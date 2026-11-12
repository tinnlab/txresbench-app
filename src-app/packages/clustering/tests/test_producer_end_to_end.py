#!/usr/bin/env python3
# ruff: noqa
"""TEST-2 / TEST-15 / TEST-26 — the produce-type + real-compute acceptance anchors.

TEST-2  [acceptance] [invariant: INV-2] [covers: ITEM-1, ITEM-3] — the produced label
        artifact's datatype is `metadata-column` with categorical kind (integer codes + a
        declared sorted `levels` set) AND its group `attributes.txr` carries the clustering
        provenance tag; the run CONFORMS against `produces: [metadata-column]`. A mutation
        emitting the exclusive, uncolour-able `clustering` datatype FAILS.
TEST-15 [acceptance] [invariant: INV-15] [covers: ITEM-3] — the output categorical carries
        an explicit sorted `levels` set + codes; the record states ids are run-specific.
TEST-26 [covers: ITEM-2, ITEM-3, ITEM-6] — the REAL-COMPUTE path: a fixture `embedding`
        artifact (written via the real `txr_zarr`) is clustered end-to-end AS A SUBPROCESS
        (spawn → read embedding → neighbours → Leiden → write the categorical
        `metadata-column` + provenance tag + report), and the output conforms via the real
        framework gate.
"""
import conformance

from clustering_fixtures import cells_digest, three_blob_embedding


def test_produces_a_categorical_metadata_column_not_an_exclusive_clustering_type(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), method="pca",
                      aligned_to=cells_digest(120))
    run.run_ok({"resolution": 1.0, "seed": 0})

    entry = run.label_entry()
    # INV-2 / DEC-9(c): a cluster label IS a categorical `metadata-column`.
    assert entry["datatype"] == "metadata-column"
    assert entry["layout"] == "chunked-1d"
    assert entry["meta"]["kind"] == "categorical"

    # the MUTATION guard: NO output may be an exclusive `clustering` datatype (the colour-by
    # section cannot read it). A compute that emits `clustering` fails this assertion.
    datatypes = {e["datatype"] for e in run.manifest()["outputs"]}
    assert "clustering" not in datatypes, (
        "a cluster label must be a categorical metadata-column (colourable for free), NOT "
        "an exclusive `clustering` datatype (owner DEC-9(c))")

    # the group `attributes.txr` carries the clustering provenance tag (method/flavor/…).
    tag = run.label_group_txr().get("clustering")
    assert tag is not None
    assert tag["method"] == "leiden" and tag["flavor"] == "igraph"
    assert tag["objective"] == "modularity" and tag["resolution"] == 1.0
    assert "seed" in tag

    # conforms against `produces: [metadata-column]` via the real framework gate.
    assert conformance.conform_outputs(run.outputs_dir) == []


def test_the_output_carries_explicit_sorted_levels_plus_codes_run_specific(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    run.run_ok({"resolution": 1.0, "seed": 0})

    entry = run.label_entry()
    # a declared level set (codes index into it), of size n_categories.
    n_levels = entry["meta"]["n_levels"]
    assert n_levels == entry["meta"]["n_categories"] >= 1
    report = run.report()
    levels = report["levels"]
    assert levels == sorted(levels, key=lambda x: (len(x), x))  # explicit + sorted
    # the labels resolve back through the level set (categorical codes → labels).
    labels = run.labels()
    assert set(labels) <= set(levels)
    assert len(labels) == report["n_cells"]
    # INV-15 — ids are recorded as run-specific, not claimed stable.
    assert "run-specific" in report["levels_are"]


def test_real_compute_end_to_end_streams_progress_and_conforms(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), method="pca",
                      aligned_to=cells_digest(120))
    proc = run.run_ok({"resolution": 1.0, "n_neighbors": 15, "seed": 0})

    # per-phase progress stream (not a boolean spinner).
    phases = run.progress_phases(proc)
    for expected in ("read", "neighbors", "leiden", "write", "report", "done"):
        assert expected in phases, (expected, phases)

    # two typed outputs: a metadata-column + a report/qc.
    datatypes = {e["datatype"] for e in run.manifest()["outputs"]}
    assert "metadata-column" in datatypes and "report/qc" in datatypes

    # three well-separated blobs → a stable 3-cluster partition.
    assert run.report()["n_clusters"] == 3
    assert conformance.conform_outputs(run.outputs_dir) == []
