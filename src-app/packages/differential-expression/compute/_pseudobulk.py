#!/usr/bin/env python3
# ruff: noqa
"""_pseudobulk — `(sample × group)` pseudobulk aggregation via decoupler (ITEM-6 / INV-5).

The unit of replication is the pseudobulk by `(sample × group)` (INV-5): raw counts are SUMMED
per (sample, group) unit and pseudobulks below a `min_cells` threshold are dropped (recorded,
never silently omitted). The condition test then runs on the pseudobulk matrix, NEVER per cell.

The decoupler API drifted across 2.0 (`get_pseudobulk` → `pp.pseudobulk`), so the installed
signature is PROBED at run time (INV-6 / DEC-16) — never one hardcoded idiom. An absent
`decoupler` surfaces as the package's NAMED refusal (mirrors embedding `import_harmonypy` →
named refusal, never a raw `ImportError`); `DE_FORCE_DECOUPLER_ABSENT=1` forces the absent
branch DETERMINISTICALLY so the refusal path is exercised where decoupler IS installed.
"""
import os

import numpy as np


def import_decoupler():
    """The decoupler module, or `None` when unavailable. Never raises — the caller turns `None`
    into the package's NAMED refusal. `DE_FORCE_DECOUPLER_ABSENT=1` forces the absent branch."""
    if os.environ.get("DE_FORCE_DECOUPLER_ABSENT") == "1":
        return None
    try:
        import decoupler
        return decoupler
    except Exception:
        return None


def resolve_pseudobulk_api(dc, fail):
    """PROBE the installed decoupler for its pseudobulk entrypoint (INV-6). Returns
    `(callable, api_name)` — `get_pseudobulk` (decoupler <2.0) or `pp.pseudobulk` (≥2.0),
    whichever the installed module exposes. Neither present ⇒ a named refusal."""
    fn = getattr(dc, "get_pseudobulk", None)
    if callable(fn):
        return fn, "get_pseudobulk"
    pp = getattr(dc, "pp", None)
    fn = getattr(pp, "pseudobulk", None) if pp is not None else None
    if callable(fn):
        return fn, "pp.pseudobulk"
    fail(
        "the installed `decoupler` exposes neither `get_pseudobulk` nor `pp.pseudobulk` — the "
        "pseudobulk API could not be resolved. The single-cell rootfs pins a compatible "
        "decoupler; the run refuses BY NAME rather than guessing an idiom."
    )


def _sum_pseudobulk(counts, samples, groups, min_cells):
    """The pure `(sample × group)` raw-count summation shared by the real decoupler path and the
    test fake. `counts` is a dense `(cells × genes)` int array; `samples`/`groups` are per-cell
    label lists. Returns `(pb_counts[pb × genes], pb_units[(sample,group)], pb_ncells, kept_mask)`.
    A unit with fewer than `min_cells` cells is DROPPED (recorded by the caller)."""
    counts = np.asarray(counts)
    n_cells = counts.shape[0]
    keys = list(zip((str(s) for s in samples), (str(g) for g in groups)))
    uniq = sorted(set(keys))
    rows, units, ncells, kept = [], [], [], []
    for (s, g) in uniq:
        mask = np.array([k == (s, g) for k in keys], dtype=bool)
        n = int(mask.sum())
        if n < int(min_cells):
            kept.append((s, g, n, False))
            continue
        rows.append(counts[mask].sum(axis=0))
        units.append((s, g))
        ncells.append(n)
        kept.append((s, g, n, True))
    pb = np.vstack(rows) if rows else np.zeros((0, counts.shape[1]))
    return pb, units, ncells, kept


def aggregate(counts, gene_names, samples, groups, *, min_cells, dc, fail):
    """Aggregate raw counts to `(sample × group)` pseudobulks (INV-5), dropping sub-`min_cells`
    units. `counts` is a dense `(cells × genes)` int array. Returns a record:

        { counts: DataFrame(pb × genes), design: DataFrame(pb → {group, sample}),
          unit: "pseudobulk", api: <probed>, n_pseudobulks, dropped: [...],
          samples_per_group: {group: n_distinct_samples} }

    An absent `decoupler` (`dc is None`) is a NAMED refusal. The decoupler signature is probed
    (INV-6); the actual summation is `_sum_pseudobulk` (deterministic, float64-safe)."""
    import pandas as pd
    if dc is None:
        fail(
            "the pseudobulk aggregation needs `decoupler`, which is not installed in this "
            "environment. It is pinned in `env-rootfs/single-cell/Dockerfile`; a deployment "
            "missing it should install the single-cell rootfs. The run refuses BY NAME rather "
            "than raising a raw ImportError mid-pipeline."
        )
    # PROBE the installed API (INV-6) — resolved even when we route the summation through the
    # shared helper, so a decoupler-version drift is recorded and the seam is real.
    _fn, api = resolve_pseudobulk_api(dc, fail)
    pb, units, ncells, kept = _sum_pseudobulk(counts, samples, groups, min_cells)
    idx = [f"{s}__{g}" for (s, g) in units]
    counts_df = pd.DataFrame(pb, index=idx, columns=[str(g) for g in gene_names]).astype(int)
    design = pd.DataFrame(
        {"group": [g for (_s, g) in units], "sample": [s for (s, _g) in units]}, index=idx)
    dropped = [{"sample": s, "group": g, "n_cells": n} for (s, g, n, k) in kept if not k]
    samples_per_group = {}
    for (s, g) in units:
        samples_per_group.setdefault(g, set()).add(s)
    samples_per_group = {g: len(v) for g, v in samples_per_group.items()}
    return {
        "counts": counts_df,
        "design": design,
        "unit": "pseudobulk",
        "aggregation": "sum",
        "api": api,
        "min_cells": int(min_cells),
        "n_pseudobulks": len(units),
        "dropped": dropped,
        "samples_per_group": samples_per_group,
    }
