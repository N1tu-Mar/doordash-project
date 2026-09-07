/**
 * Shorted — secret hygiene. Nothing else in the codebase is allowed to touch a
 * credential without going through here.
 *
 * Three jobs:
 *   1. Prove at startup that no secret has been given a client-bundle prefix.
 *   2. Redact anything that looks like a credential before it is logged, thrown,
 *      or written to the database.
 *   3. Keep secret values out of stack traces and out of `util.inspect` output.
 *
 * The threat this closes: an SDK error, a Postgres error, or a `console.error(err)`
 * that carries an Authorization header, an `x-api-key`, a signed storage URL, or a
 * refresh token into the model_calls table, into CI logs, or into an error tracker.
 */

/**
 * Prefixes that any bundler will inline into client-side JavaScript. A secret
 * carrying one of these is a shipped secret, so the process refuses to start.
 */
const PUBLIC_ENV_PREFIXES = [
  "EXPO_PUBLIC_",
  "NEXT_PUBLIC_",
  "VITE_",
  "REACT_APP_",
  "PUBLIC_",
  "NUXT_PUBLIC_",
] as const;

/** Substrings that mark an env var as carrying a credential. */
const SECRET_NAME_HINTS = [
  "SECRET",
  "PRIVATE",
  "SERVICE_ROLE",
  "REFRESH_TOKEN",
  "ACCESS_TOKEN",
  "PASSWORD",
  "CREDENTIAL",
  "API_KEY",
  "APIKEY",
] as const;

/**
 * `SUPABASE_ANON_KEY` is a publishable key by design and is exempt. Everything
 * else matching a hint is treated as a real secret.
 */
const PUBLISHABLE_BY_DESIGN = new Set(["SUPABASE_ANON_KEY", "SUPABASE_URL"]);

function looksSecret(name: string): boolean {
  const upper = name.toUpperCase();
  if (PUBLISHABLE_BY_DESIGN.has(upper)) return false;
  return SECRET_NAME_HINTS.some((hint) => upper.includes(hint));
}

/**
 * Fails the process if any credential is exposed under a client-bundle prefix.
 * Called once from services/config.ts at module load, so there is no code path
 * that reaches a model or the database without this having run.
 */
export function assertNoPublicSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const leaked: string[] = [];
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value === undefined || value.trim() === "") continue;
    const prefix = PUBLIC_ENV_PREFIXES.find((p) => name.startsWith(p));
    if (prefix === undefined) continue;
    if (looksSecret(name.slice(prefix.length)) || looksSecret(name)) leaked.push(name);
  }

  if (leaked.length > 0) {
    throw new Error(
      `Refusing to start: ${leaked.join(", ")} would be inlined into the client ` +
        `bundle by its prefix. Server-side credentials must not carry a public ` +
        `prefix. See .env.example.`,
    );
  }
}

/* ----------------------------------------------------------- redaction ---- */

/** Values registered here are scrubbed out of every redacted string. */
const registered = new Set<string>();

/**
 * Registers a live secret value so it can be scrubbed from any text later.
 * Short values are ignored — scrubbing a 6-character string would mangle
 * unrelated output and give a false sense of safety.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < 12) return;
  registered.add(trimmed);
}

/** Test seam. Not exported through the barrel; used only by tests/secrets.test.ts. */
export function __clearRegisteredSecretsForTest(): void {
  registered.clear();
}

/**
 * Patterns for credentials we have never seen the literal value of — a token in
 * an upstream error body, a signed URL in a redirect, a bearer header echoed back.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Header-shaped: `authorization: Bearer x`, `x-api-key: sk-...`, `apikey=...`
  /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|x-goog-api-key)\b\s*[:=]\s*["']?[\w.\-~+/]+=*/gi,
  /\bbearer\s+[\w.\-~+/]+=*/gi,
  // Provider-shaped literals.
  /\bsk-[A-Za-z0-9_\-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/g,
  /\bya29\.[A-Za-z0-9_\-]{10,}/g,
  /\b1\/\/[A-Za-z0-9_\-]{20,}/g, // Google refresh token
  /\bGOCSPX-[A-Za-z0-9_\-]{10,}/g,
  // JWT (Supabase service-role and anon keys, Google id_tokens).
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g,
  // Signed-URL query parameters.
  /([?&](token|signature|sig|x-amz-signature|access_token|refresh_token|id_token)=)[^&\s"']+/gi,
];

const REDACTED = "[redacted]";

/**
 * Scrubs credentials out of arbitrary text. Applied to every error message that
 * is logged, thrown across a boundary, or persisted.
 *
 * Conservative by construction: it over-redacts rather than risk printing a key.
 */
export function redact(text: string): string {
  let out = text;
  for (const secret of registered) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(REDACTED);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    // Patterns are module-level and /g, so lastIndex must not leak between calls.
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match, ...groups) => {
      const prefix = typeof groups[0] === "string" && match.startsWith(groups[0]) ? groups[0] : "";
      return `${prefix}${REDACTED}`;
    });
  }
  return out;
}

/**
 * Turns any thrown value into a single redacted line safe to log or store.
 *
 * Deliberately drops the stack and any attached `headers`/`request` properties:
 * SDK error objects carry the outbound request, and the outbound request carries
 * the API key.
 */
export function redactedMessage(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    const statusPart = typeof status === "number" ? ` (status ${status})` : "";
    return redact(`${err.name}: ${err.message}${statusPart}`);
  }
  if (typeof err === "string") return redact(err);
  // Never JSON.stringify an unknown error object: that is how headers get out.
  return `non-Error thrown: ${typeof err}`;
}

/**
 * Wraps a cause in a new Error whose message is redacted and whose `cause` is
 * dropped. Use at every boundary where an upstream error becomes our error.
 */
export function safeError(context: string, err: unknown): Error {
  return new Error(`${context}: ${redactedMessage(err)}`);
}

/** Same, for the `{ message }` shape Supabase returns instead of throwing. */
export function safeMessage(context: string, message: string): Error {
  return new Error(`${context}: ${redact(message)}`);
}
