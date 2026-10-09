#!/usr/bin/env bash
# Build Dev's backend, verified offline workflow bundle and static frontend.
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm --dir backend run build
node desktop/scripts/bundle-workflows.js
# The static client reads /config and /api at runtime. Build with no inherited
# cloud credentials/reporting endpoints and an empty same-origin API base.
(cd frontend && env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  SENTRY_DISABLED=true NEXT_PUBLIC_SENTRY_DISABLED=true NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_API_BASE_URL= NODE_OPTIONS=--max-old-space-size=3072 \
  pnpm run build)
test -f frontend/out/index.html
