"""Fourier series analysis and resynthesis of a real signal.

A clip of n samples is treated as one period of a periodic signal. Its
Fourier series is

    x[t] = sum_k  A_k * cos(2*pi*k*t/n + phi_k),   k = 0 .. n//2

where bin k has frequency k * sr / n Hz. The (A_k, phi_k) pairs are the
"knobs": two per coefficient.
"""

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

# Called with (coefficients_done, coefficients_total) during literal resynthesis.
ProgressFn = Callable[[int, int], None]


@dataclass
class Knobs:
    freqs: np.ndarray  # Hz
    amps: np.ndarray  # A_k, same units as the samples
    phases: np.ndarray  # phi_k, radians
    n: int  # length of the clip the series describes


def analyse(x: np.ndarray) -> np.ndarray:
    """Real signal -> complex coefficients for bins 0 .. n//2."""
    return np.fft.rfft(x)


def resynth(coeffs: np.ndarray, n: int) -> np.ndarray:
    """Complex coefficients -> signal, via the inverse FFT."""
    return np.fft.irfft(coeffs, n=n)


def first_n(coeffs: np.ndarray, count: int) -> np.ndarray:
    """Keep bins 0 .. count-1 and zero the rest: a brick-wall low-pass filter."""
    kept = np.zeros_like(coeffs)
    kept[:count] = coeffs[:count]
    return kept


def top_n(coeffs: np.ndarray, count: int) -> np.ndarray:
    """Keep the `count` largest coefficients by magnitude; zero the rest.

    (Strictly, DC and Nyquist count half as much as other bins -- see
    to_knobs -- but that's two bins out of thousands, so it's ignored.)
    """
    if count >= len(coeffs):
        return coeffs.copy()
    # argpartition finds the top `count` without a full sort: fast on long clips.
    keep = np.argpartition(np.abs(coeffs), -count)[-count:]
    kept = np.zeros_like(coeffs)
    kept[keep] = coeffs[keep]
    return kept


SELECTORS = {"first": first_n, "top": top_n}


def to_knobs(coeffs: np.ndarray, n: int, sr: int) -> Knobs:
    """Convert rfft output into amplitude/phase pairs for the cosine form.

    Bins 1 .. n/2-1 stand for a positive and a negative frequency, so they
    count twice. DC and (for even n) Nyquist have no mirror and count once.
    """
    amps = 2 * np.abs(coeffs) / n
    amps[0] /= 2
    if n % 2 == 0:
        amps[-1] /= 2
    return Knobs(
        freqs=np.fft.rfftfreq(n, d=1 / sr),
        amps=amps,
        phases=np.angle(coeffs),
        n=n,
    )


# Upper bound on the (chunk x n) working arrays in resynth_literal.
LITERAL_CELLS = 4_000_000


def resynth_literal(knobs: Knobs, progress: ProgressFn | None = None) -> np.ndarray:
    """Rebuild the signal by summing one cosine per knob pair.

    This is the "stereo with knobs" done by brute force: O(n * coefficients),
    so it is slow and meant for short clips. It should match resynth() to
    within floating-point error.
    """
    n = knobs.n
    t = np.arange(n, dtype=np.int64)
    out = np.zeros(n)
    total = len(knobs.amps)
    chunk = max(1, LITERAL_CELLS // n)
    for start in range(0, total, chunk):
        k = np.arange(start, min(start + chunk, total), dtype=np.int64)
        # (k * t) mod n in integers keeps the angle exact for long clips;
        # 2*pi*k*t/n in floats loses precision once k*t gets large.
        angle = 2 * np.pi * ((k[:, None] * t[None, :]) % n) / n
        angle += knobs.phases[k][:, None]
        out += knobs.amps[k] @ np.cos(angle)
        if progress:
            progress(k[-1] + 1, total)
    return out


def compare(original: np.ndarray, rebuilt: np.ndarray) -> dict[str, float]:
    """Error metrics between two equal-length signals."""
    err = original - rebuilt
    signal_power = np.mean(original**2)
    noise_power = np.mean(err**2)
    snr = np.inf if noise_power == 0 else 10 * np.log10(signal_power / noise_power)
    return {"max_abs_error": float(np.max(np.abs(err))), "snr_db": float(snr)}
