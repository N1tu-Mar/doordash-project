# `core/money.ts` — specification, edge cases, and the calibration protocol

## Status
READY FOR BUILD — algorithm, invariants, and test obligations.
DRAFT — every claim about *what DoorDash itself pro-rates*. That is unsourced (see
`refund-policy.md` §6 Q1) and must be measured, not assumed.

**Framing that matters:** this function computes **what the user is owed**, not **what DoorDash
will pay**. Those are two different numbers and the gap between them is the entire product thesis.
Store both. `owed_cents` (ours, deterministic) and `recovered_cents` (observed, entered later).
`recovery_ratio = recovered / owed` is the metric that proves the app works, and it cannot exist
if the two are collapsed into one column.

---

## 1. The base formula, corrected

PROMPT §5 gives:
```
item_share = missing_items_subtotal / order_subtotal
owed       = missing_subtotal + round(fees*share) + round(tax*share) + round(tip*share)
```
This is right in shape and wrong in three places on real receipts.

### Correction A — the denominator is a *taxable/feeable base*, not the printed subtotal
Order-level promotions, DashPass discounts, and merchant offers sit between line items and the
printed subtotal. If `sum(line_totals) != printed_subtotal`, the difference is a discount that must
be allocated to the missing item too, or the claim **over-states** and hands the reviewer a reason
to deny.

```ts
lineSum        = Σ(qty * unit_price_cents)      // pre-discount
orderDiscount  = lineSum - subtotal_cents        // >= 0 normally; < 0 means parse failure -> throw
missingGross   = Σ over missing items of (qty_missing * unit_price_cents)
missingNet     = missingGross - allocate(orderDiscount, missingGross / lineSum)
share          = missingNet / subtotal_cents     // basis for every fee line
```
If `orderDiscount < 0` (line items exceed subtotal), that is a parse bug, not a discount. **Throw
and surface**, per PROMPT §2 failure behavior. Never clamp to zero.

### Correction B — allocate fee lines individually, not as one `fees_cents` blob
Different lines have different defensibility, and the claim text is stronger when they are named.
Keep `fee_lines: {label, cents, kind}[]` rather than a scalar. Suggested `kind` classification —
this drives *both* the math and the argument:

| kind | Examples | Pro-rate? | Rationale in claim text |
|---|---|---|---|
| `proportional` | Service Fee | **Yes** | Explicitly a % of subtotal; an undelivered subtotal cannot carry it |
| `per_delivery` | Delivery Fee, Long Distance Fee, Expanded Range, Weather Impact | **Argue, flag separately** | Delivery did occur. Weakest line. Default **off** in the claim, toggle on |
| `threshold` | Small Order Fee | **Special** | See Correction D |
| `passthrough` | Regulatory Response Fee, Bag/Bottle fee | Yes if per-item, No if per-order | Needs corpus evidence; default off, flag as unknown |
| `tax` | Estimated Tax | **Recompute, don't scale** | See Correction C |
| `tip` | Dasher Tip | Separate toggle, default **on but visible** | PROMPT §5 already mandates this |
| `unknown` | anything unmatched | **Never silently included** | Surface to the user by label |

`unknown` must never be pro-rated into a total the user sends. Show it, ask, or omit.

### Correction C — tax is recomputed, not scaled
Scaling tax by `share` is *approximately* right and *provably* wrong wherever the order mixes
taxable and non-taxable items (prepared food vs. grocery staples — a real case for
convenience/grocery orders), or where fees are themselves taxed at a different rate.

```ts
effectiveTaxRate = tax_cents / taxableBase_cents   // derive per order, never hardcode
taxOwed          = round(missingNetTaxable * effectiveTaxRate)
```
`taxableBase` is unknown from the receipt alone in mixed orders. **Detect the mixed case and
degrade honestly**: if `|derivedRate - anyPlausibleRate|` cannot be resolved, mark the tax component
`uncertain` and exclude it from the headline figure rather than guessing. A slightly smaller
specific number still gets paid; an inflated one invites a denial.

### Correction D — the small-order fee can *invert*
If removing the missing items would have dropped the order under the small-order threshold, the
user did not overpay this fee — they underpaid relative to the smaller order. Do **not** pro-rate
it, and never let it produce a negative component. Clamp at the component level with an assertion,
not silently.

### Correction E — DashPass and $0 lines are not special cases
If `delivery_fee_cents == 0`, the proportional share is 0 and the math is already correct. Do not
branch. Do assert that a $0 line still parses as present — a missing line and a zero line are
different facts and the corpus must distinguish them.

---

## 2. Rounding — largest remainder, not independent rounds
PROMPT §5 says "round each component independently, then sum." Correct for a **single** missing
item. With multiple missing items, independent rounding drifts: N items each rounding up on the
same fee line can exceed the fee line itself.

Rule:
1. Round each **fee-line component** independently (PROMPT's rule) → gives `owed_cents`.
2. When splitting a component across **multiple missing items** for display, use **largest
   remainder**: floor everything, then distribute the leftover cents to the largest fractional
   parts. Guarantees `Σ per-item = component total` exactly.
3. All arithmetic in integer cents. No floats anywhere near a dollar amount (PROMPT §4). Ratios may
   be floats *inside* one expression; never store one.

## 3. Invariants — these are the property tests
```
INV-1  owed_cents >= missingNet                          # never below the item value
INV-2  owed_cents <= total_cents                          # PROMPT §5, assert it
INV-3  per-component owed <= that component's line value  # can't reclaim more service fee than paid
INV-4  Σ(per-item split) == component total               # largest-remainder correctness
INV-5  owed(all items missing) == total_cents             # exactness at the boundary
INV-6  owed(no items missing) == 0
INV-7  monotone: adding a missing item never decreases owed_cents
INV-8  owed_cents > 0 whenever missing set is non-empty and item price > 0
```
INV-5 is the sharpest test in the set — if every item is missing, the user is owed the whole ticket,
and any allocation scheme that doesn't reproduce `total_cents` exactly has a leak. Run it over every
real receipt in the corpus. It needs no hand-labeling, so it works from receipt #1.

INV-7 must hold **with the tip toggle in a fixed position** — flipping the toggle legitimately
lowers the total.

Property-test generator note: PROMPT §2 bans fake *data*. Property tests over the **arithmetic**
(random cent quantities in a pure function) are not fake receipts and are not banned — but the
**expected-value tests must use real corpus receipts with hand-verified totals** (PROMPT §5). Both.

## 4. Multi-merchant (DoubleDash) — decide before writing the schema
A DoubleDash order carries two merchants under one payment. If the missing item belongs to
merchant B, `share` computed against the **combined** subtotal spreads merchant A's fees into the
claim, which is both wrong and the kind of wrong a reviewer spots.

Required: `order_items.merchant_id`, and fee lines tagged as `scope: 'order' | 'merchant'`. If the
receipt does not disclose which merchant a fee belongs to, that is a **corpus question, not a
guess** — mark `fee_scope_unknown` and exclude the ambiguous line from the headline number.
This also protects the §3.5 shortage index: a shortage must attribute to the location that shorted
it, not to whichever merchant was first on the receipt.

## 5. Grocery / convenience — weight-adjusted and substituted items
Two behaviors the restaurant model doesn't have:
- **Weight-adjusted items** ("sold by lb"): the charged price differs from the ordered price and a
  post-delivery adjustment can change the total *after* the original receipt email. The original
  receipt is therefore **not** the final ledger. Schema must tolerate an order whose authoritative
  totals arrive in a later artifact, without mutating the raw one (PROMPT §9).
- **Substitutions**: a substituted item is neither `missing` nor `wrong_item` in the sense the diff
  assumes. The `discrepancies.kind` enum in PROMPT §4 has no value for it. Recommend adding
  `'substitution_unwanted'` — Agent A's call, flagged here rather than assumed.
Both are unverified against real emails. See `receipt-formats.md`.

## 6. Calibration protocol — the only way to answer "what does DoorDash actually pro-rate"
No source describes it. Measure it. This costs nothing extra because the operator is already
placing real orders (PROMPT §3.1).

For every claim actually filed, record:
```
owed_cents            # our computation, at the moment of filing (immutable)
owed_breakdown        # per-component, so a shortfall can be attributed to a line
claimed_cents         # what the user actually sent, after tip toggle
recovered_cents       # observed outcome
recovery_kind         # card_refund | account_credit | partial | denied | ignored
recovered_at, denial_reason_text (verbatim, never normalized)
```
After ~15–20 real filed claims, `owed_breakdown - recovered` per component tells you exactly which
fee lines DoorDash returns and which it keeps. **That is proprietary data no competitor has and no
web search can produce**, and it converts open question §6-Q1 into a measured constant with a
sample size attached. Apply the same n≥20 honesty rule as §3.5 before displaying any rate.

Do not use it to *cap* `owed_cents`. Owed is what's owed. Use it to set expectations in the UI and
to decide when to escalate from goodwill request to the Reg Z path in `refund-policy.md` §3.

## 7. Test obligations (blocking, per PROMPT §5)
- [ ] INV-1..INV-8 as property tests over integer-cent inputs
- [ ] Expected-value tests against ≥10 **real** corpus receipts, hand-verified, one per format class
      in `receipt-formats.md`
- [ ] One mixed taxable/non-taxable grocery receipt (Correction C)
- [ ] One DoubleDash receipt (§4)
- [ ] One promo/discount receipt where `lineSum != subtotal` (Correction A)
- [ ] One small-order-fee receipt (Correction D)
- [ ] Malformed input: negative discount, missing fee line, `unknown_fee` present → all must throw
      or flag, none may silently produce a number
