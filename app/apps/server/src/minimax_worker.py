"""Their burned-in subtitles taken out of the picture on this computer's GPU (Sphe, Nov 19): MiniMax-Remover
(zibojia/minimax-remover, a 6-step distilled Wan DiT) run by text_inpaint.ts, one process kept alive so the model is
loaded once and sits in VRAM, serving one stretch at a time.

The protocol is JSON lines: a request on stdin, its answer on stdout (progress lines first, `"progress"`), the
model's own chatter on stderr. A request:

  {"id", "input": file or URL, "input_args": FFmpeg's arguments for it (a URL's), "beneath": the file's watermark
   strips over the stretch, laid on it first ([{"file", "from": its source second, "box": shares}]), "from": source seconds of its first frame, "frames": N, "fps", "width", "height",
   "matrix": "bt709" | "bt601", "masks": [[[x0, y0, x1, y1], ...] per frame] (their words' boxes, source pixels),
   "out": the strip's path, "ffmpeg": FFmpeg's path}

answers {"id", "ok": true, "box": [x0, y0, x1, y1] (shares), "inferred": frames run through the model, "seconds"}
or {"id", "ok": false, "error"}; with "masks" all empty, {"ok": true, "box": null}.

The strip is clean_strips.ts's stacked see-through video: the band their words sit in (the whole width; a band per
place when their words are far apart is one strip of the rows covering them all), picture over alpha, premultiplied,
the model's picture only inside each frame's mask, grown and feathered, the original everywhere else. Frames are
streamed in and out (a chunk at a time), stretches with no words skip the model, and chunks overlap by OVERLAP frames,
crossfaded, so a seam never pops.
"""

import json
import math
import os
import subprocess
import sys
import time

import numpy as np

# Freed blocks reused across chunk sizes (the band's height changes from stretch to stretch).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# The model's chunk (4k+1 frames) and its overlap with the next.
CHUNK = 61
OVERLAP = 5
# The widest picture the model is given (the band is scaled down to it), and the step its sides come in: 1024 is
# as clean as 1280 on Cuffed & Caught's outdoor clip and ~35% quicker (Nov 19).
PROC_WIDE = 1024
SIDE = 16
# Their words' boxes grown (source pixels at 1080 lines, scaled), and the alpha's feather.
PAD_X = 20
PAD_Y = 16
FEATHER = 5
# Steps of the distilled sampler: 4 can't be told from its 6 (frames 45, 120, 210 of the outdoor clip: a mean
# difference of 0.6 of 255, every line gone in both) and is ~20% quicker.
STEPS = 4


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def say(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


class Model:
    def __init__(self, models, repo, steps=STEPS, fp8=True):
        import torch

        sys.path.insert(0, repo)
        from diffusers.models import AutoencoderKLWan
        from diffusers.schedulers import UniPCMultistepScheduler
        import transformer_minimax_remover as tm

        self.torch = torch
        self.device = torch.device("cuda:0")
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        started = time.time()
        self.vae = AutoencoderKLWan.from_pretrained(os.path.join(models, "vae"), torch_dtype=torch.float16).to(self.device).eval()
        self.transformer = tm.Transformer3DModel.from_pretrained(os.path.join(models, "transformer"), torch_dtype=torch.float16).to(self.device).eval()
        self.vae.enable_tiling(tile_sample_min_height=512, tile_sample_min_width=512, tile_sample_stride_height=448, tile_sample_stride_width=448)
        self.scheduler = UniPCMultistepScheduler.from_pretrained(os.path.join(models, "scheduler"))
        # The rotary embedding in complex64, not complex128: a consumer GPU's float64 is 1/64 of its float32.
        rope = self.transformer.rope
        rope.freqs = rope.freqs.to(torch.complex64)
        for block in self.transformer.blocks:
            block.attn1.set_processor(Fp32Rotary(torch))
        if fp8:
            to_fp8(torch, self.transformer)
        cfg = self.vae.config
        self.mean = torch.tensor(cfg.latents_mean).view(1, cfg.z_dim, 1, 1, 1).to(self.device, torch.float16)
        self.inv_std = (1.0 / torch.tensor(cfg.latents_std)).view(1, cfg.z_dim, 1, 1, 1).to(self.device, torch.float16)
        self.scale_t = 2 ** sum(self.vae.temperal_downsample)
        self.scale_s = 2 ** len(self.vae.temperal_downsample)
        self.steps = steps
        log(f"minimax: loaded in {time.time() - started:.1f} s, {torch.cuda.memory_allocated() / 2**30:.2f} GB on the GPU")

    def vae_run(self, step):
        """A VAE step whole when it fits beside Edit, else in overlapping tiles (blended): the whole band at once can be
        over the ~5 GB this GPU has free with Edit and the desktop on it."""
        torch = self.torch
        try:
            self.vae.use_tiling = False
            return step()
        except torch.OutOfMemoryError:
            torch.cuda.empty_cache()
            self.vae.use_tiling = True
            return step()

    def infer(self, images, masks):
        """images: uint8 [F, h, w, 3] at the model's size; masks: bool [F, h, w]. The model's picture, uint8 [F, h, w, 3]."""
        torch = self.torch
        import torch.nn.functional as F

        with torch.inference_mode():
            frames, h, w = masks.shape
            img = torch.from_numpy(images).to(self.device).permute(3, 0, 1, 2).unsqueeze(0).half().div_(127.5).sub_(1.0)
            m = torch.from_numpy(masks.astype(np.uint8)).to(self.device).half()
            # Grown a little more at the model's size (MiniMax's own dilation, 3 px).
            m = (F.max_pool2d(m.unsqueeze(1), 7, stride=1, padding=3).squeeze(1) > 0).half()
            m = m.unsqueeze(0).unsqueeze(0)
            masked = img * (1.0 - m)
            # One encode at a time (both at once is twice the VAE's activations: over 8 GB at 1280×256×61).
            masked_latents = (self.vae_run(lambda: self.vae.encode(masked).latent_dist.mode()) - self.mean) * self.inv_std
            del masked, img
            mask_latents = (self.vae_run(lambda: self.vae.encode((2.0 * m - 1.0).expand(1, 3, frames, h, w)).latent_dist.mode()) - self.mean) * self.inv_std
            del m
            self.scheduler.set_timesteps(self.steps, device=self.device)
            gen = torch.Generator(device=self.device).manual_seed(42)
            lf = (frames - 1) // self.scale_t + 1
            x = torch.randn((1, 16, lf, h // self.scale_s, w // self.scale_s), generator=gen, device=self.device, dtype=torch.float16)
            for t in self.scheduler.timesteps:
                noise = self.transformer(hidden_states=torch.cat([x, masked_latents, mask_latents], dim=1), timestep=t.expand(1))[0]
                x = self.scheduler.step(noise, t, x, return_dict=False)[0]
            del noise, masked_latents, mask_latents
            torch.cuda.empty_cache()
            x = x / self.inv_std + self.mean
            video = self.vae_run(lambda: self.vae.decode(x, return_dict=False)[0])
            out = video[0].clamp(-1, 1).add(1).mul(127.5).round().byte().permute(1, 2, 3, 0).cpu().numpy()
        return out


def to_fp8(torch, transformer):
    """The transformer's linear layers kept in FP8 (e4m3, a scale per output row), turned back into fp16 a layer at a
    time as it runs: 1.1 GB on the GPU, not 2.2, so the model and the VAE both stay there beside Edit and the desktop."""
    import torch.nn as nn
    import torch.nn.functional as F

    class Fp8Linear(nn.Module):
        def __init__(self, linear):
            super().__init__()
            w = linear.weight.data.float()
            scale = (w.abs().amax(dim=1, keepdim=True) / 448.0).clamp(min=1e-12)
            self.register_buffer("weight8", (w / scale).to(torch.float8_e4m3fn))
            self.register_buffer("scale", scale.half())
            self.bias = linear.bias
            self.in_features, self.out_features = linear.in_features, linear.out_features

        def forward(self, x):
            return F.linear(x, self.weight8.to(x.dtype) * self.scale.to(x.dtype), self.bias)

    def swap(module):
        for name, child in list(module.named_children()):
            if isinstance(child, nn.Linear):
                setattr(module, name, Fp8Linear(child))
            else:
                swap(child)

    for block in transformer.blocks:
        swap(block)
    torch.cuda.empty_cache()


class Fp32Rotary:
    """MiniMax's attention, its rotary embedding applied in float32 (its own does float64)."""

    def __init__(self, torch):
        self.torch = torch

    def __call__(self, attn, hidden_states, rotary_emb=None, attention_mask=None, encoder_hidden_states=None):
        torch = self.torch
        import torch.nn.functional as F

        q = attn.to_q(hidden_states)
        k = attn.to_k(hidden_states)
        v = attn.to_v(hidden_states)
        if attn.norm_q is not None:
            q = attn.norm_q(q)
        if attn.norm_k is not None:
            k = attn.norm_k(k)
        q = q.unflatten(2, (attn.heads, -1)).transpose(1, 2)
        k = k.unflatten(2, (attn.heads, -1)).transpose(1, 2)
        v = v.unflatten(2, (attn.heads, -1)).transpose(1, 2)
        if rotary_emb is not None:
            def rotate(x):
                xr = torch.view_as_complex(x.float().unflatten(3, (-1, 2)))
                return torch.view_as_real(xr * rotary_emb).flatten(3, 4).type_as(x)

            q, k = rotate(q), rotate(k)
        out = F.scaled_dot_product_attention(q, k, v, attn_mask=None, dropout_p=0.0, is_causal=False)
        out = out.transpose(1, 2).flatten(2, 3).type_as(q)
        return attn.to_out[1](attn.to_out[0](out))


def step_up(value, step=SIDE):
    return int(math.ceil(value / step) * step)


def band_of(masks, width, height):
    """The rows their words' boxes (grown) cover, on even edges: (y0, y1), or None with none."""
    scale = height / 1080
    rows = [(y0, y1) for frame in masks for (_, y0, _, y1) in frame]
    if not rows:
        return None
    # Give tall boxes (watermarks/logos) generous unmasked context above and below so the model sees surrounding
    # texture (bricks, concrete) and the mask never slams into the band's top/bottom edges unfeathered (Nov 19).
    tallest = max(r[1] - r[0] for r in rows)
    pad = max((PAD_Y + 24) * scale, min(140 * scale, 0.55 * tallest))
    y0 = max(0, int(min(r[0] for r in rows) - pad))
    y1 = min(height, int(math.ceil(max(r[1] for r in rows) + pad)))
    # At least 160 lines at 1080 of context round the words (the model fills from what's around), on even rows.
    least = int(160 * scale)
    if y1 - y0 < least:
        grow = least - (y1 - y0)
        y0 = max(0, y0 - grow // 2)
        y1 = min(height, y0 + least)
        y0 = max(0, y1 - least)
    y0 -= y0 % 2
    y1 += y1 % 2
    return y0, min(y1, height - height % 2)


def mask_frame(frame_rgb, boxes, y0, scale):
    """The mask of one frame's band (uint8, 255 = theirs): each subtitle box grown and extended along its row to a
    dash or stop beside it; tall marked logo/watermark boxes keep tight padding without sideways colour-grabbing
    (Nov 19: subtitle padding + HSV search on a 230 px ARRESTFLIX box grabbed surrounding bricks and hit the band edges)."""
    import cv2

    bh, bw = frame_rgb.shape[:2]
    m = np.zeros((bh, bw), dtype=np.uint8)
    if not boxes:
        return m
    hsv = None
    glyph = None
    for x0, by0, x1, by1 in boxes:
        line = by1 - by0
        bx0, bx1 = int(x0), int(math.ceil(x1))
        if line > 95 * scale:
            # Tall watermark/logo box: already drawn around the mark — keep padding tight so MiniMax has real context.
            px = 8 * scale
            py = 8 * scale
        else:
            if glyph is None:
                hsv = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2HSV)
                # Bold-coloured glyphs only (a cyan or yellow '-'): plain white beside a line is as often the picture's own (a vest's "POLICE").
                glyph = (hsv[:, :, 1] > 110) & (hsv[:, :, 2] > 100)
            ry0, ry1 = max(0, int(by0 - y0 - 4 * scale)), min(bh, int(math.ceil(by1 - y0 + 4 * scale)))
            if ry1 <= ry0:
                continue
            reach_l, reach_r = int(110 * scale), int(60 * scale)
            left = glyph[ry0:ry1, max(0, bx0 - reach_l):bx0]
            if left.size and left.any():
                cols = np.where(left.any(axis=0))[0]
                bx0 = max(0, bx0 - reach_l) + int(cols[0])
            right = glyph[ry0:ry1, bx1:min(bw, bx1 + reach_r)]
            if right.size and right.any():
                cols = np.where(right.any(axis=0))[0]
                bx1 = bx1 + int(cols[-1]) + 1
            px = PAD_X * scale + 0.3 * line
            py = PAD_Y * scale + 0.15 * line
        a, b = max(0, int(bx0 - px)), min(bw, int(math.ceil(bx1 + px)))
        c, d = max(0, int(by0 - y0 - py)), min(bh, int(math.ceil(by1 - y0 + py)))
        m[c:d, a:b] = 255
    return m


def alpha_of(mask, feather=FEATHER):
    import cv2

    k = feather * 2 + 1
    a = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (k, k), 0)
    return np.clip(a * 1.35, 0.0, 1.0)


class Frames:
    """The band of a stretch's frames, decoded once, in order (FFmpeg's pipe), with the file's watermark strips laid
    on it first (`beneath`: watermark_removal.ts's stacked, premultiplied strips), so the model starts from the
    picture with their watermark already out and never brings it back where their words were (Nov 19: ARRESTFLIX in
    the subtitle band of the Boyfriends intro came back under the cleaned words)."""

    def __init__(self, ffmpeg, input, start, frames, fps, width, y0, y1, matrix, input_args=(), height=1080, beneath=()):
        first = round(start * fps)
        seek = max(0.0, (first - 0.5) / fps)
        self.size = (y1 - y0) * width * 3
        self.shape = (y1 - y0, width, 3)
        self.y0, self.y1 = y0, y1
        args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{seek:.6f}"]
        args += list(input_args)
        args += [
            "-i", input, "-an", "-frames:v", str(frames),
            "-vf", f"setpts=PTS-STARTPTS,fps={fps:.6f},crop={width}:{y1 - y0}:0:{y0},scale=in_color_matrix={matrix}:in_range=tv,format=rgb24",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
        self.under = []
        for strip in beneath:
            x0, sy0, x1, sy1 = strip["box"]
            bx, by = int(round(x0 * width)), int(round(sy0 * height))
            bw, bh = max(2, int(round((x1 - x0) * width))), max(2, int(round((sy1 - sy0) * height)))
            # Only the rows of the band it reaches.
            top, bottom = max(by, y0), min(by + bh, y1)
            if bottom <= top:
                continue
            into = first / fps - float(strip["from"])
            reader = subprocess.Popen(
                [
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, into - 0.5 / fps):.6f}", "-i", strip["file"], "-an",
                    "-vf", f"setpts=PTS-STARTPTS,fps={fps:.6f},scale={bw}:{2 * bh}:in_color_matrix=bt709:in_range=tv,format=rgb24",
                    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
                ],
                stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            # Frames of the stretch before the strip starts (it starts later than the stretch).
            self.under.append({"proc": reader, "wait": max(0, int(round(-into * fps))), "size": 2 * bh * bw * 3, "bw": bw, "bh": bh, "bx": bx, "by": by, "rows": (top, bottom), "done": False})

    @staticmethod
    def _read(pipe, size):
        buf = bytearray()
        while len(buf) < size:
            part = pipe.read(size - len(buf))
            if not part:
                return None
            buf += part
        return bytes(buf)

    def read(self):
        raw = self._read(self.proc.stdout, self.size)
        if raw is None:
            return None
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(self.shape)
        if not self.under:
            return frame
        frame = frame.copy()
        for one in self.under:
            if one["wait"] > 0:
                one["wait"] -= 1
                continue
            if one["done"]:
                continue
            got = self._read(one["proc"].stdout, one["size"])
            if got is None:
                one["done"] = True
                continue
            stacked = np.frombuffer(got, dtype=np.uint8).reshape(2 * one["bh"], one["bw"], 3)
            picture, alpha = stacked[: one["bh"]], stacked[one["bh"] :, :, :1].astype(np.float32) / 255.0
            top, bottom = one["rows"]
            ry = slice(top - one["by"], bottom - one["by"])
            fy = slice(top - self.y0, bottom - self.y0)
            fx = slice(one["bx"], one["bx"] + one["bw"])
            base = frame[fy, fx].astype(np.float32)
            frame[fy, fx] = np.clip(picture[ry].astype(np.float32) + base * (1.0 - alpha[ry]) + 0.5, 0, 255).astype(np.uint8)
        return frame

    def close(self):
        self.proc.stdout.close()
        self.proc.wait()
        for one in self.under:
            one["proc"].stdout.close()
            one["proc"].kill()
            one["proc"].wait()


class Strip:
    """The stacked strip written as it goes (picture over alpha, premultiplied), as text_removal's strips were."""

    def __init__(self, ffmpeg, out, width, bh, fps):
        gop = str(max(1, round(fps / 2)))
        self.partial = out + ".partial.mp4"
        self.out = out
        self.proc = subprocess.Popen(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{bh * 2}", "-r", f"{fps:.6f}", "-i", "-",
                "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
                "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-g", gop, "-bf", "0",
                "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
                "-movflags", "+faststart", self.partial,
            ],
            stdin=subprocess.PIPE,
        )
        self.blank = np.zeros((bh * 2, width, 3), dtype=np.uint8)

    def write(self, picture, alpha):
        if alpha is None:
            self.proc.stdin.write(self.blank.tobytes())
            return
        a = alpha[..., None]
        top = np.clip(picture.astype(np.float32) * a + 0.5, 0, 255).astype(np.uint8)
        bottom = np.repeat(np.clip(alpha * 255 + 0.5, 0, 255).astype(np.uint8)[..., None], 3, axis=2)
        self.proc.stdin.write(np.concatenate([top, bottom], axis=0).tobytes())

    def finish(self):
        self.proc.stdin.close()
        if self.proc.wait() != 0:
            raise RuntimeError("FFmpeg couldn't write the strip")
        os.replace(self.partial, self.out)


# Maximum frames a box's mask holds onto adjacent unmasked frames when the pixels inside it haven't changed
# (catches OCR/mark timing slop on static shots so unmasked edge frames never leak the text back through the temporal model).
MAX_HOLD = 15


def _box_overlap(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    area_a = max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
    return inter / area_a


def hold_edges(window, window_boxes, y0):
    """Extends each box across adjacent unmasked frames while the pixels inside it stay unchanged (still the same
    text/logo), plus one same-shot transition frame for fades / slow-mo blends (Nov 19, Boyfriends intro: orange 'No'
    lingering 5 frames past a mark leaked back onto every masked frame in the 61-frame chunk)."""
    n = len(window)
    if n < 2:
        return window_boxes
    bh, bw = window[0].shape[:2]
    out = [list(bs) for bs in window_boxes]
    for i, boxes in enumerate(window_boxes):
        for box in boxes:
            rx0, rx1 = max(0, int(box[0])), min(bw, int(math.ceil(box[2])))
            ry0, ry1 = max(0, int(box[1] - y0)), min(bh, int(math.ceil(box[3] - y0)))
            if rx1 <= rx0 or ry1 <= ry0:
                continue
            ref = window[i][ry0:ry1, rx0:rx1].astype(np.float32)
            # Uniform/blank patches (spatial std < 12) aren't text or logos; never hold them across frames.
            if float(ref.std(axis=(0, 1)).max()) < 12.0:
                continue
            for step in (-1, 1):
                nxt = i + step
                if not (0 <= nxt < n) or any(_box_overlap(box, other) >= 0.5 for other in window_boxes[nxt]):
                    continue
                last = i
                for dist in range(1, MAX_HOLD + 1):
                    j = i + step * dist
                    if not (0 <= j < n) or any(_box_overlap(box, other) >= 0.5 for other in out[j]):
                        break
                    diff = np.abs(window[j][ry0:ry1, rx0:rx1].astype(np.float32) - ref)
                    if float(diff.mean()) < 5.0 and float(np.percentile(diff, 95)) < 25.0:
                        out[j].append(box)
                        last = j
                    else:
                        # One extra frame on the same shot catches 1-frame fades / 0.80x frame blends without crossing a hard cut.
                        shot_diff = float(np.abs(window[j].astype(np.float32) - window[last].astype(np.float32)).mean())
                        if shot_diff < 15.0:
                            out[j].append(box)
                        break
    return out


def clean(model, req, progress=lambda done, total: None):
    import cv2

    width, height, fps = int(req["width"]), int(req["height"]), float(req["fps"])
    masks = req["masks"]
    total = len(masks)
    band = band_of(masks, width, height)
    if band is None:
        return {"box": None, "inferred": 0}
    y0, y1 = band
    bh = y1 - y0
    scale = height / 1080
    # The model's size: the band scaled so it's at most PROC_WIDE across, sides in steps of 16.
    k = min(1.0, PROC_WIDE / width)
    pw, ph = step_up(width * k), step_up(bh * k)
    source = Frames(req["ffmpeg"], req["input"], float(req["from"]), total, fps, width, y0, y1, req.get("matrix", "bt709"), req.get("input_args", []), height, req.get("beneath", []))
    strip = Strip(req["ffmpeg"], req["out"], width, bh, fps)
    inferred = 0
    try:
        # A window of frames (the chunk being cleaned and the overlap kept from the last), their masks, and what came out.
        window, window_boxes = [], []
        written = 0
        held = None  # the last chunk's picture of the overlap frames (model size, uint8), crossfaded into the next
        next_frame = 0
        while written < total:
            while len(window) < CHUNK and next_frame < total:
                frame = source.read()
                if frame is None:
                    # The file ended early: the rest is the original (see-through).
                    total = next_frame
                    break
                window.append(frame)
                window_boxes.append(masks[next_frame])
                next_frame += 1
            if not window:
                break
            count = len(window)
            last = next_frame >= total
            keep = count if last else count - OVERLAP
            eff_boxes = hold_edges(window, window_boxes, y0)
            window_masks = [mask_frame(frame, bs, y0, scale) for frame, bs in zip(window, eff_boxes)]
            any_mask = any(m.any() for m in window_masks)
            if any_mask:
                pad = (4 - ((count - 1) % 4)) % 4
                imgs = [cv2.resize(f, (pw, ph), interpolation=cv2.INTER_AREA) for f in window] + [None] * pad
                ms = [cv2.resize(m, (pw, ph), interpolation=cv2.INTER_NEAREST) > 0 for m in window_masks] + [None] * pad
                for i in range(count, count + pad):
                    imgs[i], ms[i] = imgs[count - 1], ms[count - 1]
                out = model.infer(np.stack(imgs), np.stack(ms))[:count]
                inferred += count
                if held is not None:
                    for i in range(len(held)):
                        w = (i + 1) / (len(held) + 1)
                        out[i] = np.clip(held[i].astype(np.float32) * (1 - w) + out[i].astype(np.float32) * w + 0.5, 0, 255).astype(np.uint8)
            else:
                out = None
            for i in range(keep):
                m = window_masks[i]
                if out is None or not m.any():
                    strip.write(None, None)
                else:
                    picture = cv2.resize(out[i], (width, bh), interpolation=cv2.INTER_CUBIC)
                    feather = max(FEATHER, int(round(10 * scale))) if any((b[3] - b[1]) > 95 * scale for b in eff_boxes[i]) else FEATHER
                    alpha = alpha_of(m, feather)
                    # The original outside the mask (premultiplied, so only what's inside counts).
                    strip.write(picture, alpha)
            written += keep
            progress(written, total)
            held = None if out is None or last else out[keep:count].copy()
            window, window_boxes = window[keep:], eff_boxes[keep:]
            if last:
                break
        # Frames never decoded (the file ended early) stay see-through, so the strip keeps its length.
        while written < len(masks):
            strip.write(None, None)
            written += 1
        strip.finish()
    finally:
        source.close()
        if strip.proc.poll() is None:
            strip.proc.kill()
    return {"box": [0.0, y0 / height, 1.0, y1 / height], "inferred": inferred}


def serve(models, repo, steps):
    model = Model(models, repo, steps)
    say({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        started = time.time()
        try:
            last = [0.0]

            def progress(done, total):
                if time.time() - last[0] > 5:
                    last[0] = time.time()
                    say({"id": req["id"], "progress": done / max(1, total)})

            result = clean(model, req, progress)
            say({"id": req["id"], "ok": True, **result, "seconds": round(time.time() - started, 1)})
        except Exception as error:  # noqa: BLE001 — every failure is said, the worker lives on
            log(f"minimax: {req.get('id')}: {error!r}")
            say({"id": req["id"], "ok": False, "error": str(error)[:400]})
        finally:
            model.torch.cuda.empty_cache()


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--steps", type=int, default=STEPS)
    args = ap.parse_args()
    serve(args.models, args.repo, args.steps)
