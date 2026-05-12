#!/usr/bin/env bash
# Push the Mike images to the public publisher ACR for a marketplace release.
#
# Builds the backend container in the registry (server-side, no Docker
# required) and mirrors the pinned PostgREST tag from Docker Hub. Run this
# before scripts/package-marketplace.sh so the image tags referenced by
# createUiDefinition.json actually exist when a customer deploys.
#
# Usage:
#   scripts/release-images.sh --version v1.2.0
#   scripts/release-images.sh --version v1.2.0 --registry acrmikeoss
#   scripts/release-images.sh --version v1.2.0 --postgrest-version v12.2.3
#   scripts/release-images.sh --version v1.2.0 --skip-postgrest

set -euo pipefail

VERSION=""
REGISTRY="acrmikeoss"
POSTGREST_VERSION="v12.2.3"
SKIP_BACKEND=0
SKIP_POSTGREST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version)            VERSION="$2"; shift 2 ;;
    --registry)           REGISTRY="$2"; shift 2 ;;
    --postgrest-version)  POSTGREST_VERSION="$2"; shift 2 ;;
    --skip-backend)       SKIP_BACKEND=1; shift ;;
    --skip-postgrest)     SKIP_POSTGREST=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "--version is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# The Dockerfile lives at the repo root and COPYs from both backend/ and
# frontend/ in a multi-stage build, so the build context is the repo root.
BUILD_CTX="$REPO_ROOT"
DOCKERFILE="$REPO_ROOT/Dockerfile"

command -v az >/dev/null 2>&1 || { echo "az CLI not found on PATH" >&2; exit 1; }

echo "Registry      : $REGISTRY"
echo "Backend tag   : backend:$VERSION"
echo "PostgREST tag : postgrest:$POSTGREST_VERSION"
echo

# ── Backend ──────────────────────────────────────────────────────────────────
if [ "$SKIP_BACKEND" -eq 0 ]; then
  [ -f "$DOCKERFILE" ] || { echo "Dockerfile not found at $DOCKERFILE" >&2; exit 1; }
  echo "[1/2] Building backend image in $REGISTRY"
  # The image bundles the static-exported frontend served from the same Express
  # process — see Dockerfile. Build context is the repo root so both backend/
  # and frontend/ are visible to the COPY directives.
  az acr build \
    --registry "$REGISTRY" \
    --image "backend:$VERSION" \
    --file "$DOCKERFILE" \
    "$BUILD_CTX"
else
  echo "[1/2] Skipping backend build (--skip-backend)"
fi

# ── PostgREST ────────────────────────────────────────────────────────────────
if [ "$SKIP_POSTGREST" -eq 0 ]; then
  echo "[2/2] Mirroring postgrest:$POSTGREST_VERSION from Docker Hub"
  # --force makes the import idempotent: re-running with the same tag
  # overwrites rather than failing on "image already exists".
  az acr import \
    --name "$REGISTRY" \
    --source "docker.io/postgrest/postgrest:$POSTGREST_VERSION" \
    --image "postgrest:$POSTGREST_VERSION" \
    --force
else
  echo "[2/2] Skipping postgrest mirror (--skip-postgrest)"
fi

echo
echo "Pushed:"
echo "  ${REGISTRY}.azurecr.io/backend:$VERSION"
echo "  ${REGISTRY}.azurecr.io/postgrest:$POSTGREST_VERSION"
echo
echo "Next: scripts/package-marketplace.sh --version $VERSION"
