#!/usr/bin/env python3
# ruff: noqa
"""TEST-23 / TEST-24 [covers: ITEM-14, ITEM-7, ITEM-6] — TWO-TIER REFERENCE PARITY (#117).

## Why parity is two-tier, and why exact parity with miloR is NOT claimed

Exact numeric parity with `miloR` is not achievable and asserting it would be a lie: miloR uses
edgeR's quasi-likelihood F-test and this package uses PyDESeq2's Wald test. But asserting only
"close enough" with no upper tier would be lazy, because the piece that could actually be WRONG —
our neighbourhood construction, our counts, our design, our spatial FDR — is separable from the
statistical engine. So:

  · TIGHT, against `pertpy.tools.Milo(solver="pydeseq2")` — the SAME statistical engine. Given the
    same embedding, `prop`, `seed` and `k`, everything must match to floating-point tolerance. A
    failure here is a bug in OUR code, unambiguously, because the engine is shared.
  · LOOSE, against edgeR's quasi-likelihood F-test (the family miloR uses) on the SAME
    neighbourhoods and the SAME counts, so the two references differ ONLY in the test. Rank and
    sign agreement, not equality.

## THE LIMITATION, STATED WHERE A READER OF THE TEST SEES IT

**Both references are COMMITTED GOLDEN FIXTURES generated OUT OF BAND.** Neither can run where
the product runs: `pertpy` needs Python >= 3.12 plus JAX and the analysis rootfs is a trimmed
Python 3.11 venv; edgeR needs R, which that rootfs deliberately dropped. The generator is
committed beside the fixtures (`tools/gen_parity_fixtures.py`) and each fixture carries its own
provenance record — reference, library versions, parameters, date — so the recipe is reproducible.

The honest consequence: **a reference implementation that drifts upstream will NOT be noticed
automatically.** This is not a live parity run and it is not dressed up as one. Re-run the
generator to refresh.

## Matching is BY INDEX CELL

The refinement step dedups, so `n_nhoods` is itself seed-dependent. The fixture therefore commits
`prop`, `seed` and `k` alongside the results; without them the matching is undefined and the
comparison is unmeasurable.

## The tight tier turns the small-sample correction OFF, deliberately

This package refers its Wald statistic to a Student-t on the residual degrees of freedom by
default (see `_kernel.t_reference_pvalues` — the reference implementation's normal reference has a
measured anti-conservative left tail at these sample sizes). The reference does NOT do that, so
the parity run turns it off. Folding our own correction into both sides of a comparison would make
the comparison meaningless.
"""
import json
from pathlib import Path

import numpy as np
import pytest

import _kernel as K
import _nhoods as NH
from engines import kernel_fail

_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "parity"
TIGHT = _FIXTURES / "tight_pertpy_pydeseq2.json"
LOOSE = _FIXTURES / "loose_edger_ql.json"

#: The reason the ENGINE-DEPENDENT half of this module skips without the wheel.
#:
#: It is applied inside `_run_our_pipeline`, NOT at module scope. A module-level `importorskip`
#: takes the WHOLE file down, and this file also holds guards that touch no engine at all —
#: including `test_only_derived_summary_statistics_are_committed_no_primary_data`, which its own
#: docstring calls "the single licensing question in this epic, closed by construction". Round R1
#: found that guard running on no host without the analysis rootfs, which is precisely where a
#: licensing guard needs to run. Every test that needs the engine reaches it through the one
#: helper below, so the skip has exactly the scope it should.
_PYDESEQ2_REASON = (
    "the TIGHT tier reproduces a PyDESeq2 reference, so it needs the wheel that is pinned in "
    "env-rootfs/single-cell/requirements.txt")


def _load(path):
    assert path.is_file(), (
        f"the parity fixture {path.name} is missing. It is generated OUT OF BAND by "
        "`tools/gen_parity_fixtures.py` — see that script's header for the two toolchains.")
    return json.loads(path.read_text())


def _run_our_pipeline(fx, *, small_sample_correction=False):
    """Our pipeline over the fixture's own embedding and labels, at the fixture's committed
    `prop`/`seed`/`k`."""
    pytest.importorskip("pydeseq2", reason=_PYDESEQ2_REASON)

    import pandas as pd

    params = fx["provenance"]["parameters"]
    X = np.asarray(fx["embedding"], dtype=np.float32)
    samples = fx["samples"]
    conditions = fx["conditions"]
    levels = fx["sample_levels"]

    connectivities, distances, _k = NH.build_knn(X, n_neighbors=params["k"], seed=params["seed"])
    nhoods, index_cells, kth = NH.make_nhoods(X, connectivities, distances,
                                              prop=params["prop"], seed=params["seed"])
    counts = NH.count_nhoods(nhoods, samples, levels)
    population_ids = [f"nhood{int(i)}" for i in index_cells]
    per_sample = {}
    for s, c in zip(samples, conditions):
        per_sample[s] = c
    counts_df = pd.DataFrame(counts, index=levels, columns=population_ids)
    design_df = pd.DataFrame({"condition": [per_sample[s] for s in levels]}, index=levels)
    g1, g2 = params["contrast"]
    results, _ = K.fit(counts_df, design_df, (g1, g2), condition_col="condition",
                       method="pydeseq2", normalization=K.POSCOUNTS,
                       small_sample_correction=small_sample_correction, fail=kernel_fail)
    logfc = np.array([results[p]["logFC"] for p in population_ids])
    pvals = np.array([results[p]["pval"] for p in population_ids])
    spatial = K.weighted_bh(pvals, 1.0 / kth)
    return dict(index_cells=[int(i) for i in index_cells], counts=counts, kth=kth,
                logFC=logfc, pval=pvals, spatial_fdr=spatial)


# ── TIGHT TIER ─────────────────────────────────────────────────────────────────────
def test_tight_the_refined_index_cells_are_identical():
    fx = _load(TIGHT)
    ours = _run_our_pipeline(fx)
    assert ours["index_cells"] == fx["index_cells"], (
        "our refined neighbourhood index cells differ from the reference's. Everything downstream "
        "is matched BY index cell, so nothing else in this tier means anything until this holds.")


def test_tight_the_nhood_by_sample_counts_are_identical():
    fx = _load(TIGHT)
    ours = _run_our_pipeline(fx)
    reference = np.asarray(fx["counts"], dtype=np.int64)
    assert ours["counts"].shape == reference.shape
    assert np.array_equal(ours["counts"], reference), (
        "the (sample × neighbourhood) integer counts differ from the reference's")


def test_tight_the_kth_nearest_neighbour_distances_match():
    fx = _load(TIGHT)
    ours = _run_our_pipeline(fx)
    reference = np.asarray(fx["kth_distance"], dtype=np.float64)
    assert np.max(np.abs(ours["kth"] - reference)) <= 1e-9


def test_tight_logFC_matches_to_1e_6():
    fx = _load(TIGHT)
    ours = _run_our_pipeline(fx)
    reference = np.asarray(fx["logFC"], dtype=np.float64)
    delta = np.nanmax(np.abs(ours["logFC"] - reference))
    assert delta <= 1e-6, f"max |Δ logFC| = {delta:.3e} (bar 1e-6)"


def test_tight_neglog10p_matches_to_1e_6():
    fx = _load(TIGHT)
    ours = _run_our_pipeline(fx)
    reference = K.neglog10(np.asarray(fx["PValue"], dtype=np.float64))
    delta = np.nanmax(np.abs(K.neglog10(ours["pval"]) - reference))
    assert delta <= 1e-6, f"max |Δ neglog10p| = {delta:.3e} (bar 1e-6)"


def test_tight_spatial_fdr_matches_to_1e_9():
    fx = _load(TIGHT)
    ours = _run_our_pipeline(fx)
    reference = np.asarray(fx["SpatialFDR"], dtype=np.float64)
    mine = np.where(np.isnan(ours["spatial_fdr"]), 1.0, ours["spatial_fdr"])
    delta = np.nanmax(np.abs(mine - reference))
    assert delta <= 1e-9, f"max |Δ spatial_fdr| = {delta:.3e} (bar 1e-9)"


def test_tight_the_fixture_commits_the_determinism_parameters_and_its_provenance():
    """Without `prop`/`seed`/`k` the neighbourhood matching is undefined; without the provenance
    record a reader cannot tell what the numbers came from or when."""
    prov = _load(TIGHT)["provenance"]
    for key in ("prop", "seed", "k", "contrast"):
        assert key in prov["parameters"], key
    assert "pertpy" in prov["reference"] and "pydeseq2" in prov["reference"]
    assert prov["library_versions"]["pertpy"] and prov["library_versions"]["pydeseq2"]
    assert "OUT OF BAND" in prov["limitation"]
    assert prov["generated_at_utc"]


# ── LOOSE TIER ─────────────────────────────────────────────────────────────────────
def test_loose_spearman_correlation_of_logFC_is_at_least_0_95():
    from scipy import stats

    fx = _load(TIGHT)
    ref = _load(LOOSE)
    assert ref["index_cells"] == fx["index_cells"], (
        "the two fixtures describe different neighbourhoods; regenerate them together")
    ours = _run_our_pipeline(fx)
    rho = stats.spearmanr(ours["logFC"], np.asarray(ref["logFC"], dtype=float)).statistic
    assert rho >= 0.95, f"Spearman ρ(logFC) vs edgeR = {rho:.4f} (bar 0.95)"


def test_loose_signs_agree_on_every_neighbourhood_with_a_real_effect():
    fx = _load(TIGHT)
    ref = _load(LOOSE)
    ours = _run_our_pipeline(fx)
    theirs = np.asarray(ref["logFC"], dtype=float)
    big = np.abs(ours["logFC"]) > 0.5
    assert big.any(), "the fixture carries no neighbourhood with |logFC| > 0.5 to compare signs on"
    disagreeing = np.where(np.sign(ours["logFC"][big]) != np.sign(theirs[big]))[0]
    assert disagreeing.size == 0, (
        f"{disagreeing.size} neighbourhoods with |logFC| > 0.5 point the opposite way from edgeR")


def test_loose_top_twenty_by_adjusted_p_overlap_by_at_least_fifteen():
    fx = _load(TIGHT)
    ref = _load(LOOSE)
    ours = _run_our_pipeline(fx)
    n = min(20, len(ours["logFC"]))
    mine = set(np.argsort(np.where(np.isnan(ours["spatial_fdr"]), 1.0, ours["spatial_fdr"]))[:n])
    theirs = set(np.argsort(np.asarray(ref["FDR"], dtype=float))[:n])
    overlap = len(mine & theirs)
    bar = int(round(15 * n / 20))
    assert overlap >= bar, f"top-{n} overlap with edgeR is {overlap} (bar {bar})"


def test_loose_the_fixture_records_that_exact_parity_is_NOT_claimed():
    prov = _load(LOOSE)["provenance"]
    assert "edgeR" in prov["reference"] and "quasi-likelihood" in prov["reference"]
    assert "not achievable" in prov["note"].lower() or "NOT claimed" in prov["note"]
    assert "OUT OF BAND" in prov["limitation"]
    assert prov["library_versions"]["edgeR"] and prov["library_versions"]["R"]


def test_only_derived_summary_statistics_are_committed_no_primary_data():
    """The single licensing question in this epic, closed by construction: the fixtures carry a
    synthetic embedding generated from a committed seed plus derived statistics, and nothing that
    anyone holds rights over."""
    for path in (TIGHT, LOOSE):
        prov = _load(path)["provenance"]
        assert "SYNTHETIC" in prov["dataset"]
        assert "no licence applies" in prov["dataset"] or "no primary data" in prov["dataset"]
