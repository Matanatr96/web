"""Everyone in a clip: tracks, joined into people, and the people who never move.

  track       ByteTrack over the per-frame person boxes.
  stitch      a track that starts shortly after another ends, where that one was last
              seen and about the same size, is the same person (hidden for a moment).
  camera      the camera's pan per frame: the median shift of everyone's feet (most people
              in shot stand still), taken out before measuring how anyone moves.
  still       people whose feet never move more than STILL_RANGE body heights over at
              least STILL_S seconds: the crowd, a seated umpire, line judges. Not posed.

"Feet" is the bottom centre of the box, which only moves when the person does.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

K = 5                   # frames over which speeds are measured
STILL_S, STILL_RANGE = 3.0, 0.5
MOVING = 0.5            # body heights per second


def track(per_frame: list[np.ndarray], fps: float, min_conf: float = 0.3, breaks=()) -> list[np.ndarray]:
    """per_frame[i]: (n, 5) x1 y1 x2 y2 conf. Returns per frame (n,) ByteTrack ids aligned with the input, -1
    for boxes below min_conf or not (yet) confirmed as a track. Tracking starts afresh at each frame in `breaks`
    (a cut between kept pieces), with ids that never repeat."""
    import supervision as sv

    out, base, top, breaks = [], 0, 0, set(breaks)
    for i, b in enumerate(per_frame):
        if i == 0 or i in breaks:
            bt, base = sv.ByteTrack(frame_rate=round(fps), lost_track_buffer=round(fps)), (top + 1 if i else 0)
        ids = np.full(len(b), -1, np.int64)
        keep = np.flatnonzero(b[:, 4] >= min_conf) if len(b) else np.zeros(0, int)
        if len(keep):
            d = sv.Detections(xyxy=b[keep, :4].astype(np.float32), confidence=b[keep, 4].astype(np.float32),
                              class_id=np.zeros(len(keep), int), data={"i": keep})
            d = bt.update_with_detections(d)
            if len(d):
                ids[d.data["i"]] = d.tracker_id + base
                top = max(top, int(ids.max()))
        else:
            bt.update_with_detections(sv.Detections.empty())
        out.append(ids)
    return out


def _foot(b):
    return np.array([(b[0] + b[2]) / 2, b[3]])


def tracks_of(per_frame: list[np.ndarray], ids: list[np.ndarray]) -> dict[int, dict[int, np.ndarray]]:
    tr: dict[int, dict[int, np.ndarray]] = defaultdict(dict)
    for i, (b, t) in enumerate(zip(per_frame, ids)):
        for j in np.flatnonzero(t >= 0):
            tr[int(t[j])][i] = b[j, :4]
    return dict(tr)


def stitch(tr: dict[int, dict[int, np.ndarray]], fps: float) -> dict[int, int]:
    """ByteTrack id -> person id (the first id of its chain)."""
    person, last = {}, {}                                  # last: person -> (end frame, box)
    for t in sorted(tr, key=lambda t: min(tr[t])):
        s = min(tr[t]); b = tr[t][s]; best = None
        for p, (e, bp) in last.items():
            if 0 < s - e <= 2 * fps:
                hp = bp[3] - bp[1]
                d = np.linalg.norm(_foot(bp) - _foot(b)) / hp
                if d < 0.5 + 0.5 * (s - e) / fps and 0.6 < (b[3] - b[1]) / hp < 1.6 and (best is None or d < best[1]):
                    best = (p, d)
        p = best[0] if best else t
        person[t] = p
        e = max(tr[t])
        last[p] = (e, tr[t][e])
    return person


def camera(tr: dict[int, dict[int, np.ndarray]], n: int) -> np.ndarray:
    """(n, 2) cumulative camera shift in px, per K-frame chain."""
    cam = np.zeros((n, 2))
    for i in range(K, n):
        d = [_foot(fr[i]) - _foot(fr[i - K]) for fr in tr.values() if i in fr and i - K in fr]
        cam[i] = cam[i - K] + (np.median(d, axis=0) if len(d) >= 3 else 0)
    return cam


def people(per_frame: list[np.ndarray], ids: list[np.ndarray], fps: float) -> dict:
    """Stitched people with their frames, boxes and movement features."""
    tr = tracks_of(per_frame, ids)
    cam = camera(tr, len(per_frame))
    pid = stitch(tr, fps)
    frames: dict[int, dict[int, np.ndarray]] = defaultdict(dict)
    for t, fr in tr.items():
        frames[pid[t]].update(fr)
    out = {}
    for p, fr in frames.items():
        f = np.array(sorted(fr)); b = np.array([fr[k] for k in f])
        feet = np.c_[(b[:, 0] + b[:, 2]) / 2, b[:, 3]] - cam[f]
        h = float(np.median(b[:, 3] - b[:, 1]))
        if len(f) > K:
            sp = np.linalg.norm(feet[K:] - feet[:-K], axis=1) / h * fps / np.maximum(f[K:] - f[:-K], 1)
        else:
            sp = np.zeros(1)
        spread = np.percentile(feet, 95, axis=0) - np.percentile(feet, 5, axis=0)
        active = float(np.mean(sp > MOVING))
        rng = float(np.hypot(*spread) / h)
        seconds = len(f) / fps
        out[p] = dict(frames=f, h=h, seconds=seconds, active=active, range=rng,
                      still=bool(seconds >= STILL_S and rng < STILL_RANGE),
                      score=active * min(1.0, seconds / 4) + 0.1 * min(rng, 3))
    return {"people": out, "person_of": pid}
