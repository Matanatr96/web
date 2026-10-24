"""Modal: the deep-sports volume, mounted at /vol and laid out exactly as dsa.paths (docs/STORAGE.md), and the
image the GPU functions run in. Code and weights are pushed to the volume once and read from there.

    push(["code/wasb", "code/tennis_court_detector", "models/tcd"])     laptop -> volume, only what is missing
    pull("tennis/<match_id>/rallies/0.shots.json")                      volume -> laptop
    python -m dsa.gpu.volume ls tennis
"""
from __future__ import annotations

import sys
from pathlib import Path

import modal

from dsa.paths import ROOT

NAME, VOL = "deep-sports", Path("/vol")
volume = modal.Volume.from_name(NAME, create_if_missing=True)
SKIP = {".git", "__pycache__", ".DS_Store", "annotation-tool"}



def image(*extra: str) -> modal.Image:
    """The project's pinned dependencies (pyproject.toml) plus `extra`, with dsa.paths rooted at /vol."""
    deps = []
    if modal.is_local():
        import tomllib
        deps = tomllib.loads(Path("pyproject.toml").read_text())["project"]["dependencies"]
    img = (modal.Image.debian_slim(python_version="3.11")
           .apt_install("libgl1", "libglib2.0-0", "ffmpeg")
           .uv_pip_install(*deps, *extra))
    gpu = [e for e in extra if e.startswith("onnxruntime-gpu")]
    if gpu:     # rtmlib pulls in the CPU onnxruntime, whose files shadow the GPU one's: RTMW then ran on the CPU
        img = img.run_commands("python -m pip uninstall -y onnxruntime onnxruntime-gpu",
                               f"python -m pip install --no-deps {gpu[0]}")
    return (img
            .env({"DSA_DATA": str(VOL), "RF_HOME": str(VOL / "models/rfdetr"), "HF_HUB_OFFLINE": "1"})
            .add_local_python_source("dsa"))


def listing(rel: str) -> set[str]:
    """Every file under /vol/<rel>, as paths relative to /vol (empty when there is nothing)."""
    try:
        return {e.path.lstrip("/") for e in volume.listdir(rel, recursive=True) if e.type == modal.volume.FileEntryType.FILE}
    except Exception:
        return set()


def push(rels: list[str]) -> list[str]:
    """Upload ROOT/<rel> (a file or a folder) to /vol/<rel>, skipping files already there (by path), SKIP and
    macOS's ._ files."""
    todo = []
    for rel in rels:
        src = ROOT / rel
        if not src.exists():
            raise FileNotFoundError(f"{src} is missing on the laptop (docs/STORAGE.md)")
        files = [src] if src.is_file() else [p for p in src.rglob("*") if p.is_file() and not p.name.startswith("._")
                                             and not SKIP & set(p.relative_to(src).parts)]
        have = listing(rel)
        todo += [str(p.relative_to(ROOT)) for p in files if str(p.relative_to(ROOT)) not in have]
    if todo:
        with volume.batch_upload(force=True) as up:
            for t in todo:
                up.put_file(str(ROOT / t), "/" + t)
    return todo


def pull(rel: str) -> Path:
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as fh:
        for chunk in volume.read_file(rel):
            fh.write(chunk)
    return out


if __name__ == "__main__" and sys.argv[1:2] == ["ls"]:
    for p in sorted(listing(sys.argv[2] if len(sys.argv) > 2 else "")):
        print(p)
