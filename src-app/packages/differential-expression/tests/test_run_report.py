#!/usr/bin/env python3
# ruff: noqa
"""TEST-26 [covers: ITEM-17] — a DE run emits ONE `report/qc` index enumerating every comparison
it produced, each comparison's `regime`, the disclosure, and (for compare) dropped/degraded
pseudobulks; the report references the per-comparison `de/result` artifact ids (the run set)."""
from de_fixtures import (two_group_expression, group_labels, sample_labels,
                         MATRIX_DERIVED, EXTERNAL)


def test_markers_run_emits_one_report_indexing_its_comparisons(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression(n_groups=3))
    run.add_column(group_labels(groups=("a", "b", "c")), slot="grouping", name="grp",
                   provenance=MATRIX_DERIVED)
    run.run_ok({})
    # exactly one report/qc. #80: the hidden `run-environment` record reuses that datatype
    # (it declares the same opaque-JSON shape every report already does, so the artifact
    # conformance gate accepts it under an existing rule) — it is a provenance carrier, not
    # this analysis' report, so the claim is asserted over the PRODUCED reports.
    reports = [e for e in run.manifest()["outputs"]
               if e["datatype"] == "report/qc" and e["id"] != "run-environment"]
    assert len(reports) == 1
    rep = run.report()
    de_ids = {e["id"] for e in run.de_entries()}
    # the report enumerates every comparison with its regime, and references the run's de ids.
    assert len(rep["comparisons"]) == len(de_ids) == 3
    for c in rep["comparisons"]:
        assert c["regime"] == "R2"
        assert c["id"] in de_ids
    assert rep["disclosure"]


def test_compare_report_records_regime_and_dropped_pseudobulks(compare_run):
    # an R3 run (external, 1 sample/side) — the report records the regime + the comparison set.
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(per_side=1), slot="sample", name="donor")
    run.run_ok({"group1": "g0", "group2": "g1"})
    rep = run.report()
    assert rep["regime"] == "R3"
    assert rep["comparisons"][0]["id"] in {e["id"] for e in run.de_entries()}
    assert "dropped" in rep
