import { describe, it, expect } from "vitest";
import {
  redactSensitiveText,
  safeErrorMessage,
  safeErrorLog,
} from "./safeError";

// safeError exists so provider error messages (which love echoing the key
// back at you) can be logged / shown without leaking credentials.

describe("redactSensitiveText", () => {
  it("redacts the OpenAI 'Incorrect API key provided' echo", () => {
    const out = redactSensitiveText(
      "Incorrect API key provided: placeholder-test-value. You can find your key at platform.openai.com.",
    );

    expect(out).not.toContain("placeholder-test-value");
    expect(out).toContain("Incorrect API key provided: [redacted]");
  });

  it("redacts key/value-style secrets after api_key/token/secret markers", () => {
    const out = redactSensitiveText('request failed: api_key = "supersecretvalue1"');

    expect(out).not.toContain("supersecretvalue1");
    expect(out).toContain("[redacted]");
  });

  it("redacts bare provider-shaped keys anywhere in the text (sk-, sk-ant-, sk-or-, AIza)", () => {
    const out = redactSensitiveText(
      "tried sk-abcdefghijklmnop then sk-ant-abcdefghijklmnop then AIzaSyA1234567890abcdefghij",
    );

    expect(out).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(out).not.toMatch(/AIza/);
    expect(out.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves ordinary text untouched", () => {
    const text = "connect ECONNREFUSED 127.0.0.1:5432";

    expect(redactSensitiveText(text)).toBe(text);
  });
});

describe("safeErrorMessage", () => {
  it("uses the Error message, redacted", () => {
    const msg = safeErrorMessage(new Error("bad token: sk-abcdefghijklmnop"));

    expect(msg).toContain("bad token");
    expect(msg).not.toContain("sk-abcdefghijklmnop");
  });

  it("passes plain strings through redaction", () => {
    expect(safeErrorMessage("plain failure")).toBe("plain failure");
  });

  it("falls back for non-Error, non-string inputs", () => {
    expect(safeErrorMessage({ weird: true })).toBe("Unexpected error");
    expect(safeErrorMessage(undefined, "custom fallback")).toBe(
      "custom fallback",
    );
  });

  it("falls back when the Error has an empty message", () => {
    expect(safeErrorMessage(new Error(""))).toBe("Unexpected error");
  });
});

describe("safeErrorLog", () => {
  it("captures name, redacted message, and redacted stack from an Error", () => {
    const err = new Error("auth failed for key sk-abcdefghijklmnop");
    err.name = "ProviderError";

    const log = safeErrorLog(err);

    expect(log.name).toBe("ProviderError");
    expect(log.message).not.toContain("sk-abcdefghijklmnop");
    expect(log.stack).toBeDefined();
    expect(log.stack).not.toContain("sk-abcdefghijklmnop");
  });

  it("shapes non-Error values with a null name and no stack", () => {
    const log = safeErrorLog("something broke");

    expect(log).toEqual({ name: null, message: "something broke" });
  });
});
