/**
 * Shorted — optimal one-to-one assignment. PURE, deterministic, no I/O.
 *
 * Hungarian algorithm (Jonker-Volgenant style shortest augmenting path,
 * O(n^2 m)). Extracted from core/diff.ts because it is general arithmetic with
 * a known-correct definition, and because a matcher bug is a wrong dollar
 * figure — it deserves its own tests.
 *
 * Why an assignment and not a greedy pass: two similar receipt lines can both
 * clear a similarity threshold against the same detection. A greedy matcher
 * pairs whichever it reaches first, producing a phantom shortage on one line
 * and a phantom wrong-item on the other, from a single order.
 * See research/findings/RESPONSES.md R3.
 */
import { ShortedDataError } from "./types.js";

/**
 * Minimum-cost perfect assignment of rows to columns.
 *
 * Returns `assignment[row] = column | -1`. Rows beyond the column count are
 * unassigned. Costs must be finite: an infinite cost is expressed as a large
 * finite penalty by the caller, so the optimizer can still compare options.
 */
export function minCostAssignment(cost: readonly (readonly number[])[]): number[] {
  const rows = cost.length;
  if (rows === 0) return [];
  const cols = cost[0]?.length ?? 0;
  if (cols === 0) return new Array<number>(rows).fill(-1);

  for (const row of cost) {
    if (row.length !== cols) {
      throw new ShortedDataError("cost matrix is ragged", "ASSIGN_RAGGED_MATRIX", {
        expected: cols,
        got: row.length,
      });
    }
    for (const value of row) {
      if (!Number.isFinite(value)) {
        throw new ShortedDataError(
          "cost matrix contains a non-finite value — use a finite penalty instead",
          "ASSIGN_NON_FINITE_COST",
        );
      }
    }
  }

  // The algorithm below needs rows <= cols. Transpose and invert the result
  // otherwise, rather than padding with rows that mean nothing.
  if (rows > cols) {
    const transposed: number[][] = Array.from({ length: cols }, (_, c) =>
      Array.from({ length: rows }, (_, r) => cost[r]?.[c] ?? 0),
    );
    const flipped = minCostAssignment(transposed);
    const out = new Array<number>(rows).fill(-1);
    flipped.forEach((row, col) => {
      if (row >= 0) out[row] = col;
    });
    return out;
  }

  const INF = Number.POSITIVE_INFINITY;
  const at = (r: number, c: number): number => cost[r]?.[c] ?? 0;

  // 1-indexed working arrays, as the standard formulation is written.
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const columnRow = new Array<number>(cols + 1).fill(0); // columnRow[col] = row
  const way = new Array<number>(cols + 1).fill(0);

  for (let i = 1; i <= rows; i += 1) {
    columnRow[0] = i;
    let j0 = 0;
    const minv = new Array<number>(cols + 1).fill(INF);
    const used = new Array<boolean>(cols + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = columnRow[j0] ?? 0;
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= cols; j += 1) {
        if (used[j]) continue;
        const cur = at(i0 - 1, j - 1) - (u[i0] ?? 0) - (v[j] ?? 0);
        if (cur < (minv[j] ?? INF)) {
          minv[j] = cur;
          way[j] = j0;
        }
        if ((minv[j] ?? INF) < delta) {
          delta = minv[j] ?? INF;
          j1 = j;
        }
      }

      for (let j = 0; j <= cols; j += 1) {
        if (used[j]) {
          const row = columnRow[j] ?? 0;
          u[row] = (u[row] ?? 0) + delta;
          v[j] = (v[j] ?? 0) - delta;
        } else {
          minv[j] = (minv[j] ?? INF) - delta;
        }
      }
      j0 = j1;
    } while ((columnRow[j0] ?? 0) !== 0);

    do {
      const j1 = way[j0] ?? 0;
      columnRow[j0] = columnRow[j1] ?? 0;
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= cols; j += 1) {
    const row = columnRow[j] ?? 0;
    if (row > 0) assignment[row - 1] = j - 1;
  }
  return assignment;
}
