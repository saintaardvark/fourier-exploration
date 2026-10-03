"""Loading, generating and writing audio.

All signals are mono float64 numpy arrays in the range [-1, 1].
"""

from collections.abc import Callable

import numpy as np
import soundfile as sf

BLOCK_FRAMES = 65536

# Called with (frames_done, frames_total) as decoding proceeds.
ProgressFn = Callable[[int, int], None]


def load(
    path: str,
    seconds: float | None = None,
    channel: str = "mix",
    progress: ProgressFn | None = None,
) -> tuple[np.ndarray, int]:
    """Decode the first `seconds` of an audio file (all of it if None).

    channel: "mix" averages all channels; "left"/"right" picks one.
    Returns (samples, sample_rate).
    """
    with sf.SoundFile(path) as f:
        sr = f.samplerate
        total = f.frames if seconds is None else min(f.frames, int(seconds * sr))
        blocks = []
        done = 0
        # Decode in blocks rather than one call so long files can report progress.
        while done < total:
            block = f.read(min(BLOCK_FRAMES, total - done), dtype="float64", always_2d=True)
            if len(block) == 0:
                break
            blocks.append(block)
            done += len(block)
            if progress:
                progress(done, total)

    data = np.concatenate(blocks) if blocks else np.zeros((0, 1))
    return _pick_channel(data, channel), sr


def _pick_channel(data: np.ndarray, channel: str) -> np.ndarray:
    if channel == "mix":
        return data.mean(axis=1)
    index = {"left": 0, "right": 1}[channel]
    if index >= data.shape[1]:
        raise ValueError(f"file has {data.shape[1]} channel(s); no '{channel}' channel")
    return data[:, index]


def test_tone(seconds: float = 1.0, sr: int = 44100) -> np.ndarray:
    """A 440 Hz sine plus a quieter 110 Hz square wave.

    The sine is a single coefficient; the square needs every odd harmonic,
    so together they exercise both ends of the spectrum.
    """
    t = np.arange(int(seconds * sr)) / sr
    sine = 0.5 * np.sin(2 * np.pi * 440 * t)
    square = 0.25 * np.sign(np.sin(2 * np.pi * 110 * t))
    return sine + square


def write(path: str, x: np.ndarray, sr: int) -> None:
    """Write a WAV as 32-bit float, so the file holds exactly what we computed."""
    sf.write(path, x, sr, subtype="FLOAT")
