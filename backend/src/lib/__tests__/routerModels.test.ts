import { describe, expect, it, vi } from "vitest";
import {
    getUserRouterModels,
    replaceUserRouterModels,
    resolveRequestedModel,
} from "../routerModels";

function queryResult(data: unknown[], error: unknown = null) {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) {
        query[method] = vi.fn(() => query);
    }
    query.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data, error }).then(resolve, reject);
    return query;
}

describe("router model persistence", () => {
    it("returns one router's models in database order", async () => {
        const query = queryResult([
            { model_id: "anthropic/claude-sonnet-4.5" },
            { model_id: " openai/gpt-5.4 " },
            { model_id: null },
        ]);
        const db = {
            from: vi.fn(() => query),
        };

        await expect(
            getUserRouterModels("user-1", "vercel", db as never),
        ).resolves.toEqual([
            "anthropic/claude-sonnet-4.5",
            "openai/gpt-5.4",
        ]);
        expect(db.from).toHaveBeenCalledWith("user_router_models");
        expect(query.eq).toHaveBeenCalledWith("router", "vercel");
        expect(query.order).toHaveBeenCalledWith("sort_order", {
            ascending: true,
        });
    });

    it.each([
        {
            label: "Postgres undefined_table",
            error: {
                code: "42P01",
                message: 'relation "public.user_router_models" does not exist',
            },
        },
        {
            label: "PostgREST missing relation",
            error: {
                code: "PGRST205",
                message:
                    "Could not find the table 'public.user_router_models' in the schema cache",
            },
        },
    ])(
        "returns empty selections when the table is missing ($label)",
        async ({ error }) => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const db = { from: vi.fn(() => queryResult([], error)) };

            await expect(
                getUserRouterModels("user-1", "openrouter", db as never),
            ).resolves.toEqual([]);
            warn.mockRestore();
        },
    );

    it("still surfaces unrelated read errors", async () => {
        const db = {
            from: vi.fn(() =>
                queryResult([], { code: "57014", message: "canceled" }),
            ),
        };

        await expect(
            getUserRouterModels("user-1", "openrouter", db as never),
        ).rejects.toMatchObject({ code: "57014" });
    });

    it("uses the atomic router-neutral replacement function", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
        const db = { rpc };

        await replaceUserRouterModels(
            "user-1",
            "vercel",
            ["openai/gpt-5.4"],
            db as never,
        );

        expect(rpc).toHaveBeenCalledWith("replace_user_router_models", {
            target_user_id: "user-1",
            target_router: "vercel",
            target_model_ids: ["openai/gpt-5.4"],
        });
    });

    it("surfaces database replacement errors", async () => {
        const db = {
            rpc: vi.fn().mockResolvedValue({
                data: null,
                error: new Error("write failed"),
            }),
        };

        await expect(
            replaceUserRouterModels("user-1", "openrouter", [], db as never),
        ).rejects.toThrow("write failed");
    });
});

describe("resolveRequestedModel outside-selection behaviour", () => {
    const db = (rows: { model_id: string }[]) => ({
        from: vi.fn(() => queryResult(rows)),
    });

    it("returns a model that is in the saved selection", async () => {
        await expect(
            resolveRequestedModel(
                "openrouter/allowed/model",
                "gemini-3-flash-preview",
                "user-1",
                db([{ model_id: "allowed/model" }]) as never,
                "throw",
            ),
        ).resolves.toBe("openrouter/allowed/model");
    });

    it("throws an actionable error for an explicitly requested non-member", async () => {
        await expect(
            resolveRequestedModel(
                "vercel/pricy/frontier",
                "gemini-3-flash-preview",
                "user-1",
                db([]) as never,
                "throw",
            ),
        ).rejects.toThrow(
            "Model vercel/pricy/frontier is not in your saved Vercel AI Gateway models — add it in Settings → BYOK → Routers.",
        );
    });

    it("still degrades silently for stored preferences", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(
            resolveRequestedModel(
                "openrouter/pricy/frontier",
                "gemini-3-flash-preview",
                "user-1",
                db([]) as never,
            ),
        ).resolves.toBe("gemini-3-flash-preview");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
