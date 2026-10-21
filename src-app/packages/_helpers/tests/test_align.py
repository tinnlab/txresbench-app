#!/usr/bin/env python3
# ruff: noqa
"""Tests for the ITEM-8 axis-agnostic alignment engine (DEC-2 / DEC-18)."""
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from align import AlignmentError, align  # noqa: E402


# ───────────────────────────── DEC-2 core policy ──────────────────────────────

def test_matched_populates_in_axis_order():
    rows = [
        {"barcode": "C", "label": "gamma", "score": 3.0},
        {"barcode": "A", "label": "alpha", "score": 1.0},
        {"barcode": "B", "label": "beta", "score": 2.0},
    ]
    axis = ["A", "B", "C"]
    out = align(rows, key_column="barcode", axis_index=axis)
    # Output columns re-ordered to the AXIS order, not the table order.
    assert out["columns"]["label"] == ["alpha", "beta", "gamma"]
    assert out["columns"]["score"] == [1.0, 2.0, 3.0]
    assert "barcode" not in out["columns"]  # key column is not emitted
    assert out["coverage"]["matched"] == 3
    assert out["coverage"]["missing"] == 0
    assert out["coverage"]["extra"] == 0
    assert out["warnings"] == []


def test_missing_axis_entity_is_na_and_counted():
    rows = [{"barcode": "A", "label": "alpha"}, {"barcode": "C", "label": "gamma"}]
    axis = ["A", "B", "C"]  # B has no row
    out = align(rows, key_column="barcode", axis_index=axis)
    assert out["columns"]["label"] == ["alpha", None, "gamma"]  # NA where missing
    assert out["coverage"]["matched"] == 2
    assert out["coverage"]["missing"] == 1
    assert out["coverage"]["extra"] == 0
    assert any("no matching row" in w for w in out["warnings"])


def test_extra_table_key_is_ignored_and_counted():
    rows = [
        {"barcode": "A", "label": "alpha"},
        {"barcode": "B", "label": "beta"},
        {"barcode": "Z", "label": "zeta"},  # no axis entity → extra, ignored
    ]
    axis = ["A", "B"]
    out = align(rows, key_column="barcode", axis_index=axis)
    assert out["columns"]["label"] == ["alpha", "beta"]  # Z contributes nothing
    assert out["coverage"]["matched"] == 2
    assert out["coverage"]["missing"] == 0
    assert out["coverage"]["extra"] == 1
    assert any("no matching axis entity" in w for w in out["warnings"])


def test_missing_and_extra_together():
    rows = [{"barcode": "A", "v": 1}, {"barcode": "Z", "v": 9}]
    axis = ["A", "B"]  # B missing; Z extra
    out = align(rows, key_column="barcode", axis_index=axis)
    assert out["columns"]["v"] == [1, None]
    assert out["coverage"]["matched"] == 1
    assert out["coverage"]["missing"] == 1
    assert out["coverage"]["extra"] == 1


def test_duplicate_key_raises():
    rows = [
        {"barcode": "A", "label": "alpha"},
        {"barcode": "A", "label": "again"},  # duplicate key → HARD error
        {"barcode": "B", "label": "beta"},
    ]
    with pytest.raises(AlignmentError) as ei:
        align(rows, key_column="barcode", axis_index=["A", "B"])
    assert "duplicate key" in str(ei.value).lower()


def test_missing_key_column_raises():
    rows = [{"barcode": "A", "label": "alpha"}]
    with pytest.raises(AlignmentError):
        align(rows, key_column="cell_id", axis_index=["A"])


def test_accepts_dataframe_input():
    df = pd.DataFrame({"k": ["A", "B"], "x": [10, 20]})
    out = align(df, key_column="k", axis_index=["B", "A"])
    assert out["columns"]["x"] == [20, 10]  # axis order B, A preserved


# ───────────────────────── DEC-18 key normalization ───────────────────────────

def test_barcode_suffix_normalization_matches():
    # Table keys are BARE barcodes; axis carries the 10x `-1` lane suffix.
    rows = [
        {"barcode": "AAAC", "ct": "T"},
        {"barcode": "GGGT", "ct": "B"},
    ]
    axis = ["AAAC-1", "GGGT-1"]
    raw = align(rows, key_column="barcode", axis_index=axis)
    assert raw["coverage"]["matched_before_normalize"] == 0  # nothing matches raw
    assert raw["coverage"]["matched"] == 0

    out = align(rows, key_column="barcode", axis_index=axis, normalize=["barcode_suffix"])
    assert out["columns"]["ct"] == ["T", "B"]
    assert out["coverage"]["matched"] == 2
    # AXIS ORDER + labels preserved in output (we don't reorder / relabel to bare).
    assert out["coverage"]["matched_after_normalize"] == 2
    # before < after → the normalization-only match is visible + trusted.
    assert out["coverage"]["matched_before_normalize"] < out["coverage"]["matched_after_normalize"]
    assert any("normalization" in w for w in out["warnings"])


def test_barcode_sample_suffix_stripped():
    rows = [{"barcode": "AAAC", "ct": "T"}]
    axis = ["AAAC-1_sample1"]  # both a lane `-1` and a `_sample1` tag
    out = align(rows, key_column="barcode", axis_index=axis, normalize=["barcode_suffix"])
    assert out["coverage"]["matched"] == 1
    assert out["columns"]["ct"] == ["T"]


def test_ensembl_version_normalization_matches():
    # Table keys are versioned Ensembl ids; axis is unversioned.
    rows = [
        {"gene": "ENSG42.3", "sym": "TP53"},
        {"gene": "ENST7.11", "sym": "FOO"},
    ]
    axis = ["ENSG42", "ENST7"]
    raw = align(rows, key_column="gene", axis_index=axis)
    assert raw["coverage"]["matched_before_normalize"] == 0

    out = align(rows, key_column="gene", axis_index=axis, normalize=["ensembl_version"])
    assert out["columns"]["sym"] == ["TP53", "FOO"]
    assert out["coverage"]["matched"] == 2
    assert out["coverage"]["matched_before_normalize"] < out["coverage"]["matched_after_normalize"]


def test_ensembl_does_not_strip_gene_symbol_dash():
    # A gene symbol like HLA-A must NOT be treated as a versioned Ensembl id, and
    # its `-A` is non-numeric so barcode_suffix must not touch it either.
    rows = [{"gene": "HLA-A", "sym": "hlaa"}]
    axis = ["HLA-A"]
    out = align(rows, key_column="gene", axis_index=axis,
                normalize=["ensembl_version", "barcode_suffix"])
    assert out["coverage"]["matched"] == 1
    assert out["columns"]["sym"] == ["hlaa"]


def test_trim_and_casefold():
    rows = [{"k": "  Abc  ", "v": 1}]
    axis = ["abc"]
    out = align(rows, key_column="k", axis_index=axis, normalize=["trim", "casefold"])
    assert out["coverage"]["matched"] == 1
    assert out["columns"]["v"] == [1]


def test_axis_order_preserved_under_normalization():
    rows = [
        {"barcode": "GGGT", "ct": "B"},
        {"barcode": "AAAC", "ct": "T"},
    ]
    axis = ["AAAC-1", "GGGT-1", "CCCC-1"]  # last is missing
    out = align(rows, key_column="barcode", axis_index=axis, normalize=["barcode_suffix"])
    # Values follow the AXIS order exactly (AAAC, GGGT, then NA for CCCC).
    assert out["columns"]["ct"] == ["T", "B", None]
    assert out["coverage"]["matched"] == 2
    assert out["coverage"]["missing"] == 1


def test_normalization_collision_raises():
    # Two distinct raw table keys collapse to the same normalized key → ambiguous.
    rows = [{"barcode": "AAAC-1", "ct": "T"}, {"barcode": "AAAC-2", "ct": "B"}]
    with pytest.raises(AlignmentError):
        align(rows, key_column="barcode", axis_index=["AAAC"], normalize=["barcode_suffix"])


# ── TEST-82 (visualize-pane ITEM-67) — the DESCOPE BOUNDARY ───────────────────
#
# ITEM-67 (`axis-merge`) was cut this round under `[approved: owner 2026-08-12]`. What is
# asserted here is not the descoped feature — it is that the BOUNDARY held, because a
# vanishing test is how a plan quietly shrinks and a half-started computation is how next
# round's work begins by accident inside this one.
#
# Three clauses, and the first two are the ones nothing else in the repo says:
#   1. no `axis-merge` package ships;
#   2. `align.align`'s `coverage` contract is UNCHANGED — the same three counters the
#      pre-existing tests above pin, still returned, still named the same;
#   3. no NEW consumer reads `coverage`. Its one consumer is `annotation-integrate`, which
#      predates this round. A second reader appearing is the merge computation starting.

def _packages_root():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))  # …/src-app/packages


def test_item67_no_axis_merge_package_ships():
    root = _packages_root()
    names = sorted(
        d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))
    )
    # Positive control: the scan is actually looking at the package tree. Without it an
    # empty/foreign directory would satisfy the assertion below for the wrong reason.
    assert "_helpers" in names, f"not the packages root: {names}"
    offenders = [n for n in names if "axis" in n and "merge" in n]
    assert offenders == [], f"ITEM-67 was descoped, but a merge package ships: {offenders}"


def test_item67_coverage_contract_is_unchanged():
    # The shape, asserted as a shape rather than through one scenario: exactly these keys.
    out = align(
        [{"barcode": "A", "v": 1}],
        key_column="barcode",
        axis_index=["A", "B"],
    )
    assert set(out["coverage"]) == {
        "matched",
        "missing",
        "extra",
        "matched_before_normalize",
        "matched_after_normalize",
    }, out["coverage"]
    assert out["coverage"]["matched"] == 1
    assert out["coverage"]["missing"] == 1
    assert out["coverage"]["extra"] == 0


def test_item67_coverage_has_no_new_consumer():
    # `coverage` is READ by exactly one shipped package, and it is the pre-existing one. A
    # second reader is next round's computation leaking into this one.
    root = _packages_root()
    readers = set()
    for pkg in sorted(os.listdir(root)):
        pkg_dir = os.path.join(root, pkg)
        if not os.path.isdir(pkg_dir):
            continue
        for dirpath, _dirs, files in os.walk(pkg_dir):
            if "tests" in dirpath.split(os.sep):
                continue  # a test may name anything; this is about production readers
            for f in files:
                if not f.endswith(".py"):
                    continue
                path = os.path.join(dirpath, f)
                try:
                    src = open(path, encoding="utf-8").read()
                except OSError:
                    continue
                if '["coverage"]' in src or "['coverage']" in src or '"coverage"]' in src:
                    readers.add(pkg)
    # Positive control: the scan finds the reader we KNOW exists, so an empty result below
    # cannot be a broken walk reading as a clean boundary.
    assert "annotation-integrate" in readers, f"the known consumer was not found: {sorted(readers)}"
    assert readers <= {"_helpers", "annotation-integrate"}, (
        f"a NEW consumer of align()'s coverage appeared — ITEM-67 is descoped: {sorted(readers)}"
    )
