"""Shared synthetic scene for the physics tests: a phone on the fence behind the near baseline."""
from __future__ import annotations

import cv2
import numpy as np

from dsa.physics.homography import COURT_M, HALF_LEN, NET_POSTS_M, Calibration

SIZE = (1920, 1080)
CAMERA = np.array([0.0, -15.5, 3.5])         # m: behind the near baseline, 3.5 m up
LOOK_AT = np.array([0.0, -6.0, 0.0])
F = 800.0                                    # px: ~100 degrees across 1920 px (the 0.5x lens), whole court in view


def true_camera(camera=CAMERA, look_at=LOOK_AT, f=F, size=SIZE) -> Calibration:
    """The ground-truth camera looking from `camera` at `look_at`, no roll."""
    fwd = (look_at - camera) / np.linalg.norm(look_at - camera)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])          # court -> camera axes (x right, y down, z forward)
    t = -R @ camera
    K = np.array([[f, 0, size[0] / 2], [0, f, size[1] / 2], [0, 0, 1]])
    return Calibration(K, cv2.Rodrigues(R)[0].ravel(), t, size, 0.0)


def court_pixels(cal: Calibration):
    from dsa.physics.homography import project
    return project(cal, COURT_M), project(cal, NET_POSTS_M)


COR, FRICTION = 0.75, 0.65                   # bounce: vertical restitution, horizontal speed kept


def landing(p0, v0, t_max: float = 4.0):
    """(t, position, velocity) where a drag flight's centre comes down to BALL_R."""
    from dsa.physics.ballistics import simulate
    from dsa.physics.homography import BALL_R

    h = 0.005
    ts = np.arange(0, t_max, h)
    P, V = simulate(p0, v0, ts, return_velocity=True)
    k = int(np.flatnonzero((P[1:, 2] < BALL_R) & (V[1:, 2] < 0))[0])
    w = (P[k, 2] - BALL_R) / (P[k, 2] - P[k + 1, 2])
    t0 = ts[k] + w * h                       # refine: one exact step from the grid point before
    P2, V2 = simulate(P[k], V[k], [t0 - ts[k]], return_velocity=True)
    return t0, P2[0], V2[0]


def aim(p0, target_xy, T: float):
    """A launch velocity from p0 that lands (drag on) at target_xy after about T seconds."""
    from dsa.physics.homography import BALL_R

    p0 = np.asarray(p0, float)
    tgt = np.asarray(target_xy, float)
    v = np.r_[(tgt - p0[:2]) / T, (BALL_R - p0[2] + 0.5 * 9.81 * T * T) / T]
    for _ in range(20):
        t, p, _ = landing(p0, v)
        err = tgt - p[:2]
        v[:2] += err / t
        v[2] += 0.5 * 9.81 * (T - t)
        if np.linalg.norm(err) < 1e-3 and abs(T - t) < 1e-3:
            break
    return v


def rally(rng, cal: Calibration, fps: float = 60.0, noise_px: float = 0.5):
    """A made-up exchange: near hit -> far bounce -> far hit -> near bounce -> near hit, drag flights, bounces
    with COR and friction, sampled at fps with a random phase and VFR jitter. Returns the track (n, 5) and the
    true events [(t, kind, xyz)] (kind 'hit' | 'bounce'), the first hit excluded."""
    from dsa.physics.ballistics import simulate
    from dsa.physics.homography import project

    segs, events = [], []                    # segs: (t0, p0, v0)
    t = 0.0
    p = np.array([rng.uniform(-3, 3), rng.uniform(-12.5, -9.5), rng.uniform(0.6, 1.4)])
    for side in (+1, -1):
        for _ in range(50):                  # a baseline rally: deep enough to be played from behind the baseline
            b = np.array([rng.uniform(-3.5, 3.5), side * rng.uniform(5.0, 11.0)])
            v = aim(p, b, rng.uniform(0.8, 1.3))
            tl, pl, vl = landing(p, v)
            vb = np.r_[vl[:2] * FRICTION, -vl[2] * COR]
            ts_ = np.arange(0.05, 1.6, 0.005)
            P, V = simulate(pl, vb, ts_, return_velocity=True)
            back = HALF_LEN + rng.uniform(0.2, 1.5)
            k = np.flatnonzero((np.abs(P[:, 1]) >= back) & (P[:, 2] >= 0.35))
            if len(k):
                break
        segs.append((t, p, v))
        t += tl
        events.append((t, "bounce", pl))
        segs.append((t, pl, vb))
        k = int(k[0])                        # the other player hits it on the rise or the drop
        t += ts_[k]
        p = P[k]
        events.append((t, "hit", p))
    v = aim(p, [rng.uniform(-3, 3), rng.uniform(3.0, 10.0)], 1.0)
    segs.append((t, p, v))
    t_end = t + 0.3
    times = np.arange(rng.uniform(0, 1 / fps) + 0.05, t_end, 1 / fps)
    times = times + rng.uniform(-0.0005, 0.0005, len(times))
    xyz = np.zeros((len(times), 3))
    starts = np.array([s[0] for s in segs])
    seg_of = np.searchsorted(starts, times, side="right") - 1
    for j, (t0, p0, v0) in enumerate(segs):
        sel = seg_of == j
        if sel.any():
            xyz[sel] = simulate(p0, v0, times[sel] - t0)
    uv = project(cal, xyz) + rng.normal(0, noise_px, (len(times), 2))
    track = np.c_[times, np.ones(len(times)), uv, np.ones(len(times))]
    return track, events, xyz
