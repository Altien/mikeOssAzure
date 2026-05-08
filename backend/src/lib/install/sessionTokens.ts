// In-memory store for the operator's Entra OAuth tokens during an
// /install session. Keyed by the install session's id field.
//
// We deliberately keep this off-disk and off-cookie:
//   - Tokens can be 4KB+, which doesn't fit cleanly inside the HMAC-
//     signed install-session cookie (4KB browser ceiling, plus
//     signature overhead).
//   - Tokens are short-lived secrets — KV is the wrong place for that.
// In-process is fine because the install session itself is short
// (1h TTL) and a Container Apps revision restart between sign-in and
// picker use is rare; if it happens, the operator just signs in again.

export type SessionTokens = {
    accessToken: string;
    refreshToken?: string;
    /** Epoch ms after which the access token is expected to be expired. */
    expiresAt: number;
    /** Audience the token was issued for, for diagnostics. */
    audience?: string;
};

const store = new Map<string, SessionTokens>();

const EXPIRY_SLACK_MS = 5 * 60 * 1000;

function reapExpired(): void {
    const now = Date.now();
    for (const [k, v] of store) {
        if (now > v.expiresAt + EXPIRY_SLACK_MS) store.delete(k);
    }
}

export function storeSessionTokens(
    sessionId: string,
    tokens: SessionTokens,
): void {
    reapExpired();
    store.set(sessionId, tokens);
}

export function getSessionTokens(sessionId: string): SessionTokens | undefined {
    const t = store.get(sessionId);
    if (!t) return undefined;
    if (Date.now() > t.expiresAt + EXPIRY_SLACK_MS) {
        store.delete(sessionId);
        return undefined;
    }
    return t;
}

export function clearSessionTokens(sessionId: string): void {
    store.delete(sessionId);
}
