# Merging `feat/product-hardening` into `main`

Two Claude Code sessions ran against this repository at the same time, both
acting as Agent A. `prompt.md` §7 splits builder from researcher, not builder
from builder, so nothing prevented the overlap. This file is the resolution.

Delete it once the merge has landed.

---

## What each side owns

| Side | Work |
|---|---|
| `main` | Security hardening: `services/secrets.ts`, `services/admin.ts`, `core/untrusted.ts`, `services/tokens.ts`, an RLS-enforcing `services/db.ts` (`userDb` / `adminDb`), migrations `0003`–`0005` |
| `feat/product-hardening` | The READY FOR BUILD findings: `core/money.ts` + `fees.ts`, `core/diff.ts` + `assign.ts`, `core/dedupe.ts`, `core/claim.ts` + `services/claim.ts`, migration `0006`, CI/CD, `docs/DEPLOYMENT.md` |

They meet in exactly two places.

---

## 1. `services/db.ts` — take theirs

`main`'s version is the better one. It enforces RLS by default, routes every
service-role use through a named reason, and scrubs Postgres errors before
re-throwing. Nothing on this branch improves on that.

This branch touches it in four small hunks, all mechanical:

```
- import { receiptBalanceDeltaCents, type ReceiptTotals } from "../core/money.js";
+ import type { ReceiptMoney } from "../core/money.js";
+ import { feeLineRows, orderMoneyColumns } from "./order-row.js";

-   totals: ReceiptTotals;
+   totals: ReceiptMoney;

-     subtotal_cents: …, fees_cents: …, tax_cents: …, tip_cents: …,
-     total_cents: …, balance_delta_cents: …
+     ...orderMoneyColumns(input.totals),

+   // after the items insert:
+   insert feeLineRows(orderId, input.totals) into order_fee_lines
```

**Resolution:** `git checkout --theirs services/db.ts`, then re-apply those
four. `ReceiptTotals` no longer exists — `core/money.ts` replaced it with
`ReceiptMoney`, which carries `feeLines` and an optional `taxableBaseCents`
instead of a scalar `feesCents`. That rename is not optional; it is what the
fee-line taxonomy and the tax correction are built on.

`main`'s `insertOrder` writes through the `insert_order_with_items` RPC rather
than two statements. Fold `orderMoneyColumns()` into the RPC arguments, and
either extend the RPC to take fee lines or insert them in a second statement —
the RPC is the better home, since a partial write is what it exists to prevent.

`services/order-row.ts` is a new file and merges clean. It is where the mapping
lives now, so the same reconciliation does not have to happen twice.

## 2. Migrations — both apply, in number order

No conflict. `0006_claims_and_labels.sql` was renumbered off `0004` once
`0004_roles_and_admin.sql` appeared, and it depends on nothing in `0003`–`0005`
— only on tables from `0001` and `0002`.

One thing was deliberately removed to avoid duplicating `main`: this branch
originally added `orders.fee_lines` as jsonb. `0005` already creates
`order_fee_lines` as a real table with RLS, a `kind` column and a `line_index`.
That is the better representation and it is the one that survived. Do not
reintroduce the jsonb column.

After merging, add `main`'s new tables to the RLS and policy lists in
`supabase/ci/01_assert_schema.sql` — `user_roles`, `admin_audit_log`,
`order_fee_lines`. The lists are explicit on purpose: a table that appears
without anyone deciding it should be covered is a table nobody checked.

## 3. Everything else merges clean

`core/` is additive on this branch except `money.ts` and `diff.ts`, which
`main` has not modified. `main`'s `0005` comments already reference
`core/money.ts` `FeeKind` and `FEE_POLICY`, so that side was written against
this branch's committed core work and expects it.

---

## After merging

1. `pnpm typecheck && pnpm test` — 100+ green.
2. `pnpm test:corpus` — still red, still correct. It reports that the money math
   is unverified against real receipts, and it turns green by importing a real
   order, not by editing the test.
3. Push and watch the `schema` CI job. It is the first time any of this SQL has
   executed: there is no Docker or Postgres on the development machine, so
   migrations `0001`–`0006` and the schema assertions have only ever been read,
   never run. Expect the first run to find something.
4. Delete this file.
