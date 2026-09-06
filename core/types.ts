/**
 * Shorted — shared domain types.
 *
 * PURE. No React, no network, no Supabase, no Anthropic. See PROMPT.md §4.
 *
 * Money is integer cents everywhere. `z.number().int()` is the enforcement point:
 * a float that reaches a money field is a parse failure, not a rounding problem.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ money */

/** Integer cents. Never a float, never a string, never a Number with a decimal. */
export const CentsSchema = z
  .number()
  .int("money must be integer cents — a float reached a money field")
  .finite();

/** Cents that cannot be negative (subtotals, fees, tax, totals). */
export const NonNegativeCentsSchema = CentsSchema.min(0, "money cannot be negative");

/* ---------------------------------------------------------------- sources */

/**
 * The only ways a row may enter the database. Mirrors the CHECK constraint in
 * supabase/migrations/0001_init.sql. There is deliberately no 'seed'. PROMPT.md §2.
 */
export const IngestSourceSchema = z.enum(["gmail", "photo", "manual_entry"]);
export type IngestSource = z.infer<typeof IngestSourceSchema>;

export const DiscrepancyKindSchema = z.enum([
  "missing",
  "wrong_item",
  "modifier_ignored",
  "damaged",
]);
export type DiscrepancyKind = z.infer<typeof DiscrepancyKindSchema>;

/* ------------------------------------------------------------------ items */

export const OrderItemSchema = z.object({
  /** Verbatim from the receipt. Never normalized on write — normalize at compare time. */
  name: z.string().min(1),
  quantity: z.number().int().min(1),
  unitPriceCents: NonNegativeCentsSchema,
  /** Receipt modifier lines ("no onions", "add bacon"), verbatim, in receipt order. */
  modifiers: z.array(z.string()).default([]),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

/**
 * What the vision model claims arrived. Distinct type from OrderItem on purpose:
 * a detection has no price and carries confidence. PROMPT.md §3.4.
 */
export const DetectedItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().min(1),
  confidence: z.number().min(0).max(1),
  /** Which delivered-food photo this came from. */
  photoPath: z.string().min(1),
});
export type DetectedItem = z.infer<typeof DetectedItemSchema>;

/* ---------------------------------------------------------------- receipt */

/**
 * A parsed receipt. Every field is required: PROMPT.md §2 forbids defaulting a
 * missing money line to 0. If the parser cannot find the tip line, it fails —
 * it does not emit `tipCents: 0`, because "no tip" and "unparsed" are different
 * facts and only one of them is safe to compute a refund from.
 */
export const ParsedReceiptSchema = z
  .object({
    source: IngestSourceSchema,
    orderedAt: z.string().datetime({ offset: true }),
    merchantName: z.string().min(1),
    merchantAddr: z.string().min(1).nullable(),
    subtotalCents: NonNegativeCentsSchema,
    feesCents: NonNegativeCentsSchema,
    taxCents: NonNegativeCentsSchema,
    tipCents: NonNegativeCentsSchema,
    totalCents: NonNegativeCentsSchema,
    items: z.array(OrderItemSchema).min(1, "a receipt with no line items is a parse failure"),
    /** Object-storage key of the raw, unmodified artifact. Always present. PROMPT.md §3.2. */
    rawArtifactPath: z.string().min(1),
    parserVersion: z.string().min(1),
  })
  .strict();
export type ParsedReceipt = z.infer<typeof ParsedReceiptSchema>;

/* ------------------------------------------------------------------ error */

/**
 * Thrown by core/ when input is not trustworthy enough to compute on.
 * Callers surface this to the user. Nothing in core/ ever returns a fallback value.
 */
export class ShortedDataError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShortedDataError";
  }
}
