#!/usr/bin/env python3
# ruff: noqa
"""The image path's REFUSALS and NOTES — the half a happy-path suite never reaches (#155).

This module exists because a blind audit found that ten production behaviours added while
fixing an earlier audit round were guarded by nothing: every one of them survived being
mutated away. The happy-path suite in `test_spatial_image.py` proves the artifact is
correct when everything works; this one proves the importer behaves when something is
broken, which is the case a user actually hits.

Each test names the mutation it kills, so a later reader can tell what would go red.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pytest
import tifffile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "spatial-types" / "tests"))
import image_boundary_guards as IBG  # noqa: E402


def _everything_but_the_image_survived(entries, control_entries, image_ids):
    """EVERY artifact the control emitted, minus the images, is here — not a named handful.

    The sibling Xenium suite's own helper writes down the diagnosis this fixes: naming three or
    four ids plus "at least one metadata column" pins 4 of the 15 artifacts a real Visium import
    emits, and a regression costing the summary and nine of the ten metadata columns kept every
    end-to-end test in this file GREEN. Measured, with a probe that drops exactly those whenever
    an image is skipped: `total_failed=0`.

    Every caller already computes a control for its own reasons, so comparing the whole SET
    costs nothing — and "losing one image must never cost the matrix, the coordinates, the
    columns and the report" is a statement about ALL of them.
    """
    def ids(es):
        return {e["id"] for e in es}

    # THE DAMAGED IMAGES, NAMED — not "every image the control emitted". Subtracting them all
    # is wrong in BOTH directions on a bundle with two: it FALSE-REDS when the healthy image
    # correctly survives, and it PASSES when the healthy one is silently lost too. Latent today
    # (both callers use `with_lowres=False`) and one `with_lowres=True` away from mattering,
    # which eight other tests in this file already use. The xenium sibling takes the id.
    got, expected = ids(entries), ids(control_entries) - set(image_ids)
    assert got == expected, (
        f"the damaged image cost more than itself. Missing: {sorted(expected - got)}; "
        f"unexpectedly present: {sorted(got - expected)}. The control emitted "
        f"{len(ids(control_entries))} artifacts.")


def _compute():
    module = VF.load_compute()
    return module, sys.modules["ome_writer"], sys.modules["spatial_declarations"]


# ── one bad image must never cost the whole import ───────────────────────────────────


@pytest.mark.parametrize("scalef", [1e-320, 5e-324])
def test_a_subnormal_scalefactor_drops_one_image_and_keeps_the_import(tmp_path, scalef):
    """Kills: removing the finiteness guard on the DERIVED reciprocal.

    `1e-320` is finite and positive, so it passes every guard on the INPUT — and then
    `1 / 1e-320` is `inf`, which `SD._number` refuses. Before this was closed the whole
    import aborted: the matrix, the coordinates, all seven columns and the report were lost
    because one number in `scalefactors_json.json` was denormal. INV-6's stated posture is
    that a bundle with a damaged scale file is still IMPORTABLE.
    """
    bundle = VF.make_imaged(
        tmp_path, with_lowres=False,
        scalefactors_text=json.dumps({
            "tissue_hires_scalef": scalef, "spot_diameter_fullres": 73.61433,
        }),
    )
    _module, entries = VF.run_over(bundle, tmp_path / "out")

    assert [e for e in entries if e["datatype"] == "spatial/image"] == []
    # The rest of the import is INTACT — that is the whole point.
    assert VF.entry_by_id(entries, "spatial-coordinates")
    assert VF.entry_by_id(entries, "expression")
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())
    assert any("tissue_hires_image.png" in n for n in report["images_not_emitted"])


def test_a_truncated_vendor_image_drops_one_image_and_keeps_the_import(tmp_path):
    """Kills: narrowing the per-image guard back to `ImageConversionError` only.

    A corrupt PNG raises `OSError` out of the decoder, which is neither
    `ImageConversionError` nor `SpatialDeclarationError`. A MISSING image already degraded
    gracefully; a DAMAGED one took the entire run down, which is the worse asymmetry
    because a truncated upload is far more likely than a deleted member.
    """
    bundle = VF.make_imaged(tmp_path, with_lowres=True)
    target = bundle / "spatial" / "tissue_hires_image.png"
    blob = target.read_bytes()
    target.write_bytes(blob[: len(blob) // 2])

    _module, entries = VF.run_over(bundle, tmp_path / "out")

    images = {e["id"] for e in entries if e["datatype"] == "spatial/image"}
    assert images == {"spatial-image-lowres"}, (
        "a damaged hires image must cost only itself — the lowres image, the matrix and "
        "the coordinates are unaffected by it"
    )
    assert VF.entry_by_id(entries, "spatial-coordinates")
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())
    assert any("tissue_hires_image.png" in n for n in report["images_not_emitted"])


# ── the two note channels are not one channel ────────────────────────────────────────


def test_an_emitted_image_is_never_listed_as_not_emitted(tmp_path):
    """Kills: folding the warning notes back into `images_not_emitted`.

    `images_not_emitted` is the key a machine consumer filters on to learn what is MISSING.
    A note reading "emitted, but the cap could not be evaluated" belongs in a different
    channel, or a successfully emitted image is counted as absent.
    """
    bundle = VF.make_imaged(
        tmp_path, with_lowres=False,
        # No `spot_diameter_fullres` and no `microns_per_pixel` -> no micron scale at all,
        # so the cap cannot be evaluated and the warning path fires.
        scalefactors_text=json.dumps({"tissue_hires_scalef": 0.2}),
    )
    _module, entries = VF.run_over(bundle, tmp_path / "out")
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())

    emitted = {e["meta"]["source"] for e in entries if e["datatype"] == "spatial/image"}
    assert emitted == {"tissue_hires_image.png"}
    assert report["images_not_emitted"] == [], (
        f"an EMITTED image is listed as not emitted: {report['images_not_emitted']}"
    )
    assert any("cap could NOT be evaluated" in w for w in report["image_warnings"])
    for name in emitted:
        assert not any(name in n for n in report["images_not_emitted"])


def test_an_ambiguous_image_basename_is_reported_rather_than_silently_dropped(tmp_path):
    """Kills: deleting the ambiguous-images note.

    Member matching is by basename, so two files of the same name cannot be told apart.
    Refusing to choose is right; refusing SILENTLY is the failure `images_not_emitted`
    exists to prevent — a user finds out at overlay time that there is nothing to overlay.
    """
    bundle = VF.make_imaged(tmp_path, with_lowres=True)
    duplicate = bundle / "extra"
    duplicate.mkdir()
    (duplicate / "tissue_hires_image.png").write_bytes(
        (bundle / "spatial" / "tissue_hires_image.png").read_bytes()
    )

    _module, entries = VF.run_over(bundle, tmp_path / "out")
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())

    assert {e["id"] for e in entries if e["datatype"] == "spatial/image"} == {
        "spatial-image-lowres"
    }
    assert any("tissue_hires_image.png" in n and "more than one" in n
               for n in report["images_not_emitted"])


# ── the coverage note, including its orientation ─────────────────────────────────────


def test_an_image_that_does_not_cover_the_spots_says_so(tmp_path):
    """Kills: deleting the coverage note, AND swapping its x/y.

    The x/y half is the point. The note compares `extent.width * to_space[0]` against the
    spots' max X and the height against max Y; swapping the pair is invisible on a square
    frame, so this uses a bundle whose image covers the spots in ONE axis and not the
    other. A swapped comparison then reports the wrong axis, and the assertion on the
    message catches it.

    (Both the RAW vendor fixture — 2000x2000 since #243, covering a 10000 px full-res frame
    — and `make_imaged`'s repaint at 1400x1800 = 7000x9000 DO cover the spots. The adjacent
    no-warning test asserts exactly that, so this test builds its own under-covering frame.
    It always did: it has never relied on a fixture being broken, which is why #243 did not
    disturb it.)
    """
    # Spots run to x<=6911, y<=4360 (measured, not assumed — the importer uses only the
    # barcodes the filtered matrix carries). This frame covers Y and not X.
    bundle = VF.make_imaged(tmp_path, with_lowres=False)
    factors = json.loads(
        (bundle / "spatial" / "scalefactors_json.json").read_text()
    )
    from PIL import Image

    scalef = factors["tissue_hires_scalef"]
    narrow = np.zeros((int(12000 * scalef), int(3000 * scalef), 3), dtype=np.uint8)
    Image.fromarray(narrow).save(bundle / "spatial" / "tissue_hires_image.png")

    _module, entries = VF.run_over(bundle, tmp_path / "out")
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())

    assert {e["id"] for e in entries if e["datatype"] == "spatial/image"} == {
        "spatial-image-hires"
    }, "an under-covering image is a WARNING, never a refusal — a cropped vendor image is legitimate"
    note = [w for w in report["image_warnings"] if "covers only" in w]
    assert note, f"no coverage warning: {report['image_warnings']}"
    assert "3000 x 12000" in note[0], (
        f"the coverage note reports {note[0]!r} — the covered region is 3000 wide by "
        "12000 tall and must be reported in that order"
    )

    # THE ORIENTATION ASSERTION, and the reason it is on the SPOTS' extent rather than on
    # the covered region. The spots this fixture's matrix carries span x<=6911, y<=4360 —
    # ASYMMETRIC on purpose. Swapping `max_x, max_y = coverage_bounds` leaves the covered
    # region printed identically and leaves the fire/no-fire outcome identical too (both
    # comparisons still trip), so neither of those can detect it. What the swap DOES change
    # is which number is named as the spots' width. Asserting it here is what makes the x/y
    # orientation of the whole coverage computation checkable at all.
    xs, ys = VF.expected_xy()
    assert f"spots extend to {max(xs):.0f} x {max(ys):.0f}" in note[0], (
        f"the coverage note reports {note[0]!r}, but the spots span "
        f"{max(xs):.0f} x {max(ys):.0f} — the x and y bounds are transposed"
    )
    assert max(xs) != max(ys), (
        "the fixture's spot bounds are square, so a transposed pair is indistinguishable "
        "and the assertion above proves nothing"
    )


def test_an_image_that_covers_the_spots_warns_about_nothing(tmp_path):
    """The control for the test above: the note must not fire on a good bundle.

    Without this, a coverage check that fired unconditionally would satisfy the positive
    case and be useless.
    """
    bundle = VF.make_imaged(tmp_path, with_lowres=True)
    _module, _entries = VF.run_over(bundle, tmp_path / "out")
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())
    assert [w for w in report["image_warnings"] if "covers only" in w] == []


# ── the writer's own refusals ────────────────────────────────────────────────────────


def test_the_writer_refuses_a_declared_extent_that_disagrees_with_the_pixels(tmp_path):
    """Kills: disabling the extent cross-check in `write_ome_tiff`.

    This is the ONE place the pixels and the declaration are both in scope, and it is the
    only check that can catch a transposed extent — `image_meta`'s re-validation re-runs
    `coordinate_space`, which has no pixels to compare against. On the shipped caller both
    sides come from the same `extent_of(arr)` call, so the guard exists for third-party
    callers and for drift between the two; this test is what keeps it alive.
    """
    _module, OW, SD = _compute()
    arr = np.zeros((180, 300, 3), dtype=np.uint8)
    transposed = SD.image_meta(space=SD.coordinate_space(
        space="s", unit="pixel", to_space=[5, 0, 0, 0, 5, 0],
        extent={"width": 180, "height": 300},   # the swap
    ))
    dest = tmp_path / "nested" / "bad.ome.tif"
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        OW.write_ome_tiff(dest, arr, placement=transposed)
    assert "extent" in str(exc.value)
    assert not dest.exists() and not dest.parent.exists(), (
        "the refusal created a file or directory — it must run before anything is written"
    )


def test_a_failed_write_leaves_no_partial_file_and_spares_an_existing_one(tmp_path):
    """Kills: reverting the staging-file write to a direct one.

    `TiffWriter` creates the destination up front, so a mid-write failure used to leave a
    truncated `.ome.tif` exactly where a reader would look for it — and `emit_images` would
    carry on, finishing with a committed artifact beside an orphaned stub.
    """
    _module, OW, SD = _compute()
    placement = SD.image_meta(space=SD.coordinate_space(
        space="s", unit="pixel", to_space=[5, 0, 0, 0, 5, 0],
        extent={"width": 300, "height": 180},
    ))
    dest = tmp_path / "img.ome.tif"
    good = OW.write_ome_tiff(dest, np.zeros((180, 300, 3), dtype=np.uint8),
                             placement=placement)
    original = good.read_bytes()

    # float16 is refused by the OME-XML writer from inside `TiffWriter.close()` — i.e.
    # AFTER the staging file exists and the pixel data is written, which is what makes this
    # a genuine MID-write failure rather than an early validation. A refusal raised BEFORE
    # the writer opens would make both assertions below trivially true, so the test would
    # pass with the whole staging mechanism deleted.
    #
    # #292 CLOSED THE ONLY LEVER THIS TEST HAD, and giving it a real one back is why these
    # lines changed. `write_ome_tiff` now REFUSES a dtype OME-XML cannot express up front —
    # `float16` never reaches `TiffWriter` at all — so keeping `pytest.raises` here and
    # simply widening it to `ImageConversionError` would have turned this test into exactly
    # the early-validation tautology its own comment warns against, silently, with the tree
    # green. The lever is restored by switching that guard OFF for one call, on the staged
    # module only: `float16` then reaches the real writer, the real `tifffile` raises the
    # real `OmeXmlError` from `close()`, and #292's named backstop converts it.
    #
    # The assertion is STRONGER than the one it replaces, not weaker. `__cause__ is an
    # OmeXmlError` can only be true if `TiffWriter` was entered and got as far as assembling
    # the OME-XML — which is precisely the "mid-write" property this test exists to pin, and
    # which `pytest.raises(OmeXmlError)` only implied.
    expressible = OW.OME_EXPRESSIBLE_DTYPES
    try:
        OW.OME_EXPRESSIBLE_DTYPES = frozenset(expressible | {"float16"})
        with pytest.raises(OW.ImageConversionError) as mid_write:
            OW.write_ome_tiff(dest, np.zeros((180, 300, 3), dtype=np.float16),
                              placement=placement)
    finally:
        OW.OME_EXPRESSIBLE_DTYPES = expressible
    assert isinstance(mid_write.value.__cause__, tifffile.OmeXmlError), (
        "the failure did not come from inside `TiffWriter` — this test's whole premise is a "
        f"MID-write failure, and it got {mid_write.value.__cause__!r}. With an early refusal "
        "the two assertions below are trivially true and the staging mechanism is untested."
    )

    assert dest.read_bytes() == original, "a failed write clobbered the previous artifact"
    assert list(dest.parent.glob("*.partial")) == [], "a staging file was left behind"


def test_the_reader_refuses_a_tiff_whose_axes_are_not_a_plain_plane(tmp_path):
    """Kills: disabling the YX/YXS axis guard in `read_image`.

    A multi-page or planar-separate TIFF decodes to `(C, H, W)`. Nothing downstream would
    notice: `extent_of` would report `{width: H, height: C}` and `_halved` would average
    channel against row — §7.3's transposition arriving through the axis order. The Visium
    table is PNG-only today, so this is latent; `cytassist_image.tiff` is one row away.
    """
    _module, OW, _SD = _compute()
    rng = np.random.default_rng(0)

    separate = tmp_path / "separate.tif"
    tifffile.imwrite(separate, rng.integers(0, 255, (180, 300, 3), dtype=np.uint8),
                     photometric="rgb", planarconfig="separate")
    with pytest.raises(OW.ImageConversionError) as exc:
        OW.read_image(separate)
    assert "axis order" in str(exc.value)

    # A DELIBERATE REFUSAL MUST NOT BE RECLASSIFIED AS CORRUPTION. `read_image` re-raises
    # `ImageConversionError` before its decode normaliser, and without that line the axis
    # refusal is double-wrapped as "not a readable TIFF (ImageConversionError: … axis order
    # …)" — which still substring-matches the assertion above, so deleting the re-raise
    # left the whole suite green. This is the assertion that pins it: the file is
    # well-formed and we are declining it, and a reader must be able to tell that from a
    # damaged one.
    assert "not a readable TIFF" not in str(exc.value), (
        "the axis-order refusal was reclassified as a corrupt file — a deliberate refusal "
        "and a damaged input are different answers and must not read the same"
    )

    # THE EMPTY-SERIES REFUSAL, pinned the same way. Deleting the re-raise used to fail
    # only the axis arm, so this refusal could silently become
    # "not a readable TIFF (ImageConversionError: this TIFF contains no image series)"
    # and TEST-33's substring assertion would still pass. Both refusals now hold the line.
    empty = tmp_path / "noseries.tif"
    empty.write_bytes(b"II*\x00" + b"\x00" * 120)
    with pytest.raises(OW.ImageConversionError) as exc:
        OW.read_image(empty)
    assert "no image series" in str(exc.value)
    assert "not a readable TIFF" not in str(exc.value), (
        "the empty-series refusal was reclassified as a corrupt file"
    )

    stack = tmp_path / "stack.tif"
    tifffile.imwrite(stack, rng.integers(0, 255, (3, 180, 300), dtype=np.uint8))
    with pytest.raises(OW.ImageConversionError):
        OW.read_image(stack)

    # …and the LEGITIMATE shapes still load, or the guard is just breaking the reader.
    for name, data, kwargs in (
        ("gray.tif", rng.integers(0, 255, (180, 300), dtype=np.uint8), {}),
        ("rgb.tif", rng.integers(0, 255, (180, 300, 3), dtype=np.uint8),
         {"photometric": "rgb"}),
    ):
        path = tmp_path / name
        tifffile.imwrite(path, data, **kwargs)
        assert OW.read_image(path).shape == data.shape


def test_a_damaged_cyto_payload_refuses_rather_than_returning_a_neighbours_placement():
    """Kills: turning the damaged-payload branch back into `continue`.

    `decode_placement` cannot tell which `<Image>` a `Description` belongs to, so skipping a
    damaged payload and returning the next one hands the caller SOME OTHER image's affine —
    fail-open, in the module whose entire job is to refuse rather than misplace. A node that
    is not a cyto payload at all is still skipped; that is somebody else's metadata, not a
    damaged declaration.
    """
    _module, _OW, SD = _compute()
    good = SD.encode_placement(SD.image_meta(space=SD.coordinate_space(
        space="right", unit="pixel", to_space=[9, 0, 0, 0, 9, 0],
        extent={"width": 10, "height": 20},
    )))
    damaged = SD.OME_PLACEMENT_PREFIX + "{not json"

    ns = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
    assert SD.decode_placement(
        f"{ns}<Image><Description>{damaged}</Description></Image>"
        f"<Image><Description>{good}</Description></Image></OME>"
    ) is None, "a damaged payload returned a different Image's placement"

    # A NON-cyto description is not a damaged declaration and must not block the real one.
    assert SD.decode_placement(
        f"{ns}<Image><Description>acquired on a microscope</Description></Image>"
        f"<Image><Description>{good}</Description></Image></OME>"
    )["coordinate_space"] == "right"


def test_a_large_image_is_written_as_bigtiff(tmp_path, monkeypatch):
    """Kills: hardcoding `bigtiff=False`.

    The installed `tifffile` has its >4 GiB classic-TIFF guard commented out, so an
    overflowing classic file is written with corrupt offsets rather than refused. The
    threshold is exercised through the real `write_ome_tiff` with a lowered bound, so the
    test costs kilobytes instead of gigabytes and still drives the branch that decides.
    """
    _module, OW, SD = _compute()
    placement = SD.image_meta(space=SD.coordinate_space(
        space="s", unit="pixel", to_space=[5, 0, 0, 0, 5, 0],
        extent={"width": 300, "height": 180},
    ))
    arr = np.zeros((180, 300, 3), dtype=np.uint8)

    # The shipped VALUE, asserted before the mechanism. Monkeypatching the constant below
    # proves the branch works but would happily pass with the real threshold set to
    # infinity — the mutation that defeats the whole guard. So the value is pinned here,
    # where a change to it goes red and names the reason.
    assert OW.BIGTIFF_THRESHOLD_BYTES == 2 * 1024 ** 3, (
        f"the BigTIFF threshold is {OW.BIGTIFF_THRESHOLD_BYTES}. Classic TIFF addresses "
        "with 32-bit offsets and this tifffile has its >4 GiB guard commented out, so a "
        "threshold above ~2 GiB writes corrupt offsets instead of refusing."
    )

    small = OW.write_ome_tiff(tmp_path / "small.ome.tif", arr, placement=placement)
    with tifffile.TiffFile(small) as tf:
        assert not tf.is_bigtiff

    monkeypatch.setattr(OW, "BIGTIFF_THRESHOLD_BYTES", 1)
    big = OW.write_ome_tiff(tmp_path / "big.ome.tif", arr, placement=placement)
    with tifffile.TiffFile(big) as tf:
        assert tf.is_bigtiff, "the size threshold no longer selects BigTIFF"


def test_the_ome_physical_size_is_the_images_own_pitch_not_the_spaces(tmp_path):
    """TEST-5 [covers: ITEM-5, ITEM-7] — the two scales in one file, asserted apart.

    OME `PhysicalSizeX` means "the physical size of a pixel in THIS image"; the `cyto`
    payload's `microns_per_pixel` is the scale of the COORDINATE SPACE, shared by every
    artifact in it. On the hires image they differ by 5x and on the lowres image by 16.7x.
    Nothing asserted either value before, so a consumer reading `PhysicalSizeX` and applying
    it to space coordinates was wrong by exactly that factor with nothing to say so.

    ## What #222 added to this test

    This is where the split reaches the EMITTED BYTES, so it is where ITEM-7's sweep is
    discharged: every real downstream consumer of the space scale — both images' OME
    `PhysicalSizeX`, and both placements' `microns_per_pixel` — must have moved to the
    RENDERED spot diameter (65 um), while the artifact's declared `measured_entity`
    resolution must NOT have moved off the CAPTURE footprint (55 um). One bundle, both halves.

    `space_scale` is retyped from the two constants rather than imported from the importer,
    for the reason the sibling tests state: arithmetic taken from the code under test agrees
    with itself by construction.
    """
    bundle = VF.make_imaged(tmp_path, with_lowres=True)
    _module, entries = VF.run_over(bundle, tmp_path / "out")
    SD = sys.modules["spatial_declarations"]
    factors = VF.scalefactors()
    # 65.0 = VISIUM_RENDERED_SPOT_DIAMETER_UM, the circle `spot_diameter_fullres` measures.
    space_scale = 65.0 / factors["spot_diameter_fullres"]
    capture_scale = 55.0 / factors["spot_diameter_fullres"]

    for output_id, key in (("spatial-image-hires", "tissue_hires_scalef"),
                           ("spatial-image-lowres", "tissue_lowres_scalef")):
        entry = VF.entry_by_id(entries, output_id)
        with tifffile.TiffFile(tmp_path / "out" / entry["path"]) as tf:
            xml = tf.ome_metadata
            placement = SD.decode_placement(xml)
        physical = float(xml.split('PhysicalSizeX="')[1].split('"')[0])

        assert physical == pytest.approx(space_scale / factors[key]), (
            f"{output_id}: OME PhysicalSizeX is not this image's own pixel pitch"
        )
        assert placement["microns_per_pixel"] == pytest.approx(space_scale), (
            f"{output_id}: the cyto payload does not carry the SPACE's scale"
        )
        assert physical != pytest.approx(placement["microns_per_pixel"]), (
            "the two scales are equal, so this fixture cannot show they are distinct"
        )
        # #222: this image's declared physical size is 65/55 = 18.18% larger than the
        # pre-fix one. Stated as the RATIO rather than as `physical != capture_scale/scalef`
        # — that inequality is ENTAILED by the equality four lines above (a blind audit
        # caught it as vacuous), whereas the ratio names the size of the correction and goes
        # red on any numerator other than 65.
        assert physical / (capture_scale / factors[key]) == pytest.approx(
            65.0 / 55.0, rel=1e-9
        ), (
            f"{output_id}: PhysicalSizeX is not 65/55 of what the 55 um capture footprint "
            "would give, so the emitted pixel size is on the wrong circle (#222)"
        )

    # THE OTHER HALF OF THE SPLIT, on the same bundle: the declared capture resolution did
    # NOT move. A fix that raised both would have corrupted what one row measured.
    coords_meta = VF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert coords_meta["measured_entity"]["resolution_um"] == 55.0
    assert coords_meta["microns_per_pixel"] == pytest.approx(space_scale)


def test_every_decode_branch_is_exercised_so_a_typo_on_one_goes_red(tmp_path):
    """TEST-34 [covers: ITEM-1] — the coverage the error policy DEPENDS on.

    `read_image` normalises every failure to `ImageConversionError` so that no input can
    abort the import (INV-6). The known cost of that breadth is real and was demonstrated:
    a typo inside this function reads as "not a readable image", and the image is silently
    skipped. Three attempts were made to separate bug from bad-file BY EXCEPTION TYPE — a
    deny-list, an allow-list, and a resource-only re-raise — and each was wrong, because
    the two genuinely overlap (`tifffile` raises `TypeError` on malformed tags; a
    170-megapixel image raises `MemoryError` that is entirely about the file).

    So the separation is made HERE instead, where it can be made honestly: every decode
    branch is exercised, so a typo on ANY of them turns this red rather than hiding behind
    the normaliser. That is what makes an untested branch — the actual failure mode — a
    coverage gap with a coverage fix.

    Each case asserts the decoded shape and dtype, so a branch that silently returns the
    wrong thing fails too, not merely one that raises.
    """
    _module, OW, _SD = _compute()
    from PIL import Image

    cases = {}
    cases["png_gray"] = (tmp_path / "g.png", (12, 20), np.uint8)
    Image.fromarray(np.zeros((12, 20), dtype=np.uint8)).save(cases["png_gray"][0])
    cases["png_rgb"] = (tmp_path / "c.png", (12, 20, 3), np.uint8)
    Image.fromarray(np.zeros((12, 20, 3), dtype=np.uint8)).save(cases["png_rgb"][0])
    cases["png_16bit"] = (tmp_path / "s.png", (12, 20), np.uint16)
    Image.fromarray(np.zeros((12, 20), dtype=np.uint16)).save(cases["png_16bit"][0])
    cases["png_palette"] = (tmp_path / "p.png", (12, 20, 3), np.uint8)
    Image.fromarray(np.zeros((12, 20, 3), dtype=np.uint8)).convert("P").save(
        cases["png_palette"][0]
    )
    cases["png_rgba"] = (tmp_path / "a.png", (12, 20, 3), np.uint8)
    Image.fromarray(np.zeros((12, 20, 4), dtype=np.uint8)).save(cases["png_rgba"][0])
    cases["tif_gray"] = (tmp_path / "g.tif", (12, 20), np.uint8)
    tifffile.imwrite(cases["tif_gray"][0], np.zeros((12, 20), dtype=np.uint8))
    cases["tif_rgb"] = (tmp_path / "c.tif", (12, 20, 3), np.uint8)
    tifffile.imwrite(cases["tif_rgb"][0], np.zeros((12, 20, 3), dtype=np.uint8),
                     photometric="rgb")

    for name, (path, shape, dtype) in cases.items():
        arr = OW.read_image(path)
        assert arr.shape == shape, f"{name}: shape {arr.shape}, expected {shape}"
        assert arr.dtype == dtype, f"{name}: dtype {arr.dtype}, expected {dtype}"

    # The 16-bit branch is the one a previous audit broke with a typo while the suite
    # stayed green, because nothing read a 16-bit image. It is covered above; this asserts
    # the branch is genuinely DISTINCT, so the case cannot be quietly folded away.
    assert OW.read_image(cases["png_16bit"][0]).dtype != \
        OW.read_image(cases["png_gray"][0]).dtype

    # And `KeyboardInterrupt` is still not swallowed — it derives from `BaseException`, so
    # the broad `except Exception` cannot catch it and Ctrl-C still works.
    original = Image.open

    def interrupted(*_a, **_k):
        raise KeyboardInterrupt()

    Image.open = interrupted
    try:
        with pytest.raises(KeyboardInterrupt):
            OW.read_image(cases["png_rgb"][0])
    finally:
        Image.open = original

def test_an_image_can_never_be_both_emitted_and_not_emitted(tmp_path, monkeypatch):
    """TEST-32 [covers: ITEM-6] — the two states are mutually exclusive BY CONSTRUCTION.

    The per-image guard exists so a damaged image costs only itself. But the artifact is
    committed the moment `write_ome_tiff` returns, so if the guard still covered the code
    AFTER that point, a failure there would append to `skipped` for an image that is
    already in `entries` and already on disk — putting the same image in `entries`,
    `report["images"]` and `images_not_emitted` at once. That is exactly the defect the two
    note channels were split to remove, reintroduced structurally rather than by oversight.

    So the commit sits OUTSIDE the guard, and this asserts the property rather than the
    layout: whatever happens, the two sets are disjoint. Driven by forcing a failure at the
    latest point the guard still covers — the write itself — and, separately, by the normal
    path, so the invariant is checked in both directions.
    """
    bundle = VF.make_imaged(tmp_path, with_lowres=True)
    # Load FIRST, then patch, then drive `run_import` directly. `VF.run_over` calls
    # `load_compute()`, which re-executes `ome_writer` from its path and installs a NEW
    # module object under the same name — silently discarding any patch applied before it.
    # A patch that is thrown away leaves the test asserting the unmutated behaviour, which
    # is the quietest way for a fault-injection test to prove nothing.
    module = VF.load_compute()
    OW = sys.modules["ome_writer"]

    real_write = OW.write_ome_tiff
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:              # the hires image fails; the lowres one must not
            raise OSError("simulated disk failure during the write")
        return real_write(*args, **kwargs)

    monkeypatch.setattr(OW, "write_ome_tiff", flaky)
    entries = module.run_import(bundle, tmp_path / "out")
    module.write_manifest(tmp_path / "out", entries)
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())

    emitted = {e["meta"]["source"] for e in entries if e["datatype"] == "spatial/image"}
    assert emitted == {"tissue_lowres_image.png"}, (
        "the failing image was still recorded as an artifact"
    )
    assert any("tissue_hires_image.png" in n for n in report["images_not_emitted"])

    # THE INVARIANT: nothing is on both lists.
    for source in emitted:
        assert not any(source in n for n in report["images_not_emitted"]), (
            f"{source} is BOTH emitted and listed in images_not_emitted"
        )
    # …and the failed image left no artifact file behind.
    assert not (tmp_path / "out" / "spatial-image-hires.ome.tif").exists()


def test_every_unreadable_image_arrives_as_one_error_type(tmp_path):
    """TEST-33 [covers: ITEM-1] — one situation, one exception type.

    "This file is not readable" arrives from the decoders in FOUR unrelated hierarchies:
    a truncated PNG is an `OSError`, a garbage one a `PIL.UnidentifiedImageError` (also an
    `OSError`), an empty TIFF a `tifffile.TiffFileError` (which subclasses `Exception`
    directly), and a garbage TIFF an `IndexError` from indexing an empty series list.

    A caller cannot be expected to know all four, and the alternative — widening its
    `except` until it happens to cover them — is how a genuine logic bug ends up filed as a
    damaged input. So `read_image` normalises them at the one place that knows what
    happened, and this pins that: the caller's guard needs exactly `ImageConversionError`.

    The two TIFF cases are the ones that used to escape and abort the whole import.
    """
    _module, OW, _SD = _compute()
    real = (VF.FIXTURE / "spatial" / "tissue_hires_image.png").read_bytes()

    # Each case names the SPECIFIC text its message must carry. The first version of this
    # asserted `name.split(".")[0] in str(exc) or "readable" in str(exc)`, and every raise
    # site prefixed the filename, so the left disjunct was true by construction — replacing
    # all three messages with "everything is completely fine here" left it passing. That
    # looseness is what let the empty-series guard and the re-raise below survive deletion.
    corrupt = {
        "truncated.png": (real[:200], "not a readable image"),
        "garbage.png": (b"\x89PNG\r\n\x1a\n" + b"\x00" * 80, "not a readable image"),
        "empty.png": (b"", "not a readable image"),
        "garbage.tif": (b"II*\x00" + b"\x00" * 120, "this TIFF contains no image series"),
        "empty.tif": (b"", "not a readable TIFF"),
        "text.png": (b"not an image at all", "not a readable image"),
    }
    for name, (blob, expected) in corrupt.items():
        path = tmp_path / name
        path.write_bytes(blob)
        with pytest.raises(OW.ImageConversionError) as exc:
            OW.read_image(path)
        assert expected in str(exc.value), (
            f"{name}: message was {str(exc.value)!r}, expected to contain {expected!r}"
        )
        # The reader never repeats the filename — the caller prefixes it, and both produced
        # "tissue_hires_image.png: tissue_hires_image.png: ..." in the user-facing report.
        assert not str(exc.value).startswith(name), (
            f"{name}: the message repeats the filename the caller already prepends"
        )

    # …and a READABLE image is still read, so the normalisation did not swallow the
    # success path into a refusal.
    assert OW.read_image(VF.FIXTURE / "spatial" / "tissue_hires_image.png").shape[2] == 3


def test_a_corrupt_tiff_costs_only_its_own_image(tmp_path, monkeypatch):
    """TEST-33 (cont.) — the end-to-end half, through the real importer.

    `read_image`'s normalisation is only worth anything if the caller's guard then does its
    job. The vendor table is PNG-only today, so this drives the TIFF path by pointing one
    table row at a `.tif` — which is exactly what adding `cytassist_image.tiff` will do.
    """
    module = VF.load_compute()
    bundle = VF.make_imaged(tmp_path, with_lowres=True)
    (bundle / "spatial" / "broken.tif").write_bytes(b"II*\x00" + b"\x00" * 120)

    monkeypatch.setattr(module, "VENDOR_IMAGES", (
        {"basename": "broken.tif", "scalef_key": "tissue_hires_scalef",
         "role": "alignment", "output_id": "spatial-image-broken"},
        {"basename": "tissue_lowres_image.png", "scalef_key": "tissue_lowres_scalef",
         "role": "overview", "output_id": "spatial-image-lowres"},
    ))
    entries = module.run_import(bundle, tmp_path / "out")
    module.write_manifest(tmp_path / "out", entries)
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())

    assert {e["id"] for e in entries if e["datatype"] == "spatial/image"} == {
        "spatial-image-lowres"
    }, "a corrupt TIFF cost more than its own image"
    assert VF.entry_by_id(entries, "spatial-coordinates")
    assert any("broken.tif" in n for n in report["images_not_emitted"])




def _zero_dimension_tiff(path):
    """A VALID TIFF with `ImageWidth` (tag 256) zeroed — one byte-range, not fuzz.

    `tifffile` then divides by `product(keyframe.shape)` inside `detect_series` and raises
    `ZeroDivisionError`, which is neither an `OSError` nor a `TiffFileError`.
    """
    import struct

    tifffile.imwrite(path, np.zeros((40, 60), dtype=np.uint8))
    blob = bytearray(path.read_bytes())
    ifd = struct.unpack("<I", blob[4:8])[0]
    count = struct.unpack("<H", blob[ifd:ifd + 2])[0]
    for i in range(count):
        entry = ifd + 2 + i * 12
        if struct.unpack("<H", blob[entry:entry + 2])[0] == 256:
            blob[entry + 8:entry + 12] = struct.pack("<I", 0)
    path.write_bytes(bytes(blob))
    return path


def _absurd_plane_tiff(path, side=10_000_000):
    """A ~270-byte TIFF DECLARING a `side` x `side` plane. Axes are `YX`, so it passes the
    axis guard, and `tifffile` then asks numpy for terabytes inside `series.asarray()`.
    """
    import struct

    tifffile.imwrite(path, np.zeros((4, 4), dtype=np.uint8))
    blob = bytearray(path.read_bytes())
    ifd = struct.unpack("<I", blob[4:8])[0]
    count = struct.unpack("<H", blob[ifd:ifd + 2])[0]
    for i in range(count):
        entry = ifd + 2 + i * 12
        if struct.unpack("<H", blob[entry:entry + 2])[0] in (256, 257):
            blob[entry + 8:entry + 12] = struct.pack("<I", side)
    path.write_bytes(bytes(blob))
    return path


def test_a_tiny_file_declaring_a_terabyte_plane_costs_only_itself(tmp_path):
    """TEST-35 (cont.) [covers: ITEM-1, ITEM-6] — MemoryError is about the FILE.

    A 270-byte TIFF can declare a 10,000,000 x 10,000,000 plane, and `tifffile` will then
    ask numpy for ~91 TiB inside `series.asarray()`. That `MemoryError` is entirely
    input-caused, and an earlier policy re-raised it as "genuine resource exhaustion" —
    so a file this size took the whole import down.

    It is also why PIL's decompression-bomb check is not sufficient on its own: that check
    is a PIXEL-COUNT threshold on the PNG path, and this is a TIFF whose declared
    dimensions were never allocated. The general rule is the one that holds: a failure to
    decode is a property of the file, whatever exception the decoder chose to raise.
    """
    _module, OW, _SD = _compute()
    huge = _absurd_plane_tiff(tmp_path / "terabyte.tif")
    assert huge.stat().st_size < 1024, "the repro must stay tiny to make the point"

    with pytest.raises(OW.ImageConversionError) as exc:
        OW.read_image(huge)

    # WHICH exception the decoder raises for this file depends on the machine's memory
    # state at the moment it tries: numpy raises `MemoryError` when it cannot size the
    # allocation, and `tifffile` raises `ValueError` ("failed to read N bytes") when it
    # gets as far as the read. Both are the decoder failing on an absurd DECLARED size,
    # and asserting only one of them made this test flaky between runs.
    #
    # So the assertion is on the property that matters and is stable — the failure is
    # CONTAINED as `ImageConversionError` and names the underlying cause — rather than on
    # whichever of the two the allocator happened to reach first.
    assert any(k in str(exc.value) for k in ("MemoryError", "ValueError")), (
        f"the failure was contained but names no underlying cause: {exc.value}"
    )
    assert "not a readable TIFF" in str(exc.value)

    # AND THE POLICY, PINNED DETERMINISTICALLY. The natural repro above cannot pin it: on a
    # large-memory box numpy reports `ValueError` before it ever reaches a `MemoryError`, so
    # re-introducing a `MemoryError` re-raise leaves the whole suite green here while
    # aborting the import on a memory-capped sandbox — a machine-dependent gate, which is
    # no gate. Injecting the exception makes the assertion about the POLICY rather than
    # about this box's allocator.
    for boom in (MemoryError, RecursionError):
        original = tifffile.TiffFile

        def exploding(*_args, **_kwargs):
            raise boom("injected")

        tifffile.TiffFile = exploding
        try:
            with pytest.raises(OW.ImageConversionError) as injected:
                OW.read_image(huge)
            assert boom.__name__ in str(injected.value)
        finally:
            tifffile.TiffFile = original


def test_an_oversized_image_and_a_zero_dimension_tiff_cost_only_themselves(tmp_path):
    """TEST-35 [covers: ITEM-1, ITEM-6] — the two inputs that aborted the whole import.

    Both were found by blind audit and both were REGRESSIONS introduced by an earlier
    attempt to enumerate the decoder errors worth catching:

    * a **genuine, uncorrupted** PNG above PIL's 179-megapixel bomb threshold raises
      `PIL.Image.DecompressionBombError`, which subclasses `Exception` DIRECTLY. A
      full-resolution slide scan at 15000x15000 is 225 Mpx and crosses it.
    * a valid TIFF with one dimension tag zeroed raises `ZeroDivisionError` from inside
      `tifffile.detect_series`.

    Neither is an `OSError`, so both escaped the allow-list and took the matrix, the
    coordinates, all seven columns and the report down with them. This is the regression
    test, and it asserts the END-TO-END property (the import survives) rather than only the
    exception type, because the type is not what the user loses.
    """
    _module, OW, _SD = _compute()

    from PIL import Image

    bomb = tmp_path / "bomb.png"
    Image.fromarray(np.zeros((13000, 14000), dtype=np.uint8)).save(bomb)
    assert 13000 * 14000 > Image.MAX_IMAGE_PIXELS * 2, (
        "the fixture no longer exceeds PIL's bomb threshold, so this asserts nothing"
    )
    with pytest.raises(OW.ImageConversionError) as exc:
        OW.read_image(bomb)
    assert "DecompressionBombError" in str(exc.value), (
        f"the oversized PNG failed for some OTHER reason: {exc.value}"
    )

    with pytest.raises(OW.ImageConversionError) as exc:
        OW.read_image(_zero_dimension_tiff(tmp_path / "zerodim.tif"))
    assert "ZeroDivisionError" in str(exc.value), (
        f"the zero-dimension TIFF failed for some OTHER reason: {exc.value}"
    )


@pytest.mark.parametrize("basename", ["bomb.png", "zerodim.tif"])
def test_a_pathological_image_never_costs_the_rest_of_the_import(tmp_path, monkeypatch,
                                                                 basename):
    """TEST-35 (cont.) — driven through the REAL importer, which is where it mattered.

    The unit assertions above would pass even if the caller's guard still let the failure
    through. This drives `run_import` with the pathological file as a vendor image row and
    asserts the invariant that was actually violated: losing one image must never cost the
    matrix, the coordinates, the columns and the report (INV-6).
    """
    module = VF.load_compute()
    bundle = VF.make_imaged(tmp_path, with_lowres=True)

    from PIL import Image

    if basename.endswith(".png"):
        Image.fromarray(np.zeros((13000, 14000), dtype=np.uint8)).save(
            bundle / "spatial" / basename
        )
    else:
        _zero_dimension_tiff(bundle / "spatial" / basename)

    monkeypatch.setattr(module, "VENDOR_IMAGES", (
        {"basename": basename, "scalef_key": "tissue_hires_scalef",
         "role": "alignment", "output_id": "spatial-image-bad"},
        {"basename": "tissue_lowres_image.png", "scalef_key": "tissue_lowres_scalef",
         "role": "overview", "output_id": "spatial-image-lowres"},
    ))
    entries = module.run_import(bundle, tmp_path / "out")
    module.write_manifest(tmp_path / "out", entries)
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())

    assert {e["id"] for e in entries if e["datatype"] == "spatial/image"} == {
        "spatial-image-lowres"
    }, f"{basename} cost more than its own image"
    assert VF.entry_by_id(entries, "spatial-coordinates")
    assert VF.entry_by_id(entries, "expression")
    assert any(basename in n for n in report["images_not_emitted"])


# ── #298 E4 — the handler must never raise WHILE handling ───────────────────────────


#: The two handlers in the per-image body that report a refusal by `basename`, and a failure
#: that reaches each. `#298` names only the OUTER one, and the INNER one had the identical
#: dependency on the same assignment — so both are driven, or "fixed" would mean "fixed the
#: one the issue happened to look at".
_E4_FAILURES = {
    # -> the INNER handler, `except ome_writer.ImageConversionError` around `read_image`
    "inner-read_image-refusal": "truncate",
    # -> the OUTER handler, `except (ImageConversionError, SpatialDeclarationError, OSError)`.
    #    A subnormal scalefactor is finite and positive, so it passes every guard on the INPUT
    #    and then `1 / 1e-320` is `inf`, which `SD._number` refuses — the exact path the
    #    sibling test at the top of this file was written for.
    "outer-guard-refusal": "subnormal-scalef",
}


@pytest.mark.parametrize("failure", sorted(_E4_FAILURES), ids=sorted(_E4_FAILURES))
def test_a_spec_without_a_basename_cannot_turn_a_caught_refusal_into_an_abort(
        failure, tmp_path):
    """TEST-12 — #298 E4, the one line that could undo the whole mechanism.

    The per-image `except` body reported the refusal it caught with `spec['basename']`, while
    `basename` was assigned INSIDE the `try`. A `spec` reaching either handler without that key
    therefore made the HANDLER raise, replacing the caught refusal with a `KeyError` that is in
    no guard — turning "one image lost" back into "the import lost", from inside the mechanism
    whose entire job is to prevent exactly that.

    GUARDED BY CONSTRUCTION TODAY, and this is a REGRESSION PIN ON THE CONSTRUCTION, not a
    claim that the input is reachable: `VENDOR_IMAGES` is a module constant and `locate_members`
    derives every spec from it, so no bundle can produce this shape. #298's own acceptance says
    the test for E4 is a pin on the construction rather than on a reachable input.

    WHY `emit_images` DIRECTLY AND NOT `run_import`. `locate_members` reads `spec["basename"]`
    itself when it builds `members["images"]`, so a basename-less spec cannot travel the whole
    pipeline — it dies one function earlier, at a line that is not the one under test. Driving
    the guarded loop with the `members` shape it is documented to accept is what actually
    exercises these handlers; an end-to-end run here would exercise `locate_members` and report a
    pass about the wrong function. The end-to-end half of this invariant is carried by the
    sibling tests in this file, which drive `run_import` over real damaged bundles.

    A REAL failure is injected in each case, so the handler is actually ENTERED: an assertion
    about a handler that never runs proves nothing.
    """
    module, _OW, _SD = _compute()
    bundle = VF.make_imaged(tmp_path, with_lowres=False)
    target = bundle / "spatial" / "tissue_hires_image.png"
    scalefactors = dict(VF.scalefactors(bundle))

    if _E4_FAILURES[failure] == "truncate":
        target.write_bytes(target.read_bytes()[:64])
    else:
        scalefactors["tissue_hires_scalef"] = 1e-320

    hires = next(spec for spec in module.VENDOR_IMAGES
                 if spec["basename"] == "tissue_hires_image.png")
    # Everything `emit_images` needs EXCEPT `basename` — the one key the handlers read.
    spec = {k: v for k, v in hires.items() if k != "basename"}
    spec["path"] = target

    entries, notes, _warnings = module.emit_images(
        {"images": [spec], "ambiguous_images": []},
        tmp_path / f"e4-{failure}",
        space_id="visium-fullres-px",
        microns_per_pixel=0.5,
        microns_per_pixel_source="spot_diameter_fullres",
        scalefactors=scalefactors,
    )

    assert entries == [], (
        "the image must not be emitted, or the handler was never entered and this test proves "
        f"nothing about it; got {entries!r}")
    assert len(notes) == 1, (
        "the refusal must still reach the user; a handler that survives but says nothing is "
        f"the same silence with better manners. Got {notes!r}")
    assert notes[0].startswith(module.UNNAMED_IMAGE), (
        "the note must say WHICH image, even when the spec carried no basename — the point of "
        "resolving it before the `try` is that the handler always has something to report. "
        "Compared against the module's own constant, not against the substring 'basename': "
        "the fallback label CONTAINS that word, so a containment check passed on a note that "
        f"identified nothing. Got {notes[0]!r}")
    assert re.search(r"\(?[A-Za-z]*Error", notes[0]), (
        "the note must also NAME the failure, or half of 'skipped with a NAMED reason' is "
        f"unenforced here. Got {notes[0]!r}")


def test_a_basename_less_spec_survives_the_whole_real_import(tmp_path, monkeypatch):
    """TEST-12 (INV-1) — E4's END-TO-END half: every other artifact still emits.

    The sibling above drives `emit_images` directly, because `locate_members` reads
    `spec["basename"]` when it BUILDS `members["images"]` and a basename-less spec therefore
    dies one function before the handler under test. That proves the handler survives; it does
    NOT prove the import does, which is half (b) of this branch's whole claim — so this test
    patches the one seam that produces `members` and drives the REAL `run_import` over a REAL
    bundle from there on.

    Still a regression pin on a construction, not a reachable input: `VENDOR_IMAGES` is a
    module constant and `locate_members` is what guards it. What is asserted is that IF that
    construction ever changes, the cost is one image and not the dataset.
    """
    module = VF.load_compute()
    bundle = VF.make_imaged(tmp_path, with_lowres=False)
    target = bundle / "spatial" / "tissue_hires_image.png"

    # THE CONTROL RUNS FIRST, ON THE INTACT BUNDLE. Measured: running it after the truncation
    # makes the control lose the same artifacts as the subject, so the whole-set comparison
    # compares two equally-damaged runs and passes with a real regression installed.
    _cm, _control_entries = VF.run_over(bundle, tmp_path / "e4-e2e-control")
    assert [e for e in _control_entries if e["datatype"] == "spatial/image"], (
        "the control emitted no image, so it is not a control")

    target.write_bytes(target.read_bytes()[:64])       # a REAL failure, so the handler is entered

    real_locate_members = module.locate_members

    def stripping_the_basename(*args, **kwargs):
        members = real_locate_members(*args, **kwargs)
        members["images"] = [{k: v for k, v in spec.items() if k != "basename"}
                             for spec in members["images"]]
        return members

    monkeypatch.setattr(module, "locate_members", stripping_the_basename)
    entries = module.run_import(bundle, tmp_path / "e4-e2e-out")

    assert [e for e in entries if e["datatype"] == "spatial/image"] == [], (
        "the truncated image must not be emitted, or the handler was never entered")
    _everything_but_the_image_survived(entries, _control_entries, {"spatial-image-hires"})
    ids = {e["id"] for e in entries}
    assert {"expression", "spatial-coordinates", "visium-import-report"} <= ids, (
        f"the handler raised while handling and cost the import its core artifacts; emitted "
        f"{sorted(ids)}")
    assert any(i.startswith("metadata-column:") for i in ids), (
        f"the handler raised while handling and cost every metadata column; emitted {sorted(ids)}")
    report = json.loads((tmp_path / "e4-e2e-out" / "visium-import-report.json").read_text())
    assert any(note.startswith(module.UNNAMED_IMAGE) for note in report["images_not_emitted"]), (
        f"the refusal must still name the image; got {report['images_not_emitted']!r}")


# ── #298 E2 — a declared library missing from the rootfs, END TO END ────────────────


def test_a_rootfs_without_tifffile_costs_the_images_and_not_the_import(tmp_path):
    """TEST-10 (INV-1) — #298 E2's end-to-end half, on the path that is actually reachable.

    `emit_images` calls `ome_writer.tifffile_version()` INSIDE its guarded per-image body and
    BEFORE `write_ome_tiff`, and a Visium bundle's images are PNGs — so on a host without
    `tifffile`, nothing has imported it yet and that call is where the failure lands. Until this
    was closed it raised `ImportError`, which is in neither importer's guard tuple, and a whole
    Visium import was lost because the analysis rootfs was missing a pinned library.

    That is the ONE escape in this branch whose end-to-end proof was missing: E2 was covered
    structurally (every deferred import is inside a converting `try`) and at unit level, and
    the design nonetheless claimed an end-to-end proof "for each closed escape".

    THE MODULE IS REALLY REMOVED, via `IBG.module_really_absent` — the SHARED fixture, and
    that sharing is the point. This test used to carry its own `sys.meta_path` blocker whose
    `find_spec` RAISED, which attributes the failure to THIS file rather than to the boundary's
    import line: the site rule then took the "a library's frame -> CONVERT" arm, so the only
    END-TO-END proof of #298 E2 never touched the `_DECLARED_LIBRARIES` carve-out it exists to
    prove. Measured: deleting that carve-out outright left this test passing.
    """
    module = VF.load_compute()
    bundle = VF.make_imaged(tmp_path, with_lowres=False)

    # THE CONTROL, in this test: the same bundle WITH `tifffile` present must emit an image.
    _cm, control_entries = VF.run_over(bundle, tmp_path / "tifffile-control")
    assert [e for e in control_entries if e["datatype"] == "spatial/image"], (
        "the CONTROL emitted no image, so 'the image is absent' below would be satisfied by "
        f"broken staging. Emitted {[e['id'] for e in control_entries]}")

    with IBG.module_really_absent("tifffile"):
        entries = module.run_import(bundle, tmp_path / "no-tifffile-out")

    assert [e for e in entries if e["datatype"] == "spatial/image"] == [], (
        "no image can be written without `tifffile`, so none must be claimed")
    _everything_but_the_image_survived(entries, control_entries, {"spatial-image-hires"})
    ids = {e["id"] for e in entries}
    assert {"expression", "spatial-coordinates", "visium-import-report"} <= ids, (
        f"a missing HOST library cost the import its core artifacts; emitted {sorted(ids)}")
    assert any(i.startswith("metadata-column:") for i in ids), (
        f"a missing HOST library cost every metadata column; emitted {sorted(ids)}")
    report = json.loads(
        (tmp_path / "no-tifffile-out" / "visium-import-report.json").read_text())
    notes = report["images_not_emitted"]
    assert notes, "the refusal must reach the user"
    assert any("tifffile" in note for note in notes), (
        "the note must NAME the library that is missing — 'not emitted' alone sends the user "
        f"looking at their bundle for a fault that is in the HOST. Got {notes!r}")


def test_a_failed_image_is_never_claimed_as_emitted_in_the_warnings_channel(tmp_path):
    """TEST-6 (INV-1) — the two note channels must not CONTRADICT each other.

    `entries.append(...)` sits outside the per-image guard so an image can never be in
    `entries` and `images_not_emitted` at once — the comment at the commit point says so in as
    many words. The WARNINGS channel had no such discipline: the note below is appended before
    `write_ome_tiff` runs and it begins *"emitted, but the 0.5 um/pixel display cap could NOT
    be evaluated"*. So a write that then failed produced a report asserting in one channel that
    the image WAS emitted and in the other that it was NOT.

    THE XENIUM HALF OF THIS FIX HAD A TEST AND THE VISIUM HALF DID NOT — measured: with only
    `compute/import_visium.py` reverted, the whole Visium suite stayed green. Two importers got
    the same repair and only one was pinned, which is the same "fixed by accident, pinned by
    nothing" shape this branch is about.

    The bundle declares NO micron scale, which is what produces the emission-asserting note;
    the `MemoryError` is what makes the write fail. Driven through `emit_images` because the
    note only exists on the no-micron-scale path, which `run_import` reaches only for a bundle
    whose `scalefactors` lack `spot_diameter_fullres`.
    """
    module, _OW, _SD = _compute()
    bundle = VF.make_imaged(tmp_path, with_lowres=False)
    real = np.ascontiguousarray

    def only_in_the_writer(a, *args, **kwargs):
        if sys._getframe(1).f_code.co_filename.endswith("ome_writer.py"):
            raise MemoryError("simulated: the contiguous copy did not fit")
        return real(a, *args, **kwargs)

    spec = next(s for s in module.VENDOR_IMAGES
                if s["basename"] == "tissue_hires_image.png")
    spec = dict(spec, path=bundle / "spatial" / "tissue_hires_image.png")

    # THE POSITIVE CONTROL, run FIRST: the same call with NO injection must produce an
    # emission-asserting note. Without it, "no such note accompanies a failure" is satisfied by
    # a bundle that never produces one at all.
    _e, _s, _control_emission_notes = module.emit_images(
        {"images": [spec], "ambiguous_images": []},
        tmp_path / "contradiction-control",
        space_id="visium-fullres-px",
        microns_per_pixel=None,
        microns_per_pixel_source=None,
        scalefactors=VF.scalefactors(bundle),
    )
    assert _e, "the control emitted no image, so it produced no note to control against"

    np.ascontiguousarray = only_in_the_writer
    try:
        entries, skipped, warnings = module.emit_images(
            {"images": [spec], "ambiguous_images": []},
            tmp_path / "contradiction-out",
            space_id="visium-fullres-px",
            microns_per_pixel=None,          # -> the "emitted, but ..." note
            microns_per_pixel_source=None,
            scalefactors=VF.scalefactors(bundle),
        )
    finally:
        np.ascontiguousarray = real

    assert entries == [], f"the image must not be emitted; got {entries!r}"
    assert skipped, "the failure must be reported"
    # THE PRODUCER'S OWN CONSTANT, not a literal. A NEGATIVE assertion over a substring of
    # prose that lives in another file goes vacuously green the moment the prose is reworded —
    # measured: renaming "emitted, but" to "written to disk, but" AND moving the note back out
    # of the buffer reintroduced the whole contradiction with the suite still green.
    phrases = module.EMISSION_ASSERTING_PHRASES
    assert any(any(ph in w for ph in phrases) for w in _control_emission_notes), (
        "the POSITIVE CONTROL failed: on the SUCCESS path no note matched "
        f"{phrases!r}, so the negative assertion below is vacuous — it would pass with the "
        "whole mechanism deleted.")
    claimed = [w for w in warnings if any(ph in w for ph in phrases)]
    assert not claimed, (
        "the report claims this image WAS emitted in the warnings channel while the "
        f"images_not_emitted channel says it was not: {claimed!r} vs {skipped!r}. That is the "
        "exact contradiction the two channels were split to remove.")
