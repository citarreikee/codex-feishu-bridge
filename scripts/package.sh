#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
PACKAGE_NAME="codex-feishu-bridge-$VERSION"
RELEASES_DIR="$PROJECT_DIR/releases"
STAGE_ROOT="$RELEASES_DIR/.stage"
STAGE_DIR="$STAGE_ROOT/$PACKAGE_NAME"

rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_DIR" "$RELEASES_DIR"

rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'releases' \
  "$PROJECT_DIR/" "$STAGE_DIR/"

tar -C "$STAGE_ROOT" -czf "$RELEASES_DIR/$PACKAGE_NAME.tar.gz" "$PACKAGE_NAME"

if command -v ditto >/dev/null 2>&1; then
  ditto -c -k --sequesterRsrc --keepParent "$STAGE_DIR" "$RELEASES_DIR/$PACKAGE_NAME.zip"
else
  (cd "$STAGE_ROOT" && zip -qr "$RELEASES_DIR/$PACKAGE_NAME.zip" "$PACKAGE_NAME")
fi

rm -rf "$STAGE_ROOT"

echo "Created:"
echo "  $RELEASES_DIR/$PACKAGE_NAME.tar.gz"
echo "  $RELEASES_DIR/$PACKAGE_NAME.zip"
