#!/usr/bin/env python3
# ruff: noqa
"""Losing the image must never cost the import — and a black image must never be emitted.

Two different promises, and the second is the one that is easy to get wrong:

* **A damaged image costs ONE IMAGE.** The matrix, the coordinates and every column still
  land. That is INV-6's stated posture, carried over from the Visium importer, and it is why
  `emit_image` wraps its WHOLE body in one guard rather than a per-call `except`.
* **A multi-file OME-TIFF with missing siblings is REFUSED.** `tifffile` does not fail on
  one: it returns a full-sized array with the missing planes ZEROED and only a log line. An
  image emitted from that is a black raster registered against real cells, which is silent
  wrong data of exactly the kind this arm exists to refuse.
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


def _report(out):
    return json.loads((Path(out) / "xenium-import-report.json").read_text())


def _ids(entries):
    return {e["id"] for e in entries}


def _copy(bundle, tmp_path, name):
    dest = tmp_path / name
    shutil.copytree(bundle, dest)
    return dest


def _everything_but_the_image_survived(entries, control_entries, image_id):
    """TEST-18 [covers: ITEM-5] — every artifact the control emitted, minus the image AND ITS
    OVERLAY, is here.

    `_import_survived` below names six ids plus "some metadata column". MEASURED against a
    control import: that is 6 of the 24 artifacts a real run emits, so a regression costing
    sixteen of the seventeen metadata columns and the summary kept every end-to-end test in
    this file GREEN. The control is already computed in each of those tests for its own
    reasons, so comparing the whole SET costs nothing and is the assertion the invariant
    actually claims — "losing one image must never cost the matrix, the coordinates, the
    columns and the report" is a statement about all of them.

    ## THE OVERLAY IS SUBTRACTED TOO, AND NOT AS A COURTESY (#301)

    §7.5's registration QC overlay is DERIVED FROM the image — it draws the cells on it — so a
    run with no image has nothing to draw on and emits no overlay. That is the correct cost of
    a damaged image and it is stated here rather than inherited: the invariant is "losing the
    image costs the image", and after #301 the image's own diagnostic is part of "the image".

    It is subtracted EXPLICITLY rather than left to work out by luck. Measured on this
    branch: `_stage_morphology_plain_tiff` crops the fixture's plane to a region that is
    entirely zero, so `signal_mask` refuses it as "a single constant value" and the CONTROL
    emits no overlay either — meaning every test here would have passed with the overlay
    unaccounted for, and would have started failing the day that crop moved by one pixel. A
    guard that holds only because a fixture happens to be blank is not holding.

    So both halves are asserted: the overlay is not in the damaged run's manifest, and every
    other artifact the control emitted is.
    """
    overlay_id = f"{image_id}-registration-overlay"
    got, expected = _ids(entries), _ids(control_entries) - {image_id, overlay_id}
    assert overlay_id not in got, (
        f"the damaged run emitted {overlay_id!r} with no image to draw it on — the overlay "
        "is a picture OF the image, so an overlay without one is a picture of nothing")
    assert got == expected, (
        f"the damaged image cost more than itself. Missing: {sorted(expected - got)}; "
        f"unexpectedly present: {sorted(got - expected)}. The control emitted "
        f"{len(_ids(control_entries))} artifacts.")


def _import_survived(entries):
    """The matrix, the coordinates and the columns landed — whatever happened to the image."""
    ids = _ids(entries)
    assert "expression" in ids, "the counts matrix must survive a damaged image"
    assert "spatial-coordinates" in ids, "the tissue map must survive a damaged image"
    assert "metadata-column:cell_id" in ids and "metadata-column:spatial_x" in ids
    assert "xenium-import-report" in ids


# ── TEST-25: the silent zero-fill ────────────────────────────────────────────────────


def test_tifffile_silently_zero_fills_a_multi_file_ome_with_missing_siblings(tmp_path):
    """TEST-25 — the MEASUREMENT the refusal rests on, asserted rather than remembered.

    This test asserts a property of the DEPENDENCY, not of this package. It is here because
    the presence check in `xenium_image.read_plane` is only justified if trusting the decoder
    is genuinely unsafe — and if a future `tifffile` starts raising instead of zero-filling,
    this goes red and the check can be reconsidered on evidence.

    `tifffile` logs rather than warns here, so there is deliberately no assertion that a
    Python warning was raised: the point is that NOTHING is raised.
    """
    import tifffile

    bundle = _copy(XF.PROTEIN, tmp_path, "partial")
    focus = bundle / "morphology_focus"
    kept = focus / "ch0000_dapi.ome.tif"
    removed = sorted(p.name for p in focus.glob("*.ome.tif") if p != kept)
    assert len(removed) == 11, "the protein fixture must ship all twelve channel files"
    for name in removed:
        (focus / name).unlink()

    with tifffile.TiffFile(str(kept)) as handle:
        series = handle.series[0]
        assert str(series.axes) == "CYX"
        assert series.shape == (12, 6915, 2963), (
            "tifffile still reports TWELVE channels from the OME-XML although eleven files "
            "are gone — the shape gives a reader no hint that anything is missing"
        )
        array = series.asarray()          # raises NOTHING

    assert array.shape == (12, 6915, 2963)
    assert array[0].any(), "channel 0 is the file that is still present and must have signal"
    for channel in range(1, 12):
        assert not array[channel].any(), (
            f"channel {channel} must be ALL ZERO — that is the silent failure; if it now "
            "carries data, tifffile's behaviour changed and the refusal should be revisited"
        )


def test_a_multi_file_ome_with_missing_siblings_emits_no_image_and_says_why(tmp_path):
    """TEST-25 — the refusal, with the control that makes it mean anything.

    "No image was emitted" passes VACUOUSLY if the reader is simply broken. So the SAME code
    is run over the COMPLETE fixture in the same test, and it must emit the image. Only the
    pair distinguishes "refused because siblings are missing" from "never worked".
    """
    # THE CONTROL — complete directory, image emitted.
    complete_out = tmp_path / "complete-out"
    _, complete_entries = XF.run_over(XF.PROTEIN, complete_out)
    assert "spatial-image-morphology" in _ids(complete_entries), (
        "the control must EMIT — otherwise the refusal below proves nothing"
    )
    assert _report(complete_out)["images_not_emitted"] == []

    # THE CASE — eleven of twelve files removed.
    bundle = _copy(XF.PROTEIN, tmp_path, "partial")
    focus = bundle / "morphology_focus"
    for path in sorted(focus.glob("*.ome.tif")):
        if path.name != "ch0000_dapi.ome.tif":
            path.unlink()

    out = tmp_path / "partial-out"
    _, entries = XF.run_over(bundle, out)

    _import_survived(entries)
    assert "spatial-image-morphology" not in _ids(entries), (
        "an image whose sibling files are missing must NOT be emitted — the pixels would be "
        "eleven-twelfths black and nothing in the artifact would say so"
    )
    notes = _report(out)["images_not_emitted"]
    assert len(notes) == 1, notes
    assert "MULTI-FILE OME-TIFF" in notes[0]
    assert "11 of the 12 files" in notes[0]
    assert "ZEROED" in notes[0], "the note must say what would have happened, not just refuse"
    assert "ch0001_atp1a1_cd45_e-cadherin.ome.tif" in notes[0], (
        "the note must NAME missing files so a user can tell what to re-upload"
    )


# ── TEST-23: a damaged image costs one image ─────────────────────────────────────────


class _AbsentImagecodecs:
    """Every attribute lookup fails — which is what `import imagecodecs` failing looks like."""

    def __getattr__(self, name):
        raise AttributeError(name)


@pytest.fixture
def without_jpeg2000_codec():
    """Remove the JPEG-2000 decoder at the exact seam `tifffile` resolves it through.

    Not a simulated exception: `tifffile.tifffile.CompressionCodec.__getitem__` looks the
    codec up on the module-global `imagecodecs` and converts an `AttributeError` into
    `KeyError("<COMPRESSION.JPEG2000: 34712> requires the 'imagecodecs' package")`. Replacing
    that global with an object that has no attributes reproduces a host WITHOUT
    `imagecodecs` through tifffile's own code path, producing the exact error measured on
    this repo's `just check-py` host before the library was installed on it.

    The codec cache is a process-wide singleton, so it is cleared on the way in AND on the
    way out; leaving a poisoned entry behind would fail every later test in the session.
    """
    import tifffile.tifffile as T

    saved = T.imagecodecs
    T.imagecodecs = _AbsentImagecodecs()
    T.TIFF.DECOMPRESSORS._codecs.pop(34712, None)
    try:
        yield
    finally:
        T.imagecodecs = saved
        T.TIFF.DECOMPRESSORS._codecs.pop(34712, None)


def test_a_missing_codec_backend_costs_the_image_and_nothing_else(tmp_path,
                                                                  without_jpeg2000_codec):
    """TEST-23 — every Xenium morphology image is JPEG-2000, so this is the likeliest failure.

    `imagecodecs` is declared by the manifest and pinned in the rootfs, so a production
    sandbox has it. A host that does not must still import the matrix, the coordinates and
    every column — and must SAY that the image was lost and why, rather than leaving a user
    to discover at overlay time that there is nothing to overlay on.
    """
    out = tmp_path / "no-codec"
    _, entries = XF.run_over(XF.PRIME, out)

    _import_survived(entries)
    assert "spatial-image-morphology" not in _ids(entries)
    notes = _report(out)["images_not_emitted"]
    assert len(notes) == 1, notes
    assert "imagecodecs" in notes[0], (
        "the note must name the missing decoder — 'not emitted' alone sends the user "
        "looking at their bundle for a fault that is in the host"
    )
    assert "JPEG2000" in notes[0] or "34712" in notes[0]


def test_the_codec_fixture_is_a_real_deprivation_not_a_no_op(without_jpeg2000_codec):
    """TEST-23 — the control for the control.

    A fixture that failed to remove anything would make the test above pass while proving
    nothing about the degraded path. This asserts the deprivation actually bites, and
    `test_the_YX_pyramidal_jpeg2000_source_is_downsampled_to_the_cap` (which runs WITHOUT
    the fixture) is the other half: the same file decodes fine when the codec is present.
    """
    import tifffile

    source = XF.PRIME / "morphology_focus" / "morphology_focus_0000.ome.tif"
    with tifffile.TiffFile(str(source)) as handle:
        with pytest.raises(ValueError) as exc:
            handle.series[0].pages[0].asarray()
    assert "imagecodecs" in str(exc.value)


def test_a_truncated_image_costs_the_image_and_nothing_else(tmp_path):
    """TEST-23 — a partial upload, which is what a truncated file usually is."""
    bundle = _copy(XF.PRIME, tmp_path, "truncated")
    target = bundle / "morphology_focus" / "morphology_focus_0000.ome.tif"
    head = target.read_bytes()[:4096]
    target.write_bytes(head)

    out = tmp_path / "truncated-out"
    _, entries = XF.run_over(bundle, out)

    _import_survived(entries)
    assert "spatial-image-morphology" not in _ids(entries)
    assert len(_report(out)["images_not_emitted"]) == 1


def test_an_experiment_naming_an_image_that_is_not_there_costs_the_image(tmp_path):
    """TEST-23 — the vendor's own pointer can outlive the file it points at.

    DEC-9 makes `experiment.xenium` the source of the image path, which means a bundle
    uploaded without its image directory names a file that does not exist. Both pointers are
    broken here, so the note must name both rather than reporting only the first.
    """
    bundle = _copy(XF.PRIME, tmp_path, "no-image-files")
    shutil.rmtree(bundle / "morphology_focus")
    (bundle / "morphology.ome.tif").unlink()

    out = tmp_path / "no-image-out"
    _, entries = XF.run_over(bundle, out)

    _import_survived(entries)
    assert "spatial-image-morphology" not in _ids(entries)
    notes = _report(out)["images_not_emitted"]
    assert len(notes) == 2, notes
    assert any("morphology_focus/morphology_focus_0000.ome.tif" in n for n in notes)
    assert any("morphology.ome.tif" in n for n in notes)
    assert all("names this image but no such file" in n for n in notes)


@pytest.mark.parametrize(
    "pixel_size, label",
    [
        (0, "zero"),
        (-0.2125, "negative"),
        (float("nan"), "NaN"),
        ("0.2125", "a string"),
        (1e-320, "subnormal"),
        (True, "a bool"),
    ],
)
def test_a_damaged_pixel_size_costs_the_image_and_nothing_else(tmp_path, pixel_size, label):
    """TEST-23 — the DERIVED quantity is where these fail, not the input.

    `emit_image`'s Visium counterpart records having fixed this class once already and still
    aborting the whole import on a SUBNORMAL scalefactor, "because the failure is in the
    DERIVED quantity, not the input": 1e-320 is finite and positive and passes every guard,
    and then `cap / 1e-320` overflows to `inf`. So the subnormal row is not padding — it is
    the case that got through last time.

    `True` is here for the same reason `isinstance(x, bool)` appears in the guard: `bool` is
    a subclass of `int`, so a JSON `true` would otherwise be read as a pixel size of 1.0 um.
    """
    bundle = _copy(XF.PRIME, tmp_path, f"pixel-{label.replace(' ', '-')}")
    experiment = json.loads((bundle / "experiment.xenium").read_text())
    experiment["pixel_size"] = pixel_size
    (bundle / "experiment.xenium").write_text(json.dumps(experiment))

    out = tmp_path / f"out-{label.replace(' ', '-')}"
    _, entries = XF.run_over(bundle, out)

    _import_survived(entries)
    assert "spatial-image-morphology" not in _ids(entries), (
        f"a {label} pixel_size must not produce an image — its pixels would have no known "
        "physical size, and an identity affine would claim one pixel is one micrometre"
    )
    assert len(_report(out)["images_not_emitted"]) == 1


def test_the_coordinates_are_unchanged_by_any_image_failure(tmp_path):
    """TEST-23 — the positive control on the whole family above.

    Every test in this section asserts something did NOT happen. This one asserts what DID:
    the coordinates written when the image fails are BIT-IDENTICAL to those written when it
    succeeds, so "the import survived" means the artifacts are the same, not merely present.
    """
    import txr_zarr_read as CZR

    good_out = tmp_path / "good"
    XF.run_over(XF.PRIME, good_out)

    bundle = _copy(XF.PRIME, tmp_path, "broken")
    shutil.rmtree(bundle / "morphology_focus")
    (bundle / "morphology.ome.tif").unlink()
    bad_out = tmp_path / "bad"
    XF.run_over(bundle, bad_out)

    good = CZR.read_array(good_out / "spatial/coordinates.zarr", "coordinates")
    bad = CZR.read_array(bad_out / "spatial/coordinates.zarr", "coordinates")
    assert np.array_equal(good, bad)


# ── #292: a dtype OME-XML cannot express costs ONE image, not the import ────────────
#
# This is the END-TO-END half of the invariant, and it is the half that is easy to omit. A
# writer-level test proving `write_ome_tiff` raises the right TYPE is necessary and not
# sufficient: what #292 is actually about is that the OTHER ARTIFACTS still land. So these
# drive the REAL `run_import` and assert on the whole emitted set.
#
# ON `301cd345` TEST-9 BELOW ABORTS. Reproduced literally before the fix was designed: staging the
# prime bundle with an `int64` morphology plane made `run_import` die with
# `tifffile.OmeXmlError: data type 'int64' not supported` and write ZERO artifacts — no matrix,
# no coordinates, no columns, no report. That is the defect, and it is why "an exception was
# raised" is not the assertion here.
#
# WHY XENIUM AND NOT VISIUM. The failing input is reachable only here. `xenium_image.read_plane`
# validates the AXIS ORDER and returns `series.asarray()` with no dtype conversion, so a plain
# `int64` TIFF reaches the writer unchanged. Visium's `VENDOR_IMAGES` names two `.png` members
# and `ome_writer.read_image` dispatches on suffix into the PIL branch, which normalises every
# mode through `convert("RGB"/"L"/"I;16")` to uint8/uint16 — so the dtype cannot get there today,
# and faking it would need a monkeypatched bundle contract. Recorded in
# `docs/design/ome-tiff-dtype-refusal.md` §6 rather than papered over.

#: Smaller than the fixture's own 3522x5789 plane. An int64 copy of the full plane is ~163 MB
#: and this suite writes it three times; the dtype is what is under test, not the size.
_DTYPE_H, _DTYPE_W = 352, 578


def _stage_morphology_dtype(tmp_path, dtype, name):
    """The prime bundle with its morphology plane re-written at `dtype`.

    A COPY under `tmp_path` — `tests/fixtures/` is never written; see `XF.stage_bundle`. The
    plane is the fixture's OWN pixels, cropped and cast, so the only variable between this and
    the inline control is the dtype. `ome=False` because the vendor file a real bundle would
    carry here is a plain TIFF, and because `tifffile` would otherwise refuse to WRITE the
    fixture for the very reason under test.
    """
    import tifffile

    root = XF.stage_bundle(tmp_path, name=name)
    focus = root / "morphology_focus" / "morphology_focus_0000.ome.tif"
    with tifffile.TiffFile(str(focus)) as handle:
        plane = handle.series[0].asarray()
    tifffile.imwrite(str(focus), plane[:_DTYPE_H, :_DTYPE_W].astype(np.dtype(dtype)),
                     photometric="minisblack", ome=False)
    return root


def test_an_int64_morphology_image_costs_one_image_and_not_the_import(tmp_path):
    """TEST-9 (INV-2) — `run_import` COMPLETES, and every other artifact still lands.

    The assertion that matters is not that the image is missing; it is that the matrix, the
    coordinates, every metadata column and the report are all present. On `301cd345` this call
    raised `tifffile.OmeXmlError` out of `run_import` and none of them existed.
    """
    # THE CONTROL FIRST, IN THIS TEST. `TEST-11` runs the same control as its own test, and
    # that is not enough: skip or delete TEST-11 and the assertions below become tautologies —
    # measured, with a mutant whose guard refuses EVERY image, TEST-9 and TEST-10 both stayed
    # GREEN and only TEST-11 went red. "The image is absent" has to be paired, in the same
    # test, with "the identical bundle at an expressible dtype emits one". The sibling
    # `test_a_multi_file_ome_with_missing_siblings_emits_no_image_and_says_why` in this file
    # puts its control inline for exactly this reason.
    control_root = _stage_morphology_dtype(tmp_path, "uint16", "int64-control")
    control_out = tmp_path / "int64-control-outs"
    _control_module, control_entries = XF.run_over(control_root, control_out)
    assert "spatial-image-morphology" in _ids(control_entries), (
        "the CONTROL did not emit an image, so 'the image is absent' below would be satisfied "
        "by a staging procedure that breaks the image path rather than by the dtype refusal. "
        f"Emitted: {sorted(_ids(control_entries))}; report says "
        f"{_report(control_out)['images_not_emitted']}")

    root = _stage_morphology_dtype(tmp_path, "int64", "int64-bundle")
    out = tmp_path / "int64-outs"
    _module, entries = XF.run_over(root, out)

    _import_survived(entries)
    assert "spatial-image-morphology" not in _ids(entries), (
        "an int64 image must not be emitted — OME-XML has no PixelType for it, so the file "
        "would either fail to write or carry a header describing different pixels"
    )
    # Named explicitly as well as through `_import_survived`, because THIS is the sentence
    # #292 is about: losing one image must never cost the rest of the bundle.
    ids = _ids(entries)
    assert {"expression", "spatial-coordinates", "xenium-import-report"} <= ids, (
        f"one unusual image cost the import its core artifacts; emitted only {sorted(ids)}"
    )
    assert any(i.startswith("metadata-column:") for i in ids), (
        f"one unusual image cost the import every metadata column; emitted {sorted(ids)}"
    )


def test_the_int64_refusal_names_the_dtype_in_the_report_and_leaves_no_partial(tmp_path):
    """TEST-10 (INV-3) — the user is told which dtype, and no stub is left on disk.

    The report line is the ONLY channel this reaches a human through, so it is asserted on the
    report rather than on the exception.

    The `.partial` / `.ome.tif` check is a REGRESSION PIN, and its scope is stated exactly
    because an earlier version of this docstring described the pre-fix code in the present
    tense. As shipped, an unexpressible dtype is refused BEFORE `TiffWriter` is opened, so
    nothing can be left behind on this path and the assertion cannot fail for it. What it
    guards is the path one mutation away: `write_ome_tiff`'s named backstop converts an
    `OmeXmlError` raised from `TiffWriter.__exit__` -> `close()`, i.e. AFTER level 0 and every
    pyramid level have been written into the staging file. Should the up-front guard ever be
    narrowed so a dtype reaches the writer again, this is what checks that the staging
    discipline still cleans up — and it is the one refusal in the module where a truncated
    artifact would otherwise sit exactly where a reader looks for it.
    """
    # Inline control, for the reason TEST-9 gives.
    control_root = _stage_morphology_dtype(tmp_path, "uint16", "report-control")
    control_out = tmp_path / "report-control-outs"
    XF.run_over(control_root, control_out)
    assert _report(control_out)["images_not_emitted"] == [], (
        "the CONTROL bundle already reports a skipped image, so the assertions below cannot "
        f"distinguish the dtype refusal from a broken fixture: "
        f"{_report(control_out)['images_not_emitted']}")

    root = _stage_morphology_dtype(tmp_path, "int64", "int64-report-bundle")
    out = tmp_path / "int64-report-outs"
    _module, entries = XF.run_over(root, out)

    not_emitted = _report(out)["images_not_emitted"]
    assert len(not_emitted) == 1, f"expected exactly one skipped image, got {not_emitted}"
    line = not_emitted[0]
    assert "ImageConversionError" in line, (
        f"the report does not name the refusal type, so the reader cannot tell a refusal from "
        f"a crash: {line}")
    # THE QUOTED FORM, which is the `{arr.dtype.name!r}` interpolation and nothing else.
    # A bare `"int64" in line` is the vacuous version and this file shipped it: the refusal
    # text used to illustrate its own argument with "(int64 -> int32, float16 -> float32)", so
    # the assertion was satisfied by boilerplate — measured, against a mutant that refused
    # EVERY image, the refused dtype was `uint16` and `"int64" in line` still passed. The
    # supported-dtype list in the same message is comma-joined and UNQUOTED, so it cannot
    # produce this form for any dtype; only the interpolation can.
    assert "'int64'" in line, (
        f"the report does not name the REFUSED dtype in the position only the interpolation "
        f"can produce, so 'it names the dtype' may be satisfied by the message's own prose "
        f"rather than by the image: {line}")
    assert "'uint16'" not in line, (
        f"the refusal line names the CONTROL's dtype as the refused one: {line}")
    leftovers = sorted(p.name for p in out.rglob("*.ome.tif*"))
    assert not leftovers, (
        f"a refused image left files behind: {leftovers}. `TiffWriter` creates its file up "
        "front and this refusal can fire after level 0 is written, so an orphaned stub would "
        "sit exactly where a reader looks for the artifact.")


def test_the_same_staged_bundle_at_uint16_DOES_emit_an_image(tmp_path):
    """TEST-11 — the positive control, without which TEST-9/10 prove nothing.

    "The image is absent" passes VACUOUSLY if this staging procedure breaks the image path for
    any reason at all — a crop the coverage check rejects, an `ome=False` write `read_plane`
    cannot open, a lost `pixel_size`. Same bundle, same crop, same writer call, ONLY the dtype
    restored to the fixture's own `uint16`: the image must come back. That is what makes
    "absent" mean "the dtype was refused".
    """
    root = _stage_morphology_dtype(tmp_path, "uint16", "uint16-control-bundle")
    out = tmp_path / "uint16-control-outs"
    _module, entries = XF.run_over(root, out)

    _import_survived(entries)
    assert "spatial-image-morphology" in _ids(entries), (
        f"the CONTROL did not emit an image, so TEST-9/10's 'the image is absent' proves "
        f"nothing about the dtype. Emitted: {sorted(_ids(entries))}; report says "
        f"{_report(out)['images_not_emitted']}")
    assert _report(out)["images_not_emitted"] == [], (
        f"the control bundle reported a skipped image: {_report(out)['images_not_emitted']}")


# ── #296 / #297 / #298 — the escapes #292's sweep found ─────────────────────────────
#
# TWO TEST-N ENUMERATIONS NOW LIVE IN THIS FILE, and they are per-feature namespaces that each
# restart at 1 — so `TEST-9` above (#292's int64 case) and `TEST-9` below (#298 E1) are
# different tests, not a renumbering. Every ID below belongs to
# `.lifecycle/image-guard-escapes/TESTS.md` and names its issue in the first line of its
# docstring; every ID above belongs to #292's. Recorded rather than silently collided with,
# because a bare grep for a TEST-ID across a repo binds it to whichever file sorted first.
#
# The shape deliberately absent below is "it raises". On `e0276408` every input here DID
# raise — that is the defect — so a test asserting an exception occurred is GREEN against
# the broken code. Each one instead drives the REAL `run_import` over a real multi-artifact
# bundle and asserts BOTH halves: the bad image is skipped with a NAMED reason, and every
# other artifact still emits. The second half is the invariant; the first is only its shape.

import builtins

_PACKAGES = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(_PACKAGES / "spatial-types" / "tests"))
import image_boundary_guards as IBG  # noqa: E402


def _importer_guard_tuple():
    """The exception tuple BOTH importers actually wrote, resolved to real classes.

    Read out of the CALLERS' SOURCE by glob, never hardcoded — the same reasoning
    `test_ome_sample_classification._assert_caught_by_the_importer_guards` gives. What makes
    a refusal cost one image rather than the import is that the raised type appears in the
    tuple the caller WROTE, so a test that hardcodes the tuple stops testing that the moment
    a caller edits its line.
    """
    XF.load_compute()
    OW = sys.modules["ome_writer"]
    SD = sys.modules["spatial_declarations"]
    callers = [p for p in sorted(_PACKAGES.glob("*/compute/import_*.py"))
               if "ome_writer.write_ome_tiff" in p.read_text()]
    assert len(callers) >= 2, (
        f"expected both importers to call `write_ome_tiff`, found {[str(c) for c in callers]}")
    tuples = {}
    for caller in callers:
        # BY `ast`, NOT BY REGEX. The regex matched the FIRST `except (...)` naming
        # `ImageConversionError`, which stopped being unambiguous once `emit_image`'s re-open
        # block grew a pass-through of the same shape — it then resolved a tuple WITHOUT
        # `OSError` and reported that the two importers guard different taxonomies.
        tuples[caller.name] = IBG.importer_guard_names(caller.read_text())
    assert len(set(tuples.values())) == 1, (
        f"the importers guard DIFFERENT exception tuples: {tuples}")
    resolved = []
    for name in next(iter(tuples.values())):
        if name.startswith("ome_writer."):
            resolved.append(getattr(OW, name.split(".", 1)[1]))
        elif name.startswith("SD."):
            resolved.append(getattr(SD, name.split(".", 1)[1]))
        else:
            resolved.append(getattr(builtins, name))
    return tuple(resolved)


def _zero_the_image_width_tag(path):
    """Zero this TIFF's `ImageWidth` value in place, and say where it was.

    A zeroed dimension tag is the input `ome_writer.read_image`'s OWN attempt-3 history names
    as the one that escaped its allow-list: it makes `tifffile.detect_series` divide by zero.
    The offset is located THROUGH `tifffile` rather than hardcoded, so this stays a real
    input rather than a byte pattern that a library upgrade silently turns into a no-op.
    """
    import struct
    import tifffile

    with tifffile.TiffFile(str(path)) as handle:
        tag = handle.pages[0].tags.get(256)  # ImageWidth
        assert tag is not None, f"{path} has no ImageWidth tag to zero"
        offset = tag.valueoffset
    raw = bytearray(Path(path).read_bytes())
    raw[offset:offset + 4] = struct.pack("<I", 0)
    Path(path).write_bytes(bytes(raw))
    return offset


def _stage_morphology_plain_tiff(tmp_path, name, *, mutate=None):
    """The prime bundle with its morphology plane rewritten as a plain TIFF, then mutated.

    A COPY under `tmp_path` — `tests/fixtures/` is never written. The plane is the fixture's
    OWN pixels, cropped, so the only variable between a mutated bundle and its control is the
    mutation. `ome=False` because the vendor file a real bundle carries here is a plain TIFF.
    """
    import tifffile

    root = XF.stage_bundle(tmp_path, name=name)
    focus = root / "morphology_focus" / "morphology_focus_0000.ome.tif"
    with tifffile.TiffFile(str(focus)) as handle:
        plane = handle.series[0].asarray()
    tifffile.imwrite(str(focus), plane[:_DTYPE_H, :_DTYPE_W],
                     photometric="minisblack", ome=False)
    if mutate is not None:
        mutate(focus)
    return root


def test_a_zeroed_dimension_tag_costs_one_image_and_not_the_import(tmp_path):
    """TEST-1 (INV-1) — #296, end to end through the REAL importer.

    On `e0276408` this bundle made `run_import` die with `ZeroDivisionError` and write ZERO
    artifacts, BY DESIGN: `read_plane`'s `_PROGRAMMING_ERRORS` deny-list re-raised it as "a bug
    in this file", and `ZeroDivisionError` is in neither importer's guard tuple. The exception
    is raised inside `tifffile.detect_series` — measured at `tifffile.py:4855` — over a damaged
    vendor TIFF, which is the classification `ome_writer.read_image`'s attempt-3 history had
    ALREADY disproved. So the assertion that matters is not that the image is missing; it is
    that the matrix, the coordinates, every metadata column and the report are all present.

    THE CONTROL IS IN THIS TEST, not only in a sibling. Measured on the #292 branch with a
    mutant whose guard refused EVERY image: the "image is absent" assertions stayed GREEN and
    only the separate control test went red. "The image is absent" has to be paired, here, with
    "the identical bundle without the mutation emits one".
    """
    control_root = _stage_morphology_plain_tiff(tmp_path, "zerodim-control")
    control_out = tmp_path / "zerodim-control-outs"
    _cm, control_entries = XF.run_over(control_root, control_out)
    assert "spatial-image-morphology" in _ids(control_entries), (
        "the CONTROL did not emit an image, so 'the image is absent' below would be satisfied "
        "by staging that breaks the image path rather than by the refusal under test. "
        f"Emitted {sorted(_ids(control_entries))}; report says "
        f"{_report(control_out)['images_not_emitted']}")

    root = _stage_morphology_plain_tiff(tmp_path, "zerodim", mutate=_zero_the_image_width_tag)
    out = tmp_path / "zerodim-outs"
    _module, entries = XF.run_over(root, out)

    _import_survived(entries)
    _everything_but_the_image_survived(entries, control_entries, "spatial-image-morphology")
    assert "spatial-image-morphology" not in _ids(entries), (
        "a TIFF whose own ImageWidth tag is zero has no readable pixel grid and must not be "
        "emitted")
    ids = _ids(entries)
    assert {"expression", "spatial-coordinates", "xenium-import-report"} <= ids, (
        f"one damaged image cost the import its core artifacts; emitted only {sorted(ids)}")
    assert any(i.startswith("metadata-column:") for i in ids), (
        f"one damaged image cost the import every metadata column; emitted {sorted(ids)}")
    notes = _report(out)["images_not_emitted"]
    assert len(notes) == 1, notes
    assert "ZeroDivisionError" in notes[0], (
        "the note must NAME the exception type — an operator reading 'not emitted' alone "
        f"cannot tell a damaged file from a broken host. Got: {notes[0]!r}")


def test_a_zeroed_dimension_tag_leaves_read_plane_in_the_importers_own_taxonomy(tmp_path):
    """TEST-2 — the TYPE, checked against the tuple the CALLERS wrote.

    `pytest.raises(Exception)` would pass against `e0276408`, where this raised
    `ZeroDivisionError` straight out of the importer. The claim is narrower and is the whole
    point: the type is one the importers' `except (...)` line actually names.
    """
    import tifffile

    XF.load_compute()
    guarded = _importer_guard_tuple()
    xenium_image = sys.modules["xenium_image"]

    path = tmp_path / "zerodim.tif"
    tifffile.imwrite(str(path), np.zeros((16, 20), np.uint16),
                     photometric="minisblack", ome=False)
    _zero_the_image_width_tag(path)

    with pytest.raises(guarded) as exc:
        xenium_image.read_plane(path)
    assert "ZeroDivisionError" in str(exc.value), (
        f"the refusal must name the original exception type; got {str(exc.value)!r}")


#: The bugs the deleted `_PROGRAMMING_ERRORS` deny-list existed for, as SOURCE MUTATIONS of
#: the shipped file. Its own comment names the first three as mutation-proved; the fourth is
#: the `NameError` its type tuple also listed. Every one of them is raised BY A LINE IN
#: `xenium_image.py`, which is why the site rule keeps propagating them.
_READ_PLANE_BUG_MUTANTS = {
    "AttributeError": ("axes = str(series.axes)", "axes = str(series.axess)"),
    # [TEST-15] RE-DERIVED at #319, which renamed this call's first argument from the whole-document
    # `names` to the series-bound `series_names`. Nothing about the mutant changed — it still
    # passes `pages` where `len(pages)` belongs, so `names[:page_count]` still raises
    # `TypeError: slice indices must be integers`, and the arm under test is still the site
    # rule's PROPAGATE arm. The assertion below is the one that told us to do this ("Re-derive
    # it from the current source"), and it is what fires if the line moves again.
    "TypeError": ("index, rule, name = _channel_index(series_names, len(pages), path)",
                  "index, rule, name = _channel_index(series_names, pages, path)"),
    "NameError": ("plane = pages[index].asarray()\n            else:",
                  "plane = pagez[index].asarray()\n            else:"),
    "KeyError": ('selection = {"axes": axes, "axis": "C", "index": int(index),\n'
                 '                             "of": int(len(pages)), "rule": rule}',
                 'selection = {"axes": axes, "axis": "C", "index": int(index),\n'
                 '                             "of": int(len(pages)), "rule": rule}\n'
                 '                _ = selection["channel_nmae"]'),
}


def _cyx_fixture(tmp_path, name="cyx.ome.tif"):
    """A three-channel `CYX` OME-TIFF — the branch every bug mutant below lands on."""
    import tifffile

    path = Path(tmp_path) / name
    tifffile.imwrite(str(path), np.zeros((3, 16, 20), np.uint16),
                     photometric="minisblack", ome=True, metadata={"axes": "CYX"})
    return path


def _read_plane_from_source(source, tmp_path_for_pycache=None):
    """`read_plane` from a possibly-mutated copy of the SHIPPED `xenium_image.py`.

    Executed under the SHIPPED file's `__file__`, because that is the value the site rule
    compares against — running the mutant under a temp filename would make every mutant look
    like third-party code and turn this test green for the wrong reason.
    """
    import types

    path = XF.PKG / "compute" / "xenium_image.py"
    module = types.ModuleType("xenium_image_mutant")
    module.__file__ = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module.read_plane


@pytest.mark.parametrize("bug", sorted(_READ_PLANE_BUG_MUTANTS), ids=sorted(_READ_PLANE_BUG_MUTANTS))
def test_a_bug_in_this_file_still_propagates_and_is_not_reported_as_a_bad_bundle(bug, tmp_path):
    """TEST-3 (INV-2) — the property the deleted deny-list was added for, MUTATION-proved.

    #296 replaced a deny-list of exception TYPES with a discriminator on the raising SITE. The
    obvious way for that to be wrong is that it now swallows the bugs the deny-list caught, so
    each one is reintroduced into the shipped source and required to come out of `read_plane`
    UNCONVERTED. Its own comment records what the alternative looked like to a user: "not a
    readable Xenium OME-TIFF (...)", with the import reporting SUCCESS and shipping a dataset
    with no image.

    The CONTROL is in the same test: the un-mutated source, executed the same way, must READ
    the same fixture successfully — otherwise "it raised" would be satisfied by a broken
    exec harness rather than by the mutation.
    """
    XF.load_compute()
    shipped = (XF.PKG / "compute" / "xenium_image.py").read_text()
    fixture = _cyx_fixture(tmp_path)

    plane, selection = _read_plane_from_source(shipped)(fixture)
    assert plane.shape == (16, 20) and selection["axes"] == "CYX", (
        "the un-mutated control did not read the fixture, so the mutants below would prove "
        f"nothing about the mutation. Got {getattr(plane, 'shape', None)!r}, {selection!r}")

    old, new = _READ_PLANE_BUG_MUTANTS[bug]
    mutated = shipped.replace(old, new)
    assert mutated != shipped, (
        f"the {bug!r} mutation matched nothing in the shipped `xenium_image.py`, so the "
        "propagate arm was never challenged. Re-derive it from the current source.")

    ome_writer = sys.modules["ome_writer"]
    with pytest.raises(Exception) as raised:
        _read_plane_from_source(mutated)(fixture)
    assert not isinstance(raised.value, ome_writer.ImageConversionError), (
        f"a {bug} raised by a line in `xenium_image.py` was CONVERTED into "
        f"{raised.value!r}. A bug in this file is not a damaged bundle: converting it reports "
        "the defect to the user as a skipped image while the import claims SUCCESS.")
    assert type(raised.value).__name__ == bug, (
        f"expected the mutant to raise {bug}, got {type(raised.value).__name__}: {raised.value}")


def test_a_series_with_no_pages_is_refused_by_name_before_it_is_subscripted(tmp_path):
    """TEST-5 — the validated precondition, not a converted accident (#296 ITEM-3).

    `pages[index]` on an empty series raises `IndexError` from inside `tifffile` (measured at
    `tifffile.py:12535`), which the site rule converts correctly — into "could not be decoded
    (IndexError: list index out of range)", a sentence an operator cannot act on. A validated
    precondition is the difference between a refusal and a converted accident, so the refusal
    is asserted to name the CONDITION rather than the library's message.
    """
    import types

    XF.load_compute()
    ome_writer = sys.modules["ome_writer"]
    xenium_image = sys.modules["xenium_image"]

    class _EmptySeries:
        axes = "CYX"
        pages = []

    class _Handle:
        series = [_EmptySeries()]
        ome_metadata = ""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    fake = types.SimpleNamespace(TiffFile=lambda *a, **k: _Handle())
    saved = sys.modules.get("tifffile")
    sys.modules["tifffile"] = fake
    try:
        with pytest.raises(ome_writer.ImageConversionError) as exc:
            xenium_image.read_plane(tmp_path / "whatever.ome.tif")
    finally:
        if saved is None:
            sys.modules.pop("tifffile", None)
        else:
            sys.modules["tifffile"] = saved
    message = str(exc.value)
    assert "NO PAGES" in message, (
        f"the refusal must name the condition, not the subscript that would have failed: "
        f"{message!r}")
    assert "list index out of range" not in message, (
        "this reached `pages[index]` and was converted after the fact, so the precondition "
        f"is not doing its job: {message!r}")


def _writer_failure(exc):
    """`tifffile.TiffWriter.write` raising `exc` — the ENCODE leg of #297.

    `TiffWriter.write` is called from exactly one place in this tree (`write_ome_tiff`), so
    patching it is precise: nothing else in the import can be affected by it.
    """
    import tifffile

    def boom(*args, **kwargs):
        raise exc

    return tifffile.TiffWriter, "write", boom


def _allocation_failure(exc):
    """`np.ascontiguousarray` raising `exc` ONLY when the writer is the caller — #297's other leg.

    `np.ascontiguousarray` is also how both importers lay out their COORDINATE array
    (`import_xenium.py:1904`), so a blanket patch would break the artifact this test exists to
    prove still lands, and the test would pass for the wrong reason. The caller's filename is
    the discriminator — the same fact the fix under test rests on.
    """
    real = np.ascontiguousarray

    def only_in_the_writer(a, *args, **kwargs):
        if sys._getframe(1).f_code.co_filename.endswith("ome_writer.py"):
            raise exc
        return real(a, *args, **kwargs)

    return np, "ascontiguousarray", only_in_the_writer


@pytest.mark.parametrize("leg,injection", [
    ("allocation", _allocation_failure),
    ("encode", _writer_failure),
], ids=["allocation", "encode"])
def test_a_memoryerror_in_the_writer_costs_one_image_and_not_the_import(
        leg, injection, tmp_path, monkeypatch):
    """TEST-6 (INV-1) — #297, end to end through the REAL importer.

    `read_image` and `downsample` both convert a `MemoryError` ON PURPOSE, and `read_image`'s
    policy comment argues the case: PIL's bomb check only fires above 179 Mpx, so a
    170-megapixel 16-bit RGBA image is UNDER the threshold and still allocates ~1.4 GB — "an
    input-caused abort wearing a resource-shaped exception". Every word applied to WRITING the
    same plane, more so, since the writer holds the array, its contiguous copy AND the whole
    pyramid at once, and the module's stated motivating input is the multi-GB Xenium morphology
    image. `write_ome_tiff` nonetheless converted neither, so the identical reasoning reached
    the opposite behaviour eleven hundred lines apart in one file.

    Both legs #297 names are driven: the `np.ascontiguousarray` copy (which was outside every
    `try`) and the `TiffWriter` block (which had a `finally` and no broad `except`). The
    CONTROL is in this test — the same bundle with no injection must emit an image.
    """
    control_root = _stage_morphology_plain_tiff(tmp_path, f"mem-{leg}-control")
    control_out = tmp_path / f"mem-{leg}-control-outs"
    _cm, control_entries = XF.run_over(control_root, control_out)
    assert "spatial-image-morphology" in _ids(control_entries), (
        "the CONTROL did not emit an image, so 'the image is absent' below would be satisfied "
        f"by broken staging. Emitted {sorted(_ids(control_entries))}")

    root = _stage_morphology_plain_tiff(tmp_path, f"mem-{leg}")
    out = tmp_path / f"mem-{leg}-outs"
    target, attr, replacement = injection(MemoryError("simulated allocation failure"))
    monkeypatch.setattr(target, attr, replacement)
    _module, entries = XF.run_over(root, out)

    _import_survived(entries)
    _everything_but_the_image_survived(entries, control_entries, "spatial-image-morphology")
    ids = _ids(entries)
    assert "spatial-image-morphology" not in ids
    assert {"expression", "spatial-coordinates", "xenium-import-report"} <= ids, (
        f"a MemoryError writing ONE image cost the import its core artifacts; emitted "
        f"{sorted(ids)}")
    assert any(i.startswith("metadata-column:") for i in ids), (
        f"a MemoryError writing ONE image cost every metadata column; emitted {sorted(ids)}")
    notes = _report(out)["images_not_emitted"]
    assert len(notes) == 1, notes
    assert "MemoryError" in notes[0], (
        "the note must NAME `MemoryError`, which is the property `read_image`'s own comment "
        "claims for its arm: an operator must see a RESOURCE problem rather than a data one. "
        f"Got: {notes[0]!r}")
    assert not list(out.rglob("*.partial")), (
        f"the staging file survived the failure: {list(out.rglob('*.partial'))}")


def test_a_truncation_between_the_two_opens_costs_one_image_and_not_the_import(
        tmp_path, monkeypatch):
    """TEST-9 (INV-1) — #298 E1, the TOCTOU the issue names, end to end.

    `import_xenium` opens the morphology file twice: once through `xenium_image.read_plane`,
    and again for the OME `PhysicalSize` cross-check. `read_plane` wraps its opens; the second
    one did not, and `tifffile.TiffFileError` subclasses `Exception` DIRECTLY — its `__mro__`
    is `(TiffFileError, Exception, BaseException, object)` — so it was in neither importer's
    guard tuple. It was the only unwrapped third-party call left in either guarded body.

    Reproduced as the issue describes it: the file is truncated BETWEEN the two opens. The
    `read_plane` seam is where "between" is expressible, so the REAL `read_plane` runs and
    returns a REAL plane, and the file is truncated on its way out. Everything after that is
    the shipped importer.
    """
    def truncating_after_a_real_read(path):
        plane, selection = real_read_plane(path)
        # THE TOCTOU. The file was whole when `read_plane` opened it and is not when the
        # cross-check re-opens it — a partial re-upload, a network filesystem, an operator.
        #
        # SIXTEEN BYTES, and the number is MEASURED rather than picked: a TIFF prefix long
        # enough to carry a valid header and short enough that the IFD it points at is not
        # there raises `TiffFileError: corrupted IFD structure`, which is the type this test is
        # about. A LONGER prefix (2048 bytes) OPENS FINE and returns `ome_metadata=None`, so a
        # "truncate it a lot" test would pass while proving nothing; shorter ones (2, 4 bytes)
        # raise `struct.error` instead, which is a different escape and is covered by the
        # residue sweep.
        Path(path).write_bytes(Path(path).read_bytes()[:16])
        return plane, selection

    control_root = _stage_morphology_plain_tiff(tmp_path, "toctou-control")
    control_out = tmp_path / "toctou-control-outs"
    _cm, control_entries = XF.run_over(control_root, control_out)
    assert "spatial-image-morphology" in _ids(control_entries), (
        f"the CONTROL did not emit an image. Emitted {sorted(_ids(control_entries))}")

    root = _stage_morphology_plain_tiff(tmp_path, "toctou")
    out = tmp_path / "toctou-outs"
    # LOADED, PATCHED, THEN RUN — `XF.run_over` calls `load_compute()` itself, which builds a
    # FRESH module object and would discard a patch applied to an earlier one. (Measured: an
    # earlier draft of a sibling test patched the wrong object and passed vacuously.)
    module = XF.load_compute()
    real_read_plane = sys.modules["xenium_image"].read_plane
    monkeypatch.setattr(sys.modules["xenium_image"], "read_plane", truncating_after_a_real_read)
    entries = module.run_import(root, out)

    _import_survived(entries)
    _everything_but_the_image_survived(entries, control_entries, "spatial-image-morphology")
    ids = _ids(entries)
    assert "spatial-image-morphology" not in ids
    assert {"expression", "spatial-coordinates", "xenium-import-report"} <= ids, (
        f"a truncation between the two opens cost the import its core artifacts; emitted "
        f"{sorted(ids)}")
    assert any(i.startswith("metadata-column:") for i in ids), (
        f"a truncation between the two opens cost every metadata column; emitted {sorted(ids)}")
    notes = _report(out)["images_not_emitted"]
    assert len(notes) == 1, notes
    assert "(TiffFileError:" in notes[0], (
        "the note must NAME the exception type. This assertion used to admit the branch's own "
        "constant message prefix as an alternative, which is always true — measured: deleting "
        "the type interpolation from the E1 refusal left the test green, so INV-4 was "
        f"unenforced at this site. Got {notes[0]!r}")


def test_a_failed_image_is_never_claimed_as_emitted_in_the_warnings_channel(
        tmp_path, monkeypatch):
    """TEST-6 (INV-1) — the two note channels must not CONTRADICT each other.

    Both importers put `entries.append(...)` outside the per-image guard so an image can never
    be in `entries` and `images_not_emitted` at once — the comment at the commit point says so
    in as many words. The WARNINGS channel had no such discipline: the two-source scale notes
    are appended before `write_ome_tiff` runs and one of them says *"The image is emitted using
    `experiment.xenium`'s pixel_size alone"*. So a write that then failed produced a report
    asserting in one channel that the image WAS emitted and in the other that it was NOT.

    The placement is older than this branch; the REACHABILITY is not. Before #297 a
    `MemoryError` in the writer aborted the whole import, so there was no report to
    contradict itself in. Converting that failure is what made this observable, which makes it
    this branch's to fix.

    A bundle whose OME-XML states its pixel size in a unit this importer cannot convert is what
    produces the emission-asserting note; the `MemoryError` is what makes the write fail.
    """
    import tifffile

    root = _stage_morphology_plain_tiff(tmp_path, "contradiction")
    focus = root / "morphology_focus" / "morphology_focus_0000.ome.tif"
    with tifffile.TiffFile(str(focus)) as handle:
        plane = handle.series[0].asarray()
    # An OME image stating a physical size in a unit the importer cannot convert — the input
    # that produces the "The image is emitted using ... alone" warning.
    tifffile.imwrite(str(focus), plane, photometric="minisblack", ome=True,
                     resolution=(1e4, 1e4),
                     metadata={"axes": "YX", "PhysicalSizeX": 0.2125,
                               "PhysicalSizeXUnit": "furlong",
                               "PhysicalSizeY": 0.2125, "PhysicalSizeYUnit": "furlong"})

    # THE POSITIVE CONTROL, run FIRST and WITHOUT the injection: the same bundle must produce
    # an emission-asserting note. Without it, "no such note accompanies a failure" is satisfied
    # by a bundle that never produces one — and the assertion below is a NEGATIVE match on
    # prose, which is the shape that goes vacuously green when the prose is reworded.
    control_module = XF.load_compute()
    phrases = control_module.EMISSION_ASSERTING_PHRASES
    control_out = tmp_path / "contradiction-control"
    _cm, control_entries = XF.run_over(root, control_out)
    assert "spatial-image-morphology" in _ids(control_entries), (
        f"the control emitted no image: {sorted(_ids(control_entries))}")
    control_notes = _report(control_out).get("image_warnings", [])
    assert any(any(ph in w for ph in phrases) for w in control_notes), (
        f"the control produced no emission-asserting note matching {phrases!r}, so the "
        f"assertion below is vacuous. Control warnings: {control_notes!r}")

    out = tmp_path / "contradiction-outs"
    target, attr, replacement = _allocation_failure(MemoryError("simulated"))
    monkeypatch.setattr(target, attr, replacement)
    _module, entries = XF.run_over(root, out)

    _import_survived(entries)
    _everything_but_the_image_survived(entries, control_entries, "spatial-image-morphology")
    assert "spatial-image-morphology" not in _ids(entries)
    report = _report(out)
    not_emitted = report["images_not_emitted"]
    claimed = [w for w in report.get("image_warnings", []) if any(ph in w for ph in phrases)]
    assert not_emitted, "the failure must be reported"
    assert not claimed, (
        "the report claims this image WAS emitted in the warnings channel while the "
        f"images_not_emitted channel says it was not: {claimed!r} vs {not_emitted!r}. That is "
        "the exact contradiction the two channels were split to remove.")
