/**
 * Shorted — fee-line classification. PURE.
 *
 * research/findings/money-model.md Correction B (READY FOR BUILD) gives the
 * taxonomy and names the labels for each kind. This file encodes THAT TABLE AND
 * NOTHING ELSE. It does not extrapolate to labels the finding does not list.
 *
 * Anything unmatched classifies as `unknown`, and `unknown` is never pro-rated
 * into a number the user sends (core/money.ts FEE_POLICY). A fee we cannot name
 * is a fee we show the user and ask about — PROMPT.md §2's failure behavior
 * applied to money: a wrong classification is a wrong dollar figure, and a
 * plausible guess here survives to production.
 *
 * The real DoorDash fee vocabulary is DRAFT in refund-policy.md §1 and is a
 * corpus question. See research/findings/REQUESTS.md R6.
 */
import type { FeeKind } from "./money.js";

/**
 * Labels from money-model.md Correction B, verbatim, lowercased for comparison.
 * Order matters only in that the first match wins; the sets are disjoint.
 */
const CLASSIFIED_LABELS: ReadonlyArray<{ kind: FeeKind; labels: readonly string[] }> = [
  { kind: "proportional", labels: ["service fee"] },
  {
    kind: "per_delivery",
    labels: ["delivery fee", "long distance fee", "expanded range fee", "weather impact fee"],
  },
  { kind: "threshold", labels: ["small order fee"] },
  { kind: "passthrough", labels: ["regulatory response fee", "bag fee", "bottle fee"] },
];

/** Compare-time normalization only — case and whitespace, nothing semantic. */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classify a printed fee label.
 *
 * Exact normalized match against the documented vocabulary, or `unknown`.
 * Deliberately not fuzzy: "Expanded Range Fee" and "Extended Warranty Fee" are
 * two edits apart and land in different halves of a refund claim.
 */
export function classifyFeeLabel(label: string): FeeKind {
  const normalized = normalizeLabel(label);
  for (const group of CLASSIFIED_LABELS) {
    if (group.labels.includes(normalized)) return group.kind;
  }
  return "unknown";
}

/** Every label this classifier recognises. Used by the corpus coverage report. */
export function knownFeeLabels(): string[] {
  return CLASSIFIED_LABELS.flatMap((g) => g.labels);
}
