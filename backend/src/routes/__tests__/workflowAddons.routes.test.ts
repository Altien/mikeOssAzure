import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, eq } = vi.hoisted(() => ({
  from: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ from }),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "u1";
    next();
  },
}));

import { workflowAddonsRouter } from "../../routes/workflowAddons";

function queryReturning(data: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "order"]) {
    query[method] = vi.fn(() => query);
  }
  query.eq = eq.mockImplementation(() => query);
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data, error: null }).then(resolve, reject);
  return query;
}

const app = express();
app.use(express.json());
app.use("/workflow-addons", workflowAddonsRouter);

describe("workflow add-on catalog routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only active add-ons and preserves the public addon_key field", async () => {
    from.mockImplementation((table: string) => {
      expect(table).toBe("mike_workflows");
      return queryReturning([
        {
          id: "catalog-1",
          workflow_key: "design-partner-draft",
          title: "Design Partner Draft",
          type: "assistant",
          active: true,
        },
      ]);
    });

    const response = await request(app).get("/workflow-addons?type=assistant");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({
        id: "catalog-1",
        addon_key: "design-partner-draft",
        title: "Design Partner Draft",
      }),
    ]);
    expect(response.body[0]).not.toHaveProperty("workflow_key");
    expect(eq).toHaveBeenCalledWith("distribution", "addon");
    expect(eq).toHaveBeenCalledWith("active", true);
    expect(eq).toHaveBeenCalledWith("type", "assistant");
  });
});
