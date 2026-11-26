import { DefaultAzureCredential } from "@azure/identity";
import { validatePostgresSessionUri } from "./postgresSession";

/** Direct session/migration-owner credentials; never the PostgREST pool URL. */
export async function getMigrationDatabaseUrl(): Promise<string> {
  let uri = process.env.DATABASE_URL;
  if (!uri) {
    const host = process.env.PG_HOST;
    const user = process.env.PG_MI_USERNAME;
    if (!host || !user) throw new Error("Migration owner needs DATABASE_URL or PG_HOST + PG_MI_USERNAME");
    const token = await new DefaultAzureCredential().getToken("https://ossrdbms-aad.database.windows.net/.default");
    if (!token?.token) throw new Error("Failed to acquire Managed Identity token for PostgreSQL");
    uri = "postgresql://" + encodeURIComponent(user) + ":" + encodeURIComponent(token.token) + "@"
      + host + ":" + (process.env.PG_PORT || "5432") + "/" + (process.env.PG_DATABASE || "postgres") + "?sslmode=require";
  }
  const local = process.env.NODE_ENV !== "production" && process.env.AUTH_PROVIDER === "local";
  validatePostgresSessionUri(uri, local);
  const parsed = new URL(uri);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  if (!parsed.searchParams.has("sslmode") && !(local && loopback)) parsed.searchParams.set("sslmode", "require");
  return parsed.toString();
}
