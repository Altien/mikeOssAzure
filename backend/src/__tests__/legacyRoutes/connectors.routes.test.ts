import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// The connector OAuth start routes sit behind main's error posture: SDK errors
// embed entire upstream response bodies, so the browser normally gets a fixed
// sanitized string and the operator reads the real message in the log. These
// tests pin the ONE deliberate exception — ConnectorSetupError, repo-authored
// setup text — and prove that everything else stays sanitized.

const startUserMcpConnectorOAuth = vi.fn();
const refreshUserMcpConnectorTools = vi.fn();
const createUserMcpConnector = vi.fn();
const deleteUserMcpConnector = vi.fn();
const mcpConnectorSetupInstructions = vi.fn();

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({})),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/mcpConnectors", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../lib/mcpConnectors")>();
    return {
        ...actual,
        startUserMcpConnectorOAuth: (...args: unknown[]) =>
            startUserMcpConnectorOAuth(...args),
        refreshUserMcpConnectorTools: (...args: unknown[]) =>
            refreshUserMcpConnectorTools(...args),
        createUserMcpConnector: (...args: unknown[]) =>
            createUserMcpConnector(...args),
        deleteUserMcpConnector: (...args: unknown[]) =>
            deleteUserMcpConnector(...args),
        mcpConnectorSetupInstructions: (...args: unknown[]) =>
            mcpConnectorSetupInstructions(...args),
    };
});

import { buildApp } from "../../app";
import { ConnectorSetupError } from "../../lib/mcp/errors";
import { McpOAuthRequiredError } from "../../lib/mcp/oauth";

const ORIGINAL_API_PUBLIC_URL = process.env.API_PUBLIC_URL;
const app = buildApp();

beforeEach(() => {
    vi.clearAllMocks();
    mcpConnectorSetupInstructions.mockReturnValue(null);
    process.env.API_PUBLIC_URL = "http://localhost:3000/api";
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_API_PUBLIC_URL === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = ORIGINAL_API_PUBLIC_URL;
});

// Dev drift: Dev mounts the user router under /api/user (and /api/users).
describe("POST /api/user/mcp-connectors", () => {
    const connector = {
        id: "c1",
        name: "Private server",
        serverUrl: "https://mcp.example.test/mcp",
    };

    it("returns provider setup guidance before inserting a Slack connector", async () => {
        mcpConnectorSetupInstructions.mockReturnValue(
            "Slack MCP requires administrator setup.",
        );
        const res = await request(app).post("/api/user/mcp-connectors").send({
            name: "Slack",
            serverUrl: "https://mcp.slack.com/mcp",
        });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("connector_setup_required");
        expect(res.body.detail).toContain("administrator setup");
        expect(res.body.detail).not.toContain("localhost");
        expect(createUserMcpConnector).not.toHaveBeenCalled();
    });

    it("deletes the new connector when initial credential validation fails", async () => {
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockRejectedValue(
            new Error("Bearer token is required"),
        );
        deleteUserMcpConnector.mockResolvedValue(undefined);

        const res = await request(app).post("/api/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(400);
        expect(deleteUserMcpConnector).toHaveBeenCalledWith("u1", "c1", {});
    });

    it("exposes the retained connector when failed validation cannot be cleaned up", async () => {
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockRejectedValue(
            new Error("Bearer token is required"),
        );
        deleteUserMcpConnector.mockRejectedValue(new Error("delete failed"));

        const res = await request(app).post("/api/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            code: "connector_cleanup_failed",
            connectorId: "c1",
            detail: expect.stringContaining("Remove it from Installed"),
        });
        expect(deleteUserMcpConnector).toHaveBeenCalledWith("u1", "c1", {});
    });

    it("keeps the new connector when OAuth authorization is required", async () => {
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockRejectedValue(
            new McpOAuthRequiredError(),
        );

        const res = await request(app).post("/api/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            connector,
            oauthRequired: true,
        });
        expect(deleteUserMcpConnector).not.toHaveBeenCalled();
    });

    it("returns the refreshed connector when initial validation succeeds", async () => {
        const refreshedConnector = { ...connector, tools: [{ id: "search" }] };
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockResolvedValue(refreshedConnector);

        const res = await request(app).post("/api/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            connector: refreshedConnector,
            oauthRequired: false,
        });
        expect(refreshUserMcpConnectorTools).toHaveBeenCalledTimes(1);
        expect(deleteUserMcpConnector).not.toHaveBeenCalled();
    });
});

describe("POST /user/mcp-connectors/:id/oauth/start", () => {
    it("returns concise setup guidance without a deployment-specific redirect URI", async () => {
        startUserMcpConnectorOAuth.mockImplementation(
            async () => {
                throw new ConnectorSetupError(
                    "Slack MCP requires administrator setup.",
                );
            },
        );

        const res = await request(app).post("/api/user/mcp-connectors/c1/oauth/start");

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("connector_setup_required");
        expect(res.body.detail).toContain("administrator setup");
        expect(res.body.detail).not.toContain("localhost");
    });

    it("keeps every other failure sanitized", async () => {
        startUserMcpConnectorOAuth.mockRejectedValue(
            new Error(
                "HTTP 400 <html><body>Error 400 (Bad Request)!!1</body></html>",
            ),
        );

        const res = await request(app).post("/api/user/mcp-connectors/c1/oauth/start");

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            detail: "Connector authorization could not be started.",
        });
    });
});

describe("POST /user/mcp-connectors/:id/refresh-tools", () => {
    it("signals 'authorize this connector' without a 401, so the browser keeps its session", async () => {
        // Regression: this answered 401 { code: "oauth_required" }. Since
        // authentication moved to HttpOnly cookies, the frontend's
        // authenticatedFetch treats ANY 401 from the API as an expired Mike
        // session and logs the user out — so every OAuth connector's first
        // refresh (the step that opens the consent popup) bounced the user
        // to the login page instead. The client keys on `code`, not status.
        refreshUserMcpConnectorTools.mockRejectedValue(
            new McpOAuthRequiredError(),
        );

        const res = await request(app).post(
            "/api/user/mcp-connectors/c1/refresh-tools",
        );

        expect(res.status).not.toBe(401);
        // Dev drift: Dev's own fix (f5ae7667) answered 428; upstream #295
        // fixed the same bug with 409 and Dev adopted it. The invariant is
        // "not 401, keyed on code" — the frontend only reads `code`.
        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            code: "oauth_required",
            detail: "This connector needs to be authorized again.",
        });
    });
});
