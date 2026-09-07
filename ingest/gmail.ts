/**
 * Shorted — DoorDash receipt ingestion from Gmail. PROMPT.md §3.2.
 *
 * This is the data unblock: it is how real receipts get into the system without
 * anyone having to photograph 30 of them by hand.
 *
 * Three rules shape everything here:
 *   1. Raw HTML is stored VERBATIM before any parsing. When the parser improves
 *      we re-run it over real historical mail instead of having lost the corpus.
 *   2. Only mail that passes the receipt filter is ever persisted. Non-receipt
 *      email is discarded before it touches storage, not after.
 *   3. The stored HTML is UNTRUSTED. Gmail's `from:` operator is a substring
 *      match, so `billing@doordash.com.attacker.net` satisfies
 *      `from:doordash.com`. Anyone who knows a user's email address can put
 *      bytes in this corpus. Those bytes are later fed to a parser and, in time,
 *      to a model whose output becomes a dollar figure — so the sender is
 *      verified in code, against the parsed From header, not left to the query.
 */
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { config, PROMPT_VERSIONS } from "../services/config.js";
import { dbFor, isServiceContext, type DbContext } from "../services/db.js";
import { safeMessage } from "../services/secrets.js";
import { putRawReceiptHtml } from "../services/storage.js";
import { decryptToken, encryptToken } from "../services/tokens.js";
import { LIMITS, assertWithinBytes, boundedUntrustedName } from "../core/untrusted.js";
import { ShortedDataError } from "../core/types.js";

/** Read-only. Ingestion never needs to modify, send, or delete anything. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

/**
 * The search that defines the corpus. Narrow on purpose: a broad query would pull
 * marketing mail into storage, and §3.2 forbids persisting anything that is not
 * a receipt.
 *
 * This is a PREFILTER, not a trust boundary. See TRUSTED_SENDER_DOMAINS.
 */
export const RECEIPT_QUERY =
  'from:doordash.com (subject:"order receipt" OR subject:"Your DoorDash order" OR subject:receipt)';

/**
 * The only domains a stored receipt may come from, checked against the actual
 * address in the From header rather than against Gmail's substring match.
 *
 * `doordash.com` matches `doordash.com` and `mail.doordash.com`; it does not
 * match `doordash.com.evil.net`, which is exactly the case RECEIPT_QUERY lets
 * through.
 */
export const TRUSTED_SENDER_DOMAINS = ["doordash.com"] as const;

/** Extracts the addr-spec from a From header: `DoorDash <no-reply@doordash.com>`. */
export function senderDomain(fromHeader: string): string | null {
  const angled = /<([^>]+)>/.exec(fromHeader);
  const address = (angled?.[1] ?? fromHeader).trim().toLowerCase();
  // The LAST @, so a display name cannot smuggle a domain past the check.
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).replace(/[>\s,;]+$/, "");
  return domain.length === 0 ? null : domain;
}

export function isTrustedSender(fromHeader: string | null): boolean {
  if (fromHeader === null) return false;
  const domain = senderDomain(fromHeader);
  if (domain === null) return false;
  return TRUSTED_SENDER_DOMAINS.some(
    (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
  );
}

export function oauthClient(refreshToken?: string) {
  const client = new google.auth.OAuth2(
    config.google.clientId(),
    config.google.clientSecret(),
    config.google.redirectUri(),
  );
  if (refreshToken !== undefined) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export function consentUrl(): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
  });
}

/* --------------------------------------------------------------- consent */

/**
 * Consent gate. Throws unless the user has an active, unrevoked consent row.
 * PROMPT.md §3.2: no silent inbox access, for anyone.
 */
export async function assertGmailConsent(ctx: DbContext): Promise<void> {
  const { data, error } = await dbFor(ctx)
    .from("gmail_ingest_consents")
    .select("id")
    .eq("user_id", ctx.userId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) throw safeMessage("consent lookup failed", error.message);
  if (data === null) {
    throw new ShortedDataError(
      "no active Gmail ingestion consent for this user",
      "GMAIL_NO_CONSENT",
    );
  }
}

/**
 * Stores a Google refresh token, encrypted, against an active consent row.
 *
 * The token never travels as a function argument through the rest of the system
 * and never touches argv. It is written here, once, at the end of the OAuth
 * exchange, and read back only inside ingestGmailReceipts().
 */
export async function storeRefreshToken(ctx: DbContext, refreshToken: string): Promise<void> {
  await assertGmailConsent(ctx);
  const { error } = await dbFor(ctx)
    .from("gmail_ingest_consents")
    .update({ refresh_token_encrypted: encryptToken(refreshToken, ctx.userId) })
    .eq("user_id", ctx.userId)
    .is("revoked_at", null);
  if (error) throw safeMessage("storing refresh token failed", error.message);
}

async function loadRefreshToken(ctx: DbContext): Promise<string> {
  const { data, error } = await dbFor(ctx)
    .from("gmail_ingest_consents")
    .select("refresh_token_encrypted")
    .eq("user_id", ctx.userId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) throw safeMessage("refresh token lookup failed", error.message);
  const encrypted = (data as { refresh_token_encrypted?: string | null } | null)
    ?.refresh_token_encrypted;
  if (typeof encrypted !== "string" || encrypted === "") {
    throw new ShortedDataError(
      "no stored Gmail refresh token for this user — complete the OAuth consent flow first",
      "GMAIL_NO_TOKEN",
    );
  }
  // aad is the user id, so a ciphertext copied into another user's row fails.
  return decryptToken(encrypted, ctx.userId);
}

/**
 * Revokes consent and destroys the stored token in the same statement.
 *
 * Revoking without deleting the token leaves a live inbox key in the database
 * with nothing but application logic between it and use.
 */
export async function revokeGmailConsent(ctx: DbContext): Promise<void> {
  const { error } = await dbFor(ctx)
    .from("gmail_ingest_consents")
    .update({ revoked_at: new Date().toISOString(), refresh_token_encrypted: null })
    .eq("user_id", ctx.userId)
    .is("revoked_at", null);
  if (error) throw safeMessage("revoking consent failed", error.message);
}

/* --------------------------------------------------------------- parsing */

/** Decodes Gmail's base64url body payload. */
function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Depth-first search for the text/html part. Returns null when there isn't one.
 *
 * Depth-capped: MIME parts nest arbitrarily and the SENDER chooses the nesting.
 * An unbounded recursive walk over attacker-authored structure is a stack
 * overflow that takes the ingest process with it.
 */
function findHtmlPart(part: gmail_v1.Schema$MessagePart | undefined, depth = 0): string | null {
  if (!part || depth > LIMITS.maxMimeDepth) return null;
  if (part.mimeType === "text/html" && part.body?.data) return decodeBody(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findHtmlPart(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function header(message: gmail_v1.Schema$Message, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = message.payload?.headers?.find((h) => h.name?.toLowerCase() === wanted);
  return found?.value ?? null;
}

export interface IngestResult {
  scanned: number;
  stored: number;
  alreadyPresent: number;
  /** Matched the query but had no HTML body — nothing was persisted for these. */
  skippedNoHtml: number;
  /**
   * Matched Gmail's substring `from:` but whose real sender domain is not
   * DoorDash. Nothing was persisted. A non-zero count here is a spoofing
   * attempt, not noise.
   */
  skippedUntrustedSender: number;
  /** Over the size limit. Rejected on `sizeEstimate`, before the body was fetched. */
  skippedTooLarge: number;
}

/**
 * Pulls receipt emails and stores their raw HTML. Does NOT parse: parsing is a
 * separate, re-runnable pass over stored artifacts.
 *
 * Idempotent — storage keys are content hashes and gmail_messages is unique on
 * (user_id, gmail_message_id), so re-running adds only what is new.
 *
 * The refresh token is loaded from the encrypted column, not passed in. There is
 * no signature here that can leak a token into a shell history or a `ps` listing.
 */
export async function ingestGmailReceipts(
  ctx: DbContext,
  options: { maxMessages?: number } = {},
): Promise<IngestResult> {
  await assertGmailConsent(ctx);

  const maxMessages = normaliseMax(options.maxMessages);
  const refreshToken = await loadRefreshToken(ctx);
  const gmail = google.gmail({ version: "v1", auth: oauthClient(refreshToken) });

  const result: IngestResult = {
    scanned: 0,
    stored: 0,
    alreadyPresent: 0,
    skippedNoHtml: 0,
    skippedUntrustedSender: 0,
    skippedTooLarge: 0,
  };
  let pageToken: string | undefined;

  while (result.scanned < maxMessages) {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: RECEIPT_QUERY,
      maxResults: Math.min(100, maxMessages - result.scanned),
      ...(pageToken === undefined ? {} : { pageToken }),
    });

    const ids = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) break;

    // One dedupe query per PAGE, not per message. The old shape issued a
    // round-trip for every message id; on a 500-message backfill that is 500
    // sequential queries whose entire purpose is a set-membership test.
    const seen = await alreadyIngested(ctx, ids);

    for (const id of ids) {
      result.scanned += 1;

      if (seen.has(id)) {
        result.alreadyPresent += 1;
        continue;
      }

      // Two-phase fetch. `format: "metadata"` returns headers and sizeEstimate
      // without the body, so a spoofed or oversized message is rejected for the
      // cost of a few headers. A single `format: "full"` fetch pulled the entire
      // MIME tree — every inline image and attachment, base64-expanded — into
      // memory BEFORE deciding whether the sender was even real.
      const meta = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });

      const from = header(meta.data, "From");
      if (!isTrustedSender(from)) {
        result.skippedUntrustedSender += 1;
        continue;
      }

      // sizeEstimate covers the whole message, attachments included. An HTML
      // body under the limit cannot live in a message already over it, so this
      // rejects the expensive cases without downloading them.
      if ((meta.data.sizeEstimate ?? 0) > LIMITS.maxMessageBytes) {
        result.skippedTooLarge += 1;
        continue;
      }

      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });

      const html = findHtmlPart(full.data.payload ?? undefined);
      if (html === null) {
        // Nothing is persisted for a message we cannot store as a real artifact.
        result.skippedNoHtml += 1;
        continue;
      }
      if (Buffer.byteLength(html, "utf8") > LIMITS.maxHtmlBytes) {
        result.skippedTooLarge += 1;
        continue;
      }

      const internalDate = full.data.internalDate ?? meta.data.internalDate;
      if (!internalDate) {
        throw new ShortedDataError(
          `message ${id} has no internalDate — refusing to invent a date`,
          "GMAIL_NO_DATE",
        );
      }

      const rawArtifactPath = await putRawReceiptHtml(ctx, html);

      const { error } = await dbFor(ctx)
        .from("gmail_messages")
        .insert({
          user_id: ctx.userId,
          gmail_message_id: id,
          internal_date: new Date(Number(internalDate)).toISOString(),
          // Attacker-controlled text that will be rendered in a list view.
          // Bounded and defanged on the way in.
          subject: boundedUntrustedName("subject", header(meta.data, "Subject") ?? "(no subject)"),
          sender: boundedUntrustedName("sender", from ?? "(unknown)"),
          raw_artifact_path: rawArtifactPath,
          // order_id stays null until a parser succeeds. A row here with no order
          // is a real receipt we have and cannot yet read — countable, re-runnable.
          order_id: null,
          parse_error: null,
        });
      if (error) throw safeMessage(`gmail_messages insert failed for ${id}`, error.message);

      result.stored += 1;
    }

    pageToken = list.data.nextPageToken ?? undefined;
    if (pageToken === undefined) break;
  }

  return result;
}

/** Set-membership test for a page of message ids, in one query. */
async function alreadyIngested(ctx: DbContext, ids: readonly string[]): Promise<Set<string>> {
  const { data, error } = await dbFor(ctx)
    .from("gmail_messages")
    .select("gmail_message_id")
    .eq("user_id", ctx.userId)
    .in("gmail_message_id", [...ids]);

  if (error) throw safeMessage("gmail dedupe lookup failed", error.message);
  return new Set((data ?? []).map((row) => (row as { gmail_message_id: string }).gmail_message_id));
}

/**
 * `Number(undefined)` is NaN and `0 < NaN` is false, so an unvalidated max made
 * the whole ingestion a silent no-op that reported success. Rejected explicitly.
 */
function normaliseMax(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 5000) {
    throw new ShortedDataError(
      `maxMessages must be an integer between 1 and 5000, got ${String(value)}`,
      "GMAIL_BAD_MAX",
    );
  }
  return value;
}

/* ------------------------------------------------------------- parsing ---- */

export const GMAIL_PARSER_VERSION = PROMPT_VERSIONS.gmailHtml;

/**
 * NOT IMPLEMENTED — deliberately, and this is the honest state of the work.
 *
 * Writing this parser requires knowing the actual DOM of a real DoorDash receipt
 * email: which table cell holds the subtotal, how modifier lines nest under an
 * item, what a promo line looks like, how a multi-merchant DoubleDash order is
 * laid out. I do not have a real receipt to look at, and PROMPT.md §9 is explicit
 * that guessing DoorDash's actual behaviour is a research task, not a comment.
 *
 * Guessing here would be worse than not shipping it: a parser written against an
 * imagined DOM would produce plausible-looking wrong numbers on real mail, and
 * those numbers would go into refund claims.
 *
 * SECURITY NOTE FOR WHOEVER WRITES IT. This input is attacker-authored (see the
 * file header). Whatever parses it must:
 *   * never evaluate the HTML — no jsdom with scripts enabled, no `eval`, no
 *     `innerHTML` into a live document, no remote resource fetching;
 *   * run every extracted string through boundedUntrustedName() and every amount
 *     through assertPlausibleReceiptAmount() from core/untrusted.ts;
 *   * fence the HTML with fenceUntrusted() if any of it is ever shown to a model.
 * The caps in LIMITS are already applied at ingestion, so this only ever sees a
 * body under LIMITS.maxHtmlBytes.
 *
 * Unblocked by: research/findings/receipt-formats.md marked READY FOR BUILD.
 * See research/findings/REQUESTS.md.
 *
 * Nothing is blocked in the meantime — ingestGmailReceipts() stores real raw HTML
 * today, and this pass re-runs over everything already collected.
 */
export function parseReceiptHtml(html: string): never {
  assertWithinBytes("receipt HTML", Buffer.byteLength(html, "utf8"), LIMITS.maxHtmlBytes);
  throw new ShortedDataError(
    "DoorDash receipt HTML parser is not implemented: it requires the real DOM " +
      "documented in research/findings/receipt-formats.md (READY FOR BUILD). " +
      "Raw HTML is already being stored, so this pass can be re-run over the " +
      "existing corpus once the format is characterised.",
    "GMAIL_PARSER_NOT_IMPLEMENTED",
  );
}

/** Re-exported so callers can assert the ingest ran under the escalated path knowingly. */
export { isServiceContext };
