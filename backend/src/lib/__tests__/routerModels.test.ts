import { describe, expect, it, vi } from "vitest";
import {
    getUserRouterModels,
    replaceUserRouterModels,
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
