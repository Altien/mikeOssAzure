# Runbook: Local Microsoft Entra ID Authentication

Date: 2026-05-05

## Purpose

This runbook describes the exact Microsoft Entra ID configuration needed to run the local frontend on `localhost:3000`, the local Node backend on `localhost:3001`, authenticate with Microsoft, and call the backend with an Entra access token.

This is app-registration setup only. It does not require Azure Container Apps, Key Vault, ACR, or Azure deployment.

## Architecture

Use two Entra app registrations:

| App registration | Purpose | Local env value |
|---|---|---|
| Backend API | Defines the protected API audience and delegated scope. The Node backend validates tokens for this app. | `ENTRA_BACKEND_CLIENT_ID` |
| Web Login Client | Performs the authorization-code login flow and receives the callback at the local backend. | `ENTRA_CLIENT_ID` |

The local flow is:

1. Browser opens `http://localhost:3000/login`.
2. Frontend redirects to `http://localhost:3001/auth/select-provider`.
3. Backend redirects to Microsoft authorize endpoint.
4. Microsoft redirects back to `http://localhost:3001/auth/openid-callback/microsoft`.
5. Backend exchanges the authorization code for an access token.
6. Backend redirects the browser to the frontend with the access token in the URL fragment.
7. Frontend stores the token and sends it to the Node backend as `Authorization: Bearer <token>`.
8. Backend validates the token signature, issuer, tenant, expiry, and audience.

## Prerequisites

- Access to the correct Entra tenant.
- Permission to create app registrations and grant API permissions.
- Local backend callback URI:

```text
http://localhost:3001/auth/openid-callback/microsoft
```

- Local frontend URL:

```text
http://localhost:3000
```

## Step 1: Create The Backend API App Registration

1. Open Microsoft Entra admin center.
2. Go to **Entra ID**.
3. Go to **App registrations**.
4. Click **New registration**.
5. Enter name:

```text
Mike Local Backend API
```

6. Supported account types:

```text
Accounts in this organizational directory only
```

7. Leave Redirect URI blank.
8. Click **Register**.

On the app registration **Overview** page, copy:

- **Application (client) ID**: this is `ENTRA_BACKEND_CLIENT_ID`.
- **Directory (tenant) ID**: this is `ENTRA_TENANT_ID`.

## Step 2: Expose The Backend API Scope

Still inside **Mike Local Backend API**:

1. Go to **Expose an API**.
2. Click **Add** next to **Application ID URI**.
3. Accept the default value:

```text
api://<backend-api-client-id>
```

4. Click **Save**.
5. Click **Add a scope**.
6. Set **Scope name**:

```text
access_as_user
```

7. Set **Who can consent**:

```text
Admins and users
```

If tenant policy does not allow user consent, choose **Admins only**.

8. Set **Admin consent display name**:

```text
Access Mike Backend API
```

9. Set **Admin consent description**:

```text
Allows the app to access the Mike backend API as the signed-in user.
```

10. Set **User consent display name**:

```text
Access Mike Backend API
```

11. Set **User consent description**:

```text
Allows this app to access the Mike backend API.
```

12. Set **State** to **Enabled**.
13. Click **Add scope**.

The backend scope value is:

```text
api://<backend-api-client-id>/access_as_user
```

Use that value as `ENTRA_BACKEND_SCOPE` in `backend/.env`.

## Step 3: Create The Web Login Client App Registration

1. Return to **App registrations**.
2. Click **New registration**.
3. Enter name:

```text
Mike Local Web Login
```

4. Supported account types:

```text
Accounts in this organizational directory only
```

5. Under **Redirect URI**, choose platform:

```text
Web
```

6. Enter URI:

```text
http://localhost:3001/auth/openid-callback/microsoft
```

7. Click **Register**.

On the app registration **Overview** page, copy:

- **Application (client) ID**: this is `ENTRA_CLIENT_ID`.
- **Directory (tenant) ID**: same `ENTRA_TENANT_ID`.

If you are not on the app page after registration:

1. Go to **App registrations**.
2. Select **All applications** or **Owned applications**.
3. Search for `Mike Local Web Login`.
4. Click the app name.
5. Click **Overview** in the app's left menu.

Use **App registrations**, not **Enterprise applications**, for these settings.

## Step 4: Create A Web Client Secret

Inside **Mike Local Web Login**:

1. Go to **Certificates & secrets**.
2. Click **New client secret**.
3. Description:

```text
local development
```

4. Expiry: choose a short local-dev expiry, such as 90 or 180 days.
5. Click **Add**.
6. Copy the **Value** immediately.

The secret value is shown only once. Use it as `ENTRA_CLIENT_SECRET`.

Do not use the secret ID. Use the secret value.

## Step 5: Grant The Web Client Permission To Call The Backend API

Inside **Mike Local Web Login**:

1. Go to **API permissions**.
2. Click **Add a permission**.
3. Click **My APIs**.
4. Select **Mike Local Backend API**.
5. Choose **Delegated permissions**.
6. Tick:

```text
access_as_user
```

7. Click **Add permissions**.
8. Click **Grant admin consent for <tenant name>** if available or required.

If admin consent is not granted and the tenant blocks user consent, Microsoft login may succeed but token issuance for the backend scope can fail.

## Step 6: Configure `backend/.env`

Set:

```env
AUTH_PROVIDER=entra
FRONTEND_URL=http://localhost:3000
BACKEND_PUBLIC_URL=http://localhost:3001

ENTRA_TENANT_ID=<directory-tenant-id>
ENTRA_BACKEND_CLIENT_ID=<backend-api-client-id>
ENTRA_CLIENT_ID=<web-login-client-id>
ENTRA_CLIENT_SECRET=<web-login-client-secret-value>
ENTRA_BACKEND_SCOPE=api://<backend-api-client-id>/access_as_user
ENTRA_REDIRECT_URI=http://localhost:3001/auth/openid-callback/microsoft
AUTH_STATE_SECRET=<strong-random-local-string>
```

Keep the existing local data-plane values:

```env
SUPABASE_URL=http://localhost:4000
SUPABASE_SECRET_KEY=<local-service-role-jwt>
AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true
AZURE_STORAGE_CONTAINER_NAME=documents
```

## Step 7: Configure `frontend/.env.local`

Only one variable is needed:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

Provider mode (`entra` / `local` / `supabase`) and any Entra IDs
the browser needs are served at runtime by the backend's
`GET /config` and resolved by `frontend/src/contexts/ConfigContext.tsx`
on app startup. The bundle is portable across deployments — no
`NEXT_PUBLIC_AUTH_PROVIDER`, no `NEXT_PUBLIC_ENTRA_*`, no
`NEXT_PUBLIC_REDIRECT_URI`.

The supabase env vars (`NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`) are needed only if
you set `AUTH_PROVIDER=supabase` in `backend/.env`. In entra or
local mode the lazy `getSupabaseClient()` factory in
`frontend/src/lib/supabase.ts` is never called, so leaving them
unset is fine.

## Step 8: Restart Local Apps

Environment files are read at process startup. Restart both apps after editing env files.

Backend:

```powershell
cd C:\Data\Projects\MikeAzureDev\backend
npm run dev
```

Frontend:

```powershell
cd C:\Data\Projects\MikeAzureDev\frontend
npm run dev
```

## Step 9: Validate

Backend health:

```text
http://localhost:3001/health
```

Expected:

```json
{"ok":true}
```

Backend auth redirect smoke test:

```text
http://localhost:3001/auth/select-provider?returnUrl=http%3A%2F%2Flocalhost%3A3000%2Fassistant&selectAccount=true
```

Expected: redirect to `https://login.microsoftonline.com/...`.

End-to-end test:

1. Open:

```text
http://localhost:3000/login
```

2. Click **Sign in with Microsoft**.
3. Authenticate.
4. Expect redirect back into the frontend, normally `/assistant`.

## Troubleshooting

### Backend root URL is blank or 404

This is expected. The backend does not currently define `GET /`.

Use:

```text
http://localhost:3001/health
```

### Microsoft says the redirect URI does not match

Check **Mike Local Web Login** -> **Authentication**.

The redirect URI must be exactly:

```text
http://localhost:3001/auth/openid-callback/microsoft
```

The platform must be **Web**, because the backend performs the authorization-code exchange with a client secret.

### Token exchange fails

Check:

- `ENTRA_CLIENT_ID` is the web login app registration client ID.
- `ENTRA_CLIENT_SECRET` is the web login secret value, not the secret ID.
- `ENTRA_REDIRECT_URI` exactly matches the Web redirect URI.
- `ENTRA_BACKEND_SCOPE` is `api://<backend-api-client-id>/access_as_user`.
- The web login app has delegated permission to the backend API scope.
- Admin consent has been granted if tenant policy requires it.

### Backend returns `Invalid audience`

The access token is not for the backend API app.

Check:

- `ENTRA_BACKEND_CLIENT_ID` is the backend API app registration client ID.
- `ENTRA_BACKEND_SCOPE` uses that same backend API client ID.
- The web login app requested that exact scope.

### Frontend build fails with `supabaseUrl is required`

This used to happen with the build-time supabase client constructor.
After issue 031 the supabase client is constructed lazily and only
in supabase mode — entra and local builds need no supabase env
vars at all. If you still see this error you're on a pre-031
build; pull the latest code.

## Security Notes

- Do not commit `backend/.env` or `frontend/.env.local`.
- Rotate the web client secret if it is pasted into chat, logs, screenshots, or commits.
- Prefer a short expiry for local-development secrets.
- Use a strong `AUTH_STATE_SECRET`; it signs the OAuth state value that carries the frontend return URL.
