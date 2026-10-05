"""TV footage: keep the main-camera shots (live play), drop the rest (close-ups, crowd, changeovers, side and
low cameras), before any GPU work.

  cuts    PySceneDetect's AdaptiveDetector (CUTS) on a 480 x 270 copy.
  court   per shot, 3 frames (15%, 50%, 85% in): TennisCourtDetector's points must form a whole court
          (dsa.scene.court.court_ok) seen by the main camera (dsa.scene.court.main_camera). Keep when all 3 pass,
          discard when none do.
  split   a shot where only some pass (a dissolve the cut detector missed, a zoom) is checked every STEP
          frames and cut where the view changes; views shorter than MIN_RUN_S join their neighbours.

Reads <video>/source.mp4; writes <video>/cuts/shots.json (every frame in exactly one shot: keep / discard,
with the reason) and a thumbnail per checked frame, court drawn green (passed) or red, to cuts/thumbs/.
Then the kept frames, back to back, to <video>/kept.mp4, and kept.json: the runs of source frames they are
({"fps", "pieces": [[first, end], ...]}). Everything after this step works on kept.mp4.

    modal run --detach src/dsa/gpu/app.py --videos federer_usopen/2015 --cuts   # on a T4, results back
    python -m dsa.gpu.cuts kept federer_usopen/2015          # kept.mp4 again from cuts/shots.json (ffmpeg only)
    python -m dsa.gpu.cuts review federer_usopen/2015        # http://127.0.0.1:8774, marks saved to cuts/review.json

The first hour of the 2015 US Open final: 26.5 min kept, 33.5 min discarded, checked by eye.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import cv2
import numpy as np

from dsa.ingest.projects import PROJECTS
from dsa.paths import video_dir
from dsa.scene.court import LINES, MIN_DEPTH, court_ok, main_camera

CUTS = {"adaptive_threshold": 2.0, "min_content_val": 5.0}
SAMPLES = (0.15, 0.5, 0.85)
STEP, MIN_RUN_S = 5, 1.0
PAGE = Path(__file__).with_name("cuts.html")


def probe(video: Path) -> tuple[float, int]:
    """(fps, frame count)."""
    s = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                            "stream=avg_frame_rate,nb_frames", "-of", "json", str(video)]))["streams"][0]
    num, den = map(int, s["avg_frame_rate"].split("/"))
    return num / den, int(s["nb_frames"])


def shots(video: Path, out: Path, n: int) -> list[tuple[int, int]]:
    """[(first frame, end frame)] between camera cuts, covering the whole video."""
    from scenedetect import SceneManager, open_video
    from scenedetect.detectors import AdaptiveDetector

    small = out / "proxy.mp4"
    if not small.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf", "scale=480:270", "-c:v", "libx264",
                        "-preset", "ultrafast", "-crf", "23", "-an", str(small)], check=True)
    if probe(small)[1] != n:
        raise ValueError(f"{small} has a different frame count; constant frame rate video needed")
    sm = SceneManager()
    sm.add_detector(AdaptiveDetector(**CUTS))
    sm.detect_scenes(open_video(str(small), backend="opencv"), show_progress=True)
    s = [(a.frame_num, b.frame_num) for a, b in sm.get_scene_list(start_in_scene=True)] or [(0, n)]
    assert s[0][0] == 0 and s[-1][1] == n
    return s


class Check:
    """The court test on one frame, with a thumbnail of what it saw."""

    def __init__(self, video: Path, thumbs: Path, device: str | None, min_depth: float = MIN_DEPTH):
        from dsa.gpu.models import Tcd

        self.tcd, self.cap, self.thumbs, self.min_depth = Tcd(device or "cuda"), cv2.VideoCapture(str(video)), thumbs, min_depth
        thumbs.mkdir(parents=True, exist_ok=True)

    def test(self, bgr: np.ndarray) -> tuple[bool, np.ndarray]:
        pts = self.tcd.locate(bgr)
        h, w = bgr.shape[:2]
        return bool(np.isfinite(pts).all() and court_ok(pts, (w, h)) and main_camera(pts, w, self.min_depth)), pts

    def at(self, f: int, name: str) -> bool:
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, bgr = self.cap.read()
        if not ok:
            return False
        good, pts = self.test(bgr)
        s = 320 / bgr.shape[1]
        img = cv2.resize(bgr, (320, round(bgr.shape[0] * s)), interpolation=cv2.INTER_AREA)
        if np.isfinite(pts).all():
            for a, b in LINES:
                cv2.line(img, tuple(np.int32(pts[a] * s)), tuple(np.int32(pts[b] * s)),
                         (0, 220, 0) if good else (0, 0, 255), 1, cv2.LINE_AA)
        cv2.imwrite(str(self.thumbs / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return good

    def every(self, a: int, b: int) -> list[bool]:
        """The test every STEP frames of [a, b)."""
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, a)
        flags = []
        for f in range(a, b):
            if (f - a) % STEP:
                self.cap.grab()
                continue
            ok, bgr = self.cap.read()
            flags.append(ok and self.test(bgr)[0])
        return flags


def runs(flags: list[bool], short: int) -> list[list]:
    """[flag, first index, end index] of each view, runs shorter than `short` merged into their neighbours."""
    raw: list[list] = []
    for i, v in enumerate(flags):
        if raw and raw[-1][0] == v:
            raw[-1][2] = i + 1
        else:
            raw.append([v, i, i + 1])
    out: list[list] = []
    for r in raw:
        if out and (r[2] - r[1] < short or out[-1][0] == r[0]):
            out[-1][2] = r[2]
        else:
            out.append(r)
    if len(out) > 1 and out[0][2] - out[0][1] < short:
        out[1][1] = out[0][1]
        out = out[1:]
    return out


def run(spec: str, device: str | None = None) -> dict:
    video, out = video_dir(spec) / "source.mp4", video_dir(spec) / "cuts"
    out.mkdir(parents=True, exist_ok=True)
    fps, n = probe(video)
    project, name = spec.split("/")
    check = Check(video, out / "thumbs", device, PROJECTS[project].get("min_depth", {}).get(name, MIN_DEPTH))
    rows = []
    for k, (a, b) in enumerate(shots(video, out, n)):
        fs = sorted({a + int((b - a - 1) * q) for q in SAMPLES})
        oks = [check.at(f, f"{k:04d}_{j}") for j, f in enumerate(fs)]
        row = {"shot": k, "start_frame": a, "end_frame": b, "samples": fs, "court_in_view": oks,
               "thumbs": [f"{k:04d}_{j}" for j in range(len(fs))]}
        if all(oks) or not any(oks):
            rows.append({**row, "label": "keep" if all(oks) else "discard",
                         "reason": f"main court view in {sum(oks)} of {len(oks)} sampled frames"})
            continue
        steps = list(range(a, b, STEP))
        flags = check.every(a, b)
        views = runs(flags, int(MIN_RUN_S * fps / STEP))
        for p, (v, i0, i1) in enumerate(views):
            p0, p1 = (a if p == 0 else steps[i0]), (b if p == len(views) - 1 else steps[i1])
            name = f"{k:04d}_split{p}"
            check.at((p0 + p1) // 2, name)
            hits = sum(flags[i0:i1])
            rows.append({"shot": k, "piece": p, "start_frame": p0, "end_frame": p1, "samples": [(p0 + p1) // 2],
                         "court_in_view": [bool(v)], "thumbs": [name], "label": "keep" if v else "discard",
                         "reason": f"split from shot #{k}: {'main' if v else 'no main'} court view in "
                                   f"{hits if v else i1 - i0 - hits} of {i1 - i0} frames checked"})
    assert all(r["start_frame"] == q["end_frame"] for q, r in zip(rows, rows[1:])) and rows[-1]["end_frame"] == n
    manifest = {"video": "source.mp4", "fps": fps, "frames": n, "shots": rows,
                "method": {"cuts": CUTS, "samples": SAMPLES, "split": {"step": STEP, "min_run_s": MIN_RUN_S}}}
    (out / "shots.json").write_text(json.dumps(manifest, indent=1))
    for lab in ("keep", "discard"):
        s = [r for r in rows if r["label"] == lab]
        print(f"{lab:8s} {len(s):4d} shots, {sum(r['end_frame'] - r['start_frame'] for r in s) / fps / 60:5.1f} min")
    kept(spec)
    return manifest


def _any(terms: list[str]) -> str:
    """a+b+c+... nested as a balanced tree: ffmpeg's expression parser fails on a flat sum of ~100 terms."""
    return terms[0] if len(terms) == 1 else f"({_any(terms[:len(terms) // 2])}+{_any(terms[len(terms) // 2:])})"


def kept_pieces(manifest: dict) -> list[list[int]]:
    """[[first, end]] runs of kept source frames (adjacent kept shots joined)."""
    out: list[list[int]] = []
    for s in manifest["shots"]:
        if s["label"] == "keep":
            if out and out[-1][1] == s["start_frame"]:
                out[-1][1] = s["end_frame"]
            else:
                out.append([s["start_frame"], s["end_frame"]])
    return out


def kept(spec: str) -> Path:
    """kept.mp4: the kept frames of source.mp4, back to back; kept.json: which source frames they are."""
    d = video_dir(spec)
    m = json.loads((d / "cuts/shots.json").read_text())
    pieces = kept_pieces(m)
    if not pieces:
        raise SystemExit(f"{spec}: no shot kept (cuts/thumbs shows what the court check saw)")
    keep = _any([f"between(n,{a},{b - 1})" for a, b in pieces])
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(d / "source.mp4"), "-vf", f"select='{keep}',setpts=N/FRAME_RATE/TB",
                    "-an", "-c:v", "libx264", "-crf", "18",
                    "-preset", "veryfast", str(d / "kept.mp4")], check=True)
    (d / "kept.json").write_text(json.dumps({"fps": m["fps"], "pieces": pieces}))
    return d / "kept.mp4"


def serve(spec: str, port: int) -> None:
    """Review page: every shot by call, its checked frames, the shot playable, marks saved to review.json."""
    out = video_dir(spec) / "cuts"
    manifest = json.loads((out / "shots.json").read_text())
    video, marks = video_dir(spec) / manifest["video"], out / "review.json"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/":
                return self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            if path == "/api/shots":
                data = {"manifest": manifest, "marks": json.loads(marks.read_text()) if marks.exists() else {}}
                return self._send(200, json.dumps(data).encode(), "application/json")
            if m := re.fullmatch(r"/thumbs/(\d{4}_(?:\d|split\d+))\.jpg", path):
                return self._send(200, (out / "thumbs" / f"{m.group(1)}.jpg").read_bytes(), "image/jpeg")
            if path == "/video.mp4":
                size = video.stat().st_size
                r = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
                lo, hi = 0, size - 1
                if r:
                    lo = int(r.group(1)) if r.group(1) else size - int(r.group(2))
                    hi = int(r.group(2)) if r.group(1) and r.group(2) else min(size - 1, lo + 8 * 2 ** 20)
                with open(video, "rb") as fh:
                    fh.seek(lo)
                    body = fh.read(hi - lo + 1)
                return self._send(206 if r else 200, body, "video/mp4",
                                  {"Accept-Ranges": "bytes", **({"Content-Range": f"bytes {lo}-{hi}/{size}"} if r else {})})
            self._send(404, b"", "text/plain")

        def do_POST(self):
            if urlsplit(self.path).path != "/api/marks":
                return self._send(404, b"", "text/plain")
            tmp = out / ".review.json.tmp"
            tmp.write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
            tmp.replace(marks)
            self._send(200, b"{}", "application/json")

    print(f"http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["kept", "review"])           # run: on Modal only (app.py --cuts)
    ap.add_argument("video", help="<project>/<video>")
    ap.add_argument("--port", type=int, default=8774)
    a = ap.parse_args()
    kept(a.video) if a.cmd == "kept" else serve(a.video, a.port)


if __name__ == "__main__":
    main()
