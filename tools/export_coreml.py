"""Alias entry point for `tools/convert_wasb_coreml.py` (CoreML FP16 WASB-SBDT exporter)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert_wasb_coreml import (  # noqa: E402,F401
    DEFAULT_OUT,
    DEFAULT_WASB,
    H,
    MEAN,
    STD,
    W,
    convert,
    load_wasb,
    main,
    model_card,
    wrapper,
)

if __name__ == "__main__":
    main()
