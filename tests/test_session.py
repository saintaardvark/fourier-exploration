import json

import numpy as np
import pytest

from fourier import session
from fourier.session import Session


@pytest.fixture
def notes():
    return Session.from_test_signal("notes", seconds=1.0, sr=8000)


def test_all_coefficients_rebuild_exactly(notes):
    notes.render(mode="first", count=notes.total)
    assert np.max(np.abs(notes.y - notes.x)) < 1e-12
    assert json.loads(notes.stats_json())["snr_db"] > 200


def test_render_stats(notes):
    notes.render(mode="top", count=40, phase="random", bits=8)
    stats = json.loads(notes.stats_json())
    assert stats["count"] == 40 and stats["total"] == notes.total
    assert 0 < stats["energy"] < 1.5
    assert stats["kbps"] == pytest.approx(session.knob_kbps("top", 40, 8, notes.total, 1.0))


def test_clipping_output_is_scaled(notes):
    notes.render(mode="top", count=notes.total, phase="zero")
    assert notes.stats["peak"] > 1
    assert np.max(np.abs(notes.y_f32())) == pytest.approx(1.0)


def test_spectrum_layout(notes):
    notes.render(mode="first", count=100)
    spec = notes.spectrum_f32()
    b = session.SPECTRUM_BANDS
    assert spec.dtype == np.float32 and len(spec) == 3 * b + 1
    edges, original, kept = spec[: b + 1], spec[b + 1 : 2 * b + 1], spec[2 * b + 1 :]
    assert np.all(np.diff(edges) > 0)
    # first-100 at 1 Hz/bin keeps nothing above 100 Hz.
    assert np.all(kept[edges[:-1] > 100] <= -120)
    assert original.max() == pytest.approx(0, abs=1e-4)


def test_infinite_snr_is_json_null():
    s = Session(np.zeros(100), 100)
    s.render(mode="first", count=s.total)
    json.loads(s.stats_json())  # must not raise on NaN/Infinity
