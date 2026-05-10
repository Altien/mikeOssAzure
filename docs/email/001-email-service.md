# 001 — Email service

**Status:** Accepted (implementation deferred)

## Context

### Current state

Email in MikeOSS serves two distinct purposes:

1. **Access-control identifier.** `projects.shared_with` (text array), `tabular_reviews.shared_with` (text array), and `workflow_shares.shared_with_email` (text column) store email addresses as gate identifiers. This is a database and application-layer concern — no email is sent.

2. **Transactional notifications.** Informing users when content is shared with them, or inviting new users to sign up. This is **not yet implemented**.

The `resend` package was installed in both backend (`^4.5.1`) and frontend (`^6.8.0`) but no sending code ever called it. Both packages have been removed:

- **Frontend** — removed entirely. Email sending never belongs in the browser. Signup, password recovery, and magic-link flows are handled by **EntraID** (Azure AD B2C / Entra External Identities), not by application code. Resend was never the right tool for those.
- **Backend** — removed. Will be replaced with `@azure/communication-email` when the first sending feature is built.

### Where transactional email would add value

1. **Share notifications** — user A shares a project/review/workflow with user B's email; B is notified that content is waiting.
2. **New-user invitations** — B does not yet have an account; prompted to register via the EntraID flow.
3. **Async completion signals** — long-running document conversion or AI generation jobs (future).

None of these are implemented. Implementation is deferred until one is needed.

### Volume expectation

Low. Share notifications are user-triggered, not bulk. A realistic upper bound at current scale is dozens of transactional emails per day, well within free tiers of every option considered.

## Decision

**Azure Communication Services (ACS) Email** when the first sending feature is built. A thin provider interface (`backend/src/lib/email.ts`, to be created) wraps the SDK behind a single `sendEmail()` function selected by `EMAIL_PROVIDER` env var, keeping the implementation swappable.

**Implementation is deferred** until a concrete feature requires it.

## Options considered

### Q4 — Which email service?

| Option | Pros | Cons |
|---|---|---|
| **A. Azure Communication Services Email** *(chosen)* | Native Azure service — same resource group, billing, audit trail. Custom domain sending with ACS-managed SPF/DKIM. No external SaaS dependency for a fully Azure deployment. $0.00025/email, no monthly base. | Newer service; smaller ecosystem than Resend or SendGrid. Connection-string auth (Managed Identity covers the ACS resource control plane but not the email sending plane — this is a platform constraint, not a design choice). Requires domain verification DNS setup. |
| **B. Resend** | Already familiar from prior config. Excellent DX, React Email support, sandbox testing without domain setup. Free tier (3,000/mo) covers expected volume. | Third-party SaaS dependency. External API call from the VNet needs NAT Gateway egress. Another API key in Key Vault. |
| **C. SendGrid** | Mature, widely trusted, deep deliverability tooling. | Over-engineered for low-volume transactional use. Free tier capped at 100/day. More complex setup than ACS with no deliverability advantage at this scale. |

### Q5 — Build now or defer?

| Option | Decision |
|---|---|
| **A. Build now** | Adds Key Vault secret, new SDK, DNS changes, bounce handling — all for a feature nobody is using yet. |
| **B. Defer until needed** *(chosen)* | Build the sending infrastructure when building the first concrete user-facing feature. The provider interface is the only thing that needs to be designed now. |
| **C. Build infrastructure, not features** | The "infrastructure" is a 20-line wrapper function. Not worth doing ahead of the feature that consumes it. |

### Q6 — Should `resend` stay in the frontend?

No. Removed immediately. Reasons:

- Email sending from the browser is never correct — API keys in client bundles are a credentials leak.
- **Signup and password recovery are owned by EntraID**, not application code. Resend was never the right tool for those flows; they were the likely reason the package was added to the frontend.
- Any future notification UI calls a backend endpoint (`POST /notifications/share` or similar); the backend does the sending.

## Provider interface (to be implemented)

When the first sending feature is built, create `backend/src/lib/email.ts`:

```typescript
export interface EmailProvider {
  send(opts: { to: string; subject: string; html: string; text?: string }): Promise<void>;
}

// Selected by EMAIL_PROVIDER env var: "acs" | "none"
// "none" silently drops — useful in tests and local dev without credentials.
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void>
```

The ACS implementation uses `@azure/communication-email`. The `none` implementation is a no-op. There is no Resend implementation; self-hosted customers who want a simpler setup can configure ACS with their own domain.

## Consequences

### Immediate (already done)

- `resend` removed from both `frontend/package.json` and `backend/package.json`.
- `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` removed from `frontend/package.json` (only used by the now-deleted dead `storage.ts`).

### When implementing the first sending feature

1. Provision `Microsoft.Communication/communicationServices` and `Microsoft.Communication/emailServices` (custom domain) in the Bicep template.
2. Add DNS records (SPF, DKIM, DMARC) — one-time ops step documented in the runbook.
3. Store the ACS Email connection string as `acs-email-connection-string` in Key Vault.
4. Install `@azure/communication-email` in the backend.
5. Create `backend/src/lib/email.ts` with the `EmailProvider` interface and ACS implementation.

### Key Vault additions (deferred)

| Secret name | Used when |
|---|---|
| `acs-email-connection-string` | `EMAIL_PROVIDER=acs` (when implemented) |

### Deferred

- **Email templates** — React Email or plain HTML. The `sendEmail` interface accepts raw HTML; templates are introduced incrementally.
- **Unsubscribe / suppression list** — required before any repeated notification flows. ACS provides suppression list management.
- **Bounce and complaint handling** — ACS delivery webhooks. Implement when sending volume justifies it.
- **Custom domain verification** — a DNS/ops step outside the Bicep template. Documented in the runbook when implementing the first sending flow.
