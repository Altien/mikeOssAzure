import { createServerSupabase } from "./supabase";
import { resolveModel } from "./llm/models";

type Db = ReturnType<typeof createServerSupabase>;

export type RouterSlug = "openrouter" | "vercel";

/** The router a namespaced app-level model id routes through, if any. */
export function routerForModelId(model: string): RouterSlug | null {
    if (model.startsWith("openrouter/")) return "openrouter";
    if (model.startsWith("vercel/")) return "vercel";
    return null;
}

/**
 * True when a router-prefixed model id is in the user's saved selection for
 * that router (selections store the raw catalog id, without the slug prefix).
 * Non-router models are always allowed here — their gating happens elsewhere.
 */
export function isRouterModelSelected(
    model: string,
    openRouterModels: string[],
    vercelModels: string[],
): boolean {
    const router = routerForModelId(model);
    if (!router) return true;
    const catalogId = model.slice(router.length + 1);
    const selection =
        router === "openrouter" ? openRouterModels : vercelModels;
    return selection.includes(catalogId);
}

/**
 * Request-time model resolution for chat-style requests. Router-prefixed ids
 * are accepted by SHAPE in resolveModel, so on their own they would let any
 * authenticated user hand-craft a request that runs an arbitrary, arbitrarily
 * expensive gateway model on the operator's env key. This choke point
 * additionally requires a router model to be in the requesting user's saved
 * selection; anything else degrades exactly like an invalid model id — fall
 * back to the caller's default — with a warning for operators.
 */
export async function resolveRequestedModel(
    requested: string | null | undefined,
    fallback: string,
    userId: string,
    db: Db = createServerSupabase(),
): Promise<string> {
    const resolved = resolveModel(requested, fallback);
    const router = routerForModelId(resolved);
    if (!router) return resolved;
    const selection = await getUserRouterModels(userId, router, db);
    if (selection.includes(resolved.slice(router.length + 1))) {
        return resolved;
    }
    console.warn(
        `[router-models] user ${userId} requested ${router} model "${resolved}" outside their saved selection; using ${fallback}`,
    );
    return fallback;
}

// Deploy-before-migrate tolerance: on a database that predates the
// user_router_models migration, reads report "no selections" instead of
// exploding every profile/chat/title/tabular request into a 500. Postgres
// raises undefined_table (42P01); PostgREST reports a relation missing from
// its schema cache as PGRST205 (the analog of the 42703 missing-column shape
// selectProfile already tolerates).
function isMissingRouterModelsTable(error: unknown): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return (
        code === "42P01" ||
        (code === "PGRST205" && message.includes("user_router_models"))
    );
}

let warnedMissingTable = false;

export async function getUserRouterModels(
    userId: string,
    router: string,
    db: Db = createServerSupabase(),
): Promise<string[]> {
    const { data, error } = await db
        .from("user_router_models")
        .select("model_id")
        .eq("user_id", userId)
        .eq("router", router)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
    if (error) {
        if (isMissingRouterModelsTable(error)) {
            if (!warnedMissingTable) {
                warnedMissingTable = true;
                console.warn(
                    "[router-models] user_router_models table is missing; " +
                        "treating router selections as empty until the " +
                        "20260818_01 migration is applied",
                );
            }
            return [];
        }
        throw error;
    }

    return (data ?? []).flatMap((row) =>
        typeof row.model_id === "string" && row.model_id.trim()
            ? [row.model_id.trim()]
            : [],
    );
}

export async function replaceUserRouterModels(
    userId: string,
    router: string,
    modelIds: string[],
    db: Db = createServerSupabase(),
): Promise<void> {
    const { error } = await db.rpc("replace_user_router_models", {
        target_user_id: userId,
        target_router: router,
        target_model_ids: modelIds,
    });
    if (error) throw error;
}
