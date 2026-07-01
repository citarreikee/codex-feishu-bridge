#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_ROOT="${CFB_INSTALL_ROOT:-$HOME/.local/share/codex-feishu-bridge}"
APP_DIR="$INSTALL_ROOT/app"
BIN_DIR="${CFB_BIN_DIR:-$HOME/.local/bin}"
WRAPPER_PATH="$BIN_DIR/codex-feishu-bridge"
BRIDGE_HOME="${CFB_HOME:-$HOME/.codex-feishu-bridge}"
CONFIG_PATH="$BRIDGE_HOME/config.env"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

copy_project() {
  mkdir -p "$APP_DIR"
  rsync -a --delete \
    --exclude '.git' \
    --exclude '.DS_Store' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'releases' \
    "$PROJECT_DIR/" "$APP_DIR/"
  chmod 755 "$APP_DIR"/scripts/*.sh
}

install_dependencies() {
  cd "$APP_DIR"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
  npm run build
}

write_wrapper() {
  mkdir -p "$BIN_DIR"
  cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export CFB_HOME="\${CFB_HOME:-$BRIDGE_HOME}"
exec "$APP_DIR/scripts/daemon.sh" "\$@"
EOF
  chmod 755 "$WRAPPER_PATH"
}

ensure_config() {
  mkdir -p "$BRIDGE_HOME/data" "$BRIDGE_HOME/runtime" "$BRIDGE_HOME/logs"
  if [ ! -f "$CONFIG_PATH" ]; then
    cp "$APP_DIR/config.env.example" "$CONFIG_PATH"
    chmod 600 "$CONFIG_PATH"
    echo "Created config template: $CONFIG_PATH"
  fi
}

main() {
  need_cmd node
  need_cmd npm
  need_cmd rsync

  copy_project
  install_dependencies
  write_wrapper
  ensure_config

  echo
  echo "Install complete."
  echo "App dir:    $APP_DIR"
  echo "Command:    $WRAPPER_PATH"
  echo "Config:     $CONFIG_PATH"
  echo
  echo "Next steps:"
  echo "1. Edit $CONFIG_PATH"
  echo "2. Ensure $BIN_DIR is in PATH"
  echo "3. Run: codex-feishu-bridge start"
}

main "$@"
