#!/usr/bin/env python3
# ruff: noqa
"""align — TxResBench shared AXIS-AGNOSTIC alignment engine (ITEM-8, DEC-2/DEC-18).

A keyed **left-join** that folds a supporting annotation table onto a primary
dataset's ENTITY AXIS (cells / genes / variants / samples / … — the engine never
knows which). Given the axis's ordered list of entity ids and a table of rows
keyed by one column, it emits every non-key table column re-ordered to the axis,
with ``NA`` where an axis entity has no matching row.

Policy (DEC-2 — left-join, warn on gaps):
  * axis entity WITH a matching row → the row's values populate each column;
  * axis entity with NO row         → ``NA`` per column, counted in ``missing``
                                       (a WARNING, not an error);
  * a table key with no axis entity → ignored, counted in ``extra`` (a WARNING);
  * a DUPLICATE key in the table     → a clear ``AlignmentError`` (integration
                                       fails — DEC-2 makes this a HARD error).

Key normalization (DEC-18) — the ``normalize`` pipeline is an ordered list of
step names applied (in order) to BOTH the table keys and the axis index purely
for MATCHING; the OUTPUT preserves the original axis order + labels untouched.
Steps:
  * ``"barcode_suffix"``  — strip a trailing 10x cell-barcode suffix: a ``-<int>``
                            lane suffix (``AAAC-1`` → ``AAAC``) and/or a
                            ``_<sampleN>`` sample tag (``AAAC_sample1`` → ``AAAC``).
  * ``"ensembl_version"`` — strip a trailing ``.<int>`` version from an
                            ENSG/ENST/ENSMUSG-style id (``ENSG42.3`` → ``ENSG42``).
  * ``"trim"``            — strip surrounding whitespace.
  * ``"casefold"``        — Unicode-aware lower-casing for case-insensitive match.

The coverage report exposes ``matched_before_normalize`` (raw, pre-pipeline key
match count) vs ``matched_after_normalize`` (== ``matched``) so a
"0 matched raw → 4000 matched normalized" case is visible and trusted (DEC-18).

Pure + importable + independently testable OFF-sandbox (no ``/inputs`` /
``/outputs`` dependency): every public entry point takes plain Python / pandas
objects and returns a plain dict.
"""
import re

import numpy as np
import pandas as pd


class AlignmentError(ValueError):
    """A hard alignment failure (e.g. a duplicate key in the supporting table)."""


# ─────────────────────────────── normalization ────────────────────────────────

_KNOWN_STEPS = ("barcode_suffix", "ensembl_version", "trim", "casefold")

# A trailing 10x lane suffix (`-1`, `-2`, …) and/or a `_<sample tag>`. Applied
# repeatedly-safe: `-1` first, then a trailing `_<token>` sample suffix. Only a
# NUMERIC lane suffix is stripped (a gene symbol like `HLA-A` keeps its `-A`).
_BARCODE_LANE_RE = re.compile(r"-\d+$")
_BARCODE_SAMPLE_RE = re.compile(r"_[A-Za-z0-9]+$")
# A trailing Ensembl version on an ENS…-style id: `ENSG00000141510.11` → base.
_ENSEMBL_RE = re.compile(r"^(ENS[A-Z]*\d+)\.\d+$")


def _step_barcode_suffix(key: str) -> str:
    # Strip trailing `_<sample tag>` and `-<lane int>` suffixes, in any order and
    # combination (`AAAC-1`, `AAAC_sample1`, `AAAC-1_sample1`), by iterating until
    # neither pattern matches. Only a NUMERIC lane suffix is stripped, so a gene
    # symbol like `HLA-A` is untouched.
    out = key
    while True:
        stripped = _BARCODE_SAMPLE_RE.sub("", out)
        stripped = _BARCODE_LANE_RE.sub("", stripped)
        if stripped == out:
            return out
        out = stripped


def _step_ensembl_version(key: str) -> str:
    m = _ENSEMBL_RE.match(key)
    return m.group(1) if m else key


def _apply_normalize(key, steps):
    """Apply the ordered normalize pipeline to a single key. The key is FIRST
    canonicalized via ``_as_key`` (integer-valued floats ``1.0`` → ``'1'``, exactly
    like the raw/no-normalize path) BEFORE any string step runs; ``None`` / NaN keys
    become the empty string (they never match a real key, which is the desired
    behavior).

    Canonicalizing here is load-bearing: a float64 key column (any NaN in the column
    forces float dtype, so ``1`` reads back as ``1.0``) would otherwise stringify to
    ``'1.0'`` under normalization while the exact-match path used ``_as_key`` → ``'1'``
    — a silent 0-match despite ``matched_before_normalize > 0`` (the float-key bug)."""
    s = _as_key(key)
    for step in steps:
        if step == "trim":
            s = s.strip()
        elif step == "casefold":
            s = s.casefold()
        elif step == "barcode_suffix":
            s = _step_barcode_suffix(s)
        elif step == "ensembl_version":
            s = _step_ensembl_version(s)
        else:
            raise AlignmentError(
                f"unknown normalize step {step!r}; known: {list(_KNOWN_STEPS)}"
            )
    return s


# ──────────────────────────────── public API ──────────────────────────────────

def align(table_rows, key_column, axis_index, normalize=None):
    """Left-join a supporting table onto an ordered entity axis (DEC-2 / DEC-18).

    Args:
      table_rows:  the supporting annotation table — a ``list[dict]`` (row records)
                   OR a ``pandas.DataFrame``. One column (``key_column``) is the join
                   key; every OTHER column is aligned to the axis.
      key_column:  the name of the join-key column in the table.
      axis_index:  the primary axis's ordered entity ids (``list``); the OUTPUT
                   column order + length match this exactly.
      normalize:   an optional ordered ``list[str]`` of normalize steps
                   (``"barcode_suffix"`` / ``"ensembl_version"`` / ``"trim"`` /
                   ``"casefold"``) applied to BOTH sides for matching only.

    Returns a dict::

        {
          "columns": {col: [values aligned to axis_index order, None where missing]},
          "coverage": {matched, missing, extra,
                       matched_before_normalize, matched_after_normalize},
          "warnings": [ ... human-readable strings ... ],
        }

    Raises ``AlignmentError`` on a duplicate key in the table (DEC-2 hard error)
    or a missing ``key_column``.
    """
    df = _as_dataframe(table_rows)
    steps = list(normalize or [])

    if key_column not in df.columns:
        raise AlignmentError(
            f"key_column {key_column!r} not found in table columns {list(df.columns)}"
        )

    value_columns = [c for c in df.columns if c != key_column]
    raw_keys = df[key_column].tolist()

    # ── duplicate-key guard (DEC-2 HARD error) — on the RAW keys (a normalization
    #    that collapses two distinct raw keys is NOT a table duplicate; a genuinely
    #    duplicated supplied key is). ────────────────────────────────────────────
    dup = _first_duplicate([_as_key(k) for k in raw_keys])
    if dup is not None:
        raise AlignmentError(
            f"duplicate key {dup!r} in supporting table column {key_column!r}: "
            f"each axis entity must map to at most one row"
        )

    axis = list(axis_index)

    # ── raw (pre-normalize) match count, for the DEC-18 before/after report ──────
    raw_key_set = {_as_key(k) for k in raw_keys}
    matched_before = sum(1 for a in axis if _as_key(a) in raw_key_set)

    # ── build the normalized lookup: normalized-key → row index ─────────────────
    #    A normalization that maps two DISTINCT raw keys to the SAME normalized key
    #    is a real ambiguity — surface it as a hard error (we cannot pick a row).
    norm_lookup = {}
    for i, k in enumerate(raw_keys):
        nk = _apply_normalize(k, steps) if steps else _as_key(k)
        if nk in norm_lookup:
            raise AlignmentError(
                f"normalized key {nk!r} maps to multiple rows in the supporting "
                f"table (raw keys {_as_key(raw_keys[norm_lookup[nk]])!r} and "
                f"{_as_key(k)!r}) — cannot align unambiguously"
            )
        norm_lookup[nk] = i

    # ── walk the axis in ORDER, pulling each entity's row (left-join) ───────────
    #    AXIS-SIDE collision guard (asymmetry fix): two DISTINCT axis entities can
    #    normalize to the SAME key and both pull the SAME table row — the axis mirror
    #    of the (hard-error) TABLE-side collision above. We do NOT hard-fail (a
    #    legitimately duplicated axis can occur) but we (a) do NOT over-count
    #    ``matched`` for the colliding entity and (b) surface a warning. Deterministic:
    #    the FIRST axis entity to claim a normalized key is the counted match; a later
    #    DISTINCT entity is still filled from the same row but not re-counted. A
    #    genuinely duplicated axis entity (identical raw key) is NOT a collision.
    columns = {c: [] for c in value_columns}
    matched = 0
    missing = 0
    matched_axis_rows = set()
    claimed_norm = {}  # normalized-key → the raw key that first claimed it
    axis_collisions = []
    for a in axis:
        na = _apply_normalize(a, steps) if steps else _as_key(a)
        ri = norm_lookup.get(na)
        if ri is None:
            missing += 1
            for c in value_columns:
                columns[c].append(None)
            continue
        cur_raw = _as_key(a)
        prev_raw = claimed_norm.get(na)
        if prev_raw is not None and prev_raw != cur_raw:
            # a DISTINCT axis entity already claimed this normalized key → collision.
            axis_collisions.append((prev_raw, cur_raw, na))
            for c in value_columns:  # fill deterministically; do NOT re-count matched.
                columns[c].append(_cell(df.iloc[ri][c]))
        else:
            matched += 1
            matched_axis_rows.add(ri)
            claimed_norm[na] = cur_raw
            for c in value_columns:
                columns[c].append(_cell(df.iloc[ri][c]))

    # ── extras: table rows never consumed by any axis entity (ignored) ──────────
    extra = len(raw_keys) - len(matched_axis_rows)

    warnings = []
    if missing:
        warnings.append(
            f"{missing} axis entit{'y' if missing == 1 else 'ies'} had no matching "
            f"row in the supporting table (filled with NA)"
        )
    if extra:
        warnings.append(
            f"{extra} supporting-table row{'' if extra == 1 else 's'} had no matching "
            f"axis entity (ignored)"
        )
    if steps and matched > matched_before:
        warnings.append(
            f"normalization ({'+'.join(steps)}) recovered "
            f"{matched - matched_before} additional match"
            f"{'' if matched - matched_before == 1 else 'es'} "
            f"({matched_before} → {matched})"
        )
    # Symmetric to the recovery warning: a pipeline that REGRESSES coverage (collapsed
    # keys that matched raw) is a real problem — surface it, don't hide it.
    if steps and matched < matched_before:
        lost = matched_before - matched
        warnings.append(
            f"normalization ({'+'.join(steps)}) REGRESSED coverage by "
            f"{lost} match{'' if lost == 1 else 'es'} "
            f"({matched_before} → {matched}) — the pipeline collapsed or altered keys "
            f"that matched the axis exactly"
        )
    if axis_collisions:
        pairs = "; ".join(f"{p!r}+{c!r}→{n!r}" for p, c, n in axis_collisions[:5])
        more = "" if len(axis_collisions) <= 5 else f" (+{len(axis_collisions) - 5} more)"
        warnings.append(
            f"{len(axis_collisions)} axis-side normalization collision"
            f"{'' if len(axis_collisions) == 1 else 's'}: distinct axis entities "
            f"collapsed to the same key and share one table row; matched not "
            f"over-counted [{pairs}{more}]"
        )

    return {
        "columns": columns,
        "coverage": {
            "matched": matched,
            "missing": missing,
            "extra": extra,
            "matched_before_normalize": matched_before,
            "matched_after_normalize": matched,
        },
        "warnings": warnings,
    }


# ──────────────────────────────── internals ───────────────────────────────────

def _as_dataframe(table_rows):
    if isinstance(table_rows, pd.DataFrame):
        return table_rows
    if isinstance(table_rows, list):
        return pd.DataFrame.from_records(table_rows)
    raise AlignmentError(
        "table_rows must be a list[dict] or a pandas.DataFrame, got "
        f"{type(table_rows).__name__}"
    )


def _as_key(v):
    """Canonicalize a raw key for exact (pre-normalize) comparison — coerce to a
    trimmed string so an integer axis id and a string table key compare equal
    (``42`` == ``"42"``); None/NaN → the empty string."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return ""
    if isinstance(v, float) and float(v).is_integer():
        return str(int(v))
    return str(v)


def _cell(v):
    """Convert one aligned pandas cell to a JSON-friendly Python scalar; NaN/NaT
    → None (the aligned-NA representation shared with the 'missing' fill)."""
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


def _first_duplicate(keys):
    seen = set()
    for k in keys:
        if k in seen:
            return k
        seen.add(k)
    return None
