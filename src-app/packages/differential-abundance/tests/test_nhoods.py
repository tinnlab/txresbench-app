#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 [covers: ITEM-7] — refined neighbourhood construction.

Determinism here is load-bearing AND non-obvious. The index cells are drawn with a seeded RNG and
then REFINED (each is moved to the cell nearest its neighbourhood's median position), and the
refinement is followed by a `unique` that COLLAPSES duplicates — so `n_nhoods` is itself
seed-dependent. Two seeds on the same data legitimately give different NUMBERS of neighbourhoods.
That is why `n_nhoods` is recorded rather than inferred, and why parity matching is by index cell
at a fixed `prop` and `seed`.
"""
import numpy as np
import pytest

import _nhoods as NH


def _embedding(n=500, dims=8, seed=5):
    rng = np.random.default_rng(seed)
    X = rng.normal(size=(n, dims)).astype(np.float32)
    X[:150, 0] += 5.0          # a real blob, so the graph has structure to refine toward
    return X


def _build(X, k=15, seed=0):
    c, d, _k = NH.build_knn(X, n_neighbors=k, seed=seed)
    return c, d


def test_the_same_seed_gives_byte_identical_neighbourhoods():
    X = _embedding()
    conn, dist = _build(X)
    a = NH.make_nhoods(X, conn, dist, prop=0.1, seed=0)
    b = NH.make_nhoods(X, conn, dist, prop=0.1, seed=0)
    assert np.array_equal(a[1], b[1]), "index cells differ between two identically-seeded calls"
    assert np.array_equal(a[2], b[2]), "kth distances differ"
    assert (a[0] != b[0]).nnz == 0, "membership differs"


def test_a_different_seed_can_change_the_NUMBER_of_neighbourhoods():
    """The non-obvious part. `np.unique` after refinement collapses duplicates, so `n_nhoods` is a
    RESULT, not a parameter — which is why the report records it and nothing infers it."""
    X = _embedding()
    conn, dist = _build(X)
    counts = {len(NH.make_nhoods(X, conn, dist, prop=0.1, seed=s)[1]) for s in range(6)}
    assert len(counts) > 1, (
        "every seed produced the same neighbourhood count; either the refinement dedup is not "
        "running or the fixture is degenerate, and in both cases the determinism story is not "
        "being exercised")


def test_neighbourhoods_overlap_which_is_why_the_fdr_must_be_weighted():
    X = _embedding()
    conn, dist = _build(X)
    nhoods, index_cells, _ = NH.make_nhoods(X, conn, dist, prop=0.1, seed=0)
    per_cell = np.asarray(nhoods.sum(axis=1)).ravel()
    assert per_cell.max() > 1, (
        "no cell belongs to more than one neighbourhood — the neighbourhoods are not overlapping, "
        "which would make the whole spatial-FDR correction pointless")


def test_counts_are_integers_and_conserve_each_samples_cells_within_the_union():
    X = _embedding(n=400)
    conn, dist = _build(X)
    nhoods, index_cells, _ = NH.make_nhoods(X, conn, dist, prop=0.15, seed=0)
    samples = [f"s{i % 4}" for i in range(X.shape[0])]
    levels = sorted(set(samples))
    counts = NH.count_nhoods(nhoods, samples, levels)

    assert counts.dtype.kind == "i", "cell counts must be integers"
    assert counts.shape == (len(levels), len(index_cells))
    assert (counts >= 0).all()

    # Each sample's row sum equals the number of (cell, neighbourhood) memberships that sample
    # contributes — i.e. the counts really are the membership matrix contracted over cells.
    membership = np.asarray(nhoods.todense())
    for i, lv in enumerate(levels):
        rows = np.array([s == lv for s in samples])
        assert counts[i].sum() == int(membership[rows].sum())


def test_kth_distance_is_positive_and_one_per_neighbourhood():
    X = _embedding()
    conn, dist = _build(X)
    nhoods, index_cells, kth = NH.make_nhoods(X, conn, dist, prop=0.1, seed=0)
    assert kth.shape == (len(index_cells),)
    assert np.all(kth > 0), "a zero kth distance would give an infinite spatial-FDR weight"
    assert nhoods.shape == (X.shape[0], len(index_cells))


def test_index_cells_are_unique_and_ascending():
    X = _embedding()
    conn, dist = _build(X)
    _, index_cells, _ = NH.make_nhoods(X, conn, dist, prop=0.1, seed=0)
    assert len(set(index_cells.tolist())) == len(index_cells)
    assert np.all(np.diff(index_cells) > 0)


def test_annotate_nhoods_returns_a_majority_label_and_a_purity_fraction():
    X = _embedding()
    conn, dist = _build(X)
    nhoods, index_cells, _ = NH.make_nhoods(X, conn, dist, prop=0.1, seed=0)
    labels = ["blob" if i < 150 else "rest" for i in range(X.shape[0])]
    ann, purity = NH.annotate_nhoods(nhoods, labels)
    assert len(ann) == len(index_cells) == len(purity)
    assert set(ann) <= {"blob", "rest", ""}
    assert all(0.0 <= p <= 1.0 for p in purity)
    # a well-separated blob should give some very pure neighbourhoods
    assert max(purity) > 0.9


def test_a_prop_that_samples_no_index_cell_refuses_by_name():
    X = _embedding(n=20)
    conn, dist = _build(X, k=5)
    calls = []
    NH.make_nhoods(X, conn, dist, prop=0.001, seed=0, fail=lambda m, code=2: calls.append(m))
    assert calls and "prop" in calls[0] and "cluster-level" in calls[0]
