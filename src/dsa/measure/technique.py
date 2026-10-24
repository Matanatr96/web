"""Stroke technique from a skeleton window around contact: the measures of dsa.gpu.rally_api.pose_hits, kept from
upstream's dsa.measure.technique (Off Policy's Claude as a Tennis Coach), where they were computed on broadcast
footage and compared across players and eras.

  normalise / fill / align  (N, T, 13, 3) joint pixels on GRID -> hip-centred torso units, gaps filled, cut to WIN
  features                  STROKE per forehand / backhand (a backhand mirrored to look like a forehand first)
  serve_features            SERVE per serve
"""
from __future__ import annotations

import numpy as np

PRE, POST, HZ = 0.9, 0.6, 30                 # seconds kept around the contact; the resampled rate


def grid(hz: int = HZ) -> np.ndarray:
    return np.round(np.arange(-PRE * hz, POST * hz + 1) / hz, 4)


GRID = grid()
JOINTS = [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]            # dsa.gpu.models.KP: nose, then body pairs L/R
NAMES = ["nose", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow", "l_wrist", "r_wrist", "l_hip", "r_hip",
         "l_knee", "r_knee", "l_ankle", "r_ankle"]
MIRROR = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11]                 # left <-> right, for left-handers
KINDS = {                     # a backhand is mirrored (flip) to look like a forehand; a serve's window is the whole one
    "forehand": {"flip": False},
    "backhand": {"flip": True},
    "serve": {"flip": False, "win": (-0.9, 0.6)},
}

WIN = (-0.6, 0.4)                            # seconds analysed around the aligned contact


def normalise(pose: np.ndarray) -> np.ndarray:
    """(N, T, 13, 3) image px -> (N, T, 13, 2): centred on the mid-hip each frame, y up, in torso lengths
    (mid-shoulder to mid-hip, the median over the stroke)."""
    xy = pose[..., :2].copy()
    xy[..., 1] = -xy[..., 1]
    hip = xy[:, :, 7:9].mean(2, keepdims=True)
    torso = np.linalg.norm(xy[:, :, 1:3].mean(2) - xy[:, :, 7:9].mean(2), axis=-1)
    return (xy - hip) / np.nanmedian(torso, 1)[:, None, None, None]


def fill(x: np.ndarray) -> np.ndarray:
    """NaNs along time (axis 1) filled linearly, ends held."""
    x = x.copy()
    t = np.arange(x.shape[1])
    flat = x.reshape(x.shape[0], x.shape[1], -1)
    for i in range(flat.shape[0]):
        for j in range(flat.shape[2]):
            ok = np.isfinite(flat[i, :, j])
            if ok.any() and not ok.all():
                flat[i, :, j] = np.interp(t, t[ok], flat[i, ok, j])
    return flat.reshape(x.shape)


def align(xy: np.ndarray, grid: np.ndarray, win: tuple = WIN) -> np.ndarray:
    """(N, len(window), 13, 2) cut to `win` around the labelled contact."""
    hz = round(1 / (grid[1] - grid[0]))
    n = int(round((win[1] - win[0]) * hz)) + 1
    a = int(np.flatnonzero(np.isclose(grid, 0))[0]) + int(round(win[0] * hz))
    return xy[:, a:a + n]


def angle(a, b, c) -> np.ndarray:
    """Angle at b, degrees, in the image plane."""
    u, v = a - b, c - b
    cos = (u * v).sum(-1) / (np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1))
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


STROKE = {                                    # name: (unit, what it measures)
    "contact_height": ("torso", "hitting wrist above the hips at contact"),
    "contact_side": ("torso", "hitting wrist out to the side of the hips at contact (backhand: to the backhand side)"),
    "elbow_angle": ("deg", "hitting elbow at contact (180 straight arm)"),
    "shoulder_width": ("deg", "how far the shoulders have opened at contact: 0 side-on, 90 square to the net, over 90 "
                              "past square"),
    "shoulder_coil": ("deg", "most the shoulders turn away from the net in the take-back: 90 side-on, over 90 back "
                             "turned past side-on"),
    "hip_coil": ("deg", "most the hips turn away from the net in the take-back: 90 side-on"),
    "separation": ("deg", "shoulders' turn minus the hips' at the shoulders' most-turned moment (shoulders turned "
                          "further than the hips)"),
    "shoulder_tilt": ("deg", "shoulder line from level at contact (negative: hitting shoulder low)"),
    "knee_bend": ("deg", "most-bent knee angle in the 0.4 s before contact (lower: more bend)"),
    "takeback": ("torso", "hitting wrist out to the side of the hips at the end of the take-back (the wrist's slowest "
                          "moment before the forward swing)"),
    "swing_time": ("s", "from the end of the take-back (the forward swing's start) to contact"),
    "wrist_speed": ("torso/s", "peak hitting-wrist speed through contact"),
    "finish_height": ("torso", "wrist above the shoulders 0.3 s after contact"),
    "finish_side": ("torso", "wrist out to the hitting side of the hips 0.3 s after contact (negative: wrapped across the body)"),
    "head_still": ("torso", "head movement relative to the hips in the 0.2 s around contact"),
    "finish_arm": ("deg", "hitting arm (shoulder to wrist) from upright 0.3 s after contact, seen from behind (positive: "
                          "out to the hitting side, negative: across the body, beyond -90 below the shoulder)"),
    "finish_open": ("deg", "how far the shoulders have opened 0.3 s after contact: 0 side-on, 90 square, over 90 past"),
    "takeback_turn": ("deg", "shoulder turn from square at the forward swing's start: 0 square, 90 side-on"),
    "stance_m": ("m", "feet apart at contact, both ankles mapped onto the court surface through its lines"),
    "stance_side_m": ("m", "feet apart sideways (along the baseline) at contact, on the court surface"),
    "stance_fwd_m": ("m", "front foot ahead of the back foot toward the net at contact, on the court surface "
                          "(0: open stance, side by side)"),
    "stance_angle": ("deg", "angle of the line from back foot to front foot against the baseline at contact, on the "
                            "court surface: 90 the front foot straight ahead (neutral), below 90 stepped across the "
                            "body (closed), above 90 out to its own side (open)"),
}
GROUND = ["stance_m", "stance_side_m", "stance_fwd_m", "stance_angle"]


SERVE = {
    "reach": ("torso", "hitting wrist above the ankles at contact"),
    "toss_arm": ("torso", "tossing wrist's highest point above the head before contact"),
    "toss_straight": ("deg", "tossing elbow at the tossing wrist's highest point (180 straight arm)"),
    "toss_tilt": ("deg", "tossing arm (shoulder to wrist) from vertical at its highest point, seen from behind "
                         "(positive: leaning in over the head, negative: out to the side)"),
    "trophy_time": ("s", "from the tossing wrist's highest point to contact"),
    "trophy_tilt": ("deg", "shoulder line from level when the tossing wrist is highest (tossing shoulder up)"),
    "lean": ("torso", "shoulders right of the ankles at contact, seen from behind"),
    "trunk_lean": ("deg", "trunk (mid-hip to mid-shoulder) from upright at contact, seen from behind (positive: to the "
                          "tossing side)"),
    "hips_over": ("torso", "hips right of the ankles at contact, seen from behind"),
    "wrist_speed": ("torso/s", "peak hitting-wrist speed through contact"),
    "into_court": ("m", "how far his feet travel toward the net from 0.6 s before to 0.4 s after contact, on the court"),
}

def turn(w: np.ndarray, a: int, b: int) -> tuple[np.ndarray, np.ndarray]:
    """How far the line between joints a and b (the shoulders 1-2, the hips 7-8) is turned away from facing the net,
    in degrees, per frame: seen from behind, the line looks widest when square to the net and shrinks as it turns, to
    nothing side-on, and its ends swap sides past that. So: arccos(signed width / the stroke's widest), 0 square,
    90 side-on, over 90 turned past side-on. Also the frame it is widest (square). The line's own length cancels,
    so a broad or narrow build doesn't count."""
    d = w[:, :, b, 0] - w[:, :, a, 0]
    sq = np.nanargmax(np.abs(np.nan_to_num(d)), 1)
    rows = np.arange(len(w))
    widest = np.abs(d[rows, sq])
    ang = np.degrees(np.arccos(np.clip(d * np.sign(d[rows, sq])[:, None] / widest[:, None], -1, 1)))
    return ang, sq


FWD = (-0.55, -0.05)         # the forward swing starts in here, s from contact


def phases(w: np.ndarray, t: np.ndarray) -> dict[str, np.ndarray]:
    """Each stroke's phases (frame indices into w's time axis t), from its own motion rather than fixed times:
      fwd      the start of the forward swing = the end of the take-back: walking back from the hitting wrist's
               fastest moment through contact (speed smoothed over 5 frames) until it is under half that, then on
               to where it stops slowing: the last real dip in speed before the swing, where the wrist turns from
               going back to coming through (kept within FWD)
      coil     the shoulders' most-turned moment (turn: furthest from square) in the take-back: -0.6 s to fwd
      hipcoil  the same for the hips
    w: (N, T, 13, 2) on t, contact at t = 0."""
    hz = round((len(t) - 1) / (t[-1] - t[0]))
    at = lambda s: int(np.argmin(abs(t - s)))                       # noqa: E731
    speed = np.linalg.norm(np.diff(w[:, :, 6], axis=1), axis=-1) * hz             # between frames f and f + 1
    k = np.ones(5) / 5
    sm = np.stack([np.convolve(np.pad(np.nan_to_num(v, nan=np.nanmedian(v)), 2, mode="edge"), k, "valid") for v in speed])
    peak = np.argmax(sm[:, at(-0.15):at(0.05) + 1], 1) + at(-0.15)
    fwd = peak.copy()
    for n, f in enumerate(peak):
        top = sm[n, f]
        while f > at(FWD[0]) and (sm[n, f] > 0.5 * top or sm[n, f - 1] < sm[n, f]):   # below half its peak, then
            f -= 1                                                                      # on down to the dip
        fwd[n] = min(f, at(FWD[1]))
    frames = np.arange(len(t))
    inside = (frames[None] >= at(-0.6)) & (frames[None] <= fwd[:, None])      # the take-back, per stroke
    most = lambda i, j: np.argmax(np.where(inside, np.nan_to_num(turn(w, i, j)[0]), -1), 1)   # noqa: E731
    return {"fwd": fwd, "coil": most(1, 2), "hipcoil": most(7, 8)}


def features(w: np.ndarray, feet: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """w: (N, T, 13, 2) aligned to WIN; feet (N, T, 2) court metres on the same window.
    -> (N, len(FEATURES)), (N, len(CONTEXT))."""
    t = np.round(np.linspace(WIN[0], WIN[1], w.shape[1]), 4)
    hz = round((w.shape[1] - 1) / (WIN[1] - WIN[0]))
    at = lambda s: int(np.argmin(abs(t - s)))                       # noqa: E731
    c, fin = at(0), at(0.3)
    (sa, ssq), (ha, _) = turn(w, 1, 2), turn(w, 7, 8)              # shoulders' and hips' turn from square, degrees
    ph = phases(w, t)
    fwd, coil_t = ph["fwd"], ph["coil"]
    rows = np.arange(len(w))
    # open at contact: 0 side-on, 90 square to the net, over 90 rotated past square (square came before contact)
    opened = np.where(ssq < c, 90 + sa[rows, c], 90 - sa[rows, c])
    sh_mid = w[:, :, 1:3].mean(2)
    knee = (angle(w[:, :, 7], w[:, :, 9], w[:, :, 11]) + angle(w[:, :, 8], w[:, :, 10], w[:, :, 12])) / 2
    speed = np.linalg.norm(np.diff(w[:, :, 6], axis=1), axis=-1) * hz
    f = np.stack([
        w[:, c, 6, 1], w[:, c, 6, 0], angle(w[:, c, 2], w[:, c, 4], w[:, c, 6]), opened,
        sa[rows, coil_t], ha[rows, ph["hipcoil"]], sa[rows, coil_t] - ha[rows, coil_t],
        np.degrees(np.arctan2(w[:, c, 2, 1] - w[:, c, 1, 1], np.abs(w[:, c, 2, 0] - w[:, c, 1, 0]))),   # |dx|: a
        # mirrored backhand's shoulder line points the other way; tilt from level, either way (was near +-180)
        np.nanmin(knee[:, at(-0.4):c + 1], 1), w[rows, fwd, 6, 0], (c - fwd) / hz,
        np.nanmax(speed[:, at(-0.15):at(0.1)], 1), w[:, fin, 6, 1] - sh_mid[:, fin, 1], w[:, fin, 6, 0],
        np.linalg.norm(w[:, at(0.1), 0] - w[:, at(-0.1), 0], axis=-1),
        np.degrees(np.arctan2(w[:, fin, 6, 0] - w[:, fin, 2, 0], w[:, fin, 6, 1] - w[:, fin, 2, 1])),
        np.where(ssq < fin, 90 + sa[:, fin], 90 - sa[:, fin]), sa[rows, fwd]], 1)
    run = np.linalg.norm(feet[:, at(-0.1)] - feet[:, at(-0.5)], axis=-1) / 0.4
    return f, np.stack([feet[:, c, 0], feet[:, c, 1], run], 1)


def serve_features(w: np.ndarray, feet: np.ndarray, win: tuple) -> tuple[np.ndarray, np.ndarray]:
    """SERVE per serve; context: where he stands (depth, lateral) before the serve, and no running."""
    t = np.round(np.linspace(win[0], win[1], w.shape[1]), 4)
    hz = round((w.shape[1] - 1) / (win[1] - win[0]))
    at = lambda s: int(np.argmin(abs(t - s)))                       # noqa: E731
    c, rows = at(0), np.arange(len(w))
    toss = slice(at(-0.9), at(-0.1))
    peak = np.nanargmax(w[:, toss, 5, 1], 1) + toss.start
    speed = np.linalg.norm(np.diff(w[:, :, 6], axis=1), axis=-1) * hz
    sh = w[rows, peak][:, 1:3]
    f = np.stack([
        w[:, c, 6, 1] - w[:, c, 11:13, 1].mean(1), w[rows, peak, 5, 1] - w[rows, peak, 0, 1],
        angle(w[rows, peak, 1], w[rows, peak, 3], w[rows, peak, 5]),
        np.degrees(np.arctan2(w[rows, peak, 5, 0] - w[rows, peak, 1, 0], w[rows, peak, 5, 1] - w[rows, peak, 1, 1])),
        (c - peak) / hz,
        np.degrees(np.arctan2(sh[:, 0, 1] - sh[:, 1, 1], sh[:, 1, 0] - sh[:, 0, 0])),
        w[:, c, 1:3, 0].mean(1) - w[:, c, 11:13, 0].mean(1),
        -np.degrees(np.arctan2(w[:, c, 1:3, 0].mean(1) - w[:, c, 7:9, 0].mean(1), w[:, c, 1:3, 1].mean(1) - w[:, c, 7:9, 1].mean(1))),
        w[:, c, 7:9, 0].mean(1) - w[:, c, 11:13, 0].mean(1), np.nanmax(speed[:, at(-0.15):at(0.1)], 1),
        feet[:, at(-0.6), 0] - feet[:, at(0.4), 0]], 1)
    return f, np.stack([feet[:, at(-0.6), 0], feet[:, at(-0.6), 1], np.zeros(len(w))], 1)
