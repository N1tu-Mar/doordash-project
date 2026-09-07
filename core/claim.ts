/**
 * Shorted — the dispute draft. PURE, deterministic, no model call.
 *
 * The claim text is generated in core/, not by Claude, for one reason: every
 * number in it is load-bearing and a model that rewrites prose can also
 * rewrite a digit. services/claim.ts may run this output through a model for
 * tone, but it has to prove afterwards that no amount changed.
 *
 * What this file is allowed to assert, from research/findings/RESPONSES.md R4:
 *
 *  - The premise that DoorDash under-refunds fees is PLAUSIBLE AND UNPROVEN.
 *    No public source says so in either direction, so the copy never accuses
 *    them of it. It states the item, its proportional share of each named fee
 *    line, and the total. A specific number needs no accusation to work.
 *  - Denial is a sanctioned outcome ("sole discretion", "if we suspect fraud
 *    or abuse"), so nothing here promises the user a result.
 *  - For a credit-card order a missing item is a Reg Z billing error with a
 *    real, non-waivable deadline. That is the one escalation we can cite with
 *    confidence, and only for credit. The debit/Reg E equivalent is materially
 *    weaker and is not presented as though it were the same lever.
 */
import type { OwedBreakdown, OwedComponent } from "./money.js";
import { ShortedDataError } from "./types.js";

/**
 * How the order was paid for. This changes which escalation is honest to cite,
 * so it is captured at claim time rather than assumed.
 */
export type FundingInstrument = "credit_card" | "debit_card" | "prepaid_or_credit" | "unknown";

/** A confirmed-missing line, in the user's own words after they corrected the model. */
export interface ClaimMissingLine {
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface ClaimInput {
  merchantName: string;
  /** ISO 8601 with offset. Rendered in the user's locale by the UI, not here. */
  orderedAt: string;
  missingLines: readonly ClaimMissingLine[];
  breakdown: OwedBreakdown;
  /**
   * Which components the user chose to ask for. Defaults come from
   * `includedInHeadline`; the claim screen's toggles override it. The tip is
   * always an explicit decision (PROMPT.md §5).
   */
  isSelected: (component: OwedComponent, index: number) => boolean;
  /** How many delivered-food photos back the claim. Evidence, stated plainly. */
  photoCount: number;
  funding: FundingInstrument;
  /**
   * Date the card statement carrying this charge was sent, if known. The Reg Z
   * clock runs from here, not from the order date — a distinction that decides
   * whether the right is still available.
   */
  statementTransmittedAt?: string;
}

export interface EscalationPath {
  /** Short name for the UI. */
  label: string;
  citation: string;
  /** Deadline in ISO date form, when it can be computed. */
  deadlineAt: string | null;
  explanation: string;
}

export interface ClaimDraft {
  subject: string;
  /** Paste-ready. Every amount in here came from core/money.ts. */
  body: string;
  /** What the body actually asks for, in cents. */
  askCents: number;
  /** Every amount that appears in `body`, for the no-drift check in services/claim.ts. */
  amountsCents: number[];
  /** Available next step, or null when nothing can be cited honestly. */
  escalation: EscalationPath | null;
  /**
   * Shown to the USER before sending. Not part of the message. These are the
   * places our own number rests on an assumption, said out loud.
   */
  disclaimers: string[];
}

/** 1234 -> "$12.34". Integer cents in, string out; no float ever appears. */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new ShortedDataError("cannot format non-integer cents", "CLAIM_NOT_INTEGER", { cents });
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${fraction}`;
}

/** YYYY-MM-DD from an ISO timestamp. Throws rather than rendering "Invalid Date". */
function isoDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new ShortedDataError(`unparseable timestamp: ${iso}`, "CLAIM_BAD_DATE", { iso });
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Reg Z billing-error rights, and only where they actually exist.
 *
 * 12 CFR 1026.13(a)(3) covers goods "not accepted" or "not delivered as
 * agreed", with wrong quantity an enumerated example. The written notice must
 * reach the creditor within 60 days of the statement transmit date; the issuer
 * owes acknowledgment in 30 days and resolution within two billing cycles and
 * no more than 90 days. Primary sources cited in refund-policy.md §3.
 */
export function escalationFor(
  funding: FundingInstrument,
  statementTransmittedAt: string | undefined,
): EscalationPath | null {
  if (funding !== "credit_card") {
    // Debit is Reg E, which is a materially weaker and differently-shaped
    // right. Citing it in the same breath would overstate the user's position,
    // so we say nothing rather than something confident and wrong.
    return null;
  }
  const deadlineAt =
    statementTransmittedAt === undefined
      ? null
      : isoDate(
          new Date(new Date(statementTransmittedAt).getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        );

  return {
    label: "Credit card billing error notice",
    citation: "12 CFR 1026.13(a)(3) (Regulation Z)",
    deadlineAt,
    explanation:
      "If this is not resolved, a charge for goods not delivered as agreed is a billing " +
      "error you can dispute in writing with the card issuer. Written notice must reach " +
      "them within 60 days of the statement that carried the charge" +
      (deadlineAt === null ? "." : ` — by ${deadlineAt}.`) +
      " The issuer must acknowledge within 30 days and resolve within two billing cycles, " +
      "and no later than 90 days.",
  };
}

/**
 * Build the dispute message.
 *
 * Every amount comes from the breakdown. Nothing is recomputed here, so the
 * text and the math cannot drift apart.
 */
export function buildClaimDraft(input: ClaimInput): ClaimDraft {
  if (input.missingLines.length === 0) {
    throw new ShortedDataError(
      "refusing to draft a claim with nothing missing",
      "CLAIM_NOTHING_MISSING",
    );
  }
  if (input.merchantName.trim() === "") {
    throw new ShortedDataError("claim needs a merchant name", "CLAIM_NO_MERCHANT");
  }

  const selected = input.breakdown.components.filter((component, index) =>
    input.isSelected(component, index),
  );
  const askCents = selected.reduce((sum, component) => sum + component.cents, 0);
  if (askCents <= 0) {
    throw new ShortedDataError(
      "refusing to draft a claim that asks for nothing",
      "CLAIM_ZERO_ASK",
    );
  }

  const orderDate = isoDate(input.orderedAt);
  const amountsCents: number[] = [];

  const missingBlock = input.missingLines
    .map((line) => {
      const lineCents = line.quantity * line.unitPriceCents;
      amountsCents.push(lineCents);
      return `- ${line.quantity} x ${line.name} — ${formatCents(lineCents)}`;
    })
    .join("\n");

  const chargeBlock = selected
    .filter((component) => component.cents > 0)
    .map((component) => {
      amountsCents.push(component.cents);
      return `- ${component.label}: ${formatCents(component.cents)}`;
    })
    .join("\n");

  amountsCents.push(askCents);

  const evidence =
    input.photoCount > 0
      ? `\nI photographed everything that arrived (${input.photoCount} photo${
          input.photoCount === 1 ? "" : "s"
        }) and can send the images.`
      : "";

  // No accusation, no claim about DoorDash's policy, no predicted outcome —
  // just the item, the arithmetic, and the ask (RESPONSES.md R4).
  const body =
    `My order from ${input.merchantName} on ${orderDate} arrived with items missing.\n\n` +
    `Missing:\n${missingBlock}\n\n` +
    `I was charged for those items and for their share of the fees and tax on this order:\n` +
    `${chargeBlock}\n\n` +
    `I am requesting ${formatCents(askCents)}.${evidence}\n`;

  const disclaimers: string[] = [];
  const taxComponent = selected.find((component) => component.kind === "tax");
  if (input.breakdown.taxBasisIsAssumed && taxComponent !== undefined && taxComponent.cents > 0) {
    disclaimers.push(
      "The tax figure assumes every item on this order was taxable. If the order mixed " +
        "prepared food with non-taxable groceries, correct it before sending.",
    );
  }
  if (input.breakdown.orderDiscountCents > 0) {
    disclaimers.push(
      `This order carried a ${formatCents(
        input.breakdown.orderDiscountCents,
      )} order-level discount. The missing items are claimed at their discounted value ` +
        `(${formatCents(input.breakdown.missingNetCents)}), not their menu price.`,
    );
  }
  const unknownFees = input.breakdown.components.filter(
    (component) => component.excludedReason === "unrecognised_fee_label",
  );
  if (unknownFees.length > 0) {
    disclaimers.push(
      `Not included, because we could not classify the fee: ${unknownFees
        .map((component) => component.label)
        .join(", ")}.`,
    );
  }
  // Never let the UI imply this will be paid. Denial is a sanctioned outcome
  // and issued credits expire (refund-policy.md §2).
  disclaimers.push(
    "This is a request, not an outcome. Refunds are issued at DoorDash's discretion, and " +
      "account credits expire — track the date if you are issued one.",
  );

  return {
    subject: `Missing items — ${input.merchantName} order, ${orderDate}`,
    body,
    askCents,
    amountsCents,
    escalation: escalationFor(input.funding, input.statementTransmittedAt),
    disclaimers,
  };
}

/**
 * Every distinct money amount appearing in a piece of text, in cents.
 *
 * Used to prove a model-rewritten draft did not change a number. Deliberately
 * strict about what counts as an amount: anything it cannot read exactly is a
 * mismatch, which fails the check rather than passing it quietly.
 */
export function extractAmountsCents(text: string): number[] {
  const found = text.match(/\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\$\d+(?:\.\d{2})?/g) ?? [];
  return found.map((raw) => {
    const digits = raw.replace(/[$,]/g, "");
    const [whole = "0", fraction = "00"] = digits.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  });
}
