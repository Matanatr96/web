"""Short clips around hits, cropped on the hitter, joined into one video per group for the review pages: a page
seeks to each clip's start and loops to its end (serve it with dsa.pages.serve, which lets the browser seek).

    strip(project, rows, out)   rows: dicts with video, frame, side -> out (mp4) and the clips' times in it
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dsa.paths import video_dir

BEFORE, AFTER, SIZE, RATE = 1.0, 0.7, 360, 30       # seconds around the hit; square px; frames per second


def _pieces(spec: str) -> list[tuple[int, int]]:
    out, s = [], 0
    for a, b in json.loads((video_dir(spec) / "kept.json").read_text())["pieces"]:
        out.append((s, s + b - a))
        s += b - a
    return out


def _clip(project: str, r: dict, out: Path, players: dict, pieces: dict) -> tuple[float, float]:
    spec = f"{project}/{r['video']}"
    pl, fps = players[spec], players[spec]["fps"]
    lo, hi = next((a, b) for a, b in pieces[spec] if a <= r["frame"] < b)
    f0, f1 = max(lo, r["frame"] - int(BEFORE * fps)), min(hi, r["frame"] + int(AFTER * fps))
    end = 0 if r["side"] == "near" else 1
    bs = [pl["boxes"][f][end] for f in range(f0, f1) if pl["boxes"][f][end]]
    x0, y0 = min(b[0] for b in bs), min(b[1] for b in bs)
    x1, y1 = max(b[2] for b in bs), max(b[3] for b in bs)
    side = int(max(x1 - x0, y1 - y0) * 1.35) // 2 * 2
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{f0 / fps:.3f}", "-i",
                    str(video_dir(spec) / "kept.mp4"), "-frames:v", str(f1 - f0), "-an", "-vf",
                    f"pad=iw+{side}:ih+{side}:{side // 2}:{side // 2},crop={side}:{side}:{cx}:{cy},"
                    f"scale={SIZE}:{SIZE},fps={RATE}",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", str(out)],
                   check=True)
    return round((f1 - f0) / fps * RATE) / RATE, (r["frame"] - f0) / fps


def strip(project: str, rows: list[dict], out: Path) -> list[dict]:
    """One video of a clip per row, in order; returns per row its start, end and hit time in that video."""
    specs = {f"{project}/{r['video']}" for r in rows}
    players = {s: json.loads((video_dir(s) / "players.json").read_text()) for s in specs}
    pieces = {s: _pieces(s) for s in specs}
    with tempfile.TemporaryDirectory() as tmp:
        parts = [Path(tmp) / f"{i:04d}.mp4" for i in range(len(rows))]
        with ThreadPoolExecutor(8) as ex:
            times = list(ex.map(lambda a: _clip(project, a[0], a[1], players, pieces), zip(rows, parts)))
        (Path(tmp) / "list.txt").write_text("".join(f"file '{p}'\n" for p in parts))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i",
                        str(Path(tmp) / "list.txt"), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                        "-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], check=True)
    t, items = 0.0, []
    for r, (dur, hit) in zip(rows, times):
        items.append(r | {"start": round(t, 3), "end": round(t + dur, 3), "hit": round(t + hit, 3)})
        t += dur
    return items
