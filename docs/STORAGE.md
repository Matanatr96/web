# Storage

Same folders on the laptop and on Modal, so a file has the same path in both.

- **Laptop:** `data/`, a link to the SSD (`/Volumes/PW_SSD/deep-sports-analysis/data`).
- **Modal:** the `deep-sports` volume, at `/vol`.

```
code/<repo>/                  third-party code (wasb with its weights, tennis_court_detector, f3set, e2e_spot)
models/<model>/               weights (tcd, f3ed, f3set, e2e_spot, vitpose-plus-huge, rfdetr)
datasets/<name>/              public datasets (racketvision, tracknet, coco_wholebody, f3set/videos, …)
raw/                          our own recordings and downloaded match videos (laptop only;
                              raw/<project>/<YouTube id>.mp4: whole uploads of quiz and atp_hardcourt,
                              kept so a window can grow without downloading again; raw/starts/: frames
                              read for where play starts)
archive/                      labels from the old labelling work (laptop only)
projects/<project>/<video>/
    source.mp4                the video
    cuts/                     step 0: shots.json, thumbs
    kept.mp4, kept.json       step 0: the kept frames, and which source frames they are
    raw.npz, strokes/         step 2
    players.json              step 3
    names.json, render.mp4    step 4, then the overlay video
    points/                   quiz: usable rallies (points.json), pairs (pairs.json), their clips, serve/ frames
    test/                     step 2 on the first N seconds (--seconds); never counts as done
projects/<project>/            across a project's videos (federer_usopen, atp_hardcourt):
    shots.json                every hit by a named player (dsa.measure.shots)
    technique/<kind>/         hits.npz, hits.json (extract), analysis.json (analyse)
    movement/                 tracks.npz, points.json, syllables.npz (dsa.measure.syllables), analysis.json
    review/                   the review pages (federer_usopen: technique/index.html, published on offpolicysite)
```

Projects are listed in `dsa/projects.py`: `federer_usopen` (2003–2019), `atp_hardcourt` (players compared
at the Australian and US Opens), `quiz` (the skeleton quiz, 30 matches) and `tests` (five 5-minute clips).
A new project is one entry there.

## Modal rules

- Videos that are already done are skipped before anything starts.
- Code, weights and videos are uploaded once (`dsa.gpu.volume.push`); the image is just pip packages.
- At most 10 GPUs at once (dsa.batch: 8 model runs on L40S, plus up to 2 cuts on T4).
- Every model runs on Modal, never on the laptop: step 0's court check too (`app.py --cuts`).
- Check spend: `modal billing report --for today`.

## Rule

Keep every raw video, public dataset and model; delete only what can be made again.