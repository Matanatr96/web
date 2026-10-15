"""The catalog and the batch's bookkeeping: which step a video needs next, read from its files."""
import json

import pytest

from dsa import batch
from dsa.ingest.projects import EXTRA, MORE, PAD_S, PROJECTS, match, piece


def test_second_window_continues_where_the_first_ends():
    videos = PROJECTS["atp_hardcourt"]["videos"]
    for v in [v for v in videos if not v.endswith("_b") and v not in MORE and "_x" not in v]:
        yt, title, at, seconds, players = videos[v]
        assert videos[f"{v}_b"] == (yt, title, at + seconds, EXTRA, players)
        assert match(f"{v}_b") == match(v) == v
        # later pieces (dsa.ingest.pad): PAD_S each, from the end of the first hour
        assert piece(f"{v}_x1")[2:4] == (at + 3600, PAD_S) and piece(f"{v}_x2")[2] == at + 3600 + PAD_S


@pytest.fixture
def folder(tmp_path, monkeypatch):
    """A made-up atp_hardcourt video's folder, and where its whole upload would be."""
    monkeypatch.setattr(batch, "video_dir", lambda spec: tmp_path / "video")
    monkeypatch.setattr(batch, "upload", lambda spec: tmp_path / "upload.mp4")
    monkeypatch.setitem(batch.PROJECTS["atp_hardcourt"], "fine", True)   # step 2b on (it is off for new pieces)
    (tmp_path / "video").mkdir()
    return tmp_path


def test_each_step_follows_the_files_the_last_one_wrote(folder):
    spec, d = "atp_hardcourt/2024_ao_sinner_medvedev", folder / "video"
    assert batch.step(spec) == "get"
    (folder / "upload.mp4").touch()
    assert batch.step(spec) == "slice"
    for files, nxt in [(["source.mp4"], "cut"), (["kept.json"], "gpu"), (["raw.npz", "strokes/strokes.json"], "after"),
                       (["players.json", "names.json", "render.mp4", "render_plain.mp4"], "fine")]:
        for f in files:
            (d / f).parent.mkdir(exist_ok=True)
            (d / f).touch()
        assert batch.step(spec) == nxt
    (d / "fine.json").write_text(json.dumps({"same": True}))         # a 25 / 30 fps upload: nothing for step 2b
    assert batch.step(spec) is None


def test_steps_running_elsewhere_are_found_by_pgrep():
    """Each step's pattern, as pgrep reads it (no \\S or \\d), finds a process with that step's command line."""
    import subprocess
    import sys

    spec = "atp_hardcourt/test_pgrep_x"
    procs = {name: subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", *batch.command(name, spec)])
             for name in ("slice", "cut", "gpu", "fine", "after")}
    try:
        def found(pattern: str) -> set[int]:
            out = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True).stdout
            return {int(x) for x in out.split()}

        for name, p in procs.items():
            assert p.pid in found(batch.PATTERN[name]), name
        assert procs["gpu"].pid not in found(batch.PATTERN["cut"])
    finally:
        for p in procs.values():
            p.kill()


def test_pad_adds_a_new_match_while_its_player_is_short_and_nothing_once_all_are_there():
    from dsa.ingest import pad
    full = {p: dict.fromkeys(pad.KINDS, 70) for p in pad.PROJECTS["atp_hardcourt"]["players"]}
    assert pad.choose(full, 70, [], set()) == []
    full["Andrey Rublev"]["backhand"] = 10
    assert pad.choose(full, 70, [], set()) == ["2022_uso_rublev_tiafoe", "2023_ao_rublev_djokovic",   # all of his,
                                                 "2021_uso_tiafoe_rublev"]                          # together
    assert pad.choose(full, 70, ["2022_uso_rublev_tiafoe"], set())[0] == "2023_ao_rublev_djokovic"
