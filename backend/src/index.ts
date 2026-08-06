// Order matters here.
//   1. dotenv/config: loads .env into process.env so the next line can
//      read APPLICATIONINSIGHTS_CONNECTION_STRING from a local .env in
//      dev. (In Azure the env var comes from Container App secretRef,
//      no .env file involved.)
//   2. telemetry: applicationinsights' auto-instrumentation patches
//      require()/import at module-load time, so anything network-y
//      (http, express, pg, ...) MUST be imported AFTER this for those
//      calls to be captured. dotenv is a one-shot file reader with no
//      network/DB side effects, so it's safe before telemetry.
//   3. app construction lives in ./app (buildApp) so tests can mount the
//      Express app via supertest without binding a port or pulling in
//      telemetry/process-guard side effects.
import "dotenv/config";
import "./telemetry";
import { installProcessGuards } from "./lib/processGuards";
installProcessGuards();
import { buildApp } from "./app";
import { initDownloadSigningSecret } from "./lib/downloadTokens";
import { initManifestSigningKey, manifestPublicKey } from "./lib/manifestSigning";
import { checkSchemaVersion } from "./lib/schemaCheck";
import { initServerSessionKeys } from "./lib/serverSession";
import { anyWorkerEnabled, startWorkers, stopWorkers } from "./workers";
import { runStaleWorkSweep } from "./lib/maintenance/staleWork";

const PORT = process.env.PORT ?? 3001;

// Warm the download-token signing secret from Key Vault before accepting
// traffic — Azure deploys don't secretRef it into the env (040 Entry 19),
// and the sync signing path needs it in process.env. resolveSecret never
// rejects; .finally() is belt-and-braces so a bug there can't stop listen.
// Same for the (optional) export-manifest signing key.
async function start(): Promise<void> {
  // Required auth material and the session schema must exist before ingress
  // can reach this revision. Optional export warmups remain best effort.
  await initServerSessionKeys();
  await Promise.all([
    initDownloadSigningSecret(),
    initManifestSigningKey().catch(() => {}),
  ]);
  // Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when
  // someone's first export fails. Unset is valid (manifests export unsigned);
  // malformed is a misconfiguration, so stop rather than serve a deployment
  // whose exports will fail later.
  try {
    const signingKey = manifestPublicKey();
    if (signingKey) {
      console.log(`Export manifests signed with key ${signingKey.key_id}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const server = buildApp().listen(PORT, () => {
    console.log(`Mike backend running on port ${PORT}`);
    if (anyWorkerEnabled()) startWorkers();
    // After listen, and never awaited: a schema report must not delay or
    // prevent serving traffic. Migrations stay a deliberate manual step.
    void checkSchemaVersion().catch(() => {});
  });

  const sweepInterval = Number(process.env.STALE_SWEEP_INTERVAL_MS) || 600_000;
  const runSweep = () => void runStaleWorkSweep().catch((error) =>
    console.error("[stale-sweep] failed", error),
  );
  const initialSweep = setTimeout(runSweep, 30_000);
  initialSweep.unref();
  const sweepTimer = setInterval(runSweep, sweepInterval);
  sweepTimer.unref();

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(initialSweep);
    clearInterval(sweepTimer);
    const forced = setTimeout(() => process.exit(1), 15_000);
    forced.unref();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      await stopWorkers();
      clearTimeout(forced);
      console.log(`Graceful shutdown complete (${signal})`);
      process.exit(0);
    } catch (error) {
      console.error("Graceful shutdown failed", error);
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void start().catch((error) => {
  console.error("Required backend initialization failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
