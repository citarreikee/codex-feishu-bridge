#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${CFB_INSTALL_ROOT:-$HOME/.local/share/codex-feishu-bridge}"
APP_DIR="$INSTALL_ROOT/app"
BIN_DIR="${CFB_BIN_DIR:-$HOME/.local/bin}"
WRAPPER_PATH="$BIN_DIR/codex-feishu-bridge"
BRIDGE_HOME="${CFB_HOME:-$HOME/.codex-feishu-bridge}"
PURGE_STATE=false

for arg in "$@"; do
  case "$arg" in
    --purge-state)
      PURGE_STATE=true
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ -x "$WRAPPER_PATH" ]; then
  "$WRAPPER_PATH" stop >/dev/null 2>&1 || true
fi

rm -f "$HOME/Library/LaunchAgents/com.codex-feishu-bridge.plist"
rm -f "$WRAPPER_PATH"
rm -rf "$APP_DIR"

if [ -d "$INSTALL_ROOT" ] && [ -z "$(ls -A "$INSTALL_ROOT" 2>/dev/null)" ]; then
  rmdir "$INSTALL_ROOT" || true
fi

if [ "$PURGE_STATE" = true ]; then
  rm -rf "$BRIDGE_HOME"
fi

echo "Removed installed bridge files."
if [ "$PURGE_STATE" = true ]; then
  echo "Removed runtime state: $BRIDGE_HOME"
else
  echo "Preserved runtime state: $BRIDGE_HOME"
fi
