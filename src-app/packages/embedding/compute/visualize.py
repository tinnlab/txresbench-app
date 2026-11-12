#!/usr/bin/env python3
# ruff: noqa
"""embedding.visualize — an `embedding` of ≥3 dims → a 2-D `embedding` (Stage 0, ITEM-0a).

The TIME-bound half of the `embedding` package. Consumes ONE `embedding` artifact —
whatever produced it (our PCA, or an imported `X_scVI`; OD-2) — builds the k-NN graph and
produces a 2-D `embedding` via UMAP (default) or t-SNE, plus a `report/qc`.

## The input contract (ITEM-13)

  * `embedding` — REQUIRED, ONE `embedding` artifact of ≥3 declared dims. Fewer than 3 is
                  REFUSED from the DECLARED structure, before any read (ITEM-0e / DEC-2).

Params: `method` (`umap` | `tsne`, default `umap`), `n_neighbors` (15), `min_dist` (0.5,
UMAP; chosen and RECORDED, not silently inherited — INV-14), `metric` (`euclidean`;
recorded as the CHOICE, never claimed correct — INV-13), `seed` (0), `name` (output
member, default `X_umap`/`X_tsne`).

INV-6 — the report RECORDS which of the exact / approximate neighbour paths ran. scanpy's
switch is at 8192 cells; below it an exact (brute-force) transformer runs, at or above it
the approximate (pynndescent) one. The path is chosen HERE and recorded, so what ran is
what the report says ran. (The threshold is seam-overridable for tests via
`EMBEDDING_NEIGHBORS_EXACT_MAX`.)
"""
import _shared as S  # FIRST — pins the six thread vars before numpy/scanpy load (INV-11)

import json
import os

import numpy as np

import txr_deps
import txr_columns
import txr_zarr_read

#: scanpy's exact/approx neighbour switch (INV-6 / ITEM-21). Seam-overridable so a small
#: fixture can exercise the approximate branch without an 8192-cell matrix.
NEIGHBORS_EXACT_MAX = int(os.environ.get("EMBEDDING_NEIGHBORS_EXACT_MAX", "8192"))

#: The § B.5 honesty clause, verbatim per DEC-8 — one calm, always-present standing line
#: (neutral + specific; not a scare banner, not a dismissible toast). The declarative
#: visualize view shows it as a standing note; the compute records it into the report so a
#: run read without the view still carries it. Voice fixed here so the two never drift.
HONESTY_NOTE = (
    "A 2-D embedding is a lossy summary — distances between far-apart clusters and "
    "absolute positions are not meaningful. Use it to explore structure, not to measure it."
)


def _resolve_int(params, key, default, *, lo=1):
    try:
        return max(lo, int(params.get(key, default)))
    except (TypeError, ValueError):
        return default


def _resolve_float(params, key, default):
    try:
        return float(params.get(key, default))
    except (TypeError, ValueError):
        return default


def _embedding_member(structure):
    """The dense 2-D member of an `embedding` store, or `None` — `(path, n_dims)`."""
    for arr in structure.get("arrays", []) or []:
        shape = arr.get("shape") or []
        if len(shape) == 2:
            return arr.get("path"), int(shape[1])
    return None, None


def main():
    S.set_prefix("embedding.visualize")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)
    progress = S.progress

    seed = _resolve_int(p, "seed", 0, lo=0)
    method = str(p.get("method") or "umap").lower()
    if method not in ("umap", "tsne"):
        S.fail(f"unknown method {method!r}; expected `umap` or `tsne`")
    n_neighbors = _resolve_int(p, "n_neighbors", 15)
    min_dist = _resolve_float(p, "min_dist", 0.5)
    metric = str(p.get("metric") or "euclidean")
    emb_name = str(p.get("name") or ("X_umap" if method == "umap" else "X_tsne"))

    progress("resolve", 3, "resolving the input embedding")
    emb_path = S.slot_path(slots, "embedding")
    if emb_path is None:
        S.fail("no `embedding` input bound — embedding.visualize needs one `embedding` "
               "of at least 3 dimensions")
    structure = S.artifact_structure(emb_path)
    if structure is None:
        S.fail("the `embedding` input carries no `structure` declaration — it is not a "
               "txr_zarr artifact")
    member, declared_dims = _embedding_member(structure)
    if member is None or declared_dims is None:
        S.fail("the `embedding` input declares no 2-D coordinate member")

    # ── dim guard (ITEM-0e / DEC-2) — from the DECLARED structure, before any read ────
    if declared_dims < 3:
        S.fail(
            f"the input embedding declares {declared_dims} dimension(s); embedding.visualize "
            "needs at least 3 to build a meaningful k-NN graph and 2-D layout (a 2-D input "
            "IS already a layout). Refused from the declared structure, before reading."
        )

    progress("read", 12, "reading the embedding")
    X = np.asarray(txr_zarr_read.read_array(emb_path, member), dtype=np.float32)
    if X.ndim != 2 or X.shape[1] < 3:
        S.fail(f"the input embedding read back as shape {X.shape}; expected ≥3 columns")
    n_obs = int(X.shape[0])

    import scanpy as sc
    import anndata as ad

    adata = ad.AnnData(X=np.zeros((n_obs, 1), dtype=np.float32))
    adata.obsm["X_input"] = X

    # ── neighbours — pick the path explicitly, record what ran (INV-6) ───────────────
    progress("neighbors", 34, "k-NN graph")
    if n_obs < NEIGHBORS_EXACT_MAX:
        neighbor_path = "exact"
        from sklearn.neighbors import KNeighborsTransformer
        transformer = KNeighborsTransformer(
            n_neighbors=n_neighbors, algorithm="brute", metric=metric)
        sc.pp.neighbors(adata, use_rep="X_input", transformer=transformer,
                        random_state=seed)
    else:
        neighbor_path = "approximate"
        sc.pp.neighbors(adata, use_rep="X_input", n_neighbors=n_neighbors,
                        metric=metric, transformer="pynndescent", random_state=seed)

    # ── 2-D layout ───────────────────────────────────────────────────────────────────
    if method == "umap":
        progress("umap", 62, "UMAP layout")
        # INV-14: init="spectral", random_state=<seed>, min_dist exposed + recorded.
        sc.tl.umap(adata, min_dist=min_dist, init_pos="spectral", random_state=seed)
        coords = np.asarray(adata.obsm["X_umap"], dtype=np.float32)
        layout_params = {"init": "spectral", "min_dist": min_dist,
                         "n_neighbors": n_neighbors, "random_state": seed}
    else:
        progress("tsne", 62, "t-SNE layout")
        # The Kobak & Berens protocol (NOT scanpy's perplexity-30-only default): PCA init
        # scaled to 1e-4, learning rate n/12, perplexity = min(30, n/100 rounded up).
        from sklearn.manifold import TSNE
        pca_init = X[:, :2].astype(np.float64)
        std = pca_init[:, 0].std() or 1.0
        pca_init = (pca_init / std) * 1e-4
        perplexity = float(max(1, min(30, int(np.ceil(n_obs / 100.0)))))
        perplexity = min(perplexity, max(1.0, (n_obs - 1) / 3.0))
        learning_rate = max(50.0, n_obs / 12.0)
        tsne = TSNE(n_components=2, init=pca_init, perplexity=perplexity,
                    learning_rate=learning_rate, metric=metric, random_state=seed)
        coords = np.asarray(tsne.fit_transform(X), dtype=np.float32)
        layout_params = {"init": "pca(1e-4)", "perplexity": perplexity,
                         "learning_rate": learning_rate, "random_state": seed,
                         "protocol": "kobak_berens"}

    # ── the input embedding's correction bit (ITEM-25 / DEC-5 / F2) ──────────────────
    # We read what the input DECLARED on its `attributes.txr`. Our OWN reduce producer now
    # STAMPS `correction` there (F2 — `stamp_txr_attributes`), so a real PCA embedding reads
    # back `none` and a Harmony one `harmony`; the bit SURVIVES the reduce→visualize hop
    # (TEST-30). An imported latent of unknown provenance carries no such declaration and is
    # `unattested`, NEVER defaulted to "not corrected".
    correction = structure.get("correction")
    if correction not in ("none", "harmony", "unattested"):
        correction = "unattested"

    aligned_to = structure.get("aligned_to")

    progress("write", 86, "writing the 2-D embedding")
    rel = f"embeddings/{emb_name}.zarr"
    emb_structure, emb_meta = txr_columns.write_embedding(
        outputs_dir, rel, coords, axis="cells", name=emb_name, kind="embedding",
        method=method, aligned_to=aligned_to)
    emb_meta.update({"correction": correction, "derived_from": "embedding"})
    # ITEM-25 / F2: propagate the correction + method onto the ARTIFACT's `attributes.txr`
    # (not just the manifest meta) so the bit survives THIS hop too — a reader of the 2-D
    # layout (or the clustering package) sees the correction the input carried, not `unattested`.
    S.stamp_txr_attributes(outputs_dir / rel, emb_structure, correction=correction, method=method)
    entries = [S.output_entry(f"embedding:{emb_name}", S.DT_EMBEDDING, rel, "artifact",
                              structure=emb_structure, meta=emb_meta)]

    progress("report", 94, "provenance report")
    report = {
        "kind": "embedding-report",
        "analysis": "embedding.visualize",
        "n_cells": n_obs,
        "input_dims": int(X.shape[1]),
        "method": method,
        # INV-6 — WHICH neighbour path ran, and the switch it turned on.
        "neighbor_path": neighbor_path,
        "neighbor_exact_max": NEIGHBORS_EXACT_MAX,
        "parameters": {
            "method": method,
            "n_neighbors": n_neighbors,
            "metric": metric,           # INV-13 — the CHOICE, not a recommendation
            "seed": seed,
            **layout_params,
        },
        "library_versions": _library_versions(),
        "thread_pins": S.resolved_thread_env(),
        "correction": correction,
        # § B.5 honesty clause (INV-13 / DEC-8) — one calm, always-present standing line.
        # The declarative visualize VIEW carries the same sentence as a standing note
        # (DEC-8); the compute records it so a run read WITHOUT the view still carries it.
        "honesty_note": HONESTY_NOTE,
        # The metric/method are RECORDED CHOICES, never claims one is correct (INV-13).
        "metric_caveat": (
            f"metric={metric!r} and method={method!r} are recorded choices, not "
            "recommendations; no benchmark declares one correct for your data."
        ),
        # kept for back-compat with earlier readers of `note`.
        "note": HONESTY_NOTE,
    }
    (outputs_dir / "embedding-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.output_entry(
        "embedding-report", S.DT_REPORT_QC, "embedding-report.json", "artifact",
        structure=txr_columns.opaque("application/json"),
        meta={"kind": "embedding-report", "n_cells": n_obs, "method": method}))

    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{n_obs} cells → 2-D {method} embedding")
    print(f"embedding.visualize: {n_obs} cells → 2-D {method} ({neighbor_path} neighbours)",
          file=__import__("sys").stderr)


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
