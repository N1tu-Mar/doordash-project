# Receipt formats + Gmail ingestion — BLOCKED on corpus

## Status
DRAFT — **BLOCKED**. Contains zero receipt facts by design. Agent A: do not build a parser against
this file; build it against the corpus this file tells you how to collect.

## Why this file is empty of facts
The deep-research run (2026-09-06) produced **nothing verifiable** on: DoorDash sender addresses,
subject-line patterns, receipt HTML structure, DoubleDash multi-merchant layout, grocery
substitution / weight-adjust representation, or "your order was adjusted" follow-up emails. Every
candidate claim either failed verification or had no primary source.

This is the correct outcome, not a research failure. Receipt HTML is not documented anywhere
public, changes without notice, and varies by market, vertical, and A/B bucket. **The only valid
source is the operator's own inbox.** Encoding a guessed `from:` filter or subject regex would be
exactly the PROMPT §2 violation the rules exist to prevent — a plausible-looking placeholder that
survives to production and silently drops half the corpus.

## Current blocker
Attempted `from:doordash.com` Gmail search on 2026-09-06 was denied by the local permission
classifier. Unblock by either:
- granting the Gmail MCP search/read permission for this session, or
- operator exports 20–30 receipt emails (**Show original** → `.eml`) into `research/corpus/raw/`.

`research/corpus/` is gitignored (verified: `.gitignore` line "REAL RECEIPTS... research/corpus/").
Real receipts carry names, addresses, and partial payment info. They never enter version control.

## Collection protocol (do this before any parser work — PROMPT §8 step 2)

### Store raw before parsed, always
Per PROMPT §3.2 this is non-negotiable. Persist the **verbatim HTML body** (and the full MIME
source, which carries the `Date`, `Message-ID`, and sender headers a parser may later need) to
object storage *before* parsing, with `parser_version` recorded alongside every parse result. When
the parser improves, re-run it over history instead of losing the corpus.

Do **not** filter to "DoorDash receipts" *after* persisting. PROMPT §3.2: filter before persisting,
never after. Non-receipt email bodies must never be written.

### Target corpus composition (n = 30–50, PROMPT §3.1)
Collect deliberately across axes, not just chronologically. Each axis is a parser failure mode:

| Axis | Cases to get |
|---|---|
| Vertical | restaurant · grocery · convenience · retail · alcohol |
| Merchant type | national chain (templated menu) · local independent (freeform item names) |
| Order shape | single merchant · **DoubleDash multi-merchant** · group order · scheduled |
| Item shape | plain item · item with modifiers/options · quantity > 1 · **weight-adjusted (sold by lb)** · substituted item |
| Money shape | promo/discount applied · DashPass order · $0 delivery fee · small-order fee present · tip $0 · tip adjusted after delivery |
| Lifecycle | original receipt · **adjusted/updated receipt** · refund confirmation · cancellation |
| Format | HTML email · in-app receipt screenshot · photographed paper/kitchen receipt |
| Market | at least two states, ideally one legacy-fee jurisdiction (CA/NYC/Chicago/Seattle/CO/DC/MA/MN/PR) and one rolled-out — see `refund-policy.md` §1 |

The legacy vs rolled-out split is the highest-value axis. Fee regimes differ structurally
(15%/5% vs unpublished variable), so a parser validated on one market can be wrong in the other in
a way that produces confidently incorrect dollar figures.

### What to characterize per format class (the actual deliverable)
For each class, record and commit **to this file** (not the corpus):
1. Stable structural anchors — table/row semantics, class names, whether items are `<table>` rows or
   `<div>`s, whether prices share a cell with the name.
2. Which fee labels appear, verbatim, and whether the set is stable within a class
   (`refund-policy.md` §1: open vocabulary — this is where it gets closed *empirically, per class*).
3. Whether `Σ(line totals) == printed subtotal`, and if not, what sits in between
   (`money-model.md` Correction A).
4. Whether tax appears as one line or several; whether any non-taxable items are present.
5. How modifiers/options render, and whether they carry their own price.
6. For DoubleDash: whether fee lines are attributable to a merchant at all
   (`money-model.md` §4 — this decides the schema).
7. Whether an adjusted order produces a **new email** or only an in-app change
   (`refund-policy.md` §6-Q1 depends on this).
8. Sender addresses and subject strings actually observed, with dates and counts. Never a guess.

### Parser-hardening cases to extract
Once the corpus exists, the parser must survive at minimum: item names containing currency symbols
or digits; emoji in merchant names; multi-line item names; right-to-left or accented text; a $0.00
line vs an absent line; a negative line (discount/refund); an item quantity encoded as "2x" vs "2"
vs a separate column; totals that disagree with the sum by 1 cent (real rounding, not a bug).

Every one of those must **fail loudly**, per PROMPT §2, when it cannot be resolved. A field silently
filled with `$0.00` or `"Unknown item"` corrupts the shortage index permanently.

## Handoff
When the corpus exists and the classes are characterized, this file flips to READY FOR BUILD with
concrete anchors per class. Until then Agent A should treat `ingest/gmail.ts` as
**fetch + store raw + record parser_version**, with parsing behind a flag that fails loudly. That
part is buildable today and is the PROMPT §8 step-2 unblock.
