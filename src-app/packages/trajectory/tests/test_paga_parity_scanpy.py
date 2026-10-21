#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 [acceptance] [invariant: INV-1] — the emitted adjacency IS the library's own.

The oracle is **scanpy itself, called inside this test on the same data** — not a golden
number file. A golden file only ever proves we still agree with our past selves: it goes
green on a shared upstream misunderstanding, and it goes green on any drift we introduce and
then re-baseline. This tree already established the pattern
(`clustering/tests/test_neighbour_path_scanpy.py` uses scanpy's own `_handle_transformer`
rather than re-deriving the switch).

Parity is a meaningful bar here specifically because the numeric core of this statistic is
stable across a wide range of upstream releases, so a failure means WE changed.

Mutation: transpose the matrix before writing -> the sparsity/value comparison fails on any
asymmetric fixture and the symmetry assertion still holds, so the SEPARATE per-entry
comparison against the oracle is what catches it. Symmetrize `connectivities_tree` -> the
asymmetry assertion fails. Take the nodes in ORDER OF APPEARANCE instead of category order
-> fails here, because this fixture's category order ('A','B','trunk') deliberately differs
from its appearance order ('trunk','A','B'). Emit a dense zero-filled matrix -> the exact
non-zero INDEX SET comparison fails even though a value-closeness test would pass. Silently
pass the other statistic model -> every value changes and the parity comparison fails.

**What this fixture CANNOT catch, stated so nobody reads it as covered:** with three
single-character levels, natural and lexicographic order coincide, so it cannot distinguish
the natsort the compute imposes from the plain sort a default categorical would give. An
earlier version of this docstring claimed a `sorted()` mutation would fail here; it would
not. That property is covered instead by `test_partition_contract.py`, on a ten-numeric-level
fixture where the two orders genuinely differ.
"""
import numpy as np
import pytest

from trajectory_generators import branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


def _oracle(emb, labels, *, n_neighbors=15, metric="euclidean", seed=0, model="v1.2"):
    """scanpy's OWN answer for this input — the real decision, not a re-derivation."""
    import anndata as ad
    import pandas as pd
    import scanpy as sc

    a = ad.AnnData(X=np.zeros((emb.shape[0], 1), dtype=np.float32))
    a.obsm["X_e"] = np.asarray(emb, dtype=np.float32)
    a.obs["p"] = pd.Categorical([str(v) for v in labels])
    sc.pp.neighbors(a, n_neighbors=n_neighbors, use_rep="X_e", metric=metric,
                    random_state=seed)
    sc.tl.paga(a, groups="p", model=model)
    return a


@pytest.fixture(scope="module")
def fixture():
    counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), true_time, true_branch


def test_the_fixture_distinguishes_category_order_from_appearance_order(fixture):
    """The premise that gives the node-ordering assertion its teeth.

    If category order and appearance order agreed on this fixture, an implementation that
    sorted by appearance would pass every other assertion in this file. They do not agree:
    the trunk cells come FIRST in the data and 'trunk' sorts LAST.
    """
    _emb, _tt, branch = fixture
    appearance = list(dict.fromkeys([str(v) for v in branch]))
    categories = sorted(set(str(v) for v in branch))
    assert appearance == ["trunk", "A", "B"]
    assert categories == ["A", "B", "trunk"]
    assert appearance != categories


def test_emitted_adjacency_equals_scanpys_own_connectivities(paga_run, fixture):
    emb, _tt, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({"n_neighbors": 15, "metric": "euclidean"})

    ours = run.adjacency()
    oracle_adata = _oracle(emb, branch)
    theirs = np.asarray(oracle_adata.uns["paga"]["connectivities"].todense())

    assert ours.shape == theirs.shape
    # f32 round-trip tolerance, and NOT a millimetre more: the ONLY licensed difference is
    # the deliberate float64 CSR -> float32 CSC narrowing the declared kind asks for.
    assert np.allclose(ours, theirs, rtol=1e-5, atol=1e-7), (
        f"emitted adjacency diverged from scanpy's own\nours=\n{ours}\ntheirs=\n{theirs}")


def test_the_sparsity_pattern_is_identical_not_merely_close(paga_run, fixture):
    """An EXACT index-set comparison, because the value comparison above has a tolerance —
    and a dense zero-filled matrix is 'close' to a sparse one at every entry."""
    emb, _tt, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({"n_neighbors": 15})

    ours = run.adjacency()
    theirs = np.asarray(_oracle(emb, branch).uns["paga"]["connectivities"].todense())
    ours_nz = {(int(i), int(j)) for i, j in zip(*np.nonzero(ours))}
    theirs_nz = {(int(i), int(j)) for i, j in zip(*np.nonzero(theirs))}
    assert ours_nz == theirs_nz, (
        f"sparsity pattern differs: only-ours={ours_nz - theirs_nz}, "
        f"only-theirs={theirs_nz - ours_nz}")


def test_node_order_is_the_categorical_level_order_not_appearance_order(paga_run, fixture):
    emb, _tt, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({"n_neighbors": 15})

    oracle_adata = _oracle(emb, branch)
    expected = [str(c) for c in oracle_adata.obs["p"].cat.categories]
    assert run.node_labels() == expected == ["A", "B", "trunk"]
    # …and NOT the order the labels first appear in the data.
    assert run.node_labels() != list(dict.fromkeys([str(v) for v in branch]))


def test_the_matrix_is_symmetric_zero_diagonal_and_capped_in_unit_range(paga_run, fixture):
    emb, _tt, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({"n_neighbors": 15})

    a = run.adjacency()
    assert np.allclose(a, a.T), "the adjacency is not symmetric"
    assert np.allclose(np.diag(a), 0.0), "the adjacency has a non-zero diagonal"
    assert a.min() >= 0.0 and a.max() <= 1.0, (
        "a connectivity outside [0,1] — the statistic is an observed/expected ratio "
        "HARD-CAPPED at 1, which is exactly why it must not be read as a probability")


def test_the_tree_is_a_spanning_tree_with_its_asymmetry_preserved(paga_run, fixture):
    """`connectivities_tree` stores ONE direction per spanning-tree edge. Symmetrizing it
    'helpfully' destroys the only thing distinguishing it from the adjacency."""
    emb, _tt, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({"n_neighbors": 15})

    structure = run.graph_structure()
    n_nodes = len(structure["nodes"])
    tree = structure["tree_edges"]
    # This fixture's group graph IS connected, so the spanning tree has exactly n-1 edges.
    assert run.report()["group_graph_connected"] is True
    assert len(tree) == n_nodes - 1, f"expected {n_nodes - 1} tree edges, got {len(tree)}"

    directed = {(e["source_index"], e["target_index"]) for e in tree}
    reversed_ = {(b, a) for a, b in directed}
    assert not (directed & reversed_), (
        "the tree carries both directions of an edge — it was symmetrized, and the stored "
        "orientation is the only thing that made it a tree rather than a second adjacency")

    # and it agrees with scanpy's own tree, edge for edge.
    theirs = np.asarray(_oracle(emb, branch).uns["paga"]["connectivities_tree"].todense())
    theirs_edges = {(int(i), int(j)) for i, j in zip(*np.nonzero(theirs))}
    assert directed == theirs_edges


def test_the_declared_model_is_recorded_and_is_the_capped_statistic(paga_run, fixture):
    """The other model is a DIFFERENT statistic (no cap at 1), so which one ran is recorded
    rather than defaulted silently."""
    emb, _tt, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({"n_neighbors": 15})

    assert run.graph_structure()["paga"]["model"] == "v1.2"
    assert run.report()["model"] == "v1.2"

    # the negative control: the OTHER model genuinely gives different numbers, so recording
    # the choice is load-bearing rather than bookkeeping.
    other = np.asarray(
        _oracle(emb, branch, model="v1.0").uns["paga"]["connectivities"].todense())
    assert not np.allclose(run.adjacency(), other, rtol=1e-5, atol=1e-7), (
        "the two statistic models agree on this fixture, so this test cannot show that "
        "recording the model matters — pick a fixture where they differ")
