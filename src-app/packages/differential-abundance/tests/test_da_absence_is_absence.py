#!/usr/bin/env python3
# ruff: noqa
"""TEST-5 [acceptance] [invariant: INV-DA-2] [covers: ITEM-4, ITEM-8]

ABSENCE IS ABSENCE, and the unit of replication is the SAMPLE.

A `p` of 1 says "we tested and found nothing". An ABSENT `p` says "we did not test, and here is
why". Those are different claims and only one of them is true in an R2/R3 regime, so the columns
are not written at all — not written as 1, not written as NaN, not written as 0.

The corresponding replication claim: 10,000 cells from 2 donors carry 2 units of information
about a between-donor contrast, not 10,000. So the count matrix's ROW space is samples, and fewer
than two samples on a side means there is nothing to generalise from.
"""
import pathlib

import numpy as np
import pytest

import _kernel as K

from da_fixtures import population_dataset, EXTERNAL
from engines import ENGINES

P_FAMILY = ("neglog10p", "padj", "spatial_fdr", "neglog10_significance")
ALWAYS = ("logFC", "n_cells", "mean_prop_1", "mean_prop_2", "n_samples_1", "n_samples_2", "score")


def _bind(run, *, samples_per_side, provenance=EXTERNAL, n_per_sample=150):
    pops, conds, samps = population_dataset(n_per_sample=n_per_sample,
                                            samples_per_side=samples_per_side)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=provenance)
    run.add_column(samps, slot="sample", name="sample")
    return pops, conds, samps


def test_one_sample_per_side_is_R3_and_the_p_family_is_not_on_disk(clusters_run):
    run = clusters_run()
    _bind(run, samples_per_side=1)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    entry = run.da_entries()[0]
    members = run.da_members(entry)
    for member in P_FAMILY:
        assert member not in members, (
            f"{member!r} was written in an R3 regime. With one sample per side a within-sample "
            "difference generalises to nothing; the column must be ABSENT, not 1.")
    for member in ALWAYS:
        assert member in members, f"{member!r} should be written in every regime"
    assert run.report()["regime"] == "R3"
    assert run.report()["pvalues_written"] is False
    assert run.da_txr(entry)["da"]["pvalues_written"] is False


def test_a_no_provenance_condition_is_R2_and_the_p_family_is_not_on_disk(clusters_run):
    run = clusters_run()
    _bind(run, samples_per_side=4, provenance=None)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    members = run.da_members(run.da_entries()[0])
    for member in P_FAMILY:
        assert member not in members
    assert run.report()["regime"] == "R2"


def test_the_same_fixture_with_replication_and_provenance_DOES_write_them(clusters_run):
    """The control that stops the two tests above passing vacuously: change ONLY the replication
    and the provenance, and the p-family appears."""
    run = clusters_run()
    _bind(run, samples_per_side=4)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    members = run.da_members(run.da_entries()[0])
    assert "neglog10p" in members and "padj" in members
    # …but never `spatial_fdr` for CLUSTER populations, in ANY regime (INV-DA-4).
    assert "spatial_fdr" not in members
    assert run.report()["regime"] == "R1"


def test_the_ranked_effect_written_without_a_p_is_still_a_count_model_quantity(clusters_run):
    """"Descriptive" must not mean "computed from proportions". In R2/R3 the `logFC` a reader
    ranks by is the log2 ratio of NORMALIZED COUNTS under the declared normalization, so even the
    p-free path never touches the compositional quantity (INV-DA-1)."""
    run = clusters_run()
    pops, conds, samps = _bind(run, samples_per_side=4, provenance=None)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    report = run.report()
    assert report["normalization"]["normalization"] == "poscounts"
    assert "MOST POPULATIONS ARE UNCHANGED" in report["normalization"]["assumption"]
    entry = run.da_entries()[0]
    logfc = np.asarray(run.da_column(entry, "logFC"), dtype=float)
    # the truly-shifted population ("A" in the fixture) still ranks first by effect
    populations = list(run.da_column(entry, "population"))
    assert populations[int(np.nanargmax(logfc))] == "A"


def test_samples_below_min_cells_are_dropped_AND_recorded(clusters_run):
    """Never a silent omission. A reader has to be able to see that a sample was excluded and
    why, or the reported `n_samples_*` is a number with no provenance."""
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=3)
    # starve ONE sample down to a handful of cells
    starved = "s0_0"
    keep = [i for i, s in enumerate(samps) if s != starved][:]
    thin = [i for i, s in enumerate(samps) if s == starved][:4]
    idx = sorted(keep + thin)
    run.add_column([pops[i] for i in idx], slot="population", name="leiden")
    run.add_column([conds[i] for i in idx], slot="condition", name="condition",
                   provenance=EXTERNAL)
    run.add_column([samps[i] for i in idx], slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "min_cells": 50})
    report = run.report()
    dropped = {d["sample"] for d in report["dropped"]}
    assert starved in dropped, f"the starved sample is missing from the dropped record: {report['dropped']}"
    assert starved not in report["samples"]
    assert report["n_samples"] == len(report["samples"])
    entry = run.da_entries()[0]
    n1 = set(np.asarray(run.da_column(entry, "n_samples_1"), dtype=float).tolist())
    assert n1 == {float(report["n_samples_1"])}, (
        "the per-population `n_samples_1` must report the SURVIVING sample count, not the "
        "pre-drop one")


def test_a_side_with_no_surviving_sample_refuses_rather_than_testing_an_empty_side(clusters_run):
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=2)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "min_cells": 10_000_000})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "min_cells" in msg and "refusing" in msg


# ── the SAME rule, on the analysis that actually writes `spatial_fdr` ───────────────
#
# Every test above drives `da.clusters`. That left INV-DA-2 untested end-to-end for the PRIMARY
# analysis: moving the p-family assignments out of the R1 branch in `neighbourhoods.py` would have
# left the whole suite green, on the one producer that emits the connectivity-weighted column.

def _bind_nhoods(run, *, samples_per_side, provenance=EXTERNAL):
    from da_fixtures import embedding_dataset

    X, conds, samps, _ = embedding_dataset(n_per_sample=180, samples_per_side=samples_per_side)
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=provenance)
    run.add_column(samps, slot="sample", name="sample")


def test_neighbourhoods_one_sample_per_side_is_R3_and_omits_the_whole_p_family(neighbourhoods_run):
    """TEST-30 [covers: ITEM-4, ITEM-9] — INV-DA-2's absence rule, end-to-end, on the analysis
    that actually writes `spatial_fdr`."""
    run = neighbourhoods_run()
    _bind_nhoods(run, samples_per_side=1)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "prop": 0.15})
    entry = run.da_entries()[0]
    members = run.da_members(entry)
    for member in P_FAMILY:
        assert member not in members, (
            f"{member!r} was written by da.neighbourhoods in an R3 regime; it must be ABSENT")
    for member in ALWAYS:
        assert member in members
    assert run.report()["regime"] == "R3"
    assert run.da_txr(entry)["da"]["spatial_fdr_written"] is False


def test_neighbourhoods_a_no_provenance_condition_is_R2_and_omits_the_whole_p_family(neighbourhoods_run):
    run = neighbourhoods_run()
    _bind_nhoods(run, samples_per_side=3, provenance=None)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "prop": 0.15})
    members = run.da_members(run.da_entries()[0])
    for member in P_FAMILY:
        assert member not in members
    assert run.report()["regime"] == "R2"


def test_neighbourhoods_with_replication_and_provenance_DOES_write_them(neighbourhoods_run):
    """The control that stops the two above passing vacuously."""
    run = neighbourhoods_run()
    _bind_nhoods(run, samples_per_side=3)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "prop": 0.15})
    members = run.da_members(run.da_entries()[0])
    assert {"neglog10p", "padj", "spatial_fdr", "neglog10_significance"} <= members
    assert run.report()["regime"] == "R1"


# ── the DOWNGRADE: an R1 run whose fit yields no p at all is not an inferential result ──
#
# The regime classifier answers from PROVENANCE, before any fitting. It can therefore say R1 for a
# run whose design turns out to leave no residual degrees of freedom — a covariate at the R1 floor
# of two samples a side. Writing `padj`/`spatial_fdr` as 1.0 over an all-NaN fit would be the
# "written as 1" shape INV-DA-2 forbids, dressed as a run that tested and found nothing.

def test_an_R1_run_whose_fit_yields_no_p_downgrades_to_R3_and_omits_the_p_family(clusters_run):
    """TEST-31 [covers: ITEM-4, ITEM-5, ITEM-8] — the downgrade, end-to-end."""
    from da_fixtures import population_dataset

    pops, conds, samps = population_dataset(n_per_sample=200, samples_per_side=2)
    # two crossed covariates → 4 design columns over 4 samples → residual df = 0
    c1 = {"s0_0": "a", "s0_1": "b", "s1_0": "a", "s1_1": "b"}
    c2 = {"s0_0": "x", "s0_1": "y", "s1_0": "y", "s1_1": "x"}
    run = clusters_run()
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.add_column([c1[s] for s in samps], slot="covariate:c1", name="c1")
    run.add_column([c2[s] for s in samps], slot="covariate:c2", name="c2")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    assert proc.returncode == 0, run.diagnostics(proc)

    report = run.report()
    assert report["regime"] == "R3", (
        "a fit that produced no p-value at all is not an inferential result, whatever the "
        "provenance said")
    assert report["pvalues_written"] is False
    assert report["fit"]["downgraded_from"] == "R1"
    assert "residual degrees of freedom" in report["fit"]["downgrade_reason"]

    members = run.da_members(run.da_entries()[0])
    for member in P_FAMILY:
        assert member not in members, f"{member!r} was written over an all-NaN fit"

    # …and the downgraded result's two effect columns agree, as they do in every other R2/R3 result
    entry = run.da_entries()[0]
    logfc = np.asarray(run.da_column(entry, "logFC"), dtype=float)
    score = np.asarray(run.da_column(entry, "score"), dtype=float)
    assert np.array_equal(np.nan_to_num(logfc, nan=-999.0), np.nan_to_num(score, nan=-999.0)), (
        "a downgraded result ships `logFC` and `score` that rank populations differently")


# ── TEST-37: the mask must survive to DISK, and the guard must catch a revert ──────
#
# THIS TEST EXISTS BECAUSE ITS ABSENCE WAS EXPLOITED. A review agent reverted the mask-preserving
# assignment in both entry scripts and ran the whole suite: it stayed green. The fix with the
# highest severity in the whole feature had no test at the level that matters — the WRITTEN column
# — and the revert was then swept into a commit unnoticed. Two assertions, deliberately of
# different kinds, because either alone is what let that happen:
#
#   · a SOURCE guard, a cheap tripwire for the obvious revert — defeatable, and documented as
#     such on the function itself rather than trusted;
#   · a BEHAVIOURAL test that reads the written column back OFF DISK. That one is the guarantee
#     and it needs no particular engine.
#
# The claim that used to sit here — "it goes red for any fill however it is spelled" — was FALSE,
# and round R1 falsified it by mutation. TEST-42/44 reach their NaN by a total FIT FAILURE, so
# their masked row has a NaN `logFC` and no surviving cells; a fill conditioned on the population
# having been FITTED steps straight around them, and three such mutations ran the whole suite
# green. That is the only shape the production defect ever had. The masked-BUT-FITTED fixtures at
# the end of this file (TEST-45/46/47) cover it; the scope of each test is now stated per test
# rather than asserted globally here.

#: The p-family variables whose value must reach the writer UNTOUCHED.
MASKED_BINDINGS = ("padj_written", "spatial_written")


def _binding_sources(tree, name):
    """Every right-hand side `name` is assigned, as an AST node."""
    import ast

    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    out.append(node.value)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            target = node.target
            if isinstance(target, ast.Name) and target.id == name and node.value is not None:
                out.append(node.value)
    return out


def test_neither_entry_refills_a_masked_p_family_value():
    """The source half. A p-value the engine refused to report must reach disk as ABSENT — and
    `NaN <= q` is already False, so a fill buys nothing and only undoes the refusal.

    ── WHAT THIS CHECKS, AND WHAT IT DOES NOT ────────────────────────────────────────────────
    It checks ONE statement per binding: that `padj_written`/`spatial_written` is assigned exactly
    once, from a BARE NAME. That is a cheap tripwire for the obvious revert
    (`padj_written = np.where(np.isnan(padj), 1.0, padj)`), and nothing more.

    It is NOT the guarantee, and two earlier versions of this docstring claimed it was. A fill
    inserted on the line AFTER the binding (`np.copyto(padj_written, 1.0, where=...)` — a Call, not
    a Subscript-Store) or on the line BEFORE it (`padj[np.isnan(padj)] = 1.0` — a subscript store on
    a name this guard does not track) both leave it green. Both were demonstrated by mutation.
    Chasing that with an ever-cleverer static rule is what produced three rounds of defeated
    guards; a static check over a general-purpose language cannot bound the ways a value can be
    rewritten.

    THE GUARANTEE IS `test_a_masked_population_reaches_disk_as_NaN_engine_independently` below,
    which reads the value back off disk. This stays as the cheap first line of defence."""
    import ast

    compute = pathlib.Path(__file__).resolve().parents[1] / "compute"
    for name in ("clusters.py", "neighbourhoods.py"):
        src = (compute / name).read_text()
        tree = ast.parse(src)
        for binding in MASKED_BINDINGS:
            sources = _binding_sources(tree, binding)
            if not sources:
                assert binding == "spatial_written" and name == "clusters.py", (
                    f"{name}: {binding} is never assigned")
                continue
            assert len(sources) == 1, (
                f"{name}: {binding} is assigned {len(sources)} times; a second binding is where a "
                "refill hides")
            value = sources[0]
            assert isinstance(value, ast.Name), (
                f"{name}: {binding} is assigned from a {type(value).__name__}, not a bare name. "
                "A masked p-value must reach the writer untouched — anything computed here is a "
                "transformation of the engine's refusal.")
        # …and nothing mutates them in place afterwards, which an assignment check cannot see.
        for node in ast.walk(tree):
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) \
                    and node.value.id in MASKED_BINDINGS and isinstance(node.ctx, ast.Store):
                raise AssertionError(f"{name}: {node.value.id} is mutated by subscript assignment")


def test_a_NaN_survives_the_da_result_writer_to_disk_and_back():
    """The behavioural half, engine-independent: the storage layer must not coerce a NaN into a
    number on the way out. If it did, preserving the mask upstream would achieve nothing."""
    import tempfile

    from da_modules import import_own
    S = import_own("_shared")

    values = np.array([0.01, np.nan, 0.5], dtype=float)
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp)
        structure, meta = S.write_da_result(
            out, "columns/t.zarr", "t", ["p0", "p1", "p2"],
            {"padj": values, "neglog10_significance": K.neglog10(values)},
            regime="R1", multiplicity_family="BH within comparison")
        import txr_zarr_read
        read_back = np.asarray(txr_zarr_read.read_column(out / "columns/t.zarr", "padj"),
                               dtype=float)
    assert np.isnan(read_back[1]), "the writer coerced a masked value into a number"
    assert np.allclose(read_back[[0, 2]], values[[0, 2]])


def test_an_engine_MASKED_population_reaches_disk_as_NaN_through_the_REAL_entry(clusters_run):
    """TEST-41 [acceptance] [invariant: INV-DA-2] [covers: ITEM-5, ITEM-8] — the behavioural half,
    end to end, on the engine that actually produces a mask.

    The previous "behavioural" test called `write_da_result` on a hand-built array, so it exercised
    the STORAGE layer and would have passed with the entry-script fix fully reverted. And every
    other end-to-end test in this package runs `method: nb_glm`, so the PyDESeq2 Cook's-filter path
    — the one this whole fix exists for — was never executed by the suite at all.

    This drives the REAL entry script with the REAL default engine on a fixture that provably makes
    PyDESeq2 mask a population, and reads the WRITTEN columns back off disk."""
    pytest.importorskip("pydeseq2", reason=(
        "this asserts the behaviour of PyDESeq2's own Cook's-distance masking, so it needs the "
        "wheel pinned in env-rootfs/single-cell/requirements.txt. The rule it proves is pinned "
        "engine-independently by TEST-45 (the kernel's central correction) and TEST-47 (the same "
        "masked-but-fitted row through the real entry) — NOT by the AST guard above, which never "
        "reads `_kernel.py` and pins nothing about this rule. A skip message that misdirects the "
        "next engineer is the failure mode this file exists to end."))

    from da_fixtures import population_dataset

    pops, conds, samps = population_dataset(n_per_sample=240, samples_per_side=5)
    pops, conds, samps = list(pops), list(conds), list(samps)
    # ONE wildly outlying sample for ONE population, built by ADDING cells rather than relabelling
    # them (relabelling moves a count from one population to another and leaves neither extreme
    # enough). Below `min_replicates` (7) DESeq2 MASKS such a population rather than replacing its
    # outlier — and 5 replicates a side is exactly the regime this feature runs in.
    victim_sample, victim_pop = "s0_0", "D"
    victim_condition = next(c for c, s in zip(conds, samps) if s == victim_sample)
    for _ in range(6000):
        pops.append(victim_pop)
        conds.append(victim_condition)
        samps.append(victim_sample)

    run = clusters_run()
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "pydeseq2", "group1": "treat", "group2": "ctrl"})

    entry = run.da_entries()[0]
    members = run.da_members(entry)
    assert {"padj", "neglog10_significance"} <= members
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    headline = np.asarray(run.da_column(entry, "neglog10_significance"), dtype=float)

    masked = np.isnan(padj)
    assert masked.any(), (
        "no written `padj` is NaN. TWO causes are possible and this assertion cannot tell them "
        "apart, so check in this order: (1) the masked value was REFILLED between the kernel and "
        "the writer — that is a real regression and is what the engine-independent twin of this "
        "test, `test_a_masked_population_reaches_disk_as_NaN_engine_independently`, reports "
        "precisely; (2) this PyDESeq2 version no longer masks on this fixture, in which case the "
        "fixture needs repairing, not skipping. Look at (1) first.")
    assert np.all(np.isnan(headline[masked])), (
        "a population the engine refused to report was written with a finite headline value — it "
        "would be drawn on the volcano as a tested-and-null point")
    n_sig = run.report()["n_significant"]
    assert n_sig is not None and n_sig <= int(np.sum(~masked)), (
        "a masked population was counted as a discovery")


def test_a_masked_population_reaches_disk_as_NaN_engine_independently(clusters_run):
    """TEST-42 [acceptance] [invariant: INV-DA-2] [covers: ITEM-4, ITEM-5, ITEM-8] — THE guarantee.

    Three rounds of static guards for this rule were each defeated by a mutation that spelled the
    fill differently. The lesson is that the property is behavioural and has to be checked
    behaviourally: read the written column back OFF DISK and require the NaN to still be there.

    The obstacle was reaching a partially-masked result without the `pydeseq2` wheel, since that
    engine's Cook's filter is what masks in production and the dev host has no wheel. There IS an
    engine-independent route, through the ordinary per-cell input path: a population whose cells
    all live in a sample that `min_cells` DROPS becomes an all-zero column over the surviving
    samples, the NB-GLM cannot fit it, and its p comes back NaN while every other population fits
    normally. No monkeypatching, no engine-specific behaviour, no test-only code path.

    SCOPE, stated precisely rather than absolutely: this catches any UNCONDITIONAL refill on the
    path — in either entry, in `_kernel.bh`, or in `_shared.write_da_result` (all four verified by
    mutation). It does NOT catch a refill gated on the population having been fitted, because this
    fixture's masked row has a NaN `logFC` and no surviving cells. TEST-47 is the test for that
    shape; the two are complementary and neither is redundant.
    """
    from da_fixtures import population_dataset

    pops, conds, samps = population_dataset(n_per_sample=200, samples_per_side=3)
    pops, conds, samps = list(pops), list(conds), list(samps)

    # Thin ONE sample to well under `min_cells`, and give it — and only it — the cells of a
    # population that exists nowhere else.
    doomed = "s0_0"
    keep = [i for i, s in enumerate(samps) if s != doomed]
    thin = [i for i, s in enumerate(samps) if s == doomed][:10]
    idx = sorted(keep + thin)
    pops, conds, samps = ([pops[i] for i in idx], [conds[i] for i in idx], [samps[i] for i in idx])
    doomed_condition = next(c for c, s in zip(conds, samps) if s == doomed)
    for _ in range(20):
        pops.append("ORPHAN")
        conds.append(doomed_condition)
        samps.append(doomed)

    run = clusters_run()
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "min_cells": 100})

    report = run.report()
    assert doomed in {d["sample"] for d in report["dropped"]}, report["dropped"]
    assert report["regime"] == "R1", "the surviving samples must still support an inferential run"

    entry = run.da_entries()[0]
    populations = list(run.da_column(entry, "population"))
    assert "ORPHAN" in populations, "the orphaned population must still be a row of the table"
    orphan = populations.index("ORPHAN")

    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    headline = np.asarray(run.da_column(entry, "neglog10_significance"), dtype=float)

    # The kernel RECORDS its fit failures, so "the fixture stopped producing an unfittable
    # population" and "the fill came back" are distinguishable — and are reported as what they
    # are, rather than both pointing the next engineer at the fixture.
    n_failures = (report.get("fit") or {}).get("n_fit_failures")
    if n_failures:
        assert np.isnan(padj[orphan]), (
            f"the fit reported {n_failures} population(s) it could not fit, but the written "
            "`padj` for the orphan is FINITE — the masked value was REFILLED between the kernel "
            "and the writer.")
    others = np.delete(padj, orphan)
    assert np.sum(np.isfinite(others)) >= len(others) - 1, (
        "the other populations no longer fit, so this fixture is not isolating the orphan — "
        "repair the fixture")

    assert np.isnan(padj[orphan]), (
        "a population the model could not fit was written with a FINITE adjusted p. The NaN was "
        "refilled somewhere between the kernel and the writer — that turns 'we could not test "
        "this' into 'we tested it and found nothing', and puts the population on the volcano as "
        "a tested-and-null point.")
    assert np.isnan(headline[orphan]), (
        "the headline column refilled a masked value even though `padj` did not")
    n_sig = report["n_significant"]
    assert n_sig is not None and n_sig <= int(np.sum(np.isfinite(others))), (
        "a population that could not be fitted was counted as a discovery")


def test_a_masked_population_is_never_counted_as_a_discovery_even_at_fdr_1(clusters_run):
    """TEST-43 [covers: ITEM-5, ITEM-8] — the regime the two implementations differ in.

    `n_significant` used to be computed as `np.nan_to_num(x, nan=1.0) <= fdr`. The sentinel is
    exactly 1.0 and the comparison is `<=`, so the old and new code agree at every threshold
    EXCEPT `fdr = 1.0` — which the form permits (`require: number: {min: 0, max: 1}`) and which an
    agent call that never rendered the form is not bounded by at all. No test passed 1.0, so the
    fix had no regression coverage; this is it."""
    from da_fixtures import population_dataset

    pops, conds, samps = population_dataset(n_per_sample=200, samples_per_side=3)
    pops, conds, samps = list(pops), list(conds), list(samps)
    doomed = "s0_0"
    keep = [i for i, s in enumerate(samps) if s != doomed]
    thin = [i for i, s in enumerate(samps) if s == doomed][:10]
    idx = sorted(keep + thin)
    pops, conds, samps = ([pops[i] for i in idx], [conds[i] for i in idx], [samps[i] for i in idx])
    doomed_condition = next(c for c, s in zip(conds, samps) if s == doomed)
    for _ in range(20):
        pops.append("ORPHAN")
        conds.append(doomed_condition)
        samps.append(doomed)

    run = clusters_run()
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "min_cells": 100,
                "fdr": 1.0})

    entry = run.da_entries()[0]
    populations = list(run.da_column(entry, "population"))
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    orphan = populations.index("ORPHAN")
    assert np.isnan(padj[orphan]), "fixture no longer produces an unfittable population"

    n_fittable = int(np.sum(np.isfinite(padj)))
    assert run.report()["n_significant"] == n_fittable, (
        f"at fdr=1.0 every FITTABLE population is called ({n_fittable}), and the one the model "
        f"could not fit must NOT be — got {run.report()['n_significant']}")


def test_a_masked_neighbourhood_reaches_disk_as_NaN_engine_independently(neighbourhoods_run):
    """TEST-44 [acceptance] [invariant: INV-DA-2] [covers: ITEM-4, ITEM-6, ITEM-9] — the same
    guarantee on the PRIMARY analysis.

    The two entry scripts assemble their columns in SEPARATE code, so a test on one pins nothing
    about the other — and `da.neighbourhoods` is the entry that writes `spatial_fdr`, the column
    the whole connectivity-weighted correction exists to produce. It had no behavioural pin at all.

    Same engine-independent route as the cluster case: a spatially ISOLATED blob whose cells all
    belong to one small sample. The blob gets its own neighbourhoods; `min_cells` drops the sample;
    those neighbourhoods are then all-zero over the surviving samples and cannot be fitted."""
    import numpy as np

    rng = np.random.default_rng(5)
    dims = 6
    rows, conds, samps = [], [], []
    for side, cond in ((0, "ctrl"), (1, "treat")):
        for r in range(3):
            sample = f"s{side}_{r}"
            n = 220
            rows.append(rng.normal(size=(n, dims)).astype(np.float32))
            conds.extend([cond] * n)
            samps.extend([sample] * n)
    # …and one small sample that owns a blob far away from everything else.
    isolated = rng.normal(size=(40, dims)).astype(np.float32)
    isolated[:, 0] += 400.0
    rows.append(isolated)
    conds.extend(["ctrl"] * 40)
    samps.extend(["s0_lonely"] * 40)
    X = np.vstack(rows).astype(np.float32)

    run = neighbourhoods_run()
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "prop": 0.2,
                "min_cells": 100})

    report = run.report()
    assert "s0_lonely" in {d["sample"] for d in report["dropped"]}, report["dropped"]
    entry = run.da_entries()[0]
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    spatial = np.asarray(run.da_column(entry, "spatial_fdr"), dtype=float)
    headline = np.asarray(run.da_column(entry, "neglog10_significance"), dtype=float)

    # The kernel RECORDS how many populations it failed to fit, so the two reasons `padj` might
    # hold no NaN are distinguishable and are reported as what they are. Without this, restoring
    # the fill fails through the anti-vacuity assertion and tells the next engineer to change the
    # FIXTURE — pointing them away from the defect the test exists to catch.
    n_failures = (report.get("fit") or {}).get("n_fit_failures")
    unfittable = np.isnan(padj)
    if n_failures:
        assert unfittable.any(), (
            f"the fit reported {n_failures} neighbourhood(s) it could not fit, but NO written "
            "`padj` is NaN — the masked value was REFILLED between the kernel and the writer. "
            "That turns 'we could not test this' into 'we tested it and found nothing'.")
    assert unfittable.any(), (
        "no neighbourhood came back unfittable AND the fit reported no failures, so this fixture "
        "is not exercising the rule — repair the fixture (the isolated blob must own "
        "neighbourhoods of its own, and its sample must be dropped)")
    assert np.isfinite(padj).any(), "every neighbourhood is unfittable; the fixture is degenerate"

    assert np.all(np.isnan(spatial[unfittable])), (
        "a neighbourhood the model could not fit was written with a FINITE spatial FDR — the NaN "
        "was refilled between the kernel and the writer")
    assert np.all(np.isnan(headline[unfittable])), (
        "the headline column refilled a masked value even though `padj` did not")
    n_sig = report["n_significant"]
    assert n_sig is not None and n_sig <= int(np.sum(np.isfinite(spatial))), (
        "a neighbourhood that could not be fitted was counted as a discovery")


# ── TEST-45/46: the MASKED-BUT-FITTED row — the shape the defect actually had ──────────────
#
# WHY THESE EXIST. Round R1 mutation-tested TEST-42/44 and found the pattern exactly: they catch
# any UNCONDITIONAL refill anywhere on the path (entry, kernel or writer), and MISS every refill
# conditioned on the population having been fitted —
#
#     padj[np.isnan(padj) & np.isfinite(logfc)] = 1.0        # before the binding   (MISSED)
#     np.copyto(padj_written, 1.0, where=np.isnan(padj_written) & np.isfinite(logfc))  (MISSED)
#     padj[np.isnan(padj) & (desc["n_cells"] > 0)] = 1.0                              (MISSED)
#
# — which is the ONLY shape the production defect ever had. TEST-42/44 reach their NaN by a total
# FIT FAILURE, so their masked row has a NaN `logFC` and no surviving cells, and a fill gated on
# either of those simply steps around them. The fixture was the gap, not the approach.
#
# The state that has to be reached is the one PyDESeq2's Cook's filter produces: p ABSENT while
# `logFC`, `stat` and `n_cells` all stay FINITE AND NON-ZERO. Both tests below reach it with no
# third-party engine, so they run on every host.

def _stub_masked_engine(counts_df, design_df, contrast, *, condition_col, covariates,
                        normalization, reference_name, fail, small_sample_correction, **_kw):
    """An engine that MASKS one population's p-value while reporting a finite effect for it.

    This is not a mock of our own code — it is a stand-in for PyDESeq2's Cook's-distance filter,
    registered through `_kernel.register_method`, the same public extension point the two shipped
    engines use. It reports, for every population, a finite `logFC` and a finite Wald `stat`; for
    `MASKED_POP` it reports `pval = NaN`, exactly as `DeseqStats.summary()` does for an
    outlier-driven population.
    """
    out = {}
    for j, pop in enumerate(str(c) for c in counts_df.columns):
        out[pop] = {"logFC": 1.5 + j, "stat": 4.0 + j, "base_mean": 100.0 + j,
                    "pval": (float("nan") if pop == MASKED_POP else 0.5)}
    return out, {"engine_size_factors": [1.0] * counts_df.shape[0],
                 "small_sample_correction": bool(small_sample_correction),
                 "residual_df": (4 if small_sample_correction else None)}


MASKED_POP = "B"
STUB_KEY = "stub_masked"


@pytest.fixture
def stub_engine():
    """Register the masking stub for one test, then restore the catalog exactly."""
    before = dict(K._METHODS)
    K.register_method(STUB_KEY, label="stub", description="test stub", requires=[],
                      run=_stub_masked_engine, small_sample_correction=True)
    try:
        yield STUB_KEY
    finally:
        K._METHODS.clear()
        K._METHODS.update(before)


def _stub_frames():
    pd = pytest.importorskip("pandas")
    samples = [f"s{i}" for i in range(6)]
    counts = pd.DataFrame(
        [[100, 120, 90], [110, 130, 95], [105, 125, 92],
         [140, 60, 130], [150, 55, 135], [145, 58, 132]],
        index=samples, columns=["A", MASKED_POP, "C"])
    design = pd.DataFrame({"condition": ["ctrl"] * 3 + ["treat"] * 3}, index=samples)
    return counts, design


def test_the_kernel_keeps_a_masked_p_absent_while_correcting_the_rest(stub_engine):
    """TEST-45 [acceptance] [invariant: INV-DA-2] [covers: ITEM-5, ITEM-8] — the small-sample
    correction must NOT resurrect a p-value the engine declined to report.

    This is the round-R1 finding at the kernel level. The rule used to live inside
    `_run_pydeseq2`, where no host without the `pydeseq2` wheel could execute it: a mutation that
    reverted it to `assign(pvalue=corrected)` left the ENTIRE suite green, because every test that
    reached the line sat behind an `importorskip`. It now lives in `fit()` on the common path,
    and this reaches it with no third-party engine at all.
    """
    counts, design = _stub_frames()

    def _fail(msg):
        raise AssertionError(msg)

    results, record = K.fit(counts, design, ("treat", "ctrl"), condition_col="condition",
                            method=stub_engine, small_sample_correction=True, fail=_fail)

    assert record["small_sample_correction"] is True
    assert np.isnan(results[MASKED_POP]["pval"]), (
        "the small-sample correction recomputed a p-value for a population the engine MASKED. "
        "The engine's `stat` stays finite through Cook's filtering, so re-referring it "
        "unconditionally hands an outlier-driven population a fresh, finite p and lets it become "
        "a discovery — the engine's own refusal to report, silently undone (INV-DA-2).")
    assert np.isfinite(results[MASKED_POP]["logFC"]), (
        "the fixture no longer reproduces the masked-BUT-FITTED state: a masked row with a NaN "
        "effect is the state TEST-42 already covers, and is not the shape of this defect")
    for pop in ("A", "C"):
        p = results[pop]["pval"]
        assert np.isfinite(p) and p != 0.5, (
            f"{pop}: the correction was not applied at all — the reported p is still the engine's "
            "own normal-reference value, so this test would pass with the whole feature removed")


def test_correct_preserving_mask_is_the_identity_on_absence():
    """TEST-46 [invariant: INV-DA-2] — the rule as a pure function, so the mutation that deletes
    it is caught even if the call site is restructured again."""
    engine_p = np.array([0.04, np.nan, 0.9, np.nan])
    stat = np.array([3.0, 5.0, 0.2, np.nan])
    out = K.correct_preserving_mask(engine_p, stat, 4)

    assert np.isnan(out[1]), (
        "a FINITE statistic with an ABSENT engine p-value was given a p-value. This is exactly "
        "the Cook's-filtered row: `stat` survives the mask, `pvalue` does not.")
    assert np.isnan(out[3]), "a NaN statistic produced a non-NaN p-value"
    assert np.isfinite(out[0]) and np.isfinite(out[2]), "the correction was not applied"
    assert out[0] < out[2], "the t reference did not preserve the ordering of |stat|"
    assert np.all(np.isnan(K.correct_preserving_mask(engine_p, stat, 0))), (
        "a non-positive residual df must null the whole p-family, not fall back to a normal")


#: Registers the masking stub INSIDE the entry's own interpreter. `sitecustomize` is stdlib and
#: runs at startup, so this needs no hook in production code — the entry script, the kernel and
#: the writer all run exactly as shipped and simply see one more registered engine. `_shared` is
#: imported FIRST, for the same reason the entry imports it first: it pins the determinism
#: environment before numpy loads, and that ordering must not be perturbed by the harness.
_SITECUSTOMIZE = '''
import os, sys
_d = os.environ.get("TXR_TEST_ENGINE_DIR")
if _d:
    sys.path.insert(0, _d)
    import _shared  # noqa: F401  — determinism pin, before numpy
    import _kernel

    def _stub(counts_df, design_df, contrast, *, condition_col, covariates, normalization,
              reference_name, fail, small_sample_correction, **_kw):
        out = {}
        want = os.environ["TXR_TEST_MASKED_POP"]
        for j, pop in enumerate(str(c) for c in counts_df.columns):
            # `#<i>` masks by COLUMN INDEX. Neighbourhood ids (`nhood7`) are discovered from the
            # embedding at run time, so a test cannot name one in advance the way it can name a
            # cluster label.
            masked = (j == int(want[1:])) if want.startswith("#") else (pop == want)
            out[pop] = {"logFC": 1.5 + j, "stat": 4.0 + j, "base_mean": 100.0 + j,
                        "pval": (float("nan") if masked else 0.01)}
        return out, {"engine_size_factors": [1.0] * counts_df.shape[0],
                     "small_sample_correction": bool(small_sample_correction),
                     "residual_df": (4 if small_sample_correction else None)}

    _kernel.register_method("stub_masked", label="stub", description="test stub", requires=[],
                            run=_stub, small_sample_correction=True)
'''


def _run_with_masking_engine(run, masked_pop, params):
    """Drive the REAL entry script with an engine that masks `masked_pop`'s p-value while
    reporting a finite effect and finite cell counts for it."""
    import os
    from da_fixtures import _HELPERS_DIR, _LIB_DIR, _COMPUTE

    stub_dir = run.outputs_dir.parent / "stub_site"
    stub_dir.mkdir(exist_ok=True)
    (stub_dir / "sitecustomize.py").write_text(_SITECUSTOMIZE)
    # PREPEND, never replace. `env_extra` overwrites, and the host's own `PYTHONPATH` is where a
    # third-party wheel may be coming from — a round-R2 auditor installed `pydeseq2` that way and
    # this test was the one thing in the suite that dropped it, failing for a reason that had
    # nothing to do with what it asserts. A test that only works when the environment is provided
    # one particular way is testing the environment.
    inherited = [p for p in (os.environ.get("PYTHONPATH") or "").split(os.pathsep) if p]
    return run.run_ok({**params, "method": "stub_masked"}, env_extra={
        "PYTHONPATH": os.pathsep.join(
            [str(stub_dir), str(_HELPERS_DIR), str(_LIB_DIR), *inherited]),
        "TXR_TEST_ENGINE_DIR": str(_COMPUTE),
        "TXR_TEST_MASKED_POP": masked_pop,
    })


def test_a_masked_BUT_FITTED_population_reaches_disk_as_NaN_in_da_clusters(clusters_run):
    """TEST-47 [acceptance] [invariant: INV-DA-2] [covers: ITEM-4, ITEM-5, ITEM-8] — the entry
    half of the round-R1 finding, on `da.clusters`.

    TEST-42's masked row has a NaN `logFC` and zero surviving cells, so a refill written as
    `padj[np.isnan(padj) & np.isfinite(logfc)] = 1.0` — or gated on `n_cells > 0` — steps straight
    around it. Three such mutations were demonstrated GREEN against the whole suite. This test's
    masked population is FITTED: finite effect, finite statistic, thousands of cells, p absent.
    Every one of those refills turns it red.
    """
    run = clusters_run()
    pops, conds, samps = _bind(run, samples_per_side=3, n_per_sample=200)
    masked = sorted(set(pops))[1]
    _run_with_masking_engine(run, masked, {"group1": "treat", "group2": "ctrl"})

    entry = run.da_entries()[0]
    labels = [str(x) for x in run.da_column(entry, "population")]
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    headline = np.asarray(run.da_column(entry, "neglog10_significance"), dtype=float)
    logfc = np.asarray(run.da_column(entry, "logFC"), dtype=float)
    n_cells = np.asarray(run.da_column(entry, "n_cells"), dtype=float)

    i = labels.index(masked)
    assert np.isfinite(logfc[i]) and n_cells[i] > 0, (
        "the fixture no longer reproduces the masked-BUT-FITTED state — it has degenerated into "
        "the unfitted state TEST-42 already covers, and this test would then no longer detect a "
        "refill conditioned on the population having been fitted")
    assert np.isnan(padj[i]), (
        f"`padj` for {masked!r} reached disk as {padj[i]!r} instead of ABSENT. The engine declined "
        "to report a p-value for this population while still reporting a finite effect — the "
        "Cook's-filtered shape — and something on the path from the kernel to the writer refilled "
        "it. `NaN <= q` is already False, so the fill buys nothing and only undoes the refusal "
        "(INV-DA-2).")
    assert np.isnan(headline[i]), (
        f"the headline column for {masked!r} is finite while its `padj` is absent — it would be "
        "drawn on the volcano as a tested-and-null point")
    assert np.count_nonzero(~np.isnan(padj)) >= 2, (
        "every population came back masked, so this test would pass with the p-family removed")
    n_sig = run.report()["n_significant"]
    assert n_sig is not None and n_sig <= int(np.sum(~np.isnan(padj))), (
        "a masked-but-fitted population was counted as a discovery")


def _stub_no_df_engine(counts_df, design_df, contrast, *, condition_col, covariates,
                       normalization, reference_name, fail, small_sample_correction, **_kw):
    """An engine that reports a statistic but OMITS `residual_df` from its record."""
    out = {}
    for j, pop in enumerate(str(c) for c in counts_df.columns):
        out[pop] = {"logFC": 1.5 + j, "stat": 4.0 + j, "base_mean": 100.0 + j, "pval": 0.5}
    return out, {"engine_size_factors": [1.0] * counts_df.shape[0],
                 "small_sample_correction": bool(small_sample_correction)}


def test_an_engine_that_reports_no_residual_df_does_not_silently_null_the_p_family():
    """TEST-49 [invariant: INV-DA-2] — the failure mode the centralised correction could have
    introduced, closed before it shipped.

    `t_reference_pvalues(stat, None)` returns all-NaN by design (a non-positive/absent df means
    there is no reference distribution). Moving the correction onto the common path meant a record
    that merely OMITTED `residual_df` would null the ENTIRE p-family — and an absence with no
    reason behind it is precisely what INV-DA-2 exists to prevent: the run would read as "nothing
    was testable" while the regime still said R1. `fit()` falls back to the df it computed itself
    before dispatch, which is the same quantity over the same design.
    """
    before = dict(K._METHODS)
    K.register_method("stub_no_df", label="stub", description="test stub", requires=[],
                      run=_stub_no_df_engine, small_sample_correction=True)
    try:
        counts, design = _stub_frames()

        def _fail(msg):
            raise AssertionError(msg)

        results, record = K.fit(counts, design, ("treat", "ctrl"), condition_col="condition",
                                method="stub_no_df", small_sample_correction=True, fail=_fail)
    finally:
        K._METHODS.clear()
        K._METHODS.update(before)

    assert record["residual_df"] == 4, (
        f"expected the pre-dispatch residual df (6 samples - rank 2) to be recorded, got "
        f"{record['residual_df']!r}")
    assert all(np.isfinite(v["pval"]) for v in results.values()), (
        "the whole p-family came back ABSENT because the engine omitted `residual_df`. An "
        "absence has to have a reason behind it; this one would have had none.")


def test_a_masked_BUT_FITTED_neighbourhood_reaches_disk_as_NaN_in_da_neighbourhoods(
        neighbourhoods_run):
    """TEST-51 [acceptance] [invariant: INV-DA-2, INV-DA-4] [covers: ITEM-5, ITEM-8] — TEST-47's
    twin on the OTHER entry, and the finding that says why one test is not two.

    Round R2 found that `da.neighbourhoods` had NO masked-but-fitted coverage at all. TEST-47
    drives `da.clusters` only; TEST-44 reaches its NaN by a total fit failure, so a refill gated on
    the neighbourhood having been fitted steps around it — the exact pattern round R1 identified on
    `da.clusters` and closed only there. The auditor demonstrated it: inserting

        np.copyto(spatial_written, 1.0, where=np.isnan(spatial_written) & np.isfinite(logfc))

    into `neighbourhoods.py` left the WHOLE suite green at 208 passed.

    ── THE METHOD ERROR THAT HID IT, WHICH MATTERS MORE THAN THE GAP ─────────────────────────
    Round 7's mutation battery applied each mutation to `clusters.py` AND `neighbourhoods.py`
    together and recorded "both entries … CAUGHT". A mutation applied to two files at once cannot
    tell you which file's coverage caught it — one red is consistent with either. The table was
    right about clusters and wrong about neighbourhoods, and the design of the battery is what made
    that indistinguishable. **Mutate ONE target at a time, or the result names no target.**

    This asserts on `spatial_fdr` as well as `padj`, because on this entry the headline column and
    `n_significant` are both taken from the spatially-weighted value (INV-DA-4).
    """
    run = neighbourhoods_run()
    from test_neighbourhoods_end_to_end import _bind as _bind_nhoods

    _bind_nhoods(run, samples_per_side=3, n_per_sample=200)
    _run_with_masking_engine(run, "#1", {"prop": 0.15})

    entry = run.da_entries()[0]
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    spatial = np.asarray(run.da_column(entry, "spatial_fdr"), dtype=float)
    headline = np.asarray(run.da_column(entry, "neglog10_significance"), dtype=float)
    logfc = np.asarray(run.da_column(entry, "logFC"), dtype=float)
    n_cells = np.asarray(run.da_column(entry, "n_cells"), dtype=float)

    i = 1  # the stub masks column index 1
    assert np.isfinite(logfc[i]) and n_cells[i] > 0, (
        "the fixture no longer reproduces the masked-BUT-FITTED state on this entry — it has "
        "degenerated into the unfitted state TEST-44 already covers")
    assert np.isnan(padj[i]), (
        f"`padj` for the masked-but-fitted neighbourhood reached disk as {padj[i]!r} instead of "
        "ABSENT (INV-DA-2)")
    assert np.isnan(spatial[i]), (
        f"`spatial_fdr` for the masked-but-fitted neighbourhood reached disk as {spatial[i]!r} "
        "instead of ABSENT. This is the column the headline and `n_significant` are taken from on "
        "this entry, so a refill here is what actually turns a refusal into a discovery.")
    assert np.isnan(headline[i]), (
        "the headline column is finite while `spatial_fdr` is absent — it would be drawn on the "
        "volcano as a tested-and-null point")
    assert np.count_nonzero(~np.isnan(spatial)) >= 2, (
        "every neighbourhood came back masked, so this test would pass with the p-family removed")
    n_sig = run.report()["n_significant"]
    assert n_sig is not None and n_sig <= int(np.sum(~np.isnan(spatial))), (
        "a masked-but-fitted neighbourhood was counted as a discovery")


def test_an_UNFITTABLE_neighbourhood_is_not_a_discovery_even_at_fdr_1(neighbourhoods_run):
    """TEST-52 [acceptance] [invariant: INV-DA-2, INV-DA-4] — TEST-43's twin on the neighbourhood
    entry, at the ONE threshold where the sentinel and the mask differ.

    Round R2: reverting `_called` to `np.nan_to_num(spatial_written, nan=1.0) <= fdr` left the whole
    suite green, because no neighbourhood test passed `fdr: 1.0` and at the default 0.1 the
    sentinel 1.0 is above the threshold anyway.

    ── AND THE FIRST VERSION OF THIS TEST WAS VACUOUS, WHICH IS THE POINT WORTH KEEPING ──────
    It used the ordinary fixture and asserted `n_significant <= n_fittable`. Measured across four
    parameter settings, that fixture yields **zero** unfittable neighbourhoods (173/173, 295/295,
    141/141, 225/225), so the assertion could not fail whatever the code did — and the mutation
    battery duly reported it MISSED. A test whose fixture cannot reach the state it describes is
    not a weak test, it is not a test. The fixture, not the assertion, was the defect — the same
    diagnosis as round R1's, one level down.

    This uses TEST-44's isolated-blob fixture, which provably DOES produce unfittable
    neighbourhoods: a far-away blob owned by one small sample gets its own neighbourhoods,
    `min_cells` drops the sample, and those neighbourhoods are all-zero over the survivors.
    """
    rng = np.random.default_rng(5)
    dims = 6
    rows, conds, samps = [], [], []
    for side, cond in ((0, "ctrl"), (1, "treat")):
        for r in range(3):
            n = 220
            rows.append(rng.normal(size=(n, dims)).astype(np.float32))
            conds.extend([cond] * n)
            samps.extend([f"s{side}_{r}"] * n)
    isolated = rng.normal(size=(40, dims)).astype(np.float32)
    isolated[:, 0] += 400.0
    rows.append(isolated)
    conds.extend(["ctrl"] * 40)
    samps.extend(["s0_lonely"] * 40)
    X = np.vstack(rows).astype(np.float32)

    run = neighbourhoods_run()
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "prop": 0.2,
                "min_cells": 100, "fdr": 1.0})

    entry = run.da_entries()[0]
    spatial = np.asarray(run.da_column(entry, "spatial_fdr"), dtype=float)
    n_fittable = int(np.sum(~np.isnan(spatial)))
    n_unfittable = int(np.sum(np.isnan(spatial)))
    n_sig = run.report()["n_significant"]

    assert n_unfittable > 0, (
        "the fixture produced no unfittable neighbourhood, so this test cannot distinguish the "
        "NaN sentinel from the mask and would pass either way — the exact vacuity round R2 caught")
    assert n_sig is not None
    assert n_sig <= n_fittable, (
        f"at fdr=1.0 the run counted {n_sig} discoveries among {len(spatial)} rows of which only "
        f"{n_fittable} were fittable ({n_unfittable} absent). An ABSENT spatial FDR was treated as "
        "1.0, and 1.0 <= 1.0, so a neighbourhood the model could not fit became a discovery. "
        "`NaN <= q` is False for every q — that is the whole reason the value is written absent "
        "rather than filled (INV-DA-2).")


# ─────────────────────────────────────────────────────────────────────────────────────────────
# TEST-56 — the absence that is fabricated UPSTREAM of the mask.
#
# Every guard above this line watches the path from the kernel's NaN to the written column, and
# they are the right guards for the defect this feature was aborted over: a masked p-value being
# refilled on its way to disk. TEST-42/44 close that by reading the column back OFF DISK, which
# no spelling of a fill can evade.
#
# This is the OTHER hole, and it is invisible to all of them, because there is no NaN to preserve.
# A population absent from every sample of one contrast side has no finite coefficient — the MLE
# runs to infinity. `statsmodels` does not raise and does not report failure: it returns
# `converged=True` with a standard error of ~1.6e4, so the Wald p comes back ~0.999. The engine
# hands the writer a fabricated finite number and the writer faithfully writes it. Absence is
# never expressed, so absence cannot be preserved.
#
# The fix makes the non-identified fit take the SAME path an exception already took, so this is
# pinned by the same machinery the rest of the file relies on rather than a parallel one.
# ─────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("engine", ENGINES)
def test_a_population_absent_from_one_condition_is_never_a_tested_and_null_result(engine):
    """TEST-56 [acceptance] [invariant: INV-DA-2] [covers: ITEM-4, ITEM-5, ITEM-8]

    Asserted on EVERY installed engine, not just the one that had the bug: the property is a
    promise of the analysis, not of `statsmodels`. The `pydeseq2` arm was already correct here and
    stays as the control that the fixture really does describe a discoverable effect.
    """
    import sim
    from engines import kernel_fail
    import _kernel as K

    counts, samples, conditions, absent = sim.one_sided_counts(n_populations=8, n_per_side=5)
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)

    results, record = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                            covariates=[], method=engine, normalization="poscounts",
                            reference=None, small_sample_correction=True, fail=kernel_fail)

    pop = populations[absent]
    r = results[pop]

    # The fixture must really be separated, or this test proves nothing about anything.
    assert counts[[c == "ctrl" for c in conditions], absent].sum() == 0
    assert counts[[c == "treat" for c in conditions], absent].sum() > 0

    assert np.isnan(r["pval"]), (
        f"[{engine}] a population with ZERO cells in every control sample was reported with a "
        f"finite p-value of {r['pval']!r}. Its coefficient is unbounded — there is no Wald test "
        "to report — so a number here is fabricated, and it is the WORST case to fabricate: this "
        "is the strongest signal a differential-abundance run can contain, and a p near 1 sorts "
        "it LAST on the volcano and in the ranked table.")
    assert np.isnan(r["logFC"]), (
        f"[{engine}] the separated population carries a finite logFC of {r['logFC']!r}. An "
        "unbounded fold change reported as a number is a fabricated magnitude — the same rule "
        "`descriptive_columns` already applies to a zero-mean side.")

    # The refusal is RECORDED, not silent: a run that could not test a population must say so.
    failures = (record or {}).get("fit_failures") or []
    assert any(f.get("population") == pop for f in failures), (
        f"[{engine}] the population was written as unfitted but does not appear in "
        f"`fit_failures`, so `n_fit_failures` under-counts and the run record reads clean: "
        f"{failures!r}")

    # ANTI-VACUITY, both directions. Every OTHER population must still fit, or the fixture is
    # simply breaking the whole run and the assertions above would hold for the wrong reason.
    others = [populations[j] for j in range(len(populations)) if j != absent]
    fitted_others = [p for p in others if not np.isnan(results[p]["pval"])]
    assert len(fitted_others) >= len(others) - 1, (
        f"[{engine}] only {len(fitted_others)} of {len(others)} unseparated populations fitted — "
        "the fixture is not isolating the separated one; repair the fixture rather than this "
        "assertion")


@pytest.mark.parametrize("engine", ENGINES)
def test_the_ALR_reference_population_is_reported_as_assumed_not_as_tested(engine):
    """TEST-57 [acceptance] [invariant: INV-DA-1, INV-DA-2] [covers: ITEM-5, ITEM-8]

    Under `reference` normalization the named population's own count IS the offset, so its
    condition coefficient is zero BY CONSTRUCTION. Both engines report that as a converged,
    tested-and-null row — `nb_glm` gave logFC -3.7e-12 / padj 1.0, PyDESeq2 pval 0.99999979 — and
    "reference population B: no change, p = 1" reads as EVIDENCE that the constancy assumption
    held. It is not evidence; it is the assumption reflected back at the reader. It also consumed
    a slot in the BH family, inflating `m` for a hypothesis nobody tested.

    Distinct from TEST-56: that one is a coefficient that does not EXIST (unbounded); this is one
    that exists and is exactly zero for a reason unrelated to the data.
    """
    import sim
    from engines import kernel_fail
    import _kernel as K

    counts, samples, conditions, _ = sim.shifted_counts(n_populations=6, n_per_side=5)
    counts_df, design_df, populations = sim.counts_frame(counts, samples, conditions)
    ref = populations[2]

    results, record = K.fit(counts_df, design_df, ("treat", "ctrl"), condition_col="condition",
                            covariates=[], method=engine, normalization="reference",
                            reference=ref, small_sample_correction=True, fail=kernel_fail)

    assert np.isnan(results[ref]["pval"]), (
        f"[{engine}] the ALR reference population {ref!r} was written with a finite p-value of "
        f"{results[ref]['pval']!r}. Its coefficient is zero because it defines the offset, not "
        "because the data said so — presenting that as a test result invites the reader to take "
        "it as confirmation that the normalization's constancy assumption held.")
    assert np.isnan(results[ref]["logFC"]), (
        f"[{engine}] the reference population carries a finite logFC of {results[ref]['logFC']!r}")

    assert "reference_population_untested" in record, (
        f"[{engine}] the reference row is absent from the p-family but the run record does not "
        "say WHY — an absence with no stated reason is the thing this package refuses")

    # It leaves the multiple-testing family: BH's `m` counts only tested hypotheses.
    padj = K.bh([results[p]["pval"] for p in populations])
    assert int(np.sum(~np.isnan(padj))) == len(populations) - 1, (
        f"[{engine}] the BH family still counts {int(np.sum(~np.isnan(padj)))} of "
        f"{len(populations)} populations; the untested reference must not inflate `m`")

    # ANTI-VACUITY: every other population must still be tested, or this passes for the wrong
    # reason (a run that fitted nothing would satisfy the assertions above).
    others = [p for p in populations if p != ref]
    fitted = [p for p in others if not np.isnan(results[p]["pval"])]
    assert len(fitted) == len(others), (
        f"[{engine}] only {len(fitted)} of {len(others)} non-reference populations were tested — "
        "the reference handling has nulled more than the reference row")
