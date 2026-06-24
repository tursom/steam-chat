#!/bin/sh
set -eu

data_dir="${STEAM_CHAT_DATA_DIR:-/app/data}"

mkdir -p "$data_dir"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$data_dir"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
