/**
 * Loader for the hand-verified receipt corpus.
 *
 * research/corpus/ holds REAL receipts from REAL orders and is gitignored
 * forever (PROMPT.md §7). Nothing in this file invents a receipt, and nothing
 * here falls back to a built-in example when the corpus is empty — an empty
 * corpus is reported as an empty corpus.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { OrderItemSchema, NonNegativeCentsSchema, IngestSourceSchema } from "../core/types.js";

export const VERIFIED_DIR = join(process.cwd(), "research", "corpus", "verified");

/**
 * A real receipt plus refund cases whose expected values a human computed by
 * hand from the receipt itself. PROMPT.md §5: "Not generated cases. Real ones,
 * checked by hand."
 */
export const VerifiedFeeLineSchema = z.object({
  /** Printed label, verbatim. */
  label: z.string().min(1),
  cents: NonNegativeCentsSchema,
  /**
   * Hand-assigned kind. Recorded in the corpus file rather than derived by
   * core/fees.ts, so a classifier change shows up as a test failure instead of
   * silently rewriting the expected values.
   */
  kind: z.enum(["proportional", "per_delivery", "threshold", "passthrough", "unknown"]),
});

export const VerifiedReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    source: IngestSourceSchema,
    /** Who hand-checked the expected values, and when. Audit trail for the eval set. */
    verifiedBy: z.string().min(1),
    verifiedAt: z.string().datetime({ offset: true }),
    /** Which format class from receipt-formats.md this receipt covers. */
    formatClass: z.string().min(1),
    totals: z.object({
      subtotalCents: NonNegativeCentsSchema,
      feeLines: z.array(VerifiedFeeLineSchema),
      taxCents: NonNegativeCentsSchema,
      tipCents: NonNegativeCentsSchema,
      totalCents: NonNegativeCentsSchema,
      /** Present only when the receipt distinguishes taxable from non-taxable lines. */
      taxableBaseCents: NonNegativeCentsSchema.optional(),
    }),
    items: z.array(OrderItemSchema).min(1),
    cases: z
      .array(
        z.object({
          note: z.string().min(1),
          /** Indices into `items`, with how many units did not arrive. */
          missing: z
            .array(z.object({ itemIndex: z.number().int().min(0), quantity: z.number().int().min(1) }))
            .min(1),
          /** Hand-computed from the receipt. Every field, so a partial check cannot pass. */
          expected: z.object({
            missingGrossCents: NonNegativeCentsSchema,
            missingNetCents: NonNegativeCentsSchema,
            headlineCents: NonNegativeCentsSchema,
            withTipCents: NonNegativeCentsSchema,
            maximumCents: NonNegativeCentsSchema,
          }),
        }),
      )
      .min(1),
  })
  .strict();

export type VerifiedReceipt = z.infer<typeof VerifiedReceiptSchema>;

/** Loads every verified receipt. Throws on malformed input — never skips it silently. */
export function loadVerifiedCorpus(): VerifiedReceipt[] {
  if (!existsSync(VERIFIED_DIR)) return [];
  return readdirSync(VERIFIED_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(VERIFIED_DIR, f), "utf8")) as unknown;
      const parsed = VerifiedReceiptSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `research/corpus/verified/${f} is malformed — fix the file, do not loosen the schema:\n` +
            JSON.stringify(parsed.error.format(), null, 2),
        );
      }
      return parsed.data;
    });
}
