# fourier-exploration

Rebuilding audio clips from their Fourier series coefficients.

## Setup

    uv sync

## Commands

Every command takes an audio file (MP3/OGG/WAV/FLAC), or uses a built-in
test signal if you leave it out:

- `--test tone` (default): 440 Hz sine + 110 Hz square, steady throughout
- `--test notes`: three plucked notes after 0.25 s of silence; good for
  hearing pre-echo

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

### sweep: rebuild from N coefficients

    uv run fourier sweep song.mp3 --seconds 5
    uv run fourier sweep song.mp3 --seconds 5 --select both --counts 50,500,5000

`--select` picks which N coefficients to keep:

- `first` (default): bins 0 .. N-1. Coefficient k sits at
  k / (clip length) Hz, so this is a low-pass filter.
- `top`: the N largest by magnitude. Tonal content comes back fast;
  onsets smear across the whole clip, including into silences.
- `both`: run both, for comparison at the same N.

Writes `<select>-<N>.wav` for each N, and (for clips up to 30 s)
`progression-<select>.wav`: every step back to back, then the original.

- `--fade-ms`: fade the clip's ends (default 5 ms) so the loop seam
  doesn't click.

Output: `out/sweep/`.

## Tests

    uv run pytest
