"""The guess-the-players game: its clips, cut from the quiz project's videos (dsa.ingest.projects) after steps 0-4.
Each level shows two rallies of one match, one served by each player from the near end (the far player is
small and tracked worse; a server is easy to tell), between them a forehand and a backhand by each; the first
listed player (dsa.ingest.projects) is always blue.

  points  per video: every point with at least MIN_HITS hits (dsa.scene.results.points: from just before the serve
          to just after the last shot) whose court holds still (`court_ok`) and whose players are tracked
          well (`tracked`), then up to PAIRS pairs of them
          (`pairs`), drawn plain on black (skeletons, ball, court, net, stroke captions) into
          <video>/points/<first frame>.mp4; the candidates in points/points.json, the pairs in pairs.json.
          Nobody changes ends during a point, so each end keeps the player it has most often (step 3 mixes
          them up for a few frames now and then). Who that player is comes from the TV scoreboard's serve
          marker just before the serve, read by Opus, and the serving end; with no marker (old broadcasts),
          from step 4's names.json.
  export  every level's pairs, copied to <site>/clips/, with <site>/manifest.json.

    python -m dsa.pages.quiz points quiz/l1_federer_nadal      # or: points all
    python -m dsa.pages.quiz export ../tennis-skeleton-quiz
"""
from __future__ import annotations

import argparse
import json
import shutil
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

from dsa.ingest.projects import PROJECTS
from dsa.opus import ask
from dsa.pages import render
from dsa.paths import video_dir
from dsa.scene import results
from dsa.video import frame_at

MIN_HITS, PAIRS = 4, 5              # hits in a rally; pairs of rallies per video
TWIST, JUMP = 3.0, 0.02             # court: degrees the baselines may turn against each other in a rally;
                                    # share of its width it may move in one frame
MISSING, JUMPS = 0.05, 2            # tracking: share of frames an end's player may be missing; times their
                                    # box may jump (feet a quarter of its height) or change height by a quarter
BEFORE = (1.0, 2.5)                 # seconds before the serve at which the scoreboard is read, in turn
VIDEOS = PROJECTS["quiz"]["videos"]


def steady(d: dict, f0: int, f1: int) -> dict | None:
    """d with each end's player in frames [f0, f1) set to the one there most often; None unless the two ends
    have different players."""
    nf = d["pl"]["near_far"]
    most = [Counter(x[e] for x in nf[f0:f1] if x[e]).most_common(1) for e in (0, 1)]
    keep = [m[0][0] if m else None for m in most]
    if keep[0] is None or keep[1] is None or keep[0] == keep[1]:
        return None
    nf = list(nf)
    nf[f0:f1] = [[keep[e] if x[e] else None for e in (0, 1)] for x in nf[f0:f1]]
    return {**d, "pl": {**d["pl"], "near_far": nf}}


def court_ok(d: dict, f0: int, f1: int) -> bool:
    """The court found in every frame and holding its shape: a panning camera turns both baselines alike,
    a misplaced court turns them against each other (by more than TWIST) or jumps (by more than JUMP)."""
    c = d["court"][f0:f1] if d["court"] is not None else [None]
    if any(x is None for x in c):
        return False
    ang = lambda p, q: np.degrees(np.arctan2(q[1] - p[1], q[0] - p[0]))           # noqa: E731
    twist = [ang(x[0], x[1]) - ang(x[2], x[3]) for x in c]
    moved = [np.max(np.linalg.norm(b - a, axis=1)) / np.linalg.norm(a[3] - a[2]) for a, b in zip(c, c[1:])]
    return max(twist) - min(twist) <= TWIST and max(moved, default=0) <= JUMP


def tracked(d: dict, f0: int, f1: int) -> bool:
    """Both players followed throughout: each end's box missing (or under half its usual height: a spectator's
    head at the edge of the picture after the player runs out of it) in at most MISSING of the frames, and jumping
    or changing size from where it was last seen at most JUMPS times each (another person, or part of one);
    and the near player, nearer the camera, the taller (not a spectator's head at the edge of the picture)."""
    tall = []
    for e in (0, 1):
        b = [d["pl"]["boxes"][i][e] for i in range(f0, f1)]
        seen = [x for x in b if x is not None]
        jumps = size = 0
        for p, q in zip(seen, seen[1:]):
            h = (p[3] - p[1] + q[3] - q[1]) / 2
            jumps += np.hypot((p[0] + p[2] - q[0] - q[2]) / 2, p[3] - q[3]) > 0.25 * h
            size += abs((q[3] - q[1]) / (p[3] - p[1]) - 1) > 0.25
        tall.append(np.median([x[3] - x[1] for x in seen]) if seen else 0)
        small = sum(x[3] - x[1] < tall[-1] / 2 for x in seen)
        if len(b) - len(seen) + small > MISSING * len(b) or jumps > JUMPS or size > JUMPS:
            return False
    return tall[0] > tall[1]


def server(d: dict, f0: int, serve: int, pair: list[str]) -> str | None:
    """The name the scoreboard marks as serving shortly before frame `serve` (not before f0, the point's first
    frame, which may follow a cut), or None if it shows no marker."""
    schema = {"type": "object", "properties": {"serving": {"type": "string", "enum": pair + ["unknown"]}},
              "required": ["serving"], "additionalProperties": False}
    prompt = (f"A frame from a TV broadcast of {pair[0]} v {pair[1]}. Read the on-screen scoreboard, if there is "
              f"one: which player does it mark as serving (a ball, dot or arrow by the name)? Answer 'unknown' if "
              f"there is no scoreboard or no serve marker.")
    for s in BEFORE:
        f = max(f0, serve - int(s * d["fps"]))
        img = d["src"] / "points/serve" / f"{f:06d}.jpg"
        img.parent.mkdir(parents=True, exist_ok=True)
        if not img.exists():
            cv2.imwrite(str(img), frame_at(d["video"], f), [cv2.IMWRITE_JPEG_QUALITY, 90])
        a, _ = ask(prompt, [img], schema, d["src"] / "points/serve/cache", effort="low")
        if a["serving"] != "unknown":
            return a["serving"]
    return None


def names_of(d: dict, one: dict, f0: int, f1: int, pair: list[str]) -> tuple[dict[int, str], str, str] | None:
    """({step 3 player id: name}, the server's name, how it was decided) for the point in [f0, f1); None when
    nobody is seen at the serving end."""
    serve = next(h for h in d["hits"] if f0 <= h["frame"] < f1 and h["shot"] == "serve")
    k = one["pl"]["near_far"][serve["frame"]][0 if serve["side"] == "near" else 1]
    if k is None:
        return None
    who = server(d, f0, serve["frame"], pair)
    if who is None:
        n = json.loads((d["src"] / "names.json").read_text())
        ids = {1: n["1"], 2: n["2"]}
        return ids, ids[k], "names.json"
    return {k: who, 3 - k: pair[1 - pair.index(who)]}, who, "scoreboard"


def candidates(d: dict, pair: list[str]) -> list[dict]:
    """Every point fit for the game, with who served and each player's forehands and backhands."""
    starts = d["starts"]
    rows = []
    for hits, f0, f1 in results.points(d["hits"], list(zip(starts[:-1], starts[1:])), d["fps"]):
        f0, f1 = int(f0), int(f1)
        one = steady(d, f0, f1) if hits >= MIN_HITS else None
        serve = next(h for h in d["hits"] if f0 <= h["frame"] < f1 and h["shot"] == "serve")
        if one is None or serve["side"] != "near" or not court_ok(d, f0, f1) or not tracked(d, f0, f1):
            continue
        named = names_of(d, one, f0, f1, pair)
        if named is None:
            continue
        ids, serve, by = named
        strokes = {p: {"fh": 0, "bh": 0} for p in pair}
        for h in (h for h in d["hits"] if f0 <= h["frame"] < f1 and h["hand"] in ("fh", "bh")):
            k = one["pl"]["near_far"][h["frame"]][0 if h["side"] == "near" else 1]
            if k:
                strokes[ids[k]][h["hand"]] += 1
        rows.append({"clip": f"{f0:06d}.mp4", "first": f0, "end": f1, "hits": hits,
                     "seconds": round((f1 - f0) / d["fps"], 1), "serve": serve,
                     "blue_id": next(k for k in ids if ids[k] == pair[0]), "strokes": strokes, "by": by})
    return rows


def pairs(rows: list[dict], pair: list[str]) -> list[list[dict]]:
    """Up to PAIRS pairs of points, one served by each player, between them a forehand and a backhand by
    each; shortest first, no point used twice; only points named from the scoreboard when the video has one."""
    if any(r["by"] == "scoreboard" for r in rows):
        rows = [r for r in rows if r["by"] == "scoreboard"]
    ok = []
    for a in (r for r in rows if r["serve"] == pair[0]):
        for b in (r for r in rows if r["serve"] == pair[1]):
            if all(a["strokes"][p][s] + b["strokes"][p][s] for p in pair for s in ("fh", "bh")):
                ok.append((a["seconds"] + b["seconds"], a, b))
    out, used = [], set()
    for _, a, b in sorted(ok, key=lambda x: x[0]):
        if len(out) < PAIRS and a["clip"] not in used and b["clip"] not in used:
            out.append([a, b])
            used |= {a["clip"], b["clip"]}
    return out


def points(spec: str) -> list[list[dict]]:
    d = results.load(spec)
    out = d["src"] / "points"
    out.mkdir(exist_ok=True)
    pair = list(VIDEOS[spec.split("/")[-1]][3])
    rows = candidates(d, pair)
    chosen = pairs(rows, pair)
    keep = {r["clip"] for p in chosen for r in p}
    for f in out.glob("*.mp4"):                       # also macOS's ._ files on the exFAT drive
        if f.name not in keep:
            f.unlink(missing_ok=True)
    for r in (r for p in chosen for r in p):
        if not (out / r["clip"]).exists():
            one = steady(d, r["first"], r["end"])
            if r["blue_id"] != 1:                     # the first listed player is blue
                nf = one["pl"]["near_far"]
                nf[r["first"]:r["end"]] = [[3 - k if k else None for k in x] for x in nf[r["first"]:r["end"]]]
            render.draw(one, r["first"], r["end"], out / r["clip"], plain=True)
    (out / "points.json").write_text(json.dumps(rows, indent=1))
    (out / "pairs.json").write_text(json.dumps([[r["clip"] for r in p] for p in chosen]))
    return chosen


def export(site: Path) -> dict:
    """Copy each level's pairs to site/clips/ and write site/manifest.json."""
    clips = site / "clips"
    shutil.rmtree(clips, ignore_errors=True)
    clips.mkdir(parents=True)
    levels = {}
    for v, (yt, match, level, players, _) in VIDEOS.items():
        pj = video_dir(f"quiz/{v}") / "points/pairs.json"
        if level is None:
            continue
        for p in json.loads(pj.read_text()) if pj.exists() else []:
            for c in p:
                shutil.copy(video_dir(f"quiz/{v}") / "points" / c, clips / f"{v}_{c}")
            levels.setdefault(level, []).append({"clips": [f"clips/{v}_{c}" for c in p], "match": match,
                                                 "players": [{"name": n} for n in players]})
    manifest = {"levels": [{"level": lv, "rounds": levels[lv]} for lv in sorted(levels)]}
    (site / "manifest.json").write_text(json.dumps(manifest, indent=1))
    return {lv["level"]: len(lv["rounds"]) for lv in manifest["levels"]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["points", "export"])
    ap.add_argument("target", nargs="?", help="points: quiz/<video> or all; export: the site's folder")
    a = ap.parse_args()
    if a.cmd == "export":
        print(export(Path(a.target)))
    else:
        for v in [v for v in VIDEOS if VIDEOS[v][2]] if a.target == "all" else [a.target.split("/")[-1]]:
            if (video_dir(f"quiz/{v}") / "names.json").exists():
                print(v, len(points(f"quiz/{v}")), "pairs", flush=True)
