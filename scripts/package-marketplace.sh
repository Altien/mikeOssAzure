#!/usr/bin/env bash
# Build the Mike Azure Marketplace deployment package.
#
# Compiles infra/main.bicep into marketplace/mainTemplate.json, validates the
# UI definition and view definition, and zips the three files into a flat
# archive ready to upload to Partner Center.
#
# Partner Center rejects archives with nested folders, so the zip contains
# only the three top-level files — no `marketplace/` prefix.
#
# Usage:
#   scripts/package-marketplace.sh
#   scripts/package-marketplace.sh --version v1.2.0
#   scripts/package-marketplace.sh --out dist/
#   scripts/package-marketplace.sh --version v1.2.0 --out dist/

set -euo pipefail

VERSION=""
OUT_DIR="dist"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --out)     OUT_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Resolve paths relative to repo root ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MARKETPLACE_DIR="$REPO_ROOT/marketplace"
BICEP_SOURCE="$REPO_ROOT/infra/main.bicep"
MAIN_TEMPLATE="$MARKETPLACE_DIR/mainTemplate.json"
UI_DEFINITION="$MARKETPLACE_DIR/createUiDefinition.json"
VIEW_DEFINITION="$MARKETPLACE_DIR/viewDefinition.json"

# ── Pre-flight ───────────────────────────────────────────────────────────────
command -v az     >/dev/null 2>&1 || { echo "az CLI not found on PATH" >&2; exit 1; }
command -v python >/dev/null 2>&1 || { echo "python not found on PATH" >&2; exit 1; }

[ -f "$BICEP_SOURCE" ]   || { echo "Missing $BICEP_SOURCE"   >&2; exit 1; }
[ -f "$UI_DEFINITION" ]  || { echo "Missing $UI_DEFINITION"  >&2; exit 1; }
[ -f "$VIEW_DEFINITION" ] || { echo "Missing $VIEW_DEFINITION" >&2; exit 1; }

if [ -z "$VERSION" ]; then
  if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
    VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  else
    VERSION="$(date -u +%Y%m%d%H%M%S)"
  fi
fi

echo "Version : $VERSION"
echo "Output  : $OUT_DIR/mike-marketplace-${VERSION}.zip"
echo

# ── Compile bicep → mainTemplate.json ────────────────────────────────────────
echo "[1/3] Compiling $BICEP_SOURCE -> mainTemplate.json"
az bicep build --file "$BICEP_SOURCE" --outfile "$MAIN_TEMPLATE"

# ── Validate JSON files parse ────────────────────────────────────────────────
echo "[2/3] Validating JSON"
for f in "$MAIN_TEMPLATE" "$UI_DEFINITION" "$VIEW_DEFINITION"; do
  python -c "import json,sys; json.load(open(sys.argv[1]))" "$f" \
    || { echo "Invalid JSON: $f" >&2; exit 1; }
done

# ── Package ──────────────────────────────────────────────────────────────────
ABS_OUT_DIR="$REPO_ROOT/$OUT_DIR"
mkdir -p "$ABS_OUT_DIR"
ZIP_PATH="$ABS_OUT_DIR/mike-marketplace-${VERSION}.zip"
rm -f "$ZIP_PATH"

echo "[3/3] Building $ZIP_PATH"
# Build the archive in Python so the script works on any host without needing
# the `zip` binary (Git for Windows omits it). Paths inside the archive are
# flat — Partner Center rejects archives with nested folders.
python - "$ZIP_PATH" "$MARKETPLACE_DIR" <<'PY'
import sys, zipfile, os
zip_path, src = sys.argv[1], sys.argv[2]
files = ["mainTemplate.json", "createUiDefinition.json", "viewDefinition.json"]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for f in files:
        zf.write(os.path.join(src, f), arcname=f)
with zipfile.ZipFile(zip_path) as zf:
    for info in zf.infolist():
        print(f"  {info.file_size:>10}  {info.filename}")
PY

echo
echo "Built $ZIP_PATH"
