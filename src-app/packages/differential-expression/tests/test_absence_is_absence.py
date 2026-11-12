#!/usr/bin/env python3
# ruff: noqa
"""TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-10] — an R2/R3 `de/result` has NO
`neglog10p`/`padj` members WRITTEN (absent, not present-and-1.0); a consumer reading `padj` on
an R2 result errors loudly rather than returning a value."""
import pytest

from de_fixtures import two_group_expression, group_labels, sample_labels, MATRIX_DERIVED, EXTERNAL


def test_r2_omits_the_p_members_entirely(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.run_ok({})
    e = run.de_entries()[0]
    members = run.de_members(e)
    assert "neglog10p" not in members and "padj" not in members and "padj_across" not in members
    # the store's `de` attr records p was not written (absence-is-absence, honestly declared).
    assert run.de_txr(e)["de"]["pvalues_written"] is False


def test_r3_unreplicated_omits_the_p_members(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(per_side=1), slot="sample", name="donor")  # 1 sample/side ⇒ R3
    run.run_ok({"group1": "g0", "group2": "g1"})
    assert run.report()["regime"] == "R3"
    assert "neglog10p" not in run.de_members(run.de_entries()[0])


def test_reading_padj_on_an_r2_result_errors_loudly(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.run_ok({})
    e = run.de_entries()[0]
    # a consumer that asks for the absent `padj` member fails, rather than getting a fabricated 1.
    with pytest.raises(Exception):
        run.de_column(e, "padj")
