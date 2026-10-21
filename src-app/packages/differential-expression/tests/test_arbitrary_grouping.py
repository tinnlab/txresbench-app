#!/usr/bin/env python3
# ruff: noqa
"""TEST-18 [covers: ITEM-5] — de.markers runs against an ARBITRARY categorical grouping that is
NOT a clustering (an imported condition), producing ranked markers; the disclosure is the
single-sourced MARKER_DISCLOSURE."""
from de_fixtures import two_group_expression, group_labels, EXTERNAL

import markers as MK


def test_markers_on_an_imported_condition_grouping(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(groups=("treated", "control")), slot="grouping",
                   name="condition", provenance=EXTERNAL)
    run.run_ok({"method": "wilcoxon"})
    # one ranked marker table per group (each group vs the rest).
    entries = run.de_entries()
    assert len(entries) == 2
    for e in entries:
        assert {"score", "logFC", "pct_1"} <= run.de_members(e)
    # the disclosure is the single-sourced MARKER_DISCLOSURE, verbatim.
    assert run.report()["disclosure"] == MK.MARKER_DISCLOSURE


def test_markers_records_regime_r2_even_for_an_external_grouping(markers_run):
    # M4 — a marker scan NEVER emits p, so it is always descriptive R2, matching the hardcoded R2
    # callout — even for an EXTERNAL grouping (which the compare classifier would call R3). A
    # provenance-driven `classify()` here would stamp R3 and mislabel the artifact → this fails.
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(groups=("treated", "control")), slot="grouping",
                   name="condition", provenance=EXTERNAL)
    run.run_ok({"method": "wilcoxon"})
    assert run.report()["regime"] == "R2"
    for e in run.de_entries():
        assert run.de_cyto(e)["de"]["regime"] == "R2"
