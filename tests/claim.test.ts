/**
 * core/claim.ts — the dispute draft.
 *
 * Item names here are placeholders ("alpha"), as everywhere else in tests: the
 * subject under test is the wording and the arithmetic, not a menu (PROMPT.md §2).
 */
import { describe, expect, it } from "vitest";
import {
  buildClaimDraft,
  escalationFor,
  extractAmountsCents,
  formatCents,
  type ClaimInput,
} from "../core/claim.js";
import { computeOwed, type ReceiptMoney } from "../core/money.js";
import { ShortedDataError } from "../core/types.js";

const receipt: ReceiptMoney = {
  lineItems: [
    { quantity: 1, unitPriceCents: 1_200 },
    { quantity: 1, unitPriceCents: 800 },
  ],
  subtotalCents: 2_000,
  feeLines: [
    { label: "Service Fee", cents: 300, kind: "proportional" },
    { label: "Delivery Fee", cents: 400, kind: "per_delivery" },
  ],
  taxCents: 180,
  tipCents: 500,
  totalCents: 3_380,
};

const breakdown = computeOwed(receipt, [{ quantity: 1, unitPriceCents: 1_200 }]);

const baseInput = (overrides: Partial<ClaimInput> = {}): ClaimInput => ({
  merchantName: "Test Merchant",
  orderedAt: "2026-09-01T18:30:00-04:00",
  missingLines: [{ name: "alpha", quantity: 1, unitPriceCents: 1_200 }],
  breakdown,
  isSelected: (component) => component.includedInHeadline,
  photoCount: 3,
  funding: "unknown",
  ...overrides,
});

describe("formatCents", () => {
  it("renders integer cents without ever touching a float", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(9)).toBe("$0.09");
    expect(formatCents(1_234)).toBe("$12.34");
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
    expect(formatCents(-250)).toBe("-$2.50");
  });

  it("throws on a float rather than rounding it into a claim", () => {
    expect(() => formatCents(12.5)).toThrow(ShortedDataError);
  });
});

describe("buildClaimDraft", () => {
  it("asks for exactly the components the user selected", () => {
    const draft = buildClaimDraft(baseInput());
    expect(draft.askCents).toBe(breakdown.headlineCents);
    expect(draft.body).toContain(formatCents(breakdown.headlineCents));
  });

  it("includes the tip only when the user turned it on", () => {
    const without = buildClaimDraft(baseInput());
    expect(without.body).not.toContain("Tip");

    const withTip = buildClaimDraft(
      baseInput({ isSelected: (c) => c.includedInHeadline || c.kind === "tip" }),
    );
    expect(withTip.body).toContain("Tip on those items");
    expect(withTip.askCents).toBe(breakdown.withTipCents);
  });

  it("never accuses DoorDash of a policy it has not been shown to have", () => {
    // RESPONSES.md R4: the premise is plausible and unproven. Assert the item,
    // the arithmetic and the ask — nothing about what they do or fail to do.
    const body = buildClaimDraft(baseInput()).body.toLowerCase();
    for (const forbidden of ["policy", "you only refund", "you failed", "you never", "illegal"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("never promises an outcome, and warns that credits expire", () => {
    const draft = buildClaimDraft(baseInput());
    expect(draft.body.toLowerCase()).not.toContain("will be refunded");
    expect(draft.disclaimers.join(" ")).toMatch(/discretion/);
    expect(draft.disclaimers.join(" ")).toMatch(/expire/);
  });

  it("states the evidence it actually has", () => {
    expect(buildClaimDraft(baseInput({ photoCount: 1 })).body).toContain("1 photo)");
    expect(buildClaimDraft(baseInput({ photoCount: 0 })).body).not.toContain("photo");
  });

  it("discloses that the tax figure rests on an assumption", () => {
    expect(buildClaimDraft(baseInput()).disclaimers.join(" ")).toMatch(/assumes every item/);
  });

  it("discloses a discount, and claims the discounted value rather than menu price", () => {
    const discounted: ReceiptMoney = { ...receipt, subtotalCents: 1_500, totalCents: 2_880 };
    const owed = computeOwed(discounted, [{ quantity: 1, unitPriceCents: 1_200 }]);
    const draft = buildClaimDraft(baseInput({ breakdown: owed }));
    expect(draft.disclaimers.join(" ")).toMatch(/order-level discount/);
    expect(owed.missingNetCents).toBeLessThan(1_200);
  });

  it("names an unclassifiable fee instead of quietly dropping it", () => {
    const withMystery: ReceiptMoney = {
      ...receipt,
      feeLines: [...receipt.feeLines, { label: "Mystery Fee", cents: 100, kind: "unknown" }],
      totalCents: 3_480,
    };
    const owed = computeOwed(withMystery, [{ quantity: 1, unitPriceCents: 1_200 }]);
    const draft = buildClaimDraft(baseInput({ breakdown: owed }));
    expect(draft.disclaimers.join(" ")).toContain("Mystery Fee");
    expect(draft.body).not.toContain("Mystery Fee");
  });

  it("refuses to draft a claim that asks for nothing", () => {
    expect(() => buildClaimDraft(baseInput({ isSelected: () => false }))).toThrow(/asks for nothing/);
  });

  it("refuses to draft a claim with nothing missing", () => {
    expect(() => buildClaimDraft(baseInput({ missingLines: [] }))).toThrow(/nothing missing/);
  });

  it("throws on an unparseable order date rather than rendering Invalid Date", () => {
    expect(() => buildClaimDraft(baseInput({ orderedAt: "sometime last week" }))).toThrow(
      /unparseable timestamp/,
    );
  });

  it("lists every amount it printed, for the no-drift check", () => {
    const draft = buildClaimDraft(baseInput());
    const printed = extractAmountsCents(draft.body).sort((a, b) => a - b);
    expect(printed).toEqual([...draft.amountsCents].sort((a, b) => a - b));
  });
});

describe("escalationFor", () => {
  it("cites Reg Z only for a credit card", () => {
    expect(escalationFor("credit_card", undefined)?.citation).toContain("1026.13(a)(3)");
    expect(escalationFor("debit_card", undefined)).toBeNull();
    expect(escalationFor("prepaid_or_credit", undefined)).toBeNull();
    expect(escalationFor("unknown", undefined)).toBeNull();
  });

  it("runs the 60-day clock from the statement date, not the order date", () => {
    const path = escalationFor("credit_card", "2026-09-01T00:00:00Z");
    expect(path?.deadlineAt).toBe("2026-10-31");
  });

  it("omits a deadline it cannot compute rather than guessing one", () => {
    const path = escalationFor("credit_card", undefined);
    expect(path?.deadlineAt).toBeNull();
    expect(path?.explanation).toContain("60 days");
  });
});

describe("extractAmountsCents", () => {
  it("reads every printed amount back out exactly", () => {
    expect(extractAmountsCents("owed $12.34 and $1,234.05 and $7")).toEqual([1234, 123405, 700]);
  });

  it("finds nothing in text with no amounts", () => {
    expect(extractAmountsCents("no amounts here")).toEqual([]);
  });
});
