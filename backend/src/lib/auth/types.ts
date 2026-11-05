export interface AuthPrincipal {
  userId: string;
  email: string;
  /**
   * Display name from the IdP, when available. Auth providers that surface
   * a name (e.g. Entra `name` claim) populate this; the upstream Supabase
   * provider does not.
   */
  displayName?: string;
  /**
   * False when the IdP reports that the account has NOT proved it owns
   * `email` (Supabase: no `email_confirmed_at`). Undefined means the provider
   * has no such notion: Entra emails are tenant-administered directory
   * attributes (single configured tenant, `tid` checked) and local tokens are
   * a development-only, email-derived identity.
   */
  emailVerified?: boolean;
  /** Internal tenant after resolution; directory identity is kept separately. */
  tenantId?: string;
  directoryId?: string;
  identityKind?: "altien" | "enterprise";
  /** Set by resolveTenant only from a named membership row (never a mirrored enterprise row). */
  membershipRole?: "TenantAdmin" | "Member";
  appRoles?: string[];
  groups: string[];
  roles: string[];
  provider: string;
}

export type AuthValidationResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; status: 401 | 403; detail: string }
  // Upstream 08bdc1d9, adapted: the identity provider (GoTrue, in supabase
  // mode) could not be reached, so nobody can say whether the session is
  // valid. Callers answer 503 upstream_unavailable, never a 401 sign-out.
  | { ok: false; status: 503; detail: string; upstreamFailure: unknown };

/**
 * The email `res.locals.userEmail` carries. It is an AUTHORIZATION input,
 * not a display value: direct grants (projects, chats, reviews, workflows) and
 * organization invitations are matched against it. An address the account has
 * not proved it owns must therefore match nothing, otherwise signing up as
 * someone else's address before they do inherits whatever was shared with it.
 * Such a session still authenticates; only email-keyed matching is withheld.
 * (Upstream d146998d did this in requireAuth with Supabase's
 * `email_confirmed_at`; Dev's providers report it as `emailVerified`.)
 */
export function authorizationEmail(principal: AuthPrincipal): string {
  if (principal.emailVerified === false) return "";
  return principal.email.trim().toLowerCase();
}
