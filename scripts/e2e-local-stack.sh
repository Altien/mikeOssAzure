#!/usr/bin/env bash
# Prepare local SQLite-backed E2E env files and run Playwright.
set -euo pipefail

SETUP_ONLY=0
if [ "${1:-}" = "--setup-only" ]; then
    SETUP_ONLY=1
    shift
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

set_kv() {
    local file=$1 key=$2 value=$3
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        awk -v k="$key" -v v="$value" \
            'index($0, k"=") == 1 { print k "=" v; next } { print }' \
            "$file" >"$file.tmp" && mv "$file.tmp" "$file"
    else
        echo "${key}=${value}" >>"$file"
    fi
}

[ -f .env ] || cp .env.example .env
[ -f .env.hosted.bak ] || cp .env .env.hosted.bak
set_kv .env SUPABASE_URL "$API_URL"
set_kv .env SUPABASE_PUBLISHABLE_KEY "$ANON_KEY"
set_kv .env SUPABASE_SECRET_KEY "$SERVICE_KEY"
# The suite fires well over the backend's default 300-requests/15-min general
# cap in one run; once tripped every call 429s and profile/list waits time out.
# Same overrides CI uses — e2e is not testing throttling.
set_kv .env RATE_LIMIT_GENERAL_MAX 100000
set_kv .env RATE_LIMIT_CHAT_MAX 100000
set_kv .env RATE_LIMIT_CHAT_CREATE_MAX 100000
set_kv .env RATE_LIMIT_UPLOAD_MAX 100000
set_kv .env RATE_LIMIT_EXPORT_MAX 100000
set_kv .env RATE_LIMIT_DATA_DELETE_MAX 100000

touch "$FRONTEND/.env.local"
[ -f "$FRONTEND/.env.local.hosted.bak" ] || cp "$FRONTEND/.env.local" "$FRONTEND/.env.local.hosted.bak"
set_kv "$FRONTEND/.env.local" API_BASE_URL "http://localhost:3001"

echo "Local SQLite E2E env ready."
if [ "$SETUP_ONLY" = "1" ]; then
    exit 0
fi

cd "$ROOT"
npx playwright test "$@"
