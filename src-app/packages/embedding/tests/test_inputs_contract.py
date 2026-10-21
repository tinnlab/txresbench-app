#!/usr/bin/env python3
# ruff: noqa
"""TEST-37 [covers: ITEM-2, ITEM-13] — the input contract resolves by SLOT, and refuses a
missing / foreign-type slot by name.

Inputs are resolved by slot→path against `/inputs/inputs.json`; mounts are named `in0`/`in1`
(or anything), so a filename-suffix resolver cannot pass. A missing `matrices` slot, and a
slot bound to the wrong datatype, are each refused with a named, package-prefixed error.
"""
import numpy as np

from embedding_fixtures import counts_matrix


def test_missing_matrices_slot_is_refused_by_name(reduce_run):
    run = reduce_run()  # no matrix bound
    proc = run.run({"n_hvg": 12, "n_pcs": 6})
    assert proc.returncode != 0
    assert "no `matrices` input bound" in run.diagnostics(proc)


def test_a_foreign_type_on_the_matrices_slot_is_refused(reduce_run):
    run = reduce_run()
    rng = np.random.default_rng(0)
    # an EMBEDDING store (not a CSC expression matrix) bound on the matrices slot.
    run.add_embedding(rng.standard_normal((30, 6)).astype(np.float32),
                      slot="matrices", name="X_pca")
    proc = run.run({"n_hvg": 12, "n_pcs": 6})
    assert proc.returncode != 0
    # names the expected kind rather than crashing on a malformed read.
    assert "sparse_csc" in run.diagnostics(proc)


def test_inputs_resolve_by_slot_not_by_filename_suffix(reduce_run):
    run = reduce_run()
    # a MEANINGLESS mount name: resolution is by the slot declared in inputs.json.
    run.add_matrix(counts_matrix(60, 40, seed=2), slot="matrices", mount="not-a-matrix.bin")
    run.run_ok({"n_hvg": 12, "n_pcs": 6})
    assert run.embedding_entry()["datatype"] == "embedding"
