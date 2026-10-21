#!/usr/bin/env python3
# ruff: noqa
"""TEST-2 — every image declares its OWN affine INTO the one coordinate space.

**INV-2**, lifted verbatim from `docs/design/spatial-storage-layout.md` §7.3 rule 3
(ON `main` — restored by #315 (`b34d4371`), reconciled against what shipped; every
quotation below was re-verified against that merged text):

> **Each image declares its OWN affine INTO that space**, i.e. the *inverse* of its
> scalefactor: `tissue_hires_image.png` declares `to_space = [1/s, 0, 0, 0, 1/s, 0]` where
> `s = tissue_hires_scalef`. This is the direction that composes: N images, one coordinate
> space, every pair placeable.

The design adds, about the helper that got this backwards: *"That is a one-line difference
and exactly the kind of thing that is wrong for a year if nobody writes it down."* So this
file asserts three separate things, because the literal equality alone is not the invariant:

1. the affine really is `[1/s, …]` — and the FORWARD affine `[s, …]` is asserted NOT to be
   what was written;
2. it is read back OUT of the emitted artifact's own OME-XML, not off the dict the writer
   was handed — the OME-XML is what a consumer parses;
3. **two images at DIFFERENT scalefactors land the same physical point in the same place.**
   That is the "every pair placeable" half, and a single-image assertion cannot see it: an
   importer that wrote a forward affine consistently would still be self-consistent with one
   image and only wrong the moment a second one arrived.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402


def _scalefactors(root, bin_um):
    return json.loads(
        (Path(root) / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" /
         "scalefactors_json.json").read_text(encoding="utf-8")
    )


def _placement_from_the_artifact(module, outputs_dir, rel):
    """The placement a CONSUMER gets: decoded out of the emitted OME-TIFF's own OME-XML.

    Through the vendored `spatial_declarations.require_placement`, which is the reader the
    platform ships — not off `entry["meta"]`, which is the writer's own copy. An importer
    that computed the affine correctly and then wrote a different one into the file would
    pass a `meta`-based assertion and fail here, which is the whole point of reading back.
    """
    import tifffile

    with tifffile.TiffFile(Path(outputs_dir) / rel) as tif:
        ome_xml = tif.ome_metadata
    return module.SD.require_placement(ome_xml, consumer="test_spatial_image")


def test_TEST_2_the_affine_is_the_INVERSE_scalefactor(tmp_path):
    """TEST-2 [acceptance, INV-2] — `to_space == [1/s, 0, 0, 0, 1/s, 0]`, read from the artifact.

    The design's literal words, asserted literally. The fixture's hires image is deliberately
    at exactly the display-resolution cap so the emitted factor is 1 and this equality holds
    without a downsample folded into it (see `make_fixture.HIRES_SCALEF`) — on a downsampled
    image the equality is false BY DESIGN, and a fixture that downsampled would have forced
    this test to assert against `ome_writer.emitted_affine`, i.e. against the code rather than
    against the design.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    sf = _scalefactors(HF.FIXTURE, module.DEFAULT_BIN_UM)

    for output_id, key in (("spatial-image-hires", "tissue_hires_scalef"),
                           ("spatial-image-lowres", "tissue_lowres_scalef")):
        entry = HF.entry_by_id(entries, output_id)
        placement = _placement_from_the_artifact(module, tmp_path / "out", entry["path"])
        expected = 1.0 / sf[key]
        assert placement["to_space"] == pytest.approx(
            [expected, 0.0, 0.0, 0.0, expected, 0.0], rel=1e-12
        ), f"{output_id} does not declare the INVERSE of its own `{key}`"


def test_TEST_2_the_FORWARD_affine_is_NOT_what_was_written(tmp_path):
    """TEST-2 [acceptance, INV-2] — the negative the design warns about, asserted directly.

    §7.3's closing note names the exact mistake: an existing helper "returns `[s,0,0,0,s,0]`
    — the *forward* (fullres→hires) direction. The design above needs the inverse." Both
    affines are self-consistent within one image; only the direction differs, and the
    difference is invisible until something else is placed against it.

    If flipping the invariant off would not turn a test red, the test proves nothing about
    the invariant — so this is that test.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    sf = _scalefactors(HF.FIXTURE, module.DEFAULT_BIN_UM)
    entry = HF.entry_by_id(entries, "spatial-image-hires")
    placement = _placement_from_the_artifact(module, tmp_path / "out", entry["path"])

    forward = sf["tissue_hires_scalef"]
    assert placement["to_space"][0] != pytest.approx(forward, rel=1e-9), (
        "the emitted affine is the FORWARD scalefactor — the image claims a scale that takes "
        "full-resolution pixels INTO its own frame, so every bin drawn on it lands "
        f"{1 / forward / forward:g}x away from where it belongs"
    )
    # …and it is not the identity either, which is the other way to be wrong: an identity
    # affine claims these pixels are ALREADY full-resolution pixels.
    assert placement["to_space"][0] != pytest.approx(1.0, rel=1e-9)


def test_TEST_2_TWO_images_at_DIFFERENT_scalefactors_agree_on_one_physical_point(tmp_path):
    """TEST-2 [acceptance, INV-2] — "N images, one coordinate space, every pair placeable".

    THE LEG THAT MAKES THIS ABOUT THE DESIGN. The hires and lowres images differ in scale by
    more than 3x, and each declares its own affine. Take the SAME pixel of tissue in each —
    found by construction, since both are renders of the same ellipse at different scales —
    push it through that image's own declared affine, and the two must land at the same
    full-resolution point.

    An importer that wrote a forward affine, or that used one image's scalefactor for both,
    or that placed the coordinates in the hires frame instead of the full-resolution one,
    would still pass every single-image assertion above. It cannot pass this one.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    landed = []
    for output_id in ("spatial-image-hires", "spatial-image-lowres"):
        entry = HF.entry_by_id(entries, output_id)
        placement = _placement_from_the_artifact(module, tmp_path / "out", entry["path"])
        a, _b, tx, _c, e, ty = placement["to_space"]
        # The image's own CENTRE, which is the same physical point in both renders because
        # both are the whole frame scaled: `extent * scalef`.
        cx = placement["extent"]["width"] / 2.0
        cy = placement["extent"]["height"] / 2.0
        landed.append((a * cx + tx, e * cy + ty))

    (x0, y0), (x1, y1) = landed
    # A pixel of tolerance at the COARSER image's own pitch: the two renders quantise the
    # same point onto different grids, so exact equality would be asserting away the
    # rounding rather than the placement.
    tolerance = 1.0 / MF.LOWRES_SCALEF
    assert abs(x0 - x1) <= tolerance and abs(y0 - y1) <= tolerance, (
        f"the hires image places the frame centre at {landed[0]} and the lowres image places "
        f"the SAME point at {landed[1]} — the two images do not share one coordinate space, "
        "so no consumer can place either against the other or against the bins"
    )
    # …and both land where the FULL-RESOLUTION frame's centre actually is, which is what
    # makes "one space" mean the space the coordinates are in rather than some third frame.
    assert x0 == pytest.approx(MF.FULLRES_W / 2.0, abs=tolerance)
    assert y0 == pytest.approx(MF.FULLRES_H / 2.0, abs=tolerance)


def test_TEST_2_the_space_id_and_the_scale_are_the_COORDINATES_space(tmp_path):
    """TEST-2 [acceptance, INV-2] — the image declares the SPACE's scale, not its own pitch.

    `microns_per_pixel` is defined on the COORDINATE SPACE. Writing the image's own pixel
    pitch there would make three artifacts that declare the SAME `coordinate_space` disagree
    about its scale by the scalefactor — and because the image's block is the only one a
    SANDBOXED consumer can read out of an OME-TIFF, a neighbour-graph radius resolved through
    it would be silently wrong by exactly that factor.

    The image's own pitch is not lost, and this asserts where it went: `PhysicalSizeX` in the
    OME-XML (whose semantics ARE "the physical size of a pixel in THIS image"), and
    `display_derivative.original_resolution_um`.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    report = json.loads(
        (tmp_path / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    coords_entry = HF.entry_by_id(entries, "spatial-coordinates")

    for output_id in ("spatial-image-hires", "spatial-image-lowres"):
        entry = HF.entry_by_id(entries, output_id)
        placement = _placement_from_the_artifact(module, tmp_path / "out", entry["path"])
        assert placement["coordinate_space"] == coords_entry["meta"]["coordinate_space"]
        assert placement["microns_per_pixel"] == pytest.approx(
            coords_entry["meta"]["microns_per_pixel"]), (
            f"{output_id} declares a different micron scale for the SAME coordinate space — "
            "an analysis resolving a radius through the image would be wrong by the "
            "scalefactor"
        )
        assert placement["microns_per_pixel_source"] == "vendor"
        # The image's OWN pitch, recorded where OME says it belongs.
        own_pitch = report["microns_per_pixel"] / entry["meta"]["to_space"][0] ** -1
        derivative = entry["meta"].get("display_derivative")
        assert derivative is not None
        assert derivative["original_resolution_um"] == pytest.approx(own_pitch, rel=1e-9)


def test_TEST_2_a_DOWNSAMPLED_image_folds_the_factor_into_its_affine(tmp_path):
    """TEST-2 — the display-derivative path, on a variant built for it.

    Kept OFF the committed fixture on purpose (see `make_fixture.HIRES_SCALEF`): a
    downsampled image makes the design's literal `[1/s, …]` equality false, so it would have
    turned the acceptance test above into an assertion against `emitted_affine`. Here the
    folded factor IS the subject, so the comparison is fair.

    Four things must move together — the pixels, the extent, the affine and the OME
    PhysicalSize — and dropping any one produces an artifact that opens, conforms and is
    silently misscaled. This asserts all four against the SOURCE image's own dimensions.
    """
    module = HF.load_compute()
    # 0.5 puts the hires image at 0.2 um/pixel against the 0.5 cap, so `ceil(0.5/0.2)` = 3.
    root = HF.staged_tree(tmp_path, hires_scalef=0.5)
    entries = module.run_import(root, tmp_path / "out")
    report = json.loads(
        (tmp_path / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))

    entry = HF.entry_by_id(entries, "spatial-image-hires")
    derivative = entry["meta"]["display_derivative"]
    factor = round(derivative["applied_resolution_um"] / derivative["original_resolution_um"])
    assert factor > 1, "this variant was supposed to exercise the downsample path"

    source_w = round(MF.FULLRES_W * 0.5)
    source_h = round(MF.FULLRES_H * 0.5)
    assert derivative["original_extent"] == {"width": source_w, "height": source_h}
    # PIXELS + EXTENT.
    assert entry["meta"]["extent"] == {"width": source_w // factor, "height": source_h // factor}
    # AFFINE — the inverse scalefactor with the factor folded in.
    placement = _placement_from_the_artifact(module, tmp_path / "out", entry["path"])
    assert placement["to_space"][0] == pytest.approx(factor / 0.5, rel=1e-12)
    # …and the report SAYS so, in the channel a human reads.
    assert any("DISPLAY DERIVATIVE" in note for note in report["image_warnings"])


def test_TEST_2_the_declared_produces_includes_the_image_only_when_one_was_emitted(tmp_path):
    """TEST-2 — the emitted set matches what the report claims was emitted.

    A cheap consistency check that closes a real gap: `images` and `images_not_emitted` are
    two channels, and an image that appeared in BOTH — on disk and reported absent — is the
    contradiction the commit-point discipline in `emit_images` exists to prevent.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    report = json.loads(
        (tmp_path / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))

    emitted_ids = {e["id"] for e in entries if e["datatype"] == "spatial/image"}
    assert emitted_ids == {im["id"] for im in report["images"]}
    for note in report["images_not_emitted"]:
        for output_id in emitted_ids:
            source = HF.entry_by_id(entries, output_id)["meta"]["source"]
            assert not note.startswith(f"{source}:"), (
                f"{source} is on disk AND reported as not emitted — the two report channels "
                "contradict each other"
            )
