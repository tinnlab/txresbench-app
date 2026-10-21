#!/usr/bin/env python3
# ruff: noqa
"""TEST-7 / TEST-24 — the registration QC, which is the ONLY external check this importer has.

**INV-7**, lifted verbatim from `docs/design/spatial-storage-layout.md` §7.5
(ON `main` — restored by #315 (`b34d4371`), reconciled against what shipped; every
quotation below was re-verified against that merged text):

> Nothing in the conformance gate can check an affine (§12.2). The compensating control is a
> **rendered overlay in the `report/qc`**: the spot centres drawn on the tissue image at the
> declared transform, exactly as Space Ranger's own `detected_tissue_image.jpg` does. A human
> sees a misregistration instantly and sees nothing else about it. **This is a required output
> of the importer, not a nice-to-have** — it is the entire verification story for step 7.3.

Every other guard in this package reconciles the artifact with itself, and a UNIFORM MISSCALE
satisfies all of them: the coordinates agree with the image, the image agrees with its own
affine, the declarations agree with each other, and every bin is in the wrong place. This is
the only check with a referent outside the artifact, which is why "required output" is a
literal requirement and why the tests below are as much about the check being ABLE TO FAIL as
about it passing.

## TEST-24 is where this importer differs from its sibling

`spatial-import-visium`'s scale check measures against the Visium slide's manufactured 100 µm
spot pitch. Visium HD has no such referent — its capture area is a contiguous grid, so the
referent is the BIN LATTICE PITCH, which the bundle itself declares as `bin_size_um`. That is
weaker than a property of manufactured glass and the emitted block says so in
`referent_strength`; it is still a genuine external check, because the pitch is MEASURED off
`tissue_positions`, a file that never touches `scalefactors_json.json`.
"""
import base64
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402

#: The module's OWN tolerance fraction, READ rather than restated, so a change to it moves
#: this assertion with it instead of leaving a stale literal behind — and read
#: UNCONDITIONALLY: a `hasattr` hedge against this package's own test library is a silent
#: opt-out of the leg it pretends to add, which this branch has already had to repair once.
#: Read off the ENTRY's own already-staged import rather than loaded a second time: the
#: module needs the flat `/code` staging its siblings sit in, and a second execution would
#: mint a second copy of every class in it — the defect `hd_fixtures.load_compute`'s own
#: docstring records.
RQ_MAX_RESIDUAL_FRACTION = HF.load_compute().registration_qc.LATTICE_FIT_MAX_RESIDUAL_FRACTION
import hd_hostile_bundles as HB  # noqa: E402


def _report(out):
    return json.loads((Path(out) / "visium-hd-import-report.json").read_text(encoding="utf-8"))


def _qc(out):
    return _report(out)["registration_qc"]


#: How far the mis-registered variant moves the tissue, in full-resolution pixels.
#:
#: DERIVED from the fixture rather than picked: the tissue ellipse's x semi-axis is
#: `TISSUE_RX * NATIVE_COLS * pitch_px(2)` = 0.34 x 64 x 20 = 435 px, so a shift of one whole
#: semi-axis moves the tissue clear of roughly half the bins the vendor called in-tissue. A
#: smaller shift would leave the two regions overlapping enough for Youden's J to stay above
#: the floor, and the test would then be measuring the floor rather than the check.
MISREGISTRATION_PX = MF.TISSUE_RX * MF.NATIVE_COLS * MF.pitch_px(MF.NATIVE_BIN_UM)


# ── TEST-7: the overlay is a REQUIRED output, and it is EARNED ──────────────────────


def test_TEST_7_every_successful_import_emits_the_QC_with_an_overlay(tmp_path):
    """TEST-7 [acceptance, INV-7] — "a required output of the importer, not a nice-to-have".

    Three things, and the third is the one that makes it a picture rather than a claim:
    the `report/qc` artifact exists on every successful import; it carries a per-image
    verdict; and the embedded overlay DECODES TO A REAL PNG whose pixels DIFFER from the
    source plane — i.e. something was actually drawn on it.

    Without that last leg, an overlay generator that returned the source image untouched, or
    a blank canvas, would satisfy "an overlay is embedded" while showing a human nothing.

    ## The fourth leg, added after a mutation showed the first three were not enough

    The per-image loop below used to open `for image in qc["images"]:` and then assert a
    LOOP-INVARIANT fact — that the HTML contains at least one PNG data-URI — which does not
    mention `image` at all; the only per-image expression in it was bound and discarded.
    `overlay_embedded` was checked for truthiness alone. So an importer that rendered an
    overlay for the FIRST placeable image and silently skipped every other one passed the
    whole suite. MEASURED: gating the overlay dict to the first entry drops the lowres
    overlay entirely (two embedded PNGs become one) and all 362 tests stayed green.

    That is a real regression shape rather than a hypothetical: §7.3 rule 3's whole point is
    N images in ONE space, and `registration_qc` scores them per image. So the count is now
    asserted against the images that were actually placed, by id.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    qc = _qc(tmp_path / "out")

    entry = HF.entry_by_id(entries, "visium-hd-import-report")
    assert entry["datatype"] == "report/qc"
    assert qc["images"], "the QC recorded no per-image verdict at all"

    summary = HF.entry_by_id(entries, "visium-hd-import-summary")
    assert summary["meta"]["overlay_embedded"], (
        "no overlay was embedded, so §7.5's compensating control did not run")

    html = (tmp_path / "out" / "visium-hd-import-summary.html").read_text(encoding="utf-8")
    assert "data:image/png;base64," in html, "no PNG data-URI reached the report"

    # EVERY PLACED IMAGE, BY ID. The set is compared against the `spatial/image` artifacts
    # this run actually emitted, so it cannot be satisfied by an importer that renders one
    # overlay, and it cannot go vacuous on a bundle that placed nothing (the emitted set is
    # asserted non-empty and to hold both vendor images).
    placed = {e["id"] for e in entries if e["datatype"] == "spatial/image"}
    assert placed == {"spatial-image-hires", "spatial-image-lowres"}, (
        f"the fixture placed {placed!r}; this test's per-image leg is about the images that "
        f"were placed, so a fixture that placed fewer would weaken it silently")
    assert set(summary["meta"]["overlay_embedded"]) == placed, (
        f"an overlay was rendered for {summary['meta']['overlay_embedded']!r} but "
        f"{sorted(placed)} images were placed — §7.5's control is per image, and an "
        f"unoverlaid image is one whose registration no human ever looks at")
    # And the BYTES are per image too: one distinct payload per placed image.
    assert html.count("data:image/png;base64,") >= len(placed), (
        f"{html.count('data:image/png;base64,')} PNG data-URI(s) reached the report for "
        f"{len(placed)} placed image(s)")

    marker = "data:image/png;base64,"
    payloads = []
    rest = html
    while marker in rest:
        rest = rest.split(marker, 1)[1]
        payload, rest = rest.split("'", 1) if "'" in rest else (rest, "")
        payloads.append(payload)
    assert payloads, "no embedded PNG payload found in the report HTML"

    from PIL import Image
    import io as _io

    source = np.asarray(Image.open(
        HF.FIXTURE / "binned_outputs" / f"square_{module.DEFAULT_BIN_UM:03d}um" /
        "spatial" / "tissue_hires_image.png").convert("RGB"))
    drew_something = False
    for payload in payloads:
        try:
            raw = base64.b64decode(payload, validate=True)
        except Exception:
            continue
        rendered = np.asarray(Image.open(_io.BytesIO(raw)).convert("RGB"))
        if rendered.shape == source.shape and not np.array_equal(rendered, source):
            drew_something = True
    assert drew_something, (
        "every embedded overlay is byte-identical to the source image at that size — the "
        "overlay was produced but nothing was DRAWN on it, so a human looking at it would "
        "see the tissue and no bins")


def test_TEST_7_the_overlay_verdict_CAN_FAIL_on_a_misregistered_bundle(tmp_path):
    """TEST-7 [acceptance, INV-7] — the verdict is EARNED, not stamped.

    This is the leg that makes TEST-7 an assertion about the design rather than about the
    code. A QC that returns `pass` unconditionally satisfies every structural assertion above
    — the artifact exists, the block is there, an overlay is embedded. Only a bundle that
    SHOULD fail can tell the two apart.

    The variant moves the tissue in the IMAGE and leaves the coordinates and the declared
    affine correct, which is exactly what a misregistration is: nothing is malformed, the bins
    are simply drawn in the wrong place. Space Ranger's own `detected_tissue_image.jpg` exists
    to make the same thing visible.
    """
    module = HF.load_compute()
    good = HF.staged_tree(tmp_path / "good")
    bad = HF.staged_tree(tmp_path / "bad", image_offset_px=(MISREGISTRATION_PX, 0.0))

    module.run_import(good, tmp_path / "out-good")
    module.run_import(bad, tmp_path / "out-bad")

    good_qc, bad_qc = _qc(tmp_path / "out-good"), _qc(tmp_path / "out-bad")
    assert good_qc["registration_verdict"] == "pass", (
        f"the ALIGNED bundle did not pass, so a failure below proves nothing: {good_qc}")
    assert bad_qc["registration_verdict"] == "fail", (
        f"a bundle whose tissue is {MISREGISTRATION_PX:.0f} full-resolution pixels away from "
        f"where the bins are placed scored {bad_qc['registration_verdict']!r} — the "
        "registration check cannot fail, which makes it a decoration rather than a control")
    # The two Youden's J values must actually differ, or the verdict flipped on a threshold
    # rather than on a measurement.
    good_j = good_qc["images"][0]["youden_j"]
    bad_j = bad_qc["images"][0]["youden_j"]
    assert bad_j < good_j, f"J did not move: aligned {good_j}, misregistered {bad_j}"


def test_TEST_7_a_FAILING_verdict_does_NOT_refuse_the_import(tmp_path):
    """TEST-7 [acceptance, INV-7] — the QC reports loudly; it does not destroy access to the data.

    The same posture `emit_images` takes for a damaged image, and it is a deliberate choice
    rather than an omission: a diagnostic that is uncertain must not cost the user their
    matrix, their coordinates and their columns. So a `fail` verdict emits every artifact AND
    puts the verdict in the one channel a human sees — `meta`, because nothing in this app
    renders `report/html` (#223).
    """
    module = HF.load_compute()
    bad = HF.staged_tree(tmp_path, image_offset_px=(MISREGISTRATION_PX, 0.0))
    entries = module.run_import(bad, tmp_path / "out")

    assert HF.entry_by_id(entries, "expression")
    assert HF.entry_by_id(entries, "spatial-coordinates")
    assert HF.entry_by_id(entries, "spatial-image-hires")

    qc_entry = HF.entry_by_id(entries, "visium-hd-import-report")
    assert qc_entry["meta"]["registration_qc_verdict"] == "fail"
    lines = qc_entry["meta"]["registration_qc"]
    assert any("registration" in line and "fail" in line for line in lines), (
        f"the failing verdict does not appear in the channel a human reads: {lines}")


def test_TEST_7_the_overlay_is_a_REPORT_output_and_never_an_ARTIFACT(tmp_path):
    """TEST-7 [acceptance, INV-7] — §7.2: the diagnostics are "diagnostics, not data".

    The overlay is embedded in the report and is NOT emitted as its own artifact, so this
    contribution's declared `produces` and its output count are unchanged by it. An overlay
    that became an artifact would be a rendered picture entering a dataset's data plane, where
    a later analysis could read it as tissue.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    images = [e for e in entries if e["datatype"] == "spatial/image"]
    for entry in images:
        assert "overlay" not in entry["id"], f"an overlay was emitted as an artifact: {entry['id']}"
    # Only the two vendor images become artifacts; the overlay stays in the report.
    assert {e["id"] for e in images} == {"spatial-image-hires", "spatial-image-lowres"}
    assert not list((tmp_path / "out").glob("*overlay*"))


# ── TEST-24: the SCALE check, and its HD-specific referent ─────────────────────────


def test_TEST_24_the_referent_is_the_BIN_LATTICE_PITCH_and_not_a_slide(tmp_path):
    """TEST-24 — the difference from the sibling, asserted in the emitted block.

    `spatial-import-visium` checks against the Visium slide's manufactured 100 µm spot pitch.
    Visium HD has no slide pitch: its capture area is "a continuous grid of 2x2 um squares (no
    gaps)" (`06-spatial-processing.md:120`), so a bin's SIDE is its pitch, and the referent is
    this run's own `bin_size_um`.

    Three assertions, and the third is the one that stops a copy-paste regression: the
    referent must be NAMED as the bin pitch, its value must be THIS bin's size (not a
    constant, not the default bin's), and 100.0 must not appear as the referent anywhere —
    which is what a vendored copy of the sibling's module would produce while every other
    assertion here still passed.
    """
    module = HF.load_compute()
    for bin_um in MF.BINS:
        out = tmp_path / f"out{bin_um}"
        module.run_import(HF.FIXTURE, out, requested_bin=bin_um)
        scale = _qc(out)["scale"]
        assert scale["referent"] == "visium-hd-bin-pitch"
        assert scale["referent_um"] == float(bin_um), (
            f"the {bin_um} um run checked against a {scale['referent_um']} um referent")
        assert scale["referent_um"] != 100.0 or bin_um == 100


def test_TEST_24_the_referent_is_MEASURED_against_a_file_that_does_not_declare_it(tmp_path):
    """TEST-24 — why this counts as an EXTERNAL check even though the referent is vendor data.

    `bin_size_um` is a DECLARATION in `scalefactors_json.json`. The pitch it is checked
    against is MEASURED off `tissue_positions.parquet`, which never touches that file. So the
    two sides are independent and a wrong `microns_per_pixel` is visible — which is the whole
    point, since `microns_per_pixel` is the number every micron-denominated result in this
    dataset descends from.

    The block must also DISCLOSE the limit, because a reader comparing a green banner here
    against a green banner from the Visium importer would otherwise read parity into them: a
    `bin_size_um` wrong in the same proportion as `microns_per_pixel` passes this check and
    could not pass the Visium one.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    scale = _qc(tmp_path / "out")["scale"]

    assert scale["measured_pitch_px"] == pytest.approx(
        MF.pitch_px(module.DEFAULT_BIN_UM), rel=1e-9)
    assert scale["measured_pitch_um"] == pytest.approx(float(module.DEFAULT_BIN_UM), rel=1e-9)
    assert scale["relative_error"] == pytest.approx(0.0, abs=1e-9)
    assert scale["verdict"] == "pass"
    strength = scale.get("referent_strength", "")
    assert "vendor-declared" in strength and "weaker" in strength.lower(), (
        "the block does not disclose that this referent is weaker than the Visium arm's, so a "
        f"reader comparing two green banners would read parity into them: {strength!r}")


def test_TEST_24_a_WRONG_micron_scale_scores_FAIL(tmp_path):
    """TEST-24 — the check can fail, on the number it exists to check.

    A `microns_per_pixel` 20 % off is exactly the defect class the sibling shipped twice (#222
    at 15.4 %, #257 per slide design) and that no internal consistency check can see: every
    artifact agrees with every other, the tissue map draws correctly against the image, and
    every micron-denominated result is silently wrong by that factor.

    The aligned run in the same test is the control — without it, "the bad bundle failed"
    would also be satisfied by a check that fails on everything.
    """
    module = HF.load_compute()
    honest = MF.MICRONS_PER_PIXEL
    wrong = honest * 1.2

    good = HF.staged_tree(tmp_path / "good")
    bad = HF.staged_tree(
        tmp_path / "bad",
        scalefactor_overrides={b: {"extra": {"microns_per_pixel": wrong}} for b in MF.BINS},
    )
    module.run_import(good, tmp_path / "out-good")
    module.run_import(bad, tmp_path / "out-bad")

    assert _qc(tmp_path / "out-good")["scale"]["verdict"] == "pass"
    bad_scale = _qc(tmp_path / "out-bad")["scale"]
    assert bad_scale["verdict"] == "fail", (
        f"a {(wrong / honest - 1) * 100:.0f}% wrong micron scale passed the only check that "
        f"can see it: {bad_scale.get('reason')}")
    assert bad_scale["relative_error"] == pytest.approx(0.2, rel=1e-6)
    # …and the reason NAMES the numbers, so a reader can act without opening the JSON.
    assert "8" in bad_scale["reason"] and "%" in bad_scale["reason"]


def test_TEST_24_a_bundle_with_NO_scale_is_NOT_EVALUATED_rather_than_passed(tmp_path):
    """TEST-24 — absence is absence here too: an unmeasurable check reports so.

    With no `microns_per_pixel` there is nothing to check the pitch against. A `pass` would
    claim the scale was verified; a `fail` would claim it was wrong. `not-evaluated` is the
    only true answer, and the run must still emit everything else.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, scalefactor_overrides={8: {"drop": ("microns_per_pixel",)}})
    entries = module.run_import(root, tmp_path / "out")

    scale = _qc(tmp_path / "out")["scale"]
    assert scale["verdict"] == "not-evaluated"
    assert scale.get("reason"), "a not-evaluated verdict with no reason says nothing"
    assert HF.entry_by_id(entries, "spatial-coordinates")


def test_TEST_24_the_check_reads_the_WHOLE_positions_table_not_the_filtered_subset(tmp_path):
    """TEST-24 — the scope, which is load-bearing rather than an optimisation.

    The filtered matrix holds ONLY the bins under tissue, so over that subset `in_tissue` has
    ONE class: specificity is undefined, Youden's J cannot be computed, and the registration
    check would report `not-evaluated` on every real bundle in existence — a check that cannot
    fail. The positions table carries every square with the vendor's own call for each, which
    is the two-class label the mask has to be scored against.

    Asserted on the recorded scope AND on the counts, because a scope string is cheap to set
    and the counts are what prove it.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    qc = _qc(tmp_path / "out")
    report = _report(tmp_path / "out")

    assert qc["scope"] == "all-bins-in-positions-table"
    assert qc["n_spots_checked"] == report["n_positions_in_bundle"]
    assert qc["n_spots_checked"] > report["n_bins"], (
        "the check ran over as few rows as the filtered matrix has, so `in_tissue` is "
        "single-class and the registration verdict cannot mean anything")
    image = qc["images"][0]
    assert image["n_in_tissue"] > 0 and image["n_out_of_tissue"] > 0, (
        "the scored sample has only one class — Youden's J is undefined and the check cannot "
        "fail")


# ── TEST-36: the class TEST-7 never ran — a bundle with NO placeable image ─────────


def test_TEST_36_a_bundle_with_NO_PLACEABLE_IMAGE_still_reports_the_QC_and_says_why(tmp_path):
    """TEST-36 [acceptance, INV-7] — §7.5's "required output" on the arm nobody exercised.

    ## The gap this closes

    Every overlay assertion in this file drives `HF.FIXTURE`, whose images are placeable. So
    the whole verification story was proven on ONE class of bundle, and a bundle whose
    `scalefactors_json.json` carries no usable `tissue_hires_scalef`/`tissue_lowres_scalef`
    imports SUCCESSFULLY with zero overlay rendered — a state in which the overlay leg could
    be switched off entirely and every test here would stay green.

    ## What "required output" means when there is no image to draw on

    It cannot mean an overlay: an overlay is bins drawn ON a placed image, and there is no
    placed image. It means the QC still has to be EMITTED and still has to SAY, in the
    channel a human reads, that the check did not run and why — an unevaluated registration
    silently reported as nothing is indistinguishable from a passing one.

    So three things are asserted, and the third is the one with teeth:

    1. the `report/qc` artifact is emitted, with verdict `not-evaluated`;
    2. the verdict line NAMES the reason and points at `images_not_emitted`, which itself
       names both images;
    3. the R1 SCALE check — which needs no image at all — still ran and still has a verdict.
       Without this, "not-evaluated" could quietly become the answer to every question rather
       than to the one the missing image actually blocks.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, scalefactor_overrides={
        8: {"drop": ("tissue_hires_scalef", "tissue_lowres_scalef")}})
    entries = module.run_import(root, tmp_path / "out")

    assert not [e for e in entries if e["datatype"] == "spatial/image"], (
        "this bundle's images are unplaceable; if one was emitted, the precondition of this "
        "test is gone and its assertions below mean something else")

    qc_entry = HF.entry_by_id(entries, "visium-hd-import-report")
    assert qc_entry is not None, (
        "no `report/qc` artifact was emitted for a bundle with no placeable image — §7.5 "
        "calls the QC a required output of the importer, not of the happy path")
    assert qc_entry["meta"]["registration_qc_verdict"] == "not-evaluated"

    lines = qc_entry["meta"]["registration_qc"]
    registration = [ln for ln in lines if ln.startswith("registration:")]
    assert len(registration) == 1, f"expected one registration verdict line, got {lines!r}"
    assert "not-evaluated" in registration[0] and "images_not_emitted" in registration[0], (
        f"the unevaluated registration does not say WHY, or does not point at the channel "
        f"that does: {registration[0]!r}")

    report = _report(tmp_path / "out")
    notes = report["images_not_emitted"]
    assert len(notes) == 2 and all("scalef" in n for n in notes), (
        f"the reason each image was dropped is not stated per image: {notes!r}")

    # (3) The check that does NOT depend on an image still ran.
    scale = [ln for ln in lines if ln.startswith("scale vs the bin lattice pitch:")]
    assert len(scale) == 1 and "not-evaluated" not in scale[0], (
        f"the scale check needs no image and must still have a verdict here: {lines!r}")

    # And no overlay claims to exist.
    summary = HF.entry_by_id(entries, "visium-hd-import-summary")
    assert summary["meta"]["overlay_embedded"] == [], (
        f"an overlay is listed for a bundle with no placed image: "
        f"{summary['meta']['overlay_embedded']!r}")
    assert "data:image/png;base64" not in (
        Path(tmp_path / "out" / "visium-hd-import-summary.html").read_text(encoding="utf-8")
    ), "the report embeds an overlay PNG although no image was placed"


def test_TEST_36_the_CONTROL_the_same_bundle_WITH_scalefactors_does_render_one(tmp_path):
    """TEST-36 — the positive control, without which the test above passes on a dead leg.

    "No overlay, and the QC says why" is also satisfied by an importer that never renders an
    overlay at all. Same generator, same bin, scalefactors present: the overlay must be
    there, must decode to real PNG bytes, and the verdict must be an actual judgement rather
    than `not-evaluated`.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    summary = HF.entry_by_id(entries, "visium-hd-import-summary")
    assert summary["meta"]["overlay_embedded"], (
        "the control renders no overlay either, so the assertion above is about nothing")
    qc_entry = HF.entry_by_id(entries, "visium-hd-import-report")
    assert qc_entry["meta"]["registration_qc_verdict"] != "not-evaluated"
    html = (Path(tmp_path) / "out" / "visium-hd-import-summary.html").read_text(
        encoding="utf-8")
    assert "data:image/png;base64" in html
    # The URI is single-quoted in the emitted HTML, the same way TEST-7 reads it.
    rest = html.split("data:image/png;base64,", 1)[1]
    payload = rest.split("'", 1)[0] if "'" in rest else rest.split('"', 1)[0]
    assert base64.b64decode(payload, validate=True)[:8] == b"\x89PNG\r\n\x1a\n", (
        "the embedded overlay is not PNG bytes")


# ── TEST-39: the QC runs AFTER every writer, so it may never raise ──────────────────


def test_TEST_39_a_BAD_VALUE_in_an_UNUSED_row_costs_THAT_ROW_and_nothing_else(tmp_path):
    """TEST-39 [acceptance, INV-8] — the one code path where an exception falsifies INV-8,
    and the one where over-defending hides a real failure.

    ## Why this path is different from every other read

    `column()` in `run_import` refuses a non-finite coordinate BY NAME, and it is allowed to:
    it runs before the first writer, so the refusal leaves nothing behind. `_qc_column` reads
    the SAME file at progress 93 %, AFTER the matrix, the coordinates, the columns and the
    images are on disk — and it reads the WHOLE positions table, not the filtered matrix's
    rows. So it sees values `column()` never does.

    The first cut copied `column()`'s `(TypeError, ValueError)` tuple into it. A row the
    filtered matrix does not use holding `inf` then raised `OverflowError` out of a `try`
    that does not catch it: exit 1, a raw traceback, and 115 paths already on disk — which
    falsifies this module's own INV-8 headline using a bundle the importer had ACCEPTED.

    ## And then the over-correction, which is what this test now pins

    The repair vetoed the whole COLUMN on one bad value, and abandoned all three columns
    together — so one damaged number in an unused row turned the registration check into
    `not-evaluated`, which the module's own comment calls "a check that cannot fail". A blind
    audit reproduced the consequence that matters: a GENUINE misregistration (the tissue
    image shifted 300 full-resolution pixels, which scores `fail` on a clean table) was
    downgraded to `not-evaluated` by adding a single NaN to a row the vendor had already
    marked `in_tissue = 0`. A defect hidden by a value that has nothing to do with it.

    So the bad ROW is dropped and the check still runs on everything else. Three legs:

    1. the import succeeds and every artifact is emitted (INV-8's real content here);
    2. the QC keeps the WIDE scope and NAMES the exclusion, so a narrower sample is never
       reported as the whole table, and the count is the count;
    3. a real `fail` SURVIVES the bad row. Leg 3 is the one with teeth — legs 1 and 2 are
       both satisfied by a check that silently answers `not-evaluated` to everything.
    """
    module = HF.load_compute()
    rows = [list(r) for r in MF.positions_rows(8)]
    unused = next(r for r in rows if not r[1])       # in_tissue == 0 -> not in the filtered matrix
    unused[4] = float("nan")

    # A REAL misregistration underneath, so leg 3 has something to detect.
    root = HF.staged_tree(tmp_path, image_offset_px=(MISREGISTRATION_PX, 0.0))
    MF.write_positions_parquet(
        Path(root) / "binned_outputs" / "square_008um" / "spatial"
        / "tissue_positions.parquet",
        [tuple(r) for r in rows],
    )

    entries = module.run_import(root, tmp_path / "out")

    for wanted in ("expression", "spatial-coordinates", "spatial-image-hires",
                   "visium-hd-import-report"):
        assert HF.entry_by_id(entries, wanted) is not None, (
            f"{wanted} is missing: a bad value in a row the matrix does not even use cost "
            f"the user their import")

    block = _qc(tmp_path / "out")
    assert block["scope"].startswith("all-bins-in-positions-table"), (
        f"the QC reports scope {block['scope']!r} — one unplaceable row in a table this "
        f"import already accepted must not cost the whole-table check")
    assert block["scope"] != "all-bins-in-positions-table", (
        "the scope does not disclose that a row was excluded, so a narrower sample is being "
        "reported as the whole table")
    assert "1" in block["scope"], f"the excluded-row COUNT is not in the scope: {block['scope']!r}"
    assert block["n_spots_checked"] == len(rows) - 1, (
        f"{block['n_spots_checked']} rows checked of {len(rows)} — exactly one row was "
        f"unplaceable, so exactly one may be missing")

    # LEG 3 — the misregistration is still found.
    assert block["verdict"] == "fail", (
        f"the registration verdict is {block['verdict']!r} on a bundle whose image is "
        f"{MISREGISTRATION_PX} px out — one NaN in an unused row turned a real failure into "
        f"no answer at all, which is the defect this drop-the-row behaviour exists to fix")


def test_TEST_39_the_SAME_misregistration_is_found_WITHOUT_the_bad_row(tmp_path):
    """TEST-39 — the control that makes leg 3 above mean something.

    If the shifted fixture did not score `fail` on a clean positions table, leg 3 would be
    asserting a verdict the bundle earns for some other reason. Same shift, no NaN.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, image_offset_px=(MISREGISTRATION_PX, 0.0))
    module.run_import(root, tmp_path / "out")
    block = _qc(tmp_path / "out")
    assert block["verdict"] == "fail"
    assert block["scope"] == "all-bins-in-positions-table"


def test_TEST_39_the_CONTROL_a_clean_table_reports_the_WIDE_scope(tmp_path):
    """TEST-39 — without this, "the scope is named" passes on an importer that always narrows.

    The good fixture's positions table parses completely, so the QC must report the WHOLE
    table's scope — which is also the scope that makes the check stronger than the import's
    own consistency (it sees bins the filtered matrix dropped).
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    block = _qc(tmp_path / "out")
    assert block["scope"] == "all-bins-in-positions-table", (
        f"the clean fixture did not report the wide scope: {block['scope']!r}")
    assert block["n_spots_checked"] == len(MF.positions_rows(8)), (
        f"the wide scope checked {block['n_spots_checked']} of "
        f"{len(MF.positions_rows(8))} rows, so it is not the whole table")


def test_TEST_39_a_NON_FINITE_LATTICE_INDEX_does_not_reach_an_UNDEFINED_cast(tmp_path):
    """TEST-39 — the mask must PROVE finite what the cast then assumes.

    ## The defect a fix round introduced

    Dropping bad ROWS instead of whole columns built the `usable` mask from three of the five
    QC columns — the two coordinates and `in_tissue`. `array_row`/`array_col` were filtered BY
    that mask and never tested against it, then cast with a bare `.astype(np.int64)`. A NaN in
    a lattice index therefore survived verbatim into an UNDEFINED cast: it becomes INT64_MIN
    and is handed to `lattice_fit_pitch` as a real array index.

    MEASURED through the shipped entrypoint on an otherwise clean bundle: exit 0, a
    `RuntimeWarning: invalid value encountered in cast` written to STDERR — two non-`progress:`
    lines, which `scheduler.rs::drain_logs` turns into two job_logs rows on a run this module
    treats as clean — and the lattice-fit corroboration silently ABSENT from the report.

    ## What is asserted, and why stderr is one of the assertions

    A parquet column is TYPED, so `array_row` as a float column carrying a NaN is a shape only
    this reader can be handed, and `column()` never sees it (it reads the matrix-joined subset
    only). Three legs:

    1. the run is clean — exit 0, and STDERR carries nothing but `progress:` lines. A numpy
       warning on a successful run is not cosmetic here: it becomes log rows a human reads;
    2. the row is DROPPED and the scope says so;
    3. the lattice fit still RAN. Legs 1 and 2 are both satisfied by silently discarding the
       corroboration, which is what the defect did.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    rows = MF.positions_rows(8)
    unused_i = next(i for i, r in enumerate(rows) if not r[1])
    array_row = [float(r[2]) for r in rows]
    array_row[unused_i] = float("nan")
    root = HF.staged_tree(tmp_path)
    table = pa.table({
        "barcode": pa.array([r[0] for r in rows], pa.string()),
        "in_tissue": pa.array([int(r[1]) for r in rows], pa.int8()),
        "array_row": pa.array(array_row, pa.float64()),
        "array_col": pa.array([r[3] for r in rows], pa.int32()),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([float(r[5]) for r in rows], pa.float64()),
    })
    pq.write_table(table, Path(root) / "binned_outputs" / "square_008um" / "spatial"
                   / "tissue_positions.parquet", row_group_size=64)

    # THE PRODUCTION LAYOUT, not the path-preserving one. This line used to read
    # `HF.staged_flat_from(root, ...) if hasattr(HF, "staged_flat_from") else root` — and
    # `staged_flat_from` has never existed in `hd_fixtures`, so the ternary was permanently
    # dead and the test only ever drove the path-preserving tree. A `hasattr` hedge against a
    # helper in this package's OWN test library is a silent opt-out of the leg it pretends to
    # add; the helper is `staged_flat`, and it is called unconditionally.
    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")
    assert result.returncode == 0, (
        f"a NaN in a lattice index of a row the matrix never uses refused the import:\n"
        f"{result.stderr[-1200:]}")

    noise = [ln for ln in result.stderr.splitlines()
             if ln.strip() and not ln.startswith("progress:")]
    assert not noise, (
        "a successful run wrote non-progress lines to stderr, which become job_logs rows a "
        f"human reads: {noise!r}")

    block = _qc(tmp_path / "out")
    assert block["scope"] == "all-bins-in-positions-table-minus-1-unplaceable", (
        f"the unplaceable row is not dropped-and-named: {block['scope']!r}")
    fit = block["scale"].get("lattice_fit")
    assert fit, (f"the lattice-fit corroboration is gone from the report with no note: "
                 f"{sorted(block['scale'])}")
    # AND IT STILL CORROBORATES — the positive half of the boolean. Dropping the bad ROW is
    # what keeps the fit clean; `assert fit` alone is satisfied by a fit dragged to nonsense,
    # which is the defect the corroboration flag was added for.
    assert fit["corroborates"] is True, (
        f"the bad row was dropped and the fit still does not corroborate: {fit!r}")


# ── TEST-42 / TEST-43: the two doors round 3's own repair left open ────────────────────


def _positions_with_lattice_column(tmp_path, array_row_values, dtype):
    """The committed 8 um positions table, rewritten with `array_row` at a chosen dtype."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    rows = MF.positions_rows(8)
    root = HF.staged_tree(tmp_path)
    table = pa.table({
        "barcode": pa.array([r[0] for r in rows], pa.string()),
        "in_tissue": pa.array([int(r[1]) for r in rows], pa.int8()),
        "array_row": pa.array(array_row_values(rows), dtype),
        "array_col": pa.array([r[3] for r in rows], pa.int32()),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([float(r[5]) for r in rows], pa.float64()),
    })
    pq.write_table(table, Path(root) / "binned_outputs" / "square_008um" / "spatial"
                   / "tissue_positions.parquet", row_group_size=64)
    return root, rows


def test_TEST_42_a_NON_INTEGRAL_lattice_index_costs_THAT_ROW_and_nothing_else(tmp_path):
    """TEST-42 [acceptance, INV-8 + INV-9] — the crash, and then the over-correction.

    ## The crash this test was written for

    FIX_ROUND-3 hoisted `array_row`/`array_col` out of the branch and deleted the
    `if qc_rows is not None:` guards that had stood around the `.astype(np.int64)` — but left
    the fallback test at THREE columns. `_qc_column(name, int)` used to veto the WHOLE column
    when any row in it was non-integral, so a bundle whose coordinates and `in_tissue` all
    parsed while `array_row` did not skipped the five-column mask block, took the `else`
    branch, and evaluated `None.astype(np.int64)`. MEASURED on the committed fixture with ONE
    `in_tissue=0` row's `array_row` set to 3.5: exit 1, a raw `AttributeError`, and 116 paths
    already on disk — both headline invariants, at 93 %, after every writer.

    ## And the over-correction the FIRST repair left behind

    Widening the gate to five columns turned the crash into a SILENT DOWNGRADE, which the
    blind re-audit reproduced: the whole-column veto was still there, so the same 3.5 discarded
    the wide two-class sample (160 squares, 52 in tissue, `youden_j: 1.0`, verdict `pass`) in
    favour of the matrix-joined subset — which is ONE-CLASS BY CONSTRUCTION. The only check in
    this importer with a referent outside the artifact then reported `not-evaluated`, and the
    reason it gave a reader was "every bin carries the same `in_tissue` value": a true sentence
    about the wrong column. A genuine misregistration would have been hidden by a value that
    has nothing to do with it — which is the exact failure the block's own comment says it
    closed for the non-finite case.

    Integrality is a property of a ROW. It is tested in the mask now, beside finiteness and
    int32 range, so this input costs THAT ROW and nothing else.

    ## The trigger is an ordinary bundle, not a hostile one

    `column()`'s integrality refusal reads the MATRIX-JOINED rows only, so one fractional
    lattice index in a row the vendor already marked `in_tissue=0` — a row the filtered matrix
    never carries — passes every check before the first writer. Nothing about this bundle is
    refusable, so the correct outcome is a complete import whose QC keeps its wide scope and
    NAMES what it left out. Driven through the FLATTENED production staging.
    """
    import pyarrow as pa

    def vals(rows):
        unused_i = next(i for i, r in enumerate(rows) if not r[1])
        out = [float(r[2]) for r in rows]
        out[unused_i] = 3.5
        return out

    root, rows = _positions_with_lattice_column(tmp_path, vals, pa.float64())
    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")

    assert result.returncode == 0, (
        f"a non-integral lattice index in a row the matrix never uses cost the whole "
        f"import:\n{result.stderr[-1500:]}")
    assert "Traceback" not in result.stderr, (
        f"INV-9: a raw traceback reached stderr:\n{result.stderr[-1500:]}")
    noise = [ln for ln in result.stderr.splitlines()
             if ln.strip() and not ln.startswith("progress:")]
    assert not noise, f"a successful run wrote non-progress stderr lines: {noise!r}"

    block = _qc(tmp_path / "out")
    assert block["scope"] == "all-bins-in-positions-table-minus-1-unplaceable", (
        "one non-integral lattice index must cost THAT ROW and nothing else -- a fallback to "
        "`matrix-joined-bins` here is the one-class subset, on which the registration check "
        f"cannot fail at all: {block['scope']!r}")
    assert block["n_spots_checked"] == len(rows) - 1, (
        f"the wide scope checked {block['n_spots_checked']} of {len(rows) - 1} placeable rows")
    # THE LEG WITH TEETH: the verdict is still a real two-class judgement, not `not-evaluated`.
    verdicts = {image["verdict"] for image in block["images"]}
    assert verdicts and "not-evaluated" not in verdicts, (
        f"the registration verdict was downgraded to a check that cannot fail: {verdicts!r}")
    fit = block["scale"].get("lattice_fit")
    assert fit, (f"the lattice-fit corroboration is gone from the report with no note: "
                 f"{sorted(block['scale'])}")
    # AND IT STILL CORROBORATES — the positive half of the boolean. Dropping the bad ROW is
    # what keeps the fit clean; `assert fit` alone is satisfied by a fit dragged to nonsense,
    # which is the defect the corroboration flag was added for.
    assert fit["corroborates"] is True, (
        f"the bad row was dropped and the fit still does not corroborate: {fit!r}")


def test_TEST_43_a_LATTICE_INDEX_TOO_LARGE_FOR_int32_is_dropped_and_NAMED(tmp_path):
    """TEST-43 [acceptance, INV-8] — the mask must prove PLACEABLE, not merely FINITE.

    ## The door the finiteness mask left open

    `_qc_column(..., int)` proves a value INTEGRAL and nothing else, so the round-3 mask —
    `np.isfinite` on all five columns — still admitted a finite, integral lattice index far
    outside `int64`'s range straight into `.astype(np.int64)`, which is UNDEFINED. It becomes
    INT64_MIN and is handed to `lattice_fit_pitch` as a real array index. Testing against
    `iinfo(int64)` does not close it either: `float64(2**63 - 1)` rounds UP past int64's own
    maximum, so the comparison is vacuously true. `array_row`/`array_col` are `int32` columns
    by declaration and `column()` already bounds the matrix-joined path by exactly that
    range, which IS exactly representable in float64.

    MEASURED with `array_row = iinfo(int64).max` in one `in_tissue=0` row (a width
    `make_fixture.write_positions_parquet`'s own docstring says a vendor may write): exit 0,
    `RuntimeWarning: invalid value encountered in cast` on a SUCCESSFUL run's stderr, and
    `lattice_fit: null` in the report with nothing saying why.

    Same three legs as the NaN case, because it is the same defect at a different value:
    clean run, row dropped AND named, corroboration still ran.
    """
    import numpy as np
    import pyarrow as pa

    def vals(rows):
        unused_i = next(i for i, r in enumerate(rows) if not r[1])
        out = [int(r[2]) for r in rows]
        out[unused_i] = int(np.iinfo(np.int64).max)
        return out

    root, _rows = _positions_with_lattice_column(tmp_path, vals, pa.int64())
    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")

    assert result.returncode == 0, (
        f"an unplaceable lattice index in an unused row cost the whole import:\n"
        f"{result.stderr[-1500:]}")
    noise = [ln for ln in result.stderr.splitlines()
             if ln.strip() and not ln.startswith("progress:")]
    assert not noise, (
        "a successful run wrote non-progress lines to stderr, which become job_logs rows a "
        f"human reads: {noise!r}")

    block = _qc(tmp_path / "out")
    assert block["scope"] == "all-bins-in-positions-table-minus-1-unplaceable", (
        f"the unplaceable row is not dropped-and-named: {block['scope']!r}")
    fit = block["scale"].get("lattice_fit")
    assert fit, (f"the lattice-fit corroboration is gone from the report with no note: "
                 f"{sorted(block['scale'])}")
    # AND IT STILL CORROBORATES — the positive half of the boolean. Dropping the bad ROW is
    # what keeps the fit clean; `assert fit` alone is satisfied by a fit dragged to nonsense,
    # which is the defect the corroboration flag was added for.
    assert fit["corroborates"] is True, (
        f"the bad row was dropped and the fit still does not corroborate: {fit!r}")


# ── TEST-47: the two mask legs the round that added them did not test ───────────────


def _positions_with_column(tmp_path, name, values, dtype):
    """The committed 8 um positions table with ONE named column rewritten."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    rows = MF.positions_rows(8)
    root = HF.staged_tree(tmp_path)
    cols = {
        "barcode": pa.array([r[0] for r in rows], pa.string()),
        "in_tissue": pa.array([int(r[1]) for r in rows], pa.int8()),
        "array_row": pa.array([int(r[2]) for r in rows], pa.int32()),
        "array_col": pa.array([int(r[3]) for r in rows], pa.int32()),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([float(r[5]) for r in rows], pa.float64()),
    }
    cols[name] = pa.array(values(rows), dtype)
    pq.write_table(pa.table(cols), Path(root) / "binned_outputs" / "square_008um" / "spatial"
                   / "tissue_positions.parquet", row_group_size=64)
    return root, rows


def _one_bad_row(rows, index, bad, cast=float):
    """`rows`' column `index`, with the FIRST out-of-tissue row's value replaced."""
    unused_i = next(i for i, r in enumerate(rows) if not r[1])
    out = [cast(r[index]) for r in rows]
    out[unused_i] = bad
    return out


def test_TEST_47_a_COORDINATE_TOO_LARGE_TO_SQUARE_is_dropped_and_NAMED(tmp_path):
    """TEST-47 [acceptance, INV-8] — the mask bounded three of the five columns it filters.

    Two rounds hardened the LATTICE columns (finite, integral, int32) and left the two
    COORDINATE columns tested for finiteness alone — while the matrix-joined path refuses the
    identical value: `coordinate()` range-checks the same two columns against `float32`'s own
    range, citing `1e39` as its measured defect. A finite-but-enormous coordinate in a row the
    filtered matrix never carries therefore survived the mask, was NOT counted in
    `qc_dropped`, and was NOT named in the scope.

    It does not overflow on the way in. It overflows when `registration_qc` SQUARES it.
    MEASURED with `pxl_col_in_fullres = 1e300` in one `in_tissue=0` row: exit 0, scope still
    the unqualified `all-bins-in-positions-table` over all 160 rows, and
    `RuntimeWarning: overflow encountered in square` from `measure_spot_pitch` AND from
    `lattice_fit_pitch` — four non-`progress:` lines on a SUCCESSFUL run's stderr, which
    `scheduler.rs::drain_logs` turns into four job_logs rows a human reads. At `1.7e308` a
    third site joins. That is the exact outcome the mask exists to close, at a value class the
    mask did not cover.

    Same three legs as TEST-43, because it is the same defect one column family over.
    """
    import pyarrow as pa

    root, rows = _positions_with_column(
        tmp_path, "pxl_col_in_fullres",
        lambda rs: _one_bad_row(rs, 5, 1e300), pa.float64())
    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")

    assert result.returncode == 0, (
        f"a coordinate in a row the matrix never uses cost the whole import:\n"
        f"{result.stderr[-1500:]}")
    noise = [ln for ln in result.stderr.splitlines()
             if ln.strip() and not ln.startswith("progress:")]
    assert not noise, (
        "a successful run wrote non-progress lines to stderr, which become job_logs rows a "
        f"human reads: {noise!r}")

    block = _qc(tmp_path / "out")
    assert block["scope"] == "all-bins-in-positions-table-minus-1-unplaceable", (
        f"the unsquareable coordinate is not dropped-and-named: {block['scope']!r}")
    assert block["n_spots_checked"] == len(rows) - 1
    fit = block["scale"].get("lattice_fit")
    assert fit, ("the lattice-fit corroboration is gone from the report with no note: "
                 f"{sorted(block['scale'])}")
    # AND IT STILL CORROBORATES. Dropping the unplaceable row is what keeps the fit clean;
    # without this leg the assertion above is satisfied by a fit dragged to nonsense.
    assert fit["corroborates"] is True, (
        f"the bad row was dropped and the fit still does not corroborate: {fit!r}")


def test_TEST_47_a_NON_INTEGRAL_in_tissue_FLAG_is_dropped_and_NAMED(tmp_path):
    """TEST-47 — the third mask leg, which the round that added it did not exercise.

    Moving integrality out of `_qc_column` and into the row mask changed the behaviour of
    THREE column families — `in_tissue` through `_placeable_flag`, and the two lattice indices
    through `_placeable_index` — and only the lattice leg was tested. Deleting the `in_tissue`
    integrality term left the whole suite green.

    It is not cosmetic: `qc_in_tissue` is `qc_flag != 0`, so a `0.5` becomes `True` — a square
    the vendor did not call in-tissue is scored as if it had been, in the ONE check with a
    referent outside the artifact. Dropping the row is the same answer the other four columns
    get, and the scope says so.
    """
    import pyarrow as pa

    root, rows = _positions_with_column(
        tmp_path, "in_tissue",
        lambda rs: _one_bad_row(rs, 1, 0.5), pa.float64())
    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")

    assert result.returncode == 0, result.stderr[-1500:]
    block = _qc(tmp_path / "out")
    assert block["scope"] == "all-bins-in-positions-table-minus-1-unplaceable", (
        "a fractional `in_tissue` is not a flag; scoring it as True credits the check with a "
        f"square the vendor never called in-tissue: {block['scope']!r}")
    assert block["n_spots_checked"] == len(rows) - 1
    # THE CONTROL, without which "one row was dropped" is satisfied by dropping any row.
    assert block["n_in_tissue"] == sum(1 for r in rows if r[1]), (
        f"the dropped row was an IN-TISSUE one: {block['n_in_tissue']}")


#: `(id, column, index-in-the-fixture-row, the extreme, the arrow type)` — one row per BOUND
#: this module applies to the QC's wider read, at the value the bound itself admits.
#:
#: A bound with no control is a bound that can tighten for ever, and the first cut of this
#: control claimed three and exercised ONE. MEASURED: `_crd` narrowed from `float32`'s maximum
#: to `2000.0` — far below the bound, still above the fixture's own largest `pxl_col` of
#: 1290.0, so no ordinary bundle notices — and `_idx_lo` raised from int32's minimum to `0`,
#: each left the WHOLE package suite green. The new coordinate bound was pinned in one
#: direction only: too loose is caught by the `1e300` leg above, too tight by nothing.
LEGITIMATE_EXTREMES = (
    ("array_row-at-int32-max", "array_row", 2, "int32max", "int64"),
    ("array_col-at-int32-min", "array_col", 3, "int32min", "int64"),
    ("pxl_col-at-float32-max", "pxl_col_in_fullres", 5, "f32max", "float64"),
    ("pxl_row-at-negative-float32-max", "pxl_row_in_fullres", 4, "-f32max", "float64"),
)


@pytest.mark.parametrize("case", LEGITIMATE_EXTREMES, ids=[c[0] for c in LEGITIMATE_EXTREMES])
def test_TEST_47_the_CONTROL_every_bound_KEEPS_the_value_it_admits(case):
    """TEST-47 — the control that stops each bound becoming "drop anything unusual".

    Both ends of `int32` are legitimate lattice indices and both are exactly representable in
    `float64`; both ends of `float32`'s range are exactly the values the matrix-joined path
    ACCEPTS for a coordinate. Every one must be KEPT and the scope must stay unqualified —
    otherwise a bound can be tightened until the wide sample is no wider than the narrow one,
    which is the failure the whole `all-bins-in-positions-table` scope exists to prevent.

    One row per bound, because a control that exercises one of three bounds is a control for
    one of them.
    """
    import numpy as np
    import pyarrow as pa

    _case_id, column, index, extreme, arrow = case
    value = {
        "int32max": int(np.iinfo(np.int32).max),
        "int32min": int(np.iinfo(np.int32).min),
        "f32max": float(np.finfo(np.float32).max),
        "-f32max": -float(np.finfo(np.float32).max),
    }[extreme]
    cast = int if arrow == "int64" else float
    dtype = pa.int64() if arrow == "int64" else pa.float64()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        root, rows = _positions_with_column(
            tmp_path, column,
            lambda rs: _one_bad_row(rs, index, value, cast=cast), dtype)
        inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
        result = HF.run_entry(inputs, tmp_path / "out")

        assert result.returncode == 0, (
            f"a legitimate {extreme} in `{column}` cost the import:\n{result.stderr[-1500:]}")
        block = _qc(tmp_path / "out")
        assert block["scope"] == "all-bins-in-positions-table", (
            f"`{column}` at {extreme} — a value the bound itself admits, and the value the "
            f"matrix-joined path accepts — was dropped as unplaceable: {block['scope']!r}")
        assert block["n_spots_checked"] == len(rows)
        # KEEPING THE ROW IS NOT THE WHOLE ASSERTION, and asserting only the scope is what
        # made this control's first version pin a mangled report as acceptable. A
        # least-squares fit is not robust: every one of these extremes drags `lattice_fit`
        # (`pitch_px` up to 7.5e35 against a measured 80.0) while `measured_pitch_px` and the
        # scale verdict stay exactly as they were. Two estimators disagreeing by 34 orders of
        # magnitude, published side by side as corroboration. The fit must SAY it corroborates
        # nothing, and say why.
        fit = block["scale"].get("lattice_fit")
        assert fit is not None, (
            f"the lattice fit vanished from the report with no note: {sorted(block['scale'])}")
        assert fit["corroborates"] is False, (
            f"`{column}` at {extreme} drags the least-squares fit to "
            f"pitch_px={fit['pitch_px']:.3g} against a measured "
            f"{block['scale']['measured_pitch_px']:.3g}, and the report still calls it "
            "corroboration")
        # THE SENTENCE IS ASSERTED BY CONTENT, not by truthiness. A bare `assert fit[...]` is
        # satisfied by `"x"`: MEASURED, replacing the whole message with a single character
        # left this test green. It must name the two numbers a reader weighs — the residual it
        # measured and the pitch it fitted — and say what they mean.
        because = fit["not_corroborating_because"]
        assert "residual" in because and "lattice it assumed" in because, (
            f"the fit does not say WHY it corroborates nothing: {because!r}")
        assert f"{fit['residual_rms_px']:.3g}" in because, (
            f"the reason does not quote the residual it measured ({fit['residual_rms_px']:.3g}): "
            f"{because!r}")
        assert f"{fit['pitch_px']:.3g}" in because, (
            f"the reason does not quote the pitch it fitted: {because!r}")
        # AND THE TOLERANCE IS PUBLISHED. It is the number the comment offers as the reader's
        # means of weighing the residual, and it could be deleted from the report with the
        # suite green.
        assert fit["residual_tolerance_px"] == pytest.approx(
            RQ_MAX_RESIDUAL_FRACTION * fit["pitch_px"], rel=1e-9), (
            "the fit does not publish the tolerance its own verdict was taken against: "
            f"{fit!r}")
        assert fit["residual_rms_px"] > fit["residual_tolerance_px"], (
            f"the fit says it does not corroborate while its residual is inside its own "
            f"tolerance: {fit!r}")
        assert block["scale"]["measured_pitch_px"] == pytest.approx(
            MF.pitch_px(8), rel=1e-6), (
            "the nearest-neighbour measurement — the estimator the verdict actually rests on "
            f"— moved: {block['scale']['measured_pitch_px']!r}")


def test_TEST_48_the_ONE_CLASS_FALLBACK_is_unreachable_from_any_bundle(tmp_path):
    """TEST-48 — why the `matrix-joined-bins` branch is driven by no test, asserted.

    ## The gap this closes

    Re-aiming TEST-42 at FIX_ROUND-5 removed the suite's only assertion on
    `scope == "matrix-joined-bins"`, and a blind re-audit established what that cost: the
    fallback branch is now executed by ZERO tests, and the five-column `None`-gate above it
    can be reverted to its three-column form with the whole suite still green.

    ## Why the answer is not "add a test that drives it"

    `_qc_column` returns `None` for exactly one reason — a column that cannot be read as
    `float64` — and it reads the SAME five columns of the SAME table that `read_positions`
    and `column()` have already read before the first writer. So a bundle that reaches the
    fallback would have to carry a column those two accept and this one cannot, and no such
    column exists. The branch is a `None`-guard for a state no input can produce, which is
    the correct shape for the line below it (`qc_rows.astype(np.int64)` on `None` was a real
    exit-1-with-116-paths defect at FIX_ROUND-3) and is NOT dead code to delete: it is what
    keeps a future change to `_qc_column` from re-opening that crash.

    ## So the PRECONDITION is what gets pinned

    All five columns, each rewritten as TEXT in turn, must be REFUSED before the first
    writer — exit 2, nothing on disk, one named line. That is the measured claim behind "the
    fallback is unreachable", and if a future change lets any of the five through, this test
    goes red and the branch becomes reachable and untested in the same commit.

    The five bundles are the refusal table's own rows, so TEST-8 and TEST-9 sweep them for
    zero paths and message quality too; this test is about what their existence PROVES.
    """
    module = HF.load_compute()
    columns = ("in_tissue", "array_row", "array_col",
               "pxl_row_in_fullres", "pxl_col_in_fullres")
    # EQUALITY against the module's OWN declared set, not a subset. A subset test catches a
    # rename and lets an ADDITION through: a future sixth column would leave this test's five
    # stale and green while the new one went unrefused, and the fallback would become
    # reachable and untested in the same commit this test exists to prevent.
    assert set(columns) == set(module.POSITION_COLUMNS) - {"barcode"}, (
        f"the numeric positions columns are {sorted(set(module.POSITION_COLUMNS) - {'barcode'})} "
        f"and this test enumerates {sorted(columns)}; every one of them must refuse as TEXT "
        "or `_qc_column` can return None on a real bundle")

    for name in columns:
        root = HB._positions_column_as_text(tmp_path / f"text-{name}", name)
        inputs, _ordinals = HF.staged_flat(tmp_path / f"flat-{name}", root)
        out = tmp_path / f"out-{name}"
        result = HF.run_entry(inputs, out)
        assert result.returncode == 2, (
            f"a non-numeric `{name}` was not refused, so `_qc_column` can return None on a "
            f"real bundle and the one-class fallback becomes reachable and untested:\n"
            f"{result.stderr[-1200:]}")
        assert not list(out.rglob("*")), (
            f"the `{name}` refusal left paths on disk: {sorted(p.name for p in out.rglob('*'))[:5]}")
        assert "Traceback" not in result.stderr, result.stderr[-1200:]
        # AND IT NAMES THE COLUMN. All five used to fall to the blanket "the file's footer
        # parsed but its row groups did not" handler, whose diagnosis is both wrong (the row
        # groups parsed; one column is text) and unactionable -- five different bundles, one
        # identical sentence. A reader cannot re-export a column nobody named.
        assert f"column '{name}'" in result.stderr, (
            f"the refusal for a non-numeric `{name}` does not name the column:\n"
            f"{result.stderr[-600:]}")


def test_TEST_49_a_RANK_DEFICIENT_index_set_CORROBORATES_NOTHING():
    """TEST-49 — the one case the residual criterion cannot see, pinned at the function.

    ## Why this is a unit test and says so

    A rank-deficient index set needs a positions table whose bins all lie on ONE index line —
    every bin on a diagonal, so `array_row == array_col`. No Visium HD bundle produces that,
    the committed fixture cannot be bent into it without ceasing to be a bin lattice, and the
    two guards above (`len(unique(ar)) >= 2`, `len(unique(ac)) >= 2`) both pass on it. So it is
    UNREACHABLE through the shipped entrypoint, and a test that drove the entrypoint would be
    testing nothing. It is pinned here, at `lattice_fit_pitch` itself, and the unreachability
    is the reason rather than an excuse.

    ## What it pins

    `np.linalg.lstsq` returns the minimum-norm solution on a rank-deficient design instead of
    failing, and an UNDER-DETERMINED fit reproduces its own points EXACTLY — so the residual is
    numerical noise and the criterion this loop added would stamp `corroborates: true` on a
    pitch wrong by a factor of `hypot(1, k)`. The residual cannot detect this; only the rank
    can, and `lstsq` already returns it.

    MEASURED before the rank check: 30 bins on a real 80 px lattice with `array_row ==
    array_col` gave `pitch_px 56.57`, `residual_rms_px 2.4e-12`, `corroborates True`, against a
    nearest-neighbour `measured_pitch_px` of 113.14 — a ratio of exactly 2, affirmatively
    certified as corroboration.

    Three legs: the degenerate set returns NOTHING; a `2 * array_col` dependency (the general
    `hypot(1, k)` form) returns nothing either, so the check is not tuned to the diagonal; and
    the CONTROL — a real two-dimensional grid of the same size — still fits and still
    corroborates, so "return None" has not become the answer to everything.
    """
    import numpy as np

    RQ = HF.load_compute().registration_qc

    diagonal = np.arange(30)
    pts = np.column_stack([1000.0 + 80.0 * diagonal, 2000.0 + 80.0 * diagonal])
    assert RQ.lattice_fit_pitch(pts, diagonal, diagonal) is None, (
        "an affinely DEPENDENT index set fits exactly and would be certified as "
        "corroboration; the residual cannot see it and the rank can")

    doubled_col = np.arange(30)
    doubled_row = 2 * doubled_col
    pts2 = np.column_stack([1000.0 + 80.0 * doubled_col, 2000.0 + 40.0 * doubled_row])
    assert RQ.lattice_fit_pitch(pts2, doubled_row, doubled_col) is None, (
        "the check is tuned to the diagonal rather than to the rank")

    cols = np.tile(np.arange(6), 5)
    rows = np.repeat(np.arange(5), 6)
    grid = np.column_stack([1000.0 + 80.0 * cols, 2000.0 + 80.0 * rows])
    control = RQ.lattice_fit_pitch(grid, rows, cols)
    assert control is not None and control["corroborates"] is True, (
        f"a real two-dimensional grid no longer fits, so `None` has become the answer to "
        f"everything: {control!r}")
    assert control["pitch_px"] == pytest.approx(80.0, rel=1e-9)
