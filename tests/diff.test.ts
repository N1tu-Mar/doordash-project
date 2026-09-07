/**
 * core/diff.ts.
 *
 * Only the string-normalization and matching MECHANICS are unit tested here,
 * with non-food strings — no invented menu items, no invented receipts
 * (PROMPT.md §2). Whether the matcher actually works on real DoorDash item
 * names against real vision output is an accuracy question, and accuracy is
 * measured against the real corpus in research/evals/, not asserted here.
 */
import { describe, expect, it } from "vitest";
import {
  diffOrder,
  headNoun,
  jaccard,
  nameSimilarity,
  normalizeItemName,
  toMissingQuantities,
} from "../core/diff.js";

describe("normalizeItemName", () => {
  it("collapses case, punctuation and whitespace", () => {
    expect(normalizeItemName("  Alpha—Bravo,  CHARLIE ")).toBe("alpha bravo charlie");
  });

  it("normalizes smart quotes to a plain apostrophe", () => {
    expect(normalizeItemName("Alpha’s Bravo")).toBe("alpha's bravo");
  });

  it("does not stem, translate or substitute synonyms", () => {
    expect(normalizeItemName("Alphas")).not.toBe(normalizeItemName("Alpha"));
  });
});

describe("nameSimilarity", () => {
  it("is 1 for token-identical names and 0 for disjoint ones", () => {
    expect(nameSimilarity("alpha bravo", "BRAVO, alpha")).toBe(1);
    expect(nameSimilarity("alpha", "zulu")).toBe(0);
  });

  it("survives a modifier tail that whole-string overlap alone cannot", () => {
    // RESPONSES.md R3: the receipt name carries modifiers the detection never
    // sees, and token count alone drags Jaccard under any threshold.
    const receiptName = "alpha - bravo, no charlie, extra delta";
    expect(jaccard(receiptName, "alpha")).toBeLessThan(0.6);
    expect(nameSimilarity(receiptName, "alpha")).toBe(1);
  });
});

describe("headNoun", () => {
  it("takes the text before the first modifier delimiter", () => {
    expect(headNoun("alpha bravo - charlie")).toBe("alpha bravo");
    expect(headNoun("alpha, bravo")).toBe("alpha");
    expect(headNoun("alpha")).toBe("alpha");
  });
});

describe("diffOrder", () => {
  const item = (name: string, quantity: number) => ({
    name,
    quantity,
    unitPriceCents: 100,
    modifiers: [],
  });
  const detection = (name: string, quantity: number, confidence = 0.9) => ({
    name,
    quantity,
    confidence,
    photoPath: "delivered/0",
  });

  it("marks output as a proposal, never a verdict", () => {
    expect(diffOrder([item("alpha", 1)], []).status).toBe("proposed");
  });

  it("proposes the shortfall when fewer units were detected than ordered", () => {
    const result = diffOrder([item("alpha", 3)], [detection("alpha", 1)]);
    expect(result.lines[0]?.proposedMissingQuantity).toBe(2);
    expect(result.lines[0]?.matchQuality).toBe("exact");
  });

  it("never proposes a negative shortfall when the model over-counts", () => {
    const result = diffOrder([item("alpha", 1)], [detection("alpha", 4)]);
    expect(result.lines[0]?.proposedMissingQuantity).toBe(0);
  });

  it("prefers an exact match over a fuzzy one competing for the same detection", () => {
    const result = diffOrder(
      [item("alpha bravo charlie", 1), item("alpha bravo", 1)],
      [detection("alpha bravo", 1)],
    );
    expect(result.lines[1]?.matchQuality).toBe("exact");
    expect(result.lines[0]?.matchQuality).toBe("none");
  });

  it("solves globally instead of letting the first line take the wrong detection", () => {
    // The failure RESPONSES.md R3 describes: two similar lines, two similar
    // detections. A greedy pass walking lines in order pairs line 0 with the
    // detection that belongs to line 1, producing one phantom shortage and one
    // phantom wrong-item from a single order.
    const result = diffOrder(
      [item("alpha bravo", 1), item("alpha charlie", 1)],
      [detection("alpha charlie", 1), detection("alpha bravo", 1)],
    );
    expect(result.lines.map((l) => l.matchedDetections[0]?.name)).toEqual([
      "alpha bravo",
      "alpha charlie",
    ]);
    expect(result.lines.every((l) => l.proposedMissingQuantity === 0)).toBe(true);
    expect(result.unmatchedDetections).toHaveLength(0);
  });

  it("sums same-name detections before matching, so two containers are not a shortage", () => {
    const result = diffOrder([item("alpha", 2)], [detection("alpha", 1), detection("Alpha", 1)]);
    expect(result.lines[0]?.detectedQuantity).toBe(2);
    expect(result.lines[0]?.proposedMissingQuantity).toBe(0);
    expect(result.unmatchedDetections).toHaveLength(0);
  });

  it("treats a quantity shortfall as a partial shortage, not a failed match", () => {
    const result = diffOrder([item("alpha", 3)], [detection("alpha", 1)]);
    expect(result.lines[0]?.matchQuality).toBe("exact");
    expect(result.lines[0]?.proposedMissingQuantity).toBe(2);
  });

  it("refuses a pairing below the floor even when nothing better is available", () => {
    const result = diffOrder([item("alpha", 1)], [detection("zulu", 1)]);
    expect(result.lines[0]?.matchQuality).toBe("none");
    expect(result.lines[0]?.matchScore).toBeNull();
    expect(result.unmatchedDetections.map((d) => d.name)).toEqual(["zulu"]);
  });

  it("reports the score that justified a fuzzy pairing", () => {
    const result = diffOrder([item("alpha bravo charlie", 1)], [detection("alpha bravo charlie delta", 1)]);
    expect(result.lines[0]?.matchQuality).toBe("fuzzy");
    expect(result.lines[0]?.matchScore).toBeGreaterThanOrEqual(0.6);
  });

  it("reports unmatched detections as possible wrong-item candidates", () => {
    const result = diffOrder([item("alpha", 1)], [detection("alpha", 1), detection("zulu", 1)]);
    expect(result.unmatchedDetections.map((d) => d.name)).toEqual(["zulu"]);
    expect(result.hasAmbiguity).toBe(true);
  });

  it("surfaces the weakest confidence backing a line", () => {
    const result = diffOrder([item("alpha", 2)], [detection("alpha", 1, 0.4), detection("alpha", 1, 0.95)]);
    expect(result.lines[0]?.lowestConfidence).toBe(0.4);
  });

  it("reports no ambiguity when everything matched exactly", () => {
    expect(diffOrder([item("alpha", 1)], [detection("alpha", 1)]).hasAmbiguity).toBe(false);
  });
});

describe("toMissingQuantities", () => {
  const receiptItem = { name: "alpha", quantity: 2, unitPriceCents: 250, modifiers: [] };

  it("drops confirmed-present lines and carries unit price through", () => {
    expect(
      toMissingQuantities([
        { receiptItem, missingQuantity: 0 },
        { receiptItem, missingQuantity: 2 },
      ]),
    ).toEqual([{ quantity: 2, unitPriceCents: 250 }]);
  });
});
