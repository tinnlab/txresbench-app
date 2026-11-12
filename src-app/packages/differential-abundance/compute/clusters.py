#!/usr/bin/env python3
# ruff: noqa
"""da.clusters — CLUSTER / ANNOTATION-level differential abundance (#108).

Answers *"does the proportion of THIS NAMED population change between conditions?"*. The unit is
a label a human can talk about — which is exactly what a user with curated annotations asks — and
it is a DIFFERENT question from `da.neighbourhoods`, which asks whether ANY region shifts and
hands back discovered regions rather than names.

## Three metadata columns are a complete input

No expression matrix. No embedding. DA counts CELLS, not reads, so the whole raw-counts gate, the
banded CSC read and the matrix memory ceiling that dominate `de.compare` simply do not apply here.

    population  (categorical metadata-column)  — the ROWS of the count matrix
    condition   (categorical metadata-column)  — the TESTED COEFFICIENT
    sample      (categorical metadata-column)  — the UNIT OF REPLICATION
    covariate:<name>  (0..n metadata-columns)  — additive terms in the design formula

## The pipeline

    resolve columns → (sample × population) INTEGER counts → drop + RECORD sub-min_cells samples
    → classify the regime ON THE CONDITION → establish the DECLARED normalization (or REFUSE)
    → NB count model (R1 only) → plain BH → write one `da/result` (+ an optional per-cell effect
    column) + a `da-report`

Every stage is a named refusal on failure, never a silent wrong answer.

## The two invariants this entry owns end-to-end

INV-DA-1 — no statistic is ever computed from raw proportions. `mean_prop_1`/`mean_prop_2` are
REPORTED because a reader wants them, but nothing is tested on them; the p-values come from
`_kernel.fit` over integer counts under a normalization that is named, recorded, and narrated —
or the run refuses.

INV-DA-3 — the regime is classified on the CONDITION column's provenance, never the population's.
DA populations are matrix-derived by construction, so classifying on the population would return
R2 for every run that could exist. They were drawn CONDITION-BLIND, so this is not `de.compare`'s
circular selection. What IS affected is the interpretation: a cluster is an arbitrary partition,
so this result is SENSITIVE TO THE CLUSTERING RESOLUTION — a mandatory disclosure carried in the
report, the artifact provenance and `methods.md`. See `_shared.column_provenance` for the full
reasoning and for the residual risk we DISCLOSE rather than fake a detector for.
"""
import _shared as S  # FIRST — pins the determinism env before numpy loads

import json

import numpy as np

import txr_columns
import _regime as R
import _kernel as K

# ── INPUT SLOTS (resolved out of `/inputs/inputs.json`, never a filename suffix) ────
POPULATION_SLOT = "population"
CONDITION_SLOT = "condition"
SAMPLE_SLOT = "sample"

ANALYSIS_ID = "da.clusters"

#: The resolution-sensitivity disclosure INV-DA-3 makes MANDATORY on this analysis. It rides the
#: report, the artifact's `attributes.txr.da`, and (as prose) the manifest's `methods.note`.
RESOLUTION_DISCLOSURE = (
    "Cluster-level differential abundance is SENSITIVE TO THE CLUSTERING RESOLUTION at which "
    "these populations were defined: the populations are an arbitrary partition of a continuum, "
    "so partitioning the same cells more or less finely can change which of them move and by how "
    "much, and a shift confined to PART of a population is invisible here. The neighbourhood "
    "analysis (da.neighbourhoods) is the resolution-free complement and answers a different "
    "question: whether ANY region shifts, without naming it."
)

#: The absolute-abundance caveat. Both analyses carry it; it bounds what ANY DA result can mean.
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


def per_sample_value(values, samples, sample_levels, *, what, fail):
    """The one value of `values` each sample carries — refusing BY NAME when a sample carries
    more than one. A design frame's row is a SAMPLE (INV-DA-2), so a sample that spans two
    conditions has no row to occupy, and quietly taking the first (or the majority) would make
    the tested coefficient describe something the data does not say."""
    per = {}
    for v, s in zip(values, samples):
        per.setdefault(str(s), set()).add(str(v))
    out = []
    for lv in sample_levels:
        vs = per.get(lv, set())
        if len(vs) != 1:
            fail(
                f"refusing to test: sample {lv!r} carries {len(vs)} distinct {what} values "
                f"({sorted(vs)!r}). The unit of replication is the SAMPLE, so each sample must "
                f"map to exactly one {what}; a sample spanning several has no row in the design "
                "frame. Fix the sample column, or pick a column that is constant within a sample."
            )
        out.append(next(iter(vs)))
    return out


def main():
    S.set_prefix(ANALYSIS_ID)
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)
    progress = S.progress

    # NO `seed`. This analysis draws nothing at random — it counts cells and fits a GLM — so
    # accepting a seed would imply a randomness that does not exist, and declaring the `seed`
    # methods role for it would put that implication into `methods.md`. `da.neighbourhoods` has a
    # real seed (the index-cell draw) and declares one.
    min_cells = _resolve_int(p, "min_cells", 10, lo=1)
    fdr = _resolve_float(p, "fdr", 0.1)
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
    reference = p.get("reference") or None
    # A form sends "yes"/"no" strings; `bool("no")` is True, so the truthiness of the raw value is
    # NOT the answer. Parsed the same way every other flag in this package is.
    emit_effect_column = str(p.get("emit_effect_column", "yes")).strip().lower() not in (
        "0", "false", "no", "off", "none", "")

    progress("resolve", 5, "resolving the population, condition and sample columns")
    pop_entry = S.slot_entry(slots, POPULATION_SLOT)
    cond_entry = S.slot_entry(slots, CONDITION_SLOT)
    samp_entry = S.slot_entry(slots, SAMPLE_SLOT)
    if pop_entry is None:
        S.fail("no `population` column bound — da.clusters needs the categorical "
               "`metadata-column` whose levels are the populations to test")
    if cond_entry is None:
        S.fail("no `condition` column bound — da.clusters needs the categorical "
               "`metadata-column` that carries the condition being tested")
    if samp_entry is None:
        S.fail("no `sample` column bound — the SAMPLE is the unit of replication (INV-DA-2); "
               "without it there is nothing to replicate over and no honest test to run")

    populations_per_cell = S.read_column_values(pop_entry["path"], POPULATION_SLOT)
    conditions_per_cell = S.read_column_values(cond_entry["path"], CONDITION_SLOT)
    samples_per_cell = S.read_column_values(samp_entry["path"], SAMPLE_SLOT)
    n_cells = len(populations_per_cell)
    for name, vals in (("condition", conditions_per_cell), ("sample", samples_per_cell)):
        if len(vals) != n_cells:
            S.fail(f"the {name} column holds {len(vals)} values but the population column holds "
                   f"{n_cells} — they are not the same cells axis")
    if n_cells < S.MIN_VIABLE_CELLS:
        S.fail(f"refusing to test: {n_cells} cells is below the viable floor of "
               f"{S.MIN_VIABLE_CELLS}; there is nothing to count.")

    covariate_columns = S.read_covariate_columns(slots, n_cells)

    # ── INV-DA-3 — the regime is classified on the CONDITION, never the population ──
    condition_provenance = S.column_provenance(cond_entry["path"])
    population_provenance = S.column_provenance(pop_entry["path"])

    population_levels = sorted(set(populations_per_cell))
    sample_levels = sorted(set(samples_per_cell))
    condition_levels = sorted(set(conditions_per_cell))
    if len(population_levels) < 2:
        S.fail(f"refusing to test: the population column has {len(population_levels)} distinct "
               "level(s). Differential abundance compares populations against each other under a "
               "normalization; a single population carries no composition to compare.")
    if len(condition_levels) < 2:
        S.fail(f"refusing to test: the condition column has {len(condition_levels)} distinct "
               "level(s), so there is no contrast to test.")
    g1 = str(p.get("group1") or condition_levels[0])
    g2 = str(p.get("group2") or condition_levels[1])
    if g1 == g2 or g1 not in condition_levels or g2 not in condition_levels:
        S.fail(f"the contrast needs two distinct condition levels present in the column; got "
               f"group1={g1!r} group2={g2!r} over levels {condition_levels!r}.")

    # ── the (sample × population) INTEGER count matrix (INV-DA-2: rows are SAMPLES) ──
    progress("count", 25, f"counting cells over {len(population_levels)} populations × "
                          f"{len(sample_levels)} samples")
    import pandas as pd

    pop_index = {lv: j for j, lv in enumerate(population_levels)}
    samp_index = {lv: i for i, lv in enumerate(sample_levels)}
    counts = np.zeros((len(sample_levels), len(population_levels)), dtype=np.int64)
    for pop, samp in zip(populations_per_cell, samples_per_cell):
        counts[samp_index[str(samp)], pop_index[str(pop)]] += 1

    sample_condition = per_sample_value(conditions_per_cell, samples_per_cell, sample_levels,
                                        what="condition", fail=S.fail)
    sample_covariates = {
        name: per_sample_value(vals, samples_per_cell, sample_levels, what=f"covariate {name!r}",
                               fail=S.fail)
        for name, vals in covariate_columns.items()
    }

    # ── drop sub-`min_cells` samples, AND RECORD THEM (never a silent omission) ─────
    totals = counts.sum(axis=1)
    keep = totals >= min_cells
    dropped = [{"sample": sample_levels[i], "n_cells": int(totals[i]),
                "condition": sample_condition[i]}
               for i in range(len(sample_levels)) if not keep[i]]
    kept_levels = [sample_levels[i] for i in range(len(sample_levels)) if keep[i]]
    if len(kept_levels) == 0:
        S.fail(f"refusing to test: every sample holds fewer than min_cells={min_cells} cells "
               f"(dropped={dropped}). Lower `min_cells` or supply more cells per sample.")
    counts = counts[keep]
    sample_condition = [sample_condition[i] for i in range(len(sample_levels)) if keep[i]]
    sample_covariates = {k: [v[i] for i in range(len(sample_levels)) if keep[i]]
                         for k, v in sample_covariates.items()}

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
            "There is nothing to test on that side; lower `min_cells` or add replicates. Refused "
            "rather than fabricating a result from an empty side."
        )
    samples_per_side = min(n_samples_1, n_samples_2)

    # INV-DA-3 — classify on the CONDITION (+ the sample column for replication).
    regime = R.classify(condition_provenance, samples_per_side=samples_per_side)

    # ── establish the DECLARED normalization — this REFUSES rather than falling back ──
    progress("normalize", 45, f"establishing the {normalization!r} normalization")
    normalization = K.resolve_normalization(normalization, S.fail)
    reference_index = None
    if normalization == K.REFERENCE:
        if not reference:
            S.fail("refusing to test: the `reference` normalization was selected but no reference "
                   "population was named. Name a population present in every sample, or select "
                   "`poscounts`. There is no proportion fallback (INV-DA-1).")
        if str(reference) not in population_levels:
            S.fail(f"refusing to test: the reference population {str(reference)!r} is not one of "
                   f"the {len(population_levels)} populations in this run "
                   f"({population_levels[:8]!r}…). The additive-log-ratio normalization it "
                   "defines cannot be established, and the run never falls back to raw "
                   "proportions (INV-DA-1).")
        reference_index = pop_index[str(reference)]
    sf, norm_record = K.size_factors(counts, normalization=normalization,
                                     reference_index=reference_index,
                                     reference_name=(str(reference) if reference else None),
                                     fail=S.fail)

    desc = K.descriptive_columns(counts, sf, side1, side2)
    cols = {
        "logFC": desc["logFC"],
        "n_cells": desc["n_cells"],
        "mean_prop_1": desc["mean_prop_1"],
        "mean_prop_2": desc["mean_prop_2"],
        "n_samples_1": np.full(len(population_levels), float(n_samples_1)),
        "n_samples_2": np.full(len(population_levels), float(n_samples_2)),
        "score": desc["logFC"],  # ranked by effect when no p is written
    }
    mult_family = "none (descriptive; no p headlined)"
    fit_record = None
    p_written = False
    n_significant = None

    if regime == R.R1:
        progress("test", 65, f"negative-binomial count model ({method_key})")
        counts_df = pd.DataFrame(counts, index=kept_levels, columns=population_levels)
        design_df = pd.DataFrame({"condition": sample_condition, **sample_covariates},
                                 index=kept_levels)
        results, fit_record = K.fit(counts_df, design_df, (g1, g2), condition_col="condition",
                                    covariates=list(sample_covariates.keys()), method=method_key,
                                    normalization=normalization, reference=reference,
                                    small_sample_correction=small_sample_correction, fail=S.fail)
        logfc = np.array([results.get(pop, {}).get("logFC", np.nan) for pop in population_levels])
        pvals = np.array([results.get(pop, {}).get("pval", np.nan) for pop in population_levels])
        if np.all(np.isnan(pvals)):
            # NOT ONE population yielded a fittable p, so this is not an inferential result no
            # matter what the regime classifier said. A DOWNGRADE to R3 with the p-family ABSENT,
            # recorded by name — never a column of 1s presented as "tested and found nothing".
            # Reachable when the design consumes every residual degree of freedom (a covariate at
            # the R1 floor of two samples a side).
            regime = R.R3
            downgrade_reason = (
                "no population yielded a fittable p-value: the design "
                f"{(fit_record or {}).get('design_formula')!r} left "
                f"{(fit_record or {}).get('residual_df')!r} residual degrees of freedom over "
                f"{len(kept_levels)} surviving samples. Ranked effects only; the p-value and FDR "
                "are ABSENT, not 1.")
            fit_record = dict(fit_record or {}, regime_after_fit=R.R3, downgraded_from=R.R1,
                              downgrade_reason=downgrade_reason)
            # `logFC` and `score` KEEP the descriptive count-model effect they were seeded
            # with — a downgraded run is a descriptive run, and the fitted effect is unusable
            # here anyway.
            mult_family = "none (descriptive; no p headlined — the fit yielded no p-value)"
        else:
            cols["logFC"] = logfc
            neglog10p = K.neglog10(pvals)
            padj = K.bh(pvals)
            # A population the ENGINE REFUSED TO REPORT stays unreported, in every column.
            # PyDESeq2's Cook's-distance filter NaNs the p of a population whose fit is driven by
            # one outlying sample; `bh` propagates that NaN, and it must survive into `padj` and
            # the headline column too. Filling it with 1.0 would put the population back on the
            # volcano at y=0 as a tested-and-null point — the engine's refusal undone one column
            # further along than where it was undone before. NaN is already not a discovery
            # (`NaN <= q` is False), so the fill bought nothing and cost the mask.
            padj_written = padj
            cols["neglog10p"] = neglog10p
            cols["padj"] = padj_written
            # THE HEADLINE COLUMN, on the −log10 scale the shipped `volcano` chart kind's
            # significance channel is on. For DISJOINT cluster populations the headline IS plain
            # BH, so this is `-log10(padj)` — one column name across both analyses, so a consumer
            # never has to branch on which produced the table (INV-DA-4).
            cols["neglog10_significance"] = K.neglog10(padj_written)
            cols["score"] = neglog10p
            # NOTE: `spatial_fdr` is DELIBERATELY ABSENT here in every regime — populations are
            # DISJOINT named clusters, so a connectivity weight over them is meaningless, and
            # emitting a meaningless column is worse than omitting it (INV-DA-4).
            mult_family = "BH within comparison"
            p_written = True
            # The FDR threshold is APPLIED, not merely recorded: the run reports how many
            # populations it calls at the level the user chose.
            # NaN is EXCLUDED explicitly rather than mapped to a 1.0 sentinel: the
            # comparison is `<=`, so at `fdr = 1.0` — a form-valid input, and
            # unbounded for an agent call that never rendered the form — the sentinel
            # would count a population the engine refused to report as a discovery.
            _called = (padj_written <= fdr) & ~np.isnan(padj_written)
            n_significant = int(np.sum(_called))

    # ── write the ONE da/result for this comparison ─────────────────────────────────
    progress("write", 82, "writing the population table")
    comparison_label = f"{g1} vs {g2}"
    name = f"{base_name}:{g1}_vs_{g2}"
    rel = f"columns/{base_name}.zarr"
    result_attrs = {
        "analysis": ANALYSIS_ID,
        "comparison": comparison_label, "group1": g1, "group2": g2,
        "normalization": normalization,
        "normalization_assumption": K.NORMALIZATION_ASSUMPTION[normalization],
        "reference_population": (str(reference) if reference else None),
        "method": (fit_record or {}).get("method", method_key),
        "design_formula": (fit_record or {}).get("design_formula"),
        "small_sample_correction": (fit_record or {}).get("small_sample_correction"),
        "regime_note": S.regime_note_for(R, regime, fit_record),
        "pvalues_omitted": (not p_written),
        "samples_per_side": samples_per_side,
        "resolution_sensitivity": RESOLUTION_DISCLOSURE,
        "relative_abundance_caveat": RELATIVE_CAVEAT,
        "population_provenance": population_provenance,
        "condition_provenance": condition_provenance,
        "regime_classified_on": "condition",
        "significance_column": ("padj" if p_written else None),
        "headline_column": ("neglog10_significance" if p_written else None),
        "fdr_threshold": fdr,
        "n_significant": n_significant,
    }
    structure, meta = S.write_da_result(
        outputs_dir, rel, name, population_levels, cols, regime=regime,
        multiplicity_family=mult_family, extra_attrs=result_attrs)
    entries = [S.output_entry(f"da/result:{name}", S.DT_DA_RESULT, rel, "artifact",
                              structure=structure, meta=meta)]

    # ── the OPTIONAL per-cell signed-effect column (colours the UMAP for free) ──────
    # Populations here are DISJOINT, so each cell has exactly one effect and no arbitrary
    # reduction is needed. `da.neighbourhoods` deliberately emits no such column: a cell belongs
    # to MANY overlapping neighbourhoods, and inventing a reduction to fill a column would be
    # precisely the quiet fabrication this package refuses to do.
    if emit_effect_column:
        progress("effect-column", 88, "per-cell signed effect column")
        eff_by_pop = {pop: float(v) if np.isfinite(v) else float("nan")
                      for pop, v in zip(population_levels, np.asarray(cols["logFC"], float))}
        per_cell = [eff_by_pop.get(str(pop), float("nan")) for pop in populations_per_cell]
        eff_name = f"{base_name}_logFC"
        eff_rel = f"columns/{eff_name}.zarr"
        eff_structure, eff_meta = txr_columns.write_metadata_column(
            outputs_dir, eff_rel, eff_name, pd.Series(per_cell, dtype="float64"), axis="cells")
        S.stamp_txr_attributes(outputs_dir / eff_rel, eff_structure, da={
            "analysis": ANALYSIS_ID, "kind": "population-effect", "regime": regime,
            "comparison": comparison_label, "normalization": normalization,
            "resolution_sensitivity": RESOLUTION_DISCLOSURE,
        })
        eff_meta["da"] = {"analysis": ANALYSIS_ID, "kind": "population-effect"}
        entries.append(S.output_entry(f"metadata-column:{eff_name}", S.DT_METADATA_COLUMN,
                                      eff_rel, "artifact", structure=eff_structure, meta=eff_meta))

    # ── the run `da-report` index ───────────────────────────────────────────────────
    progress("report", 94, "run report")
    source_group = (f"population · {(fit_record or {}).get('method_label', method_key)}"
                    if p_written else "population · ranked effect")
    comparisons = [{"id": f"da/result:{name}", "key": f"da/result:{name}", "name": name,
                    "label": comparison_label, "comparison": comparison_label,
                    "qualifier": regime, "group": source_group, "source_group": source_group,
                    "regime": regime, "analysis": ANALYSIS_ID,
                    "significance_column": ("padj" if p_written else None),
                    "headline_column": ("neglog10_significance" if p_written else None),
                    "n_significant": n_significant,
                    "n_populations": len(population_levels)}]
    report = {
        "kind": "da-report", "analysis": ANALYSIS_ID, "product": "population-abundance",
        "regime": regime, "regime_note": S.regime_note_for(R, regime, fit_record), "pvalues_written": p_written,
        "regime_classified_on": "condition",
        "condition_provenance": condition_provenance,
        "population_provenance": population_provenance,
        "resolution_sensitivity": RESOLUTION_DISCLOSURE,
        "relative_abundance_caveat": RELATIVE_CAVEAT,
        "normalization": norm_record,
        "fit": fit_record,
        "method": (fit_record or {}).get("method", method_key),
        "methods_available": [m["key"] for m in K.catalog()],
        "normalizations_available": list(K.NORMALIZATIONS),
        "contrast": comparison_label,
        "multiplicity_family": mult_family,
        "small_sample_correction": (fit_record or {}).get("small_sample_correction"),
        "fdr_threshold": fdr, "n_significant": n_significant, "min_cells": min_cells,
        "n_cells": int(n_cells), "n_populations": len(population_levels),
        "n_samples": len(kept_levels), "n_samples_1": n_samples_1, "n_samples_2": n_samples_2,
        "samples_per_side": samples_per_side,
        "populations": population_levels, "samples": kept_levels,
        "dropped": dropped,
        "comparisons": comparisons, "grouped": True,
        "groups": [{"name": source_group, "count": len(comparisons)}],
        "determinism_env": S.resolved_determinism_env(),
        "library_versions": S.library_versions(),
    }
    (outputs_dir / "da-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.output_entry("da-report", S.DT_REPORT_QC, "da-report.json", "artifact",
                                  structure=txr_columns.opaque("application/json"),
                                  meta={"kind": "da-report", "analysis": ANALYSIS_ID,
                                        "n_comparisons": 1, "regime": regime}))
    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{comparison_label} ({regime})")


if __name__ == "__main__":
    main()
