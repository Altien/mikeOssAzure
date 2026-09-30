import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
    createServerSupabaseMock: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) => {
        res.locals.userId = "user-1";
        res.locals.userEmail = "user@example.com";
        next();
    },
}));

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: createServerSupabaseMock,
}));

import { auditRouter } from "../audit";

function makeApp() {
    const app = express();
    app.use("/api/audit", auditRouter);
    app.use(
        (
            _err: unknown,
            _req: express.Request,
            res: express.Response,
            _next: express.NextFunction,
        ) => {
            res.status(500).json({ detail: "Internal server error" });
        },
    );
    return app;
}

describe("audit route rejection handling", () => {
    beforeEach(() => createServerSupabaseMock.mockReset());

    it("returns 500 when a database operation rejects", async () => {
        createServerSupabaseMock.mockReturnValue({
            from: () => {
                throw new Error("database unavailable");
            },
        });

        const response = await request(makeApp()).get("/api/audit");

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ detail: "Internal server error" });
    });
});
