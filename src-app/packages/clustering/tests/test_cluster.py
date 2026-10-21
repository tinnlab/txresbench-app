#!/usr/bin/env python3
# ruff: noqa
"""TEST-11 [acceptance] [invariant: INV-11] [covers: ITEM-2] — cluster on the embedding's
kNN graph, NEVER the 2-D layout.

The kNN graph is built on the dense embedding (PC/latent) matrix; a fixture whose input
declares a 2-D layout kind is REFUSED (never used as the graph source).
"""
from clustering_fixtures import cells_digest, three_blob_embedding


def test_a_2d_layout_input_is_refused_as_the_graph_source(cluster_run):
    run = cluster_run()
    # a UMAP/t-SNE 2-D layout picture — the thing INV-11 forbids as a clustering graph.
    run.add_layout(three_blob_embedding(30, 8, seed=0))
    proc = run.run({"resolution": 1.0})
    assert proc.returncode != 0
    diag = proc.stderr
    assert "INV-11" in diag
    assert "layout" in diag.lower() or "2-d" in diag.lower()
    # refused before any partition — nothing was written.
    assert not (run.outputs_dir / "manifest.json").exists()


def test_clusters_on_the_reduced_embedding_recovering_separated_blobs(cluster_run):
    run = cluster_run()
    # three well-separated blobs in a 10-D reduced space → a clean 3-cluster partition,
    # which only holds when the graph is built on the FULL embedding (not a 2-D squashing).
    run.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    run.run_ok({"resolution": 1.0, "seed": 0})
    report = run.report()
    # the partitioned representation has the embedding's full dimensionality (10), not 2.
    assert report["n_pcs"] == 10
    assert report["n_clusters"] == 3
