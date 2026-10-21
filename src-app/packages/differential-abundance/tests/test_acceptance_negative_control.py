#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 [acceptance] [invariant: INV-DA-1] [invariant: INV-DA-7] [covers: ITEM-5, ITEM-13]

TEST-DA-NEGATIVE-CONTROL — the un-gameable one, and the centrepiece of the whole feature.

## Why this test exists in this shape

An invalid compositional test RUNS PERFECTLY. It returns plausible numbers, at plausible
significance levels, for populations that did not change — and a reader has no way to tell. So
"it runs" is not the bar, and neither is "our estimator reports few false positives", because a
BROKEN implementation can report few false positives on an easy fixture too.

The bar is two-sided, on ONE fixture:

  (a) our estimator reports <= 1 of the `P-1` genuinely-unchanged populations as significant at
      FDR 0.10, AND
  (b) the NAIVE per-population t-test on proportions — run BY THIS TEST, on the SAME counts, with
      its own independent Benjamini-Hochberg — reports >= 4 of them, i.e. it FAILS.

Half (b) is what makes half (a) mean anything. If the fixture were one the naive method also
passed, then passing it would say nothing about whether the compositional handling is real. A test
a broken implementation would also pass is not a test.

## The fixture

`sim.shifted_counts` multiplies exactly ONE population's ABSOLUTE expected abundance and leaves
every other population's ABSOLUTE expected abundance exactly where it was. Nothing else is
touched. The consequence is arithmetic: the per-sample TOTAL rises, so every unchanged
population's PROPORTION falls. A method that tests proportions MUST call those unchanged
populations changed. A method that tests counts under robust median-of-ratios size factors must
not, because a shift confined to a minority of populations does not move a median.

## Both arms must also find the real effect

Each arm additionally asserts the truly-shifted population IS recovered. Without that, an arm
that found nothing at all would pass the false-positive half trivially.
"""
import numpy as np
import pytest

import sim
import _kernel as K
from engines import ENGINES, kernel_fail

#: Seeds the control is asserted on. Every one of them, not a lucky one.
SEEDS = (0, 1, 2, 3, 4)

#: The bar, verbatim from the acceptance issue.
MAX_FALSE_POSITIVES_OURS = 1
MIN_FALSE_POSITIVES_NAIVE = 4
FDR = 0.10


def _fixture(seed):
    return sim.shifted_counts(seed=seed, shift=sim.NEGATIVE_CONTROL_SHIFT)


def _significant(padj):
    return np.asarray(padj) <= FDR


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("seed", SEEDS)
def test_our_estimator_holds_the_line_on_the_compositional_confounding_fixture(engine, seed):
    counts, samples, conditions, shifted = _fixture(seed)
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
    results, record = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                            method=engine, normalization=K.POSCOUNTS, fail=kernel_fail)
    pvals = np.array([results[p]["pval"] for p in populations])
    padj = K.bh(pvals)
    sig = _significant(padj)

    # The normalization is NAMED and its assumption recorded — INV-DA-1 is about the declaration
    # as much as the arithmetic.
    assert record["normalization"] == K.POSCOUNTS
    assert "MOST POPULATIONS ARE UNCHANGED" in record["assumption"]

    # (a) the unchanged populations are NOT called.
    false_positives = int(sig.sum() - (1 if sig[shifted] else 0))
    assert false_positives <= MAX_FALSE_POSITIVES_OURS, (
        f"{engine} seed={seed}: {false_positives} of the {len(populations) - 1} genuinely "
        f"unchanged populations were called significant at FDR {FDR}. Their ABSOLUTE abundance "
        "did not move; only their proportions did, mechanically, because another population "
        "rose. Calling them is the compositional failure this package exists to prevent.")

    # …and the arm is not passing by finding nothing.
    assert sig[shifted], (
        f"{engine} seed={seed}: the population that genuinely DID shift "
        f"({sim.NEGATIVE_CONTROL_SHIFT}x) was not recovered, so the false-positive count above "
        "proves nothing.")


@pytest.mark.parametrize("seed", SEEDS)
def test_the_naive_proportion_test_FAILS_the_same_fixture(seed):
    """The half that makes the other half mean something.

    This runs the INVALID method — an independent per-population Welch t-test on per-sample
    proportions, BH-adjusted across populations — on the SAME counts, with its own BH
    implementation so the two arms share no code. It must FAIL: report >= 4 of the 11 unchanged
    populations as significant. If this assertion ever stops holding, the fixture has stopped
    being a compositional-confounding fixture and the test above has stopped proving anything."""
    counts, samples, conditions, shifted = _fixture(seed)
    padj = sim.naive_proportion_test(counts, conditions)
    sig = _significant(padj)

    false_positives = int(sig.sum() - (1 if sig[shifted] else 0))
    assert false_positives >= MIN_FALSE_POSITIVES_NAIVE, (
        f"seed={seed}: the naive per-population proportion test reported only {false_positives} "
        f"false positives, below the {MIN_FALSE_POSITIVES_NAIVE} this control requires. The "
        "fixture is supposed to DEFEAT the naive method — if it no longer does, the estimator's "
        "clean result on the same fixture is no longer evidence of anything.")
    assert sig[shifted], (
        f"seed={seed}: the naive test did not even recover the truly-shifted population, so its "
        "false positives are not diagnostic of the compositional trap.")


@pytest.mark.parametrize("engine", ENGINES)
def test_the_two_methods_disagree_and_the_direction_of_disagreement_is_the_point(engine):
    """The comparison stated as ONE assertion over the SAME fixture, so the pairing cannot drift
    apart into two tests that happen to run on different data."""
    counts, samples, conditions, shifted = _fixture(SEEDS[0])
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
    results, _ = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                       method=engine, normalization=K.POSCOUNTS, fail=kernel_fail)
    ours = _significant(K.bh(np.array([results[p]["pval"] for p in populations])))
    naive = _significant(sim.naive_proportion_test(counts, conditions))

    ours_fp = int(ours.sum() - (1 if ours[shifted] else 0))
    naive_fp = int(naive.sum() - (1 if naive[shifted] else 0))
    assert ours_fp <= MAX_FALSE_POSITIVES_OURS < MIN_FALSE_POSITIVES_NAIVE <= naive_fp, (
        f"{engine}: on ONE fixture the count model reported {ours_fp} false positives and the "
        f"proportion test reported {naive_fp}. The whole claim of this package is that those two "
        "numbers are far apart in that order.")
