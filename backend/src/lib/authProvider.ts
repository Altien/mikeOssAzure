export const AUTH_PROVIDERS = ["supabase", "local"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export function resolveAuthProvider(
  env: NodeJS.ProcessEnv = process.env,
): AuthProvider {
  const configured = env.MIKE_AUTH_PROVIDER?.trim().toLowerCase();
  if (configured) {
    if (configured === "supabase" || configured === "local") {
      return configured;
    }
    throw new Error(
      `Unsupported MIKE_AUTH_PROVIDER "${configured}". Expected one of: ${AUTH_PROVIDERS.join(", ")}.`,
    );
  }

  // Existing SQLite installations used the built-in account/session tables
  // before auth became selectable. Fresh and upstream deployments use
  // Supabase Auth by default.
  if (
    env.MIKE_DATABASE_PROVIDER?.trim().toLowerCase() === "sqlite" ||
    (env.SQLITE_DB_PATH?.trim() &&
      !env.SUPABASE_URL?.trim() &&
      !env.SUPABASE_SECRET_KEY?.trim())
  ) {
    return "local";
  }
  return "supabase";
}

export function authProviderIsLocal(): boolean {
  return resolveAuthProvider() === "local";
}
