# Pooled authentication runtime contract

TENANCY_MODE (Key Vault: tenancy-mode) defaults to single when absent.
Pooled mode has no install tenant, disables /install, and never registers tenants
automatically. Configuration service failures fail closed; they do not switch
a pooled request to single mode. Regional startup validation is specified in 019.

## Identity configuration

All values are server runtime configuration. No new NEXT_PUBLIC variables are
used. GET /config publishes tenancyMode, onboardingUrl, externalIdSignIn and
the default path's public client/authority/scope for clients. Secrets stay on
the server.

Customers sign in with Microsoft: work accounts and personal Microsoft
accounts. The Altien External ID directory is optional. It is switched off
when ALTIEN_ENTRA_CLIENT_ID / altien-entra-client-id is absent or empty. Then
Microsoft is the only identity path. The web login page and the Word dialog
show one "Sign in with Microsoft" button. /config publishes the Microsoft
client with the `common` authority and `externalIdSignIn: false`, with no
External ID value. Pooled startup validation does not read the altien
settings. A Key Vault failure while reading the client ID still fails closed.

When the External ID directory is used, configure:

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

Microsoft sign-in (the "enterprise" identity kind in code) uses the existing
ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ENTRA_BACKEND_CLIENT_ID, and optional
ENTRA_AUTH_SCOPES. Its app registration must accept organisational directories
and personal Microsoft accounts, and must issue v2 API tokens. Login uses the
`common` authority. Refresh and logout use the verified directory's own
authority. For a personal account that is the consumers tenant,
9188040d-6c67-4c5b-b112-36a304b66dad.
Validation requires the exact https://login.microsoftonline.com/{tid}/v2.0
issuer, including the consumers tid, and the enterprise API audience. Keys come
from the one shared `common` key set. Each key's issuer template must match the
token's tid. Validation does not consult the database. Admission follows the
rules below. This follows Microsoft's
[multitenant issuer guidance](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-the-issuer).
Both app registrations need the backend web/Word callback redirects used by the
single-tenant broker.

## Admission and sessions

- With External ID configured, it is the default Microsoft login path, and
  ?identity=enterprise selects Microsoft. Web and Word then show both choices.
  Without External ID, Microsoft is the default and only path. Word uses
  the server PKCE dialog for pooled identities.
- The selected identity path is encrypted in OAuth state. Callback validation
  must agree with that path. The verified directory and path are encrypted
  with server-held credentials and reused for refresh and logout.
- External ID resolves only through its tenant_memberships row
  (identity_kind 'altien').
- A Microsoft sign-in first looks for a named membership. That is a
  tenant_memberships row with identity_kind 'microsoft', user_id equal to the
  token's oid, and directory_id equal to the verified tid (lower-cased). The
  control plane writes these rows with cp_add_directory_member. Tenant and
  role come from that row. Rows mirrored by mirror_enterprise_member
  (identity_kind 'enterprise') are auth metadata only and never count. If
  there is no named membership, the tenant comes from tenant_identity_sources.
  The role then comes from app roles or tenant_group_policies, and admission
  is mirrored as before.
- A personal account (consumers tid) is admitted only through a named
  membership. The consumers directory never resolves through
  tenant_identity_sources, and cp_link_identity_source refuses to link it.
- These lookups are uncached. The internal tenant replaces
  principal.tenantId, and directoryId keeps the verified identity directory.
- Any pooled sign-in that resolves no tenant gets a 403 with
  code: onboarding_required and the configured onboardingUrl. This covers
  External ID and Microsoft alike. The browser OAuth callback redirects
  there without creating a session or reading tenant content.
- The resolved tenant must exist and be active before erasure/profile queries
  or profile seeding. A named membership (External ID or Microsoft) gives its
  role: TenantAdmin grants TenantAdmin+Member, and Member grants Member.
  Directory-linked Microsoft users must match Mike.Admin/Mike.User app roles
  or the tenant's tenant_group_policies before a profile is created.
- Browser sessions and Word handoffs are stamped with the admitted tenant.
  Existing cookies are checked against fresh resolution; a move cannot
  keep a cookie pinned to the old tenant.

For local validation only, nonproduction AUTH_PROVIDER=local with
TENANCY_MODE=pooled resolves the deterministic local user ID through the same
membership table. Tenant/role claims or body fields never choose the tenant.
Production local pooled admission is refused.
