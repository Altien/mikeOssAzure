// The control plane's model catalogue (migration 0203, view public.cp_models):
// the models this build accepts in a tenant's memberKeyModels. The migration
// job (scripts/runMigrations.ts, also behind migrate:local) replaces the rows
// after every deploy, so the table always matches the running image.
import type { Client } from "pg";
import { MEMBER_KEY_PROVIDERS } from "./memberKeys";
import {
    builtInModelIds,
    OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS,
    OPENCODE_GO_MESSAGES_MODEL_IDS,
    providerForModel,
} from "./models";

export interface CatalogModel {
    modelId: string;
    provider: string;
    label: string;
}

/**
 * Every built-in model whose provider takes a member key. OpenRouter, Vercel
 * and xAI ids are free-form (a user's or organisation's saved selections), so
 * they have no built-in entries. Display names live in the frontend catalogue
 * only, so the label is the model id.
 */
export function memberKeyModelCatalog(): CatalogModel[] {
    const openCodeGo = [
        ...OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS,
        ...OPENCODE_GO_MESSAGES_MODEL_IDS,
    ].map((id) => `opencode-go/${id}`);
    return [...builtInModelIds(), ...openCodeGo].flatMap((modelId) => {
        const provider = providerForModel(modelId);
        return (MEMBER_KEY_PROVIDERS as readonly string[]).includes(provider)
            ? [{ modelId, provider, label: modelId }]
            : [];
    });
}

/** Replace app.model_catalog with this build's models, in one transaction. */
export async function publishModelCatalog(db: Pick<Client, "query">): Promise<number> {
    const models = memberKeyModelCatalog();
    await db.query("begin");
    try {
        await db.query("delete from app.model_catalog");
        await db.query(
            `insert into app.model_catalog (model_id, provider, label, sort_order)
             select * from unnest($1::text[], $2::text[], $3::text[], $4::int[])`,
            [
                models.map((model) => model.modelId),
                models.map((model) => model.provider),
                models.map((model) => model.label),
                models.map((_, index) => index),
            ],
        );
        await db.query("commit");
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    }
    return models.length;
}
