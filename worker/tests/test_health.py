import threading

from folio_worker import health


def test_beats_only_while_the_database_answers(tmp_path):
    path = tmp_path / "alive"
    stop = threading.Event()
    calls = []

    def answers(url):
        calls.append(url)
        stop.set()  # one round is enough
        return False

    health.beat("postgres://x", stop, every=0, path=path, answers=answers)
    assert calls == ["postgres://x"]
    assert not path.exists()
    assert "hasn't reached its database" in health.problem(path)

    stop.clear()
    health.beat("postgres://x", stop, every=0, path=path, answers=lambda url: (stop.set(), True)[1])
    assert health.problem(path) is None


def test_a_beat_too_long_ago_is_unhealthy(tmp_path):
    path = tmp_path / "alive"
    path.write_text("1000")
    assert health.problem(path, now=1000 + 3 * health.EVERY) is None
    assert "last reached its database 91 seconds ago" in health.problem(path, now=1000 + 3 * health.EVERY + 1)
