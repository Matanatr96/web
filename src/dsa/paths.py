"""Where everything lives: one layout under one root, the same on the laptop and on Modal (docs/STORAGE.md).

    code/wasb/                      WASB-SBDT with its tennis weights
    code/tennis_court_detector/     TennisCourtDetector's code; its weights in models/tcd/
    tennis/<match_id>/              the tennis-rally app's uploads, tracks, clips and shots (dsa.gpu.rally_api)

Root: DSA_DATA, else data/ on the laptop; /vol (the deep-sports volume) on Modal, where DSA_DATA is set to it.
"""
import os
from pathlib import Path

ROOT = Path(os.environ.get("DSA_DATA", "data"))
CODE, MODELS = ROOT / "code", ROOT / "models"
WASB, TCD = CODE / "wasb", CODE / "tennis_court_detector"
TCD_WEIGHTS = MODELS / "tcd/model_tennis_court_det.pt"
