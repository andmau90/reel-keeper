#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

SERVICE_SCRIPT="$SCRIPT_DIR/reelkeeper-service.sh"
BACKUP_DIR="$REELKEEPER_DATA_DIR/deployment-backups"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$BACKUP_DIR/reelkeeper-$timestamp.tar.gz"
temporary_archive="$BACKUP_DIR/.reelkeeper-$timestamp.tar.gz.tmp"
was_running=0

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if ! rm -f "$temporary_archive"; then
    echo "Could not remove temporary backup: $temporary_archive" >&2
    result=1
  fi
  if [ "$was_running" -eq 1 ]; then
    if ! "$SERVICE_SCRIPT" start; then
      echo "Backup finished, but ReelKeeper could not be restarted." >&2
      result=1
    fi
  fi
  exit "$result"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

mkdir -p "$BACKUP_DIR" "$REELKEEPER_DATA_DIR/backups"
umask 077

if "$SERVICE_SCRIPT" status >/dev/null 2>&1; then
  was_running=1
  "$SERVICE_SCRIPT" stop
fi

tar -czf "$temporary_archive" \
  -C "$REELKEEPER_DATA_DIR" \
  reelkeeper.sqlite backups
mv "$temporary_archive" "$archive"
find "$BACKUP_DIR" -type f -name 'reelkeeper-*.tar.gz' -mtime +14 \
  -exec rm -f {} \;
echo "Created ReelKeeper backup: $archive"
