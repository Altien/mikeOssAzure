import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const backendRoot = path.resolve(__dirname, "../..");
const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
// Child-process boot budget, and each test's timeout above it (spawn + kill).
const READINESS_MS = 20_000;
const TEST_TIMEOUT_MS = READINESS_MS + 10_000;

async function withStubDb(fn: (url: string) => Promise<void>) {
    // Worker readiness probes auth_sessions, db_jobs and the claim RPC. The
    // server gives the real PostgREST client a responsive schema endpoint,
    // isolating the entrypoint's keepalive and dotenv behavior.
    const server = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        // Dev drift: upstream #295's document-lifecycle boot gate must see the
        // required contract version before workers start.
        // 019: the read-only stamp metadata probe runs before any queue claim.
        res.end(req.url?.includes("/rpc/document_lifecycle_version") ? "2"
            : req.url?.includes("/rpc/stamp_runtime_metadata")
                ? JSON.stringify({ pooled: false, fallback_tenant_id: null, stamp_id: null, region: null, platform_credentials: [] }) : "[]");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No test listener");
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

function workerEnv(url: string): Record<string, string> {
    return {
        ...process.env as Record<string, string>,
        AUTH_PROVIDER: "local",
        TENANCY_MODE: "single",
        QUEUE_DRIVER: "postgres",
        DB_JOBS_POLL_MS: "60000",
        SUPABASE_URL: url,
        SUPABASE_SECRET_KEY: "test-key",
        // Multi-tenant 008: every PostgREST call is signed per request; there
        // is no fallback to the static key.
        JWT_SECRET: secret(4),
        AUTH_SESSION_ENCRYPTION_SECRET: secret(1),
        AUTH_HANDOFF_ENCRYPTION_SECRET: secret(2),
        AUTH_STATE_SECRET: secret(3),
    };
}

async function assertWorkerReady(cwd: string, env: Record<string, string>) {
    const child = spawn(process.execPath, [
        "--import", pathToFileURL(path.join(backendRoot, "node_modules/tsx/dist/loader.mjs")).href,
        path.join(backendRoot, "src/worker.ts"),
    ], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    const exited = new Promise<number | null>(resolve => child.on("exit", resolve));
    try {
        const outcome = await Promise.race([
            exited,
            new Promise<"ready">(resolve => {
                const timer = setInterval(() => {
                    if (output.includes("Mike worker process running")) {
                        clearInterval(timer);
                        resolve("ready");
                    }
                }, 25);
                // The child transpiles the whole worker graph with tsx before
                // its readiness probes: ~5-6 s alone, past 8 s under full-suite
                // load. A hung or crashed worker still fails (exit / no banner).
                setTimeout(() => { clearInterval(timer); resolve("ready"); }, READINESS_MS);
            }),
        ]);
        expect(outcome, output).toBe("ready");
        expect(output).toContain("Mike worker process running");
        expect(child.exitCode, output).toBeNull();
    } finally {
        child.kill("SIGKILL");
        await exited;
    }
}

describe("standalone worker entrypoint", () => {
    it("stays alive in Postgres mode after its required readiness probes", async () => {
        await withStubDb(async url => {
            await assertWorkerReady(backendRoot, workerEnv(url));
        });
    }, TEST_TIMEOUT_MS);

    it("loads required configuration from a bare-metal .env", async () => {
        await withStubDb(async url => {
            const workDir = mkdtempSync(path.join(os.tmpdir(), "worker-dotenv-"));
            const config = workerEnv(url);
            writeFileSync(path.join(workDir, ".env"), [
                "AUTH_PROVIDER", "TENANCY_MODE", "QUEUE_DRIVER", "DB_JOBS_POLL_MS",
                "SUPABASE_URL", "SUPABASE_SECRET_KEY", "JWT_SECRET",
                "AUTH_SESSION_ENCRYPTION_SECRET", "AUTH_HANDOFF_ENCRYPTION_SECRET",
                "AUTH_STATE_SECRET",
            ].map(key => `${key}=${config[key]}`).join("\n") + "\n");
            const env = { ...process.env as Record<string, string> };
            for (const key of Object.keys(config)) {
                if (key in env && [
                    "AUTH_PROVIDER", "TENANCY_MODE", "QUEUE_DRIVER", "DB_JOBS_POLL_MS",
                    "SUPABASE_URL", "SUPABASE_SECRET_KEY", "JWT_SECRET",
                    "AUTH_SESSION_ENCRYPTION_SECRET", "AUTH_HANDOFF_ENCRYPTION_SECRET",
                    "AUTH_STATE_SECRET",
                ].includes(key)) delete env[key];
            }
            try {
                await assertWorkerReady(workDir, env);
            } finally {
                rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            }
        });
    }, TEST_TIMEOUT_MS);
});
