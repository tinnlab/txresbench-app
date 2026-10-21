#!/usr/bin/env python3
# ruff: noqa
"""TEST-3 [acceptance] [invariant: INV-A3] [covers: ITEM-4] — overlap is a hard REFUSAL by name.

Two criteria sets that select a shared cell → `de.compare` REFUSES BY NAME naming the shared-cell
count, PRE-COMPUTE (no p, no partial result). A mutation that tests overlapping groups (or
downgrades the refusal to a warning) FAILS."""
from de_fixtures import EXTERNAL, two_group_expression


def test_overlapping_criteria_are_refused_by_name(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=1))
    run.add_column([str(i) for i in range(60)], slot="column:score", name="score",
                   provenance=EXTERNAL)
    proc = run.run({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "score", "min": "0", "max": "40"}],   # cells 0..40 (41)
        "group2_criteria": [{"column": "score", "min": "20", "max": "59"}],  # cells 20..59 (40)
    })
    assert proc.returncode != 0, "an overlapping contrast must be REFUSED, never tested"
    diag = run.diagnostics(proc)
    assert diag.startswith("de.compare:"), diag
    assert "in both group1 and group2" in diag
    # NAMES the shared-cell count — the intersection is cells 20..40 inclusive = 21 cells.
    assert "21 cells" in diag, diag
    # PRE-COMPUTE: no manifest, no de/result — the refusal fired before any test ran.
    assert not (run.outputs_dir / "manifest.json").exists()
    # and never entered the test phase (no pseudobulk / test progress line).
    phases = run.progress_phases(proc)
    assert "pseudobulk" not in phases and "test" not in phases


def test_disjoint_criteria_are_not_refused(compare_run):
    # POSITIVE CONTROL — the same shapes made disjoint must RUN (so the refusal is not vacuous).
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=1))
    run.add_column([str(i) for i in range(60)], slot="column:score", name="score",
                   provenance=EXTERNAL)
    run.run_ok({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "score", "min": "0", "max": "19"}],
        "group2_criteria": [{"column": "score", "min": "20", "max": "59"}],
    })
    assert len(run.de_entries()) == 1
