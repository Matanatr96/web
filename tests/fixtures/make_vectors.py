"""Writes tests/fixtures/{score,linecall}_vectors.json: golden vectors shared by the Python tests and the Swift
XCTests (ios/TennisVision/Tests). Every expectation below is written out by hand from the rules (ITF scoring,
ITF court dimensions); only the homography and sub-frame cases are computed, from a made-up camera and exact
quadratics, independently of dsa.physics.

    uv run python tests/fixtures/make_vectors.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
G = lambda w: ("M" if w == "me" else "O") * 4          # noqa: E731  (a love game)


def games(order: str) -> str:
    """'MOM' -> three love games won by me, opp, me."""
    return "".join(G("me" if c == "M" else "opp") for c in order)


SCORE = {"version": 1, "cases": [
    {"name": "first point", "config": {}, "points": "M",
     "expect": {"sets": [], "games": [0, 0], "points": "15-0", "server": "me", "side": "ad", "display": "0-0 15-0",
                "winner": None}},
    {"name": "love game: the receiver serves next", "config": {}, "points": "MMMM",
     "expect": {"sets": [], "games": [1, 0], "points": "0-0", "server": "opp", "side": "deuce",
                "display": "1-0 0-0", "winner": None}},
    {"name": "deuce", "config": {}, "points": "MMMOOO",
     "expect": {"sets": [], "games": [0, 0], "points": "40-40", "server": "me", "side": "deuce",
                "display": "0-0 40-40", "winner": None}},
    {"name": "advantage receiver", "config": {}, "points": "MMMOOOO",
     "expect": {"sets": [], "games": [0, 0], "points": "40-AD", "server": "me", "side": "ad",
                "display": "0-0 40-AD", "winner": None}},
    {"name": "two deuces then game", "config": {}, "points": "MMMOOOMOMM",
     "expect": {"sets": [], "games": [1, 0], "points": "0-0", "server": "opp", "side": "deuce",
                "display": "1-0 0-0", "winner": None}},
    {"name": "no-ad deciding point", "config": {"no_ad": True}, "points": "MMMOOOO",
     "expect": {"sets": [], "games": [0, 1], "points": "0-0", "server": "opp", "side": "deuce",
                "display": "0-1 0-0", "winner": None}},
    {"name": "no-ad at 40-40 shows 40-40", "config": {"no_ad": True}, "points": "MMMOOO",
     "expect": {"sets": [], "games": [0, 0], "points": "40-40", "server": "me", "side": "deuce",
                "display": "0-0 40-40", "winner": None}},
    {"name": "opponent serves first", "config": {"first_server": "opp"}, "points": "OOOO",
     "expect": {"sets": [], "games": [0, 1], "points": "0-0", "server": "me", "side": "deuce",
                "display": "0-1 0-0", "winner": None}},
    {"name": "set 6-4", "config": {}, "points": games("MOMOMOMOMM"),
     "expect": {"sets": [[6, 4]], "games": [0, 0], "points": "0-0", "server": "me", "side": "deuce",
                "display": "6-4 0-0 0-0", "winner": None}},
    {"name": "7-5 set (no tiebreak at 6-5)", "config": {}, "points": games("MOMOMOMOMO") + games("MM"),
     "expect": {"sets": [[7, 5]], "games": [0, 0], "points": "0-0", "server": "me", "side": "deuce",
                "display": "7-5 0-0 0-0", "winner": None}},
    {"name": "tiebreak at 6-6, mid-way (3 points: server rotates after the first)", "config": {},
     "points": games("MOMOMOMOMOMO") + "MMO",
     "expect": {"sets": [], "games": [6, 6], "points": "2-1", "server": "me", "side": "ad",
                "display": "6-6 2-1", "winner": None}},
    {"name": "tiebreak won 7-5: the first tiebreak receiver serves the next set", "config": {},
     "points": games("MOMOMOMOMOMO") + "MMOOMMOOMO" + "MM",
     "expect": {"sets": [[7, 6]], "games": [0, 0], "points": "0-0", "server": "opp", "side": "deuce",
                "display": "7-6 0-0 0-0", "winner": None}},
    {"name": "match 6-0 6-0", "config": {}, "points": games("M" * 12),
     "expect": {"sets": [[6, 0], [6, 0]], "games": [0, 0], "points": "0-0", "server": "me", "side": "deuce",
                "display": "6-0 6-0", "winner": "me"}},
    {"name": "match tiebreak to 10 instead of a third set", "config": {"match_tiebreak": True},
     "points": games("M" * 6) + games("O" * 6) + "MOMOMOMOMOMOMOMO" + "MM",
     "expect": {"sets": [[6, 0], [0, 6], [1, 0]], "games": [0, 0], "points": "0-0", "server": "opp",
                "side": "deuce", "display": "6-0 0-6 1-0", "winner": "me"}},
], "rally": [
    {"name": "all in", "shots": [{"t_hit_s": 0.0, "call": "in", "depth_zone": "deep"},
                                 {"t_hit_s": 1.2, "call": "in", "depth_zone": "short"},
                                 {"t_hit_s": 2.4, "call": "in", "depth_zone": "deep"},
                                 {"t_hit_s": 3.6, "call": "in", "depth_zone": "deep"}],
     "expect": {"shot_count": 4, "in_streak": 4, "played_on_after_out": False, "deep_pct": 75.0}},
    {"name": "played on after an out ball", "shots": [{"t_hit_s": 0.0, "call": "in", "depth_zone": "deep"},
                                                      {"t_hit_s": 1.3, "call": "out", "depth_zone": "out_long"},
                                                      {"t_hit_s": 2.5, "call": "in", "depth_zone": "deep"},
                                                      {"t_hit_s": 3.7, "call": "in", "depth_zone": "short"}],
     "expect": {"shot_count": 4, "in_streak": 1, "played_on_after_out": True, "deep_pct": 50.0}},
    {"name": "ends on an out ball", "shots": [{"t_hit_s": 0.0, "call": "in", "depth_zone": "deep"},
                                              {"t_hit_s": 1.1, "call": "in", "depth_zone": "deep"},
                                              {"t_hit_s": 2.2, "call": "out", "depth_zone": "out_wide"}],
     "expect": {"shot_count": 3, "in_streak": 2, "played_on_after_out": False, "deep_pct": 66.7}},
    {"name": "unknown and close keep the streak", "shots": [
        {"t_hit_s": 0.0, "call": "unknown", "depth_zone": "unknown"},
                                                            {"t_hit_s": 1.0, "call": "in", "depth_zone": "deep"},
                                                            {"t_hit_s": 2.0, "call": "close", "depth_zone": "short"},
                                                            {"t_hit_s": 3.0, "call": "out", "depth_zone": "out_long"},
                                                            {"t_hit_s": 4.0, "call": "in", "depth_zone": "deep"}],
     "expect": {"shot_count": 5, "in_streak": 3, "played_on_after_out": True, "deep_pct": 50.0}},
    {"name": "a single feed", "shots": [{"t_hit_s": 0.0, "call": "in", "depth_zone": "deep"}],
     "expect": {"shot_count": 1, "in_streak": 1, "played_on_after_out": False, "deep_pct": 100.0}},
    {"name": "out ball not returned within 3.5 s", "shots": [{"t_hit_s": 0.0, "call": "in", "depth_zone": "deep"},
                                                             {"t_hit_s": 1.0, "call": "out", "depth_zone": "out_long"},
                                                             {"t_hit_s": 5.0, "call": "in", "depth_zone": "deep"}],
     "expect": {"shot_count": 3, "in_streak": 1, "played_on_after_out": False, "deep_pct": 66.7}},
]}

LINECALL_CASES = [
    # name, xy, sigma_m, region, doubles(for zone), hitter, call, margin_m, depth_zone
    ("centre, deep, well in", [0.0, 9.0], 0.02, "singles", False, None, "in", -2.885, "deep"),
    ("2 cm past the far baseline is close at sigma 2 cm", [1.0, 11.905], 0.02, "singles", False, None, "close",
     0.02, "out_long"),
    ("6.5 cm long is out", [1.0, 11.95], 0.02, "singles", False, None, "out", 0.065, "out_long"),
    ("6.5 cm inside the singles sideline is in", [4.05, 3.0], 0.02, "singles", False, None, "in", -0.065, "short"),
    ("near baseline, 1 cm in: close", [-2.0, -11.875], 0.02, "singles", False, None, "close", -0.01, "deep"),
    ("doubles alley: in for doubles", [5.0, 8.0], 0.03, "doubles", True, None, "in", -0.485, "deep"),
    ("doubles alley: out for singles", [5.0, 8.0], 0.03, "singles", False, None, "out", 0.885, "out_wide"),
    ("past the corner: the larger excess", [4.2, 12.0], 0.02, "singles", False, None, "out", 0.115, "out_long"),
    ("wide, not long", [4.4, 11.9], 0.02, "singles", False, None, "out", 0.285, "out_wide"),
    ("serve into the far deuce box", [-2.0, 5.0], 0.03, "serve_deuce_far", False, None, "in", -1.4, "short"),
    ("serve into the wrong box", [1.0, 5.0], 0.03, "serve_deuce_far", False, None, "out", 1.0, "short"),
    ("serve 5 cm long", [-1.0, 6.45], 0.02, "serve_deuce_far", False, None, "out", 0.05, "deep"),
    ("serve on the centre line is close", [0.01, 3.0], 0.02, "serve_deuce_far", False, None, "close", 0.01, "short"),
    ("serve into the near ad box", [-1.0, -3.0], 0.02, "serve_ad_near", False, None, "in", -1.0, "short"),
    ("serve into the near deuce box", [2.0, -6.0], 0.05, "serve_deuce_near", False, None, "in", -0.4, "short"),
    ("netted: bounced on the hitter's own side", [0.0, -3.0], 0.02, "singles", False, "near", "in", -4.115, "net"),
    ("no contact point", None, None, "singles", False, None, "unknown", None, "unknown"),
]


def camera():
    """The same made-up camera as tests/physics/synth.py: (0, -15.5, 3.5) m looking at (0, -6, 0), f = 800."""
    import cv2

    cam, at, f, size = np.array([0, -15.5, 3.5]), np.array([0, -6.0, 0]), 800.0, (1920, 1080)
    fwd = (at - cam) / np.linalg.norm(at - cam)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    R = np.stack([right, np.cross(fwd, right), fwd])
    t = -R @ cam
    K = np.array([[f, 0, size[0] / 2], [0, f, size[1] / 2], [0, 0, 1]])
    return K, R, t, cv2


def homography_cases():
    K, R, t, _ = camera()
    out = []
    for name, z in (("H0: ground plane", 0.0), ("Hr: ball-centre plane z = 0.033 m", 0.033)):
        P = K @ np.c_[R[:, 0], R[:, 1], z * R[:, 2] + t]
        H = np.linalg.inv(P)
        H /= H[2, 2]
        for xy in ([0.0, 0.0], [4.115, 11.885], [-5.485, -11.885], [1.5, 6.4]):
            p = P @ np.r_[xy, 1.0]
            out.append({"name": f"{name} at {xy}", "plane_z": z, "H": np.round(H, 12).tolist(),
                        "uv": np.round(p[:2] / p[2], 6).tolist(), "xy": xy})
    return out


def subframe_cases():
    out = []
    for name, ts, fps, (a1, b1), (a2, b2), u in (
            ("60 fps, contact 7 ms after the last sample", 0.507, 60.0, (310.0, 400.0), (-260.0, 300.0),
             (900.0, -40.0)),
            ("30 fps, contact mid-gap", 1.25 + 1 / 60, 30.0, (180.0, 200.0), (-150.0, 150.0), (1200.0, 25.0))):
        v0 = 500.0
        last = np.floor(ts * fps) / fps
        pre_t = last - np.arange(3, -1, -1) / fps
        post_t = last + np.arange(1, 5) / fps
        f = lambda tt, a, b, v0=v0, ts=ts: v0 + a * (tt - ts) + b * (tt - ts) ** 2     # noqa: E731
        uu = lambda tt, u=u, ts=ts: u[0] + u[1] * (tt - ts)                            # noqa: E731
        out.append({"name": name, "pre": [[round(x, 6), round(uu(x), 6), round(f(x, a1, b1), 6)] for x in pre_t],
                    "post": [[round(x, 6), round(uu(x), 6), round(f(x, a2, b2), 6)] for x in post_t],
                    "t_star": round(ts, 6), "uv_star": [round(u[0], 6), v0]})
    return out


def main():
    (HERE / "score_vectors.json").write_text(json.dumps(SCORE, indent=1) + "\n")
    lc = {"version": 1, "conventions": {
        "frame": "metres, origin at the net centre, X right (from the near baseline), Y to the far baseline",
        "margin_m": "max over the region's edges of the excess outside it (positive = out)",
        "call": "out if margin > 2 sigma, in if margin < -2 sigma, else close; unknown without xy",
        "depth_zone": ("net (bounce on the hitter's half), out_long / out_wide (larger excess wins), "
                       "short (|Y| <= 6.40), deep")},
        "cases": [{"name": n, "xy": xy, "sigma_m": s, "region": r, "doubles": d, "hitter": h,
                   "expect": {"call": c, "margin_m": m, "depth_zone": z}}
                  for n, xy, s, r, d, h, c, m, z in LINECALL_CASES],
        "homography": homography_cases(), "subframe": subframe_cases()}
    (HERE / "linecall_vectors.json").write_text(json.dumps(lc, indent=1) + "\n")


if __name__ == "__main__":
    main()
