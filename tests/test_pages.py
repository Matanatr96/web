"""The quiz's naming and pairing, on made-up rows."""


def test_quiz_names_players_from_the_scoreboard_else_step_4(tmp_path, monkeypatch):
    import json

    from dsa.pages import quiz

    (tmp_path / "names.json").write_text(json.dumps({"1": "Holger Rune", "2": "Casper Ruud"}))
    d = {"src": tmp_path, "hits": [{"frame": 4, "shot": "serve", "side": "near"}]}
    one = {"pl": {"near_far": [[2, 1]] * 10}}       # step 3's player 2 at the near end, serving
    pair = ["Casper Ruud", "Holger Rune"]
    monkeypatch.setattr(quiz, "server", lambda *a: "Holger Rune")
    assert quiz.names_of(d, one, 0, 10, pair) == ({2: "Holger Rune", 1: "Casper Ruud"}, "Holger Rune", "scoreboard")
    monkeypatch.setattr(quiz, "server", lambda *a: None)                   # no serve marker
    assert quiz.names_of(d, one, 0, 10, pair) == ({1: "Holger Rune", 2: "Casper Ruud"}, "Casper Ruud", "names.json")


def test_quiz_pairs_one_serve_each_and_both_strokes_by_both():
    from dsa.pages.quiz import pairs

    def row(clip, serve, a, b, seconds=10):
        return {"clip": clip, "serve": serve, "seconds": seconds, "by": "scoreboard",
                "strokes": {"A": {"fh": a[0], "bh": a[1]}, "B": {"fh": b[0], "bh": b[1]}}}
    rows = [row("1", "A", (1, 0), (1, 1)), row("2", "B", (0, 1), (0, 0)), row("3", "B", (0, 0), (1, 1), 5),
            row("4", "A", (1, 1), (0, 0), 30)]
    got = [[r["clip"] for r in p] for p in pairs(rows, ["A", "B"])]
    assert got == [["1", "2"], ["4", "3"]]      # shortest first; 1+3 lacks A's backhand, 4+2 B's forehand
