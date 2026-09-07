/**
 * Property tests for core/money.ts — INV-1..INV-8 from
 * research/findings/money-model.md §3.
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
import {
  computeOwed,
  missingSubtotalCents,
  selectedTotalCents,
  splitByLargestRemainder,
  type FeeKind,
  type ReceiptMoney,
} from "../core/money.js";
import { ShortedDataError } from "../core/types.js";

const PRORATABLE: FeeKind[] = ["proportional", "per_delivery", "passthrough"];

/**
 * A coherent receipt shape: line items, an order-level discount that does not
 * exceed them, fee lines, and a total that reconciles. Amounts only.
 */
const receiptArb = (feeKinds: readonly FeeKind[] = PRORATABLE) =>
  fc
    .record({
      lineItems: fc.array(
        fc.record({
          quantity: fc.integer({ min: 1, max: 4 }),
          unitPriceCents: fc.integer({ min: 1, max: 8_000 }),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      discountPct: fc.integer({ min: 0, max: 40 }),
      fees: fc.array(
        fc.record({
          cents: fc.integer({ min: 0, max: 900 }),
          kind: fc.constantFrom(...feeKinds),
        }),
        { maxLength: 4 },
      ),
      taxCents: fc.integer({ min: 0, max: 3_000 }),
      tipCents: fc.integer({ min: 0, max: 3_000 }),
    })
    .map(({ lineItems, discountPct, fees, taxCents, tipCents }): ReceiptMoney => {
      const lineSum = lineItems.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
      const discount = Math.floor((lineSum * discountPct) / 100);
      const subtotalCents = Math.max(1, lineSum - discount);
      const feeLines = fees.map((f, i) => ({ label: `fee-${i}`, cents: f.cents, kind: f.kind }));
      const feeTotal = feeLines.reduce((s, f) => s + f.cents, 0);
      return {
        lineItems,
        subtotalCents,
        feeLines,
        taxCents,
        tipCents,
        totalCents: subtotalCents + feeTotal + taxCents + tipCents,
      };
    });

/** Every unit of every line, missing. */
const allMissing = (receipt: ReceiptMoney) =>
  receipt.lineItems.map((l) => ({ quantity: l.quantity, unitPriceCents: l.unitPriceCents }));

/** The first `n` lines missing in full. */
const firstNMissing = (receipt: ReceiptMoney, n: number) => allMissing(receipt).slice(0, n);

describe("computeOwed invariants (money-model.md §3)", () => {
  it("INV-1: owed is never below the discounted value of the missing items", () => {
    fc.assert(
      fc.property(receiptArb(), fc.integer({ min: 1, max: 6 }), (receipt, n) => {
        const owed = computeOwed(receipt, firstNMissing(receipt, n));
        expect(owed.headlineCents).toBeGreaterThanOrEqual(owed.missingNetCents);
        expect(owed.maximumCents).toBeGreaterThanOrEqual(owed.headlineCents);
      }),
    );
  });

  it("INV-2: nothing ever exceeds the order total", () => {
    fc.assert(
      fc.property(receiptArb(), fc.integer({ min: 1, max: 6 }), (receipt, n) => {
        const owed = computeOwed(receipt, firstNMissing(receipt, n));
        expect(owed.maximumCents).toBeLessThanOrEqual(receipt.totalCents);
        expect(owed.withTipCents).toBeLessThanOrEqual(receipt.totalCents);
      }),
    );
  });

  it("INV-3: no component reclaims more than that line was worth", () => {
    fc.assert(
      fc.property(receiptArb(), fc.integer({ min: 1, max: 6 }), (receipt, n) => {
        const owed = computeOwed(receipt, firstNMissing(receipt, n));
        owed.components.forEach((component) => {
          if (component.kind === "tax") {
            expect(component.cents).toBeLessThanOrEqual(receipt.taxCents);
          } else if (component.kind === "tip") {
            expect(component.cents).toBeLessThanOrEqual(receipt.tipCents);
          } else if (component.kind === "items") {
            expect(component.cents).toBeLessThanOrEqual(receipt.subtotalCents);
          } else {
            const fee = receipt.feeLines.find((f) => f.label === component.label);
            expect(component.cents).toBeLessThanOrEqual(fee?.cents ?? 0);
          }
        });
      }),
    );
  });

  it("INV-5: every item missing owes exactly the whole ticket", () => {
    fc.assert(
      fc.property(receiptArb(), (receipt) => {
        const owed = computeOwed(receipt, allMissing(receipt));
        // Every generated fee line here is pro-ratable and the receipt reconciles,
        // so the boundary is exact. Any allocation leak shows up as a cent here.
        expect(owed.maximumCents).toBe(receipt.totalCents);
        expect(owed.missingNetCents).toBe(receipt.subtotalCents);
        expect(owed.shareBasisPoints).toBe(10_000);
      }),
    );
  });

  it("INV-5 does not hold by accident: a threshold fee is withheld from the boundary", () => {
    fc.assert(
      fc.property(receiptArb(["threshold"]), (receipt) => {
        const withheld = receipt.feeLines.reduce((s, f) => s + f.cents, 0);
        const owed = computeOwed(receipt, allMissing(receipt));
        expect(owed.maximumCents).toBe(receipt.totalCents - withheld);
      }),
    );
  });

  it("INV-6: nothing missing owes nothing", () => {
    fc.assert(
      fc.property(receiptArb(), (receipt) => {
        const owed = computeOwed(receipt, []);
        expect(owed.maximumCents).toBe(0);
        expect(owed.headlineCents).toBe(0);
        expect(owed.missingNetCents).toBe(0);
      }),
    );
  });

  it("INV-7: monotone — adding a missing item never lowers the total", () => {
    fc.assert(
      fc.property(receiptArb(), fc.integer({ min: 1, max: 5 }), (receipt, n) => {
        const smaller = firstNMissing(receipt, n);
        const larger = firstNMissing(receipt, n + 1);
        fc.pre(larger.length > smaller.length);
        const a = computeOwed(receipt, smaller);
        const b = computeOwed(receipt, larger);
        expect(b.withTipCents).toBeGreaterThanOrEqual(a.withTipCents);
        expect(b.maximumCents).toBeGreaterThanOrEqual(a.maximumCents);
      }),
    );
  });

  it("INV-8: a non-empty missing set with a real price owes something", () => {
    fc.assert(
      fc.property(receiptArb(), (receipt) => {
        const owed = computeOwed(receipt, firstNMissing(receipt, 1));
        fc.pre(owed.missingNetCents > 0);
        expect(owed.headlineCents).toBeGreaterThan(0);
      }),
    );
  });

  it("returns integer cents in every money field", () => {
    fc.assert(
      fc.property(receiptArb(), (receipt) => {
        const owed = computeOwed(receipt, allMissing(receipt));
        for (const value of [
          owed.headlineCents,
          owed.withTipCents,
          owed.maximumCents,
          owed.missingNetCents,
          owed.missingGrossCents,
          owed.orderDiscountCents,
          owed.lineSumCents,
        ]) {
          expect(Number.isInteger(value)).toBe(true);
        }
        owed.components.forEach((c) => expect(Number.isInteger(c.cents)).toBe(true));
      }),
    );
  });

  it("tip is separable — headline plus tip equals withTip, and tip is never in the headline", () => {
    fc.assert(
      fc.property(receiptArb(), fc.integer({ min: 1, max: 6 }), (receipt, n) => {
        const owed = computeOwed(receipt, firstNMissing(receipt, n));
        const tip = owed.components.find((c) => c.kind === "tip");
        expect(tip?.includedInHeadline).toBe(false);
        expect(owed.headlineCents + (tip?.cents ?? 0)).toBe(owed.withTipCents);
      }),
    );
  });
});

describe("order-level discount (money-model.md Correction A)", () => {
  it("allocates the discount to the missing items instead of over-stating", () => {
    const receipt: ReceiptMoney = {
      lineItems: [
        { quantity: 1, unitPriceCents: 1_000 },
        { quantity: 1, unitPriceCents: 1_000 },
      ],
      subtotalCents: 1_500, // $5 order-level promo
      feeLines: [],
      taxCents: 0,
      tipCents: 0,
      totalCents: 1_500,
    };
    const owed = computeOwed(receipt, [{ quantity: 1, unitPriceCents: 1_000 }]);
    expect(owed.orderDiscountCents).toBe(500);
    expect(owed.missingGrossCents).toBe(1_000);
    // Half the lines missing carries half the promo, not none of it.
    expect(owed.missingNetCents).toBe(750);
  });

  it("throws when line items sum below the printed subtotal — that is a parse bug", () => {
    expect(() =>
      computeOwed(
        {
          lineItems: [{ quantity: 1, unitPriceCents: 100 }],
          subtotalCents: 500,
          feeLines: [],
          taxCents: 0,
          tipCents: 0,
          totalCents: 500,
        },
        [{ quantity: 1, unitPriceCents: 100 }],
      ),
    ).toThrow(/misparsed/);
  });
});

describe("fee kinds (money-model.md Correction B, D)", () => {
  const base = {
    lineItems: [{ quantity: 2, unitPriceCents: 500 }],
    subtotalCents: 1_000,
    taxCents: 0,
    tipCents: 0,
  };

  it("keeps an unrecognised fee out of every number the user sends", () => {
    const owed = computeOwed(
      { ...base, feeLines: [{ label: "mystery", cents: 400, kind: "unknown" }], totalCents: 1_400 },
      [{ quantity: 2, unitPriceCents: 500 }],
    );
    const mystery = owed.components.find((c) => c.label === "mystery");
    expect(mystery?.cents).toBe(0);
    expect(mystery?.excludedReason).toBe("unrecognised_fee_label");
    expect(owed.maximumCents).toBe(1_000);
  });

  it("does not pro-rate a threshold fee, and says why", () => {
    const owed = computeOwed(
      { ...base, feeLines: [{ label: "small", cents: 200, kind: "threshold" }], totalCents: 1_200 },
      [{ quantity: 1, unitPriceCents: 500 }],
    );
    const small = owed.components.find((c) => c.label === "small");
    expect(small?.cents).toBe(0);
    expect(small?.excludedReason).toBe("threshold_fee_does_not_scale");
  });

  it("computes a delivery fee share but leaves it out of the headline", () => {
    const owed = computeOwed(
      { ...base, feeLines: [{ label: "d", cents: 400, kind: "per_delivery" }], totalCents: 1_400 },
      [{ quantity: 1, unitPriceCents: 500 }],
    );
    const delivery = owed.components.find((c) => c.label === "d");
    expect(delivery?.cents).toBe(200);
    expect(delivery?.includedInHeadline).toBe(false);
    expect(owed.headlineCents).toBe(500);
    expect(owed.maximumCents).toBe(700);
  });
});

describe("tax (money-model.md Correction C)", () => {
  const receipt: ReceiptMoney = {
    lineItems: [
      { quantity: 1, unitPriceCents: 1_000 },
      { quantity: 1, unitPriceCents: 1_000 },
    ],
    subtotalCents: 2_000,
    feeLines: [],
    taxCents: 88,
    tipCents: 0,
    totalCents: 2_088,
  };

  it("flags an assumed taxable base rather than presenting it as certain", () => {
    expect(computeOwed(receipt, [{ quantity: 1, unitPriceCents: 1_000 }]).taxBasisIsAssumed).toBe(
      true,
    );
  });

  it("recomputes against a supplied taxable base instead of scaling the blob", () => {
    // Half the order is non-taxable: the tax belongs entirely to the other half.
    const owed = computeOwed(
      { ...receipt, taxableBaseCents: 1_000 },
      [{ quantity: 1, unitPriceCents: 1_000 }],
    );
    expect(owed.taxBasisIsAssumed).toBe(false);
    expect(owed.components.find((c) => c.kind === "tax")?.cents).toBe(88);
  });
});

describe("splitByLargestRemainder (INV-4)", () => {
  it("splits exactly — the parts always sum to the whole", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 5_000 }), { minLength: 1, maxLength: 8 }),
        (total, weights) => {
          const parts = splitByLargestRemainder(total, weights);
          expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
          parts.forEach((p) => expect(Number.isInteger(p)).toBe(true));
        },
      ),
    );
  });

  it("gives leftover cents to the largest fractions, deterministically", () => {
    expect(splitByLargestRemainder(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it("throws rather than dividing by zero weight", () => {
    expect(() => splitByLargestRemainder(10, [0, 0])).toThrow(ShortedDataError);
  });
});

describe("selectedTotalCents", () => {
  it("recomputes from the components the user actually chose", () => {
    const owed = computeOwed(
      {
        lineItems: [{ quantity: 1, unitPriceCents: 1_000 }],
        subtotalCents: 1_000,
        feeLines: [{ label: "svc", cents: 200, kind: "proportional" }],
        taxCents: 100,
        tipCents: 300,
        totalCents: 1_600,
      },
      [{ quantity: 1, unitPriceCents: 1_000 }],
    );
    expect(selectedTotalCents(owed, (c) => c.includedInHeadline)).toBe(owed.headlineCents);
    expect(selectedTotalCents(owed, () => true)).toBe(owed.maximumCents);
    expect(selectedTotalCents(owed, (c) => c.kind === "items")).toBe(1_000);
  });
});

describe("computeOwed refuses bad input instead of degrading", () => {
  const receipt: ReceiptMoney = {
    lineItems: [{ quantity: 1, unitPriceCents: 1_000 }],
    subtotalCents: 1_000,
    feeLines: [{ label: "svc", cents: 300, kind: "proportional" }],
    taxCents: 80,
    tipCents: 200,
    totalCents: 1_580,
  };

  it("throws when missing value exceeds every line on the receipt", () => {
    expect(() => computeOwed(receipt, [{ quantity: 1, unitPriceCents: 1_001 }])).toThrow(
      ShortedDataError,
    );
  });

  it("throws on a zero subtotal rather than dividing by zero", () => {
    expect(() =>
      computeOwed({ ...receipt, subtotalCents: 0 }, [{ quantity: 1, unitPriceCents: 0 }]),
    ).toThrow(/zero subtotal/);
  });

  it("throws on a float amount rather than rounding it", () => {
    expect(() => missingSubtotalCents([{ quantity: 1, unitPriceCents: 12.34 }])).toThrow(
      /integer cents/,
    );
  });

  it("throws when the computed refund would exceed what was paid", () => {
    expect(() =>
      computeOwed({ ...receipt, totalCents: 500 }, [{ quantity: 1, unitPriceCents: 1_000 }]),
    ).toThrow(/exceeds the order total/);
  });

  it("throws on a receipt with no line items rather than assuming the subtotal", () => {
    expect(() => computeOwed({ ...receipt, lineItems: [] }, [])).toThrow(/no line items/);
  });
});
