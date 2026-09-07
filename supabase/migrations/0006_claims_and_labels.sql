-- Shorted — what the money model, the eval, and the calibration protocol need
-- from the database. Every table here traces to a finding marked READY FOR BUILD.
--
-- research/findings/money-model.md §6   — claims: owed vs recovered, per component
-- research/findings/vision-and-models.md §4,§5,§7 — model call logging, typed edits
-- research/findings/RESPONSES.md R2      — rejected-message log, metadata only
--
-- Numbered 0006 because 0003-0005 belong to the concurrent hardening pass. This
-- file depends on none of them: it touches only tables created in 0001 and 0002,
-- and every column it adds is one those migrations do not.
--
-- Fee lines are deliberately NOT here. 0005 gives them their own table
-- (order_fee_lines) with RLS and a kind column, which is the better home than a
-- jsonb blob on orders — one row per printed line, ordered, individually
-- queryable by kind, which is exactly how core/money.ts allocates them.

-- --------------------------------------------------------- taxable base ----

-- Correction C: tax is recomputed against a base, not scaled against the
-- subtotal. NULL means the receipt did not disclose which lines were taxable,
-- which is a different fact from "everything was taxable" and must not be
-- collapsed into it — core/money.ts flags the difference as taxBasisIsAssumed.
alter table orders
  add column taxable_base_cents int check (taxable_base_cents is null or taxable_base_cents >= 0);

comment on column orders.taxable_base_cents is
  'Base the printed tax was charged on, when the receipt discloses it. NULL means unknown. '
  'Fee lines live in order_fee_lines (migration 0005), not on this table.';

-- ------------------------------------------------------- discrepancies ----

-- A substituted item is neither 'missing' nor 'wrong_item' in the sense the
-- diff assumes: the merchant sent something deliberately, and the user may or
-- may not accept it. Recommended in money-model.md §5 and flagged there as the
-- builder's call. Taking it: forcing substitutions into 'wrong_item' would
-- poison the shortage index with merchant behaviour that is not a shortage.
-- The constraint is dropped by lookup rather than by name. Postgres names an
-- inline column CHECK `<table>_<column>_check`, but that is a convention, not a
-- guarantee: an earlier migration that recreated the constraint, or a rename,
-- leaves a different name and `drop constraint discrepancies_kind_check` then
-- fails the whole deploy. Finding it by column is name-independent, and raising
-- when there is no constraint at all is better than widening nothing silently.
do $$
declare
  existing_name text;
begin
  select con.conname into existing_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'discrepancies'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%'
    and pg_get_constraintdef(con.oid) ilike '%modifier_ignored%'
  limit 1;

  if existing_name is null then
    raise exception
      'no CHECK constraint on discrepancies.kind was found — refusing to widen an enum that is not there';
  end if;

  execute format('alter table discrepancies drop constraint %I', existing_name);
end
$$;

alter table discrepancies add constraint discrepancies_kind_check
  check (kind in ('missing', 'wrong_item', 'modifier_ignored', 'damaged', 'substitution_unwanted'));

-- vision-and-models.md §7: opaque bags cap detection accuracy regardless of
-- model, so accuracy has to be reported stratified by how the food was staged.
-- Without this column the eval cannot tell a coaching problem from a prompt
-- problem, and would spend model budget on the wrong one.
alter table discrepancies
  add column capture_quality text
    check (capture_quality is null or capture_quality in ('laid_out', 'partial', 'bagged'));

-- Seconds the human spent on the confirmation screen. A screen users rush
-- produces bad labels, and that is measurable rather than a matter of opinion
-- (vision-and-models.md §5).
alter table discrepancies
  add column time_to_confirm_ms int check (time_to_confirm_ms is null or time_to_confirm_ms >= 0);

-- -------------------------------------------------- confirmation edits ----

-- Aggregate deltas between detected_items and confirmed_items tell you THAT the
-- model was wrong. Typed edits tell you HOW, which is what a prompt fix needs
-- (vision-and-models.md §5). Append-only: an edit log that can be rewritten is
-- not a label set.
create table confirmation_edits (
  id             uuid primary key default gen_random_uuid(),
  discrepancy_id uuid not null references discrepancies on delete cascade,

  edit_kind text not null check (edit_kind in (
    'added_missed_item',       -- model missed a shortage the human found
    'removed_false_positive',  -- model claimed a shortage that was not one
    'fixed_quantity',
    'fixed_name'
  )),

  -- What the model said and what the human said, for this one edit. Both, always.
  detected_value jsonb,
  confirmed_value jsonb,

  created_at timestamptz not null default now()
);

create index confirmation_edits_discrepancy_idx on confirmation_edits (discrepancy_id);
create index confirmation_edits_kind_idx on confirmation_edits (edit_kind, created_at desc);

create or replace function reject_confirmation_edit_update()
returns trigger language plpgsql as $$
begin
  raise exception 'confirmation_edits is append-only — it is the label set';
end;
$$;

create trigger confirmation_edits_append_only
  before update or delete on confirmation_edits
  for each row execute function reject_confirmation_edit_update();

-- ---------------------------------------------------------- model calls ----

-- vision-and-models.md §4: store the raw output BEFORE zod validation. A
-- rejected malformed output is the most valuable signal in the system and the
-- default path throws it away.
alter table model_calls add column raw_output text;
alter table model_calls add column input_tokens  int check (input_tokens  is null or input_tokens  >= 0);
alter table model_calls add column output_tokens int check (output_tokens is null or output_tokens >= 0);

-- A call can now have raw output AND an error: the model answered, and the
-- answer failed validation. That is precisely the case worth recording, and the
-- old xor constraint made it unrepresentable.
alter table model_calls drop constraint model_calls_output_xor_error;
alter table model_calls add constraint model_calls_has_a_result
  check (output is not null or error is not null or raw_output is not null);

-- Which photo a detection call ran on. NULL for receipt OCR and claim text.
-- RESPONSES.md R5: one call per photo, so attribution is a fact the caller
-- records rather than something the model is asked to invent.
alter table model_calls add column photo_path text;

-- --------------------------------------------------------------- claims ----

-- money-model.md §6. `owed_cents` is what our math says. `recovered_cents` is
-- what actually came back. Collapsing them into one column destroys the only
-- metric that proves the product works, and it is data no competitor has.
create table claims (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users on delete cascade,
  order_id uuid not null references orders on delete cascade,

  -- Our computation at the moment of filing. Immutable: a later change to
  -- core/money.ts must not silently rewrite history it is being measured against.
  owed_cents     int not null check (owed_cents > 0),
  owed_breakdown jsonb not null,
  -- What the user actually sent, after the tip and fee toggles.
  claimed_cents  int not null check (claimed_cents > 0),
  claim_text     text not null check (length(trim(claim_text)) > 0),

  -- Decides which escalation is honest to cite. Reg Z applies to credit only;
  -- the debit equivalent is materially weaker (refund-policy.md §3).
  funding_instrument text not null
    check (funding_instrument in ('credit_card', 'debit_card', 'prepaid_or_credit', 'unknown')),

  filed_at timestamptz not null default now(),

  -- Observed outcome. NULL means not yet known, which is different from denied.
  recovered_cents    int check (recovered_cents is null or recovered_cents >= 0),
  recovery_kind      text check (recovery_kind is null or recovery_kind in
                        ('card_refund', 'account_credit', 'partial', 'denied', 'ignored')),
  recovered_at       timestamptz,
  -- Verbatim. Never normalized, never summarized: the exact wording is the
  -- evidence for what they actually reimburse.
  denial_reason_text text,

  -- Account credits expire (refund-policy.md §2). The app tracks the clock so
  -- a "win" that quietly evaporates is visible as one.
  credit_expires_at timestamptz,

  created_at timestamptz not null default now(),

  -- A recovery has to say what kind it was, and a kind has to say when.
  constraint claims_recovery_is_complete check (
    (recovered_cents is null and recovery_kind is null and recovered_at is null)
    or (recovered_cents is not null and recovery_kind is not null and recovered_at is not null)
  ),
  constraint claims_breakdown_is_object check (jsonb_typeof(owed_breakdown) = 'object')
);

create index claims_user_filed_idx on claims (user_id, filed_at desc);
create index claims_order_idx on claims (order_id);
create index claims_open_idx on claims (user_id) where recovered_at is null;
create index claims_credit_expiry_idx on claims (credit_expires_at)
  where credit_expires_at is not null;

create or replace function reject_claim_owed_change()
returns trigger language plpgsql as $$
begin
  if new.owed_cents is distinct from old.owed_cents
     or new.owed_breakdown is distinct from old.owed_breakdown
     or new.claimed_cents is distinct from old.claimed_cents then
    raise exception 'a filed claim''s amounts are immutable — they are what the recovery is measured against';
  end if;
  return new;
end;
$$;

create trigger claims_immutable_amounts
  before update on claims
  for each row execute function reject_claim_owed_change();

-- ---------------------------------------------- gmail rejection log -------

-- RESPONSES.md R2. PROMPT.md §3.2 forbids persisting the body of anything that
-- is not a receipt, and the real subject vocabulary is unknown. So: search
-- broadly, persist a body only after a structural precondition holds, and log
-- everything else as METADATA ONLY. No body column exists here, deliberately —
-- it cannot be added by accident.
--
-- The log is also the dataset that answers R2 empirically: after a few hundred
-- rows, the rejected subjects tell you what the real filter should be.
create table gmail_rejected_messages (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,

  gmail_message_id text not null,
  -- Header metadata only. Subject lines can carry merchant and order detail, so
  -- even this is user-scoped under RLS like everything else.
  subject text not null,
  sender  text not null,
  internal_date timestamptz not null,

  rejected_reason text not null check (rejected_reason in (
    'no_html_part',        -- text/plain only; unknown whether these exist (R2 item 3)
    'no_item_table',       -- structural precondition failed
    'no_total_line',
    'body_too_large'
  )),

  created_at timestamptz not null default now(),

  unique (user_id, gmail_message_id)
);

create index gmail_rejected_reason_idx on gmail_rejected_messages (rejected_reason, created_at desc);

comment on table gmail_rejected_messages is
  'Metadata only. No message body is ever stored here — PROMPT.md §3.2 requires filtering '
  'before persisting, not after. Also the empirical answer to REQUESTS.md R2.';

-- ------------------------------------------------------------------ RLS ----

alter table confirmation_edits      enable row level security;
alter table claims                  enable row level security;
alter table gmail_rejected_messages enable row level security;

create policy confirmation_edits_owner on confirmation_edits
  for all using (
    exists (
      select 1 from discrepancies d
      join orders o on o.id = d.order_id
      where d.id = confirmation_edits.discrepancy_id and o.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from discrepancies d
      join orders o on o.id = d.order_id
      where d.id = confirmation_edits.discrepancy_id and o.user_id = auth.uid()
    )
  );

create policy claims_owner on claims
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy gmail_rejected_owner on gmail_rejected_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------- recovery by component --------

-- money-model.md §6: after ~15-20 real filed claims, owed_breakdown minus
-- recovered tells you which fee lines DoorDash returns and which it keeps.
-- Gated at n >= 20 for the same reason §3.5 gates the shortage index — a rate
-- computed from three observations is a lie with a decimal point.
--
-- security_invoker: runs under the caller's RLS, so it aggregates only the
-- caller's own claims. Cross-user aggregation needs a privacy review that has
-- not happened.
create view claim_recovery_stats
with (security_invoker = on) as
select
  count(*)                                                  as filed_claims,
  sum(claimed_cents)                                        as claimed_cents_total,
  sum(coalesce(recovered_cents, 0))                         as recovered_cents_total,
  round(
    sum(coalesce(recovered_cents, 0))::numeric / nullif(sum(claimed_cents), 0), 4
  )                                                         as recovery_ratio,
  count(*) filter (where recovery_kind = 'denied')          as denied_count,
  count(*) filter (where recovered_at is null)              as open_count
from claims
having count(*) >= 20;

comment on view claim_recovery_stats is
  'Observed recovery vs what we computed as owed. n >= 20 enforced in SQL. Never '
  'used to cap owed_cents — owed is what is owed (money-model.md §6).';

-- ------------------------------ insert_order_full: carry the taxable base ---

-- 0005 created insert_order_full() before `orders.taxable_base_cents` existed,
-- so it cannot write the column added at the top of this file. A base that the
-- receipt disclosed but the writer dropped is worse than one it never had:
-- core/money.ts would then report taxBasisIsAssumed on an order whose basis was
-- actually known, and quietly recompute tax against the wrong denominator.
--
-- Redefined rather than patched so the whole signature stays in one place.
drop function if exists insert_order_full(
  text, timestamptz, text, text, int, int, int, int, text, text, int, jsonb, jsonb
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
  p_taxable_base_cents  int,
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
  -- cannot disagree. There is no argument a caller could get wrong.
  select coalesce(sum((fee->>'cents')::int), 0) into v_fees_cents
  from jsonb_array_elements(p_fee_lines) as fee;

  insert into orders (
    user_id, source, ordered_at, merchant_name, merchant_addr,
    subtotal_cents, fees_cents, tax_cents, tip_cents, total_cents,
    taxable_base_cents, raw_artifact_path, parser_version, balance_delta_cents
  ) values (
    v_user_id, p_source, p_ordered_at, p_merchant_name, p_merchant_addr,
    p_subtotal_cents, v_fees_cents, p_tax_cents, p_tip_cents, p_total_cents,
    p_taxable_base_cents, p_raw_artifact_path, p_parser_version, p_balance_delta_cents
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
  text, timestamptz, text, text, int, int, int, int, int, text, text, int, jsonb, jsonb
) from public, anon;
grant execute on function insert_order_full(
  text, timestamptz, text, text, int, int, int, int, int, text, text, int, jsonb, jsonb
) to authenticated;

comment on function insert_order_full(
  text, timestamptz, text, text, int, int, int, int, int, text, text, int, jsonb, jsonb
) is
  'Atomic order + line items + fee lines. SECURITY INVOKER, user_id from '
  'auth.uid(), fees_cents derived from the fee lines. An order missing its '
  'items or its fee kinds understates a refund without looking wrong, so the '
  'writes commit together or not at all.';
