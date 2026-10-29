// CourtListener as a connector, per workspace: the switch and the person's
// own token live in user_courtlistener_connections (see user.apiKeyStore.ts);
// an organization's token comes from org_api_keys and is laid over theirs.

import type { CourtListenerConnectorStatus } from "@mike/contracts";
import { getOrgRole } from "../../lib/access";
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { resolveProviderSecret } from "../../lib/envSecrets";
import { courtlistenerBulkDataEnabled } from "../../lib/courtlistener";
import {
    loadCourtListenerConnection,
    saveCourtListenerConnection,
} from "./user.apiKeyStore";
import type { Db } from "./user.shared";

export async function courtListenerConnectorStatus(
    db: Db,
    owner: ConnectorOwner,
): Promise<CourtListenerConnectorStatus> {
    if (owner.orgId && !(await getOrgRole(owner.userId, owner.orgId, db)))
        throw Object.assign(new Error("Workspace not found"), { status: 404 });
    const connection = await loadCourtListenerConnection(owner, db);
    const centralToken = await resolveProviderSecret("courtlistener-api-token");
    const tokenSource = centralToken ? "org" : null;
    const bulkData = courtlistenerBulkDataEnabled();
    const ownToken = false;
    return {
        enabled: connection.enabled,
        // Listed under Installed while it is on and lookups can run, or while
        // the user has a token of their own here to manage. Switched off with
        // nothing of theirs saved, it goes back to Discover: the bulk index or
        // the organization's token was never something they added.
        installed:
            ownToken || (connection.enabled && (!!tokenSource || bulkData)),
        ownToken,
        tokenSource,
        bulkData,
    };
}

export async function setCourtListenerEnabled(
    db: Db,
    owner: ConnectorOwner,
    enabled: boolean,
): Promise<CourtListenerConnectorStatus> {
    await saveCourtListenerConnection(owner, { enabled }, db);
    return courtListenerConnectorStatus(db, owner);
}

/**
 * Save or (with null) delete the person's own token for the workspace.
 * Saving one is a request to use it, so it also turns the switch on, as
 * adding any other connector does.
 */
export async function setCourtListenerToken(
    db: Db,
    owner: ConnectorOwner,
    token: string | null,
): Promise<CourtListenerConnectorStatus> {
    // Upstream divergence (sync-log: 18035cf6 / 540fb8a2): per-workspace
    // enable switches are supported; personal credential writes remain refused.
    void db; void owner; void token;
    throw Object.assign(new Error("CourtListener credentials are managed by your organization."), { status: 403, code: "managed_credentials" });
}
