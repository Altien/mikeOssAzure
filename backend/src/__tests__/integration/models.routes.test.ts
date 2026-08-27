import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { getUserApiKeys } = vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
    localAuthOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/userApiKeys", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../lib/userApiKeys")>();
    return { ...actual, getUserApiKeys };
});

vi.mock("../../lib/database", () => ({
    createServerDatabase: vi.fn(() => ({})),
}));

import { openCodeGoModelsHandler } from "../../routes/models";

const originalFetch = global.fetch;

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    global.fetch = originalFetch;
});

function responseHarness() {
    let statusCode = 200;
    let body: unknown;
    const res = {
        locals: { userId: "user-1" },
        status: vi.fn((code: number) => {
            statusCode = code;
            return res;
        }),
        json: vi.fn((value: unknown) => {
            body = value;
            return res;
        }),
    } as unknown as Response;
    return {
        res,
        result: () => ({ statusCode, body }),
    };
}

async function invokeOpenCodeGoHandler() {
    const harness = responseHarness();
    await openCodeGoModelsHandler({} as Request, harness.res);
    return harness.result();
}

describe("GET /models/opencode-go", () => {
    it("loads and normalizes models with the authenticated user's key", async () => {
        getUserApiKeys.mockResolvedValue({ "opencode-go": "ocg-user" });
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    object: "list",
                    data: [{ id: "qwen3.8-max", object: "model" }],
                }),
                { status: 200 },
            ),
        );
        global.fetch = fetchMock;

        const response = await invokeOpenCodeGoHandler();

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({
            models: [
                {
                    id: "opencode-go/qwen3.8-max",
                    label: "qwen3.8-max",
                    group: "OpenCode Go",
                },
            ],
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "https://opencode.ai/zen/go/v1/models",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer ocg-user",
                }),
            }),
        );
    });

    it("does not contact OpenCode Go when no key is configured", async () => {
        getUserApiKeys.mockResolvedValue({ "opencode-go": null });
        const fetchMock = vi.fn();
        global.fetch = fetchMock;

        const response = await invokeOpenCodeGoHandler();

        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({
            detail: "OpenCode Go API key is not configured.",
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps upstream catalog failures to a safe gateway error", async () => {
        getUserApiKeys.mockResolvedValue({ "opencode-go": "ocg-user" });
        global.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response("provider details", { status: 401 }),
            );

        const response = await invokeOpenCodeGoHandler();

        expect(response.statusCode).toBe(502);
        expect(response.body).toEqual({
            detail: "Unable to load the OpenCode Go model catalog.",
        });
    });
});
