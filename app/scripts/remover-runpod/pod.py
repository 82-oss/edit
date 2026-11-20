"""A rented RunPod pod cleaning Edit's stretches (apps/relay/src/remover.ts starts it): it asks the relay for the next
stretch, cleans it with the minimax_worker.py the stretch brings (the Edit build's own), writes the strip straight to
R2 by the presigned URL the relay gave, says it's done, and asks for the next. With nothing left for a while it says
goodbye and the relay stops the pod (Sphe, Nov 20: a pod rented for the work and let go after is ~4x cheaper than
RunPod's serverless for the same card).

The relay's address and this pod's token come in its env (REMOVER_RELAY, REMOVER_TOKEN); RunPod sets RUNPOD_POD_ID.
"""

import hashlib
import importlib.util
import json
import os
import tempfile
import time
import urllib.request

MODELS = "/tmp/remover/weights"
REPO = "/tmp/remover/repo"
RELAY = os.environ["REMOVER_RELAY"].rstrip("/")
TOKEN = os.environ["REMOVER_TOKEN"]
POD = os.environ.get("RUNPOD_POD_ID", "")
# Nothing to do for this long: goodbye (a stretch arriving meanwhile is taken first; Edit sends a project's stretches
# in waves as their tracks are read, so a pod waits a minute before it goes).
IDLE_S = 60
_loaded = {"hash": None, "module": None, "model": None}


def log(*parts):
    print("[pod]", *parts, flush=True)


def call(route, body):
    data = json.dumps({"pod": POD, "token": TOKEN, **body}).encode()
    # Its own name: Cloudflare turns Python's "Python-urllib" away before the relay sees it (error 1010, Nov 20: every
    # pod's first ask refused, and the relay rented new ones in their place).
    req = urllib.request.Request(f"{RELAY}{route}", data=data, method="POST", headers={"Content-Type": "application/json", "User-Agent": "edit-remover-pod"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as error:
            if error.code < 500:
                raise
        except Exception:  # noqa: BLE001 — the relay out of reach a moment
            pass
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"the relay didn't answer {route}")


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
            _loaded["model"] = None
            __import__("torch").cuda.empty_cache()
        # Every card the relay rents has 16 GB or more: the model whole in fp16.
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


def clean(job):
    started = time.time()
    try:
        module, model = worker_for(job["worker"])
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "strip.mp4")
            result = module.clean(model, {
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
            })
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


def main():
    idle_since = time.time()
    log(f"up as {POD}")
    while True:
        answer = call("/v1/remover/pod/next", {})
        job = answer.get("job")
        if job is None:
            if time.time() - idle_since > IDLE_S:
                log("nothing left: goodbye")
                call("/v1/remover/pod/bye", {})
                # The relay stops the pod; until it does, nothing more is asked.
                time.sleep(3600)
            time.sleep(3)
            continue
        log(f"stretch {job['id']}: {len(job['masks'])} frames")
        output = clean(job)
        call("/v1/remover/pod/done", {"id": job["id"], "output": output})
        log(f"stretch {job['id']}: {'done' if output.get('ok') else 'failed'} in {output.get('seconds', '?')} s")
        if not output.get("ok") and "CUDA unknown error" in output.get("error", ""):
            # This worker's CUDA context is unusable. Give the relay's requeued job to another pod.
            log("CUDA unavailable: goodbye")
            call("/v1/remover/pod/bye", {})
            return
        idle_since = time.time()


if __name__ == "__main__":
    main()
