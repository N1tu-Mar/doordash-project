-- Shorted — initial schema. PROMPT.md §4.
--
-- Design rules encoded here rather than in application code, because application
-- code is where good intentions go to be forgotten:
--   * money is integer cents, non-negative, never nullable
--   * every row names the REAL ingestion path it came from; there is no 'seed'
--   * raw artifacts are immutable once written
--   * model output and human correction are separate columns, never merged
--   * RLS is on from this migration, not bolted on later

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- orders ---

create table orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,

  -- The only ways a row may enter this table. PROMPT.md §2: there is deliberately
  -- no 'seed' value, so a fixture script cannot insert an invented order even by
  -- accident. Widening this enum requires a migration and a code review.
  source        text not null check (source in ('gmail', 'photo', 'manual_entry')),

  ordered_at    timestamptz not null,
  merchant_name text not null check (length(trim(merchant_name)) > 0),
  merchant_addr text check (merchant_addr is null or length(trim(merchant_addr)) > 0),

  subtotal_cents int not null check (subtotal_cents >= 0),
  fees_cents     int not null check (fees_cents     >= 0),
  tax_cents      int not null check (tax_cents      >= 0),
  tip_cents      int not null check (tip_cents      >= 0),
  total_cents    int not null check (total_cents    >= 0),

  -- Raw email HTML / receipt image in object storage, stored BEFORE parsing and
  -- never overwritten. When the parser improves we re-run it over this. PROMPT.md §3.2.
  raw_artifact_path text not null check (length(trim(raw_artifact_path)) > 0),
  parser_version    text not null check (length(trim(parser_version)) > 0),

  -- Signed difference between the stated total and the sum of the parsed lines.
  -- Promos, credits and DashPass discounts make this non-zero legitimately; it is
  -- recorded so parser drift is visible instead of silently absorbed. See
  -- research/findings/REQUESTS.md.
  balance_delta_cents int not null,

  created_at timestamptz not null default now(),

  -- A subtotal of zero cannot be allocated against (core/money.ts divides by it).
  constraint orders_subtotal_positive check (subtotal_cents > 0)
);

create index orders_user_ordered_at_idx on orders (user_id, ordered_at desc);
create index orders_merchant_idx on orders (lower(merchant_name), lower(coalesce(merchant_addr, '')));

-- Same merchant, same address, same minute = the same receipt imported twice.
create unique index orders_dedupe_idx
  on orders (user_id, lower(merchant_name), ordered_at, total_cents);

-- ----------------------------------------------------------- order_items ---

create table order_items (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,

  -- Verbatim receipt text. Normalization happens at compare time in core/diff.ts,
  -- never on write: we cannot recover the original once we have mangled it.
  name              text not null check (length(trim(name)) > 0),
  quantity          int  not null check (quantity > 0),
  unit_price_cents  int  not null check (unit_price_cents >= 0),
  modifiers         jsonb not null default '[]'::jsonb,
  -- Position on the receipt, so items round-trip in the order the user sees them.
  line_index        int not null check (line_index >= 0),

  created_at timestamptz not null default now(),

  constraint order_items_modifiers_is_array check (jsonb_typeof(modifiers) = 'array'),
  unique (order_id, line_index)
);

create index order_items_order_idx on order_items (order_id);

-- --------------------------------------------------------- discrepancies ---

create table discrepancies (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,

  kind text not null check (kind in ('missing', 'wrong_item', 'modifier_ignored', 'damaged')),

  -- What the model said. Immutable. PROMPT.md §3.4.
  detected_items  jsonb not null,
  -- What the human said after physically looking at the food. Ground truth.
  -- Kept separate forever: the delta between these two columns IS the eval set.
  confirmed_items jsonb not null,

  -- From core/money.ts, computed on human-confirmed quantities only.
  owed_cents          int not null check (owed_cents >= 0),
  -- Tip share broken out so the claim can present it as a toggleable line. §5.
  owed_tip_share_cents int not null check (owed_tip_share_cents >= 0),

  photo_paths text[] not null check (array_length(photo_paths, 1) >= 1),

  created_at timestamptz not null default now(),

  constraint discrepancies_detected_is_array  check (jsonb_typeof(detected_items)  = 'array'),
  constraint discrepancies_confirmed_is_array check (jsonb_typeof(confirmed_items) = 'array')
);

create index discrepancies_order_idx on discrepancies (order_id);

-- ----------------------------------------------------------- model_calls ---

-- Every Claude call, logged. This is how accuracy gets measured after the fact
-- without re-running anything. PROMPT.md §6.
create table model_calls (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users on delete cascade,
  order_id uuid references orders on delete set null,

  kind     text not null check (kind in ('receipt_ocr', 'food_detection', 'claim_text')),
  model_id text not null,
  prompt_version text not null,

  -- Hash of the exact input, so an eval can group repeat calls on the same image.
  input_hash text not null,
  output     jsonb,
  -- Populated instead of `output` when the call failed or returned malformed JSON.
  -- Failures are recorded, not swallowed.
  error      text,
  latency_ms int not null check (latency_ms >= 0),

  created_at timestamptz not null default now(),

  constraint model_calls_output_xor_error
    check ((output is null) <> (error is null))
);

create index model_calls_kind_created_idx on model_calls (kind, created_at desc);
create index model_calls_input_hash_idx on model_calls (input_hash);

-- ------------------------------------------------------- immutability ------

-- Raw artifacts and model output are append-only. Processed results go in new
-- columns or new rows; they never overwrite the record of what actually happened.
create or replace function reject_immutable_column_change()
returns trigger language plpgsql as $$
begin
  if new.raw_artifact_path is distinct from old.raw_artifact_path then
    raise exception 'raw_artifact_path is immutable (PROMPT.md §9)';
  end if;
  if new.source is distinct from old.source then
    raise exception 'source is immutable';
  end if;
  return new;
end;
$$;

create trigger orders_immutable_columns
  before update on orders
  for each row execute function reject_immutable_column_change();

create or replace function reject_detected_items_change()
returns trigger language plpgsql as $$
begin
  if new.detected_items is distinct from old.detected_items then
    raise exception 'detected_items is immutable — it is the record of what the model said';
  end if;
  return new;
end;
$$;

create trigger discrepancies_immutable_detected
  before update on discrepancies
  for each row execute function reject_detected_items_change();

-- --------------------------------------------------------------- RLS -------

alter table orders        enable row level security;
alter table order_items   enable row level security;
alter table discrepancies enable row level security;
alter table model_calls   enable row level security;

create policy orders_owner on orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy order_items_owner on order_items
  for all using (
    exists (select 1 from orders o where o.id = order_items.order_id and o.user_id = auth.uid())
  ) with check (
    exists (select 1 from orders o where o.id = order_items.order_id and o.user_id = auth.uid())
  );

create policy discrepancies_owner on discrepancies
  for all using (
    exists (select 1 from orders o where o.id = discrepancies.order_id and o.user_id = auth.uid())
  ) with check (
    exists (select 1 from orders o where o.id = discrepancies.order_id and o.user_id = auth.uid())
  );

create policy model_calls_owner on model_calls
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------- shortage index (§3.5) -----

-- Gated at n >= 20 confirmed orders per merchant location IN SQL, so no caller can
-- render a rate off three observations. Below the threshold a location simply does
-- not appear, and the UI says "not enough data" — which is true.
--
-- security_invoker: this runs under the caller's RLS, so today it aggregates only
-- the caller's own orders. Cross-user aggregation is a separate, privacy-reviewed
-- path and is deliberately NOT enabled here. See docs/GAPS.md.
create view merchant_shortage_index
with (security_invoker = on) as
select
  lower(o.merchant_name)                      as merchant_name_key,
  lower(coalesce(o.merchant_addr, ''))        as merchant_addr_key,
  count(distinct o.id)                        as observed_orders,
  count(distinct d.order_id)                  as orders_with_shortage,
  round(count(distinct d.order_id)::numeric / count(distinct o.id), 4) as shortage_rate
from orders o
left join discrepancies d on d.order_id = o.id
group by 1, 2
having count(distinct o.id) >= 20;

comment on view merchant_shortage_index is
  'Real confirmed diffs only. n >= 20 enforced in SQL. Never extrapolated or smoothed. PROMPT.md §3.5';
