/**
 * Shorted — Supabase Postgres access. PROMPT.md §4.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: application code talks to the database
 * as the signed-in user, under RLS. The service-role key bypasses RLS entirely,
 * so a service-role client turns every `user_id` parameter into a trusted input
 * and every RLS policy in supabase/migrations/ into decoration.
 *
 * Two ways in, and they do not look alike on purpose:
 *
 *   userDb(ctx)      — anon key + the caller's JWT. Postgres enforces auth.uid().
 *                      A bug that passes the wrong user_id fails at the database
 *                      instead of writing to someone else's account. Default.
 *
 *   adminDb(reason)  — service role. Bypasses RLS. Every call site must state a
 *                      reason, and the reason must be one of an enumerated set,
 *                      so "who can read every user's receipts" is answerable by
 *                      grepping for one identifier.
 *
 * Errors from Supabase are never re-thrown verbatim: a Postgres or PostgREST
 * error message can echo back row contents and, on an auth failure, the token it
 * was given. Everything goes through services/secrets.ts first.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { safeMessage } from "./secrets.js";
import { ShortedDataError, type DetectedItem, type IngestSource, type OrderItem } from "../core/types.js";
import { receiptBalanceDeltaCents, type ReceiptTotals } from "../core/money.js";
import { LIMITS, assertPlausibleReceiptAmount, boundedUntrustedName } from "../core/untrusted.js";

/* --------------------------------------------------------------- context */

/**
 * A request acting on behalf of a signed-in user.
 *
 * `accessToken` is the Supabase JWT from the user's session. It is what makes
 * auth.uid() resolve inside Postgres; `userId` is carried alongside only so
 * application code can build queries, and it is checked against the token's
 * subject before any query runs.
 */
export interface UserContext {
  userId: string;
  accessToken: string;
}

/**
 * The only reasons the service-role key may be used. Adding a member here is the
 * change a reviewer should stop on: it widens the set of code that can read and
 * write across every user in the system.
 */
export type ServiceReason =
  /** Background Gmail ingestion runs with no user session attached to the request. */
  | "gmail_ingest_worker"
  /** Creating and verifying storage buckets during setup. */
  | "storage_provisioning";

export interface ServiceContext {
  kind: "service";
  reason: ServiceReason;
  /** Still required. RLS is off for this client, so the filter must be explicit. */
  userId: string;
}

export type DbContext = UserContext | ServiceContext;

export function isServiceContext(ctx: DbContext): ctx is ServiceContext {
  return (ctx as ServiceContext).kind === "service";
}

/* ---------------------------------------------------------------- clients */

/**
 * Per-token clients, bounded.
 *
 * Unbounded caching keyed by JWT is a memory leak with a user-controlled key:
 * every distinct token any caller ever presents would pin a client forever. The
 * cache is capped and evicts oldest-first, so steady-state memory is a function
 * of the cap, not of traffic.
 */
const MAX_CACHED_USER_CLIENTS = 32;
const userClients = new Map<string, SupabaseClient>();

let serviceClient: SupabaseClient | null = null;

/** Decodes a JWT payload without verifying it. Postgres does the verification. */
function jwtSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Client scoped to one user's session. Every statement it issues runs with
 * auth.uid() set, so RLS applies.
 *
 * The subject check is belt and braces — Postgres would reject a mismatched
 * write anyway — but it turns a silent empty result set into a loud error, which
 * is the difference between finding this bug in development and shipping it.
 */
export function userDb(ctx: UserContext): SupabaseClient {
  const subject = jwtSubject(ctx.accessToken);
  if (subject === null) {
    throw new ShortedDataError("access token is not a readable JWT", "AUTH_BAD_TOKEN");
  }
  if (subject !== ctx.userId) {
    throw new ShortedDataError(
      "access token subject does not match the requested user id",
      "AUTH_SUBJECT_MISMATCH",
    );
  }

  // Key on a hash, never the token: this Map is reachable from a heap dump.
  const key = createHash("sha256").update(ctx.accessToken).digest("hex");
  const cached = userClients.get(key);
  if (cached !== undefined) {
    // Refresh recency for the eviction order.
    userClients.delete(key);
    userClients.set(key, cached);
    return cached;
  }

  const client = createClient(config.supabaseUrl(), config.supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
  });

  if (userClients.size >= MAX_CACHED_USER_CLIENTS) {
    const oldest = userClients.keys().next();
    if (!oldest.done) userClients.delete(oldest.value);
  }
  userClients.set(key, client);
  return client;
}

/**
 * Service-role client. BYPASSES RLS — it can read and write every user's rows.
 *
 * `reason` is not logging garnish: it is the enumerated allowlist of situations
 * in which this is permitted, and it is what a reviewer greps for.
 */
export function adminDb(reason: ServiceReason): SupabaseClient {
  void reason;
  serviceClient ??= createClient(config.supabaseUrl(), config.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return serviceClient;
}

/** Resolves whichever client a context implies. */
export function dbFor(ctx: DbContext): SupabaseClient {
  return isServiceContext(ctx) ? adminDb(ctx.reason) : userDb(ctx);
}

/** Test seam. Drops cached clients so a test can swap credentials. */
export function __resetClientsForTest(): void {
  userClients.clear();
  serviceClient = null;
}

/* ----------------------------------------------------------- ownership --- */

/**
 * Confirms the context's user owns an order.
 *
 * Under a user context RLS already guarantees this and the query simply returns
 * nothing for someone else's order. Under a service context RLS does NOT, and
 * this explicit check is the only thing standing between a wrong `orderId` and a
 * cross-tenant write. Called on every path that takes an order id from outside.
 */
export async function assertOwnsOrder(ctx: DbContext, orderId: string): Promise<void> {
  if (!isUuid(orderId)) {
    throw new ShortedDataError(`malformed order id`, "DB_BAD_ORDER_ID");
  }
  const { data, error } = await dbFor(ctx)
    .from("orders")
    .select("id")
    .eq("id", orderId)
    .eq("user_id", ctx.userId)
    .maybeSingle();

  if (error) throw safeMessage("order ownership check failed", error.message);
  if (data === null) {
    // Deliberately does not distinguish "does not exist" from "belongs to
    // someone else": the difference is an enumeration oracle.
    throw new ShortedDataError(`order not found`, "DB_ORDER_NOT_FOUND", { orderId });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function assertUserId(userId: string): void {
  if (!isUuid(userId)) {
    throw new ShortedDataError("user id must be a uuid", "DB_BAD_USER_ID");
  }
}

/* ------------------------------------------------------------- orders ---- */

export interface InsertOrderInput {
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
 * Inserts an order and its items ATOMICALLY, via the `insert_order_with_items`
 * function in migration 0003.
 *
 * The previous two-statement version could leave an order row with zero items
 * when the second insert failed. That is not a cosmetic inconsistency: core/
 * money.ts allocates fees against the subtotal of the items it can see, so an
 * order missing its lines produces a *smaller* refund figure that still looks
 * entirely reasonable. A wrong number nobody can spot is the failure mode §2
 * exists to prevent, so the two writes now commit or roll back together.
 *
 * `user_id` is not a parameter. The SQL function reads auth.uid() itself, so
 * there is no argument a caller could get wrong.
 */
export async function insertOrder(ctx: UserContext, input: InsertOrderInput): Promise<string> {
  assertUserId(ctx.userId);

  if (input.items.length === 0) {
    throw new ShortedDataError("an order with no line items is a parse failure", "DB_NO_ITEMS");
  }
  if (input.items.length > LIMITS.maxItemsPerReceipt) {
    throw new ShortedDataError(
      `receipt has ${input.items.length} line items, over the ${LIMITS.maxItemsPerReceipt} limit`,
      "DB_TOO_MANY_ITEMS",
    );
  }

  // Bounds on every value that came from a model reading untrusted pixels,
  // applied at the last moment before it becomes a durable row.
  assertPlausibleReceiptAmount("subtotalCents", input.totals.subtotalCents);
  assertPlausibleReceiptAmount("feesCents", input.totals.feesCents);
  assertPlausibleReceiptAmount("taxCents", input.totals.taxCents);
  assertPlausibleReceiptAmount("tipCents", input.totals.tipCents);
  assertPlausibleReceiptAmount("totalCents", input.totals.totalCents);

  const { data, error } = await userDb(ctx).rpc("insert_order_with_items", {
    p_source: input.source,
    p_ordered_at: input.orderedAt,
    p_merchant_name: boundedUntrustedName("merchantName", input.merchantName),
    p_merchant_addr:
      input.merchantAddr === null ? null : boundedUntrustedName("merchantAddr", input.merchantAddr),
    p_subtotal_cents: input.totals.subtotalCents,
    p_fees_cents: input.totals.feesCents,
    p_tax_cents: input.totals.taxCents,
    p_tip_cents: input.totals.tipCents,
    p_total_cents: input.totals.totalCents,
    p_raw_artifact_path: input.rawArtifactPath,
    p_parser_version: input.parserVersion,
    p_balance_delta_cents: receiptBalanceDeltaCents(input.totals),
    p_items: input.items.map((item, lineIndex) => ({
      name: boundedUntrustedName(`items[${lineIndex}].name`, item.name),
      quantity: item.quantity,
      unit_price_cents: assertPlausibleReceiptAmount(
        `items[${lineIndex}].unitPriceCents`,
        item.unitPriceCents,
      ),
      modifiers: item.modifiers.map((m, j) =>
        boundedUntrustedName(`items[${lineIndex}].modifiers[${j}]`, m),
      ),
      line_index: lineIndex,
    })),
  });

  if (error) throw safeMessage("insertOrder failed", error.message);
  if (typeof data !== "string") {
    throw new ShortedDataError("insert_order_with_items returned no id", "DB_NO_ORDER_ID");
  }
  return data;
}

/* -------------------------------------------------------- model calls ---- */

export interface RecordModelCallInput {
  orderId: string | null;
  kind: "receipt_ocr" | "food_detection" | "claim_text";
  modelId: string;
  promptVersion: string;
  inputHash: string;
  latencyMs: number;
  /** Exactly one of these. A failed call is recorded as a failure, never as an empty success. */
  output?: unknown;
  /** Must already be redacted — pass redactedMessage(err), never err.message. */
  error?: string;
}

/**
 * Append-only model call log. This is how accuracy is measured after the fact (§6).
 *
 * The RLS policy in migration 0003 grants INSERT and SELECT only: a user can add
 * to their own audit trail and read it, and cannot edit or delete it. An audit
 * log the audited party can rewrite is not an audit log.
 */
export async function recordModelCall(
  ctx: UserContext,
  input: RecordModelCallInput,
): Promise<void> {
  assertUserId(ctx.userId);

  const { error } = await userDb(ctx).from("model_calls").insert({
    user_id: ctx.userId,
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
  if (error) throw safeMessage("recordModelCall failed", error.message);
}

/* ------------------------------------------------------ discrepancies ---- */

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

/**
 * Writes a confirmed discrepancy.
 *
 * `orderId` arrives from a client and is the one field that decides which
 * account this row lands in, so ownership is proven before the insert rather
 * than left to a policy nobody has run yet. Under a user context RLS would also
 * reject it; the explicit check makes the failure legible and covers the day
 * someone adds a service-context caller.
 */
export async function insertDiscrepancy(
  ctx: UserContext,
  input: InsertDiscrepancyInput,
): Promise<string> {
  assertUserId(ctx.userId);
  await assertOwnsOrder(ctx, input.orderId);

  if (input.photoPaths.length === 0) {
    throw new ShortedDataError("a discrepancy needs at least one photo", "DB_NO_PHOTOS");
  }
  assertPlausibleReceiptAmount("owedCents", input.owedCents);
  assertPlausibleReceiptAmount("owedTipShareCents", input.owedTipShareCents);

  const { data, error } = await userDb(ctx)
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

  if (error) throw safeMessage("insertDiscrepancy failed", error.message);
  return (data as { id: string }).id;
}
