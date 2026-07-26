import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authState,
  validateSkillZipMock,
  storeZipSkillSnapshotMock,
  listTenantSkillsMock,
  analyseSkillVersionMock,
  getSkillReviewMock,
  postSkillReviewMessageMock,
  createSkillRunMock,
  checkProjectAccessMock,
  getGitHubSkillImportPolicyMock,
  setGitHubSkillImportPolicyMock,
  acquireGitHubSkillMock,
} = vi.hoisted(() => ({
  authState: {
    roles: ["TenantAdmin"] as string[],
    tenantId: "tenant-1",
  },
  validateSkillZipMock: vi.fn(),
  storeZipSkillSnapshotMock: vi.fn(),
  listTenantSkillsMock: vi.fn(),
  analyseSkillVersionMock: vi.fn(),
  getSkillReviewMock: vi.fn(),
  postSkillReviewMessageMock: vi.fn(),
  createSkillRunMock: vi.fn(),
  checkProjectAccessMock: vi.fn(),
  getGitHubSkillImportPolicyMock: vi.fn(),
  setGitHubSkillImportPolicyMock: vi.fn(),
  acquireGitHubSkillMock: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.locals.userId = "admin-1";
    res.locals.principal = {
      userId: "admin-1",
      tenantId: authState.tenantId,
      roles: authState.roles,
    };
    next();
  },
}));

vi.mock("./archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./archive")>()),
  validateSkillZip: validateSkillZipMock,
}));

vi.mock("./persistence", () => ({
  storeZipSkillSnapshot: storeZipSkillSnapshotMock,
  listTenantSkills: listTenantSkillsMock,
}));

vi.mock("./review", () => ({
  analyseSkillVersion: analyseSkillVersionMock,
  getSkillReview: getSkillReviewMock,
  postSkillReviewMessage: postSkillReviewMessageMock,
  createSkillRun: createSkillRunMock,
}));

vi.mock("../../lib/access", () => ({
  checkProjectAccess: checkProjectAccessMock,
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ fake: true }),
}));

vi.mock("./settings", () => ({
  getGitHubSkillImportPolicy: getGitHubSkillImportPolicyMock,
  setGitHubSkillImportPolicy: setGitHubSkillImportPolicyMock,
}));

vi.mock("./github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github")>()),
  acquireGitHubSkill: acquireGitHubSkillMock,
}));

import { skillsRouter } from "./router";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/altien/skills", skillsRouter);
  return app;
}

describe("Skills routes", () => {
  beforeEach(() => {
    authState.roles = ["TenantAdmin"];
    authState.tenantId = "tenant-1";
    validateSkillZipMock.mockReset();
    storeZipSkillSnapshotMock.mockReset();
    listTenantSkillsMock.mockReset();
    analyseSkillVersionMock.mockReset();
    getSkillReviewMock.mockReset();
    postSkillReviewMessageMock.mockReset();
    createSkillRunMock.mockReset();
    checkProjectAccessMock.mockReset();
    getGitHubSkillImportPolicyMock.mockReset();
    setGitHubSkillImportPolicyMock.mockReset();
    acquireGitHubSkillMock.mockReset();
    getGitHubSkillImportPolicyMock.mockResolvedValue({
      deploymentAllowed: false,
      tenantEnabled: false,
      effectiveEnabled: false,
      privateRepositoryConnectionConfigured: false,
    });
  });

  it("keeps review and analysis TenantAdmin-only", async () => {
    analyseSkillVersionMock.mockResolvedValue({ conversationId: "review-1" });
    await request(makeApp())
      .post("/api/altien/skills/versions/version-1/analyse")
      .expect(200);
    expect(analyseSkillVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
      }),
    );

    authState.roles = ["Member"];
    await request(makeApp())
      .post("/api/altien/skills/versions/version-1/analyse")
      .expect(403);
    await request(makeApp())
      .post("/api/altien/skills/versions/version-1/review/messages")
      .send({ message: "yes" })
      .expect(403);
  });

  it("starts a run only after project access passes", async () => {
    checkProjectAccessMock.mockResolvedValue({ ok: true });
    createSkillRunMock.mockResolvedValue({
      chatId: "chat-1",
      projectId: "project-1",
    });
    authState.roles = ["Member"];

    const response = await request(makeApp())
      .post("/api/altien/skills/versions/version-1/run")
      .send({ projectId: "project-1" })
      .expect(201);
    expect(response.body.chatId).toBe("chat-1");
    expect(createSkillRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        versionId: "version-1",
        projectId: "project-1",
      }),
    );

    checkProjectAccessMock.mockResolvedValue({ ok: false });
    await request(makeApp())
      .post("/api/altien/skills/versions/version-1/run")
      .send({ projectId: "other-project" })
      .expect(404);
  });

  it("enforces both GitHub import gates before acquisition", async () => {
    await request(makeApp())
      .post("/api/altien/skills/imports/github")
      .send({ url: "https://github.com/example/skill" })
      .expect(403, { detail: "GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED" });
    expect(acquireGitHubSkillMock).not.toHaveBeenCalled();

    getGitHubSkillImportPolicyMock.mockResolvedValue({
      deploymentAllowed: true,
      tenantEnabled: false,
      effectiveEnabled: false,
      privateRepositoryConnectionConfigured: false,
    });
    await request(makeApp())
      .post("/api/altien/skills/imports/github")
      .send({ url: "https://github.com/example/skill" })
      .expect(403, { detail: "GITHUB_SKILL_IMPORT_TENANT_DISABLED" });
    expect(acquireGitHubSkillMock).not.toHaveBeenCalled();
  });

  it("imports a commit-pinned GitHub snapshot through the DMS pipeline", async () => {
    getGitHubSkillImportPolicyMock.mockResolvedValue({
      deploymentAllowed: true,
      tenantEnabled: true,
      effectiveEnabled: true,
      privateRepositoryConnectionConfigured: false,
    });
    acquireGitHubSkillMock.mockResolvedValue({
      sourceBytes: new Uint8Array([1, 2, 3]),
      snapshot: { treeHash: "hash" },
      provenance: {
        repository: "github.com/example/skill",
        selectedPath: "",
        requestedRef: "main",
        resolvedCommitSha: "a".repeat(40),
        private: false,
      },
    });
    storeZipSkillSnapshotMock.mockResolvedValue({
      id: "snapshot-1",
      skills: [{ id: "skill-1" }],
    });

    const response = await request(makeApp())
      .post("/api/altien/skills/imports/github")
      .send({ url: "https://github.com/example/skill" })
      .expect(201);
    expect(response.body.provenance.resolvedCommitSha).toBe("a".repeat(40));
    expect(storeZipSkillSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "github",
        github: expect.objectContaining({
          resolvedCommitSha: "a".repeat(40),
        }),
      }),
    );
  });

  it("imports a ZIP for a TenantAdmin", async () => {
    validateSkillZipMock.mockResolvedValue({ treeHash: "hash" });
    storeZipSkillSnapshotMock.mockResolvedValue({
      id: "snapshot-1",
      skills: [{ id: "skill-1" }],
    });

    const response = await request(makeApp())
      .post("/api/altien/skills/imports/zip")
      .attach("file", Buffer.from("zip"), "skills.zip");

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: "snapshot-1",
      skills: [{ id: "skill-1" }],
    });
    expect(storeZipSkillSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        importedBy: "admin-1",
        sourceFilename: "skills.zip",
      }),
    );
  });

  it("rejects member imports before parsing the upload", async () => {
    authState.roles = ["Member"];
    const response = await request(makeApp())
      .post("/api/altien/skills/imports/zip")
      .attach("file", Buffer.from("zip"), "skills.zip");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ detail: "ROLE_REQUIRED" });
    expect(validateSkillZipMock).not.toHaveBeenCalled();
  });

  it("lists drafts for admins and only enabled versions for members", async () => {
    listTenantSkillsMock.mockResolvedValue([]);
    const adminResponse = await request(makeApp())
      .get("/api/altien/skills")
      .expect(200);
    expect(adminResponse.body).toEqual({ skills: [], canManage: true });
    expect(listTenantSkillsMock).toHaveBeenLastCalledWith("tenant-1", {
      includeDrafts: true,
    });

    authState.roles = ["Member"];
    const memberResponse = await request(makeApp())
      .get("/api/altien/skills")
      .expect(200);
    expect(memberResponse.body).toEqual({ skills: [], canManage: false });
    expect(listTenantSkillsMock).toHaveBeenLastCalledWith("tenant-1", {
      includeDrafts: false,
    });
  });
});
