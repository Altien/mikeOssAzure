import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The document-lifecycle guard exists to stop code from serving requests the
// database cannot back (deletes that orphan storage, uploads that fail on a
// missing column). It only does that if the answer is in BEFORE the API binds
// its port and before any worker claims a job. An earlier version fired the
// probe without awaiting it: `app.listen` and `startAllWorkers` ran while the
// check was still in flight, so a destructive request or a claimed job could
// land in the window between "listening" and "exit(1)".
//
// This spawns the real entrypoints against a stub PostgREST that answers the
// probe with 0 ("migration not applied") and asserts that neither process
// ever reports listening or starting its runner before it exits 1.
const backendRoot = path.resolve(__dirname, "..", "..");

function stubSupabase(): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
        if (req.method === "GET" && req.url?.startsWith("/auth_sessions?")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("[]");
            return;
        }
        if (req.method === "POST" && req.url?.startsWith("/rpc/document_lifecycle_version")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("0");
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"message":"stub: not found"}');
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({ server, url: `http://127.0.0.1:${port}` });
        });
    });
}

async function runEntrypoint(
    file: string,
    env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
    const child: ChildProcess = spawn(
        process.execPath,
        ["--import", pathToFileURL(path.join(backendRoot, "node_modules/tsx/dist/loader.mjs")).href, path.join(backendRoot, file)],
        { cwd: backendRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    // Generous: under a full parallel vitest run on a small machine, booting
    // the real entrypoint through tsx can take well over ten seconds.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
    const [code] = (await once(child, "exit")) as [number | null];
    clearTimeout(timeout);
    return { code, output };
}

let stub: Server | null = null;
afterEach(() => {
    stub?.close();
    stub = null;
});

describe("document-lifecycle boot gate", () => {
    it("API: refuses to listen or start workers when the migration is missing", async () => {
        const { server, url } = await stubSupabase();
        stub = server;
        const { code, output } = await runEntrypoint("src/index.ts", {
            PORT: "0",
            WORKERS_MODE: "inline",
            QUEUE_DRIVER: "postgres",
            DB_JOBS_POLL_MS: "60000",
            SUPABASE_URL: url,
            SUPABASE_SECRET_KEY: "not-a-real-key",
            SUPABASE_PUBLISHABLE_KEY: "not-a-real-key",
            AUTH_PROVIDER: "local",
            AUTH_SESSION_ENCRYPTION_SECRET: Buffer.alloc(32, 1).toString("base64url"),
            AUTH_HANDOFF_ENCRYPTION_SECRET: Buffer.alloc(32, 2).toString("base64url"),
            AUTH_STATE_SECRET: Buffer.alloc(32, 3).toString("base64url"),
        });
        expect(output).toMatch(/document-lifecycle migration is not applied/);
        expect(output).not.toMatch(/Mike backend running on port/);
        expect(output).not.toMatch(/\[dbq\] runner started/);
        // Windows can report a native loader status after the fatal startup
        // path; the security contract is a nonzero exit before listen/claim.
        expect(typeof code).toBe("number");
        expect(code).not.toBe(0);
    }, 60_000);

    it("worker: refuses to start the runner when the migration is missing", async () => {
        const { server, url } = await stubSupabase();
        stub = server;
        const { code, output } = await runEntrypoint("src/worker.ts", {
            QUEUE_DRIVER: "postgres",
            DB_JOBS_POLL_MS: "60000",
            SUPABASE_URL: url,
            SUPABASE_SECRET_KEY: "not-a-real-key",
            AUTH_PROVIDER: "local",
            AUTH_SESSION_ENCRYPTION_SECRET: Buffer.alloc(32, 1).toString("base64url"),
            AUTH_HANDOFF_ENCRYPTION_SECRET: Buffer.alloc(32, 2).toString("base64url"),
            AUTH_STATE_SECRET: Buffer.alloc(32, 3).toString("base64url"),
        });
        expect(output).toMatch(/document-lifecycle migration is not applied/);
        expect(output).not.toMatch(/\[dbq\] runner started/);
        expect(code).toBe(1);
    }, 60_000);
});
