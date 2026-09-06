/**
 * Shorted — receipt items × detected items → proposed discrepancies. PROMPT.md §4.
 *
 * PURE and deterministic. No model calls here: the model already ran, in
 * services/vision.ts, and its output is an input to this file.
 *
 * Everything this module returns is a PROPOSAL. It is never a verdict. The
 * human confirmation step (capture/confirm.tsx) is what produces ground truth,
 * and it is what feeds core/money.ts. PROMPT.md §3.4, §6.
 */
import type { DetectedItem, OrderItem } from "./types.js";
import type { MissingQuantity } from "./money.js";

export type MatchQuality = "exact" | "fuzzy" | "none";

export interface DiffLine {
  receiptItem: OrderItem;
  orderedQuantity: number;
  /** Total quantity the model believes arrived for this line. */
  detectedQuantity: number;
  /** orderedQuantity - detectedQuantity, floored at 0. Zero means "nothing to claim". */
  proposedMissingQuantity: number;
  matchedDetections: DetectedItem[];
  matchQuality: MatchQuality;
  /**
   * Lowest confidence among the detections backing this line, or null when
   * nothing matched. The UI sorts the confirmation screen by this ascending:
   * make the human look at the shakiest rows first.
   */
  lowestConfidence: number | null;
}

export interface DiffResult {
  /**
   * Always "proposed". A diff is model output; only a human confirmation turns
   * it into a discrepancy row. Encoded in the type so no caller can forget.
   */
  status: "proposed";
  lines: DiffLine[];
  /**
   * Detections that matched no receipt line. Candidate 'wrong_item' — something
   * arrived that was not ordered. Requires a human to say which.
   */
  unmatchedDetections: DetectedItem[];
  /**
   * True when any line is fuzzy-matched or unmatched detections exist, i.e. the
   * confirmation screen has real work to do beyond a rubber stamp.
   */
  hasAmbiguity: boolean;
}

/**
 * Compare-time normalization only. Receipt text is stored verbatim (core/types.ts);
 * this collapses the noise DoorDash receipts and vision output disagree about —
 * case, punctuation, whitespace — and nothing else. No synonym table, no stemming,
 * no size-word stripping: those are guesses dressed up as logic, and a wrong guess
 * here becomes a wrong dollar amount.
 */
export function normalizeItemName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(name: string): Set<string> {
  return new Set(normalizeItemName(name).split(" ").filter(Boolean));
}

/** Jaccard overlap of token sets. 1 = identical token bags, 0 = disjoint. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  return intersection / (ta.size + tb.size - intersection);
}

/**
 * Above this, two names are treated as the same item and the pairing is marked
 * "fuzzy" for the human to check. Below it, no match is proposed at all.
 *
 * This threshold is a guess until it is measured against the real corpus.
 * Tuning it is a research task — see research/findings/REQUESTS.md.
 */
export const FUZZY_MATCH_THRESHOLD = 0.6;

export function diffOrder(
  receiptItems: readonly OrderItem[],
  detections: readonly DetectedItem[],
): DiffResult {
  const claimed = new Set<number>();
  const matches: DetectedItem[][] = receiptItems.map(() => []);
  const qualities: MatchQuality[] = receiptItems.map(() => "none");

  // Pass 1: exact normalized matches across ALL lines. This runs to completion
  // before any fuzzy matching, so a near-miss on one line can never consume a
  // detection that another line matches exactly.
  receiptItems.forEach((receiptItem, lineIndex) => {
    detections.forEach((d, i) => {
      if (claimed.has(i)) return;
      if (normalizeItemName(d.name) === normalizeItemName(receiptItem.name)) {
        claimed.add(i);
        matches[lineIndex]?.push(d);
        qualities[lineIndex] = "exact";
      }
    });
  });

  // Pass 2: best fuzzy candidate for lines still unmatched.
  receiptItems.forEach((receiptItem, lineIndex) => {
    if (qualities[lineIndex] !== "none") return;
    let bestIndex = -1;
    let bestScore = 0;
    detections.forEach((d, i) => {
      if (claimed.has(i)) return;
      const score = nameSimilarity(d.name, receiptItem.name);
      if (score >= FUZZY_MATCH_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    const best = bestIndex >= 0 ? detections[bestIndex] : undefined;
    if (best) {
      claimed.add(bestIndex);
      matches[lineIndex]?.push(best);
      qualities[lineIndex] = "fuzzy";
    }
  });

  const lines: DiffLine[] = receiptItems.map((receiptItem, lineIndex) => {
    const matched = matches[lineIndex] ?? [];
    const detectedQuantity = matched.reduce((sum, d) => sum + d.quantity, 0);
    return {
      receiptItem,
      orderedQuantity: receiptItem.quantity,
      detectedQuantity,
      proposedMissingQuantity: Math.max(0, receiptItem.quantity - detectedQuantity),
      matchedDetections: matched,
      matchQuality: qualities[lineIndex] ?? "none",
      lowestConfidence:
        matched.length === 0 ? null : Math.min(...matched.map((d) => d.confidence)),
    };
  });

  const unmatchedDetections = detections.filter((_, i) => !claimed.has(i));

  return {
    status: "proposed",
    lines,
    unmatchedDetections,
    hasAmbiguity:
      unmatchedDetections.length > 0 || lines.some((l) => l.matchQuality === "fuzzy"),
  };
}

/**
 * Turn HUMAN-CONFIRMED missing quantities into money.ts input.
 *
 * Takes confirmed lines, not a DiffResult, on purpose: there is no code path
 * from raw model output to a dollar figure. A human has to have looked.
 * PROMPT.md §3.4.
 */
export function toMissingQuantities(
  confirmed: readonly { receiptItem: OrderItem; missingQuantity: number }[],
): MissingQuantity[] {
  return confirmed
    .filter((c) => c.missingQuantity > 0)
    .map((c) => ({
      quantity: c.missingQuantity,
      unitPriceCents: c.receiptItem.unitPriceCents,
    }));
}
