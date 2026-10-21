#!/usr/bin/env python3
# ruff: noqa
"""TEST-24 — the committed generator IS what it claims to be.

The validity suite's whole ground truth rests on this file, so it is checked rather than
trusted. A generator committed as CODE can be checked this way; a data blob could not — you
can assert against a blob but you cannot check WHY it is the truth, and a blob produced once
by a process nobody can re-read is indistinguishable from a blob produced by the bug under
test.

What "true by construction" means here, made explicit: `true_time` is assigned when each cell
is created, and the counts are generated FROM it. It is never inferred from the counts, so
it cannot be contaminated by the thing being measured.

This also pins the FIXTURE HEALTH the ground-truth test depends on — one connected
component, no unreachable cells — so that a failure over there means the pseudotime is wrong
rather than the fixture being degenerate. Without this, a broken fixture and a broken
analysis look identical.
"""
import numpy as np
import pytest

from trajectory_generators import (branching_walk, embed, two_blob_embedding,
                                   zero_inter_edge_partition)

pytest.importorskip("scanpy")


def test_the_generator_is_seeded_and_reproducible():
    a_counts, a_time, a_branch = branching_walk(n_per_branch=80, seed=3)
    b_counts, b_time, b_branch = branching_walk(n_per_branch=80, seed=3)
    assert np.array_equal(a_counts, b_counts)
    assert np.array_equal(a_time, b_time)
    assert list(a_branch) == list(b_branch)

    # …and a different seed is genuinely different data, not a relabelling.
    c_counts, _ct, _cb = branching_walk(n_per_branch=80, seed=4)
    assert not np.array_equal(a_counts, c_counts)


def test_true_time_is_assigned_by_construction_and_spans_the_unit_interval():
    _counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    assert true_time.min() == pytest.approx(0.0)
    assert true_time.max() == pytest.approx(1.0)
    assert true_time.size == 450


def test_the_topology_is_a_trunk_and_two_branches_that_share_it():
    _counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    labels, counts = np.unique(true_branch, return_counts=True)
    assert set(labels) == {"trunk", "A", "B"}
    assert set(counts.tolist()) == {150}

    trunk = true_time[true_branch == "trunk"]
    a = true_time[true_branch == "A"]
    b = true_time[true_branch == "B"]
    # the trunk comes strictly BEFORE the split…
    assert trunk.max() < 0.5
    # …and the two branches occupy the same interval after it, which is what makes this a
    # branching topology rather than two concatenated lineages.
    assert a.min() == pytest.approx(0.5) and b.min() == pytest.approx(0.5)
    assert a.max() == pytest.approx(1.0) and b.max() == pytest.approx(1.0)
    assert np.allclose(np.sort(a), np.sort(b))


def test_true_time_is_monotone_along_each_lineage():
    """The ordering claim itself: within a lineage, later cells have larger true_time, by
    construction rather than by measurement."""
    _counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    for lineage in ("trunk", "A", "B"):
        t = true_time[true_branch == lineage]
        assert np.all(np.diff(t) > 0), f"{lineage} is not monotone in true_time"


def test_the_two_branches_are_distinguishable_in_the_counts():
    """If they were not, the fixture would be a straight line wearing a branch label, and
    the branching half of the ground truth would be fictional."""
    counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    late = true_time > 0.85
    a_late = counts[late & (true_branch == "A")].mean(axis=0)
    b_late = counts[late & (true_branch == "B")].mean(axis=0)
    # the branch-specific gene blocks diverge; a shared trunk would leave them equal.
    assert np.abs(a_late - b_late).max() > 5.0


def test_the_gating_fixture_is_healthy_so_an_INV_2_failure_is_diagnostic():
    """One connected component, no unreachable cells. Without this, a failure over in the
    ground-truth test could equally mean the fixture was degenerate."""
    import anndata as ad
    import scanpy as sc
    from scipy.sparse.csgraph import connected_components

    counts, _tt, _tb = branching_walk(n_per_branch=150, seed=0)
    emb = embed(counts)
    a = ad.AnnData(X=np.zeros((emb.shape[0], 1), dtype=np.float32))
    a.obsm["X_e"] = emb
    sc.pp.neighbors(a, n_neighbors=15, use_rep="X_e", random_state=0)

    n_comp, _ = connected_components(a.obsp["distances"], directed=False)
    assert n_comp == 1, f"the gating fixture is disconnected ({n_comp} components)"


def test_the_disconnected_fixture_really_is_disconnected():
    """The INV-4 fixture's own premise."""
    import anndata as ad
    import scanpy as sc
    from scipy.sparse.csgraph import connected_components

    emb = two_blob_embedding(n_per=200, seed=0)
    a = ad.AnnData(X=np.zeros((emb.shape[0], 1), dtype=np.float32))
    a.obsm["X_e"] = emb
    sc.pp.neighbors(a, n_neighbors=10, use_rep="X_e", random_state=0)
    n_comp, sizes = connected_components(a.obsp["distances"], directed=False)
    assert n_comp == 2
    assert sorted(np.bincount(sizes).tolist()) == [200, 200]


def test_the_zero_inter_edge_fixture_really_shares_no_edges():
    """The INV-5 fixture's own premise, measured with the same predicate the compute uses."""
    import anndata as ad
    import pandas as pd
    import scanpy as sc

    emb, labels = zero_inter_edge_partition(n_per=100, seed=0, n_groups=2)
    a = ad.AnnData(X=np.zeros((emb.shape[0], 1), dtype=np.float32))
    a.obsm["X_e"] = emb
    a.obs["p"] = pd.Categorical([str(v) for v in labels])
    sc.pp.neighbors(a, n_neighbors=10, use_rep="X_e", random_state=0)

    coo = a.obsp["distances"].tocoo()
    codes = np.asarray(a.obs["p"].cat.codes)
    assert int((codes[coo.row] != codes[coo.col]).sum()) == 0


def test_the_generator_is_offline():
    """The gating path must run with no network access, so the whole suite is usable in an
    air-gapped sandbox. Only the independent cross-check downloads, and it skips loudly."""
    source = __import__("inspect").getsource(
        __import__("trajectory_generators"))
    for network in ("requests", "urllib", "http", "datasets."):
        assert network not in source, (
            f"the generator module references {network!r} — the gating fixtures must be "
            "offline")
