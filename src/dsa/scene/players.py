"""The two players in every frame: in each half of the court, the moving person standing in the playing
area (dsa.scene.court.in_area). When several are: whoever stands nearest the singles court, counting metres behind
a baseline at DEEP of those beside a sideline (players often stand far back, rarely far out to the side,
where line judges and ball kids sit), the one picked last frame keeping their place unless someone else is
HOLD metres nearer. Contacts are no help, as the ball flies past the others too. Nobody there: that side is
empty.
"""
from __future__ import annotations

from collections import defaultdict

import cv2
import numpy as np

from dsa.scene import events
from dsa.scene.court import FAR, METRE, NEAR, NET, homography, in_area

HOLD, DEEP = 1.5, 0.3
SINGLES = (423, 1242)              # singles sidelines, reference units


def off_court(xy: np.ndarray) -> np.ndarray:
    """Metres from the singles court (0 inside it), those behind a baseline counted at DEEP."""
    dx = np.maximum(np.maximum(SINGLES[0] - xy[:, 0], xy[:, 0] - SINGLES[1]), 0)
    dy = np.maximum(np.maximum(FAR - xy[:, 1], xy[:, 1] - NEAR), 0)
    return np.hypot(dx, DEEP * dy) / METRE


def pick(ppl: dict, per_frame: list[np.ndarray], ids: list[np.ndarray], person_of: dict[int, int],
         court: list[np.ndarray | None], ball: np.ndarray, kp: list[np.ndarray] | None = None):
    """Per frame [near id or None, far id or None]; also hits per person (contacts in the playing area)."""
    homs = {}
    ref = []                                                     # per frame: (n, 2) feet on the court, or None
    for i, (b, c) in enumerate(zip(per_frame, court)):
        if c is None or not len(b):
            ref.append(None)
            continue
        key = id(c)
        if key not in homs:
            homs[key] = homography(c)
        m = homs[key]
        if m is None:
            ref.append(None)
            continue
        feet = np.float32(np.c_[(b[:, 0] + b[:, 2]) / 2, b[:, 3]])
        ref.append(cv2.perspectiveTransform(feet[:, None], m).reshape(-1, 2))

    hits: dict[int, int] = defaultdict(int)
    for t, p in events.contacts(ball, per_frame, ids, person_of, kp):
        if ref[t] is None:
            continue
        j = [j for j in np.flatnonzero(ids[t] >= 0) if person_of[int(ids[t][j])] == p]
        if j and in_area(ref[t][j[:1]])[0]:
            hits[p] += 1

    out, prev = [], [None, None]
    for i, (b, t) in enumerate(zip(per_frame, ids)):
        pick_ = [None, None]
        if ref[i] is not None:
            ok, off = in_area(ref[i]), off_court(ref[i])
            for side, half in ((0, ref[i][:, 1] >= NET), (1, ref[i][:, 1] < NET)):
                best = None
                for j in np.flatnonzero((t >= 0) & ok & half):
                    p = person_of[int(t[j])]
                    if ppl[p]["still"]:
                        continue
                    key = off[j] - (HOLD if p == prev[side] else 0)
                    if best is None or key < best[1]:
                        best = (p, key)
                pick_[side] = best[0] if best else None
        out.append(pick_)
        prev = pick_
    return out, dict(hits)
