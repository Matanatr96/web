"""The player comparison's statistics on made-up match means."""
import numpy as np

from dsa.measure.profiles import compare, event, holm


def test_holm_multiplies_by_the_tests_left_and_stays_in_order():
    assert np.allclose(holm(np.array([0.01, 0.04, 0.03])), [0.03, 0.06, 0.06])
    assert holm(np.array([0.5, 0.9])).max() <= 1


def test_event_tells_the_us_open_from_melbourne():
    assert event(np.array(["2021_ao_djokovic_zverev", "2022_uso_alcaraz_tiafoe_b"])).tolist() == [0, 1]


def test_compare_finds_the_player_who_differs_from_the_rest():
    rng = np.random.default_rng(0)
    player, video, res = [], [], []
    for p, shift in [("A", 3.0), ("B", 0.0), ("C", 0.0)]:
        for m in range(4):
            for _ in range(5):                                          # five strokes a match
                player.append(p), video.append(f"{p}{m}"), res.append([shift + rng.normal(0, 0.3), rng.normal()])
    out = compare(np.array(res), np.array(player), np.array(video))
    assert out["units"] == 12 and set(out["players"]) == {"A", "B", "C"}
    a = out["players"]["A"]
    assert a["matches"] == 4 and a["diff"][0] > 2.5 and a["holm"][0] < 0.01 and a["holm"][1] > 0.05
