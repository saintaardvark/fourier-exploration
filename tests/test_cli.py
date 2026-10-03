import argparse

import pytest

from fourier.cli import _count_list, _resolve_count


def test_counts_accept_percentages():
    specs = _count_list("10,0.1%,50%")
    assert [_resolve_count(s, 10_000) for s in specs] == [10, 10, 5000]


def test_counts_reject_junk():
    with pytest.raises(argparse.ArgumentTypeError):
        _count_list("10,lots")
