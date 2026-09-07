/**
 * Artifact path handling.
 *
 * The bug this replaces was a one-parameter cross-tenant read: getArtifact()
 * split any caller-supplied string on the first slash and downloaded whatever it
 * named, with the service-role key. These tests pin the replacement.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";

beforeAll(() => {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= randomBytes(24).toString("hex");
});

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const ctx = { userId: USER, accessToken: "unused-for-path-parsing" };

describe("parseArtifactPath", () => {
  it("accepts a well-formed path belonging to the caller", async () => {
    const { parseArtifactPath } = await import("../services/storage.js");
    expect(parseArtifactPath(ctx, `raw-receipts/${USER}/${DIGEST}.html`)).toEqual({
      bucket: "raw-receipts",
      key: `${USER}/${DIGEST}.html`,
    });
  });

  it("refuses another user's artifact", async () => {
    const { parseArtifactPath } = await import("../services/storage.js");
    expect(() => parseArtifactPath(ctx, `raw-receipts/${OTHER}/${DIGEST}.html`)).toThrow(
      /does not belong to this user/,
    );
  });

  it("refuses a bucket we do not own", async () => {
    const { parseArtifactPath } = await import("../services/storage.js");
    // storage.objects and the auth schema are reachable with a service-role key.
    expect(() => parseArtifactPath(ctx, `avatars/${USER}/${DIGEST}.html`)).toThrow(
      /unknown bucket/,
    );
  });

  it("refuses traversal", async () => {
    const { parseArtifactPath } = await import("../services/storage.js");
    for (const bad of [
      `raw-receipts/${USER}/../${OTHER}/${DIGEST}.html`,
      `raw-receipts/..%2f${OTHER}/x.html`,
      `raw-receipts\\${USER}\\${DIGEST}.html`,
    ]) {
      expect(() => parseArtifactPath(ctx, bad), bad).toThrow();
    }
  });

  it("refuses a key that is not content-addressed", async () => {
    const { parseArtifactPath } = await import("../services/storage.js");
    expect(() => parseArtifactPath(ctx, `raw-receipts/${USER}/anything.html`)).toThrow(
      /content-addressed/,
    );
  });

  it("refuses a path with no bucket segment", async () => {
    const { parseArtifactPath } = await import("../services/storage.js");
    expect(() => parseArtifactPath(ctx, "/etc/passwd")).toThrow(/malformed/);
    expect(() => parseArtifactPath(ctx, "no-slash")).toThrow(/malformed/);
  });

  it("refuses a null byte used to truncate the extension check", async () => {
    const { parseArtifactPath } = await import("../services/storage.js");
    expect(() =>
      parseArtifactPath(ctx, `raw-receipts/${USER}/${DIGEST}.html\u0000.png`),
    ).toThrow(/traversal/);
  });
});
