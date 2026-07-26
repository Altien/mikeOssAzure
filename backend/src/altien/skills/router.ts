import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { safeErrorMessage } from "../../lib/safeError";
import { checkProjectAccess } from "../../lib/access";
import { createServerSupabase } from "../../lib/supabase";
import {
  SKILL_IMPORT_LIMITS,
  SkillArchiveValidationError,
  validateSkillZip,
} from "./archive";
import { listTenantSkills, storeZipSkillSnapshot } from "./persistence";
import {
  analyseSkillVersion,
  createSkillRun,
  getSkillReview,
  postSkillReviewMessage,
} from "./review";
import {
  buildMikeSkillPackage,
  buildOriginalSkillPackage,
  buildDeveloperSkillPackage,
  getSkillPackageInfo,
} from "./packages";
import { buildContentDisposition } from "../../lib/storage";
import {
  getGitHubSkillImportPolicy,
  setGitHubSkillImportPolicy,
} from "./settings";
import {
  acquireGitHubSkill,
  GitHubSkillImportError,
} from "./github";
import { setSkillDependency } from "./dependencies";
import {
  listProjectSkillPins,
  setProjectSkillPin,
} from "./pins";
import { disableSkill } from "./lifecycle";
import {
  approveCleanRoomDeveloperArtifact,
  createCleanRoomDeveloperArtifact,
  getCleanRoomDeveloperArtifact,
  persistSkillRename,
} from "./artifacts";
import {
  completeGitHubSkillOAuth,
  disconnectGitHubSkillOAuth,
  getGitHubSkillOAuthToken,
  githubSkillOAuthCallbackUrl,
  startGitHubSkillOAuth,
} from "./githubOAuth";
import crypto from "node:crypto";
import { checkGitHubSkillVersionUpdate } from "./updates";

const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: SKILL_IMPORT_LIMITS.compressedBytes,
  },
});

function uploadOne(req: Request, res: Response, next: NextFunction) {
  zipUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const detail =
        error.code === "LIMIT_FILE_SIZE"
          ? `ZIP exceeds the ${SKILL_IMPORT_LIMITS.compressedBytes} byte limit.`
          : `Skill upload failed: ${error.message}`;
      return void res
        .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({ detail });
    }
    next(error);
  });
}

function tenantId(res: Response): string | null {
  const value = res.locals.principal?.tenantId;
  return typeof value === "string" && value.trim() ? value : null;
}

export const skillsRouter = Router();

skillsRouter.get("/", requireAuth, async (_req, res) => {
  const tenant = tenantId(res);
  if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
  const roles: string[] = res.locals.principal?.roles ?? [];
  try {
    const skills = await listTenantSkills(tenant, {
      includeDrafts: roles.includes("TenantAdmin"),
    });
    res.json({
      skills,
      canManage: roles.includes("TenantAdmin"),
    });
  } catch (error) {
    res
      .status(500)
      .json({ detail: safeErrorMessage(error, "Failed to list skills") });
  }
});

skillsRouter.post(
  "/imports/zip",
  requireAuth,
  requireRole("TenantAdmin"),
  uploadOne,
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    if (!req.file) {
      return void res.status(400).json({ detail: "ZIP file is required." });
    }
    const sourceFilename = req.file.originalname || "skills.zip";
    if (!sourceFilename.toLowerCase().endsWith(".zip")) {
      return void res.status(400).json({ detail: "A .zip file is required." });
    }
    try {
      const sourceBytes = new Uint8Array(
        req.file.buffer.buffer,
        req.file.buffer.byteOffset,
        req.file.buffer.byteLength,
      );
      const snapshot = await validateSkillZip(sourceBytes);
      const stored = await storeZipSkillSnapshot({
        tenantId: tenant,
        importedBy: String(res.locals.userId),
        sourceFilename,
        sourceBytes,
        snapshot,
      });
      res.status(201).json(stored);
    } catch (error) {
      if (error instanceof SkillArchiveValidationError) {
        return void res.status(400).json({
          detail: error.message,
          code: error.code,
        });
      }
      res
        .status(500)
        .json({ detail: safeErrorMessage(error, "Failed to import skill") });
    }
  },
);

skillsRouter.get("/settings/github", requireAuth, async (_req, res) => {
  const tenant = tenantId(res);
  if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
  try {
    res.json({
      ...(await getGitHubSkillImportPolicy(tenant)),
      canManage: (res.locals.principal?.roles ?? []).includes("TenantAdmin"),
    });
  } catch (error) {
    res
      .status(500)
      .json({ detail: safeErrorMessage(error, "Failed to read GitHub policy") });
  }
});

skillsRouter.put(
  "/settings/github",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    if (typeof req.body?.enabled !== "boolean") {
      return void res.status(400).json({ detail: "enabled must be boolean." });
    }
    try {
      res.json(
        await setGitHubSkillImportPolicy({
          tenantId: tenant,
          enabled: req.body.enabled,
          updatedBy: String(res.locals.userId),
        }),
      );
    } catch (error) {
      res.status(500).json({
        detail: safeErrorMessage(error, "Failed to update GitHub policy"),
      });
    }
  },
);

function githubOAuthPopupHtml(
  payload: { success: boolean; detail?: string },
  nonce: string,
) {
  const serialized = JSON.stringify({
    type: "github_skill_oauth_result",
    ...payload,
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html><body><p>GitHub connection complete. You may close this window.</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${serialized},"*");}window.close();</script></body></html>`;
}

skillsRouter.post(
  "/settings/github/oauth/start",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      res.json(
        await startGitHubSkillOAuth({
          tenantId: tenant,
          userId: String(res.locals.userId),
          redirectUri: githubSkillOAuthCallbackUrl(req),
        }),
      );
    } catch (error) {
      res.status(400).json({
        detail: safeErrorMessage(error, "GitHub OAuth could not start"),
      });
    }
  },
);

skillsRouter.get("/settings/github/oauth/callback", async (req, res) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const providerError =
    typeof req.query.error_description === "string"
      ? req.query.error_description
      : typeof req.query.error === "string"
        ? req.query.error
        : "";
  try {
    if (providerError) throw new Error(providerError);
    if (!state || !code) throw new Error("GitHub OAuth callback is incomplete.");
    await completeGitHubSkillOAuth({ state, code });
    res
      .set(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .set("Cross-Origin-Opener-Policy", "unsafe-none")
      .type("html")
      .send(githubOAuthPopupHtml({ success: true }, nonce));
  } catch (error) {
    res
      .status(400)
      .set(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .set("Cross-Origin-Opener-Policy", "unsafe-none")
      .type("html")
      .send(
        githubOAuthPopupHtml(
          {
            success: false,
            detail: safeErrorMessage(error, "GitHub OAuth failed"),
          },
          nonce,
        ),
      );
  }
});

skillsRouter.delete(
  "/settings/github/oauth",
  requireAuth,
  requireRole("TenantAdmin"),
  async (_req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      await disconnectGitHubSkillOAuth(tenant);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({
        detail: safeErrorMessage(error, "GitHub OAuth disconnect failed"),
      });
    }
  },
);

skillsRouter.post(
  "/imports/github",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url || url.length > 2_000) {
      return void res.status(400).json({ detail: "A GitHub URL is required." });
    }
    try {
      const policy = await getGitHubSkillImportPolicy(tenant);
      if (!policy.deploymentAllowed) {
        return void res
          .status(403)
          .json({ detail: "GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED" });
      }
      if (!policy.tenantEnabled) {
        return void res
          .status(403)
          .json({ detail: "GITHUB_SKILL_IMPORT_TENANT_DISABLED" });
      }
      const acquired = await acquireGitHubSkill({
        url,
        token: (await getGitHubSkillOAuthToken(tenant)) ?? undefined,
      });
      const stored = await storeZipSkillSnapshot({
        tenantId: tenant,
        importedBy: String(res.locals.userId),
        sourceFilename: `${acquired.provenance.repository.replace(/[^a-z0-9.-]+/gi, "-")}-${acquired.provenance.resolvedCommitSha.slice(0, 12)}.zip`,
        sourceBytes: acquired.sourceBytes,
        snapshot: acquired.snapshot,
        sourceKind: "github",
        github: acquired.provenance,
      });
      res.status(201).json({ ...stored, provenance: acquired.provenance });
    } catch (error) {
      if (error instanceof GitHubSkillImportError) {
        return void res.status(400).json({
          detail: error.message,
          code: error.code,
        });
      }
      if (error instanceof SkillArchiveValidationError) {
        return void res.status(400).json({
          detail: error.message,
          code: error.code,
        });
      }
      res.status(500).json({
        detail: safeErrorMessage(error, "GitHub skill import failed"),
      });
    }
  },
);

skillsRouter.get("/versions/:versionId/packages", requireAuth, async (req, res) => {
  const tenant = tenantId(res);
  if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
  try {
    const info = await getSkillPackageInfo({
      tenantId: tenant,
      versionId: req.params.versionId,
    });
    const roles: string[] = res.locals.principal?.roles ?? [];
    if (info.state !== "enabled" && !roles.includes("TenantAdmin")) {
      return void res.status(404).json({ detail: "Skill version not found." });
    }
    res.json(info);
  } catch (error) {
    res
      .status(404)
      .json({ detail: safeErrorMessage(error, "Skill package not found") });
  }
});

skillsRouter.get(
  "/versions/:versionId/packages/:kind",
  requireAuth,
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    if (
      req.params.kind !== "original" &&
      req.params.kind !== "mike" &&
      req.params.kind !== "developer"
    ) {
      return void res.status(404).json({ detail: "Unknown package kind." });
    }
    try {
      const info = await getSkillPackageInfo({
        tenantId: tenant,
        versionId: req.params.versionId,
      });
      const roles: string[] = res.locals.principal?.roles ?? [];
      if (info.state !== "enabled" && !roles.includes("TenantAdmin")) {
        return void res.status(404).json({ detail: "Skill version not found." });
      }
      const result = req.params.kind === "original"
        ? await buildOriginalSkillPackage({
            tenantId: tenant,
            versionId: req.params.versionId,
          })
        : req.params.kind === "mike"
          ? await buildMikeSkillPackage({
              tenantId: tenant,
              versionId: req.params.versionId,
            })
          : await buildDeveloperSkillPackage({
              tenantId: tenant,
              versionId: req.params.versionId,
            });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", result.filename),
      );
      res.send(Buffer.from(result.bytes));
    } catch (error) {
      res
        .status(404)
        .json({ detail: safeErrorMessage(error, "Skill package not found") });
    }
  },
);

skillsRouter.post(
  "/developer-artifacts/:artifactId/approve",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      res.json(
        await approveCleanRoomDeveloperArtifact({
          tenantId: tenant,
          artifactId: req.params.artifactId,
          approvedBy: String(res.locals.userId),
        }),
      );
    } catch (error) {
      res.status(409).json({
        detail: safeErrorMessage(error, "Developer artifact approval failed"),
      });
    }
  },
);

skillsRouter.get(
  "/developer-artifacts/:artifactId",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      const artifact = await getCleanRoomDeveloperArtifact({
        tenantId: tenant,
        artifactId: req.params.artifactId,
      });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", artifact.filename),
      );
      res.send(Buffer.from(artifact.bytes));
    } catch (error) {
      res.status(404).json({
        detail: safeErrorMessage(error, "Developer artifact not found"),
      });
    }
  },
);

skillsRouter.post(
  "/versions/:versionId/check-update",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      res.json(
        await checkGitHubSkillVersionUpdate({
          tenantId: tenant,
          versionId: req.params.versionId,
        }),
      );
    } catch (error) {
      res.status(422).json({
        detail: safeErrorMessage(error, "GitHub update check failed"),
      });
    }
  },
);

skillsRouter.post(
  "/versions/:versionId/adapt/rename",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const newDisplayName =
      typeof req.body?.newDisplayName === "string"
        ? req.body.newDisplayName.trim()
        : "";
    if (!newDisplayName || newDisplayName.length > 128) {
      return void res.status(400).json({
        detail: "newDisplayName of at most 128 characters is required.",
      });
    }
    try {
      res.json(
        await persistSkillRename({
          tenantId: tenant,
          versionId: req.params.versionId,
          newDisplayName,
          adaptedBy: String(res.locals.userId),
        }),
      );
    } catch (error) {
      res.status(409).json({
        detail: safeErrorMessage(error, "Skill rename could not be applied"),
      });
    }
  },
);

skillsRouter.post(
  "/versions/:versionId/developer-artifacts",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const requirementName =
      typeof req.body?.requirementName === "string"
        ? req.body.requirementName.trim()
        : "";
    const sourcePaths = Array.isArray(req.body?.sourcePaths)
      ? req.body.sourcePaths.filter(
          (value: unknown): value is string =>
            typeof value === "string" && !!value.trim(),
        )
      : undefined;
    if (
      !requirementName ||
      requirementName.length > 128 ||
      (sourcePaths && sourcePaths.length > 50)
    ) {
      return void res.status(400).json({
        detail: "A valid requirementName and at most 50 sourcePaths are required.",
      });
    }
    try {
      res.status(201).json(
        await createCleanRoomDeveloperArtifact({
          tenantId: tenant,
          versionId: req.params.versionId,
          requirementName,
          sourcePaths,
          createdBy: String(res.locals.userId),
        }),
      );
    } catch (error) {
      res.status(422).json({
        detail: safeErrorMessage(
          error,
          "Clean-room developer artifact could not be created",
        ),
      });
    }
  },
);

skillsRouter.put(
  "/projects/:projectId/pins/:skillId",
  requireAuth,
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const versionId =
      typeof req.body?.versionId === "string" ? req.body.versionId.trim() : "";
    if (!versionId) {
      return void res.status(400).json({ detail: "versionId is required." });
    }
    const db = createServerSupabase();
    const access = await checkProjectAccess(
      req.params.projectId,
      String(res.locals.userId),
      res.locals.userEmail as string | undefined,
      db,
    );
    if (!access.ok) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    if (!access.isOwner) {
      return void res.status(403).json({ detail: "PROJECT_OWNER_REQUIRED" });
    }
    try {
      res.json(
        await setProjectSkillPin({
          tenantId: tenant,
          projectId: req.params.projectId,
          skillId: req.params.skillId,
          versionId,
          pinnedBy: String(res.locals.userId),
          db,
        }),
      );
    } catch (error) {
      res.status(409).json({
        detail: safeErrorMessage(error, "Project skill pin could not be set"),
      });
    }
  },
);

skillsRouter.get(
  "/projects/:projectId/pins",
  requireAuth,
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const db = createServerSupabase();
    const access = await checkProjectAccess(
      req.params.projectId,
      String(res.locals.userId),
      res.locals.userEmail as string | undefined,
      db,
    );
    if (!access.ok) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    try {
      res.json({
        pins: await listProjectSkillPins({
          tenantId: tenant,
          projectId: req.params.projectId,
          db,
        }),
        canManage: access.isOwner,
      });
    } catch (error) {
      res.status(500).json({
        detail: safeErrorMessage(error, "Project skill pins could not be read"),
      });
    }
  },
);

skillsRouter.post(
  "/:skillId/disable",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      res.json(
        await disableSkill({
          tenantId: tenant,
          skillId: req.params.skillId,
          disabledBy: String(res.locals.userId),
        }),
      );
    } catch (error) {
      res.status(409).json({
        detail: safeErrorMessage(error, "Skill could not be disabled"),
      });
    }
  },
);

skillsRouter.post(
  "/versions/:versionId/dependencies",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const dependencyVersionId =
      typeof req.body?.dependencyVersionId === "string"
        ? req.body.dependencyVersionId.trim()
        : "";
    if (!dependencyVersionId || typeof req.body?.required !== "boolean") {
      return void res.status(400).json({
        detail: "dependencyVersionId and boolean required are required.",
      });
    }
    try {
      res.json(
        await setSkillDependency({
          tenantId: tenant,
          versionId: req.params.versionId,
          dependencyVersionId,
          required: req.body.required,
          approvedBy: String(res.locals.userId),
        }),
      );
    } catch (error) {
      res.status(409).json({
        detail: safeErrorMessage(error, "Skill dependency could not be set"),
      });
    }
  },
);

skillsRouter.post(
  "/versions/:versionId/analyse",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      const result = await analyseSkillVersion({
        tenantId: tenant,
        versionId: req.params.versionId,
        userId: String(res.locals.userId),
      });
      res.json(result);
    } catch (error) {
      res
        .status(422)
        .json({ detail: safeErrorMessage(error, "Skill analysis failed") });
    }
  },
);

skillsRouter.get(
  "/versions/:versionId/review",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    try {
      res.json(
        await getSkillReview({
          tenantId: tenant,
          versionId: req.params.versionId,
          userId: String(res.locals.userId),
        }),
      );
    } catch (error) {
      res
        .status(404)
        .json({ detail: safeErrorMessage(error, "Skill review not found") });
    }
  },
);

skillsRouter.post(
  "/versions/:versionId/review/messages",
  requireAuth,
  requireRole("TenantAdmin"),
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const message =
      typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message || message.length > 2_000) {
      return void res
        .status(400)
        .json({ detail: "A review message of at most 2,000 characters is required." });
    }
    try {
      res.json(
        await postSkillReviewMessage({
          tenantId: tenant,
          versionId: req.params.versionId,
          userId: String(res.locals.userId),
          message,
        }),
      );
    } catch (error) {
      res
        .status(409)
        .json({ detail: safeErrorMessage(error, "Review action failed") });
    }
  },
);

skillsRouter.post(
  "/versions/:versionId/run",
  requireAuth,
  async (req, res) => {
    const tenant = tenantId(res);
    if (!tenant) return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
    const projectId =
      typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
    if (!projectId) {
      return void res.status(400).json({ detail: "projectId is required." });
    }
    const db = createServerSupabase();
    const access = await checkProjectAccess(
      projectId,
      String(res.locals.userId),
      res.locals.userEmail as string | undefined,
      db,
    );
    if (!access.ok) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    try {
      res.status(201).json(
        await createSkillRun({
          tenantId: tenant,
          versionId: req.params.versionId,
          projectId,
          userId: String(res.locals.userId),
          db,
        }),
      );
    } catch (error) {
      res
        .status(409)
        .json({ detail: safeErrorMessage(error, "Skill run could not start") });
    }
  },
);
