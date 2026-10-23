"""3D ball flight with air drag: shot speed off the racket, speed at the bounce, and clearance over the net.

  simulate   RK4 on  x'' = -g z - k Cd |v| v  [+ k c_lift |v|^2 n],  k = rho A / (2 m), n the unit normal to v in
             its vertical plane pointing down (topspin dives for c_lift > 0). Phase 1 runs pure drag:
             Cd = 0.55, c_lift = 0 (fit_lift=False); the lift term is there to switch on later.
  fit_shot   the ball's (t, u, v) samples between a hit and its bounce (+ the bounce's court point from Hr, when
             known) -> scipy.optimize.least_squares on the launch point and velocity (and c_lift with
             fit_lift=True), minimising reprojection error through the calibrated camera. Monocular depth comes
             from gravity and drag plus the bounce point. Returns speed_mph (off the racket), speed_at_bounce_mph,
             net_clearance_m (ball bottom over the net at the crossing, the net 0.914 m at the centre rising
             linearly to 1.07 m at the posts) and rms_px.
"""
from __future__ import annotations

import math

import numpy as np

from dsa.physics.homography import BALL_R, NET_CENTRE_Z, NET_POST_X, NET_POST_Z, Calibration, project

G = 9.81
CD = 0.55
RHO, MASS = 1.21, 0.0577                        # kg/m^3 (20 C, sea level), kg
AREA = np.pi * BALL_R ** 2
K = RHO * AREA / (2 * MASS)                     # 1/m
MPH = 2.236936
DT = 0.005                                      # s: RK4 step (drag time constant ~2 s: errors ~1e-7)
SIGMA_PX, SIGMA_BOUNCE_M = 1.0, 0.05


def net_height(x: float) -> float:
    """Net height (m) at court X: 0.914 at the centre strap, 1.07 at the posts, linear in between."""
    return NET_CENTRE_Z + (NET_POST_Z - NET_CENTRE_Z) * min(abs(x) / NET_POST_X, 1.0)


def _accel(vx: float, vy: float, vz: float, cd: float, c_lift: float) -> tuple[float, float, float]:
    s = math.sqrt(vx * vx + vy * vy + vz * vz)
    d = K * cd * s
    ax, ay, az = -d * vx, -d * vy, -G - d * vz
    if c_lift and s > 0:
        nx, ny, nz = vx * vz, vy * vz, vz * vz - s * s          # v (v.z) - z |v|^2: down, normal to v
        nn = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nn > 0:
            f = K * c_lift * s * s / nn
            ax, ay, az = ax + f * nx, ay + f * ny, az + f * nz
    return ax, ay, az


def _rk4(p: list[float], v: list[float], h: float, cd: float, c_lift: float) -> tuple[list[float], list[float]]:
    a1 = _accel(v[0], v[1], v[2], cd, c_lift)
    a2 = _accel(*(v[i] + 0.5 * h * a1[i] for i in range(3)), cd, c_lift)
    a3 = _accel(*(v[i] + 0.5 * h * a2[i] for i in range(3)), cd, c_lift)
    a4 = _accel(*(v[i] + h * a3[i] for i in range(3)), cd, c_lift)
    p2 = [p[i] + h * v[i] + h * h / 6 * (a1[i] + a2[i] + a3[i]) for i in range(3)]
    v2 = [v[i] + h / 6 * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]) for i in range(3)]
    return p2, v2


def simulate(p0, v0, ts, cd: float = CD, c_lift: float = 0.0, dt: float = DT,
             return_velocity: bool = False):
    """Positions (n, 3) (and velocities, with return_velocity) at times ts (s after launch, >= 0) of a ball
    launched from p0 (m) at v0 (m/s)."""
    ts = np.atleast_1d(np.asarray(ts, np.float64))
    order = np.argsort(ts)
    P, V = np.zeros((len(ts), 3)), np.zeros((len(ts), 3))
    p, v, t = [float(x) for x in p0], [float(x) for x in v0], 0.0
    cd, c_lift = float(cd), float(c_lift)
    for k in order:
        target = float(ts[k])
        if target < t - 1e-12:
            raise ValueError("times must be >= 0")
        steps = int(math.ceil((target - t) / dt - 1e-9))
        if steps > 0:
            h = (target - t) / steps
            for _ in range(steps):
                p, v = _rk4(p, v, h, cd, c_lift)
        t = target
        P[k], V[k] = p, v
    return (P, V) if return_velocity else P


def net_crossing(p0, v0, t_max: float, cd: float = CD, c_lift: float = 0.0) -> tuple[float, np.ndarray] | None:
    """(t, position) where the flight crosses Y = 0 before t_max, or None."""
    ts = np.arange(0.0, t_max + 1e-9, DT)
    P = simulate(p0, v0, ts, cd, c_lift)
    s = np.sign(P[:, 1])
    k = np.flatnonzero(s[:-1] * s[1:] < 0)
    if not len(k):
        return None
    k = int(k[0])
    w = P[k, 1] / (P[k, 1] - P[k + 1, 1])
    return float(ts[k] + w * (ts[k + 1] - ts[k])), P[k] + w * (P[k + 1] - P[k])


def net_clearance(p0, v0, t_max: float, cd: float = CD, c_lift: float = 0.0) -> float | None:
    """Height of the ball's bottom over the net where it crosses (m; negative: into the net)."""
    c = net_crossing(p0, v0, t_max, cd, c_lift)
    if c is None:
        return None
    _, p = c
    return float(p[2] - BALL_R - net_height(p[0]))


def _ray_at_height(cal: Calibration, uv, z: float) -> np.ndarray:
    d = np.linalg.inv(cal.K) @ np.array([uv[0], uv[1], 1.0])
    d = cal.R.T @ d
    c = cal.centre
    s = (z - c[2]) / d[2] if abs(d[2]) > 1e-9 else 10.0
    if s <= 0:
        s = 10.0 / np.linalg.norm(d)
    return c + s * d


def fit_shot(samples, cal: Calibration, bounce: dict | None = None, fit_lift: bool = False, cd: float = CD,
             hit_height_m: float = 1.0) -> dict:
    """Fit one shot's flight.

    samples       (n, 3) t (s, presentation time), u, v (px) from just after the hit to just before the bounce.
    bounce        {"t": t_star, "xy": (X, Y)} from contact_point, when the shot bounced in view.
    fit_lift      also fit c_lift (Phase 1 default: pure drag).
    hit_height_m  first guess of the ball's height at the first sample.
    """
    from scipy.optimize import least_squares

    s = np.asarray(samples, np.float64)
    t0 = s[0, 0]
    ts = s[:, 0] - t0
    p0 = _ray_at_height(cal, s[0, 1:], hit_height_m)
    if bounce is not None:
        T = bounce["t"] - t0
        b = np.r_[bounce["xy"], BALL_R]
        vxy = (b[:2] - p0[:2]) / T
        vz = (BALL_R - p0[2] + 0.5 * G * T * T) / T
        v0 = np.r_[vxy, vz] * 1.1                              # drag: a little faster at launch
    else:
        p1 = _ray_at_height(cal, s[-1, 1:], hit_height_m)
        v0 = (p1 - p0) / max(ts[-1], 1e-3)
        v0[2] += 0.5 * G * ts[-1]
    x0 = np.r_[p0, v0, [0.0] if fit_lift else []]

    def unpack(x):
        return x[:3], x[3:6], (x[6] if fit_lift else 0.0)

    def resid(x):
        p, v, cl = unpack(x)
        times = np.r_[ts, [bounce["t"] - t0]] if bounce is not None else ts
        P = simulate(p, v, times, cd, cl)
        r = ((project(cal, P[:len(ts)]) - s[:, 1:]) / SIGMA_PX).ravel()
        if bounce is not None:
            r = np.r_[r, (P[-1] - np.r_[bounce["xy"], BALL_R]) / SIGMA_BOUNCE_M]
        return r

    sol = least_squares(resid, x0, method="trf", x_scale=np.r_[[1.0] * 3, [10.0] * 3, [0.1] * fit_lift],
                        xtol=1e-10, ftol=1e-10, max_nfev=400)
    p, v, cl = unpack(sol.x)
    t_end = (bounce["t"] - t0) if bounce is not None else ts[-1] + 0.5
    out = {"p0": p.tolist(), "v0": v.tolist(), "c_lift": float(cl), "speed_mph": float(np.linalg.norm(v) * MPH),
           "speed_at_bounce_mph": None, "net_clearance_m": net_clearance(p, v, t_end, cd, cl),
           "rms_px": float(np.sqrt(np.mean(np.square(sol.fun[:2 * len(ts)])) * SIGMA_PX ** 2)),
           "ok": bool(sol.success)}
    if bounce is not None:
        _, V = simulate(p, v, [t_end], cd, cl, return_velocity=True)
        out["speed_at_bounce_mph"] = float(np.linalg.norm(V[0]) * MPH)
    return out
