#!/usr/bin/env python3
# ruff: noqa
"""TEST-32 (tier: e2e) [covers: ITEM-0a, ITEM-20d, ITEM-26, ITEM-0d] — the unintegrated
producer→consumer chain.

A single-dataset `embedding.reduce` (no batch column, no Harmony) runs, and its `embedding`
output feeds a REAL `embedding.visualize` run that produces a 2-D `embedding`. The chaining
edge resolves by exact string equality on the `embedding` datatype (ITEM-0d), and the source
dataset's `key_sequence_digest` rides through as `aligned_to` (ITEM-26).
"""
import numpy as np

from embedding_fixtures import counts_matrix


def test_reduce_output_feeds_a_real_visualize_run_end_to_end(reduce_run, visualize_run):
    red = reduce_run()
    red.add_matrix(counts_matrix(120, 60, seed=1))
    red.add_column([f"cell-{i}" for i in range(120)], slot="cells_index", axis="cells",
                   name="barcode", holds_axis_keys=True)
    red.run_ok({"n_hvg": 25, "n_pcs": 15, "seed": 0})

    emb = red.embedding_entry()
    # the chaining edge is the exact string `embedding` (analysis 2 keys on type_id: embedding).
    assert emb["datatype"] == "embedding"
    src_digest = emb["structure"].get("aligned_to")
    assert src_digest, "reduce did not carry the source row-space digest (ITEM-26)"

    viz = visualize_run()
    viz.add_existing_store(red.outputs_dir / emb["path"], slot="embedding")
    viz.run_ok({"method": "umap", "seed": 0})

    coords = viz.embedding_array()
    assert coords.shape == (120, 2)
    viz_entry = viz.embedding_entry()
    assert viz_entry["datatype"] == "embedding"
    # aligned_to propagates through the hop unchanged (the row space is still the source's).
    assert viz_entry["structure"].get("aligned_to") == src_digest
