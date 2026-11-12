#!/usr/bin/env python3
# ruff: noqa
"""clustering.cluster — SINGLE-DATASET embedding → Leiden cluster labels (Stage A, ITEM-2).

Reads ONE `embedding` artifact (a PCA / latent representation) and produces a categorical
`metadata-column` (the per-cell cluster label — owner DEC-9(c) / INV-2) plus a `report/qc`
provenance artifact. It REBUILDS the kNN graph internally from the embedding (never a 2-D
UMAP/t-SNE layout — INV-11) and partitions it with Leiden.

## The fixed pipeline (Stage A + the Stage-B markers pass)

    resolve the ONE embedding → CEILING GATE (before any read) → read the embedding →
    viable-cell refuse → sc.pp.neighbors (kNN on the embedding) → Leiden (igraph flavor,
    modularity) → singleton reassignment / sub-floor flag → write the categorical
    `metadata-column` (+ stamp the clustering provenance into attributes.txr) →
    [if an `expression` input is bound] DESCRIPTIVE markers (wilcoxon, doc 10 §4) → report

Every stage is a named refusal on failure, never a silent wrong answer.

## The input contract (ITEM-2 / ITEM-13 / ITEM-5)

Resolved by SLOT out of `/inputs/inputs.json` (never a filename suffix):

  * `embedding`  — REQUIRED, exactly ONE `embedding` artifact (≥3-dim reduced space).
                   Stage-0 clustering is SINGLE-dataset (INV-18); >1 embedding is refused.
  * `expression` — OPTIONAL, the cells × genes CSC expression matrix. Bound → the
                   DESCRIPTIVE per-cluster markers pass runs (Stage B); absent → labels only.

Params (`/inputs/params.json`): `resolution` (1.0 — scanpy default, owner DEC-1),
`n_neighbors` (15 — scanpy default, DEC-7), `metric` (euclidean), `seed` (0),
`name` (the output cluster column's member/display name, default `leiden`),
`n_top_markers` (25 — descriptive markers per cluster kept in the report).

## The Stage-B markers pass — DESCRIPTIVE, not inferential (CL-INV-1, doc 10 §4)

The clusters were defined from the SAME cells the markers are computed on, so between-cluster
marker p-values are anti-conservative BY CONSTRUCTION (double dipping). The markers are folded
into the `report/qc` report as a RANKING (score + effect size + expression fraction) carrying
the circularity disclosure; NO `pvals_adj`/FDR is ever headlined as inference. See
`_markers.py`.

## What this pipeline deliberately does NOT do

  * NO between-cluster DE p-value / FDR headlined as inference (INV-1) — the markers are
    DESCRIPTIVE only; the raw scanpy p-values are dropped, not surfaced as a discovery claim.
  * NEVER synthesizes a cell (INV-12 / DEC-6): below 10 viable cells the run is refused.
  * NEVER clusters on a 2-D layout (INV-11): the kNN graph is rebuilt on the embedding.
  * Emits a categorical `metadata-column`, NOT an exclusive `clustering` datatype (owner
    DEC-9(c)) — a cluster label IS a categorical per-cell column, colourable for free.

Roots overridable via `TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR`. Progress → `$TXR_PROGRESS_FIFO`.
"""
import _shared as S  # FIRST — pins the determinism env before numpy/scanpy load (INV-8)

import json

import numpy as np

import txr_deps
import txr_columns
import _markers as M


# The objective the modularity FAMILY names. scanpy `sc.tl.leiden(flavor="igraph")` runs
# igraph's community_leiden with `objective_function="modularity"`, OVERRIDING igraph's own
# raw CPM default (the igraph-CPM trap, DEC-2 / INV-4). Recorded so a run's resolution is
# never compared across objectives.
LEIDEN_FLAVOR = "igraph"
LEIDEN_OBJECTIVE = "modularity"
LEIDEN_N_ITERATIONS = 2
LEIDEN_DIRECTED = False

# ── INPUT SLOTS (resolved out of `/inputs/inputs.json`, never a filename suffix) ────────
# The literal slot names this compute reads, declared as constants so the VIEW↔COMPUTE
# conformance reader can confirm the view names only slots the compute resolves. `embedding`
# is the ONE required input (the reduced space to partition, single-select, INV-18);
# `expression` is the OPTIONAL descriptive-markers matrix (labels-only when absent).
EMBEDDING_SLOT = "embedding"
EXPRESSION_SLOT = "expression"


def _resolve_int(params, key, default, *, lo=1):
    try:
        v = int(params.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def _resolve_float(params, key, default, *, lo=0.0):
    try:
        v = float(params.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def refuse_cross_objective_comparison(p):
    """INV-4: the processor REFUSES to compare resolutions across flavors/objectives.

    A `compare` request naming a flavor/objective other than this run's modularity-family
    Leiden is refused BY NAME — a resolution means different things under modularity vs CPM
    and under different flavors, so the numbers are incomparable and the tool will not
    pretend otherwise."""
    compare = p.get("compare")
    if not compare:
        return
    items = compare if isinstance(compare, list) else [compare]
    for it in items:
        if not isinstance(it, dict):
            continue
        flav = str(it.get("flavor", LEIDEN_FLAVOR))
        obj = str(it.get("objective", LEIDEN_OBJECTIVE))
        if flav != LEIDEN_FLAVOR or obj != LEIDEN_OBJECTIVE:
            S.fail(
                f"refusing to compare resolutions across objectives/flavors: this run is "
                f"Leiden flavor={LEIDEN_FLAVOR!r} objective={LEIDEN_OBJECTIVE!r}, but the "
                f"comparison names flavor={flav!r} objective={obj!r}. A `resolution` value is "
                "only comparable within one flavor+objective (the igraph-CPM trap, INV-4)."
            )


def _reassign_singletons_and_flag(labels, coords, floor):
    """INV-12 / DEC-6 — reassign each SINGLETON cluster (size 1) to the nearest surviving
    cluster by centroid distance in the embedding space, and FLAG (record, never delete)
    every sub-floor cluster (size < `floor`). The total cell count is PRESERVED — no cell is
    fabricated and none is silently dropped. Returns `(new_labels, record)`.
    """
    labels = np.asarray(labels).copy()
    uniq, counts = np.unique(labels, return_counts=True)
    size = dict(zip(uniq.tolist(), counts.tolist()))

    singletons = [c for c in uniq.tolist() if size[c] == 1]
    reassignments = []
    if singletons:
        # centroids of the NON-singleton clusters, in embedding space.
        big = [c for c in uniq.tolist() if size[c] > 1]
        if big:
            centroids = {c: coords[labels == c].mean(axis=0) for c in big}
            cids = list(centroids.keys())
            cmat = np.vstack([centroids[c] for c in cids])
            for s in singletons:
                idx = int(np.nonzero(labels == s)[0][0])
                d = np.linalg.norm(cmat - coords[idx], axis=1)
                target = cids[int(np.argmin(d))]
                labels[idx] = target
                reassignments.append({"from": s, "to": target, "cell_index": idx})

    # re-evaluate sizes AFTER reassignment; flag anything still below the floor.
    uniq2, counts2 = np.unique(labels, return_counts=True)
    subfloor = [{"cluster": c, "n": int(n)}
                for c, n in zip(uniq2.tolist(), counts2.tolist()) if n < floor]
    record = {
        "floor": floor,
        "rule": "reassign singletons to nearest cluster centroid (embedding space); "
                "flag sub-floor clusters for review (never deleted, never fabricated)",
        "singletons_reassigned": reassignments,
        "n_singletons_reassigned": len(reassignments),
        "subfloor_clusters_flagged": subfloor,
    }
    return labels, record


def main():
    S.set_prefix("clustering.cluster")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)

    seed = _resolve_int(p, "seed", 0, lo=0)
    resolution = _resolve_float(p, "resolution", 1.0)   # scanpy default (owner DEC-1)
    n_neighbors = _resolve_int(p, "n_neighbors", 15)    # scanpy default (DEC-7)
    metric = str(p.get("metric") or "euclidean")
    col_name = str(p.get("name") or "leiden")
    n_top_markers = _resolve_int(p, "n_top_markers", 25)  # descriptive markers/cluster (ITEM-5)

    # INV-4 — refuse a cross-objective/flavor comparison up front.
    refuse_cross_objective_comparison(p)

    # ── resolve the ONE embedding (single-dataset, INV-18) ──────────────────────────
    progress = S.progress
    progress("resolve", 2, "resolving inputs")
    emb_entries = S.slot_entries(slots, EMBEDDING_SLOT)
    if not emb_entries:
        S.fail("no `embedding` input bound — clustering.cluster needs one `embedding` "
               "artifact (a PCA / latent representation) to partition")
    if len(emb_entries) > 1:
        S.fail(
            f"{len(emb_entries)} embeddings bound to `embedding`, but Stage-0 "
            "clustering.cluster is single-dataset (INV-18). Multi-dataset joint clustering "
            "is a later stage, gated by alignment."
        )
    emb_entry = emb_entries[0]
    emb_path = emb_entry["path"]

    # ── CEILING GATE — before a byte of the embedding is read (INV-10) ──────────────
    progress("preflight", 5, "checking the resource envelope")
    structure, member, n_cells, n_dims = S.read_embedding_structure(emb_path, "embedding")
    # F4 — size the labels-path kNN estimate from the ACTUAL n_neighbors this run honours, not
    # a hardcoded k=15 (n_neighbors=50 builds a ~3.3× larger graph).
    ceiling = S.ceiling_refuse_if_over(n_cells, n_dims, n_neighbors)

    # ── viable-cell refuse (INV-12 / DEC-6) — no cell is ever synthesized ────────────
    if n_cells < S.VIABLE_CELL_THRESHOLD:
        S.fail(
            f"only {n_cells} cell(s) to cluster, below the viable floor of "
            f"{S.VIABLE_CELL_THRESHOLD} (DEC-6). Refusing rather than partitioning too few "
            "cells; no cell is ever synthesized to reach the floor."
        )

    # ── read the embedding (INV-11 — the reduced space, never a 2-D layout) ─────────
    progress("read", 14, "reading the embedding")
    coords = S.read_embedding_matrix(emb_path, member)
    if coords.shape[0] != n_cells:
        S.fail(f"the embedding declares {n_cells} cells but holds {coords.shape[0]} rows")

    embedding_identity = S.embedding_identity(structure, emb_entry.get("content_hash"))

    # ── neighbour path (INV-6): exact below the metric's switch, approximate at/above it ──
    # P1 — the switch is METRIC-DEPENDENT and strict-`<` (scanpy `_handle_transformer`): 8192
    # for euclidean, 4096 otherwise. The recorded path must reflect what scanpy ACTUALLY runs,
    # so it is derived from (n_cells, metric), never a flat 8192 `<=`.
    neighbour_path = S.neighbour_path(n_cells, metric)

    # ── build the AnnData carrying ONLY the embedding as a representation ────────────
    import scanpy as sc
    import anndata as ad

    adata = ad.AnnData(X=np.zeros((n_cells, 1), dtype=np.float32))
    adata.obsm["X_embedding"] = coords

    # ── kNN graph on the EMBEDDING (INV-11) ─────────────────────────────────────────
    progress("neighbors", 40, f"kNN graph (k={n_neighbors}, {neighbour_path})")
    sc.pp.neighbors(adata, n_neighbors=n_neighbors, use_rep="X_embedding",
                    metric=metric, random_state=seed)

    # ── Leiden: igraph flavor → modularity, n_iterations=2, undirected, seeded ───────
    progress("leiden", 68, f"Leiden (flavor={LEIDEN_FLAVOR}, resolution={resolution})")
    sc.tl.leiden(adata, resolution=resolution, flavor=LEIDEN_FLAVOR,
                 n_iterations=LEIDEN_N_ITERATIONS, directed=LEIDEN_DIRECTED,
                 objective_function=LEIDEN_OBJECTIVE, random_state=seed,
                 key_added="_clusters")
    raw_labels = np.asarray(adata.obs["_clusters"].astype(str).values)
    n_clusters_raw = int(len(np.unique(raw_labels)))

    # ── singleton reassignment + sub-floor flag (INV-12), count PRESERVED ────────────
    progress("post", 80, "singleton reassignment + sub-floor flag")
    labels, subfloor_record = _reassign_singletons_and_flag(
        raw_labels, coords, S.VIABLE_CELL_THRESHOLD)
    assert len(labels) == n_cells  # INV-12: no fabrication, no deletion

    # ── build the categorical column: explicit SORTED levels + integer codes (INV-15) ─
    import pandas as pd

    present = sorted(set(labels.tolist()), key=lambda x: (len(x), x))  # numeric-ish sort
    series = pd.Categorical([str(v) for v in labels], categories=present, ordered=False)
    n_clusters = len(present)

    # ── write the cluster label as a categorical `metadata-column` (INV-2, DEC-9(c)) ─
    progress("write", 88, "writing the cluster label")
    rel = "columns/clusters.zarr"
    col_structure, col_meta = txr_columns.write_metadata_column(
        outputs_dir, rel, col_name, pd.Series(series), axis="cells",
        aligned_to=embedding_identity.get("aligned_to"))

    # ── stamp the clustering provenance into the store's attributes.txr (INV-2) ─────
    versions = _library_versions()
    provenance = {
        "method": "leiden",
        "flavor": LEIDEN_FLAVOR,             # INV-3
        "objective": LEIDEN_OBJECTIVE,       # INV-4 (modularity family, not raw igraph CPM)
        "n_iterations": LEIDEN_N_ITERATIONS,
        "directed": LEIDEN_DIRECTED,
        "resolution": resolution,            # INV-21 — a REPORTED operating parameter
        "resolution_objective": LEIDEN_OBJECTIVE,  # INV-4 — the objective it drives
        "seed": seed,                        # INV-5
        "n_neighbors": n_neighbors,          # INV-7 / INV-14
        "metric": metric,                    # INV-7
        "neighbour_path": neighbour_path,    # INV-6
        "n_pcs": n_dims,                     # INV-6 — dims of the partitioned embedding
        "n_clusters": n_clusters,
        "embedding": embedding_identity,     # INV-13 — which embedding (method + hash)
        "determinism_env": S.resolved_determinism_env(),  # INV-8
    }
    # The clustering tag rides BOTH the store's group `attributes.txr` AND the manifest
    # entry's `structure` (they are the two copies of one declaration the conformance gate
    # requires to agree): the store stamp is what a consumer reading the store URL sees, and
    # `col_structure` is what rides the artifact row.
    col_structure["clustering"] = provenance
    S.stamp_clustering_provenance(outputs_dir / rel, provenance)

    col_meta.update({"clustering": provenance, "n_categories": n_clusters})
    entries = [S.output_entry(f"metadata-column:{col_name}", S.DT_METADATA_COLUMN, rel,
                              "artifact", structure=col_structure, meta=col_meta)]

    # ── DESCRIPTIVE per-cluster markers (Stage B, ITEM-5) — only when expression is bound ─
    # doc 10 §5.2: labels-only clustering never reads the counts; the markers pass is the one
    # that reads the CSC expression matrix, so it is OPTIONAL and re-checks the MEMORY ceiling
    # (INV-10, markers clause) before the read. CL-INV-1: the markers are DESCRIPTIVE — the
    # clusters were defined from the same cells, so no between-cluster p-value is headlined.
    markers = _compute_markers_if_bound(slots, labels, present, n_top_markers, progress)

    # ── the provenance report (report/qc, meta.kind clustering-report) — INV-5/6/7/13 ─
    progress("report", 94, "provenance report")
    report = {
        "kind": "clustering-report",
        "analysis": "clustering.cluster",
        "n_cells": int(n_cells),
        "n_clusters": n_clusters,
        "n_clusters_before_reassignment": n_clusters_raw,
        # INV-5 — every parameter ACTUALLY used, and the algorithm identity.
        "algorithm": "leiden",
        "flavor": LEIDEN_FLAVOR,                 # INV-3
        "objective": LEIDEN_OBJECTIVE,           # INV-4
        "n_iterations": LEIDEN_N_ITERATIONS,
        "directed": LEIDEN_DIRECTED,
        "parameters": {
            # INV-21 — the operating resolution is a REPORTED parameter, never a discovered
            # "true k". The justification is recorded, not claimed.
            "resolution": resolution,
            "resolution_is": "a reported operating parameter (scanpy default 1.0); not a "
                             "discovered 'true' number of clusters (INV-21)",
            "resolution_objective": LEIDEN_OBJECTIVE,  # INV-4 — labelled with its objective
            # INV-14 — n_neighbors is FIXED (recorded), resolution is the tuned dial; they
            # are not jointly swept.
            "n_neighbors": n_neighbors,
            "n_neighbors_is": "fixed at the documented default; the tuned dial is "
                              "`resolution`, not n_neighbors (INV-14)",
            "metric": metric,
            "metric_is": "recorded, not recommended (INV-7)",  # INV-7
            "seed": seed,
            "neighbour_path": neighbour_path,    # INV-6
            "neighbour_path_switch_cells": S.neighbour_exact_switch_cells(metric),
        },
        # INV-13 — WHICH embedding was partitioned (method + content-hash), and that a
        # cluster identity is DESCRIPTIVE, not a quantitative measurement.
        "embedding_partitioned": embedding_identity,
        "n_pcs": int(n_dims),
        "cluster_identity_is": "a descriptive label of a corrected-space partition — a "
                               "cluster identity is not a quantitative claim, and a cluster "
                               "that is really a batch is legible from the embedding's "
                               "recorded method/correction (INV-13).",
        # INV-15 — ids are run-specific unless preserved; the level set is explicit + sorted.
        "levels": present,
        "levels_are": "run-specific cluster ids (a categorical factor with an explicit, "
                      "sorted level set); stability across runs is not claimed (INV-15)",
        # INV-12 — singleton reassignment + sub-floor flag, recorded.
        "subfloor": subfloor_record,
        # INV-7 — library versions (only knowable at run time; the rootfs pins nothing).
        "library_versions": versions,
        # INV-8 — the determinism env read out of THIS running process (TEST-8).
        "determinism_env": S.resolved_determinism_env(),
        "ceiling": ceiling,
        # ITEM-5 / CL-INV-1 — the DESCRIPTIVE markers, folded into the run report. They are a
        # RANKING carrying the circular-by-construction disclosure, NOT an inference claim; no
        # between-cluster p-value / FDR is headlined as a finding.
        "markers": markers,
        "warnings": [],
    }
    (outputs_dir / "clustering-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.output_entry(
        "clustering-report", S.DT_REPORT_QC, "clustering-report.json", "artifact",
        structure=txr_columns.opaque("application/json"),
        meta={"kind": "clustering-report", "n_cells": int(n_cells),
              "n_clusters": n_clusters}))

    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{n_cells} cells → {n_clusters} clusters")
    print(f"clustering.cluster: {n_cells} cells → {n_clusters} Leiden clusters "
          f"(flavor={LEIDEN_FLAVOR}, objective={LEIDEN_OBJECTIVE}, resolution={resolution})",
          file=__import__("sys").stderr)


def _compute_markers_if_bound(slots, labels, levels, n_top, progress):
    """Resolve the OPTIONAL `expression` slot and, when bound, compute DESCRIPTIVE per-cluster
    markers (ITEM-5). Absent → a recorded skip (no counts to describe from), never a fabricated
    marker table. Refuses BEFORE the CSC read when it would blow the memory ceiling (INV-10)."""
    expr_entries = S.slot_entries(slots, EXPRESSION_SLOT)
    if not expr_entries:
        return {
            "computed": False,
            "descriptive": True,          # CL-INV-1 — the framing holds even when skipped
            "is_inference": False,
            "skipped_reason": (
                "no `expression` input bound — the cluster labels are committed, but the "
                "descriptive per-cluster markers need the cells × genes expression matrix "
                "(bind an `expression` artifact to describe what each cluster expresses)."
            ),
            "disclosure": M.MARKER_DISCLOSURE,
        }
    if len(expr_entries) > 1:
        S.fail(
            f"{len(expr_entries)} expression matrices bound to `expression`, but the markers "
            "pass describes ONE single-dataset partition (INV-18); bind exactly one."
        )
    expr_path = expr_entries[0]["path"]

    progress("markers-preflight", 90, "checking the markers memory envelope")
    _structure, xn_cells, xn_genes, nnz = S.read_expression_structure(expr_path, "expression")
    if xn_cells != len(labels):
        S.fail(
            f"the expression matrix declares {xn_cells} cells but the clustering produced "
            f"{len(labels)} labels — they must be obs-aligned over the same cells axis to "
            "describe the clusters (INV-20)."
        )
    S.markers_memory_refuse_if_over(nnz)  # INV-10 (markers clause) — before the CSC read

    progress("markers", 92, f"descriptive markers (wilcoxon, {xn_genes} genes)")
    indptr, indices, data = S.read_expression_csc(expr_path)
    return M.compute_markers(indptr, indices, data, xn_cells, xn_genes, labels, levels,
                             n_top=n_top)


def _library_versions():
    """The RESOLVED version of every library this analysis DECLARES (#80).

    Replaces a hand-typed module list read through the deprecated `__version__`
    attribute. Three things change and each was a defect:

    * the subject set is now the DECLARATION in this package's manifest — one source,
      also read by the build gate — instead of a list maintained separately from the
      imports it was supposed to describe, which is how it drifted;
    * a version that cannot be resolved is a NAMED REFUSAL rather than a recorded
      `None`, so "we do not know what produced this number" can no longer be published
      as a successful run;
    * every resolved version is CHECKED against the range this analysis declares it is
      supported against, so recording it changes an outcome instead of only decorating
      the report.

    Memoized in `txr_deps`, so this and the manifest-write hook resolve once and cannot
    disagree about what ran.
    """
    return txr_deps.resolve_and_check()["libraries"]


if __name__ == "__main__":
    main()
