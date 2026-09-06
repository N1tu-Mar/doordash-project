/**
 * Reports the honest state of the real-data corpus. No network, no database.
 *
 * `pnpm corpus:status`
 */
import { existsSync, readdirSync } from "node:fs";
import { VERIFIED_DIR, loadVerifiedCorpus } from "../tests/corpus.js";

const rawDir = "research/corpus";
const rawFiles = existsSync(rawDir)
  ? readdirSync(rawDir).filter((f) => !f.startsWith(".") && f !== "verified")
  : [];

const verified = loadVerifiedCorpus();
const cases = verified.reduce((n, r) => n + r.cases.length, 0);

console.log(`raw artifacts in ${rawDir}/:      ${rawFiles.length}`);
console.log(`hand-verified receipts:            ${verified.length}  (${VERIFIED_DIR})`);
console.log(`hand-verified refund cases:        ${cases}`);
console.log("");

if (verified.length === 0) {
  console.log("core/money.ts is UNVERIFIED against real data. PROMPT.md §5 requires");
  console.log("hand-checked real receipts, not generated cases. tests/money.corpus.test.ts");
  console.log("fails until at least one exists — that failure is the status report.");
} else if (verified.length < 30) {
  console.log(`${verified.length}/30 toward the §3.1 bootstrap target. Accuracy numbers`);
  console.log("computed below 30 real orders should not be trusted or quoted.");
} else {
  console.log("Bootstrap corpus target met (§3.1).");
}
