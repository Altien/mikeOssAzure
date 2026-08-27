import crypto from "crypto";

/**
 * HMAC-signed download tokens.
 *
 * The token encodes the storage path + filename (+ optional expiry); the
 * backend route `/download/:token` validates the signature and streams the
 * file. Tokens used for one-off signed URLs (`getSignedUrl`) carry an
 * expiry; tokens used for chat-history cards/perminks (`buildDownloadUrl`)
 * stay non-expiring because the downloads route re-checks document access
 * on every request, so revocation works by removing access.
 */

function getSecret(): string {
    const secret = process.env.DOWNLOAD_SIGNING_SECRET;
    if (!secret) {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET must be set. " +
                "Generate a strong random value (e.g. `openssl rand -hex 32`) and set it in the environment.",
        );
    }
    return secret;
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

export function signDownload(
    path: string,
    filename: string,
    expiresInSeconds?: number,
): string {
    const payload: { p: string; f: string; e?: number } = {
        p: path,
        f: filename,
    };
    if (expiresInSeconds && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
        payload.e = Math.floor(Date.now() / 1000) + Math.floor(expiresInSeconds);
    }
    const enc = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(
    token: string,
): { path: string; filename: string; expiresAt: number | null } | null {
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
            e?: number;
        };
        if (!parsed?.p || !parsed?.f) return null;
        if (
            typeof parsed.e === "number" &&
            parsed.e <= Math.floor(Date.now() / 1000)
        ) {
            return null;
        }
        return {
            path: parsed.p,
            filename: parsed.f,
            expiresAt: typeof parsed.e === "number" ? parsed.e : null,
        };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). Browser clients
 * prefix it with their same-origin `/api` gateway.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
