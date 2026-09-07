/**
 * Shorted — administrative surfaces, and the gate in front of them.
 *
 * Everything here reads across users. That is what makes it an admin board and
 * what makes it dangerous, so read this before adding to it.
 *
 * WHERE THE ENFORCEMENT ACTUALLY IS. Not in this file. Every admin view carries
 * `where public.is_admin()` (or `is_reviewer()`) in its own body, and
 * `user_roles` has no write grant for `authenticated` at all, so:
 *
 *   * a non-admin calling these functions gets an empty result from Postgres,
 *     not a filtered one from TypeScript;
 *   * a bug in this file cannot leak cross-user data, because the query it
 *     issues would still come back empty;
 *   * a user cannot grant themselves the role that would change that, because
 *     no statement their session can issue writes user_roles.
 *
 * The checks in this file exist for a different reason: to turn "you got zero
 * rows" into "you are not an admin", which is the difference between a board
 * that looks broken and a board that says why. They are UX, and they are
 * deliberately not the security boundary.
 */
import {
  isServiceContext,
  userDb,
  adminDb,
  type DbContext,
  type UserContext,
} from "./db.js";
import { safeMessage } from "./secrets.js";
import { ShortedDataError } from "../core/types.js";

export type AppRole = "admin" | "reviewer";

/** A user context that has been PROVEN to hold a role. Not constructible by hand. */
export interface PrivilegedContext extends UserContext {
  readonly roles: readonly AppRole[];
}

/* --------------------------------------------------------------- reading */

/**
 * Reads the caller's own role grants.
 *
 * Safe to call for anyone: the `user_roles_read_own` policy lets a user see
 * their own rows and nothing else, which is what an app needs to decide whether
 * to render an admin nav item. Seeing the row grants nothing.
 */
export async function rolesOf(ctx: UserContext): Promise<AppRole[]> {
  const { data, error } = await userDb(ctx)
    .from("user_roles")
    .select("role")
    .eq("user_id", ctx.userId);

  if (error) throw safeMessage("role lookup failed", error.message);
  return (data ?? []).map((row) => (row as { role: AppRole }).role);
}

export async function isAdmin(ctx: UserContext): Promise<boolean> {
  return (await rolesOf(ctx)).includes("admin");
}

/**
 * Proves the caller holds `required`, or throws.
 *
 * `admin` implies `reviewer` — an admin sees everything a reviewer sees. That
 * implication lives here AND in the SQL `is_reviewer()`; both say the same thing
 * so neither is load-bearing alone.
 */
export async function requireRole(
  ctx: UserContext,
  required: AppRole,
): Promise<PrivilegedContext> {
  if (isServiceContext(ctx as DbContext)) {
    throw new ShortedDataError(
      "requireRole needs a real user session — a service context has no role to check",
      "ADMIN_NO_USER_CONTEXT",
    );
  }

  const roles = await rolesOf(ctx);
  const satisfied = roles.includes(required) || roles.includes("admin");
  if (!satisfied) {
    // Says what is missing without saying who does have it, and without
    // confirming which boards exist.
    throw new ShortedDataError(
      `this action requires the ${required} role`,
      "ADMIN_FORBIDDEN",
      { required },
    );
  }
  return { ...ctx, roles };
}

/* ---------------------------------------------------------------- boards */

export interface ModelAccuracyRow {
  kind: string;
  model_id: string;
  prompt_version: string;
  calls: number;
  failures: number;
  failure_rate: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  distinct_users: number;
  first_call_at: string;
  last_call_at: string;
}

export interface MerchantShortageRow {
  merchant_name_key: string;
  merchant_addr_key: string;
  observed_orders: number;
  observed_users: number;
  orders_with_shortage: number;
  shortage_rate: number;
}

export interface IngestHealthRow {
  messages_total: number;
  messages_unparsed: number;
  messages_failed: number;
  users_with_mail: number;
  oldest_message_at: string | null;
  newest_message_at: string | null;
}

export interface CorpusCoverageRow {
  orders_total: number;
  users_total: number;
  orders_from_gmail: number;
  orders_from_photo: number;
  orders_manual: number;
  confirmed_discrepancies: number;
  orders_with_balance_drift: number;
}

/**
 * Model call health across every user. Reviewer or admin.
 *
 * This is the §6 accuracy number, and it is the reason model_calls is
 * append-only: an aggregate over a log the audited party could edit measures
 * nothing.
 */
export async function modelAccuracyBoard(ctx: UserContext): Promise<ModelAccuracyRow[]> {
  const privileged = await requireRole(ctx, "reviewer");
  const rows = await selectBoard<ModelAccuracyRow>(privileged, "admin_model_accuracy");
  await recordAdminAction(privileged, "read_model_accuracy", { rows: rows.length });
  return rows;
}

/**
 * Cross-user merchant shortage rates. Admin only.
 *
 * The n >= 20 orders and >= 5 distinct users gates are in the view, not here,
 * so no caller can render a rate off three observations by writing a different
 * query. docs/GAPS.md #12 called this out as needing a privacy review before it
 * existed; the review question it poses is now concrete rather than
 * hypothetical, and it is recorded in docs/SECURITY.md.
 */
export async function merchantShortageBoard(ctx: UserContext): Promise<MerchantShortageRow[]> {
  const privileged = await requireRole(ctx, "admin");
  const rows = await selectBoard<MerchantShortageRow>(privileged, "admin_merchant_shortage_index");
  await recordAdminAction(privileged, "read_merchant_shortage", { rows: rows.length });
  return rows;
}

/** Corpus size and parse backlog. Admin only — it counts each account's mail. */
export async function ingestHealthBoard(ctx: UserContext): Promise<IngestHealthRow | null> {
  const privileged = await requireRole(ctx, "admin");
  const rows = await selectBoard<IngestHealthRow>(privileged, "admin_ingest_health");
  await recordAdminAction(privileged, "read_ingest_health", {});
  return rows[0] ?? null;
}

/** Progress against the §3.1 real-order bootstrap target. Reviewer or admin. */
export async function corpusCoverageBoard(ctx: UserContext): Promise<CorpusCoverageRow | null> {
  const privileged = await requireRole(ctx, "reviewer");
  const rows = await selectBoard<CorpusCoverageRow>(privileged, "admin_corpus_coverage");
  await recordAdminAction(privileged, "read_corpus_coverage", {});
  return rows[0] ?? null;
}

async function selectBoard<T>(ctx: PrivilegedContext, view: string): Promise<T[]> {
  const { data, error } = await userDb(ctx).from(view).select("*");
  if (error) throw safeMessage(`${view} query failed`, error.message);
  return (data ?? []) as T[];
}

/* ----------------------------------------------------------- audit trail */

/**
 * Records that a privileged read happened.
 *
 * `detail` carries identifiers and counts only — never rows, never merchant
 * names, never anything from a receipt. An audit log that copies the data it is
 * auditing doubles the blast radius of reading it.
 */
export async function recordAdminAction(
  ctx: PrivilegedContext,
  action: string,
  detail: Record<string, string | number | boolean>,
): Promise<void> {
  const { error } = await userDb(ctx)
    .from("admin_audit_log")
    .insert({ actor_id: ctx.userId, action, detail });

  // Not swallowed. An unlogged privileged read is exactly the event the log
  // exists to capture, so failing to write it fails the read.
  if (error) throw safeMessage("admin audit write failed", error.message);
}

/* ------------------------------------------------------ role management */

/**
 * Grants a role.
 *
 * Service role ONLY, and that is not a stylistic choice: `user_roles` holds no
 * write grant for `authenticated` and a trigger rejects any write arriving with
 * a non-null auth.uid(). There is no user session, admin or otherwise, that can
 * call this successfully. Granting the first admin is an operator action.
 *
 * `grantedBy` is recorded so the chain of who-gave-whom-what is reconstructible.
 * Null means bootstrap.
 */
export async function grantRole(input: {
  userId: string;
  role: AppRole;
  reason: string;
  grantedBy: string | null;
}): Promise<void> {
  if (input.reason.trim() === "") {
    throw new ShortedDataError(
      "a role grant needs a stated reason — an unexplained grant cannot be audited",
      "ADMIN_NO_REASON",
    );
  }

  const { error } = await adminDb("role_administration").from("user_roles").insert({
    user_id: input.userId,
    role: input.role,
    reason: input.reason,
    granted_by: input.grantedBy,
  });
  if (error) throw safeMessage("grantRole failed", error.message);
}

/** Revokes a role. Same constraints as grantRole. */
export async function revokeRole(userId: string, role: AppRole): Promise<void> {
  const { error } = await adminDb("role_administration")
    .from("user_roles")
    .delete()
    .eq("user_id", userId)
    .eq("role", role);
  if (error) throw safeMessage("revokeRole failed", error.message);
}
