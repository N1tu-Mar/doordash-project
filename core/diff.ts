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
import { minCostAssignment } from "./assign.js";

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
  /** Similarity that justified the pairing, or null when nothing matched. */
  matchScore: number | null;
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

/**
 * The part of an item name before the first modifier delimiter.
 *
 * Receipt names carry modifier tails ("Burrito - chicken, no beans, extra rice")
 * that vision output does not ("burrito"). Token-set overlap over the full
 * strings drags under any threshold purely on token count, which
 * research/findings/RESPONSES.md R3 names as the highest-frequency failure to
 * expect. Comparing heads as a second score costs nothing and is deterministic.
 */
export function headNoun(name: string): string {
  const normalized = name.split(/[-–—(,/]/)[0] ?? name;
  return normalizeItemName(normalized);
}

/** Jaccard overlap of token sets. 1 = identical token bags, 0 = disjoint. */
export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  return intersection / (ta.size + tb.size - intersection);
}

/**
 * Similarity of two item names: the better of whole-string overlap and head-noun
 * overlap. Never a synonym table and never stemming — those are guesses dressed
 * up as logic, and a wrong guess here becomes a wrong dollar amount.
 */
export function nameSimilarity(a: string, b: string): number {
  return Math.max(jaccard(a, b), jaccard(headNoun(a), headNoun(b)));
}

/**
 * A floor on which pairings are ACCEPTABLE. It is not the matching rule —
 * the matching rule is the global assignment below (RESPONSES.md R3).
 *
 * The value is still unmeasured. Tuning it needs the detection eval, which
 * needs the corpus. See research/findings/REQUESTS.md R3.
 */
export const FUZZY_MATCH_THRESHOLD = 0.6;

/** Cost charged to a pairing below the threshold, so the optimizer avoids it. */
const UNACCEPTABLE_COST = 1_000;

/**
 * Detections carrying the same normalized name, merged into one candidate.
 *
 * Two containers of the same thing arrive as two detections; the receipt shows
 * one line with quantity 2. Grouping before assignment is what lets a 1:1
 * matcher handle that without inventing a shortage.
 */
interface DetectionGroup {
  name: string;
  quantity: number;
  members: DetectedItem[];
}

function groupDetections(detections: readonly DetectedItem[]): DetectionGroup[] {
  const groups = new Map<string, DetectionGroup>();
  for (const d of detections) {
    const key = normalizeItemName(d.name);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { name: d.name, quantity: d.quantity, members: [d] });
    } else {
      existing.quantity += d.quantity;
      existing.members.push(d);
    }
  }
  return [...groups.values()];
}

export function diffOrder(
  receiptItems: readonly OrderItem[],
  detections: readonly DetectedItem[],
): DiffResult {
  const groups = groupDetections(detections);

  // Score every pair, then solve globally. Identity matching only — quantity is
  // reconciled afterwards, because a receipt line of 2 against a detection of 1
  // is a partial shortage, not a failed match (RESPONSES.md R3).
  const cost = receiptItems.map((item) =>
    groups.map((group) => {
      const score = nameSimilarity(group.name, item.name);
      return score >= FUZZY_MATCH_THRESHOLD ? 1 - score : UNACCEPTABLE_COST;
    }),
  );

  const assignment = minCostAssignment(cost);

  const claimed = new Set<number>();
  const lines: DiffLine[] = receiptItems.map((receiptItem, lineIndex) => {
    const groupIndex = assignment[lineIndex] ?? -1;
    const group = groupIndex >= 0 ? groups[groupIndex] : undefined;
    const score =
      group === undefined ? 0 : nameSimilarity(group.name, receiptItem.name);

    // An assignment can still hand back a pairing below the floor when there is
    // nothing better available. Reject it here: the floor is absolute.
    const accepted = group !== undefined && score >= FUZZY_MATCH_THRESHOLD;
    if (accepted && groupIndex >= 0) claimed.add(groupIndex);

    const matched = accepted && group ? group.members : [];
    const detectedQuantity = accepted && group ? group.quantity : 0;
    const exact =
      accepted && group
        ? normalizeItemName(group.name) === normalizeItemName(receiptItem.name)
        : false;

    return {
      receiptItem,
      orderedQuantity: receiptItem.quantity,
      detectedQuantity,
      proposedMissingQuantity: Math.max(0, receiptItem.quantity - detectedQuantity),
      matchedDetections: matched,
      matchQuality: accepted ? (exact ? "exact" : "fuzzy") : "none",
      matchScore: accepted ? score : null,
      lowestConfidence:
        matched.length === 0 ? null : Math.min(...matched.map((d) => d.confidence)),
    };
  });

  const unmatchedDetections = groups
    .filter((_, i) => !claimed.has(i))
    .flatMap((g) => g.members);

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
