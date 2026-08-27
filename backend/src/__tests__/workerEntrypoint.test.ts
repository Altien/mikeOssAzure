import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

// `node dist/worker.js` is the documented standalone-worker topology
// (WORKERS_MODE=none on the API, workers on their own container). Everything
// startAllWorkers() creates is deliberately unref'd — it has to be, because
// the same code runs inside the API process — and a signal handler is not a
// handle, so without one ref'd handle of its own the entrypoint starts the
// runner, logs "running", and exits immediately. In Redis mode BullMQ's open
// sockets hide this; in Postgres mode (the default transport) nothing does.
//
// This spawns the real entrypoint against a Supabase URL that does not answer
// — the runner logs claim failures and keeps polling, which is exactly the
// behaviour under test — and asserts it is still alive a second later.
const backendRoot = path.resolve(__dirname, "../..");
const ALIVE_AFTER_MS = 1_500;

describe("standalone worker entrypoint", () => {
    it("stays alive in Postgres mode instead of exiting immediately", async () => {
        const child = spawn(
            process.execPath,
            [
                path.join(backendRoot, "node_modules/tsx/dist/cli.mjs"),
                path.join(backendRoot, "src/worker.ts"),
            ],
            {
                cwd: backendRoot,
                stdio: "ignore",
                env: {
                    ...process.env,
                    QUEUE_DRIVER: "postgres",
                    DB_JOBS_POLL_MS: "60000",
                    SUPABASE_URL: "http://127.0.0.1:9",
                    SUPABASE_SECRET_KEY: "not-a-real-key",
                },
            },
        );

        const exited = new Promise<number | null>((resolve) =>
            child.on("exit", (code) => resolve(code)),
        );
        const stillRunning = Symbol("alive");
        const outcome = await Promise.race([
            exited,
            new Promise<symbol>((resolve) =>
                setTimeout(() => resolve(stillRunning), ALIVE_AFTER_MS),
            ),
        ]);

        child.kill("SIGKILL");
        expect(
            outcome,
            "the worker process exited instead of staying up to poll",
        ).toBe(stillRunning);
    }, 20_000);
});
