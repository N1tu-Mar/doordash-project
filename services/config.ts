/**
 * Shorted — configuration. Every model ID and every secret is resolved here and
 * nowhere else, so "which model read this receipt" has one answer. PROMPT.md §4.
 *
 * Security rules this file enforces, at import time:
 *   * No credential may carry a client-bundle prefix (EXPO_PUBLIC_, NEXT_PUBLIC_,
 *     VITE_, ...). services/secrets.ts checks and the process refuses to start.
 *   * The service-role key is only readable from a real server process. Importing
 *     this module into anything with a `window` throws.
 *   * Every secret read through here is registered with the redactor, so its
 *     literal value can never appear in a log line, a thrown error, or a
 *     model_calls row.
 */
import { assertNoPublicSecrets, registerSecret } from "./secrets.js";

// Runs once, at import. Every other module in services/ and ingest/ imports this
// one, so there is no path to a model or the database that skips the check.
assertNoPublicSecrets();

/**
 * Guards against this module ever being bundled into an app. A bundler that
 * reaches services/config.ts has already inlined `process.env` into client
 * JavaScript, and the service-role key with it.
 */
function assertServerRuntime(name: string): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error(
      `${name} was read in a browser-like runtime. Server-side credentials must ` +
        `never reach the client bundle — move this call behind an API route.`,
    );
  }
}

/** Reads an env var or throws. There are no defaults for credentials. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is not set. Shorted refuses to start against a half-configured ` +
        `environment — see .env.example.`,
    );
  }
  return value;
}

/**
 * Reads a credential: server-runtime only, registered with the redactor, and
 * never returned with surrounding whitespace (a trailing newline in a .env file
 * silently breaks header signing and produces a confusing 401).
 */
function secret(name: string): string {
  assertServerRuntime(name);
  const value = required(name).trim();
  registerSecret(value);
  return value;
}

export const MODELS = {
  /** Receipt OCR. Its own call and its own prompt — never combined with detection (§6). */
  receiptOcr: "claude-opus-5",
  /** Delivered-food detection. Separate call, separate prompt. */
  foodDetection: "claude-opus-5",
  /** Dispute text generation. */
  claimText: "claude-opus-5",
} as const;

/**
 * Bumped whenever a prompt changes. Stored on every model_calls row and on every
 * order, so an accuracy number can always be attributed to the prompt that produced
 * it, and so a re-parse of the stored raw HTML is comparable to the original.
 *
 * The `-hardened` suffix marks prompts carrying the untrusted-content trust
 * boundary from core/untrusted.ts: an eval run before and after that change is
 * not comparable, and the version string has to say so.
 */
export const PROMPT_VERSIONS = {
  receiptOcr: "receipt-ocr@2-hardened",
  foodDetection: "food-detection@2-hardened",
  claimText: "claim-text@2-hardened",
  gmailHtml: "gmail-html@1",
} as const;

export const config = {
  anthropicApiKey: () => secret("ANTHROPIC_API_KEY"),
  supabaseUrl: () => required("SUPABASE_URL"),
  /**
   * Server-side only, and it BYPASSES RLS. Reachable through services/db.ts's
   * `adminDb()` alone, which documents every caller. Prefer `userDb()`.
   */
  supabaseServiceRoleKey: () => secret("SUPABASE_SERVICE_ROLE_KEY"),
  /** Publishable by design. Safe in a client bundle; still never grants more than RLS allows. */
  supabaseAnonKey: () => required("SUPABASE_ANON_KEY"),
  google: {
    clientId: () => required("GOOGLE_CLIENT_ID"),
    clientSecret: () => secret("GOOGLE_CLIENT_SECRET"),
    redirectUri: () => required("GOOGLE_REDIRECT_URI"),
  },
  /**
   * 32-byte key, base64, used to encrypt Google refresh tokens at rest.
   * Separate from the database credentials on purpose: a Postgres backup or a
   * leaked service-role key must not also hand over live inbox access.
   */
  tokenEncryptionKey: () => {
    const raw = secret("TOKEN_ENCRYPTION_KEY");
    const key = Buffer.from(raw, "base64");
    if (key.byteLength !== 32) {
      throw new Error(
        `TOKEN_ENCRYPTION_KEY must be 32 bytes of base64 (got ${key.byteLength}). ` +
          `Generate one with: openssl rand -base64 32`,
      );
    }
    return key;
  },
} as const;

/** Object-storage buckets. Raw artifacts are write-once; nothing overwrites them (§3.3). */
export const BUCKETS = {
  rawReceipts: "raw-receipts",
  deliveredPhotos: "delivered-photos",
} as const;

/** Buckets a caller is allowed to name. Anything else is a path-traversal attempt. */
export const ALLOWED_BUCKETS: ReadonlySet<string> = new Set(Object.values(BUCKETS));
