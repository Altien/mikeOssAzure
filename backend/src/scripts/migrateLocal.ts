// Local migration convenience: points at the docker-compose Postgres with SSL
// disabled (the local image has no TLS, so the Azure-default sslmode=require
// would fail), then runs the standard migration job — which already ignores
// non-SQL docs (UPSTREAM_SYNC_LOG.md) and reloads PostgREST. Run via
// `pnpm migrate:local`. Replaces hand-juggling DATABASE_URL + flags.
//
// Honors an existing DATABASE_URL if you set one (e.g. a different local DB).
process.env.DATABASE_URL ??=
  "postgres://mikeadmin:devpassword@localhost:5432/mike?sslmode=disable";
process.env.PGSSLMODE ??= "disable";

// runMigrations.ts runs main() on import.
void import("./runMigrations.js");
