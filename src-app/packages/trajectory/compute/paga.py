#!/usr/bin/env python3
# ruff: noqa
"""trajectory.paga — an embedding + a partition → the abstracted graph (ITEM-4/5).

Reads ONE `embedding` (a PCA / latent representation) and ONE CATEGORICAL
`metadata-column` (the partition whose levels become the graph's nodes), rebuilds the kNN
graph from the embedding, and produces a `graph/attributed` artifact — the first in-tree
producer of that already-declared open kind — plus a `report/qc`.

## The fixed pipeline

    resolve inputs -> CEILING GATE (before any read) -> read the embedding + the partition
    -> viable-cell refuse -> sc.pp.neighbors (kNN on the embedding)
    -> ZERO-INTER-EDGE PRE-CHECK  -> sc.tl.paga(model="v1.2")
    -> write graph/attributed (CSC) + the tree edge list + node attrs -> report

Every stage is a named refusal on failure, never a silent wrong answer.

## Three scanpy contract facts this file is written against

They are all cases where following the DOCUMENTATION would produce a wrong artifact:

  1. `uns['paga']['connectivities']` is a **`scipy.sparse.csr_matrix`, float64**. The scanpy
     docstring documents `numpy.ndarray`. We convert to CSC/float32 DELIBERATELY (the
     declared kind's `adjacency` array is `chunked_sparse/csc` with an `f32` weight attr),
     and the parity test's tolerance is sized for exactly that one round-trip.
  2. Node order is `adata.obs[groups].cat.categories` — natsorted, NOT order of appearance.
     Getting this wrong ships a correctly-computed matrix with wrong labels, which is the
     failure most likely to survive review, so the ordered labels are written out EXPLICITLY
     beside the matrix instead of being left implicit in an index.
  3. `sc.tl.paga` writes NO node positions (`sc.pl.paga` computes those). There is therefore
     nothing to lay out here, and the graph ships as a table rather than a picture.

Plus one undocumented side effect we USE: `sc.tl.paga` writes `adata.uns[f"{groups}_sizes"]`,
an ndarray of per-group cell counts — free per-node `n_cells`.

## The crash this refuses in front of

`sc.tl.paga` CRASHES when no two groups share an edge: its v1.2 core contracts the binarised
neighbour graph with `VertexClustering.cluster_graph()`, which DROPS self-loops, so a
partition with no inter-group edges contracts to an EDGELESS graph and
`get_adjacency_sparse` raises `ValueError: mismatching number of index arrays for shape; got
0, expected 2` from inside igraph. That is not exotic — it is what multi-sample,
un-integrated data with a disconnected neighbour graph does, and it also fires for a
single-group partition. We detect the exact condition BEFORE the call and refuse by name.

Roots overridable via `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`. Progress → `$CYTO_PROGRESS_FIFO`.
"""
import _shared as S  # FIRST — pins the determinism env before numpy/scanpy load

import json

import numpy as np

import cyto_columns
import cyto_csc


# The PAGA statistic identity. `model="v1.0"` is a DIFFERENT statistic (an undirected fuzzy
# graph, with no cap at 1), so the choice is passed explicitly and recorded — the same
# discipline the sibling packages use for their own version-unstable library defaults.
PAGA_MODEL = "v1.2"

# ── INPUT SLOTS (resolved out of `/inputs/inputs.json`, never a filename suffix) ────────
# Declared as module-level constants so the VIEW<->COMPUTE seam reader can confirm the view
# names only slots this compute resolves.
EMBEDDING_SLOT = "embedding"
PARTITION_SLOT = "partition"


def _resolve_int(params, key, default, *, lo=1):
    try:
        v = int(params.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def inter_group_edge_total(distances, codes):
    """Total INTER-group edges of the binarised neighbour graph — the exact quantity whose
    being zero makes `sc.tl.paga` raise.

    scanpy's v1.2 core binarises `neighbors.distances` into a directed igraph and contracts
    it by the group codes with `VertexClustering.cluster_graph()`, which drops self-loops. So
    the contracted graph has an edge only where two DIFFERENT groups are joined, and it is
    edgeless — the crashing case — exactly when this total is 0.

    Derived by reading scanpy's source, not by matching its error message: a message match
    would still have let the run reach the crash, and would break on a reworded upstream
    string. Validated against the real crash on five fixtures (two/four far-apart blobs, a
    single group, overlapping groups, and two joined groups plus one isolated) with a 5/5
    agreement between this predicate and whether scanpy actually raised.
    """
    coo = distances.tocoo()
    return int((codes[coo.row] != codes[coo.col]).sum())


def _tree_edges(tree, labels):
    """`connectivities_tree` as an explicit edge list, ASYMMETRY PRESERVED.

    The tree stores ONE direction per spanning-tree edge (it is a minimum spanning tree over
    the reciprocal connectivities, values back-substituted). Symmetrizing it "helpfully"
    would destroy the only thing that distinguishes it from the adjacency, so the emitted
    list is the stored orientation verbatim.
    """
    coo = tree.tocoo()
    # `v != 0` filters STORED ZEROS. A sparse matrix may carry explicit zeros, and one here
    # would be emitted as a tree edge of weight 0 AND would inflate the edge count that the
    # report's `group_graph_connected` compares against `n_nodes - 1` — flipping a genuinely
    # disconnected group graph to "connected". A reported topological property must not
    # depend on an upstream storage detail.
    return [
        {"source": labels[int(i)], "target": labels[int(j)],
         "source_index": int(i), "target_index": int(j), "connectivity": float(v)}
        for i, j, v in zip(coo.row, coo.col, coo.data) if v != 0
    ]


def main():
    S.set_prefix("trajectory.paga")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)
    progress = S.progress

    seed = S.resolve_seed(p.get("seed", 0))
    n_neighbors = _resolve_int(p, "n_neighbors", 15)
    metric = S.resolve_metric(p.get("metric"))
    name = S.resolve_output_name(p.get("name"), default="trajectory-graph")

    # ── resolve the ONE embedding + the ONE partition ────────────────────────────────
    progress("resolve", 2, "resolving inputs")
    emb_entries = S.slot_entries(slots, EMBEDDING_SLOT)
    if not emb_entries:
        S.fail("no `embedding` input bound — trajectory.paga needs one `embedding` artifact "
               "(a PCA / latent representation) to rebuild the neighbour graph from")
    if len(emb_entries) > 1:
        S.fail(
            f"{len(emb_entries)} embeddings bound to `embedding`, but an abstracted graph is "
            "built over ONE representation; bind exactly one."
        )
    emb_entry = emb_entries[0]

    part_entries = S.slot_entries(slots, PARTITION_SLOT)
    if not part_entries:
        S.fail(
            "no `partition` input bound — the abstracted graph's NODES ARE the levels of a "
            "categorical column, so trajectory.paga needs one (a cluster label, or another "
            "factor over the same cells). It does not invent a partition of its own."
        )
    if len(part_entries) > 1:
        S.fail(f"{len(part_entries)} columns bound to `partition`; bind exactly one factor.")
    part_entry = part_entries[0]

    # ── CEILING GATE — before a byte of the embedding is read ────────────────────────
    progress("preflight", 5, "checking the resource envelope")
    structure, member, n_cells, n_dims = S.read_embedding_structure(
        emb_entry["path"], EMBEDDING_SLOT)
    ceiling = S.ceiling_refuse_if_over(n_cells, n_dims, n_neighbors, n_comps=0)

    if n_cells < S.VIABLE_CELL_THRESHOLD:
        S.fail(
            f"only {n_cells} cell(s) to build a graph over, below the viable floor of "
            f"{S.VIABLE_CELL_THRESHOLD}. Refusing rather than abstracting a graph from too "
            "few; no cell is ever synthesized to reach the floor."
        )

    # ── read the embedding + the partition ───────────────────────────────────────────
    progress("read", 14, "reading the embedding and the partition")
    coords = S.read_embedding_matrix(emb_entry["path"], member)
    if coords.shape[0] != n_cells:
        S.fail(f"the embedding declares {n_cells} cells but holds {coords.shape[0]} rows")

    S.refuse_misaligned(S.declared_row_space(emb_entry["path"]),
                        S.declared_row_space(part_entry["path"]),
                        slot=PARTITION_SLOT, what="partition column")
    labels, declared_levels = S.read_categorical_column(part_entry["path"], PARTITION_SLOT)
    if len(labels) != n_cells:
        S.fail(
            f"the partition column holds {len(labels)} values but the embedding declares "
            f"{n_cells} cells — they must be aligned over the same cells axis for the levels "
            "to be a partition OF these cells."
        )

    neighbour_path = S.neighbour_path(n_cells, metric)

    # ── build the AnnData carrying ONLY the embedding + the partition ────────────────
    import anndata as ad
    import pandas as pd
    import scanpy as sc

    adata = ad.AnnData(X=np.zeros((n_cells, 1), dtype=np.float32))
    adata.obsm["X_embedding"] = coords
    # ── NODE ORDER — NATSORTED, and enforced here rather than inherited ────────────────
    #
    # Node order is the single easiest way to ship a correctly-computed matrix with WRONG
    # LABELS, so it is pinned rather than taken on trust. Three different orders are
    # reachable, measured on the installed library:
    #
    #   * a PLAIN string column      -> scanpy's own sanitize step NATSORTS it
    #                                   ('1','2',…,'10','11','12')
    #   * a default pandas category  -> LEXICOGRAPHIC ('1','10','11','12','2',…)
    #   * an EXPLICIT category list  -> preserved VERBATIM, in whatever order it arrived
    #
    # Passing the upstream producer's declared list straight through takes the third branch,
    # which means the order is whatever that producer happened to declare — and an imported
    # annotation column routinely carries a biological rather than a sorted order. The
    # artifact would then declare "natsorted" while holding something else. So the order is
    # natsorted HERE, with the same function the library itself uses, which makes the
    # declaration true by construction rather than by assumption.
    #
    # A declared level with NO cells is dropped rather than carried through as an empty node.
    # It is not a node of anything: it would contribute a zero row and column, its `n_cells`
    # would be 0, and the underlying statistic's expected-value denominator for any pair
    # involving it is 0 — the branch that substitutes a connectivity of 1. An empty group is
    # exactly the input that could turn into a spurious maximal edge, so it is excluded here
    # and the exclusion is RECORDED in the report rather than done silently.
    from natsort import natsorted  # a hard dependency of the analysis library, not a new one

    label_set = set(labels)
    present = natsorted(lv for lv in (declared_levels or label_set) if lv in label_set)
    dropped_levels = [lv for lv in declared_levels if lv not in label_set]
    if len(present) > S.MAX_PARTITION_LEVELS:
        S.fail(
            f"the partition has {len(present):,} levels, over the ceiling of "
            f"{S.MAX_PARTITION_LEVELS:,}. The abstracted graph is DENSE in the node count — "
            "the adjacency is materialised as an n x n matrix and the per-node and per-edge "
            "tables ride the artifact's manifest entry, which the ingest path caps and "
            "REFUSES past, after this compute would already have exited successfully. A "
            "partition this fine is not an abstraction of anything either: bind a coarser "
            "one (a lower clustering resolution)."
        )
    undeclared = sorted(label_set - set(present))
    if undeclared:
        S.fail(
            f"the partition column holds {len(undeclared)} label(s) its own declaration does "
            f"not list: {', '.join(undeclared[:10])}"
            + (" …" if len(undeclared) > 10 else "")
            + ". Those cells belong to no declared group, so they cannot be nodes and cannot "
            "be left out either — the underlying library would receive them as an invalid "
            "group index and die inside its own graph constructor. Re-emit the column with a "
            "level set that covers every value it holds."
        )
    adata.obs["_partition"] = pd.Categorical(labels, categories=present)

    progress("neighbors", 40, f"kNN graph (k={n_neighbors}, {neighbour_path})")
    sc.pp.neighbors(adata, n_neighbors=n_neighbors, use_rep="X_embedding",
                    metric=metric, random_state=seed)
    # The library CLAMPS k on a small dataset and only warns, so what was asked for is not
    # always what was built. Record what ran; record the request separately when they differ.
    n_neighbors, n_neighbors_requested = S.honoured_n_neighbors(adata, n_neighbors)
    neighbour_path = S.neighbour_path(n_cells, metric)

    # ── the zero-inter-edge PRE-CHECK — before scanpy is given the chance to crash ────
    progress("preflight-graph", 55, "checking the partition is joinable")
    codes = np.asarray(adata.obs["_partition"].cat.codes)
    n_inter = inter_group_edge_total(adata.obsp["distances"], codes)
    n_groups = len(present)
    if n_inter == 0:
        S.fail(
            f"the {n_groups} group(s) of this partition share ZERO neighbour edges, so there "
            "is no abstracted graph to compute: every node would be isolated and the "
            "statistic is undefined. This is what an un-integrated multi-sample dataset with "
            "a disconnected neighbour graph looks like"
            + (", and it is also what a single-group partition looks like"
               if n_groups < 2 else "")
            + ". The levers that reach it: raise `n_neighbors` so the graph connects, "
            "integrate the samples first so they share neighbours, subset to one connected "
            "component, or bind a coarser partition. Refused here rather than passed to "
            "scanpy, which raises an igraph index error from inside its own contraction step."
        )

    # ── the abstracted graph — `model` passed EXPLICITLY ─────────────────────────────
    progress("paga", 68, f"abstracted graph over {n_groups} node(s), model={PAGA_MODEL}")
    sc.tl.paga(adata, groups="_partition", model=PAGA_MODEL)

    # Node order IS `cat.categories` (natsorted), NOT order of appearance.
    node_labels = [str(c) for c in adata.obs["_partition"].cat.categories]
    conn = adata.uns["paga"]["connectivities"]          # CSR, float64 (docstring says ndarray)
    tree = adata.uns["paga"]["connectivities_tree"]     # CSR, ASYMMETRIC
    # Read from an UNDOCUMENTED side effect of the library call, so its absence is checked
    # rather than defaulted: a silent fallback would ship every node's cell count as 0 or
    # null and exit 0, which is a plausible-looking wrong artifact from a contract the
    # docstring already flags as undocumented.
    if "_partition_sizes" not in adata.uns:
        S.fail(
            "the library did not record per-group cell counts where this analysis reads them "
            "(an undocumented side effect of the call it depends on). Rather than shipping a "
            "graph whose every node claims zero cells, the run is refused — the dependency "
            "has changed and this compute needs updating."
        )
    sizes = np.asarray(adata.uns["_partition_sizes"], dtype=np.int64)
    if sizes.size != n_groups:
        S.fail(
            f"the library recorded {sizes.size} per-group cell count(s) for {n_groups} "
            "group(s); refusing rather than emitting nodes with mismatched counts."
        )

    # ── write the graph/attributed artifact ──────────────────────────────────────────
    progress("write", 84, "writing the abstracted graph")
    dense = np.asarray(conn.todense(), dtype=np.float64)
    degree = [int((dense[i] > 0).sum()) for i in range(n_groups)]
    nodes = [
        {"index": i, "label": node_labels[i],
         "n_cells": int(sizes[i]),
         "degree": degree[i]}
        for i in range(n_groups)
    ]
    tree_edges = _tree_edges(tree, node_labels)

    versions = S.library_versions()
    paga_declaration = {
        "producer": "trajectory.paga",
        "model": PAGA_MODEL,
        "statistic": (
            "observed/expected inter-partition edge ratio under a random-connection null, "
            "hard-capped at 1 — a test statistic, NOT a probability"
        ),
        "partition_column": name,
        "n_nodes": n_groups,
        "n_neighbors": n_neighbors,
        "metric": metric,
        "neighbour_path": neighbour_path,
        "seed": seed,
        "node_order": "categorical level order (natsorted), not order of appearance",
        "library_versions": versions,
    }

    rel = "graph/paga.zarr"
    # `axes=("node","node")` — both dims name ONE axis, which is what the declared kind says
    # an adjacency is. float32 is the declared weight dtype; the float64→float32 narrowing is
    # the one deliberate lossy step, and the parity test's tolerance is sized for it.
    graph_structure = cyto_csc.write_csc_zarr(
        cyto_csc.ArraySource(conn.tocsr().astype(np.float32)),
        outputs_dir / rel,
        axes=("node", "node"),
        # Keys chosen OUTSIDE `_WRITER_OWNED_STRUCTURE_KEYS` — the writer refuses a caller
        # that tries to redeclare the decode contract of bytes it did not write. This is the
        # sanctioned channel a producer uses for a fact a downstream consumer must read, and
        # it is where the tree + node attributes ride, because ONE artifact carries ONE
        # `structure.kind` and a columnar table cannot co-locate with the CSC store.
        structure_extra={
            "paga": paga_declaration,
            "nodes": nodes,
            "tree_edges": tree_edges,
        },
    )

    entries = [S.output_entry(
        f"graph:{name}", S.DT_GRAPH_ATTRIBUTED, rel, "artifact",
        structure=graph_structure,
        meta={"name": name, "kind": "abstracted-graph", "n_nodes": n_groups,
              "n_edges": int((dense > 0).sum() // 2), "model": PAGA_MODEL})]

    # ── the provenance report ────────────────────────────────────────────────────────
    progress("report", 94, "provenance report")
    group_graph_connected = len(tree_edges) == max(0, n_groups - 1)
    report = {
        "kind": "trajectory-paga-report",
        "analysis": "trajectory.paga",
        "n_cells": int(n_cells),
        "n_nodes": n_groups,
        "nodes": nodes,
        # SORTED DESCENDING by connectivity: the readout is a table rather than a picture,
        # so the ordering IS the visual hierarchy — the most connected pair has to be the
        # first row a reader sees, or the table buries its own headline.
        "edges": sorted(
            [
                {"source": node_labels[i], "target": node_labels[j],
                 "connectivity": float(dense[i, j])}
                for i in range(n_groups) for j in range(i + 1, n_groups)
                if dense[i, j] > 0
            ],
            key=lambda e: (-e["connectivity"], e["source"], e["target"]),
        ),
        "tree_edges": tree_edges,
        "group_graph_connected": group_graph_connected,
        "group_graph_connected_is": (
            "whether the abstracted graph is connected. When it is NOT, the spanning tree "
            "has FEWER than n_nodes-1 edges — a real property of the data, recorded rather "
            "than repaired."
        ),
        "algorithm": "paga",
        "model": PAGA_MODEL,
        "model_is": (
            "passed explicitly and recorded; the alternative model is a DIFFERENT statistic "
            "(an undirected fuzzy graph with no cap at 1), so a connectivity is only "
            "comparable within one model"
        ),
        "parameters": {
            "n_neighbors": n_neighbors,
            "n_neighbors_requested": n_neighbors_requested,
            "n_neighbors_is": (
                "the neighbour count the graph was ACTUALLY built with. When "
                "`n_neighbors_requested` is non-null the library clamped the request to fit "
                "the dataset, and this is the honoured value — the statistic is not "
                "comparable across neighbour counts, so recording the request would be a "
                "false basis for that comparison."
            ),
            "metric": metric,
            "metric_is": "recorded, not recommended",
            "seed": seed,
            "neighbour_path": neighbour_path,
            "neighbour_path_switch_cells": S.neighbour_exact_switch_cells(metric),
            "name": name,
        },
        "partition": {
            "levels": node_labels,
            "levels_are": "the graph's NODES, in categorical level order (natsorted)",
            "n_levels": n_groups,
            "declared_levels": declared_levels,
            "levels_dropped_as_empty": dropped_levels,
            "levels_dropped_as_empty_is": (
                "levels the bound column DECLARES but no cell carries. They are excluded "
                "from the graph because an empty group is not a node of anything, and the "
                "statistic's expected-value denominator for a pair involving one is zero — "
                "the branch that substitutes a connectivity of 1, i.e. a spurious maximal "
                "edge. Recorded so the exclusion is visible rather than silent."
            ),
            "content_hash": part_entry.get("content_hash"),
        },
        "embedding": {
            "n_dims": int(n_dims),
            "content_hash": emb_entry.get("content_hash"),
            "method": structure.get("method", "unattested"),
        },
        "inter_group_edges": n_inter,
        "expected_null_denominator": None,
        "expected_null_denominator_is": (
            "NOT reported. scanpy computes the expected-edge denominator but the line "
            "writing it to its output is commented out, so it is unrecoverable from the "
            "result; re-deriving it here would put a second implementation of the statistic "
            "in this tree, only one of which is checked against scanpy. The statistic is "
            "named precisely instead."
        ),
        "library_versions": versions,
        "determinism_env": S.resolved_determinism_env(),
        "ceiling": ceiling,
        "disclosures": {
            k: S.DISCLOSURES[k] for k in (
                "connectivity_is_not_a_probability",
                "only_as_good_as_the_partition",
                "no_method_tests_that_a_trajectory_EXISTS",
                "branch_detection_not_performed",
                "the_capability_gap_of_this_method",
                "no_method_is_best_at_this",
            )
        },
        "warnings": [],
    }
    (outputs_dir / "trajectory-paga-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.opaque_report_entry(
        "trajectory-paga-report", "trajectory-paga-report.json",
        {"kind": "trajectory-paga-report", "n_cells": int(n_cells), "n_nodes": n_groups}))

    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{n_cells} cells -> {n_groups}-node abstracted graph")
    print(f"trajectory.paga: {n_cells} cells -> {n_groups} nodes, "
          f"{len(report['edges'])} edge(s) (model={PAGA_MODEL})", file=__import__("sys").stderr)


if __name__ == "__main__":
    main()
