#!/bin/bash
# Build a redistributable ken binary + native sqlite-vec dylib.
# Output: dist/ken-<platform>.tar.gz with `ken` + `vec0.<ext>` inside.
#
# Phase 1: macOS only. Cross-platform matrix-build is Phase 2.

set -e

# Detect host platform. Override with TARGET=... to cross-compile.
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"

case "$HOST_OS-$HOST_ARCH" in
  darwin-x86_64) TARGET="${TARGET:-bun-darwin-x64}";       DYLIB_PKG="sqlite-vec-darwin-x64";    DYLIB_EXT="dylib"; PLATFORM_TAG="darwin-x64" ;;
  darwin-arm64)  TARGET="${TARGET:-bun-darwin-arm64}";     DYLIB_PKG="sqlite-vec-darwin-arm64";  DYLIB_EXT="dylib"; PLATFORM_TAG="darwin-arm64" ;;
  linux-x86_64)  TARGET="${TARGET:-bun-linux-x64}";        DYLIB_PKG="sqlite-vec-linux-x64";     DYLIB_EXT="so";    PLATFORM_TAG="linux-x64" ;;
  linux-aarch64) TARGET="${TARGET:-bun-linux-arm64}";      DYLIB_PKG="sqlite-vec-linux-arm64";   DYLIB_EXT="so";    PLATFORM_TAG="linux-arm64" ;;
  *) echo "unsupported host: $HOST_OS-$HOST_ARCH"; exit 1 ;;
esac

OUT_DIR="dist/ken-$PLATFORM_TAG"
TAR_PATH="dist/ken-$PLATFORM_TAG.tar.gz"

echo "→ target=$TARGET  dylib=$DYLIB_PKG  out=$OUT_DIR"

rm -rf "$OUT_DIR" "$TAR_PATH"
mkdir -p "$OUT_DIR"

echo "→ compiling..."
bun build src/cli.ts --compile --target="$TARGET" --outfile "$OUT_DIR/ken"

DYLIB_SRC="node_modules/$DYLIB_PKG/vec0.$DYLIB_EXT"
if [ ! -f "$DYLIB_SRC" ]; then
  echo "missing native dylib at $DYLIB_SRC"
  echo "hint: bun install on this platform installs the matching optional dep"
  exit 1
fi
cp "$DYLIB_SRC" "$OUT_DIR/vec0.$DYLIB_EXT"

echo "→ archiving..."
tar -czf "$TAR_PATH" -C dist "ken-$PLATFORM_TAG"

ls -lh "$OUT_DIR/" "$TAR_PATH"
echo "✓ built $TAR_PATH"
