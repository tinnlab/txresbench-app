#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 [acceptance] [invariant: INV-9] [covers: ITEM-4] — the marker read is BANDED
gene-major (per-band bincount accumulation, never a whole-matrix dense read), with float64
mean accumulation."""
from pathlib import Path

import numpy as np

import markers as MK

def test_read_is_banded_gene_major_not_a_whole_matrix_dense_read(monkeypatch):
    # BEHAVIORAL (not a source-grep): score a fixture whose gene count EXCEEDS the band size, and
    # prove the read is per-gene banded — never a whole-matrix `(n_cells × n_genes)` densify. We
    # intercept every `np.zeros` allocation the scorer makes and assert (a) NONE is the dense
    # whole matrix and (b) exactly ONE 1-D per-cell column is allocated PER GENE (so a mutation
    # that reads the matrix densely, or in one shot, fails).
    import scipy.sparse as sp
    n_cells, n_genes = 7, 5
    rng = np.random.default_rng(0)
    dense = rng.poisson(1.0, size=(n_cells, n_genes)).astype(np.float32)
    csc = sp.csc_matrix(dense)
    monkeypatch.setattr(MK, "_BAND", 2)  # 5 genes over band=2 ⇒ 3 bands (>1) exercised
    assert n_genes > MK._BAND  # the fixture genuinely spans multiple bands

    lib = MK._library_sizes(csc.indptr, csc.indices, csc.data, n_cells, n_genes)

    shapes = []
    real_zeros = np.zeros
    def spy_zeros(shape, *a, **k):
        shapes.append(tuple(shape) if isinstance(shape, (tuple, list)) else (shape,))
        return real_zeros(shape, *a, **k)
    monkeypatch.setattr(MK.np, "zeros", spy_zeros)  # spy only over the SCORING pass

    codes = np.array([0, 0, 0, 1, 1, 1, 1], dtype=np.intp)
    out = MK._score_bands(csc.indptr, csc.indices, csc.data, n_cells, n_genes,
                          [f"g{j}" for j in range(n_genes)], codes, 2, lib, "wilcoxon")

    # (a) the WHOLE-MATRIX dense array is NEVER allocated — the dense-read mutation trips here.
    assert (n_cells, n_genes) not in shapes, f"a whole-matrix dense read was allocated: {shapes}"
    # (b) exactly one per-cell column `(n_cells,)` is allocated PER GENE — proof of per-gene banded
    #     reading rather than a single bulk densify (which would allocate zero per-gene columns).
    per_cell_cols = [s for s in shapes if s == (n_cells,)]
    assert len(per_cell_cols) == n_genes, (len(per_cell_cols), n_genes, shapes)
    # and the banded pass still produced a finite score for every (gene, group).
    assert all(np.isfinite(r["score"]) for g in (0, 1) for r in out[g])


def test_library_sizes_and_scores_accumulate_in_float64():
    # a small deterministic CSC: 4 cells × 3 genes.
    import scipy.sparse as sp
    dense = np.array([[2, 0, 1], [0, 3, 0], [1, 1, 0], [0, 0, 4]], dtype=np.float32)
    csc = sp.csc_matrix(dense)
    indptr, indices, data = csc.indptr, csc.indices, csc.data
    lib = MK._library_sizes(indptr, indices, data, 4, 3)
    assert lib.dtype == np.float64
    assert np.allclose(lib, dense.sum(axis=1))
    codes = np.array([0, 0, 1, 1], dtype=np.intp)
    out = MK._score_bands(indptr, indices, data, 4, 3, ["a", "b", "c"], codes, 2, lib, "wilcoxon")
    # every score / effect is a finite float64-derived value (no fabricated NaN padding).
    for g in (0, 1):
        assert len(out[g]) == 3
        assert all(np.isfinite(r["score"]) for r in out[g])
        assert all(isinstance(r["base_mean"], float) for r in out[g])
