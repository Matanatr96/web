# TennisVision (iOS 17+ / watchOS 10+)

Live on-device rally streaks and line calls (WASB-SBDT on the ANE, `step=3`, all 3 heads). Only trimmed rally clips are saved and uploaded to the Modal `tennis-rally` app. See `implementation_plan.md` §3.3.

| Path | What |
|---|---|
| `CourtGeometry/` | Pure Swift package that only depends on Foundation. `CourtGeometry.swift` covers COURT_M, the DLT H0, the pose and Hr on the Z = 0.033 m plane, hit vs. bounce, sub-frame t*, the 2σ call, and depth zones. `Scorekeeper.swift` covers Rally Mode streaks and Match Mode scoring. `WatchProtocol.swift` holds the Watch message contract. |
| `App/` | iOS app: `TennisVisionApp`, `CameraCaptureManager`, `CourtCalibrationOverlay`, `LiveLineCallerEngine`, `RallySegmentUploader`. |
| `Watch/` | watchOS companion app. |
| `project.yml` | XcodeGen spec. Run `xcodegen generate`. |

```bash
# Geometry, line-call and scorekeeper tests (macOS or Linux; reads ../../tests/fixtures/*.json when present)
cd CourtGeometry && swift test
```

Setup:
1. `Resources/wasb_fp16.mlpackage` comes from `tools/convert_wasb_coreml.py`. Its contract is in `Resources/MODEL_CARD.md`.
2. Create `Config/Secrets.xcconfig` with `MODAL_BASE_URL` and the admin-minted `MODAL_JOB_TOKEN`; see `Config/Base.xcconfig`. Without a token, clips stay on the phone.
