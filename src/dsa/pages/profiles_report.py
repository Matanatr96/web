"""Step 7 for a project of many players (atp_hardcourt): how each player's strokes and movement differ from the other
players' (dsa.measure.profiles). An overview of every player against every measure; a tab per player with only the
measures where he is the most or second most extreme of them, either way, each with every player's strokes and his
typical stroke next to a typical pro's (dsa.pages.exemplars, the measurement drawn on); a Statistics tab with every
measure's boxes. Players of a project compared with this one ("compare_with": our own phone footage) get a tab each,
ranked against the pros, with how much each measure depends on the camera.

    python -m dsa.measure.profiles atp_hardcourt                  # first
    python -m dsa.pages.profiles_report atp_hardcourt [--no-videos]  -> projects/<project>/review/profiles/
    python -m dsa.pages.serve data/projects/atp_hardcourt/review 8767
"""
from __future__ import annotations

import argparse
import html
import json
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

from dsa.ingest.projects import PROJECTS, match
from dsa.measure.profiles import COURT
from dsa.measure.technique import GRID, MEASURES, MIRROR, lefty, normalise, phases
from dsa.pages import explainer, movement_report, tennis
from dsa.pages.exemplars import render
from dsa.paths import PROJECTS as ROOT_PROJECTS
from dsa.paths import video_dir

KINDS = ["serve", "forehand", "backhand"]
WORDS = dict(enumerate("zero one two three four five six seven eight nine ten eleven twelve".split()))
UNIT = {"deg": "°", "s": " s", "m": " m", "m/s": " m/s", "share": "", "torso": " torsos", "torso/s": " torsos/s"}
# the moment each stroke measure is taken (s from contact), for the pose figure and the video's hold
MOMENT = {"finish_height": 0.3, "finish_side": 0.3, "finish_arm": 0.3, "knee_bend": -0.15, "takeback": -0.2, "shoulder_coil": -0.35,
          "hip_coil": -0.35, "separation": -0.35, "into_court": 0.4, "toss_arm": "toss", "toss_straight": "toss", "toss_tilt": "toss", "trophy_time": "toss",
          "trophy_tilt": "toss"}
SHORT = {"contact_height": "contact height", "contact_side": "contact out to side", "elbow_angle": "elbow at contact",
         "shoulder_width": "shoulders open", "shoulder_coil": "shoulder turn", "hip_coil": "hip turn",
         "separation": "hip-shoulder sep.", "shoulder_tilt": "shoulder tilt", "knee_bend": "knee angle",
         "takeback": "take-back size", "swing_time": "swing time", "wrist_speed": "wrist speed",
         "finish_height": "finish height", "finish_side": "finish out to side", "head_still": "head movement",
         "stance_m": "stance width", "stance_side_m": "stance width", "stance_fwd_m": "stance forward",
         "stance_angle": "stance angle", "reach": "reach", "toss_arm": "toss arm height", "toss_straight": "toss arm straightness",
         "toss_tilt": "toss arm in over head", "trunk_lean": "trunk lean", "hips_over": "hips to hitting side",
         "finish_arm": "finish arm height", "trophy_time": "toss-to-hit time",
         "trophy_tilt": "trophy shoulder tilt", "lean": "lean", "into_court": "into court"}
# hip-shoulder separation needs the hips' turn, and seen from behind the two hip points are close together and
# jittery: it comes out with the hips turned further than the shoulders on backhands, which they aren't
# wrist speed: from behind, the swing's speed toward the net is along the camera's line of sight and unseen, so it
# measures only the wrist's speed across the picture, not how fast he swings
# the elbow's bend: a forearm pointing at the net is foreshortened and looks bent; the stance's length and depth:
# depth on the court is squashed from behind (its angle too, but the camera explains under 2% of it); on backhands the shoulders' opening (the players' order
# hardly repeats from one half of their matches to the other) and the take-back and swing time (the forward
# swing's start is often at the edge of its search)
UNRELIABLE = {"separation", "wrist_speed", "elbow_angle", "stance_m", "stance_fwd_m", "finish_open",
              "takeback_turn"}
# serve lean is trunk lean and hips over the feet together (they explain 94% of it between players), and a forehand's
# finish height and side are mostly the arm's angle at the finish (93% and 78%): the parts are shown instead.
# toss arm height: how high the tossing hand gets mixes how straight the arm is, how far it leans in, how far it
# points toward the net (unseen from behind) and how high the shoulder lifts; toss elbow and toss arm lean instead
# the backhand's stance by its angle rather than its width (the width alone misreads a stance stepping toward the net)
UNRELIABLE_BY = {"backhand": {"shoulder_width", "takeback", "swing_time", "finish_arm", "stance_side_m"},
                 "forehand": {"finish_height", "finish_side", "stance_angle"}, "serve": {"toss_arm", "lean"}}
# the rows of a stroke, phase by phase; a measure not listed goes last
PHASES = {"serve": [["toss_straight", "toss_tilt", "trophy_tilt", "trophy_time"], ["reach", "trunk_lean", "hips_over"]],
          "forehand": [["takeback", "swing_time"], ["contact_side", "shoulder_width", "head_still"],
                       ["finish_arm", "finish_height", "finish_side"]],
          "backhand": [["takeback", "swing_time", "stance_angle"], ["contact_side", "shoulder_width", "head_still"],
                       ["finish_arm", "finish_height", "finish_side"]]}
CAMERA_MAX = 0.10      # a measure is left out when the camera explains this share of a player's stroke-to-stroke spread
BONES = [(1, 2), (1, 3), (3, 5), (2, 4), (4, 6), (1, 7), (2, 8), (7, 8), (7, 9), (9, 11), (8, 10), (10, 12)]
DIRECTIONS = {"CC": "cross-court", "DL": "down the line", "IO": "inside-out", "II": "inside-in", "DM": "down the middle",
              "T": "down the T", "W": "out wide", "B": "into the body"}


def surname(p: str) -> str:
    return p.split()[-1]


def value(v: float, unit: str) -> str:
    if unit == "share":
        return f"{v * 100:.0f}%"
    u = UNIT.get(unit, " " + unit)
    return f"{v:.0f}{u}" if unit == "deg" or abs(v) >= 10 else f"{v:.2f}{u}"


def footage(project: str) -> dict[str, dict]:
    """Per player: matches, minutes of live play (kept video, both ends)."""
    out = defaultdict(lambda: {"matches": set(), "minutes": 0.0})
    for v, spec in PROJECTS[project]["videos"].items():
        k = json.loads((video_dir(f"{project}/{v}") / "kept.json").read_text())
        for p in spec[4]:
            out[p]["matches"].add(match(v))
            out[p]["minutes"] += sum(b - a for a, b in k["pieces"]) / k["fps"] / 60
    return out


@lru_cache(maxsize=None)
def load(project: str) -> tuple[dict, dict]:
    d = ROOT_PROJECTS / project / "profiles"
    res = {k: json.loads((d / f"{k}.json").read_text()) for k in KINDS}
    mv = json.loads((d / "movement.json").read_text()) if (d / "movement.json").exists() else {}
    return res, mv


def kept(project: str, kind: str, phone: bool = False) -> list[str]:
    """The kind's measures shown: not those the TV camera moves much (camera_share, from the pros' footage), and
    with our phone footage (phone) not those rated strongly camera-dependent either."""
    r = load(project)[0][kind]
    share = r.get("camera_share", [0] * len(r["features"]))
    return [n for n, c in zip(r["features"], share)
            if c < CAMERA_MAX and n not in UNRELIABLE | UNRELIABLE_BY.get(kind, set()) and not (phone and SENS.get(n) == "high")]


def tests(project: str, phone: bool = False, every: bool = False) -> list[dict]:
    """Every (kind, measure) as one row: its about, unit, the test (its numbers per player) and the table the
    shown values come from (metres for lengths)."""
    res, mv = load(project)
    rows = []
    for k in KINDS:
        r = res[k]
        for j, n in enumerate(r["features"]):
            if not every and n not in kept(project, k, phone):        # every: the left-out ones too (for figures)
                continue
            unit, about = MEASURES[k][0][n]
            shown = r["test"]
            if n in COURT:                                   # court metres, made body-relative
                unit = "torso"
            rows.append({"kind": k, "name": n, "j": j, "about": about, "unit": unit, "test": r["test"], "shown": shown,
                         "box": r["box"]})
    for table, t in mv.items():
        for j, n in enumerate(t["features"]):
            rows.append({"kind": "movement", "table": table, "name": n, "j": j, "about": t["about"][n],
                         "unit": t["units"][n], "test": t["test"], "shown": t["test"], "box": t["test"]["box"]})
    return rows


# ------------------------------------------------------------------ charts

def strip(row: dict, player: str, w=680, mates=(), ref=None) -> str:
    """Every player's strokes on one measure as a box (the middle half; whiskers 5th to 95th percentile; the tick
    the median), the player in blue, the others grey (`mates`: other players filmed the same way as him, lighter
    blue); the dashed line is the other players' median of medians (`ref`: of these players only)."""
    bx, j = row["box"], row["j"]
    by = {p: v[j] for p, v in bx.items() if np.isfinite(v[j][2])}
    order = sorted(by, key=lambda p: by[p][2])
    lo, hi = min(by[p][0] for p in order), max(by[p][4] for p in order)
    pad = (hi - lo) * 0.06 or 0.1
    lo, hi = lo - pad, hi + pad
    rh, top, left = 22, 8, 100
    h = top + rh * len(order) + 34
    x = lambda v: left + (v - lo) / (hi - lo) * (w - left - 16)                       # noqa: E731
    others = float(np.median([by[p][2] for p in order if p != player and (ref is None or p in ref)]))
    out = [f'<svg viewBox="0 0 {w} {h}" role="img">']
    for q in np.linspace(lo + pad, hi - pad, 5):
        out.append(f'<line x1="{x(q):.1f}" x2="{x(q):.1f}" y1="{top}" y2="{h - 26}" class="grid"/>'
                   f'<text x="{x(q):.1f}" y="{h - 10}" class="tick" text-anchor="middle">{value(q, row["unit"])}</text>')
    out.append(f'<line x1="{x(others):.1f}" x2="{x(others):.1f}" y1="{top}" y2="{h - 26}" class="ref"/>')
    for i, p in enumerate(order):
        y = top + rh * i + rh / 2
        cls = "his" if p == player else "mate" if p in mates else "other"
        p5, q1, med, q3, p95 = by[p]
        name = p.split()[0] if ref is not None and p not in ref else surname(p)     # our own players: first names
        out.append(f'<text x="{left - 10}" y="{y + 4:.1f}" class="row {cls}" text-anchor="end">{name}</text>'
                   f'<line x1="{x(p5):.1f}" x2="{x(p95):.1f}" y1="{y:.1f}" y2="{y:.1f}" class="whisker {cls}"/>'
                   f'<rect x="{x(q1):.1f}" y="{y - 6:.1f}" width="{max(1.0, x(q3) - x(q1)):.1f}" height="12" '
                   f'class="box {cls}"/>'
                   f'<line x1="{x(med):.1f}" x2="{x(med):.1f}" y1="{y - 7:.1f}" y2="{y + 7:.1f}" class="mean {cls}"/>')
    return "".join(out) + "</svg>"


def heat_z(project: str, res: dict, players: list[str], extra: dict | None = None) -> dict:
    """(kind, measure) -> {player: his median minus the others' median, in SDs of a player's own strokes (the
    stroke-to-stroke spread, pooled over the pros): how far apart they are against how much one player varies.
    Our own players (extra: guests) against all the pros, on the measures shown for phone footage."""
    out = {}
    for k in KINDS:
        within = spread(project, k, players)
        phone = set(kept(project, k, phone=True))
        for j, n in enumerate(res[k]["features"]):
            med = {q: res[k]["box"][q][j][2] for q in players if q in res[k]["box"] and np.isfinite(res[k]["box"][q][j][2])}
            out[k, n] = {q: (v - np.median([u for o, u in med.items() if o != q])) / within[j] for q, v in med.items()}
            for q, v in guest_medians(extra or {}, k, n).items():
                if n in phone and med:
                    out[k, n][q] = (v - np.median(list(med.values()))) / within[j]
    return out


def spread(project: str, k: str, players: list[str]) -> np.ndarray:
    """Per measure of kind k: the SD of one player's strokes about his own median, pooled over the players."""
    z = np.load(ROOT_PROJECTS / project / "profiles" / f"{k}_strokes.npz")
    f, pl = z["f"], z["player"]
    return np.sqrt(np.nanmean(np.stack([np.nanvar(f[pl == q], 0) for q in players if (pl == q).any()]), 0))


def guest_medians(extra: dict, k: str, n: str) -> dict[str, float]:
    """Our own players' medians on measure n of kind k (extra: guests)."""
    out = {}
    for q, (_, gres) in extra.items():
        g = gres[k]
        if n in g["features"] and q in g["box"] and np.isfinite(g["box"][q][g["features"].index(n)][2]):
            out[q] = g["box"][q][g["features"].index(n)][2]
    return out


def label_of(q: str, extra: dict | None = None) -> str:
    """A pro by surname, one of ours by first name."""
    return q.split()[0] if q in (extra or {}) else surname(q)


def heatmap(project: str, players: list[str], extra: dict | None = None) -> tuple[str, list[str], list[tuple[str, str]]]:
    """Measures down (grouped by stroke), players across: colour his median against the others' (red higher, blue
    lower). Players along the squares' main pattern (first singular vector, all strokes together), so alike players
    sit together, and our own (extra) last; measures within a stroke phase by phase (PHASES)."""
    res, _ = load(project)
    extra = extra or {}
    zs = heat_z(project, res, players, extra)
    rows = [(k, n) for k in KINDS for n in kept(project, k)]
    _, _, vt = np.linalg.svd(np.nan_to_num(np.array([[zs[r].get(q, np.nan) for q in players] for r in rows])),
                             full_matrices=False)
    n_pros = len(players)
    players = [players[i] for i in np.argsort(vt[0])] + list(extra)
    cw, rh, left, top, gap = 22, 22, 150, 72, 26      # square cells; names written upward
    split = 18 if extra else 0                        # a gutter between the pros and our own players, a divider in it

    def cx(c: int) -> float:
        return left + c * cw + (split if c >= n_pros else 0)
    groups = {}
    for k in KINDS:
        names = kept(project, k)
        gs = [[n for n in g if n in names] for g in PHASES.get(k, [])]
        rest = [n for n in names if not any(n in g for g in gs)]
        groups[k] = [g for g in gs + [rest] if g]
    n_rows = sum(len(kept(project, k)) for k in KINDS)
    order = []
    grid_h = rh * n_rows + gap * (len(KINDS) - 1)
    w, h = cx(len(players)) + 4, top + grid_h + (GROUPS_H if extra else 0) + LEGEND_H + 8
    out = [f'<svg class="heat" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img">']
    for c, p in enumerate(players):
        x = cx(c) + cw / 2
        out.append(f'<text transform="translate({x + 4:.0f},{top - 6}) rotate(-90)" class="tick" '
                   f'data-p="{label_of(p, extra)}">{label_of(p, extra)}</text>')
    y = top - gap + 4                  # the first stroke's name sits beside the players' names, its squares right under them
    for k in KINDS:
        y += gap
        out.append(f'<text x="0" y="{y - 6}" class="kindlab">{k.capitalize()}</text>')
        for n in (n for ns in groups[k] for n in ns):
            order.append((k, n))
            out.append(f'<g class="hr" data-k="{k}" data-n="{n}"><rect class="band" x="0" y="{y}" width="{w}" '
                       f'height="{rh}"/><text x="{left - 10}" y="{y + rh / 2 + 3.5:.1f}" class="hrow" '
                       f'text-anchor="end">{SHORT.get(n, n)}</text>')
            for c, p in enumerate(players):
                if p not in zs[k, n]:
                    continue
                z = zs[k, n][p]
                a = min(abs(z) / 1.5, 1)
                col = f"rgba(220,38,38,{a:.2f})" if z > 0 else f"rgba(37,99,235,{a:.2f})"
                out.append(f'<rect class="cell" data-p="{label_of(p, extra)}" x="{cx(c) + 1}" y="{y + 1}" '
                           f'width="{cw - 2}" height="{rh - 2}" rx="2" fill="{col}"><title>{label_of(p, extra)}, {k} {SHORT.get(n, n)}: {z:+.1f} SD of a player\'s strokes</title></rect>')
            out.append("</g>")
            y += rh
    if extra:                          # the divider last, over the highlighted row's band; then whose columns are whose
        xd = cx(n_pros) - 4 - split / 2 + 4
        out.append(f'<line class="divider" x1="{xd}" x2="{xd}" y1="0" y2="{top + grid_h + 4}"/>')
        yb = y + 14
        for a, b, name, anchor in [(0, n_pros, "Pros", "middle"), (n_pros, len(players), "Amateurs", "end")]:
            x1, x2 = cx(a) + 1, cx(b - 1) + cw - 1
            tx = (x1 + x2) / 2 if anchor == "middle" else x2
            out.append(f'<path class="bracket" d="M{x1} {yb - 6}V{yb}H{x2}V{yb - 6}"/>'
                       f'<text x="{tx:.0f}" y="{yb + 16}" class="grouplab" text-anchor="{anchor}">{name}</text>')
    out.append(legend(left, y + 18 + (GROUPS_H if extra else 0), cw))
    return "".join(out) + "</svg>", players, order


LEGEND_H = 90
GROUPS_H = 34          # room under the squares for the pros / ours brackets


def legend(x: float, y: float, cw: float) -> str:
    """The colour key under the squares: z from -1.5 or less to 1.5 or more (full colour), and what z is."""
    zs = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]
    out = []
    for i, z in enumerate(zs):
        a = min(abs(z) / 1.5, 1)
        col = f"rgba(220,38,38,{a:.2f})" if z > 0 else f"rgba(37,99,235,{a:.2f})"
        lab = {-1.5: "≤ −1.5", -1: "−1", -0.5: "−0.5", 0: "0", 0.5: "+0.5", 1: "+1", 1.5: "≥ +1.5"}[z]
        cx = x + i * cw * 1.5
        out.append(f'<rect x="{cx:.0f}" y="{y}" width="{cw - 2}" height="{cw - 2}" rx="2" fill="{col}" '
                   f'stroke="var(--line)" stroke-width="{1 if z == 0 else 0}"/>'
                   f'<text x="{cx + (cw - 2) / 2:.0f}" y="{y + cw + 12}" class="tick" text-anchor="middle">{lab}</text>')
    out.append(f'<text x="0" y="{y + 14}" class="hrow">z score</text>'
               f'<text x="0" y="{y + cw + 34}" class="hrow" id="zdef">z: his median minus the others\', in units of how</text>'
               f'<text x="0" y="{y + cw + 50}" class="hrow">much one player\'s strokes vary from stroke to stroke</text>')
    return "".join(out)


# ------------------------------------------------------------------ guests: our own phone sessions

# how much each measure depends on where the camera is, both cameras behind the court: the phone lower and closer
# than TV. low: on the court surface (mapped through its lines) or a timing; medium: left-right in the picture
# (in torso lengths, which a camera looking down shortens); high: up-down in the picture (height mixes with depth
# toward the net) or an angle in the picture (an arm toward the net foreshortens differently from each height)
SENS = {"stance_m": "low", "stance_side_m": "low", "stance_fwd_m": "low", "stance_angle": "low", "swing_time": "low",
        "trophy_time": "low", "into_court": "low",
        "contact_side": "medium", "takeback": "medium", "finish_side": "medium", "shoulder_width": "medium",
        "shoulder_coil": "medium", "hip_coil": "medium", "separation": "medium", "head_still": "medium",
        "lean": "medium",
        "contact_height": "high", "finish_height": "high", "reach": "high", "toss_arm": "high", "elbow_angle": "high", "toss_straight": "high",
        "knee_bend": "high", "shoulder_tilt": "high", "trophy_tilt": "high", "wrist_speed": "high"}
SENS_TEXT = {"low": "barely depends on the camera", "medium": "somewhat camera-dependent",
             "high": "strongly camera-dependent: a hint only"}


def guest_projects(project: str) -> list[str]:
    return [g for g, p in PROJECTS.items() if p.get("compare_with") == project
            and (ROOT_PROJECTS / g / "profiles" / "forehand.json").exists()]


UNSURE: set[str] = set()   # players whose labels can't be trusted (Paul's chosen strokes checked by eye: all him)
RANKS = {0: "the highest", 1: "the second highest", -1: "the lowest", -2: "the second lowest"}


def guests(project: str) -> dict[str, tuple[str, dict]]:
    """Each player of the projects compared with this one: (his project, its profiles per kind)."""
    out = {}
    for g in guest_projects(project):
        gres = {k: json.loads((ROOT_PROJECTS / g / "profiles" / f"{k}.json").read_text()) for k in KINDS}
        for p in PROJECTS[g]["players"]:
            if any(p in gres[k]["strokes"] for k in KINDS):
                out[p] = (g, gres)
    return out


def boxes(project: str, row: dict, extra: dict) -> dict:
    """The row's boxes per player, indexed like the row (box[player][j]): the pros', plus our own players'."""
    bx = {q: row["box"][q] for q in PROJECTS[project]["players"] if q in row["box"]}
    for p, (g, gres) in extra.items():
        gr = gres.get(row["kind"])
        if gr and row["name"] in gr["features"] and p in gr["box"]:
            bx[p] = [[np.nan] * 5] * row["j"] + [gr["box"][p][gr["features"].index(row["name"])]]
    return bx


def extreme(project: str, row: dict, bx: dict, p: str) -> dict | None:
    """Where p's median ranks among the pros' (and his, if he isn't one): the highest or second highest, the lowest
    or second lowest; None otherwise."""
    j, pros = row["j"], [q for q in PROJECTS[project]["players"] if q in bx]
    if p not in bx or not np.isfinite(bx[p][j][2]):
        return None
    med = {q: bx[q][j][2] for q in dict.fromkeys(pros + [p])}
    order = sorted(med, key=lambda q: -med[q])
    i = order.index(p)
    rank = i if i < 2 else i - len(order) if i >= len(order) - 2 else None
    if rank is None:
        return None
    others = {q: med[q] for q in pros if q != p}
    return {**row, "player": p, "rank": rank, "his": med[p], "pros": float(np.median(list(others.values()))),
            "pm": others, "of": len(order)}


def extremes(project: str, p: str, extra: dict) -> list[dict]:
    return [f for row in tests(project, bool(extra)) if (f := extreme(project, row, boxes(project, row, extra), p))]


def typical_pair(project: str, f: dict, extra: dict) -> tuple[dict, dict] | None:
    """A typical stroke of his (nearest his median, picture quality at least his median) and a typical pro's: the
    pro whose median is nearest the other pros' (not him, not one who plays with the other hand, not UNSURE), his
    stroke nearest it, hit from about the same place."""
    p, j = f["player"], f["j"]
    his_project = extra[p][0] if p in extra else project
    hs, _, _ = strokes(his_project, f["kind"])
    ps, _, _ = strokes(project, f["kind"])
    mine = np.flatnonzero((hs["player"] == p) & np.isfinite(hs["f"][:, j]))
    if not len(mine):
        return None
    mine = mine[hs["quality"][mine] >= np.median(hs["quality"][mine])]
    a = mine[int(np.argmin(abs(hs["f"][mine, j] - f["his"])))]
    cand = [q for q in f["pm"] if q not in UNSURE and lefty(q) == lefty(p)] or list(f["pm"])
    who = min(cand, key=lambda q: abs(f["pm"][q] - f["pros"]))
    sel = (ps["player"] == who) & (ps["quality"] >= np.median(ps["quality"][ps["player"] == who]))
    if f["kind"] != "serve":
        sel &= ps["ctx"][:, 2] <= np.quantile(ps["ctx"][:, 2], 0.6)
    near = np.flatnonzero(sel)
    if not len(near):
        return None
    near = near[np.argsort(abs(ps["f"][near, j] - f["pm"][who]))[:max(5, len(near) // 5)]]
    b = near[int(np.argmin(abs(ps["ctx"][near, 0] - hs["ctx"][a, 0]) + abs(ps["ctx"][near, 1] - hs["ctx"][a, 1])))]
    mine_s, pro_s = stroke(his_project, f, int(a)), stroke(project, f, int(b))
    mine_s["project"], pro_s["project"] = his_project, project
    if mine_s["hz"] != pro_s["hz"]:                 # his skeleton onto the pros' time grid (phone 30 fps, TV grid 60)
        old = np.arange(mine_s["pose"].shape[0]) / mine_s["hz"]
        new = np.arange(pro_s["pose"].shape[0]) / pro_s["hz"]
        q = mine_s["pose"].reshape(len(old), -1)
        mine_s["pose"] = np.stack([np.interp(new, old, q[:, c], left=np.nan, right=np.nan) for c in range(q.shape[1])],
                                  1).reshape(len(new), *mine_s["pose"].shape[1:])
        mine_s["hz"] = pro_s["hz"]
    return mine_s, pro_s


def clip(out_dir, f: dict):
    return out_dir / f"x_{f['player'].replace(' ', '_').lower()}_{f['kind']}_{f['name']}.mp4"


def extreme_videos(project: str, players: list[str], extra: dict, out_dir) -> None:
    """His typical stroke next to a typical pro's, for every stroke measure where he is extreme."""
    jobs = []
    for p in players:
        for f in extremes(project, p, extra):
            if f["kind"] == "movement" or clip(out_dir, f).exists():
                continue
            pr = typical_pair(project, f, extra)
            if pr:
                title = p.split()[0] if p in extra else surname(p)
                jobs.append((pr, f["name"], pr[0]["moment"], clip(out_dir, f), -0.9 if f["kind"] == "serve" else -0.6,
                             (title, f"{surname(pr[1]['label'].split(',')[0])} (typical pro)")))
    print(len(jobs), "videos", flush=True)
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(lambda j: render(project, j[0][0], j[0][1], j[1], j[2], j[3], t0=j[4], titles=j[5]), jobs))


# ------------------------------------------------------------------ videos

@lru_cache(maxsize=None)
def strokes(project: str, kind: str):
    d = ROOT_PROJECTS / project
    s = dict(np.load(d / "profiles" / f"{kind}_strokes.npz", allow_pickle=True))
    meta = json.loads((d / "technique" / kind / "hits.json").read_text())
    pose = np.load(d / "technique" / kind / "hits.npz")["pose"]
    return s, meta, pose


def stroke(project: str, f: dict, i: int) -> dict:
    s, meta, pose = strokes(project, f["kind"])
    m, p = meta[int(s["hit"][i])], pose[int(s["hit"][i])].copy()
    if m["lefty"]:                                     # back to the picture: hits.npz mirrors left-handers
        p = p[:, MIRROR]
        p[..., 0] = -p[..., 0]
    hz = round((p.shape[0] - 1) / (GRID[-1] - GRID[0]))
    zero = int(round(-GRID[0] * hz))
    t = MOMENT.get(f["name"], 0.0)
    phase = {"takeback": "fwd", "shoulder_coil": "coil", "separation": "coil", "hip_coil": "hipcoil"}.get(f["name"])
    if phase and f["kind"] != "serve":           # this stroke's own phase, not a fixed time
        tt = np.round(np.linspace(GRID[0], GRID[-1], len(p)), 4)
        t = float(tt[phases(normalise(p[None]), tt)[phase][0]])
    out = {"video": m["video"], "frame": m["frame"], "pose": p, "hz": hz,
           "label": (f"{m['player'].split()[0]}, phone, {m['video'][:4]}" if PROJECTS[project].get("compare_with") else
                     f"{surname(m['player'])}, {m['video'][:4]} {m['video'][5:].split('_')[0].upper()}"),
           "where": DIRECTIONS.get(m["direction"], ""),
           "value_text": f"{SHORT.get(f['name'], f['name'])}: {value(s['f'][i, f['j']], f['unit'])}"}
    if t == "toss":
        a, b = zero + int(-0.9 * hz), zero + int(-0.1 * hz)
        y = -p[a:b, 5, 1]
        if np.isfinite(y).any():
            k = int(np.nanargmax(y))
            out["peak"], out["peak_pt"], out["peak_head"] = round((a + k - zero) / hz, 4), p[a + k, 5, :2], p[a + k, 0, :2]
        t = out.get("peak", -0.4)
    out["moment"] = t
    out["at"] = p[zero + int(round(t * hz)), :, :2]
    return out


# ------------------------------------------------------------------ page

def pose_at(mp: np.ndarray, win: list, name: str) -> np.ndarray:
    hz = round((len(mp) - 1) / (win[1] - win[0]))
    phase = {"takeback": "fwd", "shoulder_coil": "coil", "separation": "coil", "hip_coil": "hipcoil"}.get(name)
    if phase:                                    # the stroke's own phase (its forward swing's start, its most turned)
        return mp[int(phases(mp[None], np.round(np.linspace(win[0], win[1], len(mp)), 4))[phase][0])]
    t = MOMENT.get(name, 0.0)
    if t == "toss":
        a, b = int(round((-0.9 - win[0]) * hz)), int(round((-0.1 - win[0]) * hz))
        return mp[a + int(np.nanargmax(mp[a:b, 5, 1]))]
    return mp[int(np.clip(round((t - win[0]) * hz), 0, len(mp) - 1))]


def skeletons(project: str, f: dict, extra: dict, w=340, h=280) -> str:
    """His average pose at the measure's moment next to the pros' (the mean of the other pros' means), seen from
    behind, torso units, left-handers mirrored to right-handed; the measurement in orange."""
    res, _ = load(project)
    p, name = f["player"], f["name"]
    r = res[f["kind"]]
    mine_r = extra[p][1][f["kind"]] if p in extra else r
    mine = pose_at(np.array(mine_r["mean_pose"][p]), mine_r["win"], name)
    rest = pose_at(np.nanmean([np.array(r["mean_pose"][q]) for q in f["pm"] if q in r["mean_pose"]], 0),
                   r["win"], name)
    poses = np.stack([rest, mine])
    if f["kind"] == "backhand":                  # measured mirrored (out to the side: +); drawn as hit
        poses[..., 0] = -poses[..., 0]
    pts = poses.reshape(-1, 2)
    lo, hi = np.nanmin(pts, 0), np.nanmax(pts, 0)
    sc = min((w / 2 - 24) / (hi[0] - lo[0]), (h - 70) / (hi[1] - lo[1]))
    who = p.split()[0] if p in extra else surname(p)
    out = [f'<svg viewBox="0 0 {w} {h}" role="img">']
    for q, cls, cx0, lab, v in zip(poses, ("other", "his"), (w / 4, 3 * w / 4),
                                   ("Pros" if p in extra else "Other pros", who), (f["pros"], f["his"])):
        P = lambda a: (cx0 + (a[0] - (lo[0] + hi[0]) / 2) * sc, 22 + (hi[1] - a[1]) * sc)   # noqa: E731,B023
        hip, sh, ank = q[7:9].mean(0), q[1:3].mean(0), q[11:13].mean(0)
        ref = {"contact_side": ("v", hip), "finish_side": ("v", hip), "takeback": ("v", hip), "lean": ("v", ank),
               "contact_height": ("h", hip), "finish_height": ("h", sh), "reach": ("h", ank),
               "toss_arm": ("h", q[0])}.get(name)
        if ref:
            if ref[0] == "v":
                rx = P(ref[1])[0]
                out.append(f'<line x1="{rx:.1f}" x2="{rx:.1f}" y1="14" y2="{h - 48}" class="ref"/>')
            else:
                ry = P(ref[1])[1]
                out.append(f'<line x1="{cx0 - w / 4 + 10:.1f}" x2="{cx0 + w / 4 - 10:.1f}" y1="{ry:.1f}" '
                           f'y2="{ry:.1f}" class="ref"/>')
        hot = {"elbow_angle": [(2, 4), (4, 6)], "shoulder_width": [(1, 2)], "shoulder_coil": [(1, 2)],
               "shoulder_tilt": [(1, 2)], "trophy_tilt": [(1, 2)], "hip_coil": [(7, 8)],
               "separation": [(1, 2), (7, 8)], "toss_straight": [(1, 3), (3, 5)], "toss_tilt": [(1, 3), (3, 5)],
               "knee_bend": [(7, 9), (9, 11), (8, 10), (10, 12)]}.get(name, [])
        for a, b in BONES:
            (x1, y1), (x2, y2) = P(q[a]), P(q[b])
            c = "hot" if (a, b) in hot else cls
            out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" class="bone {c}"/>')
        hx, hy = P(q[0])
        out.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="6" class="headc {"hot" if name == "head_still" else cls}"/>')
        seg = {"contact_side": (q[6], (hip[0], q[6][1])), "finish_side": (q[6], (hip[0], q[6][1])),
               "takeback": (q[6], (hip[0], q[6][1])), "contact_height": (q[6], (q[6][0], hip[1])),
               "finish_height": (q[6], (q[6][0], sh[1])), "reach": (q[6], (q[6][0], ank[1])),
               "toss_arm": (q[5], (q[5][0], q[0][1])), "lean": (sh, (ank[0], sh[1]))}.get(name)
        if seg:
            (ax, ay), (bx, by) = P(seg[0]), P(seg[1])
            out.append(f'<line x1="{ax:.1f}" y1="{ay:.1f}" x2="{bx:.1f}" y2="{by:.1f}" class="bone hot"/>')
        if name in ("wrist_speed", "swing_time"):
            wx, wy = P(q[6])
            out.append(f'<circle cx="{wx:.1f}" cy="{wy:.1f}" r="8" class="headc hot"/>')
        out.append(f'<text x="{cx0:.0f}" y="{h - 26}" class="lab {cls}" text-anchor="middle">{html.escape(lab)}</text>'
                   f'<text x="{cx0:.0f}" y="{h - 8}" class="val" text-anchor="middle">{value(v, f["unit"])}</text>')
    return "".join(out) + "</svg>"


def feet(project: str, f: dict, extra: dict, w=340, h=280) -> str:
    """Stance from above: back foot fixed, his front foot (blue) and the pros' (grey), from the medians of
    stance_side_m and stance_fwd_m (his, and the median of the other pros')."""
    p = f["player"]
    rows = {r["name"]: r for r in tests(project, every=True) if r["kind"] == f["kind"]}
    pt = {}
    for nm in ("stance_side_m", "stance_fwd_m"):
        bx = boxes(project, rows[nm], extra)
        j = rows[nm]["j"]
        pt[nm] = (bx[p][j][2], float(np.median([bx[q][j][2] for q in f["pm"] if q in bx])))
    o, sc = (w * 0.68, h * 0.78), 115                      # px per torso length
    who = p.split()[0] if p in extra else surname(p)
    out = [f'<svg viewBox="0 0 {w} {h}" role="img">',
           f'<line x1="{o[0] - 0.75 * sc:.0f}" x2="{o[0] + 0.2 * sc:.0f}" y1="{o[1]}" y2="{o[1]}" class="ref"/>'
           f'<text x="{o[0] + 0.2 * sc:.0f}" y="{o[1] + 18}" class="lab" text-anchor="end">baseline direction</text>']
    for cls, k, lab in (("other", 1, "Pros" if p in extra else "Other pros"), ("his", 0, who)):
        dx, dy = pt["stance_side_m"][k], pt["stance_fwd_m"][k]
        fx, fy = o[0] - dx * sc, o[1] - dy * sc
        out.append(f'<line x1="{o[0]:.0f}" y1="{o[1]:.0f}" x2="{fx:.0f}" y2="{fy:.0f}" class="leg {cls}"/>'
                   f'<circle cx="{fx:.0f}" cy="{fy:.0f}" r="7" class="foot {cls}"/>'
                   f'<text x="{fx - 12:.0f}" y="{fy + 4:.0f}" class="lab {cls}" text-anchor="end">{html.escape(lab)}</text>')
    out.append(f'<circle cx="{o[0]:.0f}" cy="{o[1]:.0f}" r="7" class="foot back"/>'
               f'<text x="{o[0] + 12:.0f}" y="{o[1] - 8:.0f}" class="lab">back foot</text>'
               f'<text x="{w / 2:.0f}" y="18" class="lab" text-anchor="middle">net ↑</text>')
    return "".join(out) + "</svg>"


def card(project: str, f: dict, bx: dict, extra: dict, out_dir) -> str:
    """One extreme: what is measured, his median against the pros', the boxes, and (strokes) his typical stroke next to
    a typical pro's."""
    p, name, kind = f["player"], f["name"], f["kind"]
    first = p.split()[0] if p in extra else surname(p)
    sens = SENS.get(name, "medium") if p in extra else None
    badge = f' <span class="sens {sens}">{sens}</span>' if sens else ""
    text = (f"{html.escape(f['about'][0].upper() + f['about'][1:])}. {html.escape(first)}: "
            f"<b>{value(f['his'], f['unit'])}</b>, {RANKS[f['rank']]} of {f['of']}; the "
            f"{'pros' if p in extra else 'other pros'}' median <b>{value(f['pros'], f['unit'])}</b>."
            + (f" {SENS_TEXT[sens].capitalize()}." if sens else ""))
    mates = [q for q in extra if q != p and p in extra and extra[q][0] == extra[p][0]]
    figs = (f'<figure><div class="diagram">{strip({**f, "box": bx}, p, mates=mates, ref=PROJECTS[project]["players"])}'
            f'</div></figure>')
    if kind != "movement":
        vid = clip(out_dir, f)
        figs += '<div class="pair">'
        if vid.exists():
            figs += (f'<figure><div class="player"><video src="{vid.name}" loop muted playsinline controls '
                     f'preload="none"></video></div><figcaption>{html.escape(first)}\'s typical stroke (left, near his '
                     f'median) and a typical pro\'s (right, near the pros\' median), slowed down, held at the moment '
                     f'measured.</figcaption></figure>')
        figs += (f'<figure><div class="diagram">{feet(project, f, extra)}</div><figcaption>Median stance from above.'
                 f'</figcaption></figure></div>' if name.startswith("stance") else
                 f'<figure><div class="diagram">{skeletons(project, f, extra)}</div><figcaption>Average pose at the '
                 f'moment measured, seen from behind (left-handers mirrored to right-handed); the measurement in '
                 f'orange.</figcaption></figure></div>')
    return (f'<section class="change"><h3 class="sub-h">{html.escape(kind.capitalize())}: '
            f'{html.escape(SHORT.get(name, name))}{badge}</h3><p>{text}</p>{figs}</section>')


def player_tab(project: str, p: str, extra: dict, foot: dict, res: dict, out_dir) -> str:
    fs = extremes(project, p, extra)
    if p in extra:
        g, gres = extra[p]
        cam = gres["forehand"]["camera"].get(p, {})
        n = ", ".join(f"{gres[k]['strokes'].get(p, 0)} {k}s" for k in KINDS)
        head = (f'<p class="date">Our own phone footage, games only: {n}. The phone sits lower and closer than the TV '
                f'camera, so each measure is tagged with how much the camera changes it.</p>')
        who = p.split()[0]
    else:
        head = (f'<p class="date">{len(foot[p]["matches"])} matches, {foot[p]["minutes"]:.0f} minutes of play; '
                + ", ".join(f"{res[k]['strokes'].get(p, 0)} {k}s" for k in KINDS) + "</p>")
        who = surname(p)
    body = (f'<section class="wrap"><h2>{html.escape(p)}</h2>{head}<p>These are the {len(fs)} measures where '
            f'{html.escape(who)} stands out most {"against the eleven pros" if p in extra else "from the other ten"}. '
            f'Each chart shows every player\'s strokes, and the video puts his typical stroke next to a typical '
            f'pro\'s.</p></section>')
    for kind in KINDS + ["movement"]:
        ks = [f for f in fs if f["kind"] == kind]
        if ks:
            body += f'<section class="wrap"><h2 class="part">{kind.capitalize()}</h2></section>'
            shown = extra if p in extra else {}           # a pro's charts: the pros only
            body += "".join(f'<div class="wrap">{card(project, f, boxes(project, f, shown), extra, out_dir)}</div>'
                            for f in ks)
    return body


def statistics(project: str, extra: dict) -> str:
    """Every measure, every player's box: the raw analysis."""
    pros = PROJECTS[project]["players"]
    body = ('<section class="wrap"><p>Every measure for every player. Each box holds the middle half of his strokes, '
            'the whiskers run from the 5th to the 95th percentile, and the tick is his median. The dashed line is the '
            'pros\' median.'
            + (f' {" and ".join(html.escape(q.split()[0]) for q in extra)} are in '
               '<span style="color:#7aa2f7">blue</span>.' if extra else "") + '</p></section>')
    for kind in KINDS + ["movement"]:
        rows = [r for r in tests(project, bool(extra)) if r["kind"] == kind]
        if not rows:
            continue
        body += f'<section class="wrap"><h2 class="part">{kind.capitalize()}</h2></section>'
        for r in rows:
            sens = SENS.get(r["name"]) if extra and kind != "movement" else None
            badge = f' <span class="sens {sens}">{sens}</span>' if sens else ""
            body += (f'<div class="wrap"><section class="change"><h3 class="sub-h">'
                     f'{html.escape(SHORT.get(r["name"], r["name"]))}{badge}</h3><p class="date">'
                     f'{html.escape(r["about"][0].upper() + r["about"][1:])}.</p><figure><div class="diagram">'
                     f'{strip({**r, "box": boxes(project, r, extra)}, None, mates=list(extra), ref=pros)}'
                     f'</div></figure></section></div>')
    return body


# the write-up around the overview's heatmap: what the pros show above it, what our own strokes show below it
PROS_NOTES = """
<p>A lot of the observations are obvious by eye, but it has been illuminating to quantify differences in each
player's strokes are. Some things I noticed:</p>
<ul class="support">
<li><b>The serve is the most recognizable stroke.</b> Recognizability (as quantified by RMS z, see Statistics) was 1.42
for the serve, 0.67 for the forehand, and 0.57 for the backhand. So the serve was the most recognizable, followed by forehand and
then the two-handed backhand.</li>
<li><b>Tiafoe's serve is by far the most different.</b> His serve RMS z is 2.57, against 1.68 for the next highest
(Djokovic) and 1.42 on average. Almost all of it comes from his trophy shoulder tilt (z = −5.6): for most players,
after the toss, the right shoulder is rotated to the left. For Tiafoe, the right shoulder is still facing rightwards.</li>
<li><b>Shelton has the most distinctive forehand, and Medvedev has the most distinctive backhand.</b> Shelton and
Alcaraz's forehands are the only two forehands that are "Nadal"-like, with the finish arm height being both high and
biased towards the right side of their bodies. In the same way, Medvedev is in a class of his own for his backhand
finish.</li>
<li><b>I'm most perplexed by trunk lean.</b> Disclaimer: I'm not versed in biomechanics and I'm not a coach, but I
expected that a big trunk lean like Shelton's is not great for power generation. How can it be, if the angle of your back
is tilted sideways when you're hitting the ball straight? But it seems like a lot of big servers, including Kyrgios
and Shelton, both have significant trunk leans.</li>
</ul>
"""
# the Statistics tab: how the overview's numbers are computed
METHODS = """
<section class="wrap"><h3>Methods</h3>
<p><b>z score.</b> For each player and measure, the player's median minus the median of the other pros' medians,
divided by the typical stroke-to-stroke standard deviation of a single player on that measure (pooled over the pros).
A z of 1 means the player sits one stroke-to-stroke spread away from the other pros. For Peter and Richard, the
comparison is against the median of all eleven pros.</p>
<p><b>RMS z.</b> For each player and stroke, the root mean square of the player's z scores over that stroke's
measures: square each z, average them, and take the square root. Positive and negative differences count alike. A
stroke's recognizability is its RMS z averaged over the eleven pros.</p>
<p><b>Players.</b> This list only included players with two-handed backhands, as we're already in the low data
regime with 11 players, so I can't say anything about one handers, or backhands as an umbrella.</p>
</section>
"""
OURS_NOTES = """
<h3>My strokes vs pros</h3>
<p>The pros don't all hit the same way, but together they show the range of mechanics that works at the highest
level. If my stroke falls outside that range, it's worth asking why. So I ran a couple recordings of myself and my
close friend Richard playing together through the same pipeline.</p>
<p>For reference, I am ~9 UTR (at least when I competed prior to having two kids). Richard in his prime used to be a 13
UTR and played for Columbia (top 10 in D1 tennis). And the top 10 pros are 16 UTR. At a 1.0 UTR gap, the higher-rated
player is expected to win 8-9 times out of 10. So it's humbling to realize that there are literally SEVEN quantal
levels of difference between myself and the pros. Also, what's not shown in these short snippets is Richard routinely
kicking my ass.</p>
<p>Some insights I gained about my own strokes that I either never noticed before or never could put into words:</p>
<ul class="support">
<li>For my forehand, it appears that 1) my contact is too far out to the side, 2) my shoulders are not open, and 3)
my swing timing, as measured from racquet going forward to contact, varies a lot compared to the pros (SD of 0.15 s, vs. 0.03–0.11 s for the pros). I believe a lot of these are symptoms of not hitting the ball early
enough. Richard, at least for these metrics, has a very good-looking forehand, with most metrics within professional
bounds (except for take-back size). In fact, his timing varies the least of anyone, pros included (SD of 0.02 s). This could be
because he's hitting against the balls I give him.</li>
<li>For my backhand, I have the same issue of hitting the ball too far away from me. This also applies to Richard (0.67 torso widths to the side, vs. 0.56 for me and 0.23–0.49 for the pros). Among
the pros, backhands hit further from the body are more often unforced errors, so this may be worth correcting.</li>
<li>For my serve, my trunk lean (31°) is larger than any of the pros', including Alcaraz (27.6°) and Shelton
(27.5°).</li>
<li>Despite these problems, I was curious whose strokes ours looked more similar to in mechanics. For the serve,
Rublev for both of us; for the forehand, Fritz for me and Kyrgios for Richard; for the backhand, Djokovic for me and
Tiafoe for Richard.</li>
</ul>
"""


def page(out_dir, slug: str, body: str) -> None:
    (out_dir / "index.html").write_text(PAGE.replace("{{TITLE}}", tennis.title(slug))
                                        .replace("{{BODY}}", tennis.nav(slug) + body)
                                        .replace("{{CSS}}", movement_report.CSS + tennis.CSS + explainer.CSS))
    print(out_dir / "index.html")


def tabs_html(tabs: list[tuple[str, str, str]]) -> str:
    return (f'<nav class="wrap cats" role="tablist">'
            f'{"".join(f"<button role=tab data-cat={k}>{t}</button>" for k, t, _ in tabs)}</nav>'
            + "".join(f'<div class="cat" id="{k}" role="tabpanel">{b}</div>' for k, _, b in tabs))


def report(project: str, make_videos: bool = True) -> None:
    """Top pros: the eleven players against each other."""
    out_dir = ROOT_PROJECTS / project / "review" / "profiles"
    out_dir.mkdir(parents=True, exist_ok=True)
    res, mv = load(project)
    foot = footage(project)
    players = sorted(PROJECTS[project]["players"], key=surname)
    found = {k: Counter(m["player"] for m in json.loads((ROOT_PROJECTS / project / "technique" / k / "hits.json")
                                                         .read_text())) for k in KINDS}
    extra = guests(project)
    clips = explainer.videos(project, players, out_dir, make_videos, extra)
    rows = "".join(f"<tr><td>{p}</td><td class=n>{len(foot[p]['matches'])}</td><td class=n>{foot[p]['minutes']:.0f}</td>"
                   + "".join(f"<td class=n>{found[k][p]} ({res[k]['strokes'].get(p, 0)})</td>" for k in KINDS)
                   + "</tr>" for p in players)
    svg, cols, order = heatmap(project, players, extra)
    over = (f'<section class="wrap"><p>We fingerprinted {len(players)} popular ATP players from Australian Open and US Open '
            f'broadcasts, measuring the mechanics of their forehand, backhand, and serve. Each column is a player and each '
            f'row a measurement. <span style="color:var(--red)">Red</span> means more than the other pros on that row, '
            f'<span style="color:var(--blue)">blue</span> less. Neither is better.</p>{PROS_NOTES}</section>'
            f'<div class="heatwrap"><div class="scroll">{svg}</div>{explainer.panel(project, cols, order, clips, extra)}</div>'
            + (f'<section class="wrap ours">{OURS_NOTES}</section>' if extra else ""))
    footage_html = (METHODS + f'<section class="wrap"><h3>Footage</h3><div style="overflow-x:auto"><table><thead><tr><th>Player</th><th class=n>Matches</th>'
            f'<th class=n>Minutes</th><th class=n>Serves</th><th class=n>Forehands</th><th class=n>Backhands</th>'
            f'</tr></thead><tbody>{rows}</tbody></table></div><p class="date">Each cell: strokes detected (strokes analysed, after '
            f'removing slices, drop shots, shots on the run and shots away from the baseline).</p></section>')
    syllables = []
    if (ROOT_PROJECTS / project / "movement" / "syllables.npz").exists():
        method, explorer = movement_report.section(project, out_dir, make_videos)
        syllables = [("syllables", "Syllables", f'<section class="wrap"><p>Their movement, found without supervision: '
                      f'{" ".join(method)} Colour by player to see whose movement is whose. Click a dot to play it '
                      f'and those around it.</p></section>{explorer}')]
    tabs = [("overview", "Overview", over)] + syllables + [("statistics", "Statistics", footage_html)]
    body = ('<header class="wrap"><h1>Top pros</h1></header>' + tabs_html(tabs))
    page(out_dir, "top-pros", body)


def friends(project: str, make_videos: bool = True) -> None:
    """Myself and friends: our own players (the projects compared with this one) against its eleven."""
    extra = guests(project)
    g = next(iter(extra.values()))[0]
    out_dir = ROOT_PROJECTS / g / "review" / "profiles"
    out_dir.mkdir(parents=True, exist_ok=True)
    res, _ = load(project)
    foot = footage(project)
    if make_videos:
        extreme_videos(project, list(extra), extra, out_dir)
    cats = [(p.split()[0].lower(), p.split()[0], player_tab(project, p, extra, foot, res, out_dir)) for p in extra]
    tabs = cats + [("statistics", "Statistics", statistics(project, extra))]
    body = ('<header class="wrap"><h1>Myself and friends</h1></header>' + tabs_html(tabs))
    page(out_dir, "friends", body)


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg: #fff; --ink: #17171a; --muted: #6a6a72; --faint: #9a9aa2; --line: #e6e5e1; --accent: #c2410c; --blue: #2563eb; --red: #dc2626; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.65 Inter, -apple-system, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding-left: 20px; padding-right: 20px; }
  header { padding-top: 64px; }
  h1 { font-size: clamp(32px, 5vw, 44px); line-height: 1.1; letter-spacing: -.02em; margin: 0 0 16px; }
  h2 { font-size: 28px; margin: 28px 0 4px; } h2.part { font-size: 22px; padding-top: 22px; border-top: 1px solid var(--line); }
  h3 { font-size: 17px; margin: 22px 0 8px; font-weight: 600; } h3.sub-h { font-size: 19px; margin: 0 0 8px; }
  p { margin: 0 0 14px; } .date { color: var(--muted); font-size: 15px; }
  section.change { padding-top: 28px; }
  ul.support { padding-left: 20px; } ul.support li { margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th { text-align: left; font-weight: 500; color: var(--muted); border-bottom: 1px solid var(--line); padding: 6px 8px 6px 0; }
  td { border-bottom: 1px solid var(--line); padding: 7px 8px 7px 0; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  nav.cats { position: sticky; top: 0; z-index: 2; background: var(--bg); display: flex; gap: 6px; flex-wrap: wrap; padding-top: 14px; padding-bottom: 14px; margin-top: 20px; border-bottom: 1px solid var(--line); }
  nav.cats button { font: 500 15px Inter, sans-serif; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 6px 14px; cursor: pointer; }
  nav.cats button[aria-selected="true"] { color: var(--ink); border-color: var(--ink); }
  .cat[hidden] { display: none; }
  .cat { padding-top: 24px; }
  @media (max-width: 640px) { nav.cats { flex-wrap: nowrap; overflow-x: auto; } nav.cats button { flex: none; } }
  .wide { max-width: 1060px; margin: 0 auto; padding: 0 16px; } .wide p { max-width: 760px; }
  .scroll { overflow-x: auto; max-width: 1100px; margin: 0 auto; padding: 0 20px; }
  .scroll svg { display: block; }
  svg.heat { margin: 0 auto; } svg.heat .tick { font-size: 12px; fill: var(--muted); } svg.heat .kindlab { font-size: 13px; } .hrow { font-size: 12px; fill: var(--muted); }
  section.ours { padding-top: 28px; }
  svg.heat .divider { stroke: var(--ink); stroke-width: 1.5; }
  svg.heat .bracket { fill: none; stroke: var(--muted); stroke-width: 1.2; }
  svg.heat .grouplab { font-size: 12.5px; font-weight: 600; fill: var(--ink); }
  figure { margin: 12px 0 0; }
  figcaption { font-size: 13.5px; color: var(--muted); margin-top: 6px; }
  .diagram { border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
  .diagram svg { width: 100%; height: auto; display: block; }
  .player { background: #000; border-radius: 12px; overflow: hidden; aspect-ratio: 886 / 474; }
  .player video { width: 100%; height: 100%; display: block; }
  .pair { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; }
  @media (max-width: 640px) { .pair { grid-template-columns: 1fr; } }
  svg text { font-family: Inter, sans-serif; }
  .grid { stroke: var(--line); } .tick { font-size: 11.5px; fill: var(--faint); } .kindlab { font-size: 13px; fill: var(--muted); font-weight: 600; }
  .ref { stroke: var(--faint); stroke-dasharray: 3 4; }
  .row { font-size: 12.5px; } .row.his { fill: var(--blue); font-weight: 600; } .row.other { fill: var(--muted); }
  .box.his { fill: var(--blue); fill-opacity: .25; stroke: var(--blue); } .box.other { fill: var(--faint); fill-opacity: .25; stroke: var(--faint); }
  .whisker { stroke-width: 1.2; } .whisker.his { stroke: var(--blue); } .whisker.other { stroke: var(--faint); }
  .mean { stroke-width: 2.5; } .mean.his { stroke: var(--blue); } .mean.other { stroke: var(--ink); opacity: .5; }
  .row.mate { fill: #7aa2f7; font-weight: 600; } .box.mate { fill: #7aa2f7; fill-opacity: .2; stroke: #7aa2f7; }
  .whisker.mate { stroke: #7aa2f7; } .mean.mate { stroke: #7aa2f7; }
  .sens { font-size: 12px; font-weight: 500; border-radius: 999px; padding: 1px 8px; margin-left: 6px; vertical-align: 2px; }
  .sens.low { background: #e7f5ec; color: #1e7a43; } .sens.medium { background: #fdf3e1; color: #9a6206; }
  .sens.high { background: #fbe9e4; color: #b3361b; }
  .lab { font-size: 12px; fill: var(--muted); } .lab.his { fill: var(--blue); }
  .val { font-size: 14px; font-weight: 600; fill: var(--ink); }
  .leg { stroke-width: 3; stroke-linecap: round; } .leg.other { stroke: var(--faint); } .leg.his { stroke: var(--blue); }
  .foot.other { fill: var(--faint); } .foot.his { fill: var(--blue); } .foot.back { fill: var(--ink); }
  .bone { stroke-width: 2; stroke-linecap: round; } .bone.other { stroke: var(--faint); } .bone.his { stroke: var(--blue); }
  .bone.hot { stroke-width: 4.5; stroke: var(--accent); }
  .headc { fill: none; stroke-width: 2; } .headc.other { stroke: var(--faint); } .headc.his { stroke: var(--blue); } .headc.hot { stroke: var(--accent); stroke-width: 3; }
  :root { --sunk: #f1f0ec; }
{{CSS}}
</style></head>
<body>{{BODY}}
<footer style="height:80px"></footer>
<script>
  const seen = new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? e.target.play().catch(() => {}) : e.target.pause()),
                                        { threshold: 0.5 });
  document.querySelectorAll("video").forEach(v => seen.observe(v));
  const cats = document.querySelectorAll("nav.cats button");
  function showCat(id) {
    if (!document.getElementById(id)) id = cats[0].dataset.cat;
    cats.forEach(b => b.setAttribute("aria-selected", b.dataset.cat === id));
    document.querySelectorAll(".cat").forEach(c => c.hidden = c.id !== id);
    document.querySelectorAll(".cat[hidden] video").forEach(v => v.pause());
  }

  cats.forEach(b => b.addEventListener("click", () => { history.replaceState(null, "", "#" + b.dataset.cat); showCat(b.dataset.cat); }));
  showCat(location.hash.slice(1));
  addEventListener("hashchange", () => { showCat(location.hash.slice(1)); scrollTo(0, 0); });
</script></body></html>
"""


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--no-videos", action="store_true")
    a = ap.parse_args()
    report(a.project, not a.no_videos)
    friends(a.project, not a.no_videos)
