/**
 * core/assign.ts — Hungarian assignment. Pure arithmetic over cost matrices;
 * no receipts, no items, no data (PROMPT.md §2).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { minCostAssignment } from "../core/assign.js";
import { ShortedDataError } from "../core/types.js";

const totalCost = (cost: number[][], assignment: number[]): number =>
  assignment.reduce((sum, col, row) => (col < 0 ? sum : sum + (cost[row]?.[col] ?? 0)), 0);

/** Brute force over every permutation. Only usable for tiny matrices — that is the point. */
function bruteForce(cost: number[][]): number {
  const rows = cost.length;
  const cols = cost[0]?.length ?? 0;
  let best = Number.POSITIVE_INFINITY;
  const used = new Array<boolean>(cols).fill(false);
  const walk = (row: number, acc: number): void => {
    if (row === rows) {
      best = Math.min(best, acc);
      return;
    }
    for (let c = 0; c < cols; c += 1) {
      if (used[c]) continue;
      used[c] = true;
      walk(row + 1, acc + (cost[row]?.[c] ?? 0));
      used[c] = false;
    }
  };
  walk(0, 0);
  return best;
}

describe("minCostAssignment", () => {
  it("finds the optimum, not a greedy first pick", () => {
    // Greedy on row 0 takes column 0 (cost 1) and forces row 1 onto cost 9.
    // The optimum swaps them for a total of 4.
    const cost = [
      [1, 3],
      [9, 3],
    ];
    // Greedy total would be 1 + 3 = 4 here; use an asymmetric case to be sure.
    const trap = [
      [1, 2],
      [1, 9],
    ];
    expect(totalCost(cost, minCostAssignment(cost))).toBe(bruteForce(cost));
    expect(totalCost(trap, minCostAssignment(trap))).toBe(3);
  });

  it("matches brute force on small random matrices", () => {
    fc.assert(
      fc.property(
        fc
          .record({
            rows: fc.integer({ min: 1, max: 4 }),
            cols: fc.integer({ min: 1, max: 4 }),
          })
          .chain(({ rows, cols }) =>
            fc
              .array(fc.array(fc.integer({ min: 0, max: 50 }), { minLength: cols, maxLength: cols }), {
                minLength: rows,
                maxLength: rows,
              })
              .map((cost) => cost),
          ),
        (cost) => {
          const assignment = minCostAssignment(cost);
          const rows = cost.length;
          const cols = cost[0]?.length ?? 0;

          // Every column used at most once.
          const used = assignment.filter((c) => c >= 0);
          expect(new Set(used).size).toBe(used.length);
          // As many rows assigned as there are columns to go round.
          expect(used.length).toBe(Math.min(rows, cols));

          if (rows <= cols) {
            expect(totalCost(cost, assignment)).toBe(bruteForce(cost));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("handles more rows than columns by leaving rows unassigned", () => {
    const assignment = minCostAssignment([[5], [1], [3]]);
    expect(assignment.filter((c) => c >= 0)).toHaveLength(1);
    expect(assignment[1]).toBe(0);
  });

  it("returns no assignments for an empty matrix", () => {
    expect(minCostAssignment([])).toEqual([]);
    expect(minCostAssignment([[], []])).toEqual([-1, -1]);
  });

  it("rejects a ragged matrix rather than reading past the end of a row", () => {
    expect(() => minCostAssignment([[1, 2], [3]])).toThrow(ShortedDataError);
  });

  it("rejects a non-finite cost instead of propagating NaN into a claim", () => {
    expect(() => minCostAssignment([[Number.POSITIVE_INFINITY]])).toThrow(/non-finite/);
  });
});
