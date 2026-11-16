// worker_threads bootstrap: the default home for background work in a
// single-process deployment. index.ts spawns this thread so queue workers,
// the DB-job runner, and maintenance sweeps run OFF the main event loop —
// an HTTP request can never be starved by a CPU-heavy job (zip building,
// export serialization, pdf parsing), and the seam to a fully separate
// worker process/machine (src/worker.ts) stays identical.

import "dotenv/config";
import "./telemetry";
import { installProcessGuards } from "./lib/processGuards";
installProcessGuards();
import { installStructuredLogging } from "./lib/logging/install";
const logging = installStructuredLogging({ proc: "worker-thread" });
import { log } from "./lib/logging/root";
import { readTenantDebugSwitches } from "./lib/logging/tenantDebugStore";
import { parentPort, workerData } from "node:worker_threads";
import { startAllWorkers, stopAllWorkers, WORKER_ROLES, type WorkerRole } from "./workerRuntime";
import { initSentry } from "./lib/observability/sentry";

initSentry("worker-thread");
const role = (workerData as { role?: unknown } | null)?.role;
if (role !== undefined && !WORKER_ROLES.includes(role as WorkerRole)) throw new Error("Invalid background worker role");
void startAllWorkers(role === undefined ? WORKER_ROLES : [role as WorkerRole]).then(() => {
    logging.debugSwitches.start(readTenantDebugSwitches);
    parentPort?.postMessage("ready");
    console.log("[worker-thread] background workers started");
    log().info("process.start", { role: typeof role === "string" ? role : "all" });
}).catch((error) => {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});

parentPort?.on("message", (message: unknown) => {
    if (message === "shutdown") {
        log().info("process.shutdown", { signal: "shutdown" });
        logging.debugSwitches.stop();
        void stopAllWorkers()
            .then(() => process.exit(0))
            .catch((err) => {
                console.error("[worker-thread] shutdown error", err);
                process.exit(1);
            });
    }
});
