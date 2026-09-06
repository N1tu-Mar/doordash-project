/**
 * Shorted — configuration. Every model ID and every secret is resolved here and
 * nowhere else, so "which model read this receipt" has one answer. PROMPT.md §4.
 */

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
 */
export const PROMPT_VERSIONS = {
  receiptOcr: "receipt-ocr@1",
  foodDetection: "food-detection@1",
  claimText: "claim-text@1",
  gmailHtml: "gmail-html@1",
} as const;

export const config = {
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),
  supabaseUrl: () => required("SUPABASE_URL"),
  /** Server-side only. Never expose to the app bundle. */
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseAnonKey: () => required("SUPABASE_ANON_KEY"),
  google: {
    clientId: () => required("GOOGLE_CLIENT_ID"),
    clientSecret: () => required("GOOGLE_CLIENT_SECRET"),
    redirectUri: () => required("GOOGLE_REDIRECT_URI"),
  },
} as const;

/** Object-storage buckets. Raw artifacts are write-once; nothing overwrites them (§3.3). */
export const BUCKETS = {
  rawReceipts: "raw-receipts",
  deliveredPhotos: "delivered-photos",
} as const;
