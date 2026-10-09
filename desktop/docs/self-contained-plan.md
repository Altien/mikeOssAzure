# Self-contained workspace in the Dev fork

This is the implemented compatibility design for upstream 89dc8323. The older
proposal's Next server, GoTrue, schema.sql/desktop ledger and no-queue assumptions
do not describe this fork.

- Electron supervises native PostgreSQL and PostgREST, then the existing backend.
- The backend serves frontend/out as a static export with dynamic-route shells,
  runtime /config and /api. Frontend code retains Entra and supported local auth.
- Local auth uses persisted per-install keys and existing HttpOnly sessions.
  Guest entry supplies only a local profile email through a main-frame/origin
  guarded bridge. No GoTrue database or secret is needed by the renderer.
- PostgREST has anonymous access disabled. Its service-role JWT stays in the
  isolated backend environment. The browser uses only the authenticated API.
- Numbered SQL and public.pgmigrations initialize every database. Desktop calls
  the canonical compiled runner, preserving lock/checksum/recovery behavior.
  No secondary ledger or implicit marking of pending files exists.
- Durable jobs use the Postgres queue and existing worker thread. Stream-run
  LISTEN/NOTIFY uses the supervised direct database. Local loopback port support
  is a separate integration fix; remote deployments retain the direct-port guard.
- Filesystem storage stays behind Dev's StorageProvider and implements all
  current methods. Capability PUT is mounted before the JSON parser, enforces
  exact signed size and type, and commits with a temp-file rename. The existing
  document lifecycle continues to fence and authorise final publication.
- Model credentials remain owner-managed, from an explicit private local config
  file. Inherited shell credentials and telemetry are stripped.
- Workflow imports happen at build time through the canonical validator.
  Verified reference bytes install offline before the catalogue replacement RPC.
- Unsigned native packages are validation fixtures. Signing and publication
  require a separate release action.

See ../README.md for supported commands, mutable-state locations and limits.
The existing desktop CI validates actual Mac binaries and first/returning boots.
