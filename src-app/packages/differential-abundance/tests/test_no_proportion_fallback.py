#!/usr/bin/env python3
# ruff: noqa
"""TEST-2 [acceptance] [invariant: INV-DA-1] [covers: ITEM-5]

There is NO proportion-based statistic in the shipped code path, and there is nothing to fall
back TO. Asserted two ways, because either alone is weak:

  · BY SOURCE — no shipped `compute/*.py` imports `scipy.stats` or names any two-sample test
    (`ttest`, `ranksums`, `mannwhitney`, `chisquare`, `fisher_exact`, `proportions_ztest`,
    `binomtest`). A behavioural test cannot prove a path does not EXIST; only reading can.
  · BY BEHAVIOUR — every route in which a normalization cannot be established exits NON-ZERO with
    a NAMED refusal that says what could not be established, rather than returning a result. A
    source scan cannot prove the refusal actually fires; only running can.

The naive proportion test DOES exist in this repository — in `tests/sim.py`, as the negative
control. That is deliberate and this test pins the separation: the invalid method is available to
the test suite so it can be shown FAILING, and is unreachable from the shipped package.
"""
import inspect
import re
from pathlib import Path

import numpy as np
import pytest

import sim
import _kernel as K
from engines import ENGINES, KernelRefusal, kernel_fail
from da_fixtures import DaRun, CLUSTERS, EXTERNAL

_COMPUTE = Path(__file__).resolve().parents[1] / "compute"

#: Names that would indicate a two-sample test being applied directly. A per-population test on
#: proportions is what INV-DA-1 forbids, and none of these may appear in the shipped compute.
FORBIDDEN_SYMBOLS = ("ttest_ind", "ttest_rel", "ttest_1samp", "ranksums", "mannwhitneyu",
                     "wilcoxon", "chisquare", "chi2_contingency", "fisher_exact",
                     "proportions_ztest", "binomtest", "binom_test")


def _shipped_compute_sources():
    return {p.name: p.read_text() for p in sorted(_COMPUTE.glob("*.py"))}


def test_no_shipped_compute_file_imports_scipy_stats():
    for name, src in _shipped_compute_sources().items():
        assert not re.search(r"^\s*(from\s+scipy(\.stats)?\s+import|import\s+scipy\.stats)",
                             src, re.M), (
            f"{name} imports scipy.stats. Differential abundance never computes a statistic from "
            "proportions; every p-value comes from the count model in `_kernel.fit`.")


def test_no_shipped_compute_file_names_a_two_sample_test():
    for name, src in _shipped_compute_sources().items():
        for sym in FORBIDDEN_SYMBOLS:
            assert sym not in src, (
                f"{name} names {sym!r}. A per-population two-sample test is exactly the invalid "
                "method INV-DA-1 forbids; there must be no code path that can reach one.")


def test_the_naive_method_exists_only_in_the_test_tree():
    """The negative control's arm is real code — it has to be, or the control could not run it —
    and it lives in `tests/sim.py`, never in `compute/`."""
    assert callable(sim.naive_proportion_test)
    assert "scipy" in inspect.getsource(sim.naive_proportion_test)
    for name in _shipped_compute_sources():
        assert "naive_proportion" not in (_COMPUTE / name).read_text()


def test_the_normalization_vocabulary_is_closed_at_two_entries():
    assert K.NORMALIZATIONS == (K.POSCOUNTS, K.REFERENCE)
    assert set(K.NORMALIZATION_ASSUMPTION) == set(K.NORMALIZATIONS)
    for mode in K.NORMALIZATIONS:
        assert K.NORMALIZATION_ASSUMPTION[mode].strip(), f"{mode} declares no assumption"


@pytest.mark.parametrize("engine", ENGINES)
def test_an_unestablishable_normalization_refuses_by_name_rather_than_returning(engine):
    """The behavioural half: a reference population that is absent, and one carrying a zero, both
    REFUSE — and the refusal says the run does not fall back to proportions."""
    counts, samples, conditions, _ = sim.shifted_counts(seed=0)
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)

    with pytest.raises(KernelRefusal) as absent:
        K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition", method=engine,
              normalization=K.REFERENCE, reference="not-a-population", fail=kernel_fail)
    assert "not-a-population" in str(absent.value)
    assert "proportions" in str(absent.value)

    zeroed = counts_df.copy()
    zeroed.iloc[0, 3] = 0
    with pytest.raises(KernelRefusal) as zero:
        K.fit(zeroed, design_df, ("treat", "ctrl"), condition_col="condition", method=engine,
              normalization=K.REFERENCE, reference=populations[3], fail=kernel_fail)
    assert "ZERO cells" in str(zero.value)
    assert "proportions" in str(zero.value)


def test_the_run_itself_exits_non_zero_on_an_unestablishable_normalization(clusters_run):
    """End-to-end through the REAL entry script: an absent reference population is a named,
    non-zero refusal — not a run that quietly produced numbers under some other normalization."""
    pops, conds, samps = _small_dataset()
    run = clusters_run()
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    proc = run.run({"normalization": "reference", "reference": "not-a-population",
                    "method": "nb_glm"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "not-a-population" in msg and "proportions" in msg
    assert not (run.outputs_dir / "manifest.json").exists(), (
        "a refused run must not leave a manifest behind")


def test_an_unknown_normalization_is_refused_and_names_the_closed_set():
    counts, samples, conditions = sim.null_counts(seed=0)
    counts_df, design_df, _ = sim.counts_frame(counts, samples, conditions)
    with pytest.raises(KernelRefusal) as e:
        K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
              method="nb_glm", normalization="proportions", fail=kernel_fail)
    text = str(e.value)
    assert "proportions" in text and "poscounts" in text and "reference" in text
    assert "no proportion mode" in text


def _small_dataset():
    from da_fixtures import population_dataset
    return population_dataset(n_per_sample=120, samples_per_side=3)
