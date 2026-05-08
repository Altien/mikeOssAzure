import { DefaultAzureCredential } from "@azure/identity";
import { getConfig } from "../../config";
import type { CheckResult, InstallContext } from "../types";

// Real ARM round-trip for installer-access-revoked.
// Lists role assignments on the Key Vault scope filtered to the
// installer's principal id, then reports pass when the
// Key Vault Secrets Officer assignment is gone.
//
// Prerequisites (these gate which status the check returns):
//   1. KV secret `installer-principal-id` must hold the deployer's
//      object id. Bicep keyvault.bicep writes this on greenfield
//      deploy (matches the `deployerPrincipalId` parameter).
//   2. UAMI needs Reader on the Key Vault scope (or any role whose
//      Actions include `Microsoft.Authorization/roleAssignments/read`).
//      Bicep grants this alongside the existing Secrets User role.
//   3. SUBSCRIPTION_ID must be present on the backend's env so we can
//      build the ARM resource id.
// All three fail-soft to status="info" with a clear remediation hint
// — better than a misleading green tick before the rollout is complete.

const ARM_BASE = "https://management.azure.com";
const ARM_SCOPE = "https://management.azure.com/.default";

// Built-in role: Key Vault Secrets Officer. Identical id everywhere.
const KV_SECRETS_OFFICER_ID = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7";

interface RoleAssignment {
    name?: string;
    properties?: {
        principalId?: string;
        roleDefinitionId?: string;
        scope?: string;
    };
}

interface ArmListResponse {
    value?: RoleAssignment[];
}

export async function checkInstallerAccessRevoked(
    ctx: InstallContext,
): Promise<CheckResult> {
    const subId = process.env.SUBSCRIPTION_ID ?? "";
    if (!subId) {
        return {
            status: "info",
            detail:
                "SUBSCRIPTION_ID env var is not set on the backend. " +
                "Bicep needs to thread `subscription().subscriptionId` " +
                "through to containerapp-backend.bicep.",
        };
    }

    const installerId = await getConfig("installer-principal-id").catch(() => "");
    if (!installerId) {
        return {
            status: "info",
            detail:
                "installer-principal-id is not in Key Vault yet. Bicep " +
                "keyvault.bicep should write the deployerPrincipalId on " +
                "greenfield deploy so this check has someone to look up.",
        };
    }

    let token: string;
    try {
        const cred = new DefaultAzureCredential({
            managedIdentityClientId: process.env.AZURE_CLIENT_ID,
        });
        const t = await cred.getToken(ARM_SCOPE);
        if (!t?.token) throw new Error("empty token");
        token = t.token;
    } catch (err) {
        return {
            status: "info",
            detail:
                "UAMI could not mint an ARM token: " +
                (err instanceof Error ? err.message : String(err)),
        };
    }

    const kvScope = `/subscriptions/${subId}/resourceGroups/${encodeURIComponent(
        ctx.resourceGroup,
    )}/providers/Microsoft.KeyVault/vaults/${encodeURIComponent(ctx.keyVaultName)}`;
    const filter = `principalId eq '${installerId}'`;
    const url =
        `${ARM_BASE}${kvScope}/providers/Microsoft.Authorization/` +
        `roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(filter)}`;

    let resp: Response;
    try {
        resp = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
            },
        });
    } catch (err) {
        return {
            status: "info",
            detail: `ARM fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    if (resp.status === 401 || resp.status === 403) {
        return {
            status: "info",
            detail:
                `ARM denied the read (${resp.status}). Grant the UAMI ` +
                "Reader on the Key Vault scope so it can list role assignments.",
        };
    }

    if (!resp.ok) {
        return {
            status: "fail",
            detail: `ARM returned ${resp.status} ${resp.statusText}`,
        };
    }

    let body: ArmListResponse;
    try {
        body = (await resp.json()) as ArmListResponse;
    } catch (err) {
        return {
            status: "fail",
            detail: `ARM response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const assignments = body.value ?? [];
    const stillOfficer = assignments.filter((a) =>
        (a.properties?.roleDefinitionId ?? "").toLowerCase().endsWith(
            KV_SECRETS_OFFICER_ID.toLowerCase(),
        ),
    );

    if (stillOfficer.length === 0) {
        return {
            status: "pass",
            detail: "No Key Vault Secrets Officer assignment for the installer.",
        };
    }

    return {
        status: "fail",
        detail:
            `Installer principal still has ${stillOfficer.length} ` +
            "Key Vault Secrets Officer assignment(s). Run revoke-installer-access.ps1.",
    };
}
