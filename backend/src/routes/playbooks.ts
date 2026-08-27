import { Router, type Response } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { requireUserFeature } from "../lib/userFeatures";
import { singleFileUpload } from "../lib/upload";
import {
  deletePlaybook,
  getPlaybook,
  importPlaybookFromDocx,
  listPlaybookRuns,
  listPlaybooks,
  PlaybookImportError,
  playbookConfiguration,
  publishPlaybook,
  reviewWithPlaybook,
  updatePlaybookDraft,
} from "../lib/playbooks";

export const playbooksRouter = Router();
playbooksRouter.use(requireAuth, requireUserFeature("playbooks"));

function sendError(res: Response, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const status = detail === "Playbook not found." ? 404 : 400;
  console.error("[playbooks] request failed", { error: detail });
  res.status(status).json({
    detail,
    ...(error instanceof PlaybookImportError
      ? {
          code: error.code,
          importAttemptId: error.attemptId,
          stage: error.stage,
        }
      : {}),
  });
}

playbooksRouter.get("/configuration", async (_req, res) => {
  try {
    res.json(await playbookConfiguration(res.locals.userId as string));
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.get("/", async (_req, res) => {
  try {
    res.json(await listPlaybooks(res.locals.userId as string));
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.post(
  "/import",
  requireMfaIfEnrolled,
  singleFileUpload("file"),
  async (req, res) => {
    try {
      if (!req.file)
        return void res
          .status(400)
          .json({ detail: "A Word playbook file is required." });
      const model = typeof req.body?.model === "string" ? req.body.model : "";
      const name =
        typeof req.body?.name === "string" ? req.body.name : undefined;
      res
        .status(201)
        .json(
          await importPlaybookFromDocx({
            userId: res.locals.userId as string,
            filename: req.file.originalname,
            buffer: req.file.buffer,
            name,
            model,
          }),
        );
    } catch (error) {
      sendError(res, error);
    }
  },
);

playbooksRouter.get("/:playbookId", async (req, res) => {
  try {
    res.json(
      await getPlaybook(res.locals.userId as string, req.params.playbookId),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.put("/:playbookId", requireMfaIfEnrolled, async (req, res) => {
  try {
    res.json(
      await updatePlaybookDraft(
        res.locals.userId as string,
        req.params.playbookId,
        req.body?.draft ?? req.body,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.post(
  "/:playbookId/publish",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      res.json(
        await publishPlaybook(
          res.locals.userId as string,
          req.params.playbookId,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

playbooksRouter.post("/:playbookId/review", async (req, res) => {
  try {
    const text =
      typeof req.body?.documentText === "string" ? req.body.documentText : "";
    const model = typeof req.body?.model === "string" ? req.body.model : "";
    const documentName =
      typeof req.body?.documentName === "string"
        ? req.body.documentName
        : undefined;
    const reviewMode =
      req.body?.reviewMode === "permissive"
        ? ("permissive" as const)
        : ("strict" as const);
    res.json(
      await reviewWithPlaybook({
        userId: res.locals.userId as string,
        playbookId: req.params.playbookId,
        documentText: text,
        documentName,
        model,
        reviewMode,
      }),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.get("/:playbookId/runs", async (req, res) => {
  try {
    res.json(
      await listPlaybookRuns(
        res.locals.userId as string,
        req.params.playbookId,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.delete(
  "/:playbookId",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      await deletePlaybook(res.locals.userId as string, req.params.playbookId);
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  },
);
