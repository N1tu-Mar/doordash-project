/**
 * Shorted — envelope encryption for third-party OAuth refresh tokens.
 *
 * A Google refresh token is a long-lived key to somebody's inbox. Storing one as
 * plaintext in Postgres means a database backup, a leaked service-role key, a
 * misconfigured read replica, or an over-broad RLS policy all become inbox
 * access. The key that decrypts these lives in TOKEN_ENCRYPTION_KEY, outside the
 * database, so compromising Postgres alone is not enough.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than yielding attacker-chosen bytes. Random 96-bit IV per encryption, which is
 * the size GCM is specified for.
 *
 * What this does NOT solve: a live process with the key in memory can decrypt
 * everything it can read. Revocation at Google is still the real control, which
 * is why gmail_ingest_consents carries revoked_at and why the token is deleted
 * when consent is withdrawn.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { registerSecret } from "./secrets.js";
import { ShortedDataError } from "../core/types.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bumped if the scheme changes, so old ciphertexts stay decryptable. */
const VERSION = "v1";

/**
 * Encrypts a refresh token for storage.
 *
 * `aad` binds the ciphertext to the row it belongs to — pass the user id. Moving
 * a ciphertext to another user's row then fails authentication instead of
 * silently granting that user someone else's inbox.
 */
export function encryptToken(plaintext: string, aad: string): string {
  if (plaintext.trim() === "") {
    throw new ShortedDataError("refusing to encrypt an empty token", "TOKEN_EMPTY");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, config.tokenEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(".");
}

/** Decrypts a stored token. Throws on any tampering, wrong key, or wrong `aad`. */
export function decryptToken(encoded: string, aad: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ShortedDataError("stored token is not in the expected format", "TOKEN_BAD_FORMAT");
  }
  const [, ivB64 = "", ctB64 = "", tagB64 = ""] = parts;

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new ShortedDataError("stored token has a malformed envelope", "TOKEN_BAD_ENVELOPE");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, config.tokenEncryptionKey(), iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");

    // Now that we hold it, make sure it can never be printed.
    registerSecret(plaintext);
    return plaintext;
  } catch {
    // Never surface the underlying crypto error: distinguishing "wrong key" from
    // "wrong aad" from "tampered" is an oracle.
    throw new ShortedDataError(
      "stored token failed authentication — wrong key, wrong owner, or tampered",
      "TOKEN_DECRYPT_FAILED",
    );
  }
}

/** Constant-time comparison, for anything secret-adjacent that must be matched. */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ba, bb);
}
