#!/usr/bin/env python3
# ruff: noqa
"""TEST-4 [acceptance] [invariant: INV-A4] [covers: ITEM-5, ITEM-7] — the CONSERVATIVE regime.

A contrast where EITHER group has a criterion on a MATRIX-DERIVED column resolves R2 (no
`neglog10p`/`padj`) even with a sample column + ≥2 samples/side; an ALL-external contrast with
replication resolves R1. A mutation that ORs (only-if-ALL-derived) or ignores group2's provenance
FAILS. Also unit-tests `classify_contrast` directly (the truth table)."""
import pytest

from de_fixtures import (EXTERNAL, MATRIX_DERIVED, group_labels, import_own,
                         sample_labels, two_group_expression)

R = import_own("_regime")


# ── unit: the classify_contrast truth table (INV-A4 / DEC-A3) ────────────────────────
def test_classify_contrast_any_derived_is_R2_even_with_replication():
    # group1 external, group2 DERIVED, 3 samples/side → still R2 (double-dipping back-door).
    assert R.classify_contrast([{"external": True}, {"clustering": {}}], samples_per_side=3) == R.R2
    # order irrelevant — a derived column in EITHER position forces R2.
    assert R.classify_contrast([{"clustering": {}}, {"external": True}], samples_per_side=3) == R.R2


def test_classify_contrast_all_external_replicated_is_R1():
    assert R.classify_contrast([{"external": True}, {"external": True}], samples_per_side=2) == R.R1


def test_classify_contrast_all_external_unreplicated_is_R3():
    assert R.classify_contrast([{"external": True}, {"external": True}], samples_per_side=1) == R.R3
    assert R.classify_contrast([{"external": True}], samples_per_side=None) == R.R3


def test_classify_contrast_no_evidence_defaults_conservative_R2():
    # a column with no provenance is NOT external (DEC-4) — a single such column drops to R2.
    assert R.classify_contrast([{"external": True}, {}], samples_per_side=2) == R.R2
    assert R.classify_contrast([], samples_per_side=2) == R.R2


# ── end-to-end: a derived criterion forces R2 even with a replicated sample column ───
def test_derived_criterion_forces_R2_end_to_end(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=1))
    # group1 uses a MATRIX-DERIVED column (leiden clustering) — cells 0..29 are cluster "4".
    run.add_column(["4"] * 30 + ["7"] * 30, slot="column:leiden", name="leiden",
                   provenance=MATRIX_DERIVED)
    run.add_column(group_labels(30, ("treated", "control")), slot="column:condition",
                   name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(30, per_side=2), slot="sample", name="donor", provenance=EXTERNAL)
    run.run_ok({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "leiden", "keep": ["4"]}],           # cells 0..29 (derived)
        "group2_criteria": [{"column": "condition", "keep": ["control"]}],  # cells 30..59
    })
    rep = run.report()
    assert rep["regime"] == "R2", "a matrix-derived criterion must force R2 despite replication"
    members = run.de_members(run.de_entries()[0])
    assert "neglog10p" not in members and "padj" not in members, "R2 writes NO p (INV-A4)"


def test_derived_criterion_in_GROUP2_ONLY_forces_R2_end_to_end(compare_run):
    # AC7 — the mirror of the derived-in-group1 case: group1 is ALL-EXTERNAL, and the DERIVED
    # column (leiden) constrains GROUP2. A mutation that walks only `g1_criteria` for provenance
    # would miss it and (wrongly) grant R1 with replication → this asserts R2. Order-independence
    # is proven against the REAL `_advanced_contrast` collection, not just the unit truth table.
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=1))
    run.add_column(group_labels(30, ("treated", "control")), slot="column:condition",
                   name="condition", provenance=EXTERNAL)
    # leiden clustering (matrix-derived): cells 30..59 are cluster "7".
    run.add_column(["4"] * 30 + ["7"] * 30, slot="column:leiden", name="leiden",
                   provenance=MATRIX_DERIVED)
    run.add_column(sample_labels(30, per_side=2), slot="sample", name="donor", provenance=EXTERNAL)
    run.run_ok({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "condition", "keep": ["treated"]}],  # external, cells 0..29
        "group2_criteria": [{"column": "leiden", "keep": ["7"]}],           # DERIVED, cells 30..59
    })
    rep = run.report()
    assert rep["regime"] == "R2", (
        "a matrix-derived criterion in GROUP2 must force R2 despite replication — the provenance "
        "walk must cover BOTH groups")
    # the per-column classification the chips reflect marks leiden derived, condition external.
    cls = rep["grouping_provenance"]["criterion_classification"]
    assert cls["leiden"] == "matrix-derived" and cls["condition"] == "external"
    members = run.de_members(run.de_entries()[0])
    assert "neglog10p" not in members and "padj" not in members, "R2 writes NO p (INV-A4)"


def test_all_external_replicated_contrast_is_R1_end_to_end(compare_run):
    pytest.importorskip("statsmodels")  # nb_glm runs locally so R1 actually writes p
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=1))
    run.add_column(group_labels(30, ("treated", "control")), slot="column:condition",
                   name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(30, per_side=2), slot="sample", name="donor", provenance=EXTERNAL)
    run.run_ok({
        "contrast_mode": "advanced",
        "method": "nb_glm",
        "group1_criteria": [{"column": "condition", "keep": ["treated"]}],
        "group2_criteria": [{"column": "condition", "keep": ["control"]}],
    })
    rep = run.report()
    assert rep["regime"] == "R1", "all-external + ≥2 samples/side is an inferential test"
    members = run.de_members(run.de_entries()[0])
    assert "neglog10p" in members and "padj" in members, "R1 writes p (INV-5)"
