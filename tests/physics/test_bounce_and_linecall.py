"""Ball track, hit vs bounce, sub-frame contact point, line calls and depth zones (dsa.physics.bounce_and_linecall)
on made-up rallies (tests/physics/synth.py) and the shared golden vectors."""
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from dsa.physics import bounce_and_linecall as B
from dsa.physics.homography import BALL_R, project

from synth import rally, true_camera

VECTORS = json.loads((Path(__file__).parents[1] / "fixtures/linecall_vectors.json").read_text())
CAL = true_camera()


# --- the ball track: step=3, all three heads -----------------------------------------------------------------

def _frames(n, W=1280, H=720):
    """Frame i is a flat grey of level 10 + 2 i, so a stand-in model can tell which frame it was given."""
    return [np.full((H, W, 3), 10 + 2 * i, np.uint8) for i in range(n)]


class StandIn:
    """heatmaps(): reads each stacked frame's grey level back out of the 9 channels and puts a blob for frame
    i at x = 20 + 10 i (512 x 288 pixels) in that frame's head."""

    def __init__(self):
        self.calls, self.batches = 0, []

    def __call__(self, x):
        self.calls += 1
        self.batches.append(len(x))
        out = np.zeros((len(x), 3, 288, 512), np.float32)
        for b in range(len(x)):
            for k in range(3):
                level = (x[b, 3 * k:3 * k + 3].mean(axis=(1, 2)) * B.STD + B.MEAN).mean() * 255
                i = int(round((level - 10) / 2))
                cv2.circle(out[b, k], (20 + 10 * i, 100), 2, 0.9, -1)
        return out


def test_ball_track_step3_reads_all_three_heads():
    n = 10                                                          # 4 passes; the last padded, only head 0 read
    model = StandIn()
    tr = B.ball_track(_frames(n), [i / 60 for i in range(n)], model, step=3, batch=2)
    assert sum(model.batches) == 4                                  # ceil(10 / 3) passes, not 10
    assert tr[:, 1].tolist() == [1.0] * n
    assert np.allclose(tr[:, 2], [(20 + 10 * i) * 1280 / 512 for i in range(n)], atol=0.5)  # head k -> frame t+k
    assert np.allclose(tr[:, 3], 100 * 720 / 288, atol=0.5)
    assert np.allclose(tr[:, 0], [i / 60 for i in range(n)])


def test_ball_track_step1_reads_the_middle_head():
    model = StandIn()
    tr = B.ball_track(_frames(5), [i / 30 for i in range(5)], model, step=1)
    assert sum(model.batches) == 5
    assert np.allclose(tr[:, 2], [(20 + 10 * i) * 1280 / 512 for i in range(5)], atol=0.5)
    with pytest.raises(ValueError):
        B.windows(5, step=2)


def test_windows_cover_every_frame_once():
    for n in range(1, 12):
        reads = [f for _, r in B.windows(n, 3) for _, f in r]
        assert reads == list(range(n))
        assert all(max(idx) < n for idx, _ in B.windows(n, 3))


def test_blob_heaviest_component_and_threshold():
    m = np.zeros((288, 512), np.float32)
    cv2.circle(m, (100, 50), 2, 0.6, -1)
    cv2.circle(m, (300, 200), 4, 0.9, -1)
    found, u, v, s = B.blob(m, 1024, 576)
    assert found == 1.0 and (u, v) == pytest.approx((600, 400), abs=0.5)
    assert B.blob(m * 0.5, 1024, 576)[0] == 0.0


def test_clean_drops_a_still_ball_and_a_jump():
    n = 40
    t = np.arange(n) / 60
    tr = np.c_[t, np.ones(n), 400 + 8 * np.arange(n), 300 + 2 * np.arange(n), np.ones(n)]
    tr[20, 2:4] = [1500, 100]                                       # a false blob far off the track
    still = tr.copy()
    still[:, 2:4] = [900, 500]                                      # a second ball lying on the court
    out = B.clean(tr, gate_px=60)
    assert out[20, 1] == 0 and out[np.r_[0:20, 21:n], 1].all()
    assert not B.clean(still)[:, 1].any()


# --- the sub-frame contact point ------------------------------------------------------------------------------

@pytest.mark.parametrize("case", VECTORS["subframe"], ids=[c["name"] for c in VECTORS["subframe"]])
def test_subframe_vectors(case):
    ts, uv = B.subframe(np.array(case["pre"]), np.array(case["post"]))
    assert ts == pytest.approx(case["t_star"], abs=1e-6)
    assert uv == pytest.approx(case["uv_star"], abs=1e-3)


def test_contact_point_recovers_t_star_within_2ms():
    """Noise-free drag flights at 60 fps with VFR jitter: the 4 + 4 sample quadratic intersection (the phone's
    method) and the 3D arc fit (the server's) put the bounce within 2 ms and the contact on Hr within 2 cm."""
    rng = np.random.default_rng(5)
    for _ in range(12):
        track, events, _ = rally(rng, CAL, noise_px=0.0)
        for te, kind, p in events:
            if kind != "bounce":
                continue
            i = B.refine_kink(track, int(np.argmin(np.abs(track[:, 0] - te))))
            for method in ("quadratic", "arc"):
                c = B.contact_point(track, i, CAL, method=method)
                assert c["ok"] and abs(c["t_star"] - te) < 0.002, (method, c["t_star"] - te)
                assert np.linalg.norm(c["xy"] - p[:2]) < 0.02, method


def test_contact_point_sigma_is_honest_and_occlusion_widens_it():
    """0.3 px noise: errors fall within 2 sigma about as often as a Gaussian's (>= 90%); with 3 + 3 samples the
    sigma doubles (E8) and with fewer the call is unknown."""
    rng = np.random.default_rng(6)
    z = []
    for _ in range(25):
        track, events, _ = rally(rng, CAL, noise_px=0.3)
        for te, kind, p in events:
            if kind == "bounce":
                i = B.refine_kink(track, int(np.argmin(np.abs(track[:, 0] - te))))
                c = B.contact_point(track, i, CAL, method="arc")
                e = c["xy"] - p[:2]
                z.append(float(np.sqrt(e @ np.linalg.solve(c["cov"], e))))   # Mahalanobis, 2 dof
    assert np.mean(np.array(z) < 2.45) >= 0.90                      # 2-dof chi: 95% within 2.45
    track, events, _ = rally(np.random.default_rng(7), CAL, noise_px=0.3)
    te = next(e[0] for e in events if e[1] == "bounce")
    i = B.refine_kink(track, int(np.argmin(np.abs(track[:, 0] - te))))
    full = B.contact_point(track, i, CAL)
    hidden = track.copy()
    pre, post = B._sides(track, i)
    hidden[max(pre[1] - 30, 0):pre[1], 1] = 0                      # the net band hides the ball before ...
    hidden[post[-2] + 1:post[-2] + 30, 1] = 0                       # ... and a player after: 3 + 3 samples left
    three = B.contact_point(hidden, i, CAL)
    assert (three["n_pre"], three["n_post"]) == (3, 3) and three["sigma_px"] == pytest.approx(2 * full["sigma_px"],
                                                                                            rel=0.5)
    hidden[pre[1], 1] = 0
    gone = B.contact_point(hidden, i, CAL)
    assert not gone["ok"] and B.call(gone["xy"], gone["cov"])["call"] == "unknown"


def test_refine_roi_finds_the_yellow_ball_on_the_native_frame():
    f = np.full((1080, 1920, 3), (60, 120, 70), np.uint8)
    cv2.circle(f, (1000, 500), 4, (40, 230, 220), -1, cv2.LINE_AA)  # BGR optic yellow
    assert B.refine_roi(f, (1006.0, 497.0)) == pytest.approx([1000, 500], abs=0.3)
    blank = np.full((1080, 1920, 3), (60, 120, 70), np.uint8)
    assert B.refine_roi(blank, (1006.0, 497.0)).tolist() == [1006.0, 497.0]


# --- hits vs bounces ------------------------------------------------------------------------------------------

def test_hit_vs_bounce_separation_on_200_trajectories():
    """200 made-up baseline rallies (drag flights, COR 0.75 bounces, 0.3 px noise, 60 fps VFR), 800 events:
    near hit -> far bounce -> far hit -> near bounce -> near hit. Every event classified correctly."""
    rng = np.random.default_rng(11)
    wrong = []
    for r in range(200):
        track, events, _ = rally(rng, CAL, noise_px=0.3)
        for te, kind, p in events:
            i = B.refine_kink(track, int(np.argmin(np.abs(track[:, 0] - te))))
            got = B.classify_event(track, i, CAL)["kind"]
            if got != kind:
                wrong.append((r, kind, got, p.round(2).tolist()))
    assert wrong == []


def test_far_bounces_fool_a_plain_projected_y_sign_test():
    """Why classify_event does not use sign(Y') through Hr far out: the ball's descent projects as backwards
    travel, so a far bounce looks like a hit."""
    track, events, _ = rally(np.random.default_rng(3), CAL, noise_px=0.0)
    te = next(e[0] for e in events if e[1] == "bounce" and e[2][1] > 0)
    i = B.refine_kink(track, int(np.argmin(np.abs(track[:, 0] - te))))
    pre, post = B._sides(track, i)
    from dsa.physics.homography import to_court
    y = to_court(CAL.Hr, track[:, 2:4])[:, 1]
    vi, vo = np.polyfit(track[pre, 0], y[pre], 1)[0], np.polyfit(track[post, 0], y[post], 1)[0]
    assert np.sign(vi) != np.sign(vo)                               # the naive test says "hit"
    assert B.classify_event(track, i, CAL)["kind"] == "bounce"


def test_events_find_the_rally():
    """End to end on the ball track alone: bounces found within 30 ms (recall and precision >= 95%); hits,
    including the far player's (inferred from the rally's grammar: they barely kink from behind the court),
    within 250 ms (>= 85%: the inferred ones are the weak spot of one camera behind the court)."""
    rng = np.random.default_rng(21)
    st = {k: [0, 0, 0] for k in ("hit", "bounce")}                  # found, missed, extra
    for _ in range(40):
        track, events, _ = rally(rng, CAL, noise_px=0.3)
        got = B.events(track, CAL)
        used = set()
        for te, kind, _p in events:
            tol = 0.25 if kind == "hit" else 0.03
            m = sorted((j for j, g in enumerate(got) if g["kind"] == kind and abs(g["t"] - te) < tol and j not in used),
                       key=lambda j: abs(got[j]["t"] - te))
            if m:
                used.add(m[0])
                st[kind][0] += 1
            else:
                st[kind][1] += 1
        for j, g in enumerate(got):
            if j not in used:
                st[g["kind"]][2] += 1
    rec = {k: v[0] / (v[0] + v[1]) for k, v in st.items()}
    prec = {k: v[0] / (v[0] + v[2]) for k, v in st.items()}
    assert rec["bounce"] >= 0.95 and prec["bounce"] >= 0.95, st
    assert rec["hit"] >= 0.85 and prec["hit"] >= 0.85, st


def test_catboost_decides_when_the_ball_is_above_the_horizon():
    """E11: a lob above the camera (rays pointing up) leaves too few samples for the 3D fit: the 30 Hz
    CatBoost model decides when given, else the image's vertical turn."""
    track, events, _ = rally(np.random.default_rng(3), CAL, noise_px=0.0)
    te = next(e[0] for e in events if e[1] == "bounce" and e[2][1] < 0)
    i = B.refine_kink(track, int(np.argmin(np.abs(track[:, 0] - te))))
    lob = track.copy()
    horizon = project(CAL, [[0.0, 1e4, 3.5]])[0, 1]
    pre, post = B._sides(track, i, n=B.ARC_SIDE)
    lob[post[1:], 3] = horizon - 50                                 # after the contact: above the horizon

    class Model:
        def __init__(self, p):
            self.p, self.seen = p, None

        def predict_proba(self, x):
            self.seen = x
            return np.array([[1 - self.p, self.p]])

    yes, no = Model(0.9), Model(0.1)
    a = B.classify_event(lob, i, CAL, catboost=yes)
    assert (a["method"], a["kind"]) == ("catboost", "bounce") and yes.seen.shape == (1, 18)
    assert B.classify_event(lob, i, CAL, catboost=no)["kind"] == "hit"
    assert B.classify_event(lob, i, CAL)["method"] == "image_v"
    assert B.catboost_features(track, i).shape == (18,)


def test_out_bounces_beyond_reach_in_court_far_hits_and_preroll_serve():
    """Out bounces > 2 m long/wide are still classified as bounces (not out_of_reach hits); far hits inside
    the baseline and downward near smashes/serves are classified as hits; pre-roll before a serve preserves
    the real first hit in events()."""
    from dsa.physics import ballistics as BL
    from synth import COR, FRICTION, aim, landing

    fps = 60.0
    # 1. Far out bounce > 2 m beyond the baseline (Y = 14.5 m > 11.885 + 2.0)
    p0 = np.array([0.5, -11.5, 1.1])
    v0 = aim(p0, [-1.0, 14.5], 1.1)
    tl, pl, vl = landing(p0, v0)
    vb = np.r_[vl[:2] * FRICTION, -vl[2] * COR]
    t1, t2 = np.arange(0.05, tl, 1 / fps), np.arange(tl, tl + 0.35, 1 / fps)
    ts = np.r_[t1, t2]
    uv = project(CAL, np.vstack([BL.simulate(p0, v0, t1), BL.simulate(pl, vb, t2 - tl)]))
    tr_out = np.c_[ts, np.ones(len(ts)), uv, np.ones(len(ts))]
    i_out = B.refine_kink(tr_out, int(np.argmin(np.abs(ts - tl))))
    assert B.classify_event(tr_out, i_out, CAL)["kind"] == "bounce"

    # 2. Far hit inside the baseline (bounce at Y = 5.5 m, hit at Y ~ 9.2 m)
    v_in = aim(p0, [0.5, 5.5], 0.9)
    tl2, pl2, vl2 = landing(p0, v_in)
    vb2 = np.r_[vl2[:2] * FRICTION, -vl2[2] * COR]
    th2 = 0.45
    ph2 = BL.simulate(pl2, vb2, [th2])[0]
    assert ph2[1] < 11.885
    v_ret = aim(ph2, [-1.5, -9.0], 1.0)
    t_a, t_b, t_c = np.arange(0.05, tl2, 1 / fps), np.arange(tl2, tl2 + th2, 1 / fps), np.arange(tl2 + th2, tl2 + th2 + 0.5, 1 / fps)
    ts2 = np.r_[t_a, t_b, t_c]
    xyz2 = np.vstack([BL.simulate(p0, v_in, t_a), BL.simulate(pl2, vb2, t_b - tl2), BL.simulate(ph2, v_ret, t_c - (tl2 + th2))])
    uv2 = project(CAL, xyz2)
    tr_in = np.c_[ts2, np.ones(len(ts2)), uv2, np.ones(len(ts2))]
    i_hit = B.refine_kink(tr_in, int(np.argmin(np.abs(ts2 - (tl2 + th2)))))
    assert B.classify_event(tr_in, i_hit, CAL)["kind"] == "hit"

    # 3. Pre-roll (1.5 s) before an elevated near-baseline serve at Z = 2.85 m
    p_srv = np.array([0.4, -11.95, 2.85])
    v_srv = aim(p_srv, [-2.6, 5.9], 0.43)
    tb_s, pb_s, vb_s = landing(p_srv, v_srv)
    t_pre = np.arange(0.0, 1.5, 1 / fps)
    xyz_pre = np.c_[np.full_like(t_pre, 0.4), np.full_like(t_pre, -11.95), 2.85 - 0.5 * 9.81 * (t_pre - 1.5) ** 2]
    t_fl = np.arange(1.5, 1.5 + tb_s, 1 / fps)
    t_po = np.arange(1.5 + tb_s, 1.5 + tb_s + 0.35, 1 / fps)
    ts_s = np.r_[t_pre, t_fl, t_po]
    xyz_s = np.vstack([xyz_pre, BL.simulate(p_srv, v_srv, t_fl - 1.5),
                       BL.simulate(pb_s, np.r_[vb_s[:2] * FRICTION, -vb_s[2] * COR], t_po - (1.5 + tb_s))])
    vis_s = (ts_s >= 1.0).astype(float)
    tr_srv = np.c_[ts_s, vis_s, project(CAL, xyz_s), vis_s]
    evs = B.events(tr_srv, CAL)
    assert len(evs) >= 2 and evs[0]["kind"] == "hit" and evs[0]["half"] == "near"
    assert abs(evs[0]["t"] - 1.5) < 0.05 and evs[1]["kind"] == "bounce"


# --- calls and depth zones ------------------------------------------------------------------------------------

@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_linecall_vectors(case):
    got = B.call(case["xy"], case["sigma_m"], case["region"], hitter=case["hitter"])
    assert got["call"] == case["expect"]["call"]
    if case["expect"]["margin_m"] is None:
        assert got["margin_m"] is None
    else:
        assert got["margin_m"] == pytest.approx(case["expect"]["margin_m"], abs=1e-6)
    assert B.classify_depth_zone(case["xy"], case["doubles"], case["hitter"]) == case["expect"]["depth_zone"]


def test_call_measures_sigma_across_the_nearest_line():
    cov = np.diag([0.01 ** 2, 0.10 ** 2])                           # 1 cm across, 10 cm along the court
    side = B.call([4.09, 0.0], cov, "singles")                      # 2.5 cm inside the sideline
    base = B.call([0.0, 11.86], cov, "singles")                     # 2.5 cm inside the baseline
    assert (side["call"], side["sigma_m"]) == ("in", 0.01)
    assert (base["call"], base["sigma_m"]) == ("close", 0.1)


def test_rally_mode_judges_every_shot_on_the_full_court():
    assert B.region_for("rally") == "singles"
    assert B.region_for("rally", doubles=True) == "doubles"
    assert B.region_for("rally", serve="deuce_far") == "singles"    # a feed is never judged as a serve (E2)
    assert B.region_for("match", serve="deuce_far") == "serve_deuce_far"
    assert B.classify_depth_zone([0.0, -3.0], hitter="far") == "short"
    assert B.classify_depth_zone([0.0, -3.0], hitter="near") == "net"
    assert B.classify_depth_zone([0.0, 6.4]) == "short" and B.classify_depth_zone([0.0, 6.41]) == "deep"
    assert B.BALL_R == BALL_R


def test_ball_track_streams_frames_and_timestamps():
    """A generator of frames (a whole session never sits in memory) with timestamps filled as it is read."""
    pts, model = [], StandIn()

    def frames():
        for i, f in enumerate(_frames(8)):
            pts.append(i / 59.94)
            yield f

    tr = B.ball_track(frames(), pts, model, batch=1)
    assert len(tr) == 8 and sum(model.batches) == 3
    assert np.allclose(tr[:, 0], [i / 59.94 for i in range(8)])
    assert np.allclose(tr[:, 2], [(20 + 10 * i) * 1280 / 512 for i in range(8)], atol=0.5)
    assert B.ball_track(iter([]), [], model).shape == (0, 5)


def test_ball_track_hysteresis_recovers_blurred_peaks_along_trajectory():
    """Two-stage hysteresis: unseeded weak blobs (< 0.5) are ignored, while motion-blurred frames (0.28..0.48)
    within 0.1 s and max_jump_px of the constant-velocity prediction are recovered without picking up distant noise."""
    def weak_model(x):
        out = np.zeros((len(x), 3, 288, 512), np.float32)
        for b in range(len(x)):
            for k in range(3):
                level = (x[b, 3 * k:3 * k + 3].mean(axis=(1, 2)) * B.STD + B.MEAN).mean() * 255
                i = int(round((level - 10) / 2))
                cx = 40 + 12 * i
                if i == 0:
                    cv2.circle(out[b, k], (cx, 120), 2, 0.36, -1)               # unseeded weak blob -> ignored
                elif i in (1, 2, 5):
                    cv2.circle(out[b, k], (cx, 120), 2, 0.85, -1)               # strong blobs
                elif i in (3, 4):
                    cv2.circle(out[b, k], (cx, 120), 2, 0.34, -1)               # motion-blurred fast ball -> recovered
                    cv2.circle(out[b, k], (450, 250), 4, 0.45, -1)              # stronger distant distractor -> gated out
        return out

    tr = B.ball_track(_frames(6), [i / 60 for i in range(6)], weak_model, step=3)
    assert tr[0, 1] == 0.0
    assert tr[1:, 1].tolist() == [1.0] * 5
    assert np.allclose(tr[1:, 2], [(40 + 12 * i) * 1280 / 512 for i in range(1, 6)], atol=0.6)


def test_margin_net_guard_matches_swift_and_clean_anisotropic_height():
    """Balls that cross the net measure margin to the outer sidelines/baseline rather than clamping y0/y1=0."""
    m_over, n_over = B.margin([0.0, 0.02], "singles", hitter="near")
    assert m_over == pytest.approx(-4.115) and np.allclose(abs(n_over), [1.0, 0.0])
    assert B.call([0.0, 0.02], 0.02, "singles", hitter="near")["call"] == "in"
    m_net, n_net = B.margin([0.0, -0.5], "singles", hitter="near")
    assert m_net == pytest.approx(0.5) and np.allclose(n_net, [0.0, -1.0])
    assert B.call([0.0, -0.5], 0.02, "singles", hitter="near")["call"] == "out"

    # Portrait 1080x1920 fast vertical trajectory: clean(width=1080, height=1920) preserves valid samples
    ts = np.arange(5) / 60.0
    us = np.full(5, 540.0)
    vs = np.array([200.0, 260.0, 320.0, 480.0, 640.0])  # accel jump 100 px native -> 15 px in 288H (47 px in 512W)
    tr = np.c_[ts, np.ones(5), us, vs, np.ones(5)]
    cleaned = B.clean(tr, gate_px=30.0, width=1080.0, height=1920.0)
    assert cleaned[:, 1].tolist() == [1.0] * 5
