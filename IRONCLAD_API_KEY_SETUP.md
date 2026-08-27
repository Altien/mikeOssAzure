# Getting An Ironclad API Key For Mike

Date: 2026-07-22

This guide explains how to get an Ironclad API bearer token and configure Mike
to use Ironclad's published API for contract search and document import.

## What Mike Needs

Mike expects an Ironclad bearer token in the backend environment:

```bash
IRONCLAD_API_KEY=your-ironclad-bearer-token
IRONCLAD_BASE_URL=https://na1.ironcladapp.com
IRONCLAD_AS_USER_EMAIL=you@example.com
```

`IRONCLAD_API_KEY` is required.

`IRONCLAD_BASE_URL` is optional. Use the Ironclad domain for your environment.
Most US production tenants use:

```bash
https://na1.ironcladapp.com
```

Your tenant may use a different domain, such as a sandbox, EU, or demo domain.
Check the URL you use when logged into Ironclad.

`IRONCLAD_AS_USER_EMAIL` is optional but recommended for this app. It tells
Ironclad which user the request should act as when using a client-credentials
token. The user must have permission in Ironclad to see the records you want
Mike to access.

## Step 1: Confirm API Access Is Enabled

Ironclad's API settings are only visible if API access is enabled for your
Ironclad instance.

If you do not see API settings:

1. Contact your Ironclad admin, Customer Success Manager, or Ironclad Support.
2. Ask them to enable API access for the instance.
3. Ask whether your company wants OAuth client credentials or a user-authorized
   OAuth flow.

## Step 2: Register An OAuth Client

In Ironclad:

1. Open your user profile menu.
2. Go to **Company Settings**.
3. Open the **API** tab.
4. Register a new OAuth client application.
5. Choose the grant type your organization wants to use.

For a server-side integration like Mike, the usual choice is:

```text
Client Credentials Grant
```

If your organization wants each Ironclad user to consent individually, use the
Authorization Code Grant instead. Mike's current integration is instance-level,
so client credentials are the simpler fit.

## Step 3: Add The Required Scopes

For Mike's current Ironclad features, the token needs record-read access.

Use at least:

```text
public.records.readRecords
```

Mike currently uses these Ironclad API actions:

- list records
- retrieve one record
- retrieve a record attachment

If Ironclad exposes more granular attachment scopes in your tenant, include the
record/attachment read scopes required by the Record and Attachment endpoints.

## Step 4: Generate Or Request The Bearer Token

Ironclad primarily uses OAuth 2.0 bearer tokens.

Depending on your company's Ironclad setup, you may receive:

- a client id and client secret, which you exchange for an access token, or
- a generated bearer/access token from an admin-controlled integration setup.

Store the resulting access token as:

```bash
IRONCLAD_API_KEY=...
```

Do not commit this value to git.

## Step 5: Pick The Actor User

For client-credentials tokens, Ironclad requires resource requests to include
one of these headers:

```http
x-as-user-email: user@example.com
x-as-user-id: ironclad-user-id
```

Mike currently sends `x-as-user-email`.

Set:

```bash
IRONCLAD_AS_USER_EMAIL=service-account-or-admin@example.com
```

Choose an Ironclad user that has access to the records Mike should search and
import. A dedicated service account is usually cleaner than using a real
employee's personal account.

If `IRONCLAD_AS_USER_EMAIL` is not set, Mike falls back to the signed-in Mike
user's email for each request. That only works if the signed-in Mike user's
email is also a valid Ironclad user with the needed permissions.

## Step 6: Configure Mike

Add this to `backend/.env`:

```bash
IRONCLAD_API_KEY=your-ironclad-bearer-token
IRONCLAD_BASE_URL=https://na1.ironcladapp.com
IRONCLAD_AS_USER_EMAIL=service-account-or-admin@example.com
```

Restart the backend:

```bash
cd backend
npm run dev
```

## Step 7: Smoke Test

After logging into Mike, check:

```http
GET /integrations/ironclad/status
```

Expected response:

```json
{
  "configured": true
}
```

Then test record search:

```http
GET /integrations/ironclad/records?search=test&pageSize=5
```

If the token and actor are valid, Mike should return a JSON object with a
`list` array.

## Troubleshooting

### API Tab Is Missing

Your Ironclad instance probably does not have API access enabled, or your user
does not have permission to manage API settings.

Ask an Ironclad admin or Ironclad Support to enable API access.

### 401 Or 403 From Ironclad

Likely causes:

- `IRONCLAD_API_KEY` is invalid or expired.
- The OAuth client does not have the required scopes.
- `IRONCLAD_AS_USER_EMAIL` is missing for a client-credentials token.
- The actor user does not have access to the requested records.

### Status Is Configured But Search Fails

`/integrations/ironclad/status` only checks whether `IRONCLAD_API_KEY` is set.
It does not validate the token with Ironclad.

Run a record search to validate token, base URL, scopes, and actor permissions.

### Wrong Ironclad Base URL

Set `IRONCLAD_BASE_URL` to the domain for your Ironclad environment. Examples:

```bash
IRONCLAD_BASE_URL=https://na1.ironcladapp.com
IRONCLAD_BASE_URL=https://eu1.ironcladapp.com
IRONCLAD_BASE_URL=https://demo.ironcladapp.com
```

Use the exact host your organization uses to log into Ironclad.

## Security Notes

- Treat the bearer token like a password.
- Store it only in backend environment variables or a secret manager.
- Do not expose it to the frontend.
- Prefer a dedicated Ironclad service account with the minimum permissions
  needed for Mike.
- Rotate the token if it is exposed.

## References

- Ironclad authentication overview:
  https://developer.ironcladapp.com/reference/authentication-api
- Register an OAuth client:
  https://developer.ironcladapp.com/reference/register-oauth-client
- Authenticate API requests:
  https://developer.ironcladapp.com/reference/authenticate-a-request
- Ironclad API overview:
  https://support.ironcladapp.com/hc/en-us/articles/12278082472855-Ironclad-s-Public-API-Overview
