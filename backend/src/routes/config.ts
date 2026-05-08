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
//
// Cache-Control short — config changes are rare but we already have
// /install's flushConfigCache for explicit invalidation when an
// operator rotates a value.

import { Router } from "express";

export const configRouter = Router();

configRouter.get("/", (_req, res) => {
    const provider = (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
    const authProvider =
        provider === "entra" || provider === "local" ? provider : "supabase";

    res.set("Cache-Control", "public, max-age=60");
    res.json({
        authProvider,
        entra: {
            tenantId: process.env.ENTRA_TENANT_ID ?? "",
            clientId:
                process.env.ENTRA_CLIENT_ID ??
                process.env.ENTRA_FRONTEND_CLIENT_ID ??
                "",
        },
    });
});
