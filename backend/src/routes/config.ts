// Public runtime-config endpoint.
//
// Returns the values the browser bundle needs at startup that today are
// baked in via NEXT_PUBLIC_* env vars. Surfacing them through this
// endpoint lets the same Docker image ship to any tenant: the bundle
// is identical, and only the server's env / Key Vault values vary.
//
// Unauthenticated by design — none of these values are secrets:
//   - authProvider is the deployment-mode toggle, observable from the
//     login UI flow anyway.
//   - entra.tenantId / entra.clientId end up in OAuth URLs the browser
//     constructs and submits to login.microsoftonline.com.
//   - entra.apiScope is the backend API's delegated scope
//     (api://<backend-client-id>/access_as_user). The web frontend does not
//     need it (its login is brokered by /api/auth); the Word add-in
//     (word-addin/) acquires tokens itself with MSAL and requests exactly
//     this scope, so its tokens carry the same audience the backend's
//     Entra validator already accepts for the web frontend.
//   - demoMode controls a public warning banner and contains no deployment
//     identity or secret material.
//   - workflowContributionsEnabled only toggles the "open source this
//     workflow" action (WORKFLOW_CONTRIBUTIONS_ENABLED, default off).
//
// Cache-Control short — config changes are rare but we already have
// /install's flushConfigCache for explicit invalidation when an
// operator rotates a value.

import { Router } from "express";
import { getConfig } from "../lib/config";

export const configRouter = Router();

async function configValue(name: string): Promise<string> {
    return getConfig(name).catch(() => "");
}

configRouter.get("/", async (_req, res) => {
    const provider = (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
    const authProvider =
        provider === "entra" || provider === "local" ? provider : "supabase";

    // Env first (the original contract). In entra mode, fall back to Key
    // Vault via getConfig(): Azure deploys write the Entra identifiers to KV
    // only (create-entra-apps.ps1 / /install), never to Container App env,
    // so without the fallback the Word add-in would get empty values there.
    let tenantId = process.env.ENTRA_TENANT_ID ?? "";
    let clientId =
        process.env.ENTRA_CLIENT_ID ??
        process.env.ENTRA_FRONTEND_CLIENT_ID ??
        "";
    let backendClientId = process.env.ENTRA_BACKEND_CLIENT_ID ?? "";
    if (authProvider === "entra") {
        [tenantId, clientId, backendClientId] = await Promise.all([
            tenantId || configValue("entra-tenant-id"),
            clientId || configValue("entra-client-id"),
            backendClientId || configValue("entra-backend-client-id"),
        ]);
    }
    const apiScope = backendClientId
        ? `api://${backendClientId}/access_as_user`
        : "";
    const backendPublicUrl = authProvider === "entra" ? await configValue("backend-public-url") : "";
    let backendOrigin = "";
    try { backendOrigin = new URL(backendPublicUrl).origin; } catch { /* Missing public URL is surfaced by the Word login path. */ }

    res.set("Cache-Control", "public, max-age=60");
    res.json({
        authProvider,
        demoMode: process.env.DEMO_MODE?.toLowerCase() === "true",
        // OSS-6 (decisions 4, 7): upstream bakes this into the bundle as
        // NEXT_PUBLIC_WORKFLOW_CONTRIBUTIONS_ENABLED; dev serves it at
        // runtime. Same server flag and test as routes/workflows.ts's
        // open-source gate (plain env, not a secret; default off).
        workflowContributionsEnabled:
            process.env.WORKFLOW_CONTRIBUTIONS_ENABLED === "true",
        entra: { tenantId, clientId, apiScope },
        backendOrigin,
        frontendOrigin: process.env.FRONTEND_URL || "",
    });
});
