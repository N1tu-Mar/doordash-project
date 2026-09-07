/**
 * Redaction and the public-prefix guard.
 *
 * These are the tests that decide whether a credential can reach a log line, a
 * thrown error, or a durable model_calls row. They use synthetic key-shaped
 * strings, not real credentials — a test fixture that is a real key is the exact
 * leak the module exists to prevent.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  __clearRegisteredSecretsForTest,
  assertNoPublicSecrets,
  redact,
  redactedMessage,
  registerSecret,
  safeError,
} from "../services/secrets.js";

beforeEach(() => __clearRegisteredSecretsForTest());

describe("assertNoPublicSecrets", () => {
  it("refuses a service-role key given a client-bundle prefix", () => {
    expect(() =>
      assertNoPublicSecrets({ EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40) }),
    ).toThrow(/client.*bundle/i);
  });

  it("catches every bundler prefix we know about", () => {
    for (const prefix of ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "NUXT_PUBLIC_", "PUBLIC_"]) {
      expect(() => assertNoPublicSecrets({ [`${prefix}ANTHROPIC_API_KEY`]: "sk-ant-test" })).toThrow();
    }
  });

  it("allows the anon key to be public — it is publishable by design", () => {
    expect(() =>
      assertNoPublicSecrets({ EXPO_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiJ9.a.b" }),
    ).not.toThrow();
  });

  it("ignores an empty variable — an unset placeholder is not a leak", () => {
    expect(() => assertNoPublicSecrets({ NEXT_PUBLIC_GOOGLE_CLIENT_SECRET: "" })).not.toThrow();
  });

  it("does not object to a server-side secret with no public prefix", () => {
    expect(() =>
      assertNoPublicSecrets({ SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40) }),
    ).not.toThrow();
  });
});

describe("redact", () => {
  it("scrubs a registered secret wherever it appears", () => {
    registerSecret("super-secret-value-1234");
    expect(redact("failed with super-secret-value-1234 in the header")).toBe(
      "failed with [redacted] in the header",
    );
  });

  it("ignores short registrations rather than mangling unrelated text", () => {
    registerSecret("abc");
    expect(redact("abc def")).toBe("abc def");
  });

  it("scrubs credentials it has never seen the value of", () => {
    const cases = [
      "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.sigsigsigsig",
      "x-api-key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAA",
      "google returned ya29.A0ARrdaM-EXAMPLEEXAMPLE",
      "refresh_token 1//0eXAMPLEXAMPLEXAMPLEXAMPLE",
      "client secret GOCSPX-AAAAAAAAAAAAAAAA",
    ];
    for (const text of cases) {
      expect(redact(text), text).toContain("[redacted]");
    }
  });

  it("scrubs a JWT anywhere in a message, not only behind a header name", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJlZGF0YQ";
    expect(redact(`JWSError on ${jwt} at row 3`)).not.toContain(jwt);
  });

  it("keeps the parameter name when scrubbing a signed URL", () => {
    const out = redact("https://x.supabase.co/o?token=abcdefghijklmnop&name=receipt.html");
    expect(out).toContain("token=[redacted]");
    expect(out).toContain("name=receipt.html");
  });

  it("is stable across calls — a /g regex must not carry lastIndex", () => {
    const text = "Bearer aaaaaaaaaaaaaaaaaaaa";
    expect(redact(text)).toBe(redact(text));
  });
});

describe("redactedMessage", () => {
  it("drops the stack and keeps only a redacted single line", () => {
    registerSecret("sk-ant-registered-secret-value");
    const err = new Error("call failed for sk-ant-registered-secret-value");
    const out = redactedMessage(err);
    expect(out).toBe("Error: call failed for [redacted]");
    expect(out).not.toContain("at ");
  });

  it("never serialises an unknown thrown object — that is how headers escape", () => {
    const hostile = { headers: { "x-api-key": "sk-ant-leak-me-please-0000" } };
    expect(redactedMessage(hostile)).toBe("non-Error thrown: object");
  });

  it("keeps an HTTP status, which is the part worth logging", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(redactedMessage(err)).toContain("status 401");
  });
});

describe("safeError", () => {
  it("wraps without carrying the original as a cause", () => {
    registerSecret("aaaaaaaaaaaaaaaaaaaaaa");
    const wrapped = safeError("insertOrder failed", new Error("token aaaaaaaaaaaaaaaaaaaaaa"));
    expect(wrapped.message).toBe("insertOrder failed: Error: token [redacted]");
    expect(wrapped.cause).toBeUndefined();
  });
});
