import { NextFunction, Request, Response } from "express";
import { createServerSupabase } from "../lib/supabase.js";
import { resolveRoles, resolvePooledRoles } from "../lib/auth/roles.js";
import { getTenancyMode } from "../lib/tenancyMode";
import { mirrorEnterpriseMembership } from "../lib/tenantMemberships";
import { currentTenant, runWithTenant } from "../lib/tenantContext";
import { getConfig } from "../lib/config.js";

function deny(res: Response, tenantId: string | undefined, userId: string, reason: string): void {
  console.warn("auth.tenant_access_denied", {
    tenantId,
    userId,
    reason,
    timestamp: new Date().toISOString(),
  });
  res.status(403).json({ detail: reason });
}

// getConfig() reads env first (preserves existing AUTH_PROVIDER /
// TENANT_ONBOARDING_MODE env vars where they're set), then falls
// back to KV. This lets operators change the value via /install and
// have it take effect on the next request (after flushConfigCache),
// without a Container App revision restart.
async function readAuthProvider(): Promise<string> {
  return (await getConfig("auth-provider").catch(() => "")) || "supabase";
}

async function readOnboardingMode(): Promise<string> {
  return (await getConfig("tenant-onboarding-mode").catch(() => "")) || "manual";
}

export async function tenantAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const provider = await readAuthProvider();
  let pooled: boolean;
  try { pooled = await getTenancyMode() === "pooled"; }
  catch { res.status(503).json({ detail: "Tenant configuration is unavailable" }); return; }
  if (!pooled && provider !== "entra") {
    next();
    return;
  }

  const principal = res.locals.principal;
  const tenantId: string | undefined = principal?.tenantId;
  const userId: string = principal?.userId ?? "unknown";

  if (!tenantId) {
    // Every pooled identity path (External ID, Microsoft, local) that resolves no tenant is sent to onboarding.
    if (pooled && (principal?.identityKind || (principal?.provider === "local" && process.env.NODE_ENV !== "production"))) {
      const onboardingUrl = await getConfig("pooled-onboarding-url").catch(() => "");
      res.status(403).json({ code: "onboarding_required", detail: "Join an organisation to continue.", ...(onboardingUrl ? { onboardingUrl } : {}) });
      return;
    }
    deny(res, tenantId, userId, "TENANT_UNKNOWN");
    return;
  }

  const admin = createServerSupabase();
  const { data: tenant, error } = await admin
    .from("tenants")
    .select("tenant_id,status")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    console.error(
      "tenantAccess.lookup_failed",
      JSON.stringify({ tenantId, userId, error }),
    );
    res.status(500).json({ detail: "Unable to evaluate tenant access" });
    return;
  }

  if (!tenant) {
    const onboardingMode = await readOnboardingMode();
    if (!pooled && onboardingMode === "auto") {
      // Upsert with ignoreDuplicates instead of plain insert: when a
      // freshly-signed-in user fires several authenticated requests in
      // parallel (profile + projects + deployments + chat on first
      // page load is common), every one of those requests races through
      // here together, all SELECT empty, all attempt INSERT, all but
      // the first hit Postgres 23505 unique_violation. The losers got
      // an opaque 500 "Unable to onboard tenant" and the operator saw
      // half the app fail to load on first sign-in. Observed on
      // rg-mike-test4 2026-05-19. Upsert collapses the race — losers
      // become no-op and the request proceeds.
      const { error: upsertError } = await admin
        .from("tenants")
        .upsert(
          { tenant_id: tenantId, status: "active" },
          { onConflict: "tenant_id", ignoreDuplicates: true },
        );
      if (upsertError) {
        console.error(
          "tenantAccess.onboard_failed",
          JSON.stringify({
            tenantId,
            userId,
            error: upsertError,
          }),
        );
        res.status(500).json({ detail: "Unable to onboard tenant" });
        return;
      }
    } else {
      deny(res, tenantId, userId, "TENANT_UNKNOWN");
      return;
    }
  } else if (tenant.status !== "active") {
    const reason = tenant.status === "pending" ? "TENANT_PENDING" : "TENANT_SUSPENDED";
    deny(res, tenantId, userId, reason);
    return;
  }

  let roles;
  try { roles = pooled ? await resolvePooledRoles(principal) : await resolveRoles(principal.groups ?? []); }
  catch { res.status(503).json({ detail: "Tenant policy is unavailable" }); return; }
  if (roles.length === 0) {
    deny(res, tenantId, userId, "GROUP_NOT_WHITELISTED");
    return;
  }

  // Mirror only directory-link admissions; a named member's row is already authoritative.
  if (pooled && principal.identityKind === "enterprise" && !principal.membershipRole) {
    try {
      if (!principal.directoryId) throw new Error("Missing verified directory");
      await mirrorEnterpriseMembership(tenantId, userId, principal.directoryId, roles.includes("TenantAdmin") ? "TenantAdmin" : "Member");
    } catch { res.status(503).json({ detail: "Tenant membership is unavailable" }); return; }
  }
  res.locals.principal.roles = roles;
  if (pooled) {
    // Compatibility guard: POST reads retain ordinary resource permissions.
    runWithTenant({ ...currentTenant(), tenantId, userId, roles, pooled: true,
      readOnly: req.method === "GET" || req.method === "HEAD", userEmail: principal.email }, () => next());
  } else next();
}
