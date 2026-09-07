/**
 * core/fees.ts — label classification.
 *
 * The labels asserted here are the ones money-model.md Correction B names.
 * They are fee-line vocabulary, not order data: no merchant, no item, no price.
 */
import { describe, expect, it } from "vitest";
import { classifyFeeLabel, knownFeeLabels } from "../core/fees.js";

describe("classifyFeeLabel", () => {
  it("classifies the vocabulary money-model.md documents", () => {
    expect(classifyFeeLabel("Service Fee")).toBe("proportional");
    expect(classifyFeeLabel("Delivery Fee")).toBe("per_delivery");
    expect(classifyFeeLabel("Small Order Fee")).toBe("threshold");
    expect(classifyFeeLabel("Regulatory Response Fee")).toBe("passthrough");
  });

  it("is case- and whitespace-insensitive and nothing more", () => {
    expect(classifyFeeLabel("  SERVICE   FEE ")).toBe("proportional");
  });

  it("returns unknown rather than guessing at an unlisted label", () => {
    expect(classifyFeeLabel("Extended Warranty Fee")).toBe("unknown");
    expect(classifyFeeLabel("Expanded Warranty Fee")).toBe("unknown");
    expect(classifyFeeLabel("")).toBe("unknown");
  });

  it("does not fuzzy-match a near neighbour into a different half of the claim", () => {
    // "Expanded Range Fee" is per_delivery; a one-word neighbour must not inherit it.
    expect(classifyFeeLabel("Expanded Range Fee")).toBe("per_delivery");
    expect(classifyFeeLabel("Expanded Radius Fee")).toBe("unknown");
  });

  it("exposes its vocabulary so corpus coverage can be reported", () => {
    expect(knownFeeLabels()).toContain("service fee");
  });
});
