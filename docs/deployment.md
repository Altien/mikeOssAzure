# Azure deployment

Use [Azure prerequisites](azure-prereqs.md) for self-host provisioning and [the deployment runbook](runbook-dev-deployment.md) for the maintained deployment process. The application uses Entra authentication, private Postgres/PostgREST, Azure Blob Storage, and organisation-managed model credentials.

## Database upgrades

Apply numbered files in backend/migrations/ using the migration runner. Fresh and existing databases use the same migration history; there is no standalone schema.sql bootstrap. Back up existing data, inspect the applied migration records, and run the documented migration command before starting a new version. Application boot reports outstanding migrations without applying them.

Identity values are Entra text IDs. Database roles and grants are explicit: the API uses its service role, while anonymous access is restricted. Preserve those grants when adding tables or RPCs.

The Azure `db-migrate` Container App job applies the numbered schema, refreshes
PostgREST's schema cache, and ingests the Mike workflow catalogue before the
new backend revision is activated. It uses the private PostgREST endpoint,
the same user-assigned identity as the backend for Key Vault and Blob Storage,
and the `workflowRepository`/`workflowRef` deployment parameters. Pin
`workflowRef` to a full commit for reproducible releases. Reference uploads
must finish before the database switches active catalogue rows. A failed
download, upload or replacement fails the job and leaves the previous active
catalogue usable; do not bypass the job during deployment.

## Runtime configuration and credentials

The frontend is statically exported and reads public identity/API configuration at runtime. Follow the deployment runbook for routing its assets and the backend /config endpoint; do not replace this with a Next.js production server or bake secrets into browser bundles.

Store model credentials in Key Vault with local environment fallback. Azure OpenAI requires its deployment, endpoint, API version, and API key; managed identity access to Key Vault does not imply managed identity authentication to model inference. OpenRouter uses openrouter-api-key; Vercel AI Gateway accepts ai-gateway-api-key or the legacy vercel-ai-gateway-api-key alias.
### After the organization-access upgrade: `tabular_review_legacy_shares`

`0084_organization_legacy_sharing_backfill.sql` converts the old roleless
`shared_with` arrays into real access grants. One shape has nowhere to go: a
tabular review that lives INSIDE a project now inherits access from that
project, so a share on the review alone cannot be reproduced without handing
the recipient the whole matter. That migration dropped
`tabular_reviews.shared_with` without recording those recipients.

`0093_organization_access_followup.sql` creates
`public.tabular_review_legacy_shares` as the place those `(review, project,
email)` triples belong, and backfills it only if the `shared_with` column
still exists when it runs. On a deployment that already applied
`the original import` the column is gone, so the table lands EMPTY: the recipients
are recoverable only from a pre-upgrade backup. To recover them, restore the
old `shared_with` values into a scratch column named `shared_with` on
`tabular_reviews`, re-run `0093` (it is safe to re-run), then drop the
scratch column. Fresh installs create the table empty and nothing writes it
at runtime. The table carries no foreign keys, so the record survives the
review or project being deleted. It is `service_role`-only; read it with the
service key:

```sql
select l.email, l.project_id, l.tabular_review_id, l.archived_at
from public.tabular_review_legacy_shares l
order by l.archived_at desc;
```

Each row is a person who could see that review before the upgrade and cannot
now. For each one, decide deliberately: grant them access to the project (or
add them to the organization) if they should still have it, and otherwise do
nothing. The table is a record, not a queue â€” nothing reads it, and rows may
be deleted once every recipient has been dealt with.

Apply the workflow catalog migration before deploying the matching backend
release, then run the dedicated ingestion job from the built backend artifact:

User credential settings are read-only. Model and router selections remain user preferences. For the Word add-in, configure its public HTTPS origin and CORS and Entra redirect URIs as described in [Word deployment](word-addin-development.md#production-build).

LibreOffice must be available for DOC/DOCX conversion. See [Troubleshooting](troubleshooting.md), [Safe local testing](safe-local-testing.md), and the [security policy](../SECURITY.md).

## Durable background work

Azure runs `QUEUE_DRIVER=postgres` against the private PostgREST service. The
API uses `WORKERS_MODE=none`; a separate no-ingress worker Container App runs
`node dist/worker.js` with at least one replica, the same managed identity,
Key Vault and storage access, and the same backend image. The migration job
must apply numbered `0074_db_jobs.sql` before either app starts. Redis/BullMQ
remains optional for other deployments. The worker checks required secrets and
queue schema before reporting readiness; a failed initialization exits.


### Optional Supabase authentication recovery

For deployments that explicitly select Supabase authentication, SAML SSO can
be enabled with `SSO_ENABLED=true` after configuring the domain provider in
GoTrue. The progressive SSO page accepts an email address and derives its
domain; `SSO_ALLOWED_DOMAINS` accepts exact DNS domains.
The backend starts SSO with a one-use, browser-bound PKCE state and exchanges
the callback server-side before issuing the normal HttpOnly session cookie.
Entra and local authentication do not use this GoTrue configuration.

When runtime `/config` selects Supabase authentication, confirmation and password recovery use the frontend `/auth/callback` URL. Allow that exact URL in Supabase Auth, configure SMTP and the Site URL, and use a minimum password length of 10. Recovery responses intentionally do not reveal whether an account exists. Secure email changes require both addresses to confirm; expired links must be requested again. Entra and local deployments continue using their configured identity flow. These routes do not provision Supabase Auth or its database triggers in the Azure database.
