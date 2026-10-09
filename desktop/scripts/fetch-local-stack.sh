#!/usr/bin/env bash
# Fetch the native service binaries the self-contained local stack runs:
#   Postgres 17 (zonky embedded-postgres build, via npm — same artifact the
#   packaged app bundles), and PostgREST — all pinned
#   to the versions docker-compose.yml pins, all official upstream builds,
#   all darwin/arm64.
#
# Output layout (gitignored; packaged as extraResources by electron-builder):
#   local-stack/bin/pg/{bin,lib,share}   postgres, initdb, pg_ctl, psql, ...
#   local-stack/bin/postgrest
set -euo pipefail
cd "$(dirname "$0")/.."

# MIKE_LOCAL_FETCH_ONLY=postgres fetches just the Postgres build. That is all
# `npm test` needs (src/local/upgrade.test.js boots a throwaway cluster from
# it), and it spares CI's unit job the Go toolchain needed only by the packaged app.
ONLY="${MIKE_LOCAL_FETCH_ONLY:-}"

# Pins. PG tracks supabase/postgres:17.x from docker-compose.yml (zonky has no
# 17.6 darwin build; any 17.x is wire- and dump-compatible). The other two
# match the compose image tags exactly.
PG_NPM_VERSION="17.10.0-beta.17"
POSTGREST_VERSION="v14.12"

DEST="local-stack/bin"
mkdir -p "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Postgres $PG_NPM_VERSION (@embedded-postgres/darwin-arm64)"
if [ ! -x "$DEST/pg/bin/postgres" ]; then
  npm pack "@embedded-postgres/darwin-arm64@$PG_NPM_VERSION" --pack-destination "$WORK" >/dev/null
  tar -xzf "$WORK"/embedded-postgres-darwin-arm64-*.tgz -C "$WORK"
  rm -rf "$DEST/pg"
  mv "$WORK/package/native" "$DEST/pg"
  chmod +x "$DEST"/pg/bin/*
  # npm tarballs cannot carry symlinks, so the package ships a manifest of the
  # dylib version-name links (libzstd.1.dylib -> libzstd.1.5.7.dylib, ...) and
  # hydrates them post-install. Replicate that here or postgres won't load.
  python3 - "$DEST/pg" <<'PY'
import json, os, sys
root = sys.argv[1]
with open(os.path.join(root, "pg-symlinks.json")) as f:
    for link in json.load(f):
        src = link["source"].removeprefix("native/")
        dst = os.path.join(root, link["target"].removeprefix("native/"))
        rel = os.path.relpath(os.path.join(root, src), os.path.dirname(dst))
        if not os.path.lexists(dst):
            os.symlink(rel, dst)
PY
  # The extensions the schema needs must be in the build — fail loudly here,
  # not at first-run initdb on a user's machine.
  test -f "$DEST/pg/share/postgresql/extension/pgcrypto.control"
  test -f "$DEST/pg/share/postgresql/extension/pg_trgm.control"
else
  echo "    already present, skipping"
fi

if [ "$ONLY" = "postgres" ]; then
  echo "==> Done (MIKE_LOCAL_FETCH_ONLY=postgres):"
  "$DEST/pg/bin/postgres" --version
  exit 0
fi

echo "==> PostgREST $POSTGREST_VERSION"
if [ ! -x "$DEST/postgrest" ]; then
  curl -fsSL -o "$WORK/postgrest.tar.xz" \
    "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-macos-aarch64.tar.xz"
  tar -xJf "$WORK/postgrest.tar.xz" -C "$WORK"
  mv "$WORK/postgrest" "$DEST/postgrest"
  chmod +x "$DEST/postgrest"
else
  echo "    already present, skipping"
fi

# Notices are independent of the binary cache, so older cached installations
# acquire them too. All files come from the exact pinned upstream versions.
node scripts/fetch-service-notices.mjs "$DEST/notices" \
  "$PG_NPM_VERSION" "$POSTGREST_VERSION"

echo "==> Done:"
"$DEST/pg/bin/postgres" --version
"$DEST/postgrest" --version | head -1
