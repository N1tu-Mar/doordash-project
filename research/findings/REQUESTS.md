# REQUESTS — Builder (Agent A) → Researcher (Agent B)

The only file Agent A writes inside `research/`. PROMPT.md §7.

Ordered by how much they block shipping. Each says what is blocked, what would
unblock it, and what a usable answer looks like.

---

## R1 — DoorDash receipt email DOM (BLOCKING, highest priority)

**Blocks:** `ingest/gmail.ts` → `parseReceiptHtml()`, which currently throws
`GMAIL_PARSER_NOT_IMPLEMENTED`. Raw HTML ingestion works and is already storing
real mail; nothing can be parsed out of it yet.

Writing this parser against an imagined DOM would produce plausible wrong numbers
on real mail, and those numbers go into refund claims. So it is not written.

**Need — `research/findings/receipt-formats.md`, `READY FOR BUILD`:**

1. The element/selector path to each field on a real receipt email: merchant name,
   merchant address, order timestamp, each item line (name, quantity, line total),
   modifier lines and how they nest under their item, subtotal, each individual fee
   line with its printed label, tax, tip, total.
2. How **quantity** is expressed. `2x Item` in the name string? A separate cell?
   `core/parse.ts` and `services/vision.ts` currently assume the printed line total
   divides evenly by quantity and throw when it does not — confirm or correct that.
3. **Promo, credit and DashPass discount lines.** Where they appear and whether they
   reduce the printed subtotal or sit as their own line. `orders.balance_delta_cents`
   records the gap between the stated total and the parsed lines; tell us what a
   legitimately non-zero delta looks like so we can tell drift from a promo.
4. **Format variance:** chain vs local restaurant, grocery (DashMart) vs restaurant,
   multi-merchant DoubleDash orders, and whether the layout differs by year. Enough
   concrete cases that the parser is written against variance, not against one email.
5. Whether receipts are ever text/plain only. `findHtmlPart()` currently skips any
   message with no `text/html` part and persists nothing for it.

## R2 — Receipt search query precision

**Blocks:** nothing, but it decides corpus size and whether we ever store mail we
should not.

`RECEIPT_QUERY` in `ingest/gmail.ts` is a guess:
`from:doordash.com (subject:"order receipt" OR subject:"Your DoorDash order" OR subject:receipt)`

**Need:** the actual sender addresses and subject lines DoorDash uses for order
receipts, and which of their other mail (marketing, delivery status, ratings
prompts) would slip through this filter. §3.2 forbids persisting the body of
anything that is not a receipt, so a false positive here is a rule violation, not
just noise.

## R3 — Fuzzy match threshold for item names

**Blocks:** accuracy, not shipping.

`FUZZY_MATCH_THRESHOLD = 0.6` (Jaccard over normalized tokens) in `core/diff.ts` is
an unmeasured guess. Deliberately no synonym table, no stemming, no size-word
stripping — a wrong guess there becomes a wrong dollar amount.

**Need:** from the vision eval (§7.2), the threshold that maximizes correct pairings
between real receipt item names and real detection output, plus the failure cases at
that threshold. If real receipt names and real detections differ in ways Jaccard
cannot bridge, say so and propose what does — as a findings file; A implements it.

## R4 — Refund policy reality (§7.3)

**Blocks:** `services/claim.ts` wording and what the claim should actually ask for.

Specifically, beyond the §7.3 brief:
- Does DoorDash's own flow already refund fees and tax proportionally, or only the
  item price? This is the product's entire premise and it is currently unverified.
- Is the tip refundable at all, by policy or by jurisdiction? `core/money.ts` computes
  `tipShareCents` as a separate toggleable line because §5 says the answer is arguable;
  if there is a real answer, the default state of that toggle should follow it.

## R5 — Per-photo attribution for detections

**Blocks:** evidence quality in the claim PDF, not shipping.

`detectDeliveredItems()` sends all delivered-food photos in one call, so a detection
cannot be attributed to a specific photo. Every detection is currently tagged with the
first photo's path, with a comment saying why. Attributing them honestly means either
one call per photo (more calls, no cross-photo dedupe) or asking the model to name the
photo index. Which is more accurate is an eval question.

---

# Round 2 — opened after implementing the READY FOR BUILD findings

R1, R2 and R4 stay open as written. R3 and R5 are answered enough to build
against, and what landed is described below so B can aim the eval at it.

## R3 / R5 — implemented, now measurable

R3's structural points are in: `core/diff.ts` scores every pair and solves a
global assignment (`core/assign.ts`), with `FUZZY_MATCH_THRESHOLD` demoted to a
floor on acceptable pairings, and `nameSimilarity` taking the better of
whole-string and head-noun overlap. The threshold value is still the guess it
always was — the sweep in R3 is still wanted, now against a matcher whose
failures are worth attributing.

R5 is in as one call per photo plus a pure merge in `core/dedupe.ts`.

## R6 — the real fee-line vocabulary

**Blocks:** how much of a claim we can actually ask for.

`core/fees.ts` classifies fee labels against the vocabulary named in
`money-model.md` Correction B and returns `unknown` for everything else. An
`unknown` fee is never pro-rated into a number the user sends, so every label we
cannot name is money left on the table.

**Need:** from the receipt corpus, the actual set of fee labels DoorDash prints,
with the exact strings, per vertical (restaurant / grocery / convenience) and
per market where they differ. For each, which kind it is:

- `proportional` — a stated percentage of subtotal
- `per_delivery` — charged once for the trip
- `threshold` — charged because the order was small
- `passthrough` — a per-item or per-order pass-through

Where the receipt does not disclose enough to classify a line, say so — that is
a real answer and `unknown` is the correct behaviour for it.

## R7 — cross-photo duplicate rate

**Blocks:** nothing. Sharpens `core/dedupe.ts`.

The same item name appearing in two delivered-food photos is ambiguous: one item
shot twice, or two items in two frames. Summing double-counts and taking the max
under-counts, and both errors are the expensive kind. `mergePhotoDetections`
takes the max and flags `crossPhotoAmbiguous` so the human resolves it.

**Need:** from the captured corpus, how often that flag fires, and how the human
resolves it when it does. If it is almost always one item shot twice, the flag
is costing confirmation-screen attention for nothing and the default can change.
If it is genuinely mixed, the flag stays and the confirmation UI should lead
with it.

Worth stratifying by `capture_quality` (`laid_out` / `partial` / `bagged`) —
which is now a column, per `vision-and-models.md` §7.

## R8 — does an order-level discount actually reduce what DoorDash refunds?

**Blocks:** nothing. Decides whether Correction A is right in practice.

`core/money.ts` implements `money-model.md` Correction A: an order-level promo is
allocated to the missing items, so a $12 item on an order with a $5 promo is
claimed at its discounted value, not $12. The reasoning is that claiming menu
price over-states and hands the reviewer a reason to deny.

**Need:** from the calibration data (`money-model.md` §6), whether promo orders
actually recover at a lower rate when claimed at menu price. If they do not, the
correction costs users money for a theoretical risk. This is answerable from
`claims.owed_breakdown` vs `recovered_cents` once ~20 real claims exist, and it
is exactly the kind of question the claims table was added to answer.
