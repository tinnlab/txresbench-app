#!/usr/bin/env python3
# ruff: noqa
"""TEST-21 [acceptance] [invariant: INV-DA-7] [covers: ITEM-13]

TEST-DA-POWER — recovery of a KNOWN shift.

`P = 12` populations, `R = 5` replicates per condition, ONE population given a true 2x abundance
shift, per-sample totals drawn with over-dispersion. The shifted population must be recovered at
target FDR 0.10 in at least 18 of 20 seeds, on every installed engine.

This is the half of the battery that stops the compositional handling from being achieved by
being useless: an estimator that never calls anything trivially passes the FDR test and the
negative control's first half, and fails here.

The fixture's over-dispersion is `sim.DISPERSION` (alpha = 0.02, about a 15% between-replicate
CV), stated there and in DECISIONS.md DEC-13 because it changes what this bar means: at
alpha = 0.1 a 2x shift with 5 replicates per side genuinely sits near 20% power, so a "18/20"
assertion there would be asserting something statistically false rather than something about this
implementation.
"""
import numpy as np
import pytest

import sim
import _kernel as K
from engines import ENGINES, kernel_fail

N_SEEDS = 20
MIN_RECOVERED = 18
FDR = 0.10


@pytest.mark.parametrize("engine", ENGINES)
def test_a_known_two_fold_shift_is_recovered_in_at_least_18_of_20_seeds(engine):
    recovered = 0
    misses = []
    for seed in range(N_SEEDS):
        counts, samples, conditions, shifted = sim.shifted_counts(
            seed=1000 + seed, shift=sim.POWER_SHIFT)
        counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
        results, _ = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                           method=engine, normalization=K.POSCOUNTS, fail=kernel_fail)
        pvals = np.array([results[p]["pval"] for p in populations])
        padj = K.bh(pvals)
        if padj[shifted] <= FDR:
            recovered += 1
        else:
            misses.append((seed, float(padj[shifted])))
    assert recovered >= MIN_RECOVERED, (
        f"{engine}: the true {sim.POWER_SHIFT}x shift was recovered at FDR {FDR} in only "
        f"{recovered}/{N_SEEDS} seeds (need >= {MIN_RECOVERED}). Misses (seed, padj): {misses}")


@pytest.mark.parametrize("engine", ENGINES)
def test_the_recovered_effect_points_the_right_way_and_is_about_the_right_size(engine):
    """Power is not just "something was called": the effect must have the SIGN and roughly the
    MAGNITUDE of the shift that was put in, or the test is passing on noise."""
    counts, samples, conditions, shifted = sim.shifted_counts(seed=1000, shift=sim.POWER_SHIFT)
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
    results, _ = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                       method=engine, normalization=K.POSCOUNTS, fail=kernel_fail)
    logfc = np.array([results[p]["logFC"] for p in populations])
    expected = np.log2(sim.POWER_SHIFT)
    assert logfc[shifted] > 0, f"{engine}: the shifted population's effect points the wrong way"
    assert abs(logfc[shifted] - expected) < 0.35, (
        f"{engine}: recovered logFC {logfc[shifted]:.3f} is far from the simulated "
        f"{expected:.3f}")
    others = np.delete(logfc, shifted)
    assert np.nanmax(np.abs(others)) < abs(logfc[shifted]), (
        f"{engine}: an unchanged population has a larger |logFC| than the shifted one")
