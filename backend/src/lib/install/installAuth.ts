// Install-flow session machinery. See issue 023 §"Bootstrap → Entra
// handover sequence" for the broader state machine; this file owns the
// cookie format and the middleware gate.
//
// Sessions are HMAC-signed JSON, NOT JWTs — JWT's signature/algorithm
// negotiation is overkill for a single-issuer single-verifier flow,
// and the smaller surface keeps the trust boundary obvious.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { getConfig, setConfig } from "../config";

const COOKIE_NAME = "mike-install-session";
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export type InstallSessionSource = "bootstrap" | "entra";

export type InstallSession = {
    /** Random per-session id used to key server-side state (token cache). */
    id: string;
    source: InstallSessionSource;
    issuedAt: number;
    expiresAt: number;
};

function b64url(input: string | Buffer): string {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf-8");
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
    const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

async function signingKey(): Promise<Buffer> {
    const secret = await getConfig("auth-state-secret");
    if (!secret) {
        throw new Error(
            "auth-state-secret missing — required for install-session signing",
        );
    }
    return Buffer.from(secret, "utf-8");
}

function sign(payload: string, key: Buffer): string {
    return b64url(createHmac("sha256", key).update(payload).digest());
}

export async function issueInstallSession(
    res: Response,
    source: InstallSessionSource,
): Promise<InstallSession> {
    const now = Date.now();
    const session: InstallSession = {
        id: randomBytes(16).toString("hex"),
        source,
        issuedAt: now,
        expiresAt: now + SESSION_TTL_MS,
    };
    const payload = b64url(JSON.stringify(session));
    const key = await signingKey();
    const sig = sign(payload, key);
    res.cookie(COOKIE_NAME, `${payload}.${sig}`, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        // Lax, not Strict: the OIDC callback redirects back through
        // login.microsoftonline.com, and SameSite=Strict drops the
        // just-set cookie on the resulting top-level navigation back
        // to /install — the browser still treats it as a cross-site
        // entry. Lax permits the cookie on top-level GET navigations
        // initiated from any site, which is what an OAuth return is.
        sameSite: "lax",
        maxAge: SESSION_TTL_MS,
        path: "/install",
    });
    return session;
}

export function clearInstallSession(res: Response): void {
    res.clearCookie(COOKIE_NAME, { path: "/install" });
}

async function verifySession(raw: string): Promise<InstallSession | null> {
    const dot = raw.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = raw.slice(0, dot);
    const presented = raw.slice(dot + 1);

    const key = await signingKey();
    const expected = sign(payload, key);
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let session: InstallSession;
    try {
        session = JSON.parse(fromB64url(payload).toString("utf-8"));
    } catch {
        return null;
    }
    if (typeof session.expiresAt !== "number" || Date.now() > session.expiresAt) {
        return null;
    }
    if (session.source !== "bootstrap" && session.source !== "entra") return null;
    // Backwards compat: pre-id sessions still verify; downstream code
    // that needs the id (token cache lookups) should null-check.
    if (typeof session.id !== "string") session.id = "";
    return session;
}

export async function readInstallSession(
    req: Request,
): Promise<InstallSession | null> {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
    if (!raw) return null;
    return verifySession(raw);
}

// Attach the session to res.locals if present, but DO NOT redirect or
// 401. The route decides what to render based on whether the session
// exists (the install page renders the paste form when not signed in,
// the checklist when signed in).
export async function loadInstallSession(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    res.locals.installSession = await readInstallSession(req);
    next();
}

// ── Entra OIDC for /install (slice 8) ───────────────────────────────

export type OidcState = {
    nonce: string;
    issuedAt: number;
};

export async function signOidcState(state: OidcState): Promise<string> {
    const payload = b64url(JSON.stringify(state));
    const key = await signingKey();
    return `${payload}.${sign(payload, key)}`;
}

export async function verifyOidcState(raw: string | undefined): Promise<OidcState | null> {
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = raw.slice(0, dot);
    const presented = raw.slice(dot + 1);
    const key = await signingKey();
    const expected = sign(payload, key);
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let state: OidcState;
    try {
        state = JSON.parse(fromB64url(payload).toString("utf-8"));
    } catch {
        return null;
    }
    // 10-minute window — same as the main /auth flow.
    if (Date.now() - state.issuedAt > 10 * 60 * 1000) return null;
    return state;
}

// Decodes the JWT payload without verifying the signature. We trust the
// id_token came directly from Entra over HTTPS during the authorization
// code exchange — this is just a structured read of the payload, not an
// authentication step. (The backend's main-app auth pipeline does proper
// JWKS validation; the install flow only needs claims for the admin-
// group check below.)
export function readIdTokenClaims(idToken: string): Record<string, unknown> | null {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(fromB64url(parts[1]).toString("utf-8")) as Record<string, unknown>;
    } catch {
        return null;
    }
}

// Compare the user's `groups` claim against the configured admin group
// ID(s). The KV value may be a single GUID or a comma-separated list,
// optionally followed by `# display name` comments per the issue 023
// design — we strip everything after the first `#` and ignore whitespace.
export async function isInAdminGroup(
    userGroups: string[] | undefined,
): Promise<boolean> {
    if (!userGroups || userGroups.length === 0) return false;
    const raw = await getConfig("entra-admin-group-ids").catch(() => "");
    if (!raw) return false;
    const adminGuids = raw
        .split(",")
        .map((s) => s.split("#")[0].trim().toLowerCase())
        .filter(Boolean);
    const userGuidSet = new Set(userGroups.map((g) => g.toLowerCase()));
    return adminGuids.some((g) => userGuidSet.has(g));
}

// Auto-retirement: blank the bootstrap token so /install no longer
// accepts the bootstrap path. Idempotent.
export async function retireBootstrap(): Promise<void> {
    await setConfig("install-bootstrap-token", "");
}
