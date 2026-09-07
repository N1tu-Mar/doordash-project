/**
 * core/dedupe.ts — cross-photo detection merge.
 *
 * Non-food placeholder names only, as in tests/diff.test.ts: these exercise the
 * merge MECHANICS. Whether the merge is right on real plates is an accuracy
 * question measured against the corpus in research/evals/ (PROMPT.md §2).
 */
import { describe, expect, it } from "vitest";
import { mergePhotoDetections, type PhotoDetection } from "../core/dedupe.js";

const photo = (
  photoPath: string,
  items: Array<[string, number, number?]>,
  obstructed = false,
): PhotoDetection => ({
  photoPath,
  obstructed,
  items: items.map(([name, quantity, confidence]) => ({
    name,
    quantity,
    confidence: confidence ?? 0.9,
  })),
});

describe("mergePhotoDetections", () => {
  it("sums the same name WITHIN one photo — two containers on one table", () => {
    const merged = mergePhotoDetections([photo("p1", [["alpha", 1], ["Alpha", 1]])]);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]?.quantity).toBe(2);
    expect(merged.items[0]?.crossPhotoAmbiguous).toBe(false);
  });

  it("takes the max ACROSS photos rather than double-counting one item", () => {
    const merged = mergePhotoDetections([
      photo("p1", [["alpha", 2]]),
      photo("p2", [["alpha", 2]]),
    ]);
    expect(merged.items[0]?.quantity).toBe(2);
    expect(merged.items[0]?.summedQuantity).toBe(4);
  });

  it("flags a cross-photo repeat instead of resolving it silently", () => {
    // Two photos, same name: either one item shot twice or two items in two
    // frames. The photos cannot settle it, so the human does (RESPONSES.md R5).
    const merged = mergePhotoDetections([
      photo("p1", [["alpha", 1]]),
      photo("p2", [["alpha", 1]]),
    ]);
    expect(merged.items[0]?.crossPhotoAmbiguous).toBe(true);
    expect(merged.items[0]?.photoPaths).toEqual(["p1", "p2"]);
    expect(merged.items[0]?.maxQuantityInOnePhoto).toBe(1);
    expect(merged.items[0]?.summedQuantity).toBe(2);
  });

  it("does not flag a name that only ever appeared in one photo", () => {
    const merged = mergePhotoDetections([
      photo("p1", [["alpha", 1]]),
      photo("p2", [["bravo", 1]]),
    ]);
    expect(merged.items.every((i) => !i.crossPhotoAmbiguous)).toBe(true);
    expect(merged.items.map((i) => i.photoPath)).toEqual(["p1", "p2"]);
  });

  it("keeps the stronger confidence when a second photo corroborates", () => {
    const merged = mergePhotoDetections([
      photo("p1", [["alpha", 1, 0.4]]),
      photo("p2", [["alpha", 1, 0.95]]),
    ]);
    expect(merged.items[0]?.confidence).toBe(0.95);
  });

  it("reports obstruction if any single photo was obstructed", () => {
    expect(
      mergePhotoDetections([photo("p1", [["alpha", 1]]), photo("p2", [], true)]).obstructed,
    ).toBe(true);
  });

  it("counts photos that detected nothing instead of dropping them", () => {
    const merged = mergePhotoDetections([photo("p1", []), photo("p2", [["alpha", 1]])]);
    expect(merged.emptyPhotoPaths).toEqual(["p1"]);
  });

  it("is order-stable: output follows the order the photos were supplied", () => {
    const merged = mergePhotoDetections([
      photo("p1", [["bravo", 1], ["alpha", 1]]),
      photo("p2", [["charlie", 1]]),
    ]);
    expect(merged.items.map((i) => i.name)).toEqual(["bravo", "alpha", "charlie"]);
  });

  it("returns nothing for no photos, rather than an empty-looking success", () => {
    const merged = mergePhotoDetections([]);
    expect(merged.items).toEqual([]);
    expect(merged.obstructed).toBe(false);
  });
});
