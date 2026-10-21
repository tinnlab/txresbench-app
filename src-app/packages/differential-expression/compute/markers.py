#!/usr/bin/env python3
# ruff: noqa
"""de.markers — DESCRIPTIVE marker scan over ANY categorical grouping (ITEM-4/ITEM-5).

Reads a `single-cell/expression` (raw counts) matrix + a categorical `metadata-column` grouping
and ranks each group's marker genes against the rest — a DESCRIPTIVE ranking of effect size +
detection rates, with NO p-value headlined (INV-4). Because a matrix-derived grouping was
defined from the same cells the markers are computed on, between-group p-values are circular
(double dipping); the padj column is ABSENT, not 1 (INV-3). The `MARKER_DISCLOSURE` states why.

## The banded gene-major read (INV-9)

The matrix is read in gene-major BANDS (contiguous gene columns), never `read_csc`-ing the whole
thing into one dense array. A first banded pass accumulates per-cell library sizes; a second
banded pass normalizes each gene column (CPM + log1p, DEC-17) and scores it per group via a
`(gene, group)` accumulation. Per-group mean/variance accumulate in float64 (0.29% float32 error
at 10^7 values would move a fold-change). The ceiling is re-checked BEFORE the read (INV-9).

Emits ONE `de/result` per group (each group vs the rest — DEC-13) PLUS one run `report/qc`
index (ITEM-17). p/padj members are OMITTED (INV-3/INV-4); the recorded method is read back.
"""
import _shared as S  # FIRST — pins the determinism env before numpy/scanpy load

import cyto_deps
import json

import numpy as np

import _regime as R
import _methods as METH

# ── INPUT SLOTS (resolved out of `/inputs/inputs.json`, never a filename suffix) ────────
EXPRESSION_SLOT = "expression"
GROUPING_SLOT = "grouping"

#: The double-dipping disclosure — single-sourced (mirrors clustering `MARKER_DISCLOSURE`).
MARKER_DISCLOSURE = (
    "These per-group marker genes are DESCRIPTIVE, not inferential. When the grouping was "
    "defined from the same cells the markers are computed on, the between-group p-values are "
    "anti-conservative BY CONSTRUCTION (double dipping / selection bias), and no downstream FDR "
    "correction repairs it. Read the markers as a RANKING that describes each group — never as "
    "evidence a group is real. Valid inference requires a SEPARATE, split-based analysis on data "
    "not used to define the groups."
)

#: The columns a marker artifact always writes (ranking + effect + detection). p/padj NEVER.
_BAND = 512


def _marker_method_ran(scanpy_method):
    """C4 — the HONEST name of the statistic the banded impl actually ran (not a scanpy version
    it never called), recorded in the artifact + report provenance."""
    return {"wilcoxon": "mann-whitney-u (tie-corrected, banded)",
            "t-test": "welch-t (banded)"}.get(scanpy_method, scanpy_method)


def _resolve_int(p, key, default, *, lo=1):
    try:
        v = int(p.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def _library_sizes(indptr, indices, data, n_cells, n_genes):
    """Per-cell total raw counts, accumulated BANDED (float64). One pass over gene columns,
    bincount-ing each column's data into the per-cell accumulator — never a dense matrix."""
    lib = np.zeros(n_cells, dtype=np.float64)
    for lo in range(0, n_genes, _BAND):
        hi = min(lo + _BAND, n_genes)
        a, b = int(indptr[lo]), int(indptr[hi])
        if b > a:
            rows = np.asarray(indices[a:b], dtype=np.intp)
            vals = np.asarray(data[a:b], dtype=np.float64)
            lib += np.bincount(rows, weights=vals, minlength=n_cells)[:n_cells]
    return lib


def _score_bands(indptr, indices, data, n_cells, n_genes, gene_names, codes, n_groups,
                 lib, scanpy_method):
    """Banded gene-major scoring (INV-9). For each gene band, densify the band's columns,
    normalize (CPM + log1p, DEC-17), and compute per-(gene, group-vs-rest) stats:
    ranking `score` (Wilcoxon z or Welch t), `log2fc`, detection `pct_1`/`pct_2`, `base_mean`,
    `n_1`/`n_2`. Returns `{group_code: [per-gene record, …]}` (all genes; the view/report rank).

    A `(gene, group)` composite accumulation is used for the group means via bincount on
    `codes`. float64 throughout."""
    import scipy.stats as sstats
    target = 1e4
    norm = np.where(lib > 0, target / lib, 0.0)  # per-cell CPM scale
    group_n = np.bincount(codes, minlength=n_groups)[:n_groups].astype(np.float64)
    total = float(n_cells)
    # accumulators per (gene, group)
    out = {g: [] for g in range(n_groups)}
    for lo in range(0, n_genes, _BAND):
        hi = min(lo + _BAND, n_genes)
        for j in range(lo, hi):
            a, b = int(indptr[j]), int(indptr[j + 1])
            col = np.zeros(n_cells, dtype=np.float64)
            if b > a:
                rows = np.asarray(indices[a:b], dtype=np.intp)
                col[rows] = np.asarray(data[a:b], dtype=np.float64)
            # DEC-17 — internal CPM normalization + log1p on the raw counts.
            lognorm = np.log1p(col * norm)
            detect = (col > 0).astype(np.float64)
            # per-(gene, group) sums (float64) via bincount on the group codes.
            s1 = np.bincount(codes, weights=lognorm, minlength=n_groups)[:n_groups]
            dsum = np.bincount(codes, weights=detect, minlength=n_groups)[:n_groups]
            grand = float(lognorm.sum())
            base_mean = grand / total if total else 0.0
            # Precompute ranks ONCE per gene (Wilcoxon), reused for every group-vs-rest.
            if scanpy_method == "wilcoxon":
                ranks = sstats.rankdata(lognorm)
                # C4 — the tie-correction factor `1 − Σ(t³−t)/(N³−N)` over ALL tie groups of this
                # gene, where the ZERO block (the ~90%+ of cells with no count) is the dominant
                # tied group — the sparsity-aware Wilcoxon variance doc-13 §6 calls for.
                N = float(total)
                _, tie_counts = np.unique(lognorm, return_counts=True)
                tie_sum = float(np.sum(tie_counts.astype(np.float64) ** 3
                                       - tie_counts.astype(np.float64)))
                tie_factor = (1.0 - tie_sum / (N ** 3 - N)) if N > 1 else 1.0
            for g in range(n_groups):
                ng = group_n[g]
                if ng <= 0:
                    continue
                mean_in = s1[g] / ng
                n_rest = total - ng
                mean_out = (grand - s1[g]) / n_rest if n_rest > 0 else 0.0
                log2fc = float((mean_in - mean_out) / np.log(2.0))
                pct_1 = float(dsum[g] / ng)
                pct_2 = float((detect.sum() - dsum[g]) / n_rest) if n_rest > 0 else 0.0
                if scanpy_method == "wilcoxon":
                    in_mask = codes == g
                    rank_sum_in = float(ranks[in_mask].sum())
                    # Mann-Whitney U + normal approximation z-score. C4 — the variance is
                    # TIE-CORRECTED by `tie_factor` (multiply the untied variance); the zero
                    # block dominates in sparse scRNA, so this materially changes the z.
                    U = rank_sum_in - ng * (ng + 1) / 2.0
                    mu = ng * n_rest / 2.0
                    sigma = (np.sqrt(ng * n_rest * (ng + n_rest + 1) / 12.0 * tie_factor)
                             if n_rest > 0 else 1.0)
                    score = float((U - mu) / sigma) if sigma > 0 else 0.0
                else:  # t-test (Welch), computed from group vs rest means/vars in float64.
                    s2 = np.bincount(codes, weights=lognorm * lognorm,
                                     minlength=n_groups)[:n_groups]
                    var_in = max(s2[g] / ng - mean_in * mean_in, 0.0)
                    sq_out = (float((lognorm * lognorm).sum()) - s2[g])
                    var_out = max(sq_out / n_rest - mean_out * mean_out, 0.0) if n_rest > 0 else 0.0
                    denom = np.sqrt(var_in / ng + (var_out / n_rest if n_rest > 0 else 0.0))
                    score = float((mean_in - mean_out) / denom) if denom > 0 else 0.0
                out[g].append({
                    "gene": str(gene_names[j]), "score": score, "log2fc": log2fc,
                    "base_mean": base_mean, "pct_1": pct_1, "pct_2": pct_2,
                    "n_1": float(ng), "n_2": float(n_rest),
                })
    return out


def main():
    S.set_prefix("de.markers")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)

    seed = _resolve_int(p, "seed", 0, lo=0)
    method_key = str(p.get("method") or METH.MARKER_DEFAULT)
    base_name = str(p.get("name") or "markers")
    method = METH.resolve_marker_method(method_key, S.fail)

    progress = S.progress
    progress("resolve", 3, "resolving inputs")
    expr = S.slot_entry(slots, EXPRESSION_SLOT)
    if expr is None:
        S.fail("no `expression` input bound — de.markers needs a `single-cell/expression` "
               "(counts) matrix to scan markers from")
    grp = S.slot_entry(slots, GROUPING_SLOT)
    if grp is None:
        S.fail("no `grouping` column bound — de.markers needs a categorical `metadata-column` "
               "to group cells by (a clustering, an annotation, a condition)")

    # ── CEILING GATE — before a byte of the matrix is read (INV-9) ──────────────────
    progress("preflight", 6, "checking the resource envelope")
    structure, n_cells, n_genes, nnz, gene_names = S.read_expression_structure(
        expr["path"], EXPRESSION_SLOT)
    ceiling = S.ceiling_refuse_if_over(nnz)

    grouping = S.read_column_values(grp["path"], GROUPING_SLOT)
    if len(grouping) != n_cells:
        S.fail(f"the grouping column holds {len(grouping)} values but the matrix declares "
               f"{n_cells} cells — they are not the same cells axis")
    provenance = S.column_provenance(grp["path"])
    # M4 — a marker scan is ALWAYS descriptive (it never emits p), so its regime is R2 for EVERY
    # grouping provenance (external or matrix-derived) — matching the hardcoded R2 callout. The
    # classifier's R3 "unreplicated" verdict is a de.compare concern (a p-emitting path); markers
    # has no p to withhold, so stamping R3 here only mislabels the artifact.
    regime = R.R2
    method_ran = _marker_method_ran(method["scanpy_method"])

    levels = sorted(set(grouping), key=lambda x: (len(x), x))
    if len(levels) < 2:
        S.fail(f"only {len(levels)} group in the grouping column — a marker scan needs ≥2 "
               "groups to contrast each against the rest; no marker table is fabricated.")
    code_of = {lv: i for i, lv in enumerate(levels)}
    codes = np.asarray([code_of[g] for g in grouping], dtype=np.intp)

    progress("read", 20, f"banded gene-major read ({n_genes} genes)")
    indptr, indices, data = S.read_expression_csc(expr["path"])
    lib = _library_sizes(indptr, indices, data, n_cells, n_genes)
    progress("score", 55, f"scoring markers ({method['scanpy_method']})")
    per_group = _score_bands(indptr, indices, data, n_cells, n_genes, gene_names, codes,
                             len(levels), lib, method["scanpy_method"])

    # ── write ONE de/result per group (each group vs rest — DEC-13); p ABSENT (INV-3/4) ──
    progress("write", 82, "writing per-group marker tables")
    entries = []
    comparisons = []
    # M2 — the SOURCE heading every row of this run groups under (mockup: "leiden · markers
    # (Wilcoxon)"). One producer invocation = one source, so a run's rows share one heading.
    source_group = f"markers · {method['label']}"
    for g, lv in enumerate(levels):
        recs = per_group[g]
        # KEEP the dataset's gene-axis ORDER across every comparison (so all de/result
        # artifacts of a run share ONE gene key sequence — the conformance gate requires it).
        # The ranking is carried by the `score` COLUMN, which the view/report sorts by; no
        # genes are dropped or padded (INV-7).
        gnames = [r["gene"] for r in recs]
        cols = {
            "score": np.array([r["score"] for r in recs]),
            "logFC": np.array([r["log2fc"] for r in recs]),
            "base_mean": np.array([r["base_mean"] for r in recs]),
            "pct_1": np.array([r["pct_1"] for r in recs]),
            "pct_2": np.array([r["pct_2"] for r in recs]),
            "n_1": np.array([r["n_1"] for r in recs]),
            "n_2": np.array([r["n_2"] for r in recs]),
        }
        name = f"{base_name}:{lv}_vs_rest"
        rel = f"columns/{base_name}_{g}.zarr"
        cmp_attrs = {"comparison": f"{lv} vs rest", "group": str(lv),
                     "method": method["key"], "method_ran": method_ran,
                     "preprocessing": "normalize_total(1e4)+log1p", "analysis": "de.markers",
                     "descriptive": True, "is_inference": False,
                     "pvalues_omitted": True, "disclosure": MARKER_DISCLOSURE}
        _st, meta = S.write_de_result(
            outputs_dir, rel, name, gnames, cols, regime=regime,
            multiplicity_family="none (descriptive; no p headlined)", extra_attrs=cmp_attrs)
        entries.append(S.output_entry(f"de/result:{name}", S.DT_DE_RESULT, rel, "artifact",
                                      structure=_st, meta=meta))
        # M1/M2 — the comparison row as the Visualize `entry_list` renders it: `key` (identity,
        # else the row is dropped), `label` (the row name), `qualifier` = REGIME (a
        # renderer-supported inline distinguisher — visible where the unsupported `badge` was
        # not), and `group` = the source heading the rows render under.
        comparisons.append({"id": f"de/result:{name}", "key": f"de/result:{name}",
                            "name": name, "label": cmp_attrs["comparison"],
                            "comparison": cmp_attrs["comparison"], "qualifier": regime,
                            "group": source_group, "source_group": source_group,
                            "group_label": str(lv), "regime": regime, "n_genes": len(gnames)})

    # ── run report/qc index (ITEM-17) ──────────────────────────────────────────────
    progress("report", 94, "run report")
    report = {
        "kind": "de-report", "analysis": "de.markers", "product": "marker-scan",
        "regime": regime, "regime_note": R.regime_note(regime),
        "method": method["key"], "method_ran": method_ran,
        "methods_available": [m["key"] for m in METH.marker_catalog()],
        "grouping_levels": levels, "n_cells": int(n_cells), "n_genes": int(n_genes),
        "seed": seed, "descriptive": True, "is_inference": False,
        "pvalues_written": False, "disclosure": MARKER_DISCLOSURE,
        "multiplicity_family": "none (descriptive; no p headlined)",
        # M2 — the source groups the Visualize `entry_list` renders under (one per run) + the
        # `grouped` flag it binds. `count` is the number of comparison rows in this group.
        "comparisons": comparisons, "grouped": True,
        "groups": [{"name": source_group, "count": len(comparisons)}], "dropped": [],
        "grouping_provenance": provenance if isinstance(provenance, dict) else {},
        "preprocessing": "normalize_total(1e4)+log1p (DEC-17)",
        "determinism_env": S.resolved_determinism_env(), "ceiling": ceiling,
        "library_versions": _library_versions(),
    }
    (outputs_dir / "de-report.json").write_text(json.dumps(report, indent=2))
    import cyto_columns
    entries.append(S.output_entry("de-report", S.DT_REPORT_QC, "de-report.json", "artifact",
                                  structure=cyto_columns.opaque("application/json"),
                                  meta={"kind": "de-report", "analysis": "de.markers",
                                        "n_comparisons": len(comparisons)}))
    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{len(levels)} groups → {len(comparisons)} marker tables")


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
