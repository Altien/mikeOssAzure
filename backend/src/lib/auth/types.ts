export interface AuthPrincipal {
  userId: string;
  email: string;
  /**
   * Display name from the IdP, when available. Auth providers that surface
   * a name (e.g. Entra `name` claim) populate this; the upstream Supabase
   * provider does not.
   */
  displayName?: string;
  tenantId?: string;
  groups: string[];
  roles: string[];
  provider: string;
}

export type AuthValidationResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; status: 401 | 403; detail: string };
