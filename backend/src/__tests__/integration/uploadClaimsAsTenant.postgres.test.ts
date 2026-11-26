// Regression test for migration 0197 (platform upload claims as the session's
// tenant). Replays the real numbered migrations with the standard runner as a
// non-superuser, non-BYPASSRLS migration role (as on Azure), then calls the
// upload worker's platform functions as service_role with NO tenant claim.
//
// Opt in with a superuser URL to a DISPOSABLE PostgreSQL 16 server:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/uploadClaimsAsTenant.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
//
// The test creates (if missing) the cluster roles web_anon, authenticated,
// service_role (BYPASSRLS) and mike_rls_test_migrator, and creates and drops
// its own mike_rls_test_* database; it never touches another database.
// MIKE_TENANT_RLS_TEST_THROUGH=0196 replays only files up to that number,
// which shows the defect 0197 fixes (these tests then fail).
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const through = process.env.MIKE_TENANT_RLS_TEST_THROUGH;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";
const PLATFORM_CLAIMS = '{"role":"service_role"}';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!adminUrl)("upload claim and expiry as the platform, without a tenant claim (0197)", () => {
    const database = `mike_rls_test_${process.pid}_${Date.now()}`;
    const password = randomBytes(12).toString("hex");
    let admin: Client;
    let db: Client;
    let directory: string | undefined;

    const urlFor = (user: string, secret: string) => {
        const url = new URL(adminUrl!);
        url.username = user;
        url.password = secret;
        url.pathname = `/${database}`;
        return url.toString();
    };

    beforeAll(async () => {
        admin = new Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(`do $$ begin
            if not exists (select 1 from pg_roles where rolname='web_anon') then create role web_anon nologin; end if;
            if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
            if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
            if not exists (select 1 from pg_roles where rolname='${MIGRATOR}') then
                create role ${MIGRATOR} login nosuperuser nobypassrls createrole createdb;
            end if;
        end $$`);
        await admin.query(`alter role ${MIGRATOR} with login password '${password}' nosuperuser nobypassrls createrole createdb`);
        await admin.query(`grant web_anon, authenticated, service_role to ${MIGRATOR} with admin option`);
        await admin.query(`create database ${database} owner ${MIGRATOR}`);

        const source = path.resolve(__dirname, "../../../migrations");
        let migrations = source;
        if (through) {
            directory = await mkdtemp(path.join(tmpdir(), "mike-rls-test-"));
            for (const name of await readdir(source)) {
                if (name.endsWith(".sql") && name.slice(0, 4) <= through) {
                    await copyFile(path.join(source, name), path.join(directory, name));
                }
            }
            migrations = directory;
        }
        db = new Client({ connectionString: urlFor(MIGRATOR, password) });
        await db.connect();
        await expect(runMigrationCommand(db, { kind: "up" }, migrations, quiet)).resolves.toBe(0);
        // The gates are executable by service_role only.
        await db.query("set role service_role");
        const gaps = await db.query(`select (select count(*) from app.tenant_rls_gaps())::int as rls,
            (select count(*) from app.control_plane_gaps())::int as cp`);
        await db.query("reset role");
        expect(gaps.rows[0]).toEqual({ rls: 0, cp: 0 });
    }, 600_000);

    afterAll(async () => {
        await db?.end().catch(() => {});
        if (directory) await rm(directory, { recursive: true, force: true });
        if (admin) {
            await admin.query(`drop database if exists ${database} with (force)`).catch(() => {});
            await admin.end().catch(() => {});
        }
    });

    // Each test runs in a transaction that is rolled back, as the platform:
    // service_role with no tenant_id claim, like createPlatformSupabase().
    beforeEach(async () => {
        await db.query("begin");
        await db.query("set local role service_role");
        await db.query("select set_config('request.jwt.claims', $1, true)", [PLATFORM_CLAIMS]);
        await db.query(`insert into public.tenants (tenant_id, status) values ('up-a','active'), ('up-off','active')`);
    });
    afterEach(async () => {
        await db.query("rollback");
    });

    async function session(n: number, tenant: string, status: string, fileStatus: string) {
        await db.query(`insert into public.upload_sessions
            (id, tenant_id, user_id, purpose, destination, expected_file_count, expected_total_bytes, status, expires_at)
            values ($1, $2, 'user-' || $2, 'document_create', '{}'::jsonb, 1, 10, $3, now() + interval '1 hour')`,
            [id(n), tenant, status]);
        await db.query(`insert into public.upload_session_files
            (id, tenant_id, session_id, resource_id, client_id, filename, file_type, content_type,
             expected_size_bytes, staging_storage_path, sealed_storage_path, status)
            values ($1, $2, $3, gen_random_uuid(), 'c' || $4, 'a.pdf', 'pdf', 'application/pdf', 10, 's/' || $4, 'x/' || $4, $5)`,
            [id(n + 100), tenant, id(n), String(n), fileStatus]);
    }
    async function job(n: number, tenant: string, status: "queued" | "running", attempts: number, age: string) {
        await db.query(`insert into public.upload_processing_jobs
            (id, tenant_id, session_id, file_id, user_id, status, attempts, available_at, locked_at, created_at)
            values ($1, $2, $3, $4, 'user-' || $2, $5, $6, now() - $7::interval,
                    case when $5 = 'running' then now() - $7::interval end, now() - $7::interval)`,
            [id(n + 200), tenant, id(n), id(n + 100), status, attempts, age]);
    }
    const jobStatus = async (n: number) =>
        (await db.query("select status from public.upload_processing_jobs where id = $1", [id(n + 200)])).rows[0]?.status;
    const sessionStatus = async (n: number) =>
        (await db.query("select status from public.upload_sessions where id = $1", [id(n)])).rows[0]?.status;
    const claims = async () =>
        (await db.query("select current_setting('request.jwt.claims') as c")).rows[0].c;
    const claim = async () =>
        (await db.query("select public.claim_upload_processing_job('worker-1', 600, 4) as job")).rows[0].job;
    const expire = async () =>
        (await db.query("select public.expire_exhausted_upload_jobs(1800, 20) as n")).rows[0].n;

    it("claims a tenant's queued job and refreshes its session as that tenant", async () => {
        await session(1, "up-a", "uploaded", "uploaded");
        await job(1, "up-a", "queued", 0, "1 minute");

        expect(await claim()).toBe(id(201));
        expect(await jobStatus(1)).toBe("running");
        expect(await sessionStatus(1)).toBe("processing");
        expect(await claims()).toBe(PLATFORM_CLAIMS);
    });

    it("expires a tenant's exhausted job and refreshes its session as that tenant", async () => {
        await session(2, "up-a", "processing", "processing");
        await job(2, "up-a", "running", 3, "2 hours");

        expect(await expire()).toBe(1);
        expect(await jobStatus(2)).toBe("error");
        expect(await sessionStatus(2)).toBe("error");
        expect(await claims()).toBe(PLATFORM_CLAIMS);
    });

    it("skips an offboarding tenant's jobs instead of failing every tenant's claim", async () => {
        await session(3, "up-off", "uploaded", "uploaded");
        await job(3, "up-off", "queued", 0, "1 hour");
        await session(4, "up-off", "processing", "processing");
        await job(4, "up-off", "running", 3, "2 hours");
        await session(5, "up-a", "uploaded", "uploaded");
        await job(5, "up-a", "queued", 0, "1 minute");
        await db.query("update public.tenants set status = 'offboarding' where tenant_id = 'up-off'");

        // The offboarding tenant's job is older, so it would be claimed first.
        expect(await claim()).toBe(id(205));
        expect(await claim()).toBeNull();
        expect(await expire()).toBe(0);
        expect(await jobStatus(3)).toBe("queued");
        expect(await jobStatus(4)).toBe("running");
        expect(await sessionStatus(5)).toBe("processing");
        expect(await claims()).toBe(PLATFORM_CLAIMS);
    });
});
