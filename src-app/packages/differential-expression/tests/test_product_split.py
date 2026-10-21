#!/usr/bin/env python3
# ruff: noqa
"""TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-4, ITEM-6] — de.markers emits ranked
effect + detection with NO p member in ANY regime; de.compare emits p ONLY in R1."""
from de_fixtures import (two_group_expression, group_labels, sample_labels,
                         MATRIX_DERIVED, EXTERNAL)


def test_markers_never_emits_a_p_member(markers_run):
    for prov in (MATRIX_DERIVED, EXTERNAL):
        run = markers_run()
        run.add_expression(two_group_expression())
        run.add_column(group_labels(), slot="grouping", name="grp", provenance=prov)
        run.run_ok({})
        for e in run.de_entries():
            members = run.de_members(e)
            assert "neglog10p" not in members and "padj" not in members
            # …but it DOES emit the ranked effect + detection members.
            assert {"score", "logFC", "pct_1", "pct_2"} <= members


def test_compare_emits_p_only_in_r1(compare_run):
    # matrix-derived ⇒ R2 ⇒ no p (proven elsewhere). Here: external + 1 sample/side ⇒ R3 ⇒ no p.
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(per_side=1), slot="sample", name="donor")
    run.run_ok({"group1": "g0", "group2": "g1"})
    assert "neglog10p" not in run.de_members(run.de_entries()[0])
