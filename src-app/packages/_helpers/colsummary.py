#!/usr/bin/env python3
# ruff: noqa
"""colsummary — TxResBench COMPACT per-column viz summary (ITEM-21, DEC-25/DEC-26).

Extends the h5ad_import ``INV-4`` column classifier into a COMPACT summary that
rides the artifact CATALOG ``meta`` (not just the column-file body), so viz reads
a column's legend / colormap range WITHOUT downloading the column values.

Two shapes (a RECOMMENDED-but-open interop schema — DEC-25):

  * categorical / string ::

      {name, kind:"categorical", dtype, n, n_missing,
       categories:[... capped at max_categories ...], ordered:bool,
       n_categories:<TRUE distinct count>, high_cardinality:bool}

    The preview is bounded TWICE — by count (``max_categories``, DEC-26, default
    ``MAX_SUMMARY_CATEGORIES`` = 50) and by SIZE (``MAX_SUMMARY_CATEGORIES_BYTES``
    = 1024), because a count does not bound bytes and this rides the size-capped
    manifest. Whichever trims it, ``high_cardinality=True`` and ``n_categories``
    keeps the TRUE count — so viz can show "N categories — not a color legend"
    instead of choking, and a consumer needing the FULL set reads it from the
    artifact (``attributes.txr.levels``), which is where labels resolve anyway.

  * numeric / continuous ::

      {name, kind:"continuous", dtype, n, n_missing, min, max, mean}

    Integers stay exact-typed (``min``/``max`` are ``int``); ``min``/``max``/``mean``
    are computed over FINITE values only. An all-missing / no-finite column yields
    ``min=max=mean=None``.

The summary is COMPACT by contract — it carries NO per-row values array (that is
the column body, persisted separately by the INV-4 emitter).

Pure + importable + independently testable OFF-sandbox — the public entry point
takes a plain list (or Series) and returns a plain dict.
"""
import json

import numpy as np
import pandas as pd

# DEC-26: fixed UX guardrail — a categorical with > this many distinct values is
# not a color legend regardless of deployment. This is a SCRIPT-LOCAL constant (there
# is no Rust counterpart — the earlier `SupportingLimits.MAX_SUMMARY_CATEGORIES`
# reference was stale); structured so it could later be promoted to a settings row.
#
# 200 → 50. The preview rides the artifact row, which rides the size-capped manifest
# (`outputs.rs::MAX_MANIFEST_BYTES`), and at 200 it was the LARGEST thing left in an
# entry — 3,800 of `genes_index`'s 4,842 bytes. `MAX_OUTPUTS` (512) × that entry is
# 2.4 MB against a 1 MiB cap, so the two server-side caps contradicted each other;
# `test_the_two_manifest_caps_are_consistent` now holds them to
# `MAX_MANIFEST_BYTES / MAX_OUTPUTS` = 2048 bytes per entry and this is what buys the
# room. Nothing is lost: 50 swatches is already past what a legend can distinguish,
# `n_categories` still reports the TRUE count, and the full set lives in the artifact
# (`attributes.txr.levels`) which is where every reader resolves labels anyway.
MAX_SUMMARY_CATEGORIES = 50

# …and a BYTE budget on top of the count, because a count does not bound a size: 50
# labels of 1,000 characters is a 50 KB preview, and 512 of those is 25 MB. A cap that
# can be defeated by longer strings is not a cap. Whole labels are dropped from the
# tail until the serialized preview fits — never truncated in place, because a label
# altered to fit is worse than one honestly absent (a consumer cannot tell a shortened
# label from a real one; it can tell a missing one from `high_cardinality`).
MAX_SUMMARY_CATEGORIES_BYTES = 1024

# Shared metadata-column `kind` vocabulary (SUPERSET a reader can rely on), unified
# with h5ad_import.write_metadata_column so BOTH writers of a `metadata-column` speak
# ONE language: `kind ∈ {"categorical", "continuous"}`.
#   * "categorical" — a DISCRETE column rendered as a legend: a declared
#                     CategoricalDtype, an object/bool column, OR a free-text string
#                     column (a high-cardinality legend). h5ad's former "string" kind
#                     folds in here.
#   * "continuous"  — a NUMERIC column rendered as a colormap/range (int or float).
#                     h5ad's former "numeric" kind maps here.
# The precise pandas dtype is always retained in the `dtype` field for any consumer
# that needs the finer string-vs-categorical / int-vs-float detail.
KIND_CATEGORICAL = "categorical"
KIND_CONTINUOUS = "continuous"


def summarize_column(values, name, max_categories: int = MAX_SUMMARY_CATEGORIES):
    """Compute the COMPACT per-column viz summary (ITEM-21).

    Args:
      values:          the column values — a ``list`` (or ``pandas.Series`` /
                       ndarray). NaN / None are the missing sentinel.
      name:            the column name (echoed into the summary).
      max_categories:  the categorical COUNT cap (DEC-26; default
                       ``MAX_SUMMARY_CATEGORIES`` = 50). The byte budget
                       ``MAX_SUMMARY_CATEGORIES_BYTES`` applies on top and is
                       not overridable per call.

    Returns a dict of the shape documented in the module docstring — never a
    per-row values array (compact by contract).
    """
    s = values if isinstance(values, pd.Series) else pd.Series(values)
    dtype = s.dtype
    n = int(s.shape[0])

    # ── classify exactly as INV-4 does (CategoricalDtype / object / bool → the
    #    categorical branch; integer / float → the continuous branch). ──────────
    is_categorical_like = (
        isinstance(dtype, pd.CategoricalDtype)
        or dtype == object
        or dtype == bool
        or str(dtype) == "boolean"  # pandas nullable boolean
    )
    if is_categorical_like:
        return _summarize_categorical(s, name, dtype, n, max_categories)
    if pd.api.types.is_numeric_dtype(dtype):
        return _summarize_continuous(s, name, dtype, n)
    # Anything else (datetime, etc.) → treat as categorical strings (safe default).
    return _summarize_categorical(s.astype(object), name, dtype, n, max_categories)


# ──────────────────────────────── internals ───────────────────────────────────

def _fit_preview(categories, budget=None):
    """Drop whole labels from the tail until the serialized preview fits `budget` bytes.

    Returns a prefix of `categories` — order is preserved, and the labels that survive
    are verbatim. A single label larger than the whole budget yields an empty preview
    rather than a truncated label: `high_cardinality` then tells the consumer the set is
    elsewhere, which is true and checkable, where a silently shortened label is neither.
    """
    budget = MAX_SUMMARY_CATEGORIES_BYTES if budget is None else budget
    if len(json.dumps(categories)) <= budget:
        return categories
    fitted = []
    for c in categories:
        if len(json.dumps(fitted + [c])) > budget:
            break
        fitted.append(c)
    return fitted


def _summarize_categorical(s, name, dtype, n, max_categories):
    ordered = bool(getattr(dtype, "ordered", False)) if isinstance(dtype, pd.CategoricalDtype) else False

    if isinstance(dtype, pd.CategoricalDtype):
        # Declared category universe — preserves author-intended ORDER, and counts
        # missing as any value not in the categories (pandas encodes those as NaN).
        all_categories = [_cat(c) for c in s.cat.categories.tolist()]
        n_missing = int(s.isna().sum())
    else:
        # object / bool / string — the distinct observed values, in first-seen
        # order (deterministic, legend-friendly), missing = NaN/None count.
        n_missing = int(s.isna().sum())
        seen = []
        seen_set = set()
        for v in s.tolist():
            if v is None or (isinstance(v, float) and np.isnan(v)):
                continue
            cv = _cat(v)
            if cv not in seen_set:
                seen_set.add(cv)
                seen.append(cv)
        all_categories = seen

    n_categories = len(all_categories)
    categories = _fit_preview(all_categories[:max_categories])
    # TRUE whenever the preview is not the whole set, whichever cap trimmed it. It used
    # to mean only "the COUNT cap trimmed it", which would now leave a byte-trimmed
    # preview claiming to be complete — the flag has to track the property a consumer
    # actually needs ("is this all of them?"), not the mechanism that produced it.
    high_cardinality = len(categories) < n_categories

    return {
        "name": str(name),
        "kind": "categorical",
        "dtype": str(dtype),
        "n": n,
        "n_missing": n_missing,
        "categories": categories,
        "ordered": ordered,
        "n_categories": n_categories,
        "high_cardinality": high_cardinality,
    }


def _summarize_continuous(s, name, dtype, n):
    if pd.api.types.is_integer_dtype(dtype):
        # Exact integers — but a pandas NULLABLE integer (Int64) can carry NA, so
        # drop NA and keep the surviving values as exact ints.
        non_null = s.dropna()
        n_missing = n - int(non_null.shape[0])
        arr = np.asarray(non_null.tolist(), dtype=object)
        finite = [int(x) for x in arr.tolist()]
        if finite:
            vmin = int(min(finite))
            vmax = int(max(finite))
            mean = float(np.mean(finite))
        else:
            vmin = vmax = mean = None
    else:
        arr = np.asarray(s.values, dtype=float)
        finite = arr[np.isfinite(arr)]
        n_missing = n - int(finite.size)
        if finite.size:
            vmin = float(finite.min())
            vmax = float(finite.max())
            mean = float(finite.mean())
        else:
            vmin = vmax = mean = None

    return {
        "name": str(name),
        "kind": "continuous",
        "dtype": str(dtype),
        "n": n,
        "n_missing": n_missing,
        "min": vmin,
        "max": vmax,
        "mean": mean,
    }


def _cat(v):
    """One category label → a JSON-friendly scalar (booleans → real bools; numeric
    category codes → exact int; else the string form)."""
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if (isinstance(v, float) and np.isnan(v)) else (int(v) if float(v).is_integer() else float(v))
    return str(v)
