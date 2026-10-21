#!/usr/bin/env python3
# ruff: noqa
"""TEST-F1 [regression] [invariant: INV-10] — the markers-memory gate refuses on the TRUE
PEAK, not the one-copy read estimate.

`compute_markers` reads the CSC trio (~nnz×8 resident) THEN builds
`sp.csc_matrix(...).tocsr()` (a full second CSR copy while the read trio is still referenced)
and runs `normalize_total` + `log1p` — so the real peak is ~3 concurrent copies (~nnz×24),
not one. Sizing the gate at one copy (nnz×8) let a matrix pass the pre-read gate at 1× then
get OOM-SIGKILLed mid-`.tocsr()` — the "signal kill after the refusal passed" INV-10 forbids
(the same class embedding fixed with a per-nnz peak factor).

The gate now refuses when nnz × `_MARKERS_PEAK_BYTES_PER_NNZ` exceeds the budget. A budget
BETWEEN the one-copy read (nnz×8) and the true peak (nnz×24) therefore refuses — and would
NOT if the factor were reverted to one copy.

Mutation: set `_MARKERS_PEAK_BYTES_PER_NNZ` back to 8 (one copy) → the between-budget no
longer exceeds the ceiling → the gate returns instead of refusing → both tests below FAIL.
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pytest

from clustering_fixtures import cells_digest, three_blob_embedding, three_blob_expression

_COMPUTE = Path(__file__).resolve().parents[1] / "compute"


def _load_shared():
    sys.path.insert(0, str(_COMPUTE))
    sys.path.insert(0, str(_COMPUTE.parent.parent / "_lib"))
    spec = importlib.util.spec_from_file_location("clustering_shared_peak", _COMPUTE / "_shared.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_markers_gate_refuses_on_peak_when_one_copy_would_pass():
    S = _load_shared()
    nnz = 1_000
    # the peak factor accounts for MORE than one copy (the OOM-after-pass fix).
    assert S._MARKERS_PEAK_BYTES_PER_NNZ > S._CSC_BYTES_PER_NNZ, (
        "the markers peak must exceed one CSC copy — else the gate re-admits the OOM-mid-.tocsr() "
        "case (F1)")
    resident = nnz * S._CSC_BYTES_PER_NNZ            # one copy — 8k
    peak = nnz * S._MARKERS_PEAK_BYTES_PER_NNZ       # true peak — 24k
    assert peak > resident

    # A budget strictly BETWEEN one copy and the true peak: the 1× read would fit, the real
    # peak does not. The TRUE-PEAK gate must REFUSE here; a one-copy gate would admit it.
    between = (resident + peak) // 2                 # 8k < between(16k) < 24k
    assert resident < between < peak
    S._MEM_BUDGET_BYTES = between
    with pytest.raises(SystemExit):                  # fail() → sys.exit → SystemExit
        S.markers_memory_refuse_if_over(nnz)

    # And ABOVE the true peak it admits, recording the peak it sized against.
    S._MEM_BUDGET_BYTES = peak + 1
    rec = S.markers_memory_refuse_if_over(nnz)
    assert rec["estimated_peak_bytes"] == peak
    assert rec["estimated_resident_bytes"] == resident
    assert rec["peak_bytes_per_nnz"] == S._MARKERS_PEAK_BYTES_PER_NNZ


def test_e2e_matrix_under_one_copy_but_over_peak_refuses_before_the_csc_read(cluster_run):
    """The end-to-end proof: a matrix whose declared nnz×8 (one copy) sits UNDER the budget but
    whose true peak (nnz×24) sits OVER it refuses BEFORE the CSC read — never read-then-OOM.
    The labels-side gate passes (isolating the markers gate), and the refusal lands at the
    markers preflight, before the CSC read."""
    matrix = three_blob_expression(40, 400, seed=1)          # 120 cells × 400 genes
    nnz = int(np.count_nonzero(matrix))
    # budget strictly between one copy (nnz×8) and the true peak (nnz×24); also comfortably
    # above the labels estimate (120 × (10×4 + 15×8) = 19,200 B) so the LABELS gate passes.
    budget = nnz * 12
    assert budget > 19_200, "budget must clear the labels-side estimate to isolate the markers gate"
    assert nnz * 8 < budget < nnz * 24                       # 1× fits, peak does not

    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    run.add_expression(matrix)
    proc = run.run({"resolution": 1.0},
                   env_extra={"CLUSTERING_MEMORY_BUDGET_BYTES": str(budget)})
    assert proc.returncode != 0, proc.stdout + proc.stderr
    diag = proc.stderr
    assert "refusing before reading the expression matrix" in diag
    assert "PEAK" in diag                                    # refuses on the true peak
    assert f"nnz={nnz:,}" in diag or "nnz=" in diag
    # reached the markers preflight but refused BEFORE the CSC read (no `markers` phase).
    phases = run.progress_phases(proc)
    assert "markers-preflight" in phases
    assert "markers" not in phases
    # pre-read refusal ⇒ no conformant output committed.
    assert not (run.outputs_dir / "manifest.json").exists()
