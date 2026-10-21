#!/usr/bin/env python3
# ruff: noqa
"""TEST-5 [acceptance] [invariant: INV-5] [covers: ITEM-6] — the unit of replication is the
`(sample × group)` pseudobulk: raw counts are SUMMED per unit before the test, sub-`min_cells`
units are dropped, and the recorded unit is `pseudobulk` (never per-cell)."""
import types

import numpy as np

import _pseudobulk as PB


def _fail(msg):
    raise RuntimeError(msg)


def _dc():
    m = types.SimpleNamespace()
    m.get_pseudobulk = lambda *a, **k: None
    return m


def test_aggregates_raw_counts_to_sample_by_group_units():
    # 2 samples × 2 groups, 2 cells each. Summation is exact per (sample, group).
    counts = np.array([[1, 0], [2, 0],   # s0,g0
                       [0, 3], [0, 4],   # s0,g1
                       [5, 0], [6, 0],   # s1,g0
                       [0, 7], [0, 8]])  # s1,g1
    samples = ["s0", "s0", "s0", "s0", "s1", "s1", "s1", "s1"]
    groups = ["g0", "g0", "g1", "g1", "g0", "g0", "g1", "g1"]
    rec = PB.aggregate(counts, ["a", "b"], samples, groups, min_cells=1, dc=_dc(), fail=_fail)
    assert rec["unit"] == "pseudobulk" and rec["aggregation"] == "sum"
    cdf = rec["counts"]
    assert rec["n_pseudobulks"] == 4
    assert int(cdf.loc["s0__g0", "a"]) == 3   # 1+2
    assert int(cdf.loc["s1__g1", "b"]) == 15  # 7+8
    # ≥2 samples on each side of the contrast.
    assert rec["samples_per_group"]["g0"] == 2 and rec["samples_per_group"]["g1"] == 2


def test_drops_pseudobulks_below_min_cells_recorded_not_silent():
    counts = np.array([[1, 1], [2, 2], [3, 3]])
    samples = ["s0", "s0", "s1"]   # (s1,g0) has ONE cell
    groups = ["g0", "g0", "g0"]
    rec = PB.aggregate(counts, ["a", "b"], samples, groups, min_cells=2, dc=_dc(), fail=_fail)
    dropped = {(d["sample"], d["group"]) for d in rec["dropped"]}
    assert ("s1", "g0") in dropped                 # dropped, and RECORDED
    assert "s1__g0" not in rec["counts"].index     # not silently summed in


def test_absent_decoupler_is_a_named_refusal_not_an_import_error():
    import pytest
    with pytest.raises(RuntimeError) as e:
        PB.aggregate(np.zeros((2, 2)), ["a", "b"], ["s", "s"], ["g", "g"],
                     min_cells=1, dc=None, fail=_fail)
    assert "decoupler" in str(e.value)
