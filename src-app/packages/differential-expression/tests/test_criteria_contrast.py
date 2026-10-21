#!/usr/bin/env python3
# ruff: noqa
"""TEST-7 [covers: ITEM-3] — in Advanced mode the two group MASKS select the correct cells (a
categorical + a numeric-range criterion, AND-combined) and the banded means / pseudobulk run over
EXACTLY those cells."""
import pytest

from de_fixtures import EXTERNAL, group_labels, sample_labels, two_group_expression


def test_advanced_masks_select_the_and_of_criteria(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=1))
    run.add_column(group_labels(30, ("treated", "control")), slot="column:condition",
                   name="condition", provenance=EXTERNAL)
    # a numeric score column 0..59 (str-encoded like every metadata-column).
    run.add_column([str(i) for i in range(60)], slot="column:score", name="score",
                   provenance=EXTERNAL)
    # NO sample column ⇒ R3 (ranked effect only) — this test is about MASK selection, not the
    # inferential method, so it never needs the pydeseq2/statsmodels wheel.
    run.run_ok({
        "contrast_mode": "advanced",
        # group1 = treated (cells 0-29) AND score in [0,14] → cells 0..14 = 15 cells (the AND).
        "group1_criteria": [{"column": "condition", "keep": ["treated"]},
                            {"column": "score", "min": "0", "max": "14"}],
        # group2 = control (cells 30-59) → 30 cells.
        "group2_criteria": [{"column": "condition", "keep": ["control"]}],
    })
    rep = run.report()
    gp = rep["grouping_provenance"]
    assert gp["advanced_contrast"] is True
    assert gp["n_group1"] == 15, "group1 mask must be the AND of the two criteria (treated ∩ [0,14])"
    assert gp["n_group2"] == 30
    # ONE de/result produced over exactly those two sides.
    ents = run.de_entries()
    assert len(ents) == 1
    # the per-cell readout n_1/n_2 reflect the mask sizes (banded means ran over the masked cells).
    n1 = run.de_column(ents[0], "n_1")
    n2 = run.de_column(ents[0], "n_2")
    assert set(n1) == {15.0} and set(n2) == {30.0}


def test_advanced_numeric_range_excludes_out_of_band_cells(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=2))
    run.add_column([str(i) for i in range(60)], slot="column:score", name="score",
                   provenance=EXTERNAL)
    run.run_ok({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "score", "min": "0", "max": "9"}],    # 10 cells
        "group2_criteria": [{"column": "score", "min": "50", "max": "59"}],  # 10 cells, disjoint
    })
    gp = run.report()["grouping_provenance"]
    assert gp["n_group1"] == 10 and gp["n_group2"] == 10
