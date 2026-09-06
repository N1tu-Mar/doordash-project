# Model selection, prompting structure, and the eval that keeps them honest

## Status
READY FOR BUILD — model routing and call structure.
DRAFT — accuracy targets (no baseline exists until the corpus does). Verify current model pricing
and IDs against Anthropic docs before committing to a cost model; this file does not quote prices.

## 1. Two calls, never one (PROMPT §6, restated with reasons)
Receipt OCR and delivered-food detection are separate calls with separate prompts. Reasons worth
holding onto when someone proposes merging them to save a round-trip:
- **Different failure modes.** OCR fails on glare, crumple, and low contrast. Detection fails on
  occlusion, stacking, and opaque containers. A merged call lets one failure contaminate the other's
  output, and the confidence signal becomes uninterpretable.
- **Different eval sets and different ground truth.** OCR ground truth is field-level and exact.
  Detection ground truth is set-level with precision/recall. They cannot share a metric.
- **Different cache behavior.** The receipt prompt is stable and long (fee vocabulary, format
  hints); the detection prompt is short and image-dominated. Prompt caching only helps the former.
- **The diff is `core/`, not a model.** Merging the calls would move the diff into the model, which
  breaks the layering rule in PROMPT §4 and makes the money math untestable without mocking.

## 2. Model routing
Latest family: Claude 5 (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`) plus
`claude-haiku-4-5-20251001`. Model IDs live in **one config file** (PROMPT §4) — never inline.

| Job | Start with | Why |
|---|---|---|
| Receipt OCR → structured items | `claude-sonnet-5` | Dense small text, tabular structure, exact numerals. Accuracy dominates; a wrong cent poisons the claim |
| Delivered-food detection | `claude-sonnet-5` | Open-set recognition of arbitrary prepared food in a cluttered frame is the hardest task here |
| Dispute text generation | `claude-sonnet-5` | Short, structured, must not embellish. Consider `claude-haiku-4-5-20251001` once the eval shows it holds |
| Retry / escalation on low confidence | `claude-opus-5` | Reserve for the second pass on a flagged parse, not the default |

Route by measurement, not by intuition: ship one model, log everything (§4), then A/B the cheaper
model against the same eval set. The `model_calls` table exists precisely so a downgrade is a data
question.

## 3. Structured output discipline
- Every model call returns a **zod-validated** object. Malformed output is **rejected and surfaced**,
  never coerced (PROMPT §6). A coerced parse is indistinguishable from a correct one downstream.
- Prefer **tool-use / structured-output** enforcement over "respond in JSON" instructions — schema
  enforcement at the API level removes an entire class of parse failures.
- Emit **per-field confidence**, not one score for the whole document. The money math depends on
  `unit_price_cents` far more than on `merchant_addr`; one aggregate score hides exactly the field
  you care about.
- Emit `null` + a reason, never a plausible default. `"$0.00"` and `"Unknown item"` are the two
  worst possible outputs in this system (PROMPT §2).
- **Never let the model do arithmetic.** It extracts line items and reads totals; `core/money.ts`
  computes. If the model's read of `total` disagrees with the computed sum, that is a **signal to
  surface**, not a number to pick between.

## 4. Logging — the eval substrate (PROMPT §6)
`model_calls`: `input_hash`, `output` (raw, verbatim), `latency_ms`, `model_id`, `prompt_version`,
`token_usage`, `error`. Two additions worth making now:
- `prompt_version` alongside `model_id` — otherwise a prompt change and a model change are
  indistinguishable in a regression, and you cannot answer "did my change help."
- Store the raw output **before** zod validation. A rejected malformed output is the single most
  valuable training signal in the system and the default path throws it away.

`input_hash` over the image bytes lets an eval re-score historical calls with no re-inference —
that's the whole point, and it is why the hash must be of the **exact** bytes sent, not the file.

## 5. The confirmation screen is the labeling pipeline (PROMPT §3.4)
`detected_items` and `confirmed_items` stay separate columns, always. Design consequences the eval
depends on:
- **Do not pre-check detected items as accepted.** A pre-checked list makes "accept" the cheap
  action, and the labels collapse toward the model's own output — the dataset silently becomes
  self-confirming and the measured accuracy becomes meaningless. This is a data-integrity
  requirement, not a UX preference.
- Log **corrections at the item level with an edit kind**: `added_missed_item`, `removed_false_positive`,
  `fixed_quantity`, `fixed_name`. Aggregate deltas tell you *that* the model is wrong; typed edits
  tell you *how*, which is what a prompt fix needs.
- Record **time-to-confirm**. A screen users rush is a screen producing bad labels; that's
  measurable, and it moderates how much you trust the label set.

## 6. Metrics (targets are DRAFT until a baseline exists)
**Detection** — per-item precision/recall against human-confirmed truth. The costs are asymmetric:
- A **false negative** (model misses a present item → app claims a delivered item is missing) sends
  the user to file a false claim. This is the one that gets an account flagged for "suspected fraud
  or abuse" (`refund-policy.md` §2) and is the most expensive error in the system.
- A false positive (model sees an absent item) merely means the user corrects it.
Therefore **optimize recall of *present* items** — i.e. minimize claiming something is missing when
it isn't — and let the human add missed shortages. Report both, and report the confusion at the
item level, not the order level.

**OCR** — exact-match rate per field, weighted by money impact: `unit_price_cents`, `quantity`,
`subtotal_cents`, each fee line, `total_cents` are load-bearing; `merchant_addr` is not.
Report separately: **`total_reconciliation_rate`** = fraction of receipts where
`Σ(line items) + fees + tax + tip == printed total`. This needs **zero hand-labeling** and is
available from receipt #1 — it is the fastest real accuracy signal in the project.

**End-to-end** — `owed_cents` computed from model output vs `owed_cents` from human-confirmed
items. Money error in cents is the metric that actually matters, and it is the only one that
composes OCR error and detection error the way the product does.

## 7. Known accuracy ceiling — product mitigation, not model mitigation
Opaque bags and stacked containers cap detection accuracy regardless of model (PROMPT §6). The
mitigation ships in `capture/delivered.tsx` as explicit "unpack and lay everything out" coaching.
Worth measuring as a first-class variable: log a `capture_quality` flag (laid out / in bags /
partial) at confirm time, and report detection accuracy **stratified by it**. If accuracy is 90% on
laid-out and 45% on bagged, that is a coaching-UI investment, not a prompt investment — and you
cannot know which without the stratification.
