#!/usr/bin/env bash
set -euo pipefail

action="${1:-ps}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
selfhost_dir="${HULY_SELFHOST_DIR:-$project_root/artifacts/huly/huly-selfhost}"
compose_override="$project_root/infra/huly/compose.digest.arm64.yml"
expected_selfhost_commit="865584594cc582d9e0f7013be66c22f153df1176"
instance_name="${HULY_INSTANCE_NAME:-huly_v7}"
http_port="${HULY_HTTP_PORT:-8087}"

if [[ ! -e "$selfhost_dir/.git" ]]; then
  echo "Huly Selfhost checkout is missing: $selfhost_dir" >&2
  exit 1
fi

actual_commit="$(git -C "$selfhost_dir" rev-parse HEAD)"
if [[ "$actual_commit" != "$expected_selfhost_commit" ]]; then
  echo "Unexpected Selfhost commit: $actual_commit" >&2
  exit 1
fi

compose=(docker compose -f "$selfhost_dir/compose.yml" -f "$compose_override")

case "$action" in
  up)
    command -v envsubst >/dev/null || {
      echo "envsubst is required (Homebrew: brew install gettext)" >&2
      exit 1
    }
    docker info >/dev/null
    umask 077
    for secret_file in .huly.secret .cr.secret .rp.secret; do
      if [[ ! -s "$selfhost_dir/$secret_file" ]]; then
        openssl rand -hex 32 > "$selfhost_dir/$secret_file"
      fi
    done

    export HOST_ADDRESS="localhost:$http_port"
    export SECURE=""
    export HTTP_PORT="$http_port"
    export HTTP_BIND="127.0.0.1"
    export TITLE="Project-Process-Map-Phase0"
    export DEFAULT_LANGUAGE="zh"
    export LAST_NAME_FIRST="true"
    export CR_DATABASE="defaultdb"
    export CR_USERNAME="selfhost"
    export REDPANDA_ADMIN_USER="superadmin"
    export VOLUME_ELASTIC_PATH=""
    export VOLUME_FILES_PATH=""
    export VOLUME_CR_DATA_PATH=""
    export VOLUME_CR_CERTS_PATH=""
    export VOLUME_REDPANDA_PATH=""
    export HULY_SECRET="$(<"$selfhost_dir/.huly.secret")"
    export COCKROACH_SECRET="$(<"$selfhost_dir/.cr.secret")"
    export REDPANDA_SECRET="$(<"$selfhost_dir/.rp.secret")"
    envsubst < "$selfhost_dir/.template.huly.conf" > "$selfhost_dir/huly_v7.conf"

    set -a
    # shellcheck disable=SC1091
    source "$selfhost_dir/huly_v7.conf"
    set +a
    export DOCKER_NAME="$instance_name"
    export HOST_ADDRESS="localhost:$http_port"
    export HTTP_PORT="$http_port"
    cd "$selfhost_dir"
    "${compose[@]}" up -d
    "${compose[@]}" ps
    ;;
  ps)
    cd "$selfhost_dir"
    set -a
    # shellcheck disable=SC1091
    source "$selfhost_dir/huly_v7.conf"
    set +a
    export DOCKER_NAME="$instance_name"
    export HOST_ADDRESS="localhost:$http_port"
    export HTTP_PORT="$http_port"
    "${compose[@]}" ps
    ;;
  down)
    cd "$selfhost_dir"
    set -a
    # shellcheck disable=SC1091
    source "$selfhost_dir/huly_v7.conf"
    set +a
    export DOCKER_NAME="$instance_name"
    export HOST_ADDRESS="localhost:$http_port"
    export HTTP_PORT="$http_port"
    "${compose[@]}" down
    ;;
  *)
    echo "Usage: $0 {up|ps|down}" >&2
    exit 2
    ;;
esac
