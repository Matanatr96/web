"""Scoring for both kinds of session.

Rally mode (default; hitting, drills, cooperative rallies, no serve needed):
  summarize_rally_streak  one rally's shots -> shot_count (hits), in_streak (in / close / unknown calls before the
                          first out), outs, played_on_after_out (an out ball returned within MAX_RALLY_GAP_S),
                          avg_tempo_s (between hits) and deep_pct.
  summarize_session       every rally -> longest_rally, avg_rally_length (1-shot aborted feeds left out unless
                          hide_one_shot_feeds=False), rallies_10_plus, deep_pct, in_pct, fh/bh average speed.
  deep_pct = 100 * deep / bounces in {deep, short, out_long, out_wide}, rounded to 0.1.

Match mode (opt in): a state is a JSON-able dict whose "log" is every point's winner ("M" me, "O" opponent);
  apply   a point won -> the next state (best of 3 or 5, ad or no-ad, 7-point tiebreaks at 6-6, optionally a
          10-point match tiebreak instead of the final set).
  undo    the state before the last point (the log replayed).
  expected_server_side  'deuce' or 'ad': where the next serve comes from.
  reconcile             an observed serving side (or server) against the state: a mismatch means a point was
                        missed or doubled.
"""
from __future__ import annotations

import copy

MAX_RALLY_GAP_S = 3.5
IN_CALLS = ("in", "close", "unknown")
LANDED = ("deep", "short", "out_long", "out_wide")
PTS = ("0", "15", "30", "40")
DEFAULT = {"best_of": 3, "no_ad": False, "match_tiebreak": False, "first_server": "me"}


# --- rally mode ---------------------------------------------------------------------------------------------

def _deep_pct(zones: list[str]) -> float | None:
    landed = [z for z in zones if z in LANDED]
    return round(100 * sum(z == "deep" for z in landed) / len(landed), 1) if landed else None


def summarize_rally_streak(shots: list[dict], max_gap_s: float = MAX_RALLY_GAP_S) -> dict:
    """One rally's shots (dicts with t_hit_s, call, depth_zone, in hit order) -> its streak metrics."""
    shots = sorted(shots, key=lambda s: s.get("t_hit_s") or 0.0)
    calls = [s.get("call") or "unknown" for s in shots]
    in_streak = 0
    for c in calls:
        if c not in IN_CALLS:
            break
        in_streak += 1
    played_on = any(c == "out" and k + 1 < len(shots) and
                    (shots[k + 1].get("t_hit_s") or 0) - (shots[k].get("t_hit_s") or 0) <= max_gap_s
                    for k, c in enumerate(calls))
    t = [s["t_hit_s"] for s in shots if s.get("t_hit_s") is not None]
    gaps = [b - a for a, b in zip(t, t[1:])]
    return {"shot_count": len(shots), "in_streak": in_streak, "outs": calls.count("out"),
            "played_on_after_out": played_on, "avg_tempo_s": round(sum(gaps) / len(gaps), 3) if gaps else None,
            "deep_pct": _deep_pct([s.get("depth_zone") or "unknown" for s in shots])}


def summarize_session(rallies: list[list[dict]], hide_one_shot_feeds: bool = True) -> dict:
    """Every rally's shots -> the session's headline numbers (rally mode)."""
    per = [summarize_rally_streak(r) for r in rallies]
    counted = [p for p in per if p["shot_count"] >= 2] if hide_one_shot_feeds else per
    shots = [s for r in rallies for s in r]
    judged = [s.get("call") for s in shots if s.get("call") in ("in", "out", "close")]

    def speed(stroke):
        v = [s["speed_mph"] for s in shots if s.get("stroke") == stroke and s.get("speed_mph") is not None]
        return round(sum(v) / len(v), 1) if v else None

    return {"rallies": len(counted), "longest_rally": max((p["shot_count"] for p in per), default=0),
            "avg_rally_length": round(sum(p["shot_count"] for p in counted) / len(counted), 1) if counted else None,
            "rallies_10_plus": sum(p["shot_count"] >= 10 for p in per),
            "deep_pct": _deep_pct([s.get("depth_zone") or "unknown" for s in shots]),
            "in_pct": round(100 * sum(c != "out" for c in judged) / len(judged), 1) if judged else None,
            "fh_speed_avg": speed("fh"), "bh_speed_avg": speed("bh")}


# --- match mode ---------------------------------------------------------------------------------------------

def _other(p: str) -> str:
    return "opp" if p == "me" else "me"


def new_match(**config) -> dict:
    """A match before its first point. config: best_of (3|5), no_ad, match_tiebreak, first_server ('me'|'opp')."""
    bad = set(config) - set(DEFAULT)
    if bad:
        raise ValueError(f"unknown config {sorted(bad)}")
    cfg = DEFAULT | config
    if cfg["best_of"] not in (3, 5) or cfg["first_server"] not in ("me", "opp"):
        raise ValueError("best_of must be 3 or 5, first_server 'me' or 'opp'")
    return {"config": cfg, "log": "", "sets": [], "games": [0, 0], "points": [0, 0], "tiebreak": False,
            "tiebreak_to": 7, "server": cfg["first_server"], "set_first_server": cfg["first_server"],
            "winner": None}


def _sets_won(state: dict) -> list[int]:
    return [sum(a > b for a, b in state["sets"]), sum(b > a for a, b in state["sets"])]


def _final_set(state: dict) -> bool:
    need = state["config"]["best_of"] // 2 + 1
    return _sets_won(state) == [need - 1, need - 1]


def _tb_server(state: dict) -> str:
    """Tiebreak: the player due serves point 1, then each serves two in turn."""
    n = sum(state["points"])
    first = state["tb_first"]
    return first if ((n + 1) // 2) % 2 == 0 else _other(first)


def apply(state: dict, winner: str) -> dict:
    """The state after `winner` ('me' | 'opp', or 'M' | 'O') wins a point. The input is not changed."""
    w = {"M": "me", "O": "opp"}.get(winner, winner)
    if w not in ("me", "opp"):
        raise ValueError("winner must be 'me' or 'opp'")
    if state["winner"]:
        raise ValueError("the match is over")
    s = copy.deepcopy(state)
    s["log"] += "M" if w == "me" else "O"
    k = 0 if w == "me" else 1
    s["points"][k] += 1
    a, b = s["points"][k], s["points"][1 - k]
    if s["tiebreak"]:
        if a >= s["tiebreak_to"] and a - b >= 2:
            g = list(s["games"])
            g[k] += 1
            _end_set(s, g, next_server=_other(s["tb_first"]))
        else:
            s["server"] = _tb_server(s)
        return s
    won = a >= 4 and (a - b >= 2 or (s["config"]["no_ad"] and a + b >= 7))
    if not won:
        return s
    s["points"] = [0, 0]
    s["games"][k] += 1
    g = s["games"]
    nxt = _other(s["server"])
    if max(g) >= 6 and abs(g[0] - g[1]) >= 2:
        _end_set(s, list(g), next_server=nxt)
    elif g == [6, 6]:
        s["tiebreak"], s["tiebreak_to"], s["tb_first"], s["server"] = True, 7, nxt, nxt
    else:
        s["server"] = nxt
    return s


def _end_set(s: dict, games: list[int], next_server: str) -> None:
    s["sets"].append(games)
    s["games"], s["points"], s["tiebreak"] = [0, 0], [0, 0], False
    s.pop("tb_first", None)
    need = s["config"]["best_of"] // 2 + 1
    won = _sets_won(s)
    s["server"] = s["set_first_server"] = next_server
    if max(won) == need:
        s["winner"] = "me" if won[0] == need else "opp"
        return
    if s["config"]["match_tiebreak"] and _final_set(s):
        s["tiebreak"], s["tiebreak_to"], s["tb_first"] = True, 10, next_server


def replay(log: str, **config) -> dict:
    """The state after the points in log ('M' / 'O' per point)."""
    s = new_match(**config)
    for c in log:
        s = apply(s, c)
    return s


def undo(state: dict) -> dict:
    """The state before the last point (unchanged before the first)."""
    return replay(state["log"][:-1], **state["config"]) if state["log"] else copy.deepcopy(state)


def expected_server_side(state: dict) -> str:
    """'deuce' when an even number of points has been played in this game or tiebreak, else 'ad'."""
    return "deuce" if sum(state["points"]) % 2 == 0 else "ad"


def reconcile(state: dict, observed_side: str | None = None, observed_server: str | None = None) -> dict:
    """Check the score against what the camera saw at the next serve: the serving side (from the server's
    position) and/or who serves. ok False with suggestion 'missed_point' (side parity off: add or undo a
    point) or 'wrong_server' (a game was missed or doubled)."""
    exp_side, exp_server = expected_server_side(state), state["server"]
    out = {"ok": True, "expected_side": exp_side, "expected_server": exp_server, "suggestion": None}
    if observed_server is not None and observed_server != exp_server:
        out.update(ok=False, suggestion="wrong_server")
    elif observed_side is not None and observed_side != exp_side:
        out.update(ok=False, suggestion="missed_point")
    return out


def point_score(state: dict) -> str:
    """The current game's score, me first: '30-15', '40-40', 'AD-40'; tiebreak points as numbers."""
    a, b = state["points"]
    if state["tiebreak"]:
        return f"{a}-{b}"
    if a >= 3 and b >= 3 and not state["config"]["no_ad"]:
        return "40-40" if a == b else ("AD-40" if a > b else "40-AD")
    return f"{PTS[min(a, 3)]}-{PTS[min(b, 3)]}"


def format_score(state: dict) -> str:
    """'6-4 3-2 30-15' (me first): completed sets, then games and points of the current set."""
    parts = [f"{a}-{b}" for a, b in state["sets"]]
    if not state["winner"]:
        parts += [f"{state['games'][0]}-{state['games'][1]}", point_score(state)]
    return " ".join(parts)


def summary(state: dict) -> dict:
    """The score as the web viewer and the watch show it."""
    return {"sets": [list(x) for x in state["sets"]], "games": list(state["games"]), "points": point_score(state),
            "server": state["server"], "side": expected_server_side(state), "tiebreak": state["tiebreak"],
            "display": format_score(state), "winner": state["winner"]}
