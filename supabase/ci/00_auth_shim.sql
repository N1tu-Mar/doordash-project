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

-- ---------------------------------------------------------------- roles ----

-- Supabase ships `anon`, `authenticated` and `service_role`, and the migrations
-- grant and revoke against them by name. A bare Postgres container has none of
-- them, so `revoke all on orders from anon` aborts the migration.
--
-- NOLOGIN, and no privileges beyond what the migrations themselves grant. The
-- point is to make GRANT/REVOKE statements resolve so CI actually exercises
-- them; getting the grant lists wrong is exactly the class of bug that reaches
-- production as "why can anon read this".
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- --------------------------------------------------------------- storage ---

-- Migration 0003 creates the artifact buckets and their object policies.
-- Supabase's storage extension owns these; a bare container has neither, and
-- the policy bodies call storage.foldername().
create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets,
  name      text not null,
  owner     uuid
);

-- Supabase's real implementation splits an object key on '/'. Objects here are
-- keyed `<userId>/<sha256>.<ext>`, so element 1 is the owning user.
create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select string_to_array(name, '/');
$$;
