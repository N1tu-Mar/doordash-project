-- Shorted — roles, and the admin surfaces users must never reach.
--
-- Until this migration there was no notion of privilege at all: every
-- authenticated user was identical, and the only cross-user capability in the
-- system was the service-role key, which is not a user-facing thing. Adding
-- admin boards without adding a role model would have meant gating them in
-- application code, which is the failure mode this whole schema avoids —
-- application code is where good intentions go to be forgotten.
--
-- THE PROPERTY THAT MATTERS: a signed-in user cannot grant themselves a role.
-- Not "should not". Cannot. `user_roles` has no INSERT, UPDATE or DELETE grant
-- for `authenticated` and no write policy, so there is no statement a user
-- session can issue that changes it — a privilege-escalation bug in the app
-- cannot be written, because the API to escalate does not exist for that role.
-- Roles are granted out of band, by the service role, and every grant is logged.

-- ------------------------------------------------------------- roles -------

do $$ begin
  create type app_role as enum ('admin', 'reviewer');
exception when duplicate_object then null;
end $$;

comment on type app_role is
  'admin: full cross-user read of the operational boards, plus role administration. '
  'reviewer: cross-user read of accuracy and eval data only — no PII, no money, no roles.';

create table if not exists user_roles (
  user_id    uuid not null references auth.users on delete cascade,
  role       app_role not null,

  granted_at timestamptz not null default now(),
  -- Who granted it. Null means bootstrap (the first admin, granted by an
  -- operator with direct database access) — visible as such rather than hidden.
  granted_by uuid references auth.users on delete set null,
  -- Why. Free text, required: a role grant with no stated reason is the one you
  -- cannot audit six months later.
  reason     text not null check (length(trim(reason)) > 0),

  primary key (user_id, role)
);

comment on table user_roles is
  'Role grants. Writable ONLY by the service role — `authenticated` holds no '
  'write grant and no write policy exists, so a user session cannot escalate.';

create index if not exists user_roles_role_idx on user_roles (role);

-- ------------------------------------------------------ role predicates ----

-- SECURITY DEFINER on purpose, and this is the one place in the schema that
-- needs it.
--
-- These predicates are called from inside RLS policies on other tables. If they
-- read `user_roles` as the invoker, Postgres evaluates `user_roles`' own RLS
-- while evaluating a policy that called it — recursive policy evaluation, which
-- either errors or, worse, silently returns false and locks admins out of their
-- own boards. Running as the definer reads the table directly.
--
-- The function takes no user-supplied argument and derives everything from
-- auth.uid(), so there is no parameter to abuse. search_path is pinned.
create or replace function public.has_role(p_role app_role)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid()) and r.role = p_role
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public as $$
  select public.has_role('admin'::app_role);
$$;

-- reviewer is implied by admin: an admin can see everything a reviewer can.
create or replace function public.is_reviewer()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public as $$
  select public.has_role('reviewer'::app_role) or public.has_role('admin'::app_role);
$$;

revoke all on function public.has_role(app_role) from public, anon;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_reviewer() from public, anon;
grant execute on function public.has_role(app_role) to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_reviewer() to authenticated;

-- ------------------------------------------- user_roles: read-only to users -

alter table user_roles enable row level security;
alter table user_roles force  row level security;

-- A user may read their OWN grants, so the app can hide an admin nav item it
-- would be pointless to show. Reading a row does not grant anything.
drop policy if exists user_roles_read_own on user_roles;
create policy user_roles_read_own on user_roles for select to authenticated
  using (user_id = (select auth.uid()));

-- Admins may read every grant — that is the role-administration board.
drop policy if exists user_roles_read_all on user_roles;
create policy user_roles_read_all on user_roles for select to authenticated
  using (public.is_admin());

-- There is deliberately NO insert/update/delete policy. Combined with the
-- revoke below, `authenticated` cannot write this table under any circumstances,
-- including as an admin. Granting a role is a service-role operation with an
-- audit row, not something a session can do to itself.
revoke all on user_roles from anon, authenticated;
grant select on user_roles to authenticated;

-- Defence in depth, for the day someone adds a policy without reading the above:
-- a write is rejected unless it comes from a role that bypasses RLS (service
-- role or a direct operator connection), which is exactly the set of callers
-- for which auth.uid() is null.
create or replace function reject_user_role_self_service()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if (select auth.uid()) is not null then
    raise exception
      'user_roles is not writable from a user session — grant roles through the service role';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists user_roles_no_self_service on user_roles;
create trigger user_roles_no_self_service
  before insert or update or delete on user_roles
  for each row execute function reject_user_role_self_service();

-- ------------------------------------------------------- admin audit log ---

-- Admin boards read across every user. That access is itself a privileged act
-- and is recorded, so "who looked at whose data" has an answer.
create table if not exists admin_audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid not null references auth.users on delete set null,
  action     text not null check (length(trim(action)) > 0),
  -- What was looked at or changed. No raw PII: identifiers and counts.
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint admin_audit_detail_is_object check (jsonb_typeof(detail) = 'object')
);

create index if not exists admin_audit_actor_idx on admin_audit_log (actor_id, created_at desc);

alter table admin_audit_log enable row level security;
alter table admin_audit_log force  row level security;

-- Admins write their own entries and read all of them. Ordinary users see
-- nothing here — not even their own name appearing in someone else's entry.
drop policy if exists admin_audit_insert on admin_audit_log;
create policy admin_audit_insert on admin_audit_log for insert to authenticated
  with check (public.is_admin() and actor_id = (select auth.uid()));

drop policy if exists admin_audit_select on admin_audit_log;
create policy admin_audit_select on admin_audit_log for select to authenticated
  using (public.is_admin());

-- Append-only, enforced by trigger so it holds for the service role too.
create or replace function reject_admin_audit_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'admin_audit_log is append-only';
end;
$$;

drop trigger if exists admin_audit_append_only on admin_audit_log;
create trigger admin_audit_append_only
  before update or delete on admin_audit_log
  for each row execute function reject_admin_audit_mutation();

revoke all on admin_audit_log from anon, authenticated;
grant select, insert on admin_audit_log to authenticated;

-- ---------------------------------------------------------- admin boards ---

-- Every view below is `security_invoker = off`: it runs with the view owner's
-- rights and therefore sees across users. That is the entire point of an admin
-- board, and it is why each one carries `where public.is_admin()` (or
-- is_reviewer()) IN THE VIEW BODY.
--
-- The consequence for a non-privileged user is that these views return zero
-- rows rather than an error. That is deliberate: an error message is an oracle
-- confirming the board exists and that they are not on it.

-- 1. Model accuracy. Reviewer-visible: it is counts and latencies, no PII, no
--    money, and it is the number §6 exists to produce.
create or replace view admin_model_accuracy
with (security_invoker = off) as
select
  m.kind,
  m.model_id,
  m.prompt_version,
  count(*)                                          as calls,
  count(*) filter (where m.error is not null)       as failures,
  round(
    count(*) filter (where m.error is not null)::numeric / greatest(count(*), 1), 4
  )                                                 as failure_rate,
  percentile_disc(0.5)  within group (order by m.latency_ms) as p50_latency_ms,
  percentile_disc(0.95) within group (order by m.latency_ms) as p95_latency_ms,
  count(distinct m.user_id)                         as distinct_users,
  min(m.created_at)                                 as first_call_at,
  max(m.created_at)                                 as last_call_at
from model_calls m
where public.is_reviewer()
group by m.kind, m.model_id, m.prompt_version;

comment on view admin_model_accuracy is
  'Cross-user model call health. Reviewer or admin only — the gate is in the '
  'view body, so a non-privileged caller gets zero rows, not an error.';

-- 2. Cross-user merchant shortage index. This is the one docs/GAPS.md #12 says
--    needs a privacy review, and this is that path being built explicitly
--    rather than by loosening the per-user view.
--
--    n >= 20 confirmed orders per location is enforced IN SQL, as §3.5 requires,
--    and it is enforced on DISTINCT USERS as well as on orders: twenty orders
--    from one household is one household's experience of a restaurant, not a
--    rate anyone should publish.
create or replace view admin_merchant_shortage_index
with (security_invoker = off) as
select
  lower(o.merchant_name)                   as merchant_name_key,
  lower(coalesce(o.merchant_addr, ''))     as merchant_addr_key,
  count(distinct o.id)                     as observed_orders,
  count(distinct o.user_id)                as observed_users,
  count(distinct d.order_id)               as orders_with_shortage,
  round(count(distinct d.order_id)::numeric / count(distinct o.id), 4) as shortage_rate
from orders o
left join discrepancies d on d.order_id = o.id
where public.is_admin()
group by 1, 2
having count(distinct o.id) >= 20 and count(distinct o.user_id) >= 5;

comment on view admin_merchant_shortage_index is
  'Real confirmed diffs only, across users. n >= 20 orders AND >= 5 distinct '
  'users enforced in SQL. Never extrapolated or smoothed. PROMPT.md §3.5. '
  'Admin only; the per-user merchant_shortage_index is what regular users see.';

-- 3. Ingestion health. Admin only: it names how much mail each account holds.
create or replace view admin_ingest_health
with (security_invoker = off) as
select
  count(*)                                          as messages_total,
  count(*) filter (where g.order_id is null)        as messages_unparsed,
  count(*) filter (where g.parse_error is not null) as messages_failed,
  count(distinct g.user_id)                         as users_with_mail,
  min(g.internal_date)                              as oldest_message_at,
  max(g.internal_date)                              as newest_message_at
from gmail_messages g
where public.is_admin();

comment on view admin_ingest_health is
  'Corpus size and parse backlog across users. Admin only.';

-- 4. Corpus coverage: how far the real-data bootstrap has actually got (§3.1).
create or replace view admin_corpus_coverage
with (security_invoker = off) as
select
  count(distinct o.id)        as orders_total,
  count(distinct o.user_id)   as users_total,
  count(distinct o.id) filter (where o.source = 'gmail')        as orders_from_gmail,
  count(distinct o.id) filter (where o.source = 'photo')        as orders_from_photo,
  count(distinct o.id) filter (where o.source = 'manual_entry') as orders_manual,
  count(distinct d.id)        as confirmed_discrepancies,
  count(distinct o.id) filter (where o.balance_delta_cents <> 0) as orders_with_balance_drift
from orders o
left join discrepancies d on d.order_id = o.id
where public.is_reviewer();

comment on view admin_corpus_coverage is
  'Progress against the 30-50 real order bootstrap target. Reviewer or admin.';

revoke all on admin_model_accuracy, admin_merchant_shortage_index,
              admin_ingest_health, admin_corpus_coverage
  from anon, public;
grant select on admin_model_accuracy, admin_merchant_shortage_index,
                admin_ingest_health, admin_corpus_coverage
  to authenticated;
