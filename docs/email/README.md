# Email decisions

This folder captures the email service decisions for the MikeOSS Azure migration.

## Context

Email in MikeOSS serves two distinct roles:

1. **Access-control identifier** — email addresses in `shared_with` columns and `workflow_shares` rows gate which users can see which resources. This is a database/application concern, not an email delivery concern.
2. **Transactional notifications** — informing users when content is shared with them, inviting new users to sign up, or signalling completion of async jobs. This role is **not yet implemented**.

The `resend` package is installed in both backend and frontend but no sending code exists. These docs cover which service to use when delivery is built, and the decision to defer that work until it is actually needed.

## Index

| # | Title | Summary |
|---|---|---|
| 001 | [Email service](001-email-service.md) | ACS Email for Azure deployments; Resend as local/self-hosted fallback; defer implementation until first sending feature is needed |

## Cross-cutting principles

1. **Email delivery is not required today.** The current sharing model works without it. Build it when there is a concrete user-facing feature that requires it.
2. **Never send email from the frontend.** Any calling code lives in the backend behind a POST endpoint.
3. **Provider-agnostic interface.** A single `sendEmail()` function in `backend/src/lib/email.ts` abstracts the provider. The `EMAIL_PROVIDER` env var switches between `acs`, `resend`, and `none` (silent drop, for tests).
4. **One secret per deployment.** ACS deployments use `acs-email-connection-string` from Key Vault; Resend deployments use `resend-api-key`. Only one is needed per environment.
