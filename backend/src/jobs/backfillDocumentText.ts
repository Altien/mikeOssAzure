import "dotenv/config";
import "../telemetry";
import { installProcessGuards } from "../lib/processGuards";
installProcessGuards();
import { createServerSupabase } from "../lib/supabase";
import { backfillDocumentText } from "../modules/documents/documents.service";
import { safeError } from "../lib/safeError";
import { initStorage } from "../lib/storage";

// One bounded batch per invocation. The regular maintenance sweep continues
// automatically; --retry-failed explicitly requeues terminal extraction failures.
async function main(): Promise<number> {
  await initStorage();
  return backfillDocumentText(createServerSupabase(), {
    limit: 500, retryFailed: process.argv.includes("--retry-failed"),
  });
}

void main().then((queued) => console.log(`Queued ${queued} document text extractions.`))
  .catch((error) => { console.error("Document text backfill failed", safeError(error)); process.exitCode = 1; });
