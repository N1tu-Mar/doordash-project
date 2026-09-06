# PROMPT.md — Shorted

Working name: **Shorted**. Rename freely; keep the package name `shorted` until you do.

Read this file in full before writing any code. It is the contract. If something here
conflicts with what you think is a better idea, say so in your response — do not silently
deviate.

---

## 1. What we are building

A mobile app that turns "half my DoorDash order is missing" into a specific, evidenced,
correctly-priced refund claim.

Three steps, from the user's side:

1. Photograph (or import) the DoorDash receipt → we extract the itemized order.
2. Photograph what actually arrived → we detect what is present.
3. We diff the two, the user confirms/corrects, and we generate a paste-ready dispute
   message plus a downloadable evidence PDF.

The thing that makes it more than a photo diff is the **money math**. If a $12 item never
arrived, DoorDash typically refunds $12. But the user also paid service fee, delivery fee,
tax, and tip on that item — the real loss is closer to $18. We compute the proportional
share of every fee line and put a specific dollar figure in the claim. Specific numbers
get paid. Vague complaints get a $3 credit.

Second-order product (do not build yet, but every schema decision should keep it possible):
a per-merchant **shortage index** built from real confirmed diffs — which specific
restaurant locations short which items, how often.

### Explicit non-goals for v1
- No DoorDash API, scraping, or automation of their support flow. We generate text the
  user sends themselves. Do not build anything that logs into DoorDash on the user's behalf.
- No dasher-side features. No merchant-side features.
- No public shortage index until we have real volume (see §3.5).

---

## 2. THE DATA RULE — read this twice

**Every piece of data in this system must originate from a real DoorDash order that a real
person actually placed.** No exceptions, no shortcuts, at any stage — development, testing,
demos, evals, or screenshots.

### Banned outright

- Hardcoded receipts, orders, items, prices, or users anywhere in the codebase.
- Seed scripts / fixtures that insert invented rows into the database.
- LLM-generated receipts, LLM-generated food photos, LLM-generated "example" orders.
- Faker/Chance/`@faker-js` or any equivalent library. Do not add it to package.json.
- Placeholder rows like `{ name: "Cheeseburger", price: 8.99 }` used to make a screen render.
- "Demo mode" that fabricates a flow when no real data exists.
- Copy-pasted receipt text from a blog post, Reddit screenshot, or stock photo site.

If you are about to write a literal food item name into a source file, stop. That is the
smell. The only string literals about food that belong in this codebase are UI labels
("Add a photo of what arrived"), never data.

### What to do instead when there is no data yet

Build the empty state. Every screen must render correctly and honestly with zero rows:
"No orders yet — add your first receipt." A screen that cannot be developed without fake
data is a screen whose empty state you haven't designed yet. Design it.

For UI work that needs *something* on screen: import one real receipt through the real
pipeline and use that. It takes four minutes and it is the correct four minutes.

### Failure behavior

When real data is missing or a parse fails, **fail loudly and visibly**. Never fall back to
a default, never substitute a guess, never render a plausible-looking placeholder. A blank
field with an error state is correct. A field silently filled with `$0.00` or `"Unknown
item"` is a bug that will survive to production and corrupt the shortage index.

Every record in `orders` and `order_items` carries a `source` column that must be one of
the real ingestion paths in §3. There is no `source = 'seed'`. Enforce it as a DB check
constraint so it cannot be violated even by accident.

---

## 3. Where the real data actually comes from

This is the part that makes the rule practical rather than aspirational. There are four
real sources and they are enough.

### 3.1 The operator's own orders (primary, day one)

Nitu orders DoorDash. So do his roommates, teammates, and roughly everyone at Rutgers.
Every one of those is a real receipt and a real bag of food. The bootstrap corpus is:
order, photograph the receipt, photograph the unpacked food, log what was actually wrong.
Target 30–50 real orders before trusting any accuracy number.

This is not a workaround. It is the correct way to build a vision pipeline — you cannot
know your OCR is good until you have watched it fail on a crumpled real receipt in bad
kitchen lighting.

### 3.2 Gmail receipt ingestion (primary, scaled)

DoorDash emails an itemized receipt for every order. That inbox is a real, dated,
structurally-consistent corpus, and Nitu's Gmail is already connected.

Build `ingest/gmail.ts`:
- OAuth read-only scope, search `from:doordash.com` with a receipt subject filter.
- Pull the HTML body, store the **raw HTML verbatim** in object storage before parsing.
- Parse into structured items. Store parser version alongside the result.

Storing raw-before-parsed is non-negotiable. When the parser improves, we re-run it over
real historical HTML instead of losing the corpus. It also means a parse bug never
destroys the underlying truth.

**Consent gate:** for anyone other than the operator, ingestion requires explicit in-app
consent naming what is read and stored. No silent inbox access. Never store the email body
of anything that is not a DoorDash receipt — filter before persisting, not after.

### 3.3 In-app capture (the actual product path)

Receipt photo + delivered-food photos, taken by the user at the door. This is what ships.
Store originals in object storage; never overwrite them with processed versions.

### 3.4 Human confirmation as ground truth

The user's correction step is not a UX nicety — it is the labeling pipeline. When a user
fixes "you missed the second drink," that correction is ground truth, produced by a human
who was physically holding the food. Persist it:

```
detected_items    -- what the model said
confirmed_items   -- what the human said after looking
```

Both, always, separately. The delta between them is your accuracy metric and your eval set
and, eventually, your prompt-improvement signal. Do not collapse them into one column.

### 3.5 The shortage index (real or absent)

Accumulates only from confirmed diffs on real orders. Hard rules:

- A merchant location shows a shortage rate only at **n ≥ 20 confirmed orders**. Below
  that, the UI says "not enough data," which is true and is fine to say.
- Never extrapolate, smooth, or model a rate from fewer real observations.
- Never display a national or chain-level number synthesized from location-level data.

An empty index that says so is a working product. A populated index full of estimates is a
broken one that also happens to be a lie.

---

## 4. Architecture

Follow this. Do not restructure it without flagging first.

```
shorted/
├─ app/                    # Expo Router (React Native) — the product
│  ├─ (tabs)/
│  │  ├─ index.tsx         # order list; empty state is the default state
│  │  └─ history.tsx
│  ├─ capture/
│  │  ├─ receipt.tsx       # step 1
│  │  ├─ delivered.tsx     # step 2 — includes the "unpack and lay it out" coaching
│  │  └─ confirm.tsx       # step 3 — the correction UI, most important screen in the app
│  └─ claim/[orderId].tsx  # generated dispute + PDF export
├─ core/                   # pure TS, no React, no I/O — fully unit testable
│  ├─ diff.ts              # receipt items × detected items → discrepancy list
│  ├─ money.ts             # proportional fee/tax/tip allocation. See §5.
│  └─ types.ts
├─ services/
│  ├─ vision.ts            # Claude API: receipt OCR + delivered-food detection
│  ├─ claim.ts             # Claude API: dispute text generation
│  ├─ storage.ts           # Supabase Storage — raw artifacts, never mutated
│  └─ db.ts                # Supabase Postgres client
├─ ingest/
│  └─ gmail.ts             # §3.2
├─ research/               # OWNED BY AGENT B — see §7. Builder does not write here.
│  ├─ findings/
│  ├─ corpus/              # real receipt HTML/images, gitignored, never committed
│  └─ evals/
└─ supabase/
   └─ migrations/
```

**Stack, fixed:**
- Expo (React Native) + Expo Router. Mobile-first is load-bearing — this happens standing
  at a doorstep.
- Supabase: Postgres, Storage, Auth. RLS on from the first migration, not bolted on later.
- Anthropic API for vision and text generation. Model IDs live in one config file.
- TypeScript strict. No `any` in `core/`.

**Layering rule:** `core/` is pure and deterministic — no network, no Supabase, no Claude.
All model calls live in `services/`. This exists so the money math and the diff logic can
be tested against real captured payloads with zero mocking.

### Schema sketch

```sql
create table orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users,
  source        text not null check (source in ('gmail','photo','manual_entry')),
  ordered_at    timestamptz not null,
  merchant_name text not null,
  merchant_addr text,
  subtotal_cents     int not null,
  fees_cents         int not null,
  tax_cents          int not null,
  tip_cents          int not null,
  total_cents        int not null,
  raw_artifact_path  text not null,   -- raw email HTML / receipt image. Always present.
  parser_version     text not null,
  created_at    timestamptz default now()
);

create table order_items (
  id, order_id, name, quantity, unit_price_cents, modifiers jsonb
);

create table discrepancies (
  id, order_id,
  kind text check (kind in ('missing','wrong_item','modifier_ignored','damaged')),
  detected_items  jsonb not null,   -- model output, immutable
  confirmed_items jsonb not null,   -- human correction, ground truth
  owed_cents      int not null,     -- from core/money.ts
  photo_paths     text[] not null,
  created_at timestamptz default now()
);
```

Money is integer cents everywhere. No floats, ever, anywhere near a dollar amount.

---

## 5. `core/money.ts` — the differentiating logic

Given a receipt and a set of missing items, compute what the user is actually owed.

```
item_share      = missing_items_subtotal / order_subtotal
owed_cents      = missing_items_subtotal
                + round(fees_cents * item_share)
                + round(tax_cents  * item_share)
                + round(tip_cents  * item_share)
```

Notes that matter:
- Tip proportion is arguable and jurisdiction/policy dependent. Compute it, show it as a
  **separate line** the user can toggle off before sending. Do not bury it in one total.
- Rounding: round each component independently, then sum. Never let the total exceed the
  order total — assert it.
- This function must be unit tested against **real receipts** from the corpus with
  hand-verified expected values. Not generated cases. Real ones, checked by hand.

---

## 6. Vision pipeline notes

- Receipt OCR and food detection are **separate calls with separate prompts**. Do not
  combine them.
- Detection output must be structured JSON, validated with zod before it touches the DB.
  Reject and surface an error on malformed output; never coerce.
- Opaque bags and stacked containers will wreck accuracy. The mitigation is product, not
  model: `capture/delivered.tsx` explicitly coaches "unpack and lay everything out." Ship
  that coaching in v1.
- The confirmation screen assumes the model is wrong. It should be fast to correct, not
  fast to accept. Do not pre-check every detected item as accepted.
- Log every model call's input hash, output, latency, and model ID to a `model_calls`
  table. This is how Agent B measures accuracy without re-running anything.

---

## 7. Two-agent split

Two Claude Code sessions run in parallel. They must not touch the same files.

### Agent A — Builder
**Owns:** `app/`, `core/`, `services/`, `ingest/`, `supabase/`
**Never touches:** `research/`

Job: ship the three-screen flow end to end against real data. Order of work in §8.
Reads Agent B's findings as input; does not produce research artifacts.

### Agent B — Researcher
**Owns:** `research/` only. Write access nowhere else.
**Never touches:** app code. If B wants a code change, it writes a findings file
recommending it; A implements it.

Job:
1. **Receipt corpus + parser validation.** Collect real DoorDash receipt HTML/images
   (operator's own + consented). Characterize format variance: chain vs local, grocery vs
   restaurant, promo lines, multi-merchant DoubleDash orders. Output: `research/findings/receipt-formats.md`
   with the concrete cases the parser must survive.
2. **Vision accuracy eval.** Build a held-out set of real captured orders with
   hand-labeled ground truth. Report per-item precision/recall for detection and field
   accuracy for OCR. Output: `research/evals/` + a findings file. Re-run when prompts change.
3. **Refund policy reality.** What DoorDash actually reimburses, what the shifting-ETA
   mechanic does to "late" claims, what chargeback thresholds look like, relevant state
   fee-transparency law. Output: `research/findings/refund-policy.md`. Cite sources.
4. **Prompt iteration proposals.** Based on eval failures. Proposals only — A applies them.

### Handoff contract

- Communication is **files in `research/findings/`**, not shared conversation state.
- Every findings file starts with a `## Status` block: `DRAFT` or `READY FOR BUILD`. A only
  acts on `READY FOR BUILD`.
- `research/corpus/` is gitignored. Real receipts contain names, addresses, and partial
  payment info. They never enter version control. Ever.
- If A needs something from B, A writes `research/findings/REQUESTS.md`. That is the only
  file A may write inside `research/`.

---

## 8. Build order (Agent A)

Ship each step working against real data before starting the next. Do not scaffold all
three screens with placeholders and fill them in — that path leads directly to fake data.

1. Supabase project, migrations, RLS, auth. Verify a real row can be written and read.
2. `ingest/gmail.ts` — get 20+ real receipts in, raw HTML stored. This is the data unblock;
   do it before UI.
3. `core/` — types, diff, money. Unit tested against the real receipts from step 2.
4. `capture/receipt.tsx` + `services/vision.ts` receipt path.
5. `capture/delivered.tsx` + detection path.
6. `capture/confirm.tsx` — the correction UI. Spend real time here.
7. `claim/[orderId].tsx` — generated text + PDF export.
8. Only then: history, polish, empty-state review.

---

## 9. Standing rules for both agents

- **No fake data.** §2 is the rule you break least. If you're stuck because there's no data,
  the answer is "go get real data," not "make some up for now."
- Do not add a dependency without saying why. Never add a data-faking library.
- Integer cents. Strict TS. Zod at every model and network boundary.
- Raw artifacts are immutable. Processed output goes in new columns/files.
- When uncertain about DoorDash's actual behavior, that's a §7 research task — write the
  request, don't guess in a comment.
- Do not commit anything from `research/corpus/`.
- **Commit frequently.** One commit per coherent unit of work — a schema, a module, a
  passing test — not one commit per session. Real messages describing what changed and
  why, not "wip". Small commits are how the other agent sees what landed, and how a bad
  change gets reverted without taking the good ones with it.