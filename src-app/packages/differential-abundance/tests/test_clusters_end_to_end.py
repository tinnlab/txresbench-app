#!/usr/bin/env python3
# ruff: noqa
"""TEST-11 [covers: ITEM-8, ITEM-1] — `da.clusters` end to end, from three metadata columns.

The cheapest path to real value in the epic, and the claim is literal: no expression matrix, no
embedding, no neighbourhood machinery. Three categorical columns are a complete input, which is
what removes the raw-counts gate, the banded CSC read and the matrix memory ceiling that dominate
`de.compare`.
"""
import numpy as np
import pytest

from da_fixtures import population_dataset, EXTERNAL


def _run(run, *, method="nb_glm", params=None, samples_per_side=3, n_per_sample=200):
    pops, conds, samps = population_dataset(n_per_sample=n_per_sample,
                                            samples_per_side=samples_per_side)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    body = {"method": method, "group1": "treat", "group2": "ctrl"}
    body.update(params or {})
    proc = run.run_ok(body)
    return proc, pops, conds, samps


def test_it_runs_from_three_metadata_columns_and_nothing_else(clusters_run):
    run = clusters_run()
    proc, pops, _, _ = _run(run)
    manifest = run.manifest()
    datatypes = [e["datatype"] for e in manifest["outputs"]]
    assert "da/result" in datatypes and "report/qc" in datatypes
    # the whole input set was three columns — the harness would have failed on a missing mount
    assert len(run._entries) == 3
    phases = run.progress_phases(proc)
    assert phases[0] == "resolve" and phases[-1] == "done"
    assert "count" in phases and "normalize" in phases and "write" in phases


def test_the_result_carries_one_row_per_population_and_the_shifted_one_leads(clusters_run):
    run = clusters_run()
    _run(run)
    entry = run.da_entries()[0]
    populations = list(run.da_column(entry, "population"))
    assert populations == sorted(set(populations))
    logfc = np.asarray(run.da_column(entry, "logFC"), dtype=float)
    assert populations[int(np.nanargmax(logfc))] == "A", (
        "population A is the one the fixture genuinely expands; it must have the largest effect")
    n_cells = np.asarray(run.da_column(entry, "n_cells"), dtype=float)
    assert n_cells.sum() > 0 and np.all(n_cells > 0)
    props1 = np.asarray(run.da_column(entry, "mean_prop_1"), dtype=float)
    props2 = np.asarray(run.da_column(entry, "mean_prop_2"), dtype=float)
    assert abs(props1.sum() - 1.0) < 1e-6 and abs(props2.sum() - 1.0) < 1e-6, (
        "the reported mean proportions must sum to 1 within a side — they are a composition")


def test_spatial_fdr_is_absent_from_a_cluster_result_in_every_regime(clusters_run):
    """INV-DA-4: clusters are DISJOINT, so a connectivity weight over them is meaningless, and
    emitting a meaningless column is worse than omitting it."""
    for provenance in (EXTERNAL, None):
        run = clusters_run()
        pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=3)
        run.add_column(pops, slot="population", name="leiden")
        run.add_column(conds, slot="condition", name="condition", provenance=provenance)
        run.add_column(samps, slot="sample", name="sample")
        run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
        entry = run.da_entries()[0]
        assert "spatial_fdr" not in run.da_members(entry)
        assert run.da_cyto(entry)["da"]["spatial_fdr_written"] is False


def test_it_commits_a_per_cell_effect_column_that_colours_the_embedding_for_free(clusters_run):
    run = clusters_run()
    _run(run)
    columns = run.column_entries()
    assert len(columns) == 1, "exactly one per-cell effect column is expected"
    entry = columns[0]
    assert entry["datatype"] == "metadata-column"
    assert entry["meta"]["axis"] == "cells"
    values = run.da_column(entry, "values")
    assert len(values) > 0


def test_the_effect_column_can_be_switched_off(clusters_run):
    run = clusters_run()
    _run(run, params={"emit_effect_column": "no"})
    assert run.column_entries() == []


def test_a_sample_spanning_two_conditions_is_refused_by_name(clusters_run):
    """The design frame's row IS a sample, so a sample that spans two conditions has no row to
    occupy. Taking the first (or the majority) would make the tested coefficient describe
    something the data does not say."""
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    conds = list(conds)
    # flip ONE cell's condition so its sample now carries two
    victim = samps[0]
    for i, s in enumerate(samps):
        if s == victim:
            conds[i] = "treat" if conds[i] == "ctrl" else "ctrl"
            break
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert victim in msg and "distinct condition" in msg


def test_a_single_population_level_is_refused_because_there_is_no_composition(clusters_run):
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run.add_column(["only"] * len(pops), slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    assert proc.returncode != 0
    assert "no composition to compare" in run.diagnostics(proc)


def test_a_missing_sample_column_is_refused_because_the_sample_is_the_unit_of_replication(clusters_run):
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    assert proc.returncode != 0
    assert "unit of replication" in run.diagnostics(proc)


def test_the_report_is_a_da_report_document_the_visualize_section_can_read(clusters_run):
    run = clusters_run()
    _run(run)
    report = run.report()
    assert report["kind"] == "da-report"
    assert report["analysis"] == "da.clusters"
    assert report["grouped"] is True
    assert len(report["groups"]) == 1
    row = report["comparisons"][0]
    for key in ("id", "key", "name", "label", "qualifier", "group", "regime"):
        assert row[key], key
    assert row["qualifier"] == report["regime"], (
        "the regime rides each row as `qualifier` — the renderer-supported inline distinguisher")
    assert row["significance_column"] == "padj", (
        "cluster rows threshold on plain BH `padj`; there is no spatial FDR for disjoint "
        "populations")


def test_a_covariate_column_enters_the_design_formula(clusters_run):
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=3)
    batch = ["b0" if s.endswith("_0") else "b1" for s in samps]
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.add_column(batch, slot="covariate:batch", name="batch")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    report = run.report()
    assert report["fit"]["design_formula"] == "~batch + condition", report["fit"]["design_formula"]


def test_a_covariate_that_varies_within_a_sample_is_refused_by_name(clusters_run):
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    batch = ["b0"] * len(samps)
    batch[0] = "b1"                                  # now sample samps[0] carries two batches
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.add_column(batch, slot="covariate:batch", name="batch")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    assert proc.returncode != 0
    assert "covariate 'batch'" in run.diagnostics(proc)


def test_the_reference_normalization_runs_and_records_its_assumption(clusters_run):
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=200, samples_per_side=3)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "normalization": "reference", "reference": "C"})
    report = run.report()
    assert report["normalization"]["normalization"] == "reference"
    assert report["normalization"]["reference_population"] == "C"
    assert "ABSOLUTE ABUNDANCE IS CONSTANT" in report["normalization"]["assumption"]
    entry = run.da_entries()[0]
    attrs = run.da_cyto(entry)["da"]
    assert attrs["normalization"] == "reference"
    assert attrs["reference_population"] == "C"
    # THE REFERENCE ROW IS ABSENT, NOT ~0. This assertion used to read
    #     assert abs(logfc[populations.index("C")]) < 0.2
    # i.e. it PINNED the tautology as a property. That is exactly the defect round R3 found: the
    # reference population's count IS the offset, so its coefficient is zero by construction and
    # not by measurement, and writing it as a tested-and-null row invites a reader to take
    # "reference C: no change, p = 1" as EVIDENCE that the normalization's constancy assumption
    # held. The old assertion could not distinguish "the assumption held" from "the arithmetic
    # is circular", because only the second one is ever true.
    #
    # It is now ABSENT and the reason is recorded by name, so this asserts that instead. Note it
    # is strictly stronger: |logfc| < 0.2 was satisfied by NaN's predecessor value and by any
    # small number, whereas `isnan` is satisfied by exactly one state.
    populations = list(run.da_column(entry, "population"))
    logfc = np.asarray(run.da_column(entry, "logFC"), dtype=float)
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    ref = populations.index("C")
    assert np.isnan(logfc[ref]), (
        f"the ALR reference population was written with a finite logFC of {logfc[ref]!r}; its "
        "coefficient is zero because it defines the offset, so reporting it as a measured effect "
        "is a tautology presented as a result")
    assert np.isnan(padj[ref]), (
        f"the ALR reference population was written with a finite padj of {padj[ref]!r}, and it "
        "therefore also consumed a slot in the BH family for a hypothesis nobody tested")
    # ANTI-VACUITY: every OTHER population must still carry a real effect, or this passes because
    # the run produced nothing at all.
    others = [i for i in range(len(populations)) if i != ref]
    assert np.sum(np.isfinite(logfc[others])) >= len(others) - 1, (
        "the non-reference populations lost their effects too — the reference handling nulled "
        "more than the reference row")


def test_the_headline_column_is_minus_log10_of_plain_BH_for_disjoint_populations(clusters_run):
    """`da.clusters` populations are DISJOINT, so plain BH is the right correction and the volcano
    must threshold on THAT, not on the raw p (INV-DA-4)."""
    run = clusters_run()
    _run(run)
    entry = run.da_entries()[0]
    members = run.da_members(entry)
    assert "neglog10_significance" in members
    assert "spatial_fdr" not in members
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    headline = np.asarray(run.da_column(entry, "neglog10_significance"), dtype=float)
    neglog10p = np.asarray(run.da_column(entry, "neglog10p"), dtype=float)
    assert np.allclose(headline, -np.log10(np.clip(padj, 1e-300, 1.0)), rtol=0, atol=1e-9)
    assert np.any(headline < neglog10p - 1e-9), (
        "an adjusted value can only be >= the raw p, so its −log10 must be <= the raw −log10p "
        "somewhere; if they are identical the correction is inert")
    assert run.da_cyto(entry)["da"]["headline_column"] == "neglog10_significance"


def test_the_fdr_threshold_is_APPLIED_not_merely_recorded(clusters_run):
    strict = clusters_run()
    _run(strict, params={"fdr": 0.0001})
    loose = clusters_run()
    _run(loose, params={"fdr": 0.9})
    assert strict.report()["fdr_threshold"] == 0.0001
    assert loose.report()["n_significant"] > strict.report()["n_significant"], (
        "the FDR threshold changed nothing about what the run reported")


def test_a_covariate_named_condition_is_refused_rather_than_shadowing_the_tested_column(clusters_run):
    """TEST-28 [covers: ITEM-5] — `{"condition": …, **covariates}` — a covariate literally named `condition` would be
    splatted OVER the tested coefficient, replacing its values with the covariate's and putting
    the term in the design formula twice. Refused by name rather than renamed behind the user's
    back: the two columns mean different things and only the user knows which they meant."""
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=3)
    other = ["x" if s.endswith("_0") else "y" for s in samps]
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.add_column(other, slot="covariate:condition", name="condition")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "named 'condition'" in msg and "REPLACE" in msg


def test_a_covariate_perfectly_confounded_with_the_condition_is_refused_by_name(clusters_run):
    """TEST-27 [covers: ITEM-5] — A `batch` where every control sample was processed in one batch and every treated sample in
    another. statsmodels fits that rank-deficient design through a pseudo-inverse and only WARNS —
    the effect is split across the collinear terms and the reported logFC comes back HALVED, with
    exit code 0 and a complete result written. There is no honest answer for a confounded design;
    there is only a refusal that names what is confounded."""
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=3)
    batch = ["b_ctrl" if c == "ctrl" else "b_treat" for c in conds]   # 1:1 with the condition
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.add_column(batch, slot="covariate:batch", name="batch")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "RANK-DEFICIENT" in msg and "confounded" in msg
    assert "batch" in msg


@pytest.mark.parametrize("bad", [2.0, 1.5, 0.0, -0.1])
def test_an_out_of_range_fdr_is_refused_rather_than_silently_calling_everything(clusters_run, bad):
    """TEST-48 [invariant: INV-DA-2] — round R1 finding: `fdr` was the ONE numeric parameter with
    no compute-side range check, in a package that re-checks everything else specifically because
    "an agent/MCP call that never rendered the form reaches the compute".

    `prop` is validated, `min_cells` is clamped, `k` is clamped, the resource envelope is
    re-gated — but `fdr` was `float(p.get("fdr", 0.1))` and nothing else. At `fdr: 2.0` every
    fittable population becomes a "discovery" and `fdr_threshold: 2.0` is written into the
    artifact beside it; at a negative value none are. The form's `min: 0, max: 1` binds only the
    form.
    """
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    proc = run.run({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "fdr": bad})
    assert proc.returncode != 0, (
        f"fdr={bad!r} was ACCEPTED. The run then reports discoveries against a threshold that is "
        "not a probability, and records it as though it were.")
    msg = run.diagnostics(proc)
    assert "`fdr`" in msg and "(0, 1]" in msg


def test_an_in_range_fdr_still_runs_and_reaches_the_report(clusters_run):
    """The control that stops the refusal above passing vacuously — and pins that the accepted
    value is the one recorded, not the default."""
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl", "fdr": 0.25})
    assert run.report()["fdr_threshold"] == 0.25


def test_the_run_environment_record_rides_out_with_the_outputs(clusters_run):
    """TEST-54 [invariant: INV-DA-6] — the RUN-TIME half of the #80 dependency contract.

    Round R2 finding: deleting `cyto_deps.augment(...)` from `write_manifest()` AND reducing
    `library_versions()` to `return {}` left the whole suite green at 208 passed. The fix round 7
    made for its own finding #4 had zero coverage, so the record `provenance/recorder.rs` lifts
    could be removed from this package without a single test noticing. Nothing in `tests/`
    mentioned `cyto_deps`, `augment` or `run-environment` at all.

    The placement is the point: `write_manifest` is the ONE path every successful run passes, so a
    compute cannot emit outputs without also emitting the environment that produced them.
    """
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})

    ids = [e["id"] for e in run.manifest()["outputs"]]
    assert "run-environment" in ids, (
        f"no `run-environment` output was emitted; manifest ids = {ids}. The environment record is "
        "appended by `cyto_deps.augment` in `_shared.write_manifest`, and without it a published "
        "result cannot say which environment produced it.")

    libs = run.report().get("library_versions")
    assert isinstance(libs, dict) and libs, (
        f"`library_versions` is {libs!r}. It comes from `cyto_deps.resolve_and_check()`, which "
        "refuses an unreadable version rather than recording None — an empty mapping means the "
        "call was removed or never resolved.")
    assert any(v for v in libs.values()), (
        f"every recorded library version is falsy: {libs!r}. Recording a version that is not a "
        "version is the defect `cyto_deps` was written to remove.")


def test_the_artifact_provenance_flags_are_TRUE_when_the_p_family_IS_written(clusters_run):
    """TEST-55 [invariant: INV-DA-2] — the other side of an assertion that was only ever checked
    one way.

    Round R2: `pvalues_written` and `spatial_fdr_written` on `attributes.cyto.da` were asserted
    ONLY as `is False` anywhere in the suite, so hardcoding both to `False` — making every R1
    artifact claim no p-values were written when they were — left the suite green at 208 passed.
    A flag checked in one direction is a flag that can be stuck in the other.
    """
    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})

    entry = run.da_entries()[0]
    members = run.da_members(entry)
    da = entry["meta"]["da"]

    assert run.report()["regime"] == "R1", "this fixture must reach R1 for the flags to mean this"
    assert "neglog10p" in members, "the fixture did not actually write the p-family"
    assert da["pvalues_written"] is True, (
        f"`pvalues_written` is {da['pvalues_written']!r} on an R1 artifact that DOES carry "
        "`neglog10p`. The flag is how a reader decides whether an absent column means 'not "
        "tested'; stuck False, every honest R1 result reads as a descriptive one.")
    assert da["spatial_fdr_written"] is ("spatial_fdr" in members), (
        "`spatial_fdr_written` disagrees with what is actually on disk")
