/// <reference types="office-js" />

/**
 * Ambient declaration for webpack EnvironmentPlugin substitutions.
 * These values are replaced at build time; runtime access is a no-op guard.
 *
 * Dev fork: no identity values are baked in (no Supabase URL/key, no Entra
 * ids) — auth config comes from the backend's GET /config at runtime.
 * REACT_APP_API_BASE_URL is the backend ORIGIN (like the web frontend's
 * NEXT_PUBLIC_API_BASE_URL); the add-in appends /api and /config itself.
 */
declare const process: {
  readonly env: {
    readonly REACT_APP_API_BASE_URL: string | undefined;
    readonly REACT_APP_DEFAULT_MODEL: string | undefined;
    readonly REACT_APP_WEB_APP_URL: string | undefined;
    readonly NODE_ENV: string;
  };
};
