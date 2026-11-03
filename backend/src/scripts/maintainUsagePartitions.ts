import "dotenv/config";
import { Client } from "pg";
import { getMigrationDatabaseUrl } from "../lib/deploymentDatabase";
import { maintainLedgerPartitions } from "../lib/stampDeployment";

async function main(): Promise<void> {
  const db = new Client({ connectionString: await getMigrationDatabaseUrl(), connectionTimeoutMillis: 15_000 });
  try {
    await db.connect();
    const created = await maintainLedgerPartitions(db);
    console.log("[ledger] future monthly partitions ready; created: " + created);
  } finally { await db.end().catch(() => {}); }
}
void main().catch(error => { console.error("Ledger partition maintenance failed", error); process.exitCode = 1; });
