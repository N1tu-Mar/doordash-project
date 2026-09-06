# Refund policy + legal levers — what DoorDash actually does, and what a consumer can actually cite

## Status
READY FOR BUILD — for §3 (legal levers) and §2 (discretion/credit-expiry state model).
DRAFT for §1 (fee taxonomy) and §4 (unresolved). Do not encode DRAFT sections.

Method: deep-research harness, 6 angles, 23 sources fetched, 25 falsifiable claims put through
3-vote adversarial verification (2 refutes kills). 11 confirmed, 14 killed. All web fetches
dated **2026-09-06**. The kills are load-bearing — read §4.

---

## 1. Fee taxonomy (DRAFT — open vocabulary, not a closed schema)

**Two parallel service-fee regimes as of the 2026-07-23 rollout.** A fee model must branch on
jurisdiction; it must not hardcode a percentage.

| Regime | Where | Service fee |
|---|---|---|
| Legacy | CA, Chicago, CO, DC, MA, MN, NYC, Puerto Rico, Seattle | 15% of subtotal most orders; 5% most eligible DashPass restaurant orders |
| Rolled-out (new) | everywhere else, rolling out "over the coming months" from late July 2026 | variable, driven by distance + order size; **no published rate** |

Both carry an undisclosed floor: *"A flat, minimum service fee may apply."*
Source: help.doordash.com `what-fees-do-i-pay` (fetched 2026-09-06);
about.doordash.com `updating-our-fee-structure` (2026-07-23).

Note the carve-out list is exactly the set of fee-cap / fee-disclosure-regulated jurisdictions.
The dual regime is **jurisdiction-keyed, not transitional** — do not expect it to converge.

### Engineering rule
`service_fee = 0.15 * subtotal` is wrong in two ways: it breaks in rolled-out markets, and it
breaks whenever the undisclosed minimum binds on a small subtotal. **Read the service-fee line
off the receipt, derive the effective rate per order, and use 15% / 5% only as a validation
heuristic** that flags a suspicious parse.

### Label vocabulary is open
Two competing "canonical" enumerations were both **refuted 0-3**. Treat fee labels as an open
vocabulary with fuzzy matching plus an explicit `unknown_fee` bucket that is surfaced, never
silently dropped (PROMPT §2 failure behavior).

Labels *observed* on live help pages during verification — a starting matcher, not a schema:
`Service Fee`, `Delivery Fee`, `Long Distance Fee` (>~10 mi), `Regulatory Response Fee`,
`Small Order Fee`, `Weather Impact Fee`, `Expanded/Express Delivery Fee`, `Estimated Tax`,
`Dasher Tip`, `Bag, Bottle, and Other Mandatory Fees`. `Surge Fee` appears in some Terms
renderings and not others. The vocabulary drifts between Terms and help center and across the
rollout — version-pin by fetch date, and store `parser_version` per PROMPT §4 schema.

**No source found describes how any fee line behaves on a partial or item-level refund.** That
arithmetic is unsourced. See `money-model.md` §Calibration.

---

## 2. Refund reality: denial is a sanctioned state (CONFIRMED, high)

> DoorDash "in its sole discretion has the right to: Determine whether an item reported qualifies
> for a refund or credit... **Deny any request for a refund or credit** pursuant to the Quality
> Guarantee **if we suspect fraud or abuse**... Modify or cancel the Quality Guarantee at any time."
> — Terms of the Quality Guarantee, fetched 2026-09-06

The trigger is *suspect*, not *determine*. No appeal path, no evidentiary standard, no notice
requirement is stated.

> "Any credit issued by DoorDash under this Section 12(d) is valid for **6 months from the date of
> issue** except to the extent prohibited under applicable law and may not be redeemed for cash...
> credits may expire earlier if your account is deactivated."
> — Consumer Terms 12(d), fetched 2026-09-06 (repeated in 12(f) and promo terms)

### Encoding consequences
- Model **denial as a first-class outcome**, not an error path. `claim_status ∈ {drafted, sent,
  credited, refunded_to_card, denied, ignored, partially_credited}`.
- Model a **credit expiry clock**: `credit_expires_at = credit_issued_at + 6 months`, with a
  jurisdiction override flag — "except to the extent prohibited under applicable law" is
  load-bearing; several state gift-certificate statutes restrict expiry.
- Caveat: the 6-month clock is textually scoped to 12(d) promotional/gratuitous credits. The
  missing-item remedy lives in 12(c)(i), which carries no expiry language. Applying 6 months to a
  shortage credit is a **supported inference, not a stated rule** — label it as such in the UI.
- **Do not** pattern-match the string "your account is not eligible for refunds" as a documented
  DoorDash state. That exact UI copy could not be corroborated. Observed complaint boilerplate is
  order-scoped ("order not eligible for compensation"; agents saying they would refund "if the
  system would allow me").
- Both pages carry **no visible last-updated date**. Snapshot text with fetch date.

---

## 3. Legal levers — the encodable part (CONFIRMED, high, primary sources)

This is the strongest material in the whole research run, and it is what makes a generated claim
letter land differently from a support-chat complaint.

### 3.1 Credit card — Regulation Z is the preferred path
A missing item is a **billing error** under **12 CFR 1026.13(a)(3)**: "an extension of credit for
property or services not accepted by the consumer... or not delivered... as agreed." Official
Interpretation 13(a)(3)-1 enumerates **wrong quantity** as an example, alongside non-conforming
goods, wrong property, late delivery, wrong location.

Hard limit worth encoding: Interp 13(a)(3)-1 states §1026.13(a)(3) **does not apply to a dispute
relating to the quality of property or services the consumer accepts** (acceptance per state law).

§1026.13(f): a creditor may not deny a nondelivery assertion "unless it conducts a reasonable
investigation and determines that the property or services were actually delivered, mailed, or
sent as agreed."

This right runs from **issuer to cardholder**, independent of DoorDash's discretionary policy, and
merchant terms cannot waive it. Statutory parent: FCBA/TILA 15 U.S.C. 1666(b)(3). Stable since the
2011 CFPB recodification; Title 12 last amended 2026-08-06 with no change.

**Use §1026.13, NOT §1026.12(c) claims-and-defenses.** The 12(c) route carries $50 / same-state-or-
100-mile limits and was refuted 0-3 as framed. Track them as separate clocks; never collapse.

### 3.2 The consumer deadline — compute from the statement, never the order
```
dispute_deadline = statement_transmit_date + 60 days     # NOT order_date + 60
```
§1026.13(b): notice must be **received** by the creditor at the address disclosed under
§1026.7(a)(9)/(b)(9) no later than 60 days after the creditor **transmitted the first periodic
statement** reflecting the error, must identify name and account number, and must state the
belief, reasons, and the **type, date, and amount** of the error.

Practical spread: an order early in a cycle has ~85–90 days of runway; one placed the day before
statement close has ~60.

Five fields beyond a single deadline:
- `statement_transmit_date` ≠ closing date ≠ due date ≠ receipt date. Interp 13(b)(1): a
  held-for-pickup statement is transmitted when "first made available"; a never-sent statement
  starts the clock when it *should* have been sent, and the consumer gets a **fresh 60 days** once
  it is later provided.
- The notice must be **written**. Electronic counts only if the creditor said it accepts them and
  specified how. A phone call to general service **does not preserve the right** — this is a
  product requirement for the generated claim: produce a written artifact and name the channel.
- It must arrive at the **billing-inquiries address**. Encode `channel` and `address`, not a date.
- 60 days is the statutory floor, not the practical ceiling — Visa/Mastercard chargeback windows
  (commonly 120 days from transaction or expected delivery) run on a **separate** clock.
- No Reg Z requirement to exhaust the merchant's refund process first. That is network practice,
  not law. (Still do it first — it is faster and preserves the account relationship.)

### 3.3 Creditor SLAs — two follow-up timers
```
acknowledgment_due_by = notice_received + 30 days   UNLESS resolved_at <= notice_received + 30d
resolution_due_by     = min(2 complete billing cycles, notice_received + 90 days)
```
§1026.13(c)(1) and (c)(2), verbatim. Two corrections:
1. The 30-day acknowledgment is **conditional** — a day-30 resolution with no prior acknowledgment
   is not a violation. Trigger the nudge on **total silence at day 30**.
2. "2 complete billing cycles" is not a fixed day count and needs the account's statement dates.
   Only the **90-day outer bound is safely hardcodable**.

(Only ever modified by the CFPB's 2020-05-13 COVID supervisory-flexibility statement on these exact
timeframes, rescinded 2021-03-31.)

### 3.4 Debit — Regulation E, materially weaker. Default to the EXTENDED clocks.
12 CFR 1005.11(c)(3): **90 days replaces 45** for completing an investigation on a point-of-sale
debit transaction; **20 business days replaces 10** if the transfer occurred within 30 days of the
account's first deposit.

The contestable step — is a card-not-present delivery charge a "POS debit card transaction"? —
resolves **affirmatively** via CFPB Comment 11(c)-2: extended deadlines "apply to ALL debit card
transactions, including those for cash only, at merchants' POS terminals, and also including mail
and telephone orders." Only ATM transactions are carved out. A secondary compliance blog claiming
online CNP purchases stay on the 45-day track is contradicted by this primary commentary.

Four caveats:
- 90 days extends the (c)(2) track, available only if the institution **provisionally credits**
  within 10 business days (20 for new accounts) or qualifies for a (c)(2)(i) exemption. "90 days to
  investigate" ≠ "90 days without money." Default expectation: provisional credit at business-day 10.
- Clock runs from **receipt of notice**; results reported within 3 business days of completing.
- **Biggest limit:** a shortage where the consumer authorized the charge *in the correct amount* may
  not be a §1005.11(a)(1) "error" at all — Reg E errors are unauthorized transfers, wrong amount,
  omission, computational error. (See Fed, *Consumer Compliance Outlook* 2016 Q1, on merchant-quality
  disputes.) A companion claim asserting Reg E covers "incorrect EFT" for this case was **refuted 0-3**.
- The parallel Reg E 60-day-from-statement notice deadline scored only **1-2**. Confirm independently
  before encoding.

**Product consequence:** ask for funding instrument at claim time. `funding ∈ {credit, debit,
prepaid, other}`. Credit → strong Reg Z path with a named citation. Debit → route to DoorDash goodwill
first and set expectations honestly; do not print a confident Reg E citation the user can't stand on.

---

## 4. What was killed, and why it matters as much as what survived

| Claim | Vote | Consequence |
|---|---|---|
| Closed fee taxonomy (either of two versions) | 0-3 | Open-vocabulary parser + `unknown_fee` bucket |
| "Report within 24 hours via self-help tool" | 0-3 | **Do NOT encode a 24h deadline.** No alternative window confirmed |
| "Remedy capped at the amount paid for the affected item" | 0-3 | **Do NOT** assume fees/tax/tip are excluded from what's owed — the app's whole pitch survives |
| "Charges are final and non-refundable" (Terms 12(c)(i)) | 0-3 | Refusal is not established as the legal baseline |
| "Merchants cannot issue refunds on Marketplace orders" | 1-2 | Do not assert DoorDash is sole decision-maker |
| Reg E "incorrect EFT" covers a shortage | 0-3 | Debit path is weak; see §3.4 |
| Reg E base 10bd/3bd/1bd timers; 45-day + provisional credit mechanics; Reg E 60-day notice | 1-2 each | Unresolved — verify before encoding |

Several kills were **verbatim quotes from live pages that still failed 0-3**, which suggests the
refutations turned on scope or currency rather than nonexistence. Treat them as **unresolved, not
disproven**, and re-run against dated snapshots.

### Produced nothing at all
- **Gmail ingestion** (part 4): no verified sender addresses, subject patterns, DoubleDash
  structure, grocery substitution / weight-adjust representation, or "order adjusted" email format.
  Build from a real corpus. See `receipt-formats.md`. **Encode nothing from this report.**
- **Base rates** (part 5): no missing-item incidence, order-accuracy stats, refund approval rates,
  or average refund amounts. Any dashboard number of this kind would be fabricated — PROMPT §2
  forbids it, and §3.5's n≥20 rule is the correct substitute.
- **FTC junk-fee rule status/effective date, CA SB 478, SB 1524 restaurant carve-out, NYC/Seattle/
  Chicago fee caps**: zero verified evidence. Only indirect trace is that those jurisdictions are
  exactly DoorDash's carve-out list — corroborating, not citable. **Do not cite these in generated
  claim text until researched properly.**
- **No Reddit / CFPB complaint-database / litigation evidence** was verified for caps or denial
  patterns. The account-flagging behavior in §2 rests on complaint-volume reporting and forum
  threads — weakest material here.

## 5. Time sensitivity
DoorDash side is **mid-flight**: rollout began 2026-07-23, explicitly continuing "over the coming
months." The 15%/5% rates and the nine-jurisdiction list **will drift**, and DoorDash help/Terms
pages carry no last-updated date. Re-fetch quarterly and diff.
Regulatory side is the opposite: Reg Z §1026.13 and Reg E §1005.11 are stable primary law, current
as of Title 12's 2026-08-06 amendment.

## 6. Open questions (ranked by product impact)
1. **When DoorDash refunds one item, which fee lines are pro-rated?** Is tax recomputed on the
   reduced subtotal? Is the service fee reduced proportionally? Do delivery / small-order /
   regulatory-response fees and tip stay whole? Does the adjustment surface as a new receipt email
   or only in-app? *No source addressed this, and it is the core arithmetic of the app.* Answerable
   only empirically — see `money-model.md` §Calibration.
2. **Is there any published reporting deadline?** 24h failed 0-3; nothing replaced it. Published at
   all, or purely discretionary behind an undisclosed internal rule?
3. **What is the flat minimum service fee, and the distance/order-size coefficients post-July-2026?**
   Unpublished; secondary $3–$4 estimates are blog-quality. Is the effective rate derivable from
   receipt lines alone, or does the app need per-market observed-fee calibration?
4. **Do the refuted policy claims fail on scope/currency or substance?** Resolving this changes how
   the app frames escalation from goodwill credit to card dispute.
