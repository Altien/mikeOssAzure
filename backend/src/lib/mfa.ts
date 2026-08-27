import crypto from "node:crypto";
import QRCode from "qrcode";
import { getSqliteDb } from "./sqlite";

/**
 * Local TOTP (RFC 6238) MFA backed by SQLite.
 *
 * Factors live in `user_mfa_factors` with AES-256-GCM encrypted secrets.
 * Sessions carry an `mfa_verified` flag: login creates an unverified
 * (aal1) session when the user has a verified factor and `mfa_on_login`
 * is enabled; `requireAuth` then blocks everything except the MFA and
 * profile endpoints until `verifyTotpForSession` elevates the session.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type MfaFactorRow = {
    id: string;
    user_id: string;
    friendly_name: string | null;
    status: string;
    created_at: string;
    updated_at: string;
};

let tableReady = false;

function ensureMfaTable(): void {
    if (tableReady) return;
    getSqliteDb().exec(`
        create table if not exists user_mfa_factors (
            id text primary key,
            user_id text not null,
            friendly_name text,
            encrypted_secret text not null,
            secret_iv text not null,
            secret_tag text not null,
            status text not null default 'pending',
            created_at text not null default (datetime('now')),
            updated_at text not null default (datetime('now'))
        );
    `);
    tableReady = true;
}

function mfaSecret(): string {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error(
            "USER_API_KEYS_ENCRYPTION_SECRET must be set to use MFA.",
        );
    }
    return secret;
}

function encryptionKey(): Buffer {
    return crypto.scryptSync(mfaSecret(), "mike-user-mfa-v1", 32);
}

function encryptSecret(value: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
    };
}

function decryptSecret(encrypted: string, iv: string, tag: string): string {
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        encryptionKey(),
        Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64")),
        decipher.final(),
    ]).toString("utf8");
}

function base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(value: string): Buffer {
    const clean = value.replace(/=+$/g, "").toUpperCase();
    let bits = 0;
    let buffer = 0;
    const out: number[] = [];
    for (const char of clean) {
        const idx = BASE32_ALPHABET.indexOf(char);
        if (idx === -1) continue;
        buffer = (buffer << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac("sha1", secret).update(msg).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const code =
        ((digest[offset] & 0x7f) << 24) |
        (digest[offset + 1] << 16) |
        (digest[offset + 2] << 8) |
        digest[offset + 3];
    return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotpCode(secretBase32: string, code: string): boolean {
    const normalized = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(normalized)) return false;
    const secret = base32Decode(secretBase32);
    const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    for (const drift of [-1, 0, 1]) {
        const candidate = hotp(secret, counter + drift);
        if (
            crypto.timingSafeEqual(
                Buffer.from(candidate),
                Buffer.from(normalized),
            )
        ) {
            return true;
        }
    }
    return false;
}

function loadFactorSecret(factorId: string, userId: string): string | null {
    ensureMfaTable();
    const row = getSqliteDb()
        .prepare(
            "select encrypted_secret, secret_iv, secret_tag from user_mfa_factors where id = ? and user_id = ?",
        )
        .get(factorId, userId);
    if (!row) return null;
    return decryptSecret(
        String(row.encrypted_secret),
        String(row.secret_iv),
        String(row.secret_tag),
    );
}

export function listMfaFactors(userId: string): MfaFactorRow[] {
    ensureMfaTable();
    const rows = getSqliteDb()
        .prepare(
            "select id, user_id, friendly_name, status, created_at, updated_at from user_mfa_factors where user_id = ? order by created_at asc",
        )
        .all(userId);
    return rows as unknown as MfaFactorRow[];
}

export function hasVerifiedTotpFactor(userId: string): boolean {
    return listMfaFactors(userId).some(
        (factor) => factor.status === "verified",
    );
}

export async function createMfaFactor(
    userId: string,
    email: string,
    friendlyName: string,
): Promise<{
    id: string;
    secret: string;
    uri: string;
    qrCode: string;
    error?: never;
} | {
    error: string;
}> {
    ensureMfaTable();
    const existing = listMfaFactors(userId);
    if (
        existing.some(
            (factor) =>
                (factor.friendly_name ?? "").toLowerCase() ===
                friendlyName.toLowerCase(),
        )
    ) {
        return {
            error: `A factor with the friendly name "${friendlyName}" already exists for this account.`,
        };
    }
    if (existing.filter((factor) => factor.status === "verified").length >= 10) {
        return { error: "Too many authenticator factors enrolled." };
    }

    // Drop stale unverified factors so repeated setup attempts do not pile up.
    getSqliteDb()
        .prepare(
            "delete from user_mfa_factors where user_id = ? and status = 'pending'",
        )
        .run(userId);

    const secret = base32Encode(crypto.randomBytes(20));
    const encrypted = encryptSecret(secret);
    const id = crypto.randomUUID();
    getSqliteDb()
        .prepare(
            "insert into user_mfa_factors (id, user_id, friendly_name, encrypted_secret, secret_iv, secret_tag, status) values (?, ?, ?, ?, ?, ?, 'pending')",
        )
        .run(
            id,
            userId,
            friendlyName,
            encrypted.encrypted,
            encrypted.iv,
            encrypted.tag,
        );

    const issuer = "Mike";
    const uri =
        `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}` +
        `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
    const svg = await QRCode.toString(uri, { type: "svg", margin: 1 });
    const qrCode = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    return { id, secret, uri, qrCode };
}

export function createMfaChallenge(
    factorId: string,
    userId: string,
): { id: string; expires_at: string } | null {
    ensureMfaTable();
    const row = getSqliteDb()
        .prepare("select id from user_mfa_factors where id = ? and user_id = ?")
        .get(factorId, userId);
    if (!row) return null;
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    const signature = crypto
        .createHmac("sha256", mfaSecret())
        .update(`${factorId}.${expiresAt}`)
        .digest("base64url");
    return {
        id: `${factorId}.${expiresAt}.${signature}`,
        expires_at: new Date(expiresAt).toISOString(),
    };
}

function isChallengeValid(challengeId: string, factorId: string): boolean {
    const parts = challengeId.split(".");
    if (parts.length < 3) return false;
    const signature = parts.pop() as string;
    const expiresAtRaw = parts.pop() as string;
    const challengeFactorId = parts.join(".");
    if (challengeFactorId !== factorId) return false;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    const expected = crypto
        .createHmac("sha256", mfaSecret())
        .update(`${factorId}.${expiresAtRaw}`)
        .digest("base64url");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyMfaFactorCode(params: {
    factorId: string;
    userId: string;
    challengeId?: string;
    code: string;
}): { ok: true } | { ok: false; error: string } {
    const { factorId, userId, challengeId, code } = params;
    if (challengeId && !isChallengeValid(challengeId, factorId)) {
        return { ok: false, error: "MFA challenge is invalid or expired." };
    }
    const secret = loadFactorSecret(factorId, userId);
    if (!secret) return { ok: false, error: "Authenticator factor not found." };
    if (!verifyTotpCode(secret, code)) {
        return { ok: false, error: "Invalid authentication code" };
    }
    ensureMfaTable();
    getSqliteDb()
        .prepare(
            "update user_mfa_factors set status = 'verified', updated_at = datetime('now') where id = ? and user_id = ?",
        )
        .run(factorId, userId);
    return { ok: true };
}

export function unenrollMfaFactor(factorId: string, userId: string): boolean {
    ensureMfaTable();
    getSqliteDb()
        .prepare("delete from user_mfa_factors where id = ? and user_id = ?")
        .run(factorId, userId);
    return true;
}
