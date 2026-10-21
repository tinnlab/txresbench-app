#!/usr/bin/env python3
# ruff: noqa
"""TEST-18 [acceptance] [invariant: INV-18] [covers: ITEM-1] — single-dataset Stage-0.

The analysis consumes a SINGLE `embedding`: the compute refuses >1 embedding on the slot,
and refuses when none is bound.
"""
from clustering_fixtures import cells_digest, three_blob_embedding


def test_refuses_more_than_one_embedding(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(20, 8, seed=0), aligned_to=cells_digest(60))
    run.add_embedding(three_blob_embedding(20, 8, seed=1), aligned_to=cells_digest(60))
    proc = run.run({"resolution": 1.0})
    assert proc.returncode != 0
    assert "single-dataset" in proc.stderr
    assert not (run.outputs_dir / "manifest.json").exists()


def test_refuses_when_no_embedding_is_bound(cluster_run):
    run = cluster_run()
    proc = run.run({"resolution": 1.0})
    assert proc.returncode != 0
    assert "no `embedding` input bound" in proc.stderr


def test_a_single_embedding_clusters(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0})
    assert run.report()["n_clusters"] >= 1
