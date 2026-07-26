import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authState,
  validateSkillZipMock,
  storeZipSkillSnapshotMock,
  listTenantSkillsMock,
} = vi.hoisted(() => ({
  authState: {
    roles: ["TenantAdmin"] as string[],
    tenantId: "tenant-1",
  },
  validateSkillZipMock: vi.fn(),
  storeZipSkillSnapshotMock: vi.fn(),
  listTenantSkillsMock: vi.fn(),
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

import { skillsRouter } from "./router";

function makeApp() {
  const app = express();
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
