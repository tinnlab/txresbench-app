#!/usr/bin/env python3
"""Barcode-mismatch HARD-FAIL + explicit override acceptance tests (Slice 6) — INV-13, DEC-26.

TEST-A13: a barcode-MISMATCH fixture (disjoint barcode formats across modalities) is REFUSED
at ingest by default — NOT silently unioned into a zero-overlap container (DEC-26 HARD-FAIL).
TEST-26: the EXPLICIT user override proceeds on the barcode INTERSECTION (never zero-fill,
never a spurious union); without the override the ingest stays refused.

Grounded in research/MULTIMODAL_representation.md §(c) "Detect and refuse silent barcode
mismatch" / §(d).6. Pure-kernel (numpy/anndata only) → RUNS, does not skip.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_COMPUTE = Path(__file__).resolve().parent.parent / "compute"
if str(_COMPUTE) not in sys.path:
    sys.path.insert(0, str(_COMPUTE))

import multimodal as mm  # noqa: E402


# ─────────────────────────── TEST-A13 — HARD-FAIL by default ──────────────────────────────

def test_A13_disjoint_barcode_formats_refused():
    # rna barcodes carry a `-1` suffix; prot does not — the classic FORMAT mismatch. The
    # INTERSECTION is EMPTY, so ingest REFUSES (never a spurious zero-overlap union).
    rna = ["AAAC-1", "AAAG-1", "AAAT-1"]
    prot = ["AAAC", "AAAG", "AAAT"]
    with pytest.raises(mm.BarcodeMismatchError) as ei:
        mm.align_barcodes({"rna": rna, "prot": prot})
    diag = ei.value.diagnostic
    assert diag["n_intersection"] == 0
    # the diagnostic surfaces the suffix drift so the biologist sees WHY.
    assert diag["suffix_drift"]["rna"] == ["1"]


def test_A13_disjoint_refused_even_with_override():
    # A zero-overlap join CANNOT be rescued by the override — that would fabricate a container.
    rna = ["sample_A_AAAC", "sample_A_AAAG"]
    prot = ["AAAC", "AAAG"]
    with pytest.raises(mm.BarcodeMismatchError):
        mm.align_barcodes({"rna": rna, "prot": prot}, allow_override=True)


def test_A13_partial_mismatch_refused_without_override():
    # Overlapping-but-not-identical sets (some cells only in one modality) — REFUSED by default
    # (DEC-26): a mismatch is surfaced, never a silent union.
    rna = ["c0", "c1", "c2", "c3"]
    prot = ["c1", "c2", "c3", "c4"]
    with pytest.raises(mm.BarcodeMismatchError) as ei:
        mm.align_barcodes({"rna": rna, "prot": prot})
    assert "override" in str(ei.value).lower()


# ─────────────────────────── TEST-26 — explicit override → intersection ────────────────────

def test_26_override_proceeds_on_intersection():
    rna = ["c0", "c1", "c2", "c3"]
    prot = ["c1", "c2", "c3", "c4"]
    align = mm.align_barcodes({"rna": rna, "prot": prot}, allow_override=True)
    assert align.mode == "intersection-override"
    # proceeds on the INTERSECTION — never zero-fill, never a spurious union.
    assert align.intersection == ["c1", "c2", "c3"]
    # the union is still recorded but is NOT the result axis under override.
    assert set(align.union) == {"c0", "c1", "c2", "c3", "c4"}
    # row_index maps intersection cells back to each modality's rows BY BARCODE.
    assert list(align.row_index["rna"]) == [1, 2, 3]
    assert list(align.row_index["prot"]) == [0, 1, 2]


def test_26_identical_sets_need_no_override():
    # Identical barcode sets (the normal CITE-seq / multiome case: cells paired) → no refusal,
    # the union IS the axis, no override needed.
    bc = ["c0", "c1", "c2"]
    align = mm.align_barcodes({"rna": bc, "prot": list(bc)})
    assert align.mode == "identical"
    assert align.union == bc
    assert list(align.present_mask["prot"]) == [True, True, True]
