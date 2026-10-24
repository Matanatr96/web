"""Rally-mode streaks and match-mode scoring against the shared golden vectors (tests/fixtures/score_vectors.json,
also read by the Swift tests)."""
import json
from pathlib import Path

import pytest

from dsa.physics import scorekeeper as S

VECTORS = json.loads((Path(__file__).parents[1] / "fixtures/score_vectors.json").read_text())


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_match_score_vectors(case):
    state = S.replay(case["points"], **case["config"])
    got = S.summary(state)
    assert {k: got[k] for k in case["expect"]} == case["expect"]


@pytest.mark.parametrize("case", VECTORS["rally"], ids=[c["name"] for c in VECTORS["rally"]])
def test_rally_streak_vectors(case):
    got = S.summarize_rally_streak(case["shots"])
    assert {k: got[k] for k in case["expect"]} == case["expect"]


def test_apply_does_not_change_its_input_and_undo_steps_back():
    s0 = S.new_match()
    s1 = S.apply(s0, "me")
    assert s0["points"] == [0, 0] and s0["log"] == ""
    s2 = S.apply(s1, "opp")
    assert S.undo(s2) == s1
    assert S.undo(S.undo(s2)) == s0
    assert S.undo(s0) == s0                                       # nothing to undo


def test_undo_across_a_game_and_a_set():
    log = "MMMM" * 6                                              # 6-0
    s = S.replay(log)
    assert s["sets"] == [[6, 0]]
    back = S.undo(s)
    assert (back["sets"], back["games"], S.point_score(back)) == ([], [5, 0], "40-0")


def test_expected_server_side_and_reconcile():
    s = S.replay("M")
    assert S.expected_server_side(s) == "ad"
    assert S.reconcile(s, observed_side="ad") == {"ok": True, "expected_side": "ad", "expected_server": "me",
                                                  "suggestion": None}
    assert S.reconcile(s, observed_side="deuce")["suggestion"] == "missed_point"
    assert S.reconcile(s, observed_server="opp")["suggestion"] == "wrong_server"


def test_bad_input_is_refused():
    with pytest.raises(ValueError):
        S.apply(S.new_match(), "nobody")
    with pytest.raises(ValueError):
        S.new_match(best_of=4)
    with pytest.raises(ValueError):
        S.new_match(sets=3)
    done = S.replay("MMMM" * 12)
    with pytest.raises(ValueError):
        S.apply(done, "me")


def test_best_of_five_needs_three_sets():
    s = S.replay("MMMM" * 12, best_of=5)
    assert s["winner"] is None and s["sets"] == [[6, 0], [6, 0]]
    s = S.replay("MMMM" * 18, best_of=5)
    assert s["winner"] == "me"


def test_session_summary_hides_one_shot_feeds():
    r = lambda calls, zones=None, strokes=None, speeds=None, clearances=None: [   # noqa: E731
        {"t_hit_s": 1.0 * k, "call": c, "depth_zone": (zones or ["deep"] * len(calls))[k],
         "stroke": (strokes or [None] * len(calls))[k], "speed_mph": (speeds or [None] * len(calls))[k],
         "net_clearance_m": (clearances or [None] * len(calls))[k]}
        for k, c in enumerate(calls)]
    rallies = [r(["in"] * 12, strokes=["fh", "bh"] * 6, speeds=[60, 50] * 6, clearances=[0.5, 0.7] * 6),
               r(["in", "out", "in"], zones=["deep", "out_long", "short"], strokes=["serve", "fh", "bh"],
                 speeds=[95.0, 66.0, 56.0], clearances=[0.2, 0.4, 0.6]),
               r(["in"], strokes=["feed"])]                       # an aborted feed
    assert S.summarize_session(rallies) == {
        "total_shots": 16,
        "rallies": 2,
        "longest_rally": 12,
        "avg_rally_length": 7.5,
        "rallies_10_plus": 1,
        "deep_pct": round(100 * 14 / 16, 1),
        "in_pct": round(100 * 15 / 16, 1),
        "fh_speed_avg": round((60.0 * 6 + 66.0) / 7, 1),
        "fh_speed_max": 66.0,
        "bh_speed_avg": round((50.0 * 6 + 56.0) / 7, 1),
        "bh_speed_max": 56.0,
        "serve_speed_avg": 95.0,
        "serve_speed_max": 95.0,
        "avg_speed_mph": round((60.0 * 6 + 50.0 * 6 + 95.0 + 66.0 + 56.0) / 15, 1),
        "max_speed_mph": 95.0,
        "net_clearance_avg_m": round((0.5 * 6 + 0.7 * 6 + 0.2 + 0.4 + 0.6) / 15, 3),
        "shot_counts": {"fh": 7, "bh": 7, "serve": 1, "feed": 1}}
    assert S.summarize_session(rallies, hide_one_shot_feeds=False)["avg_rally_length"] == round(16 / 3, 1)
    assert S.summarize_session([]) == {
        "total_shots": 0, "rallies": 0, "longest_rally": 0, "avg_rally_length": None,
        "rallies_10_plus": 0, "deep_pct": None, "in_pct": None,
        "fh_speed_avg": None, "fh_speed_max": None, "bh_speed_avg": None, "bh_speed_max": None,
        "serve_speed_avg": None, "serve_speed_max": None, "avg_speed_mph": None, "max_speed_mph": None,
        "net_clearance_avg_m": None, "shot_counts": {"fh": 0, "bh": 0, "serve": 0, "feed": 0}}
