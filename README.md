# fourier-exploration

Rebuilding audio clips from their Fourier series coefficients.

The original idea: a musician breaks a song into a Fourier series and sells
the coefficients. The listener has a stereo with a knob per coefficient;
they set each knob, hit play, and the song is recreated.

Inspired by [this llama](https://adekau.github.io/posts/2020/llamas.html),
redrawn from more and more Fourier coefficients until it matches the
original.

## Background

### Audio is not a llama

- **Llama:** a 2D closed curve, treated as complex numbers `x + iy`. A few
  hundred coefficients is enough, because the shape is smooth.

- **Audio:** a 1D real signal, 44,100 samples per second. A clip of length
  T has a fundamental of `1/T` Hz, and coefficient k sits at `k/T` Hz.

For a 5 s clip that means:

- 500 coefficients reach only 100 Hz: sub-bass rumble.

- Exact reconstruction needs ~110,000 coefficients, or 220,000 knobs
  (magnitude and phase for each).

An 8-minute song needs ~10.6 million coefficients.

### What to expect

1. **"First N" is a low-pass filter.** Bass comes back first, cymbals
   last: muffled to clear, not blurry to sharp.

2. **"Largest N" is the llama-like experiment.** Sustained notes and chords
   come back quickly; drums and consonants late or never.

3. **No time localisation.** Each coefficient is a sinusoid lasting the
   whole clip. Drop some, and the remainder smears across the whole clip:
   notes heard before they're played (pre-echo), silences filled in,
   transients turned to a whoosh.

4. **Phase matters as much as magnitude.** Knobs for amplitude alone, with
   random phases, give mush.

5. **The series assumes the clip loops.** If the end doesn't meet the
   start, the jump creates broadband junk. A few ms of fade fixes it.

6. **Knob precision.** How many bits does each knob need? That trade-off is
   what lossy codecs are built on.

7. **MP3/OGG sources are already lossy.** Expect near-zero coefficients
   above ~16 kHz.

### You've reinvented the MP3

The coefficients-plus-decoder idea is roughly what MP3, AAC and Vorbis do,
with three differences:

- **Short frames** (~20 ms) instead of one series for the whole song, so
  each coefficient has a time *and* a frequency. This fixes the smearing.

- **MDCT** instead of the plain DFT: real-valued, no phase to manage.

- **A psychoacoustic model** decides which coefficients you can't hear.

So the arc of this project: global Fourier series → see why it smears →
frames (STFT) → the core of a codec.

### Experiment ladder

| Step | Experiment | Status |
|---|---|---|
| 1 | Synthetic tone; check the round trip is exact | `roundtrip` |
| 2 | First-N sweep; hear the low-pass | `sweep --select first` |
| 3 | Top-N sweep; hear smearing and pre-echo | `sweep --select top` |
| 4 | Zero or randomise phases | `sweep --phase zero,random` |
| 5 | Quantise to B bits per knob | |
| 6 | STFT, top-N per frame; compare with step 3 | |
| 7 | Stereo as an XY path; epicycle plot | |

Step 7 is the direct llama analogue: treat each sample as `L + iR`, take
the complex Fourier series of that path, and draw it with epicycles. That's
how oscilloscope music works.

## Setup

    uv sync

## Commands

Every command takes an audio file (MP3/OGG/WAV/FLAC), or uses a built-in
test signal if you leave it out:

- `--test tone` (default): 440 Hz sine + 110 Hz square, steady throughout

- `--test notes`: three plucked notes after 0.25 s of silence; good for
  hearing pre-echo

Other options shared by all commands:

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
    uv run fourier sweep song.mp3 --select top --counts 0.1%,1%,10%
    uv run fourier sweep --test notes --select top --phase keep,zero,random

`--select` picks which N coefficients to keep:

- `first` (default): bins 0 .. N-1. Coefficient k sits at
  k / (clip length) Hz, so this is a low-pass filter.

- `top`: the N largest by magnitude. Tonal content comes back fast;
  onsets smear across the whole clip, including into silences.

- `both`: run both, for comparison at the same N.

`--counts` takes whole numbers, percentages of all coefficients, or a mix:
`100,0.1%,10%`.

`--phase` replaces the phase of each kept coefficient, leaving its
magnitude alone. Comma-separate several to compare them:

- `keep` (default): unchanged.

- `zero`: every cosine peaks at t = 0. Most of the energy lands in one
  click at the loop seam, and the clip becomes a palindrome (each half
  mirrors the other).

- `random`: uniform random phases (`--seed` to vary). The same spectrum,
  spread evenly through time: a wash with no onsets.

Same energy, same spectrum, very different sound: phase is where the
timing lives.

Writes `<select>[-<phase>]-<N>.wav` for each N, and (for clips up to 30 s)
`progression-<select>[-<phase>].wav`: every step back to back, then the
original.

The table's `peak` column turns red above 1.0; those WAVs are scaled
down to peak 1.0 so they don't clip.

- `--fade-ms`: fade the clip's ends (default 5 ms) so the loop seam
  doesn't click.

Output: `out/sweep/`.

## Sweeps to try on a whole song

Numbers below are for an 8-minute song: ~10.6 M coefficients, one every
0.0021 Hz. Every coefficient is a sinusoid lasting all 8 minutes.

### 1. The drone: N = 1 to 100

    uv run fourier sweep song.mp3 --select top --counts 1,3,10,30,100

**Expect:** a steady hum or chord for the whole song; no rhythm, no
sections. The biggest coefficients sit on the most-used pitches, so this is
the song's average chord — a crude key detector.

### 2. When does time come back? N = 1k to 1M

    uv run fourier sweep song.mp3 --select top --counts 1000,10000,100000,1000000

**Expect:** sections slowly swell and fade. The chorus is likely faintly
audible during the intro: pre-echo, spread over minutes.

Rough rule: placing a sound within Δt seconds needs ~1/Δt Hz of
neighbouring coefficients around each partial.

| To place a sound within | Coefficients per partial |
|---|---|
| 1 s (a section change) | ~480 |
| 0.1 s (a note) | ~4,800 |
| 10 ms (a drum hit) | ~48,000 |

Drums should be the last thing to come back.

### 3. Percentage of the song: 0.1%, 1%, 10%, 50%

    uv run fourier sweep song.mp3 --select top --counts 0.1%,1%,10%,50%

The "how few knobs can I sell" question. Music spectra are heavy-tailed, so
10% may already sound close, with a smeared top end (untested).

For scale: a 128 kbps MP3 of 8 minutes is ~7.7 MB, less than 1 M
coefficients at 8 bytes each — before recording which bins they are.

### 4. First vs top at the same N

    uv run fourier sweep song.mp3 --select both --counts 100000,1000000

- **first-1M** stops at ~2.1 kHz: muffled, telephone-like, but sharp in
  time.

- **top-1M** has the full frequency range, but smeared in time.

The cleanest A/B of low-pass versus smear.

### 5. Same knobs, different clip lengths

    uv run fourier sweep song.mp3 --seconds 5  --select top --counts 10000 --out-dir out/5s
    uv run fourier sweep song.mp3 --seconds 60 --select top --counts 10000 --out-dir out/60s
    uv run fourier sweep song.mp3              --select top --counts 10000 --out-dir out/full

**Expect:** fine at 5 s (~2,000 knobs per second), drone-like at 8 minutes
(~21 per second). This is why codecs use short frames.

### Practical notes

- **Disk:** each output WAV is ~85 MB (8 min, mono, 32-bit float).
  `progression-*.wav` is skipped for clips over 30 s.

- **Time:** ~30 s per sweep.

- **Volume:** output isn't normalised. Low N is quiet; turn it down before
  playing larger N.

- **Phase:** add `--phase random` to sweep 3. A whole song with random
  phases should collapse into an 8-minute wash of its average spectrum.

- **Stereo:** try `--channel left` vs `right` on a song with hard-panned
  instruments.

## Ideas

- **GUI:** [Pyxel](https://github.com/kitao/pyxel) for a pixel-art
  spectrogram; a grid of knobs wired to live resynthesis; paint a
  spectrogram, then play it; animated epicycles for the XY mode.

## Tests

    uv run pytest
