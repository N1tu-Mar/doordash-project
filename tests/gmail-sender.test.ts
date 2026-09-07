/**
 * Sender verification for Gmail ingestion.
 *
 * Gmail's `from:` operator is a SUBSTRING match on the address. `from:doordash.com`
 * is therefore satisfied by `billing@doordash.com.attacker.net`, which means the
 * query alone lets anyone who knows a user's email address put attacker-authored
 * HTML into the corpus — HTML that is later parsed into a dollar figure.
 *
 * These cases are the reason isTrustedSender() exists and runs before the body
 * is ever read.
 */
import { describe, expect, it } from "vitest";
import { isTrustedSender, senderDomain } from "../ingest/gmail.js";

describe("senderDomain", () => {
  it("reads the addr-spec out of a display-name header", () => {
    expect(senderDomain("DoorDash <no-reply@doordash.com>")).toBe("doordash.com");
  });

  it("reads a bare address", () => {
    expect(senderDomain("no-reply@mail.doordash.com")).toBe("mail.doordash.com");
  });

  it("takes the LAST @, so a display name cannot smuggle a domain", () => {
    expect(senderDomain('"billing@doordash.com" <mail@attacker.net>')).toBe("attacker.net");
  });

  it("returns null when there is no address", () => {
    expect(senderDomain("DoorDash Receipts")).toBeNull();
  });
});

describe("isTrustedSender", () => {
  it("accepts DoorDash and its subdomains", () => {
    expect(isTrustedSender("DoorDash <no-reply@doordash.com>")).toBe(true);
    expect(isTrustedSender("<receipts@mail.doordash.com>")).toBe(true);
  });

  it("rejects the suffix attack Gmail's from: filter allows through", () => {
    expect(isTrustedSender("DoorDash <billing@doordash.com.attacker.net>")).toBe(false);
  });

  it("rejects a lookalike that merely contains the domain", () => {
    for (const spoof of [
      "<x@notdoordash.com>",
      "<x@doordash.com.co>",
      "<x@doordash-com.net>",
      '"no-reply@doordash.com" <x@evil.example>',
    ]) {
      expect(isTrustedSender(spoof), spoof).toBe(false);
    }
  });

  it("rejects a missing header outright", () => {
    expect(isTrustedSender(null)).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isTrustedSender("<NO-REPLY@DoorDash.COM>")).toBe(true);
  });
});
