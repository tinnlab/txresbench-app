#!/usr/bin/env python3
"""ATAC (multiome) + spatial ingest acceptance tests (Slice 6) — INV-15, INV-16.

TEST-A15: a multiome (RNA+ATAC) fixture keeps the PEAK matrix + per-peak `var['interval']`
coords AND a recorded fragments-file (`.tsv.gz` + `.tbi`) path/linkage — with NO
gene-activity/TF-IDF/TSS/nucleosome materialized at ingest.
TEST-A16: a Visium/spatial fixture produces `obsm['spatial']` coords + tissue image + affine
ALIGNED, routing into the existing `imageUnderlay()` (no new viz kind).

Grounded in research/MULTIMODAL_atac_spatial_formats.md §1 (ATAC) / §2 (spatial). Pure-kernel
(numpy/anndata only) → RUNS.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sp = pytest.importorskip("scipy.sparse")
ad = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")

_COMPUTE = Path(__file__).resolve().parent.parent / "compute"
if str(_COMPUTE) not in sys.path:
    sys.path.insert(0, str(_COMPUTE))

import multimodal as mm  # noqa: E402


# ─────────────────────────── INV-15 — ATAC peak matrix + interval + fragments (TEST-A15) ──

def test_A15_multiome_split_keeps_atac_peaks():
    fts = ["Gene Expression", "Gene Expression", "Peaks", "Peaks", "Peaks"]
    names = ["GENE1", "GENE2", "chr1:100-200", "chr1:500-700", "chr2:10-90"]
    split = mm.split_by_feature_types(fts, names)
    assert set(split.modalities) == {"rna", "atac"}
    # ATAC peaks are their own modality (Peaks → atac), the primary ATAC ingest matrix (INV-15).
    assert list(split.columns["atac"]) == [2, 3, 4]
    assert split.feature_type["atac"] == "Peaks"


def test_A15_atac_var_interval_and_fragments_linkage():
    var = pd.DataFrame(
        {
            "interval": ["chr1:100-200", "chr1:500-700"],
            "gene_ids": ["p1", "p2"],
            "genome": ["GRCh38", "GRCh38"],
            "feature_types": ["Peaks", "Peaks"],
        },
        index=["chr1:100-200", "chr1:500-700"],
    )
    uns = {"atac": {"files": {"fragments": "/data/atac_fragments.tsv.gz"}, "peak_annotation": {}}}
    linkage = mm.extract_atac_linkage(var, uns)
    # peak coords preserved (var['interval']) + genome/gene_ids provenance.
    assert linkage["has_interval"] is True
    assert linkage["interval_example"] == "chr1:100-200"
    assert linkage["genome"] is True
    # the NON-DERIVABLE fragments file path is recorded/linked (INV-15) — TSS/nucleosome QC need it.
    assert linkage["fragments"]["fragments"].endswith("atac_fragments.tsv.gz")
    assert linkage["peak_annotation"] is True


def test_A15_no_downstream_derivatives_at_ingest():
    # The linkage carries ONLY the ingest primaries — no gene-activity / TF-IDF / TSS / nucleosome
    # keys are computed here (all downstream, all need the fragments file).
    var = pd.DataFrame({"interval": ["chr1:1-2"], "feature_types": ["Peaks"]}, index=["chr1:1-2"])
    linkage = mm.extract_atac_linkage(var, {})
    for forbidden in ("tss_enrichment", "nucleosome_signal", "gene_activity", "tfidf", "lsi"):
        assert forbidden not in linkage


# ─────────────────────────── INV-16 — spatial coords + image + affine (TEST-A16) ──────────

def test_A16_visium_affine_is_pure_scale():
    # The Visium scalefactor maps full-res coords → downscaled image pixels — a pure diagonal
    # scale, the single alignment source of truth (INV-16). 2×3 affine `[a,b,tx,c,d,ty]`.
    affine = mm.visium_affine(0.25)
    assert affine == [0.25, 0.0, 0.0, 0.0, 0.25, 0.0]


def test_A16_extract_spatial_trio_aligned():
    # A legacy Visium AnnData: obsm['spatial'] coords + uns['spatial'][lib]['images']['hires']
    # + scalefactors. extract_spatial yields the aligned trio routing into imageUnderlay().
    img = np.zeros((600, 800, 3), dtype=np.uint8)
    uns = {
        "spatial": {
            "libA": {
                "images": {"hires": img},
                "scalefactors": {"tissue_hires_scalef": 0.5, "spot_diameter_fullres": 89.0},
            }
        }
    }
    plan = mm.extract_spatial(uns, obsm_keys=["spatial", "X_umap"])
    assert plan is not None
    assert plan["library"] == "libA"
    assert plan["coords_key"] == "spatial"
    assert plan["image_key"] == "hires"
    # the affine is derived from the scalefactor (the alignment truth) — width/height from raster.
    assert plan["affine"] == [0.5, 0.0, 0.0, 0.0, 0.5, 0.0]
    assert plan["width"] == 800 and plan["height"] == 600
    assert plan["scale_factor"] == 0.5


def test_A16_coords_only_page_level_fallback():
    # coords present, no image/scalefactors → identity affine (page-level fallback), still routes.
    plan = mm.extract_spatial({}, obsm_keys=["spatial"])
    assert plan is not None
    assert plan["image_key"] is None
    assert plan["affine"] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def test_A16_no_spatial_returns_none():
    assert mm.extract_spatial({}, obsm_keys=["X_umap"]) is None
