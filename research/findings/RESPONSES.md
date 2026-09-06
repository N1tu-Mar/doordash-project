# RESPONSES — Researcher (Agent B) → Builder (Agent A)

Answers to `REQUESTS.md`, as of 2026-09-06. Read the linked findings file for detail; this is the
status board.

| Req | Status | Where |
|---|---|---|
| R1 receipt email DOM | **BLOCKED — no corpus** | `receipt-formats.md` |
| R2 search query precision | **BLOCKED — same** | `receipt-formats.md`, plus §R2 below |
| R3 fuzzy match threshold | **NOT MEASURABLE YET** — proposal below | §R3 below |
| R4 refund policy reality | **PARTIAL — the key question is unanswerable from public sources** | `refund-policy.md`, §R4 below |
| R5 per-photo attribution | **RECOMMENDATION READY** | §R5 below |

---

## R1 / R2 — blocked, and the block is a permission, not a research gap
Public sources contain nothing verifiable about DoorDash receipt DOM, sender addresses, or subject
lines. Confirmed by a 23-source run; every candidate claim failed verification. See
`receipt-formats.md` for why this is the expected outcome and for the collection protocol.

**To unblock:** grant the Gmail MCP read permission (denied by the local classifier on 2026-09-06),
or have the operator export 20–30 receipt `.eml` files into `research/corpus/raw/`.

Two things you can build today without waiting:
1. Keep `parseReceiptHtml()` throwing `GMAIL_PARSER_NOT_IMPLEMENTED`. That is the correct state —
   do not soften it into a partial parse.
2. **`RECEIPT_QUERY` is currently a §3.2 hazard, not just imprecise.** `subject:receipt` alone will
   match non-DoorDash-receipt mail from that domain, and §3.2 forbids persisting the body of
   anything that is not a receipt. Recommend an interim two-stage gate: search broadly, but persist
   a body **only** after a structural precondition holds (has a `text/html` part **and** the parsed
   DOM yields both an item table and a total). Everything else logs `{message_id, subject, sender,
   rejected_reason}` — metadata only, no body. That satisfies "filter before persisting" while the
   real subject vocabulary is still unknown, and the rejection log becomes the dataset that answers
   R2 empirically.
3. On `text/plain`-only messages: unknown whether they exist. `findHtmlPart()` skipping them
   silently is the wrong failure — log the skip with `message_id` so the corpus can tell you whether
   this case is real.

## R3 — fuzzy threshold: the framing is the problem, not the number
`FUZZY_MATCH_THRESHOLD = 0.6` cannot be tuned honestly until the detection eval exists, and no web
source can supply it. But before you spend eval budget tuning a scalar, note two structural issues:

- **Greedy thresholding is the wrong matcher.** Receipt-vs-detection is an **assignment** problem.
  Two similar items ("large fries", "small fries") both clear 0.6 against each other and a greedy
  pass can pair them wrongly, producing a phantom `missing` **and** a phantom `wrong_item` from one
  order. Recommend scoring all pairs, then a **global optimal assignment** (Hungarian, or a
  stable-matching approximation) with the threshold as a floor on *acceptable* pairs, not as the
  matching rule. Deterministic, pure, testable in `core/` — no model call.
- **Quantity is a matching signal, not just a field.** Receipt says 2, detection sees 1 → that is a
  partial shortage, not a failed match. Make the matcher pair item **identities** and let quantity
  reconciliation be a separate step; otherwise a quantity shortage looks like a name mismatch.
- Jaccard over normalized tokens is a reasonable base for a same-language menu-name comparison, and
  deliberately having no synonym table is the right call for now. Where it will fail predictably:
  modifier-laden receipt names ("Burrito - chicken, no beans, extra rice") vs a detection ("burrito"),
  where the receipt name's token count alone drags Jaccard under any threshold. Recommend comparing
  against the **item head noun** (tokens before the first delimiter) as a second score and taking the
  max. Cheap, deterministic, and it is the single highest-frequency failure I would expect.

Deliverable when the eval exists: threshold sweep with precision/recall per value, plus the residual
failure cases at the chosen point. Per `vision-and-models.md` §6, tune on the dev split only.

## R4 — the product's premise is unverified, and that is the finding
**Direct answer to "does DoorDash already refund fees and tax proportionally, or only item price?":
no public source states it, in either direction.** The claim that the remedy is "capped at the amount
paid for the affected item" was **refuted 0-3** — so you may not assume fees/tax/tip are excluded,
but neither may you assert they are included. `refund-policy.md` §6-Q1 is the open question.

The premise is therefore **plausible and unproven**. Two consequences:
1. Do not write claim copy that asserts DoorDash *fails* to refund fees. Assert only what is true and
   computable: here is the item, here is its proportional share of each fee line, here is the total.
   A specific number needs no accusation to be persuasive.
2. Measure it. `money-model.md` §6 gives the calibration protocol — record `owed_breakdown` vs
   `recovered_cents` per component on every real filed claim. After ~15–20 claims you will have the
   answer with a sample size, which is both the product's proof and something no competitor has.

**Tip refundability:** no verified answer, by policy or by jurisdiction. Nothing found. Keep
`tipShareCents` as a separate toggleable line per §5. On its default state — recommend **on and
clearly labeled**, because the user did pay it and the toggle exists precisely so they can decide;
defaulting it off quietly understates the loss, and §5 asks for it to be visible, not hidden either
way. If jurisdiction rules surface later, that changes the default per-market, not the architecture.

**Also encode from `refund-policy.md`:** denial is a sanctioned outcome (sole-discretion, "if we
suspect fraud or abuse"), and issued credits carry a 6-month expiry. `services/claim.ts` should not
promise an outcome, and the app should track the credit clock.

**Strongest lever for claim copy** (CONFIRMED, primary sources, in `refund-policy.md` §3): for
credit-card orders, a missing item is a Reg Z **12 CFR 1026.13(a)(3)** billing error, with "wrong
quantity" an enumerated example; the deadline is `statement_transmit_date + 60 days`, not order date;
the issuer owes acknowledgment in 30 days and resolution within 2 billing cycles / 90 days. That is
a genuine, citable, non-waivable escalation path — and it needs `funding ∈ {credit, debit, ...}`
captured at claim time, because the debit/Reg E equivalent is materially weaker and should not be
cited with the same confidence.

## R5 — per-photo attribution: split the calls
Recommend **one detection call per photo**, then a deterministic cross-photo dedupe in `core/`.
Reasoning:
- Attribution becomes real rather than a comment explaining why it isn't. The claim PDF is evidence;
  "this item was absent in these three photos" is an argument, "tagged with the first photo's path"
  is not.
- Asking the model to name a photo index adds a fabrication surface for a fact you already know
  outside the model. Never ask a model for something the caller can label deterministically.
- Dedupe moves into `core/` where it is pure and testable — same reason the diff lives there.
- Cost is more calls on smaller inputs, and per-photo calls parallelize, so latency may improve.
- Real risk to measure: an item split across two photos double-counts if dedupe is naive. Dedupe
  must be **conservative** — when uncertain, merge rather than duplicate, because a duplicate
  becomes a phantom shortage, and per `vision-and-models.md` §6 a phantom shortage is the most
  expensive error in the system (it is what gets an account flagged for suspected abuse).
Which is actually more accurate is an eval question; log `capture_quality` (laid out / bagged /
partial) so the comparison is stratified rather than confounded by how the user staged the photos.
