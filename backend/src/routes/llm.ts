// LLM-related metadata routes — currently just deployment discovery
// for Azure OpenAI. This is its own router because more LLM routes
// are likely (per-provider model lists, capability checks) and bundling
// them under /llm avoids polluting /user.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getUserApiKeys } from "../lib/userSettings";
import { listAzureOpenaiDeployments } from "../lib/llm/azureOpenaiDeployments";

export const llmRouter = Router();

// GET /llm/azure-openai/deployments
//
// Returns the list of deployments visible from the AOAI endpoint
// configured for the calling user. Falls back to env-global if the
// user hasn't set up personal AOAI. Returns an empty list (not an
// error) when AOAI is not configured at all — the dropdown can just
// hide the AOAI group.
llmRouter.get("/azure-openai/deployments", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    try {
        const apiKeys = await getUserApiKeys(userId);
        const result = await listAzureOpenaiDeployments(apiKeys.azureOpenai);
        if (!result.ok && result.reason === "not_configured") {
            return void res.json({ source: null, deployments: [] });
        }
        if (!result.ok) {
            return void res.status(502).json({
                detail: `Failed to list Azure OpenAI deployments: ${result.detail || `HTTP ${result.status}`}`,
            });
        }
        res.json({ source: result.source, deployments: result.deployments });
    } catch (err) {
        console.error("[llm/aoai-deployments] route threw", { userId, err });
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Unexpected error listing AOAI deployments",
        });
    }
});
