/**
 * Envelope encryption for Google refresh tokens.
 *
 * The property that matters is the AAD binding: a ciphertext lifted out of one
 * user's consent row must not decrypt against another user's. Without it, a
 * cross-tenant write anywhere in the system upgrades to live inbox access.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";

// Set before importing services/config.ts, which reads the environment at load.
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
});

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TOKEN = "1//0eEXAMPLE-refresh-token-value-that-is-long";

describe("token envelope", () => {
  it("round-trips under the same user", async () => {
    const { encryptToken, decryptToken } = await import("../services/tokens.js");
    expect(decryptToken(encryptToken(TOKEN, USER_A), USER_A)).toBe(TOKEN);
  });

  it("refuses to decrypt against a different user — the AAD binds it to its row", async () => {
    const { encryptToken, decryptToken } = await import("../services/tokens.js");
    const sealed = encryptToken(TOKEN, USER_A);
    expect(() => decryptToken(sealed, USER_B)).toThrow(/failed authentication/);
  });

  it("produces a different ciphertext every time — the IV is random", async () => {
    const { encryptToken } = await import("../services/tokens.js");
    expect(encryptToken(TOKEN, USER_A)).not.toBe(encryptToken(TOKEN, USER_A));
  });

  it("detects tampering with the ciphertext", async () => {
    const { encryptToken, decryptToken } = await import("../services/tokens.js");
    const parts = encryptToken(TOKEN, USER_A).split(".");
    const ct = Buffer.from(parts[2] ?? "", "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[2] = ct.toString("base64");
    expect(() => decryptToken(parts.join("."), USER_A)).toThrow(/failed authentication/);
  });

  it("gives one undifferentiated error, so it is not a decryption oracle", async () => {
    const { encryptToken, decryptToken } = await import("../services/tokens.js");
    const sealed = encryptToken(TOKEN, USER_A);
    const wrongOwner = (() => {
      try {
        decryptToken(sealed, USER_B);
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    })();
    const tampered = (() => {
      const parts = sealed.split(".");
      const tag = Buffer.from(parts[3] ?? "", "base64");
      tag[0] = (tag[0] ?? 0) ^ 0xff;
      parts[3] = tag.toString("base64");
      try {
        decryptToken(parts.join("."), USER_A);
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    })();
    expect(wrongOwner).toBe(tampered);
  });

  it("rejects a stored value that is not an envelope at all", async () => {
    const { decryptToken } = await import("../services/tokens.js");
    // A plaintext token that somehow reached the column must not be returned.
    expect(() => decryptToken(TOKEN, USER_A)).toThrow(/expected format/);
  });

  it("refuses to encrypt an empty token", async () => {
    const { encryptToken } = await import("../services/tokens.js");
    expect(() => encryptToken("   ", USER_A)).toThrow(/empty token/);
  });
});
