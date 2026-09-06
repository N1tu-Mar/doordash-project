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
`core/diff.ts`. Affects accuracy, not shipping. **Closes with R3.**

---

## Blocked on infrastructure access (needs credentials or a machine)

### 5. The migrations have never been executed
`supabase/migrations/0001_init.sql` and `0002_gmail_ingest.sql` are unrun SQL. No
Docker and no local Postgres on this machine, and no Supabase project is linked, so
nothing has validated the syntax, the triggers, the RLS policies, or the
`merchant_shortage_index` view.

**Closes with:** `supabase link` + `supabase db push` against a real project, or
`supabase db start` with Docker running. Do this before writing any code that
depends on the schema — build order §8 step 1 is "verify a real row can be written
and read", and that step is not done.

### 6. Storage buckets not created
`raw-receipts` and `delivered-photos` (`services/config.ts` → `BUCKETS`) must exist
with private access before ingestion runs.

### 7. No credentials configured
`.env.example` lists what is needed: Anthropic, Supabase (url + anon + service role),
Google OAuth client. Nothing has been run against a live API, so no vision call has
ever executed. `services/vision.ts` is typechecked, not proven.

### 8. Google OAuth consent flow has no HTTP surface
`consentUrl()` and `oauthClient()` exist; nothing serves the redirect URI or
exchanges the code for a refresh token. `pnpm ingest:gmail` currently takes a refresh
token as an argument, which works for the operator's own inbox (§3.1) and for nobody
else.

---

## Deliberately not started (build order says later)

### 9. No Expo app
No `app/` directory, no screens, no Expo dependency. §8 forbids scaffolding three
screens with placeholders and filling them in later — that path leads directly to
fake data. Screens start at step 4, after `core/` is tested against real receipts
from step 2.

### 10. `services/claim.ts` — not written
Dispute text generation. Depends on R4 (what DoorDash actually reimburses); writing
the wording first means writing it twice.

### 11. PDF export — not written
Depends on the claim text.

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
- **Detections attributed to the first photo.** See R5. The alternative was inventing
  an attribution; the comment in `services/vision.ts` says so at the call site.
