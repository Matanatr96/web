"""The two players in every frame: in each half of the court, the moving person standing in the playing
area (dsa.scene.court.in_area). When several are: whoever stands nearest the singles court, counting metres behind
a baseline at DEEP of those beside a sideline (players often stand far back, rarely far out to the side,
where line judges and ball kids sit), the one picked last frame keeping their place unless someone else is
HOLD metres nearer. Contacts are no help, as the ball flies past the others too. Nobody there: that side is
empty, rather than whoever else stands there.

Not a player, whatever their place: a box cut off by the bottom of the frame (spectators in the front rows,
whose "feet" are the frame's edge), anyone much shorter than the players there (TALL of the typical height,
measured in court metres at their feet: crouching ball kids, seated people) or much taller (HUGE: a close-up of
the crowd in the moments the last court is still held after a cut), and anyone who never comes into
the playing lanes (PLAYS of their time between the singles sidelines, CORE metres either side, or on the
court: ball kids and line judges beside and behind it).
"""
from __future__ import annotations

from collections import defaultdict

import cv2
import numpy as np

from dsa.scene import events
from dsa.scene.court import FAR, METRE, NEAR, NET, homography, in_area

HOLD, DEEP = 1.5, 0.3
TALL, HUGE, PLAYS, CORE, BOTTOM = 0.72, 1.5, 0.2, 0.5, 0.985
SINGLES = (423, 1242)              # singles sidelines, reference units


def off_court(xy: np.ndarray) -> np.ndarray:
    """Metres from the singles court (0 inside it), those behind a baseline counted at DEEP."""
    dx = np.maximum(np.maximum(SINGLES[0] - xy[:, 0], xy[:, 0] - SINGLES[1]), 0)
    dy = np.maximum(np.maximum(FAR - xy[:, 1], xy[:, 1] - NEAR), 0)
    return np.hypot(dx, DEEP * dy) / METRE


def pick(ppl: dict, per_frame: list[np.ndarray], ids: list[np.ndarray], person_of: dict[int, int],
         court: list[np.ndarray | None], ball: np.ndarray, kp: list[np.ndarray] | None = None,
         height: int | None = None):
    """Per frame [near id or None, far id or None]; also hits per person (contacts in the playing area).
    `height`: the frame's, to leave out boxes cut off by its bottom."""
    homs = {}
    ref = []                                                     # per frame: (n, 2) feet on the court, or None
    tall = []                                                    # per frame: (n,) box height in court metres
    for i, (b, c) in enumerate(zip(per_frame, court)):
        if c is None or not len(b):
            ref.append(None)
            tall.append(None)
            continue
        key = id(c)
        if key not in homs:
            m = homography(c)
            homs[key] = (m, None if m is None else np.linalg.inv(m))
        m, back = homs[key]
        if m is None:
            ref.append(None)
            tall.append(None)
            continue
        feet = np.float32(np.c_[(b[:, 0] + b[:, 2]) / 2, b[:, 3]])
        r = cv2.perspectiveTransform(feet[:, None], m).reshape(-1, 2)
        ref.append(r)
        side = cv2.perspectiveTransform(np.float32(r + [METRE, 0])[:, None], back).reshape(-1, 2)
        tall.append((b[:, 3] - b[:, 1]) / np.maximum(np.linalg.norm(side - feet, axis=1), 1e-3))

    # who can be a player: seen in the playing lanes often enough, standing as tall as the players do
    lanes: dict[int, list[bool]] = defaultdict(list)
    tall_on = []
    for r, h, t in zip(ref, tall, ids):
        if r is None:
            continue
        x = r[:, 0]
        core = ((x > SINGLES[0] - CORE * METRE) & (x < SINGLES[1] + CORE * METRE)) | (off_court(r) < CORE)
        for j in np.flatnonzero(t >= 0):
            lanes[person_of[int(t[j])]].append(bool(core[j]))
        tall_on += list(h[(off_court(r) == 0) & (t >= 0)])
    plays = {p: np.mean(v) >= PLAYS for p, v in lanes.items()}
    short, huge = (TALL * np.median(tall_on), HUGE * np.median(tall_on)) if tall_on else (0.0, np.inf)

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
            ok, off = in_area(ref[i]) & (tall[i] >= short) & (tall[i] <= huge), off_court(ref[i])
            if height:
                ok &= b[:, 3] < BOTTOM * height
            for side, half in ((0, ref[i][:, 1] >= NET), (1, ref[i][:, 1] < NET)):
                best = None
                for j in np.flatnonzero((t >= 0) & ok & half):
                    p = person_of[int(t[j])]
                    if ppl[p]["still"] or not plays.get(p):
                        continue
                    key = off[j] - (HOLD if p == prev[side] else 0)
                    if best is None or key < best[1]:
                        best = (p, key)
                pick_[side] = best[0] if best else None
        out.append(pick_)
        prev = pick_
    return out, dict(hits)
