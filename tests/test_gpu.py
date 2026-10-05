"""The GPU steps' laptop-side logic, with stand-ins for the models: nothing runs a model here."""
import numpy as np

from dsa.gpu import cuts, strokes


def test_cuts_merge_short_views():
    flags = [False] * 10 + [True] * 2 + [False] * 5 + [True] * 20
    assert cuts.runs(flags, 6) == [[False, 0, 17], [True, 17, 37]]
    assert cuts.runs([True] * 3 + [False] * 20, 6) == [[False, 0, 23]]


def test_kept_pieces_join_adjacent_shots():
    shots = {"shots": [{"label": "keep", "start_frame": 0, "end_frame": 30},
                       {"label": "keep", "start_frame": 30, "end_frame": 50},                # joins the first
                       {"label": "discard", "start_frame": 50, "end_frame": 80},
                       {"label": "keep", "start_frame": 80, "end_frame": 200}]}
    assert cuts.kept_pieces(shots) == [[0, 50], [80, 200]]


def test_strokes_decode_maps_back_to_the_source():
    hit = np.tile([1.0, 0.0], (20, 1)).astype(np.float32)
    hit[7] = [0.1, 0.9]                                                                  # one hit, 2nd piece bin 7
    el = np.zeros((20, 29), np.float32)
    el[7, [1, 3, 7, 9, 10, 19, 25]] = 1                                                  # far middle stroke bh gs CC in
    quiet = np.tile([1.0, 0.0], (5, 1)).astype(np.float32)
    rows = strokes.decode({"hit": [quiet, hit], "elements": [np.zeros((5, 29), np.float32), el], "stride": 2},
                          {"fps": 25.0, "pieces": [(0, 10), (100, 140)]})
    assert [(r["frame"], r["source_frame"], r["side"], r["shot"], r["hand"], r["technique"], r["direction"],
             r["outcome"]) for r in rows] == [(24, 114, "far", "stroke", "bh", "gs", "CC", "in")]


def test_fine_windows_pad_hits_join_overlaps_and_stay_in_their_piece():
    from dsa.gpu.fine import windows

    hits = [{"side": "near", "source_frame": f} for f in (10, 14, 40, 101)] + [{"side": "far", "source_frame": 60}]
    pieces = [[0, 50], [100, 200]]                                   # source frames; upload at twice the rate
    assert windows(hits, pieces, ratio=2.0, pad=5) == [[15, 34], [75, 86], [200, 208]]
    #                       10 and 14 joined; 101 starts at its piece (frame 200), not 5 before; far hits left out


def test_frame_loop_keeps_frame_order_across_chunks_and_cuts(tmp_path, monkeypatch):
    """process() with stand-in models on a made-up video: frames decoded in chunks, the next chunk's ball inputs
    prepared while this one is detected, must still line up with their frames; the ball's neighbours stop at
    cuts."""
    import cv2

    from dsa.gpu import process as P
    from dsa.gpu.models import KP

    video, n = str(tmp_path / "v.mp4"), 11
    w = cv2.VideoWriter(video, cv2.VideoWriter_fourcc(*"mp4v"), 25, (64, 48))
    for i in range(n):
        w.write(np.full((48, 64, 3), 20 * i, np.uint8))              # frame i is grey level 20 i
    w.release()
    index = lambda f: int(round(f.mean() / 20))                       # noqa: E731

    class Det:
        def people(self, fs):
            return [np.array([[index(f), 0, index(f) + 10, 40, 0.9]], np.float32) for f in fs]

    class Ball:
        small = staticmethod(index)

        def locate(self, triplets, W, H):
            return [[1, *t] for t in triplets]                       # (found, previous, this, next frame)

    class Pose:
        def prepare(self, f, box):
            return index(f)

        def run(self, crops):
            return [np.zeros((len(KP), 3)) for _ in crops]

    monkeypatch.setattr(P, "CHUNK", 4)
    r = P.process(video, str(tmp_path / "raw.npz"), batch=3, breaks=[6], models={"det": Det(), "ball": Ball(),
                                                                                    "pose": Pose()})
    z = np.load(tmp_path / "raw.npz")
    assert r["frames"] == n and z["boxes"][:, 0].tolist() == list(range(n))
    assert z["ball"][:, 1:].tolist() == [[max(i - 1, 0) if i != 6 else 6, i, min(i + 1, n - 1) if i != 5 else 5]
                                         for i in range(n)]
