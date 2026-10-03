"""Command-line entry point."""

import argparse
import math
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.table import Table

from fourier import audio, series

console = Console()

PROGRESSION_MAX_SECONDS = 30


def _progress() -> Progress:
    return Progress(
        SpinnerColumn(),
        TextColumn("{task.description:<28}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        TextColumn("eta"),
        TimeRemainingColumn(),
        console=console,
    )


def cmd_tone(args: argparse.Namespace) -> None:
    x = audio.test_tone(args.seconds, args.sr)
    audio.write(args.out, x, args.sr)
    console.print(f"Wrote {args.seconds}s test tone to [bold]{args.out}[/]")


def _load_clip(args: argparse.Namespace, prog: Progress) -> tuple[np.ndarray, int]:
    """Decode args.input, or generate the test tone if no input was given."""
    if args.input:
        task = prog.add_task("Decoding", total=None)
        x, sr = audio.load(
            args.input,
            seconds=args.seconds,
            channel=args.channel,
            progress=lambda done, total: prog.update(task, completed=done, total=total),
        )
    else:
        task = prog.add_task(f"Generating test {args.test}", total=1)
        sr = args.sr
        x = audio.TEST_SIGNALS[args.test](args.seconds or 1.0, sr)
        prog.update(task, completed=1)
    return x, sr


def cmd_roundtrip(args: argparse.Namespace) -> None:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []  # (stage, seconds)

    with _progress() as prog:
        start = time.perf_counter()
        x, sr = _load_clip(args, prog)
        rows.append(("load", time.perf_counter() - start))
        n = len(x)

        start = time.perf_counter()
        task = prog.add_task("Analysing (FFT)", total=1)
        coeffs = series.analyse(x)
        prog.update(task, completed=1)
        rows.append(("analyse (FFT)", time.perf_counter() - start))

        rebuilt = {}
        if args.method in ("fft", "both"):
            start = time.perf_counter()
            task = prog.add_task("Resynthesising (IFFT)", total=1)
            rebuilt["fft"] = series.resynth(coeffs, n)
            prog.update(task, completed=1)
            rows.append(("resynth (IFFT)", time.perf_counter() - start))

        if args.method in ("literal", "both"):
            start = time.perf_counter()
            knobs = series.to_knobs(coeffs, n, sr)
            task = prog.add_task("Resynthesising (literal)", total=len(coeffs))
            rebuilt["literal"] = series.resynth_literal(
                knobs, progress=lambda done, total: prog.update(task, completed=done)
            )
            rows.append(("resynth (literal)", time.perf_counter() - start))

    audio.write(str(out_dir / "original.wav"), x, sr)
    for method, y in rebuilt.items():
        audio.write(str(out_dir / f"rebuilt-{method}.wav"), y, sr)

    _report(x, sr, coeffs, rebuilt, rows, out_dir)


@dataclass
class Step:
    """One rebuilt version of the clip in a sweep."""

    mode: str  # "first" or "top"
    phase: str  # see series.PHASES
    bits: int | None  # bits per knob; None means unquantised
    count: int  # coefficients kept
    highest_hz: float  # frequency of the highest coefficient kept
    y: np.ndarray  # rebuilt signal

    @property
    def label(self) -> str:
        """File-name stem, e.g. 'top', 'top-random', 'top-random-8bit'."""
        parts = [self.mode]
        if self.phase != "keep":
            parts.append(self.phase)
        if self.bits is not None:
            parts.append(f"{self.bits}bit")
        return "-".join(parts)

    def kbps(self, total_coeffs: int, seconds: float) -> float:
        """Bitrate of the knob settings.

        Unquantised knobs are counted as two 32-bit floats. top-N must also
        say which bins it kept; first-N doesn't, since they're always 0..N-1.
        """
        per_coeff = 64 if self.bits is None else 2 * self.bits
        if self.mode == "top" and self.count < total_coeffs:
            per_coeff += math.ceil(math.log2(total_coeffs))
        return self.count * per_coeff / seconds / 1000


def cmd_sweep(args: argparse.Namespace) -> None:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with _progress() as prog:
        x, sr = _load_clip(args, prog)
        x = audio.fade(x, sr, args.fade_ms)

        task = prog.add_task("Analysing (FFT)", total=1)
        coeffs = series.analyse(x)
        prog.update(task, completed=1)

        counts = sorted({min(_resolve_count(c, len(coeffs)), len(coeffs)) for c in args.counts})
        modes = ["first", "top"] if args.select == "both" else [args.select]
        combos = [
            (mode, phase, bits) for mode in modes for phase in args.phase for bits in args.bits
        ]
        total = len(combos) * len(counts)
        task = prog.add_task(f"Resynthesising {total} steps", total=total)
        rng = np.random.default_rng(args.seed)
        steps: list[Step] = []
        for mode, phase, bits in combos:
            for count in counts:
                kept = series.SELECTORS[mode](coeffs, count)
                highest = np.flatnonzero(kept).max(initial=0) * sr / len(x)
                kept = series.set_phase(kept, phase, len(x), rng)
                if bits is not None:
                    kept = series.quantise(kept, bits, args.quant, args.db_range)
                y = series.resynth(kept, len(x))
                steps.append(Step(mode, phase, bits, count, highest, y))
                prog.advance(task)

    width = len(str(len(coeffs)))
    audio.write(str(out_dir / "original.wav"), x, sr)
    for step in steps:
        audio.write(str(out_dir / f"{step.label}-{step.count:0{width}d}.wav"), _unclip(step.y), sr)

    # All steps back to back, then the original: the audio version of the llama animation.
    # Skipped for long clips, where it would run to hours.
    if len(x) <= PROGRESSION_MAX_SECONDS * sr:
        gap = np.zeros(int(sr * 0.5))
        for label in dict.fromkeys(step.label for step in steps):
            parts = [part for step in steps if step.label == label for part in (step.y, gap)]
            audio.write(
                str(out_dir / f"progression-{label}.wav"), _unclip(np.concatenate(parts + [x])), sr
            )

    seconds = len(x) / sr
    console.print(
        f"\n{len(x):,} samples at {sr} Hz ({seconds:.2f}s) -> "
        f"{len(coeffs):,} coefficients, bin spacing {sr / len(x):.3g} Hz"
    )
    table = Table(title="Rebuilding from N coefficients")
    table.add_column("version")
    table.add_column("N", justify="right")
    table.add_column("% coeffs", justify="right")
    table.add_column("top Hz", justify="right")
    table.add_column("energy", justify="right")
    table.add_column("peak", justify="right")
    table.add_column("SNR dB", justify="right")
    table.add_column("kbps", justify="right")
    signal_power = np.mean(x**2)
    for step in steps:
        peak = np.max(np.abs(step.y))
        table.add_row(
            step.label,
            f"{step.count:,}",
            f"{step.count / len(coeffs):.1%}",
            f"{step.highest_hz:,.0f}",
            f"{np.mean(step.y**2) / signal_power:.0%}",
            f"[red]{peak:.2f}[/]" if peak > 1 else f"{peak:.2f}",
            f"{series.compare(x, step.y)['snr_db']:.1f}",
            f"{step.kbps(len(coeffs), seconds):,.0f}",
        )
    console.print(table)
    console.print(f"Original peak {np.max(np.abs(x)):.2f}. For scale, a typical MP3 is 128 kbps.")
    if any(np.max(np.abs(step.y)) > 1 for step in steps):
        console.print("[red]Red[/] peaks would clip, so those WAVs were scaled down to peak 1.0.")
    console.print(f"WAVs written to [bold]{out_dir}/[/]")


def _unclip(y: np.ndarray) -> np.ndarray:
    """Scale down a signal that would clip on playback; leave others alone."""
    peak = np.max(np.abs(y))
    return y / peak if peak > 1 else y


def _report(x, sr, coeffs, rebuilt, rows, out_dir: Path) -> None:
    console.print(
        f"\n{len(x):,} samples at {sr} Hz ({len(x) / sr:.2f}s) -> "
        f"{len(coeffs):,} coefficients = {2 * len(coeffs):,} knobs "
        f"(bin spacing {sr / len(x):.3g} Hz)"
    )

    timing = Table(title="Timing")
    timing.add_column("stage")
    timing.add_column("seconds", justify="right")
    for stage, secs in rows:
        timing.add_row(stage, f"{secs:.3f}")
    console.print(timing)

    errors = Table(title="Round-trip error")
    errors.add_column("method")
    errors.add_column("max |error|", justify="right")
    errors.add_column("SNR (dB)", justify="right")
    for method, y in rebuilt.items():
        m = series.compare(x, y)
        errors.add_row(method, f"{m['max_abs_error']:.3e}", f"{m['snr_db']:.1f}")
    console.print(errors)
    console.print(f"WAVs written to [bold]{out_dir}/[/]")


def _add_clip_args(p: argparse.ArgumentParser) -> None:
    """Arguments shared by every subcommand that works on a clip."""
    p.add_argument("input", nargs="?", help="audio file (MP3/OGG/WAV/FLAC); omit for a test signal")
    p.add_argument("--seconds", type=float, help="clip length from the start (default: whole file, or 1s of test signal)")
    p.add_argument("--channel", choices=["mix", "left", "right"], default="mix")
    p.add_argument("--test", choices=list(audio.TEST_SIGNALS), default="tone",
                   help="test signal to use when no file is given: steady tone, or plucked notes after silence")
    p.add_argument("--sr", type=int, default=44100, help="sample rate for the test signal")


def _count_list(text: str) -> list[str]:
    """Comma-separated counts: whole numbers, or percentages like '0.1%'.

    Percentages can't be turned into counts until the clip is analysed, so
    they're kept as strings here and resolved by _resolve_count.
    """
    specs = text.split(",")
    for spec in specs:
        try:
            _resolve_count(spec, 1)
        except ValueError:
            raise argparse.ArgumentTypeError(f"not a count or percentage: {spec!r}")
    return specs


def _resolve_count(spec: str, total: int) -> int:
    if spec.endswith("%"):
        return round(total * float(spec[:-1]) / 100)
    return int(spec)


def _bits_list(text: str) -> list[int | None]:
    """Comma-separated bits per knob; 'float' means unquantised."""
    out: list[int | None] = []
    for part in text.split(","):
        if part == "float":
            out.append(None)
        elif part.isdigit() and int(part) >= 1:
            out.append(int(part))
        else:
            raise argparse.ArgumentTypeError(f"bits must be a whole number >= 1 or 'float': {part!r}")
    return out


def _phase_list(text: str) -> list[str]:
    phases = text.split(",")
    for phase in phases:
        if phase not in series.PHASES:
            raise argparse.ArgumentTypeError(
                f"unknown phase {phase!r}; choose from {', '.join(series.PHASES)}"
            )
    return phases


def main() -> None:
    parser = argparse.ArgumentParser(prog="fourier", description=__doc__)
    sub = parser.add_subparsers(required=True)

    p = sub.add_parser("tone", help="write the synthetic test tone to a WAV")
    p.add_argument("out")
    p.add_argument("--seconds", type=float, default=1.0)
    p.add_argument("--sr", type=int, default=44100)
    p.set_defaults(func=cmd_tone)

    p = sub.add_parser(
        "roundtrip", help="analyse then resynthesise a clip, and report the error"
    )
    _add_clip_args(p)
    p.add_argument("--method", choices=["fft", "literal", "both"], default="fft",
                   help="literal sums one cosine per coefficient: slow, but it is the knob box")
    p.add_argument("--out-dir", default="out/roundtrip")
    p.set_defaults(func=cmd_roundtrip)

    p = sub.add_parser(
        "sweep", help="rebuild a clip from N of its coefficients, for several N"
    )
    _add_clip_args(p)
    p.add_argument("--select", choices=["first", "top", "both"], default="first",
                   help="first N coefficients (low-pass), the N largest, or both for comparison")
    p.add_argument("--counts", type=_count_list, default=["1", "10", "100", "1000", "10000", "100000"],
                   help="comma-separated values of N, as counts or percentages of all coefficients, "
                        "e.g. 100,0.1%%,10%% (default: 1,10,100,1000,10000,100000)")
    p.add_argument("--phase", type=_phase_list, default=["keep"],
                   help="comma-separated phase treatments: keep, zero, random (default: keep)")
    p.add_argument("--seed", type=int, default=0, help="random seed for --phase random")
    p.add_argument("--bits", type=_bits_list, default=[None],
                   help="comma-separated bits per knob (magnitude and phase each), "
                        "or 'float' for unquantised, e.g. float,16,8,4 (default: float)")
    p.add_argument("--quant", choices=series.QUANT_SCALES, default="log",
                   help="magnitude quantisation: log (dB steps) or linear (default: log)")
    p.add_argument("--db-range", type=float, default=96.0,
                   help="dB below the loudest coefficient covered by log quantisation (default: 96)")
    p.add_argument("--fade-ms", type=float, default=5.0,
                   help="fade the clip's ends so the loop seam doesn't click (0 to disable)")
    p.add_argument("--out-dir", default="out/sweep")
    p.set_defaults(func=cmd_sweep)

    args = parser.parse_args()
    args.func(args)
