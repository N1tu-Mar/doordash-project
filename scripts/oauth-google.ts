/**
 * One-shot Google OAuth flow for Gmail receipt ingestion. PROMPT.md §3.2.
 *
 *   pnpm oauth:google <userId>
 *
 * Closes docs/GAPS.md #8: `consentUrl()` and `oauthClient()` existed, but
 * nothing served the redirect URI or exchanged the code, so the only way to get
 * a refresh token was to do the dance by hand.
 *
 * What this does, in order:
 *   1. Prints the exact consent text and waits for the operator to read it.
 *   2. Opens a local HTTP listener on the redirect URI's port. Nothing else is
 *      served, and it shuts down after one request.
 *   3. Exchanges the code for a refresh token and prints it once.
 *   4. Records the consent row VERBATIM, so `assertGmailConsent` has something
 *      real to check against rather than a row someone inserted by hand.
 *
 * The refresh token is never printed and never written to a file. It is
 * encrypted with TOKEN_ENCRYPTION_KEY and stored on the consent row, and
 * `ingestGmailReceipts()` reads it back itself. A token echoed to a terminal
 * lands in scrollback, in `script` logs and in screen shares; one on disk in a
 * repo directory ends up in a commit.
 *
 * This runs as the service role because it happens BEFORE the user has a
 * Supabase session — see ServiceReason "oauth_consent_recording".
 */
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { GMAIL_SCOPES, oauthClient, storeRefreshToken } from "../ingest/gmail.js";
import { config } from "../services/config.js";
import { adminDb, type ServiceContext } from "../services/db.js";
import { redactedMessage } from "../services/secrets.js";

/**
 * The exact wording the user is agreeing to. Stored verbatim in
 * gmail_ingest_consents. If this text changes, that is a NEW consent row, not
 * an edit to an old one — the old row records what someone actually agreed to.
 */
const CONSENT_TEXT =
  "Shorted will read your Gmail, read-only, searching only for DoorDash order " +
  "receipts. It stores the raw HTML of messages that pass the receipt filter, so " +
  "the receipt parser can be re-run over them later. It does not store the body " +
  "of any other message, it never sends, deletes or modifies mail, and you can " +
  "revoke this at any time in your Google account and in Shorted.";

const userId = process.argv[2];
if (userId === undefined) {
  console.error("usage: pnpm oauth:google <userId>");
  process.exit(1);
}

const redirectUri = new URL(config.google.redirectUri());
const port = Number(redirectUri.port === "" ? "80" : redirectUri.port);

console.log("\nConsent text the user is agreeing to:\n");
console.log(CONSENT_TEXT);
console.log(`\nScopes: ${GMAIL_SCOPES.join(", ")}`);
console.log(`Account under consent: ${userId}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Type 'agree' to continue, anything else to abort: ");
rl.close();
if (answer.trim().toLowerCase() !== "agree") {
  console.log("Aborted. No consent recorded, no token requested.");
  process.exit(1);
}

const client = oauthClient();
const url = client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [...GMAIL_SCOPES],
});

console.log(`\nOpen this URL and approve:\n\n${url}\n`);
console.log(`Waiting for the redirect on ${redirectUri.origin}${redirectUri.pathname} ...`);

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const requested = new URL(req.url ?? "/", redirectUri.origin);
    if (requested.pathname !== redirectUri.pathname) {
      res.writeHead(404).end("not found");
      return;
    }
    const received = requested.searchParams.get("code");
    const error = requested.searchParams.get("error");

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(received === null ? `Authorization failed: ${error ?? "no code"}` : "Done. Close this tab.");
    server.close();

    if (received === null) reject(new Error(`authorization failed: ${error ?? "no code returned"}`));
    else resolve(received);
  });

  server.on("error", reject);
  server.listen(port);

  // Do not leave a listener open on a developer machine indefinitely.
  setTimeout(() => {
    server.close();
    reject(new Error("timed out waiting for the OAuth redirect"));
  }, 5 * 60_000).unref();
});

const { tokens } = await client.getToken(code);
if (!tokens.refresh_token) {
  // Google only returns a refresh token on the first consent for a client.
  throw new Error(
    "Google returned no refresh_token. Revoke this app's access at " +
      "https://myaccount.google.com/permissions and run this again — a re-consent " +
      "is the only way to get one back.",
  );
}

const ctx: ServiceContext = {
  kind: "service",
  reason: "oauth_consent_recording",
  userId,
};

const { error } = await adminDb(ctx.reason).from("gmail_ingest_consents").insert({
  user_id: userId,
  consent_text: CONSENT_TEXT,
  scopes: [...GMAIL_SCOPES],
});
if (error) throw new Error(`failed to record consent: ${redactedMessage(error.message)}`);

// Encrypted at rest, bound to this user id as AAD, and never returned to the
// terminal. The consent row has to exist first — storeRefreshToken checks it.
await storeRefreshToken(ctx, tokens.refresh_token);

console.log("\nConsent recorded and refresh token stored, encrypted, on the consent row.");
console.log("It was not printed: it is a long-lived key to this inbox.\n");
console.log("Next:");
console.log(`  SHORTED_USER_ID=${userId} SHORTED_ACCESS_TOKEN=<supabase jwt> \\`);
console.log("    pnpm ingest:gmail 50\n");
