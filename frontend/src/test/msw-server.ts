import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

// Default handlers cover the bootstrap requests that every render fires
// (so individual tests don't have to re-stub them).  Tests that care
// about /config or /api/auth/providers responses override these via
// server.use(...).
//
// The "*/path" pattern matches both same-origin requests ("/config")
// and absolute-URL requests ("https://api.example.com/config"), so the
// same handler covers both NEXT_PUBLIC_API_BASE_URL shapes.
export const handlers = [
    http.get("*/config", () =>
        HttpResponse.json({
            authProvider: "supabase",
            demoMode: false,
            entra: { tenantId: "", clientId: "" },
        }),
    ),
    http.get("*/api/auth/providers", () =>
        HttpResponse.json({
            defaultProvider: "supabase",
            providers: [
                { id: "microsoft", name: "Microsoft", mode: "openid", enabled: false },
            ],
        }),
    ),
];

export const server = setupServer(...handlers);
