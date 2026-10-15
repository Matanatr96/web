"""His movement cut into syllables with keypoint-MoSeq (Weinreb et al., Nature Methods 2024): whole body, all 19
points (nose, shoulders, elbows, wrists, hips, knees, ankles, toes, heels) through every one of his near-end points.

keypoint-MoSeq turns his skeleton into a few numbers per frame (PCA of the pose after centring on the body and
rotating it to face one way), learns a small set of movement patterns ("syllables", each a linear rule for how those
numbers change from one frame to the next) and labels every frame with one. A "stickiness" (KAPPA) sets how long a
syllable typically lasts; it was set so the median syllable lasts about half a second. Joint confidences from the pose
model tell it how much to trust each point.

Runs on one Modal GPU (T4, a few minutes), since keypoint-MoSeq pins its own numpy and jax:

    python -m dsa.measure.syllables federer_usopen
    python -m dsa.measure.syllables federer_usopen lower      hips down only (12 points): his footwork, without the arms

Reads movement/tracks.npz and points.json (dsa.measure.movement extract); writes movement/syllables.npz
(syllables_lower.npz for the hips down):
  point, start, n        his points, and where each starts in the arrays below
  syllable               per frame, numbered by how common (0 the most)
  latent                 per frame, the pose numbers the model works on
"""
from __future__ import annotations

import argparse
import json

import modal
import numpy as np

NAMES = ["nose", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow", "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee",
         "r_knee", "l_ankle", "r_ankle", "l_bigtoe", "l_smalltoe", "l_heel", "r_bigtoe", "r_smalltoe", "r_heel"]
HZ = 30
CONF = 3.0          # pose model scores at or above this count as certain (they run about 0.3 to 10, typically 4)
KAPPA = 1e6         # stickiness while fitting the syllables alone; a tenth of it when fitting the whole model
ITERS_AR, ITERS_FULL = 100, 200
BODY = {"": (NAMES, ["nose"], ["l_hip", "r_hip"], [["l_shoulder", "r_shoulder"], ["l_hip", "r_hip"]]),
        # hips down: facing set by hips over ankles, as the whole body's by nose over hips
        "lower": (NAMES[7:], ["l_hip", "r_hip"], ["l_ankle", "r_ankle"], [["l_hip", "r_hip"]])}
VARIANCE = 0.9      # pose numbers kept: enough for this share of the variance

app = modal.App("dsa-syllables")
IMAGE = (modal.Image.debian_slim(python_version="3.11")
         .uv_pip_install("keypoint-moseq==0.6.6", "jax[cuda12]==0.6.2"))


@app.function(image=IMAGE, gpu="T4", timeout=3 * 3600)        # a small model fit: the cheapest GPU
def fit(coords: dict, confs: dict, seed: int = 0, body: str = "") -> dict:
    """keypoint-MoSeq on his points: per point, the syllable and the pose numbers of every frame."""
    import tempfile

    import keypoint_moseq as kpms

    out = tempfile.mkdtemp()
    coords, confs = ({k: v.astype(np.float64) for k, v in x.items()} for x in (coords, confs))   # sent as float32
    names, front, back, skeleton = BODY[body]
    kpms.setup_project(out, overwrite=True, bodyparts=names, use_bodyparts=names, anterior_bodyparts=front,
                       posterior_bodyparts=back, fps=HZ, skeleton=skeleton)
    kpms.update_config(out, fix_heading=True, seed=seed)
    config = lambda: kpms.load_config(out)                       # noqa: E731
    data, metadata = kpms.format_data(coords, confs, **config())
    pca = kpms.fit_pca(**data, **config())
    kpms.update_config(out, latent_dim=int(np.searchsorted(np.cumsum(pca.explained_variance_ratio_), VARIANCE) + 1))
    model = kpms.init_model(data, pca=pca, **config())
    model = kpms.update_hypparams(model, kappa=KAPPA)
    model, name = kpms.fit_model(model, data, metadata, out, ar_only=True, num_iters=ITERS_AR,
                                 generate_progress_plots=False)
    model = kpms.update_hypparams(model, kappa=KAPPA / 10)
    model = kpms.fit_model(model, data, metadata, out, name, ar_only=False, start_iter=ITERS_AR,
                           num_iters=ITERS_AR + ITERS_FULL, generate_progress_plots=False)[0]
    res = kpms.extract_results(model, metadata, out, name)       # syllables already numbered by how common
    return {k: (np.asarray(r["syllable"]), np.asarray(r["latent_state"])) for k, r in res.items()}


def main(project: str, body: str = "", seed: int = 0) -> None:
    from dsa.ingest.projects import PROJECTS as CATALOG
    from dsa.paths import PROJECTS

    mine = "who" in CATALOG[project]             # a project player: his points only
    listed = set(CATALOG[project].get("players", []))   # a project of many players: theirs, not their opponents'
    d = PROJECTS / project / "movement"
    z = np.load(d / "tracks.npz")
    points = json.loads((d / "points.json").read_text())
    off, pose = np.r_[0, np.cumsum(z["lengths"])], z["pose"]
    coords, confs = {}, {}
    for i, p in enumerate(points):
        a = pose[off[i]:off[i + 1]].astype(float)
        if (mine and not p["his"]) or (listed and p["player"] not in listed) or len(a) < HZ:
            continue
        xy = a[..., :2]               # in his torso lengths x 100 about his hips, so camera zoom doesn't matter
        torso = np.nanmedian(np.linalg.norm(xy[:, 1:3].mean(1) - xy[:, 7:9].mean(1), axis=-1))
        use = [NAMES.index(n) for n in BODY[body][0]]
        coords[f"p{i}"] = ((xy - np.nanmedian(xy[:, 7:9].mean(1), 0)) / torso * 100)[:, use].astype(np.float32)
        confs[f"p{i}"] = np.clip(np.nan_to_num(a[..., 2]) / CONF, 0, 1)[:, use].astype(np.float32)
    print(len(coords), "points,", sum(len(v) for v in coords.values()), "frames", flush=True)
    if not coords:
        raise SystemExit("no points to fit (dsa.measure.movement extract first)")

    with modal.enable_output(), app.run():
        res = fit.remote(coords, confs, seed, body)

    keys = sorted(res, key=lambda k: int(k[1:]))
    syl = [res[k][0] for k in keys]
    n = [len(s) for s in syl]
    np.savez_compressed(d / f"syllables{'_' + body if body else ''}.npz",
                        point=np.array([int(k[1:]) for k in keys]), start=np.r_[0, np.cumsum(n)[:-1]],
                        n=np.array(n), syllable=np.concatenate(syl).astype(np.int16),
                        latent=np.concatenate([res[k][1] for k in keys]).astype(np.float32))
    s = np.concatenate(syl)
    runs = np.concatenate([np.diff(np.r_[0, np.flatnonzero(np.diff(x)) + 1, len(x)]) for x in syl]) / HZ
    share = np.bincount(s) / len(s)
    print(f"{res[keys[0]][1].shape[-1]} pose numbers; syllables lasting median {np.median(runs):.2f} s "
          f"(10-90% {np.percentile(runs, 10):.2f}-{np.percentile(runs, 90):.2f}); "
          f"{(share > 0.005).sum()} used for more than 0.5% of frames")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("body", nargs="?", default="", choices=["", *BODY])
    a = ap.parse_args()
    main(a.project, a.body)
