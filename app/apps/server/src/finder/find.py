# The finder's two steps for one footage file (found.ts runs them):
#
#   find.py survey <root> <id> <video> <spans.json> [--parent <id>]
#       reads the file (its shown seconds), classes what's laid over the picture, and prints what a judge must look at:
#       {"ask": [{kind, text, n}], "sheets": [png paths]} (tile #i of the sheets is ask[i])
#   find.py finish <root> <id> <verdicts.json> [--parent <id>]
#       the judge's answers ({"0": "overlay" | "camera" | "scene" | "unclear", ...}) taken in, and the file's boxes written
#       to <root>/f/found/<id>.json: {width, height, fps, covered: [[from, to] seconds], masks: [[first frame, last frame,
#       x0, y0, x1, y1, kind]]} in the file's own pixels (kinds: subtitle, note, label, mark)
#
# <root>/f holds every file's reads (scan/), so a slowed copy (--parent) reads as the file it was made from: its caption
# zone, labels and marks. Each step is one of the scripts beside this one, run in order; what each does is at its top.
import sys, os, json, subprocess, base64

HERE = os.path.dirname(os.path.abspath(__file__))
TAG = "f"


def run(script, *args, quiet=True):
    done = subprocess.run([sys.executable, os.path.join(HERE, script), TAG, *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise SystemExit(f"{script} {' '.join(args)}: {done.stderr.strip().splitlines()[-1] if done.stderr.strip() else 'failed'}")
    return done.stdout


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def has_zone(mid):
    return (load(f"{TAG}/scan/{mid}.zone.json") or {}).get("zone") is not None


def copy_ask(mid):
    """A slowed copy's own one-off words, for the judge (its labels and marks are its parent's, judged there)."""
    import cv2, numpy as np
    ask = []
    for c in load(f"{TAG}/scan/{mid}.cands.json", []):
        r = c["reads"][len(c["reads"]) // 2]
        ask.append({"kind": "one-off", "text": c["text"], "f": r[0], "box": r[1:5], "n": c["n"]})
    json.dump(ask, open(f"{TAG}/scan/{mid}.ask.json", "w"))
    sheets = []
    if ask:
        cap = cv2.VideoCapture(f"{TAG}/src/{mid}.mp4"); tiles = []
        for i, a in enumerate(ask):
            cap.set(cv2.CAP_PROP_POS_FRAMES, a["f"]); ok, img = cap.read()
            if not ok: img = np.zeros((720, 1280, 3), np.uint8)
            x0, y0, x1, y1 = a["box"]; cv2.rectangle(img, (x0 - 6, y0 - 6), (x1 + 6, y1 + 6), (0, 255, 0), 2)
            cx, cy = (x0 + x1) // 2, (y0 + y1) // 2; w = min(img.shape[1], max(480, int((x1 - x0) * 1.8))); h = w * 9 // 16
            X0 = max(0, min(img.shape[1] - w, cx - w // 2)); Y0 = max(0, min(img.shape[0] - h, cy - h // 2)); t = cv2.resize(img[Y0:Y0 + h, X0:X0 + w], (480, 270))
            cv2.rectangle(t, (0, 0), (64, 26), (0, 0, 0), -1); cv2.putText(t, f"#{i}", (4, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2); tiles.append(t)
        for s in range(0, len(tiles), 16):
            part = tiles[s:s + 16]
            while len(part) % 4: part.append(np.zeros_like(part[0]))
            cv2.imwrite(f"{TAG}/look/{mid}.cands{s // 16}.jpg", np.vstack([np.hstack(part[i:i + 4]) for i in range(0, len(part), 4)]))
    return ask


def sheets_of(mid, count):
    return [os.path.abspath(f"{TAG}/look/{mid}.cands{n}.jpg") for n in range((count + 15) // 16)]


def pack_bundle(mid, parent, out_path):
    """Packs everything Edit's server needs to judge and finish without Python or the video (RunPod cloud finder):
    precomputed mask groups (captions with backing, per-label/unsure masks with plate growth, roaming masks, base
    notes), candidate tile JPEGs as base64, and parent state for slowed copies."""
    import cv2
    sys.path.insert(0, HERE)
    import assemble
    from captions import captions, pad

    cap = cv2.VideoCapture(f"{TAG}/src/{mid}.mp4")
    Z = load(f"{TAG}/scan/{parent if parent is not None else mid}.zone.json")
    fps = cap.get(cv2.CAP_PROP_FPS) or Z["fps"]
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    W, H = Z["W"], Z["H"]
    covered = load(f"{TAG}/shown.json", {}).get(mid, [])
    ask_items = []
    parent_state = None
    if parent is not None:
        base_masks = load(f"{TAG}/scan/{mid}.masks.json", [])
        base_notes = []
        roam_masks = []
        for c in load(f"{TAG}/scan/{mid}.cands.json", []):
            rs = c["reads"]
            r = rs[len(rs) // 2]
            b = pad([min(x[1] for x in rs), min(x[2] for x in rs), max(x[3] for x in rs), max(x[4] for x in rs)], W, H)
            ex = int(0.5 * (b[3] - b[1]))
            mask = [rs[0][0] - 10, rs[-1][0] + 10, max(0, b[0] - ex), b[1], min(W, b[2] + ex), b[3], "note"]
            ask_items.append({"kind": "one-off", "text": c["text"], "n": c["n"], "f": r[0], "masks": [mask]})
    else:
        ms = captions(TAG, mid, Z)[0] if Z["zone"] else []
        base_masks = assemble.backing(TAG, mid, ms, W, H)
        base_notes = [[n["f0"], n["f1"], *n["box"]] for n in load(f"{TAG}/scan/{mid}.notes.json", [])]
        roam_masks = load(f"{TAG}/scan/{mid}.roam.masks.json", [])
        for a in assemble.ask_list(TAG, mid):
            item = {"kind": a["kind"], "text": a["text"], "n": a["n"], "f": a["f"]}
            if a["kind"] == "label":
                item["masks"] = assemble.label_masks(Z, [a["mark"]], tag=TAG, mid=mid)
            elif a["kind"] == "unsure":
                item["masks"] = assemble.label_masks(Z, [dict(a["mark"], kind="label")], tag=TAG, mid=mid)
            elif a["kind"] == "one-off":
                rs = a["reads"]
                item["note"] = [rs[0][0], rs[-1][0], min(r[1] for r in rs), min(r[2] for r in rs), max(r[3] for r in rs), max(r[4] for r in rs)]
            ask_items.append(item)
        parent_state = {
            "zone": Z,
            "marks": load(f"{TAG}/scan/{mid}.marks.json", []),
            "notes": load(f"{TAG}/scan/{mid}.notes.json", []),
            "cands": load(f"{TAG}/scan/{mid}.cands.json", []),
            "roamExt": load(f"{TAG}/scan/{mid}.roam.ext.json"),
        }
    sheets_b64 = []
    for path in sheets_of(mid, len(ask_items)):
        with open(path, "rb") as f:
            sheets_b64.append(base64.b64encode(f.read()).decode("ascii"))
    bundle = {
        "version": 1,
        "width": W,
        "height": H,
        "fps": fps,
        "frames": frames,
        "covered": covered,
        "baseMasks": base_masks,
        "baseNotes": base_notes,
        "roamMasks": roam_masks,
        "ask": ask_items,
        "sheetsB64": sheets_b64,
    }
    if parent_state is not None:
        bundle["parentState"] = parent_state
    # What the survey read, each with its frame, so Edit's finish runs off_titles and off_caption_labels as `finish` does (Nov 24).
    reads = []
    if os.path.exists(f"{TAG}/scan/{mid}.jsonl"):
        for line in open(f"{TAG}/scan/{mid}.jsonl"):
            row = json.loads(line)
            reads += [[*L[:5], row["f"]] for L in row["lines"] if len(L) >= 6]
    bundle["reads"] = reads
    tmp = f"{out_path}.tmp"
    with open(tmp, "w") as f:
        json.dump(bundle, f)
    os.replace(tmp, out_path)


def survey(mid, video, spans, parent, pack_path=None):
    for d in ("src", "scan", "look", "found"):
        os.makedirs(f"{TAG}/{d}", exist_ok=True)
    link = f"{TAG}/src/{mid}.mp4"
    if os.path.lexists(link): os.remove(link)
    os.symlink(os.path.abspath(video), link)
    shown = load(f"{TAG}/shown.json", {}); shown[mid] = spans; json.dump(shown, open(f"{TAG}/shown.json", "w"))
    if not os.path.exists(f"{TAG}/verdicts.json"): json.dump({}, open(f"{TAG}/verdicts.json", "w"))
    for old in os.listdir(f"{TAG}/look"):
        if old.startswith(f"{mid}.cands"): os.remove(f"{TAG}/look/{old}")
    if parent is not None:
        run("slowcopy.py", mid, parent, "pre"); run("scan.py", mid, "10")
        if has_zone(parent): run("dense.py", mid)
        run("slowcopy.py", mid, parent)
        ask = copy_ask(mid)
    else:
        run("scan.py", mid); run("thumbs.py", mid); run("zone.py", mid); run("marks.py", mid); run("notes.py", mid); run("cands.py", mid)
        if has_zone(mid): run("dense.py", mid)
        if any(m["kind"] == "roamer" for m in load(f"{TAG}/scan/{mid}.marks.json", [])):
            for old in (f"{TAG}/scan/{mid}.roam.ext.json", f"{TAG}/scan/{mid}.roam.raw.json"):
                if os.path.exists(old): os.remove(old)
            run("roamtrack.py", mid); run("glide.py", mid)
        if pack_path is not None:
            sys.path.insert(0, HERE)
            import assemble
            assemble.sheet(TAG, mid)
        else:
            run("assemble.py", mid)
        ask = load(f"{TAG}/scan/{mid}.ask.json", [])
    if pack_path is not None:
        pack_bundle(mid, parent, pack_path)
    print(json.dumps({"ask": [{"kind": a["kind"], "text": a["text"], "n": a["n"]} for a in ask], "sheets": sheets_of(mid, len(ask))}))


def finish(mid, verdicts, parent):
    ask = load(f"{TAG}/scan/{mid}.ask.json", []); V = load(f"{TAG}/verdicts.json", {})
    yes = []; labels = []
    for i, a in enumerate(ask):
        v = verdicts.get(str(i), "unclear")
        if a["kind"] in ("label", "roamer"):
            # A label the judge couldn't make out stays theirs (it held its place through scene changes); the camera's goes.
            if v in ("overlay", "unclear"): labels.append(a["text"])
        elif v == "overlay": yes.append([a["kind"], a["text"], a["f"]])
    V[mid] = yes
    if parent is None: V[mid + ":labels"] = labels
    json.dump(V, open(f"{TAG}/verdicts.json", "w"))
    if parent is not None:
        run("slowcopy.py", mid, parent)
        Z = load(f"{TAG}/scan/{parent}.zone.json")
    else:
        sys.path.insert(0, HERE)
        import assemble
        assemble.build(TAG, mid, yes)
        Z = load(f"{TAG}/scan/{mid}.zone.json")
    masks = load(f"{TAG}/scan/{mid}.masks.json", [])
    import cv2
    cap = cv2.VideoCapture(f"{TAG}/src/{mid}.mp4"); fps = cap.get(cv2.CAP_PROP_FPS) or Z["fps"]; frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    last = max(0, frames - 1)
    out = [[max(0, int(m[0])), min(last, int(m[1])), int(m[2]), int(m[3]), int(m[4]), int(m[5]), "note" if m[6] == "note" else m[6]] for m in masks if m[1] >= 0 and m[0] <= last and m[4] > m[2] and m[5] > m[3]]
    sys.path.insert(0, HERE)
    import assemble
    reads = []
    if os.path.exists(f"{TAG}/scan/{mid}.jsonl"):
        for line in open(f"{TAG}/scan/{mid}.jsonl"):
            row = json.loads(line)
            reads += [[*L[:6], row["f"]] for L in row["lines"] if len(L) >= 6]
    out = assemble.off_caption_labels(assemble.off_titles(out, Z["W"], Z["H"], reads), reads)
    found = {"version": 1, "width": Z["W"], "height": Z["H"], "fps": fps, "covered": load(f"{TAG}/shown.json", {}).get(mid, []), "masks": out}
    tmp = f"{TAG}/found/{mid}.json.tmp"; json.dump(found, open(tmp, "w")); os.replace(tmp, f"{TAG}/found/{mid}.json")
    kinds = {}
    for m in out: kinds[m[6]] = kinds.get(m[6], 0) + 1
    print(json.dumps({"found": os.path.abspath(f"{TAG}/found/{mid}.json"), "kinds": kinds}))


if __name__ == "__main__":
    step, root, mid = sys.argv[1:4]
    parent = sys.argv[sys.argv.index("--parent") + 1] if "--parent" in sys.argv else None
    pack_path = os.path.abspath(sys.argv[sys.argv.index("--pack") + 1]) if "--pack" in sys.argv else None
    os.makedirs(root, exist_ok=True); os.chdir(root)
    if step == "survey": survey(mid, sys.argv[4], [[a, b] for a, b, *_ in json.load(open(sys.argv[5]))], parent, pack_path)
    elif step == "finish": finish(mid, json.load(open(sys.argv[4])), parent)
    else: raise SystemExit(f"unknown step {step}")
