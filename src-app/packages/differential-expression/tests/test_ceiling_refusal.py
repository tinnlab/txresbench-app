#!/usr/bin/env python3
# ruff: noqa
"""TEST-10 [acceptance] [invariant: INV-9] [covers: ITEM-4] — an over-ceiling input refuses
PRE-compute with an itemized message naming the ceiling + a REACHABLE lever, never a mid-run
signal-kill."""
from de_fixtures import two_group_expression, group_labels, MATRIX_DERIVED


def test_over_memory_ceiling_refuses_before_the_read_naming_a_lever(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="grp", provenance=MATRIX_DERIVED)
    # a tiny memory budget seam forces the pre-read ceiling to trip (it only LOWERS a budget).
    proc = run.run({"method": "wilcoxon"}, env_extra={"DE_MEMORY_BUDGET_BYTES": "1000"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "refusing before reading" in msg
    assert "MEMORY ceiling" in msg
    assert "smaller single dataset" in msg or "sandbox memory limit" in msg


def test_over_time_ceiling_refuses_before_the_read(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="grp", provenance=MATRIX_DERIVED)
    proc = run.run({"method": "wilcoxon"}, env_extra={"DE_CPU_SECS_BUDGET": "0.0000001"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "TIME ceiling" in msg and "CPU-seconds" in msg
