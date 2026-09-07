-- CI ONLY. Asserts the invariants the migrations are supposed to encode.
--
-- Introspection only: this file reads the catalog and raises. It writes no
-- rows, so no invented order, item, price or user can enter the database even
-- in a throwaway container (PROMPT.md §2).
--
-- What it is actually protecting: every rule below lives in SQL precisely
-- because application code is where good intentions get forgotten. A migration
-- that silently drops one of them would otherwise be invisible until it
-- mattered.

\set ON_ERROR_STOP on

do $$
declare
  missing text;
begin
  ---------------------------------------------------------------- §2 ------
  -- There is no 'seed' source, and there never may be. This is the single
  -- most important constraint in the schema: it is what makes it impossible
  -- for a fixture script to insert an invented order by accident.
  if exists (
    select 1 from pg_constraint
    where conname = 'orders_source_check' and pg_get_constraintdef(oid) like '%seed%'
  ) then
    raise exception 'orders.source accepts a seed value — PROMPT.md §2 forbids it';
  end if;

  for missing in
    select v from unnest(array['gmail', 'photo', 'manual_entry']) v
    where not exists (
      select 1 from pg_constraint
      where conname = 'orders_source_check' and pg_get_constraintdef(oid) like '%' || v || '%'
    )
  loop
    raise exception 'orders.source no longer accepts the real ingestion path %', missing;
  end loop;

  -- Raw artifacts are mandatory. An order with no pointer to the bytes it came
  -- from cannot be re-parsed, which is the whole point of storing raw first.
  if exists (
    select 1 from information_schema.columns
    where table_name = 'orders' and column_name = 'raw_artifact_path' and is_nullable = 'YES'
  ) then
    raise exception 'orders.raw_artifact_path became nullable — PROMPT.md §3.2';
  end if;

  ---------------------------------------------------------------- §3.4 ----
  -- Model output and human correction stay separate columns forever. The delta
  -- between them IS the eval set; a migration that merges them destroys it.
  for missing in
    select c from unnest(array['detected_items', 'confirmed_items']) c
    where not exists (
      select 1 from information_schema.columns
      where table_name = 'discrepancies' and column_name = c
    )
  loop
    raise exception 'discrepancies.% is gone — detected and confirmed must stay separate', missing;
  end loop;

  ---------------------------------------------------------------- RLS -----
  for missing in
    select t from unnest(array[
      'orders', 'order_items', 'discrepancies', 'model_calls',
      'gmail_ingest_consents', 'gmail_messages',
      'claims', 'confirmation_edits', 'gmail_rejected_messages'
    ]) t
    where not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    )
  loop
    raise exception 'row level security is not enabled on %', missing;
  end loop;

  -- RLS enabled with no policy denies everything, which fails closed but also
  -- fails silently. Every protected table must actually carry a policy.
  for missing in
    select t from unnest(array[
      'orders', 'order_items', 'discrepancies', 'model_calls',
      'gmail_ingest_consents', 'gmail_messages',
      'claims', 'confirmation_edits', 'gmail_rejected_messages'
    ]) t
    where not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t)
  loop
    raise exception 'table % has RLS on but no policy', missing;
  end loop;

  ---------------------------------------------------- immutability --------
  for missing in
    select t from unnest(array[
      'orders_immutable_columns',
      'discrepancies_immutable_detected',
      'confirmation_edits_append_only',
      'claims_immutable_amounts'
    ]) t
    where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal)
  loop
    raise exception 'immutability trigger % is missing', missing;
  end loop;

  ---------------------------------------------------------------- §3.5 ----
  -- The n >= 20 gate lives in SQL so no caller can render a rate off three
  -- observations. If the HAVING clause disappears, the UI starts lying.
  if (select pg_get_viewdef('merchant_shortage_index'::regclass)) not like '%>= 20%' then
    raise exception 'merchant_shortage_index lost its n >= 20 gate — PROMPT.md §3.5';
  end if;
  if (select pg_get_viewdef('claim_recovery_stats'::regclass)) not like '%>= 20%' then
    raise exception 'claim_recovery_stats lost its n >= 20 gate — money-model.md §6';
  end if;

  ---------------------------------------------------------------- §3.2 ----
  -- The rejection log must never grow a body column. Storing the body of a
  -- message we rejected as "not a receipt" is the exact violation the
  -- filter-before-persist rule exists to prevent.
  if exists (
    select 1 from information_schema.columns
    where table_name = 'gmail_rejected_messages'
      and column_name in ('body', 'html', 'raw_artifact_path', 'body_html', 'snippet')
  ) then
    raise exception 'gmail_rejected_messages grew a body column — PROMPT.md §3.2';
  end if;

  ---------------------------------------------------------------- money ---
  -- Integer cents everywhere. A float column near a dollar amount is the bug
  -- that produces a wrong number nobody notices.
  for missing in
    select table_name || '.' || column_name from information_schema.columns
    where table_schema = 'public'
      and column_name like '%_cents'
      and data_type not in ('integer', 'bigint')
  loop
    raise exception 'money column % is not an integer type', missing;
  end loop;

  raise notice 'schema assertions passed';
end
$$;
