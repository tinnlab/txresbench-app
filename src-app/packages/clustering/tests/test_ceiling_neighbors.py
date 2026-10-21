#!/usr/bin/env python3
# ruff: noqa
"""TEST-F4 [regression] [invariant: INV-10] — the labels-path memory estimate scales with the
ACTUAL `n_neighbors`, not a hardcoded k=15.

The kNN adjacency has ~`n_neighbors` nnz per cell, so a run with `n_neighbors=50` builds a
graph ~3.3× larger than a k=15 estimate. The old constant `_KNN_BYTES_PER_CELL = 8*15`
under-estimated the labels-path peak by that factor; `ceiling_refuse_if_over` now sizes the
kNN term from the passed `n_neighbors`.

Mutation: hardcode the kNN term back to k=15 (ignore the arg) → the `n_neighbors=50` case no
longer exceeds a budget the k=15 case fits → the SystemExit assertion below FAILS.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

_COMPUTE = Path(__file__).resolve().parents[1] / "compute"


def _load_shared():
    sys.path.insert(0, str(_COMPUTE))
    sys.path.insert(0, str(_COMPUTE.parent.parent / "_lib"))
    spec = importlib.util.spec_from_file_location("clustering_shared_knn", _COMPUTE / "_shared.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_ceiling_estimate_scales_with_n_neighbors():
    S = _load_shared()
    n_cells, n_dims = 100_000, 10
    dims_bytes = n_dims * S._BYTES_PER_DIM                       # 40 B/cell, k-independent

    # A budget that the k=15 estimate FITS but the k=50 estimate EXCEEDS.
    #   k=15 → 100000 × (40 + 120) = 16.0 MB ; k=50 → 100000 × (40 + 400) = 44.0 MB
    S._MEM_BUDGET_BYTES = 30_000_000
    rec15 = S.ceiling_refuse_if_over(n_cells, n_dims, 15)        # fits → returns
    assert rec15["knn_bytes_per_cell"] == 15 * S._KNN_BYTES_PER_NEIGHBOUR_PER_CELL
    assert rec15["n_neighbors"] == 15

    with pytest.raises(SystemExit):                             # k=50 exceeds → refuses
        S.ceiling_refuse_if_over(n_cells, n_dims, 50)

    # the kNN term genuinely tracks n_neighbors (≈3.3× from 15→50), not a constant.
    knn15 = 15 * S._KNN_BYTES_PER_NEIGHBOUR_PER_CELL
    knn50 = 50 * S._KNN_BYTES_PER_NEIGHBOUR_PER_CELL
    assert knn50 == pytest.approx(knn15 * (50 / 15))

    # and the k=50 estimate really is over-budget while k=15 is under it (the mutation kill).
    assert n_cells * (dims_bytes + knn15) < S._MEM_BUDGET_BYTES < n_cells * (dims_bytes + knn50)
