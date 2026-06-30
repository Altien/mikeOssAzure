import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import {
  signDownload,
  verifyDownload,
  buildDownloadUrl,
} from "./downloadTokens";

const SECRET_ENV = "DOWNLOAD_SIGNING_SECRET";
const LEGACY_ENV = "SUPABASE_SECRET_KEY";
const NODE_ENV = "NODE_ENV";

const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of [SECRET_ENV, LEGACY_ENV, NODE_ENV]) {
    envSnapshot[k] = process.env[k];
  }
  process.env[SECRET_ENV] = "test-signing-secret-32-chars-min-x";
  delete process.env[LEGACY_ENV];
  process.env[NODE_ENV] = "test";
});

afterEach(() => {
  for (const k of [SECRET_ENV, LEGACY_ENV, NODE_ENV]) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe("signDownload / verifyDownload — round-trip", () => {
  it("returns a two-segment token (payload.signature)", () => {
    const token = signDownload("tenant-1/doc-1.pdf", "Report.pdf");

    expect(token.split(".")).toHaveLength(2);
  });

  it("round-trips path and filename verbatim", () => {
    const token = signDownload("tenant-1/doc-1.pdf", "Report.pdf");

    const verified = verifyDownload(token);

    expect(verified).toEqual({
      path: "tenant-1/doc-1.pdf",
      filename: "Report.pdf",
    });
  });

  it("preserves unicode and spaces in the filename", () => {
    const token = signDownload("p", "résumé final.pdf");

    expect(verifyDownload(token)).toEqual({
      path: "p",
      filename: "résumé final.pdf",
    });
  });

  it("uses base64url (no '+', '/', or '=') so the token is URL-safe", () => {
    const token = signDownload("a/b/c", "spaces and unicode ✓.pdf");

    expect(token).not.toMatch(/[+/=]/);
  });

  it("produces a deterministic token for the same input under the same secret", () => {
    const a = signDownload("path", "name.pdf");
    const b = signDownload("path", "name.pdf");

    expect(a).toBe(b);
  });

  it("produces different tokens for different paths (rules out signature reuse)", () => {
    const a = signDownload("path-a", "name.pdf");
    const b = signDownload("path-b", "name.pdf");

    expect(a).not.toBe(b);
  });
});

describe("verifyDownload — tampering", () => {
  it("returns null when the payload is mutated after signing (CWE-345)", () => {
    const original = signDownload("tenant-1/doc.pdf", "ok.pdf");
    const [, sig] = original.split(".");
    const malicious = Buffer.from(
      JSON.stringify({ p: "tenant-1/secret.pdf", f: "stolen.pdf" }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    expect(verifyDownload(`${malicious}.${sig}`)).toBeNull();
  });

  it("returns null when the signature is mutated", () => {
    const original = signDownload("p", "n");
    const [enc] = original.split(".");

    expect(verifyDownload(`${enc}.AAAA`)).toBeNull();
  });

  it("returns null when the secret used to verify differs from the secret used to sign", () => {
    const token = signDownload("p", "n");

    process.env.DOWNLOAD_SIGNING_SECRET = "different-secret-32-chars-min-xx";

    expect(verifyDownload(token)).toBeNull();
  });

  it("returns null when the token has the wrong number of segments", () => {
    expect(verifyDownload("a")).toBeNull();
    expect(verifyDownload("a.b.c")).toBeNull();
    expect(verifyDownload("")).toBeNull();
  });

  it("returns null when the signature is the right shape but truncated", () => {
    const token = signDownload("p", "n");
    const [enc, sig] = token.split(".");

    expect(verifyDownload(`${enc}.${sig.slice(0, sig.length - 4)}`)).toBeNull();
  });

  it("returns null when the payload decodes to invalid JSON (signature matches but body is junk)", () => {
    process.env[SECRET_ENV] = "test-signing-secret-32-chars-min-x";
    // Build a properly-signed token whose payload bytes are not JSON.
    const enc = "not-json";
    const sig = require("node:crypto")
      .createHmac("sha256", process.env[SECRET_ENV])
      .update(enc)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    expect(verifyDownload(`${enc}.${sig}`)).toBeNull();
  });

  it("returns null when the payload JSON lacks the p or f key", () => {
    process.env[SECRET_ENV] = "test-signing-secret-32-chars-min-x";
    const enc = Buffer.from(JSON.stringify({ p: "only-path" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const sig = require("node:crypto")
      .createHmac("sha256", process.env[SECRET_ENV])
      .update(enc)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    expect(verifyDownload(`${enc}.${sig}`)).toBeNull();
  });
});

describe("getSecret — fallback chain (covered through sign+verify)", () => {
  it("prefers DOWNLOAD_SIGNING_SECRET when set and >= 16 chars", () => {
    process.env[SECRET_ENV] = "explicit-secret-32-bytes-or-longer";
    process.env[LEGACY_ENV] = "legacy-key-also-long-enough-to-be-honoured";

    const token = signDownload("p", "n");

    delete process.env[SECRET_ENV];
    // Without the explicit secret, verification falls back to the legacy
    // key, which is a different value, so verification must fail.
    expect(verifyDownload(token)).toBeNull();
  });

  it("ignores DOWNLOAD_SIGNING_SECRET shorter than 16 chars and no longer honours SUPABASE_SECRET_KEY", () => {
    process.env[SECRET_ENV] = "too-short";
    process.env[LEGACY_ENV] = "legacy-key-thirty-two-chars-or-more-xxx";

    const token = signDownload("p", "n");

    expect(verifyDownload(token)).toEqual({ path: "p", filename: "n" });

    // Promoted code (upstream ea48cde) removed the SUPABASE_SECRET_KEY legacy
    // fallback entirely: a too-short DOWNLOAD_SIGNING_SECRET is ignored and,
    // in non-production, signing/verification fall through to the dev secret
    // regardless of SUPABASE_SECRET_KEY. So removing the legacy key has no
    // effect — the token still round-trips via the dev fallback.
    delete process.env[LEGACY_ENV];
    expect(verifyDownload(token)).toEqual({ path: "p", filename: "n" });
  });

  it("ignores SUPABASE_SECRET_KEY shorter than 32 chars", () => {
    delete process.env[SECRET_ENV];
    process.env[LEGACY_ENV] = "short";
    process.env[NODE_ENV] = "test";

    const token = signDownload("p", "n");

    // With no usable explicit/legacy secret in non-production we fall
    // through to the documented dev secret. Round-trip should still work
    // because both sides use the same fallback.
    expect(verifyDownload(token)).toEqual({ path: "p", filename: "n" });
  });

  it("throws in NODE_ENV=production when neither secret is set", () => {
    delete process.env[SECRET_ENV];
    delete process.env[LEGACY_ENV];
    process.env[NODE_ENV] = "production";

    expect(() => signDownload("p", "n")).toThrow(
      /DOWNLOAD_SIGNING_SECRET must be set in production/,
    );
  });

  it("throws in production when DOWNLOAD_SIGNING_SECRET is set but too short", () => {
    process.env[SECRET_ENV] = "tooshort";
    delete process.env[LEGACY_ENV];
    process.env[NODE_ENV] = "production";

    expect(() => signDownload("p", "n")).toThrow();
  });

  it("uses the dev fallback only in non-production", () => {
    delete process.env[SECRET_ENV];
    delete process.env[LEGACY_ENV];
    process.env[NODE_ENV] = "development";

    expect(() => signDownload("p", "n")).not.toThrow();
  });
});

describe("buildDownloadUrl", () => {
  it("returns a /download/<token> URL whose token verifies back to the same path+filename", () => {
    const url = buildDownloadUrl("tenant-1/doc.pdf", "Report.pdf");

    expect(url.startsWith("/download/")).toBe(true);
    const token = url.slice("/download/".length);
    expect(verifyDownload(token)).toEqual({
      path: "tenant-1/doc.pdf",
      filename: "Report.pdf",
    });
  });

  it("does not URL-encode the token (token is already URL-safe by construction)", () => {
    const url = buildDownloadUrl("p", "n");

    expect(url).not.toMatch(/%/);
  });
});
