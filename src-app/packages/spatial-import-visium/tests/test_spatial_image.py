#!/usr/bin/env python3
# ruff: noqa
"""`spatial/image` and the coordinate-space affine (#155).

The affine is the one declaration in this epic that NO gate can check (§12.2 item 2), so
these tests are the closest thing to a mechanical check that exists — and they are careful
to assert the DESIGN's promise rather than the code's behaviour. Two habits carry that:

* every expected number is computed from the VENDOR's own `scalefactors_json.json` and
  `tissue_positions.csv`, parsed independently of the importer, so agreeing is evidence;
* the wrong answer is asserted to be WRONG. It is not enough that `to_space` equals what
  the importer produced — the FORWARD affine (the in-tree `visium_affine(s)` spelling) is
  asserted to fail the same round trip, because a test that only confirms the current
  output would still pass if the direction were flipped in both places at once.

The image fixture is NON-SQUARE on purpose (§7.3 rule 5: "a square image passes a
transposed affine silently"), and the shipped vendor image cannot serve — see
`visium_fixtures.make_imaged`.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import tifffile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


@pytest.fixture(scope="module")
def imaged(tmp_path_factory):
    """The REAL importer over a coherent, non-square, two-image bundle.

    `write_manifest` is called too, not just `run_import`, so `outputs_dir` is the complete
    document the server consumes — which is what lets the conformance leg below run the
    real gate rather than a stand-in.
    """
    bundle = VF.make_imaged(tmp_path_factory.mktemp("imaged-src"))
    out = tmp_path_factory.mktemp("imaged-out")
    module, entries = VF.run_over(bundle, out)
    module.write_manifest(out, entries)
    return {"module": module, "entries": entries, "out": out, "bundle": bundle}


def images_of(entries):
    return [e for e in entries if e["datatype"] == "spatial/image"]


def image_by_id(entries, output_id):
    return VF.entry_by_id(entries, output_id)


# ── TEST-1 [acceptance] [invariant: INV-4] — always an OME-TIFF ──────────────────────


def test_the_emitted_image_is_an_ome_tiff_and_never_the_vendor_png(imaged):
    """TEST-1 [acceptance] [invariant: INV-4] — one image path, one reader.

    The vendor shipped a PNG. INV-4's promise is that we "still write OME-TIFF so that one
    code path serves both scales", and the check is on the BYTES, not on the filename: a
    file called `.ome.tif` containing PNG bytes would satisfy any name-based assertion.
    """
    entry = image_by_id(imaged["entries"], "spatial-image-hires")
    path = imaged["out"] / entry["path"]
    head = path.read_bytes()[:4]
    assert head in (b"II*\x00", b"MM\x00*"), (
        f"the emitted image does not start with a TIFF magic number (got {head!r}) — a "
        "vendor PNG was passed through, which is the two-path branch INV-4 exists to "
        "prevent"
    )
    with tifffile.TiffFile(path) as tf:
        assert tf.is_ome, "the emitted file is a TIFF but not an OME-TIFF"
    # And the source really was a PNG, so the conversion is the thing being proven and not
    # an accident of the fixture.
    assert (imaged["bundle"] / "spatial" / "tissue_hires_image.png").exists()
    assert entry["structure"] == {
        "encoding": "opaque", "media_type": "image/tiff; application=ome"
    }


# ── TEST-2 [acceptance] [invariant: INV-8] — no store inside the bytes ───────────────


def test_the_image_artifact_carries_no_zarr_json_and_is_one_blob(imaged):
    """TEST-2 [acceptance] [invariant: INV-8] — `_bytes_are_not_a_store` cannot condemn it.

    `conformance.py:1705-1712` refuses any `opaque` artifact containing a `zarr.json`. That
    rule is what forces OME-TIFF over OME-Zarr for this kind (§12.2 item 1), so an artifact
    that smuggled a store inside would not merely be untidy — it would be REFUSED at
    ingest, after the import appeared to succeed.
    """
    entry = image_by_id(imaged["entries"], "spatial-image-hires")
    path = imaged["out"] / entry["path"]
    assert path.is_file(), "the image artifact must be ONE blob, not a directory"
    assert entry["layout"] == "opaque"
    # A file has no members, so there is nothing to walk — but assert it the way a reader
    # would discover it, rather than inferring it from `is_file`.
    assert b"zarr.json" not in path.read_bytes()


def test_the_emitted_artifacts_pass_the_real_conformance_gate(imaged):
    """TEST-2 (cont.) [acceptance] [invariant: INV-8] — the REAL gate, not a proxy.

    The assertions above stand in for `_bytes_are_not_a_store`; this runs the actual
    `conformance.conform_outputs` the server applies at ingest, over the whole manifest
    this import wrote. That is the difference between "we believe this conforms" and "the
    gate says so", and it is what `clustering`, `embedding` and `differential-expression`
    already do in their producer end-to-end tests.

    It covers more than INV-8: the `opaque` media type must satisfy `_MEDIA_TYPE_RE`, the
    declared path must exist, the structure/meta pair must be well-formed, and the ~2 KiB
    per-entry manifest budget must hold with the coordinate-space block added.
    """
    import conformance

    violations = conformance.conform_outputs(imaged["out"], full=True)
    assert violations == [], violations

    # …and the gate really was applied to the image artifacts, not just to the ones that
    # existed before this item. A green run over a manifest with no images would prove
    # nothing about the kind this item introduces.
    manifest = json.loads((imaged["out"] / "manifest.json").read_text())
    gated = {e["id"] for e in manifest["outputs"] if e["datatype"] == "spatial/image"}
    assert gated == {"spatial-image-hires", "spatial-image-lowres"}, gated


# ── TEST-3 [acceptance] [invariant: INV-2] — the affine is the INVERSE ───────────────


def test_the_affine_is_the_inverse_scalefactor_and_the_forward_one_fails(imaged):
    """TEST-3 [acceptance] [invariant: INV-2] — the direction that composes.

    The whole content of INV-2 is a reciprocal. The in-tree `multimodal.py:423-429`
    `visium_affine(s)` returns the FORWARD `[s,0,0,0,s,0]`; §7.3 calls the difference "a
    one-line difference that is wrong for a year if nobody writes it down."

    So this asserts BOTH directions: the declared affine round-trips the vendor's own
    numbers, and the forward affine does NOT. Without the second half the test would still
    pass if someone flipped the convention consistently, which is exactly the silent
    failure INV-1 describes.
    """
    scalef = VF.scalefactors()["tissue_hires_scalef"]
    entry = image_by_id(imaged["entries"], "spatial-image-hires")
    to_space = entry["meta"]["to_space"]

    assert to_space == pytest.approx([1.0 / scalef, 0, 0, 0, 1.0 / scalef, 0]), (
        f"to_space {to_space} is not the INVERSE of tissue_hires_scalef={scalef}"
    )

    # The round trip, over the VENDOR's own full-resolution positions.
    xs, ys = VF.expected_xy()
    a, b, tx, c, d, ty = to_space
    for fx, fy in list(zip(xs, ys))[:20]:
        # full-res -> this image's pixels is the vendor's own scaling...
        px, py = fx * scalef, fy * scalef
        # ...and the declared affine must take them back.
        assert a * px + b * py + tx == pytest.approx(fx, rel=1e-6)
        assert c * px + d * py + ty == pytest.approx(fy, rel=1e-6)

    # The producer's OWN affine builder must return the inverse and NOT the forward
    # spelling. Asserted against the function rather than against a local literal: a
    # comparison between two constants written in this test is an arithmetic identity
    # (`0.04*fx != fx`) that cannot depend on the code under test, so it would keep passing
    # if `inverse_scalefactor_affine` were changed to return the forward direction.
    VF.load_compute()
    OW = sys.modules["ome_writer"]
    built = OW.inverse_scalefactor_affine(scalef)
    assert built == pytest.approx([1.0 / scalef, 0, 0, 0, 1.0 / scalef, 0])
    assert built[0] != pytest.approx(scalef), (
        "the builder returned the FORWARD affine (the in-tree `visium_affine(s)` "
        "spelling); INV-2 needs the inverse, which is the direction that composes"
    )
    # …and the emitted artifact really carries what the builder produced, so the two
    # assertions above are about the shipped path and not about an unused helper.
    assert to_space == pytest.approx(built)


# ── TEST-4 [acceptance] [invariant: INV-7] — the non-square check ────────────────────


def test_the_extent_is_not_transposed_on_a_non_square_image(imaged):
    """TEST-4 [acceptance] [invariant: INV-7] — a square image would hide this.

    A numpy image is `(rows, cols) = (height, width)` and §6.6's extent is
    `{width, height}`. The swap is invisible on a square image, which is precisely why
    §7.3 rule 5 demands a non-square fixture — and why the shipped vendor image cannot
    serve here even now that it is real and coherent (#243): it is 2000x2000, i.e. square.
    """
    entry = image_by_id(imaged["entries"], "spatial-image-hires")
    extent = entry["meta"]["extent"]

    assert extent["width"] != extent["height"], (
        "the image fixture is SQUARE, so this assertion cannot detect a transposed "
        "extent and the invariant is untested. Regenerate it non-square."
    )

    # The truth, read from the written file by an OME reader rather than from the array
    # the importer happened to hold.
    with tifffile.TiffFile(imaged["out"] / entry["path"]) as tf:
        level0 = tf.series[0].levels[0].shape
    assert extent == {"width": int(level0[1]), "height": int(level0[0])}
    # And it agrees with the fixture's own declared frame, computed independently.
    scalef = VF.scalefactors()["tissue_hires_scalef"]
    assert extent == {
        "width": int(round(VF.IMAGED_FULLRES_W * scalef)),
        "height": int(round(VF.IMAGED_FULLRES_H * scalef)),
    }


# ── TEST-5 [acceptance] [invariant: INV-1] — the SPACE, not the scalefactor ──────────


def test_the_image_declares_a_space_and_never_a_bare_scalefactor(imaged):
    """TEST-5 [acceptance] [invariant: INV-1] — "declare the space, never the scale factor".

    A scalefactor is a number whose meaning depends on a convention the reader has to
    already know; a declared space says what the numbers mean. So the positive half is
    that the full §6.6 block is present and names the SAME space the coordinates do, and
    the negative half is that no bare scalefactor is anywhere in the image's `meta` for a
    consumer to reach for instead.
    """
    entry = image_by_id(imaged["entries"], "spatial-image-hires")
    meta = entry["meta"]
    coords = VF.entry_by_id(imaged["entries"], "spatial-coordinates")["meta"]

    assert set(("coordinate_space", "unit", "to_space", "extent")) <= set(meta)
    assert isinstance(meta["coordinate_space"], str) and meta["coordinate_space"].strip()
    assert meta["coordinate_space"] == coords["coordinate_space"], (
        "the image minted its own space instead of placing itself into the coordinates' "
        "frame — two spaces cannot be composed"
    )
    assert meta["unit"] == "pixel"

    flat = json.dumps(meta).lower()
    for forbidden in ("scalef", "scale_factor", "scalefactor"):
        assert forbidden not in flat, (
            f"the image meta exposes a bare {forbidden!r}. INV-1 is that a consumer reads "
            "a declared space, never a raw scale factor whose meaning it has to assume."
        )


def test_every_artifact_in_one_space_agrees_on_that_space_s_micron_scale(imaged):
    """TEST-5 (cont.) [acceptance] [invariant: INV-1] — one space, ONE scale.

    `microns_per_pixel` is a property of the coordinate SPACE, not of an artifact:
    `coordinate_space`'s docstring defines it that way and `require_micron_scale(space, …)`
    is documented as "the micron scale of `space`". So every artifact declaring the same
    `coordinate_space` must answer that accessor identically.

    The failure this pins is not theoretical and is not cosmetic. Declaring each image's
    OWN pixel pitch here instead makes the hires image answer 5x and the lowres image
    16.7x the coordinates' value for one named space — and because the image's block is the
    ONLY one a sandboxed consumer can read (INV-10), a neighbour-graph radius resolved
    through it is silently wrong by exactly that factor, with a plausible number at the end.
    That is the failure `require_micron_scale` exists to prevent, reintroduced one level up.

    The image's own pitch is NOT lost — it is `microns_per_pixel * to_space[0]`, and it is
    recorded verbatim in the display-derivative block — so nothing is traded away for this.
    """
    SD = sys.modules["spatial_declarations"]
    entries = imaged["entries"]
    coords_meta = VF.entry_by_id(entries, "spatial-coordinates")["meta"]
    space_scale = SD.require_micron_scale(coords_meta, consumer="the test")

    placed = [e for e in entries if e["datatype"] == "spatial/image"] + [
        VF.entry_by_id(entries, "spatial-coordinates")
    ]
    assert len({e["meta"]["coordinate_space"] for e in placed}) == 1

    for entry in placed:
        assert SD.require_micron_scale(
            entry["meta"], consumer="a neighbour-graph analysis"
        ) == pytest.approx(space_scale), (
            f"{entry['id']} answers a different micron scale for the SAME coordinate "
            f"space than the coordinates do ({space_scale})"
        )
        # …and the same answer comes back through the BYTES, which is the only channel a
        # sandboxed consumer has.
        if entry["datatype"] != "spatial/image":
            continue
        with tifffile.TiffFile(imaged["out"] / entry["path"]) as tf:
            placement = SD.require_placement(tf.ome_metadata, consumer="a probe")
        assert SD.require_micron_scale(
            placement, consumer="a sandboxed analysis"
        ) == pytest.approx(space_scale)

    # The images really are at DIFFERENT pixel pitches, or this test would pass trivially
    # by there being nothing to disagree about. Each image's own pitch is recoverable.
    pitches = {
        e["id"]: e["meta"]["microns_per_pixel"] * e["meta"]["to_space"][0]
        for e in entries if e["datatype"] == "spatial/image"
    }
    assert len(set(pitches.values())) == len(pitches) > 1, pitches
    for entry in (e for e in entries if e["datatype"] == "spatial/image"):
        derivative = entry["meta"].get("display_derivative")
        if derivative:
            assert derivative["original_resolution_um"] == pytest.approx(
                pitches[entry["id"]]
            ), "the image's own pitch disagrees with its recorded original resolution"


# ── TEST-6 [acceptance] [invariant: INV-3] — the coordinates are untouched ───────────


def test_the_coordinates_stay_in_fullres_pixels_at_identity(imaged):
    """TEST-6 [acceptance] [invariant: INV-3] — the image moved, not the coordinates.

    The tempting shortcut when adding an image is to scale the coordinates onto it. §7.3
    rules 1-2 forbid it: that would bake in a choice of image and make the SECOND image
    unplaceable. Read back from the written store, not from the writer's return value.
    """
    entry = VF.entry_by_id(imaged["entries"], "spatial-coordinates")
    assert entry["meta"]["to_space"] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    assert entry["meta"]["unit"] == "pixel"

    coords = VF.read_member(imaged["out"], "spatial/coordinates.zarr", "coordinates")
    xs, ys = VF.expected_xy()
    assert coords.shape == (len(xs), 2)
    # Still the VENDOR's full-resolution numbers — not multiplied by any scalefactor.
    assert coords[:, 0] == pytest.approx(np.asarray(xs, dtype=np.float32))
    assert coords[:, 1] == pytest.approx(np.asarray(ys, dtype=np.float32))


# ── TEST-7 [acceptance] [invariant: INV-5] — lossless, and lossy unreachable ─────────


def test_the_writer_is_lossless_and_refuses_a_lossy_codec(tmp_path):
    """TEST-7 [acceptance] [invariant: INV-5] — averaged pixels, never invented ones.

    Two halves, because either alone is weak. Losslessness is asserted on the DECODED
    pixels (a codec name in the metadata proves nothing about the bytes), and the lossy
    path is asserted to be UNREACHABLE rather than merely unused — "we happen not to pass
    jpeg" is one edit away from shipping it.
    """
    module = VF.load_compute()
    OW = sys.modules["ome_writer"]
    SD = module.SD

    rng = np.random.default_rng(1155)
    # Non-square, and RANDOM so a lossy codec could not survive it by luck.
    src = rng.integers(0, 255, (180, 300, 3), dtype=np.uint8)
    placement = SD.image_meta(space=SD.coordinate_space(
        space="t", unit="pixel", to_space=[5, 0, 0, 0, 5, 0],
        extent={"width": 300, "height": 180},
    ))

    dest = OW.write_ome_tiff(tmp_path / "lossless.ome.tif", src, placement=placement)
    with tifffile.TiffFile(dest) as tf:
        decoded = tf.series[0].levels[0].asarray()
    assert np.array_equal(decoded, src), (
        "the decoded level-0 pixels differ from the source — the write was not lossless"
    )

    for lossy in ("jpeg", "webp", "jpeg2000"):
        with pytest.raises(SD.SpatialDeclarationError) as exc:
            OW.write_ome_tiff(tmp_path / f"{lossy}.ome.tif", src, placement=placement,
                              codec=lossy)
        assert "lossy" in str(exc.value).lower()
    with pytest.raises(SD.SpatialDeclarationError):
        OW.write_ome_tiff(tmp_path / "nonsense.ome.tif", src, placement=placement,
                          codec="not-a-codec")


# ── TEST-8 [acceptance] [invariant: INV-9] — never fabricate a placement ─────────────


def test_an_unplaceable_image_is_dropped_rather_than_given_an_identity_affine(
        tmp_path_factory):
    """TEST-8 [acceptance] [invariant: INV-9] — absence is absence, for the affine too.

    An identity `to_space` on a hires image is not a missing declaration, it is a WRONG
    one: it claims the pixels are already full-resolution pixels, which here is off by 5x.
    §7.3 opens by noting that getting this wrong "does not error" — so the importer must
    drop the image and SAY SO, not place it optimistically.
    """
    bundle = VF.make_imaged(tmp_path_factory.mktemp("noscale-src"),
                            with_lowres=False, drop_hires_scalef=True)
    out = tmp_path_factory.mktemp("noscale-out")
    _module, entries = VF.run_over(bundle, out)

    assert images_of(entries) == [], (
        "an image with no usable scalefactor was emitted anyway — check its to_space is "
        "not a fabricated identity"
    )
    # The run still SUCCEEDS: a bundle with an unplaceable image is still importable, and
    # the coordinates are unaffected. Refusing the whole import would be the other
    # over-reaction.
    assert VF.entry_by_id(entries, "spatial-coordinates")
    report = json.loads((out / "visium-import-report.json").read_text())
    assert report["images_not_emitted"], (
        "the image was dropped SILENTLY — a user discovers at overlay time that there is "
        "nothing to overlay on"
    )
    assert any("tissue_hires_image.png" in note for note in report["images_not_emitted"])


def test_an_unknown_micron_scale_omits_physical_size_rather_than_defaulting_to_one(
        tmp_path_factory):
    """TEST-8 (cont.) [invariant: INV-9] — the OME-native scale is absent, not 1.0.

    `PhysicalSizeX = 1.0` on an image whose real scale is unknown is indistinguishable
    downstream from a measured 1 um/pixel. Same rule as `require_micron_scale`: the field
    is omitted so a reader must refuse rather than silently measure in an arbitrary unit.
    """
    # A bundle that keeps its hires scalefactor (so the image is PLACEABLE) but states no
    # micron scale at all: neither `microns_per_pixel` nor `spot_diameter_fullres`.
    bundle = VF.make_imaged(
        tmp_path_factory.mktemp("noum-src"), with_lowres=False,
        scalefactors_text=json.dumps({"tissue_hires_scalef": 0.2}),
    )
    out = tmp_path_factory.mktemp("noum-out")
    _module, entries = VF.run_over(bundle, out)

    entry = image_by_id(entries, "spatial-image-hires")
    assert "microns_per_pixel" not in entry["meta"]
    # The display-derivative block needs a resolution, so with none there is no honest
    # block to write — and a fabricated one is what INV-9 forbids.
    assert "display_derivative" not in entry["meta"]
    with tifffile.TiffFile(out / entry["path"]) as tf:
        xml = tf.ome_metadata
    assert "PhysicalSizeX" not in xml, (
        "an unknown micron scale was written into the OME-XML anyway — a fabricated scale "
        "is indistinguishable from a measured one"
    )


# ── TEST-12 — the pyramid ────────────────────────────────────────────────────────────


def test_the_pyramid_halves_each_level_and_a_small_source_is_single_level(imaged):
    """TEST-12 [covers: ITEM-2] — level 0 full resolution, each subsequent half-scale.

    Both cases come out of ONE import run, which is the point: the big hires image builds
    a real pyramid and the small lowres image is the trivial single-level case, and the
    SAME reader opens both. That is INV-4's "one code path serves both scales" made
    observable rather than asserted.
    """
    hires = image_by_id(imaged["entries"], "spatial-image-hires")
    with tifffile.TiffFile(imaged["out"] / hires["path"]) as tf:
        levels = [tuple(l.shape[:2]) for l in tf.series[0].levels]
    assert len(levels) > 1, "the hires fixture is large enough to pyramid but did not"
    assert levels[0] == (hires["meta"]["extent"]["height"],
                         hires["meta"]["extent"]["width"]), "level 0 is not full resolution"
    for finer, coarser in zip(levels, levels[1:]):
        assert coarser == (finer[0] // 2, finer[1] // 2), (
            f"level {coarser} is not half of {finer}"
        )

    lowres = image_by_id(imaged["entries"], "spatial-image-lowres")
    with tifffile.TiffFile(imaged["out"] / lowres["path"]) as tf:
        assert tf.is_ome, "the single-level file is not a legal OME-TIFF"
        assert len(tf.series[0].levels) == 1


def test_each_pyramid_level_averages_rather_than_decimates(imaged):
    """TEST-12 (cont.) [covers: ITEM-2] — "each a real average of real measurements".

    Asserting the level SHAPES leaves the level CONTENT free, and decimation
    (`arr[::2, ::2]`) produces identical shapes while throwing away three of every four
    measurements. That is not a hypothetical: replacing the box mean with decimation
    survived this suite until this test existed.

    It matters beyond tidiness. #176 draws the line between downsampling ("fewer, larger
    pixels, each a real average of real measurements") and lossy compression ("keeps the
    pixel count and INVENTS the values"). Decimation is on neither side of that line — it
    keeps real values but discards most of them, so a thin bright feature blinks in and out
    as the viewer changes zoom, and an intensity read off a preview level is not the
    average of anything.
    """
    entry = image_by_id(imaged["entries"], "spatial-image-hires")
    with tifffile.TiffFile(imaged["out"] / entry["path"]) as tf:
        level0 = tf.series[0].levels[0].asarray()
        level1 = tf.series[0].levels[1].asarray()

    h, w = level1.shape[0], level1.shape[1]
    blocks = level0[: h * 2, : w * 2].reshape(h, 2, w, 2, level0.shape[2])
    expected = np.rint(blocks.mean(axis=(1, 3))).astype(level0.dtype)
    assert np.array_equal(level1, expected), (
        "level 1 is not the 2x2 box mean of level 0 — the pyramid is decimating, not "
        "averaging"
    )

    # …and the two are genuinely distinguishable on this fixture, so the assertion above
    # is not passing because decimation and averaging happen to agree on a smooth image.
    decimated = level0[::2, ::2][:h, :w]
    assert not np.array_equal(decimated, expected), (
        "decimation and the box mean agree on this fixture, so the assertion above cannot "
        "tell them apart — the fixture needs more local contrast"
    )


# ── TEST-13 — the display-derivative provenance ──────────────────────────────────────


def test_a_below_cap_source_passes_through_and_is_never_upsampled(imaged):
    """TEST-13 [covers: ITEM-3] — `downsampled: False`, and the numbers say why.

    Resolution is micrometres per pixel, so SMALLER is finer. Visium's images are far
    coarser than the 0.5 um/pixel cap, so the honest record is a pass-through. The
    magnitude is checked independently of the importer, because a unit error here yields a
    plausible number: the full-res scale is `65.0 / spot_diameter_fullres` — the RENDERED spot
    diameter over the vendor's measurement of that same circle (#222) — and the hires image is
    that divided by its own scalefactor.
    """
    entry = image_by_id(imaged["entries"], "spatial-image-hires")
    prov = entry["meta"]["display_derivative"]
    factors = VF.scalefactors()

    expected_um = (65.0 / factors["spot_diameter_fullres"]) / factors["tissue_hires_scalef"]
    assert prov["original_resolution_um"] == pytest.approx(expected_um, rel=1e-9)
    assert 1.0 < expected_um < 10.0, (
        f"the derived scale {expected_um} um/pixel is not a plausible Visium hires "
        "resolution — check the direction of the division"
    )
    assert prov["applied_resolution_um"] == prov["original_resolution_um"], "upsampled!"
    assert prov["downsampled"] is False
    assert prov["is_display_derivative"] is True
    assert prov["lossless"] is True and prov["codec"] == "deflate"
    assert prov["writer_version"] == tifffile.__version__


def test_a_finer_than_cap_source_is_downsampled_rather_than_refused():
    """TEST-13 (cont.) [covers: ITEM-3] — #176 landed, so the refusal is now a downsample.

    #155 shipped a `refuse_if_finer_than_cap` whose message said *"emitting it would require
    real downsampling — which this importer does not do (#176 owns it)"*. It does now, and
    this test is that refusal turned into its plan.

    The property that had to survive the change is the one the refusal existed to protect:
    `applied_resolution_um` must describe the pixels that are actually emitted. It is NOT
    the cap — the factor is a whole number, so 3.7 / 0.5 rounds UP to a factor that
    overshoots — and asserting the cap here is exactly the defect #176 exists to remove.
    """
    VF.load_compute()
    OW = sys.modules["ome_writer"]
    SD = sys.modules["spatial_declarations"]

    assert not hasattr(OW, "refuse_if_finer_than_cap"), (
        "the #155 refusal is still present beside the #176 downsample — two contradictory "
        "statements of one policy in one module"
    )

    # Coarser than the cap: pass through, untouched, never upsampled.
    factor, applied, emitted = OW.downsample_plan(3.7, SD.DEFAULT_RESOLUTION_CAP_UM,
                                                  {"width": 400, "height": 300})
    assert (factor, applied, emitted) == (1, 3.7, {"width": 400, "height": 300})

    # Finer than the cap: downsampled by a whole factor, to the resolution that factor
    # ACHIEVES. ceil(0.5 / 0.2) = 3, so the pixels land at 0.6 um/pixel — NOT at the 0.5 cap.
    factor, applied, emitted = OW.downsample_plan(0.2, SD.DEFAULT_RESOLUTION_CAP_UM,
                                                  {"width": 400, "height": 300})
    assert factor == 3
    assert applied == pytest.approx(0.6, rel=1e-12)
    assert applied != SD.DEFAULT_RESOLUTION_CAP_UM, (
        "applied_resolution_um is the cap, which is the #176 defect: an integer factor "
        "overshoots the cap, so the cap is a resolution these pixels do not have"
    )
    assert applied >= SD.DEFAULT_RESOLUTION_CAP_UM, "the cap is a bound and was not met"
    assert emitted == {"width": 133, "height": 100}


# ── TEST-14 — N images, one space ────────────────────────────────────────────────────


def test_two_images_at_different_scalefactors_place_the_same_feature_together(imaged):
    """TEST-14 [covers: ITEM-5] — the case a forward affine cannot express.

    §7.3 rule 3's stated payoff is "N images, one coordinate space, every pair placeable".
    The fixture paints ONE physical marker into both images, at each image's own scale.
    Applying each image's OWN affine to its OWN marker pixel must land both on the same
    full-resolution coordinate — the marker's true position, known independently.
    """
    entries = imaged["entries"]
    images = images_of(entries)
    assert len(images) == 2, f"expected two images, got {[e['id'] for e in images]}"

    spaces = {e["meta"]["coordinate_space"] for e in images}
    assert len(spaces) == 1, f"the two images are in DIFFERENT spaces: {spaces}"

    affines = {e["id"]: e["meta"]["to_space"] for e in images}
    assert affines["spatial-image-hires"] != affines["spatial-image-lowres"], (
        "both images declared the SAME affine, so this fixture cannot show that each "
        "carries its own"
    )

    factors = VF.scalefactors()
    placed = []
    for output_id, key in (("spatial-image-hires", "tissue_hires_scalef"),
                           ("spatial-image-lowres", "tissue_lowres_scalef")):
        # The marker is LOCATED IN THE EMITTED PIXELS, not recomputed from the constant the
        # fixture painted with. That distinction is the whole test: recomputing
        # `round(XY * scalef)` reproduces exactly what `paint()` did, so the assertion would
        # range over the affine alone and the image content would be free — an importer
        # emitting an all-black image would pass. Reading the marker back out of the written
        # OME-TIFF makes this an end-to-end geometric check.
        entry = image_by_id(entries, output_id)
        with tifffile.TiffFile(imaged["out"] / entry["path"]) as tf:
            level0 = tf.series[0].levels[0].asarray()
        bright = np.argwhere(level0[:, :, 0] == 255)
        assert bright.size, f"{output_id}: the marker is not present in the emitted pixels"
        row, col = bright.mean(axis=0)

        # Sanity: the marker must be a small compact blob, not a saturated image. Without
        # this, an all-white image would also produce a centroid and could land anywhere.
        assert bright.shape[0] < level0[:, :, 0].size * 0.01, (
            f"{output_id}: {bright.shape[0]} saturated pixels is not a marker"
        )

        a, b, tx, c, d, ty = affines[output_id]
        placed.append((a * col + b * row + tx, c * col + d * row + ty))

    truth_x, truth_y = VF.IMAGED_MARKER_XY
    # ONE full-resolution pixel, not one COARSE pixel. The marker is painted as a symmetric
    # block about its centre in each image, so its centroid is exact and the earlier
    # `1 / tissue_lowres_scalef` (~16.7 full-res units) was ~17x looser than the geometry
    # requires — loose enough that a 0.3% error in the lowres affine survived it, which
    # mattered because the lowres affine is exactly asserted nowhere else.
    tol = 1.0
    for (px, py), output_id in zip(placed, ("hires", "lowres")):
        assert abs(px - truth_x) <= tol and abs(py - truth_y) <= tol, (
            f"{output_id} placed the marker at {(px, py)}, but it is at "
            f"{(truth_x, truth_y)}"
        )
    assert abs(placed[0][0] - placed[1][0]) <= tol
    assert abs(placed[0][1] - placed[1][1]) <= tol

    # And the SECOND image's affine is pinned exactly, against the vendor's own second
    # scalefactor — so the lowres arm does not rest on a tolerance alone.
    lowres_s = factors["tissue_lowres_scalef"]
    assert affines["spatial-image-lowres"] == pytest.approx(
        [1.0 / lowres_s, 0, 0, 0, 1.0 / lowres_s, 0]
    )


# ── TEST-19 — the two copies of the placement agree ──────────────────────────────────


def test_the_ome_xml_placement_matches_the_manifest_meta(imaged):
    """TEST-19 [covers: ITEM-11] — the duplication DEC-6 accepts, held shut.

    The placement is stated twice on purpose: the manifest `meta` for the catalog/UI, and
    the OME-XML for a sandboxed consumer that can read neither `meta` nor a `structure`
    (INV-10). Both are serialized from ONE `image_meta()` result, and this is the test that
    keeps them from drifting apart into two different claims about where the pixels are.
    """
    for entry in images_of(imaged["entries"]):
        SD = sys.modules["spatial_declarations"]
        with tifffile.TiffFile(imaged["out"] / entry["path"]) as tf:
            payload = SD.decode_placement(tf.ome_metadata)
        assert payload is not None, f"{entry['id']} carries no cyto placement payload"
        # DERIVED FROM `_PLACEMENT_KEYS`, not restated. This list used to be a literal,
        # and its own comment recorded the consequence: #176 added `display_derivative` to
        # `_PLACEMENT_KEYS` and did NOT extend the literal, so the new payload key was the
        # only one with no catalog-vs-bytes agreement assertion — the comment justifying
        # the addition claimed a safety net that did not cover it. #211 then did exactly
        # the same thing with `microns_per_pixel_source`.
        #
        # Twice is a pattern, and the fix for a pattern is not a third string. Deriving it
        # means the N+1st key is covered the moment it is added, which is the property the
        # literal only pretended to have.
        assert len(SD._PLACEMENT_KEYS) >= 6, SD._PLACEMENT_KEYS
        for key in SD._PLACEMENT_KEYS:
            # `.get` on BOTH sides, not a subscript. `display_derivative` is legitimately
            # ABSENT for an image whose micron scale could not be derived — `image_meta`
            # omits it and `encode_placement` omits it from the payload — so subscripting
            # would make this a test ERROR on the supported INV-5 path rather than an
            # agreement check. The property is that the two copies AGREE, including
            # agreeing that the key is absent.
            assert payload.get(key) == entry["meta"].get(key), (
                f"{entry['id']}: OME-XML {key}={payload.get(key)!r} disagrees with the "
                f"manifest meta {entry['meta'].get(key)!r}"
            )
        assert "display_derivative" in payload, (
            "this fixture's images all carry provenance, so the loop above must actually "
            "have compared the new key rather than skipping it on both sides"
        )
        assert payload["microns_per_pixel"] == pytest.approx(
            entry["meta"]["microns_per_pixel"]
        )
