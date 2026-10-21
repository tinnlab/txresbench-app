#!/usr/bin/env python3
# ruff: noqa
"""multimodal — multi-modal single-cell ingest CORRECTNESS kernels (Slice 6, INV-10..17).

This is a RESEARCH app: a subtly-wrong multi-modal ingest SILENTLY corrupts downstream
science (no error, wrong result), so every rule here is a PURE, independently-testable
function grounded in — and CITED to — the three governing research findings docs:

  * research/MULTIMODAL_representation.md   — MuData object model + faithful MuData→SOMA
    mapping (modality→measurement, global obs → shared experiment obs UNION, raw→a
    dedicated X layer, per-measurement var domain; obs-UNION-not-zero-fill; barcode
    alignment by obs_names; what is LOST on the mapping).
  * research/MULTIMODAL_cite_protein.md     — CITE-seq / ADT / HTO ingest (`gex_only=False`
    lossless split, preserve RAW ADT counts, PRESERVE isotype controls, HTO a separate raw
    undemultiplexed modality).
  * research/MULTIMODAL_atac_spatial_formats.md — Multiome (peak matrix + var['interval'] +
    the non-derivable fragments file), spatial (coords + image + affine), Seurat highest-loss.
  * research/MULTIMODAL_qc_metrics.md        — per-modality obs, modality-prefixed columns.

These kernels are deliberately dependency-light (numpy / pandas / scipy only — NO mudata /
tiledbsoma / scanpy) so their acceptance tests RUN in any scientific-python env, not skip.
``h5ad_import.py`` composes them; the MuData→SOMA WRITE (which genuinely needs tiledbsoma) is
the one part these kernels only DESCRIBE (they compute the mapping plan; the writer applies it).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np


# ─────────────────────────── .h5mu / MuData reading (INV-9) ────────────────────────────
# `.h5mu` mirrors `.h5ad`: modalities live under the `/mod/<name>` group, each stored EXACTLY
# as a standalone `.h5ad`; the container additionally holds global `/obs` + `/var`. A modality
# is independently readable. We read WITHOUT the `mudata` package (often absent) by reading the
# per-modality `/mod/<name>` groups directly via `anndata.io.read_elem` — so the reader degrades
# gracefully and the ingest is not hard-coupled to mudata. Do NOT flatten to one matrix (INV-9).
# [cite: MULTIMODAL_atac_spatial_formats.md §3.2; MULTIMODAL_representation.md §(a) on-disk format]

def is_h5mu(path: str) -> bool:
    """True iff `path` is a MuData `.h5mu` container (by extension OR an HDF5 root with a top-
    level `/mod` group + `encoding-type == 'MuData'`)."""
    name = os.fspath(path).lower()
    if name.endswith(".h5mu"):
        return True
    if not (name.endswith(".h5") or name.endswith(".hdf5")):
        return False
    try:
        import h5py

        with h5py.File(path, "r") as f:
            enc = f.attrs.get("encoding-type")
            enc = enc.decode() if isinstance(enc, bytes) else enc
            return "mod" in f and (enc in (None, "MuData") or "mod" in f)
    except Exception:
        return False


def read_h5mu_modalities(path: str):
    """Read a `.h5mu` into `{modality_name: AnnData}` WITHOUT requiring the `mudata` package.

    Prefers `mudata.read_h5mu` when installed (canonical); else reads each `/mod/<name>` group
    via `anndata.io.read_elem` (the modality is serialized exactly as a standalone `.h5ad`,
    honoring the `mod-order` attribute for true modality order). Modalities stay FIRST-CLASS +
    NAMED; the container is NOT flattened (INV-9). Returns `(mods_dict, mod_order)`."""
    try:
        import mudata  # canonical path when available

        mdata = mudata.read_h5mu(path)
        order = list(getattr(mdata, "mod", {}).keys())
        return {k: mdata.mod[k] for k in order}, order
    except Exception:
        pass
    import h5py
    from anndata.io import read_elem

    mods: Dict[str, object] = {}
    with h5py.File(path, "r") as f:
        if "mod" not in f:
            raise RuntimeError(f"{path}: not a MuData container (no /mod group)")
        grp = f["mod"]
        order_attr = grp.attrs.get("mod-order")
        if order_attr is not None:
            names = [x.decode() if isinstance(x, bytes) else str(x) for x in list(order_attr)]
            names = [n for n in names if n in grp]
        else:
            names = sorted(grp.keys())
        for name in names:
            mods[name] = read_elem(grp[name])
    return mods, list(mods.keys())


# ─────────────────────────── modality classification (INV-10) ──────────────────────────
# 10x packs every feature type into ONE combined feature-barcode matrix; the correct,
# lossless split reads ALL feature types (`gex_only=False`) and partitions by
# `var['feature_types']` — every DISTINCT value becomes its own modality, none collapsed
# into RNA, none discarded. [cite: MULTIMODAL_cite_protein.md §1.2/§6.1-2;
# MULTIMODAL_atac_spatial_formats.md §1.1/§3.1]

# Canonical internal modality keys (DEC-17: protein = `prot`, muon's convention). The RAW
# 10x feature_types STRING is preserved as provenance separately (INV-17), never discarded.
FEATURE_TYPE_TO_MODALITY: Dict[str, str] = {
    "Gene Expression": "rna",
    "Antibody Capture": "prot",       # surface-protein ADT (DEC-17 canonical key `prot`)
    "Multiplexing Capture": "hto",    # 10x CMO / cell-multiplexing = hashing (INV-14)
    "Peaks": "atac",                  # 10x ARC multiome ATAC peak matrix (INV-15)
    "CRISPR Guide Capture": "crispr",
    "CUSTOM": "custom",
}

# DEC-18 [owner-confirm] default hashtag-name patterns. HTO can arrive as `Antibody Capture`
# features mixed with surface-protein ADTs (BioLegend TotalSeq hashtags in a plain `count`
# run), NOT only as `Multiplexing Capture`. Ingest CANNOT assume the feature-type
# (MULTIMODAL_cite_protein.md §7 "HTO delivery varies"), so a NAME heuristic optionally
# partitions hashtag ADTs into the `hto` modality, with a user override.  These patterns
# remain owner-confirmable (a deployment may supply its own list).
DEFAULT_HASHTAG_PATTERNS: Tuple[str, ...] = (r"^HTO", r"^Hashtag", r"_HTO", r"TotalSeq.*hashtag")

# DEC-14 / MULTIMODAL_cite_protein.md §2.2/§6.5: isotype/control antibodies (IgG / isotype /
# control) are NOT junk — DSB normalization REQUIRES them and QC flags outliers BY them.
# Detection is name-heuristic (surfaced, never silently trusted — §7 Open questions).
DEFAULT_ISOTYPE_PATTERNS: Tuple[str, ...] = (r"[Ii]sotype", r"[Cc]ontrol", r"IgG")


def normalize_modality_key(name: str) -> str:
    """Sanitize an arbitrary modality/measurement name to a stable key (INV-8: no modality
    privileged; the key is just an address). Preserves case-folded alnum + `_`."""
    key = re.sub(r"[^0-9A-Za-z_]+", "_", str(name)).strip("_").lower()
    return key or "modality"


def classify_feature_type(feature_type: str) -> str:
    """Map a single 10x `feature_types` STRING → canonical modality key (INV-10). An
    unrecognized feature type maps to a sanitized modality of its own — NEVER dropped, NEVER
    folded into RNA (the silent-loss trap). [cite: MULTIMODAL_cite_protein.md §1.2]"""
    ft = str(feature_type).strip()
    if ft in FEATURE_TYPE_TO_MODALITY:
        return FEATURE_TYPE_TO_MODALITY[ft]
    return normalize_modality_key(ft)


def is_hashtag_name(name: str, patterns: Sequence[str] = DEFAULT_HASHTAG_PATTERNS) -> bool:
    """DEC-18 name heuristic: does an ADT feature name look like a hashtag (HTO)?"""
    s = str(name)
    return any(re.search(p, s) for p in patterns)


def detect_isotype_controls(
    var_names: Sequence[str], patterns: Sequence[str] = DEFAULT_ISOTYPE_PATTERNS
) -> np.ndarray:
    """Boolean mask over ADT feature names flagging isotype/control antibodies (INV-14). Used
    to TAG (`var['is_isotype_control']`) — never to filter. [cite: MULTIMODAL_cite_protein.md
    §2.2/§6.5; MULTIMODAL_qc_metrics.md §2]"""
    names = [str(x) for x in var_names]
    return np.array([any(re.search(p, n) for p in patterns) for n in names], dtype=bool)


@dataclass
class ModalitySplit:
    """The lossless `feature_types` split (INV-10). `columns[modality]` = the integer var
    indices belonging to that modality (into the ORIGINAL combined matrix); `feature_type`
    records the raw 10x provenance string per modality (INV-17)."""
    columns: Dict[str, np.ndarray]
    feature_type: Dict[str, str] = field(default_factory=dict)

    @property
    def modalities(self) -> List[str]:
        return sorted(self.columns.keys())

    def total_features(self) -> int:
        return int(sum(len(c) for c in self.columns.values()))


def split_by_feature_types(
    feature_types: Sequence[str],
    var_names: Optional[Sequence[str]] = None,
    hashtag_patterns: Sequence[str] = DEFAULT_HASHTAG_PATTERNS,
    split_hashtag_adt: bool = False,
) -> ModalitySplit:
    """LOSSLESS split of a combined feature-barcode matrix into modality→col-indices (INV-10).

    EVERY distinct `feature_types` value becomes its own modality; NONE collapsed into RNA,
    NONE discarded (this is the `gex_only=False` contract — we split ALL rows). When
    `split_hashtag_adt` (DEC-18), `Antibody Capture` features whose NAME matches a hashtag
    pattern are re-routed to the `hto` modality (kept raw, undemultiplexed — INV-14).
    [cite: MULTIMODAL_cite_protein.md §1.2/§6.1-2; MULTIMODAL_atac_spatial_formats.md §3.1]"""
    fts = [str(x) for x in feature_types]
    n = len(fts)
    names = [str(x) for x in (var_names if var_names is not None else range(n))]
    buckets: Dict[str, List[int]] = {}
    provenance: Dict[str, str] = {}
    for i, ft in enumerate(fts):
        mod = classify_feature_type(ft)
        # DEC-18: optionally peel hashtag-named ADTs out of `prot` into `hto`.
        if split_hashtag_adt and mod == "prot" and is_hashtag_name(names[i], hashtag_patterns):
            mod = "hto"
            prov = "Antibody Capture (hashtag)"
        else:
            prov = ft
        buckets.setdefault(mod, []).append(i)
        provenance.setdefault(mod, prov)
    columns = {m: np.asarray(idx, dtype=np.int64) for m, idx in buckets.items()}
    return ModalitySplit(columns=columns, feature_type=provenance)


# ─────────────────────── barcode alignment: UNION + hard-fail (INV-12/13) ──────────────────
# MuData aligns modalities BY `.obs_names` (barcode string identity), NEVER by row order. The
# container obs is the UNION of all cells; a cell absent from a modality has NO X rows there
# (sparse) — it is NOT zero-filled (zero-fill FABRICATES data).  A non-identical barcode SET
# across modalities is almost always a barcode-FORMAT mismatch (a `-1` suffix / `sample_`
# prefix), NOT biology → REFUSE by default (DEC-26 HARD-FAIL); an explicit user override
# proceeds on the INTERSECTION. [cite: MULTIMODAL_representation.md §(a)/§(c)/§(d).6]

class BarcodeMismatchError(RuntimeError):
    """Raised when modalities have non-identical barcode sets and no override was given
    (INV-13 / DEC-26 HARD-FAIL). Carries the disjoint-format diagnostic."""

    def __init__(self, message: str, diagnostic: dict):
        super().__init__(message)
        self.diagnostic = diagnostic


@dataclass
class BarcodeAlignment:
    """The resolved shared cells axis (INV-12). `union` is the ordered global obs_names; a
    modality's `present_mask[mod]` is a boolean over `union` = which global cell exists in that
    modality (SOMA carries membership only implicitly = which obs joinids have X rows). NO
    zero-fill: an absent cell simply has no row in that modality's matrix. `mode` ∈
    {identical, union, intersection-override}."""
    union: List[str]
    intersection: List[str]
    present_mask: Dict[str, np.ndarray]
    mode: str
    row_index: Dict[str, np.ndarray] = field(default_factory=dict)

    @property
    def n_union(self) -> int:
        return len(self.union)


def _ordered_union(seqs: Sequence[Sequence[str]]) -> List[str]:
    seen: Dict[str, None] = {}
    for s in seqs:
        for b in s:
            if b not in seen:
                seen[b] = None
    return list(seen.keys())


def align_barcodes(
    modality_barcodes: Dict[str, Sequence[str]],
    allow_override: bool = False,
    min_overlap_frac: float = 0.01,
) -> BarcodeAlignment:
    """Align modalities by obs_names (INV-12) and enforce the barcode guard (INV-13/DEC-26).

    - Identical barcode SETS across modalities → `mode='identical'`, union == each set.
    - Non-identical but overlapping → DEFAULT: REFUSE (raise ``BarcodeMismatchError``). This
      is the CITE-seq/multiome expectation that cells are paired; a mismatch is a format bug.
    - `allow_override=True` → proceed on the INTERSECTION (`mode='intersection-override'`),
      never a spurious union, never zero-fill.
    - The empty-intersection case (disjoint formats — a `-1`/`sample_` mismatch) is ALWAYS
      refused (even the override can't rescue a zero-overlap join; that would be fabricated).

    `present_mask[mod]` is over the RESULT axis (union for identical, intersection for
    override). `row_index[mod][j]` = the row in modality `mod` for result cell `j` (or -1 if
    absent) — the alignment map the SOMA/CSC write uses to place rows by BARCODE, not order.
    [cite: MULTIMODAL_representation.md §(c) "Obs / barcode alignment"; §(d).6]"""
    mods = sorted(modality_barcodes.keys())
    bc_lists = {m: [str(x) for x in modality_barcodes[m]] for m in mods}
    bc_sets = {m: set(v) for m, v in bc_lists.items()}
    non_empty = [m for m in mods if len(bc_sets[m]) > 0]
    if len(non_empty) <= 1:
        # single modality (or all-but-one empty) — the sole modality's barcodes are the axis.
        base = non_empty[0] if non_empty else (mods[0] if mods else None)
        union = bc_lists[base] if base is not None else []
        pos = {b: i for i, b in enumerate(union)}
        return BarcodeAlignment(
            union=list(union), intersection=list(union),
            present_mask={m: np.array([b in bc_sets[m] for b in union], dtype=bool) for m in mods},
            mode="identical",
            row_index={m: np.array([{bb: i for i, bb in enumerate(bc_lists[m])}.get(b, -1) for b in union], dtype=np.int64) for m in mods},
        )

    union = _ordered_union([bc_lists[m] for m in non_empty])
    inter_set = set.intersection(*[bc_sets[m] for m in non_empty])
    intersection = [b for b in union if b in inter_set]

    identical = all(bc_sets[m] == bc_sets[non_empty[0]] for m in non_empty)

    # Empty (or implausibly tiny) intersection while each modality is non-empty ⇒ a
    # barcode-FORMAT mismatch (INV-13). ALWAYS refused — an override can't join disjoint sets.
    max_mod = max(len(bc_sets[m]) for m in non_empty)
    if len(intersection) == 0 or (len(intersection) / max(1, max_mod)) < min_overlap_frac:
        diag = _mismatch_diagnostic(bc_lists, intersection)
        raise BarcodeMismatchError(
            "barcode mismatch across modalities: the obs_names intersection is empty/implausibly "
            "small while each modality is non-empty — almost always a barcode-FORMAT mismatch "
            f"(e.g. a '-1' suffix or 'sample_' prefix), not biology. Diagnostic: {diag}",
            diag,
        )

    if identical:
        axis = list(union)
        mode = "identical"
    elif allow_override:
        axis = list(intersection)          # opt-in intersect (never zero-fill / spurious union)
        mode = "intersection-override"
    else:
        diag = _mismatch_diagnostic(bc_lists, intersection)
        raise BarcodeMismatchError(
            "non-identical barcode sets across modalities — REFUSED by default (DEC-26 hard-fail). "
            "Set the explicit override to proceed on the barcode INTERSECTION "
            f"({len(intersection)} shared cells). Diagnostic: {diag}",
            diag,
        )

    pos_by_mod = {m: {b: i for i, b in enumerate(bc_lists[m])} for m in mods}
    return BarcodeAlignment(
        union=list(union),
        intersection=list(intersection),
        present_mask={m: np.array([b in bc_sets[m] for b in axis], dtype=bool) for m in mods},
        mode=mode,
        row_index={m: np.array([pos_by_mod[m].get(b, -1) for b in axis], dtype=np.int64) for m in mods},
    )


def _mismatch_diagnostic(bc_lists: Dict[str, List[str]], intersection: List[str]) -> dict:
    """Surface WHY barcodes disagree — sample values + detected suffix/prefix drift."""
    sample = {m: v[:3] for m, v in bc_lists.items()}
    suffixes = {m: sorted({b.split("-")[-1] for b in v[:200] if "-" in b})[:5] for m, v in bc_lists.items()}
    return {
        "n_intersection": len(intersection),
        "per_modality_n": {m: len(v) for m, v in bc_lists.items()},
        "sample_barcodes": sample,
        "suffix_drift": suffixes,
    }


# ─────────────────────── modality-prefixed obs columns (INV-12 / TEST-A12b) ────────────────
# Every modality independently produces columns named `total_counts` / `n_genes_by_counts`, so
# any metric written into a SHARED obs MUST be `modality:`-prefixed or the modalities clobber
# each other; the write is always PER-MODALITY (no joint metric). [cite: MULTIMODAL_qc_metrics.md
# §4; MULTIMODAL_representation.md §(a)]

def modality_prefixed(column: str, modality: str) -> str:
    """`(total_counts, rna)` → `rna:total_counts` (the muon `modality:column` convention)."""
    return f"{normalize_modality_key(modality)}:{column}"


# ─────────────────────────── raw-counts verification (INV-11 / INV-17) ─────────────────────
# PRESERVE RAW counts per modality — never normalize/log/CLR/scale at ingest (all downstream,
# all consume raw). On Seurat conversion VERIFY the exported X is RAW COUNTS not `scale.data`
# (which is negative-valued / non-integer). [cite: MULTIMODAL_cite_protein.md §2.1/§5/§6.3-4;
# MULTIMODAL_atac_spatial_formats.md §3.3.1]

def is_raw_counts(values: np.ndarray) -> bool:
    """True iff a stored-value sample is a genuine RAW count matrix: all finite ≥0 AND integral.
    A `scale.data`-derived matrix (negative, non-integer) FAILS — the INV-17 Seurat guard."""
    d = np.asarray(values, dtype=float).ravel()
    fin = d[np.isfinite(d)]
    if fin.size == 0:
        return False
    if float(fin.min()) < 0.0:
        return False
    return bool(np.allclose(fin, np.round(fin)))


def assert_not_normalized(modality: str, values: np.ndarray) -> None:
    """INV-11 guard: reject a modality whose stored matrix is NOT raw counts (a normalized /
    scaled / CLR'd input written into the canonical raw store is a corruption)."""
    if not is_raw_counts(values):
        raise ValueError(
            f"modality '{modality}': stored matrix is not RAW integer counts (min<0 or non-integral) "
            "— refusing to ingest a normalized/scaled matrix as raw (INV-11). Supply raw counts."
        )


# ───────────────────────────── ATAC peak + fragments (INV-15) ──────────────────────────────
# ATAC ingest primary = the PEAK matrix + per-peak `var['interval']` coords; the FRAGMENTS
# file (`atac_fragments.tsv.gz` + `.tbi`) is NOT derivable from the peak matrix and MUST be
# kept + path-linked (muon: `atac.uns['atac']['files']`). TSS/nucleosome QC DEPEND on it.
# [cite: MULTIMODAL_atac_spatial_formats.md §0.1-2/§1.2-3/§1.6; MULTIMODAL_qc_metrics.md §3]

def extract_atac_linkage(var_df, uns: dict) -> dict:
    """Harvest the ATAC ingest-primary fidelity contract from a peak modality's var + uns:
    the per-peak `interval` coords + the fragments-file path linkage. Returns a dict recorded
    on the modality output's `meta` — NEVER derives gene-activity/TF-IDF/TSS (all downstream)."""
    out: dict = {"has_interval": False, "fragments": None, "peak_annotation": False}
    try:
        cols = set(getattr(var_df, "columns", []))
    except Exception:
        cols = set()
    if "interval" in cols:
        out["has_interval"] = True
        try:
            out["interval_example"] = str(var_df["interval"].iloc[0])
        except Exception:
            pass
    for c in ("gene_ids", "genome", "feature_types"):
        if c in cols:
            out[c] = True
    atac_uns = (uns or {}).get("atac") if hasattr(uns, "get") else None
    if isinstance(atac_uns, dict):
        files = atac_uns.get("files")
        if files:
            out["fragments"] = files if isinstance(files, (list, dict)) else str(files)
        if "peak_annotation" in atac_uns:
            out["peak_annotation"] = True
    return out


# ─────────────────────────────── spatial coords/image/affine (INV-16) ──────────────────────
# Spatial ingest keeps THREE things aligned — `obsm['spatial']` coords + the tissue image
# raster + the affine/scale mapping coords↔image pixels (the single alignment source of truth).
# This maps onto the app's EXISTING `image` view-kind + `ImageUnderlay` (raster + 2×3 affine),
# NO new viz API. The Visium `scalefactors` (a pure scale) or a SpatialData element transform
# is the affine source. [cite: MULTIMODAL_atac_spatial_formats.md §2.2-3/§4; VIZ_REQUIREMENTS.md §4g]

def visium_affine(scale_factor: float) -> List[float]:
    """The 2×3 affine `[a,b,tx,c,d,ty]` mapping full-res spot coords → downscaled image pixels
    for a Visium `scalefactors` (a pure diagonal SCALE, no rotation/translation). The
    `ImageUnderlay` contract is `[a,b,tx,c,d,ty]` (row-major 2×3). [cite:
    MULTIMODAL_atac_spatial_formats.md §2.2; VIZ_REQUIREMENTS.md §4g]"""
    s = float(scale_factor)
    return [s, 0.0, 0.0, 0.0, s, 0.0]


def extract_spatial(uns: dict, obsm_keys: Sequence[str], prefer: str = "hires") -> Optional[dict]:
    """Extract the aligned spatial trio from a legacy-AnnData/Visium `uns['spatial']` +
    `obsm['spatial']`, or return None when absent. Returns
    `{library, coords_key, image_key, width, height, affine, scale_factor}` — the affine is the
    SINGLE alignment source of truth (INV-16). Does NOT load the raster bytes here (the ingest
    writer materializes the image output); this computes the ALIGNMENT plan the resolver reads.
    [cite: MULTIMODAL_atac_spatial_formats.md §2.2-3]"""
    if "spatial" not in list(obsm_keys):
        return None
    spatial_uns = uns.get("spatial") if hasattr(uns, "get") else None
    if not isinstance(spatial_uns, dict) or not spatial_uns:
        # coords present but no image/scalefactors — page-level fallback (coords only).
        return {"library": None, "coords_key": "spatial", "image_key": None,
                "affine": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0], "scale_factor": 1.0}
    library = next(iter(spatial_uns.keys()))
    lib = spatial_uns[library] or {}
    images = lib.get("images", {}) if isinstance(lib, dict) else {}
    scalefactors = lib.get("scalefactors", {}) if isinstance(lib, dict) else {}
    image_key = prefer if prefer in images else (next(iter(images.keys())) if images else None)
    sf_key = f"tissue_{image_key}_scalef" if image_key else None
    scale_factor = float(scalefactors.get(sf_key, 1.0)) if sf_key else 1.0
    width = height = None
    if image_key is not None and image_key in images:
        img = np.asarray(images[image_key])
        if img.ndim >= 2:
            height, width = int(img.shape[0]), int(img.shape[1])
    return {
        "library": str(library),
        "coords_key": "spatial",
        "image_key": image_key,
        "width": width,
        "height": height,
        "affine": visium_affine(scale_factor),
        "scale_factor": scale_factor,
        "spot_diameter_fullres": scalefactors.get("spot_diameter_fullres"),
    }


# ───────────────────────── modality → datatype / SOMA measurement mapping ───────────────────
# The faithful MuData→SOMA mapping: modality → measurement; RNA is NOT privileged (INV-8). The
# per-modality datatype ids MIRROR the backend `datatype/builtin.rs` seeds (ITEM-18).
# [cite: MULTIMODAL_representation.md §(b) mapping table]

MODALITY_DATATYPE: Dict[str, str] = {
    "rna": "single-cell/expression",
    "prot": "single-cell/protein",
    "adt": "single-cell/protein",
    "atac": "single-cell/atac",
}


def modality_datatype(modality: str) -> str:
    """Modality key → its per-modality matrix datatype id (ITEM-18). An arbitrary named
    modality (crispr/custom/hto/…) falls to the GENERIC `single-cell/modality` peer (INV-8:
    no modality privileged)."""
    return MODALITY_DATATYPE.get(normalize_modality_key(modality), "single-cell/modality")


def measurement_name(modality: str) -> str:
    """Modality key → SOMA measurement name. `rna` → `RNA` (back-compat with the single-modal
    store's hardcoded `measurement_name='RNA'`, DEC-23); others use their key verbatim so a
    re-pointed spec (`$data.modality.protein`) addresses `ms['protein']` symmetrically (INV-8)."""
    m = normalize_modality_key(modality)
    return "RNA" if m == "rna" else m


@dataclass
class SomaWritePlan:
    """The faithful MuData→SOMA WRITE PLAN this module COMPUTES; the writer (needs tiledbsoma)
    APPLIES it. modality→measurement, one shared obs UNION domain, raw counts → a `counts` X
    layer, per-measurement var. [cite: MULTIMODAL_representation.md §(b)/§(c)]"""
    measurements: List[str]                 # SOMA ms[...] names, one per modality
    shared_obs: List[str]                   # the UNION cells axis (one soma_joinid domain)
    modality_of: Dict[str, str]             # measurement -> modality key
    raw_layer: str = "counts"               # never a normalized matrix in this layer
    joint_measurement: Optional[str] = None # DEC-11 synthetic ms['joint'] slot (if any)


def plan_soma_write(
    alignment: BarcodeAlignment,
    modalities: Sequence[str],
    has_joint: bool = False,
) -> SomaWritePlan:
    """Build the SOMA write plan (INV-8/9/11/12; DEC-11). Shared obs = the aligned axis (union
    or override-intersection); one measurement per modality; a synthetic `joint` measurement
    reserved ONLY when a container-level (cross-modality) embedding/`.uns` exists (DEC-11
    [owner-confirm] — no joint embedding is COMPUTED at ingest; this only reserves the slot)."""
    meas = [measurement_name(m) for m in modalities]
    modality_of = {measurement_name(m): normalize_modality_key(m) for m in modalities}
    joint = None
    if has_joint:
        joint = "joint"   # DEC-11 default: ms['joint'] holds container-level obsm/obsp + global uns
        modality_of[joint] = "joint"
    return SomaWritePlan(
        measurements=meas + ([joint] if joint else []),
        shared_obs=list(alignment.union if alignment.mode != "intersection-override" else alignment.intersection),
        modality_of=modality_of,
        joint_measurement=joint,
    )
