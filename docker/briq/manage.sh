#!/usr/bin/env bash
# Runtime configuration (including secrets) never enters the build context.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd -- "$script_dir/../.." && pwd)"
export KARAKEEP_RUNTIME_DIR="${KARAKEEP_RUNTIME_DIR:-$(dirname -- "$source_dir")/karakeep-runtime}"

if [[ ! -f "$KARAKEEP_RUNTIME_DIR/.env" ]]; then
  printf 'Missing runtime configuration: %s/.env\n' "$KARAKEEP_RUNTIME_DIR" >&2
  exit 1
fi

compose=(docker compose --env-file "$KARAKEEP_RUNTIME_DIR/.env")
if [[ -f "$KARAKEEP_RUNTIME_DIR/image.env" ]]; then
  compose+=(--env-file "$KARAKEEP_RUNTIME_DIR/image.env")
fi
compose+=(-f "$script_dir/compose.yaml")

action="${1:-status}"
if (( $# )); then shift; fi

case "$action" in
  config)
    # Deliberately do not print the expanded configuration: it contains secrets.
    "${compose[@]}" config --quiet
    ;;
  build)
    export KARAKEEP_SOURCE_REVISION
    KARAKEEP_SOURCE_REVISION="$(git -C "$source_dir" rev-parse HEAD)"
    # The timestamp identifies this build even when local edits are uncommitted.
    export KARAKEEP_IMAGE_TAG="${KARAKEEP_SOURCE_REVISION:0:12}-local-$(date -u +%Y%m%dT%H%M%S%NZ)"
    # Record the image selection separately from secrets, and only promote it
    # to image.env after a successful build.
    build_env="$(mktemp "$KARAKEEP_RUNTIME_DIR/.build-image.XXXXXX")"
    trap 'rm -f -- "$build_env"' EXIT
    printf 'KARAKEEP_IMAGE_TAG=%s\nKARAKEEP_SOURCE_REVISION=%s\n' \
      "$KARAKEEP_IMAGE_TAG" "$KARAKEEP_SOURCE_REVISION" > "$build_env"
    docker compose --env-file "$KARAKEEP_RUNTIME_DIR/.env" \
      --env-file "$build_env" -f "$script_dir/compose.yaml" build app "$@"
    mv -- "$build_env" "$KARAKEEP_RUNTIME_DIR/image.env"
    printf 'Built karakeep-local:%s\n' "$KARAKEEP_IMAGE_TAG"
    ;;
  up)
    if [[ ! -f "$KARAKEEP_RUNTIME_DIR/image.env" ]]; then
      printf 'Build the fork image first: %s build\n' "$0" >&2
      exit 1
    fi
    "${compose[@]}" up -d --no-build "$@"
    ;;
  status)
    "${compose[@]}" ps "$@"
    ;;
  stats)
    docker stats karakeep-app karakeep-chrome karakeep-search "$@"
    ;;
  processes)
    for container in karakeep-app karakeep-chrome karakeep-search; do
      printf '\n%s\n' "$container"
      docker top "$container" -eo pid,ppid,comm,args
    done
    ;;
  logs)
    "${compose[@]}" logs --tail 100 "$@"
    ;;
  stop)
    "${compose[@]}" stop "$@"
    ;;
  *)
    printf 'Usage: %s {config|build|up|status|stats|processes|logs|stop}\n' "$0" >&2
    exit 2
    ;;
esac
