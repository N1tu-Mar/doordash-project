/**
 * Property tests for core/money.ts.
 *
 * NOTE ON PROMPT.md §2: these generate integer AMOUNTS, not data. There are no
 * item names, merchants, orders or users here — nothing that could reach the
 * database or a screen, and nothing that could stand in for a real receipt.
 * This is arithmetic under test. Correctness against real receipts is
 * money.corpus.test.ts, and that suite is the one that gates the claim
 * "the money math works".
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeOwed, missingSubtotalCents } from "../core/money.js";
import { ShortedDataError } from "../core/types.js";

const cents = (max: number) => fc.integer({ min: 0, max });

/** Amounts consistent enough that computeOwed should not reject them outright. */
const coherentTotals = fc
  .record({
    subtotalCents: fc.integer({ min: 1, max: 50_000 }),
    feesCents: cents(10_000),
    taxCents: cents(10_000),
    tipCents: cents(10_000),
  })
  .map((t) => ({
    ...t,
    totalCents: t.subtotalCents + t.feesCents + t.taxCents + t.tipCents,
  }));

describe("computeOwed invariants", () => {
  it("never exceeds the order total", () => {
    fc.assert(
      fc.property(coherentTotals, fc.integer({ min: 1, max: 100 }), (totals, sharePct) => {
        const missingSub = Math.max(1, Math.floor((totals.subtotalCents * sharePct) / 100));
        const owed = computeOwed(totals, [{ quantity: 1, unitPriceCents: missingSub }]);
        expect(owed.owedIncludingTipCents).toBeLessThanOrEqual(totals.totalCents);
      }),
    );
  });

  it("is monotonic: more missing value never owes less", () => {
    fc.assert(
      fc.property(coherentTotals, fc.integer({ min: 1, max: 99 }), (totals, sharePct) => {
        const a = Math.max(1, Math.floor((totals.subtotalCents * sharePct) / 100));
        const b = Math.min(totals.subtotalCents, a + 1);
        const owedA = computeOwed(totals, [{ quantity: 1, unitPriceCents: a }]);
        const owedB = computeOwed(totals, [{ quantity: 1, unitPriceCents: b }]);
        expect(owedB.owedIncludingTipCents).toBeGreaterThanOrEqual(owedA.owedIncludingTipCents);
      }),
    );
  });

  it("returns integer cents in every field", () => {
    fc.assert(
      fc.property(coherentTotals, (totals) => {
        const owed = computeOwed(totals, [{ quantity: 1, unitPriceCents: totals.subtotalCents }]);
        for (const v of Object.values(owed)) expect(Number.isInteger(v)).toBe(true);
      }),
    );
  });

  it("claiming the whole subtotal owes at least the whole subtotal", () => {
    fc.assert(
      fc.property(coherentTotals, (totals) => {
        const owed = computeOwed(totals, [{ quantity: 1, unitPriceCents: totals.subtotalCents }]);
        expect(owed.owedExcludingTipCents).toBeGreaterThanOrEqual(totals.subtotalCents);
        expect(owed.shareBasisPoints).toBe(10_000);
      }),
    );
  });

  it("tip is separable — excluding-tip plus tip share equals including-tip", () => {
    fc.assert(
      fc.property(coherentTotals, fc.integer({ min: 1, max: 100 }), (totals, sharePct) => {
        const missingSub = Math.max(1, Math.floor((totals.subtotalCents * sharePct) / 100));
        const owed = computeOwed(totals, [{ quantity: 1, unitPriceCents: missingSub }]);
        expect(owed.owedExcludingTipCents + owed.tipShareCents).toBe(owed.owedIncludingTipCents);
      }),
    );
  });
});

describe("computeOwed refuses bad input instead of degrading", () => {
  const totals = { subtotalCents: 1000, feesCents: 300, taxCents: 80, tipCents: 200, totalCents: 1580 };

  it("throws when missing value exceeds the subtotal", () => {
    expect(() => computeOwed(totals, [{ quantity: 1, unitPriceCents: 1001 }])).toThrow(
      ShortedDataError,
    );
  });

  it("throws on a zero subtotal rather than dividing by zero", () => {
    expect(() =>
      computeOwed({ ...totals, subtotalCents: 0 }, [{ quantity: 1, unitPriceCents: 0 }]),
    ).toThrow(/zero subtotal/);
  });

  it("throws on a float amount rather than rounding it", () => {
    expect(() => missingSubtotalCents([{ quantity: 1, unitPriceCents: 12.34 }])).toThrow(
      /integer cents/,
    );
  });

  it("throws when the computed refund would exceed what was paid", () => {
    expect(() =>
      computeOwed({ ...totals, totalCents: 500 }, [{ quantity: 1, unitPriceCents: 1000 }]),
    ).toThrow(/exceeds the order total/);
  });
});
