#!/usr/bin/env python3
# ruff: noqa
"""_kernel — the COMPOSITIONAL KERNEL both DA analyses stand on (INV-DA-1 / INV-DA-2 / INV-DA-4).

This module is the reason the feature is scientifically valid rather than a false-positive
generator, so read the trap before the code.

## The trap

Cell-population proportions are COMPOSITIONAL: they are constrained to sum to 1. A real increase
in ONE population MECHANICALLY depresses every other population's proportion, whether or not
anything happened to those populations. Two consequences:

  1. A per-population t-test / Wilcoxon on proportions is STATISTICALLY INVALID. It reports
     confident false positives for every unchanged population as soon as any population truly
     moves — and the error rate scales WITH the effect size, so the bigger the real biology, the
     more false discoveries it manufactures. This is not a subtle inefficiency; it is the
     dominant error mode, and it is invisible to a reader of the output.
  2. CELLS ARE NOT REPLICATES. 10,000 cells from 2 donors carry 2 units of information about a
     between-donor contrast, not 10,000.

The two failures are INDEPENDENT. Aggregating to samples fixes replication and does NOTHING for
compositionality; normalizing fixes compositionality and does NOTHING for replication. Both are
handled here, separately and by name.

## What this module does instead (INV-DA-1)

Every p-value comes from a COUNT model over the integer `(sample × population)` matrix under an
EXPLICITLY NAMED normalization. There are exactly two, and deliberately no third:

  · `poscounts` (default) — DESeq2's robust median-of-ratios size factors computed over the
    POSITIVE counts only. ASSUMPTION: MOST POPULATIONS ARE UNCHANGED. Robust to a minority of
    shifting populations; it breaks down if a majority move. This is the TMM-family answer, and
    it is what makes the negative control pass: a shift confined to one population does not move
    a median, so the other populations' size factors — and therefore their tests — are unmoved.
  · `reference` (opt-in) — the additive-log-ratio transform: the size factor is the named
    reference population's own count, so every effect is explicitly RELATIVE TO THAT POPULATION.
    ASSUMPTION: THE NAMED REFERENCE POPULATION'S ABSOLUTE ABUNDANCE IS CONSTANT. This is scCODA's
    identifiability device without scCODA's dependency stack.

There is NO proportion mode, and no fallback to one. A run that cannot establish a normalization
— an unknown mode, a reference population absent from the data, a reference with a zero count in
some sample (the log-ratio is undefined), a degenerate count matrix — REFUSES BY NAME. Search
this package for a per-population proportion test and you will not find one; that absence is
asserted by `tests/test_no_proportion_fallback.py`, by source inspection as well as behaviour.

The honest caveat, which reaches `methods.md`: NEITHER mode measures ABSOLUTE abundance. Without a
spike-in or a total-cell-count measurement, single-cell data cannot distinguish "A went up" from
"everything else went down". Both modes report a RELATIVE shift under a STATED assumption.

## Replication (INV-DA-2)

The count matrix's ROW space is SAMPLES. `< 2` samples on either side is regime R3 and the caller
writes NO p-value (absent, not 1). Samples below `min_cells` are dropped AND RECORDED.

## Multiplicity (INV-DA-4)

`bh()` is plain Benjamini-Hochberg. `weighted_bh()` is the connectivity-weighted variant Milo
calls SPATIAL FDR: overlapping neighbourhoods are positively dependent, so plain BH is
anti-conservative exactly where the graph is dense (which is where the interesting biology
usually is). Weighting by `1/kth-nearest-neighbour distance` makes a denser neighbourhood consume
proportionally more of the error budget. `da.neighbourhoods` writes BOTH; `da.clusters` writes
only plain `padj`, because clusters are DISJOINT and a connectivity weight over them would be
meaningless — and emitting a meaningless column is worse than omitting it.
"""
import numpy as np


# ── the normalization vocabulary — CLOSED, and there is no third entry ─────────────
POSCOUNTS = "poscounts"
REFERENCE = "reference"
NORMALIZATIONS = (POSCOUNTS, REFERENCE)
NORMALIZATION_DEFAULT = POSCOUNTS

#: The assumption each mode makes, narrated BY NAME into the report + the artifact provenance.
#: INV-DA-1 requires the normalization AND its assumption to be stated, not merely recorded.
NORMALIZATION_ASSUMPTION = {
    POSCOUNTS: ("robust median-of-ratios size factors over the positive counts (DESeq2 "
                "`poscounts`) — this assumes MOST POPULATIONS ARE UNCHANGED between the "
                "conditions, and it breaks down if a majority of them move"),
    REFERENCE: ("an additive-log-ratio (ALR) offset against the named reference population — "
                "this assumes THAT POPULATION'S ABSOLUTE ABUNDANCE IS CONSTANT between the "
                "conditions, and every effect is explicitly relative to it"),
}


# ── the count-model engine registry (mirrors differential-expression/_methods.py) ──
_METHODS = {}
METHOD_DEFAULT = "pydeseq2"


def register_method(key, *, label, description, requires, run, small_sample_correction):
    """`small_sample_correction` is the engine's DEFAULT reference distribution for its Wald
    statistic — see `t_reference_pvalues` for why it is a PER-ENGINE, MEASURED property rather
    than one global switch. It is always recorded on the result, and always overridable."""
    _METHODS[key] = {"key": key, "label": label, "description": description,
                     "requires": list(requires), "run": run,
                     "small_sample_correction": bool(small_sample_correction)}


def catalog():
    """The count-model descriptors, DECLARATION ORDER (default first) — the source the run
    forms' method enum renders from. Adding an engine is a code-only `catalog()` entry."""
    return [_METHODS[k] for k in _METHODS]


def resolve_method(key, fail):
    """The engine descriptor for `key`, defaulting to PyDESeq2; an unknown key is refused BY
    NAME (never silently swapped to the default)."""
    key = str(key or METHOD_DEFAULT)
    d = _METHODS.get(key)
    if d is None:
        fail(f"unknown differential-abundance method {key!r}; the registered engines are "
             f"{sorted(_METHODS)} (adding one is a code-only catalog() entry).")
    return d


def resolve_normalization(key, fail):
    """The normalization mode, refused BY NAME when it is not one of the two declared modes.
    THERE IS NO PROPORTION MODE and no fallback to one (INV-DA-1)."""
    key = str(key or NORMALIZATION_DEFAULT)
    if key not in NORMALIZATIONS:
        fail(
            f"unknown normalization {key!r}. Differential abundance tests INTEGER counts under "
            f"one of exactly two declared normalizations: {list(NORMALIZATIONS)!r}. There is "
            "deliberately no proportion mode — a per-population test on raw proportions is "
            "invalid because proportions are compositional, and its error rate grows WITH the "
            "size of the real effect. The run refuses rather than falling back to one."
        )
    return key


# ── size factors — the compositional lever, computed HERE so both engines share it ──
def poscounts_size_factors(counts, *, fail):
    """DESeq2 `poscounts` size factors for a `(n_samples × n_populations)` integer matrix.

    Mirrors PyDESeq2's `DeseqDataSet.fit_size_factors(fit_type="poscounts")` exactly, so the
    PyDESeq2 engine (which computes them internally) and the NB-GLM engine (which takes them as
    an offset) normalize IDENTICALLY — that equality is pinned by a test:

        log_counts   = log(X) where X != 0, else 0
        logmeans     = log_counts.mean(axis=0)                  # over SAMPLES
        usable       = isfinite(logmeans) & (logmeans > 0)
        sf_i         = exp(median_j∈usable, X_ij>0 ( log(X_ij) - logmeans_j ))
        sf          /= exp(mean(log(sf)))                       # geometric mean 1

    Refuses BY NAME when no population is usable — there is no normalization to establish, and
    the alternative (testing raw proportions) is exactly what INV-DA-1 forbids."""
    X = np.asarray(counts, dtype=np.float64)
    log_counts = np.zeros_like(X)
    np.log(X, out=log_counts, where=X != 0)
    logmeans = log_counts.mean(axis=0)
    usable = (~np.isinf(logmeans)) & (logmeans > 0)
    if not usable.any():
        fail(
            "refusing to test: no population has a usable geometric mean across samples, so the "
            "`poscounts` robust size factors cannot be established (every population is empty or "
            "present in at most one cell per sample). Differential abundance never falls back to "
            "raw proportions — a per-population proportion test is invalid because proportions "
            "are compositional — so the run refuses rather than returning a plausible wrong "
            "answer. Merge or drop the degenerate populations, or supply more cells per sample."
        )
    sf = np.empty(X.shape[0], dtype=np.float64)
    for i in range(X.shape[0]):
        mask = usable & (X[i] > 0)
        if not mask.any():
            fail(
                f"refusing to test: sample index {i} has no positive count in any usable "
                "population, so its `poscounts` size factor is undefined. The run refuses rather "
                "than substituting a proportion-based statistic (INV-DA-1). Drop that sample or "
                "lower `min_cells`."
            )
        sf[i] = np.exp(np.median(np.log(X[i][mask]) - logmeans[mask]))
    sf = sf / np.exp(np.mean(np.log(sf)))
    return sf


def reference_size_factors(counts, ref_index, *, fail, ref_name=None):
    """ALR size factors: the named reference population's own count per sample, centred to a
    geometric mean of 1. `sf_i = X[i, ref] / geomean_i(X[:, ref])`.

    Refuses BY NAME when the reference population carries a ZERO in any sample — the log-ratio is
    undefined there, and the run must not quietly substitute something else (INV-DA-1)."""
    X = np.asarray(counts, dtype=np.float64)
    col = X[:, int(ref_index)]
    if np.any(col <= 0):
        zeros = int(np.sum(col <= 0))
        fail(
            f"refusing to test: the reference population {ref_name!r} has ZERO cells in "
            f"{zeros} of the {col.size} samples, so the additive-log-ratio normalization it "
            "defines is undefined there. The reference mode's whole claim is that this "
            "population's absolute abundance is constant; a sample without it cannot support "
            "that claim. Choose a reference population present in every sample, or use the "
            "`poscounts` normalization. The run refuses rather than falling back to raw "
            "proportions (INV-DA-1)."
        )
    return col / np.exp(np.mean(np.log(col)))


def size_factors(counts, *, normalization, reference_index=None, reference_name=None, fail):
    """The size factors for the DECLARED normalization, plus the record that names it and its
    assumption. This is the single place a normalization is established; there is no other."""
    if normalization == POSCOUNTS:
        sf = poscounts_size_factors(counts, fail=fail)
    elif normalization == REFERENCE:
        if reference_index is None:
            fail(
                "refusing to test: the `reference` normalization needs a reference population, "
                "and none was resolved. Name a population present in every sample, or use the "
                "`poscounts` normalization. The run never falls back to raw proportions "
                "(INV-DA-1)."
            )
        sf = reference_size_factors(counts, reference_index, fail=fail,
                                    ref_name=reference_name)
    else:  # unreachable: `resolve_normalization` already refused by name.
        fail(f"unknown normalization {normalization!r} reached the size-factor step")
    record = {"normalization": normalization,
              "assumption": NORMALIZATION_ASSUMPTION[normalization],
              "reference_population": reference_name,
              "size_factors": [float(x) for x in sf]}
    return sf, record


# ── multiplicity ───────────────────────────────────────────────────────────────────
def bh(pvals):
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


def weighted_bh(pvals, weights):
    """Connectivity-weighted Benjamini-Hochberg — Milo's SPATIAL FDR (INV-DA-4).

    Overlapping neighbourhoods are strongly positively dependent, so the effective number of
    independent tests is far below the neighbourhood count and plain BH is anti-conservative in
    dense graph regions. Weighting each neighbourhood by `1/kth-nearest-neighbour distance` makes
    a denser neighbourhood consume proportionally more of the error budget:

        adj_rev = (sum(w) * p_sorted / cumsum(w_sorted))[::-1]
        adj     = minimum.accumulate(adj_rev)[::-1]      # monotone in sorted p
        adj     = minimum(adj, 1.0)                      # capped

    An INFINITE weight (a zero kth distance — a duplicated cell) is treated as zero rather than
    poisoning the cumulative sum. A NaN p-value stays NaN here AND is written as NaN by the
    caller: an engine that refused to report a neighbourhood (PyDESeq2's Cook's filter masks one
    whose fit is driven by a single outlying sample) must not have that refusal undone downstream.
    A NaN is already not a discovery — `NaN <= q` is False — so nothing is gained by filling it,
    and filling it would put the neighbourhood back on the volcano as a tested-and-null point.

    With UNIFORM weights this reduces exactly to plain BH — the degenerate-case pin the tests
    assert, which is what shows the weighting is a refinement of BH and not a different animal."""
    p = np.asarray(pvals, dtype=np.float64)
    w = np.asarray(weights, dtype=np.float64)
    w = np.where(np.isinf(w), 0.0, w)
    out = np.full(p.shape, np.nan)
    keep = ~np.isnan(p)
    if not keep.any():
        return out
    pk = p[keep]
    wk = w[keep]
    order = np.argsort(pk)
    p_sorted = pk[order]
    w_sorted = wk[order]
    denom = np.cumsum(w_sorted)
    with np.errstate(divide="ignore", invalid="ignore"):
        adj_rev = (wk.sum() * p_sorted / denom)[::-1]
    adj = np.minimum.accumulate(adj_rev)[::-1]
    adj = np.minimum(adj, 1.0)
    final = np.empty_like(pk)
    final[order] = adj
    out[keep] = final
    return out


# ── the SMALL-SAMPLE reference distribution ────────────────────────────────────────
#
# MEASURED DEFECT, AND ITS DOCUMENTED REMEDY.
#
# Both engines produce a Wald statistic and refer it to a NORMAL distribution. That reference
# ignores the uncertainty in the fitted dispersion, and differential abundance runs on FEW
# samples and FEW populations — nothing like the thousands of genes DESeq2's shrinkage was built
# for. Measured on the acceptance fixture (P=12 populations, R=5 replicates per side, 470 null
# simulations), the PyDESeq2 path's null p-values have an inflated LEFT TAIL — `P(p < 0.01)` is
# 0.016 against a nominal 0.01 — and the consequence is that 16% of completely-null simulations
# produce at least one Benjamini-Hochberg discovery at q = 0.10 instead of the nominal 10%. That
# is a real failure of the FDR-control half of the acceptance battery, and it is a property of
# the small-sample Wald test rather than of the compositional handling: at 8 samples per side the
# same p-values are calibrated.
#
# The remedy is the one DESeq2 itself ships for this case (`useT = TRUE`): refer the Wald
# statistic to a STUDENT-t distribution on the residual degrees of freedom
# (`n_samples - rank(design)`) instead of to a normal. Measured with it on, over the same 120
# null simulations: `P(p < 0.01)` falls to 0.0028 and the family-wise null discovery rate falls
# from 0.183 to 0.017.
#
# It is ON by default because a differential-abundance run is a small-sample design by
# construction, and it is a NAMED, RECORDED parameter rather than a silent transformation — the
# two-tier parity test turns it OFF to reproduce `pertpy.tools.Milo(solver="pydeseq2")`'s exact
# normal-reference p-values, which is what makes the tight tier a genuine comparison rather than
# a comparison with our own correction folded into both sides.
#
# `scipy.special.stdtr` is the Student-t CDF. Deliberately NOT `scipy.stats`: no shipped compute
# file may import it, because that is the module a proportion test would come from and
# `tests/test_no_proportion_fallback.py` asserts its absence by source inspection.
def t_reference_pvalues(statistics, df):
    """Two-sided p-values for Wald statistics referred to `t(df)` instead of to a normal.

    A non-positive `df` means the design consumed every degree of freedom; there is nothing left
    to estimate the residual scale with, so the p-values are NaN (absent) rather than optimistic.
    """
    from scipy.special import stdtr

    z = np.asarray(statistics, dtype=np.float64)
    if df is None or df <= 0:
        return np.full(z.shape, np.nan)
    with np.errstate(invalid="ignore"):
        return 2.0 * stdtr(int(df), -np.abs(z))


def residual_df(n_samples, design_matrix):
    """`n_samples - rank(design)` — the residual degrees of freedom the t reference uses."""
    rank = int(np.linalg.matrix_rank(np.asarray(design_matrix, dtype=np.float64)))
    return int(n_samples) - rank


def engine_size_factors(dds, *, fail=None):
    """PyDESeq2's OWN fitted size factors, read from wherever this version keeps them.

    ── WHY THIS IS NOT JUST `dds.obs["size_factors"]` ────────────────────────────────────────
    PyDESeq2 has moved this key twice inside the range this package declares. Measured directly
    against the wheels rather than inferred:

        0.4.x   `obs["size_factors"]`
        0.5.0   `obsm["size_factors"]`     <- our `.obs` read raises KeyError here
        0.5.1   `obsm["size_factors"]`     <- and here
        0.5.2   `obs["size_factors"]`      (17 occurrences in dds.py, 0 of `obsm`)
        0.5.3   `obs["size_factors"]`
        0.5.4   `obs["size_factors"]`      <- the version `requirements.txt` actually pins

    So the SHIPPED configuration was always fine, and a round-R2 audit that installed 0.5.1 —
    the newest the local package mirror offers — correctly found a crash and then over-generalised
    it to "the default engine crashes on every run". It does not. What was genuinely wrong is
    narrower and still real: `run.dependencies[]` declared `>=0.5,<0.6`, which ADMITS 0.5.0 and
    0.5.1, and `txr_deps.resolve_and_check()` will happily certify a deployment that resolved one
    of them. The environment contract was wider than the code it was certifying.

    Both halves are fixed: the declaration is narrowed to `>=0.5.2,<0.6`, and this reader accepts
    either layout so the code is not silently coupled to one release's internals. If NEITHER
    carries it, that is refused BY NAME — a raw `KeyError` out of a library is not one of this
    package's answers.
    """
    for container in (getattr(dds, "obs", None), getattr(dds, "obsm", None)):
        if container is None:
            continue
        try:
            if "size_factors" not in container:
                continue
            values = container["size_factors"]
        except Exception:
            continue
        return np.asarray(getattr(values, "values", values), dtype=np.float64).ravel()
    message = (
        "the PyDESeq2 engine fitted successfully but exposes its size factors under neither "
        "`obs['size_factors']` nor `obsm['size_factors']`. This package RECORDS the engine's own "
        "factors so the compositional normalization it used can be checked against the one it was "
        "asked for (INV-DA-1), and it will not report a result whose normalization it cannot "
        "evidence. Pin `pydeseq2>=0.5.2,<0.6`, the range this package declares and tests against."
    )
    if fail is not None:
        fail(message)
    raise KeyError(message)


def correct_preserving_mask(engine_p, statistics, df):
    """Refer `statistics` to `t(df)` — but ONLY where the engine actually reported a p-value.

    ── WHY THIS IS ONE FUNCTION ON THE COMMON PATH ───────────────────────────────────────────
    An engine may DECLINE to report a p-value for a population while still returning a finite
    effect and a finite statistic. PyDESeq2 does exactly that: `DeseqStats.summary()` runs
    Cook's-distance filtering and sets `pvalue` to NaN for a population whose fit is driven by a
    single outlying sample, leaving `stat` and `log2FoldChange` FINITE. Recomputing the p from
    `stat` for every row hands those rows a fresh, finite p — the engine's own refusal to report,
    silently undone, letting an outlier-driven population become a discovery.

    This used to live inside the PyDESeq2 engine, where it was UNTESTABLE on any host without the
    `pydeseq2` wheel: a round-R1 mutation reverted it to `assign(pvalue=corrected)` and the entire
    suite stayed green, because every test that reached that line sat behind an `importorskip`.
    A guarantee that only one host can check is not a guarantee. It is now applied ONCE, by
    `fit()`, to whatever the engine returned — so it holds for EVERY engine by construction, and
    `tests/test_kernel_normalization.py` pins it in-process through a registered stub engine that
    reproduces the masked-but-fitted row on any host at all.

    `engine_p` and `statistics` are parallel arrays; NaN in `engine_p` means "absent, and it stays
    absent". A non-positive `df` nulls the whole family (see `t_reference_pvalues`).
    """
    engine_p = np.asarray(engine_p, dtype=np.float64)
    corrected = np.asarray(t_reference_pvalues(statistics, df), dtype=np.float64)
    return np.where(np.isnan(engine_p), np.nan, corrected)


# ── the design matrix (shared by both engines) ─────────────────────────────────────
def _design_matrix(design_df, condition_col, covariates):
    """`(X, columns)` — an intercept, drop-first dummies for every covariate, and drop-first
    dummies for the condition. Categorical levels are sorted so the encoding is deterministic."""
    import pandas as pd

    cols = ["Intercept"]
    blocks = [np.ones((len(design_df), 1), dtype=np.float64)]
    for cov in covariates:
        levels = sorted(set(str(v) for v in design_df[cov]))
        for lv in levels[1:]:
            cols.append(f"{cov}[{lv}]")
            blocks.append(
                (design_df[cov].astype(str).values == lv).astype(np.float64).reshape(-1, 1))
    levels = sorted(set(str(v) for v in design_df[condition_col]))
    for lv in levels[1:]:
        cols.append(f"{condition_col}[{lv}]")
        blocks.append(
            (design_df[condition_col].astype(str).values == lv).astype(np.float64).reshape(-1, 1))
    return np.hstack(blocks), cols, levels


def refuse_rank_deficient_design(design_df, condition_col, covariates, *, fail):
    """REFUSE a design whose columns are linearly dependent, naming the terms involved.

    This is not defensive tidying — it is a wrong-answer guard. `statsmodels` fits a rank-deficient
    design through a pseudo-inverse and only WARNS: with a covariate perfectly confounded with the
    condition (a `batch` where control and treated were processed in different batches — the single
    most common real covariate) the effect is split evenly across the collinear terms, and
    `_contrast_vector` reads only the condition's share, so the reported `logFC` comes back
    HALVED with exit code 0 and a complete result written. There is no honest answer to give for a
    confounded design; there is only a refusal that names what is confounded.
    """
    covariates = list(covariates)
    D, cols, _levels = _design_matrix(design_df, condition_col, covariates)
    rank = int(np.linalg.matrix_rank(D))
    if rank < D.shape[1]:
        fail(
            f"refusing to test: the design {'~' + ' + '.join([*covariates, condition_col])!r} is "
            f"RANK-DEFICIENT over the {D.shape[0]} surviving samples — rank {rank} of "
            f"{D.shape[1]} columns ({cols!r}). Some set of those columns is a linear combination "
            "of the others, so their separate effects are NOT identifiable and no amount of "
            "fitting can tell them apart. The usual cause is a covariate confounded with the "
            "condition (every sample of one condition sharing a covariate value no sample of the "
            "other has); it can also be two covariates that track each other, or a covariate with "
            "so many levels that it saturates the design. A fit would still return a number — the "
            "effect split across the dependent terms — which is why the run refuses instead of "
            "reporting it. Drop or coarsen the offending covariate, or collect samples that break "
            "the dependency."
        )
    return D, cols


def _contrast_vector(cols, condition_col, levels, g1, g2):
    """The linear contrast that reads `g1 − g2` off a drop-first condition encoding: the
    reference level contributes 0, every other level its own coefficient."""
    c = np.zeros(len(cols), dtype=np.float64)
    base = levels[0]
    if g1 != base:
        c[cols.index(f"{condition_col}[{g1}]")] += 1.0
    if g2 != base:
        c[cols.index(f"{condition_col}[{g2}]")] -= 1.0
    return c


# ── engine 1: PyDESeq2 Wald (the default; the tight-parity subject) ────────────────
def _run_pydeseq2(counts_df, design_df, contrast, *, condition_col, covariates, normalization,
                  reference_name, fail, small_sample_correction=True, force_absent=False):
    """PyDESeq2 negative-binomial Wald test over the integer `(sample × population)` matrix.

    This is the SAME call `pertpy.tools.Milo(solver="pydeseq2")` makes — `DeseqDataSet(...,
    refit_cooks=True, size_factors_fit_type="poscounts")` then `DeseqStats(dds, contrast=[factor,
    g1, g2])` — which is what makes the tight parity tier in `tests/test_parity.py` a legitimate
    bar rather than a hope.

    For the `reference` (ALR) normalization the size factors are fitted from the reference
    population ALONE, via DESeq2's `controlGenes` device with the plain median-of-ratios fit.
    That is exactly `sf_i = X[i, ref] / geomean(X[:, ref])`, i.e. the ALR offset. The caller has
    already refused a reference carrying a zero, which is also what keeps PyDESeq2 out of its
    "every gene has a zero ⇒ switch to iterative" branch.

    A NAMED refusal when `pydeseq2` is absent — never a raw `ImportError` mid-pipeline.
    `DA_FORCE_PYDESEQ2_ABSENT=1` forces the absent branch so the refusal can be exercised."""
    import os
    if force_absent or os.environ.get("DA_FORCE_PYDESEQ2_ABSENT") == "1":
        fail(
            "the PyDESeq2 differential-abundance engine needs the `pydeseq2` wheel, which is not "
            "installed in this environment. It is pinned in "
            "`env-rootfs/single-cell/Dockerfile`; a deployment missing it should install the "
            "single-cell rootfs, or select the NB-GLM engine. The run refuses BY NAME rather "
            "than raising a raw ImportError mid-pipeline."
        )
    try:
        import inspect
        from pydeseq2.dds import DeseqDataSet
        from pydeseq2.ds import DeseqStats
    except Exception:
        fail(
            "the PyDESeq2 differential-abundance engine needs the `pydeseq2` wheel (import "
            "failed). It is pinned in `env-rootfs/single-cell/Dockerfile`; install the "
            "single-cell rootfs or select the NB-GLM engine."
        )
    import pandas as pd

    g1, g2 = contrast
    meta = design_df.copy()
    for c in [condition_col, *covariates]:
        meta[c] = meta[c].astype(str).astype("category")

    formula = "~" + " + ".join([*covariates, condition_col])
    sig = inspect.signature(DeseqDataSet.__init__).parameters
    kwargs = dict(counts=counts_df.astype(int), metadata=meta, refit_cooks=True)
    if "design" in sig:
        kwargs["design"] = formula
    else:  # pydeseq2 < 0.5 — the formula seam was `design_factors`
        if covariates:
            fail(
                "this deployment's `pydeseq2` predates formula designs (`design=`), so the "
                "recorded covariates cannot be put in the model. Re-run without covariates, or "
                "select the NB-GLM engine, or update the single-cell rootfs. The run refuses "
                "rather than silently dropping a covariate from the design formula."
            )
        kwargs["design_factors"] = condition_col
    if "size_factors_fit_type" not in sig:
        fail(
            "this deployment's `pydeseq2` does not expose `size_factors_fit_type`, so the "
            "declared normalization cannot be established through it. Select the NB-GLM engine "
            "or update the single-cell rootfs; the run refuses rather than testing under an "
            "unnamed normalization (INV-DA-1)."
        )
    if normalization == POSCOUNTS:
        kwargs["size_factors_fit_type"] = "poscounts"
    else:
        if "control_genes" not in sig:
            fail(
                "this deployment's `pydeseq2` does not expose `control_genes`, so the "
                "reference-population (ALR) normalization cannot be established through it. "
                "Select the NB-GLM engine, use `poscounts`, or update the single-cell rootfs; "
                "the run refuses rather than testing under a different normalization than the "
                "one it was asked for (INV-DA-1)."
            )
        kwargs["size_factors_fit_type"] = "ratio"
        kwargs["control_genes"] = [str(reference_name)]

    dds = DeseqDataSet(**kwargs)
    dds.quiet = True
    dds.deseq2()
    stats = DeseqStats(dds, contrast=[condition_col, str(g1), str(g2)], quiet=True)
    stats.summary()
    res = stats.results_df

    # The residual degrees of freedom the SMALL-SAMPLE reference will use. The reference itself is
    # NOT applied here: `fit()` applies it to every engine's output through
    # `correct_preserving_mask`, so the "a masked p-value stays masked" rule is one statement on
    # the common path rather than one copy per engine behind an `importorskip`. This engine only
    # has to report the df it would have used, and hand back its own `stat` and `pvalue` untouched.
    df = None
    if small_sample_correction:
        design_matrix = dds.obsm.get("design_matrix")
        if design_matrix is None:
            # Never GUESS the rank: a guessed-too-large df makes the t reference lighter-tailed,
            # i.e. ANTI-conservative — the opposite of what this correction exists to do. Our own
            # design matrix is always available and is the same model.
            own, _cols, _levels = _design_matrix(meta, condition_col, list(covariates))
            df = residual_df(counts_df.shape[0], own)
        else:
            df = residual_df(counts_df.shape[0], np.asarray(design_matrix))

    out = {}
    for pop, row in res.iterrows():
        out[str(pop)] = {
            "logFC": float(row.get("log2FoldChange", float("nan"))),
            "pval": float(row.get("pvalue", float("nan"))),
            "stat": float(row.get("stat", float("nan"))),
            "base_mean": float(row.get("baseMean", float("nan"))),
        }
    fitted_sf = engine_size_factors(dds, fail=fail)
    return out, {"engine_size_factors": [float(x) for x in fitted_sf],
                 "small_sample_correction": bool(small_sample_correction),
                 "residual_df": (None if df is None else int(df))}


# ── engine 2: statsmodels NB-GLM with the SAME size factors as an offset ──────────
#
# The compositional correctness lives in the SIZE FACTORS, not in which NB engine fits the mean
# model — so this engine is handed the very same factors `size_factors()` computes for the
# PyDESeq2 path, as `offset = log(size_factor)`. That is what lets the acceptance battery prove
# INV-DA-1 on a deployment where the `pydeseq2` wheel is absent: the invariant under test is the
# normalization, and both engines carry it identically (pinned by
# `tests/test_kernel_normalization.py`).
#
# NOTE the offset is NOT the library size. Using per-sample TOTAL counts as the offset is exactly
# the proportion model, and it is what the negative control catches: a population that truly
# rises inflates the total, which then depresses every other population's fitted rate. A median
# of ratios does not move.
_NB_ALPHA_FLOOR = 1e-8
_NB_ALPHA_CAP = 1e3
_NB_EB_SHRINK = 0.2


def _mom_nb_dispersion(y, mu):
    """Per-population NB overdispersion by method of moments on the offset-adjusted counts:
    `Var = mu + alpha·mu²  ⇒  alpha = (Var − mu)/mu²`, clamped away from the degenerate ends."""
    y = np.asarray(y, dtype=np.float64)
    mu = float(mu)
    if mu <= 0.0:
        return _NB_ALPHA_FLOOR
    var = float(y.var(ddof=1)) if y.size > 1 else mu
    alpha = (var - mu) / (mu * mu)
    return float(min(max(alpha, _NB_ALPHA_FLOOR), _NB_ALPHA_CAP))


def estimate_dispersions(counts, sf):
    """Per-population dispersion with a light empirical-Bayes shrink toward the shared
    (geometric-mean) dispersion — a real per-population estimate, never a fixed 1.0.

    ── THIS IS THE MARGINAL DISPERSION, AND THAT IS A DELIBERATE, MEASURED CHOICE ────────────
    The variance is taken about each population's GRAND mean, pooling both conditions — NOT about
    the design's fitted values. Textually that is the wrong quantity: `Var = mu + alpha·mu²`
    describes variance around the FITTED mean, so pooling counts a real condition effect as
    overdispersion, and a population that genuinely moved is handed the largest `alpha`. A round-R2
    audit found this and it is a fair reading of the formula.

    The design-conditional version was implemented and MEASURED, and it is not shippable at these
    sample sizes:

        complete-null FDR simulation   56/200 runs rejected — rate 0.280,
                                       exact 95% upper bound 0.337, against a 0.10 bar
        compositional negative control 2 of 11 unchanged populations called, against a bar of 1

    The mechanism is small-sample: with 10 samples and rank-2 design there are 8 residual df, the
    residual variance frequently lands below the Poisson mean, `alpha` clamps to `_NB_ALPHA_FLOOR`,
    and the GLM then tests as if the counts were Poisson — badly overconfident. The marginal
    estimate's upward bias is what holds the false-positive rate down, and the empirical-Bayes
    shrink toward the shared dispersion is what stops any single population's estimate running away.

    So the bias is REAL, its direction is CONSERVATIVE (it costs power on true positives, it does
    not manufacture false ones), and removing it properly needs a fitted dispersion TREND across
    populations with shrinkage toward it — DESeq2's approach — which is a design change with its
    own acceptance measurement, not a one-line substitution. Tuning the shrink until the bars go
    green again would be fitting the estimator to its own test.

    `record["dispersions"]` therefore carries the MARGINAL overdispersion. It is reported for
    provenance and is not the residual dispersion of the fitted model; nothing downstream treats
    it as one.
    """
    X = np.asarray(counts, dtype=np.float64)
    normed = X / np.asarray(sf, dtype=np.float64)[:, None]
    raw = []
    for j in range(X.shape[1]):
        raw.append(_mom_nb_dispersion(normed[:, j], normed[:, j].mean()))
    shared = float(np.exp(np.mean(np.log([max(a, _NB_ALPHA_FLOOR) for a in raw]))))
    return [float(min(max((1.0 - _NB_EB_SHRINK) * a + _NB_EB_SHRINK * shared, _NB_ALPHA_FLOOR),
                      _NB_ALPHA_CAP)) for a in raw]


#: A Wald standard error above this is not a wide interval — it is a NON-IDENTIFIED fit.
#: Measured on this design: a healthy population's contrast SE is ~0.3, and a completely
#: separated one is ~1.6e4. Four orders of magnitude of daylight, so the bound needs no tuning;
#: anything inside that gap gives the same verdict. It is a named constant rather than a literal
#: so the measurement travels with the number.
_MAX_WALD_SE = 1e3


class _Unidentified(Exception):
    """A fit statsmodels reports as converged but which identifies no finite coefficient."""


def _unidentified_reason(y, side1_rows, side2_rows, fitted, res):
    """Why this population's contrast carries no testable coefficient — or `None` if it does.

    THE DEFECT THIS CLOSES. A population with zero cells in every sample of one contrast side is
    a complete-separation MLE: the likelihood is maximised as the coefficient runs to infinity.
    `statsmodels` IRLS does not raise and does not report failure — it stops at the iteration cap
    with `converged=True`, a coefficient around +/-25 on the log scale and a standard error around
    1.6e4. The Wald statistic is then ~0.0016 and the p-value comes back ~0.999.

    Left undetected that is the WORST possible outcome for this analysis: the strongest signal a
    DA run can contain — a population present in one condition and absent from the other — is
    written as a tested-and-null result, sorts LAST on the volcano and in the ranked table, and
    carries a fabricated finite `logFC` of ~10^10-fold. `n_fit_failures` stays 0, so the run
    record states that nothing went wrong.

    Note WHERE this sits relative to everything else that guards INV-DA-2. The `padj`/`spatial_fdr`
    write path is pinned behaviourally by reading the written column back off disk, which no
    spelling of a fill can evade. That guard cannot reach this: it preserves an absence once one
    exists, and here the engine never produced an absence to preserve. The fabrication happens
    UPSTREAM of the mask, so the mask is not the place to catch it.

    Both tests below are real and neither subsumes the other:
      * the STRUCTURAL one is exact and needs no threshold — zero counts across an entire side is
        separation by definition, whatever the optimiser then reports;
      * the NUMERICAL one catches the fits that are merely near-separated or otherwise
        rank-deficient in a way the structural test cannot see.
    """
    if side1_rows.any() and not np.any(y[side1_rows] > 0):
        return ("the population has zero cells in every sample of the first contrast side, so "
                "the coefficient is unbounded (complete separation) and no Wald p-value exists")
    if side2_rows.any() and not np.any(y[side2_rows] > 0):
        return ("the population has zero cells in every sample of the second contrast side, so "
                "the coefficient is unbounded (complete separation) and no Wald p-value exists")
    if not bool(getattr(fitted, "converged", True)):
        return "the IRLS fit did not converge"
    sd = float(np.ravel(res.sd)[0])
    if not np.isfinite(sd) or sd > _MAX_WALD_SE:
        return (f"the contrast standard error is {sd:.3g}, above the identifiability bound of "
                f"{_MAX_WALD_SE:g} — the fit reports a coefficient it does not identify")
    return None


def _run_nb_glm(counts_df, design_df, contrast, *, condition_col, covariates, normalization,
                reference_name, fail, small_sample_correction=True, force_absent=False,
                size_factors_override=None):
    """Quasi-likelihood negative-binomial GLM per population (statsmodels), with the declared
    normalization as a `log(size_factor)` OFFSET and a per-population dispersion.

    Refuses BY NAME when `statsmodels` is absent. `DA_FORCE_STATSMODELS_ABSENT=1` forces it."""
    import os
    if force_absent or os.environ.get("DA_FORCE_STATSMODELS_ABSENT") == "1":
        fail(
            "the NB-GLM differential-abundance engine needs `statsmodels`, which is not "
            "installed here. It is pinned in `env-rootfs/single-cell/Dockerfile`; install the "
            "single-cell rootfs or select the PyDESeq2 engine. Refused BY NAME rather than a raw "
            "ImportError."
        )
    try:
        import statsmodels.api as sm
    except Exception:
        fail("the NB-GLM differential-abundance engine needs `statsmodels` (import failed); "
             "install the single-cell rootfs or select the PyDESeq2 engine.")

    X = np.asarray(counts_df.values, dtype=np.float64)
    populations = [str(c) for c in counts_df.columns]
    ref_index = populations.index(str(reference_name)) if (
        normalization == REFERENCE and str(reference_name) in populations) else None
    sf = (np.asarray(size_factors_override, dtype=np.float64)
          if size_factors_override is not None
          else size_factors(X, normalization=normalization, reference_index=ref_index,
                            reference_name=reference_name, fail=fail)[0])
    offset = np.log(sf)
    D, cols, levels = _design_matrix(design_df, condition_col, covariates)
    g1, g2 = str(contrast[0]), str(contrast[1])
    for g in (g1, g2):
        if g not in levels:
            fail(f"the contrast names condition level {g!r}, which is not present among "
                 f"{levels!r} in the surviving samples")
    cvec = _contrast_vector(cols, condition_col, levels, g1, g2)
    # Which SAMPLES sit on each side of the contrast. Needed for the separation test below, which
    # is a statement about the counts, not about anything the optimiser reports.
    _cond = np.asarray([str(v) for v in design_df[condition_col].values])
    side1_rows, side2_rows = (_cond == g1), (_cond == g2)
    alphas = estimate_dispersions(X, sf)
    LN2 = float(np.log(2.0))
    df = residual_df(X.shape[0], D) if small_sample_correction else None
    out = {}
    failures = []
    for j, pop in enumerate(populations):
        y = X[:, j]
        alpha = alphas[j]
        try:
            model = sm.GLM(y, D, family=sm.families.NegativeBinomial(alpha=alpha), offset=offset)
            fitted = model.fit()
            res = fitted.t_test(cvec)
            coef = float(np.ravel(res.effect)[0])
            stat = float(np.ravel(res.tvalue)[0])
            # This engine's OWN reference, untouched. If a small-sample correction was asked for,
            # `fit()` re-refers this statistic centrally — the same call, on the same common path,
            # that the PyDESeq2 arm goes through — so the two engines differ in how they FIT the
            # mean model and in nothing else.
            pval = float(np.ravel(res.pvalue)[0])
            # A converged-but-non-identified fit is NOT a result. Raising here routes it into the
            # same absence path an exception already takes — recorded in `failures`, counted in
            # `n_fit_failures`, written as NaN — rather than adding a second, parallel way for a
            # population to be unfitted.
            _why = _unidentified_reason(y, side1_rows, side2_rows, fitted, res)
            if _why is not None:
                raise _Unidentified(_why)
        except _Unidentified as exc:
            coef, pval, stat = float("nan"), float("nan"), float("nan")
            failures.append({"population": pop, "error": f"unidentified fit: {exc}"})
        except Exception as exc:
            # A SINGLE population that will not converge is tolerated — it gets no effect and no
            # p, and the caller writes it as unfitted. What must NOT happen is a systematic
            # failure reading as a clean "no discoveries": the failures are COUNTED and recorded,
            # and the caller downgrades the whole run out of R1 when none of them fitted.
            coef, pval, stat = float("nan"), float("nan"), float("nan")
            failures.append({"population": pop, "error": f"{type(exc).__name__}: {exc}"})
        out[pop] = {"logFC": coef / LN2, "pval": pval, "stat": stat,
                    "base_mean": float(np.mean(y / sf)), "alpha": float(alpha)}
    return out, {"engine_size_factors": [float(x) for x in sf], "dispersions": alphas,
                 # Name the ESTIMATOR beside its output. `dispersions` is the MARGINAL
                 # overdispersion, not the fitted model's residual dispersion — see
                 # `estimate_dispersions` for the measurement behind that choice. A reader of the
                 # provenance record should not have to infer which of the two it is.
                 "dispersion_estimator": ("marginal method-of-moments (variance about the "
                                          "population's grand mean, both conditions pooled) with "
                                          "an empirical-Bayes shrink toward the shared "
                                          "dispersion; deliberately conservative"),
                 "small_sample_correction": bool(small_sample_correction),
                 "residual_df": (None if df is None else int(df)),
                 "n_fit_failures": len(failures), "fit_failures": failures[:20]}


register_method(
    # PyDESeq2 treats its shrunk dispersion as KNOWN and refers the Wald statistic to a normal.
    # On the acceptance fixture that reference has a MEASURED anti-conservative left tail, so the
    # residual-df t reference (DESeq2's own `useT`) is ON by default here.
    "pydeseq2", label="PyDESeq2 · Wald",
    description="Negative-binomial Wald test over the integer (population × sample) counts "
                "(PyDESeq2). The recommended default, and the engine the reference parity "
                "fixtures are generated with.",
    requires=["pydeseq2"], run=_run_pydeseq2, small_sample_correction=True)
register_method(
    # The NB-GLM's per-population dispersion is estimated by method of moments with an upward
    # bias and an empirical-Bayes shrink, and the resulting normal-reference test is ALREADY
    # conservative on the acceptance fixture (measured: 5/200 null simulations reject at q=0.10,
    # against a nominal 20/200). Stacking a t reference on top would count the same dispersion
    # uncertainty twice and buy nothing but lost power, so it is OFF by default here — a
    # per-engine choice made from measurement, with both engines held to the SAME acceptance bars.
    "nb_glm", label="NB-GLM",
    description="Quasi-likelihood negative-binomial GLM per population with the declared "
                "normalization as a log-size-factor offset and per-population "
                "(empirical-Bayes-shrunk) dispersion (statsmodels).",
    requires=["statsmodels"], run=_run_nb_glm, small_sample_correction=False)


# ── the one entry point ────────────────────────────────────────────────────────────
def fit(counts_df, design_df, contrast, *, condition_col, covariates=(), method=METHOD_DEFAULT,
        normalization=NORMALIZATION_DEFAULT, reference=None, small_sample_correction=None,
        fail=None):
    """Test every population's abundance for the `contrast` under the DECLARED normalization.

    `counts_df` — a pandas DataFrame of INTEGER counts, rows = SAMPLES (the unit of replication),
    columns = POPULATIONS. `design_df` — indexed by the same samples, carrying `condition_col`
    and every covariate. `contrast` — `(group1, group2)` levels of the condition.

    Returns `(results, record)` where `results` is `{population: {logFC, pval, base_mean}}` and
    `record` names the engine, the normalization, its ASSUMPTION and the design formula — the
    provenance INV-DA-1 requires to be narrated rather than merely implied.
    """
    engine = resolve_method(method, fail)
    normalization = resolve_normalization(normalization, fail)
    # `None` means "the engine's measured default"; an explicit value overrides it (the tight
    # parity fixture is generated and compared with it OFF, which is what pertpy does).
    if small_sample_correction is None:
        small_sample_correction = engine["small_sample_correction"]
    populations = [str(c) for c in counts_df.columns]

    reference_name = None
    reference_index = None
    if normalization == REFERENCE:
        reference_name = None if reference is None else str(reference)
        if not reference_name:
            fail(
                "refusing to test: the `reference` normalization was selected but no reference "
                "population was named. Name a population present in every sample, or select the "
                "`poscounts` normalization. There is no proportion fallback (INV-DA-1)."
            )
        if reference_name not in populations:
            fail(
                f"refusing to test: the reference population {reference_name!r} is not one of "
                f"the {len(populations)} populations in this run ({populations[:8]!r}…). The "
                "additive-log-ratio normalization it defines cannot be established, and the run "
                "never falls back to raw proportions (INV-DA-1)."
            )
        reference_index = populations.index(reference_name)

    # Establish the normalization ONCE, here — and let it refuse. Both engines are then fed the
    # SAME factors (PyDESeq2 re-derives them internally from the same declaration, which a test
    # pins to these to 1e-12), so the compositional claim does not depend on the engine.
    sf, record = size_factors(counts_df.values, normalization=normalization,
                              reference_index=reference_index, reference_name=reference_name,
                              fail=fail)

    # The design is checked ONCE, here, before either engine sees it — a confounded design is
    # equally unfittable by both, and the refusal must not depend on which engine was chosen.
    design_matrix, _design_cols = refuse_rank_deficient_design(
        design_df, condition_col, covariates, fail=fail)

    # …and so is the residual-degrees-of-freedom question, for the same reason. A design that
    # consumes every degree of freedom leaves NOTHING to estimate the residual scale with, so
    # there is no reference distribution the statistic can be referred to and no p-value that
    # means anything. `statsmodels` will still hand back a normal-reference p there, and PyDESeq2
    # a Wald one — both are exactly the over-confident fabrication this package exists to refuse —
    # so the p-family is NULLED here, ONCE, for whichever engine runs, and the caller downgrades
    # the regime rather than shipping a number with no reference behind it.
    df_available = residual_df(counts_df.shape[0], design_matrix)
    if df_available <= 0:
        # DECIDED BEFORE DISPATCH, not after. There is nothing to fit here, so no engine is run:
        # PyDESeq2 raises its own `ValueError` on a saturated design ("no replicates to estimate
        # the dispersion") which would surface as an unhandled traceback rather than as this
        # package's named result, and statsmodels quietly returns a normal-reference p that means
        # nothing. Neither is an answer, so the run returns the DESCRIPTIVE quantities with the
        # whole p-family absent and lets the caller downgrade the regime.
        normed = np.asarray(counts_df.values, dtype=np.float64) / sf[:, None]
        results = {str(pop): {"logFC": float("nan"), "pval": float("nan"),
                              "base_mean": float(normed[:, j].mean())}
                   for j, pop in enumerate(populations)}
        record.update({
            "method": engine["key"], "method_label": engine["label"],
            "design_formula": "~" + " + ".join([*covariates, condition_col]),
            "contrast": [str(contrast[0]), str(contrast[1])],
            "n_samples": int(counts_df.shape[0]),
            "n_populations": int(counts_df.shape[1]),
            "small_sample_correction": None,
            "residual_df": 0,
            "engine_run": False,
            "p_values_nulled": "no residual degrees of freedom",
        })
        return results, record

    if engine["key"] == "nb_glm":
        results, extra = engine["run"](
            counts_df, design_df, contrast, condition_col=condition_col, covariates=list(covariates),
            normalization=normalization, reference_name=reference_name, fail=fail,
            small_sample_correction=small_sample_correction, size_factors_override=sf)
    else:
        results, extra = engine["run"](
            counts_df, design_df, contrast, condition_col=condition_col, covariates=list(covariates),
            normalization=normalization, reference_name=reference_name, fail=fail,
            small_sample_correction=small_sample_correction)

    record.update(extra)
    record.setdefault("residual_df", int(df_available))

    # ── THE ALR REFERENCE POPULATION IS ASSUMED, NOT TESTED ───────────────────────────────────
    # Under `reference` normalization the named population's own count IS the offset, so its
    # condition coefficient is identically zero BY CONSTRUCTION. Both engines duly report it as a
    # converged, tested-and-null result — measured: `nb_glm` logFC -3.7e-12 / padj 1.0, PyDESeq2
    # pval 0.99999979 — and a reader sees "reference population B: no change, p = 1" and can read
    # that as EVIDENCE the constancy assumption held. It is not evidence of anything; it is the
    # assumption reflected back. It also consumed a slot in the BH family, inflating `m` by one
    # for a hypothesis nobody tested.
    #
    # Same rule as everywhere else in this package, applied to the one population whose "result"
    # is a tautology: the p-family is ABSENT, and the reason is recorded by name rather than left
    # for a reader to infer. The row itself STAYS — the reference population is a real population
    # and its descriptive columns are real — and NaN drops out of `bh`'s `m` automatically, so the
    # BH correction needs no separate change.
    if normalization == REFERENCE and reference_name in results:
        ref_row = results[reference_name]
        ref_row["pval"] = float("nan")
        ref_row["logFC"] = float("nan")
        if "stat" in ref_row:
            ref_row["stat"] = float("nan")
        record["reference_population_untested"] = (
            f"{reference_name!r} defines the additive-log-ratio normalization, so its own "
            "condition coefficient is zero by construction rather than by measurement. Its "
            "p-value and effect are ABSENT — reporting the tautology as a tested-and-null result "
            "would read as evidence the constancy assumption held — and it is excluded from the "
            "multiple-testing family, which counts only hypotheses that were actually tested.")

    # ── THE SMALL-SAMPLE REFERENCE, APPLIED ONCE, FOR EVERY ENGINE ────────────────────────────
    # Engines return their OWN reference's p-value and their own Wald statistic. If a small-sample
    # correction was asked for, the statistic is re-referred to `t(residual df)` HERE — and
    # `correct_preserving_mask` keeps a p-value the engine declined to report ABSENT, rather than
    # manufacturing a fresh finite one from the still-finite statistic (INV-DA-2).
    #
    # This is deliberately on the COMMON path. It used to live inside the PyDESeq2 engine, where
    # no host without the `pydeseq2` wheel could test it: a round-R1 mutation deleted the mask
    # preservation and the whole suite stayed green. Here it is reachable by any engine, and by a
    # registered stub engine with no third-party dependency at all.
    if small_sample_correction:
        # The df an engine REPORTED, falling back to the one computed here before dispatch. Never
        # `None`: `t_reference_pvalues(stat, None)` returns all-NaN, so an engine that simply
        # omitted the field would silently null the entire p-family and the run would read as
        # "nothing was testable" — an absence with no reason behind it, which is the one thing
        # this package's absence rule exists to prevent. `df_available` is the same quantity
        # (`n_samples - rank(design)`) over the same design, so the fallback is a value, not a
        # guess.
        df_used = record.get("residual_df")
        if df_used is None:
            df_used = int(df_available)
            record["residual_df"] = df_used
        pops = list(results.keys())
        engine_p = np.array([results[p].get("pval", np.nan) for p in pops], dtype=np.float64)
        stats_ = np.array([results[p].get("stat", np.nan) for p in pops], dtype=np.float64)
        corrected = correct_preserving_mask(engine_p, stats_, df_used)
        for p, v in zip(pops, corrected):
            results[p]["pval"] = float(v)

    record["engine_run"] = True
    record["method"] = engine["key"]
    record["method_label"] = engine["label"]
    record["design_formula"] = "~" + " + ".join([*covariates, condition_col])
    record["contrast"] = [str(contrast[0]), str(contrast[1])]
    record["small_sample_correction"] = bool(small_sample_correction)
    record["n_samples"] = int(counts_df.shape[0])
    record["n_populations"] = int(counts_df.shape[1])
    return results, record


# ── descriptive summaries (never a statistic) ──────────────────────────────────────
def descriptive_columns(counts, sf, side1_rows, side2_rows, *, sample_totals=None):
    """The per-population summaries every regime writes, and the RANKED EFFECT used when no
    p-value is written.

    `mean_prop_1` / `mean_prop_2` are the mean per-sample PROPORTIONS on each side. They are
    REPORTED — a reader wants to know a population went from 4% to 9% — but they are never fed to
    a test: no statistic in this package is computed from them (INV-DA-1).

    ── `sample_totals` — THE DENOMINATOR MUST BE CELLS, AND FOR NEIGHBOURHOODS IT IS NOT `sum` ──
    For `da.clusters` the populations PARTITION the cells, so `counts.sum(axis=1)` IS the number
    of cells in the sample and the default is right. For `da.neighbourhoods` they OVERLAP — a cell
    belongs to every neighbourhood whose index cell is within k — so the row sum counts each cell
    once per neighbourhood it joins and overstates the denominator by the mean membership. Round
    R2 measured 2.1x on a 1531-cell fixture, and the factor is data-dependent, so the reported
    percentage was wrong by a different amount on every run. The neighbourhood entry reasons about
    exactly this trap for `min_cells` ("counts each cell once per neighbourhood it belongs to")
    and then handed the same quantity to this function.

    So the caller PASSES the true per-sample cell counts when the columns overlap. Nothing else
    changes: `logFC`, the size factors and every statistic already come from the count model, not
    from these proportions — this fixes a REPORTED number, not a tested one.

    The ranked effect (`logFC`) is the log2 ratio of NORMALIZED mean counts under the declared
    normalization, not of proportions. So even in an R2/R3 regime, where no p is written, the
    effect a reader ranks by comes from the count model rather than from the compositional
    quantity — which is what keeps "descriptive" honest instead of merely p-free.

    A side with a zero mean gets a NaN effect rather than an infinity: an unbounded fold change
    reported as a number is a fabricated magnitude.
    """
    X = np.asarray(counts, dtype=np.float64)
    sf = np.asarray(sf, dtype=np.float64)
    normed = X / sf[:, None]
    totals = (X.sum(axis=1) if sample_totals is None
              else np.asarray(sample_totals, dtype=np.float64))
    with np.errstate(invalid="ignore", divide="ignore"):
        props = np.where(totals[:, None] > 0, X / np.where(totals[:, None] > 0, totals[:, None], 1.0), 0.0)
    s1 = np.asarray(side1_rows, dtype=bool)
    s2 = np.asarray(side2_rows, dtype=bool)
    m1 = normed[s1].mean(axis=0) if s1.any() else np.full(X.shape[1], np.nan)
    m2 = normed[s2].mean(axis=0) if s2.any() else np.full(X.shape[1], np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        logfc = np.where((m1 > 0) & (m2 > 0), np.log2(np.where(m2 > 0, m1 / np.where(m2 > 0, m2, 1.0), np.nan)), np.nan)
    return {
        "logFC": logfc,
        "n_cells": X.sum(axis=0).astype(np.float64),
        "mean_prop_1": props[s1].mean(axis=0) if s1.any() else np.full(X.shape[1], np.nan),
        "mean_prop_2": props[s2].mean(axis=0) if s2.any() else np.full(X.shape[1], np.nan),
    }


def neglog10(pvals):
    """`-log10(p)`, floored so an f32 round-trip cannot underflow the top hits to 0 (the reason
    `da/result` stores `neglog10p` and never a raw `p`)."""
    p = np.asarray(pvals, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        return -np.log10(np.clip(p, 1e-300, 1.0))
