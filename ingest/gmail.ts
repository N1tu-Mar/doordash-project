/**
 * Shorted — DoorDash receipt ingestion from Gmail. PROMPT.md §3.2.
 *
 * This is the data unblock: it is how real receipts get into the system without
 * anyone having to photograph 30 of them by hand.
 *
 * Two rules shape everything here:
 *   1. Raw HTML is stored VERBATIM before any parsing. When the parser improves
 *      we re-run it over real historical mail instead of having lost the corpus.
 *   2. Only mail that passes the receipt filter is ever persisted. Non-receipt
 *      email is discarded before it touches storage, not after.
 */
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { config, PROMPT_VERSIONS } from "../services/config.js";
import { db } from "../services/db.js";
import { putRawReceiptHtml } from "../services/storage.js";
import { ShortedDataError } from "../core/types.js";

/** Read-only. Ingestion never needs to modify, send, or delete anything. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

/**
 * The search that defines the corpus. Narrow on purpose: a broad query would pull
 * marketing mail into storage, and §3.2 forbids persisting anything that is not
 * a receipt.
 */
export const RECEIPT_QUERY =
  'from:doordash.com (subject:"order receipt" OR subject:"Your DoorDash order" OR subject:receipt)';

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

/**
 * Consent gate. Throws unless the user has an active, unrevoked consent row.
 * PROMPT.md §3.2: no silent inbox access, for anyone.
 */
export async function assertGmailConsent(userId: string): Promise<void> {
  const { data, error } = await db()
    .from("gmail_ingest_consents")
    .select("id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) throw new Error(`consent lookup failed: ${error.message}`);
  if (data === null) {
    throw new ShortedDataError(
      `no active Gmail ingestion consent for user ${userId}`,
      "GMAIL_NO_CONSENT",
    );
  }
}

/** Decodes Gmail's base64url body payload. */
function decodeBody(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Depth-first search for the text/html part. Returns null when there isn't one. */
function findHtmlPart(part: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/html" && part.body?.data) return decodeBody(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findHtmlPart(child);
    if (found !== null) return found;
  }
  return null;
}

function header(message: gmail_v1.Schema$Message, name: string): string | null {
  const found = message.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? null;
}

export interface IngestResult {
  scanned: number;
  stored: number;
  alreadyPresent: number;
  /** Messages that matched the query but had no HTML body — nothing was persisted for these. */
  skippedNoHtml: number;
}

/**
 * Pulls receipt emails and stores their raw HTML. Does NOT parse: parsing is a
 * separate, re-runnable pass over stored artifacts.
 *
 * Idempotent — storage keys are content hashes and gmail_messages is unique on
 * (user_id, gmail_message_id), so re-running adds only what is new.
 */
export async function ingestGmailReceipts(
  userId: string,
  refreshToken: string,
  options: { maxMessages?: number } = {},
): Promise<IngestResult> {
  await assertGmailConsent(userId);

  const gmail = google.gmail({ version: "v1", auth: oauthClient(refreshToken) });
  const maxMessages = options.maxMessages ?? 100;

  const result: IngestResult = { scanned: 0, stored: 0, alreadyPresent: 0, skippedNoHtml: 0 };
  let pageToken: string | undefined;

  while (result.scanned < maxMessages) {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: RECEIPT_QUERY,
      maxResults: Math.min(100, maxMessages - result.scanned),
      ...(pageToken === undefined ? {} : { pageToken }),
    });

    const messages = list.data.messages ?? [];
    if (messages.length === 0) break;

    for (const stub of messages) {
      if (!stub.id) continue;
      result.scanned += 1;

      const { data: existing } = await db()
        .from("gmail_messages")
        .select("id")
        .eq("user_id", userId)
        .eq("gmail_message_id", stub.id)
        .maybeSingle();
      if (existing !== null) {
        result.alreadyPresent += 1;
        continue;
      }

      const full = await gmail.users.messages.get({
        userId: "me",
        id: stub.id,
        format: "full",
      });

      const html = findHtmlPart(full.data.payload ?? undefined);
      if (html === null) {
        // Nothing is persisted for a message we cannot store as a real artifact.
        result.skippedNoHtml += 1;
        continue;
      }

      const rawArtifactPath = await putRawReceiptHtml(userId, html);

      const internalDate = full.data.internalDate;
      if (!internalDate) {
        throw new ShortedDataError(
          `message ${stub.id} has no internalDate — refusing to invent a date`,
          "GMAIL_NO_DATE",
        );
      }

      const { error } = await db().from("gmail_messages").insert({
        user_id: userId,
        gmail_message_id: stub.id,
        internal_date: new Date(Number(internalDate)).toISOString(),
        subject: header(full.data, "Subject") ?? "",
        raw_artifact_path: rawArtifactPath,
        // order_id stays null until a parser succeeds. A row here with no order is
        // a real receipt we have and cannot yet read — countable, and re-runnable.
        order_id: null,
        parse_error: null,
      });
      if (error) throw new Error(`gmail_messages insert failed for ${stub.id}: ${error.message}`);

      result.stored += 1;
    }

    pageToken = list.data.nextPageToken ?? undefined;
    if (pageToken === undefined) break;
  }

  return result;
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
 * Unblocked by: research/findings/receipt-formats.md marked READY FOR BUILD.
 * See research/findings/REQUESTS.md.
 *
 * Nothing is blocked in the meantime — ingestGmailReceipts() stores real raw HTML
 * today, and this pass re-runs over everything already collected.
 */
export function parseReceiptHtml(_html: string): never {
  throw new ShortedDataError(
    "DoorDash receipt HTML parser is not implemented: it requires the real DOM " +
      "documented in research/findings/receipt-formats.md (READY FOR BUILD). " +
      "Raw HTML is already being stored, so this pass can be re-run over the " +
      "existing corpus once the format is characterised.",
    "GMAIL_PARSER_NOT_IMPLEMENTED",
  );
}
