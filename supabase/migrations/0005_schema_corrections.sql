-- Shorted — schema corrections.
--
-- Migrations 0001/0002 were written before core/money.ts grew a fee taxonomy and
-- an order-discount correction, and before core/diff.ts produced a component
-- breakdown. The tables and the arithmetic drifted apart. Where they disagree,
-- the arithmetic is right — it is the part with 26 invariant tests — so the
-- tables move.
--
-- Everything here is either (a) a column the code needs and the schema lacks,
-- (b) a constraint the prose already claimed and the DDL did not enforce, or
-- (c) an index a foreign key needs and did not have. Nothing is relaxed.

-- --------------------------------------------------- 1. fee-line taxonomy --

-- `orders.fees_cents` is one integer. core/money.ts allocates each fee line
-- SEPARATELY, because they behave differently when part of an order is missing:
-- a service fee is a percentage of the subtotal and pro-rates; a delivery fee
-- bought a delivery that did happen; a small-order fee would have gone UP if
-- the missing items had never been ordered. Collapsing them to a scalar throws
-- away the classification, so a claim recomputed from a stored order cannot
-- reproduce the claim the user actually sent.
--
-- The scalar stays as a denormalised convenience for listing screens; the lines
-- are the truth.
create table if not exists order_fee_lines (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,

  -- Printed label, verbatim. This is the string the claim text names.
  label text not null check (length(trim(label)) > 0),
  cents int  not null check (cents >= 0),

  -- core/money.ts FeeKind. 'unknown' is a real, expected value: a fee we cannot
  -- name is shown to the user and never pro-rated into a number they send.
  kind text not null check (kind in
    ('proportional', 'per_delivery', 'threshold', 'passthrough', 'unknown')),

  -- Position on the receipt, so lines round-trip in the order the user saw them.
  line_index int not null check (line_index >= 0),

  created_at timestamptz not null default now(),
  unique (order_id, line_index)
);

create index if not exists order_fee_lines_order_idx on order_fee_lines (order_id);
create index if not exists order_fee_lines_kind_idx  on order_fee_lines (kind);

comment on table order_fee_lines is
  'One row per printed fee line. core/money.ts FEE_POLICY decides per-kind '
  'whether a line pro-rates and whether it belongs in the headline figure, so '
  'the kind must survive the write. orders.fees_cents is their sum.';

alter table order_fee_lines enable row level security;
alter table order_fee_lines force  row level security;

drop policy if exists order_fee_lines_select on order_fee_lines;
create policy order_fee_lines_select on order_fee_lines for select to authenticated
  using (exists (select 1 from orders o where o.id = order_fee_lines.order_id
                 and o.user_id = (select auth.uid())));

drop policy if exists order_fee_lines_insert on order_fee_lines;
create policy order_fee_lines_insert on order_fee_lines for insert to authenticated
  with check (exists (select 1 from orders o where o.id = order_fee_lines.order_id
                      and o.user_id = (select auth.uid())));

drop policy if exists order_fee_lines_delete on order_fee_lines;
create policy order_fee_lines_delete on order_fee_lines for delete to authenticated
  using (exists (select 1 from orders o where o.id = order_fee_lines.order_id
                 and o.user_id = (select auth.uid())));

-- No UPDATE policy, for the same reason order_items has none: a fee line is
-- what the receipt said, and correcting it means re-parsing, not editing the
-- record of what was read.
revoke all on order_fee_lines from anon, authenticated;
grant select, insert, delete on order_fee_lines to authenticated;

-- ------------------------------------------- 2. the owed breakdown, stored --

-- core/money.ts returns headline / withTip / maximum plus a component list.
-- The table stored one `owed_cents` and one `owed_tip_share_cents`, which
-- cannot express "the user sent the headline figure but not the delivery fee
-- line". What was actually claimed has to be reconstructible, or the eval set
-- compares against a number nobody sent.
alter table discrepancies
  add column if not exists owed_with_tip_cents int,
  add column if not exists owed_maximum_cents  int,
  add column if not exists owed_components     jsonb not null default '[]'::jsonb;

comment on column discrepancies.owed_cents is
  'core/money.ts OwedBreakdown.headlineCents — items + default-included fees + '
  'tax, no tip. The number the claim leads with.';
comment on column discrepancies.owed_with_tip_cents is
  'headlineCents + the tip attributable to the missing items.';
comment on column discrepancies.owed_maximum_cents is
  'Everything defensible at all, weak lines included. Never the default ask.';
comment on column discrepancies.owed_components is
  'OwedBreakdown.components verbatim: every line with its kind and whether it '
  'was in the headline. This is what makes a past claim reproducible.';

alter table discrepancies drop constraint if exists discrepancies_owed_ordering;
alter table discrepancies add constraint discrepancies_owed_ordering check (
  (owed_with_tip_cents is null or owed_with_tip_cents >= owed_cents)
  and (owed_maximum_cents is null or owed_with_tip_cents is null
       or owed_maximum_cents >= owed_with_tip_cents)
);

alter table discrepancies drop constraint if exists discrepancies_components_is_array;
alter table discrepancies add constraint discrepancies_components_is_array
  check (jsonb_typeof(owed_components) = 'array');

-- ------------------------------- 3. discrepancies own their owner directly --

-- Every RLS policy on discrepancies was `exists (select 1 from orders ...)`.
-- Correct, but it means the owner of a discrepancy is only knowable by joining,
-- and a policy that has to join is a policy that gets copied wrong the fourth
-- time someone adds a table. The column is derived by trigger from the order —
-- never supplied by the client — so it cannot disagree with the join it replaces.
alter table discrepancies add column if not exists user_id uuid references auth.users on delete cascade;

update discrepancies d
   set user_id = o.user_id
  from orders o
 where o.id = d.order_id and d.user_id is null;

create or replace function set_discrepancy_user_id()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare
  v_owner uuid;
begin
  select o.user_id into v_owner from public.orders o where o.id = new.order_id;
  if v_owner is null then
    raise exception 'discrepancy references an order that does not exist';
  end if;
  -- Always derived, never taken from the caller: a client-supplied user_id here
  -- would be a second, forgeable source of truth for who owns the row.
  new.user_id := v_owner;
  return new;
end;
$$;

drop trigger if exists discrepancies_set_user_id on discrepancies;
create trigger discrepancies_set_user_id
  before insert or update on discrepancies
  for each row execute function set_discrepancy_user_id();

create index if not exists discrepancies_user_idx on discrepancies (user_id, created_at desc);

-- Policies simplify to a direct comparison now that ownership is a column.
drop policy if exists discrepancies_select on discrepancies;
drop policy if exists discrepancies_insert on discrepancies;
drop policy if exists discrepancies_update on discrepancies;

create policy discrepancies_select on discrepancies for select to authenticated
  using (user_id = (select auth.uid()));
-- INSERT still checks through `orders`: user_id is not populated until the
-- trigger fires, and a WITH CHECK on a column the client cannot set would be
-- checking nothing.
create policy discrepancies_insert on discrepancies for insert to authenticated
  with check (exists (select 1 from orders o where o.id = discrepancies.order_id
                      and o.user_id = (select auth.uid())));
create policy discrepancies_update on discrepancies for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- --------------------------------- 4. photo paths must be the owner's own ---

-- `photo_paths text[]` accepted any strings at all. They are storage keys, and
-- a claim that cites another user's photo is both a data leak and a broken
-- piece of evidence. services/storage.ts enforces the same shape on the way in;
-- this is the copy that holds when someone writes a second code path.
create or replace function reject_foreign_photo_paths()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare
  v_owner uuid;
  v_path  text;
begin
  select o.user_id into v_owner from public.orders o where o.id = new.order_id;

  foreach v_path in array new.photo_paths loop
    if v_path !~ ('^(raw-receipts|delivered-photos)/' || v_owner::text
                  || '/[0-9a-f]{64}\.[a-z0-9]{1,8}$') then
      raise exception
        'photo_paths entry % is not a content-addressed artifact belonging to this order''s owner',
        v_path;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists discrepancies_photo_paths_owned on discrepancies;
create trigger discrepancies_photo_paths_owned
  before insert or update on discrepancies
  for each row execute function reject_foreign_photo_paths();

-- ------------------------------------------------- 5. the dedupe index -----

-- The old index was `(user_id, lower(merchant_name), ordered_at, total_cents)`
-- with a comment reading "same merchant, same address, same minute". It matched
-- neither: address was absent, and `ordered_at` is a timestamptz compared at
-- microsecond precision, so two imports of one receipt whose parsed timestamps
-- differ by a second were two orders.
--
-- Truncating in UTC keeps the expression immutable, which a unique index needs.
drop index if exists orders_dedupe_idx;
create unique index orders_dedupe_idx on orders (
  user_id,
  lower(merchant_name),
  lower(coalesce(merchant_addr, '')),
  date_trunc('minute', timezone('UTC', ordered_at)),
  total_cents
);

comment on index orders_dedupe_idx is
  'Same user, merchant, address, minute and total = the same receipt imported '
  'twice. Matches the comment it used to contradict.';

-- ------------------------------------- 6. constraints the prose claimed -----

-- input_hash is documented as "hash of the exact input" and used to group repeat
-- calls on one image. A non-hash value silently breaks that grouping.
alter table model_calls drop constraint if exists model_calls_input_hash_is_sha256;
alter table model_calls add constraint model_calls_input_hash_is_sha256
  check (input_hash ~ '^[0-9a-f]{64}$');

-- Consent scopes must be real scope URLs, not empty strings.
alter table gmail_ingest_consents drop constraint if exists gmail_consent_scopes_nonempty;
alter table gmail_ingest_consents add constraint gmail_consent_scopes_nonempty
  check (array_position(scopes, null) is null and array_position(scopes, '') is null);

-- A receipt dated in the future is a parse bug, and it would sort to the top of
-- every "recent orders" list forever. A trigger rather than a CHECK because
-- now() is not immutable. One day of slack absorbs clock skew and timezone
-- misparses without accepting a genuinely wrong year.
create or replace function reject_future_order_date()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.ordered_at > now() + interval '1 day' then
    raise exception 'ordered_at % is in the future — refusing a misparsed date', new.ordered_at;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_no_future_date on orders;
create trigger orders_no_future_date
  before insert or update on orders
  for each row execute function reject_future_order_date();

-- --------------------------------------- 7. indexes the foreign keys need --

-- An un-indexed foreign key makes every delete on the parent a sequential scan
-- of the child. `orders` cascades to four tables and sets null on two more.
create index if not exists model_calls_order_idx    on model_calls (order_id) where order_id is not null;
create index if not exists model_calls_user_idx     on model_calls (user_id, created_at desc);
create index if not exists gmail_messages_order_idx on gmail_messages (order_id) where order_id is not null;
create index if not exists user_roles_granted_by_idx on user_roles (granted_by) where granted_by is not null;

-- ------------------------------------- 8. the per-user shortage index, honestly

comment on view merchant_shortage_index is
  'Per-user, security_invoker: it aggregates only the caller''s own orders, so '
  'the n >= 20 gate means twenty orders from ONE person at ONE location. In '
  'practice that almost never fires, and that is correct — a rate computed from '
  'one household is not a rate. The cross-user version an operator can actually '
  'read is admin_merchant_shortage_index (migration 0004), which additionally '
  'requires >= 5 distinct users. PROMPT.md §3.5.';

-- ------------------------------ 9. atomic insert, now including fee lines ---

-- insert_order_with_items() from 0003 predates order_fee_lines. An order whose
-- fee lines land in a second statement can lose them, and a claim recomputed
-- from an order with no fee lines quietly under-states — the same
-- quiet-wrong-number failure the atomic insert was written to prevent.
--
-- Superseded by insert_order_full(). The old signature is dropped rather than
-- left as a working alternative that writes incomplete orders.
drop function if exists insert_order_with_items(
  text, timestamptz, text, text, int, int, int, int, int, text, text, int, jsonb
);

create or replace function insert_order_full(
  p_source              text,
  p_ordered_at          timestamptz,
  p_merchant_name       text,
  p_merchant_addr       text,
  p_subtotal_cents      int,
  p_tax_cents           int,
  p_tip_cents           int,
  p_total_cents         int,
  p_raw_artifact_path   text,
  p_parser_version      text,
  p_balance_delta_cents int,
  p_items               jsonb,
  p_fee_lines           jsonb
) returns uuid
language plpgsql
set search_path = pg_catalog, public as $$
declare
  v_user_id uuid := (select auth.uid());
  v_order_id uuid;
  v_fees_cents int;
begin
  if v_user_id is null then
    raise exception 'insert_order_full requires an authenticated session';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'an order must be inserted with at least one line item';
  end if;
  if jsonb_array_length(p_items) > 200 then
    raise exception 'refusing % line items on one order', jsonb_array_length(p_items);
  end if;
  if jsonb_typeof(p_fee_lines) <> 'array' then
    raise exception 'p_fee_lines must be a json array (empty is fine)';
  end if;
  if jsonb_array_length(p_fee_lines) > 40 then
    raise exception 'refusing % fee lines on one order', jsonb_array_length(p_fee_lines);
  end if;

  -- fees_cents is derived here, not passed in, so the scalar and the lines
  -- cannot disagree. There is no argument a caller can get wrong.
  select coalesce(sum((fee->>'cents')::int), 0) into v_fees_cents
  from jsonb_array_elements(p_fee_lines) as fee;

  insert into orders (
    user_id, source, ordered_at, merchant_name, merchant_addr,
    subtotal_cents, fees_cents, tax_cents, tip_cents, total_cents,
    raw_artifact_path, parser_version, balance_delta_cents
  ) values (
    v_user_id, p_source, p_ordered_at, p_merchant_name, p_merchant_addr,
    p_subtotal_cents, v_fees_cents, p_tax_cents, p_tip_cents, p_total_cents,
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

  insert into order_fee_lines (order_id, label, cents, kind, line_index)
  select
    v_order_id,
    fee->>'label',
    (fee->>'cents')::int,
    fee->>'kind',
    (fee->>'line_index')::int
  from jsonb_array_elements(p_fee_lines) as fee;

  -- All three inserts share this function's implicit transaction: the order,
  -- every line item and every fee line exist together, or none of them do.
  return v_order_id;
end;
$$;

revoke all on function insert_order_full(
  text, timestamptz, text, text, int, int, int, int, text, text, int, jsonb, jsonb
) from public, anon;
grant execute on function insert_order_full(
  text, timestamptz, text, text, int, int, int, int, text, text, int, jsonb, jsonb
) to authenticated;

comment on function insert_order_full(
  text, timestamptz, text, text, int, int, int, int, text, text, int, jsonb, jsonb
) is
  'Atomic order + line items + fee lines. SECURITY INVOKER, user_id from '
  'auth.uid(), fees_cents derived from the fee lines. An order missing its '
  'items or its fee kinds understates a refund without looking wrong, so the '
  'writes commit together or not at all.';
