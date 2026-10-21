#!/usr/bin/env python3
"""Multi-modal ingest CORRECTNESS acceptance tests (Slice 6) — INV-10/11/12/12b/14/17.

RESEARCH-CRITICAL: a subtly-wrong multi-modal ingest silently corrupts science, so these are
executable acceptance tests on real synthetic fixtures, grounded in research/MULTIMODAL_*.md.

They exercise the ingest CORRECTNESS kernels (`compute/multimodal.py`) that `h5ad_import.py`
composes — deliberately dependency-light (numpy/pandas/anndata only, NO mudata/tiledbsoma) so
they RUN rather than skip. A synthetic `.h5mu` is built with h5py + anndata's element IO and
read back through the SAME mudata-free reader the ingest uses.

Covers: TEST-A10 (gex_only=False lossless split), TEST-A11 (raw preserved / normalized
rejected), TEST-A12 (obs UNION not zero-fill; barcode not order), TEST-A12b (modality-prefix,
no clobber, nothing joint), TEST-A14 (isotype retained + flagged; HTO separate raw modality),
TEST-A17 (Seurat scale.data guard + var-uniqueness within not across).
"""
from __future__ import annotations

import numpy as np
import pytest

sp = pytest.importorskip("scipy.sparse")
ad = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_COMPUTE = _HERE.parent / "compute"
if str(_COMPUTE) not in sys.path:
    sys.path.insert(0, str(_COMPUTE))

import multimodal as mm  # noqa: E402


# ─────────────────────────────── synthetic fixtures ───────────────────────────────

def _combined_citeseq(n_cells=6):
    """A 10x CITE-seq combined feature-barcode AnnData: GEX + ADT (incl. isotype) + HTO rows,
    all in ONE matrix with a `feature_types` var column (the real 10x packing)."""
    barcodes = [f"AAAC{i}-1" for i in range(n_cells)]
    var_rows = [
        ("TP53", "Gene Expression"),
        ("CD3", "Antibody Capture"),
        ("CD19", "Antibody Capture"),
        ("IgG1_control", "Antibody Capture"),   # isotype control (INV-14)
        ("HTO_1", "Antibody Capture"),          # hashtag delivered as Antibody Capture (DEC-18)
        ("CMO301", "Multiplexing Capture"),     # 10x CMO hashing
    ]
    names = [r[0] for r in var_rows]
    fts = [r[1] for r in var_rows]
    rng = np.random.default_rng(0)
    X = sp.csr_matrix(rng.integers(0, 10, size=(n_cells, len(var_rows))).astype(np.float32))
    a = ad.AnnData(
        X=X,
        obs=pd.DataFrame(index=barcodes),
        var=pd.DataFrame({"feature_types": fts}, index=names),
    )
    return a


def _write_h5mu(path, mods: dict, mod_order=None):
    """Write a minimal `.h5mu` (per-modality `/mod/<name>` AnnData groups) with h5py + anndata
    element IO — NO mudata needed. Mirrors the real on-disk layout the reader parses."""
    import h5py
    from anndata.io import write_elem

    with h5py.File(path, "w") as f:
        f.attrs["encoding-type"] = "MuData"
        f.attrs["encoding-version"] = "0.1.0"
        grp = f.create_group("mod")
        order = mod_order or list(mods.keys())
        grp.attrs["mod-order"] = order
        for name in order:
            write_elem(grp, name, mods[name])


# ─────────────────────────── INV-10 — gex_only=False lossless split (TEST-A10) ────────────

def test_A10_feature_types_split_is_lossless():
    a = _combined_citeseq()
    split = mm.split_by_feature_types(
        a.var["feature_types"].tolist(), a.var_names.tolist(), split_hashtag_adt=True
    )
    # EVERY distinct feature type became its own modality; none dropped, none folded into RNA.
    assert set(split.modalities) == {"rna", "prot", "hto"}
    # ADT + HTO retained as first-class — NOT silently dropped (the gex_only=True trap).
    assert split.total_features() == a.n_vars  # lossless: every feature routed
    # HTO channel exists: the CMO row + the hashtag-named Antibody-Capture row (DEC-18).
    assert len(split.columns["hto"]) == 2
    # RNA is exactly the one GEX row.
    assert list(split.columns["rna"]) == [0]


def test_A10_unknown_feature_type_never_folded_into_rna():
    split = mm.split_by_feature_types(["Gene Expression", "CRISPR Guide Capture", "CUSTOM"])
    assert set(split.modalities) == {"rna", "crispr", "custom"}
    assert list(split.columns["rna"]) == [0]  # CRISPR/CUSTOM never collapsed into RNA


# ─────────────────────────── INV-11 — raw preserved / normalized rejected (TEST-A11) ─────

def test_A11_raw_integer_counts_preserved():
    a = _combined_citeseq()
    # Every modality's stored values are the raw integer counts (no normalization at ingest).
    assert mm.is_raw_counts(a.X.data)
    mm.assert_not_normalized("rna", a.X.data)  # does not raise


def test_A11_normalized_input_rejected():
    # A CLR/log-normalized ADT matrix (fractional, non-integer) must be REFUSED as raw (INV-11).
    normalized = np.array([0.31, 1.7, 2.15, 0.0], dtype=np.float32)
    assert not mm.is_raw_counts(normalized)
    with pytest.raises(ValueError, match="not RAW integer counts"):
        mm.assert_not_normalized("prot", normalized)


# ─────────────────────────── INV-12 — obs UNION, no zero-fill, by barcode (TEST-A12) ─────

def test_A12_obs_union_not_zero_fill_aligned_by_barcode():
    # rna has cells 0..3; prot has cells 2..5 — partial overlap. Union = 0..5.
    rna_bc = ["c0", "c1", "c2", "c3"]
    prot_bc = ["c2", "c3", "c4", "c5"]
    align = mm.align_barcodes({"rna": rna_bc, "prot": prot_bc}, allow_override=True)
    # override → intersection is the RESULT axis (never a spurious union, never zero-fill)…
    assert align.mode == "intersection-override"
    assert align.intersection == ["c2", "c3"]
    # …but the UNION is still recorded (the container obs domain).
    assert set(align.union) == {"c0", "c1", "c2", "c3", "c4", "c5"}
    # membership is by BARCODE identity, not row order: present_mask over the intersection axis.
    assert list(align.present_mask["rna"]) == [True, True]
    # row_index maps result cell → source row BY BARCODE (c2 is row 2 in rna, row 0 in prot).
    assert list(align.row_index["rna"]) == [2, 3]
    assert list(align.row_index["prot"]) == [0, 1]


def test_A12_absent_cell_has_no_row_not_zero():
    # A cell absent from a modality gets row_index == -1 (NO X row) — NOT a zero-filled row.
    # B8: assert a REACHABLE row_index == -1. The single-non-empty-modality branch aligns the
    # union to the sole modality's barcodes; the OTHER (empty) modality is absent for EVERY union
    # cell → its row_index is all -1 (no X row for any cell), the zero-fill-vs-no-row guarantee.
    align = mm.align_barcodes({"rna": ["c0", "c1", "c2"], "prot": []})
    assert align.union == ["c0", "c1", "c2"]
    assert list(align.row_index["prot"]) == [-1, -1, -1], "absent modality → -1 (no row), never 0-fill"
    assert list(align.present_mask["prot"]) == [False, False, False]
    # rna maps 1:1 by barcode (identity), not by fabricated position.
    assert list(align.row_index["rna"]) == [0, 1, 2]

    # A partial union (rna⊃prot) under override reduces to the intersection (never a spurious
    # union / zero-fill); the union is still recorded as the container obs domain.
    partial = mm.align_barcodes(
        {"rna": ["c0", "c1", "c2", "c3", "c4", "c5"], "prot": ["c2", "c3"]},
        allow_override=True,
    )
    assert partial.mode == "intersection-override"
    assert set(partial.union) == {"c0", "c1", "c2", "c3", "c4", "c5"}
    # Identical sets → the plain union path; every cell present in both (no absence).
    full = mm.align_barcodes({"rna": ["c0", "c1", "c2"], "prot": ["c0", "c1", "c2"]})
    assert full.mode == "identical"
    assert list(full.present_mask["prot"]) == [True, True, True]


# ─────────────────────── INV-12 / TEST-A12b — modality-prefix, no clobber, nothing joint ──

def test_A12b_modality_prefixed_columns_no_clobber():
    assert mm.modality_prefixed("total_counts", "rna") == "rna:total_counts"
    assert mm.modality_prefixed("total_counts", "prot") == "prot:total_counts"
    assert mm.modality_prefixed("total_counts", "atac") == "atac:total_counts"
    # The three do not collide in a shared obs.
    cols = {mm.modality_prefixed("total_counts", m) for m in ("rna", "prot", "atac")}
    assert len(cols) == 3
    # n_genes_by_counts likewise prefixed per modality.
    assert mm.modality_prefixed("n_genes_by_counts", "prot") == "prot:n_genes_by_counts"


# ─────────────────────── INV-14 — isotype retained + flagged; HTO separate raw modality ──

def test_A14_isotype_controls_detected_and_retained():
    names = ["CD3", "CD19", "IgG1_control", "IgG2a_control", "Mouse-IgG2b"]
    mask = mm.detect_isotype_controls(names)
    # isotype/IgG rows flagged (var['is_isotype_control']); the real ADT targets are not.
    assert list(mask) == [False, False, True, True, True]
    # Crucially they are RETAINED — the mask flags, it does NOT drop (INV-14).
    assert mask.sum() == 3 and len(mask) == len(names)


def test_A14_hto_is_own_raw_undemultiplexed_modality():
    a = _combined_citeseq()
    split = mm.split_by_feature_types(
        a.var["feature_types"].tolist(), a.var_names.tolist(), split_hashtag_adt=True
    )
    # HTO is a SEPARATE modality (not merged into prot), kept raw (integer) and undemuxed
    # (no sample assignment / droplet drop happens in the split — it's just column routing).
    assert "hto" in split.modalities
    hto_cols = split.columns["hto"]
    hto_vals = a.X[:, hto_cols].data
    assert mm.is_raw_counts(hto_vals)  # raw counts, not CLR'd / demuxed
    # the surface-protein `prot` modality retains its isotype control (INV-14, not moved to hto).
    prot_names = [a.var_names[i] for i in split.columns["prot"]]
    assert any("IgG" in n for n in prot_names)


# ─────────────────────── INV-17 — Seurat scale.data guard + var-uniqueness within ────────

def test_A17_scale_data_matrix_rejected_as_raw():
    # A Seurat `scale.data` export is z-scored: negative + non-integer → NOT raw counts (INV-17).
    scale_data = np.array([-1.23, 0.44, 2.01, -0.7], dtype=np.float32)
    assert not mm.is_raw_counts(scale_data)
    with pytest.raises(ValueError):
        mm.assert_not_normalized("rna", scale_data)


def test_A17_var_uniqueness_within_not_across_modalities():
    # RNA and ADT may legitimately reuse a name (CD3 gene vs CD3 protein) — uniqueness is
    # enforced WITHIN a modality, NOT across (INV-17). The split keeps them in distinct
    # measurements, so a cross-modality name reuse is fine.
    fts = ["Gene Expression", "Antibody Capture"]
    names = ["CD3", "CD3"]  # same name, different modality
    split = mm.split_by_feature_types(fts, names)
    assert list(split.columns["rna"]) == [0]
    assert list(split.columns["prot"]) == [1]
    # each modality has a UNIQUE var set of size 1 (no within-modality collision here).
    for m in split.modalities:
        assert len(set(names[i] for i in split.columns[m])) == len(split.columns[m])


# ─────────────────────── INV-9 — the mudata-free .h5mu reader enumerates modalities ──────

def test_h5mu_reader_enumerates_modalities_first_class(tmp_path):
    rng = np.random.default_rng(1)
    barcodes = ["c0", "c1", "c2"]
    rna = ad.AnnData(
        X=sp.csr_matrix(rng.integers(0, 5, (3, 4)).astype(np.float32)),
        obs=pd.DataFrame(index=barcodes),
        var=pd.DataFrame({"feature_types": ["Gene Expression"] * 4}, index=[f"g{i}" for i in range(4)]),
    )
    prot = ad.AnnData(
        X=sp.csr_matrix(rng.integers(0, 20, (3, 2)).astype(np.float32)),
        obs=pd.DataFrame(index=barcodes),
        var=pd.DataFrame({"feature_types": ["Antibody Capture"] * 2}, index=["CD3", "IgG1_control"]),
    )
    path = tmp_path / "cite.h5mu"
    _write_h5mu(str(path), {"rna": rna, "prot": prot})
    assert mm.is_h5mu(str(path))
    mods, order = mm.read_h5mu_modalities(str(path))
    # both modalities recovered first-class + named, NOT flattened into one matrix (INV-9).
    assert set(mods.keys()) == {"rna", "prot"}
    assert mods["rna"].n_vars == 4 and mods["prot"].n_vars == 2
    # each modality keeps its OWN var domain (a variable belongs uniquely to one modality).
    assert list(mods["prot"].var_names) == ["CD3", "IgG1_control"]
    # raw counts preserved per modality (INV-11).
    assert mm.is_raw_counts(mods["prot"].X.data)


def test_soma_write_plan_modality_to_measurement(tmp_path):
    # The faithful MuData→SOMA plan: modality→measurement, one shared obs UNION, RNA→'RNA'
    # (back-compat) but no modality privileged (INV-8). [research: MULTIMODAL_representation §(b)]
    align = mm.align_barcodes({"rna": ["c0", "c1"], "prot": ["c0", "c1"]})
    plan = mm.plan_soma_write(align, ["rna", "prot"])
    assert plan.measurements == ["RNA", "prot"]
    assert plan.modality_of == {"RNA": "rna", "prot": "prot"}
    assert plan.shared_obs == ["c0", "c1"]
    assert plan.raw_layer == "counts"
    # DEC-11: a synthetic ms['joint'] slot is reserved only when a joint embedding exists.
    plan_j = mm.plan_soma_write(align, ["rna", "prot"], has_joint=True)
    assert plan_j.joint_measurement == "joint" and "joint" in plan_j.measurements
