#!/usr/bin/env python3
# ruff: noqa
"""TEST-24 [tier: e2e] [covers: ITEM-3, ITEM-4, ITEM-5, ITEM-9, ITEM-10] — the REAL-COMPUTE
markers path AS A SUBPROCESS: a fixture matrix + a categorical grouping run through de.markers
(spawn → banded read → Wilcoxon → write de/result with p ABSENT + attributes.cyto regime), and
the output CONFORMS via the real framework gate."""
import conformance

from de_fixtures import two_group_expression, group_labels, MATRIX_DERIVED


def test_real_compute_markers_end_to_end_conforms(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24))
    run.add_column(group_labels(n_per=30), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    proc = run.run_ok({"method": "wilcoxon", "seed": 0})

    # per-phase progress stream (not a boolean spinner).
    phases = run.progress_phases(proc)
    for expected in ("read", "score", "write", "report", "done"):
        assert expected in phases, (expected, phases)

    # two de/result gene tables (each group vs rest) + a report/qc.
    datatypes = {e["datatype"] for e in run.manifest()["outputs"]}
    assert "de/result" in datatypes and "report/qc" in datatypes
    assert len(run.de_entries()) == 2

    for e in run.de_entries():
        members = run.de_members(e)
        # ranked effect + detection members land; p is ABSENT (descriptive, INV-3/INV-4).
        assert {"gene", "score", "logFC", "pct_1", "pct_2", "n_1", "n_2", "base_mean"} <= members
        assert "neglog10p" not in members and "padj" not in members
        # attributes.cyto carries the regime provenance (G3).
        assert run.de_cyto(e)["de"]["regime"] == "R2"

    # conforms against `produces: [de/result, report/qc]` via the real framework gate.
    assert conformance.conform_outputs(run.outputs_dir) == []
