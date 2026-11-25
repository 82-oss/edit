# /// script
# requires-python = ">=3.10"
# dependencies = ["torch>=2.4", "onnx>=1.16", "numpy"]
# ///
"""LaMa for the engine's caption clean (crates/edit-engine/src/caption/lama.rs), built from LaMa's own code and weights
(Apache-2.0, Suvorov et al. 2021):

    uv run scripts/lama-onnx.py ~/.local/share/edit-remover/lama-v1.onnx

Its Fourier transforms are matrix products whose cos/sin tables are inputs (lama.rs makes them for each picture size;
all 18 Fourier units work at 1/8 of it), so the graph is only convolutions, matrix products and plain arithmetic and
runs on Core ML, CUDA or the processor at any size. Checked against the original before it's written (to within 0.01
of a level). Inputs: image [1,3,H,W] 0-1, mask [1,1,H,W] 1 = fill (H, W in eights); ch, sh [H/8, H/8];
cw, sw [W/8, W/16+1]. Output: out [1,3,H,W] 0-1.
"""
import hashlib
import math
import subprocess
import sys
import tempfile
import types
import urllib.request
from pathlib import Path

import torch
import torch.nn as nn

WEIGHTS = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt"
WEIGHTS_MD5 = "19970cd5673cd1326c70885ea2b5dbb8"
CODE = "https://github.com/advimman/lama.git"
CODE_COMMIT = "786f5936b27fb3dacd2b1ad799e4de968ea697e7"
T = {}  # the tables for the call in progress


def tables(n, k):
    """cos and sin of 2*pi*i*j/n, i < n, j < k, worked out exactly (i*j mod n) in double precision."""
    i = torch.arange(n, dtype=torch.float64)[:, None]
    j = torch.arange(k, dtype=torch.float64)[None, :]
    a = 2 * math.pi * torch.remainder(i * j, n) / n
    return torch.cos(a).float(), torch.sin(a).float()


def fourier_forward(self, x):
    """LaMa's FourierUnit with rfftn/irfftn (ortho) as matrix products, in full precision."""
    dt = x.dtype
    x = x.float()
    b = x.shape[0]
    ch, sh, cw, sw = (T[k] for k in ("ch", "sh", "cw", "sw"))
    re = x @ cw
    im = -(x @ sw)
    re, im = torch.matmul(ch, re) + torch.matmul(sh, im), torch.matmul(ch, im) - torch.matmul(sh, re)
    f = torch.stack((re, im), dim=2).reshape(b, -1, re.shape[-2], re.shape[-1])
    f = self.relu(self.bn(self.conv_layer((f * T["scale"]).to(dt)))).float()
    f = f.reshape(b, -1, 2, f.shape[-2], f.shape[-1])
    re, im = f[:, :, 0], f[:, :, 1]
    re, im = torch.matmul(ch, re) - torch.matmul(sh, im), torch.matmul(ch, im) + torch.matmul(sh, re)
    wgt = T["weight"]
    return (((re * wgt) @ cw.transpose(0, 1) - (im * wgt) @ sw.transpose(0, 1)) * T["scale"]).to(dt)


def main(out: Path):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        weights = tmp / "big-lama.pt"
        print("weights:", WEIGHTS)
        urllib.request.urlretrieve(WEIGHTS, weights)
        got = hashlib.md5(weights.read_bytes()).hexdigest()
        if got != WEIGHTS_MD5:
            sys.exit(f"the weights' md5 is {got}, not {WEIGHTS_MD5}")
        code = tmp / "lama"
        subprocess.run(["git", "clone", "-q", CODE, str(code)], check=True)
        subprocess.run(["git", "-C", str(code), "checkout", "-q", CODE_COMMIT], check=True)
        # What its modules import for training only.
        for name in ("kornia", "kornia.geometry", "kornia.geometry.transform"):
            sys.modules[name] = types.ModuleType(name)
        sys.modules["kornia.geometry.transform"].rotate = None
        lightning = types.ModuleType("pytorch_lightning")
        lightning.seed_everything = lambda *a, **k: None
        sys.modules["pytorch_lightning"] = lightning
        sys.path.insert(0, str(code))
        from saicinpainting.training.modules import ffc  # noqa: E402

        torch.set_grad_enabled(False)
        original = torch.jit.load(str(weights), map_location="cpu").eval()
        state = {k[len("model."):]: v for k, v in original.state_dict().items() if k.startswith("model.generator.")}
        ffc.FourierUnit.forward = fourier_forward

        class Lama(nn.Module):
            def __init__(self):
                super().__init__()
                self.generator = ffc.FFCResNetGenerator(
                    4, 3, ngf=64, n_downsampling=3, n_blocks=18, add_out_act="sigmoid",
                    init_conv_kwargs=dict(ratio_gin=0, ratio_gout=0, enable_lfu=False),
                    downsample_conv_kwargs=dict(ratio_gin=0, ratio_gout=0, enable_lfu=False),
                    resnet_conv_kwargs=dict(ratio_gin=0.75, ratio_gout=0.75, enable_lfu=False))

            def forward(self, image, mask, ch, sh, cw, sw):
                w8 = cw.shape[0]
                T.update(ch=ch, sh=sh, cw=cw, sw=sw)
                k = torch.arange(cw.shape[1])
                T["weight"] = torch.where((k == 0) | ((w8 % 2 == 0) & (k == w8 // 2)), 1.0, 2.0).to(cw.dtype)
                T["scale"] = torch.rsqrt((ch.shape[0] * w8) * torch.ones(1, dtype=cw.dtype))
                x = torch.cat([image * (1 - mask), mask], dim=1)
                return mask * self.generator(x) + (1 - mask) * image

        model = Lama().eval()
        model.load_state_dict(state)
        h, w = 200, 712
        image = torch.rand(1, 3, h, w)
        mask = torch.zeros(1, 1, h, w)
        mask[..., 60:120, 50:650] = 1
        ch, sh = tables(h // 8, h // 8)
        cw, sw = tables(w // 8, w // 16 + 1)
        args = (image, mask, ch, sh, cw, sw)
        off = float((original(image, mask) - model(*args)).abs().max() * 255)
        print(f"against the original: {off:.4f} of a level at most")
        if off > 0.01:
            sys.exit("the rebuilt model doesn't match the original")
        out.parent.mkdir(parents=True, exist_ok=True)
        partial = out.with_suffix(".partial")
        torch.onnx.export(
            model, args, str(partial), input_names=["image", "mask", "ch", "sh", "cw", "sw"], output_names=["out"],
            opset_version=17, dynamo=False,
            dynamic_axes={"image": {2: "h", 3: "w"}, "mask": {2: "h", 3: "w"}, "out": {2: "h", 3: "w"},
                          "ch": {0: "h8", 1: "h8b"}, "sh": {0: "h8", 1: "h8b"}, "cw": {0: "w8", 1: "k"}, "sw": {0: "w8", 1: "k"}})
        partial.rename(out)
        print("written:", out)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: lama-onnx.py <out.onnx>")
    main(Path(sys.argv[1]).expanduser())
