"""Ball events from the ball track.

  turns       frames where the ball sharply changes direction (more than 60 degrees, at speed before and
              after): hits and bounces.
  contacts    turns within reach of someone (inside their box widened by 0.6 body heights each side and
              0.4 above; nearest wrist, or box centre, wins): hits, and the odd bounce at a player's feet.

Not yet: telling bounces from hits away from players, and exact hit timing.
"""
from __future__ import annotations

import numpy as np

TURN_COS = 0.5          # the ball's direction turns by more than 60 degrees
MIN_SPEED = 2.0         # px per frame, before and after (a still false ball never turns)
LOOK = (2, 6)           # frames before / after to measure the ball's direction over
RUN_GAP = 2             # frames between turn frames of the same turn
HIT_GAP = 8             # frames between separate contacts
WRISTS = (9, 10)


def turns(ball: np.ndarray) -> np.ndarray:
    """Frames where the tracked ball sharply changes direction (hits, and bounces). A turn shows on a few
    frames around it; of each run of such frames (gaps up to RUN_GAP) the one where the velocity changes
    most is kept: the moment of contact, not the first frame the turn shows on."""
    ok = ball[:, 0] > 0
    p = ball[:, 1:3]
    cand = []
    for t in np.flatnonzero(ok):
        a = [u for u in range(t - LOOK[1], t - LOOK[0] + 1) if u >= 0 and ok[u]]
        b = [u for u in range(t + LOOK[0], t + LOOK[1] + 1) if u < len(ok) and ok[u]]
        if not a or not b:
            continue
        vi = (p[t] - p[a[0]]) / (t - a[0])
        vo = (p[b[-1]] - p[t]) / (b[-1] - t)
        si, so = np.linalg.norm(vi), np.linalg.norm(vo)
        if si >= MIN_SPEED and so >= MIN_SPEED and vi @ vo / (si * so) < TURN_COS:
            cand.append((int(t), float(np.linalg.norm(vo - vi))))
    out, run = [], []
    for t, dv in cand + [(10 ** 9, 0.0)]:
        if run and t - run[-1][0] > RUN_GAP:
            out.append(max(run, key=lambda r: r[1])[0])
            run = []
        run.append((t, dv))
    return np.array(out, int)


def contacts(ball: np.ndarray, per_frame: list[np.ndarray], ids: list[np.ndarray], person_of: dict[int, int],
             kp: list[np.ndarray] | None = None) -> list[tuple[int, int]]:
    """(frame, person) for each time the ball turns within reach of someone: inside their box widened by
    0.6 body heights each side and 0.4 above; the nearest wrist (or box centre) wins. One per HIT_GAP."""
    cand = []
    for t in turns(ball):
        x, y = ball[t, 1:3]
        best = None
        for j in np.flatnonzero(ids[t] >= 0):
            x1, y1, x2, y2 = per_frame[t][j, :4]
            h = y2 - y1
            if not (x1 - 0.6 * h <= x <= x2 + 0.6 * h and y1 - 0.4 * h <= y <= y2 + 0.1 * h):
                continue
            pts = np.array([[(x1 + x2) / 2, (y1 + y2) / 2]])
            if kp is not None:
                w = kp[t][j, list(WRISTS)].astype(np.float32)
                w = w[np.isfinite(w[:, 0]) & (w[:, 2] >= 0.3), :2]
                if len(w):
                    pts = w
            d = np.min(np.hypot(*(pts - (x, y)).T)) / h
            if best is None or d < best[1]:
                best = (person_of[int(ids[t][j])], d)
        if best:
            cand.append((int(t), best[0]))
    out = []
    for t, p in cand:
        if out and t - out[-1][0] <= HIT_GAP and out[-1][1] == p:
            continue
        out.append((t, p))
    return out
