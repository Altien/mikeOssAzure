import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import {
  signDownload,
  verifyDownload,
  buildDownloadUrl,
} from "./downloadTokens";

// Backported from the OSS mirror's vitest suite (ddcfbdc), minus the
// SUPABASE_SECRET_KEY legacy-fallback cases — dev removed that fallback
// (6239643, following upstream ea48cde). The crash-regression test at the
// bottom covers a production process exit when no signing secret is loaded.

const SECRET_ENV = "DOWNLOAD_SIGNING_SECRET";
const NODE_ENV = "NODE_ENV";

const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of [SECRET_ENV, NODE_ENV]) {
    envSnapshot[k] = process.env[k];
  }
  process.env[SECRET_ENV] = "test-signing-secret-32-chars-min-x";
  process.env[NODE_ENV] = "test";
});

afterEach(() => {
  for (const k of [SECRET_ENV, NODE_ENV]) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hmacB64url(enc: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(enc).digest());
}

describe("signDownload / verifyDownload — round-trip", () => {
  it("returns a two-segment token (payload.signature)", () => {
    const token = signDownload("tenant-1/doc-1.pdf", "Report.pdf");

    expect(token.split(".")).toHaveLength(2);
  });

  it("round-trips path and filename verbatim", () => {
    const token = signDownload("tenant-1/doc-1.pdf", "Report.pdf");

    expect(verifyDownload(token)).toEqual({
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
    expect(signDownload("path", "name.pdf")).toBe(
      signDownload("path", "name.pdf"),
    );
  });

  it("produces different tokens for different paths (rules out signature reuse)", () => {
    expect(signDownload("path-a", "name.pdf")).not.toBe(
      signDownload("path-b", "name.pdf"),
    );
  });
});

describe("verifyDownload — tampering", () => {
  it("returns null when the payload is mutated after signing (CWE-345)", () => {
    const original = signDownload("tenant-1/doc.pdf", "ok.pdf");
    const [, sig] = original.split(".");
    const malicious = b64url(
      JSON.stringify({ p: "tenant-1/secret.pdf", f: "stolen.pdf" }),
    );

    expect(verifyDownload(`${malicious}.${sig}`)).toBeNull();
  });

  it("returns null when the signature is mutated", () => {
    const [enc] = signDownload("p", "n").split(".");

    expect(verifyDownload(`${enc}.AAAA`)).toBeNull();
  });

  it("returns null when the secret used to verify differs from the secret used to sign", () => {
    const token = signDownload("p", "n");

    process.env[SECRET_ENV] = "different-secret-32-chars-min-xx";

    expect(verifyDownload(token)).toBeNull();
  });

  it("returns null when the token has the wrong number of segments", () => {
    expect(verifyDownload("a")).toBeNull();
    expect(verifyDownload("a.b.c")).toBeNull();
    expect(verifyDownload("")).toBeNull();
  });

  it("returns null when the signature is the right shape but truncated", () => {
    const [enc, sig] = signDownload("p", "n").split(".");

    expect(verifyDownload(`${enc}.${sig.slice(0, sig.length - 4)}`)).toBeNull();
  });

  it("returns null when the payload decodes to invalid JSON (signature matches but body is junk)", () => {
    const enc = "not-json";

    expect(
      verifyDownload(`${enc}.${hmacB64url(enc, process.env[SECRET_ENV]!)}`),
    ).toBeNull();
  });

  it("returns null when the payload JSON lacks the p or f key", () => {
    const enc = b64url(JSON.stringify({ p: "only-path" }));

    expect(
      verifyDownload(`${enc}.${hmacB64url(enc, process.env[SECRET_ENV]!)}`),
    ).toBeNull();
  });
});

describe("getSecret — resolution (covered through sign+verify)", () => {
  it("prefers DOWNLOAD_SIGNING_SECRET when set and >= 16 chars", () => {
    process.env[SECRET_ENV] = "explicit-secret-32-bytes-or-longer";
    const token = signDownload("p", "n");

    // Removing the secret drops non-production signing to the dev
    // fallback, a different value — verification must fail.
    delete process.env[SECRET_ENV];
    expect(verifyDownload(token)).toBeNull();
  });

  it("ignores DOWNLOAD_SIGNING_SECRET shorter than 16 chars (falls through to the dev fallback outside production)", () => {
    process.env[SECRET_ENV] = "too-short";
    const token = signDownload("p", "n");

    delete process.env[SECRET_ENV];
    // Both sign and verify used the dev fallback, so the round-trip holds.
    expect(verifyDownload(token)).toEqual({ path: "p", filename: "n" });
  });

  it("throws in NODE_ENV=production when the secret is not set", () => {
    delete process.env[SECRET_ENV];
    process.env[NODE_ENV] = "production";

    expect(() => signDownload("p", "n")).toThrow(
      /DOWNLOAD_SIGNING_SECRET must be set in production/,
    );
  });

  it("throws in production when DOWNLOAD_SIGNING_SECRET is set but too short", () => {
    process.env[SECRET_ENV] = "tooshort";
    process.env[NODE_ENV] = "production";

    expect(() => signDownload("p", "n")).toThrow();
  });

  it("uses the dev fallback only in non-production", () => {
    delete process.env[SECRET_ENV];
    process.env[NODE_ENV] = "development";

    expect(() => signDownload("p", "n")).not.toThrow();
  });
});

describe("buildDownloadUrl", () => {
  it("returns a /download/<token> URL whose token verifies back to the same path+filename", () => {
    const url = buildDownloadUrl("tenant-1/doc.pdf", "Report.pdf");

    expect(url.startsWith("/download/")).toBe(true);
    expect(verifyDownload(url.slice("/download/".length))).toEqual({
      path: "tenant-1/doc.pdf",
      filename: "Report.pdf",
    });
  });

  it("does not URL-encode the token (token is already URL-safe by construction)", () => {
    expect(buildDownloadUrl("p", "n")).not.toMatch(/%/);
  });
});

// ── Crash regression: production request with no signing secret ─────────
// Mirrors the shape of GET /single-documents/:documentId/url: async
// handler, download token minted inline. Runs in a child process with a
// broken production environment (no secret) but WITH
// installProcessGuards(), as index.ts now wires it. Before the guards, the
// first /url request exited the process with code 1 (the ProcessExited in
// the customer's Container Apps logs).
const CHILD_SERVER = `
  // tsx compiles the repo's TS as CommonJS (tsconfig module: CommonJS), so
  // dynamic-import namespaces put named exports under .default.
  const pgMod = await import("./src/lib/processGuards.ts");
  (pgMod.default ?? pgMod).installProcessGuards();
  const { default: express } = await import("express");
  const dtMod = await import("./src/lib/downloadTokens.ts");
  const { buildDownloadUrl } = dtMod.default ?? dtMod;
  process.env.NODE_ENV = "production";
  delete process.env.DOWNLOAD_SIGNING_SECRET;
  const app = express();
  app.get("/url", async (_req, res) => {
    res.json({ url: buildDownloadUrl("documents/u/d/edits/x.docx", "x.docx") });
  });
  app.get("/ok", (_req, res) => res.json({ ok: true }));
  const s = app.listen(0, () => console.log("PORT:" + s.address().port));
`;

describe("process guards vs the poison Download request", () => {
  it(
    "guarded server survives the poison request and keeps serving",
    async () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", CHILD_SERVER],
        {
          cwd: new URL("../..", import.meta.url),
          env: { ...process.env, NODE_ENV: "", DOWNLOAD_SIGNING_SECRET: "" },
        },
      );
      try {
        const port = await new Promise<number>((resolve, reject) => {
          let out = "";
          child.stdout.on("data", (d: Buffer) => {
            out += d.toString();
            const m = out.match(/PORT:(\d+)/);
            if (m) resolve(Number(m[1]));
          });
          child.on("exit", (code) =>
            reject(new Error(`server died before listening (exit ${code})`)),
          );
          setTimeout(() => reject(new Error("server never started")), 15000).unref();
        });

        // The poison request still fails client-side (no response is ever
        // sent — the handler rejected), but must not kill the process.
        await fetch(`http://127.0.0.1:${port}/url`, {
          signal: AbortSignal.timeout(1500),
        }).then(
          (res) => {
            throw new Error(`poison request unexpectedly completed with HTTP ${res.status}`);
          },
          () => {},
        );
        expect(child.exitCode).toBeNull();
        const ok = await fetch(`http://127.0.0.1:${port}/ok`, {
          signal: AbortSignal.timeout(5000),
        });
        expect(ok.status).toBe(200);
      } finally {
        child.kill();
      }
    },
    30000,
  );
});
