# Storage

Same folders on the laptop and on Modal, so a file has the same path in both.

- **Laptop:** `data/` (`DSA_DATA` to point elsewhere).
- **Modal:** the `deep-sports` volume, at `/vol`.

```
code/wasb/                      WASB-SBDT (NTT, MIT) with pretrained_weights/wasb_tennis_best.pth.tar
code/tennis_court_detector/     TennisCourtDetector (yastrebksv, MIT): tracknet.py, postprocess.py, homography.py
models/tcd/                     model_tennis_court_det.pt
models/rfdetr/                  RF-DETR's download cache (RF_HOME); filled on first use
models/rtmw/                    RTMW-x (rtmlib's download); filled on first use
tennis/<match_id>/              the tennis-rally app (dsa.gpu.rally_api)
    jobs/<session|rally-n>/     job.json and, while uploading, parts/
    source.mp4|mov              a whole session; uploads/rally-n.* an iOS clip
    frame0.png                  the session's first frame, for per-rally re-registration of the court
    tracks/<n>.npy              the ball track of rally n (segment_match -> process_rally)
    rallies/<n>.mp4             the 720p clip served at GET /clips/<match_id>/<n>.mp4
    rallies/<n>.shots.json      its shots (speeds, calls, depth zones, technique)
```

## Modal rules

- Code and weights are uploaded once (`dsa.gpu.volume.push`); the image is just pip packages.
- Every container does `volume.reload()` on entry and `volume.commit()` before handing off: the volume is the
  only state shared between `web`, `segment_match` and `process_rally`.
- Check spend: `modal billing report --for today`.
