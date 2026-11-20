#!/usr/bin/env bash
# A rented RunPod pod's setup (kit.ts puts this and pod.py in apps/relay/src/remover_kit.ts; the relay hands both to
# each pod it rents): the model's Python packages and weights, then pod.py. ~20 s once the image is on the machine.
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
exec python3 -u /tmp/remover/pod.py
