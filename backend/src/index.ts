// Telemetry must initialize before network clients are imported.
import "dotenv/config";
import "./telemetry";
import { Worker as ThreadWorker } from "node:worker_threads";
import path from "node:path";
import { installProcessGuards } from "./lib/processGuards";
installProcessGuards();
import { buildApp } from "./app";
import { initDownloadSigningSecret } from "./lib/downloadTokens";
import { initManifestSigningKey, manifestPublicKey } from "./lib/manifestSigning";
import { checkSchemaVersion } from "./lib/schemaCheck";
import { initServerSessionKeys } from "./lib/serverSession";
import { closeStreamRunCluster, initStreamRunCluster, streamRunCluster } from "./lib/streamRunCluster";
import { installStreamRunRelayHandler } from "./lib/streamRuns";
import { submitClientToolResult } from "./modules/chat/chat.service";
import { enforceDocumentLifecycleMigration } from "./lib/dbq/lifecycleGuard";
import { startAllWorkers, stopAllWorkers } from "./workerRuntime";
import { initSentry } from "./lib/observability/sentry";
import { getKeyVaultConfig } from "./lib/config";
import { failBoot, listenOrFail } from "./lib/processLifecycle";

const PORT = process.env.PORT ?? 3001;
const workersMode = process.env.WORKERS_MODE === "inline" || process.env.WORKERS_MODE === "none"
  ? process.env.WORKERS_MODE : "thread";
let shuttingDown = false;

async function startThread(): Promise<ThreadWorker> {
  const isTs = __filename.endsWith(".ts");
  const entry = path.join(__dirname, isTs ? "workerThread.ts" : "workerThread.js");
  const thread = new ThreadWorker(entry, { execArgv: isTs ? ["--require", "tsx/cjs"] : [] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker thread startup timed out")), 30_000);
      const onMessage = (message: unknown) => {
        if (message === "ready") {
          clearTimeout(timeout);
          thread.off("error", onError);
          thread.off("exit", onExit);
          thread.off("message", onMessage);
          resolve();
        } else if (message && typeof message === "object" && "error" in message) {
          clearTimeout(timeout);
          reject(new Error(String(message.error)));
        }
      };
      const onError = (error: Error) => { clearTimeout(timeout); reject(error); };
      const onExit = (code: number) => { clearTimeout(timeout); reject(new Error(`Worker thread exited during startup (${code})`)); };
      thread.on("message", onMessage);
      thread.once("error", onError);
      thread.once("exit", onExit);
    });
  } catch (error) {
    await thread.terminate();
    throw error;
  }
  thread.on("error", (error) => {
    if (!shuttingDown) {
      console.error("Worker thread failed", error);
      process.exit(1);
    }
  });
  thread.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`Worker thread exited unexpectedly (${code})`);
      process.exit(1);
    }
  });
  return thread;
}

async function start(): Promise<void> {
  const telemetryDsn = await getKeyVaultConfig("sentry-dsn").catch(() => "");
  if (telemetryDsn) process.env.SENTRY_DSN = telemetryDsn;
  initSentry("api");
  await initServerSessionKeys();
  // Fail fast on the document-lifecycle contract (upstream order: before any
  // other database-dependent startup) so a missing migration is reported as
  // such rather than as a stream-run connection failure.
  await enforceDocumentLifecycleMigration();
  await initStreamRunCluster();
  installStreamRunRelayHandler(async (payload) => {
    if (!payload || typeof payload !== "object") return false;
    const { callId, userId, result, runId, fence } = payload as Record<string, unknown>;
    if (typeof callId !== "string" || typeof userId !== "string" || typeof runId !== "string" || typeof fence !== "string") return false;
    const cluster = streamRunCluster();
    const [call, run] = await Promise.all([cluster?.toolCall(callId, userId), cluster?.lookup(runId)]);
    if (!cluster || !call || !run || call.owner_instance !== cluster.instanceId || call.run_id !== runId || call.fence !== fence || run.fence !== fence) return false;
    const delivered = submitClientToolResult(callId, userId, result);
    if (delivered) void cluster.settleToolCall(callId, userId).catch(() => {});
    return delivered;
  });
  await initDownloadSigningSecret();
  await initManifestSigningKey();
  const signingKey = manifestPublicKey();
  if (signingKey) console.log(`Export manifests signed with key ${signingKey.key_id}`);

  let thread: ThreadWorker | null = null;
  if (workersMode === "thread") thread = await startThread();
  if (workersMode === "inline") await startAllWorkers();

  const server = listenOrFail(buildApp(), PORT, () => {
    console.log(`Mike backend running on port ${PORT} (workers: ${workersMode})`);
    void checkSchemaVersion().catch(() => {});
  });

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const forced = setTimeout(() => process.exit(1), 15_000);
    forced.unref();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      if (workersMode === "inline") await stopAllWorkers();
      await closeStreamRunCluster();
      if (thread) {
        const active = thread;
        const exit = new Promise<void>((resolve) => active.once("exit", () => resolve()));
        active.postMessage("shutdown");
        await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
        if (active.threadId !== -1) await active.terminate();
      }
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
  void failBoot(error, "startup");
});
