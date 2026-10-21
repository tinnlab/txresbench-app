#!/usr/bin/env python3
# ruff: noqa
"""TEST-6 [acceptance] [invariant: INV-6] [covers: ITEM-9, ITEM-11] — de.compare on a
matrix-derived / hand-drawn grouping (no count-splitting) returns ranked effects with p ABSENT
(R2), and NEVER a p-value — the "find markers returns p on a hand-drawn selection" affordance
INV-6 forbids."""
from de_fixtures import two_group_expression, group_labels, sample_labels, MATRIX_DERIVED


def test_compare_on_a_derived_grouping_never_returns_p(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.add_column(sample_labels(per_side=3), slot="sample", name="donor")  # plenty of samples
    run.run_ok({"group1": "g0", "group2": "g1"})
    assert run.report()["regime"] == "R2"
    members = run.de_members(run.de_entries()[0])
    assert "neglog10p" not in members and "padj" not in members
