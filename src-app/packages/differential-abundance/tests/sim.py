#!/usr/bin/env python3
# ruff: noqa
"""sim — the COMMITTED, SEEDED simulation generator for the acceptance battery (#116).

Everything the behavioural battery asserts is generated here, from a seed, so a failure is
reproducible rather than a mystery. Three shapes:

  · `null_counts`        — no population shifted. Used for FDR control.
  · `shifted_counts`     — exactly one population's ABSOLUTE abundance multiplied. Used for
                           power AND for the negative control.
  · `naive_proportion_test` — the INVALID method, implemented here ON PURPOSE so the negative
                           control can run it on the same fixture and show it FAILING.

## Why the fixtures are built in ABSOLUTE terms

The compositional trap only exists if the simulation is honest about it. `shifted_counts`
multiplies ONE population's expected count and leaves every other population's expected count
EXACTLY WHERE IT WAS. Nothing else is touched. The consequence is arithmetic, not a modelling
choice: the per-sample TOTAL rises on the treated side, so every unchanged population's
PROPORTION falls even though its absolute abundance did not move. A method that tests proportions
must therefore report those unchanged populations as changed — that is not bad luck, it is what
the constraint forces — while a method that tests counts under robust size factors must not.

## Why `naive_proportion_test` lives in the TEST tree and nowhere else

It is the negative control, and the negative control is the only thing that makes the positive
half mean anything: a test a broken implementation would also pass is not a test. It is
deliberately NOT in `compute/` — there is no code path in the shipped package that can compute a
statistic from proportions, and `test_no_proportion_fallback.py` asserts that by source
inspection as well as behaviour.
"""
from __future__ import annotations

import numpy as np


#: The simulation's negative-binomial over-dispersion, `Var = mu + alpha*mu^2`. At the fixture's
#: base of 400 cells per population per sample this is a between-replicate CV of about 15%, which
#: is the realistic end of the range for cell-type abundance across donors. It is a CALIBRATED
#: choice and it is stated here because it changes what the tests can claim (DEC-13): at
#: `alpha = 0.1` a 2x shift with 5 replicates per side genuinely sits at roughly 20% power, so
#: demanding "recovered in >= 18/20 seeds" there would be asking the test to assert something
#: statistically false rather than something about this implementation.
DISPERSION = 0.02

#: The POWER fixture's true shift — the 2x the acceptance bar names.
POWER_SHIFT = 2.0

#: The NEGATIVE-CONTROL fixture's true shift. It is deliberately LARGE, and that is the point: the
#: compositional confounding a proportion test walks into is proportional to how much the total
#: moved, so the invalid method's FAILURE is only demonstrable in the strong-effect regime. That
#: regime is exactly what the invariant is about — "the bigger the real biology, the more
#: confident false positives the naive test manufactures". Measured on this fixture: our estimator
#: reports 0 false positives on every seed; the naive proportion test reports 10 or 11 of 11.
NEGATIVE_CONTROL_SHIFT = 8.0


def _size_factors(rng, n_samples, spread=0.3):
    """Per-sample capture-depth variation — a real property of the data and exactly what a
    normalization exists to absorb. Log-normal, centred so the geometric mean is 1."""
    s = np.exp(rng.normal(0.0, spread, size=n_samples))
    return s / np.exp(np.mean(np.log(s)))


def _nb(rng, mean, dispersion):
    """Negative-binomial draw with `Var = mu + dispersion·mu²` — the realistic over-dispersion a
    Poisson would understate, and the reason the model under test is negative-binomial."""
    mean = np.asarray(mean, dtype=np.float64)
    if dispersion <= 0:
        return rng.poisson(mean)
    r = 1.0 / dispersion
    p = r / (r + mean)
    return rng.negative_binomial(r, p)


def _design(n_per_side):
    return ([f"c{i}" for i in range(n_per_side)] + [f"t{i}" for i in range(n_per_side)],
            ["ctrl"] * n_per_side + ["treat"] * n_per_side)


def null_counts(*, n_populations=12, n_per_side=5, base=400.0, dispersion=DISPERSION, seed=0):
    """`(counts, samples, conditions)` with NO population shifted — the complete null."""
    rng = np.random.default_rng(seed)
    samples, conditions = _design(n_per_side)
    sf = _size_factors(rng, len(samples))
    mu = np.outer(sf, np.full(n_populations, base))
    counts = _nb(rng, mu, dispersion).astype(np.int64)
    return counts, samples, conditions


def shifted_counts(*, n_populations=12, n_per_side=5, base=400.0, dispersion=DISPERSION,
                   shift=NEGATIVE_CONTROL_SHIFT,
                   shifted_index=0, seed=0):
    """`(counts, samples, conditions, shifted_index)` where population `shifted_index` has its
    ABSOLUTE expected count multiplied by `shift` on the treated side and every OTHER population
    is left EXACTLY as it was.

    This is the compositional-confounding fixture: the unchanged populations' proportions fall
    mechanically because the total rose, and nothing was done to them."""
    rng = np.random.default_rng(seed)
    samples, conditions = _design(n_per_side)
    sf = _size_factors(rng, len(samples))
    mu = np.outer(sf, np.full(n_populations, base))
    treated = np.array([c == "treat" for c in conditions])
    mu[treated, shifted_index] *= float(shift)
    counts = _nb(rng, mu, dispersion).astype(np.int64)
    return counts, samples, conditions, shifted_index


def one_sided_counts(*, n_populations=12, n_per_side=5, base=400.0, dispersion=DISPERSION,
                     absent_index=0, absent_side="ctrl", seed=0):
    """`(counts, samples, conditions, absent_index)` where population `absent_index` has ZERO
    cells in EVERY sample of `absent_side`, and an ordinary abundance everywhere else.

    THE FIXTURE CLASS THAT WAS MISSING, and the reason the whole acceptance battery could not see
    the defect it now covers. Every other generator here multiplies a base of 400, so no committed
    fixture ever contained a zero on one side — and a population present in one condition and
    absent from the other is not an exotic input, it is the canonical differential-abundance
    DISCOVERY. Power, FDR control, negative control and parity were all blind to it by
    construction, not by oversight in any single assertion.

    Statistically this is a complete-separation MLE: the coefficient is maximised as it runs to
    infinity, so no finite Wald estimate exists and the honest answer is an ABSENT p-value.
    """
    rng = np.random.default_rng(seed)
    samples, conditions = _design(n_per_side)
    sf = _size_factors(rng, len(samples))
    mu = np.outer(sf, np.full(n_populations, base))
    counts = _nb(rng, mu, dispersion).astype(np.int64)
    on_absent_side = np.array([c == absent_side for c in conditions])
    counts[on_absent_side, absent_index] = 0
    assert counts[on_absent_side, absent_index].sum() == 0
    assert counts[~on_absent_side, absent_index].sum() > 0, (
        "the fixture must leave the population PRESENT on the other side, or it is an all-zero "
        "column rather than a separated one and tests a different thing entirely")
    return counts, samples, conditions, absent_index


def counts_frame(counts, samples, conditions, *, prefix="pop"):
    """The `(counts_df, design_df, population_ids)` triple `_kernel.fit` consumes."""
    import pandas as pd

    populations = [f"{prefix}{j}" for j in range(counts.shape[1])]
    counts_df = pd.DataFrame(counts, index=list(samples), columns=populations)
    design_df = pd.DataFrame({"condition": list(conditions)}, index=list(samples))
    return counts_df, design_df, populations


def bh(pvals):
    """Plain Benjamini-Hochberg, implemented here so the negative control's NAIVE arm does not
    borrow the shipped kernel's helper — the two halves must be independent for the comparison to
    mean anything."""
    p = np.asarray(pvals, dtype=np.float64)
    ok = ~np.isnan(p)
    adj = np.full(p.shape, np.nan)
    idx = np.where(ok)[0]
    if idx.size == 0:
        return adj
    ps = p[idx]
    order = np.argsort(ps)
    ranked = ps[order]
    m = ranked.size
    q = np.minimum.accumulate((ranked * m / np.arange(1, m + 1))[::-1])[::-1]
    out = np.empty(m)
    out[order] = np.clip(q, 0, 1)
    adj[idx] = out
    return adj


def naive_proportion_test(counts, conditions, g1="treat", g2="ctrl"):
    """THE INVALID METHOD — a per-population Welch t-test on per-sample PROPORTIONS, with BH
    across populations. Returns the BH-adjusted p per population.

    This is what a reasonable-looking implementation does, it runs perfectly, and it is
    statistically invalid: proportions are constrained to sum to 1, so an independent test per
    population is testing a quantity that MUST move when any other population moves. The
    acceptance battery runs it on the same fixture our estimator passes and asserts it FAILS —
    which is what makes our estimator's pass evidence of anything at all."""
    from scipy import stats

    counts = np.asarray(counts, dtype=np.float64)
    totals = counts.sum(axis=1, keepdims=True)
    props = np.divide(counts, np.where(totals > 0, totals, 1.0))
    cond = np.asarray([str(c) for c in conditions])
    a = props[cond == str(g1)]
    b = props[cond == str(g2)]
    pvals = np.array([stats.ttest_ind(a[:, j], b[:, j], equal_var=False).pvalue
                      for j in range(counts.shape[1])])
    return bh(pvals)
