"""Export WASB-SBDT (HRNet, its tennis weights) to a Core ML mlprogram for the iPhone's Neural Engine.

    uv run python tools/convert_wasb_coreml.py                  # data/code/wasb -> ios/TennisVision/Resources/

  weights   <wasb>/pretrained_weights/wasb_tennis_best.pth.tar (MODEL_ZOO.md, Google Drive
            14AeyIOCQ2UaQmbZLNQJa1H_eSwxUXk7z), loaded with strict=True: every tensor must match the HRNet.
  inputs    frame_t0, frame_t1, frame_t2: RGB images, 512 x 288 (CoreML ImageType, scale 1/255), oldest first.
            ImageNet normalisation is baked into the graph, so the app hands over camera pixel buffers as is.
  output    heatmaps (1, 3, 288, 512) float16 probabilities (sigmoid baked in): channel k is frame_tk, so one
            pass covers three frames (step=3, as WASB is trained and evaluated). Ball = heaviest blob > 0.5.
  format    mlprogram, FP16 compute, iOS 17 target; MODEL_CARD.md written next to it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
DEFAULT_WASB = REPO / "data/code/wasb"
DEFAULT_OUT = REPO / "ios/TennisVision/Resources/wasb_fp16.mlpackage"
H, W = 288, 512
MEAN, STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)


class _AttrDict(dict):
    """The OmegaConf access WASB's HRNet expects: keys as attributes too (as dsa.gpu.models)."""

    __getattr__ = dict.__getitem__

    @classmethod
    def wrap(cls, v):
        return cls({k: cls.wrap(x) for k, x in v.items()}) if isinstance(v, dict) else v


def load_wasb(wasb: Path, weights: Path):
    """WASB's HRNet with the tennis weights, strict=True, in eval mode (FP32, CPU)."""
    import torch
    import yaml

    sys.path.insert(0, str(wasb / "src"))
    from models import build_model

    cfg = yaml.safe_load(open(wasb / "src/configs/model/wasb.yaml"))
    model = build_model({"model": _AttrDict.wrap(cfg)})
    state = torch.load(weights, map_location="cpu", weights_only=False)
    state = state.get("model_state_dict", state)
    missing, unexpected = model.load_state_dict({k.removeprefix("module."): v for k, v in state.items()}, strict=True)
    assert not missing and not unexpected
    return model.eval()


def wrapper(model):
    """frame_t0..2 (1, 3, 288, 512) RGB in [0, 1] -> heatmaps (1, 3, 288, 512) probabilities."""
    import torch
    from torch import nn

    class WasbStep3(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m
            self.register_buffer("mean", torch.tensor(MEAN).view(1, 3, 1, 1))
            self.register_buffer("std", torch.tensor(STD).view(1, 3, 1, 1))

        def forward(self, f0, f1, f2):
            x = torch.cat([(f - self.mean) / self.std for f in (f0, f1, f2)], 1)
            return torch.sigmoid(self.m(x)[0])

    return WasbStep3(model).eval()


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def convert(wasb: Path, weights: Path, out: Path) -> dict:
    import coremltools as ct
    import torch

    net = wrapper(load_wasb(wasb, weights))
    ex = tuple(torch.rand(1, 3, H, W) for _ in range(3))
    with torch.no_grad():
        traced = torch.jit.trace(net, ex)
        ref = net(*ex)
    assert tuple(ref.shape) == (1, 3, H, W), ref.shape
    ml = ct.convert(
        traced,
        inputs=[ct.ImageType(name=f"frame_t{k}", shape=(1, 3, H, W), scale=1 / 255.0,
                             color_layout=ct.colorlayout.RGB) for k in range(3)],
        outputs=[ct.TensorType(name="heatmaps", dtype=np.float16)],
        convert_to="mlprogram", compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.iOS17)
    meta = {"step": "3", "heads": "frame_t0,frame_t1,frame_t2", "threshold": "0.5", "input": "RGB 512x288",
            "weights": weights.name, "weights_sha256": sha256(weights), "normalisation": "ImageNet (baked in)"}
    ml.author = "NTT WASB-SBDT (MIT), converted by tennis-vision tools/convert_wasb_coreml.py"
    ml.license = "MIT (WASB-SBDT)"
    ml.short_description = "WASB-SBDT tennis ball heatmaps, 3 frames in, 3 heatmaps out (step=3)"
    ml.user_defined_metadata.update(meta)
    out.parent.mkdir(parents=True, exist_ok=True)
    ml.save(str(out))
    spec = ml.get_spec()
    info = {"inputs": [(i.name, list(i.type.imageType.height for _ in [0]) + [i.type.imageType.width])
                       for i in spec.description.input],
            "outputs": [(o.name, list(o.type.multiArrayType.shape)) for o in spec.description.output],
            "spec_version": spec.specificationVersion, "metadata": meta}
    return info


def model_card(out: Path, info: dict, validation: dict | None = None) -> Path:
    card = out.parent / "MODEL_CARD.md"
    v = json.dumps(validation, indent=2) if validation else "not run yet: `uv run python tools/validate_coreml.py`"
    card.write_text(f"""# wasb_fp16.mlpackage

WASB-SBDT (Tarashima et al., "Widely Applicable Strong Baseline for Sports Ball Detection and Tracking",
BMVC 2023; NTT, MIT licence) with its tennis weights `{info['metadata']['weights']}`
(sha256 `{info['metadata']['weights_sha256']}`), converted by `tools/convert_wasb_coreml.py`.

| | |
|---|---|
| Inputs | `frame_t0`, `frame_t1`, `frame_t2`: RGB images 512 x 288, oldest first (ImageNet normalisation baked in) |
| Output | `heatmaps`: (1, 3, 288, 512) float16 probabilities (sigmoid baked in); channel k is `frame_tk` |
| Use | step=3: non-overlapping triplets, all 3 heads read; ball = heaviest blob > 0.5, weighted centroid |
| Format | mlprogram, FP16, iOS 17+, intended for the Neural Engine |
| Trained on | TrackNet tennis dataset (broadcast, 1280 x 720); phone footage from behind the court is new to it |

Spec: `{json.dumps({k: info[k] for k in ('inputs', 'outputs', 'spec_version')})}`

## Validation (`tools/validate_coreml.py`)

```json
{v}
```
""")
    return card


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wasb", type=Path, default=DEFAULT_WASB)
    ap.add_argument("--weights", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    a = ap.parse_args(argv)
    weights = a.weights or a.wasb / "pretrained_weights/wasb_tennis_best.pth.tar"
    info = convert(a.wasb, weights, a.out)
    (a.out.parent / "wasb_fp16.convert.json").write_text(json.dumps(info, indent=1))
    print(json.dumps(info, indent=1))
    print("wrote", a.out, model_card(a.out, info))


if __name__ == "__main__":
    main()
