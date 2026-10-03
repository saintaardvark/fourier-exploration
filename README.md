# fourier-exploration

Rebuilding audio clips from their Fourier series coefficients.

## Setup

    uv sync

## Usage

Round trip of the built-in test tone (440 Hz sine + 110 Hz square, 1 s):

    uv run fourier roundtrip --method both

Round trip of the first 5 s of a file:

    uv run fourier roundtrip song.mp3 --seconds 5

- `--method fft` (default): inverse FFT. Fast, even for a whole song.
- `--method literal`: sums one cosine per coefficient — the "stereo with
  knobs". Cost grows with the square of the clip length: ~20 s for 1 s of
  audio, so keep it to short clips.
- `--channel mix|left|right`

Output WAVs (`original.wav`, `rebuilt-*.wav`) go to `out/`.

## Tests

    uv run pytest
