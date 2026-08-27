# Gmail integration

Mike can use a user's Gmail mailbox as an optional knowledge source, import an
email as a normal Mike document, and send material Legal Monitor alerts from
the connected mailbox. The feature is unavailable until both the instance and
the individual user are configured.

## Google Cloud setup

1. Create or select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. Configure the Google Auth Platform consent screen. Add the users who may
   connect while the app is in testing status.
4. Create an OAuth 2.0 client with application type **Web application**.
5. Add this authorized redirect URI exactly:

   ```text
   http://localhost:3001/integrations/gmail/oauth/callback
   ```

   Replace the origin for a deployed backend. The URI must be identical to
   `GMAIL_REDIRECT_URI`, including scheme, host, port, path, and trailing slash.
6. Add the following scopes to the consent configuration:

   ```text
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.send
   ```

Google classifies Gmail scopes as sensitive or restricted. A public production
deployment may require Google verification, and storing or transmitting
restricted-scope data may require an independent security assessment. Review
Google's [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [server-side OAuth guidance](https://developers.google.com/workspace/gmail/api/auth/web-server)
before production rollout.

## Backend environment

Add these values to `backend/.env`:

```dotenv
FRONTEND_URL=http://localhost:3000
API_PUBLIC_URL=http://localhost:3001

GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REDIRECT_URI=http://localhost:3001/integrations/gmail/oauth/callback

# Required for encrypting Gmail refresh tokens and user API keys at rest.
USER_API_KEYS_ENCRYPTION_SECRET=replace-with-a-long-random-secret
```

Generate the encryption secret with `openssl rand -hex 32`. Do not rotate it
without first disconnecting Gmail accounts; existing encrypted refresh tokens
cannot be decrypted under a different secret.

Restart the backend after changing the environment.

## Connect a mailbox

1. Sign in to Mike.
2. Open **Account > Features**.
3. Enable **Email Integration**.
4. Select **Connect Gmail** and approve the requested read and send access.

The document attachment dialog then shows **Import from Gmail**. Search results
accept standard Gmail query syntax, for example:

```text
from:client@example.com newer_than:30d
subject:"draft agreement" has:attachment
after:2026/07/01 before:2026/08/01
```

Selecting an email shows its headers, text body, and attachment names. Importing
creates a DOCX in Mike's SQLite-backed document storage. The original Gmail
attachment bytes are not imported; their filenames are recorded in the DOCX.
The assistant can also use `gmail_search_messages`, `gmail_get_message`, and
`gmail_import_message` when the integration is enabled and connected.

## Monitor email delivery

When Gmail is enabled and connected, a Monitor with **Email material updates**
enabled sends through the connected mailbox. The Monitor only sends when its
analysis reports material updates. Configure the recipient in the Monitor
editor.

If Gmail is unavailable, Mike retains the existing Resend fallback when
`RESEND_API_KEY` is configured. A failed or expired Gmail authorization is
reported on the Monitor run and requires reconnecting Gmail.

## Security and data behavior

- Refresh tokens are encrypted with AES-256-GCM in SQLite. Access tokens are
  refreshed on demand and are not persisted.
- OAuth state is random, one-time, and expires after ten minutes.
- Gmail tools are not sent to an LLM unless the instance is configured and the
  current user has both enabled and connected the integration.
- Disabling Email Integration immediately prevents Gmail search, import, tools,
  and Monitor delivery. Disconnecting removes the stored refresh token.
- Account exports include only mailbox address, granted scope metadata, and
  timestamps. They never include OAuth tokens.
- Account deletion removes Gmail OAuth state and connection rows.

For OAuth operational guidance, including refresh-token expiration and safe
storage, see Google's [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).
