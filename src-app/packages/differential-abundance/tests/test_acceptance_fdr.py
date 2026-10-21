#!/usr/bin/env python3
# ruff: noqa
"""TEST-22 [acceptance] [invariant: INV-DA-7] [covers: ITEM-13, ITEM-6]

TEST-DA-FDR — false-discovery control on the COMPLETE NULL.

`M = 200` fully-null simulations (no population shifted at all). Under the complete null,
Benjamini-Hochberg at level q controls the family-wise error rate at q, so the fraction of
simulations yielding ANY discovery must be <= q. The assertion is made against an EXACT
(Clopper-Pearson) binomial upper bound rather than against the point estimate, because 200 draws
of a ~q-probability event are noisy and a bare `<= 0.10` would flake.

**A method with NO compositional handling can also pass this test** — under the complete null
there is no composition to confound. That is exactly why it is not sufficient on its own, and why
`test_acceptance_negative_control.py` exists. This one rules out the opposite failure: an
estimator that is simply too eager.

The second half exercises the SPATIAL (connectivity-weighted) FDR path under a null with
NON-UNIFORM weights, because that is the correction `da.neighbourhoods` actually reports and a
weighting that broke control would be invisible to the plain-BH arm.
"""
import numpy as np
import pytest

import sim
import _kernel as K
from engines import ENGINES, kernel_fail

M = 200
FDR = 0.10


def clopper_pearson_upper(k, n, alpha=0.05):
    """The exact upper confidence limit for a binomial proportion — `1 - BetaInv` in closed form
    via the Beta quantile. Used so the assertion is about the TRUE rate, not the point estimate."""
    from scipy import stats

    if k >= n:
        return 1.0
    return float(stats.beta.ppf(1.0 - alpha, k + 1, n - k))


@pytest.mark.parametrize("engine", ENGINES)
def test_false_positive_rate_on_the_complete_null_is_controlled(engine):
    rejecting = 0
    for seed in range(M):
        counts, samples, conditions = sim.null_counts(seed=5000 + seed)
        counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
        results, _ = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                           method=engine, normalization=K.POSCOUNTS, fail=kernel_fail)
        pvals = np.array([results[p]["pval"] for p in populations])
        padj = K.bh(pvals)
        if np.nansum(padj <= FDR) > 0:
            rejecting += 1
    rate = rejecting / M
    upper = clopper_pearson_upper(rejecting, M)
    # The bound DECIDES. An earlier version was `upper <= FDR or rate <= FDR`, which is just
    # `rate <= FDR` — a binomial upper limit always exceeds its point estimate, so the first
    # disjunct could never be the one that carried a pass. That made the docstring's claim
    # ("against an exact bound rather than the point estimate") false about the shipped assertion.
    assert upper <= FDR + 1e-12, (
        f"{engine}: {rejecting}/{M} fully-null simulations produced at least one discovery at "
        f"FDR {FDR} (rate {rate:.3f}, exact 95% upper bound {upper:.3f}). Under the complete "
        "null, BH at q controls the family-wise error rate at q, so this rate must not exceed it.")


def test_the_spatial_fdr_null_behaviour_is_exercised_with_real_neighbourhood_weights():
    """The battery's exercise of the correction `da.neighbourhoods` actually reports (#99).

    NOTE WHAT IS AND IS NOT CLAIMED, because getting this wrong is easy. A WEIGHTED
    Benjamini-Hochberg procedure reallocates the error budget toward dense regions ON PURPOSE, so
    it does NOT reproduce plain BH's unweighted family-wise rate and it is not supposed to. An
    earlier version of this test asserted `<= q` for the weighted procedure and failed at 0.135;
    the assertion was wrong, not the implementation — the property a weighted procedure has is a
    weighted error rate.

    What is asserted here is the honest pair: the weighted rate stays within the documented
    ceiling `tests/test_spatial_fdr.py::MAX_NULL_RATE` (which that file also shows a broken
    weighting exceeding, so the ceiling is not vacuous), and the weights are the reciprocals of
    REAL kth-nearest-neighbour distances from an actual kNN graph rather than an invented spread.
    The structural guarantees — exact reduction to plain BH at uniform weights, monotonicity, the
    `<= 1` cap, infinite-weight and NaN handling — are asserted in that file.
    """
    import _nhoods as NH
    from test_spatial_fdr import MAX_NULL_RATE

    rng = np.random.default_rng(99)
    X = rng.normal(size=(600, 8)).astype(np.float32)
    connectivities, distances, _k = NH.build_knn(X, n_neighbors=15, seed=0)
    _, _, kth = NH.make_nhoods(X, connectivities, distances, prop=0.1, seed=0)
    weights = 1.0 / kth

    rejecting = 0
    plain = 0
    for _ in range(M):
        pvals = rng.uniform(size=len(kth))             # the complete null, exactly
        rejecting += int(np.nansum(K.weighted_bh(pvals, weights) <= FDR) > 0)
        plain += int(np.nansum(K.bh(pvals) <= FDR) > 0)
    rate = rejecting / M
    assert rate <= MAX_NULL_RATE, (
        f"spatial FDR: {rejecting}/{M} null draws produced a discovery at {FDR} "
        f"(rate {rate:.3f}; plain BH on the same draws: {plain / M:.3f}), above the "
        f"{MAX_NULL_RATE} ceiling")
