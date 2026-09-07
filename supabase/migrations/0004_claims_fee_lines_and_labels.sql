-- Shorted — what the money model, the eval, and the calibration protocol need
-- from the database. Every table here traces to a finding marked READY FOR BUILD.
--
-- research/findings/money-model.md §6   — claims: owed vs recovered, per component
-- research/findings/vision-and-models.md §4,§5,§7 — model call logging, typed edits
-- research/findings/RESPONSES.md R2      — rejected-message log, metadata only
--
-- Numbered 0004 because migration 0003 belongs to the concurrent hardening pass
-- (insert_order_with_items). This file does not depend on it.

-- ----------------------------------------------------------- fee lines ----

-- Correction B: fees are per-line with a kind, not one scalar. `fees_cents`
-- stays as the sum, because the receipt prints a sum and the reconciliation
-- check needs it; `fee_lines` is what core/money.ts actually allocates against.
alter table orders
  add column fee_lines jsonb not null default '[]'::jsonb;

alter table orders
  add constraint orders_fee_lines_is_array check (jsonb_typeof(fee_lines) = 'array');

comment on column orders.fee_lines is
  'Per-line fees: [{label, cents, kind}]. kind drives allocation in core/money.ts. '
  'An unrecognised label classifies as ''unknown'' and is never pro-rated into a claim.';

-- The taxable base, when the receipt distinguishes taxable from non-taxable
-- lines. NULL means unknown, which is a different fact from "everything was
-- taxable" and must not be collapsed into it (Correction C).
alter table orders
  add column taxable_base_cents int check (taxable_base_cents is null or taxable_base_cents >= 0);

-- ------------------------------------------------------- discrepancies ----

-- A substituted item is neither 'missing' nor 'wrong_item' in the sense the
-- diff assumes: the merchant sent something deliberately, and the user may or
-- may not accept it. Recommended in money-model.md §5 and flagged there as the
-- builder's call. Taking it: forcing substitutions into 'wrong_item' would
-- poison the shortage index with merchant behaviour that is not a shortage.
alter table discrepancies drop constraint discrepancies_kind_check;
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
