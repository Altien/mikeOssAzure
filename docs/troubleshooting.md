# Troubleshooting

## A local account says “Email not confirmed”

Docker autoconfirms newly created accounts by default. Accounts created before
autoconfirm was enabled remain unconfirmed. Confirm the existing message in
[Mailpit](http://localhost:8025), or create a new local account.

To test confirmation deliberately, set `GOTRUE_MAILER_AUTOCONFIRM=false` in the
root `.env` and recreate the Auth service:

```bash
docker compose up -d --force-recreate auth
```

## Production authentication email does not arrive

Authentication email is sent by Supabase Auth. Check its email-provider
settings and configure production SMTP in the Supabase dashboard.

## Port 54322 is already allocated

Another local Postgres or Supabase stack is using Mike's default host port.
Stop that stack or choose another mapping, for example:

```bash
DB_PORT=54323 docker compose up --build
```

## The model picker reports a missing key

Add a key under **Settings > API Keys**, or configure it in
`backend/.env` and restart the backend.

For local Ollama models, confirm `ollama list` shows an installed model and the
backend can reach the URL configured by `OLLAMA_BASE_URL`. Refresh Mike after
installing a model.

## CourtListener tools are unavailable

See [CourtListener integration](courtlistener.md#troubleshooting) for API-token
and optional bulk-data checks.

## DOC or DOCX conversion fails

Install LibreOffice and restart the backend so its conversion command is
available on the process path.

## Useful checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```

For test commands and contribution expectations, see
[Contributing](../CONTRIBUTING.md#testing).
