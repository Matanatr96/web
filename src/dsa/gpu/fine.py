"""Step 2b: the near-end player's skeleton at the upload's own frame rate (50 / 60 fps) around every near-end hit,
for the stroke measures: 17-20 ms between frames instead of 33-40. The rest of the pipeline runs at 25 / 30 fps.

  clip   laptop: from the whole upload (raw/<project>/<id>.mp4), PAD seconds either side of each near-end hit,
         each window read after its own seek,
         inside its kept piece, overlapping windows joined, at the upload's frame rate -> <video>/fine.mp4, and
         fine.json: per frame of fine.mp4 its frame number in the upload's window (from the video's start second,
         the frame numbering of source.mp4 times `ratio`) and the tracked near player's box there (players.json,
         at the nearest 25 / 30 fps frame), to find him by.
  pose   Modal (gpu.py --fine): RF-DETR people on every frame of fine.mp4, the box overlapping the tracked
         player's most (IoU at least MIN_IOU), RTMW-x on it -> <video>/fine.npz: kp (frames x 65 x 3, NaN where
         not found), box (frames x 4).

dsa.measure.technique uses fine.npz for the stroke skeletons where it exists.

    python -m dsa.gpu.fine clip atp_hardcourt/2024_ao_sinner_medvedev
    modal run src/dsa/gpu/app.py --videos atp_hardcourt/2024_ao_sinner_medvedev --fine
"""
from __future__ import annotations

import argparse
import json
import subprocess

import numpy as np

from dsa.ingest.projects import PROJECTS
from dsa.paths import video_dir

PAD = 1.0                          # seconds either side of a hit (dsa.measure.technique uses -0.9 to +0.6)
MIN_IOU = 0.3                      # a detected box is the tracked player when it overlaps his box this much


def upload(spec: str) -> tuple[str, float, float]:
    """(the whole upload's path, the second the video's window starts at, its frame rate)."""
    from dsa.ingest.download import upload as path
    from dsa.video import info

    project, v = spec.split("/")
    full, at = path(spec), PROJECTS[project]["videos"][v][2]
    if not full.exists():
        raise SystemExit(f"{spec}: the whole upload {full} is missing (python -m dsa.ingest.download get downloads it)")
    return str(full), float(at or 0), info(str(full))[0]


def done(d) -> bool:
    """Step 2b has run on the video in folder d, or had nothing to add (a 25 / 30 fps upload)."""
    j = d / "fine.json"
    return (d / "fine.npz").exists() or bool(j.exists() and json.loads(j.read_text()).get("same"))


def windows(hits: list[dict], pieces: list[list[int]], ratio: float, pad: int) -> list[list[int]]:
    """[first, end) upload frames around each near-end hit, pad either side, inside the hit's kept piece
    (source frames [a, b)); windows that overlap within a piece joined."""
    wins: list[list[int]] = []
    for h in sorted((h for h in hits if h["side"] == "near"), key=lambda h: h["source_frame"]):
        a, b = next((a, b) for a, b in pieces if a <= h["source_frame"] < b)
        c, lo, hi = round(h["source_frame"] * ratio), int(np.ceil(a * ratio)), int(b * ratio)
        w = [max(lo, c - pad), min(hi, c + pad + 1)]
        if wins and w[0] <= wins[-1][1] and wins[-1][0] >= lo:              # overlaps the last, same piece
            wins[-1][1] = max(wins[-1][1], w[1])
        else:
            wins.append(w)
    return wins


def clip(spec: str) -> dict:
    d = video_dir(spec)
    pl = json.loads((d / "players.json").read_text())
    hits = json.loads((d / "strokes/strokes.json").read_text())["hits"]
    pieces = json.loads((d / "kept.json").read_text())["pieces"]           # source frames [a, b) kept
    full, at, fps = upload(spec)
    ratio = fps / pl["fps"]                                                  # upload frames per source frame
    if ratio < 1.5:                                                          # 25 / 30 fps upload: step 2 had them all
        (d / "fine.mp4").unlink(missing_ok=True)
        (d / "fine.json").write_text(json.dumps({"same": True, "fps": fps}))
        print(f"{spec}: the upload is {fps:.0f} fps, as step 2 ran; nothing to add", flush=True)
        return {"same": True}
    starts = np.cumsum([0] + [b - a for a, b in pieces])                     # kept frame of each piece's start
    wins = windows(hits, pieces, ratio, int(round(PAD * fps)))
    frames = np.concatenate([np.arange(a, b) for a, b in wins])

    def kept(s: float) -> int | None:                                      # source frame -> kept frame
        k = int(round(s))
        for (a, b), s0 in zip(pieces, starts):
            if a <= k < b:
                return int(s0 + k - a)
        return None

    targets = []
    for n in frames:
        k = kept(n / ratio)
        targets.append(pl["boxes"][k][0] if k is not None and k < len(pl["boxes"]) else None)
    extract(full, at, fps, wins, d / "fine.mp4")
    meta = {"fps": fps, "ratio": ratio, "windows": wins, "frames": frames.tolist(), "targets": targets}
    (d / "fine.json").write_text(json.dumps(meta))
    print(f"{spec}: {len(wins)} windows, {len(frames)} frames at {fps:.0f} fps "
          f"({len(frames) / fps / 60:.1f} min)", flush=True)
    return meta


def extract(full: str, at: float, fps: float, wins: list[list[int]], out) -> None:
    """Frames [a, b) of each window (numbered from second `at` of the upload) back to back into `out`: each
    window read on its own after a seek (a select filter over the whole window decoded all of it: an hour for
    one match on the laptop)."""
    from dsa.video import info

    _, w, h = info(full)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                            "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
                            "-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)
    for a, b in wins:
        # a seek to half a frame past a gives frame a as the select filter numbered it (12 windows checked:
        # the same frames)
        dec = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{at + (a + 0.5) / fps:.6f}", "-i", full,
                              "-frames:v", str(b - a), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                             capture_output=True, check=True).stdout
        if len(dec) != (b - a) * w * h * 3:
            raise RuntimeError(f"window {a}-{b}: {len(dec) // (w * h * 3)} frames decoded, {b - a} wanted")
        enc.stdin.write(dec)
    enc.stdin.close()
    if enc.wait():
        raise RuntimeError("encoding fine.mp4 failed")


def iou(a: np.ndarray, b: list) -> np.ndarray:
    """IoU of boxes a (n, 4+) with box b."""
    x1, y1 = np.maximum(a[:, 0], b[0]), np.maximum(a[:, 1], b[1])
    x2, y2 = np.minimum(a[:, 2], b[2]), np.minimum(a[:, 3], b[3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    return inter / ((a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def pose(spec: str, device: str = "cuda", batch: int = 16) -> dict:
    """On the GPU (Modal): the tracked near player's box and skeleton in every frame of fine.mp4 -> fine.npz."""
    from dsa.gpu.models import KP, Detector, Pose
    from dsa.video import frames

    d = video_dir(spec)
    meta = json.loads((d / "fine.json").read_text())
    targets, n = meta["targets"], len(meta["targets"])
    det, ske = Detector(device), Pose(device)
    kp = np.full((n, len(KP), 3), np.nan, np.float32)
    box = np.full((n, 4), np.nan, np.float32)
    pend: list[np.ndarray] = []
    i = 0

    def run():
        nonlocal i
        crops, at = [], []
        for f, b in zip(pend, det.people(pend)):
            t = targets[i]
            if t is not None and len(b):
                o = iou(b, t)
                if o.max() >= MIN_IOU:
                    box[i] = b[int(o.argmax()), :4]
                    crops.append(ske.prepare(f, box[i]))
                    at.append(i)
            i += 1
        for j, k in zip(at, ske.run(crops) if crops else []):
            kp[j] = k
        pend.clear()

    for f in frames(str(d / "fine.mp4"), n):
        pend.append(f)
        if len(pend) == batch:
            run()
    if pend:
        run()
    np.savez_compressed(d / "fine.npz", kp=kp, box=box)
    return {"frames": n, "found": int(np.isfinite(box[:, 0]).sum())}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["clip"])
    ap.add_argument("video", help="<project>/<video>")
    a = ap.parse_args()
    clip(a.video)
