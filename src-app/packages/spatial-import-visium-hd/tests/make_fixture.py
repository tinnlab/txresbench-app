#!/usr/bin/env python3
# ruff: noqa
"""Build `tests/fixtures/visium-hd-outs/` — the SYNTHESIZED Visium HD bundle this suite runs on.

    python3 tests/make_fixture.py            # rebuild in place
    python3 tests/make_fixture.py <dir>      # build somewhere else (what the provenance test does)

## Read this before trusting anything the suite proves

**No real Visium HD bundle was available.** Every byte below is in the vendor's own FORMAT —
a 10x-shaped `filtered_feature_bc_matrix.h5`, a real parquet positions table, a real PNG, a
real `scalefactors_json.json` — but the CONTENT is generated, so what the suite proves is a
claim about the format this repo has DOCUMENTED, not about vendor bytes. That is the same
disclosure `spatial-types/tests/README-hd-fixture.md` already makes for the HD *layout*
fixture, and it is repeated here rather than glossed because the two fixtures have the same
limitation for the same reason.

Every format decision below carries a repo-internal citation, and
`tests/fixtures/PROVENANCE.json` carries them machine-readably so
`test_fixture_provenance.py` can check that each one RESOLVES to a real file and line. A
citation that has rotted is a fixture built on a fact nobody can check any more.

## Why a GENERATOR and not just committed bytes

Three reasons, in order of weight:

1. A committed blob cannot state WHY it has the shape it has. This file can, and the
   provenance test compares the committed tree against a fresh build, so the two cannot
   drift.
2. The suite needs VARIANTS — a mis-registered image, a bin whose `bin_size_um` disagrees
   with its position, a positions table missing a barcode, a bundle with one bin absent.
   Every one of those is this generator with one argument changed, which keeps a variant
   honest: it differs from the good bundle in exactly the way its name says.
3. The numbers are RELATED. `spot_diameter_fullres` is set to `bin_size_um /
   microns_per_pixel` — a CHOICE this fixture makes, not a documented format fact; it is
   recorded in PROVENANCE.json's `not_verified` and nothing under test derives from it —
   the 8 um lattice is the 2 um lattice binned 4x4, the hires image is the full-resolution
   frame times `tissue_hires_scalef`. Hand-committing four files means hand-maintaining
   those relations; deriving them means a fixture that cannot be internally inconsistent.

## The geometry, and the two properties tests depend on

* **NON-SQUARE, twice over** (`spatial-storage-layout.md` §7.3 rule 5: "the test for it must
  assert on a **non-square** fixture — a square image passes a transposed affine silently").
  The full-resolution frame is 1400 x 900 and the bin lattice is 64 columns x 40 rows, so a
  transposed read is visible in BOTH the image and the coordinates.
* **THE NESTING IS REAL.** "8 um bin = 16 native barcodes; 16 um = 64"
  (`01-file-formats.md:630`). The 2 um lattice is 40 x 64 = 2,560 squares; the 8 um lattice
  is 10 x 16 = 160 (each one 4x4 native squares, so 16:1); the 16 um lattice is 5 x 8 = 40
  (8x8 native, so 64:1). Those exact ratios are asserted, so a fixture edit that flattened
  the nesting makes the suite red instead of making it meaningless.
"""
import hashlib
import json
import math
import shutil
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DEST = HERE / "fixtures" / "visium-hd-outs"

# ── the run's own geometry ───────────────────────────────────────────────────────────

#: The full-resolution pixel frame. NON-SQUARE on purpose (see the module docstring).
FULLRES_W, FULLRES_H = 1400, 900

#: The vendor's STATED micron scale. Visium HD writes `microns_per_pixel` into
#: `scalefactors_json.json` (`docs/research/data-processing/01-file-formats.md:602`), which
#: is the whole reason this importer never derives a scale from a rendered-circle constant.
#: 0.1 um/px keeps every derived pixel figure below an exact integer, so a test can assert
#: an equality rather than a tolerance.
MICRONS_PER_PIXEL = 0.1

#: The native capture grid, in bins. 40 rows x 64 columns — non-square, and divisible by
#: both 4 and 8 so the two coarser lattices nest exactly.
NATIVE_ROWS, NATIVE_COLS = 40, 64

#: The bins Space Ranger writes by default, and the factor each is over the native grid.
#: "Space Ranger bins to **8 um** and **16 um** by default" (`01-file-formats.md:622`);
#: "8 um bin = 16 native barcodes; 16 um = 64" (`01-file-formats.md:630`) — i.e. 4x4 and 8x8.
BINS = (2, 8, 16)
NATIVE_BIN_UM = 2

#: Where the lattice sits in the full-resolution frame. A non-zero origin is deliberate: a
#: reader that silently assumed the lattice starts at (0, 0) would pass on a zero origin.
ORIGIN_X, ORIGIN_Y = 50.0, 40.0

#: `tissue_hires_image.png` / `tissue_lowres_image.png` scale factors.
#:
#: 0.2 is chosen so the hires image sits at EXACTLY
#: `spatial_declarations.DEFAULT_RESOLUTION_CAP_UM` — `MICRONS_PER_PIXEL / HIRES_SCALEF`
#: = 0.1 / 0.2 = 0.5 um/pixel — which `downsample_factor` resolves to a factor of 1 and
#: therefore a PASS-THROUGH. That is deliberate and it was corrected once: at 0.25 the image
#: is 0.4 um/pixel, and because the cap is a "no finer than" bound resolved with `ceil`, a
#: factor of 2 applies and the emitted affine folds it. The image leg the acceptance test is
#: about is the AFFINE — `to_space == [1/s, 0, 0, 0, 1/s, 0]`, §7.3 rule 3's literal words —
#: and on a downsampled image that equality is false BY DESIGN, so a fixture that downsampled
#: would have forced the test to assert against `emitted_affine(s, factor)`, i.e. against the
#: code rather than against the design.
#:
#: The downsample path is not left untested: `build(hires_scalef=...)` produces a finer image
#: on demand, and `test_spatial_image.py` drives it there, where a folded factor is the thing
#: under test rather than a confound.
HIRES_SCALEF = 0.2
LOWRES_SCALEF = 0.06

#: The gene panel. Small, and every id/name is ASCII so the hostile-text tests can introduce
#: their own non-ASCII deliberately rather than inheriting it.
N_GENES = 40

#: Which bins are in tissue: an ellipse inscribed in the middle of the lattice. A CONNECTED
#: region, not a random mask, because `registration_qc.score_registration` compares the
#: vendor's `in_tissue` call against a threshold of the image's own pixels — and a
#: scattered mask has no tissue-shaped counterpart to draw.
TISSUE_CX, TISSUE_CY = 0.5, 0.5
TISSUE_RX, TISSUE_RY = 0.34, 0.30

#: The vendor pipeline identity, mirrored onto the h5 root attributes the way a real bundle
#: carries them (verified against the committed REAL Visium bundle at
#: `spatial-import-visium/tests/fixtures/visium-outs/filtered_feature_bc_matrix.h5`, whose
#: root attributes are `chemistry_description`, `filetype`, `library_ids`,
#: `original_gem_groups`, `software_version`, `version`).
LIBRARY_ID = "Cyto_Synthetic_Visium_HD_Run"

#: The vendor's `Sample ID` from `metrics_summary.csv`, and DELIBERATELY NOT `LIBRARY_ID`.
#:
#: `coordinate_space_id` prefers the matrix's `library_ids` and falls back to this; a fixture
#: in which the two are the SAME STRING cannot tell the two rungs apart, so the precedence
#: assertion would pass whichever one the code actually used. They are different here so that
#: test can fail.
SAMPLE_ID = "Cyto-Synthetic-HD-Sample-A"
SOFTWARE_VERSION = "spaceranger-3.1.0"
CHEMISTRY = "Visium HD v1"
GENOME = "GRCh38"


def bin_shape(bin_um):
    """`(rows, cols)` of the lattice at `bin_um`. The nesting, computed rather than typed."""
    factor = bin_um // NATIVE_BIN_UM
    if NATIVE_ROWS % factor or NATIVE_COLS % factor:
        raise ValueError(
            f"the native {NATIVE_ROWS}x{NATIVE_COLS} lattice does not divide by {factor} — a "
            f"{bin_um} um bin would be ragged, and a ragged fixture makes the nesting ratios "
            "this suite asserts untrue rather than merely awkward"
        )
    return NATIVE_ROWS // factor, NATIVE_COLS // factor


def pitch_px(bin_um):
    """The centre-to-centre pitch of a `bin_um` lattice, in full-resolution pixels.

    The HD capture area is "a **continuous grid of 2x2 um squares** (no gaps)"
    (`docs/research/data-processing/06-spatial-processing.md:120`), so a bin's SIDE is also
    its pitch. That coincidence is HD-specific and is exactly what makes the scale check's
    referent the bin size; on Visium the footprint (55 um) and the pitch (100 um) are
    different numbers, and conflating them was #222.
    """
    return bin_um / MICRONS_PER_PIXEL


def positions_rows(bin_um):
    """The full positions table for one bin: `[(barcode, in_tissue, row, col, py, px)]`.

    Column ORDER is the vendor's — `barcode, in_tissue, array_row, array_col,
    pxl_row_in_fullres, pxl_col_in_fullres` — with the ROW coordinate before the COLUMN one,
    which is §7.3 rule 5's named trap and the reason the importer transposes.
    """
    rows, cols = bin_shape(bin_um)
    pitch = pitch_px(bin_um)
    out = []
    for r in range(rows):
        for c in range(cols):
            # The bin's CENTRE, in full-resolution pixels.
            py = ORIGIN_Y + (r + 0.5) * pitch
            px = ORIGIN_X + (c + 0.5) * pitch
            u = (c + 0.5) / cols - TISSUE_CX
            v = (r + 0.5) / rows - TISSUE_CY
            in_tissue = 1 if (u / TISSUE_RX) ** 2 + (v / TISSUE_RY) ** 2 <= 1.0 else 0
            out.append((barcode(bin_um, r, c), in_tissue, r, c, py, px))
    return out


def barcode(bin_um, row, col):
    """A bin's barcode.

    **THE SPELLING IS NOT VERIFIED against a real bundle**, and nothing in the importer
    depends on it — bin identity is resolved from `scalefactors_json.json`'s `bin_size_um`
    and from the staged member order, never by parsing a barcode. The shape used here is
    the one 10x's own analysis guides show (`s_<bin>um_<row>_<col>-1`), recorded in
    PROVENANCE as UNVERIFIED so nobody later reads a passing test as evidence for it.
    """
    return f"s_{bin_um:03d}um_{row:05d}_{col:05d}-1"


def scalefactors(bin_um, *, microns_per_pixel=MICRONS_PER_PIXEL, hires_scalef=HIRES_SCALEF,
                 extra=None, drop=()):
    """One bin's `scalefactors_json.json`.

    The five keys a Visium `outs/` always carries, plus the two `01-file-formats.md:602`
    records as Visium HD's own (`microns_per_pixel`, `bin_size_um`), plus
    `regist_target_img_scalef`, which "is written only on CytAssist/HD runs"
    (`01-file-formats.md:616-617`).

    `spot_diameter_fullres` is DERIVED here — `bin_size_um / microns_per_pixel` — so the
    fixture's three scale numbers cannot disagree with each other. That is a FIXTURE CHOICE
    and NOT a documented format fact: this repo's only description of the field is 10x's own
    "intended for visualization purposes, and can vary for different slide designs, ranging
    from 60-70 um" (`01-file-formats.md:611-612`), with no HD carve-out. It is listed in
    PROVENANCE.json's `not_verified`, and nothing the importer computes reads it.
    """
    doc = {
        "spot_diameter_fullres": bin_um / microns_per_pixel,
        "bin_size_um": float(bin_um),
        "microns_per_pixel": microns_per_pixel,
        "fiducial_diameter_fullres": 2.5 * bin_um / microns_per_pixel,
        "tissue_hires_scalef": hires_scalef,
        "tissue_lowres_scalef": LOWRES_SCALEF,
        "regist_target_img_scalef": 0.5,
    }
    if extra:
        doc.update(extra)
    for key in drop:
        doc.pop(key, None)
    return doc


# ── the writers ──────────────────────────────────────────────────────────────────────


def write_png(path, width, height, pixel):
    """A minimal, dependency-free 8-bit RGB PNG. `pixel(x, y) -> (r, g, b)`.

    Hand-rolled rather than via pillow so the GENERATOR has no dependency the suite's host
    might not have; the READER under test still goes through pillow, which is what matters.
    Deterministic: fixed zlib level, no timestamp chunk.
    """
    raw = bytearray()
    for y in range(height):
        raw.append(0)                                   # filter type 0 (None)
        for x in range(width):
            raw.extend(pixel(x, y))

    def chunk(kind, payload):
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def tissue_pixel_fn(*, offset_px=(0.0, 0.0), scalef=HIRES_SCALEF):
    """A `pixel(x, y)` painting a dark tissue ellipse on a light background.

    The ellipse is the SAME region `positions_rows` calls `in_tissue`, mapped into the
    scaled image, so the vendor's own call and the image's own pixels agree — which is what
    `registration_qc.score_registration` measures. `offset_px` shifts the tissue in
    FULL-RESOLUTION pixels, which is how the mis-registered variant is built: the
    coordinates and the declared affine stay correct and the PICTURE moves, so the QC has
    something real to fail on.
    """
    rows, cols = NATIVE_ROWS, NATIVE_COLS
    pitch = pitch_px(NATIVE_BIN_UM)
    cx_full = ORIGIN_X + TISSUE_CX * cols * pitch + offset_px[0]
    cy_full = ORIGIN_Y + TISSUE_CY * rows * pitch + offset_px[1]
    rx_full = TISSUE_RX * cols * pitch
    ry_full = TISSUE_RY * rows * pitch

    def pixel(x, y):
        fx, fy = (x + 0.5) / scalef, (y + 0.5) / scalef
        u = (fx - cx_full) / rx_full
        v = (fy - cy_full) / ry_full
        if u * u + v * v <= 1.0:
            return (52, 40, 70)         # tissue: dark
        return (238, 234, 240)          # background: light

    return pixel


def write_matrix_h5(path, bin_um, rows, *, attrs=None, barcodes=None):
    """One bin's `filtered_feature_bc_matrix.h5`, in 10x's own CSC-over-(features x barcodes)
    layout.

    The structure is copied from the committed REAL Visium bundle, dataset for dataset and
    dtype for dtype (`/matrix/{barcodes,data,indices,indptr,shape}` plus
    `/matrix/features/{_all_tag_keys,feature_type,genome,id,name}`), so the reader under
    test meets the same shapes it would meet in production. Only the CONTENT is synthetic.

    `rows` is the FILTERED subset — the in-tissue bins, in the vendor's own order, which is
    NOT the positions table's order. That difference is load-bearing: a positional zip of
    the two tables would align the wrong bin to the wrong barcode for every row, and the
    importer joins on the barcode instead.
    """
    import h5py
    import numpy as np

    kept = [r for r in rows if r[1] == 1]
    # Reversed, so "the matrix's order" and "the positions table's order" are visibly
    # different and a positional join cannot pass by coincidence.
    kept = list(reversed(kept))
    bcs = barcodes if barcodes is not None else [r[0] for r in kept]
    n_bc = len(bcs)

    rng = np.random.default_rng(seed=1_000 + bin_um)
    # A deterministic sparse count matrix: ~30 % of cells non-zero, small integer UMIs.
    dense = (rng.random((n_bc, N_GENES)) < 0.30) * rng.integers(1, 40, size=(n_bc, N_GENES))
    dense = dense.astype(np.int32)

    indptr = [0]
    indices, data = [], []
    for j in range(n_bc):                       # 10x stores CSC over (features x barcodes):
        col = dense[j]                          # one indptr entry per BARCODE ...
        nz = np.nonzero(col)[0]
        indices.extend(int(i) for i in nz)      # ... holding FEATURE ids.
        data.extend(int(col[i]) for i in nz)
        indptr.append(len(indices))

    with h5py.File(path, "w") as h5:
        for key, value in (attrs or {
            "chemistry_description": CHEMISTRY,
            "filetype": "matrix",
            "library_ids": np.array([LIBRARY_ID.encode()], dtype="|S32"),
            "original_gem_groups": np.array([1]),
            "software_version": SOFTWARE_VERSION,
            "version": np.int64(2),
        }).items():
            h5.attrs[key] = value
        m = h5.create_group("matrix")
        m.create_dataset("barcodes", data=np.array([b.encode() for b in bcs], dtype="|S24"))
        m.create_dataset("data", data=np.array(data, dtype=np.int32))
        m.create_dataset("indices", data=np.array(indices, dtype=np.int64))
        m.create_dataset("indptr", data=np.array(indptr, dtype=np.int64))
        m.create_dataset("shape", data=np.array([N_GENES, n_bc], dtype=np.int32))
        f = m.create_group("features")
        f.create_dataset("_all_tag_keys", data=np.array([b"genome"], dtype="|S6"))
        f.create_dataset("feature_type",
                         data=np.array([b"Gene Expression"] * N_GENES, dtype="|S15"))
        f.create_dataset("genome", data=np.array([GENOME.encode()] * N_GENES, dtype="|S6"))
        f.create_dataset("id", data=np.array(
            [f"ENSG{i:011d}".encode() for i in range(N_GENES)], dtype="|S15"))
        f.create_dataset("name", data=np.array(
            [f"GENE{i:04d}".encode() for i in range(N_GENES)], dtype="|S8"))
    return [r[0] for r in kept]


def write_positions_parquet(path, rows, *, in_tissue_dtype="int8", drop_columns=(),
                            rename=None, index_dtype="int32"):
    """One bin's `spatial/tissue_positions.parquet`.

    Written through `pyarrow` with EXPLICIT column types, because the dtype a vendor writes
    for `in_tissue` varies (`int8` in one bundle, `bool` in another) and the reader under
    test is supposed to accept both — the same reason
    `spatial-import-xenium/compute/boundaries.py` gives for reading `pyarrow.parquet`
    directly instead of going through `pandas.read_parquet`.

    `row_group_size` is small on purpose: the reader streams by row group, and a fixture
    with one row group would leave that path unexercised.

    `index_dtype` widens `array_row`/`array_col` to `int64`. The default is the `int32` a
    real Space Ranger export writes, and it is deliberately the default -- but a vendor MAY
    write the lattice indices at 64 bits, and the reader's refusal for an index no `int32`
    can hold is unreachable from a file that cannot physically carry one. A hostile bundle
    that cannot be BUILT is a refusal that cannot be TESTED, so the width is a parameter
    rather than a literal.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    in_tissue = [bool(r[1]) for r in rows] if in_tissue_dtype == "bool" else [int(r[1]) for r in rows]
    index_type = pa.int64() if index_dtype == "int64" else pa.int32()
    columns = {
        "barcode": pa.array([r[0] for r in rows], pa.string()),
        "in_tissue": pa.array(in_tissue,
                              pa.bool_() if in_tissue_dtype == "bool" else pa.int8()),
        "array_row": pa.array([r[2] for r in rows], index_type),
        "array_col": pa.array([r[3] for r in rows], index_type),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([float(r[5]) for r in rows], pa.float64()),
    }
    for name in drop_columns:
        columns.pop(name, None)
    if rename:
        columns = {rename.get(k, k): v for k, v in columns.items()}
    table = pa.table(columns)
    pq.write_table(table, path, row_group_size=64, compression="snappy",
                   version="2.6", store_schema=False)


def build(dest=DEFAULT_DEST, *, bins=BINS, scalefactor_overrides=None,
          image_offset_px=(0.0, 0.0), with_lowres=True, positions_kwargs=None,
          hires_scalef=HIRES_SCALEF):
    """Write the whole bundle under `dest` and return `{bin_um: {member: path}}`.

    The tree is the one Space Ranger writes and the one
    `spatial/visium-hd-bundle.input_requirements.members` declares against:
    `binned_outputs/square_NNNum/` holding the matrix `.h5` directly and a `spatial/`
    holding the parquet positions, the scale factors and the images.
    """
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    binned = dest / "binned_outputs"
    out = {}
    for bin_um in bins:
        bin_dir = binned / f"square_{bin_um:03d}um"
        (bin_dir / "spatial").mkdir(parents=True, exist_ok=True)
        rows = positions_rows(bin_um)
        # The scale factor and the image it places move TOGETHER: the value written into the
        # JSON is the one the PNG below is rendered at. A document whose `tissue_hires_scalef`
        # contradicted the image's own dimensions would make every image assertion a test of
        # THAT contradiction rather than of the importer.
        #
        # `hires_scalef` is threaded THROUGH `scalefactors()` rather than assigned after it,
        # so a caller's `drop=("tissue_hires_scalef",)` still removes the key — assigning
        # afterwards silently put it back, which made the unplaceable-image case emit an image
        # and the test that caught it read like a compute defect.
        sf = scalefactors(bin_um, hires_scalef=hires_scalef,
                          **((scalefactor_overrides or {}).get(bin_um, {})))

        matrix = bin_dir / "filtered_feature_bc_matrix.h5"
        write_matrix_h5(matrix, bin_um, rows)
        positions = bin_dir / "spatial" / "tissue_positions.parquet"
        write_positions_parquet(positions, rows, **((positions_kwargs or {}).get(bin_um, {})))
        scale_path = bin_dir / "spatial" / "scalefactors_json.json"
        scale_path.write_text(json.dumps(sf, indent=2) + "\n", encoding="utf-8")

        hires = bin_dir / "spatial" / "tissue_hires_image.png"
        write_png(hires, round(FULLRES_W * hires_scalef), round(FULLRES_H * hires_scalef),
                  tissue_pixel_fn(offset_px=image_offset_px, scalef=hires_scalef))
        members = {"matrix": matrix, "positions": positions,
                   "scalefactors": scale_path, "image": hires}
        if with_lowres:
            lowres = bin_dir / "spatial" / "tissue_lowres_image.png"
            write_png(lowres, round(FULLRES_W * LOWRES_SCALEF), round(FULLRES_H * LOWRES_SCALEF),
                      tissue_pixel_fn(offset_px=image_offset_px, scalef=LOWRES_SCALEF))
            members["lowres"] = lowres
        out[bin_um] = members

    # The run-root files Space Ranger emits ONCE, outside every `square_NNNum/`. They are
    # NOT declared members of the container (`spatial-types/manifest.yaml` says why, and
    # DEC-8 says why this branch does not change that), and this importer reads only
    # `metrics_summary.csv` — for provenance and the report, never for data. They are
    # present because a fixture that omitted them would not be the tree the container's own
    # comment describes, and a member matcher that accidentally reached one would then go
    # unnoticed.
    (dest / "metrics_summary.csv").write_text(
        "Sample ID,Pipeline Version,Number of Bins Under Tissue\n"
        f"{SAMPLE_ID},{SOFTWARE_VERSION},{sum(1 for r in positions_rows(8) if r[1])}\n",
        encoding="utf-8",
    )
    (dest / "web_summary.html").write_text(
        "<html><body>synthetic Space Ranger run summary; nothing reads this</body></html>\n",
        encoding="utf-8",
    )
    return out


def digest_tree(root):
    """`{relative-posix-path: sha256}` for every file under `root`, for the provenance test."""
    root = Path(root)
    return {
        str(p.relative_to(root).as_posix()): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DEST
    build(target)
    print(f"wrote {sum(1 for _ in target.rglob('*') if _.is_file())} files under {target}")
