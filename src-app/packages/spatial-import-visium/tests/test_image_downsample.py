#!/usr/bin/env python3
# ruff: noqa
"""`spatial/image` is a DISPLAY DERIVATIVE — the downsample (#176, epic #151).

#155 built the image and REFUSED a source finer than the display cap, with a message that
named this issue: *"emitting it would require real downsampling — which this importer does
not do (#176 owns it)"*. These tests are that refusal turned into a downsample.

## What "lossless" has to mean here, and why it is four tests and not one

Downsampling changes pixel values BY DEFINITION, so "lossless" cannot mean "the bytes are
unchanged". It means four separable things, and they fail independently:

| claim | test |
|---|---|
| the ORIGINAL is preserved and a consumer can reach it | TEST-2 |
| the CODEC is lossless (inherited from #155, not weakened) | TEST-8 |
| every emitted pixel is a real AVERAGE of real measurements | TEST-4 |
| the DECLARED RESOLUTION describes the EMITTED pixels | TEST-3 |

The fourth is the one that ships green if nobody looks. A downsampled image whose declared
scale still describes the original passes every shape, type and conformance check this
system has, and every downstream micron measurement silently scales wrong by exactly the
factor. TEST-3 measures it FROM THE EMITTED FILE — reopening the OME-TIFF and reading level
0's real shape, the `cyto` payload and the OME header — rather than from the producer's own
variables, because a test that reads the producer's variables cannot fail on "the producer
wrote the wrong ones".

## The fixture, and why the shipped one cannot serve

Standard Visium images are ~4.41 µm/pixel against a 0.5 µm/pixel cap — nearly NINE TIMES
COARSER (it was ~3.74 µm/pixel and ~7x before #222 corrected the micron scale) — so on the
shipped fixture the downsample branch is unreachable and every assertion about it would pass
vacuously on a pass-through. `visium_fixtures.make_fine_imaged` is a bundle whose HIRES image
is 0.236 µm/pixel (built to sit near Xenium's real 0.2 µm/pixel morphology resolution, the
case design §8.3 says this exists for) and whose LOWRES is 0.788 — so ONE bundle drives BOTH
branches through ONE code path. TEST-16 asserts the fixture really has that property, independently
of the importer, so TEST-1/3/4 cannot be vacuous.

## What these tests CANNOT check, stated rather than implied

TEST-11 is the honest half. Every guard here reconciles the artifact with ITSELF; none can
see whether the micron scale the whole chain is derived FROM was right. A wrong
`spot_diameter_fullres` yields a different factor, a different pixel grid and a different
declared resolution, and BOTH artifacts pass every check this system has. That is the same
class #155's TEST-9 named for the affine, and #156's registration overlay is the only real
check on it.
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest
import tifffile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

PKG = Path(__file__).resolve().parents[1]
TYPES_PKG = PKG.parent / "spatial-types"

#: The two images the fine fixture drives, and which branch each takes. Written down as a
#: table so a test cannot silently assert the pass-through leg twice.
FINE_HIRES = "spatial-image-hires"
FINE_LOWRES = "spatial-image-lowres"


def _hash_tree(root):
    """`{relative path: sha256}` for every file under `root`."""
    out = {}
    for path in sorted(Path(root).rglob("*")):
        if path.is_file():
            out[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


@pytest.fixture(scope="module")
def fine(tmp_path_factory):
    """The REAL importer over a bundle whose hires image is FINER than the display cap.

    `write_manifest` is called too, so `outputs_dir` is the complete document the server
    consumes and the conformance leg can run the real gate rather than a stand-in.

    The bundle is hashed BEFORE the import so INV-2's "the bundle is retained" half is a
    measurement and not an inference from the sandbox's read-only mount.
    """
    bundle = VF.make_fine_imaged(tmp_path_factory.mktemp("fine-src"))
    before = _hash_tree(bundle)
    out = tmp_path_factory.mktemp("fine-out")
    module, entries = VF.run_over(bundle, out)
    module.write_manifest(out, entries)
    return {"module": module, "entries": entries, "out": out, "bundle": bundle,
            "hashes_before": before}


def entry(fine, output_id):
    return VF.entry_by_id(fine["entries"], output_id)


def level0(fine, output_id):
    """The EMITTED pixels, read back out of the written OME-TIFF."""
    with tifffile.TiffFile(fine["out"] / entry(fine, output_id)["path"]) as tf:
        return tf.series[0].levels[0].asarray()


def vendor_pixels(fine, basename):
    """The vendor's own image, decoded independently of the importer."""
    from PIL import Image

    with Image.open(fine["bundle"] / "spatial" / basename) as im:
        return np.asarray(im.convert("RGB"))


def modules():
    """`(SD, OW)` staged the way the sandbox stages them."""
    VF.load_compute()
    return sys.modules["spatial_declarations"], sys.modules["ome_writer"]


# ── TEST-16 — the fixture is what it claims, or every other test is vacuous ───────────


def test_the_fine_fixture_really_is_finer_than_the_cap_and_non_square():
    """TEST-16 [covers: ITEM-13] — the control that stops TEST-1/3/4 passing on nothing.

    Computed from the fixture's own `scalefactors_json.json` and the vendor spot diameter,
    parsed here rather than taken from the importer — if this arithmetic came from the code
    under test it would agree with itself by construction. The numerator is the RENDERED spot
    diameter (65 um, #222), because that is the circle `spot_diameter_fullres` measures; it is
    retyped rather than imported for the same independence reason, and it is NOT the 55 um
    capture footprint the artifact declares as its `resolution_um`.

    Without this, a fixture that quietly stayed COARSER than the cap would make every
    downsample assertion below pass on a pass-through, and the whole file would be green
    while testing nothing. That is the "what independent observation distinguishes 'it
    passed' from 'it never ran'" question, answered.
    """
    SD, _ = modules()
    factors = json.loads(VF.fine_scalefactors_text())
    mpp = 65.0 / factors["spot_diameter_fullres"]

    hires_um = mpp / factors["tissue_hires_scalef"]
    lowres_um = mpp / factors["tissue_lowres_scalef"]
    cap = SD.DEFAULT_RESOLUTION_CAP_UM

    assert hires_um < cap, (
        f"the fine fixture's hires image is {hires_um} um/pixel, which is NOT finer than "
        f"the {cap} um/pixel cap — the downsample branch is unreachable and every "
        "assertion about it in this file is vacuous"
    )
    assert lowres_um > cap, (
        f"the fine fixture's lowres image is {lowres_um} um/pixel, which is not COARSER "
        "than the cap — the pass-through control in TEST-1 is not a control"
    )
    # The factor this fixture is built to produce, derived here rather than imported.
    import math
    assert math.ceil(cap / hires_um) == VF.FINE_EXPECTED_FACTOR

    # NON-SQUARE, and non-square AFTER the downsample too — a square grid passes a
    # transposed extent silently, and the emitted grid is a different grid from the source.
    src_w = int(round(VF.IMAGED_FULLRES_W * factors["tissue_hires_scalef"]))
    src_h = int(round(VF.IMAGED_FULLRES_H * factors["tissue_hires_scalef"]))
    assert src_w != src_h
    assert src_w // VF.FINE_EXPECTED_FACTOR != src_h // VF.FINE_EXPECTED_FACTOR


# ── TEST-1 [acceptance] [invariant: INV-1] — the downsample happens, end to end ───────


def test_a_finer_than_cap_image_is_downsampled_and_a_coarser_one_passes_through(fine):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-3, ITEM-6, ITEM-13].

    INV-1: *"The image is a display derivative. Downsample to a declared resolution cap,
    lossless, original preserved."*

    Driven through the REAL `run_import`, and both branches are asserted in ONE assertion
    over ONE bundle — so this proves one code path does both things, rather than one thing
    twice. The emitted grid is compared against the VENDOR FILE's own grid, decoded here,
    not against a number the producer reported.
    """
    hires = entry(fine, FINE_HIRES)
    prov = hires["meta"]["display_derivative"]

    # THE DOWNSAMPLE HAPPENED, measured on the pixels.
    src = vendor_pixels(fine, "tissue_hires_image.png")
    emitted = level0(fine, FINE_HIRES)
    assert emitted.shape[0] < src.shape[0] and emitted.shape[1] < src.shape[1], (
        f"the emitted image is {emitted.shape} and the vendor's is {src.shape} — nothing "
        "was downsampled"
    )
    assert prov["downsampled"] is True
    assert prov["downsample_factor"] == VF.FINE_EXPECTED_FACTOR
    assert emitted.shape[:2] == (src.shape[0] // VF.FINE_EXPECTED_FACTOR,
                                 src.shape[1] // VF.FINE_EXPECTED_FACTOR)

    # THE CAP IS MET, and the recorded resolution is the one the pixels HAVE — not the cap.
    # An integer factor overshoots (0.2 x 3 = 0.6, not 0.5), and recording the cap would
    # state a resolution these pixels do not have.
    assert prov["applied_resolution_um"] >= prov["resolution_cap_um"], "finer than the cap"
    assert prov["applied_resolution_um"] == pytest.approx(
        prov["original_resolution_um"] * prov["downsample_factor"], rel=1e-12
    )
    assert prov["applied_resolution_um"] != prov["resolution_cap_um"], (
        "the applied resolution IS the cap, which on this fixture means it was asserted "
        "rather than achieved"
    )

    # THE PASS-THROUGH CONTROL, in the same run of the same code.
    lowres = entry(fine, FINE_LOWRES)
    low_prov = lowres["meta"]["display_derivative"]
    low_src = vendor_pixels(fine, "tissue_lowres_image.png")
    low_emitted = level0(fine, FINE_LOWRES)
    assert low_prov["downsampled"] is False and low_prov["downsample_factor"] == 1
    assert low_emitted.shape == low_src.shape, "a coarser-than-cap image was resampled"
    assert np.array_equal(low_emitted, low_src), (
        "a pass-through image's pixels are not bit-identical to the vendor's"
    )
    # Computed from the VENDOR's own numbers rather than from the block being checked:
    # `applied == original` is ENTAILED by `factor == 1` asserted three lines above, so
    # comparing the block's two fields to each other cannot fail on any defect this message
    # names. The independent expectation is the fixture's own arithmetic.
    factors = json.loads(VF.fine_scalefactors_text())
    # 65.0, not 55.0: the RENDERED circle `spot_diameter_fullres` measures (#222).
    expected_low_um = (65.0 / factors["spot_diameter_fullres"]) / factors[
        "tissue_lowres_scalef"]
    assert low_prov["applied_resolution_um"] == pytest.approx(expected_low_um, rel=1e-9), (
        "a coarser-than-cap image was UPSAMPLED to the cap"
    )
    assert low_prov["applied_resolution_um"] > low_prov["resolution_cap_um"]

    # …and the artifact still clears the REAL gate the server applies at ingest.
    import conformance

    violations = conformance.conform_outputs(fine["out"], full=True)
    assert violations == [], violations
    manifest = json.loads((fine["out"] / "manifest.json").read_text())
    gated = {e["id"] for e in manifest["outputs"] if e["datatype"] == "spatial/image"}
    assert gated == {FINE_HIRES, FINE_LOWRES}, gated


# ── TEST-2 [acceptance] [invariant: INV-2] — the original is preserved AND reachable ──


def test_the_source_the_pixels_came_from_is_preserved_and_a_consumer_reaches_it(fine):
    """TEST-2 [acceptance] [invariant: INV-2] [covers: ITEM-7, ITEM-8].

    INV-2, from `spatial/visium-bundle`'s own declaration: *"The bundle is retained after
    import, so the vendor's own image files stay recoverable"* — which that declaration now
    also says explicitly is NOT the instrument's pixels, because Space Ranger ships no
    full-resolution image (`tissue_hires_image.png` is 10x's own 0.2x downscale). What is
    preserved and reachable is the SOURCE this derivative was built from, and this test
    asserts exactly that and no more.

    Two halves, and BOTH are required — a pointer nobody can follow does not make anything
    recoverable:

    1. PRESERVED — every bundle member is byte-identical after the import. Hashed before
       and after, because "the sandbox mounts `/inputs` read-only" is an inference about
       the runtime, not an observation of this code.
    2. REACHABLE — `require_original_reference` is followed from the emitted artifact's own
       recorded provenance to a member that EXISTS in the bundle, DECODES, and has exactly
       the grid the provenance recorded.
    """
    SD, _ = modules()

    # 1 — PRESERVED.
    after = _hash_tree(fine["bundle"])
    assert after == fine["hashes_before"], (
        "the import changed the uploaded bundle: "
        f"{set(after.items()) ^ set(fine['hashes_before'].items())}"
    )

    # 2 — REACHABLE, for the downsampled image (the case where it matters).
    meta = entry(fine, FINE_HIRES)["meta"]
    ref = SD.require_original_reference(meta, consumer="an intensity readout")

    original = fine["bundle"] / "spatial" / ref["member"]
    assert original.is_file(), (
        f"the provenance points at {ref['member']!r}, which is not in the retained bundle"
    )
    from PIL import Image

    with Image.open(original) as im:
        arr = np.asarray(im.convert("RGB"))
    assert {"width": arr.shape[1], "height": arr.shape[0]} == ref["extent"], (
        "the preserved original's grid is not the one the provenance recorded"
    )

    # It really IS the original and not the derivative wearing its name.
    emitted = level0(fine, FINE_HIRES)
    assert arr.shape[0] > emitted.shape[0] and arr.shape[1] > emitted.shape[1]
    assert ref["downsample_factor"] == VF.FINE_EXPECTED_FACTOR
    assert ref["resolution_um"] == meta["display_derivative"]["original_resolution_um"]
    assert ref["resolution_um"] < meta["display_derivative"]["applied_resolution_um"]

    # And the pass-through image points at its own source, not the hires one — the pointer
    # is per-image, which a single-image assertion could not show.
    low_ref = SD.require_original_reference(entry(fine, FINE_LOWRES)["meta"],
                                            consumer="an intensity readout")
    assert low_ref["member"] == "tissue_lowres_image.png"
    assert low_ref["member"] != ref["member"]

    # THE REFUSAL HALF, which belongs here rather than only in TEST-5: an image carrying no
    # provenance must REFUSE, not hand back the derived raster with an implicit promise that
    # it is the source. "Unknown" is not "untouched".
    stripped = {k: v for k, v in meta.items() if k != "display_derivative"}
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        SD.require_original_reference(stripped, consumer="an intensity readout")
    assert "an intensity readout" in str(exc.value)
    # …and a PARTIAL block refuses as this module's own error type, not as a KeyError a
    # consumer catching the declared type would miss entirely.
    partial = dict(meta, display_derivative={"original_source": ref["member"]})
    with pytest.raises(SD.SpatialDeclarationError):
        SD.require_original_reference(partial, consumer="an intensity readout")

    # AND THE SANDBOXED CONSUMER CAN DO THIS TOO. For an `opaque` kind the OME-XML payload
    # is the only channel that reaches inside the sandbox, so a reference that worked only
    # from the catalog `meta` would be unreachable by the consumer it was written for.
    with tifffile.TiffFile(fine["out"] / entry(fine, FINE_HIRES)["path"]) as tf:
        from_bytes = SD.require_placement(tf.ome_metadata, consumer="a spatial analysis")
    assert SD.require_original_reference(
        from_bytes, consumer="an intensity readout") == ref, (
        "the reference is reachable from the catalog but NOT from the bytes, which is the "
        "only channel a sandboxed consumer of an opaque artifact has"
    )


# ── TEST-3 [acceptance] [invariant: INV-4] — THE SCALE-AFTER-DOWNSAMPLE PROOF ─────────


def test_the_declared_scale_describes_the_emitted_pixels_not_the_original(fine):
    """TEST-3 [acceptance] [invariant: INV-4] [covers: ITEM-1, ITEM-5].

    INV-4, verbatim: *"A downsampled image whose `microns_per_pixel` still describes the
    original is worse than no downsampling: every downstream micron measurement silently
    scales wrong."*

    **Every number here comes out of the EMITTED FILE**, never out of the producer's
    variables: level 0's real shape, the `cyto` placement parsed from the file's own
    OME-XML, and `PhysicalSizeX` read from the OME header. A test that read the producer's
    variables could not fail on "the producer wrote the wrong ones", which is the entire
    defect this pins.

    Four routes describe the same pixel pitch. They are set on four different lines of
    `emit_images`, so dropping the factor from any ONE of them is a real, reachable
    mistake:

    | fact | route |
    |---|---|
    | `arr.shape` | the pixels themselves |
    | `emitted_extent` | `original_extent // downsample_factor` |
    | `to_space[0] * microns_per_pixel` | the affine and the SPACE's scale |
    | `PhysicalSizeX` | the OME header a generic reader measures with |
    """
    SD, _ = modules()
    path = fine["out"] / entry(fine, FINE_HIRES)["path"]

    with tifffile.TiffFile(path) as tf:
        pixels = tf.series[0].levels[0].asarray()
        ome_xml = tf.ome_metadata
    # `PhysicalSizeX` STRAIGHT OUT OF THE OME-XML, which is what a generic OME reader — one
    # that knows nothing about the `cyto` payload — reads. Parsed here rather than taken
    # from tifffile's own convenience accessor so this leg is an independent read of the
    # bytes the producer wrote.
    import xml.etree.ElementTree as ET

    pixels_el = ET.fromstring(ome_xml).find(
        ".//{http://www.openmicroscopy.org/Schemas/OME/2016-06}Pixels"
    )
    ome_scale = (float(pixels_el.get("PhysicalSizeX"))
                 if pixels_el is not None and pixels_el.get("PhysicalSizeX") else None)
    ome_scale_y = (float(pixels_el.get("PhysicalSizeY"))
                   if pixels_el is not None and pixels_el.get("PhysicalSizeY") else None)

    # The placement as a SANDBOXED consumer gets it — out of the bytes, not out of the
    # manifest. This is the copy that reaches an `opaque` artifact's only reader.
    placement = SD.require_placement(ome_xml, consumer="the scale proof")
    prov = entry(fine, FINE_HIRES)["meta"]["display_derivative"]

    # The fixture really downsampled, so nothing below passes because nothing moved.
    assert prov["downsampled"] is True
    assert prov["applied_resolution_um"] != prov["original_resolution_um"]

    # ROUTE 1 vs ROUTE 2 — the declared grid IS the emitted grid.
    assert placement["extent"] == {"width": pixels.shape[1], "height": pixels.shape[0]}
    assert prov["emitted_extent"] == placement["extent"]
    assert prov["emitted_extent"] == {
        "width": prov["original_extent"]["width"] // prov["downsample_factor"],
        "height": prov["original_extent"]["height"] // prov["downsample_factor"],
    }

    # ROUTE 3 — THE AFFINE ABSORBED THE FACTOR. `to_space[0] * microns_per_pixel` is the
    # physical size of one EMITTED pixel, derived from the placement alone. If the pixels
    # were downsampled and the affine left at `1/scalefactor`, this is the only thing in
    # the system that notices.
    implied_x = placement["to_space"][0] * placement["microns_per_pixel"]
    implied_y = placement["to_space"][4] * placement["microns_per_pixel"]
    assert implied_x == pytest.approx(prov["applied_resolution_um"], rel=1e-9)
    assert implied_y == pytest.approx(prov["applied_resolution_um"], rel=1e-9)
    # …and it is NOT the original's pitch, which is what an unfolded affine would give.
    assert implied_x != pytest.approx(prov["original_resolution_um"], rel=1e-6)

    # ROUTE 4 — the OME header, which is what a generic OME reader (one that knows nothing
    # about the `cyto` payload) measures with.
    assert ome_scale is not None, "no OME PhysicalSize was written"
    assert ome_scale == pytest.approx(prov["applied_resolution_um"], rel=1e-9)
    assert ome_scale_y == pytest.approx(prov["applied_resolution_um"], rel=1e-9)
    # …and NOT the original's pitch, which is what a producer that forgot to update this
    # would have written. A generic OME reader would then measure everything wrong by
    # exactly the downsample factor.
    assert ome_scale != pytest.approx(prov["original_resolution_um"], rel=1e-6)

    # THE GEOMETRIC END-TO-END LEG. A marker painted at a known FULL-RESOLUTION position is
    # located IN THE EMITTED PIXELS and pushed back through the emitted affine. Recomputing
    # `round(XY * scalef / factor)` would reproduce what the fixture did and leave the image
    # content free; reading it out of the file makes this a real round trip.
    bright = np.argwhere(pixels[:, :, 0] == 255)
    assert bright.size, "the marker is not present in the emitted pixels"
    assert bright.shape[0] < pixels[:, :, 0].size * 0.01, (
        f"{bright.shape[0]} saturated pixels is not a marker"
    )
    row, col = bright.mean(axis=0)
    a, b, tx, c, d, ty = placement["to_space"]
    placed = (a * col + b * row + tx, c * col + d * row + ty)

    truth = VF.IMAGED_MARKER_XY
    a_scale = placement["to_space"][0]

    # THE EXACT FINGERPRINT, not a tolerance — and the history is why.
    #
    # This leg previously asserted `|placed - truth| <= tol`, and the tolerance was WIDENED
    # from 0.3 to 1.0 emitted pixels in the same commit that changed the pixel-anchor
    # convention. That is the "tolerance tuned until it passed" failure this file warns
    # about elsewhere, committed here: at the tighter bound the SHIPPED corner convention
    # fails (y residual 7.5 > 4.5) and the REJECTED centre convention passes (2.5, 2.5).
    # A bound that admits the implementation and excludes its alternative is not a
    # measurement of correctness; it is a restatement of the choice.
    #
    # So the residual is PINNED EXACTLY instead. Both conventions' fingerprints are written
    # down, this asserts the shipped one, and any change to the affine — including adopting
    # the alternative — turns it red with the other fingerprint in the message.
    #
    #   CORNER  (shipped, no translation)     -> (4897.5, 2692.5), residual (-2.5, -7.5)
    #   CENTRE  (rejected, tx = (f-1)/(2s))   -> (4902.5, 2697.5), residual (+2.5, -2.5)
    #
    # **The measurement favours CENTRE** (total error 3.54 vs 7.91), and the structural
    # argument favours CORNER (`ImageWorldBounds` is corner-anchored and this affine
    # composes as a whole-image modelMatrix over it). Neither is decisive, `to_space` has no
    # consumer in the tree, and the marker centroid is not a precise enough instrument to
    # arbitrate half a pixel — the saturated blocks are not symmetric about the marker on
    # x, which is why the two residuals differ per axis at all. Recorded as DEC-14 and
    # ESCALATED; #158 must settle it against a real renderer.
    centre_tx = a_scale * (prov["downsample_factor"] - 1) / (2 * prov["downsample_factor"])
    corner_placed = (a_scale * col, a_scale * row)
    centre_placed = (corner_placed[0] + centre_tx, corner_placed[1] + centre_tx)
    assert placed == pytest.approx(corner_placed, rel=1e-9), (
        f"the emitted affine no longer places the marker at the CORNER-convention "
        f"fingerprint {corner_placed}. The CENTRE convention would give {centre_placed}. "
        "If this changed deliberately, change DEC-14 and TEST-13 with it."
    )

    # THE CONTROL, because a fingerprint nothing can miss is not a check: an affine that
    # ignored the downsample factor entirely is off by orders of magnitude, so this leg
    # really does detect the defect it primarily exists for.
    def total_error(a):
        return math.hypot(a * col - truth[0], a * row - truth[1])

    assert total_error(a_scale / prov["downsample_factor"]) > total_error(a_scale) * 5, (
        "an affine that ignored the downsample factor is not clearly worse than the "
        "shipped one, so this leg cannot detect the defect it is here for"
    )
    # …and the shipped affine really does land within ONE emitted pixel of the truth, which
    # is the most the instrument supports and is the claim TESTS.md makes.
    assert abs(placed[0] - truth[0]) <= a_scale and abs(placed[1] - truth[1]) <= a_scale


# ── TEST-4 [acceptance] [invariant: INV-3] — real averages, not decimation ────────────


def test_the_emitted_pixels_are_the_box_mean_of_the_source(fine):
    """TEST-4 [acceptance] [invariant: INV-3] [covers: ITEM-2].

    INV-3, verbatim: *"Downsampling and lossy compression are not the same thing:
    downsampling produces fewer, larger pixels, each a real average of real measurements,
    while lossy compression keeps the pixel count and invents the values."*

    Decimation is on NEITHER side of that line — it keeps real values but discards most of
    them — and it is invisible to every other check in this file: same shape, same extent,
    same factor, same affine, same provenance. The only thing that separates it from a box
    mean is the pixel bytes, so this test compares them, recomputing the expected mean here
    from the VENDOR file rather than from the resampler under test.
    """
    factor = VF.FINE_EXPECTED_FACTOR
    src = vendor_pixels(fine, "tissue_hires_image.png")
    emitted = level0(fine, FINE_HIRES)

    h, w = src.shape[0] // factor, src.shape[1] // factor
    clipped = src[: h * factor, : w * factor]
    blocks = clipped.reshape(h, factor, w, factor, src.shape[2])
    expected = np.rint(blocks.mean(axis=(1, 3))).astype(src.dtype)
    assert np.array_equal(emitted, expected), (
        "the emitted pixels are not the box mean of the vendor source"
    )

    # …and the decimated alternative is genuinely DIFFERENT on this fixture, so the
    # assertion above can tell averaging from decimation rather than passing on an image
    # smooth enough that they agree.
    decimated = src[::factor, ::factor][:h, :w]
    assert not np.array_equal(decimated, expected), (
        "decimation and the box mean agree on this fixture, so the assertion above cannot "
        "tell them apart — the fixture needs more local contrast"
    )

    # TRUNCATION vs ROUNDING, which is a one-word difference that biases every emitted
    # pixel darker. Asserted to matter on this fixture before being asserted to be absent.
    truncated = blocks.mean(axis=(1, 3)).astype(src.dtype)
    assert not np.array_equal(truncated, expected), (
        "truncation and rounding agree on this fixture, so the rounding is unproven"
    )
    assert np.array_equal(emitted, expected), "the resampler truncates instead of rounding"


# ── TEST-5 [acceptance] [invariant: INV-5] — never fabricate a scale ──────────────────


def test_an_unknown_micron_scale_downsamples_nothing_and_fabricates_nothing(
    tmp_path_factory,
):
    """TEST-5 [acceptance] [invariant: INV-5] [covers: ITEM-6, ITEM-7].

    INV-5, verbatim: *"Never fabricate a scale. An unknown micron scale must stay
    expressible and a consumer needing microns must refuse, not assume 1.0."*

    #176 adds a new place a 1.0 could appear. The cap is compared against a resolution
    derived FROM the space's micron scale, so a bundle with no scale has no resolution to
    compare — and the tempting shortcut is to assume 1.0 µm/pixel, which on this fixture
    would downsample nothing (1.0 > 0.5) and therefore look completely fine while having
    invented the number that decided it.
    """
    SD, _ = modules()
    # The vendor's file with BOTH scale legs removed — neither `microns_per_pixel` nor
    # `spot_diameter_fullres`, which is `micron_scale`'s "unavailable" leg.
    factors = json.loads(VF.fine_scalefactors_text())
    factors.pop("spot_diameter_fullres", None)
    factors.pop("microns_per_pixel", None)
    bundle = VF.make_fine_imaged(tmp_path_factory.mktemp("noscale-src"),
                                 scalefactors_text=json.dumps(factors))
    out = tmp_path_factory.mktemp("noscale-out")
    module, entries = VF.run_over(bundle, out)

    images = [e for e in entries if e["datatype"] == "spatial/image"]
    assert images, "no image was emitted, so this proves nothing about the scale path"
    for e in images:
        meta = e["meta"]
        # NO provenance block, because the resolution could never be evaluated. Absence
        # stays absence — an "untouched" block would claim the cap was checked.
        assert "display_derivative" not in meta, (
            f"{e['id']} carries display-derivative provenance with no micron scale, so the "
            "resolution in it was invented"
        )
        assert "microns_per_pixel" not in meta
        with pytest.raises(SD.SpatialDeclarationError):
            SD.require_micron_scale(meta, consumer="a neighbour graph")
        # And the new #176 consumer refuses too — "unknown" is not "untouched", so it will
        # not hand back this raster as if it were the source.
        with pytest.raises(SD.SpatialDeclarationError):
            SD.require_original_reference(meta, consumer="an intensity readout")

    # THE REPORT SPELLS ABSENCE BY OMITTING THE KEY, not by writing null. The rest of this
    # package is scrupulous about that (`image_meta` omits it; the assertion above checks
    # `not in`), and the report was the one place a consumer would have seen `null` and had
    # to know it meant the same thing. Pinned here because a 10-line comment arguing for it
    # was, until now, the only thing holding it.
    report_early = json.loads((out / "visium-import-report.json").read_text())
    for row in report_early["images"]:
        assert "display_derivative" not in row, (
            f"the report row for {row['id']} carries an explicit null where the rest of "
            "this package spells absence by the key's absence"
        )
    assert report_early["images"], "no image rows, so the assertion above is vacuous"

    # 1.0 appears NOWHERE as a scale.
    blob = json.dumps([e["meta"] for e in images])
    assert '"microns_per_pixel": 1.0' not in blob
    assert '"applied_resolution_um"' not in blob

    # And it is SAID OUT LOUD in the artifact a human reads, so "coarse, checked, passed
    # through" and "resolution unknown, never checked" are distinguishable.
    report = json.loads((out / "visium-import-report.json").read_text())
    assert any("could NOT be evaluated" in w for w in report["image_warnings"]), (
        report["image_warnings"]
    )


# ── TEST-6 [acceptance] [invariant: INV-6] — one bad image costs only itself ──────────


def test_a_failing_downsample_costs_only_its_own_image(fine, tmp_path_factory,
                                                       monkeypatch):
    """TEST-6 [acceptance] [invariant: INV-6] [covers: ITEM-6].

    INV-6, verbatim: *"Losing one image must never cost the matrix, the coordinates, the
    columns and the report."*

    #176 introduces a NEW allocation inside the per-image body — the reshape and the
    reduction in `downsample` — and a large plane can raise `MemoryError` there.
    `MemoryError` is NOT in `emit_images`' `except` tuple, so an uncaught one aborts the
    whole import over a single image.

    The failure is INJECTED rather than provoked with a huge array, deliberately: #155
    recorded that the natural repro is machine-dependent (on a large-memory box numpy
    reports `ValueError` first), and a machine-dependent gate is no gate. Injection pins
    the behaviour on every box.
    """
    VF.load_compute()
    OW = sys.modules["ome_writer"]

    # FIRST, the taxonomy claim on its own: an allocation failure INSIDE the resampler
    # leaves it as `ImageConversionError` and not as `MemoryError`. That conversion is the
    # whole reason the import survives, so it is asserted directly rather than inferred
    # from the end-to-end result below.
    class _Exploding(np.ndarray):
        def reshape(self, *args, **kwargs):
            raise MemoryError("injected: the resample allocation failed")

    victim = np.zeros((30, 30, 3), dtype=np.uint8).view(_Exploding)
    with pytest.raises(OW.ImageConversionError) as exc:
        OW.downsample(victim, 3)
    assert "MemoryError" in str(exc.value), (
        "the operator cannot tell a resource problem from a data one"
    )
    # A real bug must still NOT be laundered into a plain refusal by that same handler
    # being reached with a nonsense factor — the factor check fires before the try.
    with pytest.raises(OW.ImageConversionError):
        OW.downsample(np.zeros((9, 9), dtype=np.uint8), 1.5)

    # NOW end to end. The array is injected at `read_image` so it flows into the REAL
    # `downsample` and fails inside its own handler — patching `downsample` itself would
    # bypass the very conversion under test. Only the hires image is poisoned, so the
    # lowres one is a live control rather than an idle one.
    real_read = OW.read_image

    def exploding_read(path):
        arr = real_read(path)
        if Path(path).name == "tissue_hires_image.png":
            return arr.view(_Exploding)
        return arr

    monkeypatch.setattr(OW, "read_image", exploding_read)

    bundle = VF.make_fine_imaged(tmp_path_factory.mktemp("boom-src"))
    out = tmp_path_factory.mktemp("boom-out")
    module = sys.modules["spatial_import_visium_entry"]
    entries = module.run_import(Path(bundle), Path(out))
    module.write_manifest(out, entries)

    ids = {e["id"] for e in entries}
    # EVERYTHING ELSE SURVIVED.
    assert "expression" in ids or any(e["datatype"] == "single-cell/counts"
                                      for e in entries), sorted(ids)
    assert any(e["datatype"] == "spatial/coordinates" for e in entries), sorted(ids)
    assert any(e["datatype"] == "metadata-column" for e in entries), sorted(ids)
    assert any(e["datatype"].startswith("report/") for e in entries), sorted(ids)

    # The downsampling image is GONE and NAMED; the pass-through one is still here.
    assert FINE_HIRES not in ids, "the image whose resample exploded was still emitted"
    assert FINE_LOWRES in ids, "a failing resample cost an image it never touched"

    report = json.loads((out / "visium-import-report.json").read_text())
    named = " ".join(report["images_not_emitted"])
    assert "tissue_hires_image.png" in named, report["images_not_emitted"]
    assert "MemoryError" in named, (
        "the operator cannot tell a resource problem from a data one: "
        f"{report['images_not_emitted']}"
    )
    # NEVER BOTH. An image in `entries` and in `images_not_emitted` at once is the exact
    # defect the two channels were split to remove.
    emitted_sources = {e["meta"].get("source") for e in entries
                       if e["datatype"] == "spatial/image"}
    assert "tissue_hires_image.png" not in emitted_sources
    # …and the artifact for it was not left on disk either.
    assert not (out / f"{FINE_HIRES}.ome.tif").exists()
    assert not list(out.glob("*.partial"))

    import conformance

    assert conformance.conform_outputs(out, full=True) == []


# ── TEST-9 — the reconciliation guard, leg by leg ─────────────────────────────────────


def test_the_writer_refuses_every_way_the_scale_can_be_left_behind(fine, tmp_path):
    """TEST-9 [covers: ITEM-5] — each dropped update, and the positive control.

    `write_ome_tiff` is the one place the EMITTED PIXELS and the DECLARATION that describes
    them are both in scope, which is why the check lives there. Four facts move together
    when a downsample happens and they are set on four different lines of `emit_images`, so
    each of these is a real, reachable mistake rather than a hypothetical one.

    Every case below is built by TAKING THE REAL, CORRECT placement this import produced
    and changing ONE thing — so a case that passes cannot be passing because the placement
    was malformed in some other way.
    """
    SD, OW = modules()
    meta = entry(fine, FINE_HIRES)["meta"]
    arr = level0(fine, FINE_HIRES)
    prov = meta["display_derivative"]
    applied = prov["applied_resolution_um"]
    factor = prov["downsample_factor"]

    # THE POSITIVE CONTROL, first — if this did not write, every refusal below would be
    # indistinguishable from "the fixture is broken".
    written = OW.write_ome_tiff(tmp_path / "control.ome.tif", arr, placement=meta,
                                image_microns_per_pixel=applied)
    assert written.is_file() and written.stat().st_size > 0

    def refuses(what, placement, ome_scale=applied):
        with pytest.raises(SD.SpatialDeclarationError) as exc:
            OW.write_ome_tiff(tmp_path / f"{what}.ome.tif", arr, placement=placement,
                              image_microns_per_pixel=ome_scale)
        assert not (tmp_path / f"{what}.ome.tif").exists(), (
            f"{what}: the refusal still left a file behind"
        )
        return str(exc.value)

    # (a) THE AFFINE WAS NOT FOLDED — the pixels were downsampled and `to_space` was left
    # at `1/scalefactor`. Every spot drawn on this image lands `factor` times too close to
    # the origin, and nothing else in the system notices.
    unfolded = dict(meta, to_space=[v / factor for v in meta["to_space"]])
    assert "silently" in refuses("unfolded-affine", unfolded)

    # (b) THE EMITTED GRID WAS LEFT AT THE SOURCE'S. The provenance then describes pixels
    # that are not the ones in the file.
    stale = dict(meta, display_derivative=dict(prov,
                                               emitted_extent=dict(prov["original_extent"])))
    refuses("stale-emitted-extent", stale)

    # (c) THE FACTOR IS OFF BY ONE — the grid no longer is the source grid divided by it.
    off_by_one = dict(meta,
                      display_derivative=dict(prov, downsample_factor=factor + 1))
    refuses("off-by-one-factor", off_by_one)

    # (c2) …and a factor that is not a usable integer at all. This function's own docstring
    # says it re-derives BECAUSE a hand-built block can reach it, and these are exactly the
    # hand-built blocks: 0 raised `ZeroDivisionError` and a string raised `TypeError`,
    # neither of which is `SpatialDeclarationError` and neither of which `emit_images`
    # catches — so a bad declaration aborted the whole import from inside the one function
    # whose job is to refuse it cleanly.
    for bad in (0, -1, "3", None, 1.5, True):
        refuses(f"factor-{bad!r}",
                dict(meta, display_derivative=dict(prov, downsample_factor=bad)))

    # (d) THE OME HEADER KEPT THE PRE-DOWNSAMPLE PITCH. A generic OME reader — one that
    # knows nothing about the `cyto` payload — would measure everything wrong by `factor`.
    assert "outside this system" in refuses(
        "stale-ome-scale", meta, ome_scale=prov["original_resolution_um"]
    )

    # (e) THE TWO ABSENCE CASES MUST AGREE, or "no provenance" becomes a way to skip this
    # check entirely: provenance without a space scale, and an OME scale without provenance.
    no_space_scale = {k: v for k, v in meta.items() if k != "microns_per_pixel"}
    refuses("provenance-without-space-scale", no_space_scale)
    no_prov = {k: v for k, v in meta.items() if k != "display_derivative"}
    refuses("ome-scale-without-provenance", no_prov)

    # …and the legitimate absence — no scale anywhere — still writes. Otherwise INV-5's
    # unknown-scale path would have been closed by this guard.
    legit = dict(no_prov)
    legit.pop("microns_per_pixel", None)
    ok = OW.write_ome_tiff(tmp_path / "unknown-scale.ome.tif", arr, placement=legit,
                           image_microns_per_pixel=None)
    assert ok.is_file()


# ── TEST-11 — what the guards CANNOT see ──────────────────────────────────────────────


def test_a_wrong_micron_scale_passes_every_check_this_system_has(fine, tmp_path_factory):
    """TEST-11 [covers: ITEM-12] — the measurement of the blind spot, not of the guard.

    This is #155's TEST-9 for the scale: *"a deliberately wrong affine passes every check
    this system has, and the wrong and correct artifacts differ in exactly one key."*

    Every guard #176 adds reconciles the artifact with ITSELF. None of them can see whether
    the micron scale the whole chain is DERIVED FROM was right, and that scale comes from
    the vendor's `spot_diameter_fullres`. A wrong one propagates all the way down —
    different resolution, different factor, different pixel grid, different affine, a
    different NUMBER OF PIXELS ON DISK — and every check still passes, because every
    derived value agrees with every other.

    The test therefore asserts that the wrong artifact PASSES. A test that made it fail
    would be claiming a guarantee this system does not have. What closes this is #156's
    registration overlay, and nothing here.
    """
    SD, OW = modules()
    # 3x wrong, in the vendor number the entire scale chain hangs from.
    #
    # NOT 4x, which was the first choice and was a bad one: it lands
    # `applied_resolution_um` at 0.49999999999999994 against a 0.5 cap, i.e. this test's
    # headline claim ("the wrong artifact passes every check") would have been riding the
    # cap check's 1e-9 float slack rather than the blind spot it exists to measure. 3x gives
    # factor 8 and applied 0.5333, clear of every boundary.
    factors = json.loads(VF.fine_scalefactors_text())
    factors["spot_diameter_fullres"] = VF.FINE_SPOT_DIAMETER_FULLRES * 3
    bundle = VF.make_fine_imaged(tmp_path_factory.mktemp("wrong-src"),
                                 scalefactors_text=json.dumps(factors))
    out = tmp_path_factory.mktemp("wrong-out")
    module, entries = VF.run_over(bundle, out)
    module.write_manifest(out, entries)

    wrong = VF.entry_by_id(entries, FINE_HIRES)
    right = entry(fine, FINE_HIRES)

    # 1 — THE WRONG ARTIFACT PASSES EVERY CHECK THIS SYSTEM HAS.
    import conformance

    assert conformance.conform_outputs(out, full=True) == [], "the real ingest gate"
    # `image_meta`'s reconstruction — the check that refuses a hand-edited derived field.
    #
    # Re-running `image_meta` over the meta `image_meta` itself produced would be
    # IDEMPOTENCE, not a check: it agrees with itself by construction and cannot fail on the
    # wrong-scale defect. So the block is rebuilt from its own RECORDED INPUTS, which is
    # what `image_meta` actually does internally, and the derived fields are required to
    # come out the same — i.e. the wrong artifact is internally consistent, which is the
    # property being demonstrated.
    rebuilt = SD.display_derivative_provenance(
        original_resolution_um=wrong["meta"]["display_derivative"][
            "original_resolution_um"],
        original_extent=wrong["meta"]["display_derivative"]["original_extent"],
        original_source=wrong["meta"]["display_derivative"]["original_source"],
        codec=wrong["meta"]["display_derivative"]["codec"],
        tifffile_version=wrong["meta"]["display_derivative"]["writer_version"],
        resolution_cap_um=wrong["meta"]["display_derivative"]["resolution_cap_um"],
    )
    assert rebuilt == wrong["meta"]["display_derivative"], (
        "the wrong artifact is not even self-consistent, so it is not an instance of the "
        "blind spot this test measures"
    )
    # …and it also survives the constructor on the path that actually writes.
    assert SD.image_meta(space={k: wrong["meta"][k] for k in
                                ("coordinate_space", "unit", "to_space", "extent",
                                 "microns_per_pixel")},
                         derivative=rebuilt,
                         role=wrong["meta"]["role"],
                         source=wrong["meta"]["source"])["display_derivative"] == rebuilt
    # `write_ome_tiff`'s scale reconciliation — re-run over the wrong artifact's own bytes.
    with tifffile.TiffFile(out / wrong["path"]) as tf:
        wrong_pixels = tf.series[0].levels[0].asarray()
        wrong_xml = tf.ome_metadata
    OW.write_ome_tiff(
        Path(tmp_path_factory.mktemp("wrong-rewrite")) / "again.ome.tif", wrong_pixels,
        placement=wrong["meta"],
        image_microns_per_pixel=wrong["meta"]["display_derivative"][
            "applied_resolution_um"],
    )
    # …and the sandboxed consumer's own reader accepts it.
    assert SD.require_placement(wrong_xml, consumer="a spatial analysis")["extent"] == \
        wrong["meta"]["extent"]
    # …and it even answers `require_original_reference`, pointing at the right vendor file.
    assert SD.require_original_reference(
        wrong["meta"], consumer="an intensity readout")["member"] == \
        "tissue_hires_image.png"

    # 2 — AND IT IS GENUINELY DIFFERENT. Not a rounding difference: a different number of
    # pixels was written to disk.
    right_prov = right["meta"]["display_derivative"]
    wrong_prov = wrong["meta"]["display_derivative"]
    assert wrong_prov["downsample_factor"] != right_prov["downsample_factor"]
    assert wrong_prov["applied_resolution_um"] != right_prov["applied_resolution_um"]
    assert wrong_pixels.shape != level0(fine, FINE_HIRES).shape, (
        "the wrong scale produced the same pixel grid, so this fixture does not "
        "demonstrate the blind spot"
    )
    # The SOURCE is identical in both — same vendor file, same original grid. Only the
    # interpretation of how big those pixels are differs.
    assert wrong_prov["original_extent"] == right_prov["original_extent"]
    assert wrong_prov["original_source"] == right_prov["original_source"]

    # 3 — AND THE DIFFERENCE IS EXACTLY THE SCALE CHAIN, nothing else.
    differing = {k for k in set(right["meta"]) | set(wrong["meta"])
                 if right["meta"].get(k) != wrong["meta"].get(k)}
    assert differing == {"to_space", "extent", "microns_per_pixel",
                         "display_derivative"}, differing
    # Which is to say: every key that describes WHERE and HOW BIG differs, and every key
    # that describes WHAT this is agrees. There is no observable in the artifact — and no
    # check in this system — that says which of the two is the real slide. #156.


# ── TEST-12 — the report says it downsampled ──────────────────────────────────────────


def test_the_report_names_the_downsample_and_stays_quiet_about_a_pass_through(fine):
    """TEST-12 [covers: ITEM-6] — DEC-11, in the artifact a human reads.

    The pixels this user will look at are averages the importer computed, not what the
    instrument measured. That is exactly the class of thing `images_not_emitted` and the
    coverage warning already exist to say, so it goes in the same channel.

    A pass-through says NOTHING, and the control matters: a note on every import would
    train the reader to ignore the channel entirely.
    """
    report = json.loads((fine["out"] / "visium-import-report.json").read_text())
    notes = report["image_warnings"]

    hires_notes = [n for n in notes if n.startswith("tissue_hires_image.png")]
    assert hires_notes, notes
    note = " ".join(hires_notes)
    assert "DISPLAY DERIVATIVE" in note
    assert f"downsampled {VF.FINE_EXPECTED_FACTOR}x" in note
    # Both resolutions, so the reader can see what was traded.
    prov = entry(fine, FINE_HIRES)["meta"]["display_derivative"]
    assert f"{prov['original_resolution_um']:g}" in note
    assert f"{prov['applied_resolution_um']:g}" in note
    # And where the source went, which is the answer to the question the note provokes.
    assert "preserved in the uploaded bundle" in note

    # THE RAGGED STRIP names only the axis that actually lost something. This fixture is
    # 1400x1800 at factor 3: 1400 % 3 == 2 columns dropped, 1800 % 3 == 0 rows. Saying
    # "2 column(s) and 0 row(s) were dropped" asserts a loss that did not occur, in the one
    # channel the note exists to be honest in.
    prov_ext = prov["original_extent"]
    assert prov_ext["width"] % VF.FINE_EXPECTED_FACTOR == 2
    assert prov_ext["height"] % VF.FINE_EXPECTED_FACTOR == 0, (
        "this fixture no longer has a one-sided ragged strip, so the assertion below "
        "cannot tell a one-axis message from a two-axis one"
    )
    assert "2 column(s)" in note
    assert "row(s)" not in note, (
        f"the note names a row loss that did not happen: {note}"
    )

    # THE CONTROL: the pass-through image says nothing of the sort.
    assert not [n for n in notes
                if n.startswith("tissue_lowres_image.png") and "downsampled" in n], notes

    # The structured half, for a consumer rather than a human.
    by_id = {i["id"]: i for i in report["images"]}
    assert by_id[FINE_HIRES]["display_derivative"]["downsampled"] is True
    assert by_id[FINE_LOWRES]["display_derivative"]["downsampled"] is False


# ── TEST-13 — the emitted affine ──────────────────────────────────────────────────────


def test_the_emitted_affine_folds_the_factor_and_agrees_with_155_at_factor_one():
    """TEST-13 [covers: ITEM-4] — the two spellings cannot drift apart.

    #155's TEST-3 pins `inverse_scalefactor_affine` BY NAME as the inverse rather than the
    forward spelling — the "one-line difference that is wrong for a year if nobody writes
    it down". #176 adds a second builder beside it, which is a second chance for the
    direction to be got wrong in one of them. Requiring `emitted_affine(s, 1)` to be
    exactly the old function is what makes that impossible.
    """
    _, OW = modules()
    s = 0.2

    assert OW.emitted_affine(s, 1) == OW.inverse_scalefactor_affine(s)
    assert OW.emitted_affine(s, 3)[0] == pytest.approx(3 / s, rel=1e-12)
    assert OW.emitted_affine(s, 3)[4] == pytest.approx(3 / s, rel=1e-12)
    # Still an INVERSE, not the forward spelling: a factor of 3 at scalefactor 0.2 gives
    # 15, not 0.6. The forward mix-up survives every type and shape check.
    assert OW.emitted_affine(s, 3)[0] != pytest.approx(s * 3, rel=1e-6)

    # THE PIXEL-ANCHOR CONVENTION IS CORNER, so the affine is a PURE SCALE at every factor.
    #
    # This is asserted as a named convention, not as "the implementation returns zeros". A
    # downsample raises a question factor==1 never asks — does an emitted index denote its
    # pixel's corner or its centre? — and the two differ by a translation of (f-1)/(2s),
    # which is 5 full-resolution units on this fixture at factor 3. A centre-anchored
    # translation was added here during this issue and then REMOVED: `imageTiles.ts` defines
    # `ImageWorldBounds` as the world coordinates of the image's pixel CORNERS, and
    # `affineMatrix.ts` composes this affine as a whole-image `modelMatrix` OVER those
    # bounds — so a translation here shifts the whole image by half a block rather than
    # centring it.
    #
    # Nothing in the repo consumes `to_space` yet (#158/#159), so neither convention is
    # falsifiable in-tree today; corner is the conservative choice and #158 must confirm it.
    for factor in (1, 2, 3, 7):
        a, b, tx, c, d, ty = OW.emitted_affine(s, factor)
        assert (b, c) == (0.0, 0.0), "a downsample introduced SHEAR"
        assert (tx, ty) == (0.0, 0.0), (
            f"factor {factor} put a translation in the affine. Under the CORNER convention "
            "this tree's `ImageWorldBounds` uses, the affine composes as a whole-image "
            "modelMatrix and a translation here shifts the image by half a block."
        )
        assert a == pytest.approx(factor / s, rel=1e-12) and d == a

    for bad in (0, -1, 1.5, True, "3", None):
        with pytest.raises(OW.ImageConversionError):
            OW.emitted_affine(s, bad)


# ── TEST-14 — the degenerate refusal ──────────────────────────────────────────────────


def test_a_factor_that_leaves_under_one_pixel_is_refused_by_name(tmp_path_factory):
    """TEST-14 [covers: ITEM-3] — DEC-7, and INV-6 around it.

    The alternatives are both worse than refusing. Clamping the factor would emit pixels
    FINER than the declared cap — a false claim in the one block a reader uses to tell
    measured pixels from averaged ones. Emitting a 1x1 image would be a measurement nobody
    can use wearing a valid artifact's shape.
    """
    SD, OW = modules()

    with pytest.raises(SD.SpatialDeclarationError) as exc:
        OW.downsample_plan(0.0001, 0.5, {"width": 400, "height": 300})
    assert "not an image" in str(exc.value)
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        SD.display_derivative_provenance(
            original_resolution_um=0.0001, original_extent={"width": 400, "height": 300},
            original_source="x.png", codec="deflate", tifffile_version="1",
        )
    assert "not an image" in str(exc.value)
    # …and one pixel is still an image, so the boundary is where it is claimed to be.
    factor, _applied, emitted = OW.downsample_plan(1.0, 400.0,
                                                   {"width": 400, "height": 400})
    assert factor == 400 and emitted == {"width": 1, "height": 1}

    # END TO END: the whole import survives it. Every image in this bundle hits the
    # degenerate case, and the matrix, the coordinates, the columns and the report all
    # still arrive — INV-6 does not weaken just because the failure is a refusal of ours
    # rather than a damaged input.
    factors = json.loads(VF.fine_scalefactors_text())
    factors["spot_diameter_fullres"] = 2_000_000
    bundle = VF.make_fine_imaged(tmp_path_factory.mktemp("degenerate-src"),
                                 scalefactors_text=json.dumps(factors))
    out = tmp_path_factory.mktemp("degenerate-out")
    module, entries = VF.run_over(bundle, out)
    module.write_manifest(out, entries)

    kinds = {e["datatype"] for e in entries}
    assert "single-cell/counts" in kinds and "spatial/coordinates" in kinds
    assert "metadata-column" in kinds and "report/html" in kinds
    assert "spatial/image" not in kinds, "a sub-pixel image was emitted anyway"

    report = json.loads((out / "visium-import-report.json").read_text())
    named = " ".join(report["images_not_emitted"])
    assert "tissue_hires_image.png" in named and "not an image" in named, (
        report["images_not_emitted"]
    )
    import conformance

    assert conformance.conform_outputs(out, full=True) == []


# ── TEST-15 — the carrier work ────────────────────────────────────────────────────────


def test_the_retired_refusal_the_vendored_copy_and_the_manifests():
    """TEST-15 [covers: ITEM-9, ITEM-10] — the bookkeeping, checked rather than assumed.

    Each of these has bitten this tree before: a retired function left beside its
    replacement (two contradictory statements of one policy), a vendored copy that drifted
    from its source of truth (a second implementation wearing the first one's name), and a
    package edited without its `version` moving (the seed reconciliation keys on it).
    """
    _, OW = modules()

    # ITEM-9 — #155's refusal is GONE, not merely unused. Checked as a DEFINITION and as a
    # CALL rather than as a substring: `display_derivative_provenance`'s docstring cites the
    # retired function by name to record WHY the correction it makes was safe, and deleting
    # that history to satisfy a grep would be the wrong trade.
    # The name is ASSEMBLED rather than written as one literal, so this file does not match
    # its own sweep. Excluding this file from the sweep instead would be a guard exempting
    # itself from the rule it enforces, and the next thing to land in the exemption would
    # not be a test.
    retired = "refuse_if_finer" + "_than_cap"
    assert not hasattr(OW, retired)
    sources = (list((PKG / "compute").glob("*.py")) + list((PKG / "tests").glob("*.py"))
               + list((TYPES_PKG / "compute").glob("*.py"))
               + list((TYPES_PKG / "tests").glob("*.py")))
    assert len(sources) >= 8, f"the source sweep found only {len(sources)} files"
    assert any(p.name == "ome_writer.py" for p in sources), (
        "the sweep does not reach the module the retired function lived in"
    )
    for path in sources:
        text = path.read_text()
        assert retired + "(" not in text, f"{path}: still calls/defines it"
        assert "def " + retired not in text, path

    # ITEM-10 — the vendored copy is BYTE-IDENTICAL to its source of truth.
    vendored = (PKG / "compute" / "spatial_declarations.py").read_bytes()
    truth = (TYPES_PKG / "compute" / "spatial_declarations.py").read_bytes()
    assert hashlib.sha256(vendored).hexdigest() == hashlib.sha256(truth).hexdigest(), (
        "the vendored `spatial_declarations.py` has drifted from `spatial-types`'"
    )

    # ITEM-10 — and neither manifest still claims #176 is unbuilt.
    for manifest in (PKG / "manifest.yaml", TYPES_PKG / "manifest.yaml"):
        text = manifest.read_text()
        assert "#176 — this importer passes a below-cap source" not in text, manifest
        assert "Still NOT here: the DOWNSAMPLING" not in text, manifest

    # ITEM-10 — both packages' `version` moved past what #155 shipped (0.2.0). The
    # AUTHORITATIVE check is `scripts/check-processor-seed-versions.sh`, which diffs each
    # package against `origin/main` and NAMES the version it wants; this is the in-suite
    # floor, so a later edit that forgets the bump cannot reach a green pytest run without
    # at least tripping here. Same shape as #155's own seed-floor test.
    import re

    for manifest in (PKG / "manifest.yaml", TYPES_PKG / "manifest.yaml"):
        match = re.search(r"^version:\s*(\d+)\.(\d+)\.(\d+)\s*$", manifest.read_text(),
                          re.M)
        assert match, f"{manifest}: no parseable top-level `version`"
        assert tuple(int(g) for g in match.groups()) > (0, 2, 0), (
            f"{manifest}: version {match.group(0)!r} did not move past what #155 shipped"
        )


# ── TEST-17 — the generalization is behaviour-preserving at factor 2 ──────────────────


def test_downsample_at_factor_two_is_exactly_the_155_halving():
    """TEST-17 [covers: ITEM-2] — the regression control on generalizing `_halved`.

    The pyramid and the display derivative now share ONE resampler. That is the point —
    two of them is exactly how a tree ends up averaging in one place and decimating in the
    other — but it means a change made for #176 can silently change #155's pyramid. The
    expected value here is #155's own expression, written out, not a call into the code
    under test.

    #155's `test_each_pyramid_level_averages_rather_than_decimates` is the other half of
    this control and must pass UNMODIFIED.
    """
    _, OW = modules()
    rng = np.random.default_rng(1976)

    for shape in ((40, 60), (40, 60, 3), (41, 61), (41, 61, 3), (2, 2), (3, 5, 3)):
        arr = rng.integers(0, 256, size=shape, dtype=np.uint8)
        h, w = arr.shape[0] // 2, arr.shape[1] // 2
        clipped = arr[: h * 2, : w * 2]
        if clipped.ndim == 2:
            blocks = clipped.reshape(h, 2, w, 2)
        else:
            blocks = clipped.reshape(h, 2, w, 2, clipped.shape[2])
        expected = np.rint(blocks.mean(axis=(1, 3))).astype(arr.dtype)
        assert np.array_equal(OW.downsample(arr, 2), expected), shape

    # `factor == 1` is the identity and does not copy — a pass-through must be bit-exact,
    # which TEST-1 asserts end to end and this pins at the seam.
    arr = rng.integers(0, 256, size=(9, 7, 3), dtype=np.uint8)
    assert OW.downsample(arr, 1) is arr

    # 16-bit survives the round trip through the float mean, and does not wrap.
    wide = rng.integers(0, 65536, size=(8, 8), dtype=np.uint16)
    out = OW.downsample(wide, 2)
    assert out.dtype == np.uint16 and out.max() <= wide.max()

    # The ragged edge is DROPPED, never padded — an odd dimension loses its last row/col
    # rather than gaining an invented one.
    odd = rng.integers(0, 256, size=(7, 5), dtype=np.uint8)
    assert OW.downsample(odd, 3).shape == (2, 1)

    # EVERY DTYPE `read_image` CAN PRODUCE gets a real average, and the branch that decides
    # rounding must key on "can this dtype hold a fraction", not on "is it an integer".
    #
    # `np.issubdtype(np.bool_, np.integer)` is FALSE, so an `integer` test sent a BILEVEL
    # mask down the float path where `mean.astype(bool)` is a LOGICAL OR — any one set
    # pixel saturates the block, and it compounds per pyramid level. `read_image`'s TIFF
    # branch validates the axis order and NOT the dtype, so a mask TIFF is admitted by
    # `read_image`'s CONTRACT — though no shipped path reaches it today (`VENDOR_IMAGES` is
    # two PNGs, and the PIL branch converts them), which `downsample`'s own comment states.
    # This is a unit test of that contract, not of a production path.
    #
    # Measured on the broken branch with THIS fixture's rng draw: a 1.61%-set mask went
    # 6.3% -> 22.7% -> 59.4% -> 93.8% over four levels, i.e. a nearly solid overview.
    mask = rng.random((64, 64)) < 0.02
    level = mask
    for _ in range(4):
        level = OW.downsample(level, 2)
    assert level.dtype == np.bool_
    assert not level.any(), (
        f"a {mask.mean():.2%}-set mask saturated to {level.mean():.2%} — the resampler is "
        "OR-ing blocks instead of averaging them"
    )
    # …and the bool result is EXACTLY the rounded block mean — a majority vote — so the
    # assertion above is not passing merely because everything collapses to False. Computed
    # here rather than taken from the resampler.
    dense = rng.random((16, 16)) < 0.7
    expected_bool = np.rint(
        dense.reshape(8, 2, 8, 2).mean(axis=(1, 3))).astype(bool)
    assert np.array_equal(OW.downsample(dense, 2), expected_bool)
    assert expected_bool.any() and not expected_bool.all(), (
        "this fixture is uniform after one level, so it cannot distinguish a majority vote "
        "from a logical OR"
    )

    # Signed integers ROUND, asserted against the rounded mean computed here — a
    # min/max-within-range check would have been satisfied by truncation, decimation, floor
    # and an all-zero array alike, which is no assertion at all.
    signed = rng.integers(-128, 128, size=(8, 8), dtype=np.int8)
    expected_signed = np.rint(
        signed.reshape(4, 2, 4, 2).mean(axis=(1, 3))).astype(np.int8)
    out_signed = OW.downsample(signed, 2)
    assert out_signed.dtype == np.int8
    assert np.array_equal(out_signed, expected_signed)
    # …and rounding is DISTINGUISHABLE from truncation on this fixture, so the assertion is
    # not passing because the two happen to agree. (Truncation toward zero is what makes
    # signed a different case from unsigned: it biases toward zero, not darker.)
    assert not np.array_equal(
        signed.reshape(4, 2, 4, 2).mean(axis=(1, 3)).astype(np.int8), expected_signed)

    # Floats keep the mean rather than being quantized to {0.0, 1.0}.
    unit = rng.random((8, 8)).astype(np.float32)
    out_float = OW.downsample(unit, 2)
    assert out_float.dtype == np.float32
    assert len(np.unique(out_float)) > 2, (
        "a float plane in [0,1] was rounded to a two-valued image"
    )
    assert out_float == pytest.approx(
        unit.reshape(4, 2, 4, 2).mean(axis=(1, 3)), rel=1e-6)


# ── TEST-18 — INV-6 against the arithmetic #176 introduced ────────────────────────────


def test_a_subnormal_micron_scale_costs_one_image_and_never_the_import(tmp_path_factory):
    """TEST-18 [acceptance] [invariant: INV-6] [covers: ITEM-3, ITEM-6].

    INV-6, verbatim: *"Losing one image must never cost the matrix, the coordinates, the
    columns and the report."*

    #176's new arithmetic re-opened this in the mirror direction of a hole this package
    already closed once. `emit_images`' own handler records the history: *"Round 1 added
    `math.isfinite` to the scalefactor guard and still aborted the entire import on a
    SUBNORMAL scalefactor (1e-320 is finite and positive; 1/1e-320 is `inf`), because the
    failure is in the DERIVED quantity, not the input."* #176 divides the other way —
    `cap / original` — and a subnormal `original` overflows to `inf`, whose `math.ceil` is
    an `OverflowError`. That type is in NEITHER `emit_images`' except tuple NOR `main()`'s.

    Measured before the fix, end to end: `IMPORT ABORTED: OverflowError cannot convert
    float infinity to integer`, with no manifest and no report written at all. The whole
    dataset was lost over one damaged number in a vendor JSON file.

    `microns_per_pixel` is used rather than a tiny scalefactor because it is `micron_scale`
    leg 1, taken VERBATIM from the vendor with only a `> 0` test — the shortest path from a
    damaged vendor file to this arithmetic.
    """
    SD, _ = modules()
    for subnormal in (1e-320, 5e-324):
        factors = json.loads(VF.fine_scalefactors_text())
        factors["microns_per_pixel"] = subnormal
        bundle = VF.make_fine_imaged(tmp_path_factory.mktemp("subnormal-src"),
                                     scalefactors_text=json.dumps(factors))
        out = tmp_path_factory.mktemp("subnormal-out")
        module, entries = VF.run_over(bundle, out)
        module.write_manifest(out, entries)

        # THE IMPORT SURVIVED, which is the whole assertion.
        kinds = {e["datatype"] for e in entries}
        assert "single-cell/counts" in kinds, sorted(kinds)
        assert "spatial/coordinates" in kinds, sorted(kinds)
        assert "metadata-column" in kinds, sorted(kinds)
        assert "report/html" in kinds, sorted(kinds)
        assert (out / "manifest.json").is_file(), "no manifest was written"

        # The images are DROPPED and NAMED, not silently absent.
        report = json.loads((out / "visium-import-report.json").read_text())
        assert report["images_not_emitted"], report
        named = " ".join(report["images_not_emitted"])
        assert "tissue_hires_image.png" in named, report["images_not_emitted"]

        # …and the refusal came from this module's own error type rather than escaping as
        # an OverflowError, which is the property that makes it survivable at all.
        with pytest.raises(SD.SpatialDeclarationError):
            SD.downsample_factor(subnormal / 0.2, SD.DEFAULT_RESOLUTION_CAP_UM)

        import conformance

        assert conformance.conform_outputs(out, full=True) == []


# ── TEST-19 — WHICH pixel-anchor convention is correct, decided by measurement ─────────


def test_the_pixel_anchor_convention_is_settled_by_where_the_origin_goes(fine):
    """TEST-19 [acceptance] [invariant: INV-4] [covers: ITEM-4] — the affine has NO
    translation, and this is a proof rather than a preference.

    A downsample raises a question `factor == 1` never asks, because the two answers
    COINCIDE there: does the emitted affine need a `(factor-1)/(2s)` translation? This
    branch shipped both spellings before settling it, and the earlier attempts to decide it
    were bad in an instructive way — a marker CENTROID cannot arbitrate it (it estimates a
    centre, so it presupposes the answer), and a tolerance wide enough to admit one is wide
    enough to admit the other.

    **The ORIGIN settles it, and the origin is not an estimate.** Three measured facts:

    1. **The crop preserves the origin.** `downsample` takes `arr[: h*f, : w*f]` — it drops
       the ragged strip from the END. So emitted pixel 0 aggregates source pixels `0..f-1`,
       and the emitted frame's origin is the source frame's origin, exactly. Measured below
       on a plane whose every block has a DISTINCT mean, so the value alone identifies which
       source block an emitted pixel came from.
    2. **At `factor == 1` the affine maps 0 to 0**, with no translation — and that affine is
       pinned bit-exact against the vendor's own `pxl_*_in_fullres` values by #155's TEST-3.
       So the image frame's origin is the full-resolution frame's origin.
    3. Composing 1 and 2: for EVERY factor the emitted frame's origin is the full-resolution
       frame's origin, so `to_space` maps 0 to 0 and carries no translation. **CORNER.**

    The CENTRE convention asserts `to_space(0) = (factor-1)/(2s)` — that emitted pixel 0's
    anchor sits 5 full-resolution units INSIDE the image on this fixture. Fact 1 measures
    that its pixels begin at the origin, so that claim is false. `to_space` is a map between
    CONTINUOUS coordinate frames (fact 2 round-trips continuous vendor coordinates through
    it), and two frames that share an origin and differ by a scale are related by a pure
    scale.
    """
    _, OW = modules()

    # ── FACT 1: the crop preserves the origin, and drops from the END ────────────────
    # Every 3x3 block of this plane has a distinct mean, so an emitted value names its
    # source block unambiguously — no centroid, no estimate.
    probe = np.arange(9 * 9, dtype=np.uint8).reshape(9, 9)
    for factor in (1, 3):
        reduced = OW.downsample(probe, factor)
        assert reduced[0, 0] == np.rint(probe[0:factor, 0:factor].mean()).astype(np.uint8), (
            f"at factor {factor} the emitted origin pixel is not the mean of the source's "
            "origin block, so the crop does not preserve the origin and this proof's first "
            "premise is false"
        )
    # …and the ragged strip really is dropped from the END, not the start: a 10x10 source
    # at factor 3 keeps [0:9, 0:9], so index 9 is lost and index 0 is not.
    ragged = np.arange(10 * 10, dtype=np.uint8).reshape(10, 10)
    assert OW.downsample(ragged, 3)[0, 0] == np.rint(ragged[0:3, 0:3].mean()).astype(np.uint8)
    assert OW.downsample(ragged, 3).shape == (3, 3)

    # ── FACT 2: at factor 1 the affine maps 0 to 0, on REAL vendor data ──────────────
    low = entry(fine, FINE_LOWRES)["meta"]
    assert low["display_derivative"]["downsample_factor"] == 1, (
        "the pass-through control is no longer a pass-through"
    )
    assert (low["to_space"][2], low["to_space"][5]) == (0.0, 0.0)

    # ── CONCLUSION: no translation at ANY factor ─────────────────────────────────────
    hi = entry(fine, FINE_HIRES)["meta"]
    factor = hi["display_derivative"]["downsample_factor"]
    assert factor > 1, "the downsampling image is no longer downsampling"
    assert (hi["to_space"][2], hi["to_space"][5]) == (0.0, 0.0), (
        "the emitted affine carries a translation. Its pixels begin at the source's origin "
        "(fact 1) and the factor-1 affine maps 0 to 0 (fact 2), so it must not."
    )

    # ── AND THE REJECTED CONVENTION IS NAMED, with the claim it would make ───────────
    # Stated as a number so this test fails informatively if anyone reinstates it, rather
    # than merely asserting zeros and leaving the alternative unnamed.
    centre_tx = hi["to_space"][0] * (factor - 1) / (2 * factor)
    assert centre_tx > 0, "this fixture cannot distinguish the two conventions"
    assert hi["to_space"][2] != centre_tx, (
        f"the affine adopted the CENTRE convention (tx = {centre_tx}), which claims emitted "
        f"pixel 0's anchor lies {centre_tx} full-resolution units inside the image while "
        "fact 1 measures its pixels beginning at the origin"
    )
