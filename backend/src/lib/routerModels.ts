import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

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
    if (error) throw error;

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
