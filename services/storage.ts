/**
 * Shorted — Supabase Storage. Raw artifacts only.
 *
 * Write-once. Nothing in this file overwrites an existing object: the raw email
 * HTML and the original photos are the corpus, and a parser bug must never be
 * able to destroy them (PROMPT.md §3.2, §3.3, §9).
 */
import { createHash } from "node:crypto";
import { BUCKETS } from "./config.js";
import { db } from "./db.js";

/** Content hash — also the model-call input hash, so repeat calls on one image group. */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function putImmutable(
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const { error } = await db()
    .storage.from(bucket)
    // upsert stays false: colliding with an existing object is an error we want
    // to see, not a silent overwrite of the original artifact.
    .upload(path, body, { contentType, upsert: false });

  if (error) throw new Error(`upload to ${bucket}/${path} failed: ${error.message}`);
  return `${bucket}/${path}`;
}

/**
 * Stores raw DoorDash receipt email HTML VERBATIM, before any parsing.
 * Content-addressed, so re-ingesting the same email is idempotent rather than
 * duplicative — and so a re-parse can be tied to the exact bytes it ran on.
 */
export async function putRawReceiptHtml(userId: string, html: string): Promise<string> {
  const digest = sha256(html);
  return putImmutable(
    BUCKETS.rawReceipts,
    `${userId}/${digest}.html`,
    Buffer.from(html, "utf8"),
    "text/html; charset=utf-8",
  );
}

export async function putRawReceiptImage(
  userId: string,
  image: Buffer,
  contentType: string,
  extension: string,
): Promise<string> {
  const digest = sha256(image);
  return putImmutable(BUCKETS.rawReceipts, `${userId}/${digest}.${extension}`, image, contentType);
}

/** Delivered-food photos. Originals — processed versions go to new keys, never over these. */
export async function putDeliveredPhoto(
  userId: string,
  image: Buffer,
  contentType: string,
  extension: string,
): Promise<string> {
  const digest = sha256(image);
  return putImmutable(
    BUCKETS.deliveredPhotos,
    `${userId}/${digest}.${extension}`,
    image,
    contentType,
  );
}

/** Reads an artifact back — for re-parsing stored HTML with an improved parser (§3.2). */
export async function getArtifact(artifactPath: string): Promise<Buffer> {
  const slash = artifactPath.indexOf("/");
  if (slash < 1) throw new Error(`malformed artifact path: ${artifactPath}`);
  const bucket = artifactPath.slice(0, slash);
  const key = artifactPath.slice(slash + 1);

  const { data, error } = await db().storage.from(bucket).download(key);
  if (error) throw new Error(`download of ${artifactPath} failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}
