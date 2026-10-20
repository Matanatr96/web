"""Step 7 for a project of many players (atp_hardcourt), the Claude as a Tennis Coach page: how each player's strokes and movement
differ from the other players' (dsa.measure.profiles). An overview heatmap of every player against every measure, with
the explainer beside it (dsa.pages.explainer: a few typical clips per player and stroke to flip through); players of a
project compared with this one ("compare_with": our own phone footage) are set against the pros on it. A Syllables tab
when the project has movement syllables, and a Statistics tab with the methods and footage.

    python -m dsa.measure.profiles atp_hardcourt                  # first
    python -m dsa.pages.profiles_report atp_hardcourt [--no-videos]  -> projects/<project>/review/profiles/
    python -m dsa.pages.serve data/projects/atp_hardcourt/review/profiles 8768
"""
from __future__ import annotations

import argparse
import html
import json
from collections import Counter, defaultdict
from functools import lru_cache

import numpy as np

from dsa.ingest.projects import PROJECTS, match
from dsa.measure.profiles import COURT
from dsa.measure.technique import GRID, MEASURES, MIRROR, normalise, phases
from dsa.pages import explainer, movement_report
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


def guest_projects(project: str) -> list[str]:
    return [g for g, p in PROJECTS.items() if p.get("compare_with") == project
            and (ROOT_PROJECTS / g / "profiles" / "forehand.json").exists()]


UNSURE: set[str] = set()   # players whose labels can't be trusted (Paul's chosen strokes checked by eye: all him)


def guests(project: str) -> dict[str, tuple[str, dict]]:
    """Each player of the projects compared with this one: (his project, its profiles per kind)."""
    out = {}
    for g in guest_projects(project):
        gres = {k: json.loads((ROOT_PROJECTS / g / "profiles" / f"{k}.json").read_text()) for k in KINDS}
        for p in PROJECTS[g]["players"]:
            if any(p in gres[k]["strokes"] for k in KINDS):
                out[p] = (g, gres)
    return out


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
# the overview's opening: what the page asks, and its three parts
INTRO = """
<p>I fed Claude featurized data from 11 professional tennis players, myself, and my semi-pro friend Richard, and asked
it to coach us. With the same data, I also analyzed our strokes myself and compared the two. Turns out Claude's
analysis is vastly better than mine. However, there were a lot of nuances to get right -- read more below.</p>
<h2 class="part">Featurization</h2>
<p>For featurization, I processed raw videos and extracted ball location, court coordinates, labeled strokes (FH, BH,
topspin, slice, serve, etc) and joint data. These were largely done via off-the-shelf open-source models, and some, like ball
tracking, required post-processing.</p>
<p>This data was then processed into a set of "traits". For example, one serve trait is how straight the tossing arm
is, measured by taking the joint angle for tossing arm at the top of the toss.</p>
<p>This part took most of my time -- working with Claude, asking it to sanity check each trait, decomposing them down
into interpretable traits, deleting useless ones, adding interesting ones, etc. This was largely expected, since
designing a clean, useful, interpretable, and comprehensive feature set IS the work. And it's a one-time investment -- once done, I don't have to do it again, and if I have to come back to me, there are already skills and templates. If I were to give Claude
rating, it'd be this:</p>
<ul class="support">
<li><b>Completeness: 4/5.</b> Opus came up with a lot of good candidate traits.</li>
<li><b>Useful: 3/5.</b> It had very poor judgment over how useful or interesting these traits are.</li>
<li><b>Rigor: 2/5.</b> It did not have the common sense to normalize these traits into measures that are generalizable across individuals.
For example, the raw trait it came up with for serve reach was in meters, which failed to normalize for differences in
player height.</li>
<li><b>Interpretable: 2/5.</b> It often proposed traits that were uninterpretable and I had to break these down into atomic, interpretable traits.</li>
</ul>
<h2 class="part">Source of Truth</h2>
<p>Who has the best strokes in the world? Probably those that are the best in the world.</p>
<p>Like most sports, variance in elite biomechanics is enormous. Without incontrovertible evidence to the contrary, it
is probably impossible for a lot of amateur tennis players to conceive that Tiafoe or Meddy's forehands can perform
past USTA 4.5s. Underneath these differences, however, players also share a lot of commonalities in timing, contact
point, head movements, to name a few.</p>
<p>This needs to be quantified, otherwise I wouldn't know whether my strokes are weird but tolerable (i.e. Meddy's fh)
or weird and bad. The goal of deriving a good source of truth is therefore to quantify what it is that pros vary on
and what it is that this conserved.</p>
<p>So I took a diverse set of players (Big Foe, Meddy, Kygs, Bweh, etc), scored their traits, and measured the
variance per trait.</p>
<p>The source of truth is grounded on what pros do -- I specifically chose 11 current players that span the range of
stroke diversity (hello Tiafoe and Meddy lol).</p>
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
<h2 class="part">2. My analysis</h2>
<p>The pros don't all hit the same way, but together they show the range of mechanics that works at the highest
level. If my stroke falls outside that range, it's worth asking why. So I ran a couple recordings of myself and my
close friend Richard playing together through the same pipeline.</p>
<p>For reference, I am ~9 UTR, at least when I competed two years ago prior to having two kids. Richard in his prime
used to be a 13 UTR and played for Columbia, a top 10 D1 tennis school. And the top 10 pros are 16 UTR. For reference,
at a 1.0 UTR gap, the higher-rated player is expected to win 8-9 times out of 10. So there are literally SEVEN freaking
quantal jumps in ability between myself and the pros. For those of you in the bay, this is equivalent to pitting GPT3 against Astra in a decompilation contest. As a corollary, what's also not shown in these short snippets is Richard routinely kicking my ass.</p>
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
# below OURS_NOTES: what Claude, given only the measurements, said to fix
COACH_NOTES = """
<h2 class="part">3. Claude's analysis</h2>
<h3>What Coach Claude Tells Me I Should Do, Verbatim (AI Slop by Definition)</h3>
<p>I then fed all these measurements to Opus 5.5 with a blank context and asked it what I should do. I more or less
agree with every single one of these points, and they are more comprehensive and deeper than what I would've been able
to come up with, despite the writing being ass still. Some of these are known problems that several coaches have
historically pointed out, while others are novel. Opus' TLDR is:</p>
<ol class="support">
<li>For the forehand, widen my stance, get my ass down into an athletic stance, and engage my hips and chest instead
of just my arms through the ball.</li>
<li>For the backhand, use a bent elbow to help with the unit turn, and drive my hips through the ball instead of arming
it up.</li>
<li>For the serve, toss to the right and front more so I lean less to the left.</li>
</ol>
<p>Coach Claude's raw analysis and suggestions for Richard and me below.</p>
<div class="claude"><div class="claude-head"><span class="claude-tag">Claude</span><span class="claude-who"><button data-who="peter" aria-pressed="true">Peter</button><button data-who="richard" aria-pressed="false">Richard</button></span></div>
<div data-for="peter">
<p><b>Forehand: you turn, but you don't rotate through.</b> Your shoulder turn in the take-back is pro-level (105° vs.
the pros' 104°), so the preparation is fine. What happens after it isn't:</p>
<ul class="support">
<li>Shoulders open only 51° at contact, against the pros' 80°: less than all eleven. Your chest is still sideways when
you hit.</li>
<li>Contact is 1.19 torsos out to the side (pros 0.96, all below you), and your stance is 0.63 m wide along the
baseline (pros 0.87 m, all wider). You reach for the ball from a narrow base.</li>
<li>Your take-back is small (0.24 torsos vs. 0.55) but your forward swing is long (0.27 s vs. 0.17 s, slower than all
eleven). A short backswing feeding a long, slow forward swing is guiding the ball, not accelerating through it.</li>
<li><b>Fix:</b> let the chest drive the swing, aiming for it to nearly face the net at contact. Take the racquet back
further during the unit turn so the forward swing can be short and fast. Move your feet so contact is closer to your
body and further in front, and widen your stance so your hips have something to rotate against.</li>
</ul>
<p><b>Backhand: straight arms, swinging up instead of through.</b> Your preparation is early (racquet back 0.6 s
before contact) and your footwork is fine. The problem is the arms:</p>
<ul class="support">
<li>Take-back: arms locked, hands low by the hip, racquet pointing flat at the back fence. It is the biggest take-back
of all twelve (0.76 torsos vs. 0.59). The pros bend their elbows and keep the racquet head up.</li>
<li>Contact: arms still straight (elbow 150° vs. 111°), so the ball is 0.56 torsos out to the side (pros 0.33, all
closer in).</li>
<li>Swing: the racquet head drops low and comes almost straight up, a long path that takes 0.27 s vs. 0.16 s (slower
than all eleven). You finish with arms straight up over your head: the highest and most upright finish of all
twelve. The pros wrap over the right shoulder with bent elbows.</li>
<li><b>Fix:</b> bend the elbows a little in the take-back and keep the racquet head up. Let the ball come closer and
hit it just in front of the front hip. Swing through toward the target and let the racquet wrap over your right
shoulder, not up at the sky.</li>
</ul>
<p><b>Serve: you fall sideways instead of going up and forward.</b></p>
<ul class="support">
<li>Trunk lean at contact is 31° toward the tossing side, the most of all twelve (pros 21°).</li>
<li>Your feet travel 2.1 m into the court through contact, against the pros' 3.1 m: less than all eleven, and barely
camera-dependent.</li>
<li>Your toss arm leans in over your head (16° vs. 9°). The likely cause: the toss drifts over your head, so you bend
sideways to reach it and can't drive forward. Your toss-to-hit timing (0.63 s vs. 0.66 s) is already normal.</li>
<li><b>Fix:</b> toss further in front and slightly to the hitting side, so the ball would land about a metre inside
the baseline if you let it drop, and practise serves where you have to land inside the court.</li>
</ul>
<p><b>In order:</b> forehand rotation and contact point first (the most-used stroke, and where the most measures
agree), then the serve toss (one change should fix both the lean and the lack of drive), then the backhand take-back and finish.
Re-film after a few weeks: shoulders open at contact, contact out to the side, and swing time should all move toward
the pros.</p>
</div>
<div data-for="richard" hidden>
<p>Richard's strokes are the closest to the pros' of the two of us. The forehand barely needs work; the backhand has
the same shape as Peter's, only more so.</p>
<p><b>Forehand: big and loose, a little too long.</b></p>
<ul class="support">
<li>The take-back is the biggest of all twelve (1.02 torsos vs. the pros' 0.55; the biggest pro is 0.74). The hitting
arm goes straight back, well behind the body.</li>
<li>Contact is 1.13 torsos out to the side (pros 0.96, all closer in), from a narrow base: 0.52 m along the baseline
(pros 0.87 m, all wider).</li>
<li>The rest looks like the pros' on video: a full unit turn with the racquet up, a forward swing of 0.20 s (pros
0.17 s), and a finish that wraps low around the body.</li>
<li><b>Fix:</b> nothing structural. Shorten the take-back a little so it holds up against pace, and widen the
stance.</li>
</ul>
<p><b>Backhand: straight arms, reaching, standing up.</b></p>
<ul class="support">
<li>Take-back: arms locked and the racquet pointing flat at the back fence. It is the biggest of all twelve (1.16
torsos vs. 0.59).</li>
<li>Contact: arms still straight (elbow 156° vs. 111°), so the ball is 0.67 torsos out to the side, the furthest of
anyone (pros 0.33).</li>
<li>Feet: the front foot steps almost straight at the net, the feet nearly in line (stance angle 81° vs. 55°, the
most closed of all twelve) and only 0.17 m apart along the baseline (pros 0.57 m). The narrowest base of anyone.</li>
<li>The head moves the most of all twelve around contact (0.42 torsos vs. 0.22): on video you rise up out of the shot.
The finish, over the right shoulder, is fine.</li>
<li><b>Fix:</b> bend the elbows and keep the racquet head up in the take-back, so the ball can come closer. Step a
little more to the side for a wider base, and stay down through contact.</li>
</ul>
<p><b>Serve: a good motion that stays at the baseline.</b></p>
<ul class="support">
<li>Toss to contact takes 0.77 s, the longest of all twelve (pros 0.66 s): the tossing arm stays up a long time while
you wait for the ball.</li>
<li>Your feet travel 2.0 m into the court through contact, against the pros' 3.1 m: less than all eleven, and barely
camera-dependent.</li>
<li>Your toss arm leans in over your head (15° vs. 9°). The knee bend, jump and reach look like the pros' on
video.</li>
<li><b>Fix:</b> toss a little lower and further into the court. The lower toss shortens the wait, and the forward one
pulls you into the court.</li>
</ul>
<p><b>In order:</b> the backhand take-back and base first (four measures outside every pro), then the serve toss,
then the forehand take-back. Re-film after a few weeks: backhand contact out to the side, stance angle, and serve
into-court distance should all move toward the pros.</p>
</div>
</div>
"""


def page(out_dir, title: str, body: str) -> None:
    (out_dir / "index.html").write_text(PAGE.replace("{{TITLE}}", html.escape(title)).replace("{{BODY}}", body)
                                        .replace("{{CSS}}", movement_report.CSS + explainer.CSS))
    print(out_dir / "index.html")


def tabs_html(tabs: list[tuple[str, str, str]]) -> str:
    return (f'<nav class="wrap cats" role="tablist">'
            f'{"".join(f"<button role=tab data-cat={k}>{t}</button>" for k, t, _ in tabs)}</nav>'
            + "".join(f'<div class="cat" id="{k}" role="tabpanel">{b}</div>' for k, _, b in tabs))


def report(project: str, make_videos: bool = True) -> None:
    """Claude as a Tennis Coach: the eleven pros against each other, and our own players against them."""
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
    over = (f'<section class="wrap">{INTRO}<h2 class="part">1. Fingerprinting the pros</h2><p>We fingerprinted {len(players)} popular ATP players from Australian Open and US Open '
            f'broadcasts, measuring the mechanics of their forehand, backhand, and serve. Each column is a player and each '
            f'row a measurement. <span style="color:var(--red)">Red</span> means more than the other pros on that row, '
            f'<span style="color:var(--blue)">blue</span> less. Neither is better.</p>{PROS_NOTES}</section>'
            f'<div class="heatwrap"><div class="scroll">{svg}</div>{explainer.panel(project, cols, order, clips, extra)}</div>'
            + (f'<section class="wrap ours">{OURS_NOTES}{COACH_NOTES}</section>' if extra else ""))
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
    title = "Claude as a Tennis Coach"
    page(out_dir, title, f'<header class="wrap"><h1>{title}</h1></header>' + tabs_html(tabs))


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
  ul.support, ol.support { padding-left: 20px; } ul.support li, ol.support li { margin: 4px 0; }
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
  .claude { background: #fbf1ec; border: 1px solid #f1d9cc; border-left: 3px solid #d97757; border-radius: 10px;
            padding: 16px 20px 4px; margin: 14px 0 0; font-size: 15px; line-height: 1.6; }
  .claude-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .claude-head .claude-tag { margin-bottom: 0; }
  .claude-who { display: inline-flex; background: #f4e1d6; border-radius: 999px; padding: 3px; }
  .claude-who button { font: 500 13px Inter, sans-serif; color: #9a4a2c; background: transparent; border: 0;
                       border-radius: 999px; padding: 4px 14px; cursor: pointer; }
  .claude-who button[aria-pressed="true"] { background: #fff; color: #17171a; box-shadow: 0 1px 2px rgba(120, 60, 30, .18); }
  .claude-tag { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
                color: #b4532f; margin-bottom: 10px; }
  .claude p, .claude li { color: #2b2320; } .claude b { color: #17171a; } .claude ul.support { margin: 0 0 14px; }
{{CSS}}
</style></head>
<body>{{BODY}}
<footer style="height:80px"></footer>
<script>
  const seen = new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? e.target.play().catch(() => {}) : e.target.pause()),
                                        { threshold: 0.5 });
  document.querySelectorAll("video").forEach(v => seen.observe(v));
  document.querySelectorAll(".claude").forEach(box => box.querySelectorAll("[data-who]").forEach(b =>
    b.addEventListener("click", () => {
      box.querySelectorAll("[data-who]").forEach(x => x.setAttribute("aria-pressed", x === b));
      box.querySelectorAll("[data-for]").forEach(d => d.hidden = d.dataset.for !== b.dataset.who);
    })));
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
