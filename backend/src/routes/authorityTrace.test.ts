import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  validateSupabaseTokenMock,
  upsertUserProfileMock,
  createServerSupabaseMock,
  getCitationVerificationRunMock,
  checkProjectAccessMock,
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  getCitationVerificationRunMock: vi.fn(),
  checkProjectAccessMock: vi.fn(),
}));

vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: validateSupabaseTokenMock,
}));
vi.mock("../lib/userSettings.js", () => ({
  upsertUserProfile: upsertUserProfileMock,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../lib/citationVerification/service", () => ({
  getCitationVerificationRun: getCitationVerificationRunMock,
}));
vi.mock("../lib/access", () => ({
  checkProjectAccess: checkProjectAccessMock,
}));

import { authorityTraceRouter } from "./authorityTrace";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/authority-trace", authorityTraceRouter);
  return app;
}

beforeEach(() => {
  process.env.AUTH_PROVIDER = "supabase";
  validateSupabaseTokenMock.mockReset().mockResolvedValue({
    ok: true,
    principal: {
      userId: "user-1",
      email: "user@example.com",
      groups: [],
      roles: [],
      provider: "supabase",
    },
  });
  upsertUserProfileMock.mockReset().mockResolvedValue(undefined);
  createServerSupabaseMock.mockReset().mockReturnValue({});
  getCitationVerificationRunMock.mockReset();
  checkProjectAccessMock.mockReset();
});

describe("GET /api/authority-trace/runs/:runId", () => {
  it("requires authentication", async () => {
    const response = await request(makeApp()).get(
      "/api/authority-trace/runs/run-1",
    );

    expect(response.status).toBe(401);
    expect(getCitationVerificationRunMock).not.toHaveBeenCalled();
  });

  it("returns 404 without revealing a run from an inaccessible project", async () => {
    getCitationVerificationRunMock.mockResolvedValue({
      id: "run-1",
      project_id: "project-2",
      verified_record: { schema_version: 1 },
      report: { outcome: "success" },
      created_at: "2026-07-25T12:00:00.000Z",
    });
    checkProjectAccessMock.mockResolvedValue({ ok: false });

    const response = await request(makeApp())
      .get("/api/authority-trace/runs/run-1")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Verification run not found" });
  });

  it("returns an accessible run without source document bytes", async () => {
    const run = {
      id: "run-1",
      project_id: "project-1",
      verified_record: { schema_version: 1, citations: [] },
      report: { outcome: "success", total: 0 },
      created_at: "2026-07-25T12:00:00.000Z",
    };
    getCitationVerificationRunMock.mockResolvedValue(run);
    checkProjectAccessMock.mockResolvedValue({
      ok: true,
      isOwner: false,
      project: {
        id: "project-1",
        user_id: "owner-1",
        shared_with: ["user@example.com"],
      },
    });

    const response = await request(makeApp())
      .get("/api/authority-trace/runs/run-1")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(run);
    expect(checkProjectAccessMock).toHaveBeenCalledWith(
      "project-1",
      "user-1",
      "user@example.com",
      {},
    );
  });
});
