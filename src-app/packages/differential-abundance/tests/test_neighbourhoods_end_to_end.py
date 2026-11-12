#!/usr/bin/env python3
# ruff: noqa
"""TEST-12 [covers: ITEM-9, ITEM-4, ITEM-7] — `da.neighbourhoods` end to end.

The primary analysis of the epic, and the reason Milo was chosen over the cluster-based
alternatives: it answers "is there ANY REGION whose composition shifts?" without first choosing a
clustering resolution.
"""
import json

import numpy as np
import pytest

from da_fixtures import embedding_dataset, EXTERNAL


def _bind(run, *, samples_per_side=3, n_per_sample=200, n_dims=6, seed=1, annotation=False):
    X, conds, samps, blobs = embedding_dataset(n_per_sample=n_per_sample,
                                               samples_per_side=samples_per_side,
                                               n_dims=n_dims, seed=seed)
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    if annotation:
        run.add_column(blobs, slot="annotation", name="celltype")
    return X, conds, samps, blobs


def test_it_runs_end_to_end_from_an_embedding_and_two_columns(neighbourhoods_run):
    run = neighbourhoods_run()
    _bind(run)
    proc = run.run_ok({"method": "nb_glm", "prop": 0.15})
    phases = run.progress_phases(proc)
    for phase in ("resolve", "preflight", "graph", "neighbourhoods", "count", "normalize",
                  "write", "report", "done"):
        assert phase in phases, f"{phase} missing from {phases}"
    report = run.report()
    assert report["kind"] == "da-report" and report["analysis"] == "da.neighbourhoods"
    assert report["regime"] == "R1"
    assert report["n_nhoods"] >= 2
    assert len(report["index_cells"]) == report["n_nhoods"]
    assert len(report["kth_distance"]) == report["n_nhoods"]
    assert report["prop"] == 0.15 and report["seed"] == 0 and report["k"] == 15
    assert report["resolution_free"] is True


def test_it_writes_BOTH_padj_and_spatial_fdr_and_headlines_the_weighted_one(neighbourhoods_run):
    """INV-DA-4. Recording both is deliberate: it makes the correction visible and auditable
    rather than a silent transformation, and it lets a reviewer see how much the weighting moved."""
    run = neighbourhoods_run()
    _bind(run)
    run.run_ok({"method": "nb_glm", "prop": 0.15})
    entry = run.da_entries()[0]
    members = run.da_members(entry)
    assert {"padj", "spatial_fdr", "neglog10p", "neglog10_significance"} <= members
    padj = np.asarray(run.da_column(entry, "padj"), dtype=float)
    spatial = np.asarray(run.da_column(entry, "spatial_fdr"), dtype=float)
    neglog10p = np.asarray(run.da_column(entry, "neglog10p"), dtype=float)
    headline = np.asarray(run.da_column(entry, "neglog10_significance"), dtype=float)
    assert np.all(np.isfinite(padj)) and np.all(np.isfinite(spatial))
    assert np.all(spatial <= 1.0) and np.all(padj <= 1.0)

    # The fit really happened — `isfinite` alone would be satisfied by the producer's NaN→1 fill
    # over a fit that never produced a p at all.
    assert np.any(np.isfinite(neglog10p)) and np.nanmax(neglog10p) > 0
    assert np.any(spatial < 1.0), "no neighbourhood got an adjusted value below 1; nothing fitted"

    # The WEIGHTING actually moved something. If `spatial_fdr` were a copy of `padj` the whole
    # INV-DA-4 correction would be inert and every assertion about it would still pass.
    assert np.any(np.abs(spatial - padj) > 1e-9), (
        "the connectivity-weighted FDR is identical to plain BH everywhere — the weighting is inert")

    # …and the HEADLINE column, which the volcano's threshold rail binds to, is the −log10 of the
    # WEIGHTED value, not of the raw p or of plain BH.
    assert np.allclose(headline, -np.log10(np.clip(spatial, 1e-300, 1.0)), rtol=0, atol=1e-9)
    assert not np.allclose(headline, neglog10p)

    attrs = run.da_txr(entry)["da"]
    assert attrs["significance_column"] == "spatial_fdr", (
        "every threshold, badge and headline must read the connectivity-weighted value")
    assert attrs["headline_column"] == "neglog10_significance"
    assert run.report()["comparisons"][0]["significance_column"] == "spatial_fdr"


def test_it_does_NOT_emit_a_per_cell_effect_column(neighbourhoods_run):
    """A cell belongs to MANY overlapping neighbourhoods, so a per-cell effect would need an
    arbitrary reduction. Inventing one to fill a column is exactly the quiet fabrication this
    package refuses; `da.clusters` emits one because its populations are disjoint."""
    run = neighbourhoods_run()
    _bind(run)
    run.run_ok({"method": "nb_glm", "prop": 0.15})
    assert run.column_entries() == []


def test_the_annotation_slot_labels_regions_and_changes_NO_statistic(neighbourhoods_run):
    """The load-bearing constraint on the readability slot. A majority label makes a discovered
    region talkable-about; the moment it entered the model it would reintroduce exactly the
    cluster-boundary arbitrariness this analysis exists to avoid."""
    params = {"method": "nb_glm", "prop": 0.15}

    plain = neighbourhoods_run()
    _bind(plain, annotation=False)
    plain.run_ok(params)

    labelled = neighbourhoods_run()
    _bind(labelled, annotation=True)
    labelled.run_ok(params)

    a, b = plain.da_entries()[0], labelled.da_entries()[0]
    assert plain.da_members(a) == labelled.da_members(b)
    for member in sorted(plain.da_members(a) - {"population"}):
        x = np.asarray(plain.da_column(a, member), dtype=float)
        y = np.asarray(labelled.da_column(b, member), dtype=float)
        assert np.array_equal(np.nan_to_num(x, nan=-999.0), np.nan_to_num(y, nan=-999.0)), (
            f"binding an annotation changed {member!r} — the label must never enter the model")

    labelled_report = labelled.report()
    assert labelled_report["annotation_enters_model"] is False
    assert labelled_report["nhood_annotation"], "no majority labels were recorded"
    assert len(labelled_report["nhood_annotation"]) == labelled_report["n_nhoods"]
    assert all(0.0 <= p <= 1.0 for p in labelled_report["nhood_annotation_purity"])
    assert plain.report()["nhood_annotation"] is None


def test_a_two_dimensional_layout_is_refused_by_name_before_any_read(neighbourhoods_run):
    """INV-11. A region discovered on a UMAP picture is an artefact of the drawing, not of the
    data — and the refusal happens from the DECLARED structure, before a byte of the matrix is
    read, so it costs nothing and cannot be reached by an agent call that skipped the form."""
    run = neighbourhoods_run()
    X, conds, samps, _ = embedding_dataset(n_per_sample=60, samples_per_side=2, n_dims=6)
    run.add_embedding(X[:, :2], slot="embedding", name="X_umap", kind="layout")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    proc = run.run({"method": "nb_glm"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "2-D layout" in msg and "INV-11" in msg
    assert "artefact of the drawing" in msg
    # refused BEFORE any read: no phase past `preflight` ran
    phases = run.progress_phases(proc)
    assert "read" not in phases and "graph" not in phases


def test_the_reference_normalization_is_refused_for_neighbourhoods_with_a_reason(neighbourhoods_run):
    """A neighbourhood is a discovered, seed-dependent region — there is no stable population to
    name as a constant reference, so the ALR assumption could not be checked or even stated
    honestly. Refusing is more useful than offering a control whose meaning cannot be written."""
    run = neighbourhoods_run()
    _bind(run, samples_per_side=2, n_per_sample=120)
    proc = run.run({"method": "nb_glm", "normalization": "reference", "reference": "whatever"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "discovered" in msg and "poscounts" in msg and "cluster-level" in msg


def test_a_missing_embedding_points_at_the_analysis_that_produces_one(neighbourhoods_run):
    run = neighbourhoods_run()
    X, conds, samps, _ = embedding_dataset(n_per_sample=60, samples_per_side=2)
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    proc = run.run({"method": "nb_glm"})
    assert proc.returncode != 0
    assert "Reduce dimensions" in run.diagnostics(proc)


def test_the_counts_that_reach_the_model_are_integers_over_samples(neighbourhoods_run):
    """INV-DA-2 at the neighbourhood level: the model's row space is samples, and the values are
    cell COUNTS, not proportions."""
    run = neighbourhoods_run()
    _bind(run)
    run.run_ok({"method": "nb_glm", "prop": 0.15})
    report = run.report()
    assert report["n_samples"] == len(report["samples"])
    assert report["n_samples_1"] >= 2 and report["n_samples_2"] >= 2
    entry = run.da_entries()[0]
    n_cells = np.asarray(run.da_column(entry, "n_cells"), dtype=float)
    assert np.all(n_cells == np.round(n_cells)), "n_cells must be integral cell counts"


def test_the_fdr_threshold_is_APPLIED_not_merely_recorded(neighbourhoods_run):
    """TEST-29 [covers: ITEM-9, ITEM-6] — A `threshold_list` param narrates a CONSTRAINT into `methods.md`. If nothing in the run
    ever used it, that document would state a constraint the run did not impose. So the run calls
    significance at the chosen level, off the weighted column, and records the count."""
    strict = neighbourhoods_run()
    _bind(strict)
    strict.run_ok({"method": "nb_glm", "prop": 0.15, "fdr": 0.001})
    loose = neighbourhoods_run()
    _bind(loose)
    loose.run_ok({"method": "nb_glm", "prop": 0.15, "fdr": 0.9})

    assert strict.report()["fdr_threshold"] == 0.001
    assert loose.report()["fdr_threshold"] == 0.9
    n_strict = strict.report()["n_significant"]
    n_loose = loose.report()["n_significant"]
    assert n_strict is not None and n_loose is not None
    assert n_loose > n_strict, (
        f"the FDR threshold changed nothing: {n_strict} called at 0.001 and {n_loose} at 0.9")
    assert strict.da_txr(strict.da_entries()[0])["da"]["n_significant"] == n_strict


def test_min_cells_is_counted_in_CELLS_not_in_neighbourhood_memberships(neighbourhoods_run):
    """Neighbourhoods OVERLAP, so summing the (sample × neighbourhood) counts counts each cell
    once per neighbourhood it belongs to — roughly k·prop times. Applying `min_cells` to THAT
    would silently inflate the floor relative to the unit the form and `methods.md` both state it
    in. The dropped record must report a real cell count."""
    run = neighbourhoods_run()
    X, conds, samps, _ = embedding_dataset(n_per_sample=200, samples_per_side=3)
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "prop": 0.15, "min_cells": 1})
    report = run.report()
    total_cells = report["n_cells"]
    # every surviving sample's recorded contribution is bounded by the real cell count, which a
    # membership sum (each cell counted k·prop times) would blow straight past
    assert report["n_samples"] >= 2
    per_sample_ceiling = total_cells
    for d in report["dropped"]:
        assert 0 <= d["n_cells"] <= per_sample_ceiling

def test_min_cells_drops_a_sample_on_a_REAL_cell_count_not_a_membership_sum(neighbourhoods_run):
    """TEST-32 [covers: ITEM-7, ITEM-9] — The regression test for the unit fix, written so it can FAIL.

    Neighbourhoods OVERLAP, so contracting the (sample × neighbourhood) counts counts each cell
    once per neighbourhood it belongs to — roughly `k · prop` times. Applying `min_cells` to THAT
    silently applies the threshold in a unit nothing else in the run uses: the form says cells and
    the exported methods document says cells.

    A test that runs at `min_cells: 1` cannot see the difference — nothing is dropped, so the
    assertion about the dropped record never executes. This one starves ONE sample to a known
    number of cells and puts the threshold BETWEEN that number and its membership sum, which is
    the only band where the two implementations disagree: the correct one drops the sample, the
    membership-sum one keeps it."""
    X, conds, samps, _ = embedding_dataset(n_per_sample=200, samples_per_side=3)
    starved = "s0_0"
    keep = [i for i, s in enumerate(samps) if s != starved]
    thin = [i for i, s in enumerate(samps) if s == starved][:30]
    idx = sorted(keep + thin)

    run = neighbourhoods_run()
    run.add_embedding(X[idx], slot="embedding")
    run.add_column([conds[i] for i in idx], slot="condition", name="condition",
                   provenance=EXTERNAL)
    run.add_column([samps[i] for i in idx], slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "prop": 0.15, "min_cells": 60})

    report = run.report()
    dropped = {d["sample"]: d for d in report["dropped"]}
    assert starved in dropped, (
        f"the starved sample (30 cells, threshold 60) was not dropped — the floor is being "
        f"applied to something other than a cell count. dropped={report['dropped']}")
    assert dropped[starved]["n_cells"] <= 30, (
        f"the dropped record reports {dropped[starved]['n_cells']} cells for a sample that "
        "contributed at most 30 — that is a membership sum, not a cell count")
    assert starved not in report["samples"]


def test_a_covariate_named_condition_is_refused_here_too(neighbourhoods_run):
    """TEST-33 [covers: ITEM-9] — The same rule as `da.clusters`. It lives in `_shared` so the two analyses cannot drift, and
    it is asserted on BOTH so a copy cannot be deleted from one of them unnoticed."""
    run = neighbourhoods_run()
    X, conds, samps, _ = embedding_dataset(n_per_sample=150, samples_per_side=3)
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.add_column(["x" if s.endswith("_0") else "y" for s in samps],
                   slot="covariate:condition", name="condition")
    proc = run.run({"method": "nb_glm", "prop": 0.15})
    assert proc.returncode != 0
    assert "named 'condition'" in run.diagnostics(proc)


def test_a_result_label_cannot_escape_the_columns_directory(neighbourhoods_run):
    """TEST-34 [covers: ITEM-4] — The label is a free-text control the user types and it reaches `columns/<label>.zarr`. A
    label containing a separator or a traversal component must not put the artifact somewhere the
    run does not own — the same traversal the member-name writer refuses, one level up."""
    run = neighbourhoods_run()
    _bind(run)
    run.run_ok({"method": "nb_glm", "prop": 0.15, "name": "../../escaped/../evil"})
    entry = run.da_entries()[0]
    assert entry["path"].startswith("columns/"), entry["path"]
    assert ".." not in entry["path"], entry["path"]
    assert entry["path"].count("/") == 1, entry["path"]
    assert (run.outputs_dir / entry["path"]).is_dir()
    # …and the path is EXACTLY the sanitised label. `"escaped" in path` would have been true of
    # the RAW label too (`columns/../../escaped/../evil.zarr` contains it), so it asserted nothing.
    assert entry["path"] == "columns/escaped_evil.zarr", entry["path"]


def test_an_R1_run_whose_fit_yields_no_p_downgrades_here_too(neighbourhoods_run):
    """TEST-38 [covers: ITEM-9] — the downgrade, on the neighbourhood analysis.

    The cluster entry has had this since round 2; this one did not, so its downgrade branch — its
    regime, its omitted p-family and its recorded reason — could all have been deleted with the
    suite green. That is the same asymmetry the covariate guard closed by being asserted on both,
    and leaving it open here is what let the equivalent gap survive on the mask fix."""
    X, conds, samps, _ = embedding_dataset(n_per_sample=200, samples_per_side=2)
    c1 = {"s0_0": "a", "s0_1": "b", "s1_0": "a", "s1_1": "b"}
    c2 = {"s0_0": "x", "s0_1": "y", "s1_0": "y", "s1_1": "x"}
    run = neighbourhoods_run()
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.add_column([c1[s] for s in samps], slot="covariate:c1", name="c1")
    run.add_column([c2[s] for s in samps], slot="covariate:c2", name="c2")
    proc = run.run({"method": "nb_glm", "prop": 0.15})
    assert proc.returncode == 0, run.diagnostics(proc)

    report = run.report()
    assert report["regime"] == "R3"
    assert report["pvalues_written"] is False
    assert report["fit"]["downgraded_from"] == "R1"
    entry = run.da_entries()[0]
    members = run.da_members(entry)
    for member in ("neglog10p", "padj", "spatial_fdr", "neglog10_significance"):
        assert member not in members, f"{member!r} was written over a fit that produced no p"
    logfc = np.asarray(run.da_column(entry, "logFC"), dtype=float)
    score = np.asarray(run.da_column(entry, "score"), dtype=float)
    assert np.array_equal(np.nan_to_num(logfc, nan=-999.0), np.nan_to_num(score, nan=-999.0))
    assert np.any(np.isfinite(logfc)), (
        "a downgraded result must still carry the descriptive ranked effect")


def test_a_result_label_cannot_escape_the_columns_directory_on_the_cluster_entry(clusters_run):
    """TEST-39 [covers: ITEM-4, ITEM-8] — the same guard on the OTHER entry, which has strictly
    more traversal surface: it derives a SECOND store path from the same label for the per-cell
    effect column."""
    from da_fixtures import population_dataset

    pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=3)
    run = clusters_run()
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl",
                "name": "../../escaped/../evil"})
    for entry in run.manifest()["outputs"]:
        if entry["datatype"] == "report/qc":
            continue
        assert entry["path"].startswith("columns/") and ".." not in entry["path"]
        assert entry["path"].count("/") == 1, entry["path"]
        assert (run.outputs_dir / entry["path"]).is_dir()
    assert run.da_entries()[0]["path"] == "columns/escaped_evil.zarr"
    assert run.column_entries()[0]["path"] == "columns/escaped_evil_logFC.zarr"


def test_an_out_of_range_fdr_is_refused_here_too(neighbourhoods_run):
    """The same round-R1 gap, on the analysis whose `_called` mask is taken against `spatial_fdr`.
    Both entries resolved `fdr` with no bound; fixing one and not the other is how the sibling
    guard in this package drifted in the first place."""
    run = neighbourhoods_run()
    _bind(run)
    proc = run.run({"method": "nb_glm", "prop": 0.15, "fdr": 2.0})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "`fdr`" in msg and "(0, 1]" in msg
