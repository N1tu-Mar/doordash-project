# GAPS — what is not built, and why

Status of the foundational layer. Everything here is a deliberate stop, not an
oversight. Ordered by what blocks the demo path first.

Rule applied throughout: where shipping something would have required inventing
data or guessing DoorDash's real behaviour, it is not shipped. PROMPT.md §2, §9.

---

## Blocked on real data (cannot be closed by writing code)

### 1. `core/money.ts` is unverified against real receipts
`tests/money.corpus.test.ts` **fails on purpose** with
`0 hand-verified receipts in research/corpus/verified`. That red test is an
accurate status report: §5 requires the money math be checked against real
receipts with hand-verified expected values, and there are none yet.

Property tests (`tests/money.invariants.test.ts`) pass and cover the arithmetic
invariants — refund never exceeds the order total, monotonicity, integer output,
tip separability. They generate *amounts*, never receipts or items. They are not a
substitute for the corpus test and do not make the claim "the money math works".

**Closes when:** one real order is imported and its expected refund values are
hand-checked into `research/corpus/verified/<id>.json`. `pnpm corpus:status`
reports where this stands. Target is 30-50 real orders before any accuracy number
is quoted (§3.1).

### 2. DoorDash receipt HTML parser — not implemented
`ingest/gmail.ts` → `parseReceiptHtml()` throws `GMAIL_PARSER_NOT_IMPLEMENTED`.

Writing it requires the real DOM of a real receipt email. A parser written against
an imagined DOM produces plausible wrong numbers on real mail, and those numbers go
into refund claims. Raw HTML ingestion works today and is storing real mail, so this
pass re-runs over everything already collected — which is exactly why raw-before-
parsed is a rule.

**Closes when:** `research/findings/receipt-formats.md` is `READY FOR BUILD` (R1).

### 3. `RECEIPT_QUERY` is a guessed Gmail filter
`from:doordash.com` plus three subject guesses. §3.2 forbids persisting the body of
anything that is not a receipt, so a false positive is a rule violation. **Closes
with R2.**

### 4. `FUZZY_MATCH_THRESHOLD = 0.6` is unmeasured
`core/diff.ts`. Affects accuracy, not shipping. The structural half of R3 is now
implemented — matching is a global assignment (`core/assign.ts`) and the threshold is
a floor on acceptable pairings rather than the matching rule. The *value* is still a
guess. **Closes with R3's sweep.**

### 4b. Fee labels outside the documented vocabulary are never claimed
`core/fees.ts` classifies against the labels `money-model.md` Correction B names and
returns `unknown` for everything else. An `unknown` fee is deliberately never pro-rated
into a claim, which is the safe behaviour and also money left on the table. Every
unrecognised label is a refund line the user does not get. **Closes with R6.**

### 4c. Cross-photo duplicates are flagged, not resolved
`core/dedupe.ts` takes the max quantity across photos and sets `crossPhotoAmbiguous`,
because summing double-counts and taking the max under-counts and there is no way to
tell from the photos alone. The human resolves it on the confirmation screen. Whether
that is worth the attention it costs is measurable. **Closes with R7.**

---

## Blocked on infrastructure access (needs credentials or a machine)

### 5. The migrations have never been executed against a real project
PARTIALLY CLOSED. CI now applies every migration to a real Postgres 16 container on
every push (`.github/workflows/ci.yml`, job `schema`) against a minimal auth shim, then
asserts the schema still encodes the rules — RLS on every table, a policy on every
table, the immutability triggers, the n >= 20 gates, no `seed` source, no float money
column. So the syntax, the trigger bodies, the policy expressions and the views are
now verified on every commit.

What CI cannot prove: that `auth.uid()` resolves correctly under a real Supabase JWT,
and that a real row round-trips under RLS with the anon key. CI inserts no rows at all
— §2 bans invented users as firmly as invented receipts, so the assertions are catalog
introspection only.

**Still open:** build order §8 step 1, "verify a real row can be written and read",
against a linked project with a real signed-in user. See `docs/DEPLOYMENT.md` §2.3 —
and do it with the anon key, not the service role, or it proves nothing about RLS.

### 6. Storage buckets not created
`raw-receipts` and `delivered-photos` (`services/config.ts` → `BUCKETS`) must exist
with private access before ingestion runs.

### 7. No credentials configured
`.env.example` lists what is needed: Anthropic, Supabase (url + anon + service role),
Google OAuth client. Nothing has been run against a live API, so no vision call has
ever executed. `services/vision.ts` is typechecked, not proven.

### 8. Google OAuth consent flow — CLOSED for the operator path
`pnpm oauth:google <userId>` prints the consent text, serves the redirect once,
exchanges the code, records the consent row verbatim and prints the refresh token
(`scripts/oauth-google.ts`).

Still operator-only: it is a terminal flow. The in-app consent screen for anyone else
arrives with `app/`, and a published `gmail.readonly` scope needs Google verification
first — that is a restricted scope, not a paperwork detail.

---

## Deliberately not started (build order says later)

### 9. No Expo app
No `app/` directory, no screens, no Expo dependency. §8 forbids scaffolding three
screens with placeholders and filling them in later — that path leads directly to
fake data. Screens start at step 4, after `core/` is tested against real receipts
from step 2.

### 10. `services/claim.ts` — CLOSED
R4 came back with the answer that mattered: whether DoorDash already refunds fees
proportionally is unknown in either direction, so the copy asserts nothing about their
behaviour. `core/claim.ts` builds the draft deterministically — every amount comes from
`core/money.ts` — and `services/claim.ts` may rephrase it with a model, then proves no
amount moved before letting the rewrite ship.

Still open inside it: the tip toggle's default is `on and visible` per R4's
recommendation, and stays a recommendation until jurisdiction rules surface.

### 11. PDF export — not written
Depends on `app/`. The claim text and its evidence list exist; rendering them to a PDF
is a client-side concern that arrives with the screen that offers the download.

### 12. Cross-user shortage index
`merchant_shortage_index` enforces n >= 20 in SQL but runs with
`security_invoker = on`, so it aggregates only the caller's own orders. Real
cross-user aggregation needs a service-role path and a privacy review that has not
happened. §3.5's n >= 20 gate is in place either way.

---

## Judgment calls worth a second opinion

- **Property tests over generated amounts.** §2 bans fake data. Generated integers
  in `tests/money.invariants.test.ts` are arithmetic inputs, not data: no item names,
  no merchants, no orders, nothing that can reach the database or a screen. Reading
  this as a violation is defensible; say so and they come out.
- **`tests/money.corpus.test.ts` is red on a fresh clone.** Chosen so the unverified
  state is loud rather than a comment nobody reads. If a green CI matters more, it
  moves behind a separate `test:corpus` script — but then nothing announces that the
  money math is unverified.
- **Detections attributed to the first photo.** RESOLVED by R5 — one detection call
  per photo, merged in `core/dedupe.ts`, so attribution is a fact the caller records.

- **Migration 0006 adds `substitution_unwanted` to `discrepancies.kind`.**
  `money-model.md` §5 recommended it and left it as the builder's call. Taken: forcing
  substitutions into `wrong_item` would poison the shortage index with merchant
  behaviour that is not a shortage.

- **`corpus` is a non-blocking CI job rather than a blocking one.** The red is still
  loud — the job is named for what it means and prints `corpus:status` — but it no
  longer fails every unrelated pull request. Reading this as softening the signal is
  defensible; the alternative was a permanently red pipeline that people learn to
  ignore, which is worse.
