import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getConfigMock, undiciFetchMock } = vi.hoisted(() => ({ getConfigMock: vi.fn(), undiciFetchMock: vi.fn() }));
vi.mock("../config", () => ({ getConfig: getConfigMock }));
vi.mock("undici", async (importOriginal) => ({ ...await importOriginal<typeof import("undici")>(), fetch: undiciFetchMock }));
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
    beforeEach(() => {
        getConfigMock.mockReturnValue({});
        undiciFetchMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("follows a redirected well-known path", async () => {
        // Real shape from a hosted MCP server: the RFC 8414 path 302s to a
        // prefixed one. Refusing to follow made the whole server unusable —
        // OAuth could never start, so the popup opened on about:blank.
        const seen: string[] = [];
        undiciFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
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
        });

        const metadata = await discoverOAuthMetadata("https://app.example.com/mcp");

        expect(JSON.stringify(metadata)).toContain(
            "https://app.example.com/mcp/authorize",
        );
        expect(seen).toContain(
            "https://app.example.com/mcp/.well-known/oauth-authorization-server",
        );
    });

    it("gives up rather than chasing a redirect loop", async () => {
        undiciFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith("/.well-known/oauth-protected-resource")) {
                return json({
                    resource: "https://app.example.com/mcp",
                    authorization_servers: ["https://app.example.com"],
                });
            }
            return redirect("/round/and/around");
        });

        await expect(
            discoverOAuthMetadata("https://app.example.com/mcp"),
        ).rejects.toThrow(/redirect|OAuth metadata/i);
    });
});

describe("the fetcher handed to the MCP SDK", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("follows a redirected GET but never redirects a credential POST", async () => {
        const posts: string[] = [];
        undiciFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if ((init?.method ?? "GET").toUpperCase() === "POST") {
                posts.push(url);
                return redirect("https://app.example.com/elsewhere");
            }
            return url.endsWith("/moved") ? json(AUTH_SERVER) : redirect("/moved");
        });

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
