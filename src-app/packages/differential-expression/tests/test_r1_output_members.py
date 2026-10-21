#!/usr/bin/env python3
# ruff: noqa
"""C6 / C7 [correctness] — an R1 (pseudobulk) artifact WRITES the detection fractions
`pct_1`/`pct_2` (G2, dropped before), and its `n_1`/`n_2` are CELL counts (consistent with
R2/R3) while the pseudobulk SAMPLE counts live in the distinct `n_samples_1`/`n_samples_2`.
Uses nb_glm (statsmodels is in the rootfs) so R1 actually runs and writes p locally."""
import numpy as np
import pytest

from de_fixtures import two_group_expression, group_labels, sample_labels, EXTERNAL


@pytest.fixture
def r1_run(compare_run):
    pytest.importorskip("statsmodels")
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24))
    run.add_column(group_labels(n_per=30), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(n_per=30, per_side=2), slot="sample", name="donor")
    run.run_ok({"group1": "g0", "group2": "g1", "method": "nb_glm"})
    return run


def test_r1_is_actually_inferential(r1_run):
    assert r1_run.report()["regime"] == "R1"
    assert r1_run.report()["pvalues_written"] is True


def test_r1_writes_detection_fractions(r1_run):
    # C6 — pct_1/pct_2 are present and are real detection rates in [0,1].
    members = r1_run.de_members(r1_run.de_entries()[0])
    assert {"pct_1", "pct_2"} <= members
    for m in ("pct_1", "pct_2"):
        vals = np.asarray(r1_run.de_column(r1_run.de_entries()[0], m), dtype=float)
        assert np.all(np.isfinite(vals)) and np.all((vals >= 0) & (vals <= 1))


def test_r1_n_are_cells_and_n_samples_are_pseudobulks(r1_run):
    # C7 — n_1/n_2 = CELL counts (30 per side); n_samples_1/n_samples_2 = pseudobulk SAMPLE
    # counts (2 per side). They are DISTINCT members with different units.
    e = r1_run.de_entries()[0]
    members = r1_run.de_members(e)
    assert {"n_1", "n_2", "n_samples_1", "n_samples_2"} <= members
    n_1 = np.asarray(r1_run.de_column(e, "n_1"), dtype=float)[0]
    n_samples_1 = np.asarray(r1_run.de_column(e, "n_samples_1"), dtype=float)[0]
    assert n_1 == 30.0            # cells on side g0
    assert n_samples_1 == 2.0     # pseudobulk samples on side g0
    assert n_1 != n_samples_1     # two different units, no longer the same member name
