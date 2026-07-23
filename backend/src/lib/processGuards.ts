/**
 * Last-resort process guards. Express 4 does not catch async route-handler
 * rejections, so without these ONE request whose handler throws kills the
 * whole container (Node exits 1 on unhandledRejection), Container Apps
 * restarts it, and ingress serves Envoy 503s to everyone meanwhile —
 * exactly the backend:1.0.9 Download crash-loop a customer reported (see
 * so a request-scoped configuration error cannot terminate the service).
 *
 * The poisoned request itself still fails (the client times out — no
 * response is ever sent); the guard only stops it taking the process, and
 * every other user's connection, down with it. console.error is picked up
 * by App Insights' console auto-collection (telemetry.ts).
 */
export function installProcessGuards(): void {
    process.on("unhandledRejection", (reason) => {
        console.error("[unhandledRejection] async error escaped a handler:", reason);
    });
    process.on("uncaughtException", (err) => {
        // Sync escapes can't come from Express handlers (Express catches
        // those), so process state is unknowable here — log and exit;
        // Container Apps restarts the replica.
        console.error("[uncaughtException]", err);
        process.exit(1);
    });
}
