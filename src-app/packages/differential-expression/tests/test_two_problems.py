#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-6, ITEM-9] — pseudobulk fixes
REPLICATION and does NOTHING for SELECTION: a matrix-derived grouping with ≥2 samples/side
(replication available) still yields a result with p ABSENT (regime R2)."""
from de_fixtures import two_group_expression, group_labels, sample_labels, MATRIX_DERIVED


def test_replication_available_but_selection_unaddressed_yields_no_p(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.add_column(sample_labels(per_side=2), slot="sample", name="donor")
    run.run_ok({"group1": "g0", "group2": "g1"})
    e = run.de_entries()[0]
    members = run.de_members(e)
    # replication is available (2 samples/side) yet p is ABSENT — pseudobulk did not unlock a
    # p-value for the circular selection. A mutation emitting p merely because pseudobulk ran
    # would put `neglog10p` back and FAIL here.
    assert "neglog10p" not in members and "padj" not in members
    assert run.report()["regime"] == "R2"
    assert run.report()["pvalues_written"] is False
