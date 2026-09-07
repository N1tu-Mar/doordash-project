/**
 * Shorted — proportional refund math. PROMPT.md §5,
 * research/findings/money-model.md (READY FOR BUILD).
 *
 * PURE and deterministic. Integer cents only.
 *
 * The premise: DoorDash refunds the item price. The user also paid service fee,
 * delivery fee, tax and tip *on that item*. This module computes the whole loss
 * so the claim carries a specific number instead of a vague complaint.
 *
 * What this computes is WHAT THE USER IS OWED. It is not a prediction of what
 * DoorDash will pay — those are different numbers and the gap between them is
 * the product thesis (money-model.md §6). Nothing here is ever capped by an
 * observed recovery rate.
 */
import { ShortedDataError } from "./types.js";

/* ------------------------------------------------------------- fee lines */

/**
 * How a fee line behaves when part of the order never arrived.
 * money-model.md Correction B. The classification drives both the arithmetic
 * and the argument the claim makes, so it is data, not a comment.
 */
export type FeeKind =
  /** Explicitly a % of subtotal (service fee). An undelivered subtotal cannot carry it. */
  | "proportional"
  /** Delivery/long-distance/expanded-range. The delivery did occur — weakest line, opt-in. */
  | "per_delivery"
  /** Small-order fee. Never pro-rated: removing items would have raised it, not lowered it. */
  | "threshold"
  /** Regulatory response, bag/bottle. Per-item vs per-order is unknown without corpus evidence. */
  | "passthrough"
  /** Label we do not recognise. NEVER silently included in a total the user sends. */
  | "unknown";

export interface FeeLine {
  /** Printed label, verbatim. This is what the claim text names. */
  label: string;
  cents: number;
  kind: FeeKind;
}

/**
 * Whether a kind is pro-rated at all, and whether it belongs in the number we
 * put in front of the user first.
 *
 * `per_delivery` and `passthrough` are computed but default OFF: they are real
 * amounts with weak arguments, and a claim that overreaches gives the reviewer
 * a reason to deny the whole thing (money-model.md Correction B).
 */
const FEE_POLICY: Record<FeeKind, { prorate: boolean; defaultIncluded: boolean }> = {
  proportional: { prorate: true, defaultIncluded: true },
  per_delivery: { prorate: true, defaultIncluded: false },
  threshold: { prorate: false, defaultIncluded: false },
  passthrough: { prorate: true, defaultIncluded: false },
  unknown: { prorate: false, defaultIncluded: false },
};

/** Why a component is not in the headline number. Shown to the user by label. */
export type ExclusionReason =
  | "delivery_occurred"
  | "threshold_fee_does_not_scale"
  | "fee_scope_unknown"
  | "unrecognised_fee_label"
  | "tip_is_a_separate_decision";

/* --------------------------------------------------------------- inputs */

/** One receipt line, pre-discount. Quantity × unit price is what the merchant listed. */
export interface ReceiptLine {
  quantity: number;
  unitPriceCents: number;
}

/**
 * The money side of a receipt.
 *
 * `lineItems` is required and is not derivable from `subtotalCents`: the gap
 * between their sum and the printed subtotal IS the order-level discount, and
 * that discount has to be allocated to the missing items or the claim
 * over-states (money-model.md Correction A).
 */
export interface ReceiptMoney {
  lineItems: readonly ReceiptLine[];
  subtotalCents: number;
  feeLines: readonly FeeLine[];
  taxCents: number;
  tipCents: number;
  totalCents: number;
  /**
   * Base the printed tax was actually charged on, when it is known. Omit when
   * it is not: the derived rate then assumes the whole subtotal is taxable and
   * the result is flagged `basisIsAssumed`. Mixed taxable/non-taxable orders
   * (grocery) break that assumption, so we mark it rather than hide it
   * (money-model.md Correction C).
   */
  taxableBaseCents?: number;
}

/** A quantity of a line item that did not arrive. */
export interface MissingQuantity {
  quantity: number;
  unitPriceCents: number;
}

/* -------------------------------------------------------------- outputs */

export interface OwedComponent {
  label: string;
  kind: FeeKind | "tax" | "tip" | "items";
  cents: number;
  /** In the headline figure. False components are shown, never silently dropped. */
  includedInHeadline: boolean;
  excludedReason?: ExclusionReason;
}

export interface OwedBreakdown {
  /** Σ(qty × unit price) over every receipt line, before any order-level discount. */
  lineSumCents: number;
  /** lineSum − printed subtotal. Order promo / DashPass / merchant offer. */
  orderDiscountCents: number;
  /** Face value of what did not arrive, before its share of the order discount. */
  missingGrossCents: number;
  /** What the missing items actually cost after their share of the discount. */
  missingNetCents: number;
  /** missingNet / subtotal, in basis points. Audit trail and UI copy. */
  shareBasisPoints: number;

  /** Every component, included or not, in claim-presentation order. */
  components: OwedComponent[];

  /** The number to lead with: items + default-included fees + tax. No tip. */
  headlineCents: number;
  /** Headline + the tip attributable to the missing items. */
  withTipCents: number;
  /** Everything defensible at all, including the weak lines. Never the default ask. */
  maximumCents: number;

  /**
   * True when the tax component was derived against an assumed taxable base.
   * The UI must not present an assumed tax figure as a certainty.
   */
  taxBasisIsAssumed: boolean;
}

/* ------------------------------------------------------------ assertions */

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

function assertQuantity(label: string, quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ShortedDataError(`${label} must be a positive integer`, "MONEY_BAD_QTY", {
      label,
      quantity,
    });
  }
}

/**
 * Proportional share of `amountCents`, rounded to the nearest cent, then clamped
 * to the amount itself. The clamp is INV-3: you cannot reclaim more of a fee
 * line than you paid into it. It is an assertion, not a silent correction —
 * a share above 1.0 means the caller's inputs disagree and we throw.
 */
function allocate(amountCents: number, numerator: number, denominator: number): number {
  if (numerator > denominator) {
    throw new ShortedDataError(
      "allocation share exceeds 1 — receipt lines and totals disagree",
      "MONEY_SHARE_EXCEEDS_ONE",
      { numerator, denominator },
    );
  }
  return Math.round((amountCents * numerator) / denominator);
}

export function lineSumCents(lines: readonly ReceiptLine[]): number {
  let total = 0;
  for (const line of lines) {
    assertSafeCents("lineItem.unitPriceCents", line.unitPriceCents);
    assertQuantity("lineItem.quantity", line.quantity);
    total += line.unitPriceCents * line.quantity;
  }
  assertSafeCents("lineSum", total);
  return total;
}

export function missingSubtotalCents(missing: readonly MissingQuantity[]): number {
  let total = 0;
  for (const m of missing) {
    assertSafeCents("missing.unitPriceCents", m.unitPriceCents);
    assertQuantity("missing.quantity", m.quantity);
    total += m.unitPriceCents * m.quantity;
  }
  assertSafeCents("missingSubtotal", total);
  return total;
}

/* ----------------------------------------------------------- the compute */

/**
 * Compute what the user is actually owed for a set of missing items.
 *
 * Throws rather than returning a degraded answer. A refund claim built on a
 * receipt we could not fully parse is worse than no claim: it is a wrong number
 * sent to support under the user's name. PROMPT.md §2.
 */
export function computeOwed(
  receipt: ReceiptMoney,
  missing: readonly MissingQuantity[],
): OwedBreakdown {
  assertSafeCents("subtotalCents", receipt.subtotalCents);
  assertSafeCents("taxCents", receipt.taxCents);
  assertSafeCents("tipCents", receipt.tipCents);
  assertSafeCents("totalCents", receipt.totalCents);
  for (const fee of receipt.feeLines) assertSafeCents(`fee[${fee.label}]`, fee.cents);

  if (receipt.subtotalCents === 0) {
    throw new ShortedDataError(
      "cannot allocate fees against a zero subtotal",
      "MONEY_ZERO_SUBTOTAL",
    );
  }
  if (receipt.lineItems.length === 0) {
    throw new ShortedDataError(
      "receipt has no line items — the order discount cannot be derived",
      "MONEY_NO_LINE_ITEMS",
    );
  }

  const lineSum = lineSumCents(receipt.lineItems);

  // Correction A. A negative discount means the parsed lines exceed the printed
  // subtotal, which is a parse bug and not a promotion. Surface it; never clamp.
  const orderDiscountCents = lineSum - receipt.subtotalCents;
  if (orderDiscountCents < 0) {
    throw new ShortedDataError(
      "parsed line items sum to less than the printed subtotal — receipt is misparsed",
      "MONEY_NEGATIVE_DISCOUNT",
      { lineSum, subtotalCents: receipt.subtotalCents },
    );
  }

  const missingGrossCents = missingSubtotalCents(missing);
  if (missingGrossCents > lineSum) {
    throw new ShortedDataError(
      "missing items are worth more than every line on the receipt — receipt and diff disagree",
      "MONEY_MISSING_EXCEEDS_SUBTOTAL",
      { missingGrossCents, lineSum },
    );
  }

  const missingDiscountShare = allocate(orderDiscountCents, missingGrossCents, lineSum);
  const missingNetCents = missingGrossCents - missingDiscountShare;
  if (missingNetCents < 0) {
    throw new ShortedDataError(
      "order discount exceeds the value of the missing items",
      "MONEY_DISCOUNT_EXCEEDS_MISSING",
      { missingGrossCents, missingDiscountShare },
    );
  }
  if (missingNetCents > receipt.subtotalCents) {
    throw new ShortedDataError(
      "discounted missing value exceeds the order subtotal",
      "MONEY_MISSING_EXCEEDS_SUBTOTAL",
      { missingNetCents, subtotalCents: receipt.subtotalCents },
    );
  }

  const components: OwedComponent[] = [
    {
      label: "Items that did not arrive",
      kind: "items",
      cents: missingNetCents,
      includedInHeadline: true,
    },
  ];

  for (const fee of receipt.feeLines) {
    const policy = FEE_POLICY[fee.kind];
    const cents = policy.prorate
      ? allocate(fee.cents, missingNetCents, receipt.subtotalCents)
      : 0;

    // Correction D: a threshold fee can invert. It is reported at zero with a
    // reason, not omitted — the user should see we considered it.
    const component: OwedComponent = {
      label: fee.label,
      kind: fee.kind,
      cents,
      includedInHeadline: policy.defaultIncluded && cents > 0,
    };
    if (!component.includedInHeadline) {
      component.excludedReason = exclusionReasonFor(fee.kind);
    }
    components.push(component);
  }

  // Correction C: recompute tax against a base, do not scale a blob.
  const taxableBaseCents = receipt.taxableBaseCents ?? receipt.subtotalCents;
  assertSafeCents("taxableBaseCents", taxableBaseCents);
  if (taxableBaseCents === 0 && receipt.taxCents > 0) {
    throw new ShortedDataError(
      "tax was charged against a zero taxable base",
      "MONEY_ZERO_TAX_BASE",
    );
  }
  const taxBasisIsAssumed = receipt.taxableBaseCents === undefined;
  const taxCents =
    taxableBaseCents === 0
      ? 0
      : allocate(receipt.taxCents, Math.min(missingNetCents, taxableBaseCents), taxableBaseCents);
  components.push({
    label: "Tax on those items",
    kind: "tax",
    cents: taxCents,
    includedInHeadline: true,
  });

  // PROMPT.md §5: the tip is its own line the user can toggle, never buried.
  const tipCents = allocate(receipt.tipCents, missingNetCents, receipt.subtotalCents);
  components.push({
    label: "Tip on those items",
    kind: "tip",
    cents: tipCents,
    includedInHeadline: false,
    excludedReason: "tip_is_a_separate_decision",
  });

  const headlineCents = components
    .filter((c) => c.includedInHeadline)
    .reduce((sum, c) => sum + c.cents, 0);
  const withTipCents = headlineCents + tipCents;
  const maximumCents = components.reduce((sum, c) => sum + c.cents, 0);

  // PROMPT.md §5: never let the refund exceed what was actually paid.
  if (maximumCents > receipt.totalCents) {
    throw new ShortedDataError(
      "computed refund exceeds the order total — refusing to emit a claim",
      "MONEY_OWED_EXCEEDS_TOTAL",
      { maximumCents, totalCents: receipt.totalCents },
    );
  }

  return {
    lineSumCents: lineSum,
    orderDiscountCents,
    missingGrossCents,
    missingNetCents,
    shareBasisPoints: Math.round((missingNetCents * 10_000) / receipt.subtotalCents),
    components,
    headlineCents,
    withTipCents,
    maximumCents,
    taxBasisIsAssumed,
  };
}

function exclusionReasonFor(kind: FeeKind): ExclusionReason {
  switch (kind) {
    case "per_delivery":
      return "delivery_occurred";
    case "threshold":
      return "threshold_fee_does_not_scale";
    case "passthrough":
      return "fee_scope_unknown";
    case "unknown":
      return "unrecognised_fee_label";
    case "proportional":
      // Only reachable when a proportional share rounds to zero cents.
      return "fee_scope_unknown";
  }
}

/**
 * Recompute a total from the components the user actually selected.
 *
 * The toggles in the claim screen run through here rather than re-deriving
 * arithmetic in React, so what the user sends and what we tested are the same
 * function.
 */
export function selectedTotalCents(
  breakdown: OwedBreakdown,
  isSelected: (component: OwedComponent, index: number) => boolean,
): number {
  return breakdown.components.reduce(
    (sum, component, index) => (isSelected(component, index) ? sum + component.cents : sum),
    0,
  );
}

/**
 * Split one component across several missing items by largest remainder.
 *
 * Independent per-item rounding drifts: N items each rounding up on the same
 * fee line can sum to more than the line itself. Floor everything, then hand
 * the leftover cents to the largest fractional parts. Σ(split) == total, exactly
 * (money-model.md §2, INV-4).
 */
export function splitByLargestRemainder(
  totalCents: number,
  weights: readonly number[],
): number[] {
  assertSafeCents("splitTotal", totalCents);
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weights.length === 0) return [];
  if (weightSum <= 0) {
    throw new ShortedDataError(
      "cannot split a component across zero total weight",
      "MONEY_ZERO_WEIGHT",
    );
  }

  const exact = weights.map((w) => (totalCents * w) / weightSum);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = totalCents - floors.reduce((sum, v) => sum + v, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    // Ties break on index so the split is deterministic across runs and machines.
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const out = [...floors];
  for (const { index } of order) {
    if (remainder <= 0) break;
    out[index] = (out[index] ?? 0) + 1;
    remainder -= 1;
  }
  return out;
}

/**
 * How far the receipt's own lines are from its stated total.
 *
 * Non-zero is common and not necessarily a bug — promos, credits and DashPass
 * discounts land here. Surfaced, never silently absorbed.
 */
export function receiptBalanceDeltaCents(receipt: ReceiptMoney): number {
  const feesCents = receipt.feeLines.reduce((sum, f) => sum + f.cents, 0);
  return (
    receipt.totalCents -
    (receipt.subtotalCents + feesCents + receipt.taxCents + receipt.tipCents)
  );
}

/** Scalar fee total, for the `orders.fees_cents` column. */
export function totalFeesCents(feeLines: readonly FeeLine[]): number {
  return feeLines.reduce((sum, f) => sum + f.cents, 0);
}
