"""State for the interactive web demo: one clip, analysed once, rebuilt on demand.

Needs only numpy, so Pyodide can load it in the browser alongside series.py
and signals.py. The browser holds a Session, calls render() whenever a
control changes, and pulls the results out as flat float32 arrays and JSON.
"""

import json
import math

import numpy as np

from fourier import series, signals

# Bands in the spectrum summary sent to the browser for plotting.
SPECTRUM_BANDS = 400
SPECTRUM_LOW_HZ = 20.0


def knob_kbps(mode: str, count: int, bits: int | None, total: int, seconds: float) -> float:
    """Bitrate of the knob settings for `count` kept coefficients.

    Unquantised knobs count as two 32-bit floats. top-N must also say which
    bins it kept; first-N doesn't, since they're always 0..N-1.
    """
    per_coeff = 64 if bits is None else 2 * bits
    if mode == "top" and count < total:
        per_coeff += math.ceil(math.log2(total))
    return count * per_coeff / seconds / 1000


class Session:
    def __init__(self, x: np.ndarray, sr: int, fade_ms: float = 5.0):
        self.sr = sr
        self.x = signals.fade(np.asarray(x, dtype=np.float64), sr, fade_ms)
        self.n = len(self.x)
        self.coeffs = series.analyse(self.x)
        self.freqs = np.fft.rfftfreq(self.n, d=1 / sr)
        self._band_edges = np.geomspace(SPECTRUM_LOW_HZ, sr / 2, SPECTRUM_BANDS + 1)
        self._original_spectrum = self._band_db(self.coeffs)
        self.y = self.x.copy()
        self.kept = self.coeffs
        self.stats: dict = {}

    @classmethod
    def from_test_signal(cls, name: str, seconds: float = 1.0, sr: int = 44100) -> "Session":
        return cls(signals.TEST_SIGNALS[name](seconds, sr), sr)

    @property
    def total(self) -> int:
        return len(self.coeffs)

    def render(
        self,
        mode: str = "top",
        count: int = 100,
        phase: str = "keep",
        bits: int | None = None,
        quant: str = "log",
        seed: int = 0,
    ) -> None:
        """Rebuild the clip; results land in self.y, self.kept and self.stats."""
        count = max(0, min(int(count), self.total))
        kept = series.SELECTORS[mode](self.coeffs, count)
        highest = np.flatnonzero(kept).max(initial=0) * self.sr / self.n
        # Fixed seed: moving a slider shouldn't reshuffle the random phases.
        kept = series.set_phase(kept, phase, self.n, np.random.default_rng(seed))
        if bits is not None:
            kept = series.quantise(kept, bits, quant)
        self.kept = kept
        self.y = series.resynth(kept, self.n)

        signal_power = np.mean(self.x**2)
        seconds = self.n / self.sr
        self.stats = {
            "count": count,
            "total": self.total,
            "fraction": count / self.total,
            "highest_hz": float(highest),
            "energy": float(np.mean(self.y**2) / signal_power) if signal_power else 0.0,
            "snr_db": series.compare(self.x, self.y)["snr_db"],
            "peak": float(np.max(np.abs(self.y))),
            "original_peak": float(np.max(np.abs(self.x))),
            "kbps": knob_kbps(mode, count, bits, self.total, seconds),
            "seconds": seconds,
            "sr": self.sr,
        }

    # --- Outputs for the browser -------------------------------------------

    def y_f32(self) -> np.ndarray:
        """Rebuilt clip, scaled down to peak 1.0 if it would clip."""
        peak = np.max(np.abs(self.y))
        y = self.y / peak if peak > 1 else self.y
        return y.astype(np.float32)

    def x_f32(self) -> np.ndarray:
        return self.x.astype(np.float32)

    def stats_json(self) -> str:
        # SNR is infinite for an exact rebuild; JSON has no Infinity.
        return json.dumps(
            {k: (None if isinstance(v, float) and math.isinf(v) else v) for k, v in self.stats.items()}
        )

    def spectrum_f32(self) -> np.ndarray:
        """[band edges (Hz) | original dB | kept dB], each SPECTRUM_BANDS(+1) long.

        Each band holds the loudest coefficient in it, on a log-frequency
        axis, so thousands of bins fit a few hundred pixels.
        """
        return np.concatenate(
            [self._band_edges, self._original_spectrum, self._band_db(self.kept)]
        ).astype(np.float32)

    def _band_db(self, coeffs: np.ndarray) -> np.ndarray:
        mags = np.abs(coeffs)
        idx = np.searchsorted(self._band_edges, self.freqs, side="right") - 1
        inside = (idx >= 0) & (idx < SPECTRUM_BANDS)
        band_max = np.zeros(SPECTRUM_BANDS)
        np.maximum.at(band_max, idx[inside], mags[inside])
        ref = np.abs(self.coeffs).max() or 1.0
        with np.errstate(divide="ignore"):
            db = 20 * np.log10(band_max / ref)
        return np.maximum(db, -120.0)
