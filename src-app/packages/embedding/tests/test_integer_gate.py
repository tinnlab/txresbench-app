#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 [acceptance] [invariant: INV-3] [covers: ITEM-14] — the raw-integer-count gate.

A non-integer count matrix is REFUSED with a named, package-prefixed error before any
normalization; never silently truncated.
"""
import numpy as np

from embedding_fixtures import counts_matrix


def test_a_non_integer_matrix_is_refused_before_normalization(reduce_run):
    dense = counts_matrix(30, 20, seed=0).astype(np.float32)
    dense[3, 4] = 1.5  # a single fractional value makes it NOT raw counts
    run = reduce_run()
    run.add_matrix(dense)
    proc = run.run({"n_hvg": 10, "n_pcs": 5, "seed": 0})

    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "raw integer counts" in diag.lower()
    # refused BEFORE producing anything — never truncated-and-continued.
    assert not (run.outputs_dir / "manifest.json").exists()
    # the refusal ran before the normalize phase.
    phases = run.progress_phases(proc)
    assert "integer-gate" in phases
    assert "normalize" not in phases


def test_negative_values_are_refused(reduce_run):
    dense = counts_matrix(30, 20, seed=1).astype(np.float32)
    dense[0, 0] = -2.0
    run = reduce_run()
    run.add_matrix(dense)
    proc = run.run({"n_hvg": 10, "n_pcs": 5})
    assert proc.returncode != 0
    assert "embedding.reduce:" in proc.stderr


def test_a_clean_integer_matrix_passes_the_gate(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(40, 25, seed=2))
    proc = run.run_ok({"n_hvg": 12, "n_pcs": 6})
    assert "integer-gate" in run.progress_phases(proc)
