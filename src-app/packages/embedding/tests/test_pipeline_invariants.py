#!/usr/bin/env python3
# ruff: noqa
"""Behavioural acceptance tests for the reduce PIPELINE invariants (INV-4/5/10/15).

Each drives the REAL `compute/reduce.py` as a subprocess and asserts on its OUTPUTS. The
INV-4/INV-5 tests reproduce the pipeline faithfully in-test (the exact steps reduce runs)
so they would FAIL if a scale/regress-out step were introduced, or if the sign convention
stopped being applied — behavioural, not a declaration read back to itself.
"""
import numpy as np
import pytest

import scanpy as sc
import anndata as ad
import scipy.sparse as spx

from embedding_fixtures import ReduceRun, counts_matrix, large_counts_matrix


def _reproduce(dense, *, n_hvg, n_pcs, seed, scale=False):
    """The reduce pipeline, reproduced. `scale=True` inserts the FORBIDDEN standardization
    so the test can prove reduce did NOT take it."""
    X = spx.csr_matrix(np.asarray(dense, dtype=np.float32))
    a = ad.AnnData(X=X.astype(np.float32))
    a.layers["counts"] = a.X.copy()
    sc.pp.normalize_total(a, target_sum=None)
    sc.pp.log1p(a)
    sc.pp.highly_variable_genes(a, flavor="seurat_v3",
                                n_top_genes=min(n_hvg, dense.shape[1]), layer="counts")
    a = a[:, np.asarray(a.var["highly_variable"].values, dtype=bool)].copy()
    if scale:
        sc.pp.scale(a)
    max_comps = max(1, min(dense.shape[0], a.shape[1]) - 1)
    npc = min(n_pcs, max_comps)
    sc.pp.pca(a, n_comps=npc, svd_solver="arpack", zero_center=True, dtype="float32",
              random_state=seed)
    x = np.asarray(a.obsm["X_pca"], dtype=np.float32)
    loadings = np.asarray(a.varm["PCs"], dtype=np.float64)
    for j in range(x.shape[1]):
        if np.sign(loadings[int(np.argmax(np.abs(loadings[:, j]))), j]) < 0:
            x[:, j] *= -1.0
    return x


# ── TEST-11 [acceptance] [invariant: INV-4] [covers: ITEM-19] ──────────────────────
def test_no_scale_or_regress_out_the_pca_input_is_not_standardized(reduce_run):
    dense = counts_matrix(60, 40, seed=1)
    run = reduce_run()
    run.add_matrix(dense)
    run.run_ok({"n_hvg": 20, "n_pcs": 10, "seed": 0})
    emb = run.embedding_array()

    unscaled = _reproduce(dense, n_hvg=20, n_pcs=10, seed=0, scale=False)
    scaled = _reproduce(dense, n_hvg=20, n_pcs=10, seed=0, scale=True)

    # reduce's embedding IS the unscaled (log1p-normalized, variance-NOT-standardized) PCA,
    # and it is NOT the scaled one — so no sc.pp.scale / regress_out ran.
    assert np.allclose(emb, unscaled, atol=1e-4), np.abs(emb - unscaled).max()
    assert not np.allclose(emb, scaled, atol=1e-2)
    # and the report records the choice (INV-13 companion).
    params = run.report()["parameters"]
    assert params["scaled"] is False and params["regressed_out"] is False


# ── TEST-12 [acceptance] [invariant: INV-5] [covers: ITEM-20] ──────────────────────
def test_pca_arpack_sign_convention_applied_stored_and_reproducible(reduce_run):
    dense = counts_matrix(60, 40, seed=2)
    a = reduce_run(); a.add_matrix(dense)
    a.run_ok({"n_hvg": 20, "n_pcs": 8, "seed": 0})
    b = reduce_run(); b.add_matrix(dense)
    b.run_ok({"n_hvg": 20, "n_pcs": 8, "seed": 0})

    rep = a.report()
    assert rep["parameters"]["pca_svd_solver"] == "arpack"
    assert rep["pca_sign_convention"] == "loadings_max_abs_positive"
    assert rep["parameters"]["pca_dtype"] == "float32"

    emb_a, emb_b = a.embedding_array(), b.embedding_array()
    # the convention makes signs deterministic: re-running yields IDENTICAL coordinates.
    assert np.array_equal(emb_a, emb_b)
    # and the convention actually holds: for the reproduced loadings each component's
    # largest-magnitude loading is non-negative.
    ref = _reproduce(dense, n_hvg=20, n_pcs=8, seed=0)
    assert np.allclose(emb_a, ref, atol=1e-4)


# ── TEST-14 [acceptance] [invariant: INV-10] [covers: ITEM-18] ─────────────────────
def test_hvg_gene_statistics_are_accumulated_in_float64(reduce_run):
    # (1) the PIPELINE records float64 gene statistics — on a real run the recorded
    # variances match the stable float64 reference exactly.
    dense = counts_matrix(60, 40, seed=3)
    run = reduce_run(); run.add_matrix(dense)
    run.run_ok({"n_hvg": 15, "n_pcs": 8, "seed": 0})
    got_var = np.asarray(run.report()["gene_stats"]["variance_first8"], dtype=np.float64)
    ref = np.var(dense.astype(np.float64), axis=0, ddof=1)[: got_var.size]
    assert np.allclose(got_var, ref, rtol=1e-9, atol=1e-9), (got_var, ref)
    assert run.report()["gene_stats"]["accumulator_dtype"] == "float64"

    # (2) the ACCUMULATOR is genuinely float64 — feed it a matrix where a float32
    # sum-of-squares CANCELS. reduce's own `_gene_stats_float64` matches the float64
    # reference; a naive float32 accumulation drifts far off it.
    reduce_mod = _import_reduce()
    import scipy.sparse as sp
    big = large_counts_matrix(50, 12, seed=4)
    _means, variances = reduce_mod._gene_stats_float64(sp.csc_matrix(big.astype(np.float32)))
    ref_big = np.var(big.astype(np.float64), axis=0, ddof=1)
    assert np.allclose(variances, ref_big, rtol=1e-6, atol=1e-3), (variances, ref_big)

    x32 = big.astype(np.float32)
    n = x32.shape[0]
    s = x32.sum(axis=0, dtype=np.float32)
    ss = np.square(x32).sum(axis=0, dtype=np.float32)
    var32 = (ss / n - (s / n) ** 2) * n / (n - 1)
    assert not np.allclose(var32.astype(np.float64), ref_big, rtol=1e-2)


# ── TEST-40 [acceptance] [invariant: INV-10] [covers: ITEM-18] ─────────────────────
# F1: the float64 accumulator must determine the genes SELECTED, not merely decorate the
# report. On a fixture where a float32 counts-layer accumulation ranks a DIFFERENT gene set
# than a float64 one, the shipped pipeline must select the FLOAT64 set. Mutation that this
# kills: revert reduce's `counts` layer to float32 → seurat_v3 ranks on float32 → the pipeline
# selects the float32 set → `got == s64` fails.
def _seurat_v3_selection(dense, n_top, counts_dtype):
    X = spx.csr_matrix(np.asarray(dense, dtype=np.float32))
    a = ad.AnnData(X=X.astype(np.float32))
    a.layers["counts"] = a.X.astype(counts_dtype)
    sc.pp.normalize_total(a, target_sum=None); sc.pp.log1p(a)
    sc.pp.highly_variable_genes(a, flavor="seurat_v3", n_top_genes=n_top, layer="counts")
    return set(np.nonzero(np.asarray(a.var["highly_variable"].values, dtype=bool))[0].tolist())


def _accumulator_sensitive_counts():
    """Integer counts where a block of high-count genes (~2e6, modest within-gene spread)
    makes a float32 Σx² lose the true variance signal to rounding while a float64 one keeps
    it — so the two accumulators rank a DIFFERENT top-N gene set. Non-singular for seurat_v3's
    loess (the block sits among ordinary low-count genes), unlike the near-constant
    `large_counts_matrix`. Deterministic (seed 0)."""
    rng = np.random.default_rng(0)
    dense = rng.integers(0, 12, size=(200, 60)).astype(np.float64)
    dense[:, 0] = rng.integers(1, 9, size=200)          # no all-zero cell
    for g in range(1, 21):
        dense[:, g] = 2_000_000 + rng.integers(0, 60, size=200)
    return dense


def test_hvg_SELECTION_uses_the_float64_accumulator_not_float32(reduce_run):
    dense = _accumulator_sensitive_counts()
    n_top = 25
    s32 = _seurat_v3_selection(dense, n_top, np.float32)
    s64 = _seurat_v3_selection(dense, n_top, np.float64)
    # the fixture is genuinely one where the accumulator dtype CHANGES the selection.
    assert s32 != s64, "fixture no longer discriminates float32 vs float64 selection"

    run = reduce_run(); run.add_matrix(dense)
    run.run_ok({"n_hvg": n_top, "n_pcs": 8, "seed": 0})
    got = set(run.report()["hvg_gene_indices"])

    # the SHIPPED pipeline selects the FLOAT64 gene set — not the float32 one.
    assert got == s64, (sorted(got - s64), sorted(s64 - got))
    assert got != s32
    # and the report's float64 attestation is now backed by the actual ranking path.
    assert run.report()["gene_stats"]["accumulator_dtype"] == "float64"


def _import_reduce():
    import importlib
    import sys
    from pathlib import Path
    compute = Path(__file__).resolve().parents[1] / "compute"
    if str(compute) not in sys.path:
        sys.path.insert(0, str(compute))
    return importlib.import_module("reduce")


# ── TEST-17 [acceptance] [invariant: INV-15] [covers: ITEM-18] ─────────────────────
def test_hvg_is_seurat_v3_on_raw_counts_with_batch_key_when_chosen(reduce_run):
    dense = counts_matrix(80, 40, seed=4)

    # no batch
    run = reduce_run(); run.add_matrix(dense)
    run.run_ok({"n_hvg": 15, "n_pcs": 8, "seed": 0})
    rep = run.report()
    assert rep["parameters"]["hvg_flavor"] == "seurat_v3"
    assert rep["parameters"]["hvg_on"] == "raw_counts"
    assert rep["batch"]["used_as_hvg_batch_key"] is False

    # the selected HVGs match seurat_v3 on the RAW counts (behavioural).
    a = ad.AnnData(X=spx.csr_matrix(dense.astype(np.float32)))
    a.layers["counts"] = a.X.copy()
    sc.pp.normalize_total(a, target_sum=None); sc.pp.log1p(a)
    sc.pp.highly_variable_genes(a, flavor="seurat_v3", n_top_genes=15, layer="counts")
    ref_hvg = set(np.nonzero(np.asarray(a.var["highly_variable"].values, dtype=bool))[0])
    got_hvg = set(run.report()["hvg_gene_indices"])
    assert got_hvg == ref_hvg

    # with a batch column bound, it IS the HVG batch_key.
    batch = ["A" if i % 2 == 0 else "B" for i in range(80)]
    run2 = reduce_run()
    run2.add_matrix(dense)
    run2.add_column(batch, slot="batch", axis="cells", name="sample")
    run2.run_ok({"n_hvg": 15, "n_pcs": 8, "seed": 0, "batch_column": "sample"})
    rep2 = run2.report()
    assert rep2["batch"]["used_as_hvg_batch_key"] is True
    assert rep2["batch"]["column"] == "sample"
