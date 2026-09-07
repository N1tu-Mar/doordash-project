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

## Security posture

`docs/SECURITY.md` is the trust model: what is attacker-controlled, where each
boundary is enforced, and what is still unproven. `docs/SCHEMA.md` is the table-by-
table companion. The entries below are security gaps rather than feature gaps.

### S1. The RLS policies now execute; nobody has attempted a cross-tenant read
`0003_security_hardening.sql`, `0004_roles_and_admin.sql` and
`0005_schema_corrections.sql` ARE the security model — per-command policies,
append-only `model_calls`, private storage buckets scoped by path prefix, roles
that no user session can grant itself, and an atomic `insert_order_full`.

PARTLY CLOSED by the merge with `feat/product-hardening`. That branch brought a
PGlite harness that applies every migration in-process, so this SQL has now run
(see #5). The first execution found a real defect immediately: `0003` revokes
against `anon`, `authenticated` and `service_role`, and `supabase/ci/00_auth_shim.sql`
created none of them, so the migration aborted. The shim now creates the three
Supabase roles and a `storage` schema, and `tests/schema-security.test.ts` asserts
against the live catalog rather than against the text of the files — that
`authenticated` holds only SELECT on `user_roles`, that `is_admin()` came out
SECURITY DEFINER and stable, that each admin view's *compiled* definition still
contains its role predicate, that no `insert_order_with_items` survives.

**What is still open, and it is the important half:** nothing has attempted a
cross-tenant read. Every assertion above is made by reading the catalog with no
session attached, because PROMPT.md §2 forbids inventing users to test with.
Proving that user B cannot read user A's orders needs two real Supabase sessions,
which needs #8. Until then the policies are known to compile and known to be
attached — not known to deny.

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

### 5. The migrations have never been executed against a real project
MOSTLY CLOSED. The SQL now runs in three places, in increasing order of authority:

1. `pnpm test` — `tests/schema.test.ts` applies every migration to Postgres compiled
   to WebAssembly (PGlite), in-process, in about five seconds. No Docker, no daemon,
   runs on any machine. Then it runs `supabase/ci/01_assert_schema.sql`, and then it
   breaks one invariant at a time to prove those assertions actually fail when they
   should.
2. CI — the same files against a stock Postgres 16 container. Authoritative over the
   WASM build, which tracks a different major.
3. The deploy workflow — the same assertions against the real database, after pushing.

First execution passed: all six migrations apply, every trigger installs, RLS is on
with a policy on every table, both n >= 20 gates compile into their views.

**Still open:** that `auth.uid()` resolves correctly under a real Supabase JWT, and
that a real row round-trips under RLS. Neither is provable without a live project —
the CI shim resolves `auth.uid()` to NULL, and no row is inserted anywhere, because
§2 bans invented users as firmly as invented receipts.

Build order §8 step 1 — "verify a real row can be written and read" — is therefore
still not done. See `docs/DEPLOYMENT.md` §2.3, and do it with the anon key rather
than the service role, or it proves nothing about the policies.

### 6. Storage buckets — created by migration, applied only in the harness
`raw-receipts` and `delivered-photos` (`services/config.ts` → `BUCKETS`) are
created private, with a MIME allowlist and a 3.5 MB cap, by migration 0003 — so
there is nothing to click in the dashboard. The statement executes in the PGlite
harness against a shimmed `storage` schema; it has not run against real Supabase
storage, where the extension owns those tables. Folds into #5.

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

### 8b. No admin surface
`services/admin.ts` returns rows for four boards; nothing renders them. Deliberate
— the same §8 rule that forbids scaffolding three placeholder screens applies here.
The boards are queryable today, which is what an operator actually needs first.

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
- **Detections attributed to the first photo.** RESOLVED by R5 — one detection call
  per photo (`detectPhoto`), merged in `core/dedupe.ts`, so attribution is a fact the
  caller records rather than something invented. The same change removed the memory
  spike from encoding eight images at once.

- **Migration 0006 adds `substitution_unwanted` to `discrepancies.kind`.**
  `money-model.md` §5 recommended it and left it as the builder's call. Taken: forcing
  substitutions into `wrong_item` would poison the shortage index with merchant
  behaviour that is not a shortage.

- **`corpus` is a non-blocking CI job rather than a blocking one.** The red is still
  loud — the job is named for what it means and prints `corpus:status` — but it no
  longer fails every unrelated pull request. Reading this as softening the signal is
  defensible; the alternative was a permanently red pipeline that people learn to
  ignore, which is worse.

- **`admin_merchant_shortage_index` exists at all.** The n >= 20 and >= 5
  distinct-user gates make the numbers defensible; whether an operator should see
  per-merchant rates derived from users' orders is the open question in #12.
  Reading this as premature is defensible — say so and the view comes out.
