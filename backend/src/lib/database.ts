import { createServerSQLite } from "./sqlite";

export const DATABASE_PROVIDERS = ["sqlite"] as const;
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
  if (configured && configured !== "sqlite") {
    throw new Error(
      `Unsupported MIKE_DATABASE_PROVIDER "${configured}". This fork uses SQLite.`,
    );
  }
  return "sqlite";
}

export function createServerDatabase(): ServerDatabase {
  resolveDatabaseProvider();
  return createServerSQLite();
}

export function databaseProviderIsSQLite(): boolean {
  resolveDatabaseProvider();
  return true;
}
