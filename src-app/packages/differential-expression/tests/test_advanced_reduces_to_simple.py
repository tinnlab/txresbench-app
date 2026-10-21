#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 [covers: ITEM-3] — Advanced generalizes Simple, it does not REPLACE the computation.

An Advanced contrast whose two groups are each a single categorical `is one of {level}` criterion
selects the SAME cells as the Simple two-level contrast for that split, so the de/result STAT
columns (logFC, detection, base_mean) are equivalent — the flexible builder is a SUPERSET of the
simple path, computed the same way over the same cells."""
import numpy as np
import pytest

from de_fixtures import EXTERNAL, group_labels, sample_labels, two_group_expression


def test_single_level_advanced_equals_simple(compare_run):
    matrix = two_group_expression(n_per=30, n_genes=24, seed=3)
    labels = group_labels(30, ("treated", "control"))

    # No sample column on either run ⇒ R3 ranked-effect on both, so the equivalence is checkable
    # without the pydeseq2/statsmodels wheel; the RANKED columns are what the two paths share.
    simple2 = compare_run()
    simple2.add_expression(matrix)
    simple2.add_column(labels, slot="grouping", name="condition", provenance=EXTERNAL)
    simple2.run_ok({"group1": "treated", "group2": "control"})

    advanced = compare_run()
    advanced.add_expression(matrix)
    advanced.add_column(labels, slot="column:condition", name="condition", provenance=EXTERNAL)
    advanced.run_ok({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "condition", "keep": ["treated"]}],
        "group2_criteria": [{"column": "condition", "keep": ["control"]}],
    })

    se = simple2.de_entries()[0]
    ae = advanced.de_entries()[0]
    assert simple2.report()["regime"] == advanced.report()["regime"] == "R3"
    for member in ("logFC", "base_mean", "pct_1", "pct_2", "n_1", "n_2", "score"):
        s = np.asarray(simple2.de_column(se, member), dtype=float)
        a = np.asarray(advanced.de_column(ae, member), dtype=float)
        assert np.allclose(s, a, atol=1e-9, equal_nan=True), (
            f"advanced-vs-simple diverged on member {member!r}: the single-level criteria "
            "contrast must select the SAME cells and compute the SAME ranked effect")
