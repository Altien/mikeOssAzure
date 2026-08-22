# Manual and production deployment

Use this path when connecting Mike to managed Supabase and S3-compatible
storage instead of the infrastructure bundled with Docker Compose.

## Prerequisites

- Node.js 22 or newer
- npm and Git
- A Supabase project
- A Cloudflare R2, MinIO, or other S3-compatible bucket
- At least one supported model-provider API key, or an accessible Ollama server
- Optional: a CourtListener API token for case-law tools
- LibreOffice when DOC/DOCX-to-PDF conversion is required

## Database setup

For a fresh Supabase database, run the contents of `backend/schema.sql` in the
Supabase SQL editor. The schema file contains the complete current database
shape.

For an existing deployment, do not run the complete schema over production
data. Back up the database first, identify the last migration already applied,
then apply each newer file in `backend/migrations/` in filename order.
Migration filenames follow `YYYYMMDD_<name>.sql`.

Keep the last applied migration filename with your deployment records. Do not
blindly replay the directory against production: migrations are written for an
expected starting schema, and a successful fresh install from `schema.sql` is
not evidence that an older database has completed every upgrade step. The
repository's schema-drift CI separately checks that its pinned historical
baseline converges with the fresh schema after all later migrations run.

## Environment

Copy the maintained examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Edit both files with the credentials and URLs for your deployment. Their inline
comments describe every required and optional value.

The `NEXT_PUBLIC_*` variables are required when building the frontend. Next.js
embeds them in the browser bundle at build time, so providing them only when an
already-built application starts is too late. Production builds fail when
required public values are missing.

Use:

- the Supabase project URL for `SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_URL`;
- the service-role key for backend `SUPABASE_SECRET_KEY`; and
- the anon/public key for
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`.

Never expose the service-role key, model-provider keys, or storage secrets in
the frontend environment.

Model-provider keys and the CourtListener token can be configured globally in
`backend/.env` or per user under **Settings > API Keys**. When a key is
configured globally, its matching field is read-only.

## Authentication email

Supabase Auth sends signup, email-change, and password-recovery messages.
Configure production SMTP in the Supabase dashboard; Mike does not require a
Resend API key for these messages.

In **Authentication > URL Configuration**, set the Site URL to the deployed
frontend origin and add that origin's `/auth/callback` URL to the redirect
allow list. For example:

```text
https://your-mike.example/auth/callback
```

Enable email confirmation for production signups. Keep secure email change
enabled so Supabase requires confirmation from both the current and proposed
addresses. Set the minimum password length to 10; this applies when passwords
are created or changed and does not invalidate existing shorter passwords. The
same callback handles signup confirmation, confirmed email
changes, and password-recovery links before sending the user to the appropriate
Mike page.

Review the Supabase email templates after changing the public Site URL, and
test every link against the deployed frontend before inviting users. Existing
deployments must also apply the latest migration so confirmed email changes are
mirrored into `user_profiles`.

## Google authentication

Create a **Web application** OAuth client in Google Auth Platform. Its
authorized redirect URI is the Supabase Auth callback shown on the Google
provider page, not Mike's frontend callback. For hosted Supabase it normally
has this form:

```text
https://<project-ref>.supabase.co/auth/v1/callback
```

Enable Google under **Supabase > Authentication > Providers**, then enter the
Google client ID and secret. In **Authentication > URL Configuration**, allow
both deployed Mike clients:

```text
https://your-mike.example/auth/callback
https://your-word-addin.example/oauth-dialog.html
```

The Word add-in completes authentication in an Office Dialog and returns the
Supabase session to its existing token store. It does not retain Google's
provider access token or request Google Drive or Gmail access.

## Install and run

Install dependencies:

```bash
npm install --prefix backend
npm install --prefix frontend
npm install --prefix word-addin
```

For development, start the packages in separate terminals:

```bash
npm run dev --prefix backend
```

```bash
npm run dev --prefix frontend
```

For production, build both packages and run their `start` scripts through your
process manager or deployment platform:

```bash
npm run build --prefix backend
npm run build --prefix frontend
```

The repository also includes Dockerfiles for both applications.

## Deployment safety

- Generate unique, high-entropy signing and encryption secrets.
- Use production Supabase credentials rather than the local demo values.
- Keep backend secrets out of `NEXT_PUBLIC_*` variables.
- Configure spending limits for model-provider keys where supported.
- Confirm LibreOffice is available on the backend process path if document
  conversion is enabled.
- Review storage, logging, retention, and deletion behavior before processing
  confidential documents.

See [Safe local testing](safe-local-testing.md), the [security policy](../SECURITY.md),
and [Troubleshooting](troubleshooting.md) for related guidance.
