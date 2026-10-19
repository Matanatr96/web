"""The project player's page, styled like the wc3env site: the movement explorer (dsa.pages.movement_report) first, then
how his strokes changed (dsa.measure.technique analyse) in one tab, Then vs Now, each titled with its stroke. Each change has one line of
its numbers then and later, a matched pair of typical strokes (dsa.pages.exemplars, the measurement drawn on), its era
averages and his average early and late stroke; the methods come once, at the end.
-> <data>/projects/<project>/review/technique/ (serve with dsa.pages.serve)

    python -m dsa.pages.technique_report federer_usopen [--no-videos]
"""
from __future__ import annotations

import argparse
import html
import json
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

from dsa.ingest.projects import PROJECTS
from dsa.measure.technique import ERA_NAMES, GRID, HZ, KINDS, era
from dsa.pages import movement_report
from dsa.pages.exemplars import render
from dsa.paths import PROJECTS as ROOT_PROJECTS
from dsa.scene.court import METRE, homography

PAIRS = 3                                     # exemplar pairs per finding
ALPHA, MIN_SD = 0.05, 0.4                     # Holm-adjusted p, and the smallest change (in SD) called a finding
TYPICAL = (0.35, 0.7)                         # exemplars within this many SD of their era's mean (relaxed if few)
EXEMPLAR = {"run": 0.5, "directions": ("CC", "DM", "T", "W", "B")}   # exemplars: calm strokes, these directions
BYLINE = "Peter Wang and Nico Christie · October 2, 2026"
DIRECTIONS = {"CC": "cross-court", "DL": "down the line", "IO": "inside-out", "II": "inside-in", "DM": "down the middle",
              "T": "down the T", "W": "out wide", "B": "into the body"}

# The changes shown, by section: (kind, measure). Each passes every check; the rest either don't, or are what a
# camera behind him can't see well (knee bend, which happens toward the camera; wrist speed, which blurs).
SECTIONS = [
    ("Forehand", [("forehand", "stance_angle"), ("forehand", "contact_side"), ("forehand", "finish_height")]),
    ("Serve", [("serve", "lean")]),
]
NONE: dict[str, str] = {}                     # a section's note when it shows no changes
# one paragraph at the top of each tab: what it is and how to look at it (in the body: the site drops our header)
INTRO = {"syllables": ('<p>We used an <a href="https://doi.org/10.1038/s41592-024-02318-2">unsupervised algorithm</a> borrowed '
                       'from neuroscience to split and cluster Federer\'s movements into short, '
                       'repeated pieces called behavioral "syllables". This was done from his joints alone, with zero '
                       'knowledge of tennis. Some of these syllables correspond to conventional tennis strokes, like the '
                       'serve or discrete parts of forehands and backhands, but others, like "Stroll, head down", '
                       'capture other facets of his on-court behavior.</p>'
                       '<p>Each dot on the map below is one instance of a syllable, and instances are clustered together '
                       'by similarity. Click a dot and drag the circle to see what lives in different parts of the map. '
                       'You can drag its edge and expand to include more instances, or contract it to narrow in. '
                       'Colour by year to see which movements belong to which era.</p>'),
         "then": ('<p>We were also curious whether joints can be used to find meaningful differences in his strokes '
                  'across different epochs of his career. We first labelled his strokes into serves, forehands and '
                  'backhands, and then used a lot of Opus to perform joint analysis. Some of these changes were not '
                  'obvious to us before measuring, such as his forehand stance closing by about 15°. Some other '
                  'examples are shown below.</p>'
                  '<p>With the same data we can measure footwork speed and court coverage, see how his patterns '
                  'shift under pressure, or ask which stroke sequences come before a won or lost point, and do this '
                  'across different players and compare styles. This is just the tip.</p>')}

# measure: (title, its one line from his 2003–07 and 2017–19 averages, how to draw, moment held, label in the video,
#           y axis, unit)
def _side(v: float) -> str:
    return f"{abs(v):.0f} cm {'above' if v >= 0 else 'below'}"


SPEC = {
    "stance_angle": ("Forehand: more closed stance",
                     lambda a, b: f"Feet angle was {a:.0f}° in 2003–07, {b:.0f}° in 2017–19.",
                     "stance_angle", 0.0, "feet at {v:.0f}° to the baseline", "Feet to the baseline (°)", "deg"),
    "finish_height": ("Forehand: higher finish",
                      lambda a, b: f"Height of his hitting wrist was {_side(a)} his shoulders in 2003–07 and {_side(b)} "
                                   f"in 2017–19.",
                      "finish_height", 0.3, "wrist {cm:+.0f} cm against shoulders", "Wrist above shoulders (cm)", "cm"),
    "contact_side": ("Forehand: ball contact further from body",
                     lambda a, b: f"Contact point was {a:.0f} cm from his hip center in 2003–07 and "
                                  f"{'grew' if b > a else 'shrank'} to {b:.0f} cm in 2017–19.",
                     "contact_side", 0.0, "wrist {cm:.0f} cm out from his hips", "Hips to wrist at contact (cm)", "cm"),
    "trophy_time": ("Quicker from toss to contact",
                    lambda a, b: f"Toss to contact took {a:.2f} s in 2003–07 and {b:.2f} s in 2017–19.",
                    "trophy_time", 0.0, "toss hand highest {v:.2f} s before contact", "Toss hand highest to contact (s)",
                    "s"),
    "toss_arm": ("Tossing arm reaches less high",
                 lambda a, b: f"His tossing hand reached {a:.0f} cm above his head in 2003–07 and {b:.0f} cm in "
                              f"2017–19.",
                 "toss_arm", 0.0, "toss hand {cm:.0f} cm above his head", "Toss hand above head (cm)", "cm"),
    "lean": ("Serve: straighter body at contact",
             lambda a, b: f"His shoulders were {a:.0f} cm to the side of his feet at contact in 2003–07 and {b:.0f} cm "
                          f"in 2017–19.",
             "lean", 0.0, "shoulders {cm:.0f} cm left of his feet", "Shoulders left of feet (cm)", "cm"),
    "into_court": ("Follows his serve further into the court",
                   lambda a, b: f"He moved {a:.0f} cm into the court after serving in 2003–07 and {b:.0f} cm in "
                                f"2017–19.",
                   "into_court", 0.4, "{cmv:.0f} cm forward", "Distance into the court (cm)", "cm"),
}
SIGN = {"lean": -1}                           # shown as a positive distance


@lru_cache(maxsize=None)
def load(project: str, kind: str) -> tuple[dict, list, np.ndarray]:
    src = ROOT_PROJECTS / project / "technique" / kind
    return (json.loads((src / "analysis.json").read_text()), json.loads((src / "hits.json").read_text()),
            np.load(src / "hits.npz")["pose"])


def status(r, name) -> dict:
    """Whether a change counts: his per-match means, 2017-19 against 2003-07 by Welch's t-test, Holm-adjusted p
    below ALPHA over all the kind's measures, and at least MIN_SD of his strokes' spread. Opponents: the same test
    on his per-match mean minus his opponent's."""
    rb, i = r["robust"], list(r["features"]).index(name)
    own, vs, sd = rb["own"], rb["vs"], rb["sd"][i]
    ch = own["change"][i] / sd
    return {"ok": bool(own["holm"][i] < ALPHA and abs(ch) >= MIN_SD), "ch": ch, "t": own["t"][i], "df": own["df"][i],
            "p": own["p"][i], "holm": own["holm"][i], "m": own["matches"],
            "his_only": bool(vs["p"][i] < ALPHA and np.sign(vs["change"][i]) == np.sign(ch)), "vs_p": vs["p"][i]}


def values(r, name) -> tuple[float, dict, dict]:
    """(scale, era means, era 95% intervals) in display units: lengths in cm from the court, time in s."""
    unit = SPEC[name][6]
    if name in r["lengths"]:
        src, k = r["scales"]["metres"], 100 * SIGN.get(name, 1)
    else:
        src, k = r["robust"], (100 if unit == "cm" else 1) * SIGN.get(name, 1)
    return k, src["era_means"], src["era_ci"]


def fmt(v: float, unit: str) -> str:
    return {"deg": f"{v:.0f}°", "s": f"{v:.2f} s"}.get(unit, f"{v:.0f} cm")


def stars(p: float) -> str:
    return "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else "n.s."


def chart(his, his_ci, other, other_ci, ylabel, unit, sig, w=340, h=280) -> str:
    """Era means with 95% intervals: Federer solid, his opponents dashed, the key at the top; over his last era,
    the stars of his change since the first (sig); y axis labelled."""
    v = np.array([his, other, *his_ci, *other_ci], float).ravel()
    lo, hi = v.min(), v.max()
    pad = (hi - lo) * 0.12 or 0.1
    lo, hi = lo - pad, hi + pad * 2.2                                # room for the stars
    top = 30                                                         # below the key
    x = lambda k, d=0: 92 + k * (w - 120) / 3 + d                    # noqa: E731
    y = lambda q: top + (hi - q) / (hi - lo) * (h - 40 - top)        # noqa: E731
    mid = (top + h - 40) / 2
    out = [f'<svg viewBox="0 0 {w} {h}" role="img">',
           f'<text x="14" y="{mid:.0f}" class="ylabel" text-anchor="middle" '
           f'transform="rotate(-90 14 {mid:.0f})">{html.escape(ylabel)}</text>',
           '<circle cx="70" cy="12" r="4" class="pt his"/><text x="79" y="16" class="key-t">Federer</text>'
           '<line x1="146" x2="164" y1="12" y2="12" class="line other"/>'
           '<circle cx="155" cy="12" r="4" class="pt other"/><text x="170" y="16" class="key-t">Opponents</text>']
    for q in np.linspace(lo + pad, hi - pad * 2.2, 4):
        label = f"{q:.2f}" if unit == "s" else f"{q:.0f}"
        out.append(f'<line x1="64" x2="{w - 6}" y1="{y(q):.1f}" y2="{y(q):.1f}" class="grid"/>'
                   f'<text x="56" y="{y(q) + 4:.1f}" class="tick" text-anchor="end">{label}</text>')
    for k, e in enumerate(ERA_NAMES):
        out.append(f'<text x="{x(k):.1f}" y="{h - 16}" class="era" text-anchor="middle">{e}</text>')
    for cls, vals, ci, d in (("other", other, other_ci, 6), ("his", his, his_ci, -6)):
        out.append('<polyline class="line %s" points="%s"/>' % (cls, " ".join(f"{x(k, d):.1f},{y(q):.1f}"
                                                                           for k, q in enumerate(vals))))
        for k, q in enumerate(vals):
            out.append(f'<line x1="{x(k, d):.1f}" x2="{x(k, d):.1f}" y1="{y(ci[0][k]):.1f}" y2="{y(ci[1][k]):.1f}" '
                       f'class="err {cls}"/><circle cx="{x(k, d):.1f}" cy="{y(q):.1f}" r="4" class="pt {cls}"/>')
    ys = max(top + 12, y(max(his_ci[1][3], his[3])) - 8)          # his change's stars, over his last era
    out.append(f'<text x="{x(3, -6):.1f}" y="{ys:.1f}" class="stars" text-anchor="middle">{stars(sig)}</text>')
    return "".join(out) + "</svg>"


BONES = [(1, 2), (1, 3), (3, 5), (2, 4), (4, 6), (1, 7), (2, 8), (7, 8), (7, 9), (9, 11), (8, 10), (10, 12)]


def figure(r, name, w=340, h=280) -> tuple[str, str]:
    """His average early and late stroke with the measurement drawn on, and its caption: stick figures seen from
    behind, both feet seen from above, or a timeline."""
    k, means, _ = values(r, name)
    i = list(r["features"]).index(name)
    v0, v3 = means["his"][0][i] * k, means["his"][3][i] * k
    out = [f'<svg viewBox="0 0 {w} {h}" role="img">']
    if name == "stance_angle":
        names = list(r["features"])
        side, fwd = names.index("stance_side_m"), names.index("stance_fwd_m")
        o, sc = (w * 0.68, h * 0.78), 230                       # back foot; px per metre
        out.append(f'<line x1="{o[0] - 0.75 * sc:.0f}" x2="{o[0] + 0.2 * sc:.0f}" y1="{o[1]}" y2="{o[1]}" class="ref"/>'
                   f'<text x="{o[0] + 0.2 * sc:.0f}" y="{o[1] + 18}" class="lab" text-anchor="end">baseline direction</text>')
        for e, cls in ((0, "early"), (3, "late")):
            dx, dy = r["robust"]["era_means"]["his"][e][side], r["robust"]["era_means"]["his"][e][fwd]
            fx, fy = o[0] - dx * sc, o[1] - dy * sc
            out.append(f'<line x1="{o[0]:.0f}" y1="{o[1]:.0f}" x2="{fx:.0f}" y2="{fy:.0f}" class="leg {cls}"/>'
                       f'<circle cx="{fx:.0f}" cy="{fy:.0f}" r="7" class="foot {cls}"/>'
                       f'<text x="{fx - 12:.0f}" y="{fy + 4:.0f}" class="lab {cls}" text-anchor="end">'
                       f'{np.degrees(np.arctan2(dy, dx)):.0f}°</text>')
        out.append(f'<circle cx="{o[0]:.0f}" cy="{o[1]:.0f}" r="7" class="foot back"/>'
                   f'<text x="{o[0] + 12:.0f}" y="{o[1] - 8:.0f}" class="lab">back foot</text>'
                   f'<text x="{w / 2:.0f}" y="18" class="lab" text-anchor="middle">net ↑</text>')
        return "".join(out) + "</svg>", ""
    if name in ("trophy_time", "into_court"):
        unit = SPEC[name][6]
        top = max(v0, v3) * 1.15
        x = lambda v: 40 + v / top * (w - 80)                           # noqa: E731
        what = ("toss hand highest", "contact") if name == "trophy_time" else ("start", "after the serve")
        for row, (e, cls, v) in enumerate(((0, "early", v0), (3, "late", v3))):
            yy = 90 + row * 100
            out.append(f'<text x="40" y="{yy - 22}" class="lab">{ERA_NAMES[e].replace("-", "–")}</text>'
                       f'<line x1="{x(0):.0f}" x2="{x(v):.0f}" y1="{yy}" y2="{yy}" class="leg {cls}"/>'
                       f'<circle cx="{x(0):.0f}" cy="{yy}" r="6" class="foot {cls}"/>'
                       f'<circle cx="{x(v):.0f}" cy="{yy}" r="6" class="foot {cls}"/>'
                       f'<text x="{x(v):.0f}" y="{yy + 26}" class="val" text-anchor="middle">{fmt(v, unit)}</text>')
        out.append(f'<text x="{x(0):.0f}" y="{h - 12}" class="lab" text-anchor="middle">{what[0]}</text>'
                   f'<text x="{x(max(v0, v3)):.0f}" y="{h - 12}" class="lab" text-anchor="middle">{what[1]}</text>')
        cap = ("His average time from the toss hand's highest point to contact." if name == "trophy_time" else
               "How far his feet move toward the net, on average, as he serves.")
        return "".join(out) + "</svg>", cap
    win = r["win"]
    mp = np.array(r["robust"]["mean_pose"]["his"])                      # (eras, T, 13, 2), torso units, y up
    if KINDS[r["kind"]]["flip"]:
        mp[..., 0] = -mp[..., 0]
    if name == "toss_arm":                  # each era at its own toss peak
        lo_, hi_ = int(round((-0.9 - win[0]) * HZ)), int(round((-0.1 - win[0]) * HZ))
        at = [lo_ + int(np.nanargmax(mp[e, lo_:hi_, 5, 1])) for e in (0, 3)]
    else:
        at = [int(round((SPEC[name][3] - win[0]) * HZ))] * 2
    poses = np.stack([mp[0, at[0]], mp[3, at[1]]])
    pts = poses.reshape(-1, 2)
    lo, hi = np.nanmin(pts, 0), np.nanmax(pts, 0)
    sc = min((w / 2 - 24) / (hi[0] - lo[0]), (h - 70) / (hi[1] - lo[1]))
    for p, cls, cx0, v, era_name in zip(poses, ("early", "late"), (w / 4, 3 * w / 4), (v0, v3), ("2003–07", "2017–19")):
        P = lambda q: (cx0 + (q[0] - (lo[0] + hi[0]) / 2) * sc, 22 + (hi[1] - q[1]) * sc)   # noqa: E731
        if name == "contact_side":
            hx = P(p[7:9].mean(0))[0]
            out.append(f'<line x1="{hx:.1f}" x2="{hx:.1f}" y1="14" y2="{h - 48}" class="ref"/>')
        if name == "lean":
            fx = P(p[11:13].mean(0))[0]
            out.append(f'<line x1="{fx:.1f}" x2="{fx:.1f}" y1="14" y2="{h - 48}" class="ref"/>')
        for a, b in BONES:
            (x1, y1), (x2, y2) = P(p[a]), P(p[b])
            out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" class="bone {cls}"/>')
        hx, hy = P(p[0])
        out.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="6" class="headc {cls}"/>')
        hot = {"contact_side": (P(p[6]), (P(p[7:9].mean(0))[0], P(p[6])[1])),
               "finish_height": (P(p[6]), (P(p[6])[0], P(p[1:3].mean(0))[1])),
               "toss_arm": (P(p[5]), (P(p[5])[0], P(p[0])[1])),
               "lean": (P(p[1:3].mean(0)), (P(p[11:13].mean(0))[0], P(p[1:3].mean(0))[1]))}.get(name)
        if hot:
            (ax, ay), (bx, by) = hot
            out.append(f'<line x1="{ax:.1f}" y1="{ay:.1f}" x2="{bx:.1f}" y2="{by:.1f}" class="bone hot"/>')
        if name == "finish_height":
            sy = P(p[1:3].mean(0))[1]
            out.append(f'<line x1="{cx0 - w / 4 + 10:.1f}" x2="{cx0 + w / 4 - 10:.1f}" y1="{sy:.1f}" y2="{sy:.1f}" class="ref"/>')
        out.append(f'<text x="{cx0:.0f}" y="{h - 26}" class="lab" text-anchor="middle">{era_name}</text>'
                   f'<text x="{cx0:.0f}" y="{h - 8}" class="val" text-anchor="middle">'
                   f'{v:{"+" if name == "finish_height" else ""}.0f} cm</text>')
    moment = {"toss_arm": "with the toss hand at its highest", "finish_height": "0.3 s after contact"}.get(name, "at contact")
    return "".join(out) + "</svg>", f"His average pose {moment}, seen from behind, with the measurement in orange."


@lru_cache(maxsize=None)
def _courts(spec: str):
    from dsa.pages import render as video
    return video.load(spec)["court"]


def baseline(project: str, video: str, frame: int, at: np.ndarray) -> list[float] | None:
    """The baseline's direction on screen at image point `at` (his back foot), from the court lines."""
    courts = _courts(f"{project}/{video}")
    c = courts[frame] if courts is not None else None
    m = homography(c) if c is not None else None
    if m is None or not np.isfinite(at).all():
        return None
    g = m @ np.append(at, 1)
    g = g[:2] / g[2]
    e = np.linalg.inv(m) @ np.array([g[0] + METRE / 2, g[1], 1])
    return (e[:2] / e[2] - at).tolist()


def pairs(project, kind, name) -> list[tuple[dict, dict]]:
    """PAIRS matched exemplar pairs: a typical early and a typical late stroke (value near its era's mean, picture
    quality at least the median), calm and in the usual directions (EXEMPLAR), hit from about the same place on
    court, and differing the way the eras do by at least half the era difference; each match used once per side."""
    r, meta, pose = load(project, kind)
    st = r["strokes"]
    i = list(r["features"]).index(name)
    f, q, ctx = np.array(st["features"]), np.array(st["quality"]), np.array(st["context"])
    sd = r["robust"]["sd"][i]
    his_idx = [j for j, m in enumerate(st["index"]) if meta[m]["his"]]
    run = np.quantile(ctx[his_idx, 2], EXEMPLAR["run"]) if ctx[his_idx, 2].any() else np.inf

    def cands(k, tol):
        mu = r["robust"]["era_means"]["his"][k][i]
        return [j for j in his_idx if era(meta[st["index"][j]]["year"]) == k and q[j] >= np.median(q)
                and np.isfinite(f[j, i]) and abs(f[j, i] - mu) <= tol * sd and ctx[j, 2] <= run
                and meta[st["index"][j]]["direction"] in EXEMPLAR["directions"]]

    gap = r["robust"]["era_means"]["his"][3][i] - r["robust"]["era_means"]["his"][0][i]   # pairs must show it
    chosen = []
    for tol in TYPICAL:
        early, late = cands(0, tol), cands(3, tol)
        scored = sorted(
            ((abs(ctx[a, 0] - ctx[b, 0]) + abs(ctx[a, 1] - ctx[b, 1]) + 0.3 * abs(ctx[a, 2] - ctx[b, 2])
              + (0 if meta[st["index"][a]]["direction"] == meta[st["index"][b]]["direction"] else 1.5), a, b)
             for a in early for b in late if (f[b, i] - f[a, i]) * np.sign(gap) >= 0.5 * abs(gap)))
        chosen, used = [], set()
        for _, a, b in scored:
            va, vb = meta[st["index"][a]]["video"], meta[st["index"][b]]["video"]
            if va in used or vb in used:
                continue
            used |= {va, vb}
            chosen.append((a, b))
            if len(chosen) == PAIRS:
                break
        if len(chosen) == PAIRS:
            break
    zero = int(np.flatnonzero(np.isclose(GRID, 0))[0])
    _, _, draw, moment, overlay, _, _ = SPEC[name]
    feet = (11, 12) if KINDS[kind]["front"] == "right" else (12, 11)       # back, front ankle

    def stroke(j):
        m, p = meta[st["index"][j]], pose[st["index"][j]]
        depth = ctx[j, 0]
        where = ("on the baseline" if abs(depth) < 0.05 else
                 f"{abs(depth):.1f} m {'behind' if depth >= 0 else 'inside'} the baseline")
        if m["direction"] in DIRECTIONS:
            where += f", {DIRECTIONS[m['direction']]}"
        v = f[j, i]
        s = {"video": m["video"], "frame": m["frame"], "pose": p, "where": where, "feet": feet,
             "at": p[zero + int(round(moment * HZ)), :, :2],
             "label": f"{m['year']} vs {m['video'][5:].replace('_', ' ').title()}",
             "value_text": overlay.format(v=v, cm=abs(v) * st["metres"][j] * 100, cmv=v * 100)}
        if draw == "stance_angle":
            s["baseline"] = baseline(project, m["video"], m["frame"], p[zero, feet[0], :2])
        if draw in ("toss_arm", "trophy_time"):
            a, b = zero + int(-0.9 * HZ), zero + int(-0.1 * HZ)
            y = -p[a:b, 5, 1]
            if np.isfinite(y).any():
                t = int(np.nanargmax(y))
                s["peak"], s["peak_pt"], s["peak_head"] = round((a + t - zero) / HZ, 4), p[a + t, 5, :2], p[a + t, 0, :2]
        return s

    return [(stroke(a), stroke(b)) for a, b in chosen]


def report(project: str, videos: bool = True) -> None:
    out = ROOT_PROJECTS / project / "review" / "technique"
    out.mkdir(parents=True, exist_ok=True)
    shown = [(kind, n) for _, items in SECTIONS for kind, n in items]
    for kind, n in shown:
        assert status(load(project, kind)[0], n)["ok"], f"{kind} {n} no longer passes the checks"

    if videos:
        jobs = []
        for kind, n in shown:
            t0 = -0.9 if kind == "serve" else -0.6
            for k, (a, b) in enumerate(pairs(project, kind, n)):
                jobs.append((a, b, SPEC[n][2], SPEC[n][3], out / f"{kind}_{n}_{k}.mp4", t0))
        with ThreadPoolExecutor(6) as ex:
            list(ex.map(lambda j: render(project, *j[:5], t0=j[5]), jobs))

    def change(kind, n):
        r = load(project, kind)[0]
        st = status(r, n)
        i = list(r["features"]).index(n)
        title, say, _, _, _, ylabel, unit = SPEC[n]
        k, means, cis = values(r, n)
        his = [m[i] * k for m in means["his"]]
        other = [m[i] * k for m in means["other"]]
        text = say(his[0], his[3])
        tabs = "".join(f'<button role="tab" aria-selected="{"true" if j == 0 else "false"}" '
                       f'data-src="{kind}_{n}_{j}.mp4">Pair {j + 1}</button>'
                       for j in range(PAIRS) if (out / f"{kind}_{n}_{j}.mp4").exists())
        ci = [[[c[i] * k for c in b] for b in cis[w]] for w in ("his", "other")]
        if k < 0:
            ci = [[b[1], b[0]] for b in ci]
        fig, _ = figure(r, n)
        return f"""
<section class="wrap change">
  <h3 class="sub-h">{html.escape(title)}</h3>
  <p>{html.escape(text)}</p>
  <div class="tabs" role="tablist">{tabs}</div>
  <div class="player"><video src="{kind}_{n}_0.mp4" loop muted playsinline controls preload="auto"></video></div>
  <div class="pair">
    <figure><div class="diagram">{chart(his, ci[0], other, ci[1], ylabel, unit, st["holm"])}</div></figure>
    <figure><div class="diagram">{fig}</div></figure>
  </div>
</section>"""

    parts = []                                  # one tab, Then vs Now: each title says its stroke
    for title, items in SECTIONS:
        body = "".join(change(kind, n) for kind, n in items)
        if title in NONE:
            body += f'<section class="wrap" style="padding-top:16px"><p>{html.escape(NONE[title])}</p></section>'
        parts.append(body)

    method, explorer = movement_report.section(project, out, videos)
    counts = {kind: sum(load(project, kind)[0]["counts"]["his"]) for kind in KINDS}
    tabs = {"syllables": "Syllables", "then": "Then vs Now", "methods": "Methods"}   # id: label
    body = f"""
<header class="wrap">
  <p class="date">{BYLINE}</p>
  <h1>Federer</h1>
  <p>Tracking Federer's evolution between 2003 and 2019 through unsupervised and supervised methods.</p>
</header>
<nav class="wrap cats" role="tablist">{"".join(f'<button role="tab" data-cat="{k}">{t}</button>' for k, t in tabs.items())}</nav>
<div class="cat" id="syllables" role="tabpanel"><section class="wrap intro">{INTRO["syllables"]}</section>{explorer}</div>
<div class="cat" id="then" role="tabpanel"><section class="wrap intro">{INTRO["then"]}</section>{"".join(parts)}</div>
<div class="cat" id="methods" role="tabpanel">
<section class="wrap methods">
  <h3>Data</h3>
  <ul class="support">
    <li>TV recordings of {len(PROJECTS[project]["videos"])} of his US Open matches, 2003–2019, some only highlights. We only include live play from the main camera angle, in which Federer is standing on the near end.</li>
    <li>His joints (head, shoulders, elbows, wrists, hips, knees, ankles and feet) were tracked in every frame.</li>
    <li>Every hit was labelled automatically as a serve, forehand or backhand.</li>
    <li>Distances are in centimetres, from the court's known size.</li>
  </ul>
  <h3>Syllables</h3>
  <ul class="support">{"".join(f"<li>{m}</li>" for m in method)}</ul>
  <h3>Then vs Now</h3>
  <ul class="support">
    <li>His {counts['forehand']} forehands and {counts['serve']} serves, typical strokes only: none hit on the run or far from the baseline. His {counts['backhand']} backhands were tested the same way and nothing changed reliably.</li>
    <li>Camera zoom, picture quality, where he stood and how he moved were regressed out before comparing.</li>
    <li>Each match gives one number, his average. 2017–19 is compared with 2003–07 by Welch's t-test, corrected (Holm) for the number of measures. A change is shown when the corrected p is below 0.05 and it is at least 0.4 of the spread between his strokes.</li>
    <li>Charts: each dot is an era's average with its 95% interval; stars mark the corrected p (* below 0.05, ** 0.01, *** 0.001). The grey line is his opponents in the same matches.</li>
  </ul>
</section>
</div>

<footer class="wrap"></footer>"""
    (out / "index.html").write_text(PAGE.replace("{{BODY}}", body).replace("{{CSS}}", movement_report.CSS)
                                    .replace("{{JS}}", ""))
    print("wrote", out / "index.html")


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Federer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #ffffff; --surface: #ffffff; --sunk: #f4f4f3; --ink: #17171a; --muted: #6a6a72; --faint: #9a9aa2;
    --line: #e6e5e1; --accent: #c2410c; --blue: #2563eb;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.65 Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding-left: 20px; padding-right: 20px; }
  header { padding-top: 72px; padding-bottom: 8px; }
  h1 { font-size: clamp(32px, 5vw, 44px); line-height: 1.1; letter-spacing: -.02em; margin: 0 0 16px; font-weight: 700; }
  section { padding-top: 48px; padding-bottom: 8px; }
  section.intro { padding-top: 24px; padding-bottom: 0; }
  section.intro + section.change { padding-top: 32px; }
  h2 { font-size: 24px; letter-spacing: -.01em; margin: 0 0 12px; font-weight: 700; }
  p { margin: 0 0 14px; }
  .date { font-size: 14px; color: var(--muted); margin: 0 0 12px; }
  .part { margin-top: 36px; }
  .part h2 { padding-top: 28px; border-top: 1px solid var(--line); font-size: 30px; margin: 0; }
  h3.sub-h { font-size: 20px; margin: 0 0 10px; font-weight: 600; }
  section.change { padding-top: 40px; }
  ul.support { padding-left: 20px; margin: 0 0 16px; }
  nav.cats { position: sticky; top: 0; z-index: 2; background: var(--bg); display: flex; gap: 6px; flex-wrap: wrap; padding-top: 14px; padding-bottom: 14px; margin-top: 24px; border-bottom: 1px solid var(--line); box-shadow: 0 0 0 100vmax var(--bg); clip-path: inset(0 -100vmax); }
  nav.cats button { font: 500 15px Inter, sans-serif; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 7px 16px; cursor: pointer; }
  nav.cats button:hover { color: var(--ink); }
  nav.cats button[aria-selected="true"] { color: var(--ink); border-color: var(--ink); }
  .cat[hidden] { display: none; }
  ul.support li { margin: 6px 0; }
  .methods { padding-top: 22px; }
  .methods h3 { font-size: 17px; font-weight: 600; margin: 26px 0 6px; }
  @media (max-width: 640px) { nav.cats { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
    nav.cats button { flex: none; } }

  .player { background: #000; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); aspect-ratio: 886 / 474; }
  .player video { width: 100%; height: 100%; display: block; }
  .tabs { display: flex; gap: 6px; margin: 0 0 12px; flex-wrap: wrap; }
  .tabs button { font: 500 14px Inter, sans-serif; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 6px 14px; cursor: pointer; }
  .tabs button:hover { color: var(--ink); }
  .tabs button[aria-selected="true"] { color: var(--ink); background: var(--surface); border-color: var(--ink); }

  figure { margin: 0; }
  .diagram { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .diagram svg { width: 100%; height: auto; display: block; }
  .diagram text { font-family: Inter, sans-serif; }
  figcaption { font-size: 14px; color: var(--muted); margin-top: 8px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 18px; }
  @media (max-width: 640px) { .pair { grid-template-columns: 1fr; } }
  .grid { stroke: var(--line); }
  .tick { font-size: 12px; fill: var(--faint); }
  .era { font-size: 13px; fill: var(--muted); }
  .ylabel { font-size: 12.5px; fill: var(--muted); }
  .line { fill: none; stroke-width: 2; } .line.his { stroke: var(--blue); } .line.other { stroke: var(--faint); stroke-dasharray: 4 4; }
  .key-t { font-size: 12.5px; fill: var(--muted); }
  .stars { font-size: 15px; font-weight: 700; fill: var(--blue); stroke: #fff; stroke-width: 3px; paint-order: stroke; }
  .err { stroke-width: 1.5; } .err.his { stroke: var(--blue); } .err.other { stroke: var(--faint); }
  .pt.his { fill: var(--blue); } .pt.other { fill: var(--faint); }
  .ref { stroke: var(--faint); stroke-dasharray: 3 4; }
  .lab { font-size: 12px; fill: var(--muted); } .lab.late { fill: var(--blue); }
  .val { font-size: 14px; font-weight: 600; fill: var(--ink); }
  .leg { stroke-width: 3; stroke-linecap: round; } .leg.early { stroke: var(--faint); } .leg.late { stroke: var(--blue); }
  .foot.early { fill: var(--faint); } .foot.late { fill: var(--blue); } .foot.back { fill: var(--ink); }
  .bone { stroke-width: 2; stroke-linecap: round; } .bone.early { stroke: var(--faint); } .bone.late { stroke: var(--blue); }
  .bone.hot { stroke-width: 4.5; stroke: var(--accent); }
  .headc { fill: none; stroke-width: 2; } .headc.early { stroke: var(--faint); } .headc.late { stroke: var(--blue); }
{{CSS}}
  footer:empty { display: none; }
  footer { margin: 56px 0 0; padding: 22px 0 60px; border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); }
</style>
</head>
<body>
{{BODY}}
<script>
  // Only the videos on screen play, so the browser isn't decoding all of them at once.
  const seen = new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? e.target.play().catch(() => {}) : e.target.pause()),
                                        { threshold: 0.5 });
  document.querySelectorAll("video").forEach(v => seen.observe(v));
  // Category tabs: one category shown at a time, remembered in the address (#serve).
  const cats = document.querySelectorAll("nav.cats button");
  function showCat(id) {
    if (!document.getElementById(id)) id = cats[0].dataset.cat;
    cats.forEach(b => b.setAttribute("aria-selected", b.dataset.cat === id));
    document.querySelectorAll(".cat").forEach(c => c.hidden = c.id !== id);
    document.querySelectorAll(".cat[hidden] video").forEach(v => v.pause());
  }
  cats.forEach(b => b.addEventListener("click", () => { history.replaceState(null, "", "#" + b.dataset.cat); showCat(b.dataset.cat); }));
  showCat(location.hash.slice(1));
  if (location.hash) addEventListener("load", () => setTimeout(() => scrollTo(0, 0)));   // open on the tab, not past the title
{{JS}}
  document.querySelectorAll("section.change").forEach(s => {
    const v = s.querySelector("video"), tabs = s.querySelectorAll(".tabs button");
    if (!v) return;
    tabs.forEach(b => b.addEventListener("click", () => {
      tabs.forEach(t => t.setAttribute("aria-selected", t === b));
      v.src = b.dataset.src; v.play().catch(() => {});
    }));
  });
</script>
</body>
</html>
"""


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--no-videos", action="store_true")
    a = ap.parse_args()
    report(a.project, not a.no_videos)
