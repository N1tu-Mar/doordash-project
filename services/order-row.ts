/**
 * Shorted — the one place `ReceiptMoney` becomes `orders` table columns.
 *
 * This file exists to keep a mapping out of the middle of a large, actively
 * changing db.ts. `core/money.ts` owns the shape of an order's money and the
 * `orders` table owns the column names; whenever either moves, exactly one
 * function changes, and the writer that calls it does not.
 *
 * Fee LINES are not here. They are rows in `order_fee_lines`, not columns on
 * `orders` — see feeLineRows() below and migration 0005. `fees_cents` stays on
 * the order because the receipt prints a single fee total and the
 * reconciliation check (line sum + fees + tax + tip == printed total) needs it
 * as one number.
 */
import { receiptBalanceDeltaCents, totalFeesCents, type ReceiptMoney } from "../core/money.js";

/** The money columns of an `orders` row. Spread into the insert; nothing else. */
export function orderMoneyColumns(totals: ReceiptMoney): {
  subtotal_cents: number;
  fees_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  taxable_base_cents: number | null;
  balance_delta_cents: number;
} {
  return {
    subtotal_cents: totals.subtotalCents,
    // The sum of the printed fee lines. The lines themselves go to
    // order_fee_lines, where each keeps its label and its kind.
    fees_cents: totalFeesCents(totals.feeLines),
    tax_cents: totals.taxCents,
    tip_cents: totals.tipCents,
    total_cents: totals.totalCents,
    // NULL means the receipt did not say which lines were taxable. That is a
    // different fact from "all of them were", and core/money.ts reports the
    // difference as taxBasisIsAssumed rather than hiding it.
    taxable_base_cents: totals.taxableBaseCents ?? null,
    // Signed gap between the stated total and the sum of the parsed lines.
    // Promos and credits make this legitimately non-zero; recorded so parser
    // drift is visible instead of silently absorbed.
    balance_delta_cents: receiptBalanceDeltaCents(totals),
  };
}

/**
 * The `order_fee_lines` rows for an order.
 *
 * `line_index` is the printed position, so the claim can name fees in the order
 * the user saw them on the receipt rather than in whatever order the database
 * hands them back.
 */
export function feeLineRows(
  orderId: string,
  totals: ReceiptMoney,
): Array<{ order_id: string; label: string; cents: number; kind: string; line_index: number }> {
  return totals.feeLines.map((fee, lineIndex) => ({
    order_id: orderId,
    label: fee.label,
    cents: fee.cents,
    kind: fee.kind,
    line_index: lineIndex,
  }));
}
