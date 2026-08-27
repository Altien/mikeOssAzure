import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { requireUserFeature } from "../lib/userFeatures";
import {
  BuiltInPromptMutationError,
  createPromptLibraryItem,
  deletePromptLibraryItem,
  getPromptLibraryItem,
  listPromptLibrary,
  PromptNotFoundError,
  updatePromptLibraryItem,
  type PromptLibraryInput,
} from "../lib/promptLibrary";

export const promptsRouter = Router();
promptsRouter.use(requireAuth, requireUserFeature("promptLibrary"));

function readInput(body: unknown): PromptLibraryInput {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    name: typeof value.name === "string" ? value.name : "",
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    description:
      typeof value.description === "string" ? value.description : null,
    promptType: typeof value.promptType === "string" ? value.promptType : null,
    categories: Array.isArray(value.categories)
      ? value.categories.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    practiceAreas: Array.isArray(value.practiceAreas)
      ? value.practiceAreas.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    sourceRequirements: Array.isArray(value.sourceRequirements)
      ? value.sourceRequirements.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  };
}

function sendError(res: import("express").Response, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof PromptNotFoundError)
    return void res.status(404).json({ detail });
  if (error instanceof BuiltInPromptMutationError)
    return void res.status(409).json({ detail });
  console.error("[prompts] request failed", { error: detail });
  res.status(400).json({ detail });
}

promptsRouter.get("/", async (_req, res) => {
  try {
    res.json(await listPromptLibrary(res.locals.userId as string));
  } catch (error) {
    sendError(res, error);
  }
});

promptsRouter.get("/:promptId", async (req, res) => {
  try {
    res.json(
      await getPromptLibraryItem(
        res.locals.userId as string,
        req.params.promptId,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

promptsRouter.post("/", requireMfaIfEnrolled, async (req, res) => {
  try {
    res
      .status(201)
      .json(
        await createPromptLibraryItem(
          res.locals.userId as string,
          readInput(req.body),
        ),
      );
  } catch (error) {
    sendError(res, error);
  }
});

promptsRouter.put("/:promptId", requireMfaIfEnrolled, async (req, res) => {
  try {
    res.json(
      await updatePromptLibraryItem(
        res.locals.userId as string,
        req.params.promptId,
        readInput(req.body),
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

promptsRouter.delete("/:promptId", requireMfaIfEnrolled, async (req, res) => {
  try {
    await deletePromptLibraryItem(
      res.locals.userId as string,
      req.params.promptId,
    );
    res.status(204).send();
  } catch (error) {
    sendError(res, error);
  }
});
