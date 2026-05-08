import { NextFunction, Request, Response } from "express";
import { createServerSupabase } from "../lib/supabase.js";
import { resolveRoles } from "../lib/auth/roles.js";

function deny(res: Response, tenantId: string | undefined, userId: string, reason: string): void {
  console.warn("auth.tenant_access_denied", {
    tenantId,
    userId,
    reason,
    timestamp: new Date().toISOString(),
  });
  res.status(403).json({ detail: reason });
}

export async function tenantAccess(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const provider = process.env.AUTH_PROVIDER ?? "supabase";
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
    res.status(500).json({ detail: "Unable to evaluate tenant access" });
    return;
  }

  if (!tenant) {
    const onboardingMode = process.env.TENANT_ONBOARDING_MODE ?? "manual";
    if (onboardingMode === "auto") {
      const { error: insertError } = await admin.from("tenants").insert({ tenant_id: tenantId, status: "active" });
      if (insertError) {
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

  const roles = resolveRoles(principal.groups ?? []);
  if (roles.length === 0) {
    deny(res, tenantId, userId, "GROUP_NOT_WHITELISTED");
    return;
  }

  res.locals.principal.roles = roles;
  next();
}
