#!/usr/bin/env python3
# ruff: noqa
"""C1 [correctness] — a >2-level contrast EXCLUDES the non-{g1,g2} cells from every per-group
readout rather than relabelling them into group 0. On a 3-group {A,B,C} matrix, the A-vs-B
result must be IDENTICAL to the {A,B}-only 2-group case (C must not move A's logFC/pct_1/n_1).
The old `np.where(keep, two_codes, 0)` mutation (relabel-to-0) folds C into group A → this fails."""
import numpy as np

from de_fixtures import two_group_expression, MATRIX_DERIVED


def _read(run, member):
    return np.asarray(run.de_column(run.de_entries()[0], member), dtype=float)


def test_third_group_does_not_contaminate_the_a_vs_b_contrast(compare_run):
    # ONE underlying matrix; the first 60 cells are blocks A,B and the last 30 are block C. The
    # 2-group run is that same matrix SLICED to A,B, so A/B cell data is byte-identical.
    mat3 = two_group_expression(n_per=30, n_genes=24, n_groups=3, seed=7)  # 90 × 24
    mat2 = mat3[:60]                                                        # A,B blocks only
    grouping3 = ["A"] * 30 + ["B"] * 30 + ["C"] * 30
    grouping2 = ["A"] * 30 + ["B"] * 30

    run3 = compare_run()
    run3.add_expression(mat3)
    run3.add_column(grouping3, slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run3.run_ok({"group1": "A", "group2": "B"})   # R2 (matrix-derived) — ranked effect only

    run2 = compare_run()
    run2.add_expression(mat2)
    run2.add_column(grouping2, slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run2.run_ok({"group1": "A", "group2": "B"})

    # A's effect sizes + detection + the g1 cell count must be UNMOVED by the presence of C.
    for member in ("logFC", "pct_1", "pct_2", "base_mean", "score", "n_1", "n_2"):
        a = _read(run3, member)
        b = _read(run2, member)
        assert np.allclose(a, b, equal_nan=True), (member, a[:5], b[:5])
    # and n_1 is exactly the g1 (A) cell count — the mean denominator agrees with it (not A ∪ C).
    assert _read(run3, "n_1")[0] == 30.0 and _read(run3, "n_2")[0] == 30.0
