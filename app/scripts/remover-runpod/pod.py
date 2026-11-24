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
import signal
import subprocess
import sys
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
# Whether the finder's OCR loaded (bootstrap.sh): said on every ask, so the relay gives a pod without it cleans alone.
CAN_FIND = os.environ.get("REMOVER_FIND") == "1"
# A find given this long, then stopped with everything it started, and said to have failed: under the relay's 45 min
# for a pod quiet mid-job (remover.ts RUNNING_MS), so the relay hands it on at once rather than after (Nov 24: a stalled
# decoder or OCR child held the pod, unable to say so, until the relay gave up on it).
FIND_S = 40 * 60
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


def upload(path, url, content_type="video/mp4"):
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": content_type, "Content-Length": str(len(data))})
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


def download(url, path):
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "edit-remover-pod"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=600) as resp, open(path, "wb") as out:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def finder_dir(worker_json):
    digest = hashlib.sha256(worker_json.encode()).hexdigest()[:16]
    target = f"/tmp/remover/finder_{digest}"
    if not os.path.isdir(target):
        scripts = json.loads(worker_json)
        staging = f"{target}.tmp.{os.getpid()}"
        os.makedirs(staging, exist_ok=True)
        for name, source in scripts.items():
            # Keep every script flat inside the directory (no traversal).
            base = os.path.basename(name)
            with open(os.path.join(staging, base), "w") as f:
                f.write(source)
        try:
            os.replace(staging, target)
        except OSError:
            if not os.path.isdir(target):
                raise
    return target


def find(job):
    started = time.time()
    try:
        # Free MiniMax-Remover if it was loaded earlier so the finder's ONNX CUDA workers have the whole card.
        if _loaded["model"] is not None:
            _loaded.update(hash=None, module=None, model=None)
            try:
                __import__("torch").cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
        fdir = finder_dir(job["worker"])
        with tempfile.TemporaryDirectory() as tmp:
            video = os.path.join(tmp, "video.mp4")
            download(job["input_url"], video)
            work = os.path.join(tmp, "work")
            os.makedirs(os.path.join(work, "f", "scan"), exist_ok=True)
            parent_args = []
            if job.get("parent_url"):
                parent_file = os.path.join(tmp, "parent.json")
                download(job["parent_url"], parent_file)
                with open(parent_file) as f:
                    pstate = json.load(f)
                scan_dir = os.path.join(work, "f", "scan")
                for key, fname in (("zone", "par.zone.json"), ("marks", "par.marks.json"), ("notes", "par.notes.json"), ("cands", "par.cands.json")):
                    with open(os.path.join(scan_dir, fname), "w") as f:
                        json.dump(pstate[key], f)
                if pstate.get("roamExt") is not None:
                    with open(os.path.join(scan_dir, "par.roam.ext.json"), "w") as f:
                        json.dump(pstate["roamExt"], f)
                verdicts = pstate.get("verdicts") or {}
                with open(os.path.join(work, "f", "verdicts.json"), "w") as f:
                    json.dump({"par": verdicts.get("yes", []), "par:labels": verdicts.get("labels", [])}, f)
                parent_args = ["--parent", "par"]
            spans_path = os.path.join(tmp, "spans.json")
            with open(spans_path, "w") as f:
                json.dump(job["spans"], f)
            pack_path = os.path.join(tmp, "pack.json")
            env = {**os.environ, "PROCS": "4"}
            # Its own process group, so a stop reaches the decoders and OCR workers it starts too.
            child = subprocess.Popen(
                [sys.executable, os.path.join(fdir, "find.py"), "survey", work, "m", video, spans_path, "--pack", pack_path, *parent_args],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
                start_new_session=True,
            )
            try:
                stdout, stderr = child.communicate(timeout=FIND_S)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    child.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    pass
                raise TimeoutError(f"the finder didn't finish in {FIND_S // 60} minutes") from None
            if child.returncode != 0:
                msg = stderr.strip().splitlines()[-1] if stderr.strip() else (stdout.strip().splitlines()[-1] if stdout.strip() else f"exit {child.returncode}")
                raise RuntimeError(msg)
            upload(pack_path, job["output_url"], content_type="application/json")
            last = stdout.strip().splitlines()[-1] if stdout.strip() else "{}"
            summary = json.loads(last)
            return {"ok": True, "ask": len(summary.get("ask", [])), "sheets": len(summary.get("sheets", [])), "seconds": round(time.time() - started, 1)}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"{type(error).__name__}: {error}"[:400], "seconds": round(time.time() - started, 1)}


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


# The model whole in fp16 with a stretch's frames beside it (measured Nov 19: 12.9 GB at its peak).
NEEDS_GB = 14


def unfit():
    """Why this card can't be trusted with a stretch, or None: asked once, before the first stretch is taken (Nov 20: a
    card with too little memory free and one that answered every call with a CUDA error each failed stretch after
    stretch, both tries of each, before anything said so)."""
    try:
        import torch

        if not torch.cuda.is_available():
            return "no CUDA device"
        free, _total = torch.cuda.mem_get_info()
        if free < NEEDS_GB * 2**30:
            return f"{free / 2**30:.1f} GB of its memory free, {NEEDS_GB} needed"
        # That much really taken and given back, and a sum done on the card agreeing with the same sum done off it.
        held = torch.empty(int((NEEDS_GB - 2) * 2**30), dtype=torch.uint8, device="cuda")
        del held
        torch.cuda.empty_cache()
        a = torch.randn(1024, 1024, generator=torch.Generator().manual_seed(7))
        there = (a.cuda() @ a.cuda()).cpu()
        here = a @ a
        if not torch.allclose(there, here, rtol=1e-3, atol=1e-2):
            return "its arithmetic is off"
        return None
    except Exception as error:  # noqa: BLE001 — whatever it is, the card isn't to be used
        return f"{type(error).__name__}: {error}"[:200]


def main():
    idle_since = time.time()
    log(f"up as {POD}")
    why = unfit()
    if why is not None:
        # Nothing was taken, so nothing is lost: the relay stops this pod and rents another for what waits.
        log(f"this card isn't fit ({why}): goodbye")
        call("/v1/remover/pod/bye", {})
        return
    log(f"card checked: fit{'' if CAN_FIND else ' (cleans only: the OCR did not load)'}")
    while True:
        answer = call("/v1/remover/pod/next", {"find": CAN_FIND})
        job = answer.get("job")
        if job is None:
            if time.time() - idle_since > IDLE_S:
                log("nothing left: goodbye")
                call("/v1/remover/pod/bye", {})
                # The relay stops the pod; until it does, nothing more is asked.
                time.sleep(3600)
            time.sleep(3)
            continue
        kind = job.get("kind", "clean")
        if kind == "find":
            log(f"find {job['id']}: {len(job.get('spans', []))} spans")
            output = find(job)
        else:
            log(f"stretch {job['id']}: {len(job['masks'])} frames")
            output = clean(job)
        call("/v1/remover/pod/done", {"id": job["id"], "output": output})
        log(f"{kind} {job['id']}: {'done' if output.get('ok') else 'failed'} in {output.get('seconds', '?')} s")
        if not output.get("ok") and "CUDA" in output.get("error", ""):
            # Any CUDA error (unknown error, out of memory) leaves this pod failing every stretch in seconds while
            # healthy pods take minutes, so it takes most of the queue and spends both tries of each (Nov 20: one
            # card out of memory failed ~40 Boyfriends stretches in 15 min). Go, and the retry lands on another pod.
            log("CUDA unusable: goodbye")
            call("/v1/remover/pod/bye", {})
            return
        idle_since = time.time()


if __name__ == "__main__":
    main()
