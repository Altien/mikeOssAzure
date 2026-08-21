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

When runtime `/config` selects Supabase authentication, confirmation and password recovery use the frontend `/auth/callback` URL. Allow that exact URL in Supabase Auth, configure SMTP and the Site URL, and use a minimum password length of 10. Recovery responses intentionally do not reveal whether an account exists. Secure email changes require both addresses to confirm; expired links must be requested again. Entra and local deployments continue using their configured identity flow. These routes do not provision Supabase Auth or its database triggers in the Azure database.
