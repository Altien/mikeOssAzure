# Pooled authentication runtime contract

TENANCY_MODE (Key Vault: tenancy-mode) defaults to single when absent.
Pooled mode has no install tenant, disables /install, and never registers tenants
automatically. Configuration service failures fail closed; they do not switch
a pooled request to single mode. Regional startup validation is specified in 019.

## Identity configuration

All values are server runtime configuration. No new NEXT_PUBLIC variables are
used. GET /config publishes tenancyMode, onboardingUrl, and the public
External ID client/authority/scope for clients. Secrets stay on the server.

For the Altien-owned External ID directory configure:

| Server / Key Vault name | Value |
| --- | --- |
| ALTIEN_ENTRA_TENANT_ID / altien-entra-tenant-id | External directory's tenant GUID |
| ALTIEN_ENTRA_AUTHORITY / altien-entra-authority | Tenant-specific HTTPS authority, without the /v2.0 or OAuth endpoint suffix |
| ALTIEN_ENTRA_ISSUER / altien-entra-issuer | Exact issuer from that authority's OIDC metadata, including any trailing slash |
| ALTIEN_ENTRA_JWKS_URI / altien-entra-jwks-uri | Exact HTTPS jwks_uri from that metadata |
| ALTIEN_ENTRA_CLIENT_ID / altien-entra-client-id | Server web app registration |
| ALTIEN_ENTRA_CLIENT_SECRET / altien-entra-client-secret | Server web app credential, when required by the app |
| ALTIEN_ENTRA_BACKEND_CLIENT_ID / altien-entra-backend-client-id | API audience |
| ALTIEN_ENTRA_AUTH_SCOPES / altien-entra-auth-scopes | Optional override; defaults to OpenID/profile/email/offline_access plus the API access_as_user scope |
| POOLED_ONBOARDING_URL / pooled-onboarding-url | Control-plane onboarding HTTPS URL |

Copy the issuer and JWKS URI from the directory's metadata rather than building
them from the authority hostname. Microsoft documents that External ID can use
a tenant GUID host in the issuer even when the authority uses its tenant name:
[MSAL authority and CIAM issuer validation](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-common/docs/authority.md).
Metadata endpoint discovery is described in
[Microsoft OIDC documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc).

Enterprise uses the existing ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET,
ENTRA_BACKEND_CLIENT_ID, and optional ENTRA_AUTH_SCOPES; its app registration
must accept organisational directories and v2 API tokens. Login uses the
organizations authority. Validation requires the exact
https://login.microsoftonline.com/{tid}/v2.0 issuer, the enterprise API
audience, and a linked directory. This follows Microsoft's
[multitenant issuer guidance](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-the-issuer).
Both app registrations need the backend web/Word callback redirects used by the
single-tenant broker.

## Admission and sessions

- The default Microsoft login path is External ID; ?identity=enterprise
  selects enterprise. Web and Word expose both choices in pooled mode.
  Word uses the server PKCE dialog for pooled identities.
- The selected identity path is encrypted in OAuth state. Callback validation
  must agree with that path. The verified directory and path are encrypted
  with server-held credentials and reused for refresh and logout.
- External ID resolves only through tenant_memberships; enterprise resolves
  only through tenant_identity_sources. These lookups are uncached.
  The internal tenant replaces principal.tenantId; directoryId retains
  the verified identity directory.
- No External ID membership returns 403 with code: onboarding_required
  and the configured onboardingUrl. The browser OAuth callback redirects
  there without creating a session or reading tenant content.
- The resolved tenant must exist and be active before erasure/profile queries
  or profile seeding. External ID uses its membership role. Enterprise must
  match that tenant's tenant_group_policies (TenantAdmin or Member)
  before a profile is created; app-role support is added in 022.
- Browser sessions and Word handoffs are stamped with the admitted tenant.
  Existing cookies are checked against fresh resolution; a move cannot
  keep a cookie pinned to the old tenant.

For local validation only, nonproduction AUTH_PROVIDER=local with
TENANCY_MODE=pooled resolves the deterministic local user ID through the same
membership table. Tenant/role claims or body fields never choose the tenant.
Production local pooled admission is refused.
