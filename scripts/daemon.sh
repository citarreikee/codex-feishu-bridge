#!/usr/bin/env bash
set -euo pipefail

BRIDGE_HOME="${CFB_HOME:-$HOME/.codex-feishu-bridge}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$BRIDGE_HOME/runtime"
LOG_DIR="$BRIDGE_HOME/logs"
PID_FILE="$RUNTIME_DIR/bridge.pid"
LOG_FILE="$LOG_DIR/bridge.log"
LAUNCHD_LABEL="com.codex-feishu-bridge"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"

ensure_dirs() {
  mkdir -p "$BRIDGE_HOME"/data "$RUNTIME_DIR" "$LOG_DIR"
}

ensure_built() {
  if [ ! -f "$PROJECT_DIR/dist/daemon.mjs" ]; then
    (cd "$PROJECT_DIR" && npm run build)
    return
  fi

  local newest_src
  newest_src=$(find "$PROJECT_DIR/src" "$PROJECT_DIR/scripts" -type f \( -name '*.ts' -o -name '*.js' \) -newer "$PROJECT_DIR/dist/daemon.mjs" | head -1 || true)
  if [ -n "$newest_src" ]; then
    (cd "$PROJECT_DIR" && npm run build)
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true
}

is_running() {
  local pid
  pid=$(read_pid)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

write_launchd_plist() {
  local node_bin
  local codex_bin
  local codex_env_xml
  local launchd_path
  node_bin="$(command -v node)"
  codex_bin="$(command -v codex || true)"
  codex_env_xml=""
  if [ -n "$codex_bin" ]; then
    codex_env_xml="      <key>CFB_CODEX_EXECUTABLE</key>
      <string>$codex_bin</string>"
  fi
  launchd_path="$(dirname "$node_bin"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LAUNCHD_LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$node_bin</string>
      <string>$PROJECT_DIR/dist/daemon.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CFB_HOME</key>
      <string>$BRIDGE_HOME</string>
$codex_env_xml
      <key>PATH</key>
      <string>$launchd_path</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_FILE</string>
    <key>StandardErrorPath</key>
    <string>$LOG_FILE</string>
  </dict>
</plist>
EOF
}

launchd_print_pid() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | awk '/pid = / { print $3; exit }'
}

launchd_is_loaded() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1
}

case "${1:-help}" in
  start)
    ensure_dirs
    ensure_built
    if [ "$(uname -s)" = "Darwin" ]; then
      write_launchd_plist
      if launchd_is_loaded; then
        launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
      fi
      launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST"
      launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
      sleep 2
      local_pid="$(launchd_print_pid)"
      if [ -n "$local_pid" ]; then
        echo "$local_pid" > "$PID_FILE"
        echo "Bridge started (PID: $local_pid, launchd: $LAUNCHD_LABEL)"
      else
        echo "Bridge failed to start via launchd"
        tail -50 "$LOG_FILE" 2>/dev/null || true
        exit 1
      fi
      exit 0
    fi

    if is_running; then
      echo "Bridge already running (PID: $(read_pid))"
      exit 1
    fi
    echo "Starting bridge..."
    nohup node "$PROJECT_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    sleep 1
    if is_running; then
      echo "Bridge started (PID: $(read_pid))"
    else
      echo "Bridge failed to start"
      tail -50 "$LOG_FILE" 2>/dev/null || true
      exit 1
    fi
    ;;
  stop)
    if [ "$(uname -s)" = "Darwin" ]; then
      if launchd_is_loaded; then
        launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL"
        echo "Bridge stopped"
      else
        echo "Bridge is not running"
      fi
      rm -f "$PID_FILE"
      exit 0
    fi

    if ! is_running; then
      echo "Bridge is not running"
      rm -f "$PID_FILE"
      exit 0
    fi
    kill "$(read_pid)"
    sleep 1
    if is_running; then
      kill -9 "$(read_pid)" || true
    fi
    rm -f "$PID_FILE"
    echo "Bridge stopped"
    ;;
  status)
    if [ "$(uname -s)" = "Darwin" ]; then
      if launchd_is_loaded; then
        local_pid="$(launchd_print_pid)"
        if [ -n "$local_pid" ]; then
          echo "$local_pid" > "$PID_FILE"
          echo "Bridge running (PID: $local_pid, launchd: $LAUNCHD_LABEL)"
        else
          echo "Bridge registered with launchd but no active PID"
        fi
      else
        echo "Bridge not running"
        rm -f "$PID_FILE"
      fi
      exit 0
    fi

    if is_running; then
      echo "Bridge running (PID: $(read_pid))"
    else
      echo "Bridge not running"
      rm -f "$PID_FILE"
    fi
    ;;
  logs)
    tail -n "${2:-80}" "$LOG_FILE" 2>/dev/null || true
    ;;
  *)
    echo "Usage: scripts/daemon.sh {start|stop|status|logs [N]}"
    ;;
esac
