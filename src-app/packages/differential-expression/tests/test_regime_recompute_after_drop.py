#!/usr/bin/env python3
# ruff: noqa
"""C2 [correctness] — the R1 regime is RE-DECIDED from the POST-drop surviving pseudobulks, never
the pre-drop sample count. When one side loses a replicate to `min_cells` (falling below 2
surviving pseudobulks), the artifact must be R3 (ranked effect, NO p), not R1. The mutation
(classify once, before the drop) leaves it R1 and writes p → these fail."""
import pytest

from de_fixtures import two_group_expression, EXTERNAL


def test_side_dropping_below_two_pseudobulks_downgrades_r1_to_r3(compare_run):
    pytest.importorskip("statsmodels")  # nb_glm would RUN if the bug kept it R1 (writes p)
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24))  # 60 cells, groups g0/g1
    grouping = ["g0"] * 30 + ["g1"] * 30
    # g0: sample s0 has 29 cells, s1 has 1 (dropped at min_cells=10) ⇒ g0 keeps 1 pseudobulk.
    # g1: s0 has 15, s1 has 15 ⇒ g1 keeps 2. Pre-drop samples/side = 2 (⇒ classifier says R1).
    samples = (["s0"] * 29 + ["s1"] * 1) + (["s0"] * 15 + ["s1"] * 15)
    run.add_column(grouping, slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(samples, slot="sample", name="donor")
    run.run_ok({"group1": "g0", "group2": "g1", "method": "nb_glm", "min_cells": 10})

    rep = run.report()
    # POST-drop the regime is R3 — a side has <2 surviving pseudobulks, so no valid p.
    assert rep["regime"] == "R3", rep["regime"]
    assert rep["pvalues_written"] is False
    members = run.de_members(run.de_entries()[0])
    assert "neglog10p" not in members and "padj" not in members
    # the downgrade is recorded honestly (not silent).
    pb = rep["pseudobulk"]
    assert pb.get("downgraded_from") == "R1"
    assert pb.get("surviving_samples_per_side") == 1


def test_side_losing_all_pseudobulks_is_refused_by_name(compare_run):
    # A side with ZERO survivors cannot be tested at all — refuse BY NAME, never fabricate.
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24))
    grouping = ["g0"] * 30 + ["g1"] * 30
    # every g0 sample has < min_cells cells ⇒ g0 keeps ZERO pseudobulks.
    samples = (["a", "b", "c"] * 10) + (["s0"] * 15 + ["s1"] * 15)
    run.add_column(grouping, slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(samples, slot="sample", name="donor")
    proc = run.run({"group1": "g0", "group2": "g1", "method": "nb_glm", "min_cells": 20})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "de.compare:" in msg and "surviving replicate" in msg
