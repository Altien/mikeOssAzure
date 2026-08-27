import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    completeGmailAuthorization,
    createGmailAuthorizationUrl,
    disconnectGmail,
    getGmailMessage,
    getGmailStatus,
    searchGmailMessages,
    sendGmailMessage,
} from "../gmail";
import { createServerSQLite } from "../sqlite";

const originalEnv = {
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    encryptionSecret: process.env.USER_API_KEYS_ENCRYPTION_SECRET,
};

let userId = "";

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

beforeEach(async () => {
    userId = crypto.randomUUID();
    process.env.GMAIL_CLIENT_ID = "gmail-client.test";
    process.env.GMAIL_CLIENT_SECRET = "gmail-secret";
    process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-encryption-secret";
    const db = createServerSQLite();
    await db.from("user_profiles").upsert({
        user_id: userId,
        email_integration_enabled: true,
    }, { onConflict: "user_id" });
});

afterEach(async () => {
    vi.restoreAllMocks();
    const db = createServerSQLite();
    await db.from("gmail_oauth_states").delete().eq("user_id", userId);
    await db.from("gmail_connections").delete().eq("user_id", userId);
    await db.from("user_profiles").delete().eq("user_id", userId);
    if (originalEnv.clientId === undefined) delete process.env.GMAIL_CLIENT_ID;
    else process.env.GMAIL_CLIENT_ID = originalEnv.clientId;
    if (originalEnv.clientSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET;
    else process.env.GMAIL_CLIENT_SECRET = originalEnv.clientSecret;
    if (originalEnv.encryptionSecret === undefined) delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    else process.env.USER_API_KEYS_ENCRYPTION_SECRET = originalEnv.encryptionSecret;
});

async function connect() {
    const db = createServerSQLite();
    const authorizationUrl = await createGmailAuthorizationUrl({
        userId,
        redirectUri: "http://localhost:3001/integrations/gmail/oauth/callback",
        db,
    });
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
            expect(String(init?.body)).toContain("grant_type=authorization_code");
            return json({
                access_token: "short-lived-access-token",
                refresh_token: "persisted-refresh-token",
                scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            });
        }
        if (url.endsWith("/users/me/profile")) {
            return json({ emailAddress: "lawyer@example.com" });
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    await completeGmailAuthorization({ code: "oauth-code", state, db });
    vi.restoreAllMocks();
    return state;
}

describe("Gmail integration", () => {
    it("validates one-time OAuth state and stores only an encrypted refresh token", async () => {
        const state = await connect();
        const db = createServerSQLite();
        await expect(getGmailStatus(userId, db)).resolves.toEqual({
            available: true,
            enabled: true,
            connected: true,
            email: "lawyer@example.com",
        });
        const { data } = await db.from("gmail_connections").select("*").eq("user_id", userId).single();
        expect(data.encrypted_refresh_token).not.toContain("persisted-refresh-token");
        await expect(
            completeGmailAuthorization({ code: "second-code", state, db }),
        ).rejects.toThrow(/expired/i);
    });

    it("searches messages, reads MIME text, and sends through the connected mailbox", async () => {
        await connect();
        const requests: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const url = String(input);
            requests.push(url);
            if (url.includes("oauth2.googleapis.com/token")) {
                expect(String(init?.body)).toContain("persisted-refresh-token");
                return json({ access_token: "refreshed-access-token" });
            }
            if (url.includes("/users/me/messages?") && !url.includes("format=")) {
                expect(url).toContain("q=from%3Aclient%40example.com");
                return json({ messages: [{ id: "m1" }], resultSizeEstimate: 1 });
            }
            if (url.includes("/messages/m1?format=metadata")) {
                return json({
                    id: "m1",
                    threadId: "t1",
                    snippet: "Please review",
                    payload: { headers: [
                        { name: "Subject", value: "Draft agreement" },
                        { name: "From", value: "Client <client@example.com>" },
                        { name: "To", value: "lawyer@example.com" },
                        { name: "Date", value: "Wed, 29 Jul 2026 10:00:00 -0500" },
                    ] },
                });
            }
            if (url.includes("/messages/m1?format=full")) {
                return json({
                    id: "m1",
                    threadId: "t1",
                    snippet: "Please review",
                    payload: {
                        headers: [
                            { name: "Subject", value: "Draft agreement" },
                            { name: "From", value: "Client <client@example.com>" },
                            { name: "To", value: "lawyer@example.com" },
                        ],
                        parts: [{
                            mimeType: "text/plain",
                            body: { data: Buffer.from("Please review the attached draft.").toString("base64url") },
                        }],
                    },
                });
            }
            if (url.endsWith("/users/me/messages/send")) {
                const payload = JSON.parse(String(init?.body));
                expect(payload.raw).toMatch(/^[A-Za-z0-9_-]+$/);
                return json({ id: "sent-1" });
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const search = await searchGmailMessages({
            userId,
            query: "from:client@example.com",
        });
        expect(search.messages[0]).toMatchObject({
            id: "m1",
            subject: "Draft agreement",
            hasAttachments: false,
        });

        const message = await getGmailMessage(userId, "m1");
        expect(message.body).toBe("Please review the attached draft.");

        await sendGmailMessage({
            userId,
            to: "alerts@example.com",
            subject: "Monitor update",
            text: "A material development was found.",
        });
        expect(requests.some((url) => url.endsWith("/users/me/messages/send"))).toBe(true);
    });

    it("stops Gmail access immediately when the connection is removed", async () => {
        await connect();
        const db = createServerSQLite();
        await disconnectGmail(userId, db);
        await expect(getGmailStatus(userId, db)).resolves.toMatchObject({ connected: false });
        await expect(searchGmailMessages({ userId, db })).rejects.toThrow(/Connect Gmail/i);
    });
});
