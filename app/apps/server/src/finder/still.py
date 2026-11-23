# still.py <job.json>: their captions out of a stretch filmed by a camera that doesn't move, with no model and no rented card.
#
# Behind a caption on a still camera is a picture the same camera shows at other moments. Each letter's pixels are taken
# from the room's plate: each pixel's commonest value across the seconds of the video's files where no caption covers it. The model invents that picture instead,
# and on interrogation rooms it doubled the notepad on the table and melted hands in nearly every frame (Nov 23, the Hitman
# video). Prints {"still": false} when the stretch isn't a still shot, and the model takes it as before.
#
# job: {ffmpeg, input, input_args, from, fps, width, height, matrix, masks: [[box in pixels, ...] per frame], out, beneath,
#       found: the file's boxes (found.ts), plates: a folder, key: the video's name there, also: [{input, input_args, found}]}
import hashlib, json, os, subprocess, sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.dirname(HERE)]  # beside it where Edit unpacks the scripts, one up in the repo
import minimax_worker as worker

SMALL = (160, 90)
# A frame of the same shot differs from another by less than this (median of 0-255, small picture): people move, the room doesn't.
SAME_SHOT = 9
# Share of a frame's pixels (outside their captions) that must sit on the plate for it to count as that still shot.
ON_PLATE = 0.6
# Most frames of a stretch that may miss the plate: a stretch with a cut in it goes to the model.
OFF_PLATE = 0.08
# Frames kept either side of the one being written: for what covers them, and to take a spot from when someone's in it.
REACH = 60
PAD = 14
SIBLING_SAMPLES = 70


def read_frames(ffmpeg, input, args, W, H, filters, extra=()):
    proc = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", *extra, *args, "-i", input, "-an", "-vf", f"{filters}scale={W}:{H},format=rgb24", "-fps_mode", "vfr", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    size = W * H * 3
    try:
        while True:
            raw = proc.stdout.read(size)
            if raw is None or len(raw) < size:
                return
            yield np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


class Shot:
    """One camera angle's plate being counted: per pixel, how often each brightness (in 16 steps) is seen and their colours."""

    def __init__(self, small, rows, W):
        self.small = small.astype(np.int16)
        self.counts = np.zeros((16, rows, W), np.uint16)
        self.sums = np.zeros((16, rows, W, 3), np.uint32)
        self.seen = 0

    def add(self, band, skip):
        level = (band.mean(axis=2) / 16).astype(np.uint8).clip(0, 15)
        for step in range(16):
            here = level == step
            if skip is not None:
                here = here & ~skip
            if here.any():
                self.counts[step][here] += 1
                self.sums[step][here] += band[here]
        self.seen += 1

    def plate(self):
        best = self.counts.argmax(axis=0)
        rows, cols = np.indices(best.shape)
        n = self.counts[best, rows, cols]
        out = (self.sums[best, rows, cols] / np.maximum(n[..., None], 1)).clip(0, 255).astype(np.uint8)
        if (n == 0).any():
            out = cv2.inpaint(out, (n == 0).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
        return out

    def sure(self):
        """How much of what each pixel showed was the plate's value (0-255): low where someone sat part of the time."""
        best = self.counts.argmax(axis=0)
        rows, cols = np.indices(best.shape)
        counts = self.counts.astype(np.int32)
        near = counts[best, rows, cols] + counts[np.maximum(best - 1, 0), rows, cols] * (best > 0) + counts[np.minimum(best + 1, 15), rows, cols] * (best < 15)
        return (255 * near / np.maximum(counts.sum(axis=0), 1)).astype(np.uint8)


def caps_of(found):
    return [m for m in found["masks"] if m[6] in ("subtitle", "note")]


def same_shot(a, b):
    """Most of a still room's pixels stay put whoever moves in it: the median difference, not the mean."""
    return float(np.median(np.abs(a - b))) < SAME_SHOT


def build_plates(job, found, again=False):
    """The video's shots and their plates, kept in `plates` (every stretch of every file of the video reads the same ones).
    Only from seconds the finder read, each caption's box left out, so no caption of theirs can get into a plate."""
    W, H = int(job["width"]), int(job["height"])
    key = hashlib.sha256(job["key"].encode()).hexdigest()[:24]
    os.makedirs(job["plates"], exist_ok=True)
    path = os.path.join(job["plates"], f"{key}.v2.npz")
    if os.path.exists(path) and not again:
        data = np.load(path)
        return (int(data["y0"]), int(data["y1"])), [(data[f"s{i}"], data[f"p{i}"], data[f"c{i}"]) for i in range(int(data["n"]))]
    files = [{"input": job["input"], "input_args": job.get("input_args", []), "found": found}]
    for other in job.get("also", [])[:24]:
        try:
            files.append({**other, "found": json.load(open(other["found"]))})
        except (OSError, KeyError, ValueError):
            continue
    all_caps = [m for one in files for m in caps_of(one["found"])]
    if not all_caps:
        return None, []
    y0, y1 = max(0, min(m[3] for m in all_caps) - 40), min(H, max(m[5] for m in all_caps) + 40)
    shots = []

    def place(frame, skip):
        small = cv2.resize(frame, SMALL, interpolation=cv2.INTER_AREA).astype(np.int16)
        best = next((one for one in shots if same_shot(one.small, small)), None)
        if best is None:
            if len(shots) >= 6:
                return
            best = Shot(small, y1 - y0, W)
            shots.append(best)
        best.add(frame[y0:y1], skip)

    for one in files:
        read = one["found"].get("covered") or []
        fps = one["found"].get("fps") or 30
        caps = caps_of(one["found"])
        seconds = sum(b - a for a, b in read)
        if seconds <= 0:
            continue
        rate = max(0.25, min(2.0, SIBLING_SAMPLES / seconds))
        for at, frame in enumerate(read_frames(job["ffmpeg"], one["input"], one.get("input_args", []), W, H, f"fps={rate:.4f},")):
            t = at / rate
            if not any(a + 0.2 <= t <= b - 0.2 for a, b in read):
                continue
            here = int(round(t * fps))
            skip = np.zeros((y1 - y0, W), bool)
            for m in caps:
                if m[0] - 6 <= here <= m[1] + 6:
                    skip[max(0, m[3] - y0 - PAD):max(0, m[5] - y0 + PAD), max(0, m[2] - PAD):m[4] + PAD] = True
            place(frame, skip)
    out = [(one.small.astype(np.uint8), one.plate(), one.sure()) for one in shots if one.seen >= 8]
    tmp = f"{path}.{os.getpid()}.npz"
    np.savez_compressed(tmp, y0=y0, y1=y1, n=len(out), **{f"s{i}": one[0] for i, one in enumerate(out)}, **{f"p{i}": one[1] for i, one in enumerate(out)}, **{f"c{i}": one[2] for i, one in enumerate(out)})
    os.replace(tmp, path)
    return (y0, y1), out


def letters(frame, boxes, y0, scale):
    """The caption's own pixels and what's near them: (mask, what no other frame should be read from). A caption's letters
    are thin bright strokes, white or one bold colour, whatever is behind them; a hand, a sleeve or a yellow notepad in
    its box isn't, and stays the frame's own (Nov 24, the Hitman video: a mask of whatever differed from the room took
    the officer's hand and pad). A box with no letters in it this frame (a fade, a read a frame late) masks nothing, but
    is not read from either."""
    rows, W = frame.shape[:2]
    out = np.zeros((rows, W), np.uint8)
    cover = np.zeros((rows, W), bool)
    for x0, by0, x1, by1 in boxes:
        a, b = max(0, int(x0) - 6), min(W, int(x1) + 6)
        c, d = max(0, int(by0 - y0) - 6), min(rows, int(by1 - y0) + 6)
        if b <= a or d <= c:
            continue
        # A caption on a plate of its own: the whole box goes.
        if worker.on_a_plate(frame, a, b, c, d, scale):
            out[c:d, a:b] = 255
            cover[c:d, a:b] = True
            continue
        part = np.ascontiguousarray(frame[c:d, a:b])
        hsv = cv2.cvtColor(part, cv2.COLOR_RGB2HSV)
        hue, sat, val = hsv[..., 0].astype(np.int16), hsv[..., 1], hsv[..., 2]
        gray = cv2.cvtColor(part, cv2.COLOR_RGB2GRAY)
        size = int(15 * scale) | 1
        thin = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
        core = (val >= 200) & (sat <= 45) & (thin >= 35)
        bold = (sat > 110) & (val > 120) & (thin >= 25)
        if bold.mean() >= 0.02 and core.mean() < 0.02:
            counts = np.bincount(hue[bold], minlength=180).astype(np.float32)
            spread = sum(np.roll(counts, shift) for shift in range(-10, 11))
            core = core | (bold & (spread >= 0.2 * spread.max())[hue])
        core = cv2.morphologyEx(core.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        # Only groups of strokes the size of a word or a tall letter.
        joined = cv2.morphologyEx(core, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (int(21 * scale) | 1, int(5 * scale) | 1)))
        count, parts, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
        word = (stats[:, cv2.CC_STAT_HEIGHT] >= 10 * scale) & ((stats[:, cv2.CC_STAT_WIDTH] >= 0.06 * (b - a)) | (stats[:, cv2.CC_STAT_HEIGHT] >= 12 * scale))
        # A caption's strokes stand on its dark shadow; the bright edge of a page or a cuff stands on the room.
        labels = cv2.dilate(parts.astype(np.uint16), np.ones((7, 7), np.uint8)).astype(np.int32)
        ring = (labels > 0) & (core == 0)
        around = np.bincount(labels[ring], minlength=count)
        dark = np.bincount(labels[ring & (val < 110)], minlength=count)
        word = word & (dark >= 0.5 * np.maximum(around, 1))
        word[0] = False
        core = core & word[parts].astype(np.uint8)
        if not core.any():
            cover[c:d, a:b] = True
            continue
        # Wide enough for the soft shadow, which reaches past the box; and no other frame is read from a little further
        # out still, or the rim of that frame's shadow is laid in as a faint line.
        reach = int(38 * scale)
        tail = int(22 * scale)
        A, B, C, D = max(0, a - reach - tail), min(W, b + reach + tail), max(0, c - reach - tail), min(rows, d + reach + tail)
        canvas = np.zeros((D - C, B - A), np.uint8)
        canvas[c - C:d - C, a - A:b - A] = core
        grown = cv2.dilate(canvas, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (reach * 2 + 1, reach * 2 + 1)))
        out[C:D, A:B] = np.maximum(out[C:D, A:B], grown * 255)
        cover[C:D, A:B] |= cv2.dilate(grown, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (tail * 2 + 1, tail * 2 + 1))) > 0
    return out, cover


def filled(frame, plate, trust, mask, scale, window, own, at):
    """What goes under the mask: each pixel from the nearest frame of these seconds with no caption on it, so a person
    stays as they are; then the room's picture where it can be trusted; what's left is closed from around it."""
    rows, W = mask.shape
    holes = (mask > 0).astype(np.uint8)
    ys, xs = np.where(holes)
    grow = max(3, int(8 * scale))
    a, b, c, d = max(0, xs.min() - grow - 8), min(W, xs.max() + grow + 9), max(0, ys.min() - grow - 8), min(rows, ys.max() + grow + 9)
    out = plate.copy()
    patch = out[c:d, a:b]
    left = holes[c:d, a:b] > 0
    for step in range(1, REACH + 1):
        for other in (at - step, at + step):
            if 0 <= other < len(window):
                busy = np.zeros(left.shape, bool)
                for near in range(max(0, other - 2), min(len(own), other + 3)):
                    busy |= own[near][c:d, a:b]
                use = left & ~busy
                if use.any():
                    patch[use] = window[other][c:d, a:b][use]
                    left &= ~use
        if not left.any():
            break
    # A line or a speck one frame had (a caption's edge as it slid in) is put right from what's round it.
    smooth = cv2.medianBlur(patch, 5)
    odd = (np.abs(patch.astype(np.int16) - smooth.astype(np.int16)).sum(axis=2) > 60) & (holes[c:d, a:b] > 0)
    patch[odd] = smooth[odd]
    unsure = left & ~trust[c:d, a:b]
    if unsure.any():
        wider = cv2.dilate(holes[c:d, a:b], cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1)))
        closed = cv2.inpaint(np.ascontiguousarray(frame[c:d, a:b]), wider * 255, 3, cv2.INPAINT_TELEA)
        patch[unsure] = closed[unsure]
    return out


def solid(boxes, y0, rows, W):
    out = np.zeros((rows, W), bool)
    for x0, by0, x1, by1 in boxes:
        out[max(0, int(by0 - y0 - PAD)):max(0, int(by1 - y0 + PAD)), max(0, int(x0 - PAD)):int(x1 + PAD)] = True
    return out


def clean(job):
    W, H, fps = int(job["width"]), int(job["height"]), float(job["fps"])
    masks = job["masks"]
    total = len(masks)
    band = worker.band_of(masks, W, H)
    if band is None:
        return {"still": True, "box": None, "inferred": 0}
    y0, y1 = band
    rows = y1 - y0
    scale = H / 1080
    found = json.load(open(job["found"]))
    span, shots = build_plates(job, found)
    # A plate made before this file was read may stop short of its captions: made again with what's known now.
    words = [one for frame_boxes in masks for one in frame_boxes]
    top_word, bottom_word = int(min(one[1] for one in words)), int(max(one[3] for one in words))
    if span is not None and (top_word < span[0] or bottom_word > span[1]):
        span, shots = build_plates(job, found, True)
    if span is None or not shots or top_word < span[0] or bottom_word > span[1]:
        return {"still": False, "why": "no plate"}
    # The stretch's frames, all in memory only while they're near the one being filled.
    source = worker.Frames(job["ffmpeg"], job["input"], float(job["from"]), total, fps, W, y0, y1, job.get("matrix", "bt709"), job.get("input_args", []), H, job.get("beneath", []))
    strip = None
    try:
        # Which shot: by the picture at the middle of the stretch.
        middle = next(read_frames(job["ffmpeg"], job["input"], job.get("input_args", []), W, H, "", ("-ss", f"{float(job['from']) + total / fps / 2:.3f}")), None)
        if middle is None:
            return {"still": False, "why": "no picture"}
        small = cv2.resize(middle, SMALL, interpolation=cv2.INTER_AREA).astype(np.int16)
        ref, whole, sure = min(shots, key=lambda one: float(np.median(np.abs(one[0].astype(np.int16) - small))))
        if not same_shot(ref.astype(np.int16), small):
            return {"still": False, "why": "another shot"}
        # The plate, on the stretch's rows (rows it doesn't reach hold no caption: checked above).
        plate = np.zeros((rows, W, 3), np.uint8)
        top, bottom = max(y0, span[0]), min(y1, span[1])
        # A pixel's commonest value can differ from its neighbour's by a whole step: a line or a speck here and there.
        plate[top - y0:bottom - y0] = cv2.medianBlur(whole, 5)[top - span[0]:bottom - span[0]]
        known = np.zeros((rows, W), bool)
        known[top - y0:bottom - y0] = True
        trust = np.zeros((rows, W), bool)
        trust[top - y0:bottom - y0] = sure[top - span[0]:bottom - span[0]] >= 150

        window, marks, own = [], [], []
        off, checked, written, next_frame, boxed, empty = 0, 0, 0, 0, 0, 0
        none = np.zeros((rows, W), bool)
        out = job["out"]
        strip = worker.Strip(job["ffmpeg"], out, W, rows, fps)
        while written < total:
            while next_frame < total and len(window) - (written - off) <= REACH:
                frame = source.read()
                if frame is None:
                    total = next_frame
                    break
                if masks[next_frame]:
                    m, cover = letters(frame, masks[next_frame], y0, scale)
                    boxed += 1
                    empty += 0 if m.any() else 1
                else:
                    m, cover = None, none
                window.append(frame)
                marks.append(m)
                own.append(cover)
                next_frame += 1
            if written >= total:
                break
            at = written - off
            frame, m = window[at], marks[at]
            if at % 15 == 0:
                free = known & ~own[at]
                if free.any():
                    checked += 1
                    if float((np.abs(frame.astype(np.int16) - plate.astype(np.int16)).sum(axis=2)[free] < 45).mean()) < ON_PLATE:
                        job["_off"] = job.get("_off", 0) + 1
            if m is None or not m.any():
                strip.write(None, None)
            else:
                strip.write(filled(frame, plate, trust, m, scale, window, own, at), worker.alpha_of(m, max(worker.FEATHER, int(round(9 * scale)))))
            written += 1
            if written - off > REACH:
                window.pop(0), marks.pop(0), own.pop(0)
                off += 1
        while written < len(masks):
            strip.write(None, None)
            written += 1
        # Boxes with no letters we can see in most of their frames: a style this doesn't know, for the model.
        unread = boxed > 0 and empty / boxed > 0.6
        if unread or (checked > 0 and job.get("_off", 0) / checked > OFF_PLATE):
            strip.proc.stdin.close()
            strip.proc.wait()
            for one in (out, f"{out}.partial.mp4"):
                if os.path.exists(one):
                    os.remove(one)
            strip = None
            return {"still": False, "why": f"{empty} of {boxed} captioned frames without letters" if unread else f"{job['_off']} of {checked} looks off the room's picture"}
        strip.finish()
        strip = None
    finally:
        source.close()
        if strip is not None and strip.proc.poll() is None:
            strip.proc.kill()
    return {"still": True, "box": [0.0, y0 / H, 1.0, y1 / H], "inferred": 0}


if __name__ == "__main__":
    print(json.dumps(clean(json.load(open(sys.argv[1])))))
