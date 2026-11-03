import "dotenv/config";
import { Client } from "pg";
import { getMigrationDatabaseUrl } from "../lib/deploymentDatabase";
import { deployStampRuntime } from "../lib/stampDeployment";

async function main(): Promise<void> {
  const db = new Client({ connectionString: await getMigrationDatabaseUrl(), connectionTimeoutMillis: 15_000 });
  try {
    await db.connect();
    const created = await deployStampRuntime(db);
    console.log("[stamp] deployment metadata configured; ledger partitions created: " + created);
  } finally { await db.end().catch(() => {}); }
}
void main().catch(error => { console.error("Stamp deployment setup failed", error); process.exitCode = 1; });
