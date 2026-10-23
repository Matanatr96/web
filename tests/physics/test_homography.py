"""Metric court calibration on a made-up camera behind the near baseline (tests/physics/synth.py)."""
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from dsa.physics import homography as Hm
from dsa.scene import court as C

from synth import SIZE, CAMERA, F, court_pixels, true_camera

VECTORS = json.loads((Path(__file__).parents[1] / "fixtures/linecall_vectors.json").read_text())


def test_court_m_is_itf_and_in_points_order():
    m = Hm.COURT_M
    assert m[1, 0] - m[0, 0] == pytest.approx(10.97) and m[0, 1] - m[2, 1] == pytest.approx(23.77)
    assert m[6, 0] - m[4, 0] == pytest.approx(8.23) and m[8, 1] == pytest.approx(6.40)
    assert Hm.NET_POSTS_M[1].tolist() == pytest.approx([5.485 + 0.914, 0.0, 1.07])
    ref = np.array(C.REF, float)                                    # same points, REF's y grows towards the near end
    ref_m = np.c_[(ref[:, 0] - ref[:, 0].mean()) / C.METRE, -(ref[:, 1] - C.NET) / C.METRE]
    assert np.abs(ref_m - m).max() < 0.35                           # REF is ~2% off metric, same layout


def test_calibrate_from_4_corners_and_net_posts():
    cal = true_camera()
    court, posts = court_pixels(cal)
    rng = np.random.default_rng(0)
    est = Hm.calibrate(court[:4] + rng.normal(0, 0.5, (4, 2)), SIZE, posts_px=posts + rng.normal(0, 0.5, (2, 2)))
    assert est.rms_px < 1.0
    assert est.K[0, 0] == pytest.approx(F, rel=0.02)
    assert np.linalg.norm(est.centre - CAMERA) < 0.15


def test_calibrate_from_14_points_and_with_known_k():
    cal = true_camera()
    court, _ = court_pixels(cal)
    est = Hm.calibrate(court, SIZE)
    assert est.rms_px < 0.05 and np.linalg.norm(est.centre - CAMERA) < 0.01
    known = Hm.calibrate(court[:4], SIZE, K=cal.K)
    assert known.rms_px < 0.01 and np.allclose(known.centre, CAMERA, atol=1e-3)
    with pytest.raises(ValueError):
        Hm.calibrate(court[:3], SIZE)
    with pytest.raises(ValueError):
        Hm.calibrate(np.zeros((4, 2)), SIZE, K=cal.K)


def test_hr_removes_the_ball_radius_parallax():
    """A ball touching the far baseline: its centre is 3.3 cm up. Through H0 it lands ~25 cm long; Hr, the
    homography of the plane Z = 0.033 m, puts it within 1 cm."""
    cal = true_camera()
    court, posts = court_pixels(cal)
    est = Hm.calibrate(court[:4], SIZE, posts_px=posts)
    balls = np.array([[3.9, 11.85, Hm.BALL_R], [-4.0, 11.885, Hm.BALL_R], [0.0, 6.40, Hm.BALL_R],
                      [2.0, -11.8, Hm.BALL_R]])
    uv = Hm.project(cal, balls)
    err0 = np.linalg.norm(Hm.to_court(est.H0, uv) - balls[:, :2], axis=1)
    err_r = np.linalg.norm(Hm.to_court(est.Hr, uv) - balls[:, :2], axis=1)
    assert 0.20 < err0[:2].min() and err0[:2].max() < 0.32         # far baseline: ~25 cm through H0
    assert err_r.max() < 0.01


def test_project_and_to_court_round_trip():
    cal = true_camera()
    xy = np.array([[0.0, 0.0], [4.115, 11.885], [-5.485, -11.885], [1.0, 3.0]])
    assert np.allclose(Hm.to_court(cal.H0, Hm.project(cal, xy)), xy, atol=1e-9)
    xyz = np.c_[xy, np.full(4, Hm.BALL_R)]
    assert np.allclose(Hm.to_court(cal.Hr, Hm.project(cal, xyz)), xy, atol=1e-9)


def test_golden_homography_vectors():
    cal = true_camera()
    for case in VECTORS["homography"]:
        H = np.array(case["H"])
        assert np.allclose(Hm.to_court(H, case["uv"]), case["xy"], atol=1e-6), case["name"]
        ours = Hm.plane_homography(cal, case["plane_z"])
        assert np.allclose(ours, H, rtol=1e-9, atol=1e-12), case["name"]


def test_reregister_follows_a_6px_bump():
    cal = true_camera()
    frame0 = Hm.court_lines_image(cal)
    shift = np.float32([[1, 0, 6.0], [0, 1, 0.0]])                  # the phone slid 6 px right
    frame = cv2.warpAffine(frame0, shift, SIZE)
    new, drift = Hm.reregister(cal, frame0, frame)
    assert drift == pytest.approx(6.0, abs=0.3)
    ball = np.array([[1.0, 10.0, Hm.BALL_R]])
    uv = Hm.project(cal, ball) + [6.0, 0.0]                         # where the ball now shows up
    assert np.linalg.norm(Hm.to_court(new.Hr, uv) - ball[:, :2]) < 0.05       # 10 m out: 1 px ~ 20 cm
    assert np.linalg.norm(Hm.to_court(cal.Hr, uv) - ball[:, :2]) > 0.15       # without it: off by ~19 cm
    same, d0 = Hm.reregister(cal, frame0, frame0)
    assert d0 < 0.1 and np.allclose(same.Hr, cal.Hr, atol=1e-3)


def test_reregister_follows_a_turned_camera():
    """Wind turns the phone 0.3 degrees: every line moves differently; the registered Hr still calls a ball on
    the far baseline within 5 cm (a quarter pixel out there) and the re-solved pose fits the moved court."""
    cal = true_camera()
    turned = true_camera(look_at=np.array([0.1, -6.0, 0.0]))     # ~0.3 degrees of pan
    frame0, frame = Hm.court_lines_image(cal), Hm.court_lines_image(turned)
    new, drift = Hm.reregister(cal, frame0, frame)
    assert 2.0 < drift < 10.0 and new.rms_px < 0.5
    ball = np.array([[-3.0, 11.8, Hm.BALL_R], [2.0, -9.0, Hm.BALL_R]])
    uv = Hm.project(turned, ball)
    assert np.linalg.norm(Hm.to_court(new.Hr, uv) - ball[:, :2], axis=1).max() < 0.05     # ECC: ~0.25 px


def test_reregister_gives_up_on_a_big_move():
    cal = true_camera()
    frame0 = Hm.court_lines_image(cal)
    frame = cv2.warpAffine(frame0, np.float32([[1, 0, 0], [0, 1, 0]]), SIZE) * 0      # court gone: blank frame
    kept, drift = Hm.reregister(cal, frame0, frame)
    assert drift == float("inf") and kept is cal


def test_court_json_round_trip():
    cal = true_camera()
    d = json.loads(json.dumps(cal.to_json()))
    back = Hm.Calibration.from_json(d)
    assert np.allclose(back.Hr, cal.Hr) and np.allclose(back.H0, cal.H0)
    assert d["version"] == 1 and np.allclose(d["camera_m"], CAMERA)
