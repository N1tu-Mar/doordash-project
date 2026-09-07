/**
 * services/order-row.ts — ReceiptMoney to database columns.
 *
 * Pure mapping, no client, no network: the point of extracting it was that it
 * could be tested without one. Amounts only, no invented receipt (PROMPT.md §2).
 */
import { describe, expect, it } from "vitest";
import { feeLineRows, orderMoneyColumns } from "../services/order-row.js";
import type { ReceiptMoney } from "../core/money.js";

const totals: ReceiptMoney = {
  lineItems: [{ quantity: 1, unitPriceCents: 2_000 }],
  subtotalCents: 2_000,
  feeLines: [
    { label: "Service Fee", cents: 300, kind: "proportional" },
    { label: "Delivery Fee", cents: 400, kind: "per_delivery" },
  ],
  taxCents: 180,
  tipCents: 500,
  totalCents: 3_380,
};

describe("orderMoneyColumns", () => {
  it("sums the fee lines into the single printed total the receipt shows", () => {
    expect(orderMoneyColumns(totals).fees_cents).toBe(700);
  });

  it("records a zero balance delta when the receipt reconciles", () => {
    expect(orderMoneyColumns(totals).balance_delta_cents).toBe(0);
  });

  it("surfaces a reconciliation gap instead of absorbing it", () => {
    // A promo or credit the parser did not model. Recorded, not hidden.
    const withGap = { ...totals, totalCents: 3_180 };
    expect(orderMoneyColumns(withGap).balance_delta_cents).toBe(-200);
  });

  it("writes NULL for an undisclosed taxable base, not the subtotal", () => {
    // "We do not know which lines were taxable" and "all of them were" are
    // different facts. Defaulting to the subtotal would erase the difference.
    expect(orderMoneyColumns(totals).taxable_base_cents).toBeNull();
    expect(orderMoneyColumns({ ...totals, taxableBaseCents: 1_000 }).taxable_base_cents).toBe(
      1_000,
    );
  });

  it("emits integer cents in every money column", () => {
    for (const [key, value] of Object.entries(orderMoneyColumns(totals))) {
      if (value === null) continue;
      expect(Number.isInteger(value), key).toBe(true);
    }
  });

  it("does not put fee lines on the order row — they are their own table", () => {
    expect(Object.keys(orderMoneyColumns(totals))).not.toContain("fee_lines");
  });
});

describe("feeLineRows", () => {
  it("keeps the printed order, so the claim names fees as the user saw them", () => {
    const rows = feeLineRows("order-1", totals);
    expect(rows.map((r) => r.line_index)).toEqual([0, 1]);
    expect(rows.map((r) => r.label)).toEqual(["Service Fee", "Delivery Fee"]);
  });

  it("carries the kind through, because the kind is what decides the refund", () => {
    expect(feeLineRows("order-1", totals).map((r) => r.kind)).toEqual([
      "proportional",
      "per_delivery",
    ]);
  });

  it("returns nothing for a receipt with no fee lines", () => {
    expect(feeLineRows("order-1", { ...totals, feeLines: [] })).toEqual([]);
  });
});
