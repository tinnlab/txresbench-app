#!/usr/bin/env python3
# ruff: noqa
"""_nhoods — refined kNN NEIGHBOURHOOD construction over an embedding (#92).

The first of the two Milo pieces: turn an `embedding` into a set of OVERLAPPING neighbourhoods,
each anchored on an index cell, then count cells per `(neighbourhood × sample)`. This is what
makes `da.neighbourhoods` RESOLUTION-FREE — it never chooses a clustering resolution, so a shift
that straddles cluster boundaries is visible and no arbitrary partition is baked into the answer.

## No new KNN artifact, and none is needed

The tree has no neighbours/KNN artifact and this does not add one: the graph is rebuilt IN
PROCESS from the embedding, exactly as `clustering.cluster` and `embedding.visualize` already do
twice. Proposing a third idiom for something the tree already does would be gratuitous.

## The algorithm, pinned to the reference implementation

Mirrors `pertpy.tools.Milo.make_nhoods` (defaults `prop=0.1`, `seed=0`) step for step, because
`tests/test_parity.py`'s TIGHT tier matches neighbourhoods BY INDEX CELL against a golden fixture
generated from that very implementation — a divergence here would make the comparison meaningless
rather than merely different:

    n_ixs            = int(round(n_obs * prop))
    random.seed(seed); random_vertices = sorted(random.sample(range(n_obs), n_ixs))
    # REFINEMENT — for each sampled vertex, take the MEDIAN position of its kNN in the reduced
    # space and snap to the nearest ACTUAL cell among those neighbours. Refinement is what stops
    # the neighbourhoods from over-sampling wherever the random draw happened to land.
    nh_pos           = median(X[neighbours_of(i)], axis=0)
    refined[i]       = neighbours_of(i)[argmin(euclidean(X[neighbours_of(i)], nh_pos))]
    refined          = unique(refined)                       # collapses duplicates
    nhoods           = binarised_knn[:, refined]             # (cells × nhoods), OVERLAPPING
    kth_distance[i]  = max distance among index cell i's stored kNN distances

Note the standard-library `random` module, not a numpy Generator: that is what the reference uses,
and the draw is the thing being matched.

## Determinism is load-bearing and NOT obvious

`np.unique` on the refined vertices COLLAPSES duplicates, so `n_nhoods` is itself SEED-DEPENDENT —
two seeds on the same data legitimately give different numbers of neighbourhoods. `seed` is
therefore an explicit, recorded parameter (methods role `seed`), `n_nhoods` is RECORDED rather
than inferred, and `tests/test_determinism.py` pins same-seed ⇒ byte-identical outputs including
`n_nhoods`. Parity matching is by index cell, so `prop` and `seed` travel with the fixture.
"""
import random

import numpy as np


#: The distance metrics this package supports. CLOSED, and checked before scanpy sees the value:
#: an unknown metric otherwise surfaces as a raw
#: `sklearn.utils._param_validation.InvalidParameterError` traceback rather than as one of this
#: package's named refusals — the same gap round R1 closed for `fdr` and for exactly the same
#: reason, since an agent/MCP call that never rendered the run form reaches this code directly.
METRICS = ("euclidean", "cosine", "manhattan", "correlation")


def build_knn(X, *, n_neighbors=15, metric="euclidean", seed=0, fail=None):
    """`(connectivities, distances, effective_k)` as scanpy builds them over the embedding.

    scanpy is the same kNN builder `clustering.cluster` and `embedding.visualize` use, and it is
    what the reference implementation consumes, so the graph is shared rather than re-derived by
    a third route. The embedding is passed through `use_rep` — never a 2-D layout, which the
    caller has already refused BY NAME from the DECLARED structure before any read (INV-11).

    `effective_k` is the third return value because scanpy SILENTLY CLAMPS `n_neighbors` to the
    number of observations ("WARNING: n_obs too small: adjusting to `n_neighbors = 766`") and the
    caller records `k` in the artifact and the report. Round R2 measured the consequence: a run
    asking for `k: 5000` on 1531 cells exits 0 and records `k: 5000`, while every `kth_distance` —
    and therefore every spatial-FDR weight — is the 766th-neighbour distance. Returning what was
    ACTUALLY used is what lets the caller record the number the result was computed with.
    """
    import anndata as ad
    import scanpy as sc

    metric = str(metric)
    if metric not in METRICS:
        message = (f"unknown distance metric {metric!r}; the supported metrics are "
                   f"{list(METRICS)!r}. The metric determines the neighbourhood graph, so it is a "
                   "closed vocabulary rather than a value passed through to the graph builder.")
        if fail is not None:
            fail(message)
        raise ValueError(message)

    X = np.asarray(X, dtype=np.float32)
    requested = int(n_neighbors)
    # scanpy's own clamp, applied HERE so the value we record is the value we used.
    effective_k = max(2, min(requested, int(X.shape[0])))
    adata = ad.AnnData(X=X.copy())
    adata.obsm["X_da"] = X.copy()
    sc.pp.neighbors(adata, use_rep="X_da", n_neighbors=effective_k, metric=metric,
                    random_state=int(seed))
    return adata.obsp["connectivities"], adata.obsp["distances"], effective_k


def binarise(graph):
    """The kNN adjacency as a 0/1 CSR — the membership relation, with the connectivity weights
    discarded. `knn_graph[knn_graph != 0] = 1` in the reference; this is the same result without
    the sparse-efficiency churn."""
    import scipy.sparse as sp

    g = sp.csr_matrix(graph, copy=True)
    g.eliminate_zeros()
    g.data = np.ones_like(g.data, dtype=np.float64)
    return g


def make_nhoods(X, connectivities, distances, *, prop=0.1, seed=0, fail=None):
    """Sample and REFINE the neighbourhood index cells.

    Returns `(nhoods, index_cells, kth_distance)`:
      · `nhoods` — a `(n_cells × n_nhoods)` boolean CSR membership matrix. Columns OVERLAP; that
        overlap is precisely why the FDR must be connectivity-weighted (INV-DA-4).
      · `index_cells` — the refined index-cell row indices, ascending. `len()` is `n_nhoods`, and
        it is SEED-DEPENDENT because refinement collapses duplicates.
      · `kth_distance` — the distance to the furthest stored neighbour of each index cell; its
        reciprocal is the spatial-FDR weight.
    """
    from sklearn.metrics.pairwise import euclidean_distances

    X = np.asarray(X, dtype=np.float32)
    n_obs = X.shape[0]
    knn = binarise(connectivities)
    n_ixs = int(np.round(n_obs * float(prop)))
    if n_ixs < 1:
        if fail is not None:
            fail(
                f"refusing to build neighbourhoods: prop={prop} over {n_obs} cells samples "
                f"{n_ixs} index cells, so there is nothing to test. Raise `prop`, or use the "
                "cluster-level analysis, which needs no neighbourhood graph."
            )
        n_ixs = 1
    random.seed(int(seed))
    random_vertices = random.sample(range(n_obs), k=n_ixs)
    random_vertices.sort()

    ixs_nn = knn[random_vertices, :]
    non_zero_rows = ixs_nn.nonzero()[0]
    non_zero_cols = ixs_nn.nonzero()[1]
    refined = np.empty(len(random_vertices), dtype=np.int64)
    for i in range(len(random_vertices)):
        nn_ixs = non_zero_cols[non_zero_rows == i]
        if nn_ixs.size == 0:
            # An isolated vertex has no neighbourhood to refine toward; it stays its own index.
            refined[i] = random_vertices[i]
            continue
        nh_pos = np.median(X[nn_ixs, :], 0).reshape(-1, 1)
        dists = euclidean_distances(X[nn_ixs, :], nh_pos.T)
        refined[i] = nn_ixs[dists.argmin()]
    index_cells = np.unique(refined)
    index_cells.sort()

    nhoods = knn[:, index_cells]
    dist_mat = distances[np.asarray(index_cells), :]
    kth_distance = np.asarray(dist_mat.max(1).todense()).ravel().astype(np.float64)
    return nhoods, index_cells, kth_distance


def count_nhoods(nhoods, sample_labels, sample_levels):
    """The integer `(n_samples × n_nhoods)` count matrix — cells of each sample in each
    neighbourhood. Two lines of sparse algebra in the reference; the same two here.

    Rows are SAMPLES because the sample is the unit of replication (INV-DA-2): the column space
    of the model is samples, never cells."""
    import scipy.sparse as sp

    labels = [str(s) for s in sample_labels]
    levels = [str(s) for s in sample_levels]
    index = {lv: i for i, lv in enumerate(levels)}
    rows = np.arange(len(labels))
    cols = np.array([index[s] for s in labels], dtype=np.int64)
    dummies = sp.csr_matrix((np.ones(len(labels)), (rows, cols)),
                            shape=(len(labels), len(levels)))
    counts = sp.csr_matrix(nhoods).T.dot(dummies)  # (nhood × sample)
    return np.asarray(counts.todense()).astype(np.int64).T  # (sample × nhood)


def annotate_nhoods(nhoods, annotation_labels):
    """The MAJORITY annotation label of each neighbourhood plus its purity fraction.

    READABILITY ONLY. This never enters the model, and that constraint is load-bearing: a majority
    label makes a discovered region talkable-about ("mostly CD8 T, 82% pure"), but the moment it
    entered the design it would reintroduce exactly the cluster-boundary arbitrariness the
    neighbourhood method exists to avoid. `tests/test_neighbourhoods_end_to_end.py` asserts that
    binding an annotation changes no statistic."""
    import scipy.sparse as sp

    labels = np.asarray([str(a) for a in annotation_labels])
    levels = sorted(set(labels.tolist()))
    index = {lv: i for i, lv in enumerate(levels)}
    codes = np.array([index[s] for s in labels], dtype=np.int64)
    membership = sp.csr_matrix(nhoods).T.tocsr()  # (nhood × cell)
    out_label, out_purity = [], []
    for i in range(membership.shape[0]):
        cells = membership.indices[membership.indptr[i]:membership.indptr[i + 1]]
        if cells.size == 0:
            out_label.append("")
            out_purity.append(0.0)
            continue
        counts = np.bincount(codes[cells], minlength=len(levels))
        top = int(np.argmax(counts))
        out_label.append(levels[top])
        out_purity.append(float(counts[top]) / float(cells.size))
    return out_label, out_purity
