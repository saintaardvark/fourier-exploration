"""Command-line entry point."""

import argparse
import time
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
        task = prog.add_task("Generating test tone", total=1)
        sr = args.sr
        x = audio.test_tone(args.seconds or 1.0, sr)
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


def cmd_sweep(args: argparse.Namespace) -> None:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with _progress() as prog:
        x, sr = _load_clip(args, prog)
        x = audio.fade(x, sr, args.fade_ms)

        task = prog.add_task("Analysing (FFT)", total=1)
        coeffs = series.analyse(x)
        prog.update(task, completed=1)

        counts = sorted({min(c, len(coeffs)) for c in args.counts})
        task = prog.add_task(f"Resynthesising {len(counts)} steps", total=len(counts))
        steps = []  # (count, rebuilt signal)
        for count in counts:
            steps.append((count, series.resynth(series.first_n(coeffs, count), len(x))))
            prog.advance(task)

    width = len(str(len(coeffs)))
    audio.write(str(out_dir / "original.wav"), x, sr)
    for count, y in steps:
        audio.write(str(out_dir / f"first-{count:0{width}d}.wav"), y, sr)

    # All steps back to back, then the original: the audio version of the llama animation.
    # Skipped for long clips, where it would run to hours.
    if len(x) <= PROGRESSION_MAX_SECONDS * sr:
        gap = np.zeros(int(sr * 0.5))
        progression = np.concatenate([part for _, y in steps for part in (y, gap)] + [x])
        audio.write(str(out_dir / "progression.wav"), progression, sr)

    console.print(
        f"\n{len(x):,} samples at {sr} Hz ({len(x) / sr:.2f}s) -> "
        f"{len(coeffs):,} coefficients, bin spacing {sr / len(x):.3g} Hz"
    )
    table = Table(title="First-N coefficients")
    table.add_column("N", justify="right")
    table.add_column("knobs", justify="right")
    table.add_column("up to (Hz)", justify="right")
    table.add_column("energy kept", justify="right")
    table.add_column("SNR (dB)", justify="right")
    signal_power = np.mean(x**2)
    for count, y in steps:
        table.add_row(
            f"{count:,}",
            f"{2 * count:,}",
            f"{(count - 1) * sr / len(x):,.1f}",
            f"{np.mean(y**2) / signal_power:.1%}",
            f"{series.compare(x, y)['snr_db']:.1f}",
        )
    console.print(table)
    console.print(f"WAVs written to [bold]{out_dir}/[/]")


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
    p.add_argument("input", nargs="?", help="audio file (MP3/OGG/WAV/FLAC); omit for the test tone")
    p.add_argument("--seconds", type=float, help="clip length from the start (default: whole file, or 1s of tone)")
    p.add_argument("--channel", choices=["mix", "left", "right"], default="mix")
    p.add_argument("--sr", type=int, default=44100, help="sample rate for the test tone")


def _int_list(text: str) -> list[int]:
    return [int(part) for part in text.split(",")]


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
        "sweep", help="rebuild a clip from its first N coefficients, for several N"
    )
    _add_clip_args(p)
    p.add_argument("--counts", type=_int_list, default=[1, 10, 100, 1000, 10000, 100000],
                   help="comma-separated values of N (default: 1,10,100,1000,10000,100000)")
    p.add_argument("--fade-ms", type=float, default=5.0,
                   help="fade the clip's ends so the loop seam doesn't click (0 to disable)")
    p.add_argument("--out-dir", default="out/sweep")
    p.set_defaults(func=cmd_sweep)

    args = parser.parse_args()
    args.func(args)
