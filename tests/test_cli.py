import argparse

import pytest

from fourier.cli import _count_list, _resolve_count


def test_counts_accept_percentages():
    specs = _count_list("10,0.1%,50%")
    assert [_resolve_count(s, 10_000) for s in specs] == [10, 10, 5000]


def test_counts_reject_junk():
    with pytest.raises(argparse.ArgumentTypeError):
        _count_list("10,lots")


def test_bits_list():
    from fourier.cli import _bits_list
    assert _bits_list("float,8,4") == [None, 8, 4]
    with pytest.raises(argparse.ArgumentTypeError):
        _bits_list("0")


def test_kbps_counts_bin_indices_only_for_top():
    import numpy as np
    from fourier.cli import Step
    # 1,000 coefficients of 2x8 bits over 1 s = 16 kbps; top adds log2(1024) = 10 bits each.
    first = Step("first", "keep", 8, 1000, 0.0, np.zeros(1))
    top = Step("top", "keep", 8, 1000, 0.0, np.zeros(1))
    assert first.kbps(1024, 1.0) == 16
    assert top.kbps(1024, 1.0) == 26
