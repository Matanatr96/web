"""Court physics for line calls, shot speed and scoring (dsa.physics).

  homography           metric court calibration (H0 on the ground, Hr on the ball plane Z = 0.033 m)
  bounce_and_linecall  WASB step=3 ball track, hit vs bounce, sub-frame contact point, 2-sigma calls, depth zones
  ballistics           3D drag flight (Cd 0.55, pure drag by default): speed and net clearance
  scorekeeper          rally-mode streaks and match-mode scoring
"""
from dsa.physics.homography import BALL_R, COURT_M, NET_POSTS_M, Calibration, calibrate, project, reregister, to_court

__all__ = ["BALL_R", "COURT_M", "NET_POSTS_M", "Calibration", "calibrate", "project", "reregister", "to_court"]
