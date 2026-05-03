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

    // Legacy fallback: in supabase mode the service-role JWT was already a
    // strong secret shared only with the backend, so reuse it. In entra/local
    // modes SUPABASE_SECRET_KEY may be unset or a low-entropy local-dev value,
    // so we only honour it when long enough to be cryptographically useful.
    const legacy = process.env.SUPABASE_SECRET_KEY;
    if (legacy && legacy.length >= 32) return legacy;

    if (process.env.NODE_ENV === "production") {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET must be set in production (>= 16 chars). " +
                "Without it the backend would mint download tokens with a weak " +
                "hardcoded secret that anyone could forge.",
        );
    }

    // Upstream divergence (sync-log: eb44140). Upstream's eb44140 closed
    // the equivalent fallback unconditionally: it throws even in
    // non-production rather than returning a hardcoded string. Dev retains
    // the local-dev fallback below for `npm run dev` convenience. A
    // follow-up could remove this fallback and require operators to set
    // DOWNLOAD_SIGNING_SECRET even locally — the trade-off is between
    // local-dev ergonomics and never letting a misconfigured deploy
    // accidentally fall through to a forgeable hardcoded secret.
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
