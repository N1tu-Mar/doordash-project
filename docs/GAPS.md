# GAPS — what is not built, and why

Status of the foundational layer. Everything here is a deliberate stop, not an
oversight. Ordered by what blocks the demo path first.

Rule applied throughout: where shipping something would have required inventing
data or guessing DoorDash's real behaviour, it is not shipped. PROMPT.md §2, §9.

---

## Blocked on real data (cannot be closed by writing code)

### 1. `core/money.ts` is unverified against real receipts
`pnpm test:corpus` **fails on purpose** with
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
anything that is not a receipt, so a false positive is a rule violation.

The *security* half is closed: Gmail's `from:` is a substring match, so
`billing@doordash.com.attacker.net` satisfied the query. `isTrustedSender()` now
parses the real From header and checks the registrable domain before the body is
fetched, and `skippedUntrustedSender` counts what it rejects. What remains is the
accuracy half — whether the three subject guesses match what DoorDash actually
sends, and what they miss. **Closes with R2.**

### 4. `FUZZY_MATCH_THRESHOLD = 0.6` is unmeasured
`core/diff.ts`. Affects accuracy, not shipping. **Closes with R3.**

---

## Security posture

`docs/SECURITY.md` is the trust model: what is attacker-controlled, where each
boundary is enforced, and what is still unproven. `docs/SCHEMA.md` is the table-by-
table companion. The entries below are security gaps rather than feature gaps.

### S1. The RLS policies have never been executed
`0003_security_hardening.sql`, `0004_roles_and_admin.sql` and
`0005_schema_corrections.sql` ARE the security model — per-command policies,
append-only `model_calls`, private storage buckets scoped by path prefix, roles
that no user session can grant itself, and an atomic `insert_order_full`. All of
it is unrun SQL, exactly like 0001 and 0002 (see #5 below).

`tests/schema.test.ts` checks the SQL statically: RLS forced everywhere, a role
gate inside every admin view, `search_path` pinned on every function, no write
grant on `user_roles`. That is "the SQL says what we think it says". It is not
"the SQL runs", and it cannot be.

**Closes when:** `supabase db push` runs, and a second user's session is used to
attempt a read of the first user's orders, storage objects and model_calls — and
fails. Writing that test needs two real sessions, which needs #8.

### S2. Admin boards exist; no admin UI, and no bootstrap path
Migration 0004 adds `admin` / `reviewer` roles, four cross-user views, and an
append-only `admin_audit_log`. `services/admin.ts` queries them behind a role
gate. Nothing renders them, and granting the **first** admin currently means
running `grantRole` from a Node REPL with the service-role key.

That is honest — `user_roles` is unwritable from any user session by design, so
bootstrap is necessarily an operator action — but it is not yet a documented,
repeatable one.

**Closes when:** a `scripts/grant-role.ts` exists, and the boards have a surface.

### S3. `UserContext` has nothing issuing tokens
`services/db.ts` requires a Supabase access token so queries run under
`auth.uid()`. The plumbing is right and typechecked end to end; no auth surface
exists to produce a token (#8). Until one does, the RLS path — including every
admin gate — is unexercised.

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

### 6. Storage buckets — created by migration, still unrun
`raw-receipts` and `delivered-photos` (`services/config.ts` → `BUCKETS`) are
created private, with a MIME allowlist and a 3.5 MB cap, by migration 0003 — so
there is nothing to click in the dashboard. Like every other migration, it has
never been executed. Folds into #5.

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

### 8b. No admin surface
`services/admin.ts` returns rows for four boards; nothing renders them. Deliberate
— the same §8 rule that forbids scaffolding three placeholder screens applies here.
The boards are queryable today, which is what an operator actually needs first.

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

### 12. Cross-user shortage index — built, review still open
`admin_merchant_shortage_index` (migration 0004) is the cross-user aggregation
this entry asked for: admin-gated in SQL, n >= 20 orders **and** >= 5 distinct
users. The per-user `merchant_shortage_index` is unchanged and, running under the
caller's own RLS, is close to dead in practice — twenty orders from one person at
one location almost never happens, which is correct.

The privacy review is **still open**, and it is now a concrete question rather
than a hypothetical one: publishing a merchant's shortage rate is a claim about a
business derived from other people's orders. The current gates are a defensible
floor, not an answer. See docs/SECURITY.md §3. Nothing may surface these numbers
to end users before that review.

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
- **Detections attributed to the first photo.** RESOLVED. `services/vision.ts` now
  runs one detection call per photo (`detectPhoto`) and merges through
  `core/dedupe.ts`, so attribution is a fact the caller already knows rather than
  something invented. The same change removed the memory spike from encoding eight
  images at once. R5 closed.
- **`admin_merchant_shortage_index` exists at all.** The n >= 20 and >= 5
  distinct-user gates make the numbers defensible; whether an operator should see
  per-merchant rates derived from users' orders is the open question in #12.
  Reading this as premature is defensible — say so and the view comes out.
