#!/usr/bin/env python3
# ruff: noqa
"""Tests for the ITEM-21 compact per-column viz summary (DEC-25 / DEC-26)."""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from colsummary import MAX_SUMMARY_CATEGORIES, summarize_column  # noqa: E402


# ─────────────────────────────── categorical ──────────────────────────────────

def test_small_categorical_object():
    s = summarize_column(["a", "b", "a", "c", None, "b"], name="cell_type")
    assert s["name"] == "cell_type"
    assert s["kind"] == "categorical"
    assert s["n"] == 6
    assert s["n_missing"] == 1
    assert set(s["categories"]) == {"a", "b", "c"}
    assert s["n_categories"] == 3
    assert s["high_cardinality"] is False
    assert s["ordered"] is False


def test_ordered_categorical_reports_order_flag_and_universe():
    dtype = pd.CategoricalDtype(categories=["low", "mid", "high"], ordered=True)
    s = summarize_column(pd.Series(["low", "high", "mid", "low"], dtype=dtype), name="severity")
    assert s["kind"] == "categorical"
    assert s["ordered"] is True
    # declared category ORDER preserved
    assert s["categories"] == ["low", "mid", "high"]
    assert s["n_categories"] == 3
    assert s["high_cardinality"] is False
    assert s["n_missing"] == 0


def test_high_cardinality_caps_and_reports_true_count():
    n_distinct = MAX_SUMMARY_CATEGORIES + 50
    values = [f"id{i}" for i in range(n_distinct)]
    s = summarize_column(values, name="barcode")
    assert s["kind"] == "categorical"
    assert s["high_cardinality"] is True
    assert s["n_categories"] == n_distinct  # TRUE distinct count
    assert len(s["categories"]) == MAX_SUMMARY_CATEGORIES  # capped list
    assert s["n"] == n_distinct


def test_custom_max_categories():
    s = summarize_column([f"x{i}" for i in range(10)], name="c", max_categories=5)
    assert s["high_cardinality"] is True
    assert s["n_categories"] == 10
    assert len(s["categories"]) == 5


def test_categorical_at_exact_cap_is_not_high_cardinality():
    values = [f"id{i}" for i in range(MAX_SUMMARY_CATEGORIES)]
    s = summarize_column(values, name="c")
    assert s["n_categories"] == MAX_SUMMARY_CATEGORIES
    assert s["high_cardinality"] is False
    assert len(s["categories"]) == MAX_SUMMARY_CATEGORIES


def test_bool_column_is_categorical():
    s = summarize_column([True, False, True, None], name="is_doublet")
    assert s["kind"] == "categorical"
    assert s["n_missing"] == 1
    assert set(s["categories"]) == {True, False}


# ─────────────────────────────── continuous ───────────────────────────────────

def test_continuous_float_min_max_mean():
    s = summarize_column([1.0, 2.0, 3.0, 4.0], name="n_genes")
    assert s["kind"] == "continuous"
    assert s["n"] == 4
    assert s["n_missing"] == 0
    assert s["min"] == 1.0
    assert s["max"] == 4.0
    assert s["mean"] == pytest.approx(2.5)


def test_continuous_counts_missing_and_ignores_nonfinite():
    s = summarize_column([1.0, np.nan, 3.0, np.nan], name="score")
    assert s["kind"] == "continuous"
    assert s["n"] == 4
    assert s["n_missing"] == 2
    assert s["min"] == 1.0
    assert s["max"] == 3.0
    assert s["mean"] == pytest.approx(2.0)


def test_integer_stays_exact_typed():
    s = summarize_column(pd.Series([10, 20, 30], dtype="int64"), name="leiden")
    assert s["kind"] == "continuous"
    assert isinstance(s["min"], int) and s["min"] == 10
    assert isinstance(s["max"], int) and s["max"] == 30
    assert s["mean"] == pytest.approx(20.0)
    assert s["n_missing"] == 0


def test_nullable_integer_missing_counted():
    s = summarize_column(pd.array([1, None, 3], dtype="Int64"), name="cluster")
    assert s["kind"] == "continuous"
    assert s["n_missing"] == 1
    assert s["min"] == 1
    assert s["max"] == 3


def test_all_missing_continuous_yields_none_stats():
    s = summarize_column([np.nan, np.nan], name="empty")
    assert s["kind"] == "continuous"
    assert s["n_missing"] == 2
    assert s["min"] is None and s["max"] is None and s["mean"] is None


# ──────────────────────────────── compactness ─────────────────────────────────

def test_summary_is_compact_no_values_array():
    # A big column must NOT round-trip its per-row body into the summary.
    big = list(range(100_000)) + [i for i in range(100_000)]
    cat = summarize_column([str(x % 5) for x in big], name="c")
    cont = summarize_column([float(x) for x in big], name="v")
    for s in (cat, cont):
        assert "values" not in s
        # No field holds a per-row-length array.
        for k, v in s.items():
            if isinstance(v, list):
                assert len(v) <= MAX_SUMMARY_CATEGORIES
