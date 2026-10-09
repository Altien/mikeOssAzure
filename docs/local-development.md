# Local development

The [local stack runbook](runbook-local-stack.md) is the step-by-step setup guide. It runs Docker Postgres, private PostgREST, Caddy, and Azurite alongside the backend and frontend processes. Install package dependencies with pnpm and follow the runbook for JWTs, environment templates, storage initialization, and numbered migrations.

Use local authentication for development without Azure, or follow [local Entra authentication](runbook-entra-local-auth.md) to exercise Microsoft sign-in. The frontend obtains deployment identity settings from the backend's runtime configuration.

Provider credentials are organisation-managed. Configure them in Key Vault for Azure deployments or backend environment variables for local development. Settings displays credential availability and lets users select direct-provider, Azure OpenAI, OpenRouter, and Vercel AI Gateway models. Credentials cannot be edited from a user's Settings page.

Start application packages in separate terminals with pnpm --dir backend dev and pnpm --dir frontend dev. The usual web/API origins are http://localhost:3000 and http://localhost:3001. For Word development, see the [add-in guide](word-addin-development.md); its HTTPS development server uses port 3200.

Create a project and add public or synthetic documents to check the complete workflow. See [Safe local testing](safe-local-testing.md) and [Troubleshooting](troubleshooting.md).


### Optional Supabase authentication recovery

When runtime `/config` selects Supabase authentication, confirmation and password recovery use the frontend `/auth/callback` URL. Allow that exact URL in Supabase Auth, configure SMTP and the Site URL, and use a minimum password length of 10. Recovery responses intentionally do not reveal whether an account exists. Secure email changes require both addresses to confirm; expired links must be requested again. Entra and local deployments continue using their configured identity flow. These routes do not provision Supabase Auth or its database triggers in the Azure database.

Keep Supabase email confirmation on (`GOTRUE_MAILER_AUTOCONFIRM=false`) anywhere other people can sign up. Project, chat, review and workflow shares and organization invitations are matched by email, so the backend ignores an address Supabase has not confirmed when it matches them. When a signed-in account's email changes (in Supabase or in Entra), migration `0105` moves its email-keyed grants to the new address the first time the backend sees it, unless another account already holds the old address.
