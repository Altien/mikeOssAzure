import { NextFunction, Request, Response } from "express";
import { createServerSupabase } from "../lib/supabase.js";
import { resolveRoles } from "../lib/auth/roles.js";
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
// without a Container App revision restart. See gap #1 in
// docs/issues/azure-migration/036-marketplace-install-gaps.md.
async function readAuthProvider(): Promise<string> {
  return (await getConfig("auth-provider").catch(() => "")) || "supabase";
}

async function readOnboardingMode(): Promise<string> {
  return (await getConfig("tenant-onboarding-mode").catch(() => "")) || "manual";
}

export async function tenantAccess(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const provider = await readAuthProvider();
  if (provider !== "entra") {
    next();
    return;
  }

  const principal = res.locals.principal;
  const tenantId: string | undefined = principal?.tenantId;
  const userId: string = principal?.userId ?? "unknown";

  if (!tenantId) {
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
    if (onboardingMode === "auto") {
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

  const roles = await resolveRoles(principal.groups ?? []);
  if (roles.length === 0) {
    deny(res, tenantId, userId, "GROUP_NOT_WHITELISTED");
    return;
  }

  res.locals.principal.roles = roles;
  next();
}
