// Standalone worker entrypoint — run background workers as their own
// process, container, or machine:
//
//   node dist/worker.js            (prod)
//   npx tsx src/worker.ts          (dev)
//
// Pair it with WORKERS_MODE=none on the API process so work runs exactly
// once. Scale-out is safe by construction: BullMQ partitions work per
// connection, and the DB queue's claim is FOR UPDATE SKIP LOCKED — N worker
// processes divide the jobs, never duplicate them.

import "dotenv/config";
import "./telemetry";
import { installProcessGuards } from "./lib/processGuards";
installProcessGuards();
import { startAllWorkers, stopAllWorkers } from "./workerRuntime";

// The Postgres poller unrefs its timers so an inline API can shut down
// naturally. A standalone worker must retain a live event-loop reference.
const keepAlive = setInterval(() => {}, 60_000);
void startAllWorkers().then(() => {
    console.log("Mike worker process running");
}).catch((error) => {
    console.error("Worker initialization failed", error);
    clearInterval(keepAlive);
    process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    console.log(`Worker shutting down gracefully (${signal})`);
    const forceExit = setTimeout(() => {
        console.error("Worker graceful shutdown timed out — forcing exit");
        process.exit(1);
    }, 15_000);
    forceExit.unref();
    try {
        await stopAllWorkers();
        process.exit(0);
    } catch (err) {
        console.error("Error during worker shutdown", err);
        process.exit(1);
    }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
