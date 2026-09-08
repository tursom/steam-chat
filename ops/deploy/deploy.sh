#!/usr/bin/env bash
# Host-only deployment. No automatic rollback after a new container may have run.
set -Eeuo pipefail
umask 077

image=${1:-}
revision=${2:-}
[[ $# == 2 && $image =~ ^ghcr\.io/tursom/steam-chat@sha256:[[:xdigit:]]{64}$ && $revision =~ ^[[:xdigit:]]{40}$ ]] || {
    echo 'Invalid deployment arguments' >&2; exit 2;
}
root=${DEPLOY_ROOT:-/opt/steam-chat}
[[ $root == /* ]] || { echo 'DEPLOY_ROOT must be absolute' >&2; exit 2; }
cd -- "$root"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Deployment already running' >&2; exit 1; }
base="$root/docker-compose.yml"
[[ -f $base ]] || base="$root/docker-compose.yaml"
[[ -f $base && -d "$root/data" && ! -L "$root/data" ]] || {
    echo 'Existing Compose file and real data directory required' >&2; exit 1;
}
override="$root/compose.deploy.yml"
metadata="$root/deploy-metadata.json"
compose=(docker compose --project-directory "$root" -f "$base")
[[ ! -f $override ]] || compose+=(-f "$override")

# All registry access and immutable identity checks happen while the old service is live.
docker pull "$image"
label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ ${label,,} == ${revision,,} ]] || { echo 'Image revision mismatch' >&2; exit 1; }
image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ $image_id =~ ^sha256:[[:xdigit:]]{64}$ ]] || { echo 'Invalid image identity' >&2; exit 1; }
old_container=$("${compose[@]}" ps -a -q steam-chat)
[[ -n $old_container && $old_container != *$'\n'* ]] || {
    echo 'Exactly one existing steam-chat container required' >&2; exit 1;
}
mkdir -p -- "$root/backups"
chmod 0700 "$root/backups"
backup=$(mktemp -d "$root/backups/deploy-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
[[ ! -f $override ]] || cp -- "$override" "$backup/compose.deploy.yml"
[[ ! -f $metadata ]] || cp -- "$metadata" "$backup/deploy-metadata.json"
printf '%s\n' "$old_container" > "$backup/previous-container.txt"
docker inspect --format '{{.Config.Image}}' "$old_container" > "$backup/previous-image.txt"
docker inspect --format '{{.Image}}' "$old_container" > "$backup/previous-image-id.txt"
# This is the exact base used for the deployment, retained for disaster recovery.
cp -- "$base" "$backup/base-compose.yml"
chmod 0600 "$backup/"*
stopped=0
started=0
installed=0
tmp=''
meta_tmp=''
cleanup() {
    result=$?
    trap - EXIT
    set +e
    [[ -z $tmp ]] || rm -f -- "$tmp"
    [[ -z $meta_tmp ]] || rm -f -- "$meta_tmp"
    if (( result != 0 && stopped && ! started )); then
        if (( installed )); then
            if [[ -f "$backup/compose.deploy.yml" ]]; then
                restore=$(mktemp "$root/.restore-XXXXXXXX")
                cp -- "$backup/compose.deploy.yml" "$restore" && mv -f -- "$restore" "$override"
            else
                rm -f -- "$override"
            fi
        fi
        # Start the existing container, never recreate from a mutable tag.
        docker start "$old_container" >/dev/null || echo 'Old container restart failed; operator action required' >&2
    fi
    if (( result != 0 && started )); then
        echo 'Deployment failed after new-container start was attempted; no rollback performed' >&2
    fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Even a partially failed stop requires a best-effort restart of the existing container.
stopped=1
"${compose[@]}" stop --timeout 60 steam-chat
[[ $(docker inspect --format '{{.State.Running}}' "$old_container") == false ]] || {
    echo 'Old container is still running' >&2; exit 1;
}
tar -czf "$backup/data.tar.gz" -C "$root" data
chmod 0600 "$backup/data.tar.gz"
# Flush the completed backup before allowing schema-changing startup.
sync -f "$backup/data.tar.gz"

tmp=$(mktemp "$root/.compose.deploy-XXXXXXXX")
printf 'services:\n  steam-chat:\n    image: %s\n' "$image" > "$tmp"
installed=1
mv -f -- "$tmp" "$override"
tmp=''
sync -f "$override"
# Set before invoking up: even a failing command may already have run migrations.
started=1
docker compose --project-directory "$root" -f "$base" -f "$override" \
    up -d --no-build --pull never --wait --wait-timeout 180 steam-chat
new_container=$(docker compose --project-directory "$root" -f "$base" -f "$override" ps -q steam-chat)
[[ -n $new_container && $new_container != *$'\n'* ]] || { echo 'Missing new container' >&2; exit 1; }
[[ $(docker inspect --format '{{.State.Health.Status}}' "$new_container") == healthy ]] || {
    echo 'Container is not healthy' >&2; exit 1;
}
[[ $(docker inspect --format '{{.Image}}' "$new_container") == "$image_id" && \
   $(docker inspect --format '{{.Config.Image}}' "$new_container") == "$image" ]] || {
    echo 'Container image identity mismatch' >&2; exit 1;
}
meta_tmp=$(mktemp "$root/.deploy-metadata-XXXXXXXX")
printf '{"image":"%s","revision":"%s","deployed_at":"%s"}\n' \
    "$image" "$revision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$meta_tmp"
mv -f -- "$meta_tmp" "$metadata"
meta_tmp=''
sync -f "$metadata"
echo 'Deployment succeeded'
