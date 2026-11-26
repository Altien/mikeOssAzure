import { getConfig } from "../config";
import { getTenancyMode } from "../tenancyMode";
import { isSecretNotFound } from "../secretNotFound";

export type EntraIdentityKind = "altien" | "enterprise";
const value = (name: string) => getConfig(name);

function httpsUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid Entra endpoint");
  return url.toString();
}

/** Operator-owned External ID endpoints are copied from OIDC metadata, never token claims. */
export async function externalIdentityConfiguration() {
  const [tenantId, authority, issuer, jwksUri, clientId, backendId] = await Promise.all([
    value("altien-entra-tenant-id"), value("altien-entra-authority"), value("altien-entra-issuer"),
    value("altien-entra-jwks-uri"), value("altien-entra-client-id"), value("altien-entra-backend-client-id"),
  ]);
  if (!tenantId || !clientId || !backendId) throw new Error("External ID configuration is unavailable");
  return { tenantId, authority: httpsUrl(authority).replace(/\/+$/, ""), issuer: httpsUrl(issuer), jwksUri: httpsUrl(jwksUri), clientId, backendId };
}

/**
 * The Altien External ID path exists only when its client ID is configured.
 * Without it, pooled sign-in is Microsoft only (work and personal accounts).
 */
export async function externalIdentityConfigured(): Promise<boolean> {
  try { return !!(await value("altien-entra-client-id")).trim(); }
  catch (error) {
    // Absent (no secret, or no vault and no env value) means off; a vault failure fails closed.
    if (isSecretNotFound(error) || !process.env.KEY_VAULT_NAME) return false;
    throw error;
  }
}

export async function entraOAuthConfiguration(kind?: EntraIdentityKind, directoryId?: string) {
  const pooled = await getTenancyMode() === "pooled";
  if (pooled && (kind === "altien" || (kind === undefined && await externalIdentityConfigured()))) {
    const cfg = await externalIdentityConfiguration();
    return { ...cfg, kind: "altien" as const,
      clientSecret: await value("altien-entra-client-secret").catch(() => ""),
      scopes: await value("altien-entra-auth-scopes").catch(() => "") || `openid profile email offline_access api://${cfg.backendId}/access_as_user`,
    };
  }
  const [tenantId, clientId, clientSecret, backendId] = await Promise.all([
    value("entra-tenant-id").catch(() => ""), value("entra-client-id"),
    value("entra-client-secret").catch(() => ""), value("entra-backend-client-id"),
  ]);
  if (!clientId || !backendId || (!pooled && !tenantId)) throw new Error("Entra configuration is unavailable");
  if (directoryId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(directoryId)) throw new Error("Invalid Entra directory");
  // Pooled Microsoft sign-in uses `common` so personal accounts are accepted too.
  const authority = `https://login.microsoftonline.com/${pooled ? directoryId || "common" : tenantId}`;
  return { tenantId: pooled ? "common" : tenantId, authority, clientId, clientSecret, backendId,
    ...(pooled ? { kind: "enterprise" as const } : {}),
    scopes: process.env.ENTRA_AUTH_SCOPES || `openid profile email offline_access api://${backendId}/access_as_user`,
  };
}
