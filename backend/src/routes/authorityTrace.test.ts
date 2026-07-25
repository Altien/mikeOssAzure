import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  validateSupabaseTokenMock,
  upsertUserProfileMock,
  createServerSupabaseMock,
  getCitationVerificationRunMock,
  getAuthorityTraceWorkspaceMock,
  createCitationVerificationReviewMock,
  checkProjectAccessMock,
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  getCitationVerificationRunMock: vi.fn(),
  getAuthorityTraceWorkspaceMock: vi.fn(),
  createCitationVerificationReviewMock: vi.fn(),
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
vi.mock("../lib/citationVerification/reviewService", async () => {
  class ReviewBindingChangedError extends Error {}
  return {
    getAuthorityTraceWorkspace: getAuthorityTraceWorkspaceMock,
    createCitationVerificationReview: createCitationVerificationReviewMock,
    ReviewBindingChangedError,
  };
});
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

function exportWorkspace(integrityOk = true) {
  return {
    id: "run-1",
    project_id: "project-1",
    created_at: "2026-07-25T12:00:00.000Z",
    verified_record: {
      citations: [],
    },
    report: {
      outcome: "success",
      total: 0,
      anchored: 0,
      failed: 0,
      no_quote_claimed: 0,
      exact: 0,
      formatting_different: 0,
    },
    memo: {
      document_id: "memo-id",
      version_id: "memo-v1",
      filename: "memo.md",
      available: true,
      integrity: integrityOk ? "ok" : "changed",
      segments: [{ text: "Memo", highlights: [] }],
    },
    sources: {},
    reviews: [],
    current_reviews: {},
    integrity: {
      ok: integrityOk,
      warnings: integrityOk
        ? []
        : [
            {
              scope: "memo",
              status: "changed",
              message: "Memo changed; highlights are suppressed.",
            },
          ],
    },
  };
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
  getAuthorityTraceWorkspaceMock.mockReset();
  createCitationVerificationReviewMock.mockReset();
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
    getAuthorityTraceWorkspaceMock.mockResolvedValue({
      ...run,
      memo: { available: true, segments: [] },
      sources: {},
      reviews: [],
      current_reviews: {},
    });
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
    expect(response.body).toMatchObject({
      id: "run-1",
      project_id: "project-1",
      memo: { available: true },
      sources: {},
      reviews: [],
    });
    expect(checkProjectAccessMock).toHaveBeenCalledWith(
      "project-1",
      "user-1",
      "user@example.com",
      {},
    );
  });
});

describe("POST /api/authority-trace/runs/:runId/reviews", () => {
  it("appends an authenticated reviewer verdict", async () => {
    getCitationVerificationRunMock.mockResolvedValue({
      id: "run-1",
      project_id: "project-1",
    });
    checkProjectAccessMock.mockResolvedValue({ ok: true });
    createCitationVerificationReviewMock.mockResolvedValue({
      id: "review-1",
      run_id: "run-1",
      citation_id: "c001",
      binds_to: "a".repeat(64),
      verdict: "verified",
      note: "Checked",
      reviewer_user_id: "user-1",
      reviewer_email: "user@example.com",
      created_at: "2026-07-25T13:00:00.000Z",
      stale: false,
    });

    const response = await request(makeApp())
      .post("/api/authority-trace/runs/run-1/reviews")
      .set("Authorization", "Bearer valid-token")
      .send({
        citation_id: "c001",
        binds_to: "a".repeat(64),
        verdict: "verified",
        note: "Checked",
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: "review-1",
      reviewer_user_id: "user-1",
      reviewer_email: "user@example.com",
    });
    expect(createCitationVerificationReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        reviewerUserId: "user-1",
        reviewerEmail: "user@example.com",
      }),
      {},
    );
  });

  it("does not reveal an inaccessible run", async () => {
    getCitationVerificationRunMock.mockResolvedValue({
      id: "run-1",
      project_id: "project-2",
    });
    checkProjectAccessMock.mockResolvedValue({ ok: false });

    const response = await request(makeApp())
      .post("/api/authority-trace/runs/run-1/reviews")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(404);
    expect(createCitationVerificationReviewMock).not.toHaveBeenCalled();
  });
});

describe("Authority Trace HTML exports", () => {
  it.each(["review", "audit"])(
    "does not reveal an inaccessible run through the %s export",
    async (kind) => {
      getCitationVerificationRunMock.mockResolvedValue({
        id: "run-1",
        project_id: "project-2",
      });
      checkProjectAccessMock.mockResolvedValue({ ok: false });

      const response = await request(makeApp())
        .get(`/api/authority-trace/runs/run-1/${kind}.html`)
        .set("Authorization", "Bearer valid-token");

      expect(response.status).toBe(404);
      expect(getAuthorityTraceWorkspaceMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed on drift unless a degraded review is explicit", async () => {
    getCitationVerificationRunMock.mockResolvedValue({
      id: "run-1",
      project_id: "project-1",
    });
    checkProjectAccessMock.mockResolvedValue({ ok: true });
    getAuthorityTraceWorkspaceMock.mockResolvedValue(exportWorkspace(false));

    const blocked = await request(makeApp())
      .get("/api/authority-trace/runs/run-1/review.html")
      .set("Authorization", "Bearer valid-token");
    expect(blocked.status).toBe(409);

    const forced = await request(makeApp())
      .get(
        "/api/authority-trace/runs/run-1/review.html?force_degraded=true",
      )
      .set("Authorization", "Bearer valid-token");
    expect(forced.status).toBe(200);
    expect(forced.headers["content-disposition"]).toContain(
      "authority-trace-run-1-review.html",
    );
    expect(forced.text).toContain("DEGRADED EXPORT");
  });

  it("returns a printable landscape audit with zero reviews", async () => {
    getCitationVerificationRunMock.mockResolvedValue({
      id: "run-1",
      project_id: "project-1",
    });
    checkProjectAccessMock.mockResolvedValue({ ok: true });
    getAuthorityTraceWorkspaceMock.mockResolvedValue(exportWorkspace());

    const response = await request(makeApp())
      .get("/api/authority-trace/runs/run-1/audit.html")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("@page { size: letter landscape;");
  });
});
