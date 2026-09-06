/**
 * Shorted — Claude vision. Receipt OCR and delivered-food detection.
 *
 * Two separate calls with two separate prompts, deliberately (PROMPT.md §6).
 * Combining them lets the receipt bias the detection, which is exactly the
 * failure we cannot afford: a model that has read "2x drink" is more likely to
 * report seeing two drinks.
 *
 * Everything the model returns is validated with zod before it goes anywhere.
 * Malformed output is an error, never coerced.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODELS, PROMPT_VERSIONS, config } from "./config.js";
import { recordModelCall } from "./db.js";
import { sha256 } from "./storage.js";
import { parseNonNegativeMoneyToCents } from "../core/parse.js";
import { ShortedDataError, type DetectedItem, type OrderItem } from "../core/types.js";

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey() });
  return anthropic;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface CallContext {
  userId: string;
  orderId: string | null;
}

/* ------------------------------------------------------------ receipt OCR */

/**
 * The model reports the CHARACTERS IT SEES, as strings, and null for anything
 * it cannot read. It never computes and never infers: converting "$12.34" to
 * 1234 happens in core/parse.ts, where it is unit tested.
 *
 * null means "not legible in this image", which is a different fact from zero
 * and is surfaced to the user as such (§2).
 */
const ReceiptExtractionSchema = z.object({
  merchantName: z.string().nullable(),
  merchantAddress: z.string().nullable(),
  orderedAt: z.string().nullable().describe("ISO 8601 timestamp if a date and time are printed"),
  subtotalText: z.string().nullable().describe("Verbatim, e.g. '$24.98'"),
  feesText: z.array(z.object({ label: z.string(), amountText: z.string() }))
    .describe("Every fee line printed on the receipt, verbatim, separately"),
  taxText: z.string().nullable(),
  tipText: z.string().nullable(),
  totalText: z.string().nullable(),
  items: z.array(
    z.object({
      name: z.string(),
      quantityText: z.string().describe("Verbatim, e.g. '2' or '1'"),
      lineTotalText: z.string().nullable().describe("Price printed for this line, verbatim"),
      modifiers: z.array(z.string()),
    }),
  ),
  /** Names of fields the model could not read. Drives the error the user sees. */
  unreadable: z.array(z.string()),
});

export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;

const RECEIPT_OCR_PROMPT = `You are reading a DoorDash receipt.

Report ONLY what is printed. Rules:
- Copy amounts VERBATIM as they appear, including the currency symbol ("$12.34").
- Do NOT compute, sum, convert or reconcile anything. Another system does the math.
- If a value is not legible or not present, return null for it and name it in "unreadable".
- Never guess a price, a quantity, or an item name. A null is correct; a plausible
  invention is not.
- List every fee line separately with its printed label. Do not total them.
- Copy item names exactly as printed, including size and modifier text.`;

export async function extractReceipt(
  image: Buffer,
  mediaType: ImageMediaType,
  ctx: CallContext,
): Promise<ReceiptExtraction> {
  const started = Date.now();
  const inputHash = sha256(image);

  try {
    const response = await client().messages.parse({
      model: MODELS.receiptOcr,
      max_tokens: 16000,
      system: RECEIPT_OCR_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: image.toString("base64") },
            },
            { type: "text", text: "Read this receipt." },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(ReceiptExtractionSchema) },
    });

    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new ShortedDataError(
        "receipt OCR returned unparseable output",
        "VISION_OCR_MALFORMED",
      );
    }

    await recordModelCall({
      userId: ctx.userId,
      orderId: ctx.orderId,
      kind: "receipt_ocr",
      modelId: MODELS.receiptOcr,
      promptVersion: PROMPT_VERSIONS.receiptOcr,
      inputHash,
      latencyMs: Date.now() - started,
      output: parsed,
    });

    return parsed;
  } catch (err) {
    await recordModelCall({
      userId: ctx.userId,
      orderId: ctx.orderId,
      kind: "receipt_ocr",
      modelId: MODELS.receiptOcr,
      promptVersion: PROMPT_VERSIONS.receiptOcr,
      inputHash,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/* --------------------------------------------------- extraction -> domain */

export interface ReceiptFields {
  merchantName: string;
  merchantAddr: string | null;
  orderedAt: string;
  subtotalCents: number;
  feesCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  items: OrderItem[];
}

/**
 * Turns a raw extraction into domain values, or throws listing exactly which
 * fields are missing.
 *
 * There is no partial success here on purpose. A receipt missing its tax line
 * produces a wrong refund figure, and a wrong figure sent to support under the
 * user's name is worse than an error message (§2).
 */
export function toReceiptFields(extraction: ReceiptExtraction): ReceiptFields {
  const missing: string[] = [...extraction.unreadable];
  const need = <T>(label: string, value: T | null): T => {
    if (value === null) {
      missing.push(label);
      return undefined as unknown as T;
    }
    return value;
  };

  const merchantName = need("merchantName", extraction.merchantName);
  const orderedAt = need("orderedAt", extraction.orderedAt);
  const subtotalText = need("subtotal", extraction.subtotalText);
  const taxText = need("tax", extraction.taxText);
  const tipText = need("tip", extraction.tipText);
  const totalText = need("total", extraction.totalText);

  if (extraction.items.length === 0) missing.push("items");
  extraction.items.forEach((item, i) => {
    if (item.lineTotalText === null) missing.push(`items[${i}].price`);
  });

  if (missing.length > 0) {
    throw new ShortedDataError(
      `receipt is not fully legible: ${missing.join(", ")}`,
      "VISION_RECEIPT_INCOMPLETE",
      { missing },
    );
  }

  const items: OrderItem[] = extraction.items.map((item, i) => {
    const quantity = Number.parseInt(item.quantityText.trim(), 10);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ShortedDataError(
        `unreadable quantity on line ${i}: ${JSON.stringify(item.quantityText)}`,
        "VISION_BAD_QUANTITY",
      );
    }
    const lineTotal = parseNonNegativeMoneyToCents(item.lineTotalText as string);
    if (lineTotal % quantity !== 0) {
      // DoorDash prints a line total, not a unit price. If it does not divide
      // evenly the receipt carries something we do not model yet (a per-unit
      // promo, a weighted grocery item). Surface it rather than round it.
      throw new ShortedDataError(
        `line ${i}: total ${item.lineTotalText} does not divide evenly by quantity ${quantity}`,
        "VISION_LINE_TOTAL_INDIVISIBLE",
        { line: i },
      );
    }
    return {
      name: item.name,
      quantity,
      unitPriceCents: lineTotal / quantity,
      modifiers: item.modifiers,
    };
  });

  return {
    merchantName,
    merchantAddr: extraction.merchantAddress,
    orderedAt,
    subtotalCents: parseNonNegativeMoneyToCents(subtotalText),
    // Every printed fee line, summed here rather than by the model.
    feesCents: extraction.feesText.reduce(
      (sum, fee) => sum + parseNonNegativeMoneyToCents(fee.amountText),
      0,
    ),
    taxCents: parseNonNegativeMoneyToCents(taxText),
    tipCents: parseNonNegativeMoneyToCents(tipText),
    totalCents: parseNonNegativeMoneyToCents(totalText),
    items,
  };
}

/* -------------------------------------------------------- food detection */

const DetectionSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().describe("What the container or food appears to be, in plain words"),
      quantity: z.number().int().min(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
  /** Set when containers are closed or stacked — the known accuracy killer (§6). */
  obstructed: z.boolean().describe("true if bags or closed containers hide contents"),
  notes: z.string().nullable(),
});

const FOOD_DETECTION_PROMPT = `You are looking at photographs of food that was delivered.

You have NOT been shown the receipt and you must not guess what was ordered.
Report only what is visibly present in the photographs.

Rules:
- Describe each distinct item or container you can see, with a count.
- Do not infer contents you cannot see. A closed bag is not evidence of its contents.
- If containers are closed, stacked, or bagged, set "obstructed" to true.
- Confidence is your honest read: below 0.5 means "I think I see this but I am unsure".
- Do not name a restaurant, a menu, or a dish you are inferring rather than seeing.`;

export async function detectDeliveredItems(
  images: { data: Buffer; mediaType: ImageMediaType; photoPath: string }[],
  ctx: CallContext,
): Promise<{ items: DetectedItem[]; obstructed: boolean; notes: string | null }> {
  if (images.length === 0) {
    throw new ShortedDataError("no delivered-food photos supplied", "VISION_NO_PHOTOS");
  }

  const started = Date.now();
  const inputHash = sha256(Buffer.concat(images.map((i) => i.data)));

  try {
    const response = await client().messages.parse({
      model: MODELS.foodDetection,
      max_tokens: 16000,
      system: FOOD_DETECTION_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...images.map((img) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: img.mediaType,
                data: img.data.toString("base64"),
              },
            })),
            { type: "text" as const, text: "What is visibly present in these photos?" },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(DetectionSchema) },
    });

    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new ShortedDataError("detection returned unparseable output", "VISION_DETECT_MALFORMED");
    }

    await recordModelCall({
      userId: ctx.userId,
      orderId: ctx.orderId,
      kind: "food_detection",
      modelId: MODELS.foodDetection,
      promptVersion: PROMPT_VERSIONS.foodDetection,
      inputHash,
      latencyMs: Date.now() - started,
      output: parsed,
    });

    const firstPhoto = images[0]?.photoPath;
    if (firstPhoto === undefined) throw new ShortedDataError("no photo path", "VISION_NO_PHOTOS");

    return {
      // The model sees all photos at once, so a detection cannot currently be
      // attributed to a single photo. Attributing every detection to the first
      // photo would be a lie; per-photo attribution is a research request.
      items: parsed.items.map((item) => ({ ...item, photoPath: firstPhoto })),
      obstructed: parsed.obstructed,
      notes: parsed.notes,
    };
  } catch (err) {
    await recordModelCall({
      userId: ctx.userId,
      orderId: ctx.orderId,
      kind: "food_detection",
      modelId: MODELS.foodDetection,
      promptVersion: PROMPT_VERSIONS.foodDetection,
      inputHash,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
