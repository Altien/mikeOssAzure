import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authState,
  validateSkillZipMock,
  storeSkillSnapshotMock,
  listTenantSkillsMock,
  deleteSkillDraftVersionMock,
  analyseSkillVersionMock,
  getSkillReviewMock,
  postSkillReviewMessageMock,
  createSkillRunMock,
  checkProjectAccessMock,
  getGitHubSkillImportPolicyMock,
  setGitHubSkillImportPolicyMock,
  acquireGitHubSkillMock,
  setProjectSkillPinMock,
  listProjectSkillPinsMock,
  disableSkillMock,
  setSkillDependencyMock,
  getGitHubSkillOAuthTokenMock,
  startGitHubSkillOAuthMock,
  completeGitHubSkillOAuthMock,
  disconnectGitHubSkillOAuthMock,
} = vi.hoisted(() => ({
  authState: {
    roles: ["TenantAdmin"] as string[],
    tenantId: "tenant-1",
  },
  validateSkillZipMock: vi.fn(),
  storeSkillSnapshotMock: vi.fn(),
  listTenantSkillsMock: vi.fn(),
  deleteSkillDraftVersionMock: vi.fn(),
  analyseSkillVersionMock: vi.fn(),
  getSkillReviewMock: vi.fn(),
  postSkillReviewMessageMock: vi.fn(),
  createSkillRunMock: vi.fn(),
  checkProjectAccessMock: vi.fn(),
  getGitHubSkillImportPolicyMock: vi.fn(),
  setGitHubSkillImportPolicyMock: vi.fn(),
  acquireGitHubSkillMock: vi.fn(),
  setProjectSkillPinMock: vi.fn(),
  listProjectSkillPinsMock: vi.fn(),
  disableSkillMock: vi.fn(),
  setSkillDependencyMock: vi.fn(),
  getGitHubSkillOAuthTokenMock: vi.fn(),
  startGitHubSkillOAuthMock: vi.fn(),
  completeGitHubSkillOAuthMock: vi.fn(),
  disconnectGitHubSkillOAuthMock: vi.fn(),
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

// `SkillImportDuplicateError` is a real class the route branches on with
// `instanceof`, so it comes from the original module.
vi.mock("./persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./persistence")>()),
  storeSkillSnapshot: storeSkillSnapshotMock,
  listTenantSkills: listTenantSkillsMock,
  deleteSkillDraftVersion: deleteSkillDraftVersionMock,
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

vi.mock("./pins", () => ({
  setProjectSkillPin: setProjectSkillPinMock,
  listProjectSkillPins: listProjectSkillPinsMock,
}));

vi.mock("./lifecycle", () => ({
  disableSkill: disableSkillMock,
}));

vi.mock("./dependencies", () => ({
  setSkillDependency: setSkillDependencyMock,
}));

vi.mock("./githubOAuth", () => ({
  getGitHubSkillOAuthToken: getGitHubSkillOAuthTokenMock,
  startGitHubSkillOAuth: startGitHubSkillOAuthMock,
  completeGitHubSkillOAuth: completeGitHubSkillOAuthMock,
  disconnectGitHubSkillOAuth: disconnectGitHubSkillOAuthMock,
  githubSkillOAuthCallbackUrl: () =>
    "http://localhost/api/altien/skills/settings/github/oauth/callback",
}));

import { SkillImportDuplicateError } from "./persistence";
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
    storeSkillSnapshotMock.mockReset();
    listTenantSkillsMock.mockReset();
    deleteSkillDraftVersionMock.mockReset();
    analyseSkillVersionMock.mockReset();
    getSkillReviewMock.mockReset();
    postSkillReviewMessageMock.mockReset();
    createSkillRunMock.mockReset();
    checkProjectAccessMock.mockReset();
    getGitHubSkillImportPolicyMock.mockReset();
    setGitHubSkillImportPolicyMock.mockReset();
    acquireGitHubSkillMock.mockReset();
    setProjectSkillPinMock.mockReset();
    listProjectSkillPinsMock.mockReset();
    disableSkillMock.mockReset();
    setSkillDependencyMock.mockReset();
    getGitHubSkillOAuthTokenMock.mockReset();
    startGitHubSkillOAuthMock.mockReset();
    completeGitHubSkillOAuthMock.mockReset();
    disconnectGitHubSkillOAuthMock.mockReset();
    getGitHubSkillOAuthTokenMock.mockResolvedValue(null);
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

  it("passes amendment and snapshot commands through verbatim", async () => {
    postSkillReviewMessageMock.mockResolvedValue({
      conversationId: "review-1",
      outcome: "amended",
      supersededActionId: "action-1",
      action: { id: "action-2", payloadHash: "hash-2" },
    });
    const amended = await request(makeApp())
      .post("/api/altien/skills/versions/version-1/review/messages")
      .send({ message: "amend tools list_documents" })
      .expect(200);
    expect(amended.body).toMatchObject({ outcome: "amended" });
    expect(postSkillReviewMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        versionId: "version-1",
        message: "amend tools list_documents",
      }),
    );

    postSkillReviewMessageMock.mockResolvedValue({
      conversationId: "review-1",
      outcome: "snapshot",
      command: { kind: "read", path: "reader/SKILL.md", offset: 0 },
      result: { path: "reader/SKILL.md", text: "..." },
    });
    const snapshot = await request(makeApp())
      .post("/api/altien/skills/versions/version-1/review/messages")
      .send({ message: "read reader/SKILL.md" })
      .expect(200);
    expect(snapshot.body).toMatchObject({ outcome: "snapshot" });

    postSkillReviewMessageMock.mockRejectedValue(
      new Error("Unrecognised amendment."),
    );
    await request(makeApp())
      .post("/api/altien/skills/versions/version-1/review/messages")
      .send({ message: "amend nonsense" })
      .expect(409);
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

  it("allows only a project owner to set an exact version pin", async () => {
    setProjectSkillPinMock.mockResolvedValue({
      projectId: "project-1",
      skillId: "skill-1",
      versionId: "version-1",
    });
    // Dev drift: upstream bdce4fe7 replaced isOwner with projectRole
    checkProjectAccessMock.mockResolvedValue({ ok: true, projectRole: "editor" });
    await request(makeApp())
      .put("/api/altien/skills/projects/project-1/pins/skill-1")
      .send({ versionId: "version-1" })
      .expect(403, { detail: "PROJECT_OWNER_REQUIRED" });
    expect(setProjectSkillPinMock).not.toHaveBeenCalled();

    checkProjectAccessMock.mockResolvedValue({ ok: true, projectRole: "owner" });
    await request(makeApp())
      .put("/api/altien/skills/projects/project-1/pins/skill-1")
      .send({ versionId: "version-1" })
      .expect(200);
    expect(setProjectSkillPinMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        projectId: "project-1",
        skillId: "skill-1",
        versionId: "version-1",
      }),
    );
  });

  it("keeps skill disablement TenantAdmin-only", async () => {
    disableSkillMock.mockResolvedValue({
      skillId: "skill-1",
      disabledVersionId: "version-1",
    });
    await request(makeApp())
      .post("/api/altien/skills/skill-1/disable")
      .expect(200);
    authState.roles = ["Member"];
    await request(makeApp())
      .post("/api/altien/skills/skill-1/disable")
      .expect(403);
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
    storeSkillSnapshotMock.mockResolvedValue({
      id: "snapshot-1",
      skills: [{ id: "skill-1" }],
    });

    const response = await request(makeApp())
      .post("/api/altien/skills/imports/github")
      .send({ url: "https://github.com/example/skill" })
      .expect(201);
    expect(response.body.provenance.resolvedCommitSha).toBe("a".repeat(40));
    expect(storeSkillSnapshotMock).toHaveBeenCalledWith(
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
    storeSkillSnapshotMock.mockResolvedValue({
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
    expect(storeSkillSnapshotMock).toHaveBeenCalledWith(
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

  it("rejects a principal without a tenant before any handler runs", async () => {
    authState.tenantId = "";
    listTenantSkillsMock.mockResolvedValue([]);
    await request(makeApp())
      .get("/api/altien/skills")
      .expect(403, { detail: "TENANT_UNKNOWN" });
    expect(listTenantSkillsMock).not.toHaveBeenCalled();

    await request(makeApp())
      .post("/api/altien/skills/versions/version-1/analyse")
      .expect(403, { detail: "TENANT_UNKNOWN" });
    expect(analyseSkillVersionMock).not.toHaveBeenCalled();
  });

  it("deletes a draft version for a TenantAdmin and refuses with the reason", async () => {
    deleteSkillDraftVersionMock.mockResolvedValue({
      versionId: "version-1",
      skillId: "skill-1",
      skillDeleted: true,
      snapshotDeleted: true,
      deletedDocumentCount: 2,
      deletedBlobCount: 2,
    });

    const deleted = await request(makeApp())
      .delete("/api/altien/skills/versions/version-1")
      .expect(200);
    expect(deleted.body).toMatchObject({ skillDeleted: true });
    expect(deleteSkillDraftVersionMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      versionId: "version-1",
    });

    deleteSkillDraftVersionMock.mockRejectedValue(
      new Error("A project pins this skill version."),
    );
    await request(makeApp())
      .delete("/api/altien/skills/versions/version-1")
      .expect(409, { detail: "A project pins this skill version." });

    authState.roles = ["Member"];
    deleteSkillDraftVersionMock.mockClear();
    await request(makeApp())
      .delete("/api/altien/skills/versions/version-1")
      .expect(403);
    expect(deleteSkillDraftVersionMock).not.toHaveBeenCalled();
  });

  it("answers a duplicate ZIP import with the reason, not a 500", async () => {
    validateSkillZipMock.mockResolvedValue({ treeHash: "hash" });
    storeSkillSnapshotMock.mockRejectedValue(
      new SkillImportDuplicateError(),
    );

    const response = await request(makeApp())
      .post("/api/altien/skills/imports/zip")
      .attach("file", Buffer.from("zip"), "skills.zip");

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      detail: "This exact version was already imported.",
      code: "SKILL_IMPORT_DUPLICATE",
    });
  });

  it("requires the reviewed payload hash before approving a developer artifact", async () => {
    await request(makeApp())
      .post("/api/altien/skills/developer-artifacts/artifact-1/approve")
      .send({})
      .expect(400, {
        detail: "reviewedPayloadHash of the reviewed artifact is required.",
      });
  });
});
