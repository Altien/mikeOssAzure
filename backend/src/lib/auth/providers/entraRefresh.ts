import { entraOAuthConfiguration } from "../entraConfiguration";
import { validateEntraToken } from "./entra";
import type { ServerCredential } from "../../serverSession";

/** Refresh a server-held Entra credential. Never expose the refresh token to JS. */
export async function renewEntraCredential(refreshToken: string, credential?: ServerCredential): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}> {
  const cfg = await entraOAuthConfiguration(credential?.identityKind, credential?.directoryId);
  const { clientId, clientSecret, scopes: scope } = cfg;
  const response = await fetch(`${cfg.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token || !Number.isFinite(body.expires_in)) {
    throw new Error("Entra session refresh failed");
  }
  const result = await validateEntraToken(body.access_token);
  if (!result.ok || (credential && (result.principal.userId !== credential.userId
    || (credential.directoryId !== undefined && result.principal.directoryId !== credential.directoryId)
    || (credential.identityKind !== undefined && result.principal.identityKind !== credential.identityKind)))) throw new Error("Entra refresh identity changed");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(1, body.expires_in!) * 1000),
  };
}
