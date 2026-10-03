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


def test_first_n_is_a_low_pass():
    sr = 8000
    t = np.arange(sr) / sr
    low, high = np.sin(2 * np.pi * 100 * t), np.sin(2 * np.pi * 1000 * t)
    coeffs = series.analyse(low + high)
    y = series.resynth(series.first_n(coeffs, 500), sr)  # bins 0..499 Hz
    assert np.max(np.abs(y - low)) < 1e-9


def test_first_n_all_is_exact():
    x = np.random.default_rng(2).uniform(-1, 1, 1000)
    coeffs = series.analyse(x)
    assert np.allclose(series.resynth(series.first_n(coeffs, len(coeffs)), 1000), x)


def test_fade_ends_at_zero_and_leaves_middle():
    x = np.ones(1000)
    y = audio.fade(x, sr=1000, ms=10)
    assert y[0] == 0 and y[-1] == 0
    assert np.all(y[10:-10] == 1)


def test_top_n_finds_the_loud_partials():
    sr = 8000
    t = np.arange(sr) / sr
    loud = np.sin(2 * np.pi * 3000 * t) + 0.5 * np.sin(2 * np.pi * 50 * t)
    quiet = 0.01 * np.sin(2 * np.pi * 700 * t)
    coeffs = series.analyse(loud + quiet)
    y = series.resynth(series.top_n(coeffs, 2), sr)
    assert np.max(np.abs(y - loud)) < 1e-9


def test_top_n_keeps_exactly_n():
    coeffs = series.analyse(np.random.default_rng(3).uniform(-1, 1, 1000))
    assert np.count_nonzero(series.top_n(coeffs, 37)) == 37


def test_notes_start_with_silence():
    x = audio.test_notes(1.0, 8000)
    assert np.all(x[:2000] == 0) and np.max(np.abs(x)) > 0.1


@pytest.mark.parametrize("n", [1000, 1001])
@pytest.mark.parametrize("how", ["zero", "random"])
def test_set_phase_keeps_magnitudes_and_energy(n, how):
    x = np.random.default_rng(4).uniform(-1, 1, n)
    coeffs = series.analyse(x)
    changed = series.set_phase(coeffs, how, n, np.random.default_rng(0))
    assert np.allclose(np.abs(changed), np.abs(coeffs))
    y = series.resynth(changed, n)
    assert np.mean(y**2) == pytest.approx(np.mean(x**2))
    # Survives a round trip unchanged, i.e. it describes a real signal.
    assert np.allclose(series.analyse(y), changed)


def test_zero_phase_peaks_at_start():
    x = np.random.default_rng(5).uniform(-1, 1, 1000)
    y = series.resynth(series.set_phase(series.analyse(x), "zero", 1000), 1000)
    assert np.argmax(y) == 0


def test_top_n_zero_keeps_nothing():
    coeffs = series.analyse(np.ones(100))
    assert np.count_nonzero(series.top_n(coeffs, 0)) == 0


@pytest.mark.parametrize("scale", series.QUANT_SCALES)
def test_quantise_uses_at_most_2_to_the_bits_levels(scale):
    coeffs = series.analyse(np.random.default_rng(6).standard_normal(4000))
    q = series.quantise(coeffs, 3, scale)
    assert len(np.unique(np.round(np.abs(q), 9))) <= 8
    assert len(np.unique(np.round(np.angle(q[np.abs(q) > 0]), 9))) <= 9  # -pi and pi coincide


@pytest.mark.parametrize("scale", series.QUANT_SCALES)
def test_quantise_error_shrinks_with_bits(scale):
    x = np.random.default_rng(7).standard_normal(4000)
    coeffs = series.analyse(x)
    snrs = [series.compare(x, series.resynth(series.quantise(coeffs, b, scale), 4000))["snr_db"]
            for b in (4, 8, 16)]
    assert snrs[0] < snrs[1] < snrs[2]


def test_quantise_keeps_zeros_zero():
    coeffs = series.analyse(np.random.default_rng(8).standard_normal(1000))
    kept = series.top_n(coeffs, 50)
    assert np.count_nonzero(series.quantise(kept, 8, "log")) <= 50
