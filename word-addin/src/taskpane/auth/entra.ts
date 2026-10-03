/// <reference types="office-js" />
import {
  createNestablePublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import type { RuntimeConfig } from "./runtimeConfig";

export interface EntraToken {
  accessToken: string;
  expiresOn: number | null;
}

export function authorityFor(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}`;
}

export function entraConfigProblem(cfg: RuntimeConfig): string | null {
  const missing = [
    !cfg.entra.tenantId && "tenant id",
    !cfg.entra.clientId && "client id",
    !cfg.entra.apiScope && "API scope",
  ].filter(Boolean);
  return missing.length ? `Microsoft sign-in is not configured on this Mike server (GET /config has no Entra ${missing.join(", ")}).` : null;
}

function naaSupported(): boolean {
  try {
    return Office.context.requirements.isSetSupported("NestedAppAuth", "1.1");
  } catch {
    return false;
  }
}

function toEntraToken(result: AuthenticationResult): EntraToken {
  return { accessToken: result.accessToken, expiresOn: result.expiresOn?.getTime() ?? null };
}

/** Only NAA holds a transient delegated token. Older hosts use the server
 * PKCE dialog and one-use ticket implemented by session.ts. */
export class EntraAuth {
  private constructor(
    private readonly pca: IPublicClientApplication | null,
    private readonly scopes: string[],
  ) {}

  get supportsNestedAuthentication(): boolean { return !!this.pca; }

  static async create(cfg: RuntimeConfig): Promise<EntraAuth> {
    const scopes = [cfg.entra.apiScope];
    if (!naaSupported()) return new EntraAuth(null, scopes);
    const pca = await createNestablePublicClientApplication({
      auth: {
        clientId: cfg.entra.clientId,
        authority: authorityFor(cfg.entra.tenantId),
      },
    });
    return new EntraAuth(pca, scopes);
  }

  private account(): AccountInfo | undefined {
    return this.pca?.getActiveAccount() ?? this.pca?.getAllAccounts()[0] ?? undefined;
  }

  async acquireSilent(forceRefresh = false): Promise<EntraToken | null> {
    if (!this.pca) return null;
    try {
      const result = await this.pca.acquireTokenSilent({
        scopes: this.scopes, account: this.account(), forceRefresh,
      });
      if (result.account) this.pca.setActiveAccount(result.account);
      return toEntraToken(result);
    } catch {
      return null;
    }
  }

  async acquireInteractive(): Promise<EntraToken> {
    if (!this.pca) throw new Error("This Office host uses the secure sign-in dialog");
    const silent = await this.acquireSilent();
    if (silent) return silent;
    const result = await this.pca.acquireTokenPopup({ scopes: this.scopes });
    if (result.account) this.pca.setActiveAccount(result.account);
    return toEntraToken(result);
  }

  async signOut(): Promise<void> {
    this.pca?.setActiveAccount(null);
  }
}
