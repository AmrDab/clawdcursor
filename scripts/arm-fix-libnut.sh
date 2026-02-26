#!/usr/bin/env bash
set -euo pipefail

ARCH="$(uname -m)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/node_modules/@nut-tree-fork/libnut-linux/build/Release/libnut.node"

# Optional override: export LIBNUT_NODE_PATH=/abs/path/to/libnut.node
CANDIDATES=(
  "${LIBNUT_NODE_PATH:-}"
  "$ROOT_DIR/libnut-core/build/Release/libnut.node"
  "$ROOT_DIR/../libnut-core/build/Release/libnut.node"
)

SRC=""
for candidate in "${CANDIDATES[@]}"; do
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    SRC="$candidate"
    break
  fi
done

if [[ -z "$SRC" ]]; then
  echo "[arm-fix-libnut] ARM detected but no prebuilt libnut.node found." >&2
  echo "[arm-fix-libnut] Checked: ROOT/libnut-core and ../libnut-core (or LIBNUT_NODE_PATH). Skipping patch." >&2
  exit 0
fi

mkdir -p "$(dirname "$TARGET")"
cp "$SRC" "$TARGET"

if command -v file >/dev/null 2>&1; then
  file "$TARGET" | grep -Eq 'aarch64|ARM aarch64' || {
    echo "[arm-fix-libnut] copied file does not look like ARM64 binary: $TARGET" >&2
    exit 1
  }
fi

echo "[arm-fix-libnut] OK (ARM) -> $TARGET (source: $SRC)"
