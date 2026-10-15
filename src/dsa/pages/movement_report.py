"""The Syllables tab of dsa.pages.technique_report: an explorer of his movement, found without supervision. His whole body
is cut into syllables by keypoint-MoSeq (dsa.measure.syllables); each run of one syllable is a dot, placed on a map by how it
moves (UMAP, for display only) and coloured by its syllable, which is its cluster. Syllables are named from what they
do (speed and direction on the court, stance) cross-checked against the hit labels. Clicking a dot plays it from the
broadcast with his skeleton drawn on, with those around it inside a circle that can be moved and sized (three clips
and their stick figures together); named syllables are ready-made selections.

Made once per project, into review/technique/explorer/:
  video/<video>.mp4   his points cut from each recording, a keyframe every 0.5 s and the index first, so any
                      piece can start at once (hardware encoder)
  pose.bin            his joints through every point at POSE_HZ, int16 image px x SCALE (missing: -32768)
  data.json           the pieces (map position, cluster, year, stroke, speed, direction), points, clusters
  explorer.js         the page's explorer (from movement_explorer.js)

    python -m dsa.pages.movement_report federer_usopen [--videos]   (the page itself is written by dsa.pages.technique_report)
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np

from dsa.ingest.projects import PROJECTS
from dsa.measure.movement import HZ, kinematics, split
from dsa.paths import PROJECTS as ROOT_PROJECTS
from dsa.paths import video_dir

SERVE_WIN = (-2.5, 1.0)                       # s from his serve's contact: a piece starting in it is part of the serve
RARE = 0.005                                  # syllables on less of his time than this are left grey
STILL, MOVING, SPRINT = 1.35, 2.0, 2.6        # m/s: below, standing; a stroke named as one below MOVING; sprint
WIDE, NARROW = 1.3, 0.7                       # ankles apart, in torso lengths
HIT, MOSTLY, AFTER = 0.4, 0.5, 0.6            # share of pieces with a labelled hit: "into a ..."; is the stroke;
                                              # after his shot / after the point
LEAVE_OUT: set[str] = set()                    # groups and names not offered as ready-made selections
TELL_APART = [("vd", 0.5, ("edging forward", "edging back")), ("speed", 0.5, ("slower", "faster")),
              ("width", 0.3, ("feet close", "feet wide"))]   # for clusters that would share a name: (what, unit, words)
POSE_HZ, SCALE = 15, 8
KEEP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 18]   # POINTS kept: body, big toes, heels
BONES = [(1, 2), (1, 3), (3, 5), (2, 4), (4, 6), (1, 7), (2, 8), (7, 8), (7, 9), (9, 11), (8, 10), (10, 12),
         (11, 14), (14, 13), (12, 16), (16, 15)]                     # in KEEP: ankle - heel - big toe
PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#59a14f", "#b07aa1", "#9c755f", "#d4a72c", "#76b7b2", "#ff9da7",
           "#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#8c564b", "#17becf", "#bcbd22", "#6b6ecf", "#e7969c",
           "#637939", "#ad494a", "#3182bd", "#e6550d", "#31a354", "#756bb1", "#843c39", "#de9ed6"]
HITS = [None, "fh", "bh", "serve"]


@lru_cache(maxsize=None)
def load(project: str) -> tuple[dict, list, list, np.ndarray]:
    d = ROOT_PROJECTS / project / "movement"
    z = dict(np.load(d / "tracks.npz"))
    a = json.loads((d / "analysis.json").read_text()) if (d / "analysis.json").exists() else {}
    return a, json.loads((d / "points.json").read_text()), split(z), z["height"]


@lru_cache(maxsize=None)
def pieces(project: str, body: str = "", serve: frozenset = frozenset()) -> tuple[list[dict], np.ndarray, np.ndarray]:
    """His syllables (dsa.measure.syllables), one piece per run of one syllable (at least 0.1 s): where it is, how he moved
    on the court, the labelled hit it contains; a vector of how his body moves (keypoint-MoSeq's pose numbers over
    each third of the run, and its length; standardised) for the map; and its syllable, or -1 for rare ones. The
    syllables in `serve` count as one, so a whole serve is one piece."""
    _, points, tracks, height = load(project)
    off = np.r_[0, np.cumsum([len(t[0]) for t in tracks])]
    z = np.load(ROOT_PROJECTS / project / "movement" / f"syllables{'_' + body if body else ''}.npz")
    syl = z["syllable"].copy()
    if serve:
        syl[np.isin(syl, list(serve))] = min(serve)
    share = np.bincount(syl) / len(syl)
    out, rows = [], []
    for i, a0, n in zip(z["point"], z["start"], z["n"]):
        i, p = int(i), points[int(i)]
        st, lat = syl[a0:a0 + n], z["latent"][a0:a0 + n]
        k = kinematics(tracks[i][1])
        hits = sorted(p["hits"], key=lambda h: h["t"])
        ank = np.abs(tracks[i][0][:, 11, 0] - tracks[i][0][:, 12, 0]) / np.nanmedian(np.linalg.norm(
            tracks[i][0][:, 1:3, :2].mean(1) - tracks[i][0][:, 7:9, :2].mean(1), axis=-1))
        b = np.flatnonzero(np.r_[True, st[1:] != st[:-1]])
        for g0, g1 in zip(b, np.r_[b[1:], len(st)]):
            if g1 - g0 < 3:
                continue
            t0, t1 = g0 / HZ, g1 / HZ
            hit = next((h for h in hits if h["side"] == "near" and t0 - 0.1 <= h["t"] <= t1 + 0.1), None)
            last = [h for h in hits if h["t"] <= t0]
            sv = next((h["t"] for h in hits if h["side"] == "near" and h["shot"] == "serve"
                       and SERVE_WIN[0] <= t0 - h["t"] <= SERVE_WIN[1]), None)
            rows.append(np.r_[np.ravel([c.mean(0) for c in np.array_split(lat[g0:g1], 3)]), np.log(g1 - g0)])
            hh = height[off[i] + g0:off[i] + g1]
            out.append({"syl": int(st[g0]) if share[st[g0]] > RARE else -1, "point": i, "g0": int(g0), "g1": int(g1),
                        "year": p["year"], "player": p["player"], "vel": k["vel"][g0:g1].mean(0), "speed": float(k["speed"][g0:g1].mean()),
                        "width": float(np.nanmean(ank[g0:g1])) if np.isfinite(ank[g0:g1]).any() else np.nan,
                        "height": float(np.nanmedian(hh) if np.isfinite(hh).any()
                                        else np.nanmedian(height[off[i]:off[i + 1]])),
                        "hit": None if hit is None else ("serve" if hit["shot"] == "serve" else hit["hand"]),
                        "serve": None if sv is None else (t0 - sv, t1 - sv),     # s from his serve's contact
                        "after": bool(last and last[-1]["side"] == "near" and not hit),
                        "end": bool(hits and t0 > hits[-1]["t"] + 0.2)})
    X = np.array(rows)
    return out, (X - X.mean(0)) / X.std(0), np.array([x["syl"] for x in out])


def describe(ps: list[dict], lab: np.ndarray) -> dict:
    """Per cluster: what it does, what hits it contains, and a name and group from those."""
    out = {}
    for j in sorted(set(lab) - {-1}):
        xs = [x for x, s in zip(ps, lab) if s == j]
        n = len(xs)
        vd, vl = np.median([x["vel"] for x in xs], 0)               # m/s: + back from the net; + to his right
        d = {"n": n, "speed": float(np.median([x["speed"] for x in xs])),
             "width": float(np.nanmedian([x["width"] for x in xs])), "vd": float(vd), "vl": float(vl),
             "hits": {k: v / n for k, v in Counter(x["hit"] for x in xs if x["hit"]).items()},
             "after": sum(x["after"] for x in xs) / n, "end": sum(x["end"] for x in xs) / n,
             "serve": sum(x["serve"] is not None for x in xs) / n}
        if d["serve"] >= MOSTLY:
            d["serve_t"] = np.median([x["serve"] for x in xs if x["serve"] is not None], 0).tolist()
        d["name"], d["group"] = name(d)
        out[int(j)] = d
    # clusters that would share a name: told apart by what differs most between them, else numbered
    for nm in {d["name"] for d in out.values()}:
        same = sorted((j for j, d in out.items() if d["name"] == nm), key=lambda j: -out[j]["n"])
        if len(same) < 2:
            continue
        if out[same[0]]["group"] == "Serve":
            for k, j in enumerate(same[1:]):
                out[j]["name"] = f"{nm} ({k + 2})"
            continue
        what, unit, words = max(TELL_APART, key=lambda t: np.ptp([out[j][t[0]] for j in same]) / t[1])
        v = [out[j][what] for j in same]
        lo, hi = same[int(np.argmin(v))], same[int(np.argmax(v))]
        if np.ptp(v) / unit >= 1:
            out[lo]["name"], out[hi]["name"] = f"{nm}, {words[0]}", f"{nm}, {words[1]}"
        for k, j in enumerate(j for j in same if out[j]["name"] == nm):
            if k:
                out[j]["name"] = f"{nm} ({k + 1})"
    return out


def name(d: dict) -> tuple[str, str]:
    h, vd, vl = d["hits"], d["vd"], d["vl"]
    if d["serve"] >= MOSTLY:                   # a phase of his serve, named by when it happens
        a, b = d["serve_t"]
        if a >= -0.1:
            return "Serve: landing", "Serve"
        if b >= -0.15:
            return "Serve: swing into contact", "Serve"
        return f"Serve: {-a:.1f} s before contact", "Serve"
    for k, nm in (("fh", "Forehand"), ("bh", "Backhand")):
        if h.get(k, 0) >= MOSTLY and d["speed"] < MOVING:
            return nm, "Hitting"
    if d["end"] >= AFTER:
        return "After the point" + (", turning left" if vl < -0.6 else ", turning right" if vl > 0.6 else ""), \
            "After the point"
    if d["speed"] < STILL:
        return ("Ready stance" if d["width"] >= WIDE else "Walk" if d["width"] < NARROW else "Small steps"), "Standing"
    if abs(vl) >= 1.5 * abs(vd):
        way = "to his right" if vl > 0 else "to his left"
    elif abs(vd) >= 1.5 * abs(vl):
        way = "back" if vd > 0 else "forward"
    else:
        way = ("back" if vd > 0 else "forward") + (" and right" if vl > 0 else " and left")
    verb = "Recover" if d["after"] >= AFTER else "Sprint" if d["speed"] >= SPRINT else "Run"
    into = next((f" into a {w}" for k, w in (("fh", "forehand"), ("bh", "backhand")) if h.get(k, 0) >= HIT), "")
    group = "To his right" if "right" in way else "To his left" if "left" in way else "Forward and back"
    return f"{verb} {way}{into}", group


def mine(project: str, p: dict) -> bool:
    """A point of the project's player(s): his (a project player), or one of the listed players' (not opponents)."""
    return p["his"] if "who" in PROJECTS[project] else p["player"] in PROJECTS[project]["players"]


def opponent(project: str, video: str, player: str = "") -> str:
    """From the match title ("..., R3 vs Blake" for a project player; "..., Rublev vs Tiafoe" otherwise: the other)."""
    title = PROJECTS[project]["videos"][video][1]
    if "who" in PROJECTS[project]:
        return title.split(" vs ")[1].split(",")[0]
    a, b = title.split(", ")[-1].split(" vs ")
    return a if player.split()[-1] == b else b


@lru_cache(maxsize=None)
def fps_of(project: str, video: str) -> float:
    return json.loads((video_dir(f"{project}/{video}") / "players.json").read_text())["fps"]


def windows(project: str) -> dict[str, list[tuple[int, int, int]]]:
    """Per recording: his points as (point, first frame, frames) in kept.mp4."""
    _, points, tracks, _ = load(project)
    out: dict[str, list] = {}
    for i, p in enumerate(points):
        if mine(project, p):
            n = int(round((len(tracks[i][0]) - 1) / HZ * fps_of(project, p["video"]))) + 1
            out.setdefault(p["video"], []).append((i, p["frame"], n))
    return out


def cut(project: str, video: str, spans: list[tuple[int, int, int]], out: Path) -> None:
    """His points of one recording, back to back, every frame kept; a keyframe every 0.5 s, index first."""
    sel = "+".join(f"between(n\\,{a}\\,{a + n - 1})" for _, a, n in spans)
    fps = fps_of(project, video)
    tmp = out.with_name(out.stem + ".part.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video_dir(f"{project}/{video}") / "kept.mp4"),
                    "-vf", f"select='{sel}',setpts=N/({fps})/TB", "-an", "-r", f"{fps}",
                    "-c:v", "h264_videotoolbox", "-b:v", "1800k", "-g", str(int(round(fps / 2))),
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(tmp)], check=True)
    tmp.rename(out)


def export(project: str, out: Path, videos: bool = True, only: list[str] | None = None, seed: int = 0) -> dict:
    """data.json, pose.bin and the videos for the explorer (videos already made are kept), and data_lower.json from
    the hips-down syllables when they have been fitted (shown with ?body=lower); returns the whole body's summary."""
    out.mkdir(parents=True, exist_ok=True)
    _, points, tracks, _ = load(project)
    win = windows(project)

    if videos:
        (out / "video").mkdir(exist_ok=True)
        todo = [(v, s) for v, s in win.items() if not (out / "video" / f"{v}.mp4").exists() and (not only or v in only)]
        with ThreadPoolExecutor(4) as pool:
            list(pool.map(lambda vs: cut(project, vs[0], vs[1], out / "video" / f"{vs[0]}.mp4"), todo))

    # points: where each starts in its cut video, and his joints through it at POSE_HZ
    vids = sorted(win)
    pts, chunks, at = {}, [], 0
    for v in vids:
        t = 0.0
        for i, _, n in win[v]:
            pose = tracks[i][0][::HZ // POSE_HZ][:, KEEP, :2]
            q = np.where(np.isfinite(pose), np.round(pose * SCALE), -32768).astype(np.int16)
            pts[i] = {"v": vids.index(v), "t0": round(t, 4), "off": at, "n": len(q),
                      "opp": opponent(project, v, points[i]["player"]), "year": points[i]["year"],
                      "who": points[i]["player"]}
            chunks.append(q)
            at += len(q)
            t += n / fps_of(project, v)
    np.concatenate(chunks).tofile(out / "pose.bin")

    base = {"videos": vids, "pose_hz": POSE_HZ, "hz": HZ, "scale": SCALE, "joints": len(KEEP), "bones": BONES,
            "points": {str(i): p for i, p in pts.items()},
            "players": [] if "who" in PROJECTS[project] else PROJECTS[project]["players"]}
    if (ROOT_PROJECTS / project / "movement" / "syllables_lower.npz").exists():
        level(project, "lower", base, out / "data_lower.json", seed)
    shutil.copy(Path(__file__).with_name("movement_explorer.js"), out / "explorer.js")
    return {**level(project, "", base, out / "data.json", seed), "points": len(pts)}


def level(project: str, body: str, base: dict, path: Path, seed: int) -> dict:
    """One set of syllables as the explorer's data file: the syllables as clusters, and the map of their runs."""
    import umap

    ps, X, lab = pieces(project, body)
    # the serve's phases (one syllable each) as one cluster, so each serve is one piece
    serve = frozenset(j for j, d in describe(ps, lab).items() if d["group"] == "Serve")
    ps, X, lab = pieces(project, body, serve)
    kinds = describe(ps, lab)
    if serve:
        kinds[min(serve)]["name"] = "Serve"
    groups = ["Serve", "Hitting", "Standing", "To his right", "To his left", "Forward and back", "After the point"]
    order = sorted(kinds, key=lambda j: (groups.index(kinds[j]["group"]), -kinds[j]["n"]))
    # names given by hand (movement/syllable_names.json), for the fit they were given for
    f = ROOT_PROJECTS / project / "movement" / "syllable_names.json"
    hand = json.loads(f.read_text()).get(body or "whole") if f.exists() else None
    z = np.load(ROOT_PROJECTS / project / "movement" / f"syllables{'_' + body if body else ''}.npz")
    if hand and hand["fit"] == f"{len(z['syllable'])}:{int(z['syllable'].astype(np.int64).sum())}":
        groups = hand["groups"]
        for j, (nm, g) in hand["names"].items():
            if int(j) in kinds:
                kinds[int(j)]["name"], kinds[int(j)]["group"] = nm, g
        listed = [int(j) for j in hand["names"]]
        order = [j for j in listed if j in kinds] + [j for j in order if j not in listed]
    elif hand:
        print(f"syllable_names.json is for an earlier fit of {body or 'whole'}; using the automatic names")
    # syllables: the map is for display only, the clusters are the syllables; UMAP is not told them, so how well
    # each syllable holds together on the map is an honest check
    Y = spread(umap.UMAP(n_neighbors=30, min_dist=0.0, random_state=seed).fit_transform(X))
    cols = columns(ps, Y, lab)
    if base["players"]:
        cols["player"] = [base["players"].index(x["player"]) for x in ps]
    path.write_text(json.dumps(
        {**base, "groups": groups, "first": "Ready stance", "clusters": cluster_list(kinds, order, Y, lab),
         "pieces": cols},
        separators=(",", ":"), allow_nan=False))
    return {"pieces": len(ps), "syllables": len(set(lab) - {-1}) + max(len(serve) - 1, 0), "serve": len(serve),
            "ps": ps, "kinds": kinds}


def spread(Y: np.ndarray) -> np.ndarray:
    """Empty stretches between islands shrunk, so the map isn't mostly gap; scaled into the unit square."""
    for c in range(2):
        o = np.sort(Y[:, c])
        gap, span = np.diff(o), o[-1] - o[0]
        Y[:, c] -= np.interp(Y[:, c], o[1:], np.cumsum(np.maximum(gap - 0.03 * span, 0) * (gap > 0.05 * span)))
    return (Y - Y.min(0)) / (Y.max(0) - Y.min(0)).max()


def cluster_list(kinds: dict, order: list, Y: np.ndarray, lab: np.ndarray) -> list[dict]:
    out = []
    for k, j in enumerate(order):
        d, pts_ = kinds[j], Y[lab == j]
        near = (np.linalg.norm(pts_[:, None] - pts_[None], axis=-1) < 0.02).sum(1)
        out.append({"id": int(j), "name": d["name"], "group": d["group"], "colour": PALETTE[k % len(PALETTE)],
                    "n": d["n"], "preset": not {d["group"], d["name"]} & LEAVE_OUT,
                    "label": np.round(pts_[np.argmax(near)], 4).tolist(),        # where it is densest
                    "pocket": np.round(np.r_[np.percentile(pts_, 3, 0), np.percentile(pts_, 97, 0)], 4).tolist()})
    return out


def columns(ps: list[dict], Y: np.ndarray, lab: np.ndarray) -> dict:
    return {"x": np.round(Y[:, 0], 4).tolist(), "y": np.round(Y[:, 1], 4).tolist(), "c": [int(c) for c in lab],
            "year": [x["year"] for x in ps], "point": [x["point"] for x in ps], "g0": [x["g0"] for x in ps],
            "g1": [x["g1"] for x in ps], "hit": [HITS.index(x["hit"]) for x in ps],
            "speed": [round(fin(x["speed"]), 2) for x in ps], "vl": [round(fin(x["vel"][1]), 2) for x in ps],
            "vd": [round(fin(x["vel"][0]), 2) for x in ps],
            "h": [round(fin(x["height"], np.nanmedian([y["height"] for y in ps])), 1) for x in ps]}


def fin(v, default: float = 0.0) -> float:
    """A number for the page: missing (no feet on the court, say) as `default`."""
    return float(v) if np.isfinite(v) else float(default)


def section(project: str, out: Path, videos: bool = True) -> tuple[str, str]:
    """The steps of how the explorer was made, for the page's methods, and the explorer's HTML."""
    info = export(project, out / "explorer", videos)
    ps = info["ps"]
    many = "who" not in PROJECTS[project]                    # many players: colour and filter by player too
    dur = np.array([(x["g1"] - x["g0"]) / HZ for x in ps])
    method = [                                  # HTML: one plain line each
        f'{"Their" if many else "His"} movement was split into short, repeated movements ("syllables") with '
        f'<a href="https://doi.org/10.1038/s41592-024-02318-2">keypoint-MoSeq</a>, from his joints alone. It found '
        f"{info['syllables']}; a typical one lasts {np.median(dur):.1f} s.",
        "The serve was over-segmented into several syllables in a row, so they were merged into one, Serve.",
        "On the map, each dot is one occurrence of a syllable, and similar movements sit close together (UMAP).",
        "The names of each syllable were given by hand after watching each syllable's typical clips.",
    ]
    # noqa: E731 (the two lambdas below)
    seg = lambda cls, items: f'<div class="seg {cls}">' + "".join(                               # noqa: E731
        f'<button data-v="{v}" aria-pressed="{str(k == 0).lower()}">{t}</button>' for k, (v, t) in enumerate(items)) + "</div>"
    one = lambda src, unit, label: f"""\
<div class="explorer" data-src="{src}" data-unit="{unit}">
  <div class="ex-bar">
    <div class="ex-ctl"><span class="ex-lab">Colour by</span>{seg("ex-colour", [("cluster", label)] + ([("player", "Player")] if many else []) + [("year", "Year"), ("speed", "Speed")])}</div>
    <div class="ex-ctl ex-filter">
      <div class="ex-range"><div class="dual"><div class="track"><div class="fill"></div></div>
        <input type="range" class="ex-y0" aria-label="From"><input type="range" class="ex-y1" aria-label="To"></div>
        <span class="ex-yl"></span></div>
      <div class="ex-chips"></div></div>
    <div class="ex-acts"><button class="tool ex-more">More examples</button><button class="tool ex-reset">Reset</button><button class="tool ex-full" aria-pressed="false"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 4.5V1h3.5M8.5 1H12v3.5M12 8.5V12H8.5M4.5 12H1V8.5"/></svg><span>Full screen</span></button></div>
  </div>
  <div class="ex-main">
    <aside class="ex-side"></aside>
    <div class="ex-mapwrap"><canvas class="ex-map"></canvas><div class="ex-legend"></div>
      <div class="ex-hint">Scroll to zoom · drag to pan · click a dot to circle it · drag the circle to move it, its edge to size it</div></div>
    <div class="ex-view">
      <div class="ex-row"><div class="ex-clips"></div>
        <div class="ex-crowdtile"><canvas class="ex-crowd"></canvas></div></div>
    </div>
  </div>
</div>"""
    return method, f"""
{one("data.json", "syllables", "Syllable")}
<script>  // ?body=lower: the hips-down syllables instead, for comparing
  if (new URLSearchParams(location.search).get("body") === "lower") {{
    const ex = document.querySelector(".explorer");
    ex.dataset.src = "data_lower.json";
    ex.insertAdjacentHTML("afterbegin", '<p class="ex-body">Hips down only: syllables from his legs, without the arms. <a href="?">Whole body</a></p>');
  }}
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script src="explorer/explorer.js"></script>"""


CSS = """
  .ex-body { margin: 14px 0 0; font-size: 14px; color: var(--ink); }
  .ex-body a { color: var(--muted); margin-left: 8px; }
  /* desktop: one screen, nothing to scroll: clusters | map | his clips, all as tall as the window allows */
  .explorer { --exh: calc(100svh - 132px); max-width: 1100px; margin: 10px auto 0; padding: 0 24px; background: var(--bg, #fff); scroll-margin-top: 64px; }
  .explorer:fullscreen { --exh: calc(100vh - 62px); max-width: none; padding: 6px 28px 0; overflow: hidden; }
  /* one line: colour by, its filter, then the buttons on the right */
  .ex-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 22px; padding: 12px 0; }
  .ex-ctl { display: flex; align-items: center; gap: 10px; }
  .ex-lab { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--faint); }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button { font: 500 13.5px Inter, sans-serif; color: var(--muted); background: #fff; border: 0; padding: 6px 12px; cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-pressed="true"] { background: var(--ink); color: #fff; }
  .ex-range { display: flex; align-items: center; gap: 12px; height: 32px; }
  .ex-yl { font-size: 13px; color: var(--ink); }
  .ex-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .ex-chips button { display: inline-flex; align-items: center; gap: 7px; font: 500 13.5px Inter, sans-serif; color: var(--faint);
    background: #fff; border: 1px solid var(--line); border-radius: 999px; padding: 5px 11px; cursor: pointer; }
  .ex-chips button i { width: 9px; height: 9px; border-radius: 50%; opacity: .3; }
  .ex-chips button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink); }
  .ex-chips button[aria-pressed="true"] i { opacity: 1; }
  .ex-yl { align-self: center; font-variant-numeric: tabular-nums; min-width: 86px; }
  .dual { position: relative; width: 210px; height: 30px; }
  .dual .track { position: absolute; left: 7px; right: 7px; top: 13px; height: 4px; border-radius: 2px; background: var(--line); }
  .dual .fill { position: absolute; top: 0; bottom: 0; background: var(--ink); border-radius: 2px; }
  .dual input { position: absolute; inset: 0; width: 100%; margin: 0; background: none; pointer-events: none; -webkit-appearance: none; appearance: none; }
  .dual input::-webkit-slider-runnable-track { height: 30px; background: none; }
  .dual input::-webkit-slider-thumb { -webkit-appearance: none; pointer-events: auto; width: 16px; height: 16px; margin-top: 7px;
    border-radius: 50%; background: #fff; border: 2px solid var(--ink); cursor: grab; }
  .dual input::-moz-range-thumb { pointer-events: auto; width: 13px; height: 13px; border-radius: 50%; background: #fff; border: 2px solid var(--ink); cursor: grab; }
  .tool { font: 500 13.5px Inter, sans-serif; color: var(--ink); background: #fff; border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 12px; cursor: pointer; }
  .tool:hover { border-color: var(--faint); }
  .tool[aria-pressed="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }
  .tool svg { vertical-align: -2px; margin-right: 6px; }
  /* the list down the left; his clips above the map, which takes what height is left */
  .ex-main { display: grid; grid-template-columns: 200px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 12px 16px;
    height: max(560px, var(--exh)); }
  .ex-side { grid-column: 1; grid-row: 1 / 3; overflow-y: auto; padding-right: 4px; min-height: 0; }
  .ex-side h5 { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--faint); margin: 14px 0 4px; }
  .ex-side h5:first-child { margin-top: 0; }
  .ex-side button { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; font: 14px/1.3 Inter, sans-serif;
    color: var(--ink); background: none; border: 0; border-radius: 7px; padding: 6px 8px; cursor: pointer; }
  .ex-side button:hover { background: var(--sunk); }
  .ex-side button[aria-pressed="true"] { background: var(--ink); color: #fff; }
  .ex-side .sw { flex: none; width: 10px; height: 10px; border-radius: 3px; }
  .ex-side .nm { flex: 1; }
  .ex-mapwrap { grid-column: 2; grid-row: 2; position: relative; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; min-height: 0; }
  .ex-map { width: 100%; height: 100%; display: block; cursor: crosshair; touch-action: none; }
  .ex-legend { position: absolute; left: 10px; bottom: 10px; font-size: 12px; color: var(--muted); background: rgba(255,255,255,.9);
    padding: 4px 9px; border-radius: 6px; pointer-events: none; }
  .ex-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin: 0 4px 0 9px; }
  .ex-legend .grad { display: inline-block; width: 120px; height: 8px; border-radius: 4px; margin: 0 6px; vertical-align: 0; }
  .ex-hint { position: absolute; left: 10px; top: 8px; white-space: nowrap; font-size: 12px; color: var(--faint); background: rgba(255,255,255,.9);
    padding: 3px 8px; border-radius: 6px; pointer-events: none; }
  .ex-view { grid-column: 2; grid-row: 1; }
  .ex-acts { display: flex; gap: 6px; flex: none; margin-left: auto; }
  .ex-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .explorer:fullscreen .ex-row { grid-template-columns: repeat(8, 1fr); gap: 6px; }
  .ex-clips { display: contents; }
  .ex-crowdtile { position: relative; aspect-ratio: 4 / 3; border: 1px solid var(--line); border-radius: 9px; background: #fff; }
  .ex-crowdtile canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .ex-clip { position: relative; aspect-ratio: 4 / 3; overflow: hidden; background: #111; border-radius: 9px; }
  .ex-clip video { position: absolute; max-width: none; }
  .ex-clip canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .ex-clip span { position: absolute; left: 8px; top: 6px; font-size: 12px; color: #eee; text-shadow: 0 1px 2px #000; }
  .ex-clip.me { outline: 2px solid var(--ink); outline-offset: 2px; }
  /* phones: clusters as a swipeable row of pills, a square map, clips two by two; no full screen */
  @media (max-width: 640px) {
    .explorer { padding: 0 16px; }
    .ex-bar { gap: 12px 16px; }
    .ex-filter { width: 100%; }
    .ex-range { flex: 1; }
    .dual { flex: 1; width: auto; }
    .ex-acts { margin-left: 0; }
    .ex-bar > .ex-ctl:first-child .ex-lab { display: none; }        /* phones: the buttons say what they are */
    .seg button { padding: 6px 9px; font-size: 13px; }
    .ex-full { display: none; }
    .ex-main { display: flex; flex-direction: column; gap: 12px; height: auto; }
    .ex-side { order: 1; } .ex-view { order: 2; } .ex-mapwrap { order: 3; }
    .ex-side { display: flex; gap: 6px; overflow-x: auto; height: auto; padding: 0 0 4px; scrollbar-width: none;
      margin: 0 -16px; padding-left: 16px; padding-right: 16px; }
    .ex-side::-webkit-scrollbar { display: none; }
    .ex-side h5 { display: none; }
    .ex-side button { flex: none; width: auto; border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px; white-space: nowrap; }
    .ex-mapwrap { height: auto; aspect-ratio: 1 / 1; }
    .ex-hint { display: none; }
    .ex-row { grid-template-columns: repeat(2, 1fr); }
  }
"""


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--videos", action="store_true")
    ap.add_argument("--only", nargs="*", help="cut these recordings only (a test run)")
    a = ap.parse_args()
    out = ROOT_PROJECTS / a.project / "review" / "technique" / "explorer"
    s = export(a.project, out, a.videos, a.only)
    print(s["pieces"], "pieces,", s["points"], "points;", [d["name"] for d in s["kinds"].values()])
