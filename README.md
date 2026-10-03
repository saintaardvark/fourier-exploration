# fourier-exploration

Rebuilding audio clips from their Fourier series coefficients.

## Setup

    uv sync

## Commands

Every command takes an audio file (MP3/OGG/WAV/FLAC), or uses the built-in
test tone (440 Hz sine + 110 Hz square) if you leave it out.

- `--seconds S`: use only the first S seconds
- `--channel mix|left|right`

### roundtrip: analyse and rebuild, check it's exact

    uv run fourier roundtrip --method both
    uv run fourier roundtrip song.mp3 --seconds 5

- `--method fft` (default): inverse FFT. Fast, even for a whole song.
- `--method literal`: sums one cosine per coefficient — the "stereo with
  knobs". Cost grows with the square of the clip length: ~20 s for 1 s of
  audio, so keep it to short clips.

Output: `out/roundtrip/`.

### sweep: rebuild from the first N coefficients

    uv run fourier sweep song.mp3 --seconds 5
    uv run fourier sweep song.mp3 --seconds 5 --counts 50,500,5000

Writes `first-<N>.wav` for each N, and (for clips up to 30 s)
`progression.wav`: every step back to back, then the original.

Coefficient k sits at k / (clip length) Hz, so the first N coefficients
are a low-pass filter. The table shows the cutoff for each N.

- `--fade-ms`: fade the clip's ends (default 5 ms) so the loop seam
  doesn't click.

Output: `out/sweep/`.

## Tests

    uv run pytest
