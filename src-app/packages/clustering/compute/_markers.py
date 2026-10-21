#!/usr/bin/env python3
# ruff: noqa
"""_markers — DESCRIPTIVE per-cluster marker genes (Stage B, ITEM-5 / ITEM-8 / DEC-3/DEC-4).

After `clustering.cluster` has partitioned an embedding into cluster labels, this pass reads
the dataset's expression matrix and describes what each cluster expresses — the J1a payoff
("what defines a cluster"). It runs `sc.tl.rank_genes_groups(method='wilcoxon', tie_correct=
True, pts=True)` — `method='wilcoxon'` set EXPLICITLY (scanpy's SILENT default is `t-test`;
a v1 that inherits it ships the wrong test — DEC-3) and the ACTUAL method scanpy ran is read
back out of `adata.uns` and recorded, so the record cannot lie about which test ran.

## The load-bearing invariant — CL-INV-1 (double dipping, doc 10 §4)

The markers are **DESCRIPTIVE, NOT inferential**. The clusters were defined from the SAME
cells the markers are computed on, so the clustering optimiser — which maximises
between-group separation — has already falsified the null the marker test assumes. Between-
cluster p-values / FDR are therefore **anti-conservative by construction** (double dipping /
selection bias). This module NEVER headlines a `pvals_adj`/FDR as a discovery: the emitted
marker records carry a ranking `score` + effect size + expression fractions, and the raw
scanpy p-values are DROPPED from the emitted markers, not surfaced as evidence. The report
carries the circularity disclosure verbatim (`MARKER_DISCLOSURE`). Valid inference is a
separate, split-based analysis (count-splitting / ClusterDE / selective inference), named in
the output when applied — never this pass.

Per-cluster mean/variance summaries accumulate in **float64** (INV-9 / ITEM-8): naive
float32 accumulation reaches 0.29% error at 10⁷ values, which is a real distortion of a
fold-change. `cluster_mean_var` is the single float64 accumulator and it is the production
path (called for every emitted top marker), so the TEST-9 anchor tests the real code.
"""
from __future__ import annotations

import numpy as np


# ── CL-INV-1 — the circularity disclosure, lifted from doc 10 §4 (§4.1/§4.2/§4.3/§4.5) ──
#
# It carries the three things the invariant requires: (a) the markers are DESCRIPTIVE, not
# inference; (b) the selection-bias / circularity mechanism (clusters defined from the same
# cells the markers are tested on → the null is already falsified → p-values are inflated /
# anti-conservative by construction); (c) that valid inference is a SEPARATE, split-based
# analysis, never this pass. The middle sentence is the Single-Cell-Best-Practices wording
# doc 10 §4.3 quotes; the framing is §4.1's one-sentence mechanism + §4.5(1)'s "read it as a
# ranking, not evidence".
MARKER_DISCLOSURE = (
    "These per-cluster marker genes are DESCRIPTIVE, not inferential. The clusters were "
    "defined from the same cells the markers are computed on, so the clustering algorithm — "
    "an optimiser that maximises between-group separation — has already falsified the null "
    "hypothesis (\"these groups have equal means\") that a between-cluster test assumes. "
    "Because the definition of the clusters is based on the same data used for these "
    "statistical tests, the p-values of these tests will be inflated: between-cluster "
    "p-values / FDR are anti-conservative BY CONSTRUCTION (double dipping / selection bias), "
    "and no downstream FDR correction repairs it. Read the markers as a RANKING that "
    "describes each cluster — never as evidence that a cluster is real, and never as a "
    "discovery claim. Valid inference requires a SEPARATE, split-based analysis "
    "(count-splitting / ClusterDE / selective inference) on data not used to define the "
    "clusters, and is named in the output when applied; it is not this pass."
)

#: The scanpy default this pass deliberately OVERRIDES (DEC-3). Recorded so a reviewer can
#: see WHAT was avoided, and so a mutation that lets the default stand is legible.
_SCANPY_RANK_DEFAULT_METHOD = "t-test"
MARKER_METHOD = "wilcoxon"

#: Keys that would turn a descriptive marker record into an inference claim if headlined.
#: Emitted markers must carry NONE of these — the raw scanpy p-values are dropped. Kept here
#: as the single source of truth the guard (and the acceptance test) reads.
INFERENTIAL_KEYS = ("pvals", "pvals_adj", "padj", "fdr", "qval", "qvals", "pvalue", "p_value")


def cluster_mean_var(values, codes, n_clusters):
    """Per-cluster mean + (population) variance of one gene's per-cell `values`, accumulated
    in **float64** (INV-9 / ITEM-8). Naive float32 accumulation of a 10⁷-value column reaches
    0.29% error — enough to move a fold-change — so every per-cluster mean/variance in the
    marker summary lands here. Returns `(means, variances)`, each a length-`n_clusters`
    float64 array; an empty cluster is `(nan, nan)` (never a fabricated 0).

    Uses the sum / sum-of-squares identity in float64: `E[x²] - E[x]²`, clamped at 0 so a
    catastrophic-cancellation round-off can never emit a negative variance.
    """
    values = np.asarray(values, dtype=np.float64)          # float64 — the whole point
    codes = np.asarray(codes, dtype=np.intp)
    n = int(n_clusters)
    counts = np.bincount(codes, minlength=n)[:n].astype(np.float64)
    s1 = np.bincount(codes, weights=values, minlength=n)[:n].astype(np.float64)
    s2 = np.bincount(codes, weights=values * values, minlength=n)[:n].astype(np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        means = np.where(counts > 0, s1 / counts, np.nan)
        var = np.where(counts > 0, s2 / counts - means * means, np.nan)
    var = np.where(np.isnan(var), np.nan, np.maximum(var, 0.0))
    return means, var


def _dense_gene_column(indptr, indices, data, j, n_cells):
    """Materialise ONE gene column (`(n_cells,)` dense float64) out of the CSC trio — the
    columns are the genes, so column `j` is `indices[indptr[j]:indptr[j+1]]` → `data[…]`."""
    col = np.zeros(n_cells, dtype=np.float64)
    lo, hi = int(indptr[j]), int(indptr[j + 1])
    if hi > lo:
        col[np.asarray(indices[lo:hi], dtype=np.intp)] = np.asarray(data[lo:hi], dtype=np.float64)
    return col


def compute_markers(indptr, indices, data, n_cells, n_genes, labels, levels, *,
                    gene_names=None, n_top=25):
    """DESCRIPTIVE per-cluster markers from the CSC expression trio + the cluster labels.

    `labels` is the per-cell cluster label (str), `levels` the sorted level set. Returns a
    dict folded into the `report/qc` clustering-report under `markers`. When there is only
    ONE cluster, rank_genes_groups has nothing to contrast, so markers are skipped with a
    recorded reason (never a fabricated contrast).

    The emitted per-cluster records carry a ranking `score`, an effect size (`log2fc`),
    expression fractions (`pct_in`/`pct_out`) and a float64 `mean_expression` — and NO
    p-value/FDR (INFERENTIAL_KEYS are dropped). `descriptive`/`is_inference` +
    `MARKER_DISCLOSURE` state plainly what the numbers are (CL-INV-1).
    """
    import scanpy as sc
    import anndata as ad
    import scipy.sparse as sp
    import pandas as pd

    levels = list(levels)
    n_clusters = len(levels)
    code_of = {lv: i for i, lv in enumerate(levels)}
    codes = np.asarray([code_of[str(v)] for v in labels], dtype=np.intp)

    base = {
        "method": MARKER_METHOD,             # DEC-3 — the EXPLICIT choice…
        "method_requested": MARKER_METHOD,
        "scanpy_default_avoided": _SCANPY_RANK_DEFAULT_METHOD,  # …and what it overrides.
        "tie_correct": True,                 # DEC-3 — recorded
        "pts": True,                         # DEC-3 — recorded
        "descriptive": True,                 # CL-INV-1
        "is_inference": False,               # CL-INV-1 — NEVER an inference claim
        "n_top": int(n_top),
        "disclosure": MARKER_DISCLOSURE,     # CL-INV-1 — the circularity sentence, verbatim
        "accumulator_dtype": "float64",      # INV-9 / ITEM-8
        "pvalues_omitted": True,
        "pvalues_omitted_reason": (
            "between-cluster p-values / FDR from a cluster-then-test workflow are anti-"
            "conservative by construction (double dipping); they are dropped rather than "
            "headlined as a discovery (CL-INV-1, doc 10 §4)."
        ),
    }

    if n_clusters < 2:
        base.update({
            "computed": False,
            "skipped_reason": (
                f"only {n_clusters} cluster — rank_genes_groups needs ≥2 groups to contrast; "
                "no marker table is fabricated for a single group."
            ),
            "per_cluster": {},
        })
        return base

    gene_names = ([str(g) for g in gene_names] if gene_names is not None
                  else [f"gene{j}" for j in range(n_genes)])

    # ── build the AnnData: cells × genes, log-normalized for the ranking ──────────────
    X = sp.csc_matrix((np.asarray(data, dtype=np.float32),
                       np.asarray(indices), np.asarray(indptr)),
                      shape=(int(n_cells), int(n_genes))).tocsr()
    adata = ad.AnnData(X=X)
    adata.var_names = pd.Index(gene_names)
    adata.obs["_cluster"] = pd.Categorical([str(v) for v in labels], categories=levels)

    # Standard descriptive preprocessing for a rank test (recorded, not silent).
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    preprocessing = "normalize_total(target_sum=1e4)+log1p"

    sc.tl.rank_genes_groups(
        adata, groupby="_cluster", method=MARKER_METHOD,
        tie_correct=True, pts=True, n_genes=int(n_top), key_added="_markers")

    res = adata.uns["_markers"]
    # INV / DEC-3 — record the method scanpy ACTUALLY ran, not merely what we meant to pass.
    # If a mutation dropped `method=` and scanpy fell back to its `t-test` default, this
    # reads back `t-test` and the record (and the acceptance test) catches it.
    method_ran = str((res.get("params") or {}).get("method") or "")
    base["method_ran"] = method_ran
    base["preprocessing"] = preprocessing

    names = res["names"]
    scores = res["scores"]
    lfc = res["logfoldchanges"]
    pts = res.get("pts")

    per_cluster = {}
    for gi, lv in enumerate(levels):
        top = []
        col_names = np.asarray(names[lv]).tolist()
        col_scores = np.asarray(scores[lv]).tolist()
        col_lfc = np.asarray(lfc[lv]).tolist()
        for rank, gene in enumerate(col_names):
            # float64 per-cluster mean expression for THIS gene (INV-9 production caller).
            j = adata.var_names.get_loc(gene)
            gcol = _dense_gene_column(indptr, indices, data, int(j), int(n_cells))
            means, _var = cluster_mean_var(gcol, codes, n_clusters)
            pct_in = pct_out = None
            if pts is not None:
                # pts is a per-cluster DataFrame indexed by gene → fraction expressing.
                try:
                    pct_in = float(pts[lv].loc[gene])
                except Exception:
                    pct_in = None
            rec = {
                "gene": str(gene),
                "rank": rank,
                "score": float(col_scores[rank]),        # the RANKING statistic (not a p-value)
                "log2fc": float(col_lfc[rank]),           # effect size
                "mean_expression": float(means[gi]),      # float64 accumulator (INV-9)
                "pct_in": pct_in,                         # expression fraction in-cluster
            }
            top.append(rec)
        per_cluster[str(lv)] = top

    base.update({"computed": True, "per_cluster": per_cluster, "n_clusters": n_clusters})
    return base
