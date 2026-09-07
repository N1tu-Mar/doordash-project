-- Shorted — security hardening. Makes the RLS in 0001/0002 something the
-- application actually runs under, rather than something that would apply if
-- anyone ever connected as a user.
--
-- What was wrong, and what this fixes:
--
--   1. Every application query used the service-role key, which has BYPASSRLS.
--      The policies below were never evaluated even once. services/db.ts now
--      talks to Postgres as the signed-in user; this migration makes the
--      resulting permission set correct, because it is now load-bearing.
--
--   2. `for all` policies granted DELETE and UPDATE on the audit trail. A user
--      could delete their own model_calls rows — the log used to measure whether
--      the model was right — and edit a discrepancy after it was confirmed.
--      Append-only tables now have append-only policies.
--
--   3. Object storage had no policies and no buckets. Anything holding a
--      storage key could read any object.
--
--   4. Orders and their line items were written in two statements. A failure
--      between them left an order with no items, which produces a SMALLER
--      refund figure that still looks entirely plausible — the quiet-wrong-number
--      failure §2 exists to prevent. Now one transaction.
--
--   5. Google refresh tokens had nowhere encrypted to live, so they were passed
--      on the command line. They now live in an authenticated-encrypted column.
--
-- Nothing here relaxes an existing constraint.

-- ---------------------------------------------------- function hardening ---

-- The 0001 trigger functions were created without a pinned search_path. A
-- SECURITY DEFINER or trigger function with a mutable search_path can be made to
-- resolve `raise`/operator lookups against an attacker-created schema. Pin them.

create or replace function reject_immutable_column_change()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.raw_artifact_path is distinct from old.raw_artifact_path then
    raise exception 'raw_artifact_path is immutable (PROMPT.md §9)';
  end if;
  if new.source is distinct from old.source then
    raise exception 'source is immutable';
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable — an order cannot change owner';
  end if;
  return new;
end;
$$;

create or replace function reject_detected_items_change()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.detected_items is distinct from old.detected_items then
    raise exception 'detected_items is immutable — it is the record of what the model said';
  end if;
  if new.order_id is distinct from old.order_id then
    raise exception 'order_id is immutable — a discrepancy cannot be moved to another order';
  end if;
  return new;
end;
$$;

-- gmail_messages carries a storage pointer too, and it was not protected.
create or replace function reject_gmail_message_change()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.raw_artifact_path is distinct from old.raw_artifact_path then
    raise exception 'raw_artifact_path is immutable';
  end if;
  if new.user_id is distinct from old.user_id
     or new.gmail_message_id is distinct from old.gmail_message_id then
    raise exception 'gmail message identity is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists gmail_messages_immutable on gmail_messages;
create trigger gmail_messages_immutable
  before update on gmail_messages
  for each row execute function reject_gmail_message_change();

-- model_calls is append-only at the policy level for users, but the service role
-- bypasses RLS. Enforce it in a trigger so it holds for every role.
create or replace function reject_model_call_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'model_calls is append-only — an accuracy log the audited party can rewrite is not a log';
end;
$$;

drop trigger if exists model_calls_append_only on model_calls;
create trigger model_calls_append_only
  before update or delete on model_calls
  for each row execute function reject_model_call_mutation();

-- ------------------------------------------- encrypted refresh tokens ------

-- AES-256-GCM envelope from services/tokens.ts: 'v1.<iv>.<ct>.<tag>', base64
-- parts. The key lives in TOKEN_ENCRYPTION_KEY, outside the database, so a
-- Postgres dump on its own does not yield inbox access.
alter table gmail_ingest_consents
  add column if not exists refresh_token_encrypted text;

-- A revoked consent must not leave a live inbox key behind it.
alter table gmail_ingest_consents
  drop constraint if exists gmail_consent_revoked_has_no_token;
alter table gmail_ingest_consents
  add constraint gmail_consent_revoked_has_no_token
  check (revoked_at is null or refresh_token_encrypted is null);

-- Shape check, so a plaintext token cannot be stored here by mistake.
alter table gmail_ingest_consents
  drop constraint if exists gmail_consent_token_is_envelope;
alter table gmail_ingest_consents
  add constraint gmail_consent_token_is_envelope
  check (
    refresh_token_encrypted is null
    or refresh_token_encrypted ~ '^v1\.[A-Za-z0-9+/=]{16,}\.[A-Za-z0-9+/=]{16,}\.[A-Za-z0-9+/=]{16,}$'
  );

-- Who the message really came from, after header verification in ingest/gmail.ts.
-- Recorded so a spoofing attempt that got past the filter is visible afterwards.
alter table gmail_messages
  add column if not exists sender text;

-- ------------------------------------------------ atomic order insertion ---

-- SECURITY INVOKER (the default): the function body runs as the caller, so RLS
-- applies inside it exactly as it would outside. user_id is taken from auth.uid()
-- and is NOT a parameter — there is no argument for a caller to get wrong.
create or replace function insert_order_with_items(
  p_source              text,
  p_ordered_at          timestamptz,
  p_merchant_name       text,
  p_merchant_addr       text,
  p_subtotal_cents      int,
  p_fees_cents          int,
  p_tax_cents           int,
  p_tip_cents           int,
  p_total_cents         int,
  p_raw_artifact_path   text,
  p_parser_version      text,
  p_balance_delta_cents int,
  p_items               jsonb
) returns uuid
language plpgsql
set search_path = pg_catalog, public as $$
declare
  v_user_id uuid := auth.uid();
  v_order_id uuid;
begin
  if v_user_id is null then
    raise exception 'insert_order_with_items requires an authenticated session';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'an order must be inserted with at least one line item';
  end if;
  if jsonb_array_length(p_items) > 200 then
    raise exception 'refusing % line items on one order', jsonb_array_length(p_items);
  end if;

  insert into orders (
    user_id, source, ordered_at, merchant_name, merchant_addr,
    subtotal_cents, fees_cents, tax_cents, tip_cents, total_cents,
    raw_artifact_path, parser_version, balance_delta_cents
  ) values (
    v_user_id, p_source, p_ordered_at, p_merchant_name, p_merchant_addr,
    p_subtotal_cents, p_fees_cents, p_tax_cents, p_tip_cents, p_total_cents,
    p_raw_artifact_path, p_parser_version, p_balance_delta_cents
  )
  returning id into v_order_id;

  insert into order_items (order_id, name, quantity, unit_price_cents, modifiers, line_index)
  select
    v_order_id,
    item->>'name',
    (item->>'quantity')::int,
    (item->>'unit_price_cents')::int,
    coalesce(item->'modifiers', '[]'::jsonb),
    (item->>'line_index')::int
  from jsonb_array_elements(p_items) as item;

  -- Both inserts are in this function's implicit transaction: either the order
  -- and every line exists, or neither does.
  return v_order_id;
end;
$$;

revoke all on function insert_order_with_items(
  text, timestamptz, text, text, int, int, int, int, int, text, text, int, jsonb
) from public, anon;
grant execute on function insert_order_with_items(
  text, timestamptz, text, text, int, int, int, int, int, text, text, int, jsonb
) to authenticated;

-- ------------------------------------------------------ RLS, per command ---

-- FORCE applies policies to the table owner too. It does not stop a BYPASSRLS
-- role such as service_role — nothing in SQL does — which is precisely why
-- services/db.ts confines that key to an enumerated allowlist of reasons.
alter table orders                enable row level security;
alter table orders                force  row level security;
alter table order_items           enable row level security;
alter table order_items           force  row level security;
alter table discrepancies         enable row level security;
alter table discrepancies         force  row level security;
alter table model_calls           enable row level security;
alter table model_calls           force  row level security;
alter table gmail_ingest_consents enable row level security;
alter table gmail_ingest_consents force  row level security;
alter table gmail_messages        enable row level security;
alter table gmail_messages        force  row level security;

-- Replace the blanket `for all` policies with per-command ones.
drop policy if exists orders_owner         on orders;
drop policy if exists order_items_owner    on order_items;
drop policy if exists discrepancies_owner  on discrepancies;
drop policy if exists model_calls_owner    on model_calls;
drop policy if exists gmail_consents_owner on gmail_ingest_consents;
drop policy if exists gmail_messages_owner on gmail_messages;

-- orders: full lifecycle. Deletion is the user's right to erase their own data;
-- the immutability trigger still forbids rewriting where a row came from.
create policy orders_select on orders for select to authenticated
  using (auth.uid() = user_id);
create policy orders_insert on orders for insert to authenticated
  with check (auth.uid() = user_id);
create policy orders_update on orders for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy orders_delete on orders for delete to authenticated
  using (auth.uid() = user_id);

-- order_items: reachable only through an order you own. No UPDATE policy at all
-- — a line item is what the receipt said, and correcting it means re-parsing,
-- not editing the record of what was read.
create policy order_items_select on order_items for select to authenticated
  using (exists (select 1 from orders o where o.id = order_items.order_id and o.user_id = auth.uid()));
create policy order_items_insert on order_items for insert to authenticated
  with check (exists (select 1 from orders o where o.id = order_items.order_id and o.user_id = auth.uid()));
create policy order_items_delete on order_items for delete to authenticated
  using (exists (select 1 from orders o where o.id = order_items.order_id and o.user_id = auth.uid()));

-- discrepancies: insert and read. UPDATE is allowed because confirmed_items is
-- human ground truth that a human may correct; the 0001 trigger still pins
-- detected_items. No DELETE — a confirmed discrepancy is evidence.
create policy discrepancies_select on discrepancies for select to authenticated
  using (exists (select 1 from orders o where o.id = discrepancies.order_id and o.user_id = auth.uid()));
create policy discrepancies_insert on discrepancies for insert to authenticated
  with check (exists (select 1 from orders o where o.id = discrepancies.order_id and o.user_id = auth.uid()));
create policy discrepancies_update on discrepancies for update to authenticated
  using (exists (select 1 from orders o where o.id = discrepancies.order_id and o.user_id = auth.uid()))
  with check (exists (select 1 from orders o where o.id = discrepancies.order_id and o.user_id = auth.uid()));

-- model_calls: APPEND-ONLY. Insert your own rows, read your own rows, and that
-- is all. No update policy, no delete policy.
create policy model_calls_select on model_calls for select to authenticated
  using (auth.uid() = user_id);
create policy model_calls_insert on model_calls for insert to authenticated
  with check (auth.uid() = user_id);

-- gmail_ingest_consents: the refresh token column is readable by its owner
-- because the ingest worker reads it back. It is ciphertext either way.
create policy gmail_consents_select on gmail_ingest_consents for select to authenticated
  using (auth.uid() = user_id);
create policy gmail_consents_insert on gmail_ingest_consents for insert to authenticated
  with check (auth.uid() = user_id);
create policy gmail_consents_update on gmail_ingest_consents for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No DELETE: consent is revoked (revoked_at set, token nulled), never erased.
-- The record that access was once granted is the point of the table.

create policy gmail_messages_select on gmail_messages for select to authenticated
  using (auth.uid() = user_id);
create policy gmail_messages_insert on gmail_messages for insert to authenticated
  with check (auth.uid() = user_id);
create policy gmail_messages_update on gmail_messages for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy gmail_messages_delete on gmail_messages for delete to authenticated
  using (auth.uid() = user_id);

-- --------------------------------------------------------- role grants -----

-- RLS filters rows; grants decide whether a role may issue the statement at all.
-- Both are needed: a missing REVOKE leaves `anon` able to attempt every query
-- and rely on policies alone to come out empty.
revoke all on orders, order_items, discrepancies, model_calls,
              gmail_ingest_consents, gmail_messages
  from anon;

grant select, insert, update, delete on orders               to authenticated;
grant select, insert, delete         on order_items          to authenticated;
grant select, insert, update         on discrepancies        to authenticated;
grant select, insert                 on model_calls          to authenticated;
grant select, insert, update         on gmail_ingest_consents to authenticated;
grant select, insert, update, delete on gmail_messages       to authenticated;

-- The shortage index runs security_invoker, so it already shows only the
-- caller's own orders; anon should not be able to query it at all.
revoke all on merchant_shortage_index from anon;
grant select on merchant_shortage_index to authenticated;

-- --------------------------------------------------------- storage ---------

-- Private buckets. `public = false` means no unauthenticated URL serves these
-- objects; every read goes through a policy or a signed URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('raw-receipts',     'raw-receipts',     false, 3500000,
    array['image/jpeg','image/png','image/webp','image/gif','text/html']),
  ('delivered-photos', 'delivered-photos', false, 3500000,
    array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects are keyed `<userId>/<sha256>.<ext>` (services/storage.ts). The first
-- path segment is the owner, and that is what the policies test.
drop policy if exists shorted_artifacts_read   on storage.objects;
drop policy if exists shorted_artifacts_insert on storage.objects;

create policy shorted_artifacts_read on storage.objects for select to authenticated
  using (
    bucket_id in ('raw-receipts', 'delivered-photos')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy shorted_artifacts_insert on storage.objects for insert to authenticated
  with check (
    bucket_id in ('raw-receipts', 'delivered-photos')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Deliberately NO update and NO delete policy on these buckets. Raw artifacts
-- are the corpus (§3.3): a parser bug, or a user acting on a claim they later
-- regret, must not be able to destroy the evidence the claim was built on.
-- Deletion for a real erasure request is an operator action under service role.

comment on function insert_order_with_items(
  text, timestamptz, text, text, int, int, int, int, int, text, text, int, jsonb
) is
  'Atomic order + line items. SECURITY INVOKER, user_id from auth.uid(). '
  'An order with zero items would understate a refund without looking wrong, '
  'so the two writes commit together or not at all.';
