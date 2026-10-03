import numpy as np
import pytest

from fourier import audio, series


@pytest.mark.parametrize("n", [1000, 1001])  # even n has a Nyquist bin, odd n doesn't
def test_fft_roundtrip_is_exact(n):
    x = np.random.default_rng(0).uniform(-1, 1, n)
    y = series.resynth(series.analyse(x), n)
    assert np.max(np.abs(x - y)) < 1e-12


@pytest.mark.parametrize("n", [1000, 1001])
def test_literal_matches_fft(n):
    x = np.random.default_rng(1).uniform(-1, 1, n)
    coeffs = series.analyse(x)
    y = series.resynth_literal(series.to_knobs(coeffs, n, sr=n))
    assert np.max(np.abs(x - y)) < 1e-9


def test_pure_sine_is_one_knob():
    sr = 8000
    x = 0.5 * np.sin(2 * np.pi * 440 * np.arange(sr) / sr)  # 1 s: integer cycles
    knobs = series.to_knobs(series.analyse(x), len(x), sr)
    loud = np.flatnonzero(knobs.amps > 1e-9)
    assert list(knobs.freqs[loud]) == [440.0]
    assert knobs.amps[loud][0] == pytest.approx(0.5)


def test_load_trims_and_mixes(tmp_path):
    sr = 8000
    stereo = np.stack([np.full(sr, 0.5), np.full(sr, -0.25)], axis=1)
    path = tmp_path / "s.wav"
    import soundfile as sf
    sf.write(path, stereo, sr, subtype="FLOAT")

    x, got_sr = audio.load(str(path), seconds=0.5)
    assert got_sr == sr and len(x) == sr // 2
    assert np.allclose(x, 0.125)
    assert np.allclose(audio.load(str(path), channel="right")[0], -0.25)
