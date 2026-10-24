# tennis-vision

A phone on the fence records a session; this turns it into rallies with clips, shot speeds, bounce depth, line
calls and the near player's stroke technique, on Modal GPUs, and posts the results to a Next.js webhook
(the `/tennis` pages of Matanatr96/web). The iOS / watchOS recorder is in [ios/](ios/).

```
 upload ──► web()  (CPU)        POST /jobs, PUT parts, POST commit            src/dsa/gpu/rally_api.py
            segment_match (L4)  WASB ball track once, hits / bounces, rallies
            process_rally (L4)  per rally: 720p clip, 3D speed + net clearance, calls,
                                RF-DETR + RTMW-x technique at each near-court hit
            webhook             rally.ready / match.ready -> Postgres (no video leaves the volume)
```

- `dsa.physics`: metric court calibration (ball-plane homography), sub-frame bounces with a covariance, 3D drag
  flight fits, rally / match scoring. Pure numpy; `tests/physics` runs it on synthetic rallies.
- `dsa.measure.technique`: stroke measures from a skeleton window around contact.
- `dsa.gpu.models`: the off-the-shelf models behind small wrappers (nothing here is trained by us): WASB-SBDT
  (ball), TennisCourtDetector (court), RF-DETR (people), RTMW-x (skeletons).

```
uv sync --extra tennis --extra cloud --extra dev
.venv/bin/python -m pytest -q
modal deploy src/dsa/gpu/rally_api.py      # secrets: modal secret create tennis-rally TENNIS_JOB_SECRET=...
                                           #   TENNIS_WEBHOOK_URL=... TENNIS_WEBHOOK_SECRET=...
```

Where files live on the laptop and the volume: [docs/STORAGE.md](docs/STORAGE.md).

## Origin

Forked from Off Policy's [deep-sports-analysis](https://github.com/offpolicyinc/deep-sports-analysis)
([Claude as a Tennis Coach](https://offpolicyinc.com/work/claude-tennis-coach/)), MIT. Their Modal volume /
image plumbing, model wrappers, court snapping, skeleton cleaning and stroke measures are kept; their broadcast
pipeline (camera cuts, F3ED strokes, ByteTrack, player naming, reports) is not.
