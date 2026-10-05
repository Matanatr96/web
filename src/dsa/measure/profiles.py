"""How each player's strokes differ from the other players' (a project without one project player, such as
atp_hardcourt): the measures of dsa.measure.technique, each player against everyone else in the project.

Per kind (forehand, backhand, serve): the routine strokes of each player (dsa.measure.technique.prepare, grouped by
player); the measured camera, the event (AO / USO) and the situation regressed out, their effects estimated within each player so that
a player's style isn't taken for camera; then each player's match gives one number, his mean. For each player and
measure, his matches against every other player's matches by Welch's t-test, Holm over the measures within the
player. A finding: Holm-adjusted p below ALPHA and a difference of at least MIN_SD standard deviations of the
match means. Lengths are tested in torso lengths (camera zoom cancels) and shown in metres.

How they move (dsa.measure.movement's rally, run-to-the-ball and recovery measures) is compared the same way.

    python -m dsa.measure.profiles atp_hardcourt    -> projects/<project>/profiles/<kind>.json, movement.json
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from dsa.ingest.projects import match
from dsa.measure.technique import MEASURES, camera, prepare
from dsa.paths import PROJECTS as ROOT_PROJECTS

KINDS = ["forehand", "backhand", "serve"]
ALPHA, MIN_SD = 0.05, 0.4
MIN_STROKES = 2                     # a player's match counts with at least this many routine strokes


def holm(p: np.ndarray) -> np.ndarray:
    order = np.argsort(p)                                  # the k-th smallest p times (tests - k)
    out = np.empty_like(p)
    out[order] = np.minimum(1, np.maximum.accumulate(p[order] * (len(p) - np.arange(len(p)))))
    return out


def adjusted(f: np.ndarray, ctx: np.ndarray, cam: np.ndarray, player: np.ndarray, dirs: list) -> np.ndarray:
    """f with the camera and the situation (court position, running speed, direction) regressed out, their
    effects estimated within each player."""
    levels = sorted(set(dirs))
    nuis = np.column_stack([ctx, cam] + [np.array([d == lv for d in dirs], float) for lv in levels[1:]])
    nuis = nuis - nuis.mean(0)
    cells = np.column_stack([player == p for p in dict.fromkeys(player)]).astype(float)
    beta = np.linalg.lstsq(np.column_stack([cells, nuis]), f, rcond=None)[0]
    return f - nuis @ beta[cells.shape[1]:]


def event(video: np.ndarray) -> np.ndarray:
    """1 for a US Open match, 0 for the Australian Open: their broadcasts differ (camera height, court colour),
    taken out with the camera."""
    return np.array(["_uso_" in v for v in video], float)


def compare(res: np.ndarray, player: np.ndarray, video: np.ndarray) -> dict:
    """Per player: the mean of his match means, the difference from the other players' matches, Welch's t, df,
    p and Holm-adjusted p per measure; and the SD of all match means (the scale for MIN_SD)."""
    from scipy.stats import ttest_ind

    units = [(p, v) for p, v in dict.fromkeys(zip(player, video))
             if ((player == p) & (video == v)).sum() >= MIN_STROKES]
    means = np.stack([res[(player == p) & (video == v)].mean(0) for p, v in units])
    who = np.array([p for p, _ in units])
    out = {}
    for p in dict.fromkeys(who):
        mine, rest = means[who == p], means[who != p]
        if len(mine) < 2:
            continue
        t = ttest_ind(mine, rest, equal_var=False)
        pv = np.asarray(t.pvalue)
        out[str(p)] = {"matches": int(len(mine)), "mean": mine.mean(0).round(4).tolist(),
                  "diff": (mine.mean(0) - rest.mean(0)).round(4).tolist(), "t": np.round(t.statistic, 3).tolist(),
                  "df": np.round(t.df, 1).tolist(), "p": pv.tolist(), "holm": holm(pv).tolist()}
    return {"players": out, "sd": means.std(0).round(4).tolist(), "pool": means.mean(0).round(4).tolist(),
            "units": len(units)}


def analyse(project: str, kind: str) -> dict:
    names, lengths = list(MEASURES[kind][0]), MEASURES[kind][1]
    d = prepare(project, kind, lambda m: m["player"])
    f, ctx, meta, z, lo, hi = d["f"], d["ctx"], d["meta"], d["z"], d["lo"], d["hi"]
    player = np.array([m["player"] for m in meta])
    video = np.array([match(m["video"]) for m in meta])          # one unit per player and match
    f = np.where(np.isfinite(f), f, np.nanmedian(f, 0))
    ctx = np.where(np.isfinite(ctx), ctx, np.nanmedian(ctx, 0))
    cam = np.column_stack([camera(meta, d["score"], lo, hi), event(video)])
    dirs = [m["direction"] or "?" for m in meta]
    out = {"kind": kind, "features": names, "lengths": lengths, "kept": int(len(f)), "extracted": d["n"],
           "standard": d["res_std"], "alpha": ALPHA, "min_sd": MIN_SD,
           "strokes": {p: int((player == p).sum()) for p in dict.fromkeys(player)},
           "test": compare(adjusted(f, ctx, cam, player, dirs), player, video)}
    # lengths in metres from the court, for display
    px = z["pose"][d["keep"]][:, lo:hi + 1]
    mid = lambda a, b: (px[:, :, a, :2] + px[:, :, b, :2]) / 2                            # noqa: E731
    torso = np.nanmedian(np.linalg.norm(mid(1, 2) - mid(7, 8), axis=-1), 1)
    ppm = np.array([(m["camera"] or {}).get("ppm", np.nan) for m in meta])
    idx = [list(names).index(n) for n in lengths]
    if idx:
        g = f.copy()
        scale = torso / ppm
        g[:, idx] = f[:, idx] * np.where(np.isfinite(scale), scale, np.nanmedian(scale))[:, None]
        out["metres"] = compare(adjusted(g, ctx, cam, player, dirs), player, video)
    findings(out["test"], names)
    return out


def findings(t: dict, names: list[str]) -> None:
    """Each player's findings (compare's output, in place): Holm below ALPHA and at least MIN_SD apart."""
    for r in t["players"].values():
        r["findings"] = [names[j] for j in range(len(names))
                         if r["holm"][j] < ALPHA and abs(r["diff"][j]) >= MIN_SD * t["sd"][j]]


def movement(project: str) -> dict:
    """The same for how they move (dsa.measure.movement's measures: per rally, per run to the ball, per recovery), the
    camera's zoom and the player's size on screen regressed out."""
    from dsa.measure.movement import RALLY, RECOVER, TO_BALL, measures, split

    d = ROOT_PROJECTS / project / "movement"
    z = dict(np.load(d / "tracks.npz"))
    points = json.loads((d / "points.json").read_text())
    off, m = np.r_[0, np.cumsum(z["lengths"])], measures(points, split(z))
    out = {}
    for table, spec in (("rally", RALLY), ("to_ball", TO_BALL), ("recover", RECOVER)):
        idx = np.array([i for i, _ in m[table]])
        f = np.array([v for _, v in m[table]], float)
        f = np.where(np.isfinite(f), f, np.nanmedian(f, 0))
        meta = [points[i] for i in idx]
        cam = np.array([[p["zoom"] or np.nan, np.nanmedian(z["height"][off[i]:off[i + 1]])] for p, i in zip(meta, idx)])
        cam = np.where(np.isfinite(cam), cam, np.nanmedian(cam, 0))
        cam = np.column_stack([cam, event(np.array([p["video"] for p in meta]))])
        player = np.array([p["player"] for p in meta])
        t = compare(adjusted(f, np.zeros((len(f), 1)), cam, player, ["?"] * len(f)), player,
                    np.array([match(p["video"]) for p in meta]))
        findings(t, list(spec))
        out[table] = {"features": list(spec), "units": {k: u for k, (u, _) in spec.items()},
                      "about": {k: a for k, (_, a) in spec.items()}, "rows": int(len(f)), "test": t}
    return out


def run(project: str) -> None:
    out_dir = ROOT_PROJECTS / project / "profiles"
    out_dir.mkdir(parents=True, exist_ok=True)
    for kind in KINDS:
        r = analyse(project, kind)
        (out_dir / f"{kind}.json").write_text(json.dumps(r))
        print(f"{kind}: {r['kept']} routine strokes of {r['extracted']}, {r['test']['units']} player-matches",
              flush=True)
        for p, x in r["test"]["players"].items():
            print(f"  {p:20s} {x['matches']} matches  {', '.join(x['findings']) or '-'}", flush=True)
    if (ROOT_PROJECTS / project / "movement" / "tracks.npz").exists():
        r = movement(project)
        (out_dir / "movement.json").write_text(json.dumps(r))
        for table, x in r.items():
            print(f"{table}: {x['rows']} rows, {x['test']['units']} player-matches", flush=True)
            for p, y in x["test"]["players"].items():
                print(f"  {p:20s} {y['matches']} matches  {', '.join(y['findings']) or '-'}", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    run(ap.parse_args().project)
