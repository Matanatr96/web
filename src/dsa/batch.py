"""Every video of a TV project through the whole pipeline, each step starting on a video as soon as the step
before has finished it, so downloads, cuts and GPU runs overlap. What a video still needs is read from its
files, so the batch can be stopped and started again at any time.

  step   runs                                              writes                         at a time
  get    dsa.ingest.download get (YouTube)                 source.mp4                     GET, GET_GAP apart
  slice  dsa.ingest.download get (whole upload on disk)    source.mp4                     SLICE
  cut    modal run src/dsa/gpu/app.py --cuts   (T4)        kept.mp4, kept.json            CUT
  gpu    modal run src/dsa/gpu/app.py          (L40S)      raw.npz, strokes/              GPU
  after  dsa.scene.run, dsa.scene.names,                   players.json, names.json,      AFTER
         dsa.pages.render [--plain] (first PREVIEW s)      render.mp4, render_plain.mp4
  fine   dsa.gpu.fine clip, then app.py --fine (L40S)      fine.npz (projects with "fine")  FINE

A step that fails is tried again once; after that the video is left out (its log says why). Logs per video
and step in logs/batch/<project>/<video>.<step>.log under the data root.

    python -m dsa.batch federer_usopen
"""
from __future__ import annotations

import argparse
import fcntl
import subprocess
import sys
import time
from pathlib import Path

from dsa.gpu import fine
from dsa.ingest.download import upload
from dsa.ingest.projects import PROJECTS
from dsa.paths import ROOT, video_dir

GET, CUT, GPU, AFTER = 1, 2, 8, 2           # at a time; GET one: YouTube blocks bursts (docs/PIPELINE.md); cuts
                                             # count as GPU runs too, so both together stay within the 10-GPU limit
GET_GAP = 90                                 # seconds between download starts
SLICE = 3                                    # cut from a whole upload already on disk, at a time
FINE = 2                                     # step 2b at a time (its GPU runs count toward GPU too)
TRIES, POLL = 2, 15                          # tries per step; seconds between looks
PREVIEW = 60                                 # seconds of each render (full: dsa.pages.render without --seconds)
PY = [sys.executable, "-m"]


def step(spec: str) -> str | None:
    """The next step `spec` needs, or None when it is done."""
    d = video_dir(spec)
    if not (d / "source.mp4").exists():
        return "slice" if upload(spec).exists() else "get"
    if not (d / "kept.json").exists():
        return "cut"
    if not ((d / "raw.npz").exists() and (d / "strokes/strokes.json").exists()):
        return "gpu"
    if not all((d / f).exists() for f in ("players.json", "names.json", "render.mp4", "render_plain.mp4")):
        return "after"
    if PROJECTS[spec.split("/")[0]].get("fine") and not fine.done(d):
        return "fine"
    return None


def command(name: str, spec: str) -> list[str]:
    py = " ".join(PY)
    modal = [str(Path(sys.executable).parent / "modal"), "run", "--detach", APP, "--videos", spec]
    if name in ("get", "slice"):
        return PY + ["dsa.ingest.download", "get", spec]
    if name == "cut":                       # on Modal: the court check is a GPU model, never run on the laptop
        return modal + ["--cuts"]
    if name == "gpu":
        return modal
    if name == "fine":                      # nothing for the GPU when the upload is 25 / 30 fps (fine.json "same")
        return ["sh", "-c", f"{py} dsa.gpu.fine clip {spec} && "
                            f"if [ -f {video_dir(spec)}/fine.mp4 ]; then {' '.join(modal)} --fine; fi"]
    return ["sh", "-c", f"{py} dsa.scene.run {spec} && {py} dsa.scene.names {spec} && "
                        f"{py} dsa.pages.render {spec} --seconds {PREVIEW} && "
                        f"{py} dsa.pages.render {spec} --plain --seconds {PREVIEW}"]


# each step's processes, as pgrep sees them (from this batch or an earlier one: the GPU limit is for all)
APP = "src/dsa/gpu/app.py"
PATTERN = {"get": r"yt_dlp .*youtube\.com", "slice": r"dsa\.ingest\.download get ",
           "cut": r"app\.py --videos \S+ --cuts", "gpu": r"app\.py --videos ",
           "after": r"dsa\.(scene\.run|scene\.names|pages\.render) ",
           "fine": r"(dsa\.gpu\.fine clip|app\.py --videos \S+ --fine)"}


def busy(spec: str) -> bool:
    """Some step is already running on `spec` (left by an earlier batch): never start it twice (a GPU run twice
    is paid twice; two cuts write the same files)."""
    pat = rf"(dsa\.(ingest\.download get|scene\.run|scene\.names|pages\.render|gpu\.fine clip)|app\.py --videos) {spec}( |$)"
    return subprocess.run(["pgrep", "-f", pat], capture_output=True).returncode == 0


def count(name: str) -> int:
    """Processes of this step running now."""
    return len(subprocess.run(["pgrep", "-f", PATTERN[name]], capture_output=True, text=True).stdout.split())


def run(project: str) -> None:
    lock = open(ROOT / "logs/batch" / f"{project}.lock", "w")      # held while this batch runs
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(f"a batch for {project} is already running")
    specs = [f"{project}/{v}" for v in PROJECTS[project]["videos"]]
    limit = {"get": GET, "slice": SLICE, "cut": CUT, "gpu": GPU, "after": AFTER, "fine": FINE}
    logs = ROOT / "logs/batch" / project
    logs.mkdir(parents=True, exist_ok=True)
    running: dict[str, tuple[str, subprocess.Popen]] = {}
    tries: dict[tuple[str, str], int] = {}
    dropped: set[str] = set()
    last, last_get = "", 0.0
    while True:
        for spec, (name, p) in list(running.items()):
            if p.poll() is not None:
                del running[spec]
                if p.returncode or step(spec) == name:
                    print(f"{time.strftime('%H:%M')} {spec} {name} failed ({p.returncode})", flush=True)
                    if tries[(spec, name)] >= TRIES:
                        dropped.add(spec)
                else:
                    print(f"{time.strftime('%H:%M')} {spec} {name} done", flush=True)
        todo = {s: step(s) for s in specs if s not in dropped}
        todo = {s: n for s, n in todo.items() if n}
        if not todo and not running:
            break
        for spec, name in todo.items():
            same = max(sum(n == name for n, _ in running.values()), count(name))
            if spec in running or same >= limit[name] or busy(spec):
                continue
            if name == "get" and time.time() - last_get < GET_GAP:
                continue
            if name == "get":
                last_get = time.time()
            tries[(spec, name)] = tries.get((spec, name), 0) + 1
            log = open(logs / f"{spec.split('/')[1]}.{name}.log", "a")
            running[spec] = (name, subprocess.Popen(command(name, spec), stdout=log, stderr=subprocess.STDOUT))
            print(f"{time.strftime('%H:%M')} {spec} {name} started", flush=True)
        counts = {n: sum(v == n for v in todo.values()) for n in limit}
        now = f"left {counts}, running {len(running)}, dropped {sorted(dropped)}"
        if now != last:
            print(time.strftime("%H:%M"), now, flush=True)
            last = now
        time.sleep(POLL)
    print("all done; dropped:", sorted(dropped), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    run(ap.parse_args().project)
