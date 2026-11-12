#!/usr/bin/env python3
# ruff: noqa
"""seed_multimodal — the REAL multi-modal ingest reader, run over a real CITE-seq
.h5ad to stage a `single-cell/multimodal` dataset for the joint-drop e2e (TEST-E5).

This is NOT a mock: it imports the SAME `multimodal.py` kernels the production
`anndata-import` converter composes (`split_by_feature_types`, `modality_prefixed`,
`modality_datatype`, `align_barcodes`, `is_raw_counts`, `detect_isotype_controls`)
and runs them over a genuine 10x CITE-seq matrix (Gene Expression + Antibody
Capture). It derives per-modality QC metrics (total_counts / n_features) into the
SHARED obs, `modality:`-prefixed (MULTIMODAL_qc_metrics.md §4 — every modality
independently produces `total_counts`, so a shared-obs metric MUST be prefixed or the
modalities clobber). The joint-drop invariant (DEC-27) is that this obs is ONE row per
cell across all modalities, so a criterion on any modality's column drops the whole cell.

Writes a `report/qc` obs.json, a `single-cell/multimodal` container.json, and ONE
one-column JSON table per metric — each with the `structure` (axis + member) and `meta`
(display name) a real `metadata-column` producer declares, so the columns land on the
SHARED AXIS and the filter surface's `axis_columns` slice can see them. The Rust debug
seed route catalogs each via the SAME `insert_opaque_artifact` path the RNA seed uses.
"""
import json, os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import anndata as ad
from scipy import sparse
import multimodal as mm  # the REAL reader kernels


# The axis every modality's per-row metrics are aligned to — the ONE place this driver
# spells it, so the container's index name and each column's declaration cannot drift apart.
SHARED_AXIS = "cells"


def _sanitize(name):
    return re.sub(r"[^0-9A-Za-z_]+", "_", str(name)).strip("_") or "col"


def main():
    h5ad, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    adata = ad.read_h5ad(h5ad)
    n = int(adata.n_obs)
    barcodes = [str(b) for b in adata.obs_names]
    var_names = [str(v) for v in adata.var_names]

    ft_col = adata.var["feature_types"].astype(str).values if "feature_types" in adata.var.columns else None
    if ft_col is None:
        raise SystemExit("seed_multimodal: fixture has no var['feature_types'] — not a multi-modal 10x matrix")

    # REAL READER: lossless split of the combined feature-barcode matrix by feature_types (INV-10).
    split = mm.split_by_feature_types(ft_col, var_names)
    if len(split.modalities) < 2:
        raise SystemExit(f"seed_multimodal: only {split.modalities} modality — need ≥2 (RNA+protein)")

    X = adata.X.tocsr() if sparse.issparse(adata.X) else sparse.csr_matrix(np.asarray(adata.X))

    # Shared obs (ONE row per cell across every modality — the joint-drop axis, DEC-27).
    obs = {"id": barcodes, "ident": ["sampleA" if i % 2 == 0 else "sampleB" for i in range(n)]}
    metric_columns = {}   # name -> list[float] (continuous, materialized as metadata-column blobs)
    modality_links = []

    for mod in split.modalities:
        cols = split.columns[mod]
        smat = X[:, cols]
        # INV-11: refuse a normalized/scaled modality written as raw (raises on non-integer/neg).
        mm.assert_not_normalized(mod, smat.data if smat.nnz else np.array([0.0]))
        # REAL per-modality QC metrics over the shared cells (row-wise over this modality's columns).
        total = np.asarray(smat.sum(axis=1)).ravel().astype(float)
        nfeat = np.asarray((smat > 0).sum(axis=1)).ravel().astype(float)
        # modality:-prefixed shared-obs columns (INV-12 / TEST-A12b) — the REAL `modality_prefixed`.
        tc = mm.modality_prefixed("total_counts", mod)
        nf = mm.modality_prefixed("n_features", mod)
        obs[tc] = total.tolist(); metric_columns[tc] = total.tolist()
        obs[nf] = nfeat.tolist(); metric_columns[nf] = nfeat.tolist()
        link = {
            "modality": mod,
            "datatype": mm.modality_datatype(mod),          # rna→single-cell/expression, prot→single-cell/protein
            "measurement": mm.measurement_name(mod),
            "feature_type": split.feature_type.get(mod),    # raw 10x provenance (INV-17)
            "n_vars": int(len(cols)),
            "nnz": int(smat.nnz),
        }
        # INV-14: isotype/control antibodies retained + flagged (never dropped) for a protein modality.
        if mod in ("prot", "adt"):
            iso = mm.detect_isotype_controls([var_names[i] for i in cols])
            link["isotype_controls"] = int(np.asarray(iso).sum())
        modality_links.append(link)

    # RNA %mito (real): fraction of RNA counts from MT- genes — a per-cell continuous obs metric.
    if "rna" in split.columns:
        rna_cols = split.columns["rna"]
        rna_names = [var_names[i] for i in rna_cols]
        mt_local = [j for j, nm in enumerate(rna_names) if nm.upper().startswith("MT-")]
        rna_mat = X[:, rna_cols].tocsr()
        rna_total = np.asarray(rna_mat.sum(axis=1)).ravel().astype(float)
        if mt_local:
            mt_counts = np.asarray(rna_mat[:, mt_local].sum(axis=1)).ravel().astype(float)
        else:
            mt_counts = np.zeros(n)
        pct = np.divide(mt_counts * 100.0, rna_total, out=np.zeros(n), where=rna_total > 0)
        col = mm.modality_prefixed("pct_mito", "rna")
        obs[col] = pct.tolist(); metric_columns[col] = pct.tolist()

    # Barcode alignment across modalities (INV-12/13) — identical shared axis here (10x combined).
    align = mm.align_barcodes({m: barcodes for m in split.modalities})

    container = {
        "container": "MuData",
        "modalities": split.modalities,
        "links": modality_links,
        "shared_cells": n,
        "cells_index": SHARED_AXIS + "_index",
        "barcode_mode": align.mode,
        "n_union": align.n_union,
        "source": "10x pbmc_1k_protein_v3 CITE-seq (subsampled 200 cells)",
    }

    # report/qc obs.json — the WRAPPED columnar slice the cell-filter surface reads (`$data.obs`).
    json.dump({"columns": list(obs.keys()), "n_cells": n, "obs": obs},
              open(os.path.join(outdir, "obs.json"), "w"))
    json.dump(container, open(os.path.join(outdir, "container.json"), "w"))

    # ── each metric column as its OWN artifact, ON THE SHARED AXIS ─────────────────────
    #
    # These used to be bare little-endian f32 blobs catalogued with NO declaration at all,
    # which is `opaque`: no axis, no members. Every axis-scoped resolver in the workbench
    # selects on exactly that pair (`structure.axis` + `structure.columns`), so the columns
    # were catalogued, were visible in the catalog, and were invisible to the criteria
    # builder — which reported "No options yet" with nothing failing anywhere. The same
    # correction the SIBLING single-file import driver beside this one already carries, for
    # the same reason and in the same shape: the seed engine catalogs a driver FILE and a Zarr
    # artifact is a DIRECTORY, so the bytes are re-framed as a one-column JSON table while
    # `structure` names the axis and member a real `txr_columns.write_metadata_column`
    # declares.
    #
    # They all name `SHARED_AXIS`, which is the whole claim of this fixture: every modality's
    # metrics are aligned to ONE row each, which is what makes a criterion on any one of them
    # drop the paired row everywhere (DEC-27).
    column_files, column_structures, column_meta = {}, {}, {}
    for name, vals in metric_columns.items():
        fn = "col_" + _sanitize(name) + ".json"
        json.dump({"columns": [name], name: [float(x) for x in vals]},
                  open(os.path.join(outdir, fn), "w"))
        column_files[name] = fn
        column_structures[name] = {
            "encoding": "opaque",
            "media_type": "application/json",
            "axis": SHARED_AXIS,
            "n": n,
            "columns": [{"name": name, "kind": "numeric"}],
        }
        column_meta[name] = {"name": name, "dtype": "float32", "n": n, "axis": SHARED_AXIS}

    json.dump({
        "n_cells": n,
        "modalities": split.modalities,
        "modality_links": modality_links,
        "obs_columns": list(obs.keys()),
        "metric_columns": list(metric_columns.keys()),
        "column_files": column_files,
        "column_structures": column_structures,
        "column_meta": column_meta,
    }, open(os.path.join(outdir, "manifest.json"), "w"))
    print("seed_multimodal OK:", split.modalities, "obs_cols=", list(obs.keys()))


if __name__ == "__main__":
    main()
