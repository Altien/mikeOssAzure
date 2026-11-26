import crypto from "crypto";
import { resolveSecret } from "./envSecrets.js";
import { currentTenant } from "./tenantContext";

/**
 * HMAC-signed download tokens, bound to tenant, user and expiry (issue 011).
 *
 * The token encodes the storage path + filename; the backend route
 * `/download/:token` validates the signature, expiry and binding, then
 * streams the file through the current tenant's storage, avoiding
 * signed-URL CORS headaches.
 */

function getSecret(): string {
    const explicit = process.env.DOWNLOAD_SIGNING_SECRET;
    if (explicit && explicit.length >= 16) return explicit;

    // Upstream ea48cde removed the SUPABASE_SECRET_KEY legacy fallback and
    // now requires a dedicated DOWNLOAD_SIGNING_SECRET. Dev follows: the
    // supabase-mode service-role-JWT reuse that used to live here is gone,
    // so token signing never piggybacks on another credential.

    if (process.env.NODE_ENV === "production") {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET must be set in production (>= 16 chars). " +
                "Generate a strong random value (e.g. `openssl rand -hex 32`) and set it in the environment. " +
                "Without it the backend would mint download tokens with a weak " +
                "hardcoded secret that anyone could forge.",
        );
    }

    // Upstream divergence (sync-log: eb44140, ea48cde). Upstream throws
    // unconditionally whenever DOWNLOAD_SIGNING_SECRET is unset, even in
    // non-production. Dev retains the local-dev fallback below for
    // local development convenience. A follow-up could remove this fallback and
    // require operators to set DOWNLOAD_SIGNING_SECRET even locally — the
    // trade-off is between local-dev ergonomics and never letting a
    // misconfigured deploy accidentally fall through to a forgeable
    // hardcoded secret.
    return "dev-secret-change-me-please-change-me";
}

/**
 * Boot-time warm-up: resolve the signing secret from Key Vault
 * (`download-signing-secret`, seeded by infra/modules/keyvault.bicep) into
 * process.env so the sync signing path works. Azure deploys deliberately
 * don't secretRef this into the Container App env (redeploy-clobber class
 * of bug — 040 Entry 19). Called from index.ts before listen(); a no-op
 * for local dev where the env var comes from .env.
 *
 * Without this warm-up a production deploy with a Key Vault-only secret can
 * crash on the first Download click: getSecret() throws inside an async route
 * handler and Express 4 does not forward the rejected promise.
 */
export async function initDownloadSigningSecret(): Promise<void> {
    if (process.env.DOWNLOAD_SIGNING_SECRET) return;
    const value = await resolveSecret("download-signing-secret");
    if (value) {
        process.env.DOWNLOAD_SIGNING_SECRET = value;
        return;
    }

    // Self-seed. The offer is a solution template, so existing installs
    // upgrade by bumping the container image — the ARM template (which seeds
    // this secret for fresh installs) never re-runs. Without this, every
    // image-only upgrade needs a manual "create the KV secret" step; with
    // it, the image bump is the entire upgrade. The UAMI already has KV
    // secret-write access (the /install configurator uses it).
    if (!process.env.KEY_VAULT_NAME) return; // local dev — .env only
    try {
        const { SecretClient } = await import("@azure/keyvault-secrets");
        const { DefaultAzureCredential } = await import("@azure/identity");
        const client = new SecretClient(
            `https://${process.env.KEY_VAULT_NAME}.vault.azure.net/`,
            new DefaultAzureCredential(),
        );
        const fresh = crypto.randomBytes(32).toString("base64url");
        await client.setSecret("download-signing-secret", fresh);
        // ponytail: two replicas cold-starting together can both write;
        // re-reading converges them on whichever write landed last.
        const settled = await client.getSecret("download-signing-secret");
        process.env.DOWNLOAD_SIGNING_SECRET = settled.value || fresh;
        console.log("download-signing-secret: self-seeded in Key Vault");
    } catch (err) {
        console.error(
            "download-signing-secret: self-seed failed — downloads will fail until the secret is set in Key Vault or as an env var:",
            err,
        );
    }
}

function b64urlEncode(buf: Buffer): string {
    return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
    return Buffer.from(s, "base64url");
}

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── Bound tokens (multi-tenant issue 011) ──────────────────────────────────
//
// Payload `{t, u, p, f, exp}`: the tenant and user the link was minted for,
// the storage path and filename, and an expiry (epoch seconds). Tenant and
// user default to the current tenant context. New links always require an
// acting user; chat downloads use document/version IDs instead of tokens.
// Legacy {p, f} links are accepted only on the install tenant before the
// fixed transition cutoff. Remove the legacy branch in the following release.
export const LEGACY_DOWNLOAD_TOKENS_CUTOFF = "2026-11-28T00:00:00Z";
const DEFAULT_TTL_SECONDS = 60;

/** Lifetime of new tokens: DOWNLOAD_TOKEN_TTL_SECONDS, default 60 seconds. */
export function downloadTokenTtlSeconds(): number {
    const raw = Number(process.env.DOWNLOAD_TOKEN_TTL_SECONDS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_TTL_SECONDS;
}

export interface SignDownloadOptions {
    /** Defaults to the current tenant context. */
    tenantId?: string;
    /** Defaults to the current context's user; required for every new token. */
    userId?: string;
    /** Defaults to downloadTokenTtlSeconds(). */
    ttlSeconds?: number;
}

export interface DownloadClaims {
    path: string;
    filename: string;
    /** Tenant the link was minted in; absent: install tenant only. */
    tenantId?: string;
    /** User the link is bound to; absent only on legacy tokens. */
    userId?: string;
    /** Expiry, epoch seconds; absent only on legacy tokens. */
    expiresAt?: number;
    /** Old `{p, f}` token without expiry or binding. */
    legacy?: true;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function hmac(enc: string): string {
    return b64urlEncode(crypto.createHmac("sha256", getSecret()).update(enc).digest());
}

export function signDownload(
    path: string,
    filename: string,
    options: SignDownloadOptions = {},
): string {
    const ctx = currentTenant();
    const tenantId = options.tenantId ?? ctx?.tenantId;
    const userId = (options.userId ?? ctx?.userId)?.trim();
    if (!userId) throw new Error("Download tokens require an acting user");
    const exp = nowSeconds() + (options.ttlSeconds ?? downloadTokenTtlSeconds());
    const payload: Record<string, string | number> = { p: path, f: filename, exp };
    if (tenantId) payload.t = tenantId;
    payload.u = userId;
    const enc = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    return `${enc}.${hmac(enc)}`;
}

/**
 * Check the signature, shape and expiry of a token. Returns its claims, or
 * null when forged, malformed or expired. Whether the caller may use it is
 * `downloadAllowed`'s decision.
 */
export function verifyDownload(token: string): DownloadClaims | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    if (!timingSafeEqStr(sigEnc, hmac(enc))) return null;
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const { p, f, t, u, exp } = parsed;
    if (typeof p !== "string" || !p || typeof f !== "string" || !f) return null;
    if (exp === undefined) {
        // Legacy token: carries nothing but the path and filename.
        if (t !== undefined || u !== undefined || !legacyWindowOpen()) return null;
        return { path: p, filename: f, legacy: true };
    }
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds()) return null;
    if (t !== undefined && (typeof t !== "string" || !t)) return null;
    if (typeof u !== "string" || !u) return null;
    const claims: DownloadClaims = { path: p, filename: f, expiresAt: exp };
    if (t) claims.tenantId = t;
    if (u) claims.userId = u;
    return claims;
}

function legacyWindowOpen(): boolean {
    return Date.now() < Date.parse(LEGACY_DOWNLOAD_TOKENS_CUTOFF);
}

/**
 * May `caller` use a token with these claims? The tenant must match the
 * caller's (a token without one, legacy or not, is the install tenant's),
 * and a user-bound token must name the caller.
 */
export function downloadAllowed(
    claims: DownloadClaims,
    caller: { tenantId: string | undefined; userId: string; installTenantId: string | undefined },
): boolean {
    if (!caller.tenantId) return false;
    if (claims.legacy && !legacyWindowOpen()) return false;
    if (!claims.legacy && !claims.userId) return false;
    const tokenTenant = claims.tenantId ?? caller.installTenantId;
    if (!tokenTenant || tokenTenant !== caller.tenantId) return false;
    if (claims.userId && claims.userId !== caller.userId) return false;
    return true;
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). Browser clients
 * prefix it with their same-origin `/api` gateway.
 */
export function buildDownloadUrl(
    path: string,
    filename: string,
    options?: SignDownloadOptions,
): string {
    return `/download/${signDownload(path, filename, options)}`;
}

/**
 * Expiring blob tokens — the filesystem storage driver's stand-in for S3
 * presigned URLs.
 *
 * A presigned URL is a capability: whoever holds it can fetch that one object
 * until it expires, with no session attached (the browser follows it as a
 * plain <a> click, so no Authorization header is available). These tokens
 * reproduce exactly that contract: HMAC over {path, filename, exp}, verified
 * by the unauthenticated `/download/signed/:token` route. Access control
 * happened when the token was minted — the same moment it would have happened
 * for a presigned URL.
 *
 * Unlike `signDownload` above, these DO expire: they replace URLs that always
 * carried an expiry, and the routes that mint them re-check access on every
 * request, so a short lifetime costs nothing.
 */
export function signBlobToken(
    path: string,
    filename: string,
    expiresInSeconds: number,
): string {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const payload = JSON.stringify({ p: path, f: filename, e: exp });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update("blob:" + enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyBlobToken(
    token: string,
): { path: string; filename: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update("blob:" + enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            f: string;
            e: number;
        };
        if (!parsed?.p || !parsed?.f || typeof parsed.e !== "number") return null;
        if (parsed.e < Math.floor(Date.now() / 1000)) return null;
        return { path: parsed.p, filename: parsed.f };
    } catch {
        return null;
    }
}

/**
 * Write-side twin of `signBlobToken` — the filesystem driver's stand-in for a
 * presigned S3 `PUT`.
 *
 * The S3 URL it replaces binds the object key, the declared content type and
 * the exact byte count into the signature, so the capability cannot be
 * replayed with a different body. This reproduces that: {path, contentType,
 * size, exp} under HMAC, redeemed by `PUT /download/signed/:token`. A distinct
 * HMAC domain ("blob-put:") means a read token can never be spent as a write
 * token, or the reverse, even though both travel on the same route.
 */
export function signBlobUploadToken(
    path: string,
    contentType: string,
    sizeBytes: number,
    expiresInSeconds: number,
): string {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const payload = JSON.stringify({
        p: path,
        c: contentType,
        s: sizeBytes,
        e: exp,
    });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update("blob-put:" + enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyBlobUploadToken(
    token: string,
): { path: string; contentType: string; sizeBytes: number } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update("blob-put:" + enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            c: string;
            s: number;
            e: number;
        };
        if (!parsed?.p || !parsed?.c) return null;
        if (typeof parsed.s !== "number" || typeof parsed.e !== "number")
            return null;
        if (parsed.e < Math.floor(Date.now() / 1000)) return null;
        return { path: parsed.p, contentType: parsed.c, sizeBytes: parsed.s };
    } catch {
        return null;
    }
}
