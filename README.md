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

`pnpm test` currently reports **one intentional failure**: the money math is
unverified against real receipts because there are none yet. That red test is the
status report. Do not make it green by inventing a receipt.

## Layout

```
core/       pure TS — no network, no DB, no model calls. types, money, diff, parse.
services/   config, Supabase db + storage, Claude vision
ingest/     Gmail receipt ingestion (raw HTML stored before parsing)
supabase/   migrations. RLS from the first one.
research/   Agent B only. corpus/ is gitignored forever.
scripts/    corpus:status, ingest:gmail
tests/
```

`core/` stays pure so the money math and the diff logic can be tested against real
captured payloads with zero mocking.

## Setup

```bash
pnpm install
cp .env.example .env    # fill in — nothing has a default
pnpm typecheck
pnpm test
```

Database (not yet run against a real project — see GAPS #5):

```bash
supabase link --project-ref <ref>
supabase db push
```

Then create the private storage buckets `raw-receipts` and `delivered-photos`.

## Two agents

`prompt.md` §7. Agent A (builder) owns `app/ core/ services/ ingest/ supabase/` and
never writes in `research/` except `research/findings/REQUESTS.md`. Agent B
(researcher) owns `research/` and nothing else. Communication is files, not shared
conversation state; A acts only on findings marked `READY FOR BUILD`.

Open requests to B: `research/findings/REQUESTS.md`.
