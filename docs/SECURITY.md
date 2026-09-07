# Security model

What is trusted, what is not, and where each boundary is enforced. Read this
before changing anything in `services/` or `supabase/migrations/`.

---

## 1. Trust boundaries

| Input | Who controls it | Where it is handled |
|---|---|---|
| Receipt photo | The user, and whoever printed what is in frame | `services/vision.ts` |
| Delivered-food photos | The user | `services/vision.ts` |
| Receipt email HTML | **Anyone on the internet** | `ingest/gmail.ts` |
| Model output | The model, steered by the above | `core/untrusted.ts` |
| `user_id`, `order_id` from a request | The caller | Postgres RLS + `assertOwnsOrder` |

The one people get wrong is the email. Gmail's `from:` operator is a substring
match, so `from:doordash.com` is satisfied by `billing@doordash.com.attacker.net`.
Anyone who knows a user's address can put bytes in the corpus. `isTrustedSender()`
parses the actual `From` header and checks the registrable domain, before the body
is read; `tests/gmail-sender.test.ts` pins the spoofing cases.

---

## 2. Database access: RLS is the enforcement, not the documentation

`supabase/migrations/0001` shipped RLS policies and `services/db.ts` then used the
service-role key for every query. Service role has `BYPASSRLS`. The policies were
never evaluated once, and every `userId` parameter was a trusted input — a
transposed argument anywhere wrote into another account.

Now there are two doors and they do not look alike:

```ts
userDb(ctx)       // anon key + the user's JWT. auth.uid() is set. Default.
adminDb(reason)   // service role. Bypasses RLS. `reason` is an enumerated union.
```

`ServiceReason` is the complete list of code that can read across users. Grep it.
Adding a member is the change a reviewer should stop on.

`userDb` also checks the JWT's `sub` against `ctx.userId` before issuing anything.
Postgres would reject a mismatch anyway; the check turns a silent empty result set
into a loud error, which is the difference between finding a bug in development
and shipping it.

### Policy shape (migration 0003)

Per-command, not `for all`:

| Table | select | insert | update | delete |
|---|---|---|---|---|
| `orders` | ✓ | ✓ | ✓ | ✓ (right to erase) |
| `order_items` | ✓ | ✓ | — | ✓ |
| `order_fee_lines` | ✓ | ✓ | — | ✓ |
| `discrepancies` | ✓ | ✓ | ✓ (`confirmed_items` only, by trigger) | — |
| `model_calls` | ✓ | ✓ | — | — |
| `gmail_ingest_consents` | ✓ | ✓ | ✓ | — |
| `gmail_messages` | ✓ | ✓ | ✓ | ✓ |
| `user_roles` | own rows, or all if admin | — | — | — |
| `admin_audit_log` | admin only | admin only | — | — |

`order_items` and `order_fee_lines` have no `UPDATE` policy on purpose: a line is
what the receipt said, and correcting it means re-parsing, not editing the record
of what was read.

`model_calls` is the log used to measure whether the model was right. The old
`for all` policy let the audited party delete it. It is now append-only at the
policy level *and* by trigger, so the property holds even for service role.

`force row level security` is on for every table: policies apply to the table
owner too. Nothing in SQL constrains a `BYPASSRLS` role — that is what the
`ServiceReason` allowlist is for.

Grants are revoked from `anon` separately. RLS filters rows; grants decide whether
the statement may be issued at all, and relying on policies alone to return empty
is one missing `using` clause away from a leak.

### Storage

Objects are keyed `<userId>/<sha256>.<ext>`, buckets are private, and the policies
test `(storage.foldername(name))[1] = auth.uid()::text`.

`getArtifact()` previously split any caller string on the first slash and
downloaded whatever it named, with the service-role key — a one-parameter
cross-tenant read of every user's receipts. `parseArtifactPath()` now validates
the bucket against an allowlist, requires the caller's own prefix, and requires a
content-addressed key shape. `tests/storage-paths.test.ts` covers it.

There is deliberately **no** update or delete policy on those buckets. Raw
artifacts are the corpus (§3.3); a parser bug must not be able to destroy the
evidence a claim was built on. Erasure requests are an operator action.

---

## 3. Roles and admin surfaces

Until migration 0004 there was no notion of privilege: every authenticated user
was identical. Admin boards read across users, so they needed a role model that
lives in the database rather than in a `if (user.isAdmin)` somewhere.

| Role | Sees | Cannot |
|---|---|---|
| *(none)* | Own orders, own artifacts, own audit rows | Anything of anyone else's |
| `reviewer` | Cross-user model accuracy and corpus coverage — counts, latencies, failure rates | Merchant names, addresses, money, inbox stats, roles |
| `admin` | Everything a reviewer sees, plus merchant shortage rates and ingest health | Still cannot grant themselves or anyone else a role from a session |

### The property that matters

**A signed-in user cannot grant themselves a role.** Not "should not" — cannot:

1. `user_roles` has no `INSERT`/`UPDATE`/`DELETE` grant for `authenticated`, and
   no write policy exists. There is no statement a user session can issue.
2. A trigger (`reject_user_role_self_service`) rejects any write arriving with a
   non-null `auth.uid()`, which covers the day someone adds a policy without
   reading point 1.
3. Grants go through `adminDb("role_administration")` — service role only. The
   first admin is an operator action, and `granted_by = null` records it as
   bootstrap rather than hiding it.

A privilege-escalation bug in the application cannot be *written*, because the
API to escalate does not exist for that role.

### Where the gate actually is

In SQL. Every admin view is `security_invoker = off` — it runs with the view
owner's rights and therefore sees across users — and every one carries
`where public.is_admin()` (or `is_reviewer()`) **in its own body**. So:

- a non-admin querying `admin_merchant_shortage_index` gets **zero rows**, not
  an error. An error would confirm the board exists and that they are not on it;
- a bug in `services/admin.ts` cannot leak cross-user data, because the query it
  issues still comes back empty;
- the `n >= 20 orders AND >= 5 distinct users` gate on shortage rates is in the
  view, so no caller can render a rate off three observations by writing a
  different query.

`services/admin.ts` checks roles too, but that is **UX, not the boundary**: it
turns "you got zero rows" into "you are not an admin". The file's header says so
explicitly, so nobody later mistakes it for the enforcement.

`is_admin()` / `is_reviewer()` / `has_role()` are `SECURITY DEFINER`, `STABLE`,
and `search_path`-pinned. Definer rights are required here and only here: these
predicates are called from inside RLS policies on other tables, and reading
`user_roles` as the invoker would evaluate `user_roles`' own RLS during that
policy — recursive evaluation, which either errors or silently locks admins out.
They take no user-supplied argument; everything derives from `auth.uid()`.

### Privileged reads are logged

`admin_audit_log` records every board read: actor, action, and counts. It carries
**no row content** — an audit log that copies the data it audits doubles the blast
radius of reading it. It is append-only by policy *and* by trigger, so the
property holds for the service role too, and ordinary users cannot read it at all.

`recordAdminAction` failing fails the read. An unlogged privileged read is
precisely the event the log exists to capture.

### The privacy question this makes concrete

`admin_merchant_shortage_index` is what docs/GAPS.md #12 called out as needing a
privacy review before it existed. It now exists, so the review question is
concrete: **publishing a merchant's shortage rate is a claim about a business
derived from other people's orders.** The gates in place — 20 orders, 5 distinct
users, admin-only, no per-user rows exposed — are a defensible floor, not a
finished answer. Anything that surfaces these numbers to end users needs that
review first.

---

## 4. Secrets

- `services/secrets.ts` refuses to start if any credential carries a bundler
  prefix (`EXPO_PUBLIC_`, `NEXT_PUBLIC_`, `VITE_`, …). Enforced at import of
  `services/config.ts`, so no path to a model or the database skips it.
- `services/config.ts` throws if a secret is read in a runtime with a `window`.
- Every secret read is registered with the redactor. `redact()` also scrubs
  credentials it has never seen the value of: bearer headers, `sk-ant-…`,
  `ya29.…`, Google refresh tokens, JWTs, signed-URL parameters.
- **Nothing rethrows an upstream error verbatim.** SDK error objects carry the
  outbound request, and the outbound request carries the API key. Every boundary
  uses `safeMessage()` / `redactedMessage()`. `model_calls.error` is a durable
  column, so an unredacted message there is a permanent leak.
- Google refresh tokens are AES-256-GCM encrypted (`services/tokens.ts`) with a
  key held outside Postgres. The AAD is the user id, so a ciphertext moved into
  another user's row fails to decrypt. Revoking consent nulls the token in the
  same statement, and a CHECK constraint enforces that pairing.
- The ingest script takes credentials from the environment, never `argv`. Process
  arguments are world-readable in `ps`, land in shell history, and are captured by
  most process telemetry.

---

## 5. Prompt injection

A receipt is a picture of text and the text can say anything. That text reaches a
model whose output becomes a dollar figure, and eventually a message sent to
DoorDash under the user's name. Four layers, in `core/untrusted.ts`:

1. **Trust-boundary preamble** on every system prompt, naming a per-call random
   nonce and stating that fenced content and image text are data.
2. **Structured output** (zod), with `.max()` on every string and array. There is
   no free-text channel to hijack, and no way to drive a 10,000-element response
   into `model_calls.output`.
3. **Neutralisation** of control characters, zero-width/bidi characters, and
   instruction-shaped markers.
4. **Plausibility bounds** on every value after the model has spoken.

Layer 4 is the one that protects the money. An injected `$99,999.00` satisfies
every schema and parses as valid currency; `assertPlausibleReceiptAmount` is what
stops it. Layer 3 is explicitly **not** a filter that makes untrusted text safe —
treating it as one is how these systems get broken.

Both prompts also ask the model to report injection attempts verbatim into
`suspiciousInstructionText`, so an attack lands in the audit trail rather than
only in whatever it managed to change.

Item names and modifiers go through `boundedUntrustedName()` before storage,
because they are later interpolated into the claim-text prompt — an item name is a
second-order injection vector into a message sent under the user's name.

---

## 6. Memory

Every payload here is held in full, so size limits are a security control as much
as a performance one — an unbounded buffer is a denial of service with extra
steps. `LIMITS` in `core/untrusted.ts` is the single place they live.

### Bounded inputs

| Limit | Value | Why |
|---|---|---|
| `maxImageBytes` | 3.5 MB | One photo, and it expands ~1.37× again as base64 |
| `maxImagesPerCall` | 8 | Photos per order |
| `maxHtmlBytes` | 2 MB | Real DoorDash receipts are 100–300 KB |
| `maxMessageBytes` | 8 MB | Whole Gmail message, checked before the body is fetched |
| `maxItemsPerReceipt` | 200 | Also a zod `.max()`, so an adversarial image cannot drive a huge response |
| `maxMimeDepth` | 20 | Unbounded recursion over attacker-chosen MIME nesting is a stack overflow |

### What was fixed, and what it cost before

**Detection ran as one call over every photo.** Eight buffers *and* their eight
base64 encodings were alive simultaneously — ~28 MB of binary plus ~38 MB of
string for a single detection. It is now one call per photo (`detectPhoto`),
processed sequentially, so exactly one encoding exists at a time. `detectDeliveredItems`
loops and merges via `core/dedupe.ts`, and takes an optional `release` callback so
a backfill can drop each buffer after it is sent.

That change was owed anyway: batching gave one flat list with no way to say which
photo a detection came from, and the old code attributed every one of them to the
first photo — a lie sitting in the evidence column of a refund claim
(`research/findings/RESPONSES.md` R5).

**Gmail fetched `format: "full"` before checking the sender.** The entire MIME
tree — every inline image and attachment, base64-expanded — was pulled into memory
and only then was the `From` header examined. It is now a two-phase fetch:
`format: "metadata"` for headers and `sizeEstimate`, and the body is downloaded
only for a message that is both from a real DoorDash domain and under
`maxMessageBytes`. Spoofed and oversized mail costs a few headers.

**Other allocation fixes:**

- `Buffer.concat` dropped from image hashing — it copied every byte of every photo
  purely to compute a digest. Now an incremental `createHash`.
- `putRawReceiptHtml` encodes the string once and both hashes and uploads that one
  buffer, instead of making two full copies of every receipt.
- `getArtifact` checks the declared blob size before materialising the body, so an
  oversized object is rejected without ever being in memory.
- `ingestGmailReceipts` issues one dedupe query per page rather than one per
  message — a 500-message backfill was 500 sequential round-trips for a
  set-membership test.
- `userDb`'s client cache is bounded (32) and keyed by a hash of the token, not the
  token: an unbounded cache keyed by JWT is a memory leak with a user-controlled
  key, and the map is reachable from a heap dump.
- `core/diff.ts` profiles each name once instead of re-normalizing inside the
  `n × m` scoring loop. A 40-line order against 30 detection groups went from
  4,800 NFKD normalizations and 4,800 throwaway `Set`s to 140.
- `core/assign.ts` uses `Float64Array`/`Int32Array` scratch space allocated once
  and refilled per row. It previously built two fresh arrays inside the row loop.
- `core/money.ts` `splitByLargestRemainder` went from four arrays plus one object
  per weight to two, sorting an index array instead of `{index, fraction}` objects.
- `redact()` checks `includes` before `split`/`join`. It runs on every error the
  system produces, and almost no error contains a live secret, so the common path
  should not rebuild the string once per registered credential.
- `Math.min(...array)` replaced with a loop in `diffOrder` — the spread allocates
  an intermediate array *and* pushes one argument per element onto the call stack,
  which is a `RangeError` rather than a slow path once the array is large enough.

---

## 7. Known gaps

- **The migrations have never been run.** `0003`, `0004` and `0005` are unexecuted
  SQL, like `0001` and `0002` before them (docs/GAPS.md #5, S1). The RLS policies
  and the admin gates *are* the security model, and nothing has validated their
  syntax, let alone their behaviour. `tests/schema.test.ts` checks that the SQL
  says what we think it says; it does not and cannot check that it runs. First
  thing against a real project: `supabase db push`, then attempt a cross-tenant
  read from a second user's session and confirm it fails.
- **No auth surface exists yet.** `UserContext` requires a Supabase access token;
  nothing currently issues one (GAPS #8). The plumbing is right and typechecked,
  but end to end it is unproven — including every admin gate, which is why
  `tests/admin.test.ts` stubs the database and says so in its header.
- **No admin UI.** `services/admin.ts` returns rows; nothing renders them. The
  boards are queryable, not visible.
- **`adminDb("gmail_ingest_worker")` has no caller.** The reason is declared for a
  background worker that does not exist. Ingestion today runs under a user context.
- **`insert_order_full` is untested against a live database.** It is the atomicity
  guarantee for order + items + fee lines and it has only been typechecked.
- **The first admin has no bootstrap script.** `grantRole` works, but granting
  admin #1 currently means running it from a Node REPL with the service-role key.
  That is honest — it is an operator action — but it is not yet a documented one.
