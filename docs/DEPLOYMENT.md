# Deployment and operation

How to stand this up and run a real order through it, end to end.

Read `docs/GAPS.md` first. Some of the path below stops at a wall that code
cannot get past — the receipt parser needs a real receipt's DOM, and the money
math needs a hand-checked real receipt. Those walls are marked. Nothing here
tells you to work around them with placeholder data; that is the one thing this
project does not do.

---

## 0. What exists and what does not

| Layer | State |
|---|---|
| `core/` — money, diff, matcher, dedupe, claim draft | Built, tested, pure |
| `supabase/migrations/` | Applied to a real Postgres by `pnpm test` and again in CI |
| `ingest/gmail.ts` — raw HTML ingestion | Built. The **parser** is not (GAPS #2) |
| `services/vision.ts` | Typechecked, never run against the live API (GAPS #7) |
| `app/` — the three screens | Not started, on purpose (GAPS #9, build order §8) |

So today this deploys as a **data pipeline and a claim engine**, not as a phone
app. That ordering is the build order in `prompt.md` §8, and it is deliberate:
screens built before there is a real receipt to put through them are screens
filled with invented data.

---

## 1. Prerequisites

- Node 22, pnpm 10
- A Supabase project (free tier is fine)
- An Anthropic API key
- A Google Cloud project with the Gmail API enabled

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`. Nothing has a default — `services/config.ts` throws on a missing
variable rather than starting half-configured.

```bash
pnpm typecheck
pnpm test          # green suite, including the migrations applied to a real Postgres
pnpm test:corpus   # RED until a real receipt is hand-verified. Expected.
```

`pnpm test` boots Postgres compiled to WebAssembly, applies every migration, runs
the schema assertions, and then breaks each invariant in turn to check the
assertions actually catch it. No Docker, no server, about five seconds. So a
migration that does not apply fails before you push, not after.

---

## 2. Database

### 2.1 Link and push

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or, from CI: **Actions → Deploy migrations → Run workflow**, pick the
environment, leave `dry_run` on for the first run to see the diff, then run
again with it off. That path is preferred — it re-runs the schema assertions
against the real database afterwards and fails if a rule was dropped.

The SQL has already been executed against a real Postgres by this point, twice:
in `pnpm test` and in the `schema` CI job. What `db push` adds is the first run
against a database where `auth.uid()` resolves to an actual user.

### 2.2 Storage buckets

Create two buckets, **both private**:

- `raw-receipts`
- `delivered-photos`

Names come from `services/config.ts` → `BUCKETS`. The deploy workflow fails if
either is missing or public. They hold receipt images and photos of people's
front doorsteps; a public bucket here is a data breach with a URL.

### 2.3 Verify a real row round-trips

`prompt.md` §8 step 1. Sign in as a real user through Supabase Auth, then read
and write one row as that user with the anon key — **not** the service role key.
The service role bypasses RLS, so a test that passes with it proves nothing
about whether the policies work.

---

## 3. Gmail ingestion — the data unblock

This is build-order step 2, and it is what everything downstream waits on.

### 3.1 Google Cloud setup

1. Enable the Gmail API.
2. Create an **OAuth client ID**, type *Web application*.
3. Add `http://localhost:8787/oauth/google/callback` as an authorized redirect
   URI (match `GOOGLE_REDIRECT_URI` in `.env` exactly).
4. Add yourself as a test user on the consent screen. The scope is
   `gmail.readonly` — a restricted scope, so a published app needs Google's
   verification. For the operator's own inbox, test-user mode is enough.

### 3.2 Consent and token

```bash
pnpm oauth:google <your-supabase-user-id>
```

Prints the exact consent text, waits for you to agree, serves the redirect once,
exchanges the code, records the consent row verbatim, and prints the refresh
token. The token is printed and never written to disk — put it in a secret
manager, not in the repo.

The consent row is not ceremony: `ingestGmailReceipts` calls
`assertGmailConsent` first and refuses to touch an inbox without one.

### 3.3 Pull receipts

```bash
pnpm ingest:gmail <userId> <refreshToken> 50
```

Stores raw HTML verbatim in `raw-receipts`, one row per message in
`gmail_messages`, and parses nothing. Re-running is idempotent — storage keys
are content hashes and the message table is unique on `(user_id, message_id)`.

**Where this stops:** `parseReceiptHtml()` throws `GMAIL_PARSER_NOT_IMPLEMENTED`.
Writing it needs the real DOM of a real receipt email, which is
`research/findings/receipt-formats.md` (currently `DRAFT — BLOCKED`). Every
message ingested now is re-parsed the moment that lands, which is the entire
reason raw-before-parsed is a rule.

---

## 4. Verifying the money math against a real receipt

`pnpm test:corpus` is red because `core/money.ts` has never been checked against
a real receipt. Making it green:

1. Take one real order you actually placed.
2. Hand-compute the refund for one or more missing-item scenarios. By hand, from
   the receipt.
3. Write it to `research/corpus/verified/<id>.json` in the shape
   `tests/corpus.ts` validates. That directory is gitignored forever.
4. `pnpm corpus:status` reports where you are against the 30–50 target.

The schema requires a `formatClass` per receipt, and the suite reports how many
classes you have covered. `money-model.md` §7 wants a promo receipt, a mixed
taxable/non-taxable grocery receipt, a DoubleDash receipt and a small-order-fee
receipt before the math counts as verified — those are the four cases the
corrections in `core/money.ts` exist for.

Do not make it green any other way.

---

## 5. Running the claim engine

Once an order exists in the database:

```ts
const owed = computeOwed(receiptMoney, confirmedMissing);   // core/money.ts
const draft = buildClaimDraft({ ...  breakdown: owed });    // core/claim.ts
```

`draft.body` is paste-ready. `draft.disclaimers` is for the user's eyes, not for
the message. `draft.escalation` is non-null only for credit-card orders, where
Reg Z gives a real deadline.

`services/claim.ts` can rephrase the draft with a model, and then proves no
amount changed. If it did, the deterministic text ships instead.

---

## 6. CI

| Job | Blocking | What it proves |
|---|---|---|
| `checks` | yes | typecheck, unit and property tests, and the migrations applied in-process |
| `schema` | yes | the same migrations against stock Postgres 16 — authoritative over the WASM build |
| `corpus` | **no** | reports that the money math is unverified against real receipts |
| `no-corpus-committed` | yes | no real receipt has ever entered git history |

`corpus` is red on a fresh clone and that is the design. It turns green when the
corpus exists, and reporting it separately keeps the fact visible without
blocking unrelated work.

CI takes no secrets. Anything needing a credential runs in the environment-gated
deploy workflow instead, because a job readable by a fork PR is a job that can
be made to leak whatever it can read.

---

## 7. Operational rules that outlive this document

- Raw artifacts are immutable. Reprocessing writes new keys, never over old ones.
- `detected_items` and `confirmed_items` never merge. The delta is the eval set.
- A merchant shortage rate below n=20 does not exist. The SQL enforces it.
- `owed_cents` is never capped by what DoorDash actually paid. Owed is owed; the
  gap between owed and recovered is the measurement (`money-model.md` §6).
- Nothing in `research/corpus/` is ever committed. CI checks history, not just
  the working tree.

---

## 8. What to build next

In build order, once the corpus exists:

1. The Gmail receipt parser, against real DOM (unblocks everything).
2. `capture/receipt.tsx` + the vision receipt path against a real photo.
3. `capture/delivered.tsx`, with the "unpack and lay everything out" coaching —
   product mitigation for an accuracy ceiling no model fixes.
4. `capture/confirm.tsx`. Do not pre-check detected items: a pre-checked list
   makes "accept" the cheap action and the label set silently becomes the
   model's own output.
5. `claim/[orderId].tsx` — the draft, the toggles, PDF export.
