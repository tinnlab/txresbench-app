#!/usr/bin/env python3
# ruff: noqa
"""TEST-10 [acceptance] [invariant: INV-10] [covers: ITEM-9] — the honest ceiling refusal,
plus the DEC-6 min-cell refusal.

An over-TIME-ceiling run refuses with an itemized message naming the time ceiling + the
`timeout_secs` lever; an over-MEMORY-ceiling run refuses naming the memory ceiling + a
REACHABLE lever (a smaller single dataset, or raising the deployment's sandbox memory limit
— NOT a phantom `class: batch` the package ships no way to select; F2/F3). Neither is a
signal-kill after a wait (refusal is PRE-compute). And a below-floor input (<10 viable cells,
DEC-6) is refused honestly, never fabricated.
"""
from clustering_fixtures import (
    cells_digest,
    three_blob_embedding,
    three_blob_expression,
)


def test_over_memory_ceiling_is_refused_before_any_read(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    # a tiny memory budget forces the refusal without a 4 GiB fixture.
    proc = run.run({"resolution": 1.0},
                   env_extra={"CLUSTERING_MEMORY_BUDGET_BYTES": "1000"})
    assert proc.returncode != 0
    diag = proc.stderr
    assert "refusing before reading" in diag.lower()
    assert "MEMORY ceiling" in diag           # names WHICH ceiling
    assert "n_cells=" in diag                  # names the number/arithmetic
    # F3 — the labels path names a REACHABLE lever (smaller dataset / sandbox memory limit),
    # NOT the phantom `class: batch` the package ships no way to select. Mutation: restore
    # "class: batch" as the named lever → the `not in` assertion FAILS.
    assert "class: batch" not in diag
    assert "smaller single dataset" in diag and "sandbox memory limit" in diag
    # refused BEFORE the read — nothing was read, nothing was written.
    assert "read" not in run.progress_phases(proc)
    assert not (run.outputs_dir / "manifest.json").exists()


def test_over_time_ceiling_is_refused_and_names_the_time_ceiling(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    proc = run.run({"resolution": 1.0},
                   env_extra={"CLUSTERING_CPU_SECS_BUDGET": "0.00001",
                              "CLUSTERING_CPU_SECS_PER_MCELL": "1000000"})
    assert proc.returncode != 0
    diag = proc.stderr
    assert "TIME ceiling" in diag and "CPU-second" in diag
    assert "timeout_secs" in diag              # names the lever
    assert "read" not in run.progress_phases(proc)


def test_markers_over_memory_ceiling_refuses_before_the_csc_read(cluster_run):
    """INV-10 (MARKERS clause) — the DEDICATED markers-memory refusal (Stage-B wired the
    `markers_memory_refuse_if_over` guard but shipped no refusal test of its own). A markers
    run whose DECLARED expression CSC would exceed the MEMORY ceiling refuses BY NAME —
    naming the memory ceiling, the CSC PEAK arithmetic (`nnz=…`), and a REACHABLE lever (a
    smaller single dataset / raising the sandbox memory limit, NOT the phantom `class: batch`;
    F1/F2) — BEFORE the CSC read, never an OOM-kill mid-read.

    The budget is chosen so the tiny 10-dim embedding PASSES the labels-side memory gate
    (`ceiling_refuse_if_over`, ~19 KiB estimate) but the expression's declared PEAK FAILS
    the markers-side gate — isolating the MARKERS refusal from the labels refusal, so this
    test cannot pass vacuously via the labels ceiling.

    Mutation: drop `markers_memory_refuse_if_over(nnz)` in `_compute_markers_if_bound` → the
    CSC is read + markers computed → the run SUCCEEDS (returncode 0, a manifest is written)
    → this test FAILS.
    """
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    # 120 cells × 400 genes → declared nnz ≈ 36k, so the markers PEAK (nnz×24 B) ≫ the 100 KB
    # budget, while the 120-cell × 10-dim embedding's labels estimate (~19 KB) sits UNDER it.
    run.add_expression(three_blob_expression(40, 400, seed=1))
    proc = run.run({"resolution": 1.0},
                   env_extra={"CLUSTERING_MEMORY_BUDGET_BYTES": "100000"})
    assert proc.returncode != 0
    diag = proc.stderr
    # the MARKERS-specific refusal (distinct from the labels-side "reading the embedding" one).
    assert "refusing before reading the expression matrix" in diag
    assert "MEMORY ceiling" in diag          # names WHICH ceiling
    assert "nnz=" in diag                     # names the CSC arithmetic that drives it
    assert "PEAK" in diag                     # F1 — refuses on the true PEAK, not one copy
    # F2 — names a REACHABLE lever, never the phantom `class: batch`.
    assert "class: batch" not in diag
    assert "smaller single dataset" in diag and "sandbox memory limit" in diag
    # got as far as the markers PREFLIGHT, but refused BEFORE the CSC read (the `markers`
    # phase at progress 92) — the labels DID complete (they precede the optional markers).
    phases = run.progress_phases(proc)
    assert "markers-preflight" in phases
    assert "markers" not in phases
    # refused pre-read ⇒ NO conformant output was committed (no manifest).
    assert not (run.outputs_dir / "manifest.json").exists()


def test_below_the_viable_cell_floor_is_refused_honestly(cluster_run):
    run = cluster_run()
    # 6 cells < the DEC-6 floor of 10.
    run.add_embedding(three_blob_embedding(2, 8, seed=0), aligned_to=cells_digest(6))
    proc = run.run({"resolution": 1.0})
    assert proc.returncode != 0
    diag = proc.stderr
    assert "viable floor" in diag and "DEC-6" in diag
    assert "no cell is ever synthesized" in diag
    assert not (run.outputs_dir / "manifest.json").exists()
