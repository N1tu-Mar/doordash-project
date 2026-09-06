-- Shorted — Gmail receipt ingestion. PROMPT.md §3.2.

-- Explicit, revocable, in-app consent. Ingestion for anyone other than the
-- operator checks this table first. No silent inbox access.
create table gmail_ingest_consents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,

  -- The exact text the user agreed to, stored verbatim. If the wording changes,
  -- that is a new consent row — not an edit to an old one.
  consent_text text not null check (length(trim(consent_text)) > 0),
  scopes       text[] not null check (array_length(scopes, 1) >= 1),

  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index gmail_consent_active_idx
  on gmail_ingest_consents (user_id) where revoked_at is null;

-- One row per DoorDash receipt email seen. Records the raw artifact and the
-- dedupe key so re-running ingestion is idempotent.
--
-- Only emails that PASSED the receipt filter are ever inserted here, and only
-- their bodies are ever written to storage. Non-receipt mail is discarded before
-- persistence, not after (§3.2).
create table gmail_messages (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users on delete cascade,

  gmail_message_id text not null,
  internal_date    timestamptz not null,
  subject          text not null,

  raw_artifact_path text not null check (length(trim(raw_artifact_path)) > 0),
  -- Null until a parser succeeds on this HTML. A row here with no order is a
  -- real receipt we have stored and cannot yet parse — visible, countable, and
  -- re-runnable once the parser improves. That is the point of storing raw first.
  order_id uuid references orders on delete set null,
  parse_error text,

  created_at timestamptz not null default now(),

  unique (user_id, gmail_message_id)
);

create index gmail_messages_unparsed_idx on gmail_messages (user_id) where order_id is null;

alter table gmail_ingest_consents enable row level security;
alter table gmail_messages        enable row level security;

create policy gmail_consents_owner on gmail_ingest_consents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy gmail_messages_owner on gmail_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
