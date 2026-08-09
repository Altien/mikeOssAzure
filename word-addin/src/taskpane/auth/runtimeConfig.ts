/**
 * Where the Mike backend lives and how it wants the add-in to authenticate.
 *
 * Dev-fork divergence (upstream sync b8bd5b0c): upstream's add-in signs in
 * against Supabase with REACT_APP_SUPABASE_URL / _ANON_KEY baked into the
 * bundle. This fork authenticates with Microsoft Entra, and — like the web
 * frontend (frontend/src/contexts/ConfigContext.tsx) — reads every
 * deployment-specific value at RUNTIME from the backend's unauthenticated
 * `GET /config`. The only build-time value is the backend origin
 * (REACT_APP_API_BASE_URL, the add-in's counterpart of the frontend's
 * NEXT_PUBLIC_API_BASE_URL), because the bundle must know where to fetch
 * /config from. Never bake tenant / client ids into the bundle.
 */

export type AuthProvider = "supabase" | "local" | "entra";

export interface RuntimeConfig {
  authProvider: AuthProvider;
  entra: {
    tenantId: string;
    clientId: string;
    apiScope: string;
  };
}

// Guard the `process` reference: webpack's EnvironmentPlugin only substitutes
// registered vars, and a stale dev server can leave a literal `process.env...`
// that throws "process is not defined" in the browser.
const RAW_API_ORIGIN: string =
  process.env.REACT_APP_API_BASE_URL ||
  "";

/** Backend origin, no trailing slash (same meaning as NEXT_PUBLIC_API_BASE_URL). */
export const API_ORIGIN: string = RAW_API_ORIGIN.replace(/\/+$/, "");

/** Base for API routes — the dev backend mounts every router under /api. */
export const API_BASE_URL = `${API_ORIGIN}/api`;

let _configPromise: Promise<RuntimeConfig> | null = null;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Fetch `GET /config` once per pane load; a failure is retried on the next call. */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (_configPromise) return _configPromise;
  const pending = (async (): Promise<RuntimeConfig> => {
    const res = await fetch(`${API_ORIGIN}/config`, { credentials: "omit" });
    if (!res.ok) throw new Error(`GET /config failed (${res.status})`);
    const body = (await res.json()) as {
      authProvider?: unknown;
      entra?: { tenantId?: unknown; clientId?: unknown; apiScope?: unknown };
    };
    const provider = asString(body.authProvider);
    const authProvider: AuthProvider =
      provider === "entra" || provider === "local" ? provider : "supabase";
    return {
      authProvider,
      entra: {
        tenantId: asString(body.entra?.tenantId),
        clientId: asString(body.entra?.clientId),
        apiScope: asString(body.entra?.apiScope),
      },
    };
  })().catch((e: unknown) => {
    _configPromise = null;
    throw e;
  });
  _configPromise = pending;
  return pending;
}
