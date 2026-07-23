import crypto from "crypto";
import { resolveSecret } from "./envSecrets.js";

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
