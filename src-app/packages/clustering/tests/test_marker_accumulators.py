#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 [acceptance] [invariant: INV-9] [covers: ITEM-8] — the per-cluster mean/variance
accumulator in the marker path is float64, and its error at a 10⁷-value synthetic column
stays under the float32 0.29% bound.

This is a UNIT test on the real production accumulator (`_markers.cluster_mean_var`, the one
`compute_markers` calls for every emitted top marker), not a re-implementation. The synthetic
column is a catastrophic-cancellation stress: a large mean (30000) with a tiny true variance
(1.0), where `E[x²] − E[x]²` in float32 loses the low bits (the "1" sits below the float32 ulp
of x² ≈ 9e8) and returns garbage, while float64 recovers it. The float32 path is the NEGATIVE
control that proves the dtype choice matters.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

# import the real accumulator off the compute dir (staged into /code in the sandbox).
_COMPUTE = Path(__file__).resolve().parents[1] / "compute"
sys.path.insert(0, str(_COMPUTE))
from _markers import cluster_mean_var  # noqa: E402

_N = 10_000_000            # 10⁷ values, per INV-9
_MEAN = 30000.0            # a large offset — the source of the float32 cancellation
_BOUND = 0.0029           # the float32 0.29% error bound the doc names


def _synthetic_column():
    """A 10⁷-value column alternating 30000±1 → true mean 30000, true (population) variance
    exactly 1.0. Values are integers < 2²⁴ so they are EXACT in float32 (the error is in the
    ACCUMULATION, not the storage) — an honest float32-vs-float64 comparison."""
    x = np.empty(_N, dtype=np.float64)
    x[0::2] = _MEAN - 1.0
    x[1::2] = _MEAN + 1.0
    return x


def test_accumulator_is_float64_and_within_the_float32_error_bound():
    x = _synthetic_column()
    codes = np.zeros(_N, dtype=np.intp)     # one cluster
    means, var = cluster_mean_var(x, codes, 1)

    # (a) the accumulator is float64.
    assert means.dtype == np.float64
    assert var.dtype == np.float64

    # (b) float64 recovers the true mean (30000) and variance (1.0) to well within 0.29%.
    assert abs(means[0] - _MEAN) / _MEAN < _BOUND
    true_var = 1.0
    assert abs(var[0] - true_var) / true_var < _BOUND


def test_negative_control_naive_float32_blows_the_bound():
    """The dtype choice is load-bearing: the SAME identity in float32 loses the variance
    entirely (catastrophic cancellation), so a mutation that dropped to float32 would ship a
    wrong fold-change. This proves INV-9 is not vacuous."""
    x = _synthetic_column()
    xf = x.astype(np.float32)
    # naive float32: E[x²] − E[x]², every accumulation kept in float32.
    ex = (xf.sum(dtype=np.float32) / np.float32(_N))
    ex2 = ((xf * xf).sum(dtype=np.float32) / np.float32(_N))   # xf*xf is float32
    var_f32 = float(ex2) - float(ex) * float(ex)
    true_var = 1.0
    # float32 is wildly off (the low bit is gone) — its relative error dwarfs the 0.29% bound.
    assert abs(var_f32 - true_var) / true_var > _BOUND

    # and the float64 accumulator, on the identical column, stays inside the bound (the
    # A/B that pins the dtype as the cause).
    _means, var64 = cluster_mean_var(x, np.zeros(_N, dtype=np.intp), 1)
    assert abs(var64[0] - true_var) / true_var < _BOUND


def test_empty_cluster_is_nan_never_a_fabricated_zero():
    # a cluster with no cells is NaN (uncomputable), never a fabricated 0 mean/variance —
    # a 0 is a different claim, and the one a downstream fold-change would act on.
    x = np.array([1.0, 2.0, 3.0, 4.0], dtype=np.float64)
    codes = np.array([0, 0, 0, 0], dtype=np.intp)   # nothing in cluster 1
    means, var = cluster_mean_var(x, codes, 2)
    assert not np.isnan(means[0]) and not np.isnan(var[0])
    assert np.isnan(means[1]) and np.isnan(var[1])
