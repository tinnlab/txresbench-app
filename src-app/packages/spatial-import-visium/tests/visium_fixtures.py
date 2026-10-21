#!/usr/bin/env python3
# ruff: noqa
"""Staging + read-back machinery for the `spatial.import-visium` suites.

## Why this module is named after its package

Non-`test_*.py` files in a `tests/` dir are imported by BARE NAME, so a `_shared.py` or a
`fixtures.py` here would collide with every other package's copy of the same name — the
`--import-mode=importlib` fix in `packages/pytest.ini` gives path-unique names to
`test_*.py` modules ONLY. `embedding` solved the same problem the same way with
`embedding_fixtures.py`; this follows it.

## The fixture is REAL vendor data

`tests/fixtures/visium-outs/` is a 10x Genomics `Visium_Mouse_Olfactory_Bulb` bundle
(Space Ranger 2.0.0, Visium V1 slide), SUBSET. Every byte is the vendor's own format
produced by the vendor's own pipeline: the `.h5` keeps its root attributes and its
feature group, `tissue_positions.csv` keeps the headered >= 2.0 spelling and still holds
out-of-tissue spots the filtered matrix does NOT contain, and `scalefactors_json.json` is
copied verbatim. Nothing here is synthesised.

It is deliberately NON-SQUARE in the full-resolution pixel frame — the subset is a wide,
short strip — because a square fixture passes a transposed `(x, y)` silently, which the
design names as "the single most likely bug in the whole importer".
"""
import importlib.util
import json
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
FIXTURE = PKG / "tests" / "fixtures" / "visium-outs"
COMPUTE = PKG / "compute" / "import_visium.py"

#: The fixture's own numbers, asserted rather than assumed by `test_producer_end_to_end`.
FIXTURE_SPACE_RANGER = "spaceranger-2.0.0"
FIXTURE_LIBRARY_ID = "Visium_Mouse_Olfactory_Bulb"

# ── the CytAssist fixtures (#257) ────────────────────────────────────────────────────
# TWO MORE REAL VENDOR BUNDLES, and they are here for one reason: #257's constants are 70 um
# and 60 um, and a constant with no bundle behind it is the "tuned parameter" this whole item
# exists to refuse. Each is the committed evidence for exactly one row of
# `import_visium.SLIDE_DESIGNS`, and `tests/fixtures/PROVENANCE.json` carries its licence,
# source URL, archive sha256 and the numbers measured off it.
#
# Same rule as `visium-outs/` above: every byte is the vendor's own format produced by the
# vendor's own pipeline — `scalefactors_json.json` byte-identical, and an `.h5` keeping the
# root attributes and the whole feature group with fewer barcodes.
#
# THE POSITIONS TABLES ARE THE VENDOR'S COMPLETE FILES — 4,992 and 14,336 rows, which are
# 10x's own documented counts for these capture areas — and NOT windows, which is what they
# were until #257's fourth fix round. A blind audit measured why that mattered: a producer
# switching its numerator on `len(positions) >= 1000` passed the whole package suite AND the
# cross-package gate while applying a 21.4% wrong micron scale to every real bundle, because
# no committed fixture reached the threshold. That is #243's lesson one file over, where an
# undersized image fixture hid an incoherent artifact for months.
#
# The `.h5` stays a subset: a filtered matrix legitimately holds fewer barcodes than the
# positions table, which is the shape `visium-outs/` has too, and it is what keeps these
# directories small enough to commit.
#
# Neither ships a vendor IMAGE. What they are here to prove is the micron scale, and the scale
# check reads only the positions table and the scalefactors; the one CytAssist-specific image
# is `cytassist_image.tiff`, which this importer will never emit (see
# `import_visium.NON_PLACEABLE_VENDOR_IMAGES`), so committing 23 MB of it would buy nothing.

#: `CytAssist_FFPE_Human_Lung_Squamous_Cell_Carcinoma`, Space Ranger 2.0.0, `Visium V4 Slide`
#: — the 6.5 mm CytAssist slide design, whose rendered spot circle measures 70 um.
CYTASSIST_V4 = PKG / "tests" / "fixtures" / "cytassist-v4-outs"
CYTASSIST_V4_SPACE_RANGER = "spaceranger-2.0.0"
CYTASSIST_V4_LIBRARY_ID = "CytAssist_FFPE_Human_Lung_Squamous_Cell_Carcinoma"
CYTASSIST_V4_CHEMISTRY = "Visium V4 Slide"
CYTASSIST_V4_DESIGN_ID = "visium-6.5mm-70um-rendered-spot"
CYTASSIST_V4_RENDERED_SPOT_UM = 70.0

#: `CytAssist_11mm_FFPE_Human_Colorectal_Cancer`, Space Ranger 2.0.1, `Visium V5 Slide` — the
#: 11 mm CytAssist slide design, whose rendered spot circle measures 60 um. Its vendor table
#: has 14,336 rows, which is 10x's own stated count for an 11 mm capture area.
CYTASSIST_V5_11MM = PKG / "tests" / "fixtures" / "cytassist-v5-11mm-outs"
CYTASSIST_V5_11MM_SPACE_RANGER = "spaceranger-2.0.1"
CYTASSIST_V5_11MM_LIBRARY_ID = "CytAssist_11mm_FFPE_Human_Colorectal_Cancer"
CYTASSIST_V5_11MM_CHEMISTRY = "Visium V5 Slide"
CYTASSIST_V5_11MM_DESIGN_ID = "visium-11mm-60um-rendered-spot"
CYTASSIST_V5_11MM_RENDERED_SPOT_UM = 60.0

#: The three committed bundles and the design each one is evidence FOR, as
#: `(root, design_id, rendered_spot_diameter_um)`. A table so a test can assert over every
#: design with one loop and a NEW design's fixture joins the sweep by adding a row — the same
#: reason `import_visium.SLIDE_DESIGNS` is a table.
COMMITTED_BUNDLES = (
    (FIXTURE, "visium-6.5mm-65um-rendered-spot", 65.0),
    (CYTASSIST_V4, CYTASSIST_V4_DESIGN_ID, CYTASSIST_V4_RENDERED_SPOT_UM),
    (CYTASSIST_V5_11MM, CYTASSIST_V5_11MM_DESIGN_ID, CYTASSIST_V5_11MM_RENDERED_SPOT_UM),
)


def _load_by_path(name, path):
    """Load one module from an exact PATH, ignoring `sys.path` entirely."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_compute():
    """Import `compute/import_visium.py` the way the sandbox stages it.

    ## Why this binds `spatial_declarations` BY PATH instead of by `sys.path`

    In production the sandbox assembles ONE `/code` dir holding the entry plus the files
    `run.helpers` declares, so `import spatial_declarations` is unambiguous: there is
    exactly one such file and it is the vendored copy. A pytest process is not that dir.
    It imports out of the source tree, where `spatial-types` ships a file of the same
    name — and whichever suite runs first wins `sys.modules`, for the whole session.

    That is not hypothetical and it is not cosmetic: putting `compute/` on `sys.path` was
    the first implementation, and it PASSED when this suite ran alone and FAILED under
    `just check-py`, resolving `SD` to `spatial-types`' original. Every assertion in
    `test_vendored_contract.py` would then have been about a module this package does not
    ship — the byte-identity test would still have passed (the files ARE identical today)
    while proving nothing about the copy. It is the same ambiguous-bare-name class as
    #207, one directory over.

    So the vendored copy is loaded from its own path and INSTALLED under the bare name
    before the entry is executed, which reproduces `/code` exactly: one file, beside the
    entry, whatever else the interpreter has already imported.
    """
    _load_by_path("spatial_declarations", PKG / "compute" / "spatial_declarations.py")
    # `ome_writer` (#155) is staged the same way and for the same reason. It imports
    # `spatial_declarations` itself, so it MUST be loaded after that name is installed —
    # in `/code` both files sit beside the entry and the bare name resolves to this
    # package's copy; here the order is what reproduces that.
    _load_by_path("ome_writer", PKG / "compute" / "ome_writer.py")
    # `registration_qc` (#156), staged by the same rule and AFTER `spatial_declarations` for
    # the same reason: in `/code` all three sit beside the entry and every bare name resolves
    # to this package's copy, and reproducing that order here is what stops a sibling
    # package's same-named module winning `sys.modules` for the session.
    _load_by_path("registration_qc", PKG / "compute" / "registration_qc.py")
    return _load_by_path("spatial_import_visium_entry", COMPUTE)


def run_over(bundle_root, outputs_dir):
    """Drive the REAL compute over `bundle_root`, returning `(module, entries)`.

    This calls the shipped `run_import`, not a re-implementation of it — a test that
    reproduces the importer's logic proves only that the reproduction agrees with itself.
    """
    module = load_compute()
    entries = module.run_import(Path(bundle_root), Path(outputs_dir))
    return module, entries


def entry_by_id(entries, output_id):
    hits = [e for e in entries if e["id"] == output_id]
    assert len(hits) == 1, f"expected exactly one {output_id!r}, got {len(hits)}"
    return hits[0]


def read_member(outputs_dir, rel_dir, member):
    """Read one member of a written store back as a numpy array.

    Through `_lib`'s OWN reader (`cyto_zarr_read`), which is the reader the platform
    ships for these stores — the writer emits Zarr v3 with the repo's shuffle/codec
    conventions, and a third-party `zarr` at v2 cannot open it. Reading BACK rather than
    trusting the writer's return value is the whole point: these suites assert on the
    bytes that landed, which is what a consumer will see.
    """
    import cyto_zarr_read

    return cyto_zarr_read.read_array(str(Path(outputs_dir) / rel_dir), member)


def read_column(outputs_dir, rel_dir, member="values"):
    """A column artifact as what it MEANS — categorical labels resolved, strings decoded."""
    import cyto_zarr_read

    return cyto_zarr_read.read_column(str(Path(outputs_dir) / rel_dir), member)


def read_values(outputs_dir, rel_dir):
    """The sole `values` member of a 1-D metadata-column store, as what it MEANS.

    Through `read_column` rather than `read_array`: a TEXT column is stored in the split
    arrow layout (`values/offsets` + `values/values`), so `values` is a GROUP and a raw
    array read fails on it. `read_column` is the platform's own dispatch over the four
    encodings, which is what any real consumer uses.
    """
    return read_column(outputs_dir, rel_dir)


def member_attributes(outputs_dir, rel_dir, member):
    """`attributes.cyto` of one member — the declaration that travels WITH the bytes."""
    doc = json.loads(
        (Path(outputs_dir) / rel_dir / member / "zarr.json").read_text()
    )
    return doc.get("attributes", {}).get("cyto", {})


def positions_table(bundle_root=None):
    """The fixture's own `tissue_positions.csv`, parsed independently of the importer.

    `bundle_root` defaults to the committed fixture; pass a bundle to read that copy's table
    instead (the probes in `test_image_coherence` add rows to theirs).

    Parsed here with the stdlib rather than through the importer's `read_positions`, so
    the expectations these tests compare against do not inherit the importer's own reading
    of the file. A test whose expectation comes from the code under test cannot fail on a
    misreading.
    """
    import csv

    root = Path(bundle_root) if bundle_root is not None else FIXTURE
    with open(root / "spatial" / "tissue_positions.csv", newline="") as fh:
        rows = list(csv.reader(fh))
    header = [c.strip() for c in rows[0]]
    return [dict(zip(header, r)) for r in rows[1:] if r and any(c.strip() for c in r)]


def matrix_barcodes():
    """The fixture matrix's barcodes, in ITS order — the order every artifact is in."""
    import h5py

    with h5py.File(FIXTURE / "filtered_feature_bc_matrix.h5", "r") as f:
        return [b.decode() for b in f["matrix/barcodes"][:]]


def scalefactors(bundle_root=None):
    """The bundle's `scalefactors_json.json`, parsed. Defaults to the committed fixture."""
    root = Path(bundle_root) if bundle_root is not None else FIXTURE
    return json.loads((root / "spatial" / "scalefactors_json.json").read_text())


def scaled_xy(bundle_root=None):
    """Every spot's `(xs, ys)` IN IMAGE PIXELS for `tissue_hires_scalef`, as two lists.

    The one place the `col -> x`, `row -> y` transpose is written for image-space work, so a
    caller that needs the scaled coordinates does not spell it a third time. [`expected_xy`]
    is the FULL-RESOLUTION equivalent and is deliberately left alone: it is the expectation
    the importer's own affine is compared against, and giving the two one implementation
    would make that comparison self-referential.
    """
    scalef = scalefactors(bundle_root)["tissue_hires_scalef"]
    rows = positions_table(bundle_root)
    xs = [float(r["pxl_col_in_fullres"]) * scalef for r in rows]
    ys = [float(r["pxl_row_in_fullres"]) * scalef for r in rows]
    return xs, ys


def expected_xy():
    """`(xs, ys)` for the matrix's barcodes, in the matrix's order, from the CSV.

    `x` is the CSV's `pxl_col_in_fullres` and `y` is its `pxl_row_in_fullres` — the
    TRANSPOSE the importer must perform, written out here in the opposite direction from
    the code so that agreeing is evidence.
    """
    by_barcode = {r["barcode"]: r for r in positions_table()}
    xs, ys = [], []
    for bc in matrix_barcodes():
        row = by_barcode[bc]
        xs.append(float(row["pxl_col_in_fullres"]))
        ys.append(float(row["pxl_row_in_fullres"]))
    return xs, ys


def make_variant(tmp_path, *, scalefactors_text=None, drop_scalefactors=False):
    """A copy of the fixture bundle with `scalefactors_json.json` replaced or removed.

    Used by the INV-6 legs: a bundle that states `microns_per_pixel`, and a bundle whose
    scale file is unreadable. Everything else is the real bundle.
    """
    import shutil

    dest = Path(tmp_path) / "bundle"
    shutil.copytree(FIXTURE, dest)
    target = dest / "spatial" / "scalefactors_json.json"
    if drop_scalefactors:
        target.write_text("{ this is not json")
    elif scalefactors_text is not None:
        target.write_text(scalefactors_text)
    return dest


#: The synthetic full-resolution frame `make_imaged` builds its images against, and the
#: full-res position of the marker it paints into every one of them.
#:
#: DELIBERATELY NON-SQUARE (7000 x 9000), because §7.3 rule 5 is explicit that "the test
#: for it must assert on a NON-SQUARE fixture — a square image passes a transposed affine
#: silently", and the shipped vendor bundle is 2000x2000 — SQUARE, so it cannot serve for
#: that one property no matter how real it is.
#:
#: ## What changed at #243, and what did not
#:
#: This block used to give a second reason: that the shipped image was a 200x200 placeholder
#: which did not cover its own spots. That is no longer true. The committed
#: `tissue_hires_image.png` is now 10x's own 2000x2000 emission and all 160 of the bundle's
#: spots land on it (`hires_coverage`, asserted by `test_image_coherence.py`). So the REAL
#: fixture is now the right thing to reach for whenever the question is "do the spots sit on
#: the tissue", and this synthetic frame is NOT — it has no tissue in it.
#:
#: What this fixture is still for is the SQUARENESS problem and the marker. Width != height
#: and the marker is off-centre in both axes, so a transposed extent, a transposed marker, or
#: a forward-instead-of-inverse affine each produce a different number rather than the same
#: one — none of which a 2000x2000 image can show.
IMAGED_FULLRES_W = 7000
IMAGED_FULLRES_H = 9000
IMAGED_MARKER_XY = (4900, 2700)


#: `spot_diameter_fullres` for [`make_fine_imaged`], chosen so the hires image lands FINER
#: than the 0.5 µm/pixel display cap and the lowres image stays COARSER than it (#176).
#:
#: The arithmetic, so the fixture is a derivation and not a magic number. The importer
#: derives the space's scale as `VISIUM_RENDERED_SPOT_DIAMETER_UM / spot_diameter_fullres`
#: (`micron_scale` leg 2 — 65.0 um, the RENDERED circle that field measures, since #222; it
#: was 55.0 before, which measured the capture footprint instead and ran 15.4% low), and each
#: image's own pitch as that divided by its own scalefactor. With the vendor's real
#: scalefactors (hires 0.2, lowres 0.06):
#:
#:   microns_per_pixel = 65.0 / 1375          = 0.0473 µm/pixel (full-res)
#:   hires             = 0.0473 / 0.2         = 0.236  µm/pixel -> ceil(0.5/0.236) = FACTOR 3
#:   lowres            = 0.0473 / 0.06        = 0.788  µm/pixel -> FACTOR 1, pass-through
#:
#: 1375 is KEPT rather than re-derived to restore a round 0.04 (DEC-8): the fixture exists to
#: put ONE bundle on both sides of the resolution cap, and it still does — the hires factor is
#: still 3 and the lowres image still passes through. Moving a committed vendor-derived number
#: for a rounder intermediate would re-baseline several unrelated image assertions.
#:
#: The target it was SIZED for is 0.2 µm/pixel, which is not arbitrary: it is Xenium's real
#: morphology resolution, the case design §8.3 says the downsample exists for. #222 moved the
#: numerator 55 -> 65 and the fixture now lands at 0.236 µm/pixel instead — still well inside
#: the same regime and still factor 3, which is why 1375 was kept rather than re-derived
#: (DEC-8). And ONE bundle exercising BOTH branches
#: is the point — it proves one code path downsamples and passes through, rather than two
#: fixtures each proving one thing.
FINE_SPOT_DIAMETER_FULLRES = 1375
FINE_EXPECTED_FACTOR = 3

#: The marker's half-width in [`make_fine_imaged`]'s images, in that image's own pixels.
#:
#: Bigger than `make_imaged`'s (which is `max(1, round(2 * scalef))`, i.e. 1 at the hires
#: scalefactor) for a reason the downsample forces: the marker is located in the emitted
#: pixels by an EXACT `== 255` test, and after a 3x box mean a 3x3 marker leaves no output
#: block fully saturated — every block mixes marker with gradient, so nothing equals 255 and
#: the marker becomes unfindable. 6 gives a 13x13 block, which guarantees at least one whole
#: `factor x factor` block of pure marker at factor 3. Sized to the ASSERTION's needs, and
#: said so rather than tuned until the test went green.
FINE_MARKER_HALF = 6


def fine_scalefactors_text():
    """The fine fixture's `scalefactors_json.json`, as text.

    The vendor's own file with ONE number replaced. Everything else — both scalefactors, the
    fiducial diameter — is 10x's, so the affine assertions still compare against vendor
    numbers and only the SCALE of the space is hypothetical.
    """
    import json

    factors = dict(scalefactors())
    factors["spot_diameter_fullres"] = FINE_SPOT_DIAMETER_FULLRES
    return json.dumps(factors)


def make_fine_imaged(tmp_path, **kwargs):
    """A bundle whose HIRES image is FINER than the display cap and whose LOWRES is not.

    The shipped Visium images are ~4.41 µm/pixel against a 0.5 µm/pixel cap — nearly NINE
    TIMES COARSER (~3.74 and ~7x before #222) — so on the real fixture the downsample branch
    is unreachable and every assertion about it would pass vacuously on a pass-through. This is the fixture that
    makes #176's own code path reachable from the end-to-end suite.
    """
    kwargs.setdefault("scalefactors_text", fine_scalefactors_text())
    kwargs.setdefault("marker_half", FINE_MARKER_HALF)
    return make_imaged(tmp_path, **kwargs)


def make_imaged(tmp_path, *, with_lowres=True, scalefactors_text=None,
                drop_hires_scalef=False, marker_half=None):
    """A bundle whose images are SYNTHESIZED, coherent and NON-SQUARE.

    ## What is synthesized and what is not

    Only the IMAGE PIXELS and their dimensions. The bundle is otherwise the real vendor
    subset — the same matrix, the same `tissue_positions.csv`, and above all the vendor's
    own `scalefactors_json.json` — so every number the affine assertions compare against
    (`tissue_hires_scalef == 0.2`, `tissue_lowres_scalef == 0.06`, the `pxl_*` columns) is
    still 10x's, not this module's. What is manufactured is the geometry the shipped
    placeholder image lacks, and nothing else.

    ## The marker is what makes "N images, one space" checkable

    A single bright square is painted at [`IMAGED_MARKER_XY`] in the FULL-RESOLUTION frame
    and rendered into each image at that image's own scalefactor. So the same physical
    feature exists in the hires image at one pixel address and in the lowres image at a
    different one, and applying each image's OWN `to_space` to its OWN marker pixel must
    land both on the same full-res coordinate. That is the property §7.3 rule 3 promises
    and the one a forward-direction affine cannot deliver.

    The images are low-entropy (a gradient plus the marker) so they deflate to almost
    nothing and the suite stays fast.
    """
    import json
    import shutil

    import numpy as np

    dest = Path(tmp_path) / "imaged"
    shutil.copytree(FIXTURE, dest)

    factors = json.loads((dest / "spatial" / "scalefactors_json.json").read_text())
    if scalefactors_text is not None:
        (dest / "spatial" / "scalefactors_json.json").write_text(scalefactors_text)
        factors = json.loads(scalefactors_text)
    elif drop_hires_scalef:
        factors.pop("tissue_hires_scalef", None)
        (dest / "spatial" / "scalefactors_json.json").write_text(json.dumps(factors))

    def paint(scalef):
        """The frame at `scalef`, as `(H, W, 3)` uint8 with the marker burned in."""
        w = int(round(IMAGED_FULLRES_W * scalef))
        h = int(round(IMAGED_FULLRES_H * scalef))
        # A gradient that differs along BOTH axes, so a transposed read is visible in the
        # pixels too and not only in the declared extent.
        ys = np.linspace(0, 120, h, dtype=np.float32)[:, None]
        xs = np.linspace(0, 120, w, dtype=np.float32)[None, :]
        plane = (ys + xs).astype(np.uint8)
        arr = np.repeat(plane[:, :, None], 3, axis=2)
        mx = int(round(IMAGED_MARKER_XY[0] * scalef))
        my = int(round(IMAGED_MARKER_XY[1] * scalef))
        half = marker_half if marker_half is not None else max(1, int(round(2 * scalef)))
        arr[max(0, my - half):my + half + 1, max(0, mx - half):mx + half + 1, :] = 255
        return arr

    from PIL import Image

    for basename, key in (("tissue_hires_image.png", "tissue_hires_scalef"),
                          ("tissue_lowres_image.png", "tissue_lowres_scalef")):
        if basename == "tissue_lowres_image.png" and not with_lowres:
            continue
        scalef = factors.get(key)
        # A scalefactor that is absent, non-positive, or so small that it would size the
        # image to zero pixels. The last case is the subnormal one (`1e-320`), and it is
        # handled HERE rather than by letting PIL fail: the situation under test is a
        # bundle carrying a PLAUSIBLE vendor image beside a damaged number, which is what a
        # truncated or mis-generated `scalefactors_json.json` really looks like. Sizing the
        # file from the damaged number instead would test PIL's refusal to write an empty
        # image, which is nobody's failure mode.
        degenerate = (
            not isinstance(scalef, (int, float)) or isinstance(scalef, bool)
            or scalef <= 0
            or int(round(IMAGED_FULLRES_W * scalef)) < 1
            or int(round(IMAGED_FULLRES_H * scalef)) < 1
        )
        if degenerate:
            # No usable scalefactor: still WRITE the image, because the case under test is
            # an image that is PRESENT and UNPLACEABLE. Sized by the hires factor so the
            # file is a plausible vendor artifact rather than a degenerate one.
            scalef = 0.2
            Image.fromarray(paint(scalef)).save(dest / "spatial" / basename)
            continue
        Image.fromarray(paint(scalef)).save(dest / "spatial" / basename)
    return dest


def marker_in_image(scalef):
    """Where [`IMAGED_MARKER_XY`] lands in an image scaled by `scalef`, as `(col, row)`.

    Computed here from the marker's full-res position, in the opposite direction from the
    importer's affine, so that the two agreeing is evidence rather than a restatement.
    """
    return (int(round(IMAGED_MARKER_XY[0] * scalef)),
            int(round(IMAGED_MARKER_XY[1] * scalef)))


def make_resized(tmp_path, *, n_spots, n_genes):
    """A SMALLER real bundle: the fixture, cut to `n_spots` x `n_genes`.

    Used to prove that the emitted artifact COUNT is structural rather than a property of
    one fixture (INV-10): the fan-out must be one artifact per named column, never one per
    row, per gene or per tile. Every file it writes is still the vendor's own format —
    only fewer rows of it.
    """
    import csv
    import shutil

    import h5py
    import numpy as np

    dest = Path(tmp_path) / "resized"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "spatial").mkdir(exist_ok=True)
    for name in ("scalefactors_json.json", "tissue_hires_image.png"):
        shutil.copy(FIXTURE / "spatial" / name, dest / "spatial" / name)

    with h5py.File(FIXTURE / "filtered_feature_bc_matrix.h5", "r") as src:
        m = src["matrix"]
        indptr = m["indptr"][:]
        indices = m["indices"][:]
        data = m["data"][:]
        barcodes = [b.decode() for b in m["barcodes"][:]][:n_spots]
        feats = {k: m["features"][k][:] for k in m["features"].keys()}
        root_attrs = dict(src.attrs)

        new_data, new_indices, new_indptr = [], [], [0]
        for c in range(n_spots):
            lo, hi = int(indptr[c]), int(indptr[c + 1])
            sel = [(int(i), v) for i, v in zip(indices[lo:hi], data[lo:hi]) if int(i) < n_genes]
            new_indices.extend(i for i, _ in sel)
            new_data.extend(v for _, v in sel)
            new_indptr.append(len(new_data))

        with h5py.File(dest / "filtered_feature_bc_matrix.h5", "w") as out:
            for k, v in root_attrs.items():
                out.attrs[k] = v
            g = out.create_group("matrix")
            g.create_dataset("barcodes", data=np.array([b.encode() for b in barcodes]))
            g.create_dataset("data", data=np.asarray(new_data, dtype=np.int32))
            g.create_dataset("indices", data=np.asarray(new_indices, dtype=np.int64))
            g.create_dataset("indptr", data=np.asarray(new_indptr, dtype=np.int64))
            g.create_dataset("shape", data=np.array([n_genes, n_spots], dtype=np.int32))
            fg = g.create_group("features")
            for k, v in feats.items():
                fg.create_dataset(k, data=(v if k == "_all_tag_keys" else v[:n_genes]))

    keep = set(barcodes)
    rows = [r for r in positions_table() if r["barcode"] in keep]
    with open(dest / "spatial" / "tissue_positions.csv", "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return dest


#: The scale a vendor-stated `microns_per_pixel` must carry for the committed fixture's spots
#: to sit at the Visium slide's manufactured 100 µm pitch — i.e. `100 / 113.000`, where
#: 113.000 px is the median nearest-neighbour spacing MEASURED off the vendor's own
#: `tissue_positions.csv`.
#:
#: This is the SCALE POSITIVE CONTROL, and it needs no new fixture: `micron_scale` leg 1
#: already honours a vendor-stated `microns_per_pixel` verbatim, so the same bundle, the same
#: positions and the same image can be imported with a correct scale and with a wrong one and
#: the check asked which is which. A control that required a different fixture would not be
#: controlling for anything.
REGISTERED_MICRONS_PER_PIXEL = 100.0 / 113.0


def registered_scalefactors_text(microns_per_pixel=REGISTERED_MICRONS_PER_PIXEL):
    """The vendor's own `scalefactors_json.json` plus a stated `microns_per_pixel`.

    ADDING a key rather than editing one: `spot_diameter_fullres` and both image scalefactors
    stay exactly 10x's, so the affine and the image geometry are untouched and the ONLY thing
    that moves between this bundle and the shipped one is which leg of `micron_scale` fires.
    """
    import json

    factors = dict(scalefactors())
    factors["microns_per_pixel"] = float(microns_per_pixel)
    return json.dumps(factors)


#: How far outside the in-tissue spot cloud [`make_registered`]'s painted tissue blob extends,
#: in full-resolution pixels. Half a spot pitch, so the blob's boundary sits between the
#: outermost in-tissue spots and their out-of-tissue neighbours — which is what gives the
#: mask any discriminating power at all. A blob painted exactly on the spot centres would
#: leave every boundary spot's verdict to rounding.
REGISTERED_BLOB_MARGIN_FULLRES = 56.0


def make_registered(tmp_path, *, scalefactors_text=None, transpose_image=False):
    """A bundle whose images carry TISSUE where the vendor says there is tissue.

    ## Why this fixture has to exist

    `make_imaged` gives a geometrically coherent frame, but its pixels are a gradient plus a
    marker — there is no tissue in them, so a tissue mask derived from them says nothing about
    `in_tissue` and the registration check cannot be given a POSITIVE result to be told apart
    from a negative one. Without that, "the check failed" is indistinguishable from "the check
    always fails", which is no check at all.

    The committed real fixture is now COHERENT — since #243 its `tissue_hires_image.png` is
    10x's own 2000x2000 emission and all 160 of its spots land on it — but it still cannot
    serve as this suite's positive control, for a different reason: its pixels are real H&E,
    so the `in_tissue` flags and the tissue mask are two independent measurements and a
    disagreement between them is a finding about the DATA, not a controlled input. A positive
    control has to be a case where the right answer is known by construction.

    Using the real bundle to replace this control is #156's work and needs its own
    calibration; it is now POSSIBLE, which it was not before #243, and that is what #243
    unlocked. It is not silently assumed here.

    ## The limitation, stated rather than hidden

    The blob is painted from the in-tissue spots' own positions, so this fixture is partly
    self-referential and cannot calibrate `J_FLOOR` for real H&E. What it CAN prove, and all
    that is claimed from it, is that the check DISCRIMINATES between a right and a wrong
    mapping over IDENTICAL pixels — the pixels never change between the correct case and the
    mutated ones; only the declared affine does.

    `transpose_image` paints the blob at TRANSPOSED full-resolution coordinates while leaving
    everything else alone, giving a bundle whose image is genuinely misregistered by the one
    error §7.3 rule 5 calls "the single most likely bug in the whole importer" — a negative
    control that is a property of the DATA rather than of a mutated declaration.
    """
    import json
    import shutil

    import numpy as np
    from PIL import Image

    dest = Path(tmp_path) / "registered"
    shutil.copytree(FIXTURE, dest)
    if scalefactors_text is None:
        scalefactors_text = registered_scalefactors_text()
    (dest / "spatial" / "scalefactors_json.json").write_text(scalefactors_text)
    factors = json.loads(scalefactors_text)

    rows = positions_table()
    xs = np.array([float(r["pxl_col_in_fullres"]) for r in rows])
    ys = np.array([float(r["pxl_row_in_fullres"]) for r in rows])
    inside = np.array([str(r["in_tissue"]).strip() == "1" for r in rows])
    if transpose_image:
        xs, ys = ys.copy(), xs.copy()
    tissue_xy = np.column_stack([xs[inside], ys[inside]])

    def paint(scalef):
        """The frame at `scalef` — pale slide, with a dark blob over the in-tissue spots."""
        w = int(round(IMAGED_FULLRES_W * scalef))
        h = int(round(IMAGED_FULLRES_H * scalef))
        # A pale, gently varying background rather than a flat one: a constant plane has no
        # Otsu threshold, and `tissue_mask` REFUSES it by design. The variation is small
        # enough to stay on the background side of the threshold.
        yy = np.linspace(228, 244, h, dtype=np.float32)[:, None]
        xx = np.linspace(0, 8, w, dtype=np.float32)[None, :]
        plane = (yy + xx).astype(np.float32)
        # The blob: every full-res pixel within `margin` of an in-tissue spot centre. Built as
        # a distance test against the spot cloud in the IMAGE's own grid, so the blob is at
        # the same physical place in the hires and the lowres image and the two are genuinely
        # one scene at two scales.
        margin = REGISTERED_BLOB_MARGIN_FULLRES * scalef
        centres = tissue_xy * scalef
        grid_y, grid_x = np.mgrid[0:h, 0:w]
        blob = np.zeros((h, w), dtype=bool)
        # Chunked over the spots, so peak memory is one (h, w) boolean per step rather than
        # one per spot.
        for cx, cy in centres:
            blob |= ((grid_x - cx) ** 2 + (grid_y - cy) ** 2) <= margin ** 2
        plane[blob] = 70.0
        arr = np.repeat(np.clip(plane, 0, 255).astype(np.uint8)[:, :, None], 3, axis=2)
        return arr

    for basename, key in (("tissue_hires_image.png", "tissue_hires_scalef"),
                          ("tissue_lowres_image.png", "tissue_lowres_scalef")):
        scalef = factors.get(key)
        if not (isinstance(scalef, (int, float)) and not isinstance(scalef, bool)
                and scalef > 0):
            continue
        Image.fromarray(paint(float(scalef))).save(dest / "spatial" / basename)
    return dest


#: The factor by which the shipped `tissue_hires_image.png` was downscaled BEFORE #243, and
#: which [`make_downscaled_hires`] reproduces on demand.
#:
#: Measured, not guessed: the 200x200 PNG this repo carried until #243 is a BIT-IDENTICAL
#: `PIL.Image.Resampling.BICUBIC` 10x downscale of the vendor's own 2000x2000 emission (mean
#: absolute difference 0.000 across all three channels; every other PIL filter differs). So
#: the historical artifact is reconstructible exactly, which is what lets the negative
#: control below be the REAL thing rather than an approximation of it.
PRE_243_DOWNSCALE_FACTOR = 10

#: The sha256 of the artifact this repository actually shipped until #243 —
#: `git show origin/main:src-app/packages/spatial-import-visium/tests/fixtures/visium-outs/spatial/tissue_hires_image.png`
#: (a repo-root path; `git show <rev>:./<path>` also works from this directory).
#:
#: Pinned because the docstrings around [`make_downscaled_hires`] call its output a
#: BYTE-EXACT reconstruction, and until this constant existed nothing checked that: only the
#: output's DIMENSIONS were asserted, so swapping the resampling filter (or a Pillow/zlib
#: upgrade changing the encoder) would have left every test green while quietly turning the
#: negative control into an approximation of the historical artifact rather than the thing
#: itself. A claim that is load-bearing in five docstrings needs one assertion.
PRE_243_HIRES_SHA256 = "e58b4cd666143a04fbfd52ed1e96f6a43009d4545a58624f35591052991a97b4"


def hires_coverage(bundle_root=None):
    """Does this bundle's hires image cover this bundle's own spots? (#243)

    The one measurement #243 exists for. Returns a report rather than a bool, so a failing
    assertion can name WHICH spot fell out and by how much instead of just saying `False`.

    ## Why this reads the three files directly

    The CSV, the JSON and the PNG are parsed here with `csv`, `json` and PIL — deliberately
    NOT through `import_visium.read_positions`, `read_scalefactors` or `ome_writer.read_image`.
    This follows [`expected_xy`]'s rule: an expectation computed by the code under test cannot
    fail on that code being wrong. The importer's own affine is the thing whose premise this
    checks, so the check may not be built out of it.

    ## What "covers" means

    `x = pxl_col_in_fullres * tissue_hires_scalef` and `y = pxl_row_in_fullres *
    tissue_hires_scalef` — the transpose is explicit here for the same reason it is explicit
    in [`expected_xy`] — and the spot is inside when `0 <= x < width` and `0 <= y < height`.
    Half-open on purpose: `x == width` addresses no pixel. That matches the product's own
    convention (`registration_qc.score_registration`: `(xs >= 0) & (xs < width)`), so the
    independent check and the shipped code agree AT the boundary rather than near it.

    ## None of this function's conventions is visible on the committed bundle alone

    That image is SQUARE, nothing comes within 200 px of a far edge, nothing approaches the
    origin, and every bundle in the tree states the same scalefactor. So on the real data a
    transposed read, either bound comparison, and even IGNORING `scalefactors_json.json`
    entirely are all invisible — each was confirmed green by mutation before it was pinned.

    [`make_geometry_probe`] exists to make them falsifiable, and `test_image_coherence`
    drives this function over a non-square frame that separates the axes, over spots placed
    exactly on the far edge / at the origin / at negative coordinates, and over a bundle that
    restates its scalefactor. It then checks the whole predicate against the SHIPPED
    `registration_qc.score_registration`, which is the assurance the rest rests on: the
    conventions above are a mirror, and a mirror is only worth what it is compared to.

    ## Scope

    Reads the `>= 2.0` headered `tissue_positions.csv` spelling only. Every caller is the
    committed bundle or a copy of it, all of which are headered; the older headerless
    `tissue_positions_list.csv` is deliberately not handled here rather than shipped
    untested.
    """
    import csv
    import json as _json

    from PIL import Image

    # `bundle_root` defaults to the committed fixture; pass a bundle to measure that copy
    # instead (the probes and the downscaled reconstruction are read this way).
    root = Path(bundle_root) if bundle_root is not None else FIXTURE
    factors = _json.loads((root / "spatial" / "scalefactors_json.json").read_text())
    scalef = factors["tissue_hires_scalef"]
    with open(root / "spatial" / "tissue_positions.csv", newline="") as fh:
        rows = list(csv.DictReader(fh))
    with Image.open(root / "spatial" / "tissue_hires_image.png") as im:
        width, height = im.size

    outside = []
    for row in rows:
        x = float(row["pxl_col_in_fullres"]) * scalef
        y = float(row["pxl_row_in_fullres"]) * scalef
        if not (0 <= x < width and 0 <= y < height):
            outside.append({"barcode": row["barcode"], "x": x, "y": y})
    xs = [float(r["pxl_col_in_fullres"]) for r in rows]
    ys = [float(r["pxl_row_in_fullres"]) for r in rows]
    return {
        "scalef": scalef,
        "image_size": (width, height),
        "implied_fullres_frame": (width / scalef, height / scalef),
        "n_spots": len(rows),
        "n_inside": len(rows) - len(outside),
        "outside": outside,
        "fullres_x": (min(xs), max(xs)),
        "fullres_y": (min(ys), max(ys)),
    }


def make_downscaled_hires(tmp_path, factor=PRE_243_DOWNSCALE_FACTOR):
    """The bundle as it was BEFORE #243: real spots, real scalefactors, a SHRUNK image.

    A copy of the committed fixture whose `tissue_hires_image.png` is downscaled by `factor`
    with the same BICUBIC filter that produced the historical artifact, and whose
    `scalefactors_json.json` and `tissue_positions.csv` are left ALONE — which is precisely
    what makes it incoherent. Shrinking the image without restating the scalefactor is the
    whole bug: the number still claims the image is a 0.2x view of a 10000 px frame while the
    pixels now only span 1000.

    This exists so the incoherent case stays REACHABLE after the fixture is fixed. Two
    different suites need it and neither can use the shipped bundle any more:

    * `test_image_coherence` uses it as the discrimination proof — the same predicate that
      passes on the shipped bundle must FAIL here, or the passing leg proves nothing;
    * `test_registration_qc` uses it for "spots that miss the image are reported rather than
      scored", which until #243 was measured against the shipped fixture because the shipped
      fixture happened to be broken. Depending on a fixture's DEFECT for a negative case is
      how a bug becomes load-bearing; the defect is now constructed on purpose instead.
    """
    import shutil

    from PIL import Image

    dest = Path(tmp_path) / "downscaled-hires"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(FIXTURE, dest)
    target = dest / "spatial" / "tissue_hires_image.png"
    with Image.open(target) as im:
        shrunk = im.resize(
            (im.size[0] // factor, im.size[1] // factor),
            Image.Resampling.BICUBIC,
        )
    shrunk.save(target)
    return dest


def make_geometry_probe(tmp_path, *, image_size, name, extra_positions=(),
                        scalefactors_text=None):
    """A bundle copy with the hires image RESIZED to `image_size`, plus optional crafted rows.

    A GEOMETRY PROBE, not a fixture that claims to be anything: the pixels are irrelevant and
    the resize is deliberate, because the only thing under test is what
    [`hires_coverage`] computes from a `(width, height)` pair and a positions table.

    It exists because the committed bundle cannot falsify two of that function's stated
    conventions. The image is 2000x2000 and the spots span x in [220, 1382] and y in
    [566, 1734] after scaling, so:

    * **the transpose is invisible** — swapping `x` and `y`, or swapping `width` and
      `height`, changes no verdict on a square frame where both axes have room;
    * **the half-open bound is invisible** — nothing lands within 200 px of an edge, so
      `< width` and `<= width` agree everywhere.

    A non-square `image_size` separates the axes, and `extra_positions` (rows of
    `(barcode, pxl_row_in_fullres, pxl_col_in_fullres)`) can place a spot EXACTLY on an edge
    or past it.

    `scalefactors_text` replaces `scalefactors_json.json` wholesale, the way
    [`make_variant`] already does. That closes a third hole a blind audit found: hardcoding
    `scalef = 0.2` inside [`hires_coverage`] and never opening the JSON at all left every
    coherence test green, so "the scalefactor is READ FROM THE BUNDLE" — the first half of
    INV-1 — was unfalsifiable too.

    ## The crafted rows are geometry, and nothing else

    They carry a real `barcode` and real `pxl_*` values; `array_row`/`array_col` are assigned
    past the end of the vendor's grid so they collide with no real spot, and `in_tissue` is 0
    on EVERY crafted row — including the ones that land on the image — because these are
    geometry probes and no vendor tissue call applies to them. They are only meaningful to
    [`hires_coverage`]: nothing here makes them valid input to the importer or to
    `registration_qc`, which join on the matrix's barcodes and would drop them. Do not reuse
    this helper to drive those without revisiting that.
    """
    import csv
    import shutil

    from PIL import Image

    # `name` is REQUIRED and a collision RAISES rather than replacing. With a default name,
    # two probes in one test would silently alias to one directory: the second would destroy
    # and rebuild the first, both call sites would hold the same path, and a test comparing
    # "two different bundles" would compare one bundle with itself and pass. That is a green
    # test measuring nothing, which is the failure this whole suite exists to avoid.
    dest = Path(tmp_path) / name
    if dest.exists():
        raise AssertionError(
            f"a geometry probe named {name!r} already exists at {dest}. Two probes in one "
            "test must have different names, or they are the same bundle"
        )
    shutil.copytree(FIXTURE, dest)

    if scalefactors_text is not None:
        (dest / "spatial" / "scalefactors_json.json").write_text(scalefactors_text)

    target = dest / "spatial" / "tissue_hires_image.png"
    with Image.open(target) as im:
        im.resize(image_size, Image.Resampling.BICUBIC).save(target)

    # Materialised first: `if <generator>:` is truthy even when the generator is empty, so
    # the two spellings of "no extra rows" would otherwise produce different bundles — one
    # byte-identical to the vendor's CSV, one rewritten.
    extra_positions = tuple(extra_positions)
    if extra_positions:
        positions = dest / "spatial" / "tissue_positions.csv"
        with open(positions, newline="") as fh:
            rows = list(csv.reader(fh))
        header = [c.strip() for c in rows[0]]
        # Past the end of a Visium V1 grid (78 rows x 128 cols), so a crafted row cannot
        # collide with a real spot's array index. The vendor's own rows keep theirs.
        for offset, (barcode, row_fullres, col_fullres) in enumerate(extra_positions):
            record = dict.fromkeys(header, "0")
            record["barcode"] = barcode
            record["in_tissue"] = "0"
            record["array_row"] = str(1000 + offset)
            record["array_col"] = str(1000 + offset)
            record["pxl_row_in_fullres"] = str(row_fullres)
            record["pxl_col_in_fullres"] = str(col_fullres)
            rows.append([record[c] for c in header])
        with open(positions, "w", newline="") as fh:
            # LF, not `csv.writer`'s default CRLF: the vendor's own file is LF-only and this
            # helper's whole claim is that the result is that bundle plus some rows. Every
            # current reader opens with `newline=""` and would not notice, which is exactly
            # why it would have stayed wrong.
            csv.writer(fh, lineterminator="\n").writerows(rows)
    return dest


# ── the SHIPPED ENTRYPOINT, as a subprocess ──────────────────────────────────────────

#: The environment that really does give a CPython subprocess a non-UTF-8 preferred encoding on
#: this host: `PYTHONUTF8=0` turns PEP 540 off, `PYTHONCOERCECLOCALE=0` turns PEP 538's
#: C -> C.UTF-8 coercion off, and `LC_ALL=C`/`LANG=C` then yield `ANSI_X3.4-1968`. All four are
#: needed; drop any one and the subprocess is back in UTF-8 and a locale test proves nothing —
#: which is why the caller asserts the encoding it actually got before believing the result.
ASCII_LOCALE_ENV = {"PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "LC_ALL": "C", "LANG": "C"}


def run_entry(bundle_root, outputs_dir, *, slot="bundle", env=None, timeout=1800):
    """Run `compute/import_visium.py` as `main()` does in production — a SUBPROCESS, over the
    `CYTO_INPUTS_DIR`/`CYTO_OUTPUTS_DIR` seam, with a `/code`-shaped `PYTHONPATH`.

    A subprocess and not an in-process call, because `main()`'s refusal path is `sys.exit(2)`
    and because the sandbox runs it exactly this way: one entry file, the declared helpers
    beside it, and `_lib` staged in. Anything this driver can reach, the server can.

    `env` is merged over the inherited environment (after the two `CYTO_*` variables and
    `PYTHONPATH` are set), which is what lets an ASCII-locale run use THIS driver rather than a
    second copy of it — see [`ASCII_LOCALE_ENV`]. `timeout=` matches this package's subprocess
    convention: a hung child should fail the suite, not hang it.

    Lives here rather than in one test module (#330 / DEC-8) because two suites now drive the
    entrypoint — `test_vendor_formats.py` for the manifest the server reads, and
    `test_hostile_vendor_text.py` for the refusal path and the locale — and a second spelling of
    one driver is a driver that answers differently in two places. #336 added a THIRD
    (`test_refusal_escaping.py`); it needs the same invocation with the output captured as BYTES,
    so the staging is shared through [`_entry_invocation`] and only the capture mode differs.
    """
    import subprocess

    argv, child = _entry_invocation(bundle_root, outputs_dir, slot, env)
    return subprocess.run(argv, capture_output=True, text=True, env=child, timeout=timeout)


def run_entry_bytes(bundle_root, outputs_dir, *, slot="bundle", env=None, timeout=1800):
    r"""[`run_entry`], with stdout/stderr captured as **BYTES** (#336 / DEC-1).

    `text=True` DECODES, and decoding hides exactly the half of #336 that matters:

    * a raw `\r` and a raw `\x07` survive into the `str` but are invisible to every assertion a
      reader would naturally write against a decoded string;
    * a raw `\n` becomes an ordinary newline, indistinguishable from the message's own trailing
      one — and that raw `\n` IS the attack: `scheduler.rs::drain_logs` reads the compute's
      stderr with `BufReader::lines()` and writes EACH LINE as its own `job_logs` row, so a
      vendor-supplied newline forges a log row (MEASURED: a forged
      `spatial.import-visium: import SUCCEEDED` line);
    * a byte sequence that is not valid UTF-8 at all is silently replaced or raises, depending on
      the child's encoding, so the test measures the decoder rather than the compute.

    The control characters ARE the payload, so the payload must not be decoded away before the
    assertion sees it.
    """
    import subprocess

    argv, child = _entry_invocation(bundle_root, outputs_dir, slot, env)
    return subprocess.run(argv, capture_output=True, env=child, timeout=timeout)


def _entry_invocation(bundle_root, outputs_dir, slot, env):
    """The `/inputs` staging and the child environment both entrypoint drivers share.

    ONE spelling of the invocation, for the reason [`run_entry`]'s docstring already gives: a
    second copy is a driver that answers differently in two places, and the two would then differ
    in exactly the way that makes a refusal test prove nothing.
    """
    import os

    inputs = Path(outputs_dir).parent / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    (inputs / "params.json").write_text("{}")
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": slot, "kind": "dataset",
                    "sandbox_path": f"/inputs/{Path(bundle_root).name}"}]
    }))
    staged = inputs / Path(bundle_root).name
    if not staged.exists():
        staged.symlink_to(Path(bundle_root).resolve(), target_is_directory=True)

    child = dict(os.environ)
    child["CYTO_INPUTS_DIR"] = str(inputs)
    child["CYTO_OUTPUTS_DIR"] = str(outputs_dir)
    child["PYTHONPATH"] = os.pathsep.join([str(PKG / "compute"), str(PKG.parent / "_lib")])
    if env:
        child.update(env)
    return [sys.executable, str(COMPUTE)], child


# ── #327: staging two UNRELATED runs out of one real bundle ──────────────────────────
#
# Two copies of one fixture are — correctly — the same measurement, so after #327 they share a
# coordinate frame: the ladder's bottom rung is a digest of the vendor's own barcodes and the
# positions joined to them. A test that wants two UNRELATED runs therefore has to change the thing
# that makes them unrelated, and that is the MATRIX, not the directory it sits in. These three
# stagers are the sibling package's `stage_bundle` / `restage_cell_ids` / `shift_centroids`, over
# this platform's two files.


def stage_bundle(tmp_path, source=None, *, name="outs"):
    """A COPY of a fixture bundle, at a directory of your choosing.

    Copied rather than mutated in place: a test that writes into `tests/fixtures/` dirties tracked
    vendor bytes for every other suite in the process, and a `Ctrl-C` leaves them dirty.

    `name` DEFAULTS TO `outs` — Space Ranger's own output directory name, and the value the removed
    `bundle-directory-name` rung answered for a majority of real uploads. A stager that defaulted
    to a unique name would quietly help any test that still depended on the mount.
    """
    import shutil

    root = Path(tmp_path) / name
    root.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(Path(source or FIXTURE), root)
    return root


def restage_barcodes(root, suffix):
    """Give a staged bundle its OWN spot barcodes, in BOTH files that carry them (#327).

    `/matrix/barcodes` and `tissue_positions.csv`'s first column are JOINED by the importer — it
    REFUSES the run when a matrix barcode has no row — so both move together or nothing imports.
    The suffix is applied to every barcode, so they stay mutually distinct inside the run and
    differ from any other run's.
    """
    import csv

    import h5py
    import numpy as np

    root = Path(root)
    with h5py.File(root / "filtered_feature_bc_matrix.h5", "a") as handle:
        group = handle["matrix"]
        old = [b.decode() if isinstance(b, bytes) else str(b) for b in group["barcodes"][:]]
        renamed = [f"{o}{suffix}" for o in old]
        del group["barcodes"]
        group.create_dataset("barcodes",
                             data=np.array([r.encode() for r in renamed], dtype="S"))

    positions = root / "spatial" / "tissue_positions.csv"
    with open(positions, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    for row in rows[1:]:
        row[0] = f"{row[0]}{suffix}"
    with open(positions, "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    return root


def shift_positions(root, dx):
    """Move every spot by `dx` in the full-resolution X axis, leaving the BARCODES untouched (#327).

    The other half of `restage_barcodes`: two bundles that differ ONLY in geometry. The derived
    frame identity is over the barcodes AND the positions, so a test that makes its two runs
    unrelated by restaging barcodes alone can never notice whether the positions half is wired at
    all — which is exactly the gap a blind angle proved in the sibling package by replacing the
    call site's positions with zeros and watching the whole suite stay green.
    """
    import csv

    root = Path(root)
    positions = root / "spatial" / "tissue_positions.csv"
    with open(positions, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    column = [c.strip() for c in rows[0]].index("pxl_col_in_fullres")
    for row in rows[1:]:
        row[column] = repr(float(row[column]) + dx)
    with open(positions, "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    return root


def set_library_id_raw(root, value):
    """Write the matrix's `library_ids` root attribute EXACTLY as given — no `str`/`|S` coercion.

    The sibling of [`set_library_id`], which exists because that one cannot express the two shapes
    #327's repair is about: a NUMERIC attribute (`np.array([0])`) and a MULTI-ELEMENT one
    (`np.array([b"LibA", b"LibB"])`, which `spaceranger aggr` writes). Both are legal h5 attributes
    and both were being read as a stated frame identity; a stager that coerced them to a length-1
    byte string would have made the tests for that unwritable.
    """
    import h5py

    root = Path(root)
    with h5py.File(root / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs["library_ids"] = value
    return root


def set_library_id(root, value):
    """Write, or DELETE (`value is None`), the matrix's `library_ids` root attribute.

    Written as a fixed-length `|S` array, which is the shape the REAL fixture uses
    (`array([b'Visium_Mouse_Olfactory_Bulb'], dtype='|S27')`) — a stager that wrote a `str`
    attribute instead would exercise a different h5py decode path from the one every real bundle
    takes.
    """
    import h5py
    import numpy as np

    root = Path(root)
    with h5py.File(root / "filtered_feature_bc_matrix.h5", "r+") as handle:
        if value is None:
            handle.attrs.pop("library_ids", None)
        else:
            handle.attrs["library_ids"] = np.array([str(value).encode()], dtype="S")
    return root
