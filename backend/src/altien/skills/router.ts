import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { safeErrorMessage } from "../../lib/safeError";
import {
  SKILL_IMPORT_LIMITS,
  SkillArchiveValidationError,
  validateSkillZip,
} from "./archive";
import { listTenantSkills, storeZipSkillSnapshot } from "./persistence";

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
