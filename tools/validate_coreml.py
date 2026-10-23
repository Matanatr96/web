"""Check the Core ML export against PyTorch before it ships to the phone.

    uv run python tools/validate_coreml.py [--video rally.mp4] [--frames 300]

  1. strict    the tennis weights load into WASB's HRNet with strict=True.
  2. fp16      the exported graph's arithmetic: the wrapper (normalisation + sigmoid baked in) in FP16 against FP32
               on the same triplets: max |heatmap difference| over all 3 heads < MAX_ABS (0.02), and the ball
               (heaviest blob > 0.5) found in the same frames, within AGREE_PX px at 512 x 288, in >= 99%.
  3. spec      the .mlpackage: an mlprogram, inputs frame_t0..2 (RGB 512 x 288), output heatmaps (1, 3, 288, 512)
               float16, step=3 metadata.
  4. coreml    on macOS only (Core ML runs nowhere else): the .mlpackage's own predictions against PyTorch FP32,
               same thresholds. Elsewhere reported as skipped; run it again on the Mac before shipping.
  Triplets: frames of --video when given (three consecutive frames per triplet, as the phone sees them), else
  a synthetic court with a moving ball. Results go into MODEL_CARD.md; exit status 1 when a check fails.
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert_wasb_coreml import DEFAULT_OUT, DEFAULT_WASB, H, W, load_wasb, model_card, wrapper  # noqa: E402

MAX_ABS, AGREE, AGREE_PX = 0.02, 0.99, 2.0


def blob(m: np.ndarray, threshold: float = 0.5):
    """(found, x, y) at 512 x 288: the heaviest blob above threshold, probability-weighted centroid."""
    import cv2

    if m.max() <= threshold:
        return False, 0.0, 0.0
    n, lab = cv2.connectedComponents((m > threshold).astype(np.uint8))
    best = max(range(1, n), key=lambda k: m[lab == k].sum())
    ys, xs = np.nonzero(lab == best)
    w = m[ys, xs]
    return True, float((xs * w).sum() / w.sum()), float((ys * w).sum() / w.sum())


def agreement(a: np.ndarray, b: np.ndarray) -> float:
    """Share of heatmaps (any head) where both find no ball, or both find it within AGREE_PX."""
    same = 0
    for x, y in zip(a.reshape(-1, H, W), b.reshape(-1, H, W), strict=True):
        fa, fb = blob(x), blob(y)
        same += (not fa[0] and not fb[0]) or (fa[0] and fb[0] and np.hypot(fa[1] - fb[1], fa[2] - fb[2]) <= AGREE_PX)
    return same / (len(a.reshape(-1, H, W)))


def synthetic_triplets(n: int, seed: int = 0) -> list[np.ndarray]:
    """n triplets (3, 288, 512, 3) uint8 RGB: a green court, white lines, an optic-yellow ball moving."""
    import cv2

    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        base = np.full((H, W, 3), (40, 110, 60), np.uint8)
        cv2.line(base, (120, 60), (392, 60), (235, 235, 235), 2)
        cv2.line(base, (30, 270), (482, 270), (235, 235, 235), 2)
        cv2.line(base, (120, 60), (30, 270), (235, 235, 235), 2)
        cv2.line(base, (392, 60), (482, 270), (235, 235, 235), 2)
        p, v = rng.uniform([60, 40], [450, 250]), rng.uniform(-12, 12, 2)
        tri = []
        for k in range(3):
            f = base.copy()
            c = (p + k * v).astype(int)
            cv2.circle(f, tuple(int(x) for x in c), 3, (220, 240, 60), -1, cv2.LINE_AA)
            tri.append(f)
        out.append(np.stack(tri))
    return out


def video_triplets(path: str, n: int) -> list[np.ndarray]:
    import cv2

    cap, frames = cv2.VideoCapture(path), []
    while len(frames) < 3 * n:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(cv2.resize(f, (W, H))[:, :, ::-1])
    return [np.stack(frames[i:i + 3]) for i in range(0, len(frames) - 2, 3)]


def torch_heatmaps(net, triplets, dtype="float32") -> np.ndarray:
    import torch

    m = net.to(getattr(torch, dtype))
    out = []
    with torch.no_grad():
        for tri in triplets:
            xs = [torch.from_numpy(f.astype(np.float32) / 255).permute(2, 0, 1)[None].to(m.mean.dtype) for f in tri]
            out.append(m(*xs).float().numpy()[0])
    net.float()
    return np.stack(out)


def check_spec(path: Path) -> dict:
    import coremltools as ct

    spec = ct.utils.load_spec(str(path))
    d = spec.description
    ins = {i.name: (i.type.WhichOneof("Type"), i.type.imageType.width, i.type.imageType.height) for i in d.input}
    outs = {o.name: (list(o.type.multiArrayType.shape), o.type.multiArrayType.dataType) for o in d.output}
    fp16 = ct.proto.FeatureTypes_pb2.ArrayFeatureType.FLOAT16
    ok = (spec.WhichOneof("Type") == "mlProgram"
          and all(ins.get(f"frame_t{k}") == ("imageType", W, H) for k in range(3))
          and outs.get("heatmaps") == ([1, 3, H, W], fp16)
          and d.metadata.userDefined.get("step") == "3")
    return {"ok": bool(ok), "type": spec.WhichOneof("Type"), "inputs": ins,
            "outputs": {k: [v[0], int(v[1])] for k, v in outs.items()}, "metadata": dict(d.metadata.userDefined)}


def coreml_heatmaps(path: Path, triplets) -> np.ndarray:
    import coremltools as ct
    from PIL import Image

    ml = ct.models.MLModel(str(path), compute_units=ct.ComputeUnit.ALL)
    return np.stack([ml.predict({f"frame_t{k}": Image.fromarray(t[k]) for k in range(3)})["heatmaps"][0]
                     for t in triplets]).astype(np.float32)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wasb", type=Path, default=DEFAULT_WASB)
    ap.add_argument("--weights", type=Path, default=None)
    ap.add_argument("--model", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--video", default=None)
    ap.add_argument("--frames", type=int, default=60, help="triplets to compare")
    a = ap.parse_args(argv)
    weights = a.weights or a.wasb / "pretrained_weights/wasb_tennis_best.pth.tar"
    res: dict = {}
    try:
        net = wrapper(load_wasb(a.wasb, weights))
        res["strict"] = {"ok": True}
    except (RuntimeError, AssertionError) as e:
        res["strict"] = {"ok": False, "error": str(e)[:300]}
        print(json.dumps(res, indent=1))
        return 1
    triplets = video_triplets(a.video, a.frames) if a.video else synthetic_triplets(a.frames)
    res["triplets"] = {"n": len(triplets), "source": a.video or "synthetic"}
    ref = torch_heatmaps(net, triplets, "float32")
    half = torch_heatmaps(net, triplets, "float16") if _half_ok() else None
    if half is not None:
        d = float(np.abs(half - ref).max())
        ag = agreement(half, ref)
        res["fp16"] = {"ok": d < MAX_ABS and ag >= AGREE, "max_abs": round(d, 5), "agreement": round(ag, 4),
                       "balls_found_fp32": int(sum(blob(m)[0] for m in ref.reshape(-1, H, W)))}
    else:
        res["fp16"] = {"ok": None, "skipped": "no FP16 convolutions on this CPU build of torch"}
    if a.model.exists():
        res["spec"] = check_spec(a.model)
        if platform.system() == "Darwin":
            cm = coreml_heatmaps(a.model, triplets)
            d = float(np.abs(cm - ref).max())
            ag = agreement(cm, ref)
            res["coreml"] = {"ok": d < MAX_ABS and ag >= AGREE, "max_abs": round(d, 5), "agreement": round(ag, 4)}
        else:
            res["coreml"] = {"ok": None, "skipped": f"Core ML predictions need macOS (this is {platform.system()})"}
    else:
        res["spec"] = {"ok": False, "error": f"{a.model} missing: run tools/convert_wasb_coreml.py"}
    print(json.dumps(res, indent=1))
    info_p = a.model.parent / "wasb_fp16.convert.json"
    if info_p.exists():
        model_card(a.model, json.loads(info_p.read_text()), res)
    return 0 if all(v.get("ok") is not False for v in res.values() if isinstance(v, dict) and "ok" in v) else 1


def _half_ok() -> bool:
    import torch

    if not (torch.cuda.is_available() or (hasattr(torch.backends, "mps") and torch.backends.mps.is_available())):
        return False
    try:
        torch.nn.functional.conv2d(torch.ones(1, 1, 4, 4, dtype=torch.float16), torch.ones(1, 1, 3, 3,
                                                                                      dtype=torch.float16))
        return True
    except RuntimeError:
        return False


if __name__ == "__main__":
    sys.exit(main())
