#!/usr/bin/env python3
# ruff: noqa
"""TEST-3 / TEST-4 — the Leiden flavor + objective acceptance anchors.

TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-2] — the run records algorithm=leiden,
       flavor=igraph, n_iterations=2, directed=False, and a pinned seed; a mutation running
       Louvain / `flavor="leidenalg"` is caught (recorded flavor ≠ igraph fails).
TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-4] — the run records
       objective=modularity, the resolution field is labelled with that objective, and a
       request to compare resolutions across flavors/objectives is REFUSED; a mutation
       leaving the raw igraph CPM default is caught (recorded objective ≠ modularity fails).
"""
from clustering_fixtures import cells_digest, three_blob_embedding


def test_records_leiden_igraph_two_iterations_undirected_and_a_seed(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0, "seed": 3})

    tag = run.label_group_cyto()["clustering"]
    report = run.report()
    # INV-3 — recorded flavor MUST be igraph (a Louvain / leidenalg mutation fails here).
    assert tag["method"] == "leiden" and report["algorithm"] == "leiden"
    assert tag["flavor"] == "igraph" and report["flavor"] == "igraph"
    assert tag["n_iterations"] == 2 and report["n_iterations"] == 2
    assert tag["directed"] is False and report["directed"] is False
    assert tag["seed"] == 3


def test_records_modularity_objective_labelled_on_the_resolution(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0})

    tag = run.label_group_cyto()["clustering"]
    report = run.report()
    # INV-4 — modularity family (scanpy igraph override of igraph's raw CPM default). A
    # mutation leaving CPM is caught: recorded objective ≠ modularity fails.
    assert tag["objective"] == "modularity" and report["objective"] == "modularity"
    # the resolution field is LABELLED with the objective it drives.
    assert tag["resolution_objective"] == "modularity"
    assert report["parameters"]["resolution_objective"] == "modularity"


def test_refuses_to_compare_resolutions_across_objectives_or_flavors(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(20, 8, seed=0), aligned_to=cells_digest(60))
    proc = run.run({"resolution": 1.0,
                    "compare": [{"flavor": "leidenalg", "objective": "CPM",
                                 "resolution": 0.5}]})
    assert proc.returncode != 0
    diag = proc.stderr.lower()
    assert "compare resolutions across" in diag
    assert "cpm" in diag or "igraph-cpm trap" in diag
    # refused up front — nothing was written.
    assert not (run.outputs_dir / "manifest.json").exists()
