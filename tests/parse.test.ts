import { describe, expect, it } from "vitest";
import { parseMoneyToCents, parseNonNegativeMoneyToCents } from "../core/parse.js";

describe("parseMoneyToCents", () => {
  it("parses the shapes that appear on receipts", () => {
    expect(parseMoneyToCents("$12.34")).toBe(1234);
    expect(parseMoneyToCents("12.34")).toBe(1234);
    expect(parseMoneyToCents("$1,234.05")).toBe(123405);
    expect(parseMoneyToCents("$7")).toBe(700);
    expect(parseMoneyToCents("$0.09")).toBe(9);
    expect(parseMoneyToCents("$12.3")).toBe(1230);
  });

  it("parses discount lines as negatives, both notations", () => {
    expect(parseMoneyToCents("-$2.00")).toBe(-200);
    expect(parseMoneyToCents("($2.00)")).toBe(-200);
  });

  it("does not go through parseFloat", () => {
    // 0.1 + 0.2 territory: these must be exact.
    expect(parseMoneyToCents("$0.29")).toBe(29);
    expect(parseMoneyToCents("$8.10")).toBe(810);
    expect(parseMoneyToCents("$999999.99")).toBe(99999999);
  });

  it("throws instead of guessing", () => {
    for (const bad of ["", "   ", "free", "$", "12.345", "1.2.3", "$--1", "12,34"]) {
      expect(() => parseMoneyToCents(bad), bad).toThrow();
    }
  });
});

describe("parseNonNegativeMoneyToCents", () => {
  it("rejects negatives rather than taking an absolute value", () => {
    expect(() => parseNonNegativeMoneyToCents("-$1.00")).toThrow(/non-negative/);
  });
});

describe("comma handling", () => {
  it("rejects a decimal comma instead of turning $12,34 into $1234.00", () => {
    expect(() => parseMoneyToCents("12,34")).toThrow(/not a recognisable/);
    expect(() => parseMoneyToCents("$1,23")).toThrow();
    expect(() => parseMoneyToCents("$1,2345")).toThrow();
  });

  it("accepts commas only as thousands separators", () => {
    expect(parseMoneyToCents("$1,234")).toBe(123400);
    expect(parseMoneyToCents("$12,345.67")).toBe(1234567);
  });
});
