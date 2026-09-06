/**
 * Runs Gmail receipt ingestion for one user. PROMPT.md §3.2, build order step 2.
 *
 *   pnpm ingest:gmail <userId> <refreshToken> [maxMessages]
 *
 * Stores raw HTML only. Parsing is a separate pass over stored artifacts.
 */
import { ingestGmailReceipts } from "../ingest/gmail.js";

const [userId, refreshToken, maxRaw] = process.argv.slice(2);

if (userId === undefined || refreshToken === undefined) {
  console.error("usage: pnpm ingest:gmail <userId> <refreshToken> [maxMessages]");
  process.exit(1);
}

const options = maxRaw === undefined ? {} : { maxMessages: Number(maxRaw) };
const result = await ingestGmailReceipts(userId, refreshToken, options);

console.log(`scanned:          ${result.scanned}`);
console.log(`stored (new):     ${result.stored}`);
console.log(`already present:  ${result.alreadyPresent}`);
console.log(`skipped, no HTML: ${result.skippedNoHtml}`);
console.log("");
console.log("Raw HTML is stored. Parsing is blocked on research/findings/receipt-formats.md.");
