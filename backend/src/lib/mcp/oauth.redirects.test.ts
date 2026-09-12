import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getConfigMock } = vi.hoisted(() => ({ getConfigMock: vi.fn() }));
vi.mock("../config", () => ({ getConfig: getConfigMock }));
vi.mock("dns/promises", () => ({
    default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
    lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import { discoverOAuthMetadata } from "./oauth";

const AUTH_SERVER = {
    issuer: "https://app.example.com",
    authorization_endpoint: "https://app.example.com/mcp/authorize",
    token_endpoint: "https://app.example.com/mcp/token",
    registration_endpoint: "https://app.example.com/mcp/register",
    response_types_supported: ["code"],
};

function redirect(location: string) {
    return new Response(null, { status: 302, headers: { location } });
}

function json(value: unknown) {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

describe("MCP OAuth metadata discovery", () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        getConfigMock.mockReturnValue({});
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.restoreAllMocks();
    });

    it("follows a redirected well-known path", async () => {
        // Real shape from a hosted MCP server: the RFC 8414 path 302s to a
        // prefixed one. Refusing to follow made the whole server unusable —
        // OAuth could never start, so the popup opened on about:blank.
        const seen: string[] = [];
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input instanceof Request ? input.url : input);
            seen.push(url);
            if (url.endsWith("/.well-known/oauth-protected-resource")) {
                return json({
                    resource: "https://app.example.com/mcp",
                    authorization_servers: ["https://app.example.com"],
                });
            }
            if (url === "https://app.example.com/.well-known/oauth-authorization-server") {
                return redirect("/mcp/.well-known/oauth-authorization-server");
            }
            if (url === "https://app.example.com/mcp/.well-known/oauth-authorization-server") {
                return json(AUTH_SERVER);
            }
            return new Response(null, { status: 401 });
        }) as typeof fetch;

        const metadata = await discoverOAuthMetadata("https://app.example.com/mcp");

        expect(JSON.stringify(metadata)).toContain(
            "https://app.example.com/mcp/authorize",
        );
        expect(seen).toContain(
            "https://app.example.com/mcp/.well-known/oauth-authorization-server",
        );
    });

    it("gives up rather than chasing a redirect loop", async () => {
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith("/.well-known/oauth-protected-resource")) {
                return json({
                    resource: "https://app.example.com/mcp",
                    authorization_servers: ["https://app.example.com"],
                });
            }
            return redirect("/round/and/around");
        }) as typeof fetch;

        await expect(
            discoverOAuthMetadata("https://app.example.com/mcp"),
        ).rejects.toThrow(/redirect|OAuth metadata/i);
    });
});

describe("the fetcher handed to the MCP SDK", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.restoreAllMocks();
    });

    it("follows a redirected GET but never redirects a credential POST", async () => {
        const posts: string[] = [];
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if ((init?.method ?? "GET").toUpperCase() === "POST") {
                posts.push(url);
                return redirect("https://app.example.com/elsewhere");
            }
            return url.endsWith("/moved") ? json(AUTH_SERVER) : redirect("/moved");
        }) as typeof fetch;

        const { guardedDiscoveryFetch } = await import("./client");

        const followed = await guardedDiscoveryFetch("https://app.example.com/start");
        expect(followed.status).toBe(200);

        // A token exchange carries the authorization code: it goes exactly
        // where discovery said, and no further.
        const posted = await guardedDiscoveryFetch("https://app.example.com/token", {
            method: "POST",
            body: "grant_type=authorization_code",
        });
        expect(posted.status).toBe(302);
        expect(posts).toEqual(["https://app.example.com/token"]);
    });
});
