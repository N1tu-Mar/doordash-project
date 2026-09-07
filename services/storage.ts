/**
 * Shorted — Supabase Storage. Raw artifacts only.
 *
 * Write-once. Nothing in this file overwrites an existing object: the raw email
 * HTML and the original photos are the corpus, and a parser bug must never be
 * able to destroy them (PROMPT.md §3.2, §3.3, §9).
 *
 * Two security properties this file is responsible for:
 *
 *   * Every object lives under `<userId>/`, and every read re-derives that prefix
 *     from the caller's own context rather than trusting the path it was handed.
 *     The previous getArtifact() split an arbitrary caller string on the first
 *     slash and downloaded whatever it named — any bucket, any user's receipts,
 *     with the service-role key. That is a one-parameter cross-tenant read.
 *
 *   * Every payload is size-checked before it is buffered. These objects are
 *     held in memory in full, and an image is expanded ~1.37x again when it is
 *     base64-encoded for the model.
 */
import { createHash } from "node:crypto";
import { ALLOWED_BUCKETS, BUCKETS } from "./config.js";
import { dbFor, type DbContext } from "./db.js";
import { safeMessage } from "./secrets.js";
import { LIMITS, assertWithinBytes } from "../core/untrusted.js";
import { ShortedDataError } from "../core/types.js";

/** Content hash — also the model-call input hash, so repeat calls on one image group. */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Object keys are `<userId>/<sha256>.<ext>` and nothing else. Built here, never
 * accepted from a caller, so there is no input that can shape one.
 */
function objectKey(userId: string, digest: string, extension: string): string {
  if (!/^[0-9a-f-]{36}$/.test(userId)) {
    throw new ShortedDataError("user id is not a uuid", "STORAGE_BAD_USER_ID");
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new ShortedDataError("digest is not a sha256 hex string", "STORAGE_BAD_DIGEST");
  }
  if (!/^[a-z0-9]{1,8}$/.test(extension)) {
    throw new ShortedDataError(
      `refusing storage extension ${JSON.stringify(extension)}`,
      "STORAGE_BAD_EXTENSION",
    );
  }
  return `${userId}/${digest}.${extension}`;
}

/** Content types we are willing to write. An allowlist, because these are served back. */
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/html; charset=utf-8",
]);

async function putImmutable(
  ctx: DbContext,
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  if (!ALLOWED_BUCKETS.has(bucket)) {
    throw new ShortedDataError(`unknown bucket ${JSON.stringify(bucket)}`, "STORAGE_BAD_BUCKET");
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ShortedDataError(
      `refusing content type ${JSON.stringify(contentType)}`,
      "STORAGE_BAD_CONTENT_TYPE",
    );
  }

  const { error } = await dbFor(ctx)
    .storage.from(bucket)
    // upsert stays false: colliding with an existing object is an error we want
    // to see, not a silent overwrite of the original artifact.
    .upload(path, body, { contentType, upsert: false });

  if (error) throw safeMessage(`upload to ${bucket} failed`, error.message);
  return `${bucket}/${path}`;
}

/**
 * Stores raw DoorDash receipt email HTML VERBATIM, before any parsing.
 * Content-addressed, so re-ingesting the same email is idempotent rather than
 * duplicative — and so a re-parse can be tied to the exact bytes it ran on.
 *
 * The string is encoded to bytes ONCE and both hashed and uploaded from that one
 * buffer. Hashing the string and then encoding it separately made two full
 * copies of every receipt, which for a 100-message backfill is the difference
 * between a steady heap and a sawtooth.
 */
export async function putRawReceiptHtml(ctx: DbContext, html: string): Promise<string> {
  const bytes = Buffer.from(html, "utf8");
  assertWithinBytes("receipt HTML", bytes.byteLength, LIMITS.maxHtmlBytes);
  return putImmutable(
    ctx,
    BUCKETS.rawReceipts,
    objectKey(ctx.userId, sha256(bytes), "html"),
    bytes,
    "text/html; charset=utf-8",
  );
}

export async function putRawReceiptImage(
  ctx: DbContext,
  image: Buffer,
  contentType: string,
  extension: string,
): Promise<string> {
  assertWithinBytes("receipt image", image.byteLength, LIMITS.maxImageBytes);
  return putImmutable(
    ctx,
    BUCKETS.rawReceipts,
    objectKey(ctx.userId, sha256(image), extension),
    image,
    contentType,
  );
}

/** Delivered-food photos. Originals — processed versions go to new keys, never over these. */
export async function putDeliveredPhoto(
  ctx: DbContext,
  image: Buffer,
  contentType: string,
  extension: string,
): Promise<string> {
  assertWithinBytes("delivered photo", image.byteLength, LIMITS.maxImageBytes);
  return putImmutable(
    ctx,
    BUCKETS.deliveredPhotos,
    objectKey(ctx.userId, sha256(image), extension),
    image,
    contentType,
  );
}

/**
 * Splits a stored `bucket/key` path and proves it belongs to the caller.
 *
 * The path comes out of a database row, so under RLS it is already the caller's.
 * It is re-checked anyway: a stored path is still a value an attacker may have
 * influenced upstream, and the whole point of defence in depth is that the
 * cheapest check runs closest to the dangerous operation.
 */
export function parseArtifactPath(
  ctx: DbContext,
  artifactPath: string,
): { bucket: string; key: string } {
  if (artifactPath.includes("..") || artifactPath.includes("\\") || artifactPath.includes("\0")) {
    throw new ShortedDataError("artifact path contains traversal characters", "STORAGE_TRAVERSAL");
  }

  const slash = artifactPath.indexOf("/");
  if (slash < 1) {
    throw new ShortedDataError("malformed artifact path", "STORAGE_MALFORMED_PATH");
  }
  const bucket = artifactPath.slice(0, slash);
  const key = artifactPath.slice(slash + 1);

  if (!ALLOWED_BUCKETS.has(bucket)) {
    throw new ShortedDataError(`unknown bucket ${JSON.stringify(bucket)}`, "STORAGE_BAD_BUCKET");
  }
  if (!key.startsWith(`${ctx.userId}/`)) {
    throw new ShortedDataError(
      "artifact does not belong to this user",
      "STORAGE_CROSS_TENANT_READ",
    );
  }
  if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(key)) {
    throw new ShortedDataError("artifact key is not a content-addressed key", "STORAGE_BAD_KEY");
  }

  return { bucket, key };
}

/**
 * Reads an artifact back — for re-parsing stored HTML with an improved parser (§3.2).
 *
 * Takes a context so the object can be proven to belong to the caller, and so
 * the download itself runs under the caller's RLS rather than the service role.
 */
export async function getArtifact(ctx: DbContext, artifactPath: string): Promise<Buffer> {
  const { bucket, key } = parseArtifactPath(ctx, artifactPath);

  const { data, error } = await dbFor(ctx).storage.from(bucket).download(key);
  if (error) throw safeMessage("artifact download failed", error.message);
  if (data === null) {
    throw new ShortedDataError("artifact download returned no body", "STORAGE_EMPTY_DOWNLOAD");
  }

  // Check the declared size before materialising the body: a Blob knows its
  // length without being read, so an oversized object is rejected without ever
  // being held in memory.
  assertWithinBytes("artifact", data.size, LIMITS.maxHtmlBytes);

  return Buffer.from(await data.arrayBuffer());
}
