#!/usr/bin/env python3
# ruff: noqa
"""de.compare — INFERENTIAL condition comparison (ITEM-6/7/8/9/10/11).

Reads a `single-cell/expression` (RAW COUNTS, INV-13) matrix + a categorical grouping + a
sample/replicate column, and tests two groups against each other. The regime is decided by the
grouping column's PROVENANCE (INV-2), never the analysis:

  · matrix-derived grouping (double dipping) ⇒ R2 — ranked effects, p ABSENT (INV-6, never a p)
  · external + a sample column + ≥2 samples/side ⇒ R1 — pseudobulk (sample × group) → PyDESeq2 /
    NB-GLM → logFC / −log10 p / BH-padj (INV-5)
  · external + 1 sample/side ⇒ R3 — ranked effects, p ABSENT

Pseudobulk fixes REPLICATION and does NOTHING for SELECTION (INV-1), so a matrix-derived grouping
still yields NO p even when pseudobulk would run. Raw counts pass straight through (DESeq2
normalizes internally); no global pseudocount is added (D4). One `de/result` per comparison
(DEC-13) + one run `report/qc` (ITEM-17). `neglog10p` stored, never raw p (INV-8).
"""
import _shared as S  # FIRST — pins the determinism env before numpy load

import cyto_deps
import json

import numpy as np

import _regime as R
import _methods as METH
import _pseudobulk as PB

EXPRESSION_SLOT = "expression"
GROUPING_SLOT = "grouping"
SAMPLE_SLOT = "sample"

_BAND = 512


def _resolve_int(p, key, default, *, lo=0):
    try:
        v = int(p.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def _band_group_means(indptr, indices, data, n_cells, n_genes, gene_names, codes, n_groups, lib,
                      keep=None):
    """Banded gene-major per-group log-normalized mean + detection + base_mean (INV-9), for the
    ranked-effect (R2/R3) readout. float64. Returns per-gene arrays keyed by member.

    C1 — when `keep` (a per-cell boolean mask) is given, EVERY per-group readout is restricted to
    the kept cells: a >2-level contrast EXCLUDES the non-{g1,g2} cells rather than relabelling
    them into group 0. `group_n`, `total`/`base_mean`, and the per-band `s1`/`dd` accumulators all
    count only kept cells, so `means[:,0]`/`pct_1`/`base_mean`/`score` and the denominators are
    computed over ONLY the two contrast groups' cells."""
    target = 1e4
    norm = np.where(lib > 0, target / lib, 0.0)
    if keep is None:
        kept = np.ones(n_cells, dtype=np.float64)
        group_n = np.bincount(codes, minlength=n_groups)[:n_groups].astype(np.float64)
        total = float(n_cells)
    else:
        keep = np.asarray(keep, dtype=bool)
        kept = keep.astype(np.float64)
        group_n = np.bincount(codes[keep], minlength=n_groups)[:n_groups].astype(np.float64)
        total = float(keep.sum())
    means = np.zeros((n_genes, n_groups), dtype=np.float64)
    detect = np.zeros((n_genes, n_groups), dtype=np.float64)
    base = np.zeros(n_genes, dtype=np.float64)
    for lo in range(0, n_genes, _BAND):
        hi = min(lo + _BAND, n_genes)
        for j in range(lo, hi):
            a, b = int(indptr[j]), int(indptr[j + 1])
            col = np.zeros(n_cells, dtype=np.float64)
            if b > a:
                rows = np.asarray(indices[a:b], dtype=np.intp)
                col[rows] = np.asarray(data[a:b], dtype=np.float64)
            lognorm = np.log1p(col * norm)
            d = (col > 0).astype(np.float64)
            s1 = np.bincount(codes, weights=lognorm * kept, minlength=n_groups)[:n_groups]
            dd = np.bincount(codes, weights=d * kept, minlength=n_groups)[:n_groups]
            with np.errstate(invalid="ignore", divide="ignore"):
                means[j] = np.where(group_n > 0, s1 / group_n, 0.0)
                detect[j] = np.where(group_n > 0, dd / group_n, 0.0)
            base[j] = float((lognorm * kept).sum()) / total if total else 0.0
    return means, detect, base, group_n


def _banded_pseudobulk_counts(indptr, indices, data, n_cells, n_genes, gene_names,
                              unit_codes, n_units, keep=None):
    """Sum RAW counts to `(unit × genes)` pseudobulks BANDED (never a dense cells × genes),
    where `unit_codes` maps each cell to its `(sample, group)` unit index. float→int at the end.

    AC1 — when `keep` (a per-cell boolean mask) is given, ONLY the kept cells are summed. In the
    ADVANCED contrast every non-{group1,group2} cell carries grouping `"__none__"` and maps to
    `unit_index.get(...,0)` = a REAL surviving unit; without this filter their raw counts would
    fold into pseudobulk unit 0 and silently bias the DESeq2/NB-GLM test (wrong logFC/p/padj).
    The means path already restricts to `keep`; the counts matrix must too, over the SAME mask."""
    pb = np.zeros((n_units, n_genes), dtype=np.float64)
    keep = None if keep is None else np.asarray(keep, dtype=bool)
    for j in range(n_genes):
        a, b = int(indptr[j]), int(indptr[j + 1])
        if b > a:
            rows = np.asarray(indices[a:b], dtype=np.intp)
            vals = np.asarray(data[a:b], dtype=np.float64)
            if keep is not None:
                m = keep[rows]
                rows = rows[m]
                vals = vals[m]
            if rows.size == 0:
                continue
            u = unit_codes[rows]
            pb[:, j] += np.bincount(u, weights=vals, minlength=n_units)[:n_units]
    return pb


def _bh(pvals):
    """Benjamini-Hochberg adjusted p-values (float64). NaN-safe: NaN inputs stay NaN."""
    p = np.asarray(pvals, dtype=np.float64)
    ok = ~np.isnan(p)
    adj = np.full(p.shape, np.nan)
    idx = np.where(ok)[0]
    if idx.size == 0:
        return adj
    ps = p[idx]
    order = np.argsort(ps)
    ranked = ps[order]
    m = ranked.size
    q = ranked * m / (np.arange(1, m + 1))
    q = np.minimum.accumulate(q[::-1])[::-1]
    q = np.clip(q, 0, 1)
    out = np.empty(m)
    out[order] = q
    adj[idx] = out
    return adj


COLUMN_SLOT_PREFIX = "column:"


def _has_criterion(criteria):
    """A criteria list carries a real criterion iff some row is a dict naming a non-empty column."""
    return any(
        isinstance(c, dict) and isinstance(c.get("column"), str) and c.get("column").strip()
        for c in (criteria or []))


def _read_obs_columns(slots, n_cells):
    """`{name: values}` + `{name: provenance}` for every `column:<name>` slot the advanced run
    bound (one per criterion column). A `metadata-column` store cannot carry its own display name
    (values live under the constant member), so the name arrives with the BINDING — slot
    `column:<name>` — exactly as cell-filter resolves its criteria columns. Values are length-
    checked against the matrix's cells axis."""
    obs, prov = {}, {}
    for slot, entries in slots.items():
        s = str(slot)
        if not s.startswith(COLUMN_SLOT_PREFIX) or not entries:
            continue
        name = s[len(COLUMN_SLOT_PREFIX):]
        entry = entries[0]
        vals = S.read_column_values(entry["path"], s)
        if len(vals) != n_cells:
            S.fail(f"the criterion column {name!r} holds {len(vals)} values but the matrix "
                   f"declares {n_cells} cells — not the same cells axis")
        obs[name] = vals
        prov[name] = S.column_provenance(entry["path"])
    return obs, prov


def _criteria_with_excludes(criteria, obs_cols):
    """AC2 — realize the per-criterion include/EXCLUDE toggle (the mockup `.incexc` chip) WITHOUT
    forking the vendored kernel (INV-A1 stays byte-identical). A CATEGORICAL criterion flagged
    exclude (`mode == "exclude"` / `keep_mode == "exclude"` / `exclude is True`) is rewritten to an
    INCLUDE keep-set of the COMPLEMENT — the column's DISTINCT LEVELS ∖ the selected set — so
    `criteria_keep_mask` receives a plain include keep-set and never learns about exclude.

    A NUMERIC-range exclude ("outside [min,max]") is NOT expressible by the single-range kernel, so
    it is REFUSED BY NAME (the view hides the exclude toggle on numeric rows; this is belt+braces).
    An exclude of an absent column or an empty keep-set excludes nothing ⇒ keeps all ⇒ passes
    through as an unconstrained criterion (same as an empty include keep-set)."""
    import _criteria as CRIT

    out = []
    for c in criteria or []:
        if not isinstance(c, dict):
            out.append(c)
            continue
        mode = str(c.get("keep_mode") or c.get("mode") or "").strip().lower()
        excluded = (mode == "exclude") or (c.get("exclude") is True)
        if not excluded:
            out.append(c)
            continue
        if not CRIT._is_categorical_criterion(c):
            col = c.get("column")
            S.fail(
                f"exclude is not supported on the numeric-range criterion {col!r}: a single "
                "min/max range cannot express 'outside [min, max]'. Use an include range (or two "
                "contrasts). The exclude toggle is shown only on categorical criteria.")
        raw_name = c.get("column")
        col_name = CRIT._trim_column(raw_name) if isinstance(raw_name, str) else None
        col_vals = obs_cols.get(col_name) if col_name else None
        wanted = c.get("keep")
        wanted = wanted if isinstance(wanted, (list, tuple)) else []
        nc = {k: v for k, v in c.items() if k not in ("mode", "keep_mode", "exclude")}
        if col_vals is None or len(wanted) == 0:
            out.append(nc)  # excludes nothing ⇒ keep all (unconstrained)
            continue
        wanted_str = {str(x) for x in wanted}
        levels, seen = [], set()
        for v in col_vals:
            sv = str(v)
            if sv not in seen:
                seen.add(sv)
                levels.append(sv)
        nc["keep"] = [lv for lv in levels if lv not in wanted_str]  # COMPLEMENT keep-set
        out.append(nc)
    return out


def _advanced_contrast(p, slots, sample_entry, n_cells):
    """Build the two contrast SIDES from criteria expressions over obs columns (INV-A1/A3/A4).

    Each group (`group1`/`group2`) is a `criteria` list executed by the VENDORED
    `criteria_keep_mask` (INV-A1 — cell-filter's shipped kernel, byte-for-byte); the two sides are
    the resulting per-cell keep MASKS, NOT two levels of one column. Overlap is a hard REFUSAL by
    name (INV-A3), and the regime is resolved CONSERVATIVELY over EVERY criterion column's
    provenance (INV-A4). Returns the SAME 7-tuple the simple branch produces
    `(grouping, g1, g2, provenance, samples, samples_per_side, regime)` so the downstream
    banded-means + pseudobulk path is byte-shared."""
    import _criteria as CRIT

    g1_criteria = p.get("group1_criteria") or []
    g2_criteria = p.get("group2_criteria") or []
    if not isinstance(g1_criteria, list) or not isinstance(g2_criteria, list) \
            or not _has_criterion(g1_criteria) or not _has_criterion(g2_criteria):
        S.fail("the advanced contrast needs at least one criterion (naming a column) in EACH of "
               "group1 and group2 — build both group panels before running.")

    obs_cols, obs_prov = _read_obs_columns(slots, n_cells)

    # AC2 — resolve the per-criterion include/exclude toggle into a plain include keep-set (a
    # categorical exclude → the COMPLEMENT) BEFORE the vendored kernel runs, so INV-A1 holds.
    g1_eff = _criteria_with_excludes(g1_criteria, obs_cols)
    g2_eff = _criteria_with_excludes(g2_criteria, obs_cols)

    g1_mask = np.asarray(CRIT.criteria_keep_mask(g1_eff, obs_cols, n_cells=n_cells), dtype=bool)
    g2_mask = np.asarray(CRIT.criteria_keep_mask(g2_eff, obs_cols, n_cells=n_cells), dtype=bool)

    # INV-A3 — overlap is a hard REFUSAL, NAMED by the shared-cell count, PRE-COMPUTE. A cell on
    # both sides of a contrast is invalid; never silently test it (no p, no partial result).
    overlap_n = int(np.logical_and(g1_mask, g2_mask).sum())
    if overlap_n > 0:
        S.fail(
            f"refusing the advanced contrast: {overlap_n} cells are in both group1 and group2. "
            "A cell on both sides of a contrast is invalid (it would be compared against itself), "
            "so no test is run — narrow a criterion, or add an exclude, so the two groups are "
            "disjoint. Refused pre-compute; no p-value, no partial result.")

    n1 = int(g1_mask.sum())
    n2 = int(g2_mask.sum())
    if n1 == 0 or n2 == 0:
        empty = "group1" if n1 == 0 else "group2"
        S.fail(f"refusing the advanced contrast: {empty} selects NO cells with the criteria given, "
               "so there is nothing to test on that side. Widen or fix a criterion.")

    g1_label, g2_label = "group1", "group2"
    grouping = np.where(g1_mask, g1_label,
                        np.where(g2_mask, g2_label, "__none__")).tolist()

    # INV-A4 — the COMBINED provenance: EVERY criterion column of BOTH groups. A miss on group2's
    # provenance re-opens exactly the double-dipping this feature guards.
    crit_cols = []
    for c in list(g1_criteria) + list(g2_criteria):
        if isinstance(c, dict):
            col = c.get("column")
            if isinstance(col, str) and col.strip() and col in obs_cols and col not in crit_cols:
                crit_cols.append(col)
    provenances = [obs_prov.get(c) or {} for c in crit_cols]

    samples = None
    samples_per_side = None
    if sample_entry is not None:
        samples = S.read_column_values(sample_entry["path"], SAMPLE_SLOT)
        if len(samples) != n_cells:
            S.fail(f"the sample column holds {len(samples)} values but the matrix declares "
                   f"{n_cells} cells — not the same cells axis")
        s1 = {s for s, kp in zip(samples, g1_mask.tolist()) if kp}
        s2 = {s for s, kp in zip(samples, g2_mask.tolist()) if kp}
        samples_per_side = min(len(s1), len(s2))

    regime = R.classify_contrast(provenances, samples_per_side=samples_per_side)

    # AC4 — the per-criterion-column provenance CLASSIFICATION the regime chips reflect, resolved
    # here (the form's column frame carries no provenance). "matrix-derived" ⇒ R2; "external" ⇒
    # eligible for R1; "unknown" ⇒ conservative default (treated as non-external). Same signals
    # `classify_contrast` uses, so the chips and the regime cannot disagree.
    def _classify_col(pv):
        if R.is_matrix_derived(pv):
            return "matrix-derived"
        if R.is_external(pv):
            return "external"
        return "unknown"

    criterion_classification = {c: _classify_col(obs_prov.get(c) or {}) for c in crit_cols}
    provenance = {"advanced_contrast": True,
                  "criterion_columns": {c: (obs_prov.get(c) or {}) for c in crit_cols},
                  "criterion_classification": criterion_classification,
                  "group1_criteria": g1_criteria, "group2_criteria": g2_criteria,
                  "n_group1": n1, "n_group2": n2}
    return grouping, g1_label, g2_label, provenance, samples, samples_per_side, regime


def main():
    S.set_prefix("de.compare")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)

    seed = _resolve_int(p, "seed", 0)
    min_cells = _resolve_int(p, "min_cells", 10, lo=1)
    method_key = str(p.get("method") or METH.COMPARE_DEFAULT)
    multiplicity = str(p.get("multiplicity") or "bh_within")
    base_name = str(p.get("name") or "compare")
    method = METH.resolve_compare_method(method_key, S.fail)

    progress = S.progress
    progress("resolve", 3, "resolving inputs")
    expr = S.slot_entry(slots, EXPRESSION_SLOT)
    if expr is None:
        S.fail("no `expression` input bound — de.compare needs a RAW-COUNTS "
               "`single-cell/expression` matrix (INV-13)")
    # DE advanced-contrast (v0.2): Simple (two levels of one column) stays the default (INV-A2);
    # Advanced builds each side from a CRITERIA expression over obs columns (INV-A1/A3/A4).
    contrast_mode = str(p.get("contrast_mode") or "simple").strip().lower()
    sample_entry = S.slot_entry(slots, SAMPLE_SLOT)

    # INV-13 — refuse a normalized/log layer BY NAME (raw counts only).
    progress("preflight", 6, "checking the resource envelope")
    structure, n_cells, n_genes, nnz, gene_names = S.read_expression_structure(
        expr["path"], EXPRESSION_SLOT, require_raw_counts=True)
    ceiling = S.ceiling_refuse_if_over(nnz)

    if contrast_mode == "advanced":
        # ADVANCED — the two sides are criteria masks over obs columns. Produces the SAME tuple
        # the simple branch does, so the downstream banded-means/pseudobulk path is byte-shared.
        grouping, g1, g2, provenance, samples, samples_per_side, regime = _advanced_contrast(
            p, slots, sample_entry, n_cells)
    else:
        # SIMPLE (v1) — byte-unchanged (INV-A2). Two distinct levels of ONE grouping column.
        grp = S.slot_entry(slots, GROUPING_SLOT)
        if grp is None:
            S.fail("no `grouping` column bound — de.compare needs a categorical `metadata-column` "
                   "condition to contrast")
        grouping = S.read_column_values(grp["path"], GROUPING_SLOT)
        if len(grouping) != n_cells:
            S.fail(f"the grouping column holds {len(grouping)} values but the matrix declares "
                   f"{n_cells} cells — not the same cells axis")
        provenance = S.column_provenance(grp["path"])

        # ── the contrast (group1 vs group2) ─────────────────────────────────────────
        levels = sorted(set(grouping), key=lambda x: (len(x), x))
        g1 = str(p.get("group1") or (levels[0] if levels else ""))
        g2 = str(p.get("group2") or (levels[1] if len(levels) > 1 else ""))
        if not g1 or not g2 or g1 == g2 or g1 not in levels or g2 not in levels:
            S.fail(f"the contrast needs two distinct groups present in the grouping column; got "
                   f"group1={g1!r} group2={g2!r} over levels {levels}.")

        # ── sample column + samples-per-side → regime (INV-2) ───────────────────────
        samples = None
        samples_per_side = None
        if sample_entry is not None:
            samples = S.read_column_values(sample_entry["path"], SAMPLE_SLOT)
            if len(samples) != n_cells:
                S.fail(f"the sample column holds {len(samples)} values but the matrix declares "
                       f"{n_cells} cells — not the same cells axis")
            s1 = {s for s, gr in zip(samples, grouping) if gr == g1}
            s2 = {s for s, gr in zip(samples, grouping) if gr == g2}
            samples_per_side = min(len(s1), len(s2))
        regime = R.classify(provenance, samples_per_side=samples_per_side)

    progress("read", 22, f"banded gene-major read ({n_genes} genes)")
    indptr, indices, data = S.read_expression_csc(expr["path"])

    comparison_label = f"{g1} vs {g2}"
    name = f"{base_name}:{g1}_vs_{g2}"
    rel = f"columns/{base_name}.zarr"

    # per-cell library sizes (banded) for the ranked-effect readout in every regime.
    libsz = np.zeros(n_cells, dtype=np.float64)
    for lo in range(0, n_genes, _BAND):
        hi = min(lo + _BAND, n_genes)
        a, b = int(indptr[lo]), int(indptr[hi])
        if b > a:
            rows = np.asarray(indices[a:b], dtype=np.intp)
            libsz += np.bincount(rows, weights=np.asarray(data[a:b], dtype=np.float64),
                                 minlength=n_cells)[:n_cells]

    two_codes = np.array([0 if gr == g1 else (1 if gr == g2 else -1) for gr in grouping])
    keep = two_codes >= 0
    # C1 — restrict the ranked-effect readout to the two contrast groups' cells by passing the
    # `keep` MASK (non-{g1,g2} cells are EXCLUDED, never relabelled into group 0).
    means, detect, base_mean, group_n = _band_group_means(
        indptr, indices, data, n_cells, n_genes, gene_names,
        np.where(keep, two_codes, 0).astype(np.intp), 2, libsz, keep=keep)

    log2fc = (means[:, 0] - means[:, 1]) / np.log(2.0)
    n1 = float((two_codes == 0).sum())
    n2 = float((two_codes == 1).sum())

    report_extra = {"unit": "per-cell (ranked effect only)"}
    pseudobulk_record = None
    p_written = False
    cols = {
        "logFC": log2fc, "base_mean": base_mean,
        "pct_1": detect[:, 0], "pct_2": detect[:, 1],
        "n_1": np.full(n_genes, n1), "n_2": np.full(n_genes, n2),
        "score": log2fc,  # ranked by effect size when there is no p
    }
    mult_family = "none (descriptive; no p headlined)"

    if regime == R.R1:
        # ── R1: pseudobulk (sample × group) → the method → logFC/neglog10p/padj (INV-5) ──
        # C5 — decoupler is NOT the aggregator: the pseudobulk sum is a LOCAL banded bincount
        # (`_banded_pseudobulk_counts`), so `decoupler` is OPTIONAL provenance, never the R1 gate.
        # The R1 REFUSAL is gated on the chosen METHOD's real dependency (pydeseq2 / statsmodels),
        # raised BY NAME inside `method["run"]`.
        dc = PB.import_decoupler()
        decoupler_api = None
        if dc is not None:
            _fn, decoupler_api = PB.resolve_pseudobulk_api(dc, S.fail)  # recorded, NOT used to sum
        progress("pseudobulk", 45, f"pseudobulk (sample × group), min_cells={min_cells}")
        unit_keys = [(str(s), str(gr)) for s, gr in zip(samples, grouping)]
        two_only = [k for k, kp in zip(unit_keys, keep) if kp]
        uniq_units = sorted(set(two_only))
        unit_index = {u: i for i, u in enumerate(uniq_units)}
        unit_codes = np.array([unit_index.get((str(s), str(gr)), 0)
                               for s, gr in zip(samples, grouping)], dtype=np.intp)
        pb = _banded_pseudobulk_counts(indptr, indices, data, n_cells, n_genes, gene_names,
                                       unit_codes, len(uniq_units), keep=keep)
        import pandas as pd
        ncell_per_unit = np.bincount(unit_codes[keep], minlength=len(uniq_units))
        keep_unit = ncell_per_unit >= min_cells
        dropped = [{"sample": uniq_units[i][0], "group": uniq_units[i][1],
                    "n_cells": int(ncell_per_unit[i])}
                   for i in range(len(uniq_units)) if not keep_unit[i]]
        idx = [f"{s}__{g}" for (s, g) in uniq_units]
        counts_df = pd.DataFrame(pb, index=idx, columns=[str(x) for x in gene_names]).astype(int)
        design = pd.DataFrame({"group": [g for (_s, g) in uniq_units],
                               "sample": [s for (s, _g) in uniq_units]}, index=idx)
        counts_df = counts_df.loc[keep_unit]
        design = design.loc[keep_unit]
        # ── C2: the regime is RE-DECIDED from the POST-DROP surviving pseudobulks, never the
        # pre-drop `samples_per_side`. A side that lost replicates to `min_cells` cannot support
        # a replicate-aware p, so R1 downgrades to R3 (ranked effect only); a side with ZERO
        # survivors is refused BY NAME (there is nothing to test).
        n_side1 = int((design["group"] == g1).sum())
        n_side2 = int((design["group"] == g2).sum())
        if n_side1 == 0 or n_side2 == 0:
            empty_side = g1 if n_side1 == 0 else g2
            S.fail(
                f"refusing to test {comparison_label!r}: after dropping pseudobulks below "
                f"min_cells={min_cells}, side {empty_side!r} has NO surviving replicate "
                f"(dropped={dropped}). A replicate-aware test needs at least one surviving "
                "pseudobulk per side; lower `min_cells` or add replicates. Refused rather than "
                "fabricating a p from an empty side."
            )
        surviving_pps = min(n_side1, n_side2)
        pseudobulk_record = {"unit": "pseudobulk", "aggregation": "sum",
                             "api": "local-banded-sum", "decoupler_api": decoupler_api,
                             "min_cells": min_cells, "n_pseudobulks": int(keep_unit.sum()),
                             "dropped": dropped, "samples_per_side": samples_per_side,
                             "surviving_samples_per_side": surviving_pps,
                             "n_samples_1": n_side1, "n_samples_2": n_side2}
        if surviving_pps >= 2:
            progress("test", 70, f"{method['label']} on the pseudobulk matrix")
            res = method["run"](counts_df, design, (g1, g2), fail=S.fail)
            genes = list(counts_df.columns)
            logfc_a = np.array([res.get(g, {}).get("logFC", np.nan) for g in genes])
            pval_a = np.array([res.get(g, {}).get("pval", np.nan) for g in genes])
            base_a = np.array([res.get(g, {}).get("base_mean", np.nan) for g in genes])
            padj_within = _bh(pval_a)
            padj_across = _bh(pval_a)  # single comparison ⇒ across-family == within-family (G4)
            with np.errstate(divide="ignore"):
                neglog10p = -np.log10(np.clip(pval_a, 1e-300, 1.0))
            # `detect`/`n1`/`n2` are per-CELL over the contrast cells, in the ORIGINAL gene order;
            # `genes` is `counts_df.columns` == `gene_names` (all genes, same order), so they align.
            cols = {
                "logFC": logfc_a, "neglog10p": neglog10p, "padj": padj_within,
                "padj_across": padj_across, "base_mean": base_a,
                # C6 — detection fractions (G2) are written in R1 too (per-cell g1/g2 rates).
                "pct_1": detect[:, 0], "pct_2": detect[:, 1],
                # C7 — n_1/n_2 are CELL counts in EVERY regime; the pseudobulk SAMPLE counts are
                # the DISTINCT `n_samples_1`/`n_samples_2` (surviving units per side).
                "n_1": np.full(len(genes), n1), "n_2": np.full(len(genes), n2),
                "n_samples_1": np.full(len(genes), float(n_side1)),
                "n_samples_2": np.full(len(genes), float(n_side2)),
                "score": neglog10p,
            }
            gene_names = genes
            p_written = True
            mult_family = ("BH within comparison" if multiplicity == "bh_within"
                           else "BH within + across-comparison family")
            pseudobulk_record["regime_after_drop"] = R.R1
        else:
            # C2 — DOWNGRADE: not enough surviving replicates for a valid p. Keep the C1-correct
            # ranked-effect `cols` (per-cell, all genes), stamp R3, and write NO p.
            regime = R.R3
            p_written = False
            mult_family = "none (descriptive; no p headlined)"
            pseudobulk_record["regime_after_drop"] = R.R3
            pseudobulk_record["downgraded_from"] = R.R1
            pseudobulk_record["downgrade_reason"] = (
                f"side g1 kept {n_side1} / g2 kept {n_side2} pseudobulk(s) after the min_cells "
                "drop; a side below 2 replicates generalises to nothing, so no p is written")
        report_extra = pseudobulk_record

    # ── write the ONE de/result for this comparison ─────────────────────────────────
    progress("write", 86, "writing the comparison table")
    cmp_attrs = {"comparison": comparison_label, "group1": g1, "group2": g2,
                 "method": method["key"], "analysis": "de.compare",
                 "regime_note": R.regime_note(regime),
                 "pvalues_omitted": (not p_written),
                 "samples_per_side": samples_per_side}
    _st, meta = S.write_de_result(
        outputs_dir, rel, name, gene_names, cols, regime=regime,
        multiplicity_family=mult_family, extra_attrs=cmp_attrs)
    entries = [S.output_entry(f"de/result:{name}", S.DT_DE_RESULT, rel, "artifact",
                              structure=_st, meta=meta)]

    # ── run report/qc index (ITEM-17 / DEC-14) ──────────────────────────────────────
    progress("report", 94, "run report")
    # M2 — the source heading this comparison groups under (mockup: "condition · pseudobulk
    # (PyDESeq2)"). Pseudobulk when a p was written; ranked effect otherwise.
    source_group = (f"pseudobulk · {method['label']}" if p_written
                    else f"ranked effect · {method['label']}")
    # M1/M2 — the comparison row as the Visualize `entry_list` renders it: `key` (identity, else
    # the row drops), `label` (row name), `qualifier` = REGIME (a renderer-supported inline
    # distinguisher, visible where the unsupported `badge` was not), `group` = source heading.
    comparisons = [{"id": f"de/result:{name}", "key": f"de/result:{name}", "name": name,
                    "label": comparison_label, "comparison": comparison_label,
                    "qualifier": regime, "group": source_group, "source_group": source_group,
                    "regime": regime, "n_genes": len(gene_names)}]
    report = {
        "kind": "de-report", "analysis": "de.compare", "product": "condition-comparison",
        "regime": regime, "regime_note": R.regime_note(regime), "pvalues_written": p_written,
        "method": method["key"], "methods_available": [m["key"] for m in METH.compare_catalog()],
        "contrast": comparison_label, "multiplicity_family": mult_family,
        "n_cells": int(n_cells), "n_genes": int(n_genes), "seed": seed,
        "grouping_provenance": provenance if isinstance(provenance, dict) else {},
        "pseudobulk": report_extra,
        "comparisons": comparisons, "grouped": True,
        "groups": [{"name": source_group, "count": len(comparisons)}],
        "dropped": (pseudobulk_record or {}).get("dropped", []),
        "determinism_env": S.resolved_determinism_env(), "ceiling": ceiling,
        "library_versions": _library_versions(),
    }
    (outputs_dir / "de-report.json").write_text(json.dumps(report, indent=2))
    import cyto_columns
    entries.append(S.output_entry("de-report", S.DT_REPORT_QC, "de-report.json", "artifact",
                                  structure=cyto_columns.opaque("application/json"),
                                  meta={"kind": "de-report", "analysis": "de.compare",
                                        "n_comparisons": 1, "regime": regime}))
    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{comparison_label} ({regime})")


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
