import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { signDownload as rawSignDownload, verifyDownload, buildDownloadUrl as rawBuildDownloadUrl, downloadAllowed } from "../downloadTokens";
import { runWithTenant, currentTenant } from "../tenantContext";

const signDownload = (path: string, filename: string, options: Parameters<typeof rawSignDownload>[2] = {}) => rawSignDownload(path, filename, { userId: currentTenant()?.userId ?? "user-1", ...options });
const buildDownloadUrl = (path: string, filename: string) => rawBuildDownloadUrl(path, filename, { userId: currentTenant()?.userId ?? "user-1" });

const SECRET = "test-secret-32-bytes-long-enough!!";

function b64url(input: string | Buffer): string {
    return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

beforeAll(() => {
    process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
});

afterAll(() => {
    delete process.env.DOWNLOAD_SIGNING_SECRET;
});

describe("signDownload", () => {
    it("returns a two-part dot-separated token", () => {
        const token = signDownload("documents/user/doc.pdf", "contract.pdf");
        const parts = token.split(".");
        expect(parts).toHaveLength(2);
        expect(parts[0].length).toBeGreaterThan(0);
        expect(parts[1].length).toBeGreaterThan(0);
    });

    it("produces different tokens for different paths", () => {
        const t1 = signDownload("documents/a/file.pdf", "a.pdf");
        const t2 = signDownload("documents/b/file.pdf", "b.pdf");
        expect(t1).not.toBe(t2);
    });

    it("uses base64url characters only (no +, /, =)", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        expect(token).not.toMatch(/[+/=]/);
    });
});

describe("verifyDownload", () => {
    it("round-trips Unicode filenames and long runs of padding-like characters", () => {
        const path = `documents/user/${"=".repeat(20_000)}/source.docx`;
        const filename = "审阅 — café.docx";
        // Bound tokens also carry their user and expiry (multi-tenant 011).
        expect(verifyDownload(signDownload(path, filename))).toMatchObject({ path, filename, userId: "user-1" });
    });

    it("round-trips a valid token", () => {
        const path = "documents/user123/doc456/source.pdf";
        const filename = "Contract Final v2.pdf";
        const token = signDownload(path, filename);
        const result = verifyDownload(token);
        expect(result).not.toBeNull();
        expect(result!.path).toBe(path);
        expect(result!.filename).toBe(filename);
    });

    it("returns null for a tampered payload", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        const [, sig] = token.split(".");
        const fakePayload = Buffer.from(
            JSON.stringify({ p: "documents/attacker/file.pdf", f: "file.pdf" }),
        )
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        expect(verifyDownload(`${fakePayload}.${sig}`)).toBeNull();
    });

    it("returns null for a tampered signature", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        const [enc] = token.split(".");
        const fakeSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        expect(verifyDownload(`${enc}.${fakeSig}`)).toBeNull();
    });

    it("returns null for a token with too many parts", () => {
        expect(verifyDownload("a.b.c")).toBeNull();
    });

    it("returns null for a token with too few parts", () => {
        expect(verifyDownload("onlyonepart")).toBeNull();
    });

    it("returns null when payload JSON is missing required fields", () => {
        const bad = Buffer.from(JSON.stringify({ x: 1 }))
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        const sig = Buffer.alloc(32).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        expect(verifyDownload(`${bad}.${sig}`)).toBeNull();
    });

    it("returns null when signed with a different secret", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        process.env.DOWNLOAD_SIGNING_SECRET = "different-secret-value-!!";
        const result = verifyDownload(token);
        process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
        expect(result).toBeNull();
    });
});

// Multi-tenant issue 011: tokens are bound to tenant, user and expiry.
describe("bound download tokens", () => {
    const tenantA = { tenantId: "tenant-a", userId: "user-1", installTenantId: "install" };

    function legacyToken(path: string, filename: string): string {
        const enc = b64url(JSON.stringify({ p: path, f: filename }));
        return `${enc}.${b64url(createHmac("sha256", SECRET).update(enc).digest())}`;
    }

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.DOWNLOAD_TOKEN_TTL_SECONDS;
        delete process.env.DOWNLOAD_LEGACY_TOKENS_UNTIL;
    });

    it("binds the current tenant and user and accepts the same caller", () => {
        const token = runWithTenant({ tenantId: "tenant-a", userId: "user-1" }, () =>
            signDownload("documents/user-1/d/source.pdf", "a.pdf"));
        const claims = verifyDownload(token)!;
        expect(claims).toMatchObject({ tenantId: "tenant-a", userId: "user-1" });
        expect(downloadAllowed(claims, tenantA)).toBe(true);
    });

    it("rejects an expired token", () => {
        vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
        process.env.DOWNLOAD_TOKEN_TTL_SECONDS = "60";
        const token = signDownload("p", "n", { tenantId: "tenant-a" });
        vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
        expect(verifyDownload(token)).not.toBeNull();
        vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
        expect(verifyDownload(token)).toBeNull();
    });

    it("defaults to a 60 second lifetime", () => {
        vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
        const claims = verifyDownload(signDownload("p", "n"))!;
        expect(claims.expiresAt).toBe(Date.parse("2026-01-01T00:01:00Z") / 1000);
    });

    it("rejects a token from tenant B for a caller in tenant A", () => {
        const token = signDownload("p", "n", { tenantId: "tenant-b", userId: "user-1" });
        expect(downloadAllowed(verifyDownload(token)!, tenantA)).toBe(false);
    });

    it("rejects a user-bound token for another user in the same tenant", () => {
        const token = signDownload("p", "n", { tenantId: "tenant-a", userId: "user-2" });
        expect(downloadAllowed(verifyDownload(token)!, tenantA)).toBe(false);
    });

    it("refuses to mint without an acting user", () => {
        expect(() => rawSignDownload("p", "n")).toThrow(/acting user/);
        expect(() => runWithTenant({ tenantId: "tenant-a" }, () => rawSignDownload("p", "n"))).toThrow(/acting user/);
    });

    it("rejects a caller with no tenant", () => {
        const token = signDownload("p", "n", { tenantId: "tenant-a" });
        expect(downloadAllowed(verifyDownload(token)!, { ...tenantA, tenantId: undefined })).toBe(false);
    });

    it("honours a token minted outside any tenant scope for the install tenant only", () => {
        const claims = verifyDownload(signDownload("p", "n"))!;
        expect(claims.tenantId).toBeUndefined();
        expect(downloadAllowed(claims, tenantA)).toBe(false);
        expect(downloadAllowed(claims, { ...tenantA, tenantId: "install" })).toBe(true);
    });

    it("accepts an old-format token for the install tenant only, until the cutoff", () => {
        vi.useFakeTimers({ now: new Date("2026-11-27T23:59:59Z") });
        const claims = verifyDownload(legacyToken("documents/u/d.pdf", "d.pdf"))!;
        expect(claims).toMatchObject({ path: "documents/u/d.pdf", legacy: true });
        const install = { ...tenantA, tenantId: "install" };
        expect(downloadAllowed(claims, install)).toBe(true);
        expect(downloadAllowed(claims, tenantA)).toBe(false);
        expect(downloadAllowed(claims, { ...install, installTenantId: undefined })).toBe(false);

        vi.useFakeTimers({ now: new Date("2026-11-28T00:00:00Z") });
        expect(downloadAllowed(claims, install)).toBe(false);
        expect(verifyDownload(legacyToken("documents/u/d.pdf", "d.pdf"))).toBeNull();
        process.env.DOWNLOAD_LEGACY_TOKENS_UNTIL = "2999-01-01T00:00:00Z";
        expect(verifyDownload(legacyToken("documents/u/d.pdf", "d.pdf"))).toBeNull();
    });

    it("rejects a signed payload whose binding fields are malformed", () => {
        const sign = (payload: unknown) => {
            const enc = b64url(JSON.stringify(payload));
            return `${enc}.${b64url(createHmac("sha256", SECRET).update(enc).digest())}`;
        };
        const exp = Math.floor(Date.now() / 1000) + 60;
        expect(verifyDownload(sign({ p: "p", f: "n", exp: "soon" }))).toBeNull();
        expect(verifyDownload(sign({ p: "p", f: "n", exp, t: 7 }))).toBeNull();
        expect(verifyDownload(sign({ p: "p", f: "n", exp, u: "" }))).toBeNull();
        expect(verifyDownload(sign({ p: "p", f: "n", exp, t: "tenant-a" }))).toBeNull();
        // A tenant without an expiry is not a legacy token.
        expect(verifyDownload(sign({ p: "p", f: "n", t: "tenant-a" }))).toBeNull();
    });
});

describe("buildDownloadUrl", () => {
    it("returns a path starting with /download/", () => {
        const url = buildDownloadUrl("documents/user/file.pdf", "file.pdf");
        expect(url).toMatch(/^\/download\//);
    });

    it("embeds a verifiable token in the URL", () => {
        const path = "documents/user/file.pdf";
        const filename = "file.pdf";
        const url = buildDownloadUrl(path, filename);
        const token = url.replace("/download/", "");
        const result = verifyDownload(token);
        expect(result).not.toBeNull();
        expect(result!.path).toBe(path);
        expect(result!.filename).toBe(filename);
    });
});
