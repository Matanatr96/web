"""The reference court (TennisCourtDetector's court_reference.py): the 14 points where court lines cross, in the
order of POINTS, in REF units (METRE per metre), near baseline at the bottom; LINES joins them. dsa.gpu.models.Tcd
and dsa.scene.court_snap map detections onto it; dsa.physics.homography draws it."""
from __future__ import annotations

POINTS = [
    "far baseline, left doubles corner", "far baseline, right doubles corner",
    "near baseline, left doubles corner", "near baseline, right doubles corner",
    "left singles sideline at the far baseline", "left singles sideline at the near baseline",
    "right singles sideline at the far baseline", "right singles sideline at the near baseline",
    "far service line at the left singles sideline", "far service line at the right singles sideline",
    "near service line at the left singles sideline", "near service line at the right singles sideline",
    "far T (centre service line meets far service line)", "near T (centre service line meets near service line)",
]
REF = [(286, 561), (1379, 561), (286, 2935), (1379, 2935), (423, 561), (423, 2935), (1242, 561),
       (1242, 2935), (423, 1110), (1242, 1110), (423, 2386), (1242, 2386), (832, 1110), (832, 2386)]
LINES = [(0, 1), (2, 3), (0, 2), (1, 3), (4, 5), (6, 7), (8, 9), (10, 11), (12, 13)]
LEFT, RIGHT, FAR, NEAR, NET, MID = 286, 1379, 561, 2935, 1748, 832
METRE = 1117 / 10.97
