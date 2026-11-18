#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

SERVER_ENTRY="$REELKEEPER_INSTALL_DIR/apps/server/dist/server.js"

start() {
  mkdir -p "$REELKEEPER_DATA_DIR" "$LOG_DIR"

  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    case "$pid" in
      ''|*[!0-9]*|0|1)
        rm -f "$PID_FILE"
        ;;
      *)
        if kill -0 "$pid" 2>/dev/null; then
          echo "ReelKeeper is already running (PID $pid)."
          return 0
        fi
        rm -f "$PID_FILE"
        ;;
    esac
  fi

  if [ ! -f "$SERVER_ENTRY" ]; then
    echo "Built server entry point not found: $SERVER_ENTRY" >&2
    return 1
  fi
  if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "Node.js executable not found: $NODE_BIN" >&2
    return 1
  fi

  umask 077
  log_file="$LOG_DIR/reelkeeper-$(date -u +%Y%m%d).log"
  cd "$REELKEEPER_INSTALL_DIR"
  nohup "$NODE_BIN" "$SERVER_ENTRY" >>"$log_file" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  sleep 2

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "ReelKeeper exited during startup. Check $log_file" >&2
    return 1
  fi
  echo "ReelKeeper started (PID $pid); log: $log_file"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "ReelKeeper is not running (no PID file)."
    return 0
  fi

  pid=$(cat "$PID_FILE")
  case "$pid" in
    ''|*[!0-9]*|0|1)
      rm -f "$PID_FILE"
      echo "Removed invalid ReelKeeper PID file."
      return 0
      ;;
  esac

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Removed stale ReelKeeper PID file."
    return 0
  fi

  if ! kill -TERM "$pid" 2>/dev/null; then
    if kill -0 "$pid" 2>/dev/null; then
      echo "Could not signal ReelKeeper process $pid." >&2
      return 1
    fi
    rm -f "$PID_FILE"
    echo "ReelKeeper stopped."
    return 0
  fi
  attempt=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 30 ]; do
    sleep 1
    attempt=$((attempt + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "ReelKeeper did not stop within 30 seconds; PID file retained." >&2
    return 1
  fi
  rm -f "$PID_FILE"
  echo "ReelKeeper stopped."
}

status() {
  if [ ! -f "$PID_FILE" ]; then
    echo "ReelKeeper is not running."
    return 1
  fi
  pid=$(cat "$PID_FILE")
  case "$pid" in
    ''|*[!0-9]*)
      echo "ReelKeeper has an invalid PID file." >&2
      return 1
      ;;
  esac
  if kill -0 "$pid" 2>/dev/null; then
    echo "ReelKeeper is running (PID $pid)."
    return 0
  fi
  echo "ReelKeeper is not running (stale PID file)." >&2
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) status ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
