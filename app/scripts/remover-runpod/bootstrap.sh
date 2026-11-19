#!/usr/bin/env bash
# A RunPod worker's setup (endpoint.ts puts this and handler.py in the endpoint's env): the model's Python packages
# and weights, then the handler. ~20 s on a fresh worker, ~5 s on a restart.
set -euo pipefail
t0=$(date +%s)
# Ubuntu 24.04's pip refuses system installs without this; the container is ours alone.
export PIP_BREAK_SYSTEM_PACKAGES=1
# Debian's own cryptography has no RECORD file, so pip can't upgrade it in place (Nov 19: every worker died here).
python3 -m pip install --no-cache-dir -q --ignore-installed cryptography
# As in Edit's own remover venv: 0.33's Wan VAE has no enable_tiling, which minimax_worker.py calls.
python3 -m pip install --no-cache-dir -q \
  runpod diffusers==0.43.0 accelerate==1.16.0 einops==0.8.2 opencv-python-headless huggingface_hub==2.4.0 safetensors
mkdir -p /tmp/remover/repo /tmp/remover/weights
# The model's transformer code, pinned to the commit Edit's installs run.
curl -fsSL https://raw.githubusercontent.com/zibojia/MiniMax-Remover/28e12b450d8a72a7547b86940a4985e6ad90d75b/transformer_minimax_remover.py \
  -o /tmp/remover/repo/transformer_minimax_remover.py
python3 - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download(repo_id="zibojia/minimax-remover", local_dir="/tmp/remover/weights", allow_patterns=["vae/*", "transformer/*", "scheduler/*"])
PY
echo "[bootstrap] ready in $(( $(date +%s) - t0 )) s"
exec python3 -u /tmp/remover/handler.py
