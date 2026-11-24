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
# The finder's OCR on its own: cleaning needs none of it, so a pod whose OCR won't install or load still cleans, and
# pod.py tells the relay it can't find (Nov 24: an OCR failure here stopped the setup, and with it every clean).
# rapidocr + onnxruntime-gpu==1.26.0: latest CUDA 12 build matching runpod/pytorch cu1281 (1.27+ requires CUDA 13 and silently falls back to CPU).
# PP-OCRv5 Mobile ONNX weights fetched once here so parallel scan.py/dense.py workers never race on first run.
export REMOVER_FIND=0
if python3 -m pip install --no-cache-dir -q rapidocr==3.10.0 onnxruntime-gpu==1.26.0 && python3 - <<'PY'
import onnxruntime as ort
ort.set_default_logger_severity(3)
if hasattr(ort, "preload_dlls"):
    ort.preload_dlls()
from rapidocr import RapidOCR, OCRVersion, ModelType
RapidOCR(params={
    "Global.log_level": "error",
    "Det.ocr_version": OCRVersion.PPOCRV5,
    "Det.model_type": ModelType.MOBILE,
    "Rec.ocr_version": OCRVersion.PPOCRV5,
    "Rec.model_type": ModelType.MOBILE,
    "EngineConfig.onnxruntime.use_cuda": False,
})
PY
then
  REMOVER_FIND=1
else
  echo "[bootstrap] the finder's OCR didn't load: this pod cleans only"
fi
echo "[bootstrap] ready in $(( $(date +%s) - t0 )) s"
exec python3 -u /tmp/remover/pod.py
