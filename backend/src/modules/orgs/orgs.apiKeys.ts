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
import type { Db } from "../../lib/supabase";
import {
    getApiKeyStatusFor,
    getEffectiveApiKeyStatus,
    orgKeyOwner,
    saveApiKeyForOwner,
    setApiKeyEnabledFor,
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
     * Whether a member's own key is used for a provider the organization has
     * no key for. When false, work in the organization never runs on a
     * personal key.
     */
    allow_personal_api_keys: boolean;
    /** Whether the caller may change any of this. */
    can_manage: boolean;
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
        .select("allow_personal_api_keys")
        .eq("id", orgId)
        .maybeSingle();
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    if (!data) return { ok: false, kind: "not_found" };
    try {
        return {
            ok: true,
            settings: {
                keys: await getApiKeyStatusFor(orgKeyOwner(orgId), db),
                effective: await getEffectiveApiKeyStatus(userId, orgId, db),
                allow_personal_api_keys: false,
                can_manage: false,
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

/**
 * Decide whether members' own keys may be used for work in the
 * organization. Turning it off is how a firm makes sure its matters only
 * ever run on accounts it holds.
 */
export async function setOrgPersonalApiKeysAllowed(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        allowed: unknown;
    },
): Promise<OrgResult<{ settings: OrgApiKeySettings }>> {
    // Upstream divergence (sync-log: db8d42c3): NOT SUPPORTED — secret
    // edits and personal-key opt-in are deployment administrator operations.
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };
    return { ok: false, kind: "validation", detail: "Provider credentials are managed by the deployment administrator. Personal keys cannot override them." };

}
