"""Bounces, hits and line calls from a ball track, with sub-frame timing and an uncertainty on every call.

  ball_track          WASB-SBDT at step=3: frames (t, t+1, t+2) in, all three output heads read, one heatmap per
                      frame, so one pass covers three frames (20 passes/s at 60 fps) and no frame waits for the
                      next one. Rows: pts_s, found, u, v, score (native pixels, presentation timestamps).
  clean               drops blobs that sit still for STILL_FRAMES (a second ball, a logo) and jumps of more than
                      GATE_PX (at 512 x 288) from a constant-velocity prediction.
  candidates          samples where the ball turns sharply: hits and bounces.
  is_bounce           hit or bounce. The contact point is put on the ball plane (Hr) and a gravity arc through it
                      is fitted to the samples before and after (linear in the 3D velocity). A bounce keeps its
                      court-Y direction (sign of Y' the same before and after), comes down and goes up; a hit
                      reverses Y'. Samples above the horizon (E11: a lob above the camera) are left out; with fewer
                      than MIN_SIDE samples left on either side the 30 Hz CatBoost bounce model decides (or, without
                      one, the image's vertical turn).
  contact_point       sub-frame bounce: quadratics u(t), v(t) on the last FULL_SIDE samples before and the first
                      FULL_SIDE after (presentation timestamps, never frame numbers), t* where the two v curves
                      meet; samples optionally refined on the native frame (refine_roi). The pixel error goes
                      through the Jacobian of Hr into a 2 x 2 covariance in metres. 3 + 3 samples: sigma doubled;
                      fewer: unknown.
  call                margin_m (positive = out) against the region's lines and the verdict: out beyond +2 sigma,
                      in inside -2 sigma, close in between.
  classify_depth_zone deep (service line to baseline), short (net to service line), out_long, out_wide, net.
"""
from __future__ import annotations

from typing import Callable, Iterable, Sequence

import cv2
import numpy as np

from dsa.physics.homography import (BALL_R, DOUBLES_HALF_W, HALF_LEN, SERVICE, SINGLES_HALF_W, Calibration,
                                    to_court)

STEP = 3
SMALL_W, SMALL_H = 512, 288
HEAT_THRESHOLD = 0.5
MEAN, STD = np.float32([0.485, 0.456, 0.406]), np.float32([0.229, 0.224, 0.225])
GATE_PX, STILL_FRAMES, STILL_PX, REACQUIRE = 60.0, 10, 2.0, 6
MIN_SIDE, FULL_SIDE = 3, 4
KINK = 15.0                     # kink score (F-like ratio, ~6 on smooth flight) above which the path may kink
LOOK = 4                        # samples each side to judge a kink over
ARC_SIDE = 6                    # samples each side for the 3D bounce fit
REACH_M = 2.0                   # m beyond the court lines where a kink can still be a bounce
ARC_RETRY_PX = 2.0              # 3D bounce fit worse than this: refit on FULL_SIDE samples each side
BOUNCE_DVZ = 1.5                # m/s: a bounce raises the vertical velocity by at least this
MIN_GAP_S = 0.1                 # between two events
SIGMA_PX_FLOOR = 1.0            # native px: WASB + centroid error on a sharp 1/1000 s frame
G = 9.81
CATBOOST_HZ, CATBOOST_LAGS, CATBOOST_THRESHOLD = 30.0, 3, 0.45
ROI = 64
REGIONS = {                     # x0, x1, y0, y1 in court metres
    "singles": (-SINGLES_HALF_W, SINGLES_HALF_W, -HALF_LEN, HALF_LEN),
    "doubles": (-DOUBLES_HALF_W, DOUBLES_HALF_W, -HALF_LEN, HALF_LEN),
    "serve_deuce_far": (-SINGLES_HALF_W, 0.0, 0.0, SERVICE),
    "serve_ad_far": (0.0, SINGLES_HALF_W, 0.0, SERVICE),
    "serve_deuce_near": (0.0, SINGLES_HALF_W, -SERVICE, 0.0),
    "serve_ad_near": (-SINGLES_HALF_W, 0.0, -SERVICE, 0.0),
}
DEPTH_ZONES = ("deep", "short", "out_long", "out_wide", "net", "unknown")


# --- the ball track -----------------------------------------------------------------------------------------

def small(bgr: np.ndarray) -> np.ndarray:
    """A native BGR frame -> WASB's input: 512 x 288 RGB, ImageNet-normalised, (288, 512, 3) float32."""
    return (cv2.resize(bgr[:, :, ::-1], (SMALL_W, SMALL_H)).astype(np.float32) / 255 - MEAN) / STD


def blob(m: np.ndarray, W: int, H: int, threshold: float = HEAT_THRESHOLD) -> tuple[float, float, float, float]:
    """One heatmap (288, 512) of probabilities -> found, u, v, score: the heaviest connected blob above threshold,
    its probability-weighted centroid mapped to the W x H frame (as dsa.gpu.models.Ball.locate)."""
    if m.max() <= threshold:
        return 0.0, 0.0, 0.0, float(m.max())
    n, lab = cv2.connectedComponents((m > threshold).astype(np.uint8))
    best = max(range(1, n), key=lambda k: m[lab == k].sum())
    ys, xs = np.nonzero(lab == best)
    w = m[ys, xs]
    return 1.0, float((xs * w).sum() / w.sum() * W / SMALL_W), float((ys * w).sum() / w.sum() * H / SMALL_H), \
        float(w.sum())


def windows(n: int, step: int = STEP) -> list[tuple[list[int], list[int]]]:
    """The model's inputs for n frames: (the 3 frame indices stacked, the (head, frame) pairs read).
    step=3: non-overlapping triplets, heads 0, 1, 2 -> frames t, t+1, t+2; the last one padded with the last
    frame, its padded heads not read. step=1: (t-1, t, t+1) around every frame, head 1 only (upstream's way)."""
    if step == 3:
        out = []
        for s in range(0, n, 3):
            idx = [min(s + k, n - 1) for k in range(3)]
            out.append((idx, [(k, s + k) for k in range(3) if s + k < n]))
        return out
    if step == 1:
        return [([max(t - 1, 0), t, min(t + 1, n - 1)], [(1, t)]) for t in range(n)]
    raise ValueError("step must be 3 (all three heads) or 1 (middle head)")


def ball_track(frames: Iterable[np.ndarray], pts_s: Sequence[float], heatmaps: Callable[[np.ndarray], np.ndarray],
               step: int = STEP, batch: int = 8) -> np.ndarray:
    """Native BGR frames and their presentation timestamps -> (n, 5) pts_s, found, u, v, score.

    heatmaps: (B, 9, 288, 512) float32 (3 small() frames, channels-first, stacked oldest first) ->
    (B, 3, 288, 512) probabilities, head k for the k-th stacked frame (wasb_heatmaps on a GPU, the CoreML
    model on a phone, a stand-in in tests). Frames stream: only the 512 x 288 inputs of the windows waiting for
    the next batch are held, so a whole session fits in memory; pts_s may fill up while frames are read."""
    if step not in (1, 3):
        raise ValueError("step must be 3 (all three heads) or 1 (middle head)")
    smalls: dict[int, np.ndarray] = {}
    rows: dict[int, tuple[float, float, float, float]] = {}
    queue: list[tuple[list[int], list[tuple[int, int]]]] = []
    shape = {"W": 0, "H": 0}

    def run(force: bool, n: int) -> None:
        while queue and (force or len(queue) >= batch):
            chunk = queue[:batch]
            del queue[:batch]
            x = np.stack([np.concatenate([smalls[i] for i in idx], 0) for idx, _ in chunk]).astype(np.float32)
            for (_, reads), m in zip(chunk, np.asarray(heatmaps(x))):
                for head, f in reads:
                    rows[f] = blob(m[head], shape["W"], shape["H"])
            keep = min([min(idx) for idx, _ in queue] + [n - 2])
            for i in [k for k in smalls if k < keep]:
                del smalls[i]

    n = 0
    for i, f in enumerate(frames):
        if i == 0:
            shape["H"], shape["W"] = f.shape[:2]
        smalls[i] = small(f).transpose(2, 0, 1)
        n = i + 1
        if step == 3 and i % 3 == 2:
            queue.append(([i - 2, i - 1, i], [(0, i - 2), (1, i - 1), (2, i)]))
        elif step == 1 and i >= 1:
            queue.append(([max(i - 2, 0), i - 1, i], [(1, i - 1)]))
        run(False, n)
    if n:                                               # the tail: a padded last triplet / the last frame
        if step == 3 and n % 3:
            s0 = n - n % 3
            queue.append(([min(s0 + k, n - 1) for k in range(3)], [(k, s0 + k) for k in range(3) if s0 + k < n]))
        elif step == 1:
            queue.append(([max(n - 2, 0), n - 1, n - 1], [(1, n - 1)]))
        run(True, n)
    if len(pts_s) < n:
        raise ValueError("one timestamp per frame")
    out = np.zeros((n, 5), np.float64)
    out[:, 0] = np.asarray(pts_s, np.float64)[:n]
    for f, r in rows.items():
        out[f, 1:] = r
    return out


def wasb_heatmaps(device: str = "cuda") -> Callable[[np.ndarray], np.ndarray]:
    """WASB-SBDT with its tennis weights (dsa.gpu.models.Ball) as a heatmaps() function: all three heads."""
    from dsa.gpu.models import Ball

    ball = Ball(device)
    torch = ball.torch

    def run(x: np.ndarray) -> np.ndarray:
        t = torch.from_numpy(x).to(device)
        with torch.no_grad(), torch.autocast("cuda", torch.float16, enabled=device == "cuda"):
            return ball.model(t)[0].sigmoid().float().cpu().numpy()

    return run


def clean(track: np.ndarray, gate_px: float = GATE_PX, still_frames: int = STILL_FRAMES,
          width: float | None = None) -> np.ndarray:
    """E12: a copy of the track without blobs that stay put for still_frames detections (within STILL_PX at
    512 x 288: a second ball on the ground, a logo) and without jumps of more than gate_px (at 512 x 288) from
    the constant-velocity prediction of the last two kept samples. After REACQUIRE frames without a kept sample
    the next detection starts a new track (a new rally, a re-feed). width: the frame's width in pixels (default:
    the widest detection, which slightly overstates the scale)."""
    out = track.copy()
    ok = out[:, 1] > 0
    if not ok.any():
        return out
    W = width or max(out[ok, 2].max(), SMALL_W)
    p = out[:, 2:4] * (SMALL_W / W)                      # native -> 512 x 288 pixels
    run = 0
    for i in range(len(out)):                            # still blobs
        if ok[i] and i > 0 and ok[i - 1] and np.linalg.norm(p[i] - p[i - 1]) < STILL_PX:
            run += 1
        else:
            if run + 1 >= still_frames:
                ok[i - run - 1:i] = False
            run = 0
    if run + 1 >= still_frames:
        ok[len(out) - run - 1:] = False
    kept: list[int] = []
    for i in np.flatnonzero(ok):
        if kept and i - kept[-1] > REACQUIRE:
            kept = []
        if len(kept) >= 2:
            a, b = kept[-2], kept[-1]
            dt_ab = out[b, 0] - out[a, 0]
            pred = p[b] + (p[b] - p[a]) * (out[i, 0] - out[b, 0]) / dt_ab if dt_ab > 0 else p[b]
            if np.linalg.norm(p[i] - pred) > gate_px:
                ok[i] = False
                continue
        kept.append(int(i))
    out[~ok, 1] = 0
    return out


def frame_width(track: np.ndarray) -> float:
    ok = track[:, 1] > 0
    return float(max(track[ok, 2].max(), 1.0)) if ok.any() else 1.0


# --- events -------------------------------------------------------------------------------------------------

def _rss_quad(s: np.ndarray) -> float:
    """Residual sum of squares (px^2) of one quadratic in t per image coordinate; s rows (t, u, v)."""
    if len(s) <= 3:
        return 0.0
    t0 = s[:, 0].mean()
    return float(sum(np.sum((np.polyval(np.polyfit(s[:, 0] - t0, s[:, c], 2), s[:, 0] - t0) - s[:, c]) ** 2)
                     for c in (1, 2)))


def noise_px(track: np.ndarray, n: int = 2 * LOOK + 1) -> float:
    """The track's pixel noise: the median over sliding windows of one quadratic's residual (floored)."""
    ok = np.flatnonzero(track[:, 1] > 0)
    s = track[:, [0, 2, 3]]
    r = [_rss_quad(s[ok[j:j + n]]) / (2 * (n - 3)) for j in range(0, len(ok) - n + 1)]
    return max(float(np.sqrt(np.median(r))) if r else SIGMA_PX_FLOOR, 0.1)


def kink_scores(track: np.ndarray, look: int = LOOK) -> dict[int, float]:
    """Per found sample i: how much better two quadratics (up to i, after i) explain the 2 look + 1 samples
    around it than one does, in units of the track's noise variance (~chi^2 with 6 dof where the flight is
    smooth). Smooth turns of the image path (a ball flying away passes its apex) score low; hits and bounces,
    where the velocity jumps, score high."""
    ok = np.flatnonzero(track[:, 1] > 0)
    s, t = track[:, [0, 2, 3]], track[:, 0]
    var = noise_px(track) ** 2
    out = {}
    for j in range(look, len(ok) - look):
        w = ok[j - look:j + look + 1]
        if t[w[-1]] - t[w[0]] > 2 * look * 2.5 / 60:                       # a gap in the track
            continue
        rss1 = _rss_quad(s[w])
        rss2 = min(_rss_quad(s[w[:k]]) + _rss_quad(s[w[k:]]) for k in (look, look + 1))
        out[int(ok[j])] = (rss1 - rss2) / max(rss2 / (4 * look + 2 - 12), var)
    return out


def refine_kink(track: np.ndarray, i: int, look: int = LOOK, reach: int = 3) -> int:
    """The sample, within reach of i, after which the path kinks: over the fixed stretch of reach + look samples
    either side of i, the split into two quadratics (every sample on one side or the other) that leaves the
    least residual. Kink scores peak a couple of samples either side of a kink, not on it."""
    ok = np.flatnonzero(track[:, 1] > 0)
    s = track[:, [0, 2, 3]]
    j0 = int(np.searchsorted(ok, i))
    lo, hi = max(j0 - reach - look, 0), min(j0 + reach + look + 1, len(ok))
    best = (np.inf, i)
    for j in range(max(j0 - reach, lo + MIN_SIDE - 1), min(j0 + reach, hi - MIN_SIDE - 1) + 1):
        r = _rss_quad(s[ok[lo:j + 1]]) + _rss_quad(s[ok[j + 1:hi]])
        if r < best[0]:
            best = (r, int(ok[j]))
    return best[1]


def candidates(track: np.ndarray, threshold: float = KINK) -> np.ndarray:
    """Indices of samples where the ball's path kinks (hits and bounces): kink_scores above threshold, each
    moved onto its kink (refine_kink), the strongest kept where two are less than MIN_GAP_S apart."""
    t = track[:, 0]
    score = {i: s for i, s in kink_scores(track).items() if s > threshold}
    peaks = [i for i in score if score[i] >= max(score.get(k, 0.0) for k in range(i - LOOK, i + LOOK + 1))]
    moved: dict[int, float] = {}
    for i in peaks:
        j = refine_kink(track, i)
        moved[j] = max(moved.get(j, 0.0), score[i])
    out: list[int] = []
    for i in sorted(moved, key=lambda k: -moved[k]):
        if all(abs(t[i] - t[k]) >= MIN_GAP_S for k in out):
            out.append(i)
    return np.array(sorted(out), int)


def _sides(track: np.ndarray, i: int, n: int = FULL_SIDE, span_s: float = 0.25) -> tuple[np.ndarray, np.ndarray]:
    """Found samples before and after the kink at i, at most n each and within span_s of it; of the splits
    (i on the before or the after side) the one whose two quadratic fits leave the least residual."""
    ok = track[:, 1] > 0
    t = track[:, 0]
    best = None
    for split in (i - 1, i, i + 1):
        if split < 0 or split + 1 >= len(track):
            continue
        pre = [k for k in range(split, -1, -1) if ok[k] and t[split] - t[k] <= span_s][:n][::-1]
        post = [k for k in range(split + 1, len(track)) if ok[k] and t[k] - t[split + 1] <= span_s][:n]
        if len(pre) < MIN_SIDE or len(post) < MIN_SIDE:
            continue
        s = track[:, [0, 2, 3]]
        r = _rss_quad(s[pre]) + _rss_quad(s[post])
        if best is None or r < best[0] - 1e-9:
            best = (r, pre, post)
    if best is None:
        pre = [k for k in range(i, -1, -1) if ok[k] and t[i] - t[k] <= span_s][:n][::-1]
        post = [k for k in range(i + 1, len(track)) if ok[k] and t[k] - t[i] <= span_s][:n]
        return np.array(pre, int), np.array(post, int)
    return np.array(best[1], int), np.array(best[2], int)


def _quad(t: np.ndarray, y: np.ndarray, t0: float) -> np.ndarray:
    return np.polyfit(t - t0, y, min(2, len(t) - 1))


def refine_roi(bgr: np.ndarray, uv, size: int = ROI) -> np.ndarray:
    """A coarse ball position (from the 512 x 288 heatmap) -> the centroid of the optic-yellow blob in the
    size x size crop of the native frame around it; unchanged when no blob stands out."""
    u, v = float(uv[0]), float(uv[1])
    h, w = bgr.shape[:2]
    x0, y0 = int(round(u)) - size // 2, int(round(v)) - size // 2
    xa, ya, xb, yb = max(x0, 0), max(y0, 0), min(x0 + size, w), min(y0 + size, h)
    if xb - xa < 4 or yb - ya < 4:
        return np.array([u, v])
    c = bgr[ya:yb, xa:xb].astype(np.float32)
    s = (c[:, :, 1] + c[:, :, 2]) / 2 - c[:, :, 0]                    # (G + R) / 2 - B: yellow
    s -= np.median(s)
    if s.max() < 40:
        return np.array([u, v])
    m = np.where(s >= 0.5 * s.max(), s, 0)
    n, lab = cv2.connectedComponents((m > 0).astype(np.uint8))
    best = max(range(1, n), key=lambda k: m[lab == k].sum())
    ys, xs = np.nonzero(lab == best)
    wt = m[ys, xs]
    return np.array([xa + (xs * wt).sum() / wt.sum(), ya + (ys * wt).sum() / wt.sum()])


def jacobian(H: np.ndarray, uv) -> np.ndarray:
    """d(X, Y) / d(u, v) of the homography H at uv (2 x 2, metres per pixel)."""
    x = H @ np.array([uv[0], uv[1], 1.0])
    return (H[:2, :2] * x[2] - np.outer(x[:2], H[2, :2])) / x[2] ** 2


def subframe(pre: np.ndarray, post: np.ndarray) -> tuple[float, np.ndarray]:
    """(t, u, v) samples before and after a bounce -> t*, (u*, v*): quadratics in t on each side, t* the root
    of pre_v(t) = post_v(t) nearest the middle of the gap (u when v gives none, else the closest approach)."""
    t0 = (pre[-1, 0] + post[0, 0]) / 2
    dt = max(post[0, 0] - pre[-1, 0], 1e-4)
    lo, hi = pre[-1, 0] - dt - t0, post[0, 0] + dt - t0
    fits = [(_quad(pre[:, 0], pre[:, c], t0), _quad(post[:, 0], post[:, c], t0)) for c in (1, 2)]
    ts = None
    for a, b in (fits[1], fits[0]):
        d = np.polysub(a, b)
        roots = np.roots(d) if np.any(np.abs(d) > 1e-12) else np.array([])
        roots = roots[np.isreal(roots)].real if len(roots) else roots
        roots = roots[(roots >= lo) & (roots <= hi)] if len(roots) else roots
        if len(roots):
            ts = float(roots[np.argmin(np.abs(roots))])
            break
    if ts is None:
        g = np.linspace(lo, hi, 401)
        d2 = sum((np.polyval(a, g) - np.polyval(b, g)) ** 2 for a, b in fits)
        ts = float(g[np.argmin(d2)])
    uv = np.array([(np.polyval(a, ts) + np.polyval(b, ts)) / 2 for a, b in fits])
    return ts + t0, uv


def _rays(cal: Calibration, uv: np.ndarray) -> np.ndarray:
    d = np.c_[uv, np.ones(len(uv))] @ np.linalg.inv(cal.K).T @ cal.R      # camera rays in court axes
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def _arc_solve(cal: Calibration, pre: np.ndarray, post: np.ndarray, t_star: float, z: float, iters: int = 3):
    """For a fixed contact time: the contact point (X, Y) on the plane Z = z and the velocities into and out of
    it that best reproject the (t, u, v) samples, each side a ballistic arc (gravity + drag, the drag held at
    its value for the current velocity estimate). Linear least squares on the projection equations, rows
    divided by the point's depth so the error is in pixels; refined iters times. -> theta (8,), its
    covariance per px^2, rms px."""
    M = cal.K @ np.c_[cal.R, cal.tvec]
    from dsa.physics.ballistics import CD, K as KD
    v_pre, v_post = np.zeros(3), np.zeros(3)
    depth = None
    for _ in range(iters):
        A, y, rows = [], [], []
        for side, (s, v) in enumerate(((pre, v_pre), (post, v_post))):
            acc = np.array([0.0, 0.0, -G]) - KD * CD * np.linalg.norm(v) * v
            for t, u, w in s:
                dt = t - t_star
                base = np.array([0.0, 0.0, z]) + 0.5 * acc * dt * dt
                for r in (M[0] - u * M[2], M[1] - w * M[2]):
                    a = np.zeros(8)
                    a[0:2] = r[:2]
                    a[2 + 3 * side:5 + 3 * side] = r[:3] * dt
                    A.append(a)
                    y.append(-(r[:3] @ base + r[3]))
                    rows.append((side, t, base))
        A, y = np.array(A), np.array(y)
        if depth is not None:
            A, y = A / depth[:, None], y / depth
        theta = np.linalg.lstsq(A, y, rcond=None)[0]
        v_pre, v_post = theta[2:5], theta[5:8]
        X = np.array([np.r_[theta[0], theta[1], 0.0] + b + (v_pre if sd == 0 else v_post) * (t - t_star)
                      for sd, t, b in rows])
        depth = np.maximum(X @ M[2, :3] + M[2, 3], 1e-3)
    resid = A @ theta - y
    cov = np.linalg.pinv(A.T @ A)
    return theta, cov, float(np.sqrt(np.mean(resid ** 2)))


def arc_fit(cal: Calibration, pre: np.ndarray, post: np.ndarray, z: float = BALL_R) -> dict:
    """The bounce hypothesis as 3D physics: the contact time t* (searched across the gap between the last
    sample before and the first after), the contact point on Z = z and the 3D velocities into and out of it.
    -> {t_star, xy, v_pre, v_post, cov_xy (per px^2), rms_px}."""
    from scipy.optimize import minimize_scalar

    dt = max(post[0, 0] - pre[-1, 0], 1e-4)
    lo, hi = pre[-1, 0] - 0.25 * dt, post[0, 0] + 0.25 * dt
    cost = lambda ts: _arc_solve(cal, pre, post, ts, z, iters=2)[2]    # noqa: E731
    grid = np.linspace(lo, hi, 9)
    k = int(np.argmin([cost(g) for g in grid]))
    r = minimize_scalar(cost, bounds=(grid[max(k - 1, 0)], grid[min(k + 1, 8)]), method="bounded",
                        options={"xatol": 1e-5})
    ts = float(r.x)
    theta, cov, rms = _arc_solve(cal, pre, post, ts, z)
    return {"t_star": ts, "xy": theta[:2], "v_pre": theta[2:5], "v_post": theta[5:8], "cov_xy": cov[:2, :2],
            "rms_px": rms}


def contact_point(track: np.ndarray, i: int, cal: Calibration,
                  frame_at: Callable[[int], np.ndarray] | None = None, method: str = "quadratic") -> dict:
    """The bounce near sample i: t_star (s), uv (px), xy (court metres on the ball plane Hr), cov (2 x 2 m^2),
    sigma_px and the sample counts; ok False (call unknown) with fewer than MIN_SIDE samples on either side.

    method      'quadratic': FULL_SIDE samples each side, subframe() t*, xy = Hr(uv*), cov through Hr's Jacobian
                (the on-phone method, CourtGeometry.swift). 'arc': arc_fit() on up to ARC_SIDE samples each side,
                xy and its covariance from the 3D fit (the server's method: several times less noisy far out).
    frame_at(k) native BGR frame k, when given: each sample is refined on the native frame first (refine_roi).
    """
    pre, post = _sides(track, i, n=FULL_SIDE if method == "quadratic" else ARC_SIDE)
    res = {"ok": False, "n_pre": len(pre), "n_post": len(post), "t_star": None, "uv": None, "xy": None,
           "cov": None, "sigma_px": None, "method": method}
    if len(pre) < MIN_SIDE or len(post) < MIN_SIDE:
        return res
    s = track[:, [0, 2, 3]].copy()
    if frame_at is not None:
        for k in np.r_[pre, post]:
            s[k, 1:] = refine_roi(frame_at(int(k)), s[k, 1:])
    a, b = s[pre], s[post]
    dof = sum(max(len(x) - 3, 0) for x in (a, b))
    sigma = max(SIGMA_PX_FLOOR, float(np.sqrt((_rss_quad(a) + _rss_quad(b)) / (2 * dof))) if dof else 0.0)
    if min(len(a), len(b)) < FULL_SIDE:
        sigma *= 2
    if method == "arc":
        f = arc_fit(cal, a, b)
        xy = f["xy"]
        res.update(ok=True, t_star=f["t_star"], xy=xy, uv=project_ground(cal, xy), cov=sigma ** 2 * f["cov_xy"],
                   sigma_px=sigma, v_pre=f["v_pre"], v_post=f["v_post"])
        return res
    ts, uv = subframe(a, b)
    J = jacobian(cal.Hr, uv)
    res.update(ok=True, t_star=ts, uv=uv, xy=to_court(cal.Hr, uv), cov=sigma ** 2 * J @ J.T, sigma_px=sigma)
    return res


def project_ground(cal: Calibration, xy) -> np.ndarray:
    from dsa.physics.homography import project
    return project(cal, np.r_[xy, BALL_R])


def catboost_features(track: np.ndarray, i: int, hz: float = CATBOOST_HZ, lags: int = CATBOOST_LAGS) -> np.ndarray:
    """The 30 Hz bounce model's inputs at sample i (TennisProject's recipe): for lag k = 1..lags-1, the ball's
    x and y differences to k samples before and after (resampled at hz) and their ratios."""
    ok = track[:, 1] > 0
    t, p = track[ok, 0], track[ok, 2:4]
    t_i = track[i, 0]
    at = lambda tt: np.array([np.interp(tt, t, p[:, 0]), np.interp(tt, t, p[:, 1])])   # noqa: E731
    c, f = at(t_i), []
    for k in range(1, lags):
        b, a = at(t_i - k / hz), at(t_i + k / hz)
        dx, dy, dxi, dyi = abs(b[0] - c[0]), b[1] - c[1], a[0] - c[0], a[1] - c[1]
        f += [dx, dy, dxi, dyi, abs(dx / (dxi + 1e-15)), dy / (dyi + 1e-15)]
    return np.array(f, np.float64)


def _image_v_turn(track: np.ndarray, i: int, n: int = LOOK) -> tuple[float, float] | None:
    """Image-v velocity (px/s, down positive) just before and just after the kink at i (lines on n samples)."""
    a, b = _sides(track, i, n=n)
    if len(a) < 2 or len(b) < 2:
        return None
    return float(np.polyfit(track[a, 0], track[a, 3], 1)[0]), float(np.polyfit(track[b, 0], track[b, 3], 1)[0])


def classify_event(track: np.ndarray, i: int, cal: Calibration, catboost=None) -> dict:
    """What happened at the kink near sample i -> {kind: 'bounce' | 'hit' | 'none', bounce, method, half, ...}.

    One camera behind the court cannot see motion along its rays: far out, the ray is nearly horizontal, so a
    change of the ball's court-Y velocity hardly moves it in the image (a plain sign test of Hr-projected Y'
    gets far bounces wrong). So:
      out_of_reach  the kink seen through Hr lands more than REACH_M beyond the court: the ball was in the air
                    (a ball 0.3 m up at the far baseline projects 2+ m long): hit.
      far half      (inside reach) a bounce comes down and goes up, so the image-v velocity flips from down to
                    up (the component the camera does see): bounce; else none (a smooth turn, noise).
      near half     court_y: the bounce hypothesis fitted in 3D (arc_fit: contact on the ball plane, gravity +
                    drag arcs in and out, rays steep enough to see Y'). Y' reversed and the ball going up: hit;
                    coming down and Z' raised by more than BOUNCE_DVZ: bounce; else none.
    Samples whose rays point above the horizon are left out (E11: a lob above the camera); with fewer than
    MIN_SIDE left on either side, TennisProject's 30 Hz CatBoost bounce model decides when given (catboost:
    a fitted catboost model), else the image-v flip."""
    uv = track[i, 2:4]
    xy = to_court(cal.Hr, uv) if _rays(cal, uv[None])[0, 2] < 0 else np.array([0.0, np.inf])
    half = "near" if xy[1] < 0 else "far"
    out = {"half": half, "xy_proj": xy}
    if abs(xy[1]) > HALF_LEN + REACH_M or abs(xy[0]) > DOUBLES_HALF_W + REACH_M:
        return out | {"kind": "hit", "bounce": False, "method": "out_of_reach"}
    pre, post = _sides(track, i, n=ARC_SIDE)
    below = lambda ks: [k for k in ks if _rays(cal, track[[k], 2:4])[0, 2] < 0]    # noqa: E731
    pre, post = below(pre), below(post)
    vv = _image_v_turn(track, i)
    if len(pre) < MIN_SIDE or len(post) < MIN_SIDE:
        if catboost is not None:
            x = catboost_features(track, i)[None]
            p = catboost.predict_proba(x)[0, 1] if hasattr(catboost, "predict_proba") else catboost.predict(x)[0]
            b = bool(p > CATBOOST_THRESHOLD)
            return out | {"kind": "bounce" if b else "hit", "bounce": b, "method": "catboost", "p": float(p)}
        b = vv is not None and vv[0] > 0 > vv[1]
        return out | {"kind": "bounce" if b else "hit", "bounce": b, "method": "image_v"}
    s = track[:, [0, 2, 3]]
    if half == "far":
        b = vv is not None and vv[0] > 0 > vv[1]
        t_star, uv_star = subframe(s[pre[-FULL_SIDE:]], s[post[:FULL_SIDE]]) if b else (None, None)
        return out | {"kind": "bounce" if b else "none", "bounce": b, "method": "image_v", "v_px_s": vv,
                      "t_star": t_star, "xy": to_court(cal.Hr, uv_star) if b else None}
    f = arc_fit(cal, s[pre], s[post])
    j = int(np.argmin(np.abs(track[:, 0] - f["t_star"])))
    if j != i and abs(track[j, 0] - f["t_star"]) < abs(track[i, 0] - f["t_star"]) - 1e-3:
        pre2, post2 = (below(x) for x in _sides(track, j, n=ARC_SIDE))     # re-centred on the fitted contact
        if len(pre2) >= MIN_SIDE and len(post2) >= MIN_SIDE:
            f = arc_fit(cal, s[pre2], s[post2])
    if f["rms_px"] > ARC_RETRY_PX:                 # another event inside the window: fit fewer samples
        pre3, post3 = (below(x) for x in _sides(track, i, n=FULL_SIDE))
        if len(pre3) >= MIN_SIDE and len(post3) >= MIN_SIDE:
            f3 = arc_fit(cal, s[pre3], s[post3])
            f = f3 if f3["rms_px"] < f["rms_px"] else f
    v1, v2 = f["v_pre"], f["v_post"]
    if np.sign(v1[1]) != np.sign(v2[1]) and v2[2] > 0:
        kind = "hit"                                  # sent back, and up (to clear the net)
    elif v1[2] < 0 and v2[2] - v1[2] > BOUNCE_DVZ:
        kind = "bounce"                               # came down, kicked up by the court
    else:
        kind = "none"
    return out | {"kind": kind, "bounce": kind == "bounce", "method": "court_y", "vy_pre": float(v1[1]),
                  "vy_post": float(v2[1]), "vz_pre": float(v1[2]), "vz_post": float(v2[2]),
                  "t_star": f["t_star"], "xy": f["xy"], "rms_px": f["rms_px"]}


def is_bounce(track: np.ndarray, i: int, cal: Calibration, catboost=None) -> dict:
    """Hit or bounce at the kink near sample i: classify_event() with a boolean 'bounce' (False for hits and
    for kinks that are neither)."""
    return classify_event(track, i, cal, catboost)


def infer_hit(track: np.ndarray, cal: Calibration, bounce: dict, nxt: dict, inside: list[int]) -> dict | None:
    """The unseen hit between a bounce and the next event on the other half: two ballistic arcs, out of the
    bounce's contact point and (when the next event is a bounce) into the next contact point, that meet at the
    hit. For each candidate hit time the arcs' velocities are a linear least-squares fit (continuity at the hit
    weighted in); the time with the least reprojection error wins. -> {t, xyz} or None without anchors."""
    if bounce.get("xy") is None or bounce.get("t_star") is None:
        return None
    s = track[inside][:, [0, 2, 3]]
    M = cal.K @ np.c_[cal.R, cal.tvec]
    g = np.array([0.0, 0.0, -G])
    b1, t1 = np.r_[bounce["xy"], BALL_R], bounce["t_star"]
    two = nxt["kind"] == "bounce" and nxt.get("xy") is not None and nxt.get("t_star") is not None
    b2, t2 = (np.r_[nxt["xy"], BALL_R], nxt["t_star"]) if two else (None, None)

    def solve(th):
        A, y = [], []
        for t, u, v in s:
            first = t <= th or not two
            dt = t - (t1 if first else t2)
            base = (b1 if first else b2) + 0.5 * g * dt * dt
            for r in (M[0] - u * M[2], M[1] - v * M[2]):
                a = np.zeros(6)
                a[0 if first else 3:3 if first else 6] = r[:3] * dt
                depth = max(M[2, :3] @ base + M[2, 3], 1.0)
                A.append(a / depth)
                y.append(-(r[:3] @ base + r[3]) / depth)
        if two:                                         # the arcs meet at the hit: 100 px per metre apart
            w = 100.0 / cal.K[0, 0]
            rhs = b2 - b1 + 0.5 * g * ((th - t2) ** 2 - (th - t1) ** 2)
            for k in range(3):
                a = np.zeros(6)
                a[k], a[3 + k] = (th - t1), -(th - t2)
                A.append(a * w * cal.K[0, 0])
                y.append(rhs[k] * w * cal.K[0, 0])
        A, y = np.array(A), np.array(y)
        th_ = np.linalg.lstsq(A, y, rcond=None)[0]
        return th_, float(np.sum((A @ th_ - y) ** 2))

    if not two:
        return None
    ts = s[:, 0]
    costs = [solve(th)[1] for th in ts[1:-1]]
    if not costs:
        return None
    th = float(ts[1 + int(np.argmin(costs))])
    v1 = solve(th)[0][:3]
    return {"t": th, "xyz": (b1 + v1 * (th - t1) + 0.5 * g * (th - t1) ** 2).tolist()}


def events(track: np.ndarray, cal: Calibration, catboost=None) -> list[dict]:
    """Every hit and bounce in a ball track, in time order: [{i, t, kind, half, inferred, ...}].

    candidates() -> classify_event(), 'none' dropped, then the rally's grammar, which also fills in what one
    camera misses:
      - a player does not hit twice in a row: a hit right after a hit on the same half is dropped (a smooth turn
        of a ball flying high over the net projects out of reach too);
      - a hit out of reach needs a bounce on its half since the last hit (else: a high ball in flight);
      - a bounce on the same half within MIN_GAP_S * 3 of the last one is the same bounce;
      - a far player's hit sends the ball back almost along the camera's ray (no kink to see): when a bounce is
        followed by an event on the other half with no hit between, the hit is inferred (inferred=True) at the
        strongest kink between them, or where the ball is highest in the image."""
    raw = []
    for i in candidates(track):
        c = classify_event(track, int(i), cal, catboost)
        if c["kind"] != "none":
            t = c.get("t_star") if c["kind"] == "bounce" and c.get("t_star") is not None else float(track[i, 0])
            raw.append({"i": int(i), "t": float(t), "inferred": False} | c)
    out: list[dict] = []
    ok = np.flatnonzero(track[:, 1] > 0)
    start = None                                        # the track starts just after a hit (a feed, a serve)
    if len(ok):
        y0 = to_court(cal.Hr, track[ok[0], 2:4])[1]
        start = {"kind": "hit", "t": float(track[ok[0], 0]), "half": "near" if y0 < 0 else "far"}
    for e in raw:
        last_hit = next((x for x in reversed(out) if x["kind"] == "hit"), start)
        prev = out[-1] if out else None
        if e["kind"] == "hit":
            before = prev if prev is not None else start
            if before is not None and before["kind"] == "hit" and before["half"] == e["half"]:
                continue
            if e["method"] == "out_of_reach" and last_hit is not None and not any(
                    x["kind"] == "bounce" and x["half"] == e["half"] and x["t"] > last_hit["t"] for x in out):
                continue
        elif prev is not None and prev["kind"] == "bounce" and prev["half"] == e["half"] and \
                e["t"] - prev["t"] < 3 * MIN_GAP_S:
            continue
        if prev is not None and prev["kind"] == "bounce" and prev["half"] != e["half"]:
            t = track[:, 0]
            lo, hi = prev["t"] + 0.15, e["t"] - 0.15                     # outside both events' kink windows
            inside = [k for k in range(prev["i"] + 1, e["i"]) if track[k, 1] > 0 and lo <= t[k] <= hi]
            if inside:
                h = infer_hit(track, cal, prev, e, inside)
                best = int(np.argmin(np.abs(t - h["t"]))) if h else min(inside, key=lambda k: track[k, 3])
                out.append({"i": best, "t": float(h["t"] if h else t[best]), "kind": "hit", "half": prev["half"],
                            "inferred": True, "bounce": False, "method": "grammar"} | ({"xyz": h["xyz"]} if h else {}))
        out.append(e)
    return out


# --- calls --------------------------------------------------------------------------------------------------

def margin(xy, region: str = "singles") -> tuple[float, np.ndarray]:
    """Signed distance (m, positive = out) of a bounce from the region's boundary, as the largest excess over
    its four edges, and the outward normal of that edge."""
    x0, x1, y0, y1 = REGIONS[region]
    X, Y = float(xy[0]), float(xy[1])
    ex = [(x0 - X, (-1.0, 0.0)), (X - x1, (1.0, 0.0)), (y0 - Y, (0.0, -1.0)), (Y - y1, (0.0, 1.0))]
    m, n = max(ex, key=lambda e: e[0])
    return m, np.array(n)


def call(xy, sigma, region: str = "singles") -> dict:
    """{call, margin_m, sigma_m}: out when margin_m > 2 sigma_m, in when < -2 sigma_m, else close; unknown
    when xy is None. sigma: sigma_m along the edge's normal (float) or a 2 x 2 covariance in m^2."""
    if xy is None or sigma is None:
        return {"call": "unknown", "margin_m": None, "sigma_m": None}
    m, n = margin(xy, region)
    s = np.asarray(sigma, np.float64)
    sm = float(np.sqrt(n @ s @ n)) if s.ndim == 2 else float(s)
    verdict = "out" if m > 2 * sm else "in" if m < -2 * sm else "close"
    return {"call": verdict, "margin_m": round(float(m), 4), "sigma_m": round(sm, 4)}


def region_for(session_type: str, doubles: bool = False, serve: str | None = None) -> str:
    """Rally mode judges every shot, the first one too (a feed), against the full court; match mode judges a
    serve ('deuce_far', 'ad_near', ...) against its box."""
    if session_type == "match" and serve:
        return f"serve_{serve}"
    return "doubles" if doubles else "singles"


def classify_depth_zone(xy, doubles: bool = False, hitter: str | None = None) -> str:
    """Where a bounce landed: out_long / out_wide outside the court (the larger excess wins at a corner), deep
    from the service line to the baseline, short from the net to the service line; net when the hitter
    ('near' / 'far') is given and the ball bounced on the hitter's own side; unknown without xy."""
    if xy is None:
        return "unknown"
    X, Y = float(xy[0]), float(xy[1])
    if hitter in ("near", "far") and (Y < 0 if hitter == "near" else Y > 0):
        return "net"
    hw = DOUBLES_HALF_W if doubles else SINGLES_HALF_W
    ey, ex = abs(Y) - HALF_LEN, abs(X) - hw
    if ey > 0 and ey >= ex:
        return "out_long"
    if ex > 0:
        return "out_wide"
    return "short" if abs(Y) <= SERVICE else "deep"
