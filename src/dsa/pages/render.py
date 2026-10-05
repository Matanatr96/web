"""The overlay video, after step 4: each player's name and skeleton in their colour, the ball as a small dot,
and the latest stroke in words in the top left corner, in the hitter's colour, for HOLD seconds. Nobody else
is drawn.

--plain: the models' output alone on black, without the video: skeletons, ball, court lines and the stroke
(render_plain.mp4).

Reads the analysed video (kept.mp4 for TV, else source.mp4), raw.npz (skeletons, ball; cleaned by dsa.scene.clean), players.json (step 3),
names.json (step 4) and, for TV, strokes/strokes.json; writes render.mp4.

    python -m dsa.pages.render federer_usopen/2015 [--seconds 60 | --longest] [--plain]

--longest: only the longest point (most hits, from its serve to its last shot), into render[_plain]_longest.mp4.
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import cv2
import numpy as np

from dsa.scene import clean
from dsa.scene.court import LEFT, LINES, METRE, NET, RIGHT, homography
from dsa.scene.results import load, points
from dsa.video import frames

HOLD, ALPHA, MIN_SCORE = 1.5, 0.85, 0.3
COLOR = [(255, 150, 0), (0, 130, 255)]            # Player 1, Player 2 (BGR): blue, orange
BALL = (80, 255, 80)
BODY = [(5, 6), (5, 7), (7, 9), (6, 8), (8, 10), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14),
        (14, 16), (15, 17), (16, 20)]
FONT = cv2.FONT_HERSHEY_SIMPLEX

WORDS = {"fh": "forehand", "bh": "backhand", "gs": "topspin",
         "slice": "slice", "volley": "volley", "lob": "lob", "smash": "smash", "drop": "drop shot",
         "CC": "cross-court", "DL": "down the line", "DM": "down the middle", "IO": "inside-out",
         "II": "inside-in", "T": "down the T", "W": "wide", "B": "at the body",
         "winner": "winner", "forced-err": "forced error", "unforced-err": "unforced error"}


def words(h: dict) -> str:
    """Coarse to fine: serve / return, forehand / backhand, spin or shot, direction, how it ended."""
    parts = [h["shot"] if h["shot"] != "stroke" else None, h["hand"], h["technique"], h["direction"],
             h["outcome"] if h["outcome"] != "in" else None]
    out = [WORDS.get(p, p) for p in parts if p]
    if h.get("approach"):
        out.append("approach")
    s = ", ".join(out)
    return s[:1].upper() + s[1:]


def text(img: np.ndarray, s: str, org: tuple[int, int], color, scale: float = 0.5) -> None:
    cv2.putText(img, s, (org[0] + 1, org[1] + 1), FONT, scale, (0, 0, 0), 1, cv2.LINE_AA)
    cv2.putText(img, s, org, FONT, scale, color, 1, cv2.LINE_AA)


def draw(d: dict, f0: int, f1: int, out: Path, plain: bool = False, captions: bool = True) -> Path:
    """Frames [f0, f1) of the analysed video, drawn into `out`."""
    fps, n, starts = d["fps"], f1 - f0, d["starts"]
    court = d["court"][f0:f1] if plain and d["court"] is not None else [None] * n
    boxes, kps, ball = d["boxes"][f0:f1], d["kps"][f0:f1], d["ball"][f0:f1]
    pl = {k: d["pl"][k][f0:f1] for k in ("near_far", "boxes")}
    hits = [dict(h, frame=h["frame"] - f0) for h in d["hits"] if f0 - HOLD * fps <= h["frame"] < f1] if captions else []

    # the players' joints per end, and the ball, cleaned frame to frame (dsa.scene.clean); never across a cut or a
    # change of who is at that end
    cuts = {int(c) - f0 for c in starts[1:-1] if f0 < c < f1}
    J = kps[0].shape[1] if len(kps) else 17
    joint = np.full((2, n, J, 3), np.nan)
    height = np.full((2, n), np.nan)
    for i in range(n):
        for e in (0, 1):
            b = pl["boxes"][i][e]
            if pl["near_far"][i][e] is None or b is None:
                continue
            j = np.flatnonzero((boxes[i][:, :4].astype(int) == b).all(1))
            if len(j):
                joint[e, i], height[e, i] = kps[i][j[0]], b[3] - b[1]
    for e in (0, 1):
        who = [pl["near_far"][i][e] for i in range(n)]
        joint[e] = clean.joints(joint[e], height[e], cuts | {i for i in range(1, n) if who[i] != who[i - 1]})
    ball = clean.ball(ball[:n], cuts)

    showing = {}                                   # frame -> [(end, words)], newest last
    for h in hits:
        e = 0 if h["side"] == "near" else 1
        for f in range(max(h["frame"], 0), min(h["frame"] + int(HOLD * fps), n)):
            showing.setdefault(f, []).append((e, words(h)))

    w, hgt = d["size"]
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{hgt}",
                            "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
    blank = np.zeros((hgt, w, 3), np.uint8)
    for i, img in enumerate((blank.copy() for _ in range(n)) if plain else frames(d["video"], n, f0)):
        over = img.copy()
        if court[i] is not None:
            for u, v in LINES:
                cv2.line(over, tuple(np.int32(court[i][u])), tuple(np.int32(court[i][v])), (200, 200, 200), 1,
                         cv2.LINE_AA)
            m = homography(court[i])
            if m is not None:                                    # the net: 1.07 m at the posts, 0.914 m mid-court
                a, c, b = cv2.perspectiveTransform(np.float32([[[LEFT, NET], [(LEFT + RIGHT) / 2, NET],
                                                                 [RIGHT, NET]]]), np.linalg.inv(m))[0]
                px = np.linalg.norm(b - a) / ((RIGHT - LEFT) / METRE)        # px per metre at the net
                up = lambda p, hm: p - (0, hm * px)                          # noqa: E731
                net = np.int32([a, c, b, up(b, 1.07), up(c, 0.914), up(a, 1.07)])
                band = over.copy()
                cv2.fillPoly(band, [net], (120, 120, 120), cv2.LINE_AA)
                over = cv2.addWeighted(band, 0.5, over, 0.5, 0)
                cv2.polylines(over, [net], True, (200, 200, 200), 1, cv2.LINE_AA)
        labels = []
        for e in (0, 1):
            k, b = pl["near_far"][i][e], pl["boxes"][i][e]
            if k is None or b is None:
                continue
            c = COLOR[k - 1]
            thick = 2 if b[3] - b[1] > 150 else 1
            kp = joint[e, i]
            ok = np.isfinite(kp).all(1) & (kp[:, 2] >= MIN_SCORE)
            if ok.any():
                for a, bb in BODY:
                    if ok[a] and ok[bb]:
                        cv2.line(over, tuple(np.int32(kp[a, :2])), tuple(np.int32(kp[bb, :2])), c, thick,
                                 cv2.LINE_AA)
                for q in np.flatnonzero(ok[:17]):
                    cv2.circle(over, tuple(np.int32(kp[q, :2])), 2, c, -1, cv2.LINE_AA)
            labels.append((d["name"][k - 1], b, c))
        if i < len(ball) and ball[i][0] > 0:
            cv2.circle(over, (int(ball[i][1]), int(ball[i][2])), 3, BALL, -1, cv2.LINE_AA)
        img = over if plain else cv2.addWeighted(over, ALPHA, img, 1 - ALPHA, 0)
        for nm, b, c in labels if not plain else []:
            text(img, nm, (b[0], b[1] - 6), c)
        if i in showing:                                          # the newest stroke only, top left
            e, line = showing[i][-1]
            k = pl["near_far"][i][e]
            (tw, th), base = cv2.getTextSize(line, FONT, 0.8, 2)
            cv2.rectangle(img, (12, 12), (12 + tw + 20, 12 + th + base + 16), (0, 0, 0), -1)
            cv2.putText(img, line, (22, 20 + th), FONT, 0.8, COLOR[k - 1] if k else (255, 255, 255), 2, cv2.LINE_AA)
        enc.stdin.write(img.tobytes())
    enc.stdin.close()
    enc.wait()
    return out


def render(spec: str, seconds: float = 0, plain: bool = False, longest: bool = False) -> Path:
    d = load(spec)
    fps, total, starts = d["fps"], d["total"], d["starts"]
    if longest:
        f0, f1 = max(points(d["hits"], list(zip(starts[:-1], starts[1:])), fps))[1:]
    else:
        f0, f1 = 0, min(total, int(seconds * fps)) if seconds else total
    out = d["src"] / (("render_plain" if plain else "render") + ("_longest" if longest else "") + ".mp4")
    return draw(d, f0, f1, out, plain)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", help="<project>/<video>")
    ap.add_argument("--seconds", type=float, default=0, help="only the first N seconds")
    ap.add_argument("--plain", action="store_true", help="the models' output alone, on black")
    ap.add_argument("--longest", action="store_true", help="only the longest point")
    a = ap.parse_args()
    print(render(a.video, a.seconds, a.plain, a.longest))
