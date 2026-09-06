# Evals — structure and rules

## Status
DRAFT — harness structure is buildable now; **no eval set exists until the corpus does.**

## The one rule
Every eval case originates from a real order (PROMPT §2). There is no synthetic eval set, no
LLM-generated receipt, no invented ground truth. An eval with zero cases that says so is a working
eval. An eval populated with fabricated cases is a broken one that also reports a fake number.

## Layout
```
research/evals/
├─ README.md              # this file
├─ ocr/                   # receipt field extraction cases -> corpus refs + hand-verified fields
├─ detection/             # delivered-photo cases -> corpus refs + confirmed item sets
└─ money/                 # end-to-end owed_cents cases, hand-computed
```
Cases reference corpus artifacts **by hash/path**; they never inline receipt content, because
`research/corpus/` is gitignored and evals are not. A case file that contains a real item name or
address is a leak — check for that before committing anything here.

## Held-out discipline
The confirmation screen produces labels continuously (PROMPT §3.4), which makes it tempting to
evaluate on everything. Split by **order**, not by item, and freeze a held-out set before any prompt
iteration. Prompt changes are tuned on the dev split; the held-out split is scored only on
re-runs, and its scores are the only ones quoted.

## Metrics
Defined in `../findings/vision-and-models.md` §6. Two are available before any hand-labeling:
- `total_reconciliation_rate` (OCR self-consistency) — available from receipt #1
- money-math invariant INV-5 (`all items missing == order total`) — from `../findings/money-model.md` §3

Start with those two. They are real numbers on real data on day one, which is worth more than a
complete eval suite that arrives after the deadline.

## Re-run trigger
Re-run and record on every prompt change and every model-ID change (PROMPT §7 job 2). Because
`model_calls` stores `input_hash`, `prompt_version`, and raw output, historical scoring needs no
re-inference — score from the table, re-infer only for the changed configuration.
