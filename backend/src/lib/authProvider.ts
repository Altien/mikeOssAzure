export const AUTH_PROVIDERS = ["local"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export function resolveAuthProvider(
  env: NodeJS.ProcessEnv = process.env,
): AuthProvider {
  const configured = env.MIKE_AUTH_PROVIDER?.trim().toLowerCase();
  if (configured && configured !== "local") {
    throw new Error(
      `Unsupported MIKE_AUTH_PROVIDER "${configured}". This fork uses local SQLite authentication.`,
    );
  }
  return "local";
}

export function authProviderIsLocal(): boolean {
  resolveAuthProvider();
  return true;
}
