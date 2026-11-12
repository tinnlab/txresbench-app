#!/usr/bin/env python3
# ruff: noqa
"""Regression tests for the CONFIRMED data-correctness bugs in the sandbox processors.

Each test here would have FAILED before the corresponding fix:
  1. barcode_suffix wrongly applied to the genes axis (dash-DIGIT gene symbols).
  2. float-key mismatch under normalization (float64 key column).
  3. silent axis-side normalization collision.
  4. detect_key_column zero-match reported as clean success (now DEGRADED).
  + output row-count == axis length; all-null categorical summarized without crash.

Imports resolve via the scripts-root `conftest.py` (align/colsummary + the
annotation-integrate extension are placed on `sys.path`)."""
import numpy as np
import pandas as pd
import pytest

from align import AlignmentError, align
from annotation_integrate import (
    DEFAULT_NORMALIZE,
    default_normalize_for_axis,
    integrate,
)
from colsummary import summarize_column


# ─────────────── Fix 1: axis-aware default; dash-DIGIT gene symbols ────────────

def test_axis_aware_default_pipeline_selection():
    # cells → barcode_suffix (NOT ensembl); genes/features → ensembl_version (NOT
    # barcode_suffix); anything else → trim only.
    assert default_normalize_for_axis("cells") == ["barcode_suffix", "trim"]
    assert default_normalize_for_axis("genes") == ["ensembl_version", "trim"]
    assert default_normalize_for_axis("features") == ["ensembl_version", "trim"]
    assert default_normalize_for_axis("samples") == ["trim"]
    assert default_normalize_for_axis(None) == ["trim"]
    # barcode_suffix must NEVER be in a non-cell default.
    assert "barcode_suffix" not in default_normalize_for_axis("genes")
    assert "barcode_suffix" not in default_normalize_for_axis("features")


def test_dash_digit_gene_symbols_align_on_genes_axis_no_collision():
    # NKX2-1 and NKX2-5 are DISTINCT real gene symbols. On the genes axis the default
    # pipeline (ensembl_version+trim) leaves them intact → both align, no collision.
    axis = ["NKX2-1", "NKX2-5", "HOXA-1"]
    rows = [
        {"gene": "NKX2-1", "biotype": "protein_coding"},
        {"gene": "NKX2-5", "biotype": "protein_coding"},
        {"gene": "HOXA-1", "biotype": "lncRNA"},
    ]
    out = integrate(axis, rows, axis_name="genes")
    assert out["coverage"]["matched"] == 3
    assert out["coverage"]["missing"] == 0
    assert out.get("degraded") is False
    col = {c["name"]: c for c in out["columns"]}["biotype"]
    assert col["values"] == ["protein_coding", "protein_coding", "lncRNA"]
    # No axis-side collision, no coverage regression from the pipeline.
    assert not any("collision" in w.lower() for w in out["warnings"])
    assert not any("regressed" in w.lower() for w in out["warnings"])


def test_barcode_suffix_would_collapse_dash_digit_genes_hard_error():
    # Demonstrates the HAZARD the axis-aware default avoids: forcing barcode_suffix on
    # dash-DIGIT gene symbols collapses NKX2-1 + NKX2-5 → "NKX2" (TABLE-side dup → hard
    # error). This is exactly why barcode_suffix must not be the genes default.
    rows = [
        {"gene": "NKX2-1", "biotype": "protein_coding"},
        {"gene": "NKX2-5", "biotype": "protein_coding"},
    ]
    with pytest.raises(AlignmentError):
        align(rows, key_column="gene", axis_index=["NKX2"], normalize=["barcode_suffix", "trim"])


# ─────────────── Fix 2: float64 key column aligns under normalization ──────────

def test_float64_key_column_aligns_under_normalization():
    # A NaN anywhere in the key column forces float64 dtype, so integer ids read back
    # as 1.0/2.0. Before the fix, `str(1.0)` → "1.0" under normalization while the axis
    # side canonicalized to "1" → 0 matches despite matched_before_normalize>0.
    rows = [
        {"k": 1.0, "v": "a"},
        {"k": 2.0, "v": "b"},
        {"k": np.nan, "v": "c"},  # forces float64; unmatchable key
    ]
    axis = [1, 2, 3]  # integer axis ids
    out = align(rows, key_column="k", axis_index=axis, normalize=["trim"])
    assert out["coverage"]["matched_before_normalize"] == 2
    assert out["coverage"]["matched"] == 2  # NOT 0 — the float-key bug is fixed
    assert out["columns"]["v"] == ["a", "b", None]
    # Coverage did not regress under normalization → no regression warning.
    assert not any("regressed" in w.lower() for w in out["warnings"])


def test_float_key_no_normalize_still_matches():
    # The raw/no-normalize path already canonicalized; assert the normalized path now
    # agrees (1.0 → "1" on both sides).
    df = pd.DataFrame({"k": pd.array([10, None, 30], dtype="Int64"), "v": ["x", "y", "z"]})
    # Int64 with a null → the key column carries pandas NA; canonicalization must still
    # match the string axis ids "10"/"30".
    out = align(df, key_column="k", axis_index=["10", "20", "30"], normalize=["casefold"])
    assert out["columns"]["v"] == ["x", None, "z"]
    assert out["coverage"]["matched"] == 2


# ─────────────── Fix 3: axis-side normalization collision is surfaced ──────────

def test_axis_side_collision_surfaces_warning_and_no_overcount():
    # TWO distinct axis entities (NKX2-1, NKX2-5) both normalize to "NKX2" under
    # barcode_suffix and share the single "NKX2" table row. Not a hard error, but:
    #   * matched must NOT be over-counted (counts the row once), and
    #   * a warning must be surfaced (the previously-silent asymmetry).
    rows = [{"gene": "NKX2", "biotype": "protein_coding"}]
    axis = ["NKX2-1", "NKX2-5"]
    out = align(rows, key_column="gene", axis_index=axis, normalize=["barcode_suffix"])
    # Both positions filled deterministically from the same row …
    assert out["columns"]["biotype"] == ["protein_coding", "protein_coding"]
    # … but matched counts the shared row ONCE (no over-count).
    assert out["coverage"]["matched"] == 1
    assert any("collision" in w.lower() for w in out["warnings"])


def test_distinct_axis_no_collision_warning():
    # Control: distinct normalized keys → no collision warning.
    rows = [{"g": "A", "v": 1}, {"g": "B", "v": 2}]
    out = align(rows, key_column="g", axis_index=["A", "B"], normalize=["trim"])
    assert not any("collision" in w.lower() for w in out["warnings"])
    assert out["coverage"]["matched"] == 2


# ─────────────── Fix 4: zero-match auto-detect → DEGRADED, not success ─────────

def test_zero_match_AUTO_DETECT_is_refused_outright_not_flagged_degraded():
    # The annotation table shares NO keys with the axis and names no key column.
    #
    # Fix 4 originally turned this from "clean success" into "success flagged DEGRADED",
    # which was only half the fix: the flag has no reader (the completion hook stores the
    # summary verbatim, the per-file status is derived from the JOB's outcome, and the
    # panel's `integration_summary` narrowing keeps only {matched,missing,extra,error}),
    # so the user still saw a green "Integrated" tag over all-NA columns. Worse, the
    # "best" column was whichever came FIRST — the detector accepted `matched == 0`.
    # With nothing aligning there is no key, so the inference must refuse.
    axis = ["AAAC-1", "CCCG-1"]
    rows = [
        {"barcode": "ZZZZ", "cell_type": "T"},
        {"barcode": "YYYY", "cell_type": "B"},
    ]
    with pytest.raises(AlignmentError) as exc:
        integrate(axis, rows, axis_name="cells")  # auto-detect key
    msg = str(exc.value)
    assert "auto-detect" in msg
    # Actionable: names each candidate + its score, and shows both sides' key shapes.
    assert "'barcode'" in msg and "'cell_type'" in msg, msg
    assert "AAAC-1" in msg and "ZZZZ" in msg, msg


def test_zero_match_with_an_EXPLICIT_key_column_is_flagged_degraded_not_success():
    # The other half of Fix 4, which survives unchanged: when the caller NAMES the join
    # column, a zero-match alignment is an honest (all-NA) answer to the question asked
    # rather than an invented one — it emits, and is flagged degraded rather than clean.
    axis = ["AAAC-1", "CCCG-1"]
    rows = [
        {"barcode": "ZZZZ", "cell_type": "T"},
        {"barcode": "YYYY", "cell_type": "B"},
    ]
    out = integrate(axis, rows, axis_name="cells", key_column="barcode")
    assert out["degraded"] is True
    assert out["coverage"]["matched"] == 0
    col = {c["name"]: c for c in out["columns"]}["cell_type"]
    assert col["values"] == [None, None]  # all-NA
    assert col["summary"]["degraded"] is True
    assert col["summary"]["status"] == "degraded"
    assert any("degraded" in w.lower() for w in out["warnings"])


def test_successful_alignment_is_not_degraded():
    axis = ["AAAC-1", "CCCG-1"]
    rows = [{"barcode": "AAAC", "cell_type": "T"}, {"barcode": "CCCG", "cell_type": "B"}]
    out = integrate(axis, rows, axis_name="cells")
    assert out["degraded"] is False
    col = {c["name"]: c for c in out["columns"]}["cell_type"]
    assert col["summary"]["status"] == "ok"
    assert col["summary"]["degraded"] is False


# ─────────────── Output row-count == axis length (≥5-row axis) ─────────────────

def test_align_output_row_count_equals_axis_length():
    axis = ["A", "B", "C", "D", "E", "F"]  # 6 entities
    rows = [{"k": k, "v": i} for i, k in enumerate(["A", "C", "E"])]  # only 3 present
    out = align(rows, key_column="k", axis_index=axis)
    assert len(out["columns"]["v"]) == len(axis) == 6
    assert out["columns"]["v"] == [0, None, 1, None, 2, None]
    assert out["coverage"]["matched"] == 3
    assert out["coverage"]["missing"] == 3


def test_integrate_output_row_count_equals_axis_length():
    axis = ["AAAC-1", "CCCG-1", "GGGG-1", "TTTT-1", "ACGT-1"]  # 5 cells
    rows = [
        {"barcode": "AAAC", "cell_type": "T"},
        {"barcode": "GGGG", "cell_type": "B"},
    ]
    out = integrate(axis, rows, axis_name="cells")
    col = {c["name"]: c for c in out["columns"]}["cell_type"]
    assert len(col["values"]) == len(axis) == 5
    assert col["values"] == ["T", None, "B", None, None]
    assert col["summary"]["n"] == 5


# ─────────────── all-null CATEGORICAL column summarizes without crash ──────────

def test_all_null_object_categorical_summary_no_crash():
    # An entirely-missing aligned column (every axis entity unmatched) is object dtype
    # and must summarize as a categorical with zero categories, not crash.
    s = summarize_column([None, None, None, None, None], name="cell_type")
    assert s["kind"] == "categorical"
    assert s["n"] == 5
    assert s["n_missing"] == 5
    assert s["categories"] == []
    assert s["n_categories"] == 0
    assert s["high_cardinality"] is False


def test_all_null_declared_categorical_summary_no_crash():
    dtype = pd.CategoricalDtype(categories=["x", "y"], ordered=True)
    s = summarize_column(pd.Series([None, None], dtype=dtype), name="c")
    assert s["kind"] == "categorical"
    assert s["n_missing"] == 2
    # The declared category universe is preserved even when unobserved.
    assert s["categories"] == ["x", "y"]
    assert s["ordered"] is True


# ─────────────── Fix 5: unified kind vocabulary across writers ─────────────────

def test_colsummary_kind_vocabulary_is_categorical_continuous():
    # colsummary is the reference vocabulary: {categorical, continuous}.
    assert summarize_column(["a", "b"], name="c")["kind"] == "categorical"
    assert summarize_column([1.0, 2.0], name="v")["kind"] == "continuous"
    assert summarize_column(pd.Series([1, 2], dtype="int64"), name="i")["kind"] == "continuous"


def test_h5ad_write_metadata_column_uses_unified_kinds(tmp_path):
    # The h5ad writer must speak the SAME {categorical, continuous} vocab (was
    # {categorical, string, numeric}). `h5ad_import` imports scipy at module load
    # (the real sandbox env has the single-cell stack); dependency-gate it here since
    # this pure-test env is pandas/numpy-only.
    import importlib

    pytest.importorskip("scipy")
    h5 = importlib.import_module("h5ad_import")

    def kind_of(rel, name, series):
        # ITEM-26: the writer now emits a Zarr artifact directory and returns the two
        # producer declarations `(structure, meta)`; the display vocabulary lives on
        # `meta`, which is what has to keep agreeing with colsummary.
        # `axis` is declared, never defaulted: neither `h5ad_import` nor the framework
        # `txr_columns` it delegates to holds a default any more (INV-2/INV-5).
        _structure, meta = h5.write_metadata_column(tmp_path, rel, name, series, "cells")
        return meta

    # object/free-string column → "categorical" (was "string").
    assert kind_of("a.zarr", "s", pd.Series(["x", "y", "z"]))["kind"] == "categorical"
    # bool column → "categorical" (was "string").
    assert kind_of("b.zarr", "flag", pd.Series([True, False, True]))["kind"] == "categorical"
    # integer column → "continuous" (was "numeric").
    assert kind_of("c.zarr", "n", pd.Series([1, 2, 3], dtype="int64"))["kind"] == "continuous"
    # float column → "continuous".
    assert kind_of("d.zarr", "f", pd.Series([1.0, 2.5]))["kind"] == "continuous"
    # declared categorical → "categorical" (with the declared level set preserved).
    dt = pd.CategoricalDtype(categories=["lo", "hi"], ordered=True)
    m5 = kind_of("e.zarr", "sev", pd.Series(["lo", "hi"], dtype=dt))
    assert m5["kind"] == "categorical"
    # This test is about the KIND vocabulary. `meta` carries the level COUNT, not the
    # list — the list is data and the manifest is size-capped metadata; that the
    # declared set is preserved is asserted on `structure` + the stored stamp in
    # `_lib/test_columns.py`.
    assert m5["n_levels"] == 2 and m5["ordered"] is True
