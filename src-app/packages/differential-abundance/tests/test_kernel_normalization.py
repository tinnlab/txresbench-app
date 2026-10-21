#!/usr/bin/env python3
# ruff: noqa
"""TEST-3 [covers: ITEM-5] — the normalization is ONE thing, computed ONCE, shared by both engines.

The compositional claim of this package rests on the SIZE FACTORS, not on which negative-binomial
engine fits the mean model. That is what lets the acceptance battery prove INV-DA-1 on a
deployment where the `pydeseq2` wheel is absent — but only if the two engines really do normalize
identically. This test is what makes that "only if" true rather than asserted:

  · our `poscounts_size_factors` equals PyDESeq2's OWN internally-fitted `size_factors` to 1e-10
    on the same matrix (so handing the NB-GLM `log(sf)` as an offset is the same normalization
    PyDESeq2 applies internally, not a lookalike);
  · our `reference_size_factors` is exactly `count_ref / geomean(count_ref)` — the additive
    log-ratio, by construction;
  · the two engines agree on the SIGN and the rank order of the effects for the same input.
"""
import numpy as np
import pytest

import sim
import _kernel as K
from engines import ENGINES, kernel_fail

#: Applied inside the two tests that actually drive PyDESeq2, NOT at module scope. A module-level
#: `importorskip` takes the WHOLE file down, and round R1 found it doing exactly that to
#: `test_reference_size_factors_are_exactly_the_additive_log_ratio` and to
#: `test_poscounts_is_robust_to_a_minority_shift_and_that_is_the_whole_point` — the latter
#: described in its own docstring as "the property the negative control depends on, isolated".
#: Neither imports pydeseq2, and both are exactly the engine-independent evidence a host without
#: the wheel most needs to see.
_PYDESEQ2_REASON = (
    "this compares OUR arithmetic against PyDESeq2's own, so it needs the wheel that is pinned in "
    "env-rootfs/single-cell/requirements.txt. The invariant it supports is proven independently "
    "by the acceptance battery on the always-present NB-GLM arm.")


def test_our_poscounts_size_factors_equal_pydeseq2s_own():
    pytest.importorskip("pydeseq2", reason=_PYDESEQ2_REASON)

    from pydeseq2.dds import DeseqDataSet

    counts, samples, conditions, _ = sim.shifted_counts(seed=7)
    counts_df, design_df, _ = sim.counts_frame(counts, samples, conditions)
    ours = K.poscounts_size_factors(counts_df.values, fail=_raise)

    meta = design_df.copy()
    meta["condition"] = meta["condition"].astype("category")
    dds = DeseqDataSet(counts=counts_df.astype(int), metadata=meta, design="~condition",
                       refit_cooks=True, size_factors_fit_type="poscounts", quiet=True)
    dds.fit_size_factors()
    theirs = K.engine_size_factors(dds)

    assert np.max(np.abs(ours - theirs)) < 1e-10, (
        f"our poscounts size factors diverge from PyDESeq2's own "
        f"(max |Δ| = {np.max(np.abs(ours - theirs)):.3e}). The NB-GLM arm would then be testing "
        "under a DIFFERENT normalization than the PyDESeq2 arm, and the acceptance battery's "
        "cross-engine claim would be false.")


def test_reference_size_factors_are_exactly_the_additive_log_ratio():
    counts, samples, conditions, _ = sim.shifted_counts(seed=8)
    col = counts[:, 5].astype(np.float64)
    ours = K.reference_size_factors(counts, 5, fail=_raise, ref_name="pop5")
    expected = col / np.exp(np.mean(np.log(col)))
    assert np.allclose(ours, expected, rtol=0, atol=1e-12)
    # geometric mean 1, so the offset is centred and the effects are relative to the reference.
    assert abs(np.exp(np.mean(np.log(ours))) - 1.0) < 1e-12


def test_poscounts_is_robust_to_a_minority_shift_and_that_is_the_whole_point():
    """The property the negative control depends on, isolated: multiplying ONE population's counts
    on one side must not move the size factors, because a median of ratios does not follow a
    minority. If this stopped holding, the estimator would inherit the compositional confounding
    and the negative control would go red — this test says WHY."""
    counts, samples, conditions, shifted = sim.shifted_counts(seed=9, shift=1.0)
    base = K.poscounts_size_factors(counts, fail=_raise)
    bumped = counts.copy()
    treated = np.array([c == "treat" for c in conditions])
    bumped[treated, shifted] *= 8
    after = K.poscounts_size_factors(bumped, fail=_raise)
    assert np.max(np.abs(np.log(after / base))) < 0.05, (
        "an 8x shift in ONE of 12 populations moved the robust size factors by more than 5% — "
        "the median of ratios is supposed to be unmoved by a minority")


@pytest.mark.parametrize("engine", ENGINES)
def test_the_fit_record_names_the_normalization_the_engine_and_the_design_formula(engine):
    counts, samples, conditions, _ = sim.shifted_counts(seed=10)
    counts_df, design_df, _ = sim.counts_frame(counts, samples, conditions)
    _, record = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                      method=engine, normalization=K.POSCOUNTS, fail=kernel_fail)
    assert record["normalization"] == K.POSCOUNTS
    assert record["assumption"] == K.NORMALIZATION_ASSUMPTION[K.POSCOUNTS]
    assert record["method"] == engine
    assert record["design_formula"] == "~condition"
    assert record["contrast"] == ["treat", "ctrl"]
    assert len(record["size_factors"]) == counts_df.shape[0]


def test_both_engines_agree_on_sign_and_ranking():
    if len(ENGINES) < 2:
        pytest.skip("only one count-model engine is installed here; there is nothing to compare")
    counts, samples, conditions, shifted = sim.shifted_counts(seed=11, shift=4.0)
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
    effects = {}
    for engine in ENGINES:
        results, _ = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                           method=engine, normalization=K.POSCOUNTS, fail=kernel_fail)
        effects[engine] = np.array([results[p]["logFC"] for p in populations])
    a, b = (effects[e] for e in ENGINES[:2])
    assert np.argmax(a) == np.argmax(b) == shifted
    big = np.abs(a) > 0.5
    assert np.all(np.sign(a[big]) == np.sign(b[big])), "the engines disagree on a sign"


def _raise(message, code=2):
    raise AssertionError(message)


def test_a_p_value_the_engine_MASKED_is_not_resurrected_by_the_small_sample_correction():
    """TEST-26 [covers: ITEM-5] — The regression test for the highest-severity defect this package's review found.

    `DeseqStats.summary()` runs Cook's-distance filtering: for a population whose fit is driven by
    a single outlying sample it sets `pvalue` to NaN — a deliberate refusal to report — while
    leaving `stat` FINITE. The small-sample correction recomputes the p from `stat`, and if it did
    so for every row it would hand those masked rows a fresh, finite p and let an outlier-driven
    population become a discovery. The engine's own refusal, silently undone, on the DEFAULT path.

    The masking is not exotic: DESeq2 replaces outliers only when a group has at least
    `min_replicates` (7) samples, so BELOW that — which is exactly the 5-per-side shape the
    acceptance battery and most real designs have — it masks instead. Verified reachable here: the
    fixture below makes the engine mask exactly one population.
    """
    pytest.importorskip("pydeseq2", reason=_PYDESEQ2_REASON)

    from pydeseq2.dds import DeseqDataSet
    from pydeseq2.ds import DeseqStats

    counts, samples, conditions = sim.null_counts(seed=42, n_per_side=5)
    counts = counts.copy()
    counts[0, 3] *= 100                       # one wildly outlying sample, one population
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)

    meta = design_df.copy()
    meta["condition"] = meta["condition"].astype(str).astype("category")
    dds = DeseqDataSet(counts=counts_df.astype(int), metadata=meta, design="~condition",
                       refit_cooks=True, size_factors_fit_type="poscounts", quiet=True)
    dds.deseq2()
    stats = DeseqStats(dds, contrast=["condition", "treat", "ctrl"], quiet=True)
    stats.summary()
    engine_p = stats.results_df["pvalue"].to_numpy(dtype=float)
    masked = np.isnan(engine_p)
    assert masked.any(), (
        "the fixture no longer triggers the engine's Cook's masking, so this test would pass "
        "vacuously — pick a harsher outlier or fewer replicates")
    # the statistic IS finite for the masked row, which is exactly what makes the defect possible
    assert np.all(np.isfinite(stats.results_df["stat"].to_numpy(dtype=float)[masked]))

    results, record = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                            method="pydeseq2", normalization=K.POSCOUNTS,
                            small_sample_correction=True, fail=kernel_fail)
    assert record["small_sample_correction"] is True
    ours = np.array([results[p]["pval"] for p in populations])
    assert np.all(np.isnan(ours[masked])), (
        "a p-value the engine deliberately masked came back finite after the small-sample "
        "correction — an outlier-driven population can become a discovery")
    # …and the correction still did its job on every row the engine DID report
    assert np.all(np.isfinite(ours[~masked]))
