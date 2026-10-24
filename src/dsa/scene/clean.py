"""Frame-to-frame clean-up of the ball and the players' joints, never across a camera cut (`breaks`).

  ball    one track is followed: a detection within JUMP px per frame of the track's last point joins it;
          others are held, and replace the track only when they form a run of more than DETOUR frames
          themselves (a ball lying on the court or in a ball kid's hand shows up for a few frames at a
          time). Gaps of up to BALL_GAP frames are then filled with a straight line, as TrackNet does.
  joints  per player and end: left / right is decided per side of the body, never per joint: the arms
          (shoulders, elbows, wrists, hands) and the legs (hips, knees, ankles, feet) each swap as a whole.
          The model's own frames are compared, each with the one before, to find where it flips a side;
          only flips lasting at most FLIP frames are undone (longer ones are taken as right), so a wrong
          swap can never stick. Legs that cross are left as the model drew them: they are nearly always
          right (feet together, a player seen from behind). Next, a joint more than SPIKE body heights
          from the average of the frames before and after is replaced by that average; low-confidence
          gaps of up to JOINT_GAP frames are filled with a straight line; then a light Savitzky-Golay smooth (order 2) over SMOOTH frames, SMOOTH_SMALL for players
          under SMALL px tall (the far end), whose joints jitter more.
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import savgol_filter

JUMP, BALL_GAP, DETOUR = 60.0, 5, 6
SPIKE, JOINT_GAP, SMOOTH, SMOOTH_SMALL, SMALL, MIN_SCORE, FLIP = 0.15, 3, 5, 7, 150, 0.3, 8
HANDS = [(23 + k, 44 + k) for k in range(21)]                     # dsa.gpu.models.KP: left hand, then right hand
SIDES = {"face": [(1, 2), (3, 4)], "arms": [(5, 6), (7, 8), (9, 10)] + HANDS,
         "legs": [(11, 12), (13, 14), (15, 16), (17, 20), (18, 21), (19, 22)]}


def _swap(out: np.ndarray, frames, pairs) -> None:
    l, r = [a for a, _ in pairs], [b for _, b in pairs]
    for i in frames:
        out[i, l + r] = out[i, r + l]


def _sides(kp: np.ndarray, out: np.ndarray, a: int, b: int) -> None:
    """Undo the model's short left / right flips in frames [a, b) of `out`, judged on its own output `kp`."""
    for pairs in SIDES.values():
        pairs = [(x, y) for x, y in pairs if y < kp.shape[1]]
        l, r = [x for x, _ in pairs], [y for _, y in pairs]
        state = np.zeros(b - a, int)                              # the model's flips so far, mod 2
        for i in range(a + 1, b):
            p, c, s = kp[i - 1, l + r, :2], kp[i, l + r, :2], kp[i, r + l, :2]
            ok = np.isfinite(p).all(1) & np.isfinite(c).all(1)
            ok &= np.roll(ok, len(l))                             # both joints of a pair seen in both frames
            flipped = ok.any() and (np.linalg.norm(s - p, axis=1)[ok].sum()
                                    < 0.5 * np.linalg.norm(c - p, axis=1)[ok].sum())
            state[i - a] = state[i - a - 1] ^ flipped
        keep = median_filter(state, 2 * FLIP + 1, mode="nearest")  # runs of at most FLIP frames removed
        _swap(out, a + np.flatnonzero(state != keep), pairs)


def _runs(ok: np.ndarray, breaks: set[int]) -> list[tuple[int, int]]:
    """[(first, end)] of consecutive frames with ok set, split at breaks."""
    out, s = [], None
    for i, v in enumerate(ok):
        if s is not None and (not v or i in breaks):
            out.append((s, i))
            s = None
        if v and s is None:
            s = i
    if s is not None:
        out.append((s, len(ok)))
    return out


def _fill(xy: np.ndarray, ok: np.ndarray, gap: int, breaks: set[int]) -> np.ndarray:
    """Straight-line fill of gaps of at most `gap` frames between ok frames, within a piece; ok updated in place."""
    idx = np.flatnonzero(ok)
    for a, b in zip(idx, idx[1:]):
        if 1 < b - a <= gap + 1 and not any(a < c <= b for c in breaks):
            t = (np.arange(a + 1, b) - a) / (b - a)
            xy[a + 1:b] = xy[a] + t[:, None] * (xy[b] - xy[a])
            ok[a + 1:b] = True
    return xy


def ball(b: np.ndarray, breaks=()) -> np.ndarray:
    """b: (n, 4+) rows of (found, x, y, ...); returns a cleaned copy."""
    breaks = set(breaks)
    out = b.copy()
    ok = out[:, 0] > 0
    xy = out[:, 1:3]

    def fits(i, j):
        return np.linalg.norm(xy[i] - xy[j]) <= JUMP * abs(i - j) and not any(j < c <= i for c in breaks)

    last, held = None, []                          # the track's last point; detections off the track
    for i in np.flatnonzero(ok):
        if last is not None and any(last < c <= i for c in breaks):
            last = None
        if last is None or fits(i, last):
            ok[held] = False
            held, last = [], i
            continue
        if held and not fits(i, held[-1]):         # a different stray: drop the last one
            ok[held] = False
            held = []
        held.append(i)
        if len(held) > DETOUR:                     # a run of its own: the ball is there now
            held, last = [], i
    ok[held] = False
    _fill(xy, ok, BALL_GAP, breaks)
    out[:, 0] = ok
    return out


def joints(kp: np.ndarray, height: np.ndarray, breaks=(), smooth: int = 0) -> np.ndarray:
    """kp: (n, J, 3) one player's joints per frame (NaN where not seen), height: (n,) body height in px.
    smooth: the smoothing window in frames instead of SMOOTH / SMOOTH_SMALL (for 50 / 60 fps skeletons: the same span
    in seconds). Returns a cleaned copy; joints still missing stay NaN."""
    breaks = set(breaks)
    out = kp.astype(np.float64).copy()
    seen = np.isfinite(out[:, 0, 0])
    for a, b in _runs(seen, breaks):
        h = np.nanmedian(height[a:b])
        _sides(kp.astype(np.float64), out, a, b)
        win = smooth or (SMOOTH_SMALL if h < SMALL else SMOOTH)
        for j in range(out.shape[1]):
            xy, ok = out[a:b, j, :2], out[a:b, j, 2] >= MIN_SCORE
            for i in range(1, b - a - 1):
                if ok[i - 1] and ok[i] and ok[i + 1]:
                    mid = (xy[i - 1] + xy[i + 1]) / 2
                    if np.linalg.norm(xy[i] - mid) > SPIKE * h:
                        xy[i] = mid
            _fill(xy, ok, JOINT_GAP, set())
            for s, e in _runs(ok, set()):
                if e - s >= win:
                    xy[s:e] = savgol_filter(xy[s:e], win, 2, axis=0)
            xy[~ok] = np.nan
            out[a:b, j, 2] = np.where(ok, np.maximum(out[a:b, j, 2], MIN_SCORE), out[a:b, j, 2])
    return out
