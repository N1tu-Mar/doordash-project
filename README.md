# Shorted

Turns "half my DoorDash order is missing" into a specific, evidenced,
correctly-priced refund claim. `prompt.md` is the contract; read it first.

**The rule that governs everything:** every piece of data in this system comes from
a real DoorDash order a real person actually placed. No fixtures, no seed scripts,
no faker, no LLM-generated receipts. See §2 of `prompt.md`.

## State of the build

`docs/GAPS.md` — what is not built and why. Read it before assuming something is
missing by accident.

`pnpm corpus:status` — the honest state of the real-data corpus.

`pnpm test:corpus` currently **fails on purpose**: the money math is unverified
against real receipts because there are none yet. That red test is the status
report. Do not make it green by inventing a receipt.

`pnpm test` excludes it, so ordinary runs are green and the unverified state stays
loud in its own command.

## Layout

```
core/       pure TS — no network, no DB, no model calls.
            types, money, fees, parse, diff, assign, dedupe, untrusted
services/   config, secrets, tokens, Supabase db + storage, Claude vision, admin
ingest/     Gmail receipt ingestion (raw HTML stored before parsing)
supabase/   migrations. RLS from the first one, enforced from the third.
research/   Agent B only. corpus/ is gitignored forever.
scripts/    corpus:status, ingest:gmail
docs/       GAPS, SECURITY, SCHEMA
tests/
```

`core/` stays pure so the money math and the diff logic can be tested against real
captured payloads with zero mocking. `core/untrusted.ts` is the trust boundary
every model input crosses; it lives in `core/` because it is arithmetic and string
handling, not I/O.

## Documentation

| Doc | Read it when |
|---|---|
| `prompt.md` | Always first. It is the contract. |
| `docs/GAPS.md` | Before assuming something is missing by accident. |
| `docs/SECURITY.md` | Before touching `services/` or `supabase/migrations/`. |
| `docs/SCHEMA.md` | Before changing a table, a policy, or the money model. |

## Setup

```bash
pnpm install
cp .env.example .env    # fill in — nothing has a default
pnpm typecheck
pnpm test
```

`TOKEN_ENCRYPTION_KEY` needs generating: `openssl rand -base64 32`. It encrypts
Google refresh tokens at rest and is deliberately not a Supabase credential — a
Postgres dump must not also hand over live inbox access.

Database (**not yet run against a real project** — see GAPS #5):

```bash
supabase link --project-ref <ref>
supabase db push          # 0001..0005
```

Migration `0003` creates the private storage buckets, so there is nothing to click
in the dashboard. `0004` adds roles; the first admin is granted out of band with
the service-role key, because `user_roles` is deliberately unwritable from any
user session (docs/SECURITY.md §3).

## Test commands

| Command | What it runs |
|---|---|
| `pnpm test` | Everything except the corpus test |
| `pnpm test:corpus` | The one intentionally-red test below |
| `pnpm test:all` | Both |

`tests/schema.test.ts` checks the migration SQL statically — RLS forced on every
user-data table, a role gate inside every admin view, `search_path` pinned on every
function, no write grant on `user_roles`. It does **not** run Postgres, and it does
not claim to.

## Two agents

`prompt.md` §7. Agent A (builder) owns `app/ core/ services/ ingest/ supabase/` and
never writes in `research/` except `research/findings/REQUESTS.md`. Agent B
(researcher) owns `research/` and nothing else. Communication is files, not shared
conversation state; A acts only on findings marked `READY FOR BUILD`.

Open requests to B: `research/findings/REQUESTS.md`.
