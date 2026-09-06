/**
 * core/money.ts against REAL receipts with hand-verified expected values.
 * PROMPT.md §5.
 *
 * This suite is RED until the corpus exists, and that is the correct state:
 * the money math is genuinely unverified against real data right now. Do not
 * make it green by adding an example receipt to the repo — add a real one to
 * research/corpus/verified/ (gitignored). See docs/GAPS.md.
 */
import { describe, expect, it } from "vitest";
import { computeOwed } from "../core/money.js";
import { loadVerifiedCorpus, VERIFIED_DIR } from "./corpus.js";

const corpus = loadVerifiedCorpus();

describe("money.ts vs the real receipt corpus", () => {
  it("has at least one hand-verified real receipt to check against", () => {
    expect(
      corpus.length,
      `0 hand-verified receipts in ${VERIFIED_DIR}. core/money.ts is UNVERIFIED against ` +
        `real data. Import a real order (PROMPT.md §3.1/§3.2) and hand-check its ` +
        `expected refund values. Do not satisfy this by inventing a receipt.`,
    ).toBeGreaterThan(0);
  });

  for (const receipt of corpus) {
    describe(`${receipt.receiptId} (${receipt.source}, verified by ${receipt.verifiedBy})`, () => {
      for (const testCase of receipt.cases) {
        it(testCase.note, () => {
          const missing = testCase.missing.map((m) => {
            const item = receipt.items[m.itemIndex];
            if (!item) throw new Error(`itemIndex ${m.itemIndex} out of range`);
            return { quantity: m.quantity, unitPriceCents: item.unitPriceCents };
          });

          const owed = computeOwed(receipt.totals, missing);

          expect(owed.missingSubtotalCents).toBe(testCase.expected.missingSubtotalCents);
          expect(owed.owedExcludingTipCents).toBe(testCase.expected.owedExcludingTipCents);
          expect(owed.owedIncludingTipCents).toBe(testCase.expected.owedIncludingTipCents);
        });
      }
    });
  }
});
