#!/usr/bin/env python3
# ruff: noqa
"""TEST-5 [acceptance] [invariant: INV-5] — the zero-inter-edge crash is a NAMED REFUSAL.

When no two groups share a neighbour edge, the abstracted-graph tool CRASHES:

    ValueError: mismatching number of index arrays for shape; got 0, expected 2
      igraph/adjacency.py in _get_adjacency_sparse

The mechanism, read off the library's source rather than guessed from the message: its core
binarises the neighbour distances into a directed graph and contracts it by the group codes
with `cluster_graph()`, which DROPS self-loops. So a partition whose groups share no edges
contracts to an EDGELESS graph, and building a sparse adjacency from zero edges raises.

This is not an exotic input — it is what multi-sample, un-integrated data with a
disconnected neighbour graph does, and it fires for a single-group partition too.

This file carries a POSITIVE CONTROL: it drives the library directly on the same fixture and
asserts the real crash still happens. Without that, the refusal test would keep passing if
upstream ever fixed the crash, and would be standing in front of nothing.

Mutation: remove the pre-check -> the run dies with the igraph traceback instead of our
refusal, and the "no traceback" assertion fails. Check only `n_groups < 2` -> the two-group
far-apart fixture crashes. Match on the exception MESSAGE instead of the edge count -> the
run still reaches the crash, and the message assertion is upstream-fragile.
"""
import numpy as np
import pytest

from trajectory_generators import cells_digest, zero_inter_edge_partition

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


@pytest.fixture(scope="module")
def zero_edge():
    return zero_inter_edge_partition(n_per=100, n_dims=8, seed=0, n_groups=2)


def test_the_library_really_does_crash_on_this_fixture(zero_edge):
    """The POSITIVE CONTROL. The refusal is only worth having while this is true."""
    import anndata as ad
    import pandas as pd
    import scanpy as sc

    emb, labels = zero_edge
    a = ad.AnnData(X=np.zeros((emb.shape[0], 1), dtype=np.float32))
    a.obsm["X_e"] = emb
    a.obs["p"] = pd.Categorical([str(v) for v in labels])
    sc.pp.neighbors(a, n_neighbors=10, use_rep="X_e", random_state=0)

    with pytest.raises(ValueError) as exc:
        sc.tl.paga(a, groups="p", model="v1.2")
    assert "mismatching number of index arrays" in str(exc.value)


def test_the_run_refuses_by_name_at_a_reachable_lever(paga_run, zero_edge):
    emb, labels = zero_edge
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(labels, name="group")
    proc = run.run_fails({"n_neighbors": 10})

    diagnostics = run.diagnostics(proc)
    assert "ZERO neighbour edges" in diagnostics
    # every lever named is one the user can actually pull.
    assert "raise `n_neighbors`" in diagnostics
    assert "integrate the samples" in diagnostics
    assert "coarser partition" in diagnostics
    # and NOT a sandbox stack trace.
    assert "Traceback" not in proc.stderr, (
        "the library's traceback reached the user — the pre-check did not run before the "
        "call")
    assert "mismatching number of index arrays" not in proc.stderr
    assert not (run.outputs_dir / "manifest.json").exists()


def test_a_single_group_partition_is_refused_the_same_way(paga_run):
    """The same predicate covers it, because a lone group also contracts to an edgeless
    graph — verified against the real crash, not assumed by symmetry."""
    emb, _labels = zero_inter_edge_partition(n_per=120, n_dims=8, seed=1, n_groups=1)
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(["only"] * emb.shape[0], name="group")
    proc = run.run_fails({"n_neighbors": 10})

    diagnostics = run.diagnostics(proc)
    assert "ZERO neighbour edges" in diagnostics
    assert "single-group partition" in diagnostics
    assert "Traceback" not in proc.stderr


def test_genuine_zeros_are_NOT_refused_when_some_pair_is_joined(paga_run):
    """The other side of the predicate, and the reason it is an edge COUNT rather than a
    connectivity check: two joined groups plus one isolated group does NOT crash, and the
    right answer there is a graph with real zero entries, not a refusal.

    Refusing this case would be a false positive that blocks a legitimate analysis.
    """
    import numpy as np

    rng = np.random.default_rng(0)
    emb = np.vstack([
        rng.normal(0.0, 1.0, (80, 8)),
        rng.normal(1.5, 1.0, (80, 8)),
        rng.normal(500.0, 0.5, (80, 8)),
    ]).astype(np.float32)
    labels = np.repeat(["A", "B", "far"], 80)

    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(labels, name="group")
    run.run_ok({"n_neighbors": 10})

    a = run.adjacency()
    assert a.shape == (3, 3)
    labels_out = run.node_labels()
    far = labels_out.index("far")
    # the isolated group is genuinely zero against both others — recorded, not refused.
    assert a[far].sum() == pytest.approx(0.0)
    assert a[labels_out.index("A"), labels_out.index("B")] > 0.0

    # …and the report states the group graph is disconnected rather than pretending the
    # spanning tree is complete.
    report = run.report()
    assert report["group_graph_connected"] is False
    assert len(report["tree_edges"]) < len(labels_out) - 1
