# Schema

What each table is for, why it is shaped that way, and which invariants live in
the database rather than in TypeScript.

The governing idea: **anything that must always be true is a constraint, a
trigger, or a policy — not a code review comment.** Application code is where
good intentions go to be forgotten, and this schema stores numbers people send to
a company asking for money back.

Migrations apply in order. `0001`/`0002` are the original tables; `0003` fixed the
security model; `0004` added roles; `0005` reconciled the tables with
`core/money.ts`. None of them have ever been executed — see GAPS #5.

---

## Tables

### `orders`

One real DoorDash order. `source` is `gmail | photo | manual_entry` and there is
deliberately **no `seed` value**, so no fixture script can insert an invented
order even by accident (PROMPT.md §2). Widening that enum takes a migration.

Money is integer cents, non-negative, never nullable. `subtotal_cents > 0` is its
own named constraint because `core/money.ts` divides by it.

`raw_artifact_path` points at the unmodified email HTML or receipt image, stored
**before** parsing. It and `source` are immutable by trigger: when the parser
improves we re-run it over the original bytes, and a parser bug must not be able
to rewrite what it was given.

`balance_delta_cents` is the signed gap between the printed total and the sum of
the parsed lines. Promos, credits and DashPass discounts make it legitimately
non-zero. It is recorded rather than absorbed so parser drift is visible.

`fees_cents` is a **denormalised sum** of `order_fee_lines`. The lines are the
truth; see below.

**Dedupe** (`orders_dedupe_idx`) is unique on user, merchant, address, minute and
total. It used to be unique on user, merchant, full timestamp and total, under a
comment claiming it covered address and minute — so two imports of one receipt
whose parsed timestamps differed by a second were two orders. `0005` made the
index match its comment. Truncation is in UTC because a unique index needs an
immutable expression.

`ordered_at` cannot be more than a day in the future (trigger, because `now()` is
not immutable in a `CHECK`). A receipt dated next year is a parse bug that would
sort to the top of every list forever.

### `order_items`

Receipt lines, verbatim. Names are **never normalized on write** — normalization
happens at compare time in `core/diff.ts`, because you cannot recover the original
once you have mangled it. `line_index` preserves the order the user saw.

No `UPDATE` policy: a line item is what the receipt said. Correcting it means
re-parsing, not editing the record of what was read.

### `order_fee_lines` *(0005)*

One row per printed fee line, with its `kind` from `core/money.ts`'s taxonomy:
`proportional | per_delivery | threshold | passthrough | unknown`.

This table exists because a single `fees_cents` integer threw away the thing the
arithmetic branches on. Fee lines do not behave alike when part of an order never
arrives:

- a **service fee** is a percentage of the subtotal, so an undelivered subtotal
  cannot carry it — it pro-rates;
- a **delivery fee** bought a delivery that did happen — the weakest line, and
  off by default;
- a **small order fee** would have gone *up* if the missing items had never been
  ordered — it never pro-rates;
- `unknown` is a real, expected value. A fee we cannot name is shown to the user
  and never folded into a number they send.

Without the kinds, a claim recomputed from a stored order cannot reproduce the
claim the user actually sent.

### `discrepancies`

What the model said and what the human said, in **separate columns, forever**.
`detected_items` is immutable by trigger; `confirmed_items` is ground truth and
may be corrected. The delta between them *is* the eval set — merging them would
destroy the only measurement §6 asks for.

`0005` added `owed_with_tip_cents`, `owed_maximum_cents` and `owed_components`.
Storing a single total made a past claim irreproducible: "$14.20" does not say
whether the delivery fee was included, and an eval then compares the model against
a number nobody sent.

`user_id` is derived by trigger from the order and is never accepted from the
client — a client-supplied owner would be a second, forgeable source of truth for
who owns the row. It exists so RLS is a direct comparison rather than a join that
gets copied wrong the fourth time someone adds a table.

`photo_paths` entries must be content-addressed artifacts under the order owner's
own storage prefix, enforced by trigger. A claim citing another user's photo is
both a leak and broken evidence.

No `DELETE` policy: a confirmed discrepancy is evidence.

### `model_calls`

Every Claude call: model, prompt version, input hash, latency, and **either**
output **or** error, never both (`model_calls_output_xor_error`). Failures are
recorded, not swallowed — an unlogged call is an accuracy measurement nobody can
reconstruct.

**Append-only**, by policy *and* by trigger. The policy binds `authenticated`; the
trigger also binds the service role. An accuracy log the audited party can rewrite
measures nothing.

`input_hash` is constrained to a sha256 hex string (`0005`), because grouping
repeat calls on one image is the whole point of the column.

### `gmail_ingest_consents`

Explicit, revocable, in-app consent, with the exact agreed text stored verbatim.
Changed wording is a **new row**, never an edit. A partial unique index allows one
active consent per user.

`refresh_token_encrypted` (0003) holds an AES-256-GCM envelope from
`services/tokens.ts`, keyed outside the database. Two constraints back it: the
format must be an envelope (so a plaintext token cannot be stored by mistake), and
a revoked consent must carry no token at all.

No `DELETE` policy. Consent is revoked, never erased — the record that access was
once granted is the point of the table.

### `gmail_messages`

One row per receipt email seen, with its storage pointer and the verified
`sender`. `order_id` stays null until a parser succeeds: a row here with no order
is a real receipt we have and cannot yet read — countable, and re-runnable once
the parser improves. That is precisely why raw-before-parsed is a rule.

### `user_roles` *(0004)*

`admin` and `reviewer` grants, with `granted_by` and a **required** `reason` — an
unexplained grant is the one you cannot audit six months later. `granted_by = null`
means bootstrap.

Users may read their own row (so an app can hide a nav item) and admins may read
all. **Nobody holds a write grant.** See docs/SECURITY.md §3.

### `admin_audit_log` *(0004)*

Actor, action, and counts for every privileged read. Append-only by trigger.
Carries no row content: an audit log that copies the data it audits doubles the
blast radius of reading it.

---

## Views

| View | Scope | Gate |
|---|---|---|
| `merchant_shortage_index` | Caller's own orders (`security_invoker = on`) | `n >= 20` |
| `admin_model_accuracy` | All users | `is_reviewer()` |
| `admin_corpus_coverage` | All users | `is_reviewer()` |
| `admin_merchant_shortage_index` | All users | `is_admin()`, `n >= 20` orders **and** `>= 5` distinct users |
| `admin_ingest_health` | All users | `is_admin()` |

`merchant_shortage_index` is honestly close to dead: running under the caller's
RLS, its `n >= 20` gate means twenty orders from *one person* at *one location*.
That is correct — a rate from one household is not a rate — and it is why the
cross-user version exists as a separate, admin-gated view rather than as a
loosening of this one.

Every `admin_*` view carries its role predicate **in its own body**, so a
non-privileged caller gets zero rows rather than an error. The gates are in SQL
where no caller can route around them by writing a different query.

---

## Functions

| Function | Rights | Purpose |
|---|---|---|
| `insert_order_full` | invoker | Atomic order + items + fee lines |
| `has_role` / `is_admin` / `is_reviewer` | **definer**, stable | Role predicates callable from inside RLS policies |
| `reject_*` triggers | invoker | Immutability and ownership enforcement |

Every function pins `search_path`. A mutable one lets an attacker-created schema
shadow the operators a function resolves — the classic Postgres escalation.
`tests/schema.test.ts` fails if any definition loses its pin.

`insert_order_full` takes **no `user_id` argument** — it reads `auth.uid()` — and
derives `fees_cents` by summing the fee lines it was given. Neither is a parameter
a caller can get wrong. All three inserts share one transaction: an order missing
its items or its fee kinds understates a refund *without looking wrong*, which is
the quiet-wrong-number failure §2 exists to prevent.

---

## Storage

Two private buckets, `raw-receipts` and `delivered-photos`, with a MIME allowlist
and a 3.5 MB per-object cap. Keys are `<userId>/<sha256>.<ext>`; policies test
`(storage.foldername(name))[1] = auth.uid()::text`.

`SELECT` and `INSERT` policies only. Raw artifacts are the corpus — a parser bug,
or a user acting on a claim they later regret, must not be able to destroy the
evidence the claim was built on. Erasure for a real request is an operator action.

---

## Things that are still wrong

- **None of this has run.** GAPS #5 / S1. Syntax, triggers, policies and views are
  all unvalidated.
- **`gmail_ingest_consents.scopes`** is checked for non-empty entries but not
  against the actual scope vocabulary.
- **No `updated_at` anywhere.** Nothing needs it yet; it will be missed the first
  time someone debugs a sync.
- **Deleting a user cascades away their `model_calls`.** Right for privacy, wrong
  for a long-run accuracy series. Nobody has decided which matters more.
