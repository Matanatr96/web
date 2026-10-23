# wasb_fp16.mlpackage

WASB-SBDT (Tarashima et al., "Widely Applicable Strong Baseline for Sports Ball Detection and Tracking",
BMVC 2023; NTT, MIT licence) with its tennis weights `wasb_tennis_best.pth.tar`
(sha256 `9d391239ab10c733f8e5bfadf16ab72838e7a8ebc88e8ae2038501c03d42b4bb`), converted by `tools/convert_wasb_coreml.py`.

| | |
|---|---|
| Inputs | `frame_t0`, `frame_t1`, `frame_t2`: RGB images 512 x 288, oldest first (ImageNet normalisation baked in) |
| Output | `heatmaps`: (1, 3, 288, 512) float16 probabilities (sigmoid baked in); channel k is `frame_tk` |
| Use | step=3: non-overlapping triplets, all 3 heads read; ball = heaviest blob above 0.5, probability-weighted centroid |
| Format | mlprogram, FP16, iOS 17+, intended for the Neural Engine |
| Trained on | TrackNet tennis dataset (broadcast, 1280 x 720); phone footage from behind the court is out of distribution |

Spec: `{"inputs": [["frame_t0", [288, 512]], ["frame_t1", [288, 512]], ["frame_t2", [288, 512]]], "outputs": [["heatmaps", [1, 3, 288, 512]]], "spec_version": 8}`

## Validation (`tools/validate_coreml.py`)

```json
not run yet: `uv run python tools/validate_coreml.py`
```
