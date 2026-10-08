#!/usr/bin/env bash
# Disposable database only; no deployment credentials or existing volumes.
set -euo pipefail
cd "$(dirname "$0")/.."
container="mike-migration-ledger-test-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD=migration-test \
  -e POSTGRES_DB=mike_migration_test_suite \
  -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
ready=false
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d mike_migration_test_suite >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 1
done
if [ "$ready" != true ]; then docker logs "$container"; exit 1; fi
port="$(docker port "$container" 5432/tcp | sed 's/.*://')"
export MIKE_MIGRATION_TEST_DATABASE_URL="postgresql://postgres:migration-test@127.0.0.1:$port/mike_migration_test_suite?sslmode=disable"
pnpm exec vitest run src/__tests__/migrationLedger.db.test.ts --maxWorkers=1
