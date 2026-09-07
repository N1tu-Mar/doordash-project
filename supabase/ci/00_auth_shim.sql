-- CI ONLY. Never run against a Supabase project.
--
-- The migrations reference `auth.users` and `auth.uid()`, which Supabase
-- provides and a bare Postgres container does not. This shim supplies just
-- enough of that surface for the migrations to apply, so CI can prove the SQL
-- parses, the triggers compile, the RLS policies bind, and the views build.
--
-- It creates SCHEMA ONLY. It inserts no rows — not an order, not an item, not
-- a user. PROMPT.md §2 bans invented users as firmly as invented receipts, and
-- a CI fixture is exactly the kind of "just for testing" exception the rule
-- exists to refuse. Everything CI asserts is asserted by introspection.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

-- Supabase resolves this from the request JWT. In CI it resolves to NULL, which
-- is correct: no request is in flight, and every RLS policy therefore denies.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
