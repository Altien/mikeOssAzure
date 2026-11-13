import { getKeyVaultConfig } from "./config";
import { getTenancyMode } from "./tenancyMode";

/** Validate the session endpoint used by LISTEN and schema/partition ownership. */
export function validatePostgresSessionUri(uri: string, localDevelopment = false): string {
  const parsed = new URL(uri);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) throw new Error("Session database URI must use PostgreSQL");
  if (!localDevelopment && parsed.port && parsed.port !== "5432") throw new Error("Session database URI requires direct PostgreSQL port 5432");
  if (parsed.searchParams.get("pool_mode") === "transaction" || parsed.searchParams.get("pgbouncer") === "true") {
    throw new Error("Session database URI cannot use transaction pooling");
  }
  return uri;
}

/** Loopback is the local docker-compose Postgres, which has no TLS. */
export function sessionUsesTls(uri: string): boolean {
  return !["localhost", "127.0.0.1", "::1"].includes(new URL(uri).hostname);
}

/** Pooled stamps use a separate session URI, never the PostgREST pool URI. */
export async function streamRunDatabaseUri(): Promise<string> {
  const pooled = await getTenancyMode() === "pooled";
  let uri = "";
  if (process.env.KEY_VAULT_NAME) {
    try { uri = await getKeyVaultConfig(pooled ? "postgres-session-uri" : "pgrst-db-uri"); }
    catch (error) {
      if (pooled && (error as { statusCode?: number }).statusCode !== 404) throw error;
      if (!process.env.STREAM_RUN_DATABASE_URL) throw error;
    }
  }
  uri ||= process.env.STREAM_RUN_DATABASE_URL || "";
  if (!uri || uri === "__unset__") throw new Error("Stream run database URI unavailable");
  // Upstream desktop 89dc8323 supervises its own direct PostgreSQL on a
  // dedicated loopback port, including in production builds.
  const desktopLoopback = process.env.AUTH_PROVIDER === "local" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(uri).hostname);
  return validatePostgresSessionUri(
    uri,
    desktopLoopback || (process.env.NODE_ENV !== "production" && process.env.AUTH_PROVIDER === "local"),
  );
}
