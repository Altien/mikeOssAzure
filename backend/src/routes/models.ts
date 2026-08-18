import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { authHeaders } from "../lib/llm/ollama";
import { createServerSupabase } from "../lib/supabase";
import { getUserApiKeys } from "../lib/userApiKeys";

export const modelsRouter = Router();

function catalogPrice(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") {
        return undefined;
    }
    const normalized = String(value).trim();
    const amount = Number(normalized);
    return normalized && Number.isFinite(amount) && amount >= 0
        ? normalized
        : undefined;
}

function catalogPricing(
    input: unknown,
    output: unknown,
    options?: { variesByProvider?: boolean; tiered?: boolean },
) {
    const normalizedInput = catalogPrice(input);
    const normalizedOutput = catalogPrice(output);
    if (!normalizedInput && !normalizedOutput) return undefined;
    return {
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedOutput ? { output: normalizedOutput } : {}),
        ...(options?.variesByProvider ? { variesByProvider: true } : {}),
        ...(options?.tiered ? { tiered: true } : {}),
    };
}

// Live list of locally installed Ollama models, shaped like the frontend's
// ModelOption. Returns [] when Ollama is unreachable so the app still works.
modelsRouter.get("/ollama", requireAuth, async (_req, res) => {
    const base = (
        process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"
    ).replace(/\/$/, "");
    try {
        const r = await fetch(`${base}/models`, { headers: authHeaders() });
        if (!r.ok) return void res.json({ models: [] });
        const data = (await r.json()) as { data?: { id: string }[] };
        const models = (data.data ?? []).map((m) => ({
            id: `ollama/${m.id}`,
            label: `${m.id} (local)`,
            group: "Local",
        }));
        res.json({ models });
    } catch {
        res.json({ models: [] });
    }
});

// OpenRouter's authenticated catalog, limited to text models that support
// tool calling because Mike supplies tools on interactive chat requests.
modelsRouter.get("/openrouter", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    try {
        const apiKeys = await getUserApiKeys(userId, createServerSupabase());
        const key = apiKeys.openrouter?.trim();
        if (!key) {
            return void res.status(422).json({
                code: "missing_api_key",
                detail: "An OpenRouter API key is required to list models.",
            });
        }

        const response = await fetch(
            "https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=tools&sort=most-popular&limit=1000",
            { headers: { Authorization: `Bearer ${key}` } },
        );
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            return void res.status(502).json({
                detail: `OpenRouter model catalog request failed (${response.status})${detail ? `: ${detail}` : ""}`,
            });
        }

        const payload = (await response.json()) as {
            data?: Array<{
                id?: unknown;
                name?: unknown;
                pricing?: {
                    prompt?: unknown;
                    completion?: unknown;
                };
            }>;
        };
        const models = (payload.data ?? []).flatMap((model) => {
            if (typeof model.id !== "string" || !model.id.trim()) return [];
            const pricing = catalogPricing(
                model.pricing?.prompt,
                model.pricing?.completion,
            );
            return [
                {
                    id: model.id.trim(),
                    label:
                        typeof model.name === "string" && model.name.trim()
                            ? model.name.trim()
                            : model.id.trim(),
                    ...(pricing ? { pricing } : {}),
                },
            ];
        });
        res.json({ models });
    } catch (error) {
        res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to list OpenRouter models.",
        });
    }
});

// Vercel AI Gateway's public catalog, limited to text models that support tool
// calling because Mike supplies tools on interactive chat requests. A key must
// still be configured before the catalog is exposed in the user's settings.
modelsRouter.get("/vercel", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    try {
        const apiKeys = await getUserApiKeys(userId, createServerSupabase());
        if (!apiKeys.vercel?.trim()) {
            return void res.status(422).json({
                code: "missing_api_key",
                detail: "A Vercel AI Gateway API key is required to list models.",
            });
        }

        const baseUrl = (
            process.env.VERCEL_AI_GATEWAY_BASE_URL?.trim() ||
            "https://ai-gateway.vercel.sh/v1"
        ).replace(/\/+$/, "");
        const response = await fetch(`${baseUrl}/models`);
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            return void res.status(502).json({
                detail: `Vercel AI Gateway model catalog request failed (${response.status})${detail ? `: ${detail}` : ""}`,
            });
        }

        const payload = (await response.json()) as {
            data?: Array<{
                id?: unknown;
                name?: unknown;
                type?: unknown;
                tags?: unknown;
                modalities?: { output?: unknown };
                supported_parameters?: unknown;
                pricing?: {
                    input?: unknown;
                    output?: unknown;
                    input_tiers?: unknown;
                    output_tiers?: unknown;
                    varies_by_provider?: unknown;
                };
            }>;
        };
        const models = (payload.data ?? []).flatMap((model) => {
            const outputs = Array.isArray(model.modalities?.output)
                ? model.modalities.output
                : [];
            const tags = Array.isArray(model.tags) ? model.tags : [];
            const parameters = Array.isArray(model.supported_parameters)
                ? model.supported_parameters
                : [];
            const supportsText =
                model.type === "language" || outputs.includes("text");
            const supportsTools =
                tags.includes("tool-use") || parameters.includes("tools");
            if (
                !supportsText ||
                !supportsTools ||
                typeof model.id !== "string" ||
                !model.id.trim()
            ) {
                return [];
            }
            const pricing = catalogPricing(
                model.pricing?.input,
                model.pricing?.output,
                {
                    variesByProvider:
                        model.pricing?.varies_by_provider === true,
                    tiered:
                        (Array.isArray(model.pricing?.input_tiers) &&
                            model.pricing.input_tiers.length > 0) ||
                        (Array.isArray(model.pricing?.output_tiers) &&
                            model.pricing.output_tiers.length > 0),
                },
            );
            return [
                {
                    id: model.id.trim(),
                    label:
                        typeof model.name === "string" && model.name.trim()
                            ? model.name.trim()
                            : model.id.trim(),
                    ...(pricing ? { pricing } : {}),
                },
            ];
        });
        res.json({ models });
    } catch (error) {
        res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to list Vercel AI Gateway models.",
        });
    }
});
