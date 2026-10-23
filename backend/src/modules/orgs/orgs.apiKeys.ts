// Provider keys an organization holds for its members, and the setting that
// decides whether a member's own key may stand in for one it lacks.
//
// Behind the module facade (orgs.service.ts). The keys themselves are stored,
// encrypted and validated by the user module's key store, which serves a
// person's keys and an organization's through one implementation: nothing
// here touches a secret or reimplements a check. What this file adds is who
// may do it — an organization's owners and admins — and the audit trail.

import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import type { OrgResult } from "../../lib/orgs";
import {
    ROUTER_SLUGS,
    getAllOrgRouterModels,
    getEffectiveRouterModels,
    replaceOrgRouterModels,
    type RouterModelSelections,
    type RouterSlug,
} from "../../lib/routerModels";
import type { Db } from "../../lib/supabase";
import {
    getApiKeyStatusFor,
    getEffectiveApiKeyStatus,
    normalizeRouterModels,
    orgKeyOwner,
    type ApiKeyProvider,
    type ApiKeyStatus,
} from "../user/user.service";

export type OrgApiKeySettings = {
    /** Which providers the organization has a usable key for. No secrets. */
    keys: ApiKeyStatus;
    /**
     * What the caller can run in the organization: its keys, with their own
     * beneath where that is allowed. This is what the model picker reads, so
     * it offers exactly the models a request would be able to use.
     */
    effective: ApiKeyStatus;
    /**
     * The models the organization's key may run, per "model list" provider
     * (OpenRouter, Bedrock, Azure and the like). Its admins choose them.
     */
    router_models: RouterModelSelections;
    /**
     * The lists that govern the caller's work here: the organization's for
     * each provider whose key it holds, their own for the rest.
     */
    effective_router_models: RouterModelSelections;
    /** Whether the caller may change any of this. */
    can_manage: boolean;
    can_manage_models?: boolean;
    managed?: boolean;
};

async function readSettings(
    db: Db,
    orgId: string,
    userId: string,
    canManage: boolean,
): Promise<OrgResult<{ settings: OrgApiKeySettings }>> {
    const { data, error } = await db
        .from("organizations")
        .select("id")
        .eq("id", orgId)
        .maybeSingle();
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    if (!data) return { ok: false, kind: "not_found" };
    try {
        const [keys, effective, routerModels, effectiveRouterModels] =
            await Promise.all([
                getApiKeyStatusFor(orgKeyOwner(orgId), db),
                getEffectiveApiKeyStatus(userId, orgId, db),
                getAllOrgRouterModels(orgId, db),
                getEffectiveRouterModels(userId, orgId, db),
            ]);
        return {
            ok: true,
            settings: {
                keys,
                effective,
                router_models: routerModels,
                effective_router_models: effectiveRouterModels,
                can_manage: false,
                can_manage_models: canManage,
                managed: true,
            },
        };
    } catch (error) {
        return {
            ok: false,
            kind: "db_error",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Any member may see which providers their organization has set up, and
 * whether their own keys are in play: that is what explains which models
 * they are offered. Nothing here is a secret.
 */
export async function getOrgApiKeySettings(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ settings: OrgApiKeySettings }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    return readSettings(db, params.orgId, params.userId, isOrgAdmin(role));
}

/**
 * Save, replace or (with no key) remove the organization's key for a
 * provider. Owners and admins only: a key is a credential the firm pays
 * for, and whoever sets it decides where the firm's work is sent.
 */
export async function saveOrgApiKey(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        provider: ApiKeyProvider;
        apiKey: string | null;
        settings?: unknown;
    },
): Promise<OrgResult<{ settings: OrgApiKeySettings }>> {
    // Upstream divergence (sync-log: db8d42c3): NOT SUPPORTED — secret
    // edits and personal-key opt-in are deployment administrator operations.
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };
    return { ok: false, kind: "validation", detail: "Provider credentials are managed by the deployment administrator. Personal keys cannot override them." };

}

/** Turn the organization's key for a provider off or on without losing it. */
export async function setOrgApiKeyEnabled(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        provider: ApiKeyProvider;
        enabled: boolean;
    },
): Promise<OrgResult<{ settings: OrgApiKeySettings }>> {
    // Upstream divergence (sync-log: db8d42c3): NOT SUPPORTED — secret
    // edits and personal-key opt-in are deployment administrator operations.
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };
    return { ok: false, kind: "validation", detail: "Provider credentials are managed by the deployment administrator. Personal keys cannot override them." };

}

export function normalizeOrgRouterSlug(value: string): RouterSlug | null {
    return ROUTER_SLUGS.find((slug) => slug === value) ?? null;
}

/**
 * Replace the models the organization's key for one provider may run.
 * Owners and admins only: the list is what the firm's key can be spent on.
 * Held to the same rules as a person's own list (shape, length, no
 * duplicates, at most 50), and refused as a whole rather than trimmed, so
 * what was saved is what was sent.
 */
export async function saveOrgRouterModels(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        provider: RouterSlug;
        modelIds: unknown;
    },
): Promise<OrgResult<{ settings: OrgApiKeySettings }>> {
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    if (!Array.isArray(params.modelIds))
        return {
            ok: false,
            kind: "validation",
            detail: "model_ids must be an array of model IDs",
        };
    if (params.modelIds.length > 50)
        return {
            ok: false,
            kind: "validation",
            detail: "A provider can include at most 50 models",
        };
    const models = normalizeRouterModels(params.modelIds, params.provider);
    if (models.length !== params.modelIds.length)
        return {
            ok: false,
            kind: "validation",
            detail: "model_ids contains an invalid or duplicate model ID",
        };

    try {
        await replaceOrgRouterModels(params.orgId, params.provider, models, db);
    } catch (error) {
        return {
            ok: false,
            kind: "db_error",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.router_models.updated",
        title: params.provider,
        detail: {
            org_id: params.orgId,
            provider: params.provider,
            model_count: models.length,
        },
    });
    return readSettings(db, params.orgId, params.actorId, true);
}
