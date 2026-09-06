/**
 * Shorted — deterministic parsing of money strings. PURE.
 *
 * The vision model reads the characters printed on the receipt and returns them
 * verbatim ("$12.34"). It never returns a cents integer. Converting text to
 * money is arithmetic, and arithmetic belongs in code that can be unit tested,
 * not in a model that can quietly be off by a factor of ten.
 */
import { ShortedDataError } from "./types.js";

/**
 * Commas are only ever thousands separators, in groups of three. A decimal
 * comma ("12,34" — a European format, or an OCR slip on "12.34") is REJECTED,
 * not stripped: stripping it turns $12.34 into $1234.00 inside a refund claim.
 */
const MONEY_TEXT = /^-?(\d{1,3}(,\d{3})*|\d{1,12})(\.\d{1,2})?$/;

/**
 * "$12.34" -> 1234. "(1.50)" and "-1.50" -> -150.
 *
 * Throws on anything it does not fully recognise. There is no lenient mode and
 * no fallback to 0: an unparseable total must reach the user as an error, not
 * as a number that happens to be wrong (PROMPT.md §2).
 */
export function parseMoneyToCents(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ShortedDataError("empty money string", "PARSE_MONEY_EMPTY", { raw });
  }

  // Accounting-style negatives: (1.50)
  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  const body = parenthesised?.[1] ?? trimmed;

  const cleaned = body.replace(/[$\s]/g, "");

  if (!MONEY_TEXT.test(cleaned)) {
    throw new ShortedDataError(
      `not a recognisable money amount: ${JSON.stringify(raw)}`,
      "PARSE_MONEY_UNRECOGNISED",
      { raw },
    );
  }

  const negative = parenthesised !== null || cleaned.startsWith("-");
  const digits = cleaned.replace(/^-/, "").replace(/,/g, "");
  const [whole = "0", fraction = ""] = digits.split(".");

  // String arithmetic, not parseFloat: 0.1 + 0.2 has no place near a refund.
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new ShortedDataError("money amount out of range", "PARSE_MONEY_RANGE", { raw });
  }

  return negative ? -cents : cents;
}

/** Same, but rejects negatives — for subtotals, fees, tax, tips and totals. */
export function parseNonNegativeMoneyToCents(raw: string): number {
  const cents = parseMoneyToCents(raw);
  if (cents < 0) {
    throw new ShortedDataError(
      `expected a non-negative amount, got ${JSON.stringify(raw)}`,
      "PARSE_MONEY_NEGATIVE",
      { raw },
    );
  }
  return cents;
}
