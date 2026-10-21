#!/usr/bin/env python3
# ruff: noqa
"""TEST-31 [covers: ITEM-0, ITEM-17, ITEM-23, ITEM-27] — reduce end-to-end.

A single-dataset `embedding.reduce` runs end-to-end through the REAL entry script, applies
normalize_total(None)+log1p, emits an `embedding` + `report/qc` via `write_embedding`, and
streams per-phase progress. The emitted artifacts CONFORM to the real framework gate.
"""
import numpy as np

import conformance

from embedding_fixtures import counts_matrix


def test_reduce_runs_end_to_end_and_emits_conforming_artifacts(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(120, 60, seed=0))
    proc = run.run_ok({"n_hvg": 30, "n_pcs": 15, "seed": 0})

    # per-phase progress stream (not a boolean spinner).
    phases = run.progress_phases(proc)
    for expected in ("read", "normalize", "hvg", "pca", "write", "report", "done"):
        assert expected in phases

    # two typed outputs: an embedding + a report/qc.
    datatypes = {e["datatype"] for e in run.manifest()["outputs"]}
    assert "embedding" in datatypes and "report/qc" in datatypes

    # the embedding is (n_cells × n_pcs), float32, via write_embedding.
    emb_entry = run.embedding_entry()
    assert emb_entry["layout"] == "chunked-dense"
    emb = run.embedding_array()
    assert emb.shape == (120, 15)
    assert emb.dtype == np.float32

    # the run's OWN framework gate accepts what it emitted.
    violations = conformance.conform_outputs(run.outputs_dir)
    assert violations == [], violations


def test_aligned_to_carries_the_source_row_space_digest_when_a_cells_index_is_bound(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(40, 25, seed=1))
    run.add_column([f"cell-{i}" for i in range(40)], slot="cells_index", axis="cells",
                   name="barcode", holds_axis_keys=True)
    run.run_ok({"n_hvg": 12, "n_pcs": 6})
    emb_entry = run.embedding_entry()
    # aligned_to is a non-empty digest (ITEM-26): the source dataset's row space.
    assert emb_entry["structure"].get("aligned_to")
