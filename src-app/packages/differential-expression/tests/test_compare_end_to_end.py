#!/usr/bin/env python3
# ruff: noqa
"""TEST-25 [tier: e2e] [covers: ITEM-6, ITEM-7, ITEM-8, ITEM-10] — de.compare on a fixture with
a sample column + ≥2 samples/side. When the rootfs wheels (decoupler + pydeseq2) are present the
R1 path aggregates to (sample × group) pseudobulks → PyDESeq2 → writes p; when they are ABSENT
the SAME run emits the NAMED refusal (TEST-15's e2e twin). The run is exercised either way —
it always RUNS both arms (self-detecting; carries no test-gate marker)."""
import conformance

from de_fixtures import two_group_expression, group_labels, sample_labels, EXTERNAL


def _wheels_present():
    try:
        import decoupler  # noqa
        import pydeseq2  # noqa
        return True
    except Exception:
        return False


def test_compare_r1_real_or_named_refusal(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24))
    run.add_column(group_labels(n_per=30), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(n_per=30, per_side=2), slot="sample", name="donor")
    proc = run.run({"group1": "g0", "group2": "g1", "method": "pydeseq2"})

    if _wheels_present():
        assert proc.returncode == 0, proc.stderr[-2000:]
        assert run.report()["regime"] == "R1"
        e = run.de_entries()[0]
        members = run.de_members(e)
        # R1 writes the p-family (neglog10p stored, padj + across-family) + the multiplicity family.
        assert {"neglog10p", "padj", "padj_across"} <= members
        assert run.report()["pvalues_written"] is True
        assert "BH within" in run.report()["multiplicity_family"]
        assert conformance.conform_outputs(run.outputs_dir) == []
    else:
        # the wheels are not in this environment → the R1 path refuses BY NAME (the twin of
        # TEST-15), never a raw ImportError. This branch PASSES (the refusal is asserted).
        assert proc.returncode != 0
        msg = run.diagnostics(proc)
        assert "de.compare:" in msg
        assert "decoupler" in msg or "pydeseq2" in msg
        assert "rootfs" in msg
