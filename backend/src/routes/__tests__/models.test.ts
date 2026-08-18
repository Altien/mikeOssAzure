import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserApiKeys } = vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        next();
    },
}));

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({ from: vi.fn() })),
}));

vi.mock("../../lib/userApiKeys", () => ({
    getUserApiKeys: (...args: unknown[]) => getUserApiKeys(...args),
}));

import { modelsRouter } from "../models";

const app = express();
app.use("/models", modelsRouter);

describe("GET /models/openrouter", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ openrouter: "or-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("requires a configured OpenRouter key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns the authenticated OpenRouter catalog in selector shape", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: "anthropic/claude-sonnet-4.5",
                            name: "Claude Sonnet 4.5",
                        },
                        { id: "openai/gpt-5.4" },
                        { id: null, name: "Invalid" },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
            { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("https://openrouter.ai/api/v1/models?"),
            { headers: { Authorization: "Bearer or-user-key" } },
        );
    });

    it("does not expose upstream authentication failures as a success", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    new Response("invalid key", { status: 401 }),
                ),
        );

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(502);
        expect(response.body.detail).toContain(
            "OpenRouter model catalog request failed (401)",
        );
    });
});

describe("GET /models/vercel", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ vercel: "vercel-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("requires a configured Vercel AI Gateway key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/vercel");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns text, tool-capable models from Vercel's public catalog", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        data: [
                            {
                                id: "anthropic/claude-sonnet-4.5",
                                name: "Claude Sonnet 4.5",
                                type: "language",
                                tags: ["tool-use"],
                                modalities: { output: ["text"] },
                            },
                            {
                                id: "openai/gpt-5.4",
                                type: "language",
                                supported_parameters: ["tools"],
                            },
                            {
                                id: "image/model",
                                type: "image",
                                modalities: { output: ["image"] },
                            },
                            {
                                id: "text/no-tools",
                                type: "language",
                                modalities: { output: ["text"] },
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    },
                ),
            ),
        );

        const response = await request(app).get("/models/vercel");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
            { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
        ]);
        expect(fetch).toHaveBeenCalledWith(
            "https://ai-gateway.vercel.sh/v1/models",
        );
    });
});
