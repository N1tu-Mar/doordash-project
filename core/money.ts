/**
 * Shorted — proportional refund math. PROMPT.md §5.
 *
 * PURE and deterministic. Integer cents only.
 *
 * The premise: DoorDash refunds the item price. The user also paid service fee,
 * delivery fee, tax and tip *on that item*. This module computes the whole loss
 * so the claim carries a specific number instead of a vague complaint.
 */
import { ShortedDataError } from "./types.js";

/** The money lines of a receipt. Subset of ParsedReceipt so diff output can feed it directly. */
export interface ReceiptTotals {
  subtotalCents: number;
  feesCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
}

/** A quantity of a line item that did not arrive. */
export interface MissingQuantity {
  quantity: number;
  unitPriceCents: number;
}

export interface OwedBreakdown {
  /** Face value of what did not arrive. What DoorDash typically offers. */
  missingSubtotalCents: number;
  feeShareCents: number;
  taxShareCents: number;
  /**
   * Tip attributable to the missing items. Arguable, and jurisdiction/policy
   * dependent — kept as its own line so the UI can toggle it off before sending.
   * PROMPT.md §5. Never fold this into a single total.
   */
  tipShareCents: number;
  /** The number to lead the claim with. */
  owedExcludingTipCents: number;
  owedIncludingTipCents: number;
  /** missing_subtotal / order_subtotal, in basis points. For the audit trail and UI copy. */
  shareBasisPoints: number;
}

function assertSafeCents(label: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new ShortedDataError(`${label} is not integer cents`, "MONEY_NOT_INTEGER", {
      label,
      value,
    });
  }
  if (!Number.isSafeInteger(value)) {
    throw new ShortedDataError(`${label} is out of safe integer range`, "MONEY_OUT_OF_RANGE", {
      label,
      value,
    });
  }
  if (value < 0) {
    throw new ShortedDataError(`${label} is negative`, "MONEY_NEGATIVE", { label, value });
  }
}

/**
 * Proportional share of `amountCents`, rounded to the nearest cent.
 * Each component rounds independently and the components are summed afterwards —
 * we never round the sum, because the user sees each line separately.
 */
function allocate(amountCents: number, numerator: number, denominator: number): number {
  return Math.round((amountCents * numerator) / denominator);
}

export function missingSubtotalCents(missing: readonly MissingQuantity[]): number {
  let total = 0;
  for (const m of missing) {
    assertSafeCents("missing.unitPriceCents", m.unitPriceCents);
    if (!Number.isInteger(m.quantity) || m.quantity < 1) {
      throw new ShortedDataError("missing quantity must be a positive integer", "MONEY_BAD_QTY", {
        quantity: m.quantity,
      });
    }
    total += m.unitPriceCents * m.quantity;
  }
  assertSafeCents("missingSubtotal", total);
  return total;
}

/**
 * Compute what the user is actually owed for a set of missing items.
 *
 * Throws rather than returning a degraded answer. A refund claim built on a
 * receipt we could not fully parse is worse than no claim: it is a wrong number
 * sent to support under the user's name. PROMPT.md §2.
 */
export function computeOwed(
  totals: ReceiptTotals,
  missing: readonly MissingQuantity[],
): OwedBreakdown {
  assertSafeCents("subtotalCents", totals.subtotalCents);
  assertSafeCents("feesCents", totals.feesCents);
  assertSafeCents("taxCents", totals.taxCents);
  assertSafeCents("tipCents", totals.tipCents);
  assertSafeCents("totalCents", totals.totalCents);

  if (totals.subtotalCents === 0) {
    throw new ShortedDataError(
      "cannot allocate fees against a zero subtotal",
      "MONEY_ZERO_SUBTOTAL",
    );
  }

  const missingSubtotal = missingSubtotalCents(missing);
  if (missingSubtotal > totals.subtotalCents) {
    throw new ShortedDataError(
      "missing items are worth more than the order subtotal — receipt and diff disagree",
      "MONEY_MISSING_EXCEEDS_SUBTOTAL",
      { missingSubtotal, subtotalCents: totals.subtotalCents },
    );
  }

  const feeShareCents = allocate(totals.feesCents, missingSubtotal, totals.subtotalCents);
  const taxShareCents = allocate(totals.taxCents, missingSubtotal, totals.subtotalCents);
  const tipShareCents = allocate(totals.tipCents, missingSubtotal, totals.subtotalCents);

  const owedExcludingTipCents = missingSubtotal + feeShareCents + taxShareCents;
  const owedIncludingTipCents = owedExcludingTipCents + tipShareCents;

  // PROMPT.md §5: never let the refund exceed what was actually paid.
  if (owedIncludingTipCents > totals.totalCents) {
    throw new ShortedDataError(
      "computed refund exceeds the order total — refusing to emit a claim",
      "MONEY_OWED_EXCEEDS_TOTAL",
      { owedIncludingTipCents, totalCents: totals.totalCents },
    );
  }

  return {
    missingSubtotalCents: missingSubtotal,
    feeShareCents,
    taxShareCents,
    tipShareCents,
    owedExcludingTipCents,
    owedIncludingTipCents,
    shareBasisPoints: Math.round((missingSubtotal * 10_000) / totals.subtotalCents),
  };
}

/**
 * How far the receipt's own lines are from its stated total.
 *
 * Non-zero is common and not necessarily a bug — promos, credits and DashPass
 * discounts are separate lines we do not yet model. Surfaced, never silently
 * absorbed; see research/findings/REQUESTS.md.
 */
export function receiptBalanceDeltaCents(totals: ReceiptTotals): number {
  return (
    totals.totalCents -
    (totals.subtotalCents + totals.feesCents + totals.taxCents + totals.tipCents)
  );
}
