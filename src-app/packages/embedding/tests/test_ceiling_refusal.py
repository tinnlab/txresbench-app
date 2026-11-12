#!/usr/bin/env python3
# ruff: noqa
"""Ceiling-gate acceptance tests (INV-8 / INV-9).

TEST-20 — the estimate sizes against the Normal-class envelope (nnz×8 from DECLARED
structure) and counts parallelism against the CPU budget, not wall time.
TEST-21 — an over-ceiling run is REFUSED before any matrix read, with an honest message
naming the number, the budget, and WHICH ceiling (memory vs time).
"""
import json

import numpy as np

from embedding_fixtures import counts_matrix


# ── TEST-20 [acceptance] [invariant: INV-8] [covers: ITEM-16] ──────────────────────
def test_the_estimate_sizes_against_the_normal_class_envelope(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(60, 40, seed=0))
    run.run_ok({"n_hvg": 12, "n_pcs": 6})
    ceiling = run.report()["ceiling"]
    nnz = ceiling["nnz"]
    # resident = nnz × 8 (uint32 index + float32 datum), from the DECLARED nnz.
    assert ceiling["estimated_resident_bytes"] == nnz * 8
    # the default budget is the Normal class 4 GiB.
    assert ceiling["memory_budget_bytes"] == 4 * 1024**3
    # CPU-seconds counted against the 600 CPU-s Normal budget (parallelism, not wall).
    assert ceiling["cpu_seconds_budget"] == 600.0
    assert ceiling["estimated_cpu_seconds"] >= 0.0


# ── TEST-21 [acceptance] [invariant: INV-9] [covers: ITEM-10, ITEM-16] ─────────────
def test_over_memory_ceiling_is_refused_before_any_read(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(80, 60, seed=1))
    # a tiny memory budget forces the refusal without a 4 GiB fixture.
    proc = run.run({"n_hvg": 12, "n_pcs": 6},
                   env_extra={"EMBEDDING_MEMORY_BUDGET_BYTES": "1000"})
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "refusing before reading" in diag.lower()
    assert "memory" in diag.lower()          # names WHICH ceiling
    assert "nnz=" in diag                     # names the number/arithmetic
    assert "lever" in diag.lower()            # names the lever that moves it
    # refused BEFORE the read — no matrix was read, nothing was written.
    phases = run.progress_phases(proc)
    assert "read" not in phases
    assert not (run.outputs_dir / "manifest.json").exists()


def test_over_time_ceiling_is_refused_and_names_the_time_ceiling(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(80, 60, seed=2))
    proc = run.run({"n_hvg": 12, "n_pcs": 6},
                   env_extra={"EMBEDDING_CPU_SECS_BUDGET": "0.0001",
                              "EMBEDDING_CPU_SECS_PER_MNNZ": "1000"})
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "time" in diag.lower() and "cpu-second" in diag.lower()
    assert "read" not in run.progress_phases(proc)


# ── TEST-41 [covers: ITEM-16] — P1: the gate sizes the TRUE PEAK, not one copy ──────
# The pipeline holds ~3 concurrent copies of the stored values during the fit (CSC read
# buffer + CSR X + the float64 counts layer), so the ceiling must refuse on the peak. A
# matrix that fits at 1× (nnz×8) but NOT at peak (nnz×28) is refused before any read.
# Mutation this kills: revert `_PEAK_BYTES_PER_NNZ` to 8 → peak == resident < budget → the
# run is NOT refused (returncode 0) → the refusal assertion fails.
def test_the_gate_refuses_on_the_concurrent_copy_peak_not_a_single_copy(reduce_run):
    dense = counts_matrix(80, 60, seed=7)
    nnz = int((dense != 0).sum())
    # a budget ABOVE one copy (nnz×8) but BELOW the real peak (nnz×28): 1.5× one copy.
    budget = int(nnz * 8 * 1.5)
    run = reduce_run()
    run.add_matrix(dense)
    proc = run.run({"n_hvg": 12, "n_pcs": 6},
                   env_extra={"EMBEDDING_MEMORY_BUDGET_BYTES": str(budget)})
    assert proc.returncode != 0, (
        "a matrix that fits at 1× but not at the ~3-copy peak was NOT refused — the ceiling "
        "underestimated peak memory (P1)")
    diag = run.diagnostics(proc)
    assert "peak" in diag.lower() and "memory" in diag.lower()
    assert "read" not in run.progress_phases(proc)
    assert not (run.outputs_dir / "manifest.json").exists()


# ── TEST-42 [covers: ITEM-16] — P2: a missing declared `nnz` fails CLOSED ───────────
# `structure.get("nnz", 0)` used to yield 0 for a store with no declared nnz → resident 0 →
# both gates passed trivially → the matrix was read anyway, silently disabling the ceiling.
# Mutation this kills: restore the `.get("nnz", 0)` default → the run is NOT refused.
def test_a_missing_declared_nnz_is_refused_not_bypassed(reduce_run):
    run = reduce_run()
    store = run.add_matrix(counts_matrix(80, 60, seed=8))
    # strip `nnz` from the declared structure the ceiling reads.
    meta = store / "zarr.json"
    doc = json.loads(meta.read_text())
    assert doc["attributes"]["txr"].pop("nnz", None) is not None
    meta.write_text(json.dumps(doc, indent=2))

    proc = run.run({"n_hvg": 12, "n_pcs": 6})
    assert proc.returncode != 0, "a structure with no declared nnz silently bypassed the ceiling (P2)"
    diag = run.diagnostics(proc)
    assert "nnz" in diag.lower() and "refusing before reading" in diag.lower()
    assert "read" not in run.progress_phases(proc)
