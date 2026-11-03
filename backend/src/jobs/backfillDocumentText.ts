import "dotenv/config";
import "../telemetry";
import { installProcessGuards } from "../lib/processGuards";
installProcessGuards();
import { runDocumentTextBackfill } from "./maintenance";
import { safeError } from "../lib/safeError";
import { initStorage } from "../lib/storage";

// One bounded batch per invocation (per tenant on a pooled install). The
// regular maintenance sweep continues automatically; --retry-failed
// explicitly requeues terminal extraction failures.
async function main(): Promise<void> {
  await initStorage();
  const report = await runDocumentTextBackfill({
    limit: 500, retryFailed: process.argv.includes("--retry-failed"),
  });
  for (const { tenantId, queued } of report.tenants) {
    console.log(`Tenant ${tenantId}: queued ${queued} document text extractions.`);
  }
  console.log(`Queued ${report.queued} document text extractions.`);
  for (const { tenantId, error } of report.failures) {
    console.error("Document text backfill failed for a tenant", { tenantId, ...safeError(error) });
  }
  if (report.failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => { console.error("Document text backfill failed", safeError(error)); process.exitCode = 1; });
