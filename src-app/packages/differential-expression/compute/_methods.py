#!/usr/bin/env python3
# ruff: noqa
"""_methods — the marker + compare METHOD REGISTRIES (INV-12 / DEC-15 / DEC-16).

Method dispatch is a `catalog()` registry with ≥2 methods per analysis, mirroring the
`web_search`/`lit_search` provider `catalog()` pattern: the SET of methods lives in code, each
method is ONE descriptor + ONE impl, the form's method enum is sourced from the catalog
descriptors, and the chosen method is recorded in the `de/result` provenance. Adding a method
is a CODE-ONLY change — a descriptor + an impl, no manifest/datatype/UI edit.

The method choice stays WITHIN a product — the marker registry and the compare registry are
SEPARATE dicts; a single dropdown spanning markers + condition is the legacy category error
(INV-4/INV-12), which is why there is no unified registry.

v1 (DEC-16):
  · de.markers → wilcoxon (default) + t-test  (both scanpy `rank_genes_groups`, zero new dep)
  · de.compare → pydeseq2 (default) + nb_glm   (both replicate-aware pseudobulk tests, rootfs wheels)
"""

# ── the marker method registry ─────────────────────────────────────────────────────
# Each descriptor maps to a scanpy `rank_genes_groups` method string. A marker method is a
# DESCRIPTIVE ranking (no p headlined), so the impl is just the scanpy method identity the
# markers pass runs; the ranking/effect/detection extraction is shared.
_MARKER_METHODS = {}
_COMPARE_METHODS = {}

MARKER_DEFAULT = "wilcoxon"
COMPARE_DEFAULT = "pydeseq2"


def register_marker_method(key, *, label, description, scanpy_method):
    _MARKER_METHODS[key] = {"key": key, "label": label, "description": description,
                            "scanpy_method": scanpy_method}


def register_compare_method(key, *, label, description, requires, run):
    _COMPARE_METHODS[key] = {"key": key, "label": label, "description": description,
                             "requires": list(requires), "run": run}


def marker_catalog():
    """The marker method descriptors, DECLARATION ORDER (default first) — the source the form's
    method enum renders from (INV-12). A descriptor is `{key, label, description, scanpy_method}`."""
    return [_MARKER_METHODS[k] for k in _MARKER_METHODS]


def compare_catalog():
    """The compare method descriptors, DECLARATION ORDER (default first) — the form's enum
    source (INV-12). `{key, label, description, requires, run}`."""
    return [_COMPARE_METHODS[k] for k in _COMPARE_METHODS]


def resolve_marker_method(key, fail):
    """The scanpy method string for `key`, defaulting to wilcoxon; a genuinely unknown key is
    refused BY NAME (never silently swapped to the default)."""
    key = str(key or MARKER_DEFAULT)
    d = _MARKER_METHODS.get(key)
    if d is None:
        fail(f"unknown marker method {key!r}; the registered methods are "
             f"{sorted(_MARKER_METHODS)} (adding one is a code-only catalog() entry).")
    return d


def resolve_compare_method(key, fail):
    """The compare method descriptor for `key`, defaulting to pydeseq2; an unknown key is
    refused BY NAME."""
    key = str(key or COMPARE_DEFAULT)
    d = _COMPARE_METHODS.get(key)
    if d is None:
        fail(f"unknown compare method {key!r}; the registered methods are "
             f"{sorted(_COMPARE_METHODS)} (adding one is a code-only catalog() entry).")
    return d


# ── v1 marker methods (DEC-16): wilcoxon (default) + t-test ─────────────────────────
# C4 — the descriptions state what the banded impl ACTUALLY runs (an in-package tie-corrected
# Mann-Whitney U / Welch t over log-normalized expression), not a scanpy version it never calls.
register_marker_method(
    "wilcoxon", label="Wilcoxon rank-sum",
    description="Mann-Whitney U rank-sum, tie-corrected (sparsity-aware, zeros as one tied "
                "block), banded — the in-package equivalent of scanpy's wilcoxon ranking.",
    scanpy_method="wilcoxon")
register_marker_method(
    "t-test", label="t-test",
    description="Welch t-test over log-normalized expression, banded (in-package).",
    scanpy_method="t-test")


# ── v1 compare methods (DEC-16): pydeseq2 (default) + nb_glm ─────────────────────────
def _run_pydeseq2(counts, design, contrast, *, fail, force_absent=False):
    """PyDESeq2 Wald test on the (sample × group) pseudobulk matrix.

    `counts` — a pandas DataFrame `(pseudobulk_samples × genes)` of summed RAW counts.
    `design` — a pandas DataFrame indexed by the same pseudobulk samples, with a `group` column.
    `contrast` — `(group1, group2)`. Returns `{gene: {logFC, pval, padj, base_mean}}`.

    A NAMED refusal when `pydeseq2` is absent (mirrors embedding `import_harmonypy` → named
    refusal, never a raw `ImportError`). `DE_FORCE_PYDESEQ2_ABSENT=1` forces the absent branch."""
    import os
    if force_absent or os.environ.get("DE_FORCE_PYDESEQ2_ABSENT") == "1":
        fail(
            "the PyDESeq2 compare method needs the `pydeseq2` wheel, which is not installed in "
            "this environment. It is pinned in `env-rootfs/single-cell/Dockerfile`; a "
            "deployment missing it should install the single-cell rootfs, or select the NB-GLM "
            "compare method. The run refuses BY NAME rather than raising a raw ImportError "
            "mid-pipeline."
        )
    try:
        from pydeseq2.dds import DeseqDataSet
        from pydeseq2.ds import DeseqStats
    except Exception:
        fail(
            "the PyDESeq2 compare method needs the `pydeseq2` wheel (import failed). It is "
            "pinned in `env-rootfs/single-cell/Dockerfile`; install the single-cell rootfs or "
            "select the NB-GLM method."
        )
    import numpy as np
    g1, g2 = contrast
    dds = DeseqDataSet(counts=counts.astype(int), metadata=design, design_factors="group")
    dds.deseq2()
    stats = DeseqStats(dds, contrast=["group", str(g1), str(g2)])
    stats.summary()
    res = stats.results_df
    out = {}
    for gene, row in res.iterrows():
        out[str(gene)] = {
            "logFC": float(row.get("log2FoldChange", float("nan"))),
            "pval": float(row.get("pvalue", float("nan"))),
            "padj": float(row.get("padj", float("nan"))),
            "base_mean": float(row.get("baseMean", float("nan"))),
        }
    return out


# NB dispersion (alpha) clamp — a per-gene estimate is bounded away from the degenerate ends
# (0 = Poisson, ∞) so the GLM fit is well-posed. These replace the former FIXED alpha=1.0.
_NB_ALPHA_FLOOR = 1e-8
_NB_ALPHA_CAP = 1e3
# EB shrinkage weight toward the cross-gene shared dispersion (doc-13 §6.1 row 4 "empirical-Bayes
# dispersion shrinkage"): a light shrink stabilises the per-gene method-of-moments estimate on the
# few (~80) pseudobulk rows without collapsing genuine per-gene differences.
_NB_EB_SHRINK = 0.2


def _mom_nb_dispersion(y):
    """Per-gene NB overdispersion `alpha` by METHOD OF MOMENTS on the pseudobulk counts:
    `Var = mu + alpha·mu²  ⇒  alpha = (Var − mu)/mu²`, clamped to `[floor, cap]`. This is the
    per-gene dispersion doc-13 §6.1 row 4 mandates in place of a FIXED `alpha=1.0`."""
    import numpy as np
    y = np.asarray(y, dtype=float)
    mu = float(y.mean()) if y.size else 0.0
    if mu <= 0.0:
        return _NB_ALPHA_FLOOR
    var = float(y.var(ddof=1)) if y.size > 1 else mu
    alpha = (var - mu) / (mu * mu)
    return float(min(max(alpha, _NB_ALPHA_FLOOR), _NB_ALPHA_CAP))


def estimate_nb_dispersions(counts):
    """Per-gene NB dispersion for every gene column of the pseudobulk `counts` DataFrame, with a
    light empirical-Bayes shrink toward the shared (geometric-mean) dispersion (doc-13 §6.1 row 4).
    Returns `{gene: alpha}` — each a real per-gene estimate, never the discarded fixed `1.0`."""
    import numpy as np
    raw = {str(g): _mom_nb_dispersion(counts[g].astype(float).values) for g in counts.columns}
    if not raw:
        return raw
    shared = float(np.exp(np.mean(np.log([max(a, _NB_ALPHA_FLOOR) for a in raw.values()]))))
    return {g: float(min(max((1.0 - _NB_EB_SHRINK) * a + _NB_EB_SHRINK * shared,
                             _NB_ALPHA_FLOOR), _NB_ALPHA_CAP))
            for g, a in raw.items()}


def _run_nb_glm(counts, design, contrast, *, fail, force_absent=False):
    """Quasi-likelihood negative-binomial GLM (statsmodels) per gene on the pseudobulk matrix —
    the doc-13 §6.1-row-4 alternative to PyDESeq2. Fits `counts ~ group` with a library-size
    offset; the group coefficient is the log fold-change, its Wald p the significance.

    The per-gene overdispersion `alpha` is ESTIMATED (`estimate_nb_dispersions`, method-of-moments
    + a light EB shrink) — NOT the former mis-calibrating fixed `alpha=1.0`. Each result carries
    its fitted `alpha` so provenance can show two differently-overdispersed genes got two
    dispersions.

    Refuses BY NAME when `statsmodels` is absent. `DE_FORCE_STATSMODELS_ABSENT=1` forces it."""
    import os
    if force_absent or os.environ.get("DE_FORCE_STATSMODELS_ABSENT") == "1":
        fail(
            "the NB-GLM compare method needs `statsmodels`, which is not installed here. It is "
            "pinned in `env-rootfs/single-cell/Dockerfile`; install the single-cell rootfs or "
            "select the PyDESeq2 method. Refused BY NAME rather than a raw ImportError."
        )
    try:
        import statsmodels.api as sm
        import statsmodels.formula.api as smf
    except Exception:
        fail("the NB-GLM compare method needs `statsmodels` (import failed); install the "
             "single-cell rootfs or select the PyDESeq2 method.")
    import numpy as np
    import pandas as pd
    g1, g2 = contrast
    # binary group indicator: 1 for g1 (the numerator of the contrast), 0 for g2.
    grp = (design["group"].astype(str) == str(g1)).astype(float).values
    lib = counts.sum(axis=1).astype(float).values
    offset = np.log(np.clip(lib, 1.0, None))
    alphas = estimate_nb_dispersions(counts)
    out = {}
    LN2 = float(np.log(2.0))
    for gene in counts.columns:
        y = counts[gene].astype(float).values
        alpha = alphas.get(str(gene), _NB_ALPHA_FLOOR)
        df = pd.DataFrame({"y": y, "grp": grp, "offset": offset})
        try:
            # PER-GENE dispersion (not the discarded fixed 1.0) — quasi-likelihood NB-GLM.
            model = smf.glm("y ~ grp", data=df,
                            family=sm.families.NegativeBinomial(alpha=alpha), offset=df["offset"])
            fit = model.fit()
            coef = float(fit.params.get("grp", float("nan")))
            pval = float(fit.pvalues.get("grp", float("nan")))
        except Exception:
            coef, pval = float("nan"), float("nan")
        out[str(gene)] = {"logFC": coef / LN2, "pval": pval, "padj": float("nan"),
                          "base_mean": float(np.mean(y)), "alpha": float(alpha)}
    return out


# C5 — `requires` names the method's REAL dependency (the test wheel). Aggregation is a local
# banded sum, so `decoupler` is NOT a hard requirement of either method.
register_compare_method(
    "pydeseq2", label="PyDESeq2 · Wald",
    description="Pseudobulk negative-binomial Wald test (PyDESeq2). The recommended default.",
    requires=["pydeseq2"], run=_run_pydeseq2)
register_compare_method(
    "nb_glm", label="NB-GLM",
    description="Quasi-likelihood negative-binomial GLM per gene with a library-size offset and "
                "per-gene (empirical-Bayes-shrunk) dispersion (statsmodels).",
    requires=["statsmodels"], run=_run_nb_glm)
