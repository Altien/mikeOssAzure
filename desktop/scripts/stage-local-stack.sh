#!/usr/bin/env bash
# Stage an unsigned validation bundle. Publishing/signing is a separate action.
set -euo pipefail
cd "$(dirname "$0")/../.."
test -x desktop/local-stack/bin/pg/bin/postgres || { echo "run local:fetch first"; exit 1; }
test -x desktop/local-stack/bin/postgrest || { echo "run local:fetch first"; exit 1; }
test -f backend/dist/scripts/migrationLedger.js || { echo "run local:build first"; exit 1; }
test -f backend/dist/workerThread.js || { echo "run local:build to compile role workers"; exit 1; }
test -f backend/dist/lib/extraction/process.js || { echo "run local:build to compile isolated parsers"; exit 1; }
test -f backend/dist/workflow-catalog/catalog.json || { echo "run local:build to bundle offline workflows"; exit 1; }
test -f frontend/out/index.html || { echo "run local:build first"; exit 1; }
APP="desktop/local-stack/app"
rm -rf "$APP"
mkdir -p "$APP/backend"
node desktop/scripts/stage-source-notices.mjs "$APP" desktop/local-stack/bin/notices
cp -R backend/dist "$APP/backend/dist"
cp backend/package.json backend/pnpm-lock.yaml "$APP/backend/"
cp -R backend/migrations "$APP/backend/migrations"
(cd "$APP/backend" && pnpm install --prod --frozen-lockfile --ignore-workspace)
cp -R frontend/out "$APP/backend/public"
