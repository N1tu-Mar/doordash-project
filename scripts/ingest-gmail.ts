/**
 * Runs Gmail receipt ingestion for one user. PROMPT.md §3.2, build order step 2.
 *
 *   SHORTED_USER_ID=<uuid> SHORTED_ACCESS_TOKEN=<jwt> pnpm ingest:gmail [maxMessages]
 *
 * Credentials come from the environment, never from argv. Process arguments are
 * world-readable in `ps` on a shared machine, land in shell history, and are
 * captured by most process-level telemetry. The Google refresh token is not
 * accepted here at all any more — it lives encrypted in gmail_ingest_consents
 * and ingestGmailReceipts() reads it back itself.
 *
 * Stores raw HTML only. Parsing is a separate pass over stored artifacts.
 */
import { ingestGmailReceipts } from "../ingest/gmail.js";
import { redactedMessage } from "../services/secrets.js";
import type { UserContext } from "../services/db.js";

function fromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(
      `${name} is not set.\n\n` +
        `usage: SHORTED_USER_ID=<uuid> SHORTED_ACCESS_TOKEN=<supabase jwt> \\\n` +
        `         pnpm ingest:gmail [maxMessages]\n\n` +
        `The Gmail refresh token is NOT passed here — it is stored encrypted\n` +
        `against the user's consent row by the OAuth callback.`,
    );
    process.exit(1);
  }
  return value.trim();
}

const ctx: UserContext = {
  userId: fromEnv("SHORTED_USER_ID"),
  accessToken: fromEnv("SHORTED_ACCESS_TOKEN"),
};

const maxRaw = process.argv[2];
let options: { maxMessages?: number } = {};
if (maxRaw !== undefined) {
  const parsed = Number.parseInt(maxRaw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`maxMessages must be a positive integer, got ${JSON.stringify(maxRaw)}`);
    process.exit(1);
  }
  options = { maxMessages: parsed };
}

try {
  const result = await ingestGmailReceipts(ctx, options);

  console.log(`scanned:                 ${result.scanned}`);
  console.log(`stored (new):            ${result.stored}`);
  console.log(`already present:         ${result.alreadyPresent}`);
  console.log(`skipped, no HTML:        ${result.skippedNoHtml}`);
  console.log(`skipped, oversized:      ${result.skippedTooLarge}`);
  console.log(`skipped, sender spoofed: ${result.skippedUntrustedSender}`);

  if (result.skippedUntrustedSender > 0) {
    console.log("");
    console.log(
      `${result.skippedUntrustedSender} message(s) matched Gmail's from:doordash.com but were\n` +
        `not actually sent from doordash.com. Gmail's from: operator is a substring\n` +
        `match, so 'billing@doordash.com.example.net' satisfies it. Nothing was stored.`,
    );
  }

  console.log("");
  console.log("Raw HTML is stored. Parsing is blocked on research/findings/receipt-formats.md.");
} catch (err) {
  // Redacted: an OAuth or PostgREST failure can carry a token in its message.
  console.error(`ingestion failed: ${redactedMessage(err)}`);
  process.exit(1);
}
