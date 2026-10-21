#!/usr/bin/env python3
# ruff: noqa
"""da.neighbourhoods — Milo-style NEIGHBOURHOOD differential abundance (#109).

Answers *"is there ANY REGION of the cell-neighbourhood graph whose composition shifts?"*. The
unit is a neighbourhood, neighbourhoods OVERLAP, and a population is DISCOVERED rather than
named. This is NOT the same question `da.clusters` answers: cluster-level DA is blind to a shift
confined to part of a cluster and inherits the arbitrariness of the clustering resolution, while
this analysis is RESOLUTION-FREE and sees shifts that straddle cluster boundaries — but it hands
back regions, not names, so it is harder to talk about. Both ship, and the views say which
question each answers rather than presenting them as two flavours of one thing.

## The pipeline

    resolve the embedding → REFUSE a 2-D layout by name, before any read (INV-11) → ceiling gate
    → kNN over the embedding (rebuilt in-process; no KNN artifact exists or is needed)
    → refined overlapping neighbourhoods, deterministic under `seed` (#92)
    → (sample × neighbourhood) INTEGER counts
    → drop + RECORD sub-min_cells samples
    → classify the regime ON THE CONDITION (INV-DA-3)
    → establish the DECLARED normalization, or REFUSE (INV-DA-1)
    → NB count model (R1 only) → plain BH AND connectivity-weighted BH (INV-DA-4)
    → one `da/result` + a `da-report`

## What this analysis deliberately does NOT emit

A per-cell effect `metadata-column`. A cell belongs to MANY overlapping neighbourhoods, so a
per-cell effect would need an arbitrary reduction (max |logFC|? mean? weighted?) and inventing
one to fill a column is exactly the quiet fabrication this package refuses. `da.clusters` emits
one because its populations are disjoint; this one does not.

## The `annotation` slot is READABILITY ONLY

Binding an annotation labels each neighbourhood with its majority cell type and that label's
purity fraction, so a discovered region is talkable-about. It NEVER enters the model — the moment
it did, it would reintroduce exactly the cluster-boundary arbitrariness this method exists to
avoid. `tests/test_neighbourhoods_end_to_end.py` asserts that binding it changes no statistic.
"""
import _shared as S  # FIRST — pins the determinism env before numpy/scanpy load

import json

import numpy as np

import cyto_columns
import _regime as R
import _kernel as K
import _nhoods as NH

# ── INPUT SLOTS (resolved out of `/inputs/inputs.json`, never a filename suffix) ────
EMBEDDING_SLOT = "embedding"
CONDITION_SLOT = "condition"
SAMPLE_SLOT = "sample"
ANNOTATION_SLOT = "annotation"

ANALYSIS_ID = "da.neighbourhoods"

#: The counterpart of `da.clusters`' resolution disclosure: this analysis states that it made no
#: resolution choice at all, which is the property it exists to have.
RESOLUTION_STATEMENT = (
    "Neighbourhood-level differential abundance is RESOLUTION-FREE: no clustering resolution was "
    "chosen, so a shift that straddles cluster boundaries is visible and no arbitrary partition "
    "is baked into the result. The price is that a neighbourhood is a discovered region rather "
    "than a name; bind an annotation column to label each region by its majority cell type (that "
    "label is for reading only and never enters the model)."
)

RELATIVE_CAVEAT = (
    "Differential abundance measures RELATIVE composition. Without a spike-in or a total-cell "
    "count, single-cell data cannot distinguish 'this population went up' from 'everything else "
    "went down'; both readings fit the same data."
)


def _resolve_int(p, key, default, *, lo=0):
    try:
        v = int(p.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def _resolve_float(p, key, default):
    try:
        return float(p.get(key, default))
    except (TypeError, ValueError):
        return default


def main():
    S.set_prefix(ANALYSIS_ID)
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)
    progress = S.progress

    seed = _resolve_int(p, "seed", 0)
    prop = _resolve_float(p, "prop", 0.1)
    k = _resolve_int(p, "k", 15, lo=2)
    metric = str(p.get("metric") or "euclidean")
    min_cells = _resolve_int(p, "min_cells", 10, lo=1)
    fdr = _resolve_float(p, "fdr", 0.1)
    # The label reaches a store PATH, so it is reduced to a single safe segment here
    # rather than trusted: it is a free-text control the user types.
    base_name = S.safe_label(p.get("name"))
    method_key = str(p.get("method") or K.METHOD_DEFAULT)
    normalization = str(p.get("normalization") or K.NORMALIZATION_DEFAULT)
    # The SMALL-SAMPLE reference distribution (see `_kernel.t_reference_pvalues`). Left UNSET the
    # engine's own measured default applies; an explicit value overrides it. Always recorded.
    _ssc = p.get("small_sample_correction", None)
    small_sample_correction = (None if _ssc in (None, "")
                               else str(_ssc).strip().lower() not in ("0", "false", "no", "off"))
    # `fdr` is the discovery threshold every `n_significant` count and every `_called` mask is
    # taken against, and it reaches the artifact as `fdr_threshold`. The run form declares
    # `min: 0, max: 1`, but an agent/MCP call that never rendered the form reaches this code
    # directly — the same reasoning the NaN sentinel above was handled for. Unbounded, `fdr: 2.0`
    # calls EVERY fittable population a discovery and records `fdr_threshold: 2.0` beside it,
    # and a negative value calls none; both are a wrong number rather than a refusal.
    if not (0.0 < fdr <= 1.0) or fdr != fdr:
        S.fail(f"`fdr` must be a false-discovery-rate threshold in (0, 1]; got {fdr!r}. It is a "
               "probability, and a run that called every population a discovery at `fdr > 1` "
               "would record that threshold beside the result as if it meant something.")

    if not (0.0 < prop <= 1.0):
        S.fail(f"`prop` must be in (0, 1]; got {prop!r}. It is the fraction of cells sampled as "
               "neighbourhood index cells before refinement.")

    progress("resolve", 4, "resolving the embedding, condition and sample inputs")
    emb = S.slot_entry(slots, EMBEDDING_SLOT)
    if emb is None:
        S.fail("no `embedding` input bound — da.neighbourhoods rebuilds the neighbourhood graph "
               "from a reduced embedding (PCA/latent). Run Reduce dimensions first.")
    cond_entry = S.slot_entry(slots, CONDITION_SLOT)
    samp_entry = S.slot_entry(slots, SAMPLE_SLOT)
    if cond_entry is None:
        S.fail("no `condition` column bound — da.neighbourhoods needs the categorical "
               "`metadata-column` that carries the condition being tested")
    if samp_entry is None:
        S.fail("no `sample` column bound — the SAMPLE is the unit of replication (INV-DA-2); "
               "without it there is nothing to replicate over and no honest test to run")

    # INV-11 — a 2-D UMAP/t-SNE LAYOUT is refused BY NAME from the DECLARED structure, before a
    # single byte of the matrix is read. A region discovered on a picture is an artefact of the
    # drawing, not of the data.
    progress("preflight", 8, "checking the input shape and the resource envelope")
    structure, member, n_cells, n_dims = S.read_embedding_structure(emb["path"], EMBEDDING_SLOT)
    ceiling = S.ceiling_refuse_if_over(n_cells, n_dims, n_neighbors=k, prop=prop)
    if n_cells < S.MIN_VIABLE_CELLS:
        S.fail(f"refusing to test: {n_cells} cells is below the viable floor of "
               f"{S.MIN_VIABLE_CELLS}; there is no neighbourhood structure to find.")

    conditions_per_cell = S.read_column_values(cond_entry["path"], CONDITION_SLOT)
    samples_per_cell = S.read_column_values(samp_entry["path"], SAMPLE_SLOT)
    for name, vals in (("condition", conditions_per_cell), ("sample", samples_per_cell)):
        if len(vals) != n_cells:
            S.fail(f"the {name} column holds {len(vals)} values but the embedding declares "
                   f"{n_cells} cells — they are not the same cells axis")
    covariate_columns = S.read_covariate_columns(slots, n_cells)
    ann_entry = S.slot_entry(slots, ANNOTATION_SLOT)
    annotation_per_cell = None
    if ann_entry is not None:
        annotation_per_cell = S.read_column_values(ann_entry["path"], ANNOTATION_SLOT)
        if len(annotation_per_cell) != n_cells:
            S.fail(f"the annotation column holds {len(annotation_per_cell)} values but the "
                   f"embedding declares {n_cells} cells — not the same cells axis")

    condition_provenance = S.column_provenance(cond_entry["path"])
    condition_levels = sorted(set(conditions_per_cell))
    if len(condition_levels) < 2:
        S.fail(f"refusing to test: the condition column has {len(condition_levels)} distinct "
               "level(s), so there is no contrast to test.")
    g1 = str(p.get("group1") or condition_levels[0])
    g2 = str(p.get("group2") or condition_levels[1])
    if g1 == g2 or g1 not in condition_levels or g2 not in condition_levels:
        S.fail(f"the contrast needs two distinct condition levels present in the column; got "
               f"group1={g1!r} group2={g2!r} over levels {condition_levels!r}.")

    # ── the neighbourhood graph, rebuilt in process from the embedding (#92) ────────
    progress("read", 18, f"reading the embedding ({n_cells} cells × {n_dims} dims)")
    X = S.read_embedding_matrix(emb["path"], member)
    progress("graph", 30, f"kNN over the embedding (k={k}, metric={metric})")
    connectivities, distances, effective_k = NH.build_knn(
        X, n_neighbors=k, metric=metric, seed=seed, fail=S.fail)
    # RECORD WHAT WAS USED, not what was asked for. scanpy clamps `n_neighbors` to the cell
    # count without failing, and `kth_distance` — the spatial-FDR weight — is the k-th
    # neighbour distance under the CLAMPED k.
    k = effective_k
    progress("neighbourhoods", 42, f"refined neighbourhoods (prop={prop}, seed={seed})")
    nhoods, index_cells, kth_distance = NH.make_nhoods(X, connectivities, distances, prop=prop,
                                                       seed=seed, fail=S.fail)
    n_nhoods = int(len(index_cells))
    if n_nhoods < 2:
        S.fail(f"refusing to test: the refinement collapsed to {n_nhoods} neighbourhood(s), so "
               "there is no composition to compare. Raise `prop`, or use the cluster-level "
               "analysis.")
    # The population ids are the INDEX CELLS' positions — that is what makes a neighbourhood
    # matchable across runs (and against the parity fixture) at a fixed `prop` + `seed`.
    population_ids = [f"nhood{int(i)}" for i in index_cells]

    sample_levels = sorted(set(samples_per_cell))
    progress("count", 52, f"counting cells over {n_nhoods} neighbourhoods × "
                          f"{len(sample_levels)} samples")
    counts = NH.count_nhoods(nhoods, samples_per_cell, sample_levels)

    import pandas as pd

    def _per_sample(values, what):
        per = {}
        for v, s in zip(values, samples_per_cell):
            per.setdefault(str(s), set()).add(str(v))
        out = []
        for lv in sample_levels:
            vs = per.get(lv, set())
            if len(vs) != 1:
                S.fail(
                    f"refusing to test: sample {lv!r} carries {len(vs)} distinct {what} values "
                    f"({sorted(vs)!r}). The unit of replication is the SAMPLE, so each sample "
                    f"must map to exactly one {what}; a sample spanning several has no row in "
                    "the design frame."
                )
            out.append(next(iter(vs)))
        return out

    sample_condition = _per_sample(conditions_per_cell, "condition")
    sample_covariates = {name: _per_sample(vals, f"covariate {name!r}")
                         for name, vals in covariate_columns.items()}

    # `min_cells` is stated to the user, and narrated into `methods.md`, in CELLS — so it must be
    # counted in cells. `counts` is (sample × neighbourhood) and the neighbourhoods OVERLAP, so
    # `counts.sum(axis=1)` counts each cell once per neighbourhood it belongs to (roughly k·prop
    # times) and would silently apply the threshold in a unit nothing else in the run uses. The
    # honest quantity is how many of a sample's cells lie inside the union of the neighbourhoods:
    # a cell in none of them contributes to no column and cannot support any test.
    in_any_nhood = np.asarray(nhoods.sum(axis=1)).ravel() > 0
    cells_per_sample = {lv: 0 for lv in sample_levels}
    for s, inside in zip(samples_per_cell, in_any_nhood):
        if inside:
            cells_per_sample[str(s)] += 1
    totals = np.array([cells_per_sample[lv] for lv in sample_levels], dtype=np.int64)
    keep = totals >= min_cells
    dropped = [{"sample": sample_levels[i], "n_cells": int(totals[i]),
                "n_cells_in_neighbourhoods": int(totals[i]),
                "condition": sample_condition[i]}
               for i in range(len(sample_levels)) if not keep[i]]
    kept_levels = [sample_levels[i] for i in range(len(sample_levels)) if keep[i]]
    if len(kept_levels) == 0:
        S.fail(f"refusing to test: every sample has fewer than min_cells={min_cells} cells "
               f"inside the union of the neighbourhoods (dropped={dropped}). Lower `min_cells`, "
               "raise `prop`, or supply more cells per sample.")
    counts = counts[keep]
    sample_condition = [sample_condition[i] for i in range(len(sample_levels)) if keep[i]]
    sample_covariates = {kk: [v[i] for i in range(len(sample_levels)) if keep[i]]
                         for kk, v in sample_covariates.items()}

    S.refuse_covariate_named_like_the_condition(sample_covariates, S.fail)

    side1 = np.array([c == g1 for c in sample_condition])
    side2 = np.array([c == g2 for c in sample_condition])
    n_samples_1 = int(side1.sum())
    n_samples_2 = int(side2.sum())
    if n_samples_1 == 0 or n_samples_2 == 0:
        empty = g1 if n_samples_1 == 0 else g2
        S.fail(
            f"refusing to test {g1!r} vs {g2!r}: after dropping samples below "
            f"min_cells={min_cells}, side {empty!r} has NO surviving sample (dropped={dropped}). "
            "Refused rather than fabricating a result from an empty side."
        )
    samples_per_side = min(n_samples_1, n_samples_2)

    # INV-DA-3 — classify on the CONDITION. There is no population column here at all: a
    # neighbourhood is discovered from the embedding, which is matrix-derived BY CONSTRUCTION and
    # CONDITION-BLIND. Classifying on it would return R2 for every run that could ever exist.
    regime = R.classify(condition_provenance, samples_per_side=samples_per_side)

    progress("normalize", 60, f"establishing the {normalization!r} normalization")
    normalization = K.resolve_normalization(normalization, S.fail)
    if normalization == K.REFERENCE:
        S.fail(
            "refusing to test: the `reference` (additive-log-ratio) normalization names ONE "
            "population whose absolute abundance is assumed constant, and a neighbourhood is a "
            "discovered, seed-dependent region — there is no stable population here to name, so "
            "the assumption could not be checked or even stated honestly. Use `poscounts` for "
            "neighbourhood-level abundance, or run the cluster-level analysis, where a named "
            "reference population is meaningful. The run refuses rather than testing under a "
            "normalization it cannot justify (INV-DA-1)."
        )
    sf, norm_record = K.size_factors(counts, normalization=normalization, fail=S.fail)

    # The denominator is CELLS PER SAMPLE, not the row sum: neighbourhoods OVERLAP, so a row sum
    # counts each cell once per neighbourhood it joins (see `descriptive_columns`). `totals` is
    # the per-sample cell count already computed for `min_cells`, restricted to surviving samples.
    desc = K.descriptive_columns(counts, sf, side1, side2, sample_totals=totals[keep])
    cols = {
        "logFC": desc["logFC"],
        "n_cells": desc["n_cells"],
        "mean_prop_1": desc["mean_prop_1"],
        "mean_prop_2": desc["mean_prop_2"],
        "n_samples_1": np.full(n_nhoods, float(n_samples_1)),
        "n_samples_2": np.full(n_nhoods, float(n_samples_2)),
        "score": desc["logFC"],
    }
    mult_family = "none (descriptive; no p headlined)"
    fit_record = None
    p_written = False
    n_significant = None

    if regime == R.R1:
        progress("test", 72, f"negative-binomial count model ({method_key})")
        counts_df = pd.DataFrame(counts, index=kept_levels, columns=population_ids)
        design_df = pd.DataFrame({"condition": sample_condition, **sample_covariates},
                                 index=kept_levels)
        results, fit_record = K.fit(counts_df, design_df, (g1, g2), condition_col="condition",
                                    covariates=list(sample_covariates.keys()), method=method_key,
                                    normalization=normalization,
                                    small_sample_correction=small_sample_correction, fail=S.fail)
        logfc = np.array([results.get(pop, {}).get("logFC", np.nan) for pop in population_ids])
        pvals = np.array([results.get(pop, {}).get("pval", np.nan) for pop in population_ids])
        if np.all(np.isnan(pvals)):
            # NOT ONE p-VALUE COULD BE FITTED, so this is not an inferential result no matter what
            # the regime classifier said. Writing `padj`/`spatial_fdr` as 1.0 over an all-NaN fit
            # would be exactly the "written as 1" shape INV-DA-2 forbids, dressed as a run that
            # tested and found nothing. It is a DOWNGRADE to R3 with the p-family ABSENT, recorded
            # by name — the same correction `de.compare` makes when its surviving replicates
            # cannot support a p. Reachable when the design consumes every residual degree of
            # freedom (a covariate at the R1 floor of two samples a side).
            regime = R.R3
            downgraded_from = R.R1
            downgrade_reason = (
                "no neighbourhood yielded a fittable p-value: the design "
                f"{(fit_record or {}).get('design_formula')!r} left "
                f"{(fit_record or {}).get('residual_df')!r} residual degrees of freedom over "
                f"{len(kept_levels)} surviving samples. Ranked effects only; the p-value and both "
                "FDR columns are ABSENT, not 1.")
            fit_record = dict(fit_record or {}, regime_after_fit=R.R3,
                              downgraded_from=downgraded_from,
                              downgrade_reason=downgrade_reason)
            # `logFC` and `score` KEEP the descriptive count-model effect they were seeded
            # with. A downgraded run is a descriptive run, so it ships the same two agreeing
            # effect columns every other R2/R3 result does — and the fitted effect is unusable
            # here anyway (it is NaN whenever the design left nothing to fit).
            mult_family = "none (descriptive; no p headlined — the fit yielded no p-value)"
        else:
            cols["logFC"] = logfc
            progress("fdr", 80, "connectivity-weighted BH (spatial FDR) + plain BH")
            # INV-DA-4 — neighbourhoods OVERLAP, so plain BH is anti-conservative in dense
            # regions. BOTH are written: `spatial_fdr` is the one every threshold, badge and
            # headline reads, and `padj` is recorded beside it so the correction is AUDITABLE
            # rather than silent — a reviewer can see exactly how much the weighting moved.
            with np.errstate(divide="ignore", invalid="ignore"):
                weights = 1.0 / np.asarray(kth_distance, dtype=np.float64)
            padj = K.bh(pvals)
            spatial = K.weighted_bh(pvals, weights)
            # A neighbourhood the ENGINE REFUSED TO REPORT stays unreported, in every column —
            # see the matching note in `clusters.py`. NaN is already not a discovery, so filling
            # it with 1.0 bought nothing and cost the mask that PyDESeq2's Cook's filter set.
            padj_written = padj
            spatial_written = spatial
            cols["neglog10p"] = K.neglog10(pvals)
            cols["padj"] = padj_written
            cols["spatial_fdr"] = spatial_written
            # THE HEADLINE COLUMN. `spatial_fdr` is what this analysis thresholds on, and this is
            # it on the −log10 scale the shipped `volcano` chart kind's significance channel (and
            # its threshold rail) treats that channel as being on. Binding the volcano to THIS is
            # what makes INV-DA-4 true of the surface a reader actually looks at, rather than only
            # of the bytes on disk.
            cols["neglog10_significance"] = K.neglog10(spatial_written)
            cols["score"] = K.neglog10(pvals)
            mult_family = "connectivity-weighted BH (spatial FDR); plain BH recorded alongside"
            p_written = True
            # The FDR threshold is APPLIED here, not merely recorded: the run reports how many
            # neighbourhoods it calls at the level the user chose, off the weighted column.
            # NaN is EXCLUDED explicitly rather than mapped to a 1.0 sentinel: the
            # comparison is `<=`, so at `fdr = 1.0` — a form-valid input, and
            # unbounded for an agent call that never rendered the form — the sentinel
            # would count a population the engine refused to report as a discovery.
            _called = (spatial_written <= fdr) & ~np.isnan(spatial_written)
            n_significant = int(np.sum(_called))

    nhood_annotation = None
    nhood_purity = None
    if annotation_per_cell is not None:
        progress("annotate", 86, "labelling neighbourhoods (readability only)")
        nhood_annotation, nhood_purity = NH.annotate_nhoods(nhoods, annotation_per_cell)

    progress("write", 90, "writing the neighbourhood table")
    comparison_label = f"{g1} vs {g2}"
    name = f"{base_name}:{g1}_vs_{g2}"
    rel = f"columns/{base_name}.zarr"
    result_attrs = {
        "analysis": ANALYSIS_ID,
        "comparison": comparison_label, "group1": g1, "group2": g2,
        "normalization": normalization,
        "normalization_assumption": K.NORMALIZATION_ASSUMPTION[normalization],
        "method": (fit_record or {}).get("method", method_key),
        "design_formula": (fit_record or {}).get("design_formula"),
        "small_sample_correction": (fit_record or {}).get("small_sample_correction"),
        "regime_note": S.regime_note_for(R, regime, fit_record),
        "pvalues_omitted": (not p_written),
        "samples_per_side": samples_per_side,
        "resolution_free": True,
        "resolution_statement": RESOLUTION_STATEMENT,
        "relative_abundance_caveat": RELATIVE_CAVEAT,
        "condition_provenance": condition_provenance,
        "regime_classified_on": "condition",
        "n_nhoods": n_nhoods, "prop": prop, "k": k, "seed": seed,
        "index_cells": [int(i) for i in index_cells],
        "kth_distance": [float(d) for d in kth_distance],
        "nhood_annotation": nhood_annotation,
        "nhood_annotation_purity": nhood_purity,
        "significance_column": ("spatial_fdr" if p_written else None),
        "headline_column": ("neglog10_significance" if p_written else None),
        "fdr_threshold": fdr,
        "n_significant": n_significant,
    }
    structure, meta = S.write_da_result(
        outputs_dir, rel, name, population_ids, cols, regime=regime,
        multiplicity_family=mult_family, extra_attrs=result_attrs)
    entries = [S.output_entry(f"da/result:{name}", S.DT_DA_RESULT, rel, "artifact",
                              structure=structure, meta=meta)]

    progress("report", 96, "run report")
    source_group = (f"neighbourhood · {(fit_record or {}).get('method_label', method_key)}"
                    if p_written else "neighbourhood · ranked effect")
    comparisons = [{"id": f"da/result:{name}", "key": f"da/result:{name}", "name": name,
                    "label": comparison_label, "comparison": comparison_label,
                    "qualifier": regime, "group": source_group, "source_group": source_group,
                    "regime": regime, "analysis": ANALYSIS_ID,
                    "significance_column": ("spatial_fdr" if p_written else None),
                    "headline_column": ("neglog10_significance" if p_written else None),
                    "n_significant": n_significant,
                    "n_populations": n_nhoods}]
    report = {
        "kind": "da-report", "analysis": ANALYSIS_ID, "product": "neighbourhood-abundance",
        "regime": regime, "regime_note": S.regime_note_for(R, regime, fit_record), "pvalues_written": p_written,
        "regime_classified_on": "condition",
        "condition_provenance": condition_provenance,
        "resolution_free": True, "resolution_statement": RESOLUTION_STATEMENT,
        "relative_abundance_caveat": RELATIVE_CAVEAT,
        "normalization": norm_record,
        "fit": fit_record,
        "method": (fit_record or {}).get("method", method_key),
        "methods_available": [m["key"] for m in K.catalog()],
        "normalizations_available": list(K.NORMALIZATIONS),
        "contrast": comparison_label,
        "multiplicity_family": mult_family,
        "small_sample_correction": (fit_record or {}).get("small_sample_correction"),
        "fdr_threshold": fdr, "n_significant": n_significant,
        "min_cells": min_cells, "seed": seed, "prop": prop, "k": k,
        "metric": metric,
        "n_cells": int(n_cells), "n_dims": int(n_dims), "n_nhoods": n_nhoods,
        "index_cells": [int(i) for i in index_cells],
        "kth_distance": [float(d) for d in kth_distance],
        "nhood_annotation": nhood_annotation, "nhood_annotation_purity": nhood_purity,
        "annotation_enters_model": False,
        "n_samples": len(kept_levels), "n_samples_1": n_samples_1, "n_samples_2": n_samples_2,
        "samples_per_side": samples_per_side, "samples": kept_levels,
        "dropped": dropped,
        "comparisons": comparisons, "grouped": True,
        "groups": [{"name": source_group, "count": len(comparisons)}],
        "ceiling": ceiling,
        "determinism_env": S.resolved_determinism_env(),
        "library_versions": S.library_versions(),
    }
    (outputs_dir / "da-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.output_entry("da-report", S.DT_REPORT_QC, "da-report.json", "artifact",
                                  structure=cyto_columns.opaque("application/json"),
                                  meta={"kind": "da-report", "analysis": ANALYSIS_ID,
                                        "n_comparisons": 1, "regime": regime}))
    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{comparison_label} ({regime}, {n_nhoods} neighbourhoods)")


if __name__ == "__main__":
    main()
