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
import { diffOrder, nameSimilarity, normalizeItemName, toMissingQuantities } from "../core/diff.js";

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
