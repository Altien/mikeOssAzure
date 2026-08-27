# Safe Local Testing

Mike is a legal AI project. Until you have reviewed your deployment and data
flows, test it with disposable local data and synthetic documents only.

## Use Disposable Test Resources

Use separate test resources:

- local SQLite files under `backend/data/`
- disposable model-provider API keys with low spending limits
- a local OpenAI-compatible server when possible
- a test email account

Do not use firm API keys or real client documents for initial testing.

## Keep Secrets Out Of The Frontend

The browser does not need Supabase configuration. Session handling and all
Supabase keys stay server-side.

For frontend testing, `frontend/.env.local` normally needs only:

```env
API_BASE_URL=http://localhost:3001
```

Keep the Supabase service-role key in `backend/.env` only:

```env
SUPABASE_SECRET_KEY=your-supabase-service-role-key
SUPABASE_PUBLISHABLE_KEY=your-supabase-anon-key
```

Model-provider keys such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`OPENAI_API_KEY` should stay in `backend/.env`.

## Test With Synthetic Documents

Use fake or public sample documents when testing:

- synthetic NDAs
- sample contracts
- public court documents
- dummy PDF/DOCX files

Do not upload privileged, confidential, client, matter, personnel, or firm
knowledge-management material until you are comfortable with storage, logging,
deletion, and model-provider behavior.

## Confirm Environment Files Are Not Tracked

Before running or committing changes, check:

```bash
git status --short
```

Stop if `.env`, `.env.local`, or any file containing secrets appears in the
output.

## Start With Non-LLM Flows

If you do not want to use model-provider keys yet, test only the non-LLM flows
first:

- account creation
- project creation
- file upload with synthetic documents
- folder organization
- document deletion

Then add one disposable, capped model-provider key or a local
OpenAI-compatible model and test assistant behavior with synthetic documents.

## Clean Up After Testing

After testing, delete:

- local SQLite files under `backend/data/`
- disposable model-provider keys
- local `.env` files that contain secrets

For legal-document workflows, deletion semantics matter. Verify that local file
storage no longer contains test document bytes after delete flows.
