# Local development

The [local stack runbook](runbook-local-stack.md) is the step-by-step setup guide. It runs Docker Postgres, private PostgREST, Caddy, and Azurite alongside the backend and frontend processes. Install package dependencies with pnpm and follow the runbook for JWTs, environment templates, storage initialization, and numbered migrations.

Use local authentication for development without Azure, or follow [local Entra authentication](runbook-entra-local-auth.md) to exercise Microsoft sign-in. The frontend obtains deployment identity settings from the backend's runtime configuration.

Provider credentials are organisation-managed. Configure them in Key Vault for Azure deployments or backend environment variables for local development. Settings displays credential availability and lets users select direct-provider, Azure OpenAI, OpenRouter, and Vercel AI Gateway models. Credentials cannot be edited from a user's Settings page.

Start application packages in separate terminals with pnpm --dir backend dev and pnpm --dir frontend dev. The usual web/API origins are http://localhost:3000 and http://localhost:3001. For Word development, see the [add-in guide](word-addin-development.md); its HTTPS development server uses port 3200.

Create a project and add public or synthetic documents to check the complete workflow. See [Safe local testing](safe-local-testing.md) and [Troubleshooting](troubleshooting.md).
