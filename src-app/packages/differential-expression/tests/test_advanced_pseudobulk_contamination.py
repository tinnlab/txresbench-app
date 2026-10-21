#!/usr/bin/env python3
# ruff: noqa
"""AC1 [correctness] [invariant: INV-A3/INV-1] [covers: compare._banded_pseudobulk_counts] — in an
ADVANCED contrast the pseudobulk sum must be over ONLY the contrast cells. Non-contrast
(`__none__`) cells map to `unit_index.get(...,0)` = pseudobulk unit 0, so without a keep-mask their
RAW counts fold into unit 0 and silently bias the DESeq2/NB-GLM test. This is the feature's
headline path; the mutation (drop the `keep=` filter, default-to-0) FAILS here.

AC2 [fidelity] [invariant: INV-A1/DEC-A5] [covers: compare._criteria_with_excludes] — the
per-criterion include/EXCLUDE toggle, realized as the categorical COMPLEMENT keep-set so the
vendored kernel (`_criteria.criteria_keep_mask`) stays byte-identical. An exclude{A} mask MUST equal
NOT include{A}; the mutation (treat exclude as include) FAILS here."""
import numpy as np

import compare
from de_fixtures import import_own

CRIT = import_own("_criteria")


# ── AC1 — pseudobulk unit-0 contamination ─────────────────────────────────────────────
def test_pseudobulk_unit0_sums_only_contrast_cells():
    # 4 cells, 2 genes, gene-major CSC. Cells 0,1 are the ONE surviving contrast unit (unit 0);
    # cells 2,3 are `__none__` (excluded) but map to unit 0 via `unit_index.get(...,0)`.
    indptr = np.array([0, 4, 8], dtype=np.int64)
    indices = np.array([0, 1, 2, 3, 0, 1, 2, 3], dtype=np.int64)
    data = np.array([10, 20, 100, 200, 1, 2, 50, 60], dtype=np.float64)
    unit_codes = np.array([0, 0, 0, 0], dtype=np.intp)   # every cell (incl. __none__) → unit 0
    keep = np.array([True, True, False, False])          # only cells 0,1 belong to the contrast

    pb = compare._banded_pseudobulk_counts(
        indptr, indices, data, 4, 2, ["g0", "g1"], unit_codes, 1, keep=keep)
    # unit 0 = the kept cells only: gene0 = 10+20 = 30, gene1 = 1+2 = 3.
    assert pb[0, 0] == 30.0 and pb[0, 1] == 3.0, (
        "the pseudobulk sum must EXCLUDE the __none__ cells (2,3); their counts must not fold "
        "into unit 0")

    # The reverted behaviour (no keep-mask) folds cells 2,3 into unit 0 → 330 / 113 — proving the
    # keep-mask is exactly what stops the contamination.
    contaminated = compare._banded_pseudobulk_counts(
        indptr, indices, data, 4, 2, ["g0", "g1"], unit_codes, 1)
    assert contaminated[0, 0] == 330.0 and contaminated[0, 1] == 113.0


# ── AC2 — categorical exclude == complement (kernel unchanged) ─────────────────────────
def _mask(criteria, obs, n):
    return np.asarray(CRIT.criteria_keep_mask(criteria, obs, n_cells=n), dtype=bool)


def test_categorical_exclude_is_the_complement_of_include():
    obs = {"leiden": ["A", "A", "B", "B", "C", "C"]}
    n = 6

    include_A = _mask([{"column": "leiden", "keep": ["A"]}], obs, n)
    exclude_crit = compare._criteria_with_excludes(
        [{"column": "leiden", "keep": ["A"], "mode": "exclude"}], obs)
    exclude_A = _mask(exclude_crit, obs, n)

    # exclude{A} selects the COMPLEMENT cells — exactly NOT include{A}.
    assert np.array_equal(exclude_A, ~include_A), (
        "a categorical exclude{A} must select the complement (== NOT include{A})")
    # and equals an explicit include of the complement level-set {B, C}.
    include_BC = _mask([{"column": "leiden", "keep": ["B", "C"]}], obs, n)
    assert np.array_equal(exclude_A, include_BC)
    # the transform rewrote the keep-set to the complement, leaving no exclude flag for the kernel.
    assert set(exclude_crit[0]["keep"]) == {"B", "C"}
    assert "mode" not in exclude_crit[0] and "exclude" not in exclude_crit[0]


def test_include_mode_is_a_passthrough():
    obs = {"cond": ["treated", "control", "treated"]}
    crit = [{"column": "cond", "keep": ["treated"], "mode": "include"}]
    out = compare._criteria_with_excludes(crit, obs)
    assert _mask(out, obs, 3).tolist() == [True, False, True]
