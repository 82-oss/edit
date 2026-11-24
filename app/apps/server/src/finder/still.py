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
# Frames each hidden pixel is voted on from: a pad or a hand passing through for a moment is outvoted by the room.
SAMPLES = 5
PAD = 14
SIBLING_SAMPLES = 800


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
        # Real frames of this shot with no caption in their place: the room with its grain, where the plate is an average.
        self.real = []

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

    def plate(self, close=True):
        best = self.counts.argmax(axis=0)
        rows, cols = np.indices(best.shape)
        n = self.counts[best, rows, cols]
        out = (self.sums[best, rows, cols] / np.maximum(n[..., None], 1)).clip(0, 255).astype(np.uint8)
        if close and (n == 0).any():
            out = cv2.inpaint(out, (n == 0).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
        return out

    def keep(self, band):
        self.real.append(band.copy())
        if len(self.real) >= 24:
            self.real = self.real[::2]

    def real_frame(self, plate):
        """The kept frame nearest the plate: the fewest people out of their usual place."""
        if not self.real:
            return plate
        return min(self.real, key=lambda one: float(np.abs(one.astype(np.int16) - plate.astype(np.int16)).mean()))

    def sure(self):
        """How much of what each pixel showed was the plate's value (0-255): low where someone sat part of the time."""
        best = self.counts.argmax(axis=0)
        rows, cols = np.indices(best.shape)
        counts = self.counts.astype(np.int32)
        near = counts[best, rows, cols] + counts[np.maximum(best - 1, 0), rows, cols] * (best > 0) + counts[np.minimum(best + 1, 15), rows, cols] * (best < 15)
        looks = counts.sum(axis=0)
        # A spot seen only a few times between captions can't be trusted, however much those few agree.
        return ((255 * near / np.maximum(looks, 1)) * (looks >= 5)).astype(np.uint8)


def caps_of(found):
    return [m for m in found["masks"] if m[6] in ("subtitle", "note")]


def place_of(caps):
    """Where a file's captions come up (most of them), or None with too few to tell."""
    if len(caps) < 5:
        return None
    return [int(np.percentile([m[2] for m in caps], 2)), int(np.percentile([m[3] for m in caps], 2)), int(np.percentile([m[4] for m in caps], 98)), int(np.percentile([m[5] for m in caps], 98))]


def captioned(frame, place):
    """Whether a caption's plate or shadow is in its place in this frame, read or not: near-black there. A line the finder
    missed would otherwise win the few looks that spot gets between captions and be laid back in as the room (Nov 24,
    Trooper: one sentence over 17 minutes)."""
    x0, y0, x1, y1 = place
    return float((cv2.cvtColor(np.ascontiguousarray(frame[y0:y1, x0:x1]), cv2.COLOR_RGB2GRAY) < 40).mean()) >= 0.015


def same_shot(a, b):
    """Most of a still room's pixels stay put whoever moves in it: the median difference, not the mean."""
    return float(np.median(np.abs(a - b))) < SAME_SHOT


def build_plates(job, found, again=False):
    """The video's shots and their plates, kept in `plates` (every stretch of every file of the video reads the same ones).
    Only from seconds the finder read, each caption's box left out, so no caption of theirs can get into a plate."""
    W, H = int(job["width"]), int(job["height"])
    key = hashlib.sha256(job["key"].encode()).hexdigest()[:24]
    os.makedirs(job["plates"], exist_ok=True)
    path = os.path.join(job["plates"], f"{key}.v8.npz")
    if os.path.exists(path) and not again:
        data = np.load(path)
        return (int(data["y0"]), int(data["y1"])), [(data[f"s{i}"], data[f"p{i}"], data[f"c{i}"], data[f"r{i}"]) for i in range(int(data["n"]))]
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

    def place(frame, skip, clear):
        small = cv2.resize(frame, SMALL, interpolation=cv2.INTER_AREA).astype(np.int16)
        best = next((one for one in shots if same_shot(one.small, small)), None)
        if best is None:
            if len(shots) >= 6:
                return
            best = Shot(small, y1 - y0, W)
            shots.append(best)
        best.add(frame[y0:y1], skip)
        if clear:
            best.keep(frame[y0:y1])

    for one in files:
        read = one["found"].get("covered") or []
        fps = one["found"].get("fps") or 30
        caps = caps_of(one["found"])
        where = place_of(caps)
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
            busy = where is not None and captioned(frame, where)
            if busy:
                skip[max(0, where[1] - y0 - PAD):max(0, where[3] - y0 + PAD), max(0, where[0] - PAD):where[2] + PAD] = True
            place(frame, skip, where is not None and not busy and not any(m[0] - 6 <= here <= m[1] + 6 for m in caps))
    out = []
    for one in shots:
        if one.seen >= 8:
            picture = one.plate()
            out.append((one.small.astype(np.uint8), picture, one.sure(), one.real_frame(picture)))
    tmp = f"{path}.{os.getpid()}.npz"
    np.savez_compressed(tmp, y0=y0, y1=y1, n=len(out), **{f"s{i}": one[0] for i, one in enumerate(out)}, **{f"p{i}": one[1] for i, one in enumerate(out)}, **{f"c{i}": one[2] for i, one in enumerate(out)}, **{f"r{i}": one[3] for i, one in enumerate(out)})
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
        # A caption on a plate of its own: the whole box goes. A black plate is nearly half the box at the darkest, which a
        # soft shadow round the letters isn't.
        darkest = cv2.cvtColor(np.ascontiguousarray(frame[c:d, a:b]), cv2.COLOR_RGB2GRAY) < 40
        if worker.on_a_plate(frame, a, b, c, d, scale) or darkest.mean() >= 0.45:
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
        # The black plate the letters sit on, however little of the box it fills: its corners stayed behind otherwise.
        dark = (gray < 40).astype(np.uint8)
        blobs, blob = cv2.connectedComponents(dark, connectivity=8)
        touching = np.unique(blob[(cv2.dilate(core, np.ones((9, 9), np.uint8)) > 0) & (dark > 0)])
        on_plate = np.isin(blob, touching[touching > 0])
        canvas[c - C:d - C, a - A:b - A] = core | on_plate.astype(np.uint8)
        grown = cv2.dilate(canvas, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (reach * 2 + 1, reach * 2 + 1)))
        out[C:D, A:B] = np.maximum(out[C:D, A:B], grown * 255)
        cover[C:D, A:B] |= cv2.dilate(grown, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (tail * 2 + 1, tail * 2 + 1))) > 0
    return out, cover


def stretch_plate(job, masks, total, W, H, y0, y1, fps):
    """The commonest picture of this stretch alone, captions left out: what's on the table now (a card put down halfway
    through the video isn't on the whole video's plate). (picture, the pixels it saw)."""
    step = max(1, total // 96)
    where = place_of(caps_of(json.load(open(job["found"]))))
    shot = Shot(np.zeros(1), y1 - y0, W)
    for at, frame in enumerate(read_frames(job["ffmpeg"], job["input"], job.get("input_args", []), W, H, f"fps={fps / step:.6f},", ("-ss", f"{float(job['from']):.3f}"))):
        index = at * step
        if index >= total:
            break
        near = [one for i in range(max(0, index - 6), min(total, index + 7)) for one in masks[i]]
        skip = solid(near, y0, y1 - y0, W)
        if where is not None and captioned(frame, where):
            skip[max(0, where[1] - y0 - PAD):max(0, where[3] - y0 + PAD), max(0, where[0] - PAD):where[2] + PAD] = True
        shot.add(frame[y0:y1], skip)
    return shot.plate(False), shot.counts.sum(axis=0) >= 2


def filled(frame, plate, trust, certain, mask, scale, window, own, at, nearby, seen, real):
    """What goes under the mask: each pixel voted on by the nearest frames with no caption on it, so a person stays as
    they are and something that only passed through doesn't land there; failing that, this stretch's own picture, then
    the room's where it can be trusted; what's left is closed from around it."""
    rows, W = mask.shape
    holes = (mask > 0).astype(np.uint8)
    ys, xs = np.where(holes)
    grow = max(3, int(8 * scale))
    a, b, c, d = max(0, xs.min() - grow - 8), min(W, xs.max() + grow + 9), max(0, ys.min() - grow - 8), min(rows, ys.max() + grow + 9)
    out = plate.copy()
    patch = out[c:d, a:b]
    want = holes[c:d, a:b] > 0
    votes = np.zeros((SAMPLES, *want.shape, 3), np.uint8)
    count = np.zeros(want.shape, np.uint8)
    for step in range(3, REACH + 1, 4):
        for other in (at - step, at + step):
            if 0 <= other < len(window):
                busy = np.zeros(want.shape, bool)
                for near in range(max(0, other - 2), min(len(own), other + 3)):
                    busy |= own[near][c:d, a:b]
                ys, xs = np.nonzero(want & ~busy & (count < SAMPLES))
                if len(ys):
                    votes[count[ys, xs], ys, xs] = window[other][c:d, a:b][ys, xs]
                    count[ys, xs] += 1
        if (count[want] >= SAMPLES).all():
            break
    known = seen[c:d, a:b]
    patch[want & known] = nearby[c:d, a:b][want & known]
    # An average has no grain and shows as a smooth patch on carpet: a real frame's pixels wherever they agree with it.
    sharp = real[c:d, a:b]
    agrees = np.abs(sharp.astype(np.int16) - patch.astype(np.int16)).sum(axis=2) < 60
    patch[want & agrees] = sharp[want & agrees]
    for many in range(1, SAMPLES + 1):
        # One or two frames are a poor vote: this stretch's own picture is better, where it saw the spot.
        here = want & (count == many) & (~known if many < 3 else True)
        if here.any():
            voted = np.median(votes[:many, here], axis=0).astype(np.uint8)
            # The nearest frame's own pixel where it agrees with the vote: the same picture, with its grain.
            first = votes[0, here]
            close = np.abs(first.astype(np.int16) - voted.astype(np.int16)).sum(axis=1) < 45
            voted[close] = first[close]
            patch[here] = voted
    # Something this stretch's picture has that the room's doesn't (the pad, held up for most of it), and that the part of
    # it we can see now shows isn't there any more: the room goes in its place. Wholly hidden, it stays (a card on the table)
    # unless that spot is nearly always plain room.
    room = plate[c:d, a:b]
    differ = known & (np.abs(nearby[c:d, a:b].astype(np.int16) - room.astype(np.int16)).sum(axis=2) > 45)
    pieces, parts = cv2.connectedComponents(differ.astype(np.uint8), connectivity=8)
    if pieces > 1:
        here_now = np.ascontiguousarray(frame[c:d, a:b]).astype(np.int16)
        off_near = np.abs(here_now - nearby[c:d, a:b].astype(np.int16)).sum(axis=2).astype(np.float64)
        off_room = np.abs(here_now - room.astype(np.int16)).sum(axis=2).astype(np.float64)
        open_part = ~want
        shown = np.bincount(parts[open_part], minlength=pieces)
        gone = (shown >= 10) & (np.bincount(parts[open_part], off_room[open_part], minlength=pieces) < np.bincount(parts[open_part], off_near[open_part], minlength=pieces))
        plain = np.bincount(parts.ravel(), certain[c:d, a:b].ravel().astype(np.float64), minlength=pieces) / np.maximum(np.bincount(parts.ravel(), minlength=pieces), 1)
        gone |= (shown < 10) & (plain >= 0.7)
        gone[0] = False
        back = want & gone[parts]
        patch[back] = room[back]
    left = want & (count == 0) & ~known
    # No frame of these seconds shows it: the room as a clear frame had it, never a smooth guess from around it.
    patch[left] = sharp[left]
    # A line or a speck one frame had (a caption's edge as it slid in, a dotted edge of someone's shoe in the room's picture)
    # is put right from what's round it.
    smooth = cv2.medianBlur(patch, 9)
    odd = (np.abs(patch.astype(np.int16) - smooth.astype(np.int16)).sum(axis=2) > 60) & want
    patch[odd] = smooth[odd]
    return out


def is_gray(frame, free):
    """A black-and-white stretch of the video (the channel cuts to one and back): its colour channels move together."""
    picked = frame[free][::29].astype(np.float32)
    return len(picked) >= 100 and float(np.std(picked[:, 0] - picked[:, 2])) < 4 and float(np.std(picked[:, 0] - picked[:, 1])) < 4


def regraded(picture, frame, free):
    """The room's colour picture in this frame's black and white: each channel a straight-line fit of the picture's
    brightness, from what's showing."""
    luma = cv2.cvtColor(picture, cv2.COLOR_RGB2GRAY).astype(np.float32)
    out = np.zeros(picture.shape, np.uint8)
    for channel in range(3):
        gain, offset = np.polyfit(luma[free][::29], frame[..., channel][free][::29].astype(np.float32), 1)
        out[..., channel] = (gain * luma + offset).clip(0, 255).astype(np.uint8)
    return out


def closed_up(frame, mask):
    """A frame that isn't the room at all (the channel's white flash between two shots): the words closed from what's round them."""
    ys, xs = np.nonzero(mask)
    a, b, c, d = max(0, xs.min() - 8), min(mask.shape[1], xs.max() + 9), max(0, ys.min() - 8), min(mask.shape[0], ys.max() + 9)
    out = np.array(frame)
    out[c:d, a:b] = cv2.inpaint(np.ascontiguousarray(frame[c:d, a:b]), (mask[c:d, a:b] > 0).astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)
    return out


def solid(boxes, y0, rows, W):
    out = np.zeros((rows, W), bool)
    for x0, by0, x1, by1 in boxes:
        out[max(0, int(by0 - y0 - PAD)):max(0, int(by1 - y0 + PAD)), max(0, int(x0 - PAD)):int(x1 + PAD)] = True
    return out


def clean(job):
    W, H, fps = int(job["width"]), int(job["height"]), float(job["fps"])
    found = json.load(open(job["found"]))
    masks = job["masks"]
    # A box far from where this file's captions come up is a title or a screen read as one: left alone, and the strip
    # stays the height of the captions.
    caps = caps_of(found)
    where = place_of(caps)
    if where is not None:
        inside = lambda box: where[0] - 40 <= (box[0] + box[2]) / 2 <= where[2] + 40 and where[1] - 40 <= (box[1] + box[3]) / 2 <= where[3] + 40
        if sum(inside(m[2:6]) for m in caps) >= 0.9 * len(caps):
            masks = [[box for box in boxes if inside(box)] for boxes in masks]
    total = len(masks)
    band = worker.band_of(masks, W, H)
    if band is None:
        return {"still": True, "box": None, "inferred": 0}
    y0, y1 = band
    rows = y1 - y0
    scale = H / 1080
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
        ref, whole, sure, grain = min(shots, key=lambda one: float(np.median(np.abs(one[0].astype(np.int16) - small))))
        if not same_shot(ref.astype(np.int16), small):
            return {"still": False, "why": "another shot"}
        # The plate, on the stretch's rows (rows it doesn't reach hold no caption: checked above).
        plate = np.zeros((rows, W, 3), np.uint8)
        top, bottom = max(y0, span[0]), min(y1, span[1])
        # A pixel's commonest value can differ from its neighbour's by a whole step: a line or a speck here and there.
        plate[top - y0:bottom - y0] = cv2.medianBlur(whole, 5)[top - span[0]:bottom - span[0]]
        real = plate.copy()
        real[top - y0:bottom - y0] = cv2.medianBlur(grain, 5)[top - span[0]:bottom - span[0]]
        known = np.zeros((rows, W), bool)
        known[top - y0:bottom - y0] = True
        trust = np.zeros((rows, W), bool)
        trust[top - y0:bottom - y0] = sure[top - span[0]:bottom - span[0]] >= 150
        certain = np.zeros((rows, W), bool)
        certain[top - y0:bottom - y0] = sure[top - span[0]:bottom - span[0]] >= 205

        nearby, seen = stretch_plate(job, masks, total, W, H, y0, y1, fps)
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
                free = known & ~own[at]
                gray = free.any() and is_gray(frame, free)
                if gray:
                    fill = filled(frame, regraded(plate, frame, free), trust, certain, m, scale, window, own, at, regraded(nearby, frame, free), seen, regraded(real, frame, free))
                elif free.any() and float((np.abs(frame.astype(np.int16) - plate.astype(np.int16)).sum(axis=2)[free] < 45).mean()) < 0.3:
                    fill = closed_up(frame, m)
                else:
                    fill = filled(frame, plate, trust, certain, m, scale, window, own, at, nearby, seen, real)
                strip.write(fill, worker.alpha_of(m, max(worker.FEATHER, int(round(9 * scale)))))
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
