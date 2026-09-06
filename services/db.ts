/**
 * Shorted — Supabase Postgres client and the only writers for orders/items/
 * discrepancies/model_calls. PROMPT.md §4.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import type { DetectedItem, IngestSource, OrderItem } from "../core/types.js";
import { receiptBalanceDeltaCents, type ReceiptTotals } from "../core/money.js";

let client: SupabaseClient | null = null;

/** Service-role client. Server-side only — it bypasses RLS. */
export function db(): SupabaseClient {
  client ??= createClient(config.supabaseUrl(), config.supabaseServiceRoleKey(), {
    auth: { persistSession: false },
  });
  return client;
}

export interface InsertOrderInput {
  userId: string;
  source: IngestSource;
  orderedAt: string;
  merchantName: string;
  merchantAddr: string | null;
  totals: ReceiptTotals;
  items: OrderItem[];
  /** Storage key of the raw artifact. Must already be uploaded — see §3.2. */
  rawArtifactPath: string;
  parserVersion: string;
}

/**
 * Inserts an order and its items.
 *
 * `source` has no 'seed' value in the database and none is accepted here, so
 * there is no code path that writes an order which did not come from a real
 * ingestion (§2). The raw artifact must be stored BEFORE this is called.
 */
export async function insertOrder(input: InsertOrderInput): Promise<string> {
  const { data, error } = await db()
    .from("orders")
    .insert({
      user_id: input.userId,
      source: input.source,
      ordered_at: input.orderedAt,
      merchant_name: input.merchantName,
      merchant_addr: input.merchantAddr,
      subtotal_cents: input.totals.subtotalCents,
      fees_cents: input.totals.feesCents,
      tax_cents: input.totals.taxCents,
      tip_cents: input.totals.tipCents,
      total_cents: input.totals.totalCents,
      raw_artifact_path: input.rawArtifactPath,
      parser_version: input.parserVersion,
      balance_delta_cents: receiptBalanceDeltaCents(input.totals),
    })
    .select("id")
    .single();

  if (error) throw new Error(`insertOrder failed: ${error.message}`);
  const orderId = (data as { id: string }).id;

  const { error: itemsError } = await db().from("order_items").insert(
    input.items.map((item, lineIndex) => ({
      order_id: orderId,
      name: item.name,
      quantity: item.quantity,
      unit_price_cents: item.unitPriceCents,
      modifiers: item.modifiers,
      line_index: lineIndex,
    })),
  );
  if (itemsError) {
    // The order row is left in place deliberately: it points at a real raw
    // artifact that exists in storage. A half-written order is visible and
    // fixable; a deleted one loses the pointer to the artifact.
    throw new Error(`insertOrder items failed for ${orderId}: ${itemsError.message}`);
  }

  return orderId;
}

export interface RecordModelCallInput {
  userId: string;
  orderId: string | null;
  kind: "receipt_ocr" | "food_detection" | "claim_text";
  modelId: string;
  promptVersion: string;
  inputHash: string;
  latencyMs: number;
  /** Exactly one of these. A failed call is recorded as a failure, never as an empty success. */
  output?: unknown;
  error?: string;
}

/** Append-only model call log. This is how accuracy is measured after the fact (§6). */
export async function recordModelCall(input: RecordModelCallInput): Promise<void> {
  const { error } = await db().from("model_calls").insert({
    user_id: input.userId,
    order_id: input.orderId,
    kind: input.kind,
    model_id: input.modelId,
    prompt_version: input.promptVersion,
    input_hash: input.inputHash,
    latency_ms: input.latencyMs,
    output: input.output ?? null,
    error: input.error ?? null,
  });
  // Logging failure must not be swallowed: an unlogged call is an accuracy
  // measurement we can never reconstruct.
  if (error) throw new Error(`recordModelCall failed: ${error.message}`);
}

export interface InsertDiscrepancyInput {
  orderId: string;
  kind: "missing" | "wrong_item" | "modifier_ignored" | "damaged";
  /** What the model said. Immutable once written. */
  detectedItems: DetectedItem[];
  /** What the human said after looking at the food. Ground truth. */
  confirmedItems: unknown[];
  owedCents: number;
  owedTipShareCents: number;
  photoPaths: string[];
}

export async function insertDiscrepancy(input: InsertDiscrepancyInput): Promise<string> {
  const { data, error } = await db()
    .from("discrepancies")
    .insert({
      order_id: input.orderId,
      kind: input.kind,
      detected_items: input.detectedItems,
      confirmed_items: input.confirmedItems,
      owed_cents: input.owedCents,
      owed_tip_share_cents: input.owedTipShareCents,
      photo_paths: input.photoPaths,
    })
    .select("id")
    .single();

  if (error) throw new Error(`insertDiscrepancy failed: ${error.message}`);
  return (data as { id: string }).id;
}
