#!/usr/bin/env python3
# ruff: noqa
"""Tests for the ITEM-13 annotation-table integrator (annotation_integrate.integrate).

The pure core is I/O-free, so we drive it in-memory. `align.py` + `colsummary.py` live
in the scripts dir (this file's parent's parent); `annotation_integrate.py` lives in the
`annotation-integrate` extension folder — both are added to `sys.path` (mirroring how the
sandbox runner stages them side-by-side)."""
import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.dirname(_HERE)  # …/processors/_helpers (align.py, colsummary.py)
sys.path.insert(0, _SCRIPTS)
# …/processors/_helpers/tests → up 3 → src-app, then packages/annotation-integrate.
_SRC_APP = os.path.abspath(os.path.join(_HERE, *([os.pardir] * 3)))
_EXT = os.path.join(_SRC_APP, "packages", "annotation-integrate")
sys.path.insert(0, _EXT)

import align  # noqa: E402
from annotation_integrate import integrate, DEFAULT_NORMALIZE  # noqa: E402


# ─────────────────────────── the task's canonical case ────────────────────────

def _basic_case():
    # Axis index carries the 10x lane suffix (`-1`); the table is keyed by the bare
    # barcode — so a correct run MUST normalize (barcode_suffix) to match.
    axis = ["AAAC-1", "CCCG-1"]
    rows = [
        {"barcode": "AAAC", "cell_type": "T", "score": 1.5},
        {"barcode": "CCCG", "cell_type": "B", "score": 2.5},
    ]
    return axis, rows


def test_integrate_aligns_and_summarizes():
    axis, rows = _basic_case()
    out = integrate(axis, rows, axis_name="cells")

    # Key auto-detected as `barcode`; every axis entity matched after normalization.
    assert out["key_column"] == "barcode"
    assert out["axis"] == "cells"
    assert out["coverage"]["matched"] == 2
    assert out["coverage"]["missing"] == 0
    assert out["coverage"]["extra"] == 0
    # DEC-18 before/after: raw keys (`AAAC` vs `AAAC-1`) matched 0; normalize recovered 2.
    assert out["coverage"]["matched_before_normalize"] == 0

    cols = {c["name"]: c for c in out["columns"]}
    # The key column is NOT emitted; both value columns are, in AXIS order.
    assert set(cols) == {"cell_type", "score"}
    assert cols["cell_type"]["values"] == ["T", "B"]
    assert cols["score"]["values"] == [1.5, 2.5]


def test_categorical_summary_meta():
    axis, rows = _basic_case()
    out = integrate(axis, rows, axis_name="cells")
    summ = {c["name"]: c["summary"] for c in out["columns"]}["cell_type"]
    assert summ["kind"] == "categorical"
    assert set(summ["categories"]) == {"T", "B"}
    assert summ["n_categories"] == 2
    assert summ["high_cardinality"] is False
    assert summ["n"] == 2
    assert summ["n_missing"] == 0
    # The alignment coverage is folded into the per-column summary meta (DEC-25).
    assert summ["coverage"]["matched"] == 2


def test_continuous_summary_meta():
    axis, rows = _basic_case()
    out = integrate(axis, rows, axis_name="cells")
    summ = {c["name"]: c["summary"] for c in out["columns"]}["score"]
    assert summ["kind"] == "continuous"
    assert summ["min"] == 1.5
    assert summ["max"] == 2.5
    assert summ["mean"] == 2.0
    assert summ["n_missing"] == 0
    assert summ["coverage"]["matched"] == 2


def test_default_normalize_pipeline():
    # The module ships the DEC-18 default pipeline (barcode/ensembl/trim).
    assert DEFAULT_NORMALIZE == ["barcode_suffix", "ensembl_version", "trim"]


def test_missing_axis_entity_is_na_and_counted():
    axis = ["AAAC-1", "CCCG-1", "GGGG-1"]  # GGGG has no annotation row
    rows = [
        {"barcode": "AAAC", "cell_type": "T"},
        {"barcode": "CCCG", "cell_type": "B"},
    ]
    out = integrate(axis, rows, axis_name="cells")
    col = {c["name"]: c for c in out["columns"]}["cell_type"]
    assert col["values"] == ["T", "B", None]  # NA where the axis entity has no row
    assert out["coverage"]["matched"] == 2
    assert out["coverage"]["missing"] == 1
    # The categorical summary counts the NA and still lists only real categories.
    assert col["summary"]["n_missing"] == 1
    assert set(col["summary"]["categories"]) == {"T", "B"}


def test_explicit_key_column_override():
    axis, rows = _basic_case()
    out = integrate(axis, rows, axis_name="cells", key_column="barcode")
    assert out["key_column"] == "barcode"
    assert out["coverage"]["matched"] == 2


def test_genes_axis_ensembl_version_normalization():
    # A DIFFERENT axis (genes) proves the integrator is axis-agnostic: the axis carries
    # Ensembl version suffixes (`.3`/`.1`), the table is keyed by the bare id.
    axis = ["ENSG42.3", "ENSG7.1"]
    rows = [
        {"gene_id": "ENSG42", "biotype": "protein_coding"},
        {"gene_id": "ENSG7", "biotype": "lncRNA"},
    ]
    out = integrate(axis, rows, axis_name="genes")
    assert out["key_column"] == "gene_id"
    assert out["axis"] == "genes"
    assert out["coverage"]["matched"] == 2
    col = {c["name"]: c for c in out["columns"]}["biotype"]
    assert col["values"] == ["protein_coding", "lncRNA"]


def test_duplicate_key_is_hard_error():
    axis = ["AAAC-1", "CCCG-1"]
    rows = [
        {"barcode": "AAAC", "cell_type": "T"},
        {"barcode": "AAAC", "cell_type": "B"},  # duplicate supplied key → DEC-2 hard error
    ]
    with pytest.raises(align.AlignmentError):
        integrate(axis, rows, axis_name="cells", key_column="barcode")
