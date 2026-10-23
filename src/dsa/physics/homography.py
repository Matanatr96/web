"""Metric court calibration from one frame: image pixels <-> court metres, on the ground and on the ball plane.

Court frame (metres, ITF dimensions to the outer edges of the lines): origin at the centre of the net, X to the
right as seen from the near baseline, Y towards the far baseline, Z up. COURT_M lists the 14 points in the order
of dsa.scene.court.POINTS (whose REF is ~2% off metric, so it is not reused for measuring); NET_POSTS_M are the
two doubles net posts at their 1.07 m tops.

  calibrate   image points of (some of) COURT_M + optionally the net posts -> Calibration: the pinhole camera
              (K, rvec, tvec; focal length searched when not given) from cv2.solvePnP, and from it
              H0  image -> court on Z = 0                 (feet, painted lines)
              Hr  image -> court on Z = BALL_R = 0.033 m  (the ball's centre when it touches the ground):
                  Hr = (K [r1  r2  BALL_R r3 + t])^-1. A bounce seen through H0 lands up to ~25 cm long at the
                  far baseline, because the camera sees the ball's centre, not its contact point.
  to_court    image pixels -> court metres through H0 or Hr.
  project     court metres (X, Y, Z) -> image pixels.
  reregister  a bumped camera: the frame registered onto frame 0 (ECC on the court-line image) and the
              calibration moved with it; returns the drift in pixels.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

BALL_R = 0.033                       # m: ball radius; its centre's height at contact
HALF_LEN, SERVICE = 11.885, 6.40     # m: baseline and service line distance from the net
SINGLES_HALF_W, DOUBLES_HALF_W = 4.115, 5.485
CENTRE_HALF_W = 0.025                # m: half-width of the 5 cm centre service line
NET_POST_X, NET_POST_Z = DOUBLES_HALF_W + 0.914, 1.07
NET_CENTRE_Z = 0.914

COURT_M = np.array([
    (-DOUBLES_HALF_W, HALF_LEN), (DOUBLES_HALF_W, HALF_LEN),          # far baseline, doubles corners
    (-DOUBLES_HALF_W, -HALF_LEN), (DOUBLES_HALF_W, -HALF_LEN),        # near baseline, doubles corners
    (-SINGLES_HALF_W, HALF_LEN), (-SINGLES_HALF_W, -HALF_LEN),        # left singles sideline, far / near
    (SINGLES_HALF_W, HALF_LEN), (SINGLES_HALF_W, -HALF_LEN),          # right singles sideline, far / near
    (-SINGLES_HALF_W, SERVICE), (SINGLES_HALF_W, SERVICE),            # far service line, left / right
    (-SINGLES_HALF_W, -SERVICE), (SINGLES_HALF_W, -SERVICE),          # near service line, left / right
    (0.0, SERVICE), (0.0, -SERVICE),                                  # far T, near T
], np.float64)
NET_POSTS_M = np.array([(-NET_POST_X, 0.0, NET_POST_Z), (NET_POST_X, 0.0, NET_POST_Z)], np.float64)
CORNERS = [0, 1, 2, 3]               # the 4 outer corners tapped on frame 0

F_RANGE = (0.3, 6.0)                 # focal length search, in image widths


@dataclass
class Calibration:
    """A calibrated camera and the image -> court homographies it implies."""

    K: np.ndarray
    rvec: np.ndarray
    tvec: np.ndarray
    size: tuple[int, int]
    rms_px: float
    H0: np.ndarray = field(init=False)
    Hr: np.ndarray = field(init=False)

    def __post_init__(self):
        self.K, self.rvec, self.tvec = (np.asarray(a, np.float64).reshape(s) for a, s in
                                        ((self.K, (3, 3)), (self.rvec, (3,)), (self.tvec, (3,))))
        self.H0, self.Hr = plane_homography(self, 0.0), plane_homography(self, BALL_R)

    @property
    def R(self) -> np.ndarray:
        return cv2.Rodrigues(self.rvec)[0]

    @property
    def centre(self) -> np.ndarray:
        """The camera's position in court metres."""
        return -self.R.T @ self.tvec

    def to_json(self) -> dict:
        """court.json v1."""
        return {"version": 1, "size": list(self.size), "K": self.K.tolist(), "rvec": self.rvec.tolist(),
                "tvec": self.tvec.tolist(), "rms_px": self.rms_px, "H0": self.H0.tolist(), "Hr": self.Hr.tolist(),
                "camera_m": self.centre.tolist()}

    @classmethod
    def from_json(cls, d: dict) -> Calibration:
        return cls(np.array(d["K"]), np.array(d["rvec"]), np.array(d["tvec"]), tuple(d["size"]), float(d["rms_px"]))


def plane_homography(cal: Calibration, z: float) -> np.ndarray:
    """Image -> court (X, Y) on the plane Z = z: (K [r1  r2  z r3 + t])^-1, normalised."""
    R = cal.R
    m = cal.K @ np.c_[R[:, 0], R[:, 1], z * R[:, 2] + cal.tvec]
    h = np.linalg.inv(m)
    return h / h[2, 2]


def to_court(H: np.ndarray, uv) -> np.ndarray:
    """Image pixels (..., 2) -> court metres (..., 2) through H (H0 or Hr)."""
    uv = np.asarray(uv, np.float64)
    p = np.c_[uv.reshape(-1, 2), np.ones(uv.size // 2)] @ H.T
    return (p[:, :2] / p[:, 2:3]).reshape(uv.shape)


def project(cal: Calibration, xyz) -> np.ndarray:
    """Court metres (..., 3) (or (..., 2) on the ground) -> image pixels (..., 2)."""
    xyz = np.asarray(xyz, np.float64)
    shape = xyz.shape[:-1]
    if xyz.shape[-1] == 2:
        xyz = np.concatenate([xyz, np.zeros(shape + (1,))], -1)
    cam = xyz.reshape(-1, 3) @ cal.R.T + cal.tvec
    p = cam @ cal.K.T
    return (p[:, :2] / p[:, 2:3]).reshape(shape + (2,))


def _object_points(court_idx, posts: bool) -> np.ndarray:
    pts = np.c_[COURT_M[list(court_idx)], np.zeros(len(court_idx))]
    return np.r_[pts, NET_POSTS_M] if posts else pts


def _solve(obj: np.ndarray, img: np.ndarray, K: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Pose of a camera with intrinsics K: SQPnP (global) then Levenberg-Marquardt; reprojection RMS in px."""
    obj32, img32 = obj.astype(np.float64)[:, None], img.astype(np.float64)[:, None]
    try:
        ok, rvec, tvec = cv2.solvePnP(obj32, img32, K, None, flags=cv2.SOLVEPNP_SQPNP)
    except cv2.error:
        return np.zeros(3), np.zeros(3), np.inf
    if not ok:
        return np.zeros(3), np.zeros(3), np.inf
    rvec, tvec = cv2.solvePnPRefineLM(obj32, img32, K, None, rvec, tvec)
    proj = cv2.projectPoints(obj32, rvec, tvec, K, None)[0].reshape(-1, 2)
    if np.any((obj @ cv2.Rodrigues(rvec)[0].T + tvec.ravel())[:, 2] <= 0):
        return rvec.ravel(), tvec.ravel(), np.inf                  # points behind the camera
    return rvec.ravel(), tvec.ravel(), float(np.sqrt(np.mean(np.sum((proj - img) ** 2, 1))))


def _K(f: float, size: tuple[int, int]) -> np.ndarray:
    return np.array([[f, 0, size[0] / 2], [0, f, size[1] / 2], [0, 0, 1]], np.float64)


def calibrate(court_px, size: tuple[int, int], court_idx=None, posts_px=None, K=None) -> Calibration:
    """Calibrate a fixed camera from one frame.

    court_px   (n, 2) image pixels of COURT_M[court_idx] (default: all 14 when n == 14, else the 4 corners).
    size       (width, height) of the frame.
    posts_px   (2, 2) image pixels of the tops of the left and right net posts (NET_POSTS_M), or None.
    K          3x3 intrinsics when known (e.g. from the phone); else square pixels, the principal point at the
               centre, no distortion, and the focal length that best reprojects every point.
    """
    court_px = np.asarray(court_px, np.float64).reshape(-1, 2)
    if court_idx is None:
        court_idx = list(range(14)) if len(court_px) == 14 else CORNERS[:len(court_px)]
    if len(court_idx) != len(court_px) or len(court_px) < 4:
        raise ValueError("need at least 4 court points, matching court_idx")
    posts = posts_px is not None
    obj = _object_points(court_idx, posts)
    img = np.r_[court_px, np.asarray(posts_px, np.float64).reshape(2, 2)] if posts else court_px
    if K is not None:
        r, t, rms = _solve(obj, img, np.asarray(K, np.float64))
        if not np.isfinite(rms):
            raise ValueError("calibration failed: no camera reprojects these points")
        return Calibration(np.asarray(K, np.float64), r, t, tuple(size), rms)
    w = size[0]
    cost = lambda lf: _solve(obj, img, _K(np.exp(lf) * w, size))[2]       # noqa: E731
    grid = np.linspace(np.log(F_RANGE[0]), np.log(F_RANGE[1]), 48)
    errs = np.array([cost(g) for g in grid])
    k = int(np.argmin(errs))
    lo, hi = grid[max(k - 1, 0)], grid[min(k + 1, len(grid) - 1)]
    from scipy.optimize import minimize_scalar
    best = minimize_scalar(cost, bounds=(lo, hi), method="bounded", options={"xatol": 1e-6})
    lf = best.x if best.fun <= errs[k] else grid[k]
    Kf = _K(np.exp(lf) * w, size)
    r, t, rms = _solve(obj, img, Kf)
    if not np.isfinite(rms):
        raise ValueError("calibration failed: no camera reprojects these points")
    return Calibration(Kf, r, t, tuple(size), rms)


def court_lines_image(cal: Calibration, thickness: int = 3) -> np.ndarray:
    """The painted lines as this camera sees them: a uint8 image, 255 on the lines (for tests and previews)."""
    from dsa.scene.court import LINES
    img = np.zeros((cal.size[1], cal.size[0]), np.uint8)
    for a, b in LINES:
        seg = np.linspace(COURT_M[a], COURT_M[b], 64)
        cv2.polylines(img, [np.round(project(cal, seg)).astype(np.int32)], False, 255, thickness, cv2.LINE_AA)
    return img


def _lines(bgr_or_grey: np.ndarray) -> np.ndarray:
    if bgr_or_grey.ndim == 3:
        from dsa.scene.court_snap import line_mask
        m = line_mask(bgr_or_grey)
    else:
        m = bgr_or_grey.astype(np.float32)
    return cv2.GaussianBlur(m, (0, 0), 2.0)


def reregister(cal: Calibration, frame0, frame, max_drift_px: float = 40.0) -> tuple[Calibration, float]:
    """The camera moved a little since frame 0 (wind, a bumped tripod): register `frame` onto `frame0` with
    ECC (a homography: exact for a camera that turns) on their court-line images (dsa.scene.court_snap.line_mask
    for colour frames, the image itself for single-channel line masks). H0 and Hr follow the image motion
    exactly (H . M^-1); the pose is re-solved with the same K from the moved court points (for project()).
    Returns the new calibration and the median drift of the court points in pixels; the old calibration and
    inf when registration fails or drifts more than max_drift_px (recalibrate)."""
    a, b = _lines(frame0), _lines(frame)
    warp = np.eye(3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(a, b, warp, cv2.MOTION_HOMOGRAPHY,
                                       (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-7), None, 5)
    except cv2.error:
        return cal, float("inf")
    M = warp.astype(np.float64)                         # frame0 pixels -> frame pixels
    obj = np.r_[np.c_[COURT_M, np.zeros(14)], NET_POSTS_M]
    old = project(cal, obj)
    p = np.c_[old, np.ones(len(old))] @ M.T
    new = p[:, :2] / p[:, 2:3]
    drift = float(np.median(np.linalg.norm(new[:14] - old[:14], axis=1)))
    if not np.isfinite(drift) or drift > max_drift_px:
        return cal, float("inf")
    r, t, rms = _solve(obj, new, cal.K)
    if not np.isfinite(rms):
        return cal, float("inf")
    try:
        Minv = np.linalg.inv(M)
    except np.linalg.LinAlgError:
        return cal, float("inf")
    moved = Calibration(cal.K, r, t, cal.size, rms)
    moved.H0, moved.Hr = (h / h[2, 2] for h in (cal.H0 @ Minv, cal.Hr @ Minv))
    return moved, drift
