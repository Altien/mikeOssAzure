# Troubleshooting

## Local services or database access fail

Use the health checks and service addresses in the [local stack runbook](runbook-local-stack.md). Confirm Postgres, PostgREST, Caddy, and Azurite are running and the backend has the correct local JWT and storage settings. Apply outstanding numbered migrations before retrying an API that reports missing columns, tables, or functions.

## Sign-in fails

Check the backend /config response for the intended auth provider. Local mode requires its development JWT configuration. For Entra, verify tenant, client ID, API audience/scope, and redirect URIs using the [Entra runbook](runbook-entra-local-auth.md). Browser configuration is loaded at runtime; verify requests reach the intended backend.

## Models are unavailable

Check organisation-managed Key Vault or local environment credentials. Settings shows availability but does not accept user key writes. Azure OpenAI needs a valid endpoint, deployment, API version, and API key. Router models must be selected in Settings and require their router credential. Restart the local backend after environment changes.

## Document conversion or upload fails

Check backend logs, Blob/Azurite configuration, the configured container, and LibreOffice availability. Use a small public document to isolate the failure.

## Word add-in fails

The [Word development guide](word-addin-development.md#troubleshooting) covers HTTPS certificate trust, port 3200, Entra sign-in, CORS, and tracked-change requirements.
