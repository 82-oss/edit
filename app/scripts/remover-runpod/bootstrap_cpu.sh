#!/usr/bin/env bash
# A rented CPU machine's setup (kit.ts puts this and cpu.js in apps/relay/src/remover_kit.ts; the relay hands both to
# each one it rents, with signed URLs for Edit's engine and FFmpeg on R2): Bun, the engine, then cpu.js.
set -euo pipefail
t0=$(date +%s)
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates unzip >/dev/null
curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v1.4.0" >/dev/null
mkdir -p /opt/edit
# Gzipped on R2 (163 MB, not 412: quicker to every machine).
curl -fsSL "$ADDON_URL" | gunzip > /opt/edit/edit-native.node &
curl -fsSL "$FFMPEG_URL" | gunzip > /opt/edit/edit-ffmpeg &
curl -fsSL "$FFPROBE_URL" | gunzip > /opt/edit/edit-ffprobe &
wait
chmod +x /opt/edit/edit-ffmpeg /opt/edit/edit-ffprobe
echo "[bootstrap] ready in $(( $(date +%s) - t0 )) s"
exec /opt/bun/bin/bun /tmp/remover/cpu.js
