#!/usr/bin/env python3
# ruff: noqa
"""TEST-2 [acceptance] [invariant: INV-2] [covers: ITEM-9] — the regime is decided by the
grouping column's PROVENANCE, not the analysis id: a matrix-derived grouping resolves R2 whether
invoked via de.markers or de.compare."""
from de_fixtures import two_group_expression, group_labels, sample_labels, MATRIX_DERIVED


def test_matrix_derived_grouping_is_r2_via_markers(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.run_ok({"method": "wilcoxon"})
    assert run.report()["regime"] == "R2"


def test_matrix_derived_grouping_is_r2_via_compare_even_with_samples(compare_run):
    # A mutation keying the regime on the analysis (compare ⇒ R1) would FAIL here.
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.add_column(sample_labels(per_side=2), slot="sample", name="donor")
    run.run_ok({"group1": "g0", "group2": "g1"})
    assert run.report()["regime"] == "R2"
