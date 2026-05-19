import { DefaultAzureCredential } from "@azure/identity";
import { getConfig } from "../../config";
import type { CheckResult, InstallContext } from "../types";

// Real Microsoft Graph round-trip for entra-frontend-redirect-uris.
// Fetches the frontend app registration via Graph and compares its
// web.redirectUris + spa.redirectUris against the URIs that
// create-entra-apps.ps1 registers for the current backend FQDN.
//
// Auth: uses the backend's UAMI via DefaultAzureCredential. Two ways
// to grant the UAMI read access to the app reg:
//   1. Add the UAMI's service principal as an owner of the app reg
//      (narrow — only this app reg). Preferred.
//   2. Grant the UAMI's SP the Application.Read.All app role on
//      Microsoft Graph (broad — any app reg in tenant). Cheaper to
//      operate but wider blast radius.
// Either way, this check fails-soft with a clear remediation hint
// until one of those is in place — the operator sees what to do.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

function expectedUris(fqdn: string): { web: string[]; spa: string[] } {
    return {
        web: [
            `https://${fqdn}/api/auth/openid-callback/microsoft`,
            `https://${fqdn}/install/auth/microsoft/callback`,
        ],
        spa: [`https://${fqdn}/login`],
    };
}

interface AppRegistration {
    id?: string;
    appId?: string;
    web?: { redirectUris?: string[] };
    spa?: { redirectUris?: string[] };
}

interface GraphErrorBody {
    error?: { code?: string; message?: string };
}

export async function checkRedirectUris(
    ctx: InstallContext,
): Promise<CheckResult> {
    const clientId = await getConfig("entra-client-id").catch(() => "");
    if (!clientId) {
        return {
            status: "fail",
            detail: "entra-client-id is not in Key Vault. Run create-entra-apps.ps1 first.",
        };
    }

    let token: string;
    try {
        const cred = new DefaultAzureCredential({
            managedIdentityClientId: process.env.AZURE_CLIENT_ID,
        });
        const t = await cred.getToken(GRAPH_SCOPE);
        if (!t?.token) throw new Error("empty token");
        token = t.token;
    } catch (err) {
        return {
            status: "info",
            detail:
                "UAMI could not mint a Graph token: " +
                (err instanceof Error ? err.message : String(err)),
        };
    }

    // Look up the application by appId (the client id) — Graph requires
    // a $filter for this; the (appId='...') key path is also accepted.
    const url = `${GRAPH_BASE}/applications(appId='${encodeURIComponent(clientId)}')`;
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
            detail: `Graph fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    if (resp.status === 401 || resp.status === 403) {
        // Graph 403 immediately after the UAMI was granted ownership is
        // almost always a token / cache propagation lag — Azure AD takes
        // a minute or two to propagate role grants to the cached token
        // we just minted. Retry once after a brief delay before treating
        // it as a hard verify-access failure. Closes 040 Entry 6 fix B.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        try {
            resp = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
            });
        } catch {
            /* fall through to the original-failure handling below */
        }
    }

    if (resp.status === 401 || resp.status === 403) {
        const bodyText = (await resp.text()).slice(0, 300);
        let code = "";
        try {
            const parsed = JSON.parse(bodyText) as GraphErrorBody;
            code = parsed.error?.code ?? "";
        } catch {
            /* keep raw */
        }
        return {
            status: "info",
            // Plain-English first sentence describing the state, then
            // the technical remediation. The script affordance is
            // suppressed at the renderer for info-state rows (Entry 6
            // fix A) so this row no longer offers a script that doesn't
            // address the verify-only failure.
            detail:
                "Couldn't verify the sign-in callback URLs are registered. " +
                "This is normally a Microsoft Entra propagation delay after " +
                "create-entra-apps.ps1 finishes — refresh this page in a " +
                "minute or two. If it persists, the install backend's " +
                "managed identity needs read access to the frontend app " +
                `registration (Graph ${resp.status}${code ? ` ${code}` : ""}).`,
        };
    }

    if (!resp.ok) {
        return {
            status: "fail",
            detail: `Graph returned ${resp.status} ${resp.statusText}`,
        };
    }

    let app: AppRegistration;
    try {
        app = (await resp.json()) as AppRegistration;
    } catch (err) {
        return {
            status: "fail",
            detail: `Graph response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const want = expectedUris(ctx.backendFqdn);
    const haveWeb = new Set(app.web?.redirectUris ?? []);
    const haveSpa = new Set(app.spa?.redirectUris ?? []);
    const missingWeb = want.web.filter((u) => !haveWeb.has(u));
    const missingSpa = want.spa.filter((u) => !haveSpa.has(u));

    if (missingWeb.length === 0 && missingSpa.length === 0) {
        return {
            status: "pass",
            detail: `${want.web.length} web + ${want.spa.length} spa URIs all present`,
        };
    }

    const missing = [
        ...missingWeb.map((u) => `web: ${u}`),
        ...missingSpa.map((u) => `spa: ${u}`),
    ];
    return {
        status: "fail",
        detail: `Missing ${missing.length} URI${missing.length === 1 ? "" : "s"}: ${missing.join("; ")}. Run register-redirect-uris.ps1.`,
    };
}
