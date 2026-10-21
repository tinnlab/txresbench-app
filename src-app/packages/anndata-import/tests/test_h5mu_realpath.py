#!/usr/bin/env python3
"""REAL-PATH .h5mu ingest tests (declarative-processor-ui Phase 7) — the test-honesty fix.

The Slice-6 ingest acceptance tests (`test_multimodal_ingest.py`, `test_atac_spatial_ingest.py`)
are PURE-KERNEL only: they fabricate `var`/`uns`/`obsm` and call the `multimodal.py` kernels in
ISOLATION — they NEVER run `read_h5mu_to_combined` / `main()` / the sandbox-staged path. So they
FALSE-PASSED on exactly the HIGH/MED ingest findings (B2 fragments dropped, B4 spatial dropped, B5
cross-modality var rename) — the bug lived in the combine STAGING, which no test exercised.

These tests drive the REAL `h5ad_import.read_h5mu_to_combined()` end-to-end over a synthetic
`.h5mu`, then read the staged combined `.h5ad` BACK and assert the FIXED behavior — i.e. exactly
what `main()` reads off the staged file. Dependency-light (anndata/pandas/scipy/h5py — NO
mudata/tiledbsoma/scanpy) so they RUN, not skip. A full bwrap+rootfs `main()` run is Phase-8 (the
staging-list is asserted in Rust: `sandbox::processors::h5ad_import_sibling_imports_are_all_staged`).

Covers: B2 (INV-15 ATAC fragments linkage preserved through the combine), B4 (INV-16 spatial
obsm+uns preserved), B5 (INV-17 a feature name reused ACROSS modalities is NOT renamed to `-1`).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sp = pytest.importorskip("scipy.sparse")
ad = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")
pytest.importorskip("h5py")

# Put BOTH the anndata-import compute dir (multimodal.py) AND the shared scripts dir (colsummary.py,
# imported at h5ad_import module scope) on sys.path — mirrors the sandbox `/code` staging where both
# siblings sit next to the entry (PY_HELPERS). Without colsummary the module import would fail.
_HERE = Path(__file__).resolve()
_COMPUTE = _HERE.parent.parent / "compute"
_SCRIPTS = _HERE.parents[3] / "server/src/modules/sandbox/processors/scripts"
for _p in (str(_COMPUTE), str(_SCRIPTS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

hi = pytest.importorskip("h5ad_import")
import multimodal as mm  # noqa: E402


def _anndata(barcodes, names, fts, *, uns=None, obsm=None, hi_counts=10):
    rng = np.random.default_rng(abs(hash(tuple(names))) % (2**32))
    X = sp.csr_matrix(rng.integers(0, hi_counts, size=(len(barcodes), len(names))).astype(np.float32))
    a = ad.AnnData(
        X=X,
        obs=pd.DataFrame(index=[str(b) for b in barcodes]),
        var=pd.DataFrame({"feature_types": fts}, index=names),
    )
    if uns:
        a.uns.update(uns)
    if obsm:
        for k, v in obsm.items():
            a.obsm[k] = v
    return a


def _write_h5mu(path, mods, order):
    import h5py
    from anndata.io import write_elem

    with h5py.File(path, "w") as f:
        f.attrs["encoding-type"] = "MuData"
        f.attrs["encoding-version"] = "0.1.0"
        grp = f.create_group("mod")
        grp.attrs["mod-order"] = order
        for name in order:
            write_elem(grp, name, mods[name])


def _build_multiome_spatial_h5mu(tmp_path):
    """A CITE-seq + ATAC + spatial `.h5mu`: IDENTICAL barcodes (so the guard passes on the union),
    a feature name (`CD3`) reused across RNA and ADT, an ATAC peak modality carrying the fragments
    linkage in `uns['atac']['files']`, and Visium spatial coords+uns on the RNA modality."""
    barcodes = ["c0", "c1", "c2"]
    rna = _anndata(
        barcodes, ["CD3", "CD8A"], ["Gene Expression", "Gene Expression"],
        obsm={"spatial": np.array([[10.0, 20.0], [30.0, 40.0], [50.0, 60.0]], dtype=float)},
        uns={"spatial": {"libA": {"images": {"hires": np.zeros((4, 4, 3), dtype=np.uint8)},
                                  "scalefactors": {"tissue_hires_scalef": 0.5}}}},
    )
    prot = _anndata(barcodes, ["CD3", "IgG1_control"], ["Antibody Capture", "Antibody Capture"], hi_counts=20)
    atac = ad.AnnData(
        X=sp.csr_matrix(np.array([[1, 0], [0, 2], [3, 1]], dtype=np.float32)),
        obs=pd.DataFrame(index=barcodes),
        var=pd.DataFrame(
            {"feature_types": ["Peaks", "Peaks"], "interval": ["chr1:100-200", "chr2:10-90"],
             "genome": ["GRCh38", "GRCh38"]},
            index=["chr1:100-200", "chr2:10-90"],
        ),
    )
    atac.uns["atac"] = {"files": {"fragments": "/data/atac_fragments.tsv.gz"}, "peak_annotation": {}}
    path = tmp_path / "multiome_spatial.h5mu"
    _write_h5mu(str(path), {"rna": rna, "prot": prot, "atac": atac}, ["rna", "prot", "atac"])
    return path


def _stage_combined(tmp_path):
    src = _build_multiome_spatial_h5mu(tmp_path)
    out = tmp_path / "outputs"
    out.mkdir()
    staged, fmt, _tmp, meta = hi.read_h5mu_to_combined(src, ad, out, {})
    assert fmt == "h5mu"
    return ad.read_h5ad(staged), meta


# ─────────────────────────── B5 — no cross-modality var rename (INV-17) ────────────────────────

def test_realpath_var_name_reused_across_modalities_not_renamed():
    combined, _ = _stage_combined(_tmp_dir())
    # 'CD3' appears in BOTH the RNA and the ADT modality. The SERVED label (`feature_name`, what
    # main()'s genes_index emits) must keep 'CD3' for BOTH — never cross-renamed to 'CD3-1' (the B5
    # mislabel). The combined var_names INDEX may be storage-disambiguated (CD3/CD3-1) — that is a
    # storage key, never surfaced as the modality's label.
    assert "feature_name" in combined.var.columns
    served = list(combined.var["feature_name"])
    assert served.count("CD3") == 2, f"served label cross-renamed (B5 regression): {served}"
    # The two CD3 features belong to DISTINCT modalities (rna gene vs prot antibody) — INV-17.
    cd3_mods = sorted(combined.var.loc[combined.var["feature_name"] == "CD3", "modality"].tolist())
    assert cd3_mods == ["prot", "rna"]
    # Each modality's SERVED labels are internally unique (INV-17 within-modality uniqueness).
    for mod in ("rna", "prot", "atac"):
        sub = combined.var.loc[combined.var["modality"] == mod, "feature_name"].tolist()
        assert len(set(sub)) == len(sub), f"within-modality dup label in {mod}: {sub}"


# ─────────────────────────── B2 — ATAC fragments linkage preserved (INV-15) ────────────────────

def test_realpath_atac_fragments_linkage_survives_the_combine():
    combined, _ = _stage_combined(_tmp_dir())
    # The non-derivable fragments-file path (from mods['atac'].uns['atac']['files']) MUST survive
    # into the combined uns — main() reads exactly this off the staged h5ad. (B2 false-pass fix:
    # the old kernel test fabricated uns and never ran the combine.)
    assert isinstance(combined.uns.get("atac"), (dict,)) or hasattr(combined.uns.get("atac"), "get")
    linkage = mm.extract_atac_linkage(combined.var[combined.var["modality"] == "atac"], combined.uns)
    assert linkage["fragments"]["fragments"].endswith("atac_fragments.tsv.gz")
    assert linkage["has_interval"] is True  # var['interval'] peak coords preserved too


# ─────────────────────────── B4 — spatial coords/image preserved (INV-16) ──────────────────────

def test_realpath_spatial_obsm_and_uns_survive_the_combine():
    combined, _ = _stage_combined(_tmp_dir())
    # obsm['spatial'] coords + uns['spatial'] must both survive so main()'s extract_spatial finds
    # them (B4 false-pass fix: the old test called extract_spatial on a fabricated dict).
    assert "spatial" in combined.obsm
    assert combined.obsm["spatial"].shape == (3, 2)
    plan = mm.extract_spatial(combined.uns, list(combined.obsm.keys()))
    assert plan is not None
    assert plan["coords_key"] == "spatial"
    assert plan["affine"] == [0.5, 0.0, 0.0, 0.0, 0.5, 0.0]


# A fresh tmp dir per test (pytest tmp_path is function-scoped; this keeps each build isolated).
def _tmp_dir():
    import tempfile

    return Path(tempfile.mkdtemp(prefix="h5mu_realpath_"))
