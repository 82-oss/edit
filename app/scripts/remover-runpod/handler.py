"""The RunPod side of Edit's subtitle removal (apps/relay/src/remover.ts starts each job): a stretch is cleaned by
the minimax_worker.py the job brings (the Edit build's own, so the GPU runs exactly that version) and its strip is
written straight to R2 by the presigned URL the relay gave.

A job's input: {worker: the worker's code, input_url, beneath: [{file: URL, from, box}], output_url, from, fps,
width, height, matrix, masks}. Its output: {ok, box, inferred, seconds} or {ok: false, error}.

The model is loaded once, on the first job, and kept on the GPU for every job after (a worker of another version
loads it again).
"""

import hashlib
import importlib.util
import os
import tempfile
import time
import urllib.request

import runpod

MODELS = "/tmp/remover/weights"
REPO = "/tmp/remover/repo"
_loaded = {"hash": None, "module": None, "model": None}


def worker_for(source):
    digest = hashlib.sha256(source.encode()).hexdigest()[:16]
    if _loaded["hash"] != digest:
        path = f"/tmp/remover/minimax_worker_{digest}.py"
        with open(path, "w") as f:
            f.write(source)
        spec = importlib.util.spec_from_file_location(f"minimax_worker_{digest}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if _loaded["model"] is not None:
            del _loaded["model"]
            module_torch = __import__("torch")
            module_torch.cuda.empty_cache()
        # Every RunPod card the endpoint takes has 16 GB or more: the model whole in fp16 (fp8 is for the 8 GB cards at home).
        _loaded.update(hash=digest, module=module, model=module.Model(MODELS, REPO, fp8=False))
    return _loaded["module"], _loaded["model"]


def upload(path, url):
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": "video/mp4", "Content-Length": str(len(data))})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                if resp.status in (200, 201, 204):
                    return
                raise RuntimeError(f"R2 answered {resp.status}")
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def handler(event):
    job = event.get("input", {})
    started = time.time()
    try:
        module, model = worker_for(job["worker"])
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "strip.mp4")
            req = {
                "ffmpeg": "ffmpeg",
                "input": job["input_url"],
                "input_args": ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"],
                "from": float(job["from"]),
                "fps": float(job["fps"]),
                "width": int(job["width"]),
                "height": int(job["height"]),
                "matrix": job.get("matrix", "bt709"),
                "masks": job["masks"],
                "beneath": job.get("beneath", []),
                "out": out,
            }
            result = module.clean(model, req)
            if result.get("box") is not None:
                upload(out, job["output_url"])
        return {"ok": True, **result, "seconds": round(time.time() - started, 1)}
    except Exception as error:  # noqa: BLE001 — every failure is said; Edit leaves the stretch blurred
        return {"ok": False, "error": f"{type(error).__name__}: {error}"[:400]}
    finally:
        try:
            __import__("torch").cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass


runpod.serverless.start({"handler": handler})
