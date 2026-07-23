# Deploying Mike to Azure — minimal self-host

This guide stands Mike up in your Azure tenant in **about 30–60
minutes** with the smallest set of resources that will run the
application: 5 Azure resources, 1 Container App, no Bicep, no
Key Vault, no VNet, no Managed Identity. Run schema migrations
from your laptop.

For local development on your laptop without any Azure resources,
see [`runbook-local-stack.md`](./runbook-local-stack.md).

For production hardening (private endpoints, MI, KV) once you've
got the minimal version working, jump to the
[Going to production](#going-to-production) appendix at the
bottom.

---

## Contents

1. [What you'll deploy](#1-what-youll-deploy)
2. [Prerequisites](#2-prerequisites)
3. [Set up your shell](#3-set-up-your-shell)
4. [Resource group](#4-resource-group)
5. [Container Apps Environment](#5-container-apps-environment)
6. [Postgres](#6-postgres)
7. [Storage Account](#7-storage-account)
8. [Container Registry](#8-container-registry)
9. [Build and push the application image](#9-build-and-push-the-application-image)
10. [Run the schema migration from your laptop](#10-run-the-schema-migration-from-your-laptop)
11. [Deploy the backend Container App (with PostgREST sidecar)](#11-deploy-the-backend-container-app-with-postgrest-sidecar)
12. [First-time configuration via `/install`](#12-first-time-configuration-via-install)
13. [Smoke test](#13-smoke-test)
14. [Optional: enable Entra ID authentication](#14-optional-enable-entra-id-authentication)
15. [Optional: enable Azure OpenAI](#15-optional-enable-azure-openai)
16. [Updates and redeploys](#16-updates-and-redeploys)
17. [Going to production](#going-to-production)
18. [Troubleshooting](#troubleshooting)

---

## 1. What you'll deploy

```
                              ┌──────────────────────────────────────┐
                              │  Container Apps Environment          │
                              │  (Consumption, no VNet)              │
                              │                                      │
   Browser  ──HTTPS──► [ingress] ──► Container App: backend          │
                              │      ├── backend container :8080    ─┤  serves API + UI
                              │      └── postgrest sidecar :3000     │  (localhost only)
                              │                                      │
                              │      Application reaches via         │
                              │       http://localhost:3000          │
                              └────────┬─────────────────────────────┘
                                       │
                                       ├── Postgres Flexible Server  (public + firewall)
                                       ├── Storage Account            (public + key auth)
                                       └── Container Registry         (admin user)

                Operator's laptop
                  └── runs `pnpm migrate:dev` directly against Postgres
                      (firewalled to your IP for the duration)
```

Five Azure resources (RG aside), one Container App with two
containers in it. Migrations run from your machine.

> **What you're trading for simplicity.** Postgres, Storage, and ACR
> are all publicly reachable (with auth). For paying-customer
> production deployments you want the private-endpoint topology in
> [Going to production](#going-to-production); for self-host or
> small-team use the public-with-auth posture is reasonable and
> cuts the deployment in half.

## 2. Prerequisites

- An Azure subscription with quota for: 1× PostgreSQL Flexible Server, 1× Container Apps Environment, 1× Container Registry, 1× Storage Account.
- `az` CLI 2.55 or later. Verify with `az --version`.
- **Node.js 22+, Corepack, and pnpm on your laptop** — used to run schema migrations against the deployed Postgres.
- The Mike source cloned locally — the migration step uses the migration files in `backend/migrations/`.
- Permission to create resources in your subscription. (If you want Entra ID sign-in in section 14, you'll also need permission to create Entra app registrations.)
- A region that supports all of the above. Most major Azure regions do.
- About 30–60 minutes of focused time.

## 3. Set up your shell

```sh
# Login
az login
az account set --subscription "<your-subscription-id-or-name>"

# Pick names. Storage / ACR have global-uniqueness constraints —
# replace XYZ with your own short tag.
export RG=rg-mike-XYZ
export LOC=uksouth                   # any region with quota
export PG_SERVER=pg-mike-XYZ
export STORAGE=stmikeXYZ             # 3-24 lowercase alphanumeric
export ACR=acrmikeXYZ                # 5-50 alphanumeric
export CAE=cae-mike-XYZ

# Generate a strong Postgres admin password — save this NOW
export PG_PASSWORD="$(openssl rand -base64 24)"
echo "Postgres admin password: $PG_PASSWORD"
```

> **Save the Postgres password.** You'll need it for migrations,
> for the application's connection string, and for any direct
> debugging. There's no Key Vault holding it for you in this minimal
> deployment.

## 4. Resource group

```sh
az group create --name "$RG" --location "$LOC"
```

## 5. Container Apps Environment

```sh
# Container Apps Environment — no VNet, no log sink.
az containerapp env create \
  --name "$CAE" --resource-group "$RG" --location "$LOC" \
  --logs-destination none
```

> **Logging is opt-in.** This minimal deployment ships container
> stdout straight to `/dev/null`. If you want logs queryable in
> KQL, provision a Log Analytics workspace and pass
> `--logs-workspace-id`/`--logs-workspace-key` instead. See the
> production-hardening doc for the wider observability stack.

This step takes ~3 minutes. While it runs, continue to step 6 in
another terminal — Postgres provisioning is also slow and can run
in parallel.

## 6. Postgres

```sh
# Provision the server with public access enabled
az postgres flexible-server create \
  --name "$PG_SERVER" --resource-group "$RG" --location "$LOC" \
  --tier Burstable --sku-name Standard_B1ms \
  --version 16 \
  --storage-size 32 --backup-retention 7 \
  --admin-user mikeadmin --admin-password "$PG_PASSWORD" \
  --public-access 0.0.0.0 \
  --yes

# IMPORTANT: whitelist required extensions before migrations run.
# Without this, migrations fail on `CREATE EXTENSION pgcrypto`.
az postgres flexible-server parameter set \
  --resource-group "$RG" --server-name "$PG_SERVER" \
  --name azure.extensions --value PGCRYPTO,VECTOR

# Allow Azure services (so the Container App can connect)
az postgres flexible-server firewall-rule create \
  --resource-group "$RG" --name "$PG_SERVER" \
  --rule-name AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0

# Allow your current public IP (so you can run migrations from local
# in step 10). The 0.0.0.0/0 we passed in --public-access above is
# overridden by these explicit rules.
MY_IP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create \
  --resource-group "$RG" --name "$PG_SERVER" \
  --rule-name AllowMyLaptop \
  --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"
```

Capture the FQDN — you'll use it in steps 10 and 11:

```sh
export PG_FQDN=$(az postgres flexible-server show \
  -n "$PG_SERVER" -g "$RG" --query fullyQualifiedDomainName -o tsv)
echo "Postgres FQDN: $PG_FQDN"
```

> **Why public access is OK here.** With public access + firewall,
> only Azure services (the Container App's egress IPs) and your
> laptop IP can reach Postgres. The admin password is the
> authentication. For paying-customer production, replace this with
> a private endpoint — see [Going to production](#going-to-production).

## 7. Storage Account

```sh
az storage account create \
  --name "$STORAGE" --resource-group "$RG" --location "$LOC" \
  --sku Standard_LRS --kind StorageV2 \
  --https-only true --min-tls-version TLS1_2 \
  --allow-blob-public-access false

# Documents container
az storage container create \
  --name documents \
  --account-name "$STORAGE" --auth-mode key

# Capture the connection string — used in step 11
export STORAGE_CONN=$(az storage account show-connection-string \
  -n "$STORAGE" -g "$RG" --query connectionString -o tsv)
```

## 8. Container Registry

```sh
az acr create \
  --name "$ACR" --resource-group "$RG" --location "$LOC" \
  --sku Basic --admin-enabled true

# Capture the credentials — used by the Container App to pull images
export ACR_LOGIN=$(az acr credential show -n "$ACR" --query username -o tsv)
export ACR_PASSWORD=$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)
```

> **Why admin-enabled.** This is the simplest path for a
> manual deployment — the Container App pulls with a username/password
> stored as a secret. The production-grade alternative is `AcrPull`
> via Managed Identity; see [Going to production](#going-to-production).

## 9. Build and push the application image

You don't need Docker locally — `az acr build` builds the image
remotely from the cloned source.

```sh
# From the cloned Mike repo root
cd path/to/cloned/mike

az acr build \
  --registry "$ACR" \
  --image "backend:latest" \
  --file Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL= \
  .
```

The `acr build` step takes 5–10 minutes the first time. The
`NEXT_PUBLIC_API_BASE_URL=` (empty) build-arg means the bundled
frontend uses same-origin requests against the backend it ships
with — correct for this single-Container-App deployment.

You also need PostgREST. Mirror it once into your ACR:

```sh
az acr import \
  --name "$ACR" \
  --source docker.io/postgrest/postgrest:v12.2.3 \
  --image "postgrest:v12.2.3"
```

## 10. Run the schema migration from your laptop

You allowed your IP through the Postgres firewall in step 6. Use
that to run migrations directly from your local clone:

```sh
cd path/to/cloned/mike/backend

# First time: activate the repository's pnpm version and install dependencies
corepack enable
pnpm install --frozen-lockfile

# Run migrations.  Two details that matter against an Azure Postgres
# Flexible Server: (a) `?sslmode=require` because Azure rejects non-SSL
# connections by default; (b) `pnpm migrate:dev` rather than `pnpm migrate`
# because the latter requires a prior `pnpm build` of the backend, while
# migrate:dev runs the TypeScript directly via tsx.
DATABASE_URL="postgres://mikeadmin:$PG_PASSWORD@$PG_FQDN:5432/postgres?sslmode=require" \
  pnpm migrate:dev
```

You should see one log line per migration applied. The migrations
are idempotent — `node-pg-migrate` records what's been applied in a
`pgmigrations` table and skips anything already there.

After every release that includes new migration files, repeat this
step (or run them from anywhere with Postgres reachability — your
CI, a developer machine, etc.).

> **Why not a Container Apps Job?** A separate Container Apps Job
> running `pnpm migrate` is the production pattern (it removes
> the local-machine dependency from operations). For a self-host
> deployment, running it from local once per release is simpler:
> one less resource, one less moving part. The Job approach is
> covered in [Going to production](#going-to-production).

## 11. Deploy the backend Container App (with PostgREST sidecar)

The backend and PostgREST run as **two containers in the same
Container App**. They share localhost networking, so the backend
talks to PostgREST at `http://localhost:3000` instead of needing
a separate ingress.

```sh
# Generate four HMAC secrets the application needs.  AUTH_STATE_SECRET
# is required even in local-auth mode because /install signs its
# session cookies with it.
export JWT_SECRET=$(openssl rand -base64 48)
export DOWNLOAD_SECRET=$(openssl rand -base64 32)
export AUTH_STATE_SECRET=$(openssl rand -base64 32)
export BOOTSTRAP_TOKEN=$(uuidgen 2>/dev/null || python -c 'import uuid; print(uuid.uuid4())')

# Postgres connection string.  sslmode=require because Azure Postgres
# Flexible Server rejects non-SSL connections by default.
export PG_URI="postgres://mikeadmin:$PG_PASSWORD@$PG_FQDN:5432/postgres?sslmode=require"

az containerapp create \
  --name backend --resource-group "$RG" --environment "$CAE" \
  --image "$ACR.azurecr.io/backend:latest" \
  --registry-server "$ACR.azurecr.io" \
  --registry-username "$ACR_LOGIN" \
  --registry-password "$ACR_PASSWORD" \
  --ingress external --target-port 8080 \
  --min-replicas 0 --max-replicas 5 \
  --cpu 0.5 --memory 1Gi \
  --secrets \
    "pg-uri=$PG_URI" \
    "jwt-secret=$JWT_SECRET" \
    "storage-conn=$STORAGE_CONN" \
    "download-secret=$DOWNLOAD_SECRET" \
    "auth-state-secret=$AUTH_STATE_SECRET" \
    "bootstrap-token=$BOOTSTRAP_TOKEN" \
    "anthropic-key=<your-anthropic-key>" \
    "openai-key=<your-openai-key>" \
    "gemini-key=<your-gemini-key>" \
  --env-vars \
    "NODE_ENV=production" \
    "PORT=8080" \
    "AUTH_PROVIDER=local" \
    "SUPABASE_URL=http://localhost:3000" \
    "SUPABASE_SECRET_KEY=secretref:jwt-secret" \
    "JWT_SECRET=secretref:jwt-secret" \
    "AZURE_STORAGE_CONNECTION_STRING=secretref:storage-conn" \
    "AZURE_STORAGE_CONTAINER_NAME=documents" \
    "DOWNLOAD_SIGNING_SECRET=secretref:download-secret" \
    "AUTH_STATE_SECRET=secretref:auth-state-secret" \
    "INSTALL_BOOTSTRAP_TOKEN=secretref:bootstrap-token" \
    "ANTHROPIC_API_KEY=secretref:anthropic-key" \
    "OPENAI_API_KEY=secretref:openai-key" \
    "GEMINI_API_KEY=secretref:gemini-key"
```

> Replace `<your-anthropic-key>`, `<your-openai-key>`, `<your-gemini-key>`
> with your actual provider keys. You need at least one of them; set
> the others to empty if you don't have them. The application
> falls back through providers based on user preference.

Now add the PostgREST sidecar to the same Container App:

```sh
az containerapp update \
  --name backend --resource-group "$RG" \
  --container-name postgrest \
  --image "$ACR.azurecr.io/postgrest:v12.2.3" \
  --cpu 0.25 --memory 0.5Gi \
  --set-env-vars \
    "PGRST_DB_URI=secretref:pg-uri" \
    "PGRST_DB_SCHEMA=public" \
    "PGRST_DB_ANON_ROLE=web_anon" \
    "PGRST_SERVER_PORT=3000" \
    "PGRST_JWT_SECRET=secretref:jwt-secret"
```

> The `containerapp update --container-name postgrest` syntax adds
> a second container to the existing app rather than replacing the
> first. Both containers share the app's `--secrets`. After this
> command completes, the app has two containers running side-by-side.

Capture the backend FQDN — you'll need it for `/install`, Entra
setup (section 14), and the smoke test:

```sh
export BACKEND_FQDN=$(az containerapp show \
  -n backend -g "$RG" \
  --query 'properties.configuration.ingress.fqdn' -o tsv)
echo "Backend: https://$BACKEND_FQDN"

# CORS / login redirects need this too
az containerapp update \
  -n backend -g "$RG" \
  --set-env-vars \
    "FRONTEND_URL=https://$BACKEND_FQDN" \
    "BACKEND_PUBLIC_URL=https://$BACKEND_FQDN"
```

## 12. First-time configuration via `/install`

The deployed backend exposes `/install` — a server-rendered config
admin UI. With this minimal deployment running in
`AUTH_PROVIDER=local` mode, it's a quick way to verify the app is
running and to seed any per-tenant settings. (When you switch to
Entra in section 14, `/install` becomes the primary tool for
operators to manage config.)

```sh
echo "Visit: https://$BACKEND_FQDN/install"
echo "Bootstrap token: $BOOTSTRAP_TOKEN"
```

1. Open the URL in a browser.
2. Paste the bootstrap token. The configurator issues a short-lived
   session cookie.
3. The page shows a checklist of expected config items. Each item
   probes the live state and shows ✓ / ✗ / info.
4. For items the configurator can fix in-place (paste a setting,
   choose a default model), use the inline form.
5. Some items need work outside the deployment (creating Entra
   apps, provisioning Azure OpenAI). The configurator tells you
   what's needed; operator-side automation scripts are not
   bundled with this fork — see `scripts/install/README.md` for
   the format if you want to ship your own.

> **Note on minimal mode.** Because this deployment doesn't use
> Key Vault, `/install` cannot persist most config items —
> there's no KV to write to. Treat it as a status-check page in
> minimal mode. Switch to Entra (section 14) and you'll have a
> full configuration plane backed by Container App env updates.

## 13. Smoke test

```sh
# Health check (unauthenticated)
curl -fsS "https://$BACKEND_FQDN/api/health"
# → {"ok":true}

# Runtime config — confirms the bundle picks up the right values
curl -fsS "https://$BACKEND_FQDN/config"
# → {"authProvider":"local","entra":{"tenantId":"","clientId":""}}

# Open the app
echo "App: https://$BACKEND_FQDN"
```

In a browser, you should see the login page. Click **Continue
locally**, type any email, and you'll be signed in (`AUTH_PROVIDER=local`
mints a JWT for any email). This validates the full vertical:
backend boots, PostgREST sidecar reachable on localhost, schema
migrated, blob container ready.

For real users you'll want Microsoft sign-in — see the next
section.

## 14. Optional: enable Entra ID authentication

Two Entra app registrations + nine env-var changes on the backend.
The recommended auth mode for any deployment that has real users.

The minimal deployment below intentionally has no Key Vault, so follow its
Azure CLI commands. A hardened deployment that has added Key Vault can use
[`scripts/install/create-entra-apps.ps1`](../scripts/install/create-entra-apps.ps1)
from PowerShell 7 instead.

### 14a. Create the backend API app registration

```sh
# Create the app
az ad app create \
  --display-name "Mike Backend API" \
  --sign-in-audience AzureADMyOrg

export BACKEND_APP_ID=$(az ad app list \
  --display-name "Mike Backend API" --query '[0].appId' -o tsv)

# Set the identifier URI
az ad app update --id "$BACKEND_APP_ID" \
  --identifier-uris "api://$BACKEND_APP_ID"

# Expose access_as_user scope. The portal makes this easy; via az
# you set the api property on the app.
SCOPE_ID=$(uuidgen 2>/dev/null || python -c 'import uuid; print(uuid.uuid4())')
az ad app update --id "$BACKEND_APP_ID" --set "api={
  \"oauth2PermissionScopes\": [{
    \"adminConsentDescription\": \"Allows the app to access the Mike backend API as the signed-in user.\",
    \"adminConsentDisplayName\": \"Access Mike Backend API\",
    \"id\": \"$SCOPE_ID\",
    \"isEnabled\": true,
    \"type\": \"User\",
    \"userConsentDescription\": \"Allows this app to access the Mike backend API.\",
    \"userConsentDisplayName\": \"Access Mike Backend API\",
    \"value\": \"access_as_user\"
  }]
}"
```

### 14b. Create the web login client app registration

```sh
az ad app create \
  --display-name "Mike Web Login" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://$BACKEND_FQDN/api/auth/openid-callback/microsoft"

export WEB_APP_ID=$(az ad app list \
  --display-name "Mike Web Login" --query '[0].appId' -o tsv)

# Add a client secret
export WEB_SECRET=$(az ad app credential reset --id "$WEB_APP_ID" \
  --display-name "deploy-time" --query password -o tsv)

# Grant the web app delegated access to the backend API
az ad app permission add \
  --id "$WEB_APP_ID" --api "$BACKEND_APP_ID" \
  --api-permissions "$SCOPE_ID=Scope"

az ad app permission grant \
  --id "$WEB_APP_ID" --api "$BACKEND_APP_ID" \
  --scope access_as_user
```

> **Admin consent.** Some tenants block user consent — if so, an
> admin needs to grant consent. Run `az ad app permission
> admin-consent --id "$WEB_APP_ID"` if your account has the
> required role, or have a Directory admin click "Grant admin
> consent" in the portal.

### 14c. Optional — group claims for role mapping

Mike maps Entra group OIDs to app roles via two env vars
(`ENTRA_ADMIN_GROUP_IDS`, `ENTRA_MEMBER_GROUP_IDS`). To use them,
the backend API app needs to emit `groups` claims. In the portal:

1. Open the Mike Backend API app registration → **Token configuration**.
2. **Add groups claim** → tick **Security groups** for both Access
   tokens and ID tokens.

Capture the group OIDs:

```sh
az ad group show --group "<your-admin-group-name>" --query id -o tsv
az ad group show --group "<your-member-group-name>" --query id -o tsv
```

### 14d. Switch the backend to entra mode

```sh
export TENANT_ID=$(az account show --query tenantId -o tsv)
export AUTH_STATE_SECRET=$(openssl rand -base64 32)

az containerapp update \
  -n backend -g "$RG" \
  --set-env-vars \
    "AUTH_PROVIDER=entra" \
    "ENTRA_TENANT_ID=$TENANT_ID" \
    "ENTRA_BACKEND_CLIENT_ID=$BACKEND_APP_ID" \
    "ENTRA_BACKEND_SCOPE=api://$BACKEND_APP_ID/access_as_user" \
    "ENTRA_CLIENT_ID=$WEB_APP_ID" \
    "ENTRA_REDIRECT_URI=https://$BACKEND_FQDN/api/auth/openid-callback/microsoft" \
    "ENTRA_ADMIN_GROUP_IDS=<comma-separated-admin-group-oids>" \
    "ENTRA_MEMBER_GROUP_IDS=<comma-separated-member-group-oids>"

# Add the client secret + auth-state secret
az containerapp secret set \
  -n backend -g "$RG" \
  --secrets \
    "entra-client-secret=$WEB_SECRET" \
    "auth-state-secret=$AUTH_STATE_SECRET"

az containerapp update \
  -n backend -g "$RG" \
  --set-env-vars \
    "ENTRA_CLIENT_SECRET=secretref:entra-client-secret" \
    "AUTH_STATE_SECRET=secretref:auth-state-secret"
```

The PostgREST sidecar also needs an adjustment — entra mode
disables JWT validation (the trust boundary becomes "PostgREST is
in the same Container App as the backend, only reachable via
localhost").

```sh
az containerapp update \
  --name backend --resource-group "$RG" \
  --container-name postgrest \
  --set-env-vars \
    "PGRST_DB_ANON_ROLE=service_role" \
    "PGRST_JWT_SECRET="
```

Smoke test:

```sh
# Should redirect to login.microsoftonline.com
curl -sI "https://$BACKEND_FQDN/api/auth/select-provider?returnUrl=https%3A%2F%2F$BACKEND_FQDN%2Fassistant&selectAccount=true" \
  | grep -i location
```

## 15. Optional: enable Azure OpenAI

Mike supports Azure OpenAI as an LLM provider alongside Anthropic,
Gemini, and direct OpenAI.

For a hardened deployment that uses Key Vault, the equivalent PowerShell
helper is [`scripts/install/setup-aoai.ps1`](../scripts/install/setup-aoai.ps1).

### 15a. Connect to an existing AOAI resource

```sh
az containerapp secret set \
  -n backend -g "$RG" \
  --secrets \
    "azure-openai-key=<your-aoai-key>"

az containerapp update \
  -n backend -g "$RG" \
  --set-env-vars \
    "AZURE_OPENAI_ENDPOINT=https://<your-aoai>.openai.azure.com" \
    "AZURE_OPENAI_API_KEY=secretref:azure-openai-key" \
    "AZURE_OPENAI_API_VERSION=2024-10-21" \
    "AZURE_OPENAI_DEPLOYMENT=<your-default-deployment-name>"
```

### 15b. Provision a fresh AOAI resource

```sh
export AOAI=aoai-mike-XYZ

az cognitiveservices account create \
  --name "$AOAI" --resource-group "$RG" --location "$LOC" \
  --kind OpenAI --sku S0 \
  --custom-domain "$AOAI" --yes

# Deploy a model. Pick one with quota in your region; see
# https://learn.microsoft.com/azure/ai-services/openai/concepts/models
az cognitiveservices account deployment create \
  --resource-group "$RG" --name "$AOAI" \
  --deployment-name "gpt-4o-mini" \
  --model-name "gpt-4o-mini" --model-version "2024-07-18" \
  --model-format OpenAI \
  --sku-name Standard --sku-capacity 10

ENDPOINT=$(az cognitiveservices account show \
  -n "$AOAI" -g "$RG" --query 'properties.endpoint' -o tsv)
KEY=$(az cognitiveservices account keys list \
  -n "$AOAI" -g "$RG" --query key1 -o tsv)
```

Then wire `$ENDPOINT`, `$KEY`, and `gpt-4o-mini` into the backend
as in 15a.

### 15c. Per-user keys

Per-user AOAI is also supported — each user can paste their own
endpoint, key, and pick a deployment from the dropdown on the in-app
`/account/models` page. The model picker calls
`/llm/azure-openai/deployments` against the user's endpoint to
populate the dropdown.

## 16. Updates and redeploys

For application code changes:

```sh
# Pull the latest code, rebuild
cd path/to/cloned/mike
git pull

az acr build \
  --registry "$ACR" \
  --image "backend:latest" \
  --file Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL= \
  .

# If the new release ships schema migrations, re-run from local
DATABASE_URL="postgres://mikeadmin:$PG_PASSWORD@$PG_FQDN:5432/postgres?sslmode=require" \
  pnpm -C backend migrate:dev

# Promote the backend container to the new image
az containerapp update -n backend -g "$RG" \
  --image "$ACR.azurecr.io/backend:latest"
```

For env-var changes (rotating an LLM key, adding a group OID to
admin list, etc.): `az containerapp update --set-env-vars` /
`--secrets`. Each change creates a new revision and the previous
one drains.

---

## Going to production

The minimal deployment above is the right shape for self-host or
small-team use. For production deployments — paying customers,
regulatory compliance, mature operations — layer in the following
in roughly this order:

### 1. Network isolation (private endpoints)

Replace public Postgres + public Storage with private endpoints
on a VNet. Adds:

- Virtual Network with two subnets (`subnet-cae` delegated to
  `Microsoft.App/environments`, `subnet-pe` for endpoints).
- Private DNS zones (`privatelink.postgres.database.azure.com`,
  `privatelink.blob.core.windows.net`) linked to the VNet.
- Private endpoints + zone groups for Postgres and Blob.
- Postgres `--public-access Disabled`.
- Storage `--default-action Deny` and the IP-allowlist firewall
  rules removed.
- Container Apps Environment created with
  `--infrastructure-subnet-resource-id` pointed at `subnet-cae`.

This is non-trivial — about another 30 minutes of `az` commands.

### 2. Managed Identity for credential-less auth

Replace ACR admin user + Storage connection string + Postgres
password with Managed Identity:

- User-assigned MI granted `AcrPull`, `Storage Blob Data
  Contributor`, and (optionally) `Postgres role member`.
- Container App attaches the MI; pulls images, reads from blob,
  and reads from KV without any stored passwords.

### 3. Key Vault for centralized secret management

Once you have MI, use Key Vault for shared secrets across multiple
environments / deployments:

- Key Vault with RBAC mode.
- MI granted `Key Vault Secrets User`.
- All secrets become `keyvaultref:` references in the Container App
  config.
- Rotating a secret = update KV once, all Container Apps re-resolve.

### 4. Schema migrations as a Container Apps Job

Replace running `pnpm migrate` from a laptop with a managed Job:

- `Microsoft.App/jobs` resource, manual trigger, same backend image.
- Triggered by the deploy pipeline before the backend is promoted.
- No human-machine dependency in the production deploy path.

### 5. PostgREST as a separate Container App with internal-only ingress

Splitting the sidecar back out to a dedicated Container App:

- Better isolation (PostgREST scales independently of backend).
- Can be reached from other Container Apps in the same environment.
- Internal-only ingress is the trust boundary in entra mode.

### 6. Observability (Log Analytics + App Insights)

For queryable logs and request/dependency/exception telemetry:

- Log Analytics workspace as the Container Apps log destination
  (`--logs-workspace-id`/`--logs-workspace-key` on env create).
- Workspace-based Application Insights resource linked to it.
- Backend reads `APPLICATIONINSIGHTS_CONNECTION_STRING` (from KV)
  and emits HTTP request, dependency, and exception telemetry.

### 7. NAT Gateway

For stable outbound IP (matters if you allowlist the deployment's
egress with third-party LLM providers):

- Standard Public IP + NAT Gateway attached to `subnet-cae`.
- All Container App egress now exits through that single IP.

### 8. Zone-redundant high availability

Postgres Flex Server `enableHa: 'ZoneRedundant'` (requires General
Purpose tier — Burstable doesn't support it). Container Apps
already scale across zones in supported regions.

### 9. Custom domain + WAF

For a branded URL and HTTP-layer attack mitigation:

- Container App custom domain bound to your DNS.
- Optionally Azure Front Door or Application Gateway with a WAF
  policy in front.


---

## Troubleshooting

### `subnet must be delegated to Microsoft.App/environments`

You're trying to attach a CAE to a subnet that doesn't have the
delegation. The minimal deployment doesn't need a VNet — only
[Going to production](#going-to-production) does. Drop the
`--infrastructure-subnet-resource-id` flag from `az containerapp
env create` if you don't need network isolation yet.

### `extension "pgcrypto" is not allow-listed`

Step 10 (migration) failed because step 6 (Postgres) didn't whitelist
the extension. Run the `parameter set` command from step 6 again,
then retry the migration.

### Migrations fail with "could not connect to server"

Your laptop IP changed and the Postgres firewall no longer allows
it. Find your new IP and re-run the firewall-rule create from
step 6 with `--rule-name AllowMyLaptop` (it overwrites the
existing rule).

### Backend can't reach PostgREST sidecar

Sidecars share localhost. The backend's `SUPABASE_URL` should be
`http://localhost:3000`. If you see DNS errors in the backend logs
trying to resolve `postgrest`, the env var still points at the
production-style separate-Container-App URL — fix it with `az
containerapp update --set-env-vars SUPABASE_URL=http://localhost:3000`.

### Backend container restarts in a loop

Almost always a missing env var causing the backend to throw at
startup. Stream logs:

```sh
az containerapp logs show \
  --name backend --resource-group "$RG" \
  --container backend --type system --follow
```

The first error in the boot sequence is the cause.

### Microsoft sign-in says "redirect URI does not match"

The web login app registration's Web redirect URI must be exactly
`https://$BACKEND_FQDN/api/auth/openid-callback/microsoft`. Update via
portal (App registrations → your app → Authentication) or:

```sh
az ad app update --id "$WEB_APP_ID" \
  --web-redirect-uris "https://$BACKEND_FQDN/api/auth/openid-callback/microsoft"
```

### Backend returns `Invalid audience` after Microsoft sign-in

Token's `aud` claim doesn't match `ENTRA_BACKEND_CLIENT_ID`. The
SPA app's `access_as_user` permission must point at the same
backend API app you set in `ENTRA_BACKEND_CLIENT_ID`.

### `/install` returns 401 / "Bootstrap token invalid"

Either you pasted the wrong token, or the bootstrap was already
retired by a successful Entra admin sign-in. To rotate:

```sh
NEW_BOOTSTRAP=$(uuidgen)
az containerapp secret set \
  -n backend -g "$RG" \
  --secrets "bootstrap-token=$NEW_BOOTSTRAP"
echo "New token: $NEW_BOOTSTRAP"
```

The next request to `/install` picks up the new value (after the
TTL cache expires — 5 minutes — or restart the backend revision
to flush immediately).

---

## References

- [`runbook-local-stack.md`](./runbook-local-stack.md) — local
  development without any Azure resources
- `backend/src/lib/install/manifest.ts` — canonical list of
  expected Key Vault secret names (relevant when you graduate to KV)
- `backend/.env.example` — complete env-var reference
- [Azure Container Apps documentation](https://learn.microsoft.com/azure/container-apps/)
- [Azure Database for PostgreSQL Flexible Server documentation](https://learn.microsoft.com/azure/postgresql/flexible-server/)
- [Microsoft Entra ID app registration documentation](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app)
