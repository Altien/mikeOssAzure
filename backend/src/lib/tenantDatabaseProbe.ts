// Read-only proof that tenant traffic can reach the database as its own role.
//
// probeStampRuntime proves service_role, but tenant requests run as
// tenantDbRole(). A PostgREST login without that role leaves a healthy-looking
// API where every sign-in fails (migration 0180 grants tenant_app only to the
// migration login and to `authenticator`). This call goes through the same
// client and signing as tenant traffic, so the role and claims are the real
// ones and `tenant-rls-enforced=false` naturally stops requiring tenant_app.
//
// Errors carry only the database code, on purpose with no `cause`: failBoot logs
// and reports the error, and a raw driver message can hold connection details.

import { createServerSupabase, tenantDbRole, usesSignedPostgrest } from "./supabase";
import { getTenancyMode } from "./tenancyMode";
import { installTenantId, runWithTenant, type TenantContext } from "./tenantContext";

/**
 * A tenant claim no install uses. A pooled stamp has no install tenant, and the
 * question here is only whether the role and its grants work, so RLS returns
 * zero rows for this claim and no tenant's row is read.
 */
export const TENANT_PROBE_ID = "mike-tenant-path-probe";

const PROBE_TIMEOUT_MS = 15_000;

export type TenantPathResult =
  | { state: "skipped" }
  | { state: "ok"; role: string }
  | { state: "failed"; role: string; code: string; httpStatus?: number };

/** The claim for a probe: the install's tenant, or the reserved one on a pooled stamp. */
export async function tenantProbeContext(): Promise<TenantContext> {
  const install = await getTenancyMode() === "pooled"
    ? undefined
    : await installTenantId().catch(() => undefined);
  return { tenantId: install || TENANT_PROBE_ID };
}

/** The error's own code when it looks like one; never its message. */
export function databaseErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : "no code";
}

/**
 * One signed read as the tenant role. Zero rows passes, so an empty new install
 * is fine; a role, grant or JWT error comes back as `failed`. Hosted Supabase
 * does not use the signing path, so there is nothing to prove on it.
 */
export async function checkTenantPostgrestPath(
  signal: AbortSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS),
): Promise<TenantPathResult> {
  if (!usesSignedPostgrest()) return { state: "skipped" };
  const role = await tenantDbRole();
  const scope = await tenantProbeContext();
  // Awaited inside the scope: a query builder issues its request where awaited.
  const { error, status } = await runWithTenant(scope, async () =>
    await createServerSupabase().from("tenants").select("tenant_id").limit(1).abortSignal(signal));
  if (!error) return { state: "ok", role };
  return { state: "failed", role, code: databaseErrorCode(error), httpStatus: status || undefined };
}

const PERMISSION_DENIED = "42501";
export const STREAM_RUN_LOGIN = "stream-run database login (STREAM_RUN_DATABASE_URL / pgrst-db-uri)";

/** A real permission failure: the only case where a grant, or the rollback, can help. */
export function isPermissionDenied(code: string): boolean {
  return code === PERMISSION_DENIED;
}

/**
 * What the operator does about a login that cannot use `role`. Only for a
 * permission failure: the rollback gives up the database's tenant boundary, so
 * it must never be suggested for an outage that it would not fix.
 */
export async function tenantRoleGuidance(role: string, login: string): Promise<string> {
  const grant = `Grant the role to the ${login}: GRANT ${role} TO <login>.`;
  if (await getTenancyMode() === "pooled" || role !== "tenant_app") return grant;
  return `${grant} As a temporary mitigation on a single install, set tenant-rls-enforced=false.`;
}

/** A role switch refused for 22023: SET ROLE to a role the database does not have. */
export function roleMissingGuidance(role: string): string {
  return `Role ${role} may not exist in this database. Run the migration job.`;
}

/** What the migrations leave each role holding on the tables these checks read. */
const SHIPPED_TABLE_PRIVILEGES: Record<string, string> = {
  "tenant_app public.stream_runs": "SELECT, INSERT, UPDATE, DELETE", // 0180
  "service_role public.stream_runs": "SELECT, INSERT, UPDATE, DELETE", // 0097
  "tenant_app public.tenants": "SELECT, INSERT", // 0180 revokes update and delete
  "service_role public.tenants": "ALL", // 0005
  "service_role public.pgmigrations": "SELECT", // 0109
};

/**
 * A grant that shipped in a migration comes back only with a migration still to
 * apply: if the job has nothing to apply, it was removed by hand, and the job
 * repairs memberships, not table grants.
 */
function tableGrantRemedy(role: string, table: string): string {
  const privileges = SHIPPED_TABLE_PRIVILEGES[`${role} ${table}`];
  const restore = privileges
    ? `run: GRANT ${privileges} ON ${table} TO ${role}.`
    : `restore the grant the migrations give ${role} on ${table}.`;
  return `run the migration job with the same image as this backend. If it applies nothing, the grant was removed by hand: as the server administrator, ${restore}`;
}

/** The role was held, so the refusal is about a table. The rollback would only hide this. */
export function tableGrantGuidance(role: string, table: string): string {
  const remedy = tableGrantRemedy(role, table);
  return `Role ${role} lacks a grant on ${table}: ${remedy}`;
}

/**
 * PostgREST switches role and reads in one request, so its 42501 cannot say which
 * was refused, and only the code is kept. The database can answer it directly.
 */
async function postgrestPermissionGuidance(role: string): Promise<string> {
  const ifFalse = await tenantRoleGuidance(role, "PostgREST login");
  const ifTrue = tableGrantRemedy(role, "public.tenants");
  return `Either the PostgREST login lacks role ${role}, or that role lacks a grant on public.tenants; this check cannot tell which. As the server administrator, run: select pg_has_role('<login>', '${role}', 'member'). If false: ${ifFalse} If true, the role lacks a table grant: ${ifTrue}`;
}

/** What the operator does about a failed PostgREST read, by what its code means. */
export async function tenantPathGuidance(role: string, code: string): Promise<string> {
  if (isPermissionDenied(code)) return postgrestPermissionGuidance(role);
  if (/^PGRST30\d$/.test(code) || code === "POSTGREST_JWT_UNAVAILABLE") {
    return "PostgREST did not accept the signed request. Check that its PGRST_JWT_SECRET is the same value the backend signs with (Key Vault postgrest-jwt-secret, or JWT_SECRET on local auth). PostgREST takes a changed value only in a new PostgREST revision.";
  }
  if (code === "22023") return roleMissingGuidance(role);
  return "Check that PostgREST and its database are running and reachable from the backend, and read PostgREST's console logs.";
}

/** Stop startup: the API would otherwise listen with every tenant request failing. */
export async function probeTenantPostgrestPath(): Promise<void> {
  const result = await checkTenantPostgrestPath();
  if (result.state !== "failed") return;
  const http = result.httpStatus ? `, HTTP ${result.httpStatus}` : "";
  const guidance = await tenantPathGuidance(result.role, result.code);
  throw new Error(
    `Tenant database check failed: a PostgREST read as role ${result.role} failed (code ${result.code}${http}). ${guidance}`,
  );
}

/**
 * The same for the direct stream-run connection used for raw SQL in tenant
 * scope. A pool checkout or network error here says nothing about the role, and
 * a refusal after the role switch says the role was held.
 */
export async function streamRunRoleFailure(
  role: string,
  error: unknown,
  step: "role-switch" | "table-read",
): Promise<Error> {
  const code = databaseErrorCode(error);
  if (step === "table-read" && isPermissionDenied(code)) {
    const guidance = tableGrantGuidance(role, "public.stream_runs");
    return new Error(`Tenant database check failed: role ${role} could not read public.stream_runs (code ${code}). ${guidance}`);
  }
  if (isPermissionDenied(code)) {
    const guidance = await tenantRoleGuidance(role, STREAM_RUN_LOGIN);
    return new Error(`Tenant database check failed: the stream-run login could not use role ${role} (code ${code}). ${guidance}`);
  }
  if (step === "role-switch" && code === "22023") {
    const guidance = roleMissingGuidance(role);
    return new Error(`Tenant database check failed: the stream-run login could not switch to role ${role} (code ${code}). ${guidance}`);
  }
  return new Error(
    `Tenant database check failed: the stream-run connection failed while checking role ${role} (code ${code}). Check that the database is reachable from the backend, and the host and login in STREAM_RUN_DATABASE_URL / pgrst-db-uri.`,
  );
}
