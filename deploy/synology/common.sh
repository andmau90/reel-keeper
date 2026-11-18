#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
ENV_FILE=${REELKEEPER_ENV_FILE:-/volume1/appdata/reelkeeper/reelkeeper.env}

if [ ! -r "$ENV_FILE" ]; then
  echo "ReelKeeper environment file is not readable: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

: "${REELKEEPER_DATA_DIR:?Set REELKEEPER_DATA_DIR in the environment file}"
: "${MOVIE_LIBRARY_ROOT:?Set MOVIE_LIBRARY_ROOT in the environment file}"

REELKEEPER_INSTALL_DIR=${REELKEEPER_INSTALL_DIR:-$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)}
NODE_BIN=${NODE_BIN:-node}
PID_FILE="$REELKEEPER_DATA_DIR/reelkeeper.pid"
LOG_DIR="$REELKEEPER_DATA_DIR/logs"

export REELKEEPER_DATA_DIR MOVIE_LIBRARY_ROOT
export REELKEEPER_HOST REELKEEPER_PORT
export WATCHER_POLL_INTERVAL_SECONDS WATCHER_STABILITY_SECONDS
export TMDB_ACCESS_TOKEN
