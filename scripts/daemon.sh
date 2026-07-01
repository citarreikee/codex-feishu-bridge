#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BRIDGE_HOME="${CFB_HOME:-$HOME/.codex-feishu-bridge}"
RUNTIME_DIR="$BRIDGE_HOME/runtime"
LOG_DIR="$BRIDGE_HOME/logs"
PID_FILE="$RUNTIME_DIR/bridge.pid"
LOG_FILE="$LOG_DIR/bridge.log"
ERR_FILE="$LOG_DIR/bridge.err.log"
ENTRY_POINT="$REPO_ROOT/dist/daemon.mjs"

ensure_dirs() {
  mkdir -p "$BRIDGE_HOME/data" "$RUNTIME_DIR" "$LOG_DIR"
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' < "$PID_FILE"
  fi
}

get_bridge_pid() {
  local pid
  pid="$(read_pid || true)"
  if [[ -z "${pid:-}" ]]; then
    return 1
  fi

  if kill -0 "$pid" >/dev/null 2>&1; then
    printf '%s\n' "$pid"
    return 0
  fi

  rm -f "$PID_FILE"
  return 1
}

ensure_built() {
  if [[ ! -f "$ENTRY_POINT" ]]; then
    (cd "$REPO_ROOT" && npm run build)
  fi
}

start_bridge() {
  ensure_dirs
  ensure_built

  if pid="$(get_bridge_pid)"; then
    echo "Bridge already running (PID: $pid)"
    return 0
  fi

  (
    cd "$REPO_ROOT"
    nohup node "$ENTRY_POINT" >>"$LOG_FILE" 2>>"$ERR_FILE" &
    echo $! > "$PID_FILE"
  )

  sleep 1

  if pid="$(get_bridge_pid)"; then
    echo "Bridge started (PID: $pid)"
    return 0
  fi

  echo "Bridge failed to start"
  show_logs 50
  return 1
}

stop_bridge() {
  if ! pid="$(get_bridge_pid)"; then
    echo "Bridge is not running"
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
  echo "Bridge stopped"
}

show_status() {
  if pid="$(get_bridge_pid)"; then
    echo "Bridge running (PID: $pid)"
  else
    echo "Bridge not running"
  fi
}

show_logs() {
  local lines="${1:-80}"
  if [[ -f "$LOG_FILE" ]]; then
    echo "== stdout =="
    tail -n "$lines" "$LOG_FILE"
  fi
  if [[ -f "$ERR_FILE" ]]; then
    echo "== stderr =="
    tail -n "$lines" "$ERR_FILE"
  fi
}

command="${1:-help}"
case "$command" in
  start)
    start_bridge
    ;;
  stop)
    stop_bridge
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs "${2:-80}"
    ;;
  *)
    echo "Usage: codex-feishu-bridge {start|stop|status|logs [N]}"
    ;;
esac
