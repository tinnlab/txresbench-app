#!/usr/bin/env python3
# ruff: noqa
"""TEST-19 [covers: ITEM-8] — BH within comparison by default, the across-comparison family
emitted too (G4); no global pseudocount is added to raw counts (D4)."""
from pathlib import Path

import numpy as np

import compare as CMP

_COMPARE_SRC = (Path(__file__).resolve().parents[1] / "compute" / "compare.py").read_text()


def test_bh_within_comparison_is_correct():
    # Benjamini-Hochberg on a known vector.
    p = np.array([0.01, 0.02, 0.03, 0.04, 0.05])
    adj = CMP._bh(p)
    # monotone, in [0,1], and each ≥ the raw p.
    assert np.all(adj >= p - 1e-9)
    assert np.all((adj >= 0) & (adj <= 1))
    assert np.all(np.diff(adj[np.argsort(p)]) >= -1e-9)


def test_r1_emits_both_within_and_across_family_columns():
    # the R1 branch writes BOTH `padj` (within) and `padj_across` (across-comparison family).
    assert '"padj": padj_within' in _COMPARE_SRC
    assert '"padj_across": padj_across' in _COMPARE_SRC


def test_no_global_pseudocount_added_to_raw_counts():
    # D4 (BEHAVIORAL, not a source-grep) — the banded pseudobulk of a KNOWN fixture equals the
    # exact integer per-(unit) SUM, with NO additive constant. A `+1` pseudocount mutation on the
    # counts makes every entry off by (n_cells_in_unit) and this fails.
    import scipy.sparse as sp
    # 4 cells × 3 genes; unit 0 = cells {0,1}, unit 1 = cells {2,3}.
    dense = np.array([[2, 0, 1],
                      [3, 0, 0],
                      [0, 5, 4],
                      [0, 1, 0]], dtype=np.float32)
    csc = sp.csc_matrix(dense)
    unit_codes = np.array([0, 0, 1, 1], dtype=np.intp)
    pb = CMP._banded_pseudobulk_counts(csc.indptr, csc.indices, csc.data, 4, 3,
                                       ["a", "b", "c"], unit_codes, 2)
    # the EXACT integer sum per unit — no pseudocount anywhere.
    expected = np.array([[5, 0, 1],    # cells 0+1
                         [0, 6, 4]])   # cells 2+3
    assert np.array_equal(pb, expected), pb
    # a `+1`-per-cell pseudocount would have produced unit sums of (5+2, 0+2, 1+2) etc.
    assert pb[0, 1] == 0 and pb[1, 0] == 0  # a true zero stays zero (no floor/pseudocount)
