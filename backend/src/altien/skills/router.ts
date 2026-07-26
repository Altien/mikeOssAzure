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
  getSkillPackageInfo,
} from "./packages";
import { buildContentDisposition } from "../../lib/storage";

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
    if (req.params.kind !== "original" && req.params.kind !== "mike") {
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
      const result =
        req.params.kind === "original"
          ? await buildOriginalSkillPackage({
              tenantId: tenant,
              versionId: req.params.versionId,
            })
          : await buildMikeSkillPackage({
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
