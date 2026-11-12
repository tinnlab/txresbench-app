#!/usr/bin/env python3
# ruff: noqa
"""TEST-4 [covers: ITEM-5] — every way the kernel can fail is a NAMED refusal.

The failure mode this package exists to prevent is a plausible wrong answer, so the kernel's job
when it cannot do the right thing is to stop and say why — never to substitute something it can
do. Each refusal below names the thing that could not be established and, where the temptation
exists, says explicitly that the run does not fall back to proportions.
"""
import numpy as np
import pytest

import sim
import _kernel as K
from engines import ENGINES, KernelRefusal, kernel_fail


def _frame(seed=0):
    counts, samples, conditions, _ = sim.shifted_counts(seed=seed)
    return sim.counts_frame(counts, samples, conditions)


def test_an_unknown_engine_is_refused_and_lists_the_registered_ones():
    counts_df, design_df, _ = _frame()
    with pytest.raises(KernelRefusal) as e:
        K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
              method="edger", normalization=K.POSCOUNTS, fail=kernel_fail)
    assert "edger" in str(e.value)
    assert "pydeseq2" in str(e.value) and "nb_glm" in str(e.value)


def test_the_reference_mode_without_a_reference_is_refused():
    counts_df, design_df, _ = _frame()
    with pytest.raises(KernelRefusal) as e:
        K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
              method="nb_glm", normalization=K.REFERENCE, reference=None, fail=kernel_fail)
    assert "no reference population was named" in str(e.value)
    assert "proportion" in str(e.value)


def test_a_degenerate_count_matrix_refuses_rather_than_inventing_a_size_factor():
    """No population has a usable geometric mean, so there is no normalization to establish. The
    alternative — testing the raw proportions — is exactly what INV-DA-1 forbids."""
    counts = np.zeros((6, 4), dtype=np.int64)
    with pytest.raises(KernelRefusal) as e:
        K.poscounts_size_factors(counts, fail=kernel_fail)
    assert "usable geometric mean" in str(e.value)
    assert "raw proportions" in str(e.value)


def test_a_sample_with_no_positive_count_in_any_usable_population_refuses():
    counts, samples, conditions, _ = sim.shifted_counts(seed=2)
    counts = counts.copy()
    counts[0, :] = 0
    with pytest.raises(KernelRefusal) as e:
        K.poscounts_size_factors(counts, fail=kernel_fail)
    assert "size factor is undefined" in str(e.value)


@pytest.mark.parametrize("engine", ENGINES)
def test_the_engines_refuse_by_name_when_their_own_dependency_is_absent(engine):
    """A missing wheel must be a NAMED refusal that points at the rootfs pin, not a raw
    ImportError surfacing from the middle of the pipeline."""
    counts_df, design_df, _ = _frame()
    descriptor = K.resolve_method(engine, kernel_fail)
    with pytest.raises(KernelRefusal) as e:
        descriptor["run"](counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                          covariates=[], normalization=K.POSCOUNTS, reference_name=None,
                          fail=kernel_fail, force_absent=True)
    text = str(e.value)
    assert descriptor["requires"][0] in text
    assert "rootfs" in text


def test_a_contrast_level_absent_from_the_surviving_samples_is_refused_by_name():
    counts_df, design_df, _ = _frame()
    with pytest.raises(KernelRefusal) as e:
        K.fit(counts_df, design_df, ("treat", "nonexistent"), condition_col="condition",
              method="nb_glm", normalization=K.POSCOUNTS, fail=kernel_fail)
    assert "nonexistent" in str(e.value)


def test_the_small_sample_correction_is_recorded_whichever_way_it_is_set():
    """A silent transformation is exactly what this package must not do: whichever reference
    distribution was used, the record says so."""
    counts_df, design_df, _ = _frame()
    for flag in (True, False):
        _, record = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                          method="nb_glm", normalization=K.POSCOUNTS,
                          small_sample_correction=flag, fail=kernel_fail)
        assert record["small_sample_correction"] is flag
        if flag:
            assert record["residual_df"] == counts_df.shape[0] - 2


def test_the_t_reference_is_more_conservative_than_the_normal_one_by_construction():
    """The correction can only ever RAISE a p-value — a heavier-tailed reference cannot make a
    statistic look more significant. If this inverted, the "correction" would be manufacturing
    significance rather than removing it."""
    stats = np.array([0.5, 1.5, 2.5, 4.0, 8.0])
    t_p = K.t_reference_pvalues(stats, df=8)
    from scipy.special import ndtr
    normal_p = 2.0 * ndtr(-np.abs(stats))
    assert np.all(t_p >= normal_p - 1e-12)
    assert np.all(t_p <= 1.0 + 1e-12)


def test_a_design_with_no_residual_degrees_of_freedom_yields_absent_p_not_optimistic_p():
    assert np.all(np.isnan(K.t_reference_pvalues([3.0, 1.0], df=0)))
    assert np.all(np.isnan(K.t_reference_pvalues([3.0], df=None)))


# ── the guard against over-confident inference under insufficient replication ──────
#
# THIS IS THE ONE THAT WAS INERT. The R1→R3 downgrade was written to stop a run reporting
# significance when the fit could not support any, but it keyed on "did every p come back NaN?" —
# and `statsmodels` refers its Wald statistic to a NORMAL, which returns a perfectly finite
# p-value at ZERO residual degrees of freedom. So on the engine that is always installed, a design
# that had consumed every degree of freedom sailed through as R1 and shipped p-values with no
# reference distribution behind them: exactly the over-confident fabrication this package exists
# to refuse, in the guard meant to prevent it.
#
# It was found only by writing the missing test for the downgrade. The fix moved the decision into
# the kernel, ONCE, for whichever engine runs — and these are the pins that make it stay fixed.
# Both of them go RED if the nulling is removed: the first directly, the second through the
# regime the entry script then reports.

@pytest.mark.parametrize("engine", ENGINES)
def test_a_design_with_no_residual_degrees_of_freedom_yields_NO_p_on_any_engine(engine):
    """TEST-35 [acceptance] [invariant: INV-DA-2] [covers: ITEM-5] — Four samples; two crossed covariates plus the condition is four design columns. The design
    is FULL RANK (so the rank guard must NOT be what fires) and the residual degrees of freedom
    are ZERO — there is nothing left to estimate the residual scale with, so no reference
    distribution exists and no p-value means anything."""
    import pandas as pd

    counts, samples, conditions = sim.null_counts(n_per_side=2)
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
    design_df = design_df.assign(c1=["a", "b", "a", "b"], c2=["x", "y", "y", "x"])

    # the rank guard does NOT fire — this is a full-rank, saturated design, not a confounded one
    D, cols = K.refuse_rank_deficient_design(design_df, "condition", ["c1", "c2"],
                                             fail=kernel_fail)
    assert len(cols) == 4 and D.shape == (4, 4)
    assert K.residual_df(4, D) == 0

    results, record = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                            covariates=["c1", "c2"], method=engine,
                            normalization=K.POSCOUNTS, fail=kernel_fail)
    assert record["residual_df"] == 0
    assert record["p_values_nulled"] == "no residual degrees of freedom"
    pvals = np.array([results[p]["pval"] for p in populations])
    assert np.all(np.isnan(pvals)), (
        f"{engine}: a design with zero residual degrees of freedom returned "
        f"{int(np.sum(~np.isnan(pvals)))} finite p-value(s). There is no reference distribution "
        "for the statistic to be referred to, so those numbers are over-confident by "
        "construction — which is the failure this package exists to refuse.")


def test_the_normal_reference_WOULD_return_a_finite_p_there_which_is_why_the_guard_is_needed():
    """TEST-36 [covers: ITEM-5] — The evidence that the guard is not defensive tidying.

    `statsmodels`' NB-GLM with a normal reference is the engine that is ALWAYS installed, and it
    hands back a finite p at zero residual degrees of freedom. The guard exists because of this
    behaviour, so the behaviour is asserted here — if statsmodels ever became conservative on its
    own, this test tells the next reader that the guard's justification changed, rather than
    letting the guard sit on with no stated reason."""
    import pandas as pd
    import statsmodels.api as sm

    y = np.array([100.0, 140.0, 90.0, 160.0])
    D = np.array([[1.0, 0.0, 0.0, 0.0],
                  [1.0, 1.0, 0.0, 0.0],
                  [1.0, 0.0, 1.0, 0.0],
                  [1.0, 1.0, 1.0, 1.0]])
    assert K.residual_df(4, D) == 0
    fit = sm.GLM(y, D, family=sm.families.NegativeBinomial(alpha=0.02)).fit()
    p = float(np.ravel(fit.t_test(np.array([0.0, 0.0, 0.0, 1.0])).pvalue)[0])
    assert np.isfinite(p), (
        "statsmodels no longer returns a finite p at zero residual degrees of freedom — the "
        "kernel's nulling is still correct, but its stated justification has changed")


# ── TEST-50: the engine's size factors, wherever this PyDESeq2 release keeps them ──────────
#
# Round R2 finding. PyDESeq2 moved `size_factors` between `.obs` and `.obsm` TWICE inside the
# range this package declared: 0.4.x `.obs`, 0.5.0/0.5.1 `.obsm`, 0.5.2/0.5.3/0.5.4 `.obs`. The
# code read `.obs` unconditionally, so any deployment that resolved 0.5.0 or 0.5.1 — both ADMITTED
# by the old `>=0.5,<0.6` declaration — got a raw `KeyError` traceback from inside the engine
# rather than one of this package's named refusals.
#
# These use a stand-in with just the two attributes the reader touches. That is deliberate: the
# point is to exercise BOTH layouts and the neither-layout case on ANY host, including one with no
# `pydeseq2` at all, which is exactly the property the original code lacked.

class _FakeDds:
    def __init__(self, obs=None, obsm=None):
        if obs is not None:
            self.obs = obs
        if obsm is not None:
            self.obsm = obsm


def test_size_factors_are_read_from_obs_when_that_is_where_the_engine_put_them():
    import pandas as pd

    dds = _FakeDds(obs=pd.DataFrame({"size_factors": [1.0, 2.0, 0.5]}), obsm={})
    assert list(K.engine_size_factors(dds)) == [1.0, 2.0, 0.5]


def test_size_factors_are_read_from_obsm_on_the_releases_that_moved_them_there():
    """0.5.0 and 0.5.1. Before this, these versions raised `KeyError: 'size_factors'` from
    `_run_pydeseq2`'s return path — AFTER the full DESeq2 fit had already run."""
    import pandas as pd

    dds = _FakeDds(obs=pd.DataFrame(index=[0, 1, 2]),
                   obsm={"size_factors": np.array([1.0, 2.0, 0.5])})
    assert list(K.engine_size_factors(dds)) == [1.0, 2.0, 0.5]


def test_an_engine_exposing_size_factors_NOWHERE_is_refused_by_name():
    """Not a `KeyError`. This package records the engine's own factors so the normalization it
    used can be checked against the one it was asked for (INV-DA-1); if it cannot evidence that,
    it says so in its own words."""
    import pandas as pd

    dds = _FakeDds(obs=pd.DataFrame(index=[0, 1]), obsm={})
    seen = []

    def _capture(message, code=2):
        seen.append(message)
        raise AssertionError("refused")

    with pytest.raises(AssertionError):
        K.engine_size_factors(dds, fail=_capture)
    assert len(seen) == 1
    assert "size_factors" in seen[0] and "pydeseq2>=0.5.2,<0.6" in seen[0], seen


def test_the_declared_pydeseq2_range_excludes_the_releases_the_reader_had_to_be_taught():
    """The other half of the fix, and the half a code change alone would not give: the ENVIRONMENT
    contract must not certify a version the code is not tested against. `txr_deps` resolves the
    declared range at run time and passes anything inside it."""
    import pathlib

    import yaml

    manifest = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "manifest.yaml")
                              .read_text())
    for a in manifest["contributes"]["analyses"]:
        declared = {d["library"]: d["version"] for d in a["run"]["dependencies"]}
        if "pydeseq2" not in declared:
            continue
        spec = declared["pydeseq2"]
        assert spec == ">=0.5.2,<0.6", (
            f"{a['id']} declares pydeseq2 {spec!r}. 0.5.0 and 0.5.1 keep the fitted size factors "
            "in `obsm`, not `obs`; the reader now handles both, but the declared range is what "
            "the runtime contract certifies and it must not admit untested releases.")
