import crypto from "crypto";

/**
 * HMAC-signed, non-expiring download tokens.
 *
 * The token encodes the R2 storage path + filename; the backend route
 * `/download/:token` validates the signature and streams the file. This
 * gives persistent links safe to store in chat history without signed-URL
 * expiry or R2 CORS headaches.
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
    // `npm run dev` convenience. A follow-up could remove this fallback and
    // require operators to set DOWNLOAD_SIGNING_SECRET even locally — the
    // trade-off is between local-dev ergonomics and never letting a
    // misconfigured deploy accidentally fall through to a forgeable
    // hardcoded secret.
    return "dev-secret-change-me-please-change-me";
}

function b64urlEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signDownload(path: string, filename: string): string {
    const payload = JSON.stringify({ p: path, f: filename });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(
    token: string,
): { path: string; filename: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            f: string;
        };
        if (!parsed?.p || !parsed?.f) return null;
        return { path: parsed.p, filename: parsed.f };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). The frontend
 * prefixes it with NEXT_PUBLIC_API_BASE_URL when rendering `<a href=…>`.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
