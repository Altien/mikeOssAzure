import { createServerSupabase } from "./supabase";
import { createServerSQLite } from "./sqlite";

export const DATABASE_PROVIDERS = ["supabase", "sqlite"] as const;
export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number];

// The existing SQLite adapter deliberately implements the subset of the
// Supabase query API used by Mike. Keeping this alias in one place lets domain
// code stop depending on the concrete SQLite module while the adapter is made
// fully typed incrementally.
export type ServerDatabase = ReturnType<
  (typeof import("./sqlite"))["createServerSQLite"]
>;

export function resolveDatabaseProvider(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseProvider {
  const configured = env.MIKE_DATABASE_PROVIDER?.trim().toLowerCase();
  if (configured) {
    if (configured === "supabase" || configured === "sqlite") {
      return configured;
    }
    throw new Error(
      `Unsupported MIKE_DATABASE_PROVIDER "${configured}". Expected one of: ${DATABASE_PROVIDERS.join(", ")}.`,
    );
  }

  // Compatibility for existing local installations created before the
  // provider setting existed. Fresh installations default to upstream
  // Supabase unless they explicitly select SQLite.
  if (
    env.SQLITE_DB_PATH?.trim() &&
    !env.SUPABASE_URL?.trim() &&
    !env.SUPABASE_SECRET_KEY?.trim()
  ) {
    return "sqlite";
  }
  return "supabase";
}

export function createServerDatabase(): ServerDatabase {
  if (resolveDatabaseProvider() === "sqlite") {
    return createServerSQLite();
  }
  return createServerSupabase() as unknown as ServerDatabase;
}

export function databaseProviderIsSQLite(): boolean {
  return resolveDatabaseProvider() === "sqlite";
}
