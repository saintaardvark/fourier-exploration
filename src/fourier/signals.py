"""Test signals and clip conditioning that need only numpy.

Kept apart from audio.py (which needs soundfile) so the web demo can load
this module, and series.py, in Pyodide.
"""

import numpy as np


def test_tone(seconds: float = 1.0, sr: int = 44100) -> np.ndarray:
    """A 440 Hz sine plus a quieter 110 Hz square wave.

    The sine is a single coefficient; the square needs every odd harmonic,
    so together they exercise both ends of the spectrum.
    """
    t = np.arange(int(seconds * sr)) / sr
    sine = 0.5 * np.sin(2 * np.pi * 440 * t)
    square = 0.25 * np.sign(np.sin(2 * np.pi * 110 * t))
    return sine + square


def test_notes(seconds: float = 1.0, sr: int = 44100) -> np.ndarray:
    """Three plucked notes (A, C#, E) after a quarter-second of silence.

    Sharp onsets and silent gaps are what a global Fourier series handles
    worst: dropping coefficients smears energy into the silence (pre-echo).
    """
    n = int(seconds * sr)
    out = np.zeros(n)
    for start, freq in [(0.25, 440.0), (0.5, 554.37), (0.75, 659.26)]:
        t = np.arange(n - int(start * sr)) / sr
        envelope = np.exp(-t / 0.15)
        harmonics = sum(np.sin(2 * np.pi * h * freq * t) / h for h in range(1, 7))
        out[int(start * sr):] += 0.2 * envelope * harmonics
    return out


TEST_SIGNALS = {"tone": test_tone, "notes": test_notes}


def fade(x: np.ndarray, sr: int, ms: float) -> np.ndarray:
    """Raised-cosine fade in and out, so the clip's end meets its start.

    The Fourier series treats the clip as one period of a loop; a jump at
    the seam would otherwise show up as broadband junk.
    """
    width = min(int(sr * ms / 1000), len(x) // 2)
    if width == 0:
        return x
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, width))
    out = x.copy()
    out[:width] *= ramp
    out[-width:] *= ramp[::-1]
    return out
