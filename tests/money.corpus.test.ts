/**
 * core/money.ts against REAL receipts with hand-verified expected values.
 * PROMPT.md §5, money-model.md §7.
 *
 * This suite is RED until the corpus exists, and that is the correct state:
 * the money math is genuinely unverified against real data right now. Do not
 * make it green by adding an example receipt to the repo — add a real one to
 * research/corpus/verified/ (gitignored). See docs/GAPS.md.
 *
 * CI runs this as its own non-blocking job so the red stays visible without
 * jamming the pipeline. See .github/workflows/ci.yml.
 */
import { describe, expect, it } from "vitest";
import { computeOwed, totalFeesCents, type ReceiptMoney } from "../core/money.js";
import { classifyFeeLabel } from "../core/fees.js";
import { loadVerifiedCorpus, VERIFIED_DIR, type VerifiedReceipt } from "./corpus.js";

const corpus = loadVerifiedCorpus();

/** The corpus file's own totals, in the shape core/money.ts takes. */
function toReceiptMoney(receipt: VerifiedReceipt): ReceiptMoney {
  const base: ReceiptMoney = {
    lineItems: receipt.items.map((i) => ({
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
    })),
    subtotalCents: receipt.totals.subtotalCents,
    feeLines: receipt.totals.feeLines,
    taxCents: receipt.totals.taxCents,
    tipCents: receipt.totals.tipCents,
    totalCents: receipt.totals.totalCents,
  };
  return receipt.totals.taxableBaseCents === undefined
    ? base
    : { ...base, taxableBaseCents: receipt.totals.taxableBaseCents };
}

describe("money.ts vs the real receipt corpus", () => {
  it("has at least one hand-verified real receipt to check against", () => {
    expect(
      corpus.length,
      `0 hand-verified receipts in ${VERIFIED_DIR}. core/money.ts is UNVERIFIED against ` +
        `real data. Import a real order (PROMPT.md §3.1/§3.2) and hand-check its ` +
        `expected refund values. Do not satisfy this by inventing a receipt.`,
    ).toBeGreaterThan(0);
  });

  it("covers the format classes the parser has to survive", () => {
    // money-model.md §7 blocks on one receipt per class. Reported as a count so
    // the gap is visible before anyone quotes an accuracy number.
    const classes = new Set(corpus.map((r) => r.formatClass));
    expect(
      classes.size,
      `corpus covers ${classes.size} format class(es): ${[...classes].join(", ") || "none"}. ` +
        `money-model.md §7 wants promo, mixed-tax grocery, DoubleDash and small-order-fee ` +
        `receipts before the money math is considered verified.`,
    ).toBeGreaterThanOrEqual(4);
  });

  for (const receipt of corpus) {
    describe(`${receipt.receiptId} (${receipt.source}, ${receipt.formatClass}, verified by ${receipt.verifiedBy})`, () => {
      const money = toReceiptMoney(receipt);

      /**
       * Reconciliation. Needs zero hand-labeling and is available from receipt
       * #1 — vision-and-models.md §6 calls it the fastest real accuracy signal
       * in the project.
       */
      it("reconciles: subtotal + fees + tax + tip equals the printed total", () => {
        const sum =
          money.subtotalCents +
          totalFeesCents(money.feeLines) +
          money.taxCents +
          money.tipCents;
        expect(sum).toBe(money.totalCents);
      });

      it("every fee label classifies to the kind the human assigned", () => {
        // A classifier drift shows up here rather than as a quietly different
        // refund figure. Unknown-on-both-sides is a pass: it means the label is
        // genuinely uncatalogued, which is the honest state (core/fees.ts).
        for (const fee of money.feeLines) {
          expect(classifyFeeLabel(fee.label), fee.label).toBe(fee.kind);
        }
      });

      for (const testCase of receipt.cases) {
        it(testCase.note, () => {
          const missing = testCase.missing.map((m) => {
            const item = receipt.items[m.itemIndex];
            if (!item) throw new Error(`itemIndex ${m.itemIndex} out of range`);
            return { quantity: m.quantity, unitPriceCents: item.unitPriceCents };
          });

          const owed = computeOwed(money, missing);

          expect(owed.missingGrossCents).toBe(testCase.expected.missingGrossCents);
          expect(owed.missingNetCents).toBe(testCase.expected.missingNetCents);
          expect(owed.headlineCents).toBe(testCase.expected.headlineCents);
          expect(owed.withTipCents).toBe(testCase.expected.withTipCents);
          expect(owed.maximumCents).toBe(testCase.expected.maximumCents);
        });
      }

      /** INV-5 over real receipts. No hand-labeling needed, so it works from #1. */
      it("INV-5: every item missing owes the whole ticket, minus what does not scale", () => {
        const withheld = money.feeLines
          .filter((f) => classifyFeeLabel(f.label) === "threshold" || f.kind === "unknown")
          .reduce((s, f) => s + f.cents, 0);
        const owed = computeOwed(
          money,
          money.lineItems.map((l) => ({
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
          })),
        );
        expect(owed.maximumCents).toBe(money.totalCents - withheld);
      });
    });
  }
});
