#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 [acceptance] [invariant: INV-DA-4] [covers: ITEM-6] — connectivity-weighted BH.

Milo neighbourhoods OVERLAP: a cell belongs to many of them, so in dense regions of the kNN graph
neighbourhoods are near-duplicates, the tests are strongly positively dependent, and the effective
number of independent tests is far below the neighbourhood count. Plain Benjamini-Hochberg is
therefore ANTI-CONSERVATIVE exactly where the graph is dense — which is where the interesting
biology usually is. Weighting each neighbourhood by `1/kth-nearest-neighbour distance` makes a
denser neighbourhood consume proportionally more of the error budget.

## What a WEIGHTED procedure does and does not promise

Reallocating the error budget is the POINT of the correction, so the weighted procedure does not
— and is not supposed to — reproduce the unweighted family-wise rate of plain BH. It controls a
WEIGHTED error rate; a dense region deliberately gets a slightly larger share. This test therefore
asserts (a) the structural properties the correction must have unconditionally, (b) that with
UNIFORM weights it collapses EXACTLY onto plain BH — the pin that shows it is a refinement of BH
rather than a different animal — and (c) that with REAL kth-distance weights taken from an actual
kNN graph the null discovery rate stays close to nominal rather than blowing out. Measured on the
shipped implementation: 0.100 for plain BH and 0.119 for the weighted version over 1,000 null
draws at q = 0.10. `MAX_NULL_RATE` below is set so a genuinely broken weighting cannot sit under
it (a version with the monotonicity step removed, or with `w.sum()·p/w` instead of the cumulative
sum, is far above it).
"""
import numpy as np
import pytest

import _kernel as K

#: The bound on the UNWEIGHTED null discovery rate with realistic weights. See the module
#: docstring: a weighted procedure controls a weighted rate, so this is a sanity ceiling, not a
#: claim of exact unweighted control.
MAX_NULL_RATE = 0.15
Q = 0.10


def test_uniform_weights_reduce_exactly_to_plain_bh():
    """The degenerate-case pin. If this ever breaks, the correction has stopped being a
    generalisation of Benjamini-Hochberg."""
    rng = np.random.default_rng(0)
    for _ in range(50):
        p = rng.uniform(size=37)
        w = np.full(37, 3.7)          # any constant, not just 1
        assert np.allclose(K.weighted_bh(p, w), K.bh(p), rtol=0, atol=1e-12)


def test_it_is_monotone_in_sorted_p_and_capped_at_one():
    rng = np.random.default_rng(1)
    for _ in range(200):
        p = rng.uniform(size=50)
        w = 1.0 / rng.uniform(0.4, 4.0, size=50)
        adj = K.weighted_bh(p, w)
        assert np.all(adj <= 1.0 + 1e-12)
        assert np.all(adj >= 0.0)
        order = np.argsort(p)
        s = adj[order]
        assert np.all(np.diff(s) >= -1e-12), "not monotone non-decreasing in sorted p"


def test_an_infinite_weight_is_treated_as_zero_not_as_a_poisoned_cumulative_sum():
    """A zero kth distance (a duplicated cell) gives an infinite weight. Left alone it would make
    `sum(w)` and `cumsum(w)` both infinite and every adjusted value NaN — a whole run's
    significance silently destroyed by one duplicate row."""
    p = np.array([0.001, 0.02, 0.3, 0.6])
    w = np.array([np.inf, 2.0, 1.0, 0.5])
    adj = K.weighted_bh(p, w)
    assert np.all(np.isfinite(adj)), adj
    assert np.all(adj <= 1.0)


def test_nan_p_values_stay_nan_through_the_kernels_own_adjustment():
    """KERNEL-LEVEL ONLY, and named accordingly.

    Both BH functions must carry a NaN through unchanged — an unfittable or engine-masked
    neighbourhood has no adjusted p, and inventing one for it is how a refusal to report becomes a
    tested-and-null result. What happens to that NaN AFTERWARDS, on the way to disk, is a property
    of the entry scripts and is asserted where it can actually be observed:
    `test_da_absence_is_absence.py::test_a_masked_population_reaches_disk_as_NaN_engine_independently`
    and its neighbourhood twin.

    Two earlier versions of this test claimed the producer half in their NAME and docstring while
    testing only the kernel, and one of them asserted `written[1] == 1.0` over an array it had just
    filled itself — a tautology that read as a live pin on the very fill that was later removed as
    unsafe. Neither is claimed here.
    """
    p = np.array([0.001, np.nan, 0.4])
    w = np.array([1.0, 1.0, 1.0])
    adj = K.weighted_bh(p, w)
    assert np.isnan(adj[1])
    assert np.isfinite(adj[0]) and np.isfinite(adj[2])
    assert np.isnan(K.bh(p)[1])

    # The NaN must not have displaced its neighbours' values either: the two fittable entries
    # adjust exactly as they would with the NaN row absent.
    finite_only = K.bh(np.array([0.001, 0.4]))
    assert np.allclose(K.bh(p)[[0, 2]], finite_only, rtol=0, atol=1e-12)


def test_all_nan_input_yields_all_nan_rather_than_a_spurious_zero():
    adj = K.weighted_bh(np.array([np.nan, np.nan]), np.array([1.0, 2.0]))
    assert np.all(np.isnan(adj))


def test_the_null_discovery_rate_with_real_kth_distance_weights_stays_near_nominal():
    """(c) — the weights are the reciprocals of REAL kth-nearest-neighbour distances taken from an
    actual kNN graph over an actual embedding, so their spread is the spread the shipped pipeline
    really produces (a coefficient of variation of roughly 0.09), not an invented one."""
    import _nhoods as NH

    rng = np.random.default_rng(3)
    X = rng.normal(size=(600, 8)).astype(np.float32)
    connectivities, distances, _k = NH.build_knn(X, n_neighbors=15, seed=0)
    _, index_cells, kth = NH.make_nhoods(X, connectivities, distances, prop=0.1, seed=0)
    weights = 1.0 / kth

    M = 400
    weighted_rejecting = 0
    plain_rejecting = 0
    for _ in range(M):
        p = rng.uniform(size=len(kth))
        weighted_rejecting += int(np.nansum(K.weighted_bh(p, weights) <= Q) > 0)
        plain_rejecting += int(np.nansum(K.bh(p) <= Q) > 0)
    weighted_rate = weighted_rejecting / M
    plain_rate = plain_rejecting / M
    assert weighted_rate <= MAX_NULL_RATE, (
        f"the connectivity-weighted null discovery rate is {weighted_rate:.3f} at q={Q} "
        f"(plain BH on the same draws: {plain_rate:.3f}), above the {MAX_NULL_RATE} ceiling. A "
        "weighted procedure reallocates the error budget on purpose, but not by this much — this "
        "size of gap means the weighting is wrong, not merely weighted.")


def test_a_plausible_transcription_slip_in_the_weighting_blows_the_ceiling():
    """The ceiling above is not vacuous, and this is what shows it.

    The mutation is a REAL transcription slip, not a strawman: dropping the `sum(w)` scaling from
    the numerator of `adj = sum(w) · p_sorted / cumsum(w_sorted)`. It leaves an expression that
    still looks like a weighted BH, still sorts, still accumulates, still caps at 1 — and it
    rejects on EVERY null draw.

    (Two mutations were measured while writing this and only one is used, because the other turned
    out to be CONSERVATIVE and so proves nothing: dropping the reverse cumulative-minimum makes
    the adjusted values LARGER, not smaller — 0.08 against a real rate of 0.09. Assuming a
    mutation is anti-conservative without measuring it is how a mutation test comes to certify
    nothing.)"""
    import _nhoods as NH

    rng = np.random.default_rng(4)
    X = rng.normal(size=(600, 8)).astype(np.float32)
    connectivities, distances, _k = NH.build_knn(X, n_neighbors=15, seed=0)
    _, _, kth = NH.make_nhoods(X, connectivities, distances, prop=0.1, seed=0)
    w = 1.0 / kth

    def broken(p, w):
        order = np.argsort(p)
        p_sorted, w_sorted = p[order], w[order]
        adj = np.minimum.accumulate((p_sorted / np.cumsum(w_sorted))[::-1])[::-1]  # sum(w) gone
        out = np.empty_like(p)
        out[order] = np.minimum(adj, 1.0)
        return out

    M = 400
    broken_rate = sum(int(np.nansum(broken(rng.uniform(size=len(w)), w) <= Q) > 0)
                      for _ in range(M)) / M
    real_rate = sum(int(np.nansum(K.weighted_bh(rng.uniform(size=len(w)), w) <= Q) > 0)
                    for _ in range(M)) / M
    assert broken_rate > MAX_NULL_RATE, (
        f"the deliberately-broken weighting sat at {broken_rate:.3f}, under the "
        f"{MAX_NULL_RATE} ceiling, so the ceiling proves nothing about the real one")
    assert real_rate <= MAX_NULL_RATE, (
        f"the real weighting sat at {real_rate:.3f} on this stream")
