#!/usr/bin/env python3
# ruff: noqa
"""embedding.reduce — SINGLE-DATASET count matrix → PCA embedding (Stage 0, ITEM-0).

Reads ONE `single-cell/expression` count matrix and produces a `embedding` (the PCA
representation) plus a `report/qc` provenance artifact. The memory-bound half of the
`embedding` package; the k-NN + 2-D layout is `embedding.visualize` (ITEM-0a).

## The fixed pipeline (ITEM-17b)

    resolve inputs → CEILING GATE (before any read) → read CSC → integer gate →
    INLINE FILTER (subset at read) → small-sample refuse (POST-filter) → normalize →
    HVG (seurat_v3, on raw counts) → PCA (arpack) → provenance

Every stage is a named refusal on failure, never a silent wrong answer. The inline filter
subsets the matrix (and the batch factor + cell keys) BEFORE anything fits, so the
embedding is RE-DERIVED on the surviving subset, never sliced from a global layout (INV-12).

## The input contract (ITEM-13)

Resolved by SLOT out of `/inputs/inputs.json` (never a filename suffix):

  * `matrices`     — REQUIRED, exactly ONE `single-cell/expression` CSC store. Stage-0
                     `matrices` is SINGLE-select (DEC-12); multi-dataset is Stage 1.
  * `batch`        — OPTIONAL, a cells-axis `metadata-column`. When bound, it is the
                     `seurat_v3` HVG `batch_key` (INV-15). ONE column drives HVG's batch
                     split (and, in Stage B, the covariate Harmony corrects on — ITEM-8).
  * `cells_index`  — OPTIONAL, the cells-axis KEY artifact. Supplies the row space's
                     `key_sequence_digest` for `aligned_to` (ITEM-26). Absent ⇒ absent.
  * `column:<name>`— 0..N, OPTIONAL. One cells-axis obs column the inline filter's
                     `criteria` may reference (ITEM-2d). The name arrives with the binding
                     because a `metadata-column` store cannot carry it (`cell-filter`'s
                     `column:<name>` convention). Read at full length, subset with the matrix.

Params (`/inputs/params.json`): `criteria` (the inline-filter recipe, a list of
`{column, min?, max?, keep?}` — ITEM-2b/14a), `n_hvg` (2000), `n_pcs` (50), `seed` (0), `name`
(output embedding member, default `X_pca`), `harmony_name` (the corrected member, default
`X_harmony`), `batch_column` (the chosen column's display name, for the report),
`integration` (`none` | `harmony`; default `none`).

## Optional Harmony batch correction (ITEM-20a / INV-22)

With `integration: harmony` and a bound `batch` column, the PCA embedding is batch-
corrected via `harmonypy` and emitted as a THIRD `embedding` (`method="harmony"`,
`correction="harmony"`) alongside the uncorrected PCA one. The harmonypy VERSION is pinned
(recorded, matched to the Dockerfile pin) and EVERY Harmony parameter is passed EXPLICITLY,
`theta` first — never harmonypy's version-unstable default (INV-22). When harmonypy is
absent (rootfs not yet republished) the run is refused BY NAME (ITEM-20b), never a raw
`ImportError`.

## What this pipeline deliberately does NOT do

  * NO `sc.pp.scale`, NO `regress_out` (INV-4 / ITEM-19) — the PCA input is `log1p`-
    normalized, its per-gene variance is NOT standardized to 1.
  * NEVER synthesizes a cell (INV-2 / DEC-6): below 10 surviving cells the run is refused.
  * NEVER exposes a corrected representation as an expression matrix (INV-1): the PCA (and,
    in Stage B, Harmony) latent is emitted as an `embedding`, and its `meta.correction`
    records provenance (`none` here; DEC-5).

Roots overridable via `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`. Progress →
`$CYTO_PROGRESS_FIFO`.
"""
import _shared as S  # FIRST — pins the six thread vars before numpy/scanpy load (INV-11)

import json

import numpy as np

import cyto_deps
import cyto_columns
import _criteria as CR  # the cell-filter predicate kernel, VENDORED VERBATIM (DEC-11)


def _resolve_int(params, key, default, *, lo=1):
    try:
        v = int(params.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def _gene_stats_float64(mat_csc):
    """Per-gene mean and (ddof=1) variance of the RAW counts, accumulated in FLOAT64
    (INV-10 / ITEM-18). Not float32: on a matrix with large counts a float32
    sum-of-squares drifts. Returned so the report carries a stable float64 reference of the
    statistics HVG ranks on; a test pins the float64 property (TEST-14). The RANKING itself is
    made genuinely float64 by feeding seurat_v3 a float64 `counts` layer (see `main`), so the
    SELECTED gene set matches these statistics rather than a float32 re-accumulation (F1/TEST-40).

    Two-pass over the CSC columns (genes): `Σx` and `Σx²` per gene, both float64.
    """
    import scipy.sparse as sp

    m = mat_csc.tocsc()
    n_cells = int(m.shape[0])
    n_genes = int(m.shape[1])
    means = np.zeros(n_genes, dtype=np.float64)
    variances = np.zeros(n_genes, dtype=np.float64)
    indptr = m.indptr
    data = m.data.astype(np.float64)  # promote BEFORE any accumulation
    for g in range(n_genes):
        lo, hi = int(indptr[g]), int(indptr[g + 1])
        col = data[lo:hi]
        nnz = col.size
        s = col.sum(dtype=np.float64)
        mean = s / n_cells
        # STABLE two-pass in float64: Σ(x-mean)² over the stored values plus the implicit
        # zeros' contribution ((n_cells - nnz)·mean²), Bessel-corrected to ddof=1. This is
        # the numerically-correct float64 accumulation (matches np.var(ddof=1)) — the exact
        # thing INV-10 forbids doing in float32.
        ssd = np.square(col - mean).sum(dtype=np.float64) + (n_cells - nnz) * (mean * mean)
        var = ssd / (n_cells - 1) if n_cells > 1 else 0.0
        means[g] = mean
        variances[g] = max(var, 0.0)
    return means, variances


VIABLE_CELL_THRESHOLD = 10  # DEC-6 (legacy `embedding-create.R:219-221`)


def main():
    S.set_prefix("embedding.reduce")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)

    seed = _resolve_int(p, "seed", 0, lo=0)
    n_hvg = _resolve_int(p, "n_hvg", 2000)
    n_pcs_req = _resolve_int(p, "n_pcs", 50)
    emb_name = str(p.get("name") or "X_pca")
    harmony_name = str(p.get("harmony_name") or "X_harmony")
    integration = str(p.get("integration") or "none").lower()

    if integration not in ("none", "harmony"):
        S.fail(f"unknown integration mode {integration!r}; expected `none` or `harmony`")

    # ── Harmony preconditions — checked FAST, before a byte of the matrix is read ─────
    # (ITEM-20a/20b, INV-22). Two pre-read refusals when `integration: harmony`:
    #   1. a batch/covariate column MUST be bound — Harmony corrects on it (there is
    #      nothing to correct against otherwise);
    #   2. harmonypy MUST be importable — when the rootfs has not been republished with
    #      the pinned harmonypy, we refuse BY NAME (never a raw `ImportError`), naming the
    #      package + the republish requirement.
    harmony_mod = None
    if integration == "harmony":
        if S.slot_path(slots, "batch") is None:
            S.fail(
                "integration=`harmony` needs a batch/covariate column, but none is bound on "
                "the `batch` slot. Harmony corrects the embedding against that covariate; "
                "with nothing to correct on, re-run with `integration: none` for the "
                "uncorrected PCA embedding, or bind a cells-axis column on `batch`."
            )
        harmony_mod = S.import_harmonypy()
        if harmony_mod is None:
            S.fail(
                "integration=`harmony` requires the `harmonypy` package, which is NOT "
                "available in this environment. The single-cell env rootfs pins "
                f"`harmonypy {S.harmonypy_requirement()}` (INV-22), but this deployment has not yet "
                "been republished with it — the runtime lazy-fetches the moving "
                "`schema5-latest-<arch>` image tag, so a republished rootfs resolves this. "
                "Re-run with `integration: none` for the uncorrected PCA embedding, or wait "
                "for the rootfs republish (ITEM-20b). Refused by name rather than crashing "
                "on a raw ImportError mid-pipeline."
            )

    # ── resolve the ONE matrix (single-select, DEC-12) ──────────────────────────────
    progress = S.progress
    progress("resolve", 2, "resolving inputs")
    matrix_paths = S.slot_paths(slots, "matrices")
    if not matrix_paths:
        S.fail("no `matrices` input bound — embedding.reduce needs one "
               "`single-cell/expression` count matrix")
    if len(matrix_paths) > 1:
        S.fail(
            f"{len(matrix_paths)} matrices bound to `matrices`, but Stage-0 embedding.reduce "
            "is single-dataset (DEC-12). Multi-dataset reduce is a later stage."
        )
    matrix_path = matrix_paths[0]

    # ── CEILING GATE — before a byte of the matrix is read (INV-8/9, ITEM-16, DEC-4) ─
    progress("preflight", 5, "checking the resource envelope")
    structure = S.read_matrix_structure(matrix_path, "matrices")
    ceiling = S.ceiling_refuse_if_over(structure)

    # ── read the matrix (CSC → scipy csc) ───────────────────────────────────────────
    progress("read", 12, "reading the count matrix")
    mat = S.read_matrix_csc(matrix_path, structure)
    n_cells, n_genes = int(mat.shape[0]), int(mat.shape[1])

    # ── INTEGER-count gate (INV-3 / ITEM-14): raw counts only, never truncated ──────
    progress("integer-gate", 16, "validating raw integer counts")
    data = np.asarray(mat.data)
    if data.size and not np.all(data == np.round(data)):
        bad = float(data[np.argmax(data != np.round(data))])
        S.fail(
            "the input matrix is NOT raw integer counts (found a non-integer stored value, "
            f"e.g. {bad!r}). embedding.reduce requires raw counts and REFUSES a normalized / "
            "scaled matrix rather than truncating it (INV-3). Feed the raw count matrix, "
            "not a `single-cell/normalized` one."
        )
    if data.size and float(data.min()) < 0:
        S.fail("the input matrix holds negative values; raw counts are non-negative (INV-3)")

    n_cells_in = n_cells  # the DECLARED count, before the inline filter (for the report)

    # ── optional batch column (the seurat_v3 HVG batch_key, INV-15 / ITEM-8) ─────────
    # Read at FULL length here so the inline filter below subsets it in lock-step with the
    # matrix — the batch factor must describe the SURVIVING cells, not the pre-filter set.
    batch_path = S.slot_path(slots, "batch")
    batch_values = None
    batch_column_name = str(p.get("batch_column") or "batch")
    if batch_path is not None:
        vals = S.read_column_values(batch_path, "batch")
        if len(vals) != n_cells:
            S.fail(
                f"the `batch` column has {len(vals)} values but the matrix declares "
                f"{n_cells} cells — they are not the same cells axis"
            )
        batch_values = vals

    # ── INLINE metadata filter (ITEM-2b/2c/2d / ITEM-17b / INV-12) ───────────────────
    # An optional predicate over ANY cells-axis obs column, bound one `column:<name>` slot
    # per criterion, the recipe carried in `params.criteria`. The keep-mask is computed with
    # `cell-filter`'s SHIPPED `criteria_keep_mask` — VENDORED VERBATIM (DEC-11), never a
    # fourth dialect — then the matrix + batch + cell-keys are SUBSET at read, BEFORE anything
    # fits. Normalize / HVG / PCA therefore see only survivors because there is nothing else
    # to see: the embedding is RE-DERIVED on the subset, never sliced from a global layout
    # (INV-12). Missing values are excluded (`np.isfinite`, ITEM-14b); an empty / absent
    # criterion is NO CONSTRAINT (ITEM-14a). Composition is AND (DEC-11).
    progress("filter", 18, "applying the inline metadata filter")
    criteria = p.get("criteria")
    if not isinstance(criteria, list):
        criteria = []
    filter_obs = S.collect_filter_columns(slots, n_cells)
    if criteria:
        keep = np.asarray(CR.criteria_keep_mask(criteria, filter_obs, n_cells=n_cells), dtype=bool)
    else:
        keep = np.ones(n_cells, dtype=bool)
    n_kept = int(keep.sum())
    filter_applied = bool(criteria) and n_kept != n_cells

    # Per-column honesty (OD-3 / ITEM-24): for each criterion, the EXACT predicate applied and
    # how many cells it alone would keep. Built from the SAME recipe the mask ran on.
    filter_columns = []
    for c in criteria:
        if not isinstance(c, dict):
            continue
        col = c.get("column")
        is_cat = CR._is_categorical_criterion(c)
        one = np.asarray(CR.criteria_keep_mask([c], filter_obs, n_cells=n_cells), dtype=bool)
        filter_columns.append({
            "column": col,
            "kind": "categorical" if is_cat else "range",
            "predicate": ({"keep": c.get("keep")} if is_cat
                          else {"min": c.get("min"), "max": c.get("max")}),
            "present": col in filter_obs,
            "cells_kept_by_this_column": int(one.sum()),
        })

    keep_idx = np.nonzero(keep)[0]
    if filter_applied:
        mat = mat[keep_idx, :]
        if batch_values is not None:
            batch_values = [batch_values[i] for i in keep_idx.tolist()]
        n_cells = int(mat.shape[0])

    # ── small-sample refuse on POST-FILTER cells (INV-2 / DEC-6) — no cell synthesized ─
    # Evaluated on the SURVIVING count (n_kept == post-filter n_cells): a filter that leaves
    # too few cells is refused here, not fitted. No code path synthesizes a cell to reach the
    # threshold. In single-dataset Stage 0 "exclude the sub-threshold sample" degenerates to
    # "refuse the run" (DEC-6), coded on the surviving count so Stage 1 inherits it unchanged.
    surviving = n_kept
    if surviving < VIABLE_CELL_THRESHOLD:
        S.fail(
            f"only {surviving} cell(s) survive the inline filter "
            f"(of {n_cells_in} in), below the viable threshold of {VIABLE_CELL_THRESHOLD} "
            "(DEC-6). Refusing rather than fitting an embedding on too few cells; no cell is "
            "ever synthesized to reach the threshold. Loosen the filter or pick a larger subset."
        )

    # ── float64 gene statistics of the RAW counts (INV-10) ──────────────────────────
    progress("gene-stats", 22, "float64 per-gene mean/variance")
    gene_means, gene_variances = _gene_stats_float64(mat)

    # ── build the AnnData; keep RAW counts for seurat_v3 (INV-15) ────────────────────
    import scanpy as sc
    import anndata as ad
    import pandas as pd

    adata = ad.AnnData(X=mat.tocsr().astype(np.float32))
    # INV-10 / F1: the raw counts seurat_v3 RANKS genes on are kept as FLOAT64, not float32.
    # scanpy's seurat_v3 accumulates the per-gene mean/variance it ranks on directly over this
    # `counts` layer, honouring its dtype — so a float32 layer let the exact 0.29% sum-of-squares
    # drift INV-10 forbids change the SELECTED gene set (which fully determines the PCA), while
    # the report attested `accumulator_dtype: float64`. Feeding a float64 counts layer makes the
    # accumulation that RANKS genes genuinely float64, so the shipped selection IS the float64
    # one. (Cost: the counts-layer data array is float64 = 2× its float32 size; the ceiling gate
    # sizes this into the peak — see `_PEAK_BYTES_PER_NNZ`.)
    adata.layers["counts"] = adata.X.astype(np.float64)  # raw counts (float64) for seurat_v3
    if batch_values is not None:
        adata.obs["_batch"] = pd.Categorical([str(v) for v in batch_values])

    # ── normalize (INV-4/17): normalize_total(None) + log1p, sparse-preserving ───────
    progress("normalize", 34, "normalize_total + log1p")
    sc.pp.normalize_total(adata, target_sum=None)
    sc.pp.log1p(adata)
    # INV-4 / ITEM-19: NO sc.pp.scale, NO sc.pp.regress_out. The PCA input variance is NOT
    # standardized. (Asserted behaviourally by TEST-11.)

    # ── HVG: seurat_v3 on the RAW counts layer, batch_key when chosen (INV-15) ───────
    progress("hvg", 48, f"highly-variable genes (seurat_v3, n_top={n_hvg})")
    n_hvg_eff = int(min(n_hvg, n_genes))
    hvg_kwargs = dict(flavor="seurat_v3", n_top_genes=n_hvg_eff, layer="counts")
    if batch_values is not None:
        hvg_kwargs["batch_key"] = "_batch"
    sc.pp.highly_variable_genes(adata, **hvg_kwargs)
    hvg_mask = np.asarray(adata.var["highly_variable"].values, dtype=bool)
    n_hvg_selected = int(hvg_mask.sum())
    adata_hvg = adata[:, hvg_mask].copy()

    # ── PCA: arpack, sparse implicit centering, float32, sign canonicalized (INV-5) ──
    progress("pca", 68, f"PCA (arpack, {n_pcs_req} comps)")
    max_comps = max(1, min(n_cells, n_hvg_selected) - 1)
    n_pcs_eff = int(min(n_pcs_req, max_comps))
    sc.pp.pca(adata_hvg, n_comps=n_pcs_eff, svd_solver="arpack", zero_center=True,
              dtype="float32", random_state=seed)
    x_pca = np.asarray(adata_hvg.obsm["X_pca"], dtype=np.float32)
    loadings = np.asarray(adata_hvg.varm["PCs"], dtype=np.float64)  # genes × n_pcs

    # Deterministic sign convention (INV-5): each component's sign is fixed so its
    # largest-magnitude LOADING is positive. Recorded so the choice is inspectable and a
    # re-run reproduces identical signs.
    sign_convention = "loadings_max_abs_positive"
    for j in range(x_pca.shape[1]):
        col = loadings[:, j]
        if col.size == 0:
            continue
        s = np.sign(col[int(np.argmax(np.abs(col)))])
        if s < 0:
            x_pca[:, j] *= -1.0
            loadings[:, j] *= -1.0

    # ── aligned_to: the source dataset's row-space digest (ITEM-26), when available ──
    aligned_to = None
    cells_index_path = S.slot_path(slots, "cells_index")
    if cells_index_path is not None:
        keys = S.read_column_values(cells_index_path, "cells_index")
        # The key artifact spans the FULL dataset; a filtered run's embedding lives in the
        # SURVIVING row space, so digest the subset (INV-12 — the row space IS the survivors),
        # never the pre-filter sequence.
        if len(keys) == n_cells_in:
            if filter_applied:
                keys = [keys[i] for i in keep_idx.tolist()]
            aligned_to = cyto_columns.axis_key_digest(pd.Series([str(k) for k in keys]))

    # ── write the PCA embedding artifact (INV-1 — an `embedding`, never a matrix) ─────
    progress("write", 82, "writing the PCA embedding")
    rel = "embeddings/X_pca.zarr"
    emb_structure, emb_meta = cyto_columns.write_embedding(
        outputs_dir, rel, x_pca, axis="cells", name=emb_name, kind="embedding",
        method="pca", aligned_to=aligned_to)
    # DEC-5 provenance: our PCA latent is NOT batch-corrected.
    emb_meta.update({
        "correction": "none",          # {none, harmony, unattested} — DEC-5
        "derived_from": "expression",  # ITEM-25(a)
        "n_pcs": n_pcs_eff,
        "sign_convention": sign_convention,
    })
    # ITEM-25 / F2: stamp the correction + method into the ARTIFACT's `attributes.cyto` (not
    # only the manifest meta) so the bit survives the hop into analysis 2 and the clustering
    # package, both of which read it back off the embedding's `attributes.cyto`.
    S.stamp_cyto_attributes(outputs_dir / rel, emb_structure, correction="none", method="pca")
    entries = [S.output_entry("embedding:X_pca", S.DT_EMBEDDING, rel, "artifact",
                              structure=emb_structure, meta=emb_meta)]

    # ── optional Harmony batch correction over the PCA embedding (ITEM-20a / INV-22) ──
    # A THIRD `embedding` (`method="harmony"`), never an expression matrix (INV-1). The
    # harmonypy VERSION is pinned (recorded here + matched against the Dockerfile pin) and
    # EVERY Harmony parameter is passed EXPLICITLY, `theta` first — never harmonypy's
    # version-unstable default (INV-22, doc-09 §B.2.5). When on, this corrected
    # representation is the one neighbours/UMAP run on downstream (recorded as
    # `primary_embedding`); the uncorrected PCA embedding is still emitted alongside it.
    harmony_info = None
    primary_embedding = "pca"
    if integration == "harmony":
        n_batches = len({str(v) for v in batch_values}) if batch_values is not None else 0
        if n_batches < 2:
            S.fail(
                f"integration=`harmony` needs at least 2 distinct batch categories on "
                f"{batch_column_name!r}, but the bound column has {n_batches}. Harmony has "
                "nothing to correct against a single group; re-run with `integration: none`."
            )
        progress("harmony", 88, "Harmony batch correction")
        z_harmony, harmony_params, harmonypy_version = S.run_harmony(
            harmony_mod, x_pca, batch_values, seed)
        rel_h = f"embeddings/{harmony_name}.zarr"
        h_structure, h_meta = cyto_columns.write_embedding(
            outputs_dir, rel_h, z_harmony, axis="cells", name=harmony_name,
            kind="embedding", method="harmony", aligned_to=aligned_to)
        h_meta.update({
            "correction": "harmony",       # DEC-5 — batch-corrected
            "derived_from": "expression",  # ITEM-25(a)
            "method": "harmony",
            "harmony_theta": harmony_params["theta"],   # the EXPLICIT theta (INV-22)
            "harmony_params": harmony_params,
            "harmonypy_version": harmonypy_version,
            "batch_factor": batch_column_name,
            "n_pcs": n_pcs_eff,
            "sign_convention": sign_convention,
        })
        # ITEM-25 / F2: the batch-correction bit must survive onto the ARTIFACT, not just the
        # manifest meta — so a Harmony embedding read downstream reports `harmony`, never
        # `unattested`.
        S.stamp_cyto_attributes(outputs_dir / rel_h, h_structure, correction="harmony", method="harmony")
        entries.append(S.output_entry(
            f"embedding:{harmony_name}", S.DT_EMBEDDING, rel_h, "artifact",
            structure=h_structure, meta=h_meta))
        harmony_info = {
            "harmonypy_version": harmonypy_version,
            # The DECLARED requirement, rendered as what it is. Keyed `harmonypy_pin`
            # because that is the key this report has always carried and readers parse;
            # its VALUE is the exact version while the declaration is exact, and the
            # range text if it is ever widened — never a range disguised as a pin.
            "harmonypy_pin": S.harmonypy_pin(),
            "harmonypy_requirement": S.harmonypy_requirement(),
            "parameters": harmony_params,      # theta first, all explicit
            "theta": harmony_params["theta"],
            "batch_factor": batch_column_name,
            "output_name": harmony_name,
        }
        primary_embedding = "harmony"

    # ── the provenance report (report/qc, meta.kind embedding-report) — INV-7/13 ─────
    progress("report", 94, "provenance report")
    versions = _library_versions()
    hvg_gene_indices = np.nonzero(hvg_mask)[0].tolist()
    report = {
        "kind": "embedding-report",
        "analysis": "embedding.reduce",
        "n_cells": n_cells,
        "n_genes": n_genes,
        "surviving_cells": surviving,
        # OD-3 / ITEM-24 — the inline filter, per dataset: cells-in, cells-kept, and the
        # EXACT predicate applied per column. `applied: false` (with cells_in == cells_kept)
        # is the honest no-filter record, not an omission.
        "filter": {
            "applied": filter_applied,
            "cells_in": n_cells_in,
            "cells_kept": surviving,
            "criteria": criteria,           # the recipe the mask actually ran on
            "columns": filter_columns,      # per-column kind + exact predicate + kept count
        },
        # every parameter ACTUALLY used (INV-7)
        "parameters": {
            "n_hvg_requested": n_hvg,
            "n_hvg_effective": n_hvg_eff,
            "n_hvg_selected": n_hvg_selected,
            "n_pcs_requested": n_pcs_req,
            "n_pcs_effective": n_pcs_eff,
            "seed": seed,
            "integration": integration,
            "normalization": "normalize_total(target_sum=None) + log1p",
            "scaled": False,          # INV-4 — recorded as the CHOICE (INV-13)
            "regressed_out": False,   # INV-4
            "hvg_flavor": "seurat_v3",
            "hvg_on": "raw_counts",
            "pca_svd_solver": "arpack",
            "pca_dtype": "float32",
            "pca_zero_center": True,
        },
        "batch": {
            "column": batch_column_name if batch_values is not None else None,
            "used_as_hvg_batch_key": batch_values is not None,  # INV-15
        },
        # INV-5 — the PCA sign convention, recorded.
        "pca_sign_convention": sign_convention,
        # INV-7 — library versions (only knowable at run time; rootfs pins nothing).
        "library_versions": versions,
        # INV-11 — the six thread vars, read out of THIS running process (TEST-15).
        "thread_pins": S.resolved_thread_env(),
        # INV-10 — float64 gene statistics (a sample; the full arrays are large).
        "gene_stats": {
            "accumulator_dtype": "float64",
            "n_genes": n_genes,
            "mean_first8": [float(x) for x in gene_means[:8]],
            "variance_first8": [float(x) for x in gene_variances[:8]],
        },
        "hvg_gene_indices": hvg_gene_indices[:200],
        "hvg_gene_indices_total": len(hvg_gene_indices),
        # DEC-5 provenance of the RUN's primary embedding: `harmony` when integration is on
        # (the corrected representation neighbours/UMAP run on downstream), else `none`.
        "correction": "harmony" if integration == "harmony" else "none",
        "primary_embedding": primary_embedding,
        # INV-22 — the Harmony provenance: the resolved+pinned harmonypy version and every
        # EXPLICIT parameter (theta first). Absent when integration is off.
        "harmony": harmony_info,
        "ceiling": ceiling,
        "warnings": [],
    }
    if n_pcs_eff < n_pcs_req:
        report["warnings"].append(
            f"requested {n_pcs_req} PCs but only {n_pcs_eff} are computable from "
            f"{n_cells} cells × {n_hvg_selected} HVGs"
        )
    (outputs_dir / "embedding-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.output_entry(
        "embedding-report", S.DT_REPORT_QC, "embedding-report.json", "artifact",
        structure=cyto_columns.opaque("application/json"),
        meta={"kind": "embedding-report", "n_cells": n_cells,
              "correction": "harmony" if integration == "harmony" else "none"}))

    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{n_cells} cells → {n_pcs_eff}-D PCA embedding")
    print(f"embedding.reduce: {n_cells} cells × {n_genes} genes → {n_hvg_selected} HVGs → "
          f"{n_pcs_eff}-D PCA embedding", file=__import__("sys").stderr)


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

    Memoized in `cyto_deps`, so this and the manifest-write hook resolve once and cannot
    disagree about what ran.
    """
    return cyto_deps.resolve_and_check()["libraries"]


if __name__ == "__main__":
    main()
