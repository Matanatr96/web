"""The tennis-rally Modal app's logic without Modal: upload jobs, HTTP Range clips, auth, rally segmentation,
one rally's shots and the idempotent webhook client."""
import hashlib
import json
import sys
import uuid
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from dsa.gpu import rally_api as RA

sys.path.insert(0, str(Path(__file__).parent / "physics"))
from synth import rally, true_camera  # noqa: E402

SECRET, NOW = "s3cret", 1_800_000_000
MID = str(uuid.UUID(int=0x1234))


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(RA, "PART_SIZE", 1024)
    spawned = []
    app = RA.create_app(tmp_path, SECRET, spawn=lambda kind, payload: spawned.append((kind, payload)),
                        now=lambda: NOW)
    return TestClient(app), tmp_path, spawned


def tok(scope=MID, exp=NOW + 3600, secret=SECRET):
    return {"X-Job-Token": RA.mint_token(secret, scope, exp)}


def job(size, **kw):
    return {"match_id": MID, "source": "web", "size_bytes": size, "court": {"size": [1920, 1080]}} | kw


# --- auth -----------------------------------------------------------------------------------------------------

def test_tokens_are_scoped_and_expire():
    t = RA.mint_token(SECRET, MID, NOW + 10)
    assert RA.verify_token(SECRET, t, MID, NOW)
    assert not RA.verify_token(SECRET, t, str(uuid.uuid4()), NOW)            # another match
    assert not RA.verify_token(SECRET, t, MID, NOW + 11)                     # expired
    assert not RA.verify_token("other", t, MID, NOW)                         # another secret
    assert not RA.verify_token(SECRET, t[:-1] + ("0" if t[-1] != "0" else "1"), MID, NOW)
    assert not RA.verify_token(SECRET, "garbage", MID, NOW)
    assert RA.verify_token(SECRET, RA.mint_token(SECRET, "any", NOW + 10), MID, NOW)  # the iOS device token


def test_job_routes_fail_closed(api, tmp_path):
    client, _, _ = api
    assert client.post("/jobs", json=job(10)).status_code == 401
    assert client.post("/jobs", json=job(10), headers={"X-Job-Token": "x.1.y"}).status_code == 403
    assert client.post("/jobs", json=job(10), headers=tok(exp=NOW - 1)).status_code == 403
    assert client.post("/jobs", json=job(10), headers=tok(scope=str(uuid.uuid4()))).status_code == 403
    unset = TestClient(RA.create_app(tmp_path / "x", None))
    assert unset.post("/jobs", json=job(10), headers=tok()).status_code == 503
    assert client.post("/jobs", json=job(10) | {"source": "fax"}, headers=tok()).status_code == 422


# --- uploads --------------------------------------------------------------------------------------------------

def test_upload_resume_and_commit_a_session(api):
    client, root, spawned = api
    data = bytes(range(256)) * 10                                            # 2560 bytes: 3 parts of 1024
    r = client.post("/jobs", json=job(len(data), session_type="rally"), headers=tok())
    assert r.status_code == 201
    assert r.json() == {"job_id": MID, "match_id": MID, "rally_idx": None, "part_size": 1024, "parts_expected": 3,
                        "status": "uploading", "size_bytes": 2560, "received_parts": []}
    again = client.post("/jobs", json=job(len(data), session_type="rally"), headers=tok())
    assert again.status_code == 200 and again.json()["job_id"] == MID                    # idempotent
    assert client.post("/jobs", json=job(999), headers=tok()).status_code == 409         # a different file

    put = lambda n, body, **h: client.put(f"/jobs/{MID}/parts/{n}", content=body, headers=tok() | h)  # noqa: E731
    assert put(0, data[:1000]).status_code == 400                            # short part
    assert put(3, data[:10]).status_code == 400                              # past the end
    assert put(0, data[:1024], **{"X-Part-Sha256": "0" * 64}).status_code == 400
    assert put(2, data[2048:], **{"X-Part-Sha256": hashlib.sha256(data[2048:]).hexdigest()}).status_code == 200
    assert put(0, data[:1024]).json()["received_parts"] == [0, 2]
    assert put(0, data[:1024]).status_code == 200                            # a retried part overwrites itself
    assert client.get(f"/jobs/{MID}", headers=tok()).json()["received_parts"] == [0, 2]   # resume from part 1
    early = client.post(f"/jobs/{MID}/commit", headers=tok())
    assert early.status_code == 409 and early.json()["missing"] == [1]
    put(1, data[1024:2048])
    done = client.post(f"/jobs/{MID}/commit", json={"sha256": hashlib.sha256(data).hexdigest()}, headers=tok())
    assert done.status_code == 200 and done.json()["status"] == "processing"
    assert (root / MID / "source.mp4").read_bytes() == data
    assert not (root / MID / "jobs/session/parts").exists()
    assert spawned == [("segment_match", {"match_id": MID, "path": f"{MID}/source.mp4", "session_type": "rally",
                                          "court": {"size": [1920, 1080]}, "doubles": False, "source": "web",
                                          "biomech": True})]
    assert client.post(f"/jobs/{MID}/commit", headers=tok()).json()["status"] == "processing"
    assert len(spawned) == 1                                                 # committing twice is a no-op
    assert client.get(f"/jobs/{MID}", headers=tok()).json()["received_parts"] == [0, 1, 2]
    assert put(0, data[:1024]).status_code == 409


def test_commit_checks_the_whole_file(api):
    client, _, spawned = api
    client.post("/jobs", json=job(5), headers=tok())
    client.put(f"/jobs/{MID}/parts/0", content=b"abcde", headers=tok())
    bad = client.post(f"/jobs/{MID}/commit", json={"sha256": "1" * 64}, headers=tok())
    assert bad.status_code == 400 and spawned == []


def test_an_ios_rally_clip_is_its_own_job(api):
    client, root, spawned = api
    body = job(700, source="ios", rally_idx=3, content_type="video/quicktime", start_s=81.5, session_type="match")
    r = client.post("/jobs", json=body, headers=tok(scope="any"))
    assert r.status_code == 201 and r.json()["job_id"] == f"{MID}.r3"
    client.put(f"/jobs/{MID}.r3/parts/0", content=b"\0" * 700, headers=tok(scope="any"))
    assert client.post(f"/jobs/{MID}.r3/commit", headers=tok(scope="any")).status_code == 200
    assert (root / MID / "uploads/rally-3.mov").stat().st_size == 700
    kind, payload = spawned[0]
    assert kind == "process_rally" and payload["rally_idx"] == 3 and payload["start_s"] == 81.5
    assert payload["session_type"] == "match" and payload["path"] == f"{MID}/uploads/rally-3.mov"
    assert client.get("/jobs/not-a-job", headers=tok()).status_code == 404
    assert client.get(f"/jobs/{uuid.uuid4()}", headers=tok()).status_code == 404


# --- rally clips over HTTP Range ------------------------------------------------------------------------------

@pytest.fixture
def clip(api):
    client, root, _ = api
    data = bytes(range(250)) * 4                                             # 1000 bytes
    (root / MID / "rallies").mkdir(parents=True)
    (root / MID / "rallies/7.mp4").write_bytes(data)
    return client, data


def test_clip_full_and_partial_content(clip):
    client, data = clip
    r = client.get(f"/clips/{MID}/7.mp4")
    assert r.status_code == 200 and r.content == data
    assert r.headers["accept-ranges"] == "bytes" and r.headers["content-type"] == "video/mp4"
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert r.headers["content-length"] == "1000"
    for rng, (a, b) in {"bytes=0-1": (0, 1), "bytes=100-199": (100, 199), "bytes=990-": (990, 999),
                        "bytes=-5": (995, 999), "bytes=900-5000": (900, 999)}.items():
        p = client.get(f"/clips/{MID}/7.mp4", headers={"Range": rng})       # Safari probes with bytes=0-1
        assert p.status_code == 206, rng
        assert p.headers["content-range"] == f"bytes {a}-{b}/1000"
        assert p.headers["content-length"] == str(b - a + 1) and p.content == data[a:b + 1]


def test_clip_edge_cases(clip):
    client, data = clip
    bad = client.get(f"/clips/{MID}/7.mp4", headers={"Range": "bytes=1000-"})
    assert bad.status_code == 416 and bad.headers["content-range"] == "bytes */1000"
    assert client.get(f"/clips/{MID}/7.mp4", headers={"Range": "bytes=-0"}).status_code == 416
    assert client.get(f"/clips/{MID}/7.mp4", headers={"Range": "bytes=0-1,5-6"}).status_code == 200  # ignored
    assert client.get(f"/clips/{MID}/7.mp4", headers={"Range": "items=0-1"}).status_code == 200
    head = client.head(f"/clips/{MID}/7.mp4", headers={"Range": "bytes=0-9"})
    assert head.status_code == 206 and head.headers["content-length"] == "10" and head.content == b""
    etag = client.get(f"/clips/{MID}/7.mp4").headers["etag"]
    assert client.get(f"/clips/{MID}/7.mp4", headers={"If-None-Match": etag}).status_code == 304
    assert client.get(f"/clips/{MID}/8.mp4").status_code == 404
    assert client.get("/clips/not-a-uuid/7.mp4").status_code == 404
    assert client.get(f"/clips/{MID}/..%2F..%2Fsecret.mp4").status_code == 404
    assert client.get(f"/clips/{MID}/7.mov").status_code == 404


# --- rallies from ball events ---------------------------------------------------------------------------------

def ev(*items):
    return [{"t": t, "kind": k} | ({"call": c} if c else {}) for t, k, c in items]


def test_rally_mode_plays_on_after_an_out_ball():
    e = ev((10.0, "hit", None), (10.8, "bounce", "in"), (11.2, "hit", None), (12.0, "bounce", "out"),
           (12.4, "hit", None), (13.1, "bounce", "in"), (13.5, "hit", None), (14.3, "bounce", "in"))
    r = RA.segment_rallies(e, "rally")
    assert [(x["hits"], x["start_s"], x["end_s"]) for x in r] == [(4, 8.5, 16.3)]
    m = RA.segment_rallies(e, "match")                                       # never terminated early by out calls
    assert [(x["hits"], x["start_s"], x["end_s"]) for x in m] == [(4, 8.5, 16.3)]


def test_rallies_split_on_gaps_nets_double_bounces_and_lost_tracks():
    e = ev((1.0, "hit", None), (1.8, "bounce", "in"), (2.2, "hit", None),
           (7.0, "hit", None), (7.6, "net", None),                           # > 3.5 s gap, then into the net
           (8.5, "hit", None), (9.2, "bounce", "in"), (9.9, "bounce", "in"),  # a quick re-feed (E3); not returned
           (10.6, "hit", None), (11.0, "break", None), (11.5, "hit", None))
    r = RA.segment_rallies(e, "rally", duration=12.0)
    assert [x["hits"] for x in r] == [2, 1, 1, 1, 1]
    assert r[0]["start_s"] == 0.0 and r[-1]["end_s"] == 12.0                 # clamped to the video
    assert RA.segment_rallies([], "rally") == []
    assert RA.segment_rallies(ev((3.0, "bounce", "in")), "rally") == []      # no hit, no rally


# --- one rally's shots ----------------------------------------------------------------------------------------

def test_analyse_track_turns_a_rally_into_shots():
    cal = true_camera()
    track, events, xyz = rally(np.random.default_rng(31), cal, noise_px=0.3)
    shots, evs = RA.analyse_track(track, cal, "rally")
    bounces = [e for e in events if e[1] == "bounce"]
    hits = [e for e in events if e[1] == "hit"]
    assert len(shots) == 1 + len(hits) == 3                                 # the feed the track starts with + 2
    assert shots[0]["stroke"] == "feed" and [s["hitter"] for s in shots] == ["near", "far", "near"]
    for s, (te, _, p) in zip(shots, bounces):
        assert s["call"] == "in" and s["depth_zone"] == "deep" and s["sigma_m"] > 0
        assert abs(s["t_bounce_s"] - te) < 0.01 and np.hypot(s["bounce_x"] - p[0], s["bounce_y"] - p[1]) < 0.15
        assert 20 < s["speed_mph"] < 120 and 15 < s["speed_at_bounce_mph"] < s["speed_mph"]
        assert 0 < s["net_clearance_m"] < 3
    assert abs(shots[2]["t_hit_s"] - hits[1][0]) < 0.05
    assert shots[2]["call"] == "unknown" and shots[2]["depth_zone"] == "unknown"        # no bounce in the clip
    assert set(shots[0]) == {"shot_idx", "hitter", "t_hit_s", "hit_x", "hit_y", "stroke", "direction",
                             "depth_zone", "t_bounce_s", "bounce_x", "bounce_y", "speed_mph",
                             "speed_at_bounce_mph", "net_clearance_m", "call", "margin_m", "sigma_m"}
    m, _ = RA.analyse_track(track, cal, "match")
    assert m[0]["stroke"] == "serve"                                         # judged against a service box
    assert RA.analyse_track(track[:, :] * [1, 0, 1, 1, 1], cal) == ([], [])  # no ball, no shots


def test_serve_boxes_follow_the_server():
    assert RA._serve_region("near", 1.0) == "deuce_far" and RA._serve_region("near", -1.0) == "ad_far"
    assert RA._serve_region("far", -1.0) == "deuce_near" and RA._serve_region("far", 1.0) == "ad_near"
    assert RA._direction(2.0, -3.0) == "cross" and RA._direction(2.0, 3.0) == "dtl"
    assert RA._direction(2.0, 0.5) == "middle" and RA._direction(None, 1.0) is None


# --- the webhook ----------------------------------------------------------------------------------------------

def test_webhook_retries_with_one_idempotency_key():
    seen, codes = [], [500, 503, 200]

    def handler(req):
        seen.append((req.headers["authorization"], req.headers["idempotency-key"], json.loads(req.content)))
        return httpx.Response(codes[len(seen) - 1])

    sleeps = []
    client = httpx.Client(transport=httpx.MockTransport(handler))
    event = {"type": "rally.ready", "match_id": MID, "rally": {"rally_idx": 2}, "shots": []}
    assert RA.send_webhook("https://x/api/tennis/webhook", "hook", event, client, sleep=sleeps.append) == 200
    assert len(seen) == 3 and sleeps == [0.5, 1.0]
    assert {s[1] for s in seen} == {RA.event_id(event)} and seen[0][0] == "Bearer hook"
    assert seen[0][2] == seen[2][2] == {"event_id": RA.event_id(event)} | event
    assert RA.event_id(event) == RA.event_id(dict(event))                   # replays dedupe on the receiver
    assert RA.event_id(event) != RA.event_id(event | {"rally": {"rally_idx": 3}})


def test_webhook_does_not_retry_a_4xx_and_fails_closed():
    calls = []
    client = httpx.Client(transport=httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(401)))
    event = {"type": "match.status", "match_id": MID, "status": "processing"}
    assert RA.send_webhook("https://x", "hook", event, client, sleep=lambda s: None) == 401 and len(calls) == 1
    with pytest.raises(RuntimeError):
        RA.send_webhook("https://x", None, event, client)
    with pytest.raises(RuntimeError):
        RA.send_webhook(None, "hook", event, client)

    def down(req):
        raise httpx.ConnectError("down", request=req)

    flaky = httpx.Client(transport=httpx.MockTransport(down))
    assert RA.send_webhook("https://x", "hook", event, flaky, retries=2, sleep=lambda s: None) == 0


def test_decode_and_cut_a_clip(tmp_path):
    """PyAV decode with presentation timestamps, and the 720p faststart clip /clips serves."""
    import shutil

    import cv2

    src = str(tmp_path / "src.mp4")
    w = cv2.VideoWriter(src, cv2.VideoWriter_fourcc(*"mp4v"), 30, (320, 240))
    for i in range(60):
        w.write(np.full((240, 320, 3), 4 * i, np.uint8))
    w.release()
    got = list(RA.decode(src, 0.5, 1.0))
    assert [round(t, 3) for t, _ in got] == [round(k / 30, 3) for k in range(15, 31)]
    assert got[0][1].shape == (240, 320, 3)
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed (the Modal image has it)")
    dest = tmp_path / "rallies/0.mp4"
    RA.cut_clip(src, str(dest), 0.5, 1.5, height=120)
    clip = list(RA.decode(str(dest)))
    assert clip[0][1].shape[0] == 120 and 25 <= len(clip) <= 32
    assert b"moov" in dest.read_bytes()[:4096]                               # +faststart: index first


def test_calibration_from_uploader_taps():
    cal = true_camera()
    from dsa.physics.homography import COURT_M, NET_POSTS_M, project
    court = {"size": [1920, 1080], "court_px": project(cal, COURT_M[:4]).tolist(),
             "posts_px": project(cal, NET_POSTS_M).tolist()}
    est = RA.calibration(court)
    assert np.allclose(est.Hr, cal.Hr, atol=1e-4 * np.abs(cal.Hr).max())
    assert RA.calibration(est.to_json())
    assert np.allclose(RA.calibration(est.to_json()).Hr, est.Hr)
    assert RA.calibration(None) is None and RA.calibration({}) is None


def test_preroll_serve_strokes_netted_call_and_multi_replica_refresh(tmp_path, monkeypatch):
    from dsa.physics import ballistics as BL
    from dsa.physics.homography import project
    from synth import COR, FRICTION, aim, landing

    cal = true_camera()
    fps = 60.0
    p_srv = np.array([0.4, -11.95, 2.85])
    v_srv = aim(p_srv, [-2.6, 5.9], 0.43)
    tb, pb, vb = landing(p_srv, v_srv)
    t_pre = np.arange(0.0, 1.5, 1 / fps)
    xyz_pre = np.c_[np.full_like(t_pre, 0.4), np.full_like(t_pre, -11.95), 2.85 - 0.5 * 9.81 * (t_pre - 1.5) ** 2]
    t_fl = np.arange(1.5, 1.5 + tb, 1 / fps)
    t_po = np.arange(1.5 + tb, 1.5 + tb + 0.35, 1 / fps)
    ts = np.r_[t_pre, t_fl, t_po]
    xyz = np.vstack([xyz_pre, BL.simulate(p_srv, v_srv, t_fl - 1.5),
                     BL.simulate(pb, np.r_[vb[:2] * FRICTION, -vb[2] * COR], t_po - (1.5 + tb))])
    vis = (ts >= 1.0).astype(float)
    tr = np.c_[ts, vis, project(cal, xyz), vis]
    shots, _ = RA.analyse_track(tr, cal, "match")
    assert len(shots) == 1
    assert shots[0]["stroke"] == "serve" and shots[0]["hitter"] == "near"
    assert abs(shots[0]["t_hit_s"] - 1.5) < 0.05 and shots[0]["hit_y"] == pytest.approx(-11.95, abs=0.5)
    assert shots[0]["hit_x"] == pytest.approx(0.4, abs=0.2) and shots[0]["call"] == "in"
    # Overhead serve (p0_z >= 1.75) in 'rally' mode is also classified as 'serve' so serve speed is tracked
    rally_srv_shots, _ = RA.analyse_track(tr, cal, "rally")
    assert len(rally_srv_shots) == 1 and rally_srv_shots[0]["stroke"] == "serve"
    assert rally_srv_shots[0]["speed_mph"] > 80.0 and rally_srv_shots[0]["speed_at_bounce_mph"] > 60.0
    u_shots, u_ev = RA.analyse_track(tr, None, "match")
    assert len(u_shots) == 1 and u_shots[0]["stroke"] == "serve" and u_shots[0]["call"] == "unknown"
    assert abs(u_shots[0]["t_hit_s"] - 1.5) < 0.05 and u_shots[0]["t_bounce_s"] is not None
    assert RA.analyse_track(tr * [1, 0, 1, 1, 1], None) == ([], [])

    # Subsequent rally shots get 'fh' / 'bh' stroke classification
    r_tr, _, _ = rally(np.random.default_rng(31), cal, noise_px=0.3)
    r_shots, _ = RA.analyse_track(r_tr, cal, "rally")
    assert all(s["stroke"] in ("fh", "bh") for s in r_shots[1:])

    # Multi-replica refresh() and iOS metadata + finalize_session route
    monkeypatch.setattr(RA, "PART_SIZE", 1024)
    refreshes, spawned = [], []
    app = RA.create_app(tmp_path, SECRET, spawn=lambda k, p: spawned.append((k, p)),
                        refresh=lambda: refreshes.append(1), now=lambda: NOW)
    client = TestClient(app)
    body = job(500, source="ios", rally_idx=1, content_type="video/quicktime", start_s=12.0,
               bookmarked=True, live_call="out", score={"games": [1, 0]})
    assert client.post("/jobs", json=body, headers=tok(scope="any")).status_code == 201
    assert len(refreshes) >= 1
    client.put(f"/jobs/{MID}.r1/parts/0", content=b"\0" * 500, headers=tok(scope="any"))
    assert client.post(f"/jobs/{MID}.r1/commit", headers=tok(scope="any")).status_code == 200
    assert spawned[-1][0] == "process_rally" and spawned[-1][1]["bookmarked"] is True
    assert spawned[-1][1]["live_call"] == "out" and spawned[-1][1]["score"] == {"games": [1, 0]}
    fin = client.post(f"/sessions/{MID}/finalize", json={"source": "ios", "session_type": "match",
                                                         "score": {"games": [6, 4]}}, headers=tok(scope="any"))
    assert fin.status_code == 200 and spawned[-1][0] == "finalize_session"

    # Phase 3 biomechanics summary schema matches web normalizeBiomechTrait expectations
    bio = RA.compute_session_biomechanics([shots, r_shots])
    assert isinstance(bio["traits"], list) and len(bio["traits"]) >= 4
    assert isinstance(bio["coach_notes"], str) and len(bio["coach_notes"]) > 10
    for tr_item in bio["traits"]:
        assert set(tr_item.keys()) == {"trait", "stroke", "user_value", "pro_mean", "pro_std", "z_score", "unit"}
        assert tr_item["stroke"] in ("fh", "bh", "serve")
        assert tr_item["pro_std"] > 0
        assert tr_item["z_score"] == pytest.approx((tr_item["user_value"] - tr_item["pro_mean"]) / tr_item["pro_std"],
                                                   abs=0.02)

    # Full unsegmented Camera Roll / web upload with rally_idx == 0 routes to segment_match
    mid_lib = str(uuid.uuid4())
    lib_body = {"match_id": mid_lib, "source": "ios_library", "rally_idx": 0, "size_bytes": 600,
                "content_type": "video/quicktime", "session_type": "rally"}
    assert client.post("/jobs", json=lib_body, headers=tok(scope="any")).status_code == 201
    client.put(f"/jobs/{mid_lib}.r0/parts/0", content=b"\0" * 600, headers=tok(scope="any"))
    assert client.post(f"/jobs/{mid_lib}.r0/commit", headers=tok(scope="any")).status_code == 200
    assert spawned[-1][0] == "segment_match"
    assert spawned[-1][1]["path"] == f"{mid_lib}/source.mov"


def test_match_mode_scoring_first_hit_serve_and_rotated_decode(tmp_path):
    """Round 2 regressions: score_match_rallies (C1/C2/L1), annotate_bounce_calls is_first_hit (H3),
    uncalibrated rally shots (H7), and rotated video decode (H4)."""
    import shutil
    import subprocess

    cal = true_camera()
    r1_tr, _, _ = rally(np.random.default_rng(31), cal, noise_px=0.2)
    u_rshots, _ = RA.analyse_track(r1_tr, None, "rally")
    assert len(u_rshots) >= 2 and u_rshots[0]["stroke"] == "feed" and u_rshots[1]["stroke"] == "shot"

    # Match-mode scoring: handles me/opp winners, emits display/formatted/at_s/timestamp_s, and stops once match won
    per_rally = [
        [{"shot_idx": 0, "hitter": "near", "call": "in", "t_hit_s": 1.0, "t_bounce_s": 1.6}],
        [{"shot_idx": 0, "hitter": "near", "call": "out", "t_hit_s": 5.0, "t_bounce_s": 5.5}],
        [{"shot_idx": 0, "hitter": "far", "call": "out", "t_hit_s": 9.0, "t_bounce_s": 9.7,
          " dummy": 1}, {"shot_idx": 1, "hitter": "far", "call": "out", "t_hit_s": 10.2, "t_bounce_s": 10.8}],
    ]
    score_out, points_out = RA.score_match_rallies(per_rally)
    assert score_out["display"] == score_out["formatted"] == "0-0 30-15"
    assert score_out["points"] == "30-15"
    assert [p["winner"] for p in points_out] == ["me", "opp", "me"]
    assert [p["ended_by"] for p in points_out] == ["winner", "double_fault", "out"]
    assert points_out[0]["at_s"] == points_out[0]["timestamp_s"] == 1.6

    # Match-over guard: extra rallies after match point do not raise ValueError("the match is over")
    win_rally = [{"shot_idx": 0, "hitter": "near", "call": "in", "t_hit_s": 1.0, "t_bounce_s": 1.5}]
    over_score, over_pts = RA.score_match_rallies([win_rally] * 60)
    assert over_score["winner"] == "me" and len(over_pts) == 48

    # H3: after an "out" bounce in Rally 1, Rally 2's 2nd shot (a deep groundstroke at Y=-10.87m) is judged on full court ("in")
    from dsa.physics import ballistics as BL
    from dsa.physics.homography import project
    from synth import COR, FRICTION, aim, landing

    fps = 60.0
    p_srv = np.array([0.4, -11.95, 2.85])
    v_srv = aim(p_srv, [-2.0, 5.5], 0.43)
    tb, pb, vb = landing(p_srv, v_srv)
    t_s1 = np.arange(0.0, tb, 1 / fps)
    t_s2 = np.arange(tb, tb + 0.35, 1 / fps)
    ts_srv = np.r_[t_s1, t_s2]
    xyz_srv = np.vstack([BL.simulate(p_srv, v_srv, t_s1),
                         BL.simulate(pb, np.r_[vb[:2] * FRICTION, -vb[2] * COR], t_s2 - tb)])
    srv_tr = np.c_[ts_srv, np.ones_like(ts_srv), project(cal, xyz_srv), np.ones_like(ts_srv)]
    i_b_srv = len(t_s1) - 1

    # Rally 2: valid serve (lands at Y=+5.5m in ad_far box) followed by deep groundstroke (i=114 of r1_tr at Y=-10.87m)
    r2_gs = r1_tr.copy()
    r2_gs[:, 0] += 10.0
    srv2_tr = srv_tr.copy()
    srv2_tr[:, 0] += 8.0
    combined = np.vstack([r1_tr, srv2_tr, r2_gs])
    n1, n2 = len(r1_tr), len(r1_tr) + len(srv2_tr)
    combined_mod = combined.copy()
    combined_mod[110:118, 3] = 5.0  # force Rally 1 bounce at i=114 out of court
    ev_all = [
        {"i": 0, "t": float(combined_mod[0, 0]), "kind": "hit", "half": "near"},
        {"i": 114, "t": float(combined_mod[114, 0]), "kind": "bounce", "half": "far"},
        {"i": n1, "t": float(combined_mod[n1, 0]), "kind": "hit", "half": "near"},
        {"i": n1 + i_b_srv, "t": float(combined_mod[n1 + i_b_srv, 0]), "kind": "bounce", "half": "far"},
        {"i": n2 + 73, "t": float(combined_mod[n2 + 73, 0]), "kind": "hit", "half": "far"},
        {"i": n2 + 114, "t": float(combined_mod[n2 + 114, 0]), "kind": "bounce", "half": "near"},
    ]
    annotated = RA.annotate_bounce_calls(combined_mod, ev_all, cal, session_type="match")
    bounces_ann = [e for e in annotated if e["kind"] == "bounce"]
    assert [b["call"] for b in bounces_ann] == ["out", "in", "in"]

    # H4: rotated video decode() applies display rotation metadata so dimensions and corners match ffmpeg
    if shutil.which("ffmpeg") is not None:
        raw_mp4 = str(tmp_path / "raw.mp4")
        rot_mp4 = str(tmp_path / "rot90.mp4")
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=0.1",
                        "-vf", "drawbox=x=0:y=0:w=40:h=40:color=red:t=fill",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", raw_mp4], check=True, capture_output=True)
        subprocess.run(["ffmpeg", "-y", "-display_rotation", "90", "-i", raw_mp4, "-c", "copy", rot_mp4],
                       check=True, capture_output=True)
        _, frm_rot = next(RA.decode(rot_mp4))
        assert frm_rot.shape == (320, 180, 3) and frm_rot.flags["C_CONTIGUOUS"]
        # 90 deg CCW moves top-left (x=0..40, y=0..40) to bottom-left (y=280..320, x=0..40)
        assert frm_rot[300, 20, 2] > 150 and frm_rot[20, 20, 2] < 50


def test_auto_calibrate_video_and_finalize_session_stats(tmp_path, monkeypatch):
    """auto_calibrate_video samples frames with Tcd + court_snap.refine and gracefully falls back to None;
    finalize_session aggregates saved per-rally shots into SwingVision speed, shot, and biomechanics stats."""
    import dsa.gpu.models as GM
    from dsa.physics.homography import COURT_M, project
    from dsa.scene import court_snap

    cal = true_camera()
    true_pts = project(cal, COURT_M)
    dummy_frame = np.zeros((1080, 1920, 3), np.uint8)
    monkeypatch.setattr(RA, "decode", lambda src, start_s=0.0, end_s=None: iter([(0.0, dummy_frame), (0.5, dummy_frame)]))

    # 1. Graceful fallback when Tcd raises (e.g., missing weights / no GPU)
    monkeypatch.setattr(GM, "Tcd", lambda dev: (_ for _ in ()).throw(RuntimeError("no gpu")))
    assert RA.auto_calibrate_video("fake.mp4") is None

    # 2. First frame returns NaNs, second frame returns valid corners refined by court_snap
    calls = {"n": 0}

    class FakeTcd:
        def __init__(self, device):
            self.device = device

        def locate(self, bgr):
            calls["n"] += 1
            return np.full((14, 2), np.nan) if calls["n"] == 1 else true_pts + 1.0

    monkeypatch.setattr(GM, "Tcd", FakeTcd)
    monkeypatch.setattr(court_snap, "refine", lambda bgr, pts: {"points": true_pts} if np.all(np.isfinite(pts[:4])) else None)
    auto_cal = RA.auto_calibrate_video("fake.mp4")
    assert auto_cal is not None
    assert np.allclose(auto_cal.Hr, cal.Hr, atol=1e-4 * np.abs(cal.Hr).max())

    # 3. finalize_session loads saved rally shots and populates full SwingVision stats + biomechanics
    rdir = tmp_path / MID / "rallies"
    rdir.mkdir(parents=True)
    (rdir / "0.shots.json").write_text(json.dumps([
        {"shot_idx": 0, "hitter": "near", "t_hit_s": 1.0, "hit_x": 0.4, "hit_y": -11.9, "stroke": "serve",
         "speed_mph": 102.0, "speed_at_bounce_mph": 76.0, "net_clearance_m": 0.35, "depth_zone": "short", "call": "in"},
        {"shot_idx": 1, "hitter": "far", "t_hit_s": 2.1, "hit_x": -1.5, "hit_y": 11.2, "stroke": "fh",
         "speed_mph": 68.0, "speed_at_bounce_mph": 51.0, "net_clearance_m": 0.62, "depth_zone": "deep", "call": "in"},
        {"shot_idx": 2, "hitter": "near", "t_hit_s": 3.3, "hit_x": 1.8, "hit_y": -11.5, "stroke": "bh",
         "speed_mph": 62.0, "speed_at_bounce_mph": 47.0, "net_clearance_m": 0.55, "depth_zone": "deep", "call": "in"},
    ]))
    spawned = []
    client = TestClient(RA.create_app(tmp_path, SECRET, spawn=lambda k, p: spawned.append((k, p)), now=lambda: NOW))
    res = client.post(f"/sessions/{MID}/finalize", json={"source": "ios", "session_type": "rally"}, headers=tok(scope="any"))
    assert res.status_code == 200
    st = spawned[-1][1]["stats"]
    assert st["total_shots"] == 3 and st["rallies"] == 1 and st["longest_rally"] == 3
    assert st["serve_speed_avg"] == 102.0 and st["serve_speed_max"] == 102.0
    assert st["fh_speed_avg"] == 68.0 and st["bh_speed_avg"] == 62.0
    assert st["avg_speed_mph"] == pytest.approx(77.3, abs=0.1) and st["max_speed_mph"] == 102.0
    assert st["net_clearance_avg_m"] == pytest.approx(0.507, abs=0.005)
    assert st["shot_counts"] == {"fh": 1, "bh": 1, "serve": 1, "feed": 0}
    assert "biomechanics" in st and len(st["biomech_traits"]) >= 4
