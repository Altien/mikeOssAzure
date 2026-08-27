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

import { startAllWorkers, stopAllWorkers } from "./workerRuntime";

startAllWorkers();

// KEEPALIVE. Everything startAllWorkers() creates is deliberately unref'd —
// it has to be, because the same code runs inside the API process and its
// timers must not stop that process from exiting. In the Redis topology the
// BullMQ workers' open sockets happen to hold the loop, which hides this; in
// Postgres mode (the default) nothing does, and `node dist/worker.js` starts
// the runner, logs that it is running, and exits within half a second.
// `process.on("SIGTERM")` does not keep the loop alive — signal handlers are
// not handles — so the entrypoint needs one ref'd handle of its own. This is
// it, and it is cleared on shutdown so the process can still exit promptly.
const keepAlive = setInterval(() => {}, 60_000);
console.log("Mike worker process running");

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Worker shutting down gracefully (${signal})`);
    clearInterval(keepAlive);
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
