/// <reference types="office-js" />
/**
 * Microsoft Entra sign-in for the Word add-in (MSAL.js).
 *
 * Dev-fork divergence (upstream sync b8bd5b0c): replaces upstream's Supabase
 * password grant. The add-in requests an access token for the backend API's
 * delegated scope (`api://<backend-client-id>/access_as_user`, served by
 * GET /config as `entra.apiScope`) from the same tenant and the same client
 * application the web frontend signs in with (`entra.clientId`). The backend
 * therefore validates it with the unchanged Entra validator
 * (backend/src/lib/auth/providers/entra.ts: RS256 + tenant JWKS, issuer,
 * audience = backend client id, tid) — exactly like the web frontend's token.
 *
 * Two acquisition paths:
 *   1. Nested App Authentication (NAA) — when the Office host supports the
 *      `NestedAppAuth 1.1` requirement set, MSAL brokers through the host's
 *      signed-in Microsoft account (`createNestablePublicClientApplication`):
 *      usually silent SSO, else a host-managed consent/sign-in popup.
 *      App registration: SPA redirect URI `brk-multihub://<add-in host>`.
 *   2. Office dialog fallback — older hosts: the pane opens
 *      `auth-dialog.html` with `Office.context.ui.displayDialogAsync`; that
 *      page runs a standard MSAL redirect flow and posts the token back with
 *      `messageParent`. App registration: SPA redirect URI
 *      `https://<add-in host>/auth-dialog.html`.
 * Tokens are held by MSAL's cache (NAA: the host broker; fallback:
 * localStorage shared with the dialog page), never in custom storage.
 */
import {
  createNestablePublicClientApplication,
  createStandardPublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import type { RuntimeConfig } from "./runtimeConfig";

export const AUTH_DIALOG_PATH = "/auth-dialog.html";

export interface EntraToken {
  accessToken: string;
  /** Epoch milliseconds; null when MSAL didn't report an expiry. */
  expiresOn: number | null;
}

/** Message the fallback dialog posts back to the task pane. */
export type AuthDialogMessage =
  | {
      type: "success";
      accessToken: string;
      expiresOn: number | null;
      homeAccountId: string | null;
    }
  | { type: "error"; message: string };

export function authorityFor(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}`;
}

export function dialogRedirectUri(): string {
  return `${window.location.origin}${AUTH_DIALOG_PATH}`;
}

/** Standard (non-nested) MSAL instance — used by the fallback dialog and the pane. */
export function createDialogFlowClient(
  cfg: RuntimeConfig
): Promise<IPublicClientApplication> {
  return createStandardPublicClientApplication({
    auth: {
      clientId: cfg.entra.clientId,
      authority: authorityFor(cfg.entra.tenantId),
      redirectUri: dialogRedirectUri(),
    },
    // localStorage so the pane can reuse (acquireTokenSilent) what the
    // dialog page — same origin — cached after its redirect sign-in.
    cache: { cacheLocation: "localStorage" },
  });
}

export function toEntraToken(result: AuthenticationResult): EntraToken {
  return {
    accessToken: result.accessToken,
    expiresOn: result.expiresOn ? result.expiresOn.getTime() : null,
  };
}

function naaSupported(): boolean {
  try {
    return Office.context.requirements.isSetSupported("NestedAppAuth", "1.1");
  } catch {
    return false;
  }
}

/** Missing /config values that make Entra sign-in impossible, or null. */
export function entraConfigProblem(cfg: RuntimeConfig): string | null {
  const missing = [
    !cfg.entra.tenantId && "tenant id",
    !cfg.entra.clientId && "client id",
    !cfg.entra.apiScope && "API scope",
  ].filter(Boolean);
  if (missing.length === 0) return null;
  const list = missing.join(", ");
  return `Microsoft sign-in is not configured on this Mike server (GET /config has no Entra ${list}).`;
}

function openAuthDialog(): Promise<AuthDialogMessage> {
  return new Promise((resolve, reject) => {
    Office.context.ui.displayDialogAsync(
      dialogRedirectUri(),
      { height: 60, width: 30 },
      (asyncResult) => {
        if (asyncResult.status === Office.AsyncResultStatus.Failed) {
          reject(new Error(asyncResult.error.message));
          return;
        }
        const dialog = asyncResult.value;
        dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
          dialog.close();
          if (!("message" in arg)) {
            reject(new Error("Sign-in failed"));
            return;
          }
          // Only accept messages from our own dialog page's origin.
          if (arg.origin && arg.origin !== window.location.origin) {
            reject(new Error("Sign-in response came from an unexpected origin"));
            return;
          }
          try {
            resolve(JSON.parse(arg.message) as AuthDialogMessage);
          } catch {
            reject(new Error("Malformed sign-in response"));
          }
        });
        dialog.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
          const code = "error" in arg ? arg.error : 0;
          reject(
            new Error(
              code === 12006
                ? "The sign-in window was closed."
                : `Sign-in window error (${code}).`
            )
          );
        });
      }
    );
  });
}

export class EntraAuth {
  private constructor(
    private readonly pca: IPublicClientApplication,
    private readonly nested: boolean,
    private readonly scopes: string[]
  ) {}

  get supportsNestedAuthentication(): boolean { return this.nested; }

  static async create(cfg: RuntimeConfig): Promise<EntraAuth> {
    const scopes = [cfg.entra.apiScope];
    if (naaSupported()) {
      const pca = await createNestablePublicClientApplication({
        auth: {
          clientId: cfg.entra.clientId,
          authority: authorityFor(cfg.entra.tenantId),
        },
      });
      return new EntraAuth(pca, true, scopes);
    }
    return new EntraAuth(await createDialogFlowClient(cfg), false, scopes);
  }

  private account(): AccountInfo | undefined {
    return (
      this.pca.getActiveAccount() ?? this.pca.getAllAccounts()[0] ?? undefined
    );
  }

  /**
   * Silent acquisition only (cache / refresh token / host broker). Resolves
   * null whenever user interaction would be required.
   */
  async acquireSilent(forceRefresh = false): Promise<EntraToken | null> {
    const account = this.account();
    // Standard MSAL needs a cached account; NAA falls back to the host's.
    if (!this.nested && !account) return null;
    try {
      const result = await this.pca.acquireTokenSilent({
        scopes: this.scopes,
        account,
        forceRefresh,
      });
      if (result.account) this.pca.setActiveAccount(result.account);
      return toEntraToken(result);
    } catch {
      return null;
    }
  }

  /** Interactive sign-in — call from a user gesture (the Sign in button). */
  async acquireInteractive(): Promise<EntraToken> {
    if (this.nested) {
      const silent = await this.acquireSilent();
      if (silent) return silent;
      const result = await this.pca.acquireTokenPopup({ scopes: this.scopes });
      if (result.account) this.pca.setActiveAccount(result.account);
      return toEntraToken(result);
    }
    const msg = await openAuthDialog();
    if (msg.type === "error") throw new Error(msg.message);
    if (msg.homeAccountId) {
      const account = this.pca.getAccount({ homeAccountId: msg.homeAccountId });
      if (account) this.pca.setActiveAccount(account);
    }
    return { accessToken: msg.accessToken, expiresOn: msg.expiresOn };
  }

  /**
   * Forget the add-in's tokens. Under NAA the Office account itself stays
   * signed in (it belongs to the host); the session layer's signed-out flag
   * stops silent SSO from signing the pane straight back in.
   */
  async signOut(): Promise<void> {
    this.pca.setActiveAccount(null);
    if (!this.nested) await this.pca.clearCache().catch(() => {});
  }
}
