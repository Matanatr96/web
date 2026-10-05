"""The catalog and the batch's bookkeeping: which step a video needs next, read from its files."""
import json

import pytest

from dsa import batch
from dsa.ingest.projects import EXTRA, PROJECTS, match


def test_second_window_continues_where_the_first_ends():
    videos = PROJECTS["atp_hardcourt"]["videos"]
    for v in [v for v in videos if not v.endswith("_b")]:
        yt, title, at, seconds, players = videos[v]
        assert videos[f"{v}_b"] == (yt, title, at + seconds, EXTRA, players)
        assert match(f"{v}_b") == match(v) == v


@pytest.fixture
def folder(tmp_path, monkeypatch):
    """A made-up atp_hardcourt video's folder, and where its whole upload would be."""
    monkeypatch.setattr(batch, "video_dir", lambda spec: tmp_path / "video")
    monkeypatch.setattr(batch, "upload", lambda spec: tmp_path / "upload.mp4")
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


def test_steps_running_elsewhere_are_found_by_their_command_lines():
    import re

    spec = "atp_hardcourt/x"
    lines = {name: " ".join(batch.command(name, spec)) for name in ("slice", "cut", "gpu", "fine", "after")}
    for name, line in lines.items():
        assert re.search(batch.PATTERN[name], line), name
    assert not re.search(batch.PATTERN["cut"], lines["gpu"])
