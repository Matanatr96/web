"""The tennis pages as one site: a front page and a bar on every page to go between them.

    python -m dsa.pages.tennis                 # writes data/tennis/ (front page, a link per page)
    python -m dsa.pages.serve data/tennis 8767

Each page stays where its generator writes it (its videos next to it); data/tennis/<slug> is a link to that folder.
"""
from __future__ import annotations

import html
from datetime import date

from dsa.paths import PROJECTS as ROOT_PROJECTS

SITE = ROOT_PROJECTS.parent / "tennis"
# slug, title, folder it links to, one line for the front page (in the bar's order)
PAGES = [("federer", "Federer", ROOT_PROJECTS / "federer_usopen" / "review" / "technique",
          "His strokes, 2003 to 2019, at the US Open."),
         ("top-pros", "Top pros", ROOT_PROJECTS / "atp_hardcourt" / "review" / "profiles",
          "How eleven of today's players differ."),
         ("friends", "Myself and friends", ROOT_PROJECTS / "own" / "review" / "profiles",
          "Stroke analysis against pros.")]

CSS = """
  .site { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; padding-top: 18px; padding-bottom: 6px;
          font-size: 14px; border-bottom: 1px solid var(--line); }
  .site a { color: var(--muted); text-decoration: none; }
  .site a:hover { color: var(--ink); }
  .site .home { font-weight: 600; color: var(--ink); margin-right: 6px; }
  .site .here { color: var(--ink); font-weight: 600; }
"""


DONE = {"federer": "2026-10-02", "top-pros": "2026-11-15", "friends": "2026-11-17"}   # when each was first made


def nav(slug: str | None) -> str:
    """The bar at the top of a page: Tennis and the pages (this one marked)."""
    up = "../" if slug else ""
    links = "".join(f'<a href="{up}{s}/" class="{"here" if s == slug else ""}">{html.escape(t)}</a>'
                    for s, t, _, _ in PAGES)
    home = '<a class="home" href="../">Tennis</a>' if slug else '<span class="home">Tennis</span>'
    return f'<nav class="wrap site">{home}{links}</nav>'


def title(slug: str) -> str:
    return next(t for s, t, _, _ in PAGES if s == slug)


FRONT = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tennis</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg: #ffffff; --ink: #17171a; --muted: #6a6a72; --faint: #9a9aa2; --line: #e6e5e1; --accent: #c2410c; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 Inter, system-ui, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 32px 0 12px; }
  ul.pages { list-style: none; margin: 0; padding: 0; }
  ul.pages li { padding: 3px 0; }
  ul.pages a { display: block; color: var(--ink); text-decoration: none; }
  ul.pages b { font-weight: 600; }
  ul.pages time { display: inline-block; width: 96px; color: var(--faint); font-variant-numeric: tabular-nums; }
  ul.pages a:hover b, ul.pages a:hover span { color: var(--accent); }
  ul.pages span { color: var(--muted); }
{{CSS}}
</style>
</head>
<body>
<main class="wrap"><h1>Tennis</h1><ul class="pages">{{CARDS}}</ul></main>
</body>
</html>
"""


def build() -> None:
    SITE.mkdir(parents=True, exist_ok=True)
    for slug, _, folder, _ in PAGES:
        link = SITE / slug
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(folder.resolve(), target_is_directory=True)
    cards = "".join(f'<li><a href="{s}/"><time>{date.fromisoformat(DONE[s]):%Y.%m.%d}</time><b>{html.escape(t)}</b> '
                    f'<span>— {html.escape(d)}</span></a></li>'
                    for s, t, _, d in sorted(PAGES, key=lambda p: DONE[p[0]], reverse=True))   # newest first
    (SITE / "index.html").write_text(FRONT.replace("{{CSS}}", CSS)
                                     .replace("{{CARDS}}", cards))
    print(SITE / "index.html")


if __name__ == "__main__":
    build()
