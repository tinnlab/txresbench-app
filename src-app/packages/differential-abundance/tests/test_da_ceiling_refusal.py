#!/usr/bin/env python3
# ruff: noqa
"""TEST-25 [covers: ITEM-4] — the Normal-class ceiling refuses BEFORE any read, by name.

The compute is reachable by an agent/MCP call that never rendered a form, so the envelope is
re-checked compute-side from the DECLARED embedding structure before a byte of the matrix is read.
A refusal must name WHICH ceiling was hit and a lever the reader can actually reach — and, as in
`clustering`, it must NOT name a `batch` resource class, because this package ships no per-run
class control and pointing at one would send the reader after an escape hatch that does not exist.
"""
import numpy as np

from da_fixtures import embedding_dataset, EXTERNAL


def _bind(run, *, n_per_sample=60, samples_per_side=2, n_dims=6):
    X, conds, samps, _ = embedding_dataset(n_per_sample=n_per_sample,
                                           samples_per_side=samples_per_side, n_dims=n_dims)
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    return X


def test_the_memory_ceiling_refuses_before_any_read_and_names_a_reachable_lever(neighbourhoods_run):
    run = neighbourhoods_run()
    _bind(run)
    proc = run.run({"method": "nb_glm"}, env_extra={"DA_MEMORY_BUDGET_BYTES": "1024"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "MEMORY ceiling" in msg
    assert "refusing before reading the embedding" in msg
    assert "smaller embedding" in msg and "sandbox memory limit" in msg
    assert "batch" not in msg, (
        "the refusal must not name a `batch` resource class — this package ships no per-run class "
        "control, so that would point the reader at an escape hatch that does not exist")
    phases = run.progress_phases(proc)
    assert "read" not in phases and "graph" not in phases, (
        f"the ceiling gate ran too late: {phases}")


def test_the_time_ceiling_refuses_and_names_the_admin_setting(neighbourhoods_run):
    run = neighbourhoods_run()
    _bind(run)
    proc = run.run({"method": "nb_glm"}, env_extra={"DA_CPU_SECS_BUDGET": "0.000001"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "TIME ceiling" in msg
    assert "timeout_secs" in msg
    assert "CPU-seconds count parallelism, not wall clock" in msg
    assert "batch" not in msg


def test_the_ceiling_estimate_is_recorded_on_a_successful_run(neighbourhoods_run):
    run = neighbourhoods_run()
    _bind(run, n_per_sample=150, samples_per_side=3)
    run.run_ok({"method": "nb_glm", "prop": 0.15})
    ceiling = run.report()["ceiling"]
    for key in ("n_cells", "n_dims", "n_neighbors", "prop", "estimated_resident_bytes",
                "memory_budget_bytes", "estimated_cpu_seconds", "cpu_seconds_budget"):
        assert key in ceiling, key
    assert ceiling["estimated_resident_bytes"] < ceiling["memory_budget_bytes"]


def test_the_estimate_scales_with_the_neighbour_count_rather_than_a_hardcoded_k():
    """A run at `k=50` builds structures ~3x larger than a k=15 estimate; hardcoding 15 would
    underestimate the peak by that factor and let an oversized run slip the gate."""
    from da_modules import import_own
    S = import_own("_shared")

    small = S.ceiling_refuse_if_over(100_000, 20, n_neighbors=15, prop=0.1)
    large = S.ceiling_refuse_if_over(100_000, 20, n_neighbors=50, prop=0.1)
    assert large["estimated_resident_bytes"] > small["estimated_resident_bytes"] * 1.5


def test_a_below_floor_cell_count_is_refused_rather_than_fitted(neighbourhoods_run):
    run = neighbourhoods_run()
    X = np.random.default_rng(0).normal(size=(6, 5)).astype(np.float32)
    run.add_embedding(X, slot="embedding")
    run.add_column(["ctrl", "ctrl", "ctrl", "treat", "treat", "treat"], slot="condition",
                   name="condition", provenance=EXTERNAL)
    run.add_column(["s0", "s1", "s2", "s3", "s4", "s5"], slot="sample", name="sample")
    proc = run.run({"method": "nb_glm"})
    assert proc.returncode != 0
    assert "viable floor" in run.diagnostics(proc)
