#!/usr/bin/env bash
# Dev adaptation of source157: this physical checkout only. No global prune,
# sibling discovery, prefix ownership, Supabase sweep, or orphan-volume guessing.
# up [compose up args]; down [--purge]; gc [--dry-run]; status; -p NAME.
set -euo pipefail
ROOT="$(cd -P -- "$(dirname -- "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.dev.yml"
PROJECT="$(printenv COMPOSE_PROJECT_NAME || true)"
DRY_RUN=0
PURGE=0
need() { command -v "$1" >/dev/null 2>&1 || { printf '%s is required.\n' "$1" >&2; exit 1; }; }
die() { printf '%s\n' "$*" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: scripts/stack.sh up [compose up args] | down [--purge] | gc [--dry-run] | status [-p NAME]'; }
[ "$#" -gt 0 ] || { usage; exit 1; }
CMD=$1; shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|--project) [ "$#" -ge 2 ] || die 'Missing project name.'; PROJECT=$2; shift 2;;
    --project=*) PROJECT="$(printf '%s' "$1" | cut -d= -f2-)"; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --purge) PURGE=1; shift;;
    --deep) die '--deep is not supported: cleanup is restricted to this checkout.';;
    -h|--help) usage; exit 0;;
    --) shift; break;;
    *) break;;
  esac
done
case "$CMD" in up|down|gc|status) ;; *) usage; exit 1;; esac
[ "$PURGE" = 0 ] || [ "$CMD" = down ] || die '--purge is only valid for explicit down.'
if [ "$CMD" != up ] && [ "$#" -ne 0 ]; then die 'Unexpected arguments; refusing ambiguous cleanup scope.'; fi
for argument in "$@"; do
  case "$argument" in -f|--file|--file=*|-p|--project-name|--project-name=*|--project-directory|--project-directory=*|--env-file|--env-file=*) die 'Compose scope overrides are not accepted by stack.sh.';; esac
done
need docker; need jq
[ -f "$COMPOSE_FILE" ] || die 'This checkout has no docker-compose.dev.yml.'
docker info >/dev/null 2>&1 || die 'Docker is not available.'
if [ -z "$PROJECT" ]; then
  PROJECT="$(docker compose -f "$COMPOSE_FILE" config --format json | jq -er '.name | select(type=="string" and length>0)')" || die 'Cannot resolve the exact Compose project.'
fi
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die 'Invalid Compose project name.'
# Canonicalize EXISTING paths. A missing/foreign label is never guessed from a
# project/container/volume name. Git Bash Windows paths are normalized by cygpath.
canonical_path() {
  local value=$1
  if command -v cygpath >/dev/null 2>&1; then value="$(cygpath -u -- "$value")" || return 1; fi
  [ -e "$value" ] || return 1
  if [ -d "$value" ]; then value="$(cd -P -- "$value" && pwd)" || return 1
  else value="$(cd -P -- "$(dirname -- "$value")" && printf '%s/%s' "$(pwd)" "$(basename -- "$value")")" || return 1; fi
  if command -v cygpath >/dev/null 2>&1; then cygpath -m -- "$value" | tr '[:upper:]' '[:lower:]'; else printf '%s\n' "$value"; fi
}
EXPECTED_ROOT="$(canonical_path "$ROOT")" || die 'Cannot canonicalize checkout.'
EXPECTED_FILE="$(canonical_path "$COMPOSE_FILE")" || die 'Cannot canonicalize Compose file.'
WORK="$(mktemp -d)"
cleanup_temp() {
  # Only known files inside our freshly created temp directory; no recursive rm.
  rm -f -- "$WORK/ids" "$WORK/members.jsonl" "$WORK/members.json" "$WORK/one.json" "$WORK/volumes" "$WORK/networks" "$WORK/references"
  rmdir -- "$WORK" 2>/dev/null || true
}
trap cleanup_temp EXIT
verify_container() {
  local id=$1 project directory files
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  docker inspect "$id" >"$WORK/one.json" || return 1
  project="$(jq -r '.[0].Config.Labels["com.docker.compose.project"] // ""' "$WORK/one.json")"
  directory="$(jq -r '.[0].Config.Labels["com.docker.compose.project.working_dir"] // ""' "$WORK/one.json")"
  files="$(jq -r '.[0].Config.Labels["com.docker.compose.project.config_files"] // ""' "$WORK/one.json")"
  [ "$project" = "$PROJECT" ] || return 1
  # Exactly this file; unknown override files make ownership ambiguous.
  [ "$(canonical_path "$directory")" = "$EXPECTED_ROOT" ] || return 1
  [ "$(canonical_path "$files")" = "$EXPECTED_FILE" ] || return 1
}
snapshot() {
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" >"$WORK/ids"
  : >"$WORK/members.jsonl"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    verify_container "$id" || die "Cannot prove this checkout owns container $id; no cleanup performed."
    jq -c '.[0]' "$WORK/one.json" >>"$WORK/members.jsonl"
  done <"$WORK/ids"
  jq -s '.' "$WORK/members.jsonl" >"$WORK/members.json"
  jq -r '[.[].Mounts[]? | select(.Type=="volume") | .Name] | unique[]' "$WORK/members.json" >"$WORK/volumes"
  jq -r '[.[].NetworkSettings.Networks[]?.NetworkID | select(length>0)] | unique[]' "$WORK/members.json" >"$WORK/networks"
}
action() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
remove_containers() {
  local stop=$1 id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    verify_container "$id" || die "Ownership changed for $id; refusing further cleanup."
    if [ "$stop" = 1 ]; then action docker stop "$id"; fi
    # Non-force removal refuses a concurrent start; never delete by project prefix.
    action docker rm "$id" || die "Container $id became active or could not be removed."
  done <"$WORK/ids"
}
remove_empty_networks() {
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    docker network inspect "$id" >"$WORK/one.json" || continue
    jq -e --arg project "$PROJECT" '.[0] | .Labels["com.docker.compose.project"]==$project and ((.Containers // {})|length)==0' "$WORK/one.json" >/dev/null || continue
    action docker network rm "$id" || die "Network $id is now in use or could not be removed."
  done <"$WORK/networks"
}
verify_volume_references() {
  local volume=$1 id
  docker ps -aq --filter "volume=$volume" >"$WORK/references"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    verify_container "$id" || die "Volume $volume is referenced outside this checkout; refusing purge."
  done <"$WORK/references"
  docker volume inspect "$volume" >"$WORK/one.json" || die "Cannot inspect volume $volume."
  jq -e --arg project "$PROJECT" '.[0].Labels["com.docker.compose.project"]==$project' "$WORK/one.json" >/dev/null || die "Volume $volume has no verified project label; refusing purge."
}
snapshot
case "$CMD" in
  status) jq -r '.[] | [.Id[0:12],.Name,.State.Status] | @tsv' "$WORK/members.json";;
  gc|up)
    # Named volumes survive automatic gc; orphan/unknown volumes and images are
    # deliberately outside this checkout-proven container cleanup operation.
    if jq -e 'length>0 and all(.[]; .State.Status=="exited" or .State.Status=="dead" or .State.Status=="created")' "$WORK/members.json" >/dev/null; then
      remove_containers 0; remove_empty_networks
    fi
    if [ "$CMD" = up ]; then
      # Existing project volumes without any verified container provenance may
      # belong to another checkout using the same project name. Do not adopt them.
      docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | while IFS= read -r volume; do
        grep -Fxq -- "$volume" "$WORK/volumes" || die "Cannot prove ownership of orphan volume $volume; repair this checkout explicitly before up."
      done
      # Source a465c4b1: attach the source release without broadening checkout-owned cleanup.
      if [ -z "${GIT_SHA:-}" ] && command -v git >/dev/null 2>&1; then
        GIT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"; export GIT_SHA
      fi
      if [ "$DRY_RUN" = 1 ]; then action docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up "$@"
      else docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up "$@"; fi
    fi;;
  down)
    if [ "$PURGE" = 1 ]; then
      while IFS= read -r volume; do [ -z "$volume" ] || verify_volume_references "$volume"; done <"$WORK/volumes"
    fi
    remove_containers 1; remove_empty_networks
    if [ "$PURGE" = 1 ]; then
      while IFS= read -r volume; do
        [ -n "$volume" ] || continue
        # IDs come only from mounts of the verified checkout snapshot. Recheck
        # all remaining references; Docker's non-force rm closes the final race.
        verify_volume_references "$volume"
        if [ "$DRY_RUN" != 1 ] && [ -s "$WORK/references" ]; then die "Volume $volume is still referenced; retained."; fi
        action docker volume rm "$volume" || die "Volume $volume is in use or could not be removed."
      done <"$WORK/volumes"
    fi;;
esac
