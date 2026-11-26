# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["torch>=2.4,<2.8", "coremltools>=8.3", "numpy"]
# ///
"""LaMa as Core ML for a Mac (the ONNX of lama-onnx.py gets cut into 117 pieces by ONNX Runtime's Core ML provider,
which then fails to compile them: Nov 25, an M1 Air, error -14). Converted from the same rebuilt PyTorch LaMa with
`coremltools`, one fixed size per model and its Fourier tables built in, so Core ML gets one clean graph:

    uv run scripts/lama-coreml.py /tmp/edit-lama/coreml 1280x192 [WxH ...]

Writes lama-<W>x<H>.mlpackage for each size. On a Mac it then times each on the GPU and the processor, in full and
half precision (LaMa overflows in half: Nov 25 on CUDA), and prints how far each is from the original.
"""
import importlib.util
import platform
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("lama_onnx", here / "lama-onnx.py")
lama_onnx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lama_onnx)


class Fixed(nn.Module):
    """The rebuilt LaMa at one size, its tables held as constants: image [1,3,H,W] 0-1, mask [1,1,H,W] -> [1,3,H,W]."""

    def __init__(self, model, w, h):
        super().__init__()
        self.model = model
        ch, sh = lama_onnx.tables(h // 8, h // 8)
        cw, sw = lama_onnx.tables(w // 8, w // 16 + 1)
        for name, t in (("ch", ch), ("sh", sh), ("cw", cw), ("sw", sw)):
            self.register_buffer(name, t)

    def forward(self, image, mask):
        return self.model(image, mask, self.ch, self.sh, self.cw, self.sw)


def main(out: Path, sizes):
    import coremltools as ct

    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        model, original = lama_onnx.load(Path(tmp))
    for w, h in sizes:
        fixed = Fixed(model, w, h).eval()
        image = torch.rand(1, 3, h, w)
        mask = torch.zeros(1, 1, h, w)
        mask[..., h // 3: 2 * h // 3, 40: w - 40] = 1
        want = original(image, mask).numpy()
        traced = torch.jit.trace(fixed, (image, mask))
        for precision, tag in ((ct.precision.FLOAT32, "fp32"), (ct.precision.FLOAT16, "fp16")):
            started = time.time()
            ml = ct.convert(
                traced,
                inputs=[ct.TensorType(name="image", shape=(1, 3, h, w)), ct.TensorType(name="mask", shape=(1, 1, h, w))],
                outputs=[ct.TensorType(name="out")],
                convert_to="mlprogram",
                compute_precision=precision,
                minimum_deployment_target=ct.target.macOS13,
            )
            path = out / f"lama-{w}x{h}-{tag}.mlpackage"
            ml.save(str(path))
            print(f"{path.name}: converted in {time.time() - started:.0f} s", flush=True)
            if platform.system() != "Darwin":
                continue
            for units in (ct.ComputeUnit.CPU_AND_GPU, ct.ComputeUnit.ALL, ct.ComputeUnit.CPU_ONLY):
                try:
                    loaded = ct.models.MLModel(str(path), compute_units=units)
                    feed = {"image": image.numpy(), "mask": mask.numpy()}
                    loaded.predict(feed)
                    started = time.time()
                    for _ in range(5):
                        got = loaded.predict(feed)["out"]
                    took = (time.time() - started) / 5 * 1000
                    off = np.abs(got - want)
                    inside = off[0].max(0)[mask[0, 0].numpy() > 0]
                    print(f"  {tag} on {units.name}: {took:.0f} ms; off from the original inside the hole: mean "
                          f"{inside.mean() * 255:.3f}, max {off.max() * 255:.2f} levels", flush=True)
                except Exception as error:  # noqa: BLE001 - report and go on to the next
                    print(f"  {tag} on {units.name}: failed: {error}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: lama-coreml.py <out-dir> WxH [WxH ...]")
    main(Path(sys.argv[1]).expanduser(), [tuple(int(v) for v in one.split("x")) for one in sys.argv[2:]])
