"""3D drag flight: simulate() against closed forms, fit_shot() recovering speed and net clearance from pixels."""
import numpy as np
import pytest

from dsa.physics import ballistics as BL
from dsa.physics.homography import BALL_R, project

from synth import landing, true_camera


def launch(p0, speed_mph, target_xy):
    """A pure-drag launch at speed_mph from p0 that lands at target_y, aimed at target_xy (bisection on the
    elevation)."""
    p0 = np.asarray(p0, float)
    d = np.asarray(target_xy, float) - p0[:2]
    d /= np.linalg.norm(d)
    s = speed_mph / BL.MPH
    lo, hi = -0.5, 0.6
    for _ in range(60):
        el = (lo + hi) / 2
        v = s * np.r_[d * np.cos(el), np.sin(el)]
        _, p, _ = landing(p0, v)
        if abs(p[1]) > abs(target_xy[1]):
            hi = el
        else:
            lo = el
    return v


def observe(cal, p0, v0, t_end, fps=60.0, noise_px=0.3, seed=0):
    rng = np.random.default_rng(seed)
    ts = np.arange(0.5 / fps, t_end - 0.004, 1 / fps)
    uv = project(cal, BL.simulate(p0, v0, ts)) + rng.normal(0, noise_px, (len(ts), 2))
    return np.c_[ts, uv]


def test_simulate_without_drag_is_a_parabola_and_drag_slows_the_ball():
    p0, v0 = np.array([0.0, -11.0, 1.0]), np.array([1.0, 25.0, 4.0])
    ts = np.linspace(0, 1.0, 11)
    exact = p0 + np.outer(ts, v0) + 0.5 * np.outer(ts ** 2, [0, 0, -BL.G])
    assert np.allclose(BL.simulate(p0, v0, ts, cd=0.0), exact, atol=1e-9)
    P, V = BL.simulate(p0, v0, [1.0], return_velocity=True)
    assert np.linalg.norm(V[0]) < np.linalg.norm(v0 + [0, 0, -BL.G]) - 3      # ~0.45 /s drag at 25 m/s
    assert P[0, 1] < exact[-1, 1]
    # one call with many times == separate calls (state carried between targets)
    many = BL.simulate(p0, v0, [0.7, 0.2, 0.45])
    assert np.allclose(many[1], BL.simulate(p0, v0, [0.2])[0])


def test_lift_term_is_off_by_default_and_topspin_dives():
    p0, v0 = np.array([0.0, -11.0, 1.0]), np.array([0.0, 28.0, 5.0])
    plain = BL.simulate(p0, v0, [0.8])[0]
    top = BL.simulate(p0, v0, [0.8], c_lift=0.2)[0]
    assert np.allclose(BL.simulate(p0, v0, [0.8], c_lift=0.0)[0], plain)
    assert top[2] < plain[2] - 0.3


def test_net_height_and_clearance():
    assert BL.net_height(0.0) == pytest.approx(0.914)
    assert BL.net_height(6.399) == pytest.approx(1.07)
    assert BL.net_height(20.0) == pytest.approx(1.07)
    v = np.array([0.0, 20.0, 3.0])
    c = BL.net_clearance([0.0, -11.0, 1.0], v, 2.0, cd=0.0)
    t = 11.0 / 20.0
    assert c == pytest.approx(1.0 + 3.0 * t - 0.5 * BL.G * t * t - BALL_R - 0.914, abs=1e-4)
    assert BL.net_clearance([0.0, 1.0, 1.0], v, 2.0) is None                 # never crosses


@pytest.mark.parametrize("name, p0, mph, target", [
    ("115 mph flat serve", [0.4, -11.95, 2.85], 115.0, [-2.6, 5.9]),
    ("70 mph groundstroke", [1.2, -12.2, 0.95], 70.0, [-1.0, 9.6]),
    ("85 mph crosscourt from the far side", [-2.0, 12.5, 1.0], 85.0, [3.0, -8.5]),
])
def test_fit_shot_recovers_speed_and_net_clearance(name, p0, mph, target):
    """Pixels from the phone behind the near baseline (0.3 px noise, 60 fps) between hit and bounce, the
    bounce from Hr: speed within 2 mph, clearance within 5 cm, pure drag (fit_lift=False)."""
    cal = true_camera()
    p0 = np.array(p0)
    v0 = launch(p0, mph, target)
    tb, pb, vb = landing(p0, v0)
    truth_clear = BL.net_clearance(p0, v0, tb)
    obs = observe(cal, p0, v0, tb)
    rng = np.random.default_rng(1)
    t0 = obs[0, 0]
    # fit_shot reports the speed at its first sample; compare with the truth at that moment
    _, V0 = BL.simulate(p0, v0, [t0], return_velocity=True)
    f = BL.fit_shot(obs, cal, bounce={"t": tb + rng.normal(0, 0.001), "xy": pb[:2] + rng.normal(0, 0.02, 2)})
    assert f["ok"] and f["rms_px"] < 1.0
    assert f["speed_mph"] == pytest.approx(np.linalg.norm(V0[0]) * BL.MPH, abs=2.0), name
    assert f["speed_at_bounce_mph"] == pytest.approx(np.linalg.norm(vb) * BL.MPH, abs=2.0), name
    assert f["net_clearance_m"] == pytest.approx(truth_clear, abs=0.05), name
    assert np.linalg.norm(V0[0]) * BL.MPH == pytest.approx(mph, abs=1.5)   # launched at the stated speed


def test_fit_shot_without_a_bounce_still_measures_speed():
    cal = true_camera()
    p0 = np.array([1.2, -12.2, 0.95])
    v0 = launch(p0, 70.0, [-1.0, 9.6])
    tb, _, _ = landing(p0, v0)
    obs = observe(cal, p0, v0, tb)
    _, V0 = BL.simulate(p0, v0, [obs[0, 0]], return_velocity=True)
    f = BL.fit_shot(obs, cal)
    assert f["speed_at_bounce_mph"] is None
    assert f["speed_mph"] == pytest.approx(np.linalg.norm(V0[0]) * BL.MPH, abs=4.0)


def test_fit_lift_recovers_topspin():
    cal = true_camera()
    p0, v0 = np.array([0.5, -12.0, 1.0]), np.array([-0.5, 26.0, 6.0])
    tb, pb, _ = (lambda r: r)(_landing_with_lift(p0, v0, 0.15))
    obs = observe(cal, p0, v0, tb, noise_px=0.1)
    obs_lift = np.c_[obs[:, 0], project(cal, BL.simulate(p0, v0, obs[:, 0], c_lift=0.15))]
    f = BL.fit_shot(obs_lift, cal, bounce={"t": tb, "xy": pb[:2]}, fit_lift=True)
    assert f["c_lift"] == pytest.approx(0.15, abs=0.05)


def _landing_with_lift(p0, v0, cl):
    ts = np.arange(0, 3, 0.001)
    P = BL.simulate(p0, v0, ts, c_lift=cl)
    k = int(np.flatnonzero(P[:, 2] < BALL_R)[0])
    return ts[k], P[k], None
