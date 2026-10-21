#!/usr/bin/env python3
# ruff: noqa
"""The morphology image: ONE space shared with the cells, and the plane that was chosen.

Every assertion is against the EMITTED artifact — the declaration in the manifest entry and
the bytes on disk — never against an intermediate the compute happened to return.

The three vendor image shapes are all exercised from REAL bytes, because they are three
different code paths and a fixture covering one would leave two unproven:

* `YX`   — the prime bundle's `morphology_focus/morphology_focus_0000.ome.tif` (5-level
           pyramid, JPEG-2000);
* `CYX`  — the protein bundle's `morphology_focus/`, 12 channels across TWELVE files;
* `ZYX`  — the prime bundle's `morphology.ome.tif`, 11 focal planes, reached by removing
           `morphology_focus/` so the importer falls back the way a pre-XOA-2 bundle makes
           it fall back.
"""
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

XF.load_compute()  # installs the vendored helpers under their bare names
import ome_writer  # noqa: E402


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    out = tmp_path_factory.mktemp("xenium-prime-image")
    module, entries = XF.run_over(XF.PRIME, out)
    return {"out": out, "entries": entries, "module": module, "bundle": XF.PRIME}


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    out = tmp_path_factory.mktemp("xenium-protein-image")
    module, entries = XF.run_over(XF.PROTEIN, out)
    return {"out": out, "entries": entries, "module": module, "bundle": XF.PROTEIN}


@pytest.fixture(scope="module")
def zyx_fallback(tmp_path_factory):
    """The prime bundle with `morphology_focus/` REMOVED.

    Not a synthesised image: the bundle's own `morphology.ome.tif` is a real 11-plane focal
    stack the vendor ships, and `experiment.xenium` names it in `images.morphology_filepath`.
    Removing the focus projection is what makes the importer follow that second pointer,
    which is exactly what a bundle predating the `morphology_focus/` directory looks like.
    """
    bundle = tmp_path_factory.mktemp("xenium-zyx") / "prime"
    shutil.copytree(XF.PRIME, bundle)
    shutil.rmtree(bundle / "morphology_focus")
    out = tmp_path_factory.mktemp("xenium-zyx-out")
    module, entries = XF.run_over(bundle, out)
    return {"out": out, "entries": entries, "module": module, "bundle": bundle}


def _image(ctx):
    return XF.entry(ctx["entries"], "spatial-image-morphology")


def _coords(ctx):
    return XF.entry(ctx["entries"], "spatial-coordinates")


# ── TEST-5 [acceptance] [invariant: INV-5] ───────────────────────────────────────────
#
# "Each image declares its OWN affine INTO that space … This is the direction that
# composes: N images, one coordinate space, every pair placeable."


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_image_and_the_cells_declare_the_SAME_coordinate_space(case, prime, protein):
    """TEST-5 [acceptance] [invariant: INV-5] — one space, not two.

    The falsifier is a plausible alternative that was actually considered and rejected
    (DEC-6's rejected alternative B): give the image its own PIXEL space, which would make
    every scale rule satisfiable without touching shared code — and would mean the image and
    the cells are no longer placeable against each other, which is the whole point of the
    artifact. This assertion is what makes that shortcut visible if anyone takes it later.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    image, coords = _image(ctx), _coords(ctx)
    assert image["meta"]["coordinate_space"] == coords["meta"]["coordinate_space"]
    assert image["meta"]["unit"] == coords["meta"]["unit"] == "micrometre", (
        "the image must be placed in the CELLS' unit; a pixel-unit image beside a "
        "micrometre-unit coordinate set is two frames wearing one name"
    )
    # The coordinates sit at identity in that frame and the IMAGE carries the transform.
    assert coords["meta"]["to_space"] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    assert image["meta"]["to_space"] != coords["meta"]["to_space"]


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_affine_is_the_inverse_direction_not_the_forward_one(case, prime, protein):
    """TEST-5 [acceptance] [invariant: INV-5] — the one-line difference that is wrong for a year.

    `multimodal.visium_affine(s)` returns the FORWARD `[s,0,0,0,s,0]`; the design needs the
    INVERSE. Both are 2x3 row-major and they differ by one reciprocal, so a mix-up is
    invisible to every type and shape check in the system.

    On Xenium the two are `pixel_size * factor` (correct: microns per emitted pixel) and
    `1/pixel_size` (wrong by ~22x here). Asserting the correct value alone would pass with
    the reciprocal too if the number happened to be near 1 — it is not, so this asserts BOTH
    that the affine is the micron pitch and that it is NOT the reciprocal.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    meta = _image(ctx)["meta"]
    pixel_size = XF.experiment(ctx["bundle"])["pixel_size"]
    factor = meta["display_derivative"]["downsample_factor"]

    assert meta["to_space"][0] == pytest.approx(pixel_size * factor, rel=1e-12)
    assert meta["to_space"][4] == pytest.approx(pixel_size * factor, rel=1e-12)
    # The forward direction, which must NOT be what was written.
    assert meta["to_space"][0] != pytest.approx(1.0 / pixel_size, rel=1e-6)
    # And no translation: #176 settled the CORNER convention, so the origin maps to 0.
    assert meta["to_space"][2] == 0.0 and meta["to_space"][5] == 0.0


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_far_corner_of_the_image_lands_where_the_source_grid_says(case, prime, protein):
    """TEST-5 [acceptance] [invariant: INV-5] — the affine, the extent and the source agree.

    Applying the affine to the image's own far corner must reproduce the physical span the
    SOURCE grid implies once the ragged strip a floor division discards is accounted for.
    That is a different computation from `_reconcile_scale`'s legs: this one starts at the
    vendor's `original_extent` and `pixel_size` and arrives at the emitted corner, so a
    factor dropped from either the pixels or the affine breaks it.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    meta = _image(ctx)["meta"]
    pixel_size = XF.experiment(ctx["bundle"])["pixel_size"]
    derivative = meta["display_derivative"]
    factor = derivative["downsample_factor"]

    corner_x = meta["extent"]["width"] * meta["to_space"][0] + meta["to_space"][2]
    corner_y = meta["extent"]["height"] * meta["to_space"][4] + meta["to_space"][5]
    expected_x = (derivative["original_extent"]["width"] // factor) * pixel_size * factor
    expected_y = (derivative["original_extent"]["height"] // factor) * pixel_size * factor
    assert corner_x == pytest.approx(expected_x, rel=1e-9)
    assert corner_y == pytest.approx(expected_y, rel=1e-9)


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_every_cell_centroid_inverts_into_the_emitted_pixel_grid(case, prime, protein):
    """TEST-5 [acceptance] [invariant: INV-5] — the round trip, over every cell.

    "Every pair placeable" is only true if a consumer can actually take a position in the
    space and find the pixel it falls on. So this does that, for EVERY cell, through the
    declaration alone: invert the image's affine and require the result to be a real index
    into the emitted grid.

    A forward/inverse mix-up, a dropped downsample factor, or a transposed extent each put
    cells outside the grid; none of them changes a type or a shape.
    """
    import cyto_zarr_read as CZR

    ctx = {"prime": prime, "protein": protein}[case]
    meta = _image(ctx)["meta"]
    coords = CZR.read_array(ctx["out"] / "spatial/coordinates.zarr", "coordinates")

    px = (coords[:, 0] - meta["to_space"][2]) / meta["to_space"][0]
    py = (coords[:, 1] - meta["to_space"][5]) / meta["to_space"][4]
    assert (px >= 0).all() and (py >= 0).all(), "a cell landed left of / above the image"
    assert (px < meta["extent"]["width"]).all(), (
        f"a cell inverts to x={px.max():.1f} on a {meta['extent']['width']}-pixel-wide "
        "image — the affine, the extent and the coordinates do not describe one frame"
    )
    assert (py < meta["extent"]["height"]).all(), (
        f"a cell inverts to y={py.max():.1f} on a {meta['extent']['height']}-pixel-tall image"
    )
    # And the transposition control: swapping the two axes must NOT also fit, or the test
    # would pass on a transposed image. (Both fixtures are non-square in the pixel grid.)
    assert not ((px < meta["extent"]["height"]).all()
                and (py < meta["extent"]["width"]).all()), (
        "the emitted grid is close enough to square that a transposed affine would also "
        "satisfy this test — pick a fixture whose image is decisively non-square"
    )


# ── TEST-14: the three vendor image shapes, from real bytes ──────────────────────────


def test_the_YX_pyramidal_jpeg2000_source_is_downsampled_to_the_cap(prime):
    """TEST-14 — the #176 display derivative, firing for real for the first time.

    Every standard Visium image is COARSER than the 0.5 um/pixel cap and passes through
    untouched, so `factor > 1` had never run against real vendor pixels. Xenium's 0.2125
    um/pixel morphology image is the case #176 was built for.

    `applied_resolution_um` is 0.6375 and NOT the 0.5 cap: `downsample_factor` takes the
    CEIL because the cap is a "no finer than" bound, so the achieved resolution deliberately
    overshoots and the provenance records what was ACHIEVED. Asserting 0.5 here would be
    asserting the cap, which is precisely the confusion #176's docstring warns about.
    """
    meta = _image(prime)["meta"]
    derivative = meta["display_derivative"]

    assert derivative["downsample_factor"] == 3
    assert derivative["original_resolution_um"] == pytest.approx(XF.PIXEL_SIZE_UM)
    assert derivative["applied_resolution_um"] == pytest.approx(0.6375, rel=1e-12)
    assert derivative["applied_resolution_um"] != pytest.approx(0.5), (
        "the recorded resolution must be the one ACHIEVED, never the cap"
    )
    assert derivative["lossless"] is True
    assert derivative["codec"] == "deflate"
    assert derivative["original_extent"] == {"width": 5789, "height": 3522}
    assert derivative["emitted_extent"] == {"width": 5789 // 3, "height": 3522 // 3}
    assert meta["extent"] == derivative["emitted_extent"]
    # The source it names must be the vendor's own path, not a bare stem.
    assert derivative["original_source"] == "morphology_focus/morphology_focus_0000.ome.tif"
    assert meta["source"] == derivative["original_source"]


def test_the_emitted_bytes_on_disk_carry_the_grid_and_the_scale(prime):
    """TEST-14 — read the FILE back, not the declaration that describes it.

    OME `PhysicalSizeX/Y` is what a generic reader — one that knows nothing about the `cyto`
    payload — measures with, so a pre-downsample value there misscales every tool outside
    this system by exactly the factor. `_reconcile_scale` checks the declaration against
    itself; this checks the bytes.
    """
    import re

    import tifffile

    meta = _image(prime)["meta"]
    dest = prime["out"] / "spatial-image-morphology.ome.tif"
    assert dest.is_file()

    with tifffile.TiffFile(str(dest)) as handle:
        series = handle.series[0]
        assert str(series.axes) == "YX"
        assert series.shape == (meta["extent"]["height"], meta["extent"]["width"])
        xml = handle.ome_metadata or ""
        # The rendering pyramid is a separate thing from the display derivative: level 0 IS
        # the artifact, and the halvings below it are a viewer's overview.
        assert len(series.levels) > 1, "a 1929x1174 image should carry overview levels"
        assert series.levels[0].shape == series.shape

    pixels = re.search(r"<Pixels[^>]*>", xml).group(0)
    for attr in ("PhysicalSizeX", "PhysicalSizeY"):
        value = float(re.search(attr + r'="([^"]+)"', pixels).group(1))
        assert value == pytest.approx(0.6375, rel=1e-9), (
            f"OME {attr} must be the EMITTED pixel pitch, not the source's"
        )
    assert 'PhysicalSizeXUnit="µm"' in pixels


def test_the_multi_file_CYX_source_selects_DAPI_and_says_so(protein):
    """TEST-14 — 12 channels across 12 files, reduced to one DECLARED plane.

    `ome_writer.read_image` refuses a `CYX` series outright — correctly, and its comment
    names the Xenium morphology image as the case it guards against — so the reduction
    happens in this package and the choice is recorded. A reader cannot recover WHICH
    channel from the bytes, so a selection that is not declared is a selection that is lost.
    """
    meta = _image(protein)["meta"]
    selection = meta["plane_selection"]

    assert selection["axes"] == "CYX"
    assert selection["axis"] == "C"
    assert selection["index"] == 0
    assert selection["of"] == 12
    assert selection["rule"] == "channel-name-match", (
        "index 0 must be reached by MATCHING the channel name, not by falling back to the "
        "first channel — the rule is what distinguishes a choice from a default"
    )
    assert selection["channel_name"] == "DAPI"
    # The other eleven are named too, so a user can see what was not emitted.
    assert len(selection["available"]) == 12
    assert "PD-L1" in selection["available"] and "VISTA" in selection["available"]


def test_the_CYX_selection_emits_the_PIXELS_of_the_channel_it_declares(protein):
    """TEST-14 — THE BYTE-LEVEL ORACLE, and the reason it exists.

    Everything in the test above reads `plane_selection`, which is a string the code under
    test wrote ABOUT ITSELF. A blind mutation proved that hollow: emitting
    `pages[(index + 3)]`'s pixels while still declaring index 0 / `channel_name: "DAPI"` /
    `rule: "channel-name-match"` left the ENTIRE package suite green. That is precisely the
    failure `xenium_image._channel_index`'s own docstring says the branch exists to prevent
    — *"a plausible-looking image labelled as the wrong stain … worse than no image, since
    nothing downstream could tell"* — and until this test existed, nothing downstream could.

    So the emitted pixels are compared to the DECLARED channel's own pixels, read
    independently from the vendor file, after applying the same box mean the importer
    applied. The `ZYX` sibling already did this; the `CYX` path did not.
    """
    import tifffile

    entry = _image(protein)
    meta = entry["meta"]
    index = meta["plane_selection"]["index"]
    factor = meta["display_derivative"]["downsample_factor"]

    source_path = (XF.PROTEIN / meta["source"])
    with tifffile.TiffFile(str(source_path)) as handle:
        declared = handle.series[0].pages[index].asarray()
        # THE DISCRIMINATOR: a different channel of the same image, so "the pixels match"
        # cannot be satisfied by every channel being identical (they are not — asserted).
        other = handle.series[0].pages[(index + 3) % len(handle.series[0].pages)].asarray()
    assert not np.array_equal(declared, other), (
        "the fixture's channels must actually DIFFER, or comparing against the declared one "
        "proves nothing about which was selected"
    )

    expected = ome_writer.downsample(declared, factor)
    with tifffile.TiffFile(str(protein["out"] / entry["path"])) as handle:
        emitted = handle.series[0].asarray()
    assert np.array_equal(emitted, expected), (
        "the emitted pixels are not the pixels of the channel this artifact DECLARES. The "
        "declaration and the bytes are two facts and only this assertion compares them."
    )


def test_the_channel_rule_is_a_real_match_and_not_a_relabelled_fallback():
    """TEST-14 — `rule: "channel-name-match"` asserted where it can be FALSIFIED.

    In the only real `CYX` bundle DAPI is `ch0000`, so "matched the name" and "took channel
    0" produce the same index and the same declaration — the assertion in the test above
    cannot tell them apart, and a mutation replacing the whole match loop with `return 0,
    "channel-name-match", names[0]` kept the suite green.

    `_channel_index` is called directly, with the names REORDERED, which is the one way to
    make the two answers differ without inventing a fixture.
    """
    import xenium_image as XI

    names = ["ATP1A1/CD45/E-Cadherin", "18S", "DAPI", "PD-1"]
    index, rule, name = XI._channel_index(names, len(names), Path("ch0000_atp1a1.ome.tif"))
    assert (index, rule, name) == (2, "channel-name-match", "DAPI"), (
        "DAPI must be found BY NAME wherever it sits; returning 0 here is the fallback "
        "wearing the match's label"
    )

    # No DAPI at all -> the filename's own index, and the rule says so.
    index, rule, _ = XI._channel_index(["18S", "PD-1", "VISTA"], 3,
                                       Path("ch0002_dapi.ome.tif"))
    assert (index, rule) == (2, "filename-match"), (
        "with no channel names to match, the filename's index is the answer — NOT 0, which "
        "would emit another stain's pixels under the filename's label"
    )

    # No name, no usable filename -> channel 0, and the rule must NOT claim a match.
    index, rule, _ = XI._channel_index(["18S", "PD-1"], 2, Path("morphology_focus_0000.ome.tif"))
    assert (index, rule) == (0, "first-channel")

    # A filename index the series does not have must NOT assert a stain it never verified.
    index, rule, _ = XI._channel_index([], 2, Path("ch0009_dapi.ome.tif"))
    assert (index, rule) == (0, "first-channel")


def test_the_selection_of_one_plane_from_a_stack_is_reported_not_only_declared(protein):
    """TEST-14 — the warning channel, because `meta` is not what a human reads.

    Eleven real measured channels are not in this artifact. #211 records that `meta` reaches
    no sandboxed consumer; the report is where a person finds out.
    """
    import json

    report = json.loads((protein["out"] / "xenium-import-report.json").read_text())
    stack_notes = [w for w in report["image_warnings"] if "CYX stack of 12 planes" in w]
    assert len(stack_notes) == 1, report["image_warnings"]
    assert "DAPI" in stack_notes[0]
    assert "channel-name-match" in stack_notes[0]
    assert "remain in the uploaded bundle" in stack_notes[0]


def test_the_ZYX_focal_stack_falls_back_and_takes_the_middle_plane(zyx_fallback):
    """TEST-14 — the third shape, and the bytes prove WHICH plane.

    Reached by removing `morphology_focus/`, so the importer follows
    `experiment.xenium`'s second pointer. The declaration says "middle plane"; this asserts
    the emitted PIXELS are that plane, box-meaned by the same factor — which is the only way
    to tell a correct selection from an off-by-one or from plane 0.
    """
    import tifffile

    meta = _image(zyx_fallback)["meta"]
    selection = meta["plane_selection"]
    assert selection["axes"] == "ZYX"
    assert selection["axis"] == "Z"
    assert selection["of"] == 11
    assert selection["index"] == 5, "11 planes -> the middle is index 5"
    assert selection["rule"] == "middle-plane"
    assert meta["source"] == "morphology.ome.tif"

    source = zyx_fallback["bundle"] / "morphology.ome.tif"
    with tifffile.TiffFile(str(source)) as handle:
        plane5 = handle.series[0].pages[5].asarray()
        plane0 = handle.series[0].pages[0].asarray()

    ome_writer = sys.modules["ome_writer"]
    expected = ome_writer.downsample(plane5, meta["display_derivative"]["downsample_factor"])

    with tifffile.TiffFile(str(zyx_fallback["out"] / "spatial-image-morphology.ome.tif")) as h:
        emitted = h.series[0].levels[0].asarray()

    assert emitted.shape == expected.shape
    assert np.array_equal(emitted, expected), (
        "the emitted pixels must be the MIDDLE plane, box-meaned — not plane 0, not a "
        "projection over z, and not an interpolation"
    )
    # The discriminator: plane 0 must NOT also match, or "middle" would be unfalsifiable.
    assert not np.array_equal(
        emitted, ome_writer.downsample(plane0, meta["display_derivative"]["downsample_factor"])
    ), "planes 0 and 5 are indistinguishable in this fixture; the selection is unprovable"
