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
import { parentPort } from "node:worker_threads";
import { startAllWorkers, stopAllWorkers } from "./workerRuntime";
import { initSentry } from "./lib/observability/sentry";

initSentry("worker-thread");
void startAllWorkers().then(() => {
    parentPort?.postMessage("ready");
    console.log("[worker-thread] background workers started");
}).catch((error) => {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});

parentPort?.on("message", (message: unknown) => {
    if (message === "shutdown") {
        void stopAllWorkers()
            .then(() => process.exit(0))
            .catch((err) => {
                console.error("[worker-thread] shutdown error", err);
                process.exit(1);
            });
    }
});
