#!/bin/sh
# Builds Firecrawl Local for the packaged Edit: the program Edit reads web
# pages and PDFs with (apps/server/src/web_page.ts). Firecrawl publishes it
# only as a crate, so it's compiled here (about 7 minutes cold; the release
# keeps the result between runs). It's AGPL-3.0, so it ships unmodified as
# its own program, `edit-firecrawl`, with licenses/firecrawl-local.txt
# beside it, and Edit only ever runs it, never links it in.
#
#   scripts/fetch-firecrawl.sh aarch64-apple-darwin <out-dir>
#   scripts/fetch-firecrawl.sh x86_64-unknown-linux-gnu <out-dir>
#
# The build lands as <out-dir>/edit-firecrawl.
# Bumping the version: change VERSION here and in licenses/firecrawl-local.txt.

set -eu

TARGET="$1"
OUT="$2"
VERSION="0.1.1"

case "$TARGET" in
  aarch64-apple-darwin | x86_64-unknown-linux-gnu) ;;
  *)
    echo "no Firecrawl Local build for $TARGET" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT"
# Already there (same version): nothing to do.
if [ -x "$OUT/edit-firecrawl" ] && [ "$(cat "$OUT/.firecrawl-version" 2>/dev/null)" = "$TARGET $VERSION" ]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Building Firecrawl Local $VERSION for $TARGET"
# --locked: the crate's own Cargo.lock, so the build is the one its version was tested with.
CARGO_TARGET_DIR="$TMP/target" cargo install firecrawl-local --version "=$VERSION" --locked --target "$TARGET" --root "$TMP/root" --quiet
if [ "$(uname -s)" = Darwin ] && otool -L "$TMP/root/bin/firecrawl-local" | tail -n +2 | grep -vE '^[[:space:]]*(/usr/lib/|/System/Library/)'; then
  echo "Firecrawl Local needs libraries outside macOS, so it can't be bundled." >&2
  exit 1
fi
install -m 755 "$TMP/root/bin/firecrawl-local" "$OUT/edit-firecrawl"
echo "$TARGET $VERSION" >"$OUT/.firecrawl-version"
"$OUT/edit-firecrawl" --version
echo "Firecrawl Local $VERSION for $TARGET in $OUT"
