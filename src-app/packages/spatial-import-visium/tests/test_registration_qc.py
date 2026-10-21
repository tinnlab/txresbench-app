#!/usr/bin/env python3
# ruff: noqa
"""The registration QC — the only check in this arm with a referent OUTSIDE the artifact (#156).

## What this suite is for

Two shipped tests in this package assert that a WRONG artifact PASSES:

* `test_sandbox_reachability.py::test_a_wrong_affine_passes_every_check_this_system_has`
  (#155's TEST-9) — the wrong and correct artifacts *"differ in EXACTLY ONE key, and it is
  the one no gate reads"*.
* `test_image_downsample.py::test_a_wrong_micron_scale_passes_every_check_this_system_has`
  (#176's TEST-11) — *"the test therefore asserts that the wrong artifact PASSES. A test that
  made it fail would be claiming a guarantee this system does not have. What closes this is
  #156's registration overlay, and nothing here."*

This is that closure. Both of those tests remain true about everything they measure — nothing
here weakens them — because the thing they measure is INTERNAL consistency, and a uniform
misscale satisfies internal consistency by definition. What changes is that there is now a
check which does not look inside the artifact at all.

## The discipline these tests are written under

**Every PASS recorded here is paired with an observation that distinguishes "it passed" from
"it never ran".** A QC that reports `pass` on both the correct and the broken artifact is
worse than no QC, because it certifies the defect. So:

* TEST-3 and TEST-14 assert the FAILING case first and the passing case second, over
  IDENTICAL pixels — only the declared affine moves between them.
* TEST-14 carries an explicit CONTROL mutation that must leave the verdict green. A battery
  in which everything fails is indistinguishable from a check that always fails.
* TEST-4 runs three real imports of the SAME committed vendor bundle differing only in
  `scalefactors_json.json`, and requires three different verdicts.
* Every numeric verdict asserts the MARGIN, not just the side of the threshold, so a check
  that is barely discriminating cannot look identical to one that is decisively so.

## The limitation, stated rather than hidden (DEC-6)

The registration half's POSITIVE control is synthetic. It no longer HAS to be for the reason
originally recorded here — that reason was that the committed fixture's image did not cover
its own spots, which #243 fixed: the image is now 10x's own 2000x2000 emission and all 160
spots land on it.

It is still synthetic because of a second reason, which #243 did not remove: real H&E gives
no control. `make_registered` paints tissue where the vendor says the spots are, so the
right answer is known by construction; on the real bundle the tissue mask and the `in_tissue`
flags are two independent measurements, and their agreement is a finding about the data
rather than a control. Replacing this control with a real-tissue one is #156's work and needs
its own calibration. #243 made it POSSIBLE; it did not do it, and nothing here pretends
otherwise.

TEST-6's negative case — spots that miss their image — is now built on purpose by
`VF.make_downscaled_hires`, which reconstructs the pre-#243 artifact exactly, instead of
being harvested from a defect in the shipped fixture. Depending on a fixture's bug for a
negative case is how a bug becomes load-bearing.

So `make_registered` paints a tissue blob over the in-tissue spots, which means the blob's
location descends from the same table the spots do. What that fixture proves — and all this
suite claims from it — is that the check DISCRIMINATES between a right and a wrong mapping
over identical pixels. It does NOT prove `J_FLOOR = 0.5` is calibrated for real H&E, and
nothing here says otherwise.
"""
import base64
import copy
import itertools
import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

RQ_NAME = "registration_qc"
HIRES = "spatial-image-hires"
LOWRES = "spatial-image-lowres"


def modules():
    """`(entry_module, registration_qc)` staged the way `/code` does."""
    module = VF.load_compute()
    return module, sys.modules[RQ_NAME]


def run(bundle, tmp_path_factory, name):
    """A REAL import over `bundle`, returning `(outputs_dir, entries, report)`."""
    module, _ = modules()
    out = Path(tmp_path_factory.mktemp(name))
    _, entries = VF.run_over(bundle, out)
    module.write_manifest(out, entries)
    report = json.loads((out / "visium-import-report.json").read_text())
    return out, entries, report


def full_positions():
    """The WHOLE positions table as `(coords, in_tissue)` — both classes, in `(x, y)`.

    Read from the vendor CSV here rather than from the importer, so a test that checks the
    importer used the whole table is not asking the importer what it used.
    """
    rows = VF.positions_table()
    coords = np.array(
        [[float(r["pxl_col_in_fullres"]), float(r["pxl_row_in_fullres"])] for r in rows],
        dtype=np.float64,
    )
    flag = np.array([str(r["in_tissue"]).strip() == "1" for r in rows])
    return coords, flag


@pytest.fixture(scope="module")
def registered(tmp_path_factory):
    """The POSITIVE CONTROL: a coherent bundle whose images carry tissue where the vendor says.

    Correct micron scale (stated by the vendor, `micron_scale` leg 1) AND a correctly
    registered image. Every `pass` in this suite is measured here, and every `fail` is
    measured against the SAME pixels with one declared number moved.
    """
    bundle = VF.make_registered(tmp_path_factory.mktemp("registered-src"))
    return run(bundle, tmp_path_factory, "registered-out")


@pytest.fixture(scope="module")
def shipped(tmp_path_factory):
    """The committed REAL vendor bundle, imported by unmodified importer code.

    Since #243 this bundle is COHERENT — 10x's own 2000x2000 `tissue_hires_image.png` with
    the vendor's own spots landing on it — so it is a real-data POSITIVE case here. It used
    to be this suite's "spots miss the image" negative case; that role moved to
    [`uncovered`], which constructs the incoherence on purpose.
    """
    return run(VF.FIXTURE, tmp_path_factory, "shipped-out")


@pytest.fixture(scope="module")
def uncovered(tmp_path_factory):
    """A bundle whose spots ALL fall outside its own image — built, not borrowed (#243).

    `make_downscaled_hires` reconstructs the pre-#243 committed artifact exactly: a BICUBIC
    10x downscale of the vendor image with `scalefactors_json.json` and `tissue_positions.csv`
    untouched, so the declared scalefactor still describes a 10000 px frame the 1000 px image
    cannot cover.

    It is a fixture rather than an inline construction because two tests need the same bundle
    and importing it is the expensive part.
    """
    bundle = VF.make_downscaled_hires(tmp_path_factory.mktemp("uncovered-src"))
    return run(bundle, tmp_path_factory, "uncovered-out")


def reemit_with_affine(entry, out, to_space, tmp_path_factory, name):
    """Re-write an emitted `spatial/image` with a DIFFERENT declared affine, on disk.

    ## Why the mutation has to happen here and not in a dict

    `check_registration` reads the affine back out of the artifact's OWN OME-XML and
    cross-checks it against the manifest entry's copy, failing on a divergence — because if
    the two ever disagree, the artifact a consumer reads is not the one the producer thinks
    it wrote.

    That guard has a sharp edge for tests: mutating `entry["meta"]["to_space"]` alone now
    produces a DIVERGENCE, and the check fails for that reason instead of because the spots
    landed off the tissue. Every affine test would still be green and every one of them would
    be measuring the wrong thing — the phantom-leg failure, arriving through a guard added to
    close a different phantom leg.

    So the mutation is written into the BYTES. Both copies of the declaration move together,
    there is no divergence, and what gets exercised is the real
    write -> read-back -> score path. This mirrors #155's own TEST-9, which builds its
    deliberately-wrong artifact exactly this way.

    The placement is rebuilt WITHOUT a display-derivative block and written with no
    `image_microns_per_pixel`, because `write_ome_tiff` reconciles the affine against the
    recorded resolution and would (correctly) refuse an affine that no longer matches one.
    The derivative is not what any of these tests are about.
    """
    import tifffile

    module = VF.load_compute()
    SD, OW = module.SD, sys.modules["ome_writer"]
    src = Path(out) / entry["path"]
    with tifffile.TiffFile(src) as handle:
        pixels = handle.series[0].levels[0].asarray()

    dest_dir = Path(tmp_path_factory.mktemp(name))
    meta = dict(entry["meta"])
    space = SD.coordinate_space(
        space=meta["coordinate_space"], unit=meta["unit"], to_space=list(to_space),
        extent=dict(meta["extent"]), microns_per_pixel=meta.get("microns_per_pixel"),
    )
    placement = SD.image_meta(space=space, role=meta.get("role"),
                              source=meta.get("source"))
    rel = Path(entry["path"]).name
    OW.write_ome_tiff(dest_dir / rel, pixels, placement=placement)
    mutant = copy.deepcopy(entry)
    mutant["path"] = rel
    mutant["meta"] = placement
    return mutant, dest_dir


def overlay_uris(html):
    """Every `data:image/png;base64,...` in the report HTML, in document order."""
    out, cursor = [], 0
    token = "data:image/png;base64,"
    while True:
        start = html.find(token, cursor)
        if start < 0:
            return out
        stop = html.find("'", start)
        out.append(html[start:stop])
        cursor = stop


def decode_png(uri):
    from PIL import Image

    raw = base64.b64decode(uri.split(",", 1)[1])
    return Image.open(io.BytesIO(raw)), raw


# ── TEST-1 [acceptance] [invariant: INV-2] — the overlay EXISTS ──────────────────────


def test_the_report_carries_a_rendered_overlay(registered):
    """TEST-1 [acceptance] [invariant: INV-2] [covers: ITEM-4, ITEM-5].

    INV-2, verbatim: *"An absent overlay and a correct overlay must not be the same green
    test. Existence is asserted explicitly."*

    So this test asserts EXISTENCE and nothing about correctness — correctness is TEST-3's
    job, in its own test, precisely so that a report with no overlay in it cannot pass by
    riding a green correctness assertion.

    Existence is asserted as far as it can be: the URI is present, it base64-decodes, PIL
    OPENS the result as a PNG, and its pixel dimensions are the DECLARED extent scaled by the
    bound `OVERLAY_MAX_EDGE` imposes. A zero-byte or truncated overlay fails every one of
    those.

    That last leg is stated carefully because the first version of this docstring got it
    wrong: it claimed the overlay's dimensions "match the extent the artifact declares", which
    is false — the declared extent is 1400x1800 and the overlay is 700x900, because
    `render_overlay` bounds the longest edge at 900 so a base64 plane cannot make the report
    unopenable. Asserting against the reported `overlay` block alone would have been
    production output compared with production output, so the expectation below is computed
    from the DECLARED extent and the module's own bound instead.
    """
    out, entries, report = registered
    html = (out / "visium-import-summary.html").read_text()
    uris = overlay_uris(html)
    qc = report["registration_qc"]
    rendered = [image for image in qc["images"] if "overlay" in image]
    assert rendered, "no image in the QC block carries a rendered overlay"

    # One overlay per checked image, PLUS the vendor's own two diagnostics, which are JPEGs
    # and therefore not counted by `overlay_uris`. Counted, because an append that silently
    # drops one is the shape that merges cleanly and breaks nothing visibly.
    assert len(uris) == len(rendered), (
        f"{len(rendered)} images were rendered but {len(uris)} PNG overlays reached the HTML"
    )
    _, RQ = modules()
    for uri, image in zip(uris, rendered):
        png, raw = decode_png(uri)
        assert len(raw) > 0
        assert png.format == "PNG"
        # INDEPENDENT expectation: the emitted artifact's DECLARED extent, reduced by the
        # module's own longest-edge bound. Nothing here reads the size back out of the
        # renderer's own report.
        extent = image["extent"]
        expected_scale = min(1.0, RQ.OVERLAY_MAX_EDGE / max(extent["width"], extent["height"]))
        assert png.size == (
            max(1, round(extent["width"] * expected_scale)),
            max(1, round(extent["height"] * expected_scale)),
        ), (
            f"the overlay is {png.size} for a declared extent of "
            f"{(extent['width'], extent['height'])} at a bound of {RQ.OVERLAY_MAX_EDGE}"
        )
        # …and the block's own report agrees with the bytes, so a reader of the JSON is not
        # being told about a different image from the one in the HTML.
        assert png.size == (image["overlay"]["width"], image["overlay"]["height"])
        assert min(png.size) > 1, "a 1-pixel overlay is an absent overlay in a green disguise"


# ── TEST-2 [acceptance] [invariant: INV-1] — it reads the DECLARATION ────────────────


def test_the_overlay_and_the_metric_read_the_declared_affine(registered, tmp_path_factory):
    """TEST-2 [acceptance] [invariant: INV-1] [covers: ITEM-3, ITEM-4].

    INV-1, verbatim: *"The overlay is generated from the DECLARED `to_space`, not from the
    raw scalefactor — otherwise it validates a different code path than the one that ships,
    which is the one failure mode that would make the whole control worthless."*

    The proof has to be a DIFFERENCE, not a match. Both runs below get identical pixels on
    disk and an identical `scalefactors_json.json` — the vendor's `tissue_hires_scalef` is
    0.2 in both — and differ ONLY in the `to_space` handed to the check. An implementation
    that recomputed the affine from the scalefactor would produce byte-identical output and
    fail here; one that reads the declaration cannot.

    Both the METRIC and the RENDERED BYTES are required to move. A renderer that read the
    declaration while the metric did not (or the reverse) would leave half the control
    validating the wrong code path.
    """
    out, entries, report = registered
    _, RQ = modules()
    tmp_factory = tmp_path_factory
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)
    declared = list(entry["meta"]["to_space"])
    assert VF.scalefactors()["tissue_hires_scalef"] == 0.2
    assert declared[0] == pytest.approx(1.0 / 0.2), (
        "the fixture's declared affine is not the inverse scalefactor, so this test is not "
        "isolating the declaration from the vendor number"
    )

    def probe(to_space, name):
        # Mutated IN THE BYTES, so both copies of the declaration move together and what is
        # exercised is the scoring path rather than the divergence guard.
        mutant, where = reemit_with_affine(entry, out, to_space, tmp_factory, name)
        return RQ.check_registration(
            mutant, where, coords, flag,
            microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, spot_diameter_um=55.0,
        )

    base_block, base_uri = probe(declared, "inv1-base")
    moved = [declared[0] * 2, 0.0, 0.0, 0.0, declared[4] * 2, 0.0]
    moved_block, moved_uri = probe(moved, "inv1-moved")
    assert "declaration_mismatch" not in base_block
    assert "declaration_mismatch" not in moved_block, (
        "the mutant failed as a declaration DIVERGENCE, not as a bad registration — this "
        "test is measuring the cross-check instead of the thing it claims to measure"
    )

    assert base_block["verdict"] == "pass"
    assert moved_block["verdict"] == "fail", (
        "doubling the DECLARED affine did not change the verdict, so the metric is not "
        "reading the declaration"
    )
    assert base_block["youden_j"] != moved_block["youden_j"]
    assert base_uri != moved_uri, (
        "the rendered overlay is byte-identical under a doubled DECLARED affine, so it is "
        "being drawn from the vendor scalefactor and validates a code path that does not ship"
    )
    # …and the echo in the block is the declaration itself, so a reader of the report can see
    # WHICH affine was exercised rather than taking the claim on trust.
    assert base_block["to_space"] == declared
    assert moved_block["to_space"] == moved


# ── TEST-3 [acceptance] [invariant: INV-3] — a transposed affine fails a pinned floor ─


def test_a_transposed_affine_falls_below_the_pinned_floor(registered, tmp_path_factory):
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-3, ITEM-7].

    INV-3, verbatim: *"Something about correctness is mechanically checkable, not only
    eyeballed — a deliberately transposed affine must fail a pinned numeric assertion."*

    The transpose is not an arbitrary mutation. §7.3 rule 5 calls the axis order *"the single
    most likely bug in the whole importer"*, and the epic's own build order says a square
    fixture passes it silently — which is why `make_registered` inherits `make_imaged`'s
    NON-SQUARE 7000 x 9000 frame.

    The FAILING case is asserted first and the passing case second, deliberately: a floor
    that only ever sees a passing value is a floor nobody has proven is reachable.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)
    declared = list(entry["meta"]["to_space"])

    def score(to_space, name):
        mutant, where = reemit_with_affine(entry, out, to_space, tmp_path_factory, name)
        block, _ = RQ.check_registration(
            mutant, where, coords, flag,
            microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, spot_diameter_um=55.0,
        )
        assert "declaration_mismatch" not in block, (
            "scored the divergence guard rather than the registration"
        )
        return block

    transposed = score([0.0, declared[0], 0.0, declared[4], 0.0, 0.0], "inv3-transposed")
    correct = score(declared, "inv3-correct")

    assert transposed["verdict"] == "fail", transposed["reason"]
    assert transposed["youden_j"] < RQ.J_FLOOR, (
        f"a transposed affine scored J={transposed['youden_j']} at or above the "
        f"{RQ.J_FLOOR} floor — the floor cannot distinguish a transpose"
    )
    assert correct["verdict"] == "pass", correct["reason"]
    assert correct["youden_j"] >= RQ.J_FLOOR, correct["reason"]
    # THE MARGIN, not just the side. A check that separates the two cases by 0.001 would pass
    # every assertion above and would be worthless.
    margin = correct["youden_j"] - transposed["youden_j"]
    assert margin > 0.5, (
        f"correct J={correct['youden_j']:.4f} vs transposed J={transposed['youden_j']:.4f} "
        f"— a margin of {margin:.4f} is too small to be a discrimination"
    )
    # The transpose is only detectable because the frame is non-square. Asserted, so that a
    # future square fixture disarms this test loudly instead of silently.
    assert entry["meta"]["extent"]["width"] != entry["meta"]["extent"]["height"], (
        "the fixture's image is SQUARE, so a transposed affine is indistinguishable from a "
        "correct one and this test proves nothing"
    )


# ── TEST-4 [acceptance] [invariant: INV-4] — the EXTERNAL referent discriminates ─────


def test_the_external_referent_discriminates_on_real_vendor_data(tmp_path_factory):
    """TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-2].

    INV-4, verbatim: *"the deliverable is a check with an external referent. Do not add
    another internal-consistency assertion; there are already enough and they are all blind
    to this."*

    THREE REAL IMPORTS of the SAME committed `Visium_Mouse_Olfactory_Bulb` bundle — the same
    matrix, the same `tissue_positions.csv`, the same images — differing only in
    `scalefactors_json.json`. Three different verdicts.

    That is what makes this a check rather than a constant. Every other guard in this package
    would return the same answer for all three, because all three are internally consistent:
    #176's TEST-11 says so in as many words, and mutation (b) below IS TEST-11's own mutation,
    `spot_diameter_fullres * 3`.

    The referent is the Visium slide's manufactured 100 um centre-to-centre spot pitch
    (`docs/research/data-processing/02-platforms.md:357`). It is applied to the spot lattice
    measured off `tissue_positions.csv`, a file that never touches `scalefactors_json.json` —
    so nothing on either side of the comparison is a function of the number under test.
    """
    _, RQ = modules()
    factors = VF.scalefactors()

    def verdict(label, scalefactors_text):
        bundle = VF.make_variant(
            tmp_path_factory.mktemp(f"ref-{label}"), scalefactors_text=scalefactors_text
        )
        out, entries, report = run(bundle, tmp_path_factory, f"ref-out-{label}")
        return report["registration_qc"]["scale"]

    # (a) THE POSITIVE CONTROL — a vendor-STATED scale that puts the spots at the slide's own
    #     pitch. `micron_scale` leg 1, a code path that already shipped.
    good = verdict("good", VF.registered_scalefactors_text())
    # (b) TEST-11's own mutation, in the vendor number the whole scale chain hangs from.
    worse = dict(factors); worse["spot_diameter_fullres"] = factors["spot_diameter_fullres"] * 3
    triple = verdict("triple", json.dumps(worse))
    # (c) …and the other direction, so a check that only fires on "too big" is caught.
    smaller = dict(factors); smaller["spot_diameter_fullres"] = factors["spot_diameter_fullres"] / 3
    third = verdict("third", json.dumps(smaller))

    assert good["verdict"] == "pass", good["reason"]
    assert good["relative_error"] < 0.001, (
        f"the positive control is only accurate to {good['relative_error']:.4%}, which is not "
        "a control — it is inside the tolerance by luck rather than by being right"
    )
    # The arithmetic, stated so the numbers are a derivation and not observations copied out
    # of a run: `microns_per_pixel = VISIUM_RENDERED_SPOT_DIAMETER_UM / spot_diameter_fullres`
    # (65 um since #222; it was 55, and the two mutation errors below moved with it because
    # they are ratios against the SAME unmutated base). The unmutated bundle now measures
    # 99.777 um, so TRIPLING the diameter DIVIDES the scale by three — the measured pitch
    # falls to 99.777/3 = 33.259 um, an error of 1 - 1/3 x 0.99777 = 0.667 — and dividing it
    # by three MULTIPLIES the scale, giving 99.777 x 3 = 299.330 um, an error of 1.993. Both
    # are an order of magnitude outside the 5% tolerance, and they are asymmetric because a
    # ratio is.
    assert triple["verdict"] == "fail", triple["reason"]
    assert triple["relative_error"] == pytest.approx(0.667, abs=0.01), triple["relative_error"]
    assert third["verdict"] == "fail", third["reason"]
    assert third["relative_error"] == pytest.approx(1.993, abs=0.02), third["relative_error"]
    assert triple["relative_error"] > 10 * good["tolerance"]
    assert third["relative_error"] > 10 * good["tolerance"]

    # THE REFERENT IS NOT A FUNCTION OF THE ARTIFACT: all three imports measured the SAME spot
    # spacing in pixels, because the positions table never changed. Only the micron scale
    # applied to it moved. If this ever stops being true, the "external" claim is gone.
    assert (good["measured_pitch_px"] == triple["measured_pitch_px"]
            == third["measured_pitch_px"]), (
        "the measured pixel pitch moved between variants that share a positions table, so it "
        "is not independent of `scalefactors_json.json` and the referent is not external"
    )
    assert good["referent_um"] == RQ.SLIDE_SPOT_PITCH_UM == 100.0


# ── TEST-5 — the measurement on the bundle exactly as committed ──────────────────────


def test_the_shipped_bundles_declared_scale_measured_against_the_slide(shipped):
    """TEST-5 [covers: ITEM-2] — the number, on unmodified code over the committed bundle.

    This asserts the MEASUREMENT and that the verdict follows from it. It was written while
    DEC-9 was still open, and deliberately held no opinion about whether the shipped constant
    was right, so that it would stay true and meaningful whichever way that was ruled.

    DEC-9 HAS SINCE BEEN RULED (#222): the scale numerator is the 65 um rendered circle, not
    the 55 um capture footprint. The measurement half below is untouched by that — it never
    depended on the constant — and the two lines that recorded the OPEN defect now record the
    CLOSED one, per the instruction those lines themselves carried. So the docstring's
    original claim now holds in a narrower, honest form: this test does not decide the
    constant; it reports the measurement, and the measurement is what decided it.

    What is pinned: the spot spacing measured off the vendor's own positions table, which is
    a property of 10x's data and of nothing this branch wrote; and that the reported verdict
    is the one the reported error implies.
    """
    out, entries, report = shipped
    scale = report["registration_qc"]["scale"]

    assert scale["measured_pitch_px"] == pytest.approx(113.0, abs=0.5), (
        "the committed Visium_Mouse_Olfactory_Bulb subset's spot spacing is not what it was "
        "measured to be; the fixture changed under this test"
    )
    # The two estimators agree — one index-free, one fitted against the array indices. They
    # are computed from disjoint information about the same lattice, so agreement is evidence
    # rather than a restatement.
    assert scale["lattice_fit"]["pitch_px"] == pytest.approx(scale["measured_pitch_px"], rel=0.01)
    assert scale["lattice_fit"]["residual_rms_px"] < 1.0

    # THE VERDICT FOLLOWS THE NUMBER. Whatever the error is, the verdict must be the one the
    # tolerance implies — a verdict that did not follow its own measurement would be the
    # defect this whole item exists to remove.
    implied = "pass" if scale["relative_error"] <= scale["tolerance"] else "fail"
    assert scale["verdict"] == implied, (
        f"relative error {scale['relative_error']} against tolerance {scale['tolerance']} "
        f"implies {implied}, but the check said {scale['verdict']}"
    )
    # DEC-9 WAS ACTED ON (#222), so these two lines have been re-read exactly as the message
    # below them used to instruct. THE MEASUREMENT ASSERTIONS ABOVE ARE UNCHANGED — the pixel
    # pitch, the two-estimator agreement, the verdict-follows-the-number logic and the implied
    # scale never depended on which constant the importer divides, which is why this test was
    # written to stay true either way.
    #
    # What moved is the pair of lines that pinned the DEFECT. Before #222 the shipped
    # derivation measured 15.573% against the slide's 100 um pitch and the verdict was `fail`;
    # the numerator was 55 um (the capture footprint) divided into a measurement of the 65 um
    # RENDERED circle. It now measures ~0.223% and the verdict is `pass`. The bound is
    # INVERTED rather than deleted, and it is ~30x TIGHTER than the one it replaces, so this
    # is a stronger assertion than the escalation it retires — not a relaxed one.
    assert scale["microns_per_pixel_source"] == "derived-from-spot-diameter"
    assert scale["relative_error"] < 0.005, (
        f"the shipped derivation measures {scale['relative_error']:.4%} against the slide's "
        "pitch. Before #222 this was 15.573% (a 55 um numerator over the 65 um rendered "
        "circle); after it, ~0.223%. A number back above 15% means the constants were "
        "re-merged; anything else means the fixture or the estimator moved"
    )
    assert scale["verdict"] == "pass"
    # And the check hands the reader the scale its own referent implies, rather than leaving
    # them to divide. It is stated in the report and written into NO artifact.
    assert scale["implied_microns_per_pixel"] == pytest.approx(
        100.0 / scale["measured_pitch_px"]
    )


# ── TEST-6 — spots off the image are reported as that, not scored ───────────────────


def test_spots_that_miss_the_image_are_reported_rather_than_scored(
    uncovered, shipped, registered
):
    """TEST-6 [covers: ITEM-3, ITEM-7] — the loudest registration failure there is.

    Scoring Youden's J over the zero spots that survive would be a measurement over an empty
    sample; the check must say what actually happened instead.

    ## Where the negative case comes from (changed by #243)

    It used to come from the SHIPPED fixture, whose image did not cover its own spots. #243
    fixed the fixture, so the negative case is now CONSTRUCTED — `make_downscaled_hires`
    reproduces the pre-#243 artifact byte-exactly (a BICUBIC 10x downscale that leaves
    `scalefactors_json.json` untouched). Same numbers, same code path, but the incoherence is
    now deliberate and named instead of being a defect this suite quietly relied on.

    ## TWO controls, and that is the point

    The shipped bundle is now a SECOND positive control alongside `make_registered`, and a
    stronger one: its image is real vendor H&E and its spots are the vendor's own. So this
    test asserts, on one run, that the check reports 0 inside on an image that misses its
    spots and 160 inside on the real vendor bundle — which "a check that always reports 0"
    cannot do.
    """
    _out, _entries, uncovered_report = uncovered
    shipped_out, shipped_entries, shipped_report = shipped
    reg_out, reg_entries, reg_report = registered
    _, RQ = modules()

    hires = next(image for image in uncovered_report["registration_qc"]["images"]
                 if image["image_id"] == HIRES)
    assert hires["n_spots"] == 160, (
        "the QC did not score the whole positions table; on the matrix-joined subset every "
        "spot is in-tissue and Youden's J is undefined by construction"
    )
    assert hires["spots_inside_image"] == 0
    assert hires["verdict"] == "fail"
    assert "land inside this image" in hires["reason"]

    control = next(image for image in reg_report["registration_qc"]["images"]
                   if image["image_id"] == HIRES)
    assert control["spots_inside_image"] == 160, (
        "the positive control's spots do not land on its own image either, so this test "
        "cannot tell a coverage failure from a check that always fails"
    )
    assert control["verdict"] == "pass"

    # The REAL vendor bundle, which since #243 is coherent. This is the assertion that would
    # have been impossible to write before #243 and is the whole point of the issue.
    real = next(image for image in shipped_report["registration_qc"]["images"]
                if image["image_id"] == HIRES)
    assert real["n_spots"] == 160
    assert real["spots_inside_image"] == 160, (
        "the committed vendor bundle's spots do not land on its own vendor image; #243 is "
        f"re-opened ({real})"
    )
    assert RQ.MIN_SPOTS_INSIDE_FRACTION == 0.5


# ── TEST-7 / TEST-8 — `not-evaluated` is a third value, never a pass ────────────────


def test_a_bundle_with_no_micron_scale_is_not_evaluated_not_passed(tmp_path_factory):
    """TEST-7 [covers: ITEM-2] — absence is absence, in the verdict as well as in the data.

    `micron_scale` leg 3 declares NO scale rather than inventing 1.0. The check must inherit
    that posture exactly: with no scale there is no number to test against the slide, and
    reporting `pass` would turn "nobody could check" into "checked and fine" — the precise
    laundering this item exists to prevent.

    The pixel spacing is still MEASURED and reported, because it is measurable, so a reader
    who obtains a scale elsewhere can apply the referent by hand.
    """
    _, RQ = modules()
    bundle = VF.make_variant(tmp_path_factory.mktemp("noscale-src"), drop_scalefactors=True)
    out, entries, report = run(bundle, tmp_path_factory, "noscale-out")
    scale = report["registration_qc"]["scale"]

    assert scale["verdict"] == RQ.VERDICT_NOT_EVALUATED
    assert scale["verdict"] not in (RQ.VERDICT_PASS, RQ.VERDICT_FAIL)
    assert scale["microns_per_pixel"] is None
    assert "relative_error" not in scale, (
        "an error was reported against a scale that does not exist"
    )
    assert scale["measured_pitch_px"] == pytest.approx(113.0, abs=0.5), (
        "the spacing is measurable without a scale and must still be reported"
    )
    assert report["registration_qc"]["verdict"] != RQ.VERDICT_PASS
    # The import still SUCCEEDED and still emitted its data — this package's INV-6 posture.
    assert any(e["id"] == "expression" for e in entries)
    assert any(e["id"] == "spatial-coordinates" for e in entries)


def test_a_bundle_with_no_emitted_image_is_not_evaluated_not_passed(tmp_path_factory):
    """TEST-8 [covers: ITEM-3] — nothing to overlay on is not a clean overlay.

    A bundle whose images carry no usable scalefactor emits no `spatial/image` (#155's
    INV-9/DEC-8: an unplaceable image is DROPPED, because an identity affine would be a WRONG
    declaration rather than a missing one). With no image there is no registration to check,
    and that must be `not-evaluated` — an unchecked registration is not a correct one.
    """
    _, RQ = modules()
    factors = dict(VF.scalefactors())
    factors.pop("tissue_hires_scalef", None)
    factors.pop("tissue_lowres_scalef", None)
    bundle = VF.make_imaged(tmp_path_factory.mktemp("noimg-src"),
                            scalefactors_text=json.dumps(factors))
    out, entries, report = run(bundle, tmp_path_factory, "noimg-out")
    qc = report["registration_qc"]

    assert not [e for e in entries if e["datatype"] == "spatial/image"], (
        "an image was emitted, so this bundle does not exercise the no-image branch"
    )
    assert qc["images"] == []
    assert qc["registration_verdict"] == RQ.VERDICT_NOT_EVALUATED
    assert qc["verdict"] != RQ.VERDICT_PASS
    assert "nothing to place the spots on" in qc["registration_reason"]
    assert report["images_not_emitted"], "the existing channel stopped saying why"


# ── TEST-9 — the QC is in both artifacts, and above the fold ────────────────────────


def test_the_qc_reaches_the_json_and_the_top_of_the_html(registered):
    """TEST-9 [covers: ITEM-5] — an overlay nobody opens is not a check (DEC-2).

    The verdict has to be the first thing in the report body, not a section under a table of
    provenance strings. Asserted by BYTE OFFSET in the document, because "the string is
    present somewhere" is exactly the assertion that would let it drift to the bottom.
    """
    out, entries, report = registered
    qc = report["registration_qc"]

    # The machine-readable half: verdicts AND the numbers behind them, so a consumer or a
    # later gate can refuse on this without re-deriving it.
    assert qc["kind"] == "visium-registration-qc"
    # The verdict on THIS fixture is known, so it is pinned. `verdict in (the three constants)`
    # was the original assertion here and it cannot fail — the production code only ever
    # assigns one of those three, so it restates the type rather than observing anything.
    assert qc["verdict"] == "pass"
    assert qc["scale"]["referent_um"] == 100.0
    assert "referent_source" in qc["scale"]
    assert qc["scale"]["measured_pitch_um"] is not None
    assert qc["scope"] == "all-spots-in-positions-table"
    assert qc["n_spots_checked"] == 160

    html = (out / "visium-import-summary.html").read_text()
    banner = html.index("Registration QC")
    facts = html.index("Run summary")
    assert banner < facts, (
        f"the registration verdict is at byte {banner} and the facts table at {facts} — the "
        "QC is below the fold, where DEC-2 says nobody reads it"
    )
    # The verdict HEADLINE is in the banner, not only in the embedded JSON — a reader who does
    # not open a script tag must still see it. Asserted against the module's own headline
    # string for THIS verdict rather than as a substring OR-chain: the original assertion
    # accepted 'pass' matching inside 'passed', 'passes' or 'bypass' anywhere in the head, so
    # a banner rendering a stale or wrong verdict would have satisfied it.
    module, _ = modules()
    head = html[:facts]
    _, _, headline = module._VERDICT_STYLE[qc["verdict"]]
    assert headline in head, f"the banner does not carry the {qc['verdict']!r} headline"
    for other, (_, _, wording) in module._VERDICT_STYLE.items():
        if other != qc["verdict"]:
            assert wording not in head, (
                f"the banner also carries the {other!r} headline; a reader cannot tell which "
                "verdict this import got"
            )
    assert "outside" in head, "the banner does not say the referent is external"


def test_the_failing_banner_renders_its_own_wording(uncovered):
    """TEST-26 [covers: ITEM-5] — the FAIL branch of the banner, which TEST-9 cannot reach.

    TEST-9 runs on the passing fixture, so the red banner's wording, colour and placement were
    never rendered by anything. A verdict channel whose failing state is unexercised is a
    channel that can be broken in exactly the case it exists for.

    The failing bundle used to be the SHIPPED one, which failed because its image did not
    cover its own spots. #243 fixed that fixture — it now PASSES on real vendor H&E — so the
    fail branch is reached via `uncovered`, which reconstructs the pre-#243 artifact on
    purpose. Same verdict, same code path, from a bundle that is broken deliberately rather
    than by accident.
    """
    out, entries, report = uncovered
    module, _ = modules()
    qc = report["registration_qc"]
    assert qc["verdict"] == "fail"
    html = (out / "visium-import-summary.html").read_text()
    colour, _, headline = module._VERDICT_STYLE["fail"]
    head = html[: html.index("Run summary")]
    assert headline in head and colour in head
    assert module._VERDICT_STYLE["pass"][2] not in head
    # The measured numbers reach the banner too, not only the verdict word — DEC-5's point is
    # that a bare red/green would make a reader trust a threshold this repo can only calibrate
    # against a synthetic control.
    assert f"{qc['scale']['measured_pitch_um']:.3f}" in head


# ── TEST-10 — the vendor's own diagnostics, beside ours, still not artifacts ────────


def test_the_vendor_diagnostics_sit_beside_ours_and_are_not_artifacts(registered):
    """TEST-10 [covers: ITEM-6] — the epic's ITEM-3, and #154's INV-4 still true afterwards.

    The reader compares our registration against Space Ranger's own without leaving the
    report. `aligned_fiducials.jpg` and `detected_tissue_image.jpg` stay EMBEDDED diagnostics
    and never become artifacts — design §7.2: *"embed them in the report HTML instead of
    emitting artifacts; they are diagnostics, not data"*.
    """
    out, entries, report = registered
    html = (out / "visium-import-summary.html").read_text()

    for name in ("aligned_fiducials.jpg", "detected_tissue_image.jpg"):
        assert name in html, f"{name} is no longer embedded in the report"
    # BESIDE ours: the vendor section sits between our banner and the facts table.
    assert html.index("Registration QC") < html.index("Space Ranger's own") < html.index("Run summary")

    paths = {e["path"] for e in entries}
    for name in ("aligned_fiducials.jpg", "detected_tissue_image.jpg"):
        assert not any(name in p for p in paths), (
            f"{name} became an artifact; #154's INV-4 says it is a diagnostic, not data"
        )
    # And the overlay itself added NO artifact, so the MAX_OUTPUTS headroom bound is untouched.
    assert not any("overlay" in p for p in paths)


# ── TEST-11 — the drawn spot is the DECLARED spot ──────────────────────────────────


def test_the_overlay_draws_the_spot_at_its_declared_physical_size(registered):
    """TEST-11 [covers: ITEM-4] — what makes a misscale visible to a human, not only computed.

    The radius must be DERIVED from the declared micron scale through the declared affine,
    never a constant. If it were a constant, the overlay would look identical whether the
    scale was right or wrong, and the visual half of this control would be decorative.

    Asserted as a RATIO: halving the declared scale must double the drawn diameter, because
    at half the micrometres per pixel a 55 um spot spans twice as many pixels. Measured off
    the reported geometry AND off the rendered PNG's own marked-pixel count, so a number that
    was computed but never reached the canvas is caught.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)
    scale = VF.REGISTERED_MICRONS_PER_PIXEL

    def draw(microns_per_pixel):
        block, uri = RQ.check_registration(
            copy.deepcopy(entry), out, coords, flag,
            microns_per_pixel=microns_per_pixel, spot_diameter_um=55.0,
        )
        png, _ = decode_png(uri)
        marked = np.asarray(png.convert("RGB")).reshape(-1, 3)
        # The outline colour is written by the renderer and by nothing else in the frame,
        # which is a pale gradient plus a dark blob.
        hits = int(((marked == np.array(RQ._COLOUR_IN_TISSUE)).all(axis=1)).sum())
        return block, hits

    base, base_hits = draw(scale)
    half, half_hits = draw(scale / 2)

    assert half["spot_diameter_image_px"] == pytest.approx(
        base["spot_diameter_image_px"] * 2
    ), "halving the declared scale did not double the declared spot size"
    assert base["spot_diameter_image_px"] == pytest.approx(
        55.0 / scale / entry["meta"]["to_space"][0] * base["level_scale"]
    ), "the drawn diameter is not the declared 55 um carried through the declared affine"
    # …and it reached the canvas: a bigger circle marks strictly more pixels.
    assert half_hits > base_hits > 0, (
        f"the rendered outline covers {base_hits} px at the declared scale and {half_hits} at "
        "half of it — the radius was computed but not drawn"
    )


# ── TEST-12 — the package declaration moved with the code ──────────────────────────


def test_the_new_helper_is_declared_and_the_version_moved():
    """TEST-12 [covers: ITEM-8] — an undeclared helper is an ImportError in a user's sandbox.

    `run.helpers` is what assembles `/code`, and `import registration_qc` in the entry
    resolves to whatever is staged beside it. There is no build-time signal for a missing
    one — the failure is a user's job dying.

    The helper list is asserted by COUNT as well as by membership, because an append is
    precisely the hunk that merges cleanly and drops something without conflicting.
    """
    import yaml

    manifest = Path(__file__).resolve().parents[1] / "manifest.yaml"
    doc = yaml.safe_load(manifest.read_text())
    analysis = doc["contributes"]["analyses"][0]
    helpers = analysis["run"]["helpers"]

    assert "compute/registration_qc.py" in helpers
    assert len(helpers) == 3, f"expected 3 staged helpers, found {len(helpers)}: {helpers}"
    for helper in helpers:
        assert (manifest.parent / helper).is_file()

    Version = pytest.importorskip("packaging.version").Version
    assert Version(str(doc["version"])) > Version("0.3.0"), (
        "the seed reconciliation keys on `version`; an unchanged one keeps executing the OLD "
        "kernel while this package's files have moved"
    )
    # The QC adds NO library. It uses numpy (already declared for the matrix) and PIL (already
    # declared as the PNG reader tifffile is not).
    libraries = {d["library"] for d in analysis["run"]["dependencies"]}
    assert libraries == {"numpy", "pandas", "scipy", "h5py", "tifffile", "pillow"}, libraries
    assert "matplotlib" not in libraries, (
        "DEC-8: the overlay draws with PIL.ImageDraw precisely so no rootfs pin is implied"
    )
    # `produces` is unchanged: the overlay is a report output, not an artifact (DEC-10).
    assert "spatial/image" in analysis["produces"]
    assert len([p for p in analysis["produces"] if p == "report/qc"]) == 1


# ── TEST-13 — the QC never raises into the import ──────────────────────────────────


def test_a_broken_qc_costs_the_diagnostic_and_never_the_data(registered, tmp_path_factory):
    """TEST-13 [covers: ITEM-1] — DEC-7, as an assertion rather than a comment.

    `emit_images` wraps its whole per-image body in ONE guard because *"losing one image must
    never cost the matrix, the coordinates, the columns and the report"*. A diagnostic has
    even less claim to abort an import than an artifact does.

    Driven by truncating the EMITTED OME-TIFF before the check reads it back, which is a real
    failure of a real read on a real path — not a monkeypatched exception, which would prove
    only that `except` works.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)

    truncated = Path(tmp_path_factory.mktemp("truncated"))
    (truncated / entry["path"]).parent.mkdir(parents=True, exist_ok=True)
    raw = (out / entry["path"]).read_bytes()
    (truncated / entry["path"]).write_bytes(raw[: len(raw) // 3])

    block, overlays = RQ.registration_qc(
        coords=coords, in_tissue=flag,
        microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, scale_source="vendor",
        image_entries=[entry], outputs_dir=truncated, spot_diameter_um=55.0,
        scope="all-spots-in-positions-table",
    )
    image = block["images"][0]
    assert image["verdict"] == RQ.VERDICT_NOT_EVALUATED
    assert "could not be run over this image" in image["reason"]
    # The exception's TYPE is named, so a reader can tell a damaged file from a logic bug.
    # Asserted against the type the read ACTUALLY raises — determined here by making the same
    # call and catching it — rather than against a substring like "Error", which nearly every
    # Python exception class name satisfies and which a hardcoded literal would also pass.
    try:
        RQ.read_emitted_plane(truncated / entry["path"], entry["meta"]["extent"])
        raise AssertionError("the truncated file read cleanly; this test drives nothing")
    except AssertionError:
        raise
    except Exception as real:
        expected = type(real).__name__
    assert expected in image["reason"], (
        f"the report says {image['reason']!r} but the read really raises {expected}"
    )
    # The SCALE half is unaffected — one broken image must not cost the other referent.
    assert block["scale"]["verdict"] == "pass", block["scale"]["reason"]
    assert block["verdict"] != RQ.VERDICT_PASS
    assert overlays == {}


# ── TEST-14 — the mutation battery, with a control ─────────────────────────────────


def test_the_mutation_battery_and_its_control(registered, tmp_path_factory):
    """TEST-14 [covers: ITEM-2, ITEM-3] — a guard that cannot be made to fail is no guard.

    Six mutations of the mapping and the scale, each of which must drive the check RED, and
    a CONTROL mutation which must leave it GREEN. The control is what distinguishes "the
    battery ran and the mutations were caught" from "this check fails on everything" — the
    latter passes every assertion a control-free battery could make.

    Every registration mutation runs over IDENTICAL PIXELS. Nothing on disk changes between
    the control and the mutants; only the declared affine does. So a red verdict cannot be
    attributed to the image.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)
    declared = list(entry["meta"]["to_space"])
    a, d = declared[0], declared[4]
    scale = VF.REGISTERED_MICRONS_PER_PIXEL

    counter = itertools.count()

    def registration(to_space):
        mutant, where = reemit_with_affine(
            entry, out, to_space, tmp_path_factory, f"battery-{next(counter)}"
        )
        block, _ = RQ.check_registration(
            mutant, where, coords, flag, microns_per_pixel=scale, spot_diameter_um=55.0,
        )
        assert "declaration_mismatch" not in block, (
            "the battery is exercising the divergence guard, not the registration metric"
        )
        return block["verdict"], block

    affine_mutations = {
        # (mutation, which MECHANISM must catch it). Naming the mechanism is not decoration:
        # a blind audit pointed out that `assert set(verdicts) == {"fail"}` collapsed five
        # mutations into one green line and HID that three of them never reach Youden's J at
        # all — they land zero spots in frame and are caught by the coverage bound. Five
        # mutants all caught by one trivial guard reads exactly like five probes of the
        # metric, and it is not the same thing.
        "transposed": ([0.0, a, 0.0, d, 0.0, 0.0], "score"),
        "doubled": ([a * 2, 0.0, 0.0, 0.0, d * 2, 0.0], "score"),
        "halved": ([a * 0.5, 0.0, 0.0, 0.0, d * 0.5, 0.0], "coverage"),
        "forward-instead-of-inverse": ([1.0 / a, 0.0, 0.0, 0.0, 1.0 / d, 0.0], "coverage"),
        "half-image-translation": ([a, 0.0, VF.IMAGED_FULLRES_W / 2.0, 0.0, d,
                                    VF.IMAGED_FULLRES_H / 2.0], "coverage"),
    }
    for name, (to_space, mechanism) in affine_mutations.items():
        verdict, block = registration(to_space)
        assert verdict == "fail", f"{name} was not caught: {block['reason']}"
        if mechanism == "score":
            assert block["spots_inside_fraction"] >= RQ.MIN_SPOTS_INSIDE_FRACTION, (
                f"{name} is recorded as caught by the SCORE but its spots left the frame, so "
                "it is really caught by the coverage bound"
            )
            assert block["youden_j"] is not None and block["youden_j"] < RQ.J_FLOOR, (
                f"{name} did not reach Youden's J; the registration metric is not what caught it"
            )
        else:
            assert block["spots_inside_fraction"] < RQ.MIN_SPOTS_INSIDE_FRACTION, (
                f"{name} is recorded as caught by COVERAGE but its spots stayed in frame"
            )
    # At least two mutants must be caught by the METRIC rather than by the bounds check, or
    # this battery says nothing about the thing the module exists for.
    assert sum(1 for _, m in affine_mutations.values() if m == "score") >= 2

    # THE CONTROL — and it is a REAL perturbation, not the base case under another name.
    #
    # The first version of this control was `[a, 0, 0, 0, d, 0]`, which is element-for-element
    # IDENTICAL to `declared`. It re-ran the base case and could not do the job a control
    # exists for: ruling out "this check fails on anything you hand it". This one genuinely
    # moves the affine — a translation of one full-resolution pixel and a relative scale change
    # of 1e-9, both far below the spot radius — and the verdict must NOT move.
    control_affine = [a * (1 + 1e-9), 0.0, 1.0, 0.0, d * (1 + 1e-9), 1.0]
    assert control_affine != declared, "the control is not a perturbation at all"
    control_verdict, control_block = registration(control_affine)
    assert control_verdict == "pass", control_block["reason"]
    assert control_block["youden_j"] >= RQ.J_FLOOR
    # …and it really did travel a different code path: the mapped positions moved, so a
    # verdict that stayed green did so despite a change, not because nothing changed.
    _, base_block = registration(declared)
    assert control_block["to_space"] != base_block["to_space"]

    # The sixth mutation is on the SCALE referent, and it is the live one: the 65/55 ratio
    # DEC-9 escalates. It must be caught by the same threshold, from the same code, with no
    # special case.
    wrong_scale = RQ.check_scale(coords, scale * 55.0 / 65.0, scale_source="probe")
    right_scale = RQ.check_scale(coords, scale, scale_source="probe")
    assert wrong_scale["verdict"] == "fail", wrong_scale["reason"]
    assert right_scale["verdict"] == "pass", right_scale["reason"]
    assert wrong_scale["relative_error"] > 0.15
    assert right_scale["relative_error"] < 0.001

    # And the tolerance is not vacuously tight either: an error INSIDE it still passes, so
    # "everything fails" is excluded on the scale half as well as on the registration half.
    tolerable = RQ.check_scale(coords, scale * 1.04, scale_source="probe")
    assert tolerable["verdict"] == "pass", tolerable["reason"]
    assert 0.03 < tolerable["relative_error"] <= RQ.PITCH_TOLERANCE


# ═════════════════════════════════════════════════════════════════════════════════════
# ROUND 1 — the tests a blind mutation audit proved were missing.
#
# The audit applied 30 single-line mutations to `compute/registration_qc.py` and 13 of them
# left the suite GREEN. The pattern behind almost all of them is ONE root cause: the positive
# control SATURATES the metric. `make_registered` paints the tissue blob at half a spot pitch
# around exactly the in-tissue spots, so the correct case scores sensitivity 1.000 /
# specificity 1.000 / J exactly 1.000, and every failing case scores J in {0.000, 0.025}.
# Nothing in the suite ever observed a J strictly between those, so:
#
#   * `J_FLOOR` could be set to 0.03 OR to 0.99 and everything stayed green;
#   * specificity was 1.0 in every scored case, so `J = sensitivity` survived;
#   * every scored case had `spots_inside_fraction` of exactly 1.0 or 0.0, so scoring
#     off-image spots as misses (rather than dropping them) was unverified;
#   * every fixture was dark-tissue-on-pale-slide and already `uint8`, so the polarity
#     decision, the border ring, Otsu itself and `_to_uint8`'s normalisation never ran.
#
# The fix is NOT to perturb the fixture until the numbers land somewhere interesting — that
# would make every assertion in this file depend on a hand-tuned blob. It is to drive the
# MEASUREMENT and the JUDGEMENT directly, on synthetic inputs chosen so the expected value is
# arithmetic rather than an observation. `registration_verdict` was split out of
# `check_registration` for exactly that.
# ═════════════════════════════════════════════════════════════════════════════════════


def _scored(mask, xy, labels):
    _, RQ = modules()
    return RQ.score_registration(mask, xy, np.asarray(labels, dtype=bool))


def test_youden_j_needs_both_of_its_terms(registered):
    """TEST-15 [covers: ITEM-3] — half of the metric was inert, and nothing said so.

    Mutation `J = sensitivity` survived the whole original suite, because specificity was
    exactly 1.0 in every case it ever scored. A metric with a dead term is a metric that
    cannot detect the failure that term exists for: a mask which over-calls tissue.

    Each case below fixes the expected value by ARITHMETIC — `J = sens + spec - 1` over counts
    the test itself chose — so no assertion here is an observation copied out of a run.
    """
    _, RQ = modules()
    mask_all = np.ones((40, 40), dtype=bool)
    mask_none = np.zeros((40, 40), dtype=bool)
    xs = np.array([5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 5.0, 10.0])
    ys = np.array([5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 30.0, 5.0])
    labels = np.array([True] * 4 + [False] * 4)

    # A mask that calls EVERYTHING tissue: it finds every in-tissue spot (sensitivity 1) and
    # every out-of-tissue spot too (specificity 0). J = 1 + 0 - 1 = 0, i.e. chance — which is
    # the correct answer, because a mask that says "yes" everywhere carries no information.
    over = _scored(mask_all, (xs, ys), labels)
    assert over["sensitivity"] == 1.0 and over["specificity"] == 0.0
    assert over["youden_j"] == 0.0, (
        "an all-tissue mask scored non-zero; the specificity term is not in the metric"
    )
    assert RQ.registration_verdict(dict(over, to_space=[1, 0, 0, 0, 1, 0]))["verdict"] == "fail"

    # …and the mirror image, which the original suite DID cover: a mask that calls nothing
    # tissue. Kept so the pair is visible together — one of these alone leaves a term dead.
    under = _scored(mask_none, (xs, ys), labels)
    assert under["sensitivity"] == 0.0 and under["specificity"] == 1.0
    assert under["youden_j"] == 0.0


def test_the_j_floor_is_pinned_on_its_own_boundary():
    """TEST-16 [covers: ITEM-3] — the threshold, exercised where it actually decides.

    `J_FLOOR` could be moved anywhere from 0.03 to 0.99 without any test noticing, because
    the suite only ever fed the judgement 0.0 and 1.0. This drives it at the boundary from
    both sides, so the constant is pinned by BEHAVIOUR and not merely by its own literal.

    The block is synthetic on purpose: it is the judgement that is under test here, not the
    scoring, and building it by hand is what lets J be set to exactly the floor.
    """
    _, RQ = modules()
    assert RQ.J_FLOOR == 0.5, (
        "the floor moved; DEC-5 derives 0.5 from Youden's J's own scale (0 = chance, "
        "1 = perfect) and a move needs that derivation revisited, not just this line edited"
    )

    def judge(j):
        return RQ.registration_verdict({
            "spots_inside_fraction": 1.0, "spots_inside_image": 100, "n_spots": 100,
            "youden_j": j, "sensitivity": 1.0, "specificity": j,
            "to_space": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        })["verdict"]

    assert judge(RQ.J_FLOOR) == "pass", "the floor is exclusive; DEC-5 states 'at or above'"
    assert judge(RQ.J_FLOOR + 1e-9) == "pass"
    assert judge(RQ.J_FLOOR - 1e-9) == "fail", (
        "a value below the floor passed — the floor is not deciding anything"
    )
    assert judge(0.0) == "fail" and judge(1.0) == "pass"
    # The COVERAGE bound is decided FIRST, so a wrong affine that empties the frame is
    # reported as that rather than as a low score — even when J would have said `pass`.
    empty = RQ.registration_verdict({
        "spots_inside_fraction": 0.0, "spots_inside_image": 0, "n_spots": 100,
        "youden_j": 1.0, "sensitivity": 1.0, "specificity": 1.0,
        "to_space": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    })
    assert empty["verdict"] == "fail" and "land inside this image" in empty["reason"]


def test_a_spot_that_missed_the_image_is_a_miss_not_a_dropped_row():
    """TEST-17 [covers: ITEM-3] — the semantic the comment claimed and nothing checked.

    `score_registration` says a spot that fell off the image *"is not on tissue. Scoring it as
    a miss rather than dropping it is what keeps a wildly wrong affine from scoring well on
    the handful of spots that happened to stay in frame."* Restricting the rates to in-frame
    spots survived the original suite, because every case it scored had ALL or NONE of its
    spots in frame.

    Here exactly half are pushed out of the frame, so the two behaviours give different
    numbers: dropping them would score sensitivity 1.0 over the survivors; counting them as
    misses scores 0.5.
    """
    mask = np.ones((40, 40), dtype=bool)
    xs = np.array([5.0, 10.0, 15.0, 20.0, 500.0, 600.0, 700.0, 800.0])
    ys = np.array([5.0, 10.0, 15.0, 20.0, 500.0, 600.0, 700.0, 800.0])
    labels = np.array([True] * 8)
    result = _scored(mask, (xs, ys), labels)
    assert result["spots_inside_image"] == 4 and result["n_spots"] == 8
    assert result["spots_inside_fraction"] == 0.5
    assert result["sensitivity"] == 0.5, (
        f"sensitivity is {result['sensitivity']}; at 1.0 the off-image spots were dropped "
        "rather than scored as misses, and a wildly wrong affine would score well on the few "
        "spots that stayed in frame"
    )


def test_the_tissue_mask_polarity_is_measured_from_the_border_not_assumed():
    """TEST-18 [covers: ITEM-3] — the branch the module argues about and never ran.

    `tissue_mask` decides which side of Otsu's threshold is TISSUE from the image border,
    because brightfield puts tissue darker than the slide and fluorescence puts it brighter,
    and Youden's J is antisymmetric under a label flip — so guessing wrong would turn a good
    registration into J ≈ -1 and a bad one into ≈ +1. Deleting the decision (`mask = dark`,
    always) survived the entire original suite: every fixture is dark-on-pale.

    Two images here, and they are different tests. The first is a plain BRIGHT-tissue plane,
    which catches a deleted decision. The second puts tissue IN A CORNER, which catches the
    ring being shrunk to one pixel — a corner sample would read that corner as background and
    invert the mask, while the full ring still reads background.
    """
    _, RQ = modules()

    bright = np.full((60, 80), 20, dtype=np.uint8)
    bright[20:40, 30:60] = 230
    mask, info = RQ.tissue_mask(bright)
    assert info["tissue_is_darker_than_background"] is False, (
        "a bright-tissue-on-dark-background plane was read as dark-tissue; the polarity is "
        "assumed rather than measured, and every score on such an image is inverted"
    )
    assert mask[30, 45] and not mask[5, 5], "the mask selected the background, not the tissue"

    # TISSUE TOUCHING A CORNER. `border[0, 0]` is now tissue, so a one-pixel sample reads
    # 'the border is bright' and concludes tissue is dark — the exact inversion above. The
    # whole ring is still overwhelmingly background, so the shipped decision holds.
    cornered = np.full((60, 80), 20, dtype=np.uint8)
    cornered[0:18, 0:22] = 230
    mask2, info2 = RQ.tissue_mask(cornered)
    assert info2["tissue_is_darker_than_background"] is False, (
        "with tissue in one corner the polarity flipped, so the decision is sampling too "
        "little of the border to be robust"
    )
    assert mask2[5, 5] and not mask2[40, 60]
    # And a constant plane carries no boundary at all: refused, never guessed at.
    with pytest.raises(RQ.RegistrationQCError):
        RQ.tissue_mask(np.full((20, 20), 128, dtype=np.uint8))


def test_otsu_picks_a_threshold_between_the_two_modes():
    """TEST-19 [covers: ITEM-3] — hardcoding the threshold to 0.5 survived the whole suite.

    The synthetic fixture is two-valued, so any threshold in a wide band separates it and the
    actual histogram computation was never exercised. This plane's two modes both sit BELOW
    0.5 after normalisation, so a hardcoded 0.5 puts them on the same side and the mask
    collapses — while a real between-class-variance maximum lands between them.
    """
    _, RQ = modules()
    plane = np.zeros((100, 100), dtype=np.uint16)
    plane[:70, :] = 1000      # background mode
    plane[70:99, :] = 3000    # tissue mode
    plane[99, :] = 10000      # a bright artifact, which is what stretches the normalisation
    mask, info = RQ.tissue_mask(plane)
    threshold = info["threshold_normalised"]
    # Normalised: 1000 -> 0.0, 3000 -> 0.222, 10000 -> 1.0. The bright artifact stretches the
    # range, so BOTH populated modes are squeezed below 0.5 — which is the whole point of this
    # fixture. A separating threshold sits strictly between them; a hardcoded 0.5 puts them on
    # the SAME side and the mask collapses to "everything except the artifact".
    assert 0.0 < threshold < 0.222, (
        f"Otsu returned {threshold}, which does not separate modes at 0.0 and 0.222 — a "
        "hardcoded or mis-derived threshold"
    )
    assert threshold != 0.5
    # The BRIGHTER mode is the tissue here, because the border is majority background (the
    # 1000 region fills the top edge and most of both side edges) and the polarity is read
    # from the border. Asserted in the direction the mechanism actually produces, not the
    # direction a dark-tissue habit assumes.
    assert info["tissue_is_darker_than_background"] is False
    assert mask[80, 10] and not mask[10, 10], "the two modes landed on the same side"
    assert info["mask_fraction"] == pytest.approx(0.30, abs=0.01), (
        "the mask is not the 3000+10000 rows; at ~0.99 the threshold failed to separate and "
        "everything but the artifact was called tissue, which is the hardcoded-0.5 outcome"
    )

    # ── the threshold is the CLASS BOUNDARY, not the bin's midpoint ──────────────────
    #
    # Otsu's maximisation puts bins [0..index] in the dark class, so the boundary is
    # `(index + 1) / 256`. `(index + 0.5) / 256` — the bin's midpoint, which is what this
    # module computed at first — hands half of bin `index` to the BRIGHT class even though the
    # between-class variance placed it in the dark one.
    #
    # The two differ by 1/512 of the normalised range, which no assertion above can see: a
    # revert of this fix survived the entire suite. So the probe below is placed INSIDE the
    # band the two conventions disagree about — normalised 0.00293, which is above the
    # midpoint (0.001953) and below the boundary (0.003906) — where one convention calls it
    # dark and the other calls it bright. Its raw value is derived from the two formulas
    # rather than picked, so it cannot drift out of the band.
    two_mode = np.zeros((256, 256), dtype=np.float64)
    two_mode[200:, :] = 1000.0
    _, base_info = RQ.tissue_mask(two_mode)
    index = round(base_info["threshold_normalised"] * 256 - 1)
    assert base_info["threshold_normalised"] == pytest.approx((index + 1) / 256), (
        f"the threshold is {base_info['threshold_normalised']}, not the class boundary "
        f"{(index + 1) / 256} for index {index} — it is the bin midpoint"
    )
    probed = two_mode.copy()
    probed[0, 0] = ((index + 0.5) / 256 + (index + 1) / 256) / 2 * 1000.0
    probe_mask, probe_info = RQ.tissue_mask(probed)
    assert probe_info["tissue_is_darker_than_background"] is False
    # Tissue is the BRIGHT side here, so the probe being OUT of the mask means it was put in
    # the dark class — the boundary convention. Under the midpoint it would be in the mask.
    assert not probe_mask[0, 0], (
        "a pixel between the bin midpoint and the class boundary was classified BRIGHT, so "
        "the threshold is the midpoint and half of the winning bin is on the wrong side"
    )


def test_not_evaluated_is_never_a_pass_on_any_of_its_branches():
    """TEST-20 [covers: ITEM-1, ITEM-2, ITEM-3] — the suite's headline discipline, enforced.

    This file's module docstring says `not-evaluated` is a third value that must never read as
    a pass, and TEST-7/TEST-8 cover two of the branches that produce it — which made the rest
    LOOK covered. A blind audit turned three others into `VERDICT_PASS` one at a time and the
    suite stayed green every time: the one-class label branch, `check_scale`'s fewer-than-two-
    spots branch, and `registration_qc`'s exception guard around the scale check.

    "Nobody could check this" laundered into "checked and fine" is the exact failure this
    whole item exists to remove, so every branch that can produce it is now driven.
    """
    _, RQ = modules()

    # (1) ONE-CLASS LABELS — every spot in-tissue, which is what the FILTERED matrix looks
    #     like. `youden_j` is undefined and the verdict must say so.
    mask = np.ones((40, 40), dtype=bool)
    xy = (np.array([5.0, 10.0, 15.0]), np.array([5.0, 10.0, 15.0]))
    one_class = _scored(mask, xy, np.array([True, True, True]))
    assert one_class["youden_j"] is None and one_class["specificity"] is None
    judged = RQ.registration_verdict(dict(one_class, to_space=[1, 0, 0, 0, 1, 0]))
    assert judged["verdict"] == RQ.VERDICT_NOT_EVALUATED
    assert judged["verdict"] != RQ.VERDICT_PASS
    assert "NOT a pass" in judged["reason"]

    # (2) FEWER THAN TWO SPOTS — there is no spacing to measure.
    for coords in (np.zeros((0, 2)), np.array([[10.0, 20.0]])):
        scale = RQ.check_scale(coords, 0.88, scale_source="probe")
        assert scale["verdict"] == RQ.VERDICT_NOT_EVALUATED, coords
        assert scale["verdict"] != RQ.VERDICT_PASS
        assert scale["measured_pitch_px"] is None
        assert "relative_error" not in scale

    # (3) THE EXCEPTION GUARD around the scale check, which is a DIFFERENT branch from (2)
    #     and had to be found by mutation rather than by reading.
    #
    #     The first version of this leg passed a 1-D `coords` array, on the assumption that it
    #     would raise. It does not: `measure_spot_pitch` checks `pts.ndim != 2` and returns a
    #     `None` pitch, so that input lands in branch (2) above and the except guard was never
    #     entered. The mutation that turns this guard into `VERDICT_PASS` still survived — a
    #     phantom leg in the very test written to close a phantom leg. It was caught by
    #     re-running the mutation battery against the fixed suite instead of assuming the fix
    #     worked.
    #
    #     An object-dtype coordinate array — what a damaged positions table really produces —
    #     raises `ValueError` inside `measure_spot_pitch`'s subtraction, which is a real
    #     failure on a real path rather than a monkeypatched raise (that would prove only
    #     that `except` works).
    with pytest.raises(ValueError):
        RQ.check_scale(np.array([["a", "b"], ["c", "d"]], dtype=object), 0.88,
                       scale_source="probe")
    block, overlays = RQ.registration_qc(
        coords=np.array([["a", "b"], ["c", "d"]], dtype=object),
        in_tissue=np.array([True, False]),
        microns_per_pixel=0.88, scale_source="probe", image_entries=[],
        outputs_dir=".", spot_diameter_um=55.0, scope="probe",
    )
    assert block["scale"]["verdict"] == RQ.VERDICT_NOT_EVALUATED, (
        "a raise inside the scale check did not become `not-evaluated`; if it became `pass` "
        "then an unrunnable check reads as a clean one"
    )
    assert block["scale"]["verdict"] != RQ.VERDICT_PASS
    assert "ValueError" in block["scale"]["reason"]
    assert block["verdict"] != RQ.VERDICT_PASS
    assert overlays == {}


def test_a_singular_affine_is_refused_rather_than_divided_by():
    """TEST-21 [covers: ITEM-3] — the guard INV-3's design rationale rests on.

    `invert_affine` computes a full 2x2 inverse rather than a reciprocal precisely so a
    TRANSPOSED affine can be MAPPED and seen to be wrong, instead of raising. But an affine
    that collapses the image onto a line has no inverse at all, and the determinant guard for
    it was dead in the original suite (`if False:` survived): the transposed affine's
    determinant is `-a*d`, which is not zero.

    A singular affine must become a stated `not-evaluated`, never a crash and never a pass.
    """
    _, RQ = modules()
    for singular in ([0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                     [5.0, 5.0, 0.0, 5.0, 5.0, 0.0],
                     [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]):
        with pytest.raises(RQ.RegistrationQCError) as caught:
            RQ.invert_affine(singular)
        assert "singular" in str(caught.value)
    # A NON-singular transpose still inverts, because that is the case the check has to be
    # able to score rather than decline.
    apply = RQ.invert_affine([0.0, 5.0, 0.0, 5.0, 0.0, 0.0])
    ux, uy = apply(np.array([10.0]), np.array([20.0]))
    assert (ux[0], uy[0]) == (4.0, 2.0)


def test_a_sixteen_bit_plane_is_normalised_not_wrapped():
    """TEST-22 [covers: ITEM-4] — `read_image`'s contract says the dtype is NOT constrained.

    `_to_uint8`'s docstring names this exact mutation — *"a bare `.astype(uint8)` here would
    wrap a 16-bit plane into noise"* — and a bare `astype` survived the original suite,
    because every fixture plane is already `uint8`.
    """
    _, RQ = modules()
    plane = np.array([[0, 1000, 32768, 65535]], dtype=np.uint16)
    out = RQ._to_uint8(plane)
    assert out.dtype == np.uint8
    # The endpoints map to the endpoints.
    assert out[0, 0] == 0 and out[0, 3] == 255
    # THE DISCRIMINATING VALUES, chosen by working out what each implementation returns rather
    # than by picking round numbers: a bare `astype(uint8)` takes the low byte, so 1000 -> 232
    # and 32768 -> 0, while a linear normalisation gives 3 and 127. Every one of those four is
    # a different number, so neither implementation can be mistaken for the other.
    assert out[0, 1] == 3, f"1000 became {out[0, 1]}; 232 is the low byte, i.e. a wrapped cast"
    assert out[0, 2] == 127, (
        f"32768 became {out[0, 2]}; 0 is the low byte — the brightest half of a 16-bit plane "
        "wrapping to black is exactly the 'noise' this function exists to prevent"
    )
    assert out[0, 0] < out[0, 1] < out[0, 2] < out[0, 3], "normalisation is not monotonic"
    # An already-uint8 plane passes through untouched, so display is not silently restretched.
    same = np.array([[3, 4, 5]], dtype=np.uint8)
    assert (RQ._to_uint8(same) == same).all()


def test_the_read_back_level_scale_is_derived_from_the_array_not_assumed(registered):
    """TEST-23 [covers: ITEM-3] — the seam that keeps a coarser pyramid read honest.

    `read_emitted_plane` returns `level_scale = arr.shape[1] / declared_extent.width`, derived
    from the array's OWN shape so that *"a level chosen for cost cannot silently misplace a
    spot"*. Hardcoding it to 1.0 survived the original suite, because every Visium fixture is
    level 0 at scale 1.0 — so the seam has never been observed doing anything.

    Driven by handing the real emitted file a DECLARED extent twice its real width, which is
    what a coarser level looks like from the mapping's point of view.
    """
    out, entries, report = registered
    _, RQ = modules()
    entry = VF.entry_by_id(entries, HIRES)
    declared = entry["meta"]["extent"]

    arr, (scale_x, scale_y), info = RQ.read_emitted_plane(out / entry["path"], declared)
    assert (scale_x, scale_y) == (1.0, 1.0) and info["pyramid_level"] == 0
    assert info["level_extent"] == {"width": declared["width"], "height": declared["height"]}

    doubled = {"width": declared["width"] * 2, "height": declared["height"] * 2}
    _, (half_x, half_y), _ = RQ.read_emitted_plane(out / entry["path"], doubled)
    assert (half_x, half_y) == (0.5, 0.5), (
        f"level scale is {(half_x, half_y)} for an array half the declared size; it is "
        "hardcoded rather than derived, and a coarser-level read would place every spot at "
        "twice its true distance from the origin"
    )

    # THE TWO AXES ARE INDEPENDENT. A pyramid level rounds its height and its width
    # separately, so one ratio cannot stand in for the other — applying the x ratio to y
    # would silently misplace every spot along y in proportion to the mismatch, which is
    # exactly what this seam exists to rule out. Driven with a declared extent whose two
    # ratios differ, so a single shared scale cannot satisfy both assertions.
    skewed = {"width": declared["width"] * 2, "height": declared["height"] * 4}
    _, (skew_x, skew_y), _ = RQ.read_emitted_plane(out / entry["path"], skewed)
    assert skew_x == 0.5, skew_x
    assert skew_y == 0.25, (
        f"the y scale is {skew_y}, not 0.25 — it is being derived from the WIDTH ratio, so "
        "every spot's y position is wrong by the difference between the two"
    )
    for bad in ({"width": 0, "height": 10}, {"width": 10, "height": 0}):
        with pytest.raises(RQ.RegistrationQCError):
            RQ.read_emitted_plane(out / entry["path"], bad)


def test_a_data_level_misregistration_fails_without_any_declaration_being_touched(
        tmp_path_factory):
    """TEST-24 [acceptance] [invariant: INV-3] [covers: ITEM-3, ITEM-7] — the stronger control.

    Every other negative control in this file mutates the DECLARED affine over identical
    pixels. This one is the other way round: every declaration is exactly what the shipped
    importer produces — the vendor's own scalefactors, the inverse-scalefactor affine, the
    correct extent — and the TISSUE IN THE IMAGE is at transposed positions.

    That is what a real misregistration is. Nothing in the artifact is edited, nothing is
    hand-mutated, and every internal-consistency guard in this package still passes it. The
    check has to notice from the pixels alone, which is the entire claim of this item.
    """
    _, RQ = modules()
    good = VF.make_registered(tmp_path_factory.mktemp("dl-good-src"))
    bad = VF.make_registered(tmp_path_factory.mktemp("dl-bad-src"), transpose_image=True)
    _, good_entries, good_report = run(good, tmp_path_factory, "dl-good-out")
    _, bad_entries, bad_report = run(bad, tmp_path_factory, "dl-bad-out")

    good_image = next(i for i in good_report["registration_qc"]["images"] if i["image_id"] == HIRES)
    bad_image = next(i for i in bad_report["registration_qc"]["images"] if i["image_id"] == HIRES)

    # THE DECLARATIONS ARE IDENTICAL. Only the pixels differ, so a `fail` cannot be attributed
    # to anything that was edited.
    assert good_image["to_space"] == bad_image["to_space"]
    assert good_image["extent"] == bad_image["extent"]
    assert VF.entry_by_id(good_entries, HIRES)["meta"] == VF.entry_by_id(bad_entries, HIRES)["meta"]

    assert good_image["verdict"] == "pass", good_image["reason"]
    assert bad_image["verdict"] == "fail", bad_image["reason"]
    assert bad_image["youden_j"] is not None, (
        "the transposed-tissue case did not even reach the metric; it is being caught by the "
        "coverage bound, so this is not a test of the registration score"
    )
    assert bad_image["youden_j"] < RQ.J_FLOOR
    # The SCALE half is unaffected — transposing the tissue does not move the spot lattice.
    assert bad_report["registration_qc"]["scale"]["verdict"] == "pass"


def test_the_overlay_is_omitted_loudly_when_there_is_no_declared_spot_size(tmp_path_factory):
    """TEST-25 [covers: ITEM-4] — an absent overlay must say why it is absent.

    With no micron scale a spot has no declared physical size, so drawing one would require
    inventing a radius — and *"an overlay with an invented radius would look exactly like a
    measured one"*. The explanation could be deleted outright without the original suite
    noticing, because TEST-7 inspected only the `scale` block.
    """
    bundle = VF.make_imaged(tmp_path_factory.mktemp("noscale-img-src"),
                            scalefactors_text=json.dumps(
                                {"tissue_hires_scalef": 0.2, "tissue_lowres_scalef": 0.06}))
    out, entries, report = run(bundle, tmp_path_factory, "noscale-img-out")
    qc = report["registration_qc"]

    assert qc["scale"]["verdict"] == "not-evaluated"
    image = next(i for i in qc["images"] if i["image_id"] == HIRES)
    assert image["spot_diameter_image_px"] is None
    assert "overlay" not in image
    assert "invented radius" in image["overlay_omitted"], (
        "the overlay is absent and the report does not say why"
    )
    html = (out / "visium-import-summary.html").read_text()
    assert "no overlay was rendered" in html


# ═════════════════════════════════════════════════════════════════════════════════════
# ROUND 2 — the defects a blind CORRECTNESS audit found, each with the test that pins it.
#
# The tests-quality round above closed holes in what the suite could CATCH. This round is
# different in kind: these are real defects in the module, found by reading the code against
# its own claims and demonstrated by running it. Every one of them makes the check report the
# WRONG THING rather than merely fail to notice something.
#
# Four of them share a shape worth naming, because it is the shape this whole item exists to
# remove: a real FAIL being downgraded to `not-evaluated`. A renderer exception discarded an
# already-computed verdict; a zero pitch raised before the FAIL branch; one NaN coordinate
# NaN-ed out every distance. "Could not be checked" laundered over "checked and wrong" is the
# same laundering as a false pass, in a politer font.
# ═════════════════════════════════════════════════════════════════════════════════════


def test_an_inverted_mask_is_reported_as_that_and_not_as_a_misregistration():
    """TEST-27 [covers: ITEM-3] — a confidently-worded FAIL about the wrong thing.

    `tissue_mask` reads the polarity off the image border, which assumes the frame is slide.
    A blind audit demonstrated a plane that is 90% tissue reaching all four edges inverting
    the mask outright — and an inverted mask turns a CORRECT registration into Youden's J near
    -1, which the original code reported as *"the vendor's own `in_tissue` call and this
    image's own pixels disagree about where the tissue is"*. That sentence is false in that
    situation, and a false FAIL on a routine cropped or CytAssist section is as corrosive as a
    false pass: it teaches the reader to ignore the one check with an external referent.

    A wrong affine SCATTERS the spots, which drives J toward 0. Only an inverted mask drives
    it toward -1. So strong anti-correlation is diagnosable as itself, and it becomes
    `not-evaluated` naming the real cause.

    This is NOT `abs(J)`: a genuine misregistration still scores near 0 and still FAILS, which
    the last assertion below pins.
    """
    _, RQ = modules()

    def judge(j):
        return RQ.registration_verdict({
            "spots_inside_fraction": 1.0, "spots_inside_image": 100, "n_spots": 100,
            "youden_j": j, "sensitivity": 0.0, "specificity": 0.0,
            "to_space": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        })

    inverted = judge(-1.0)
    assert inverted["verdict"] == RQ.VERDICT_NOT_EVALUATED
    assert "ANTI-correlated" in inverted["reason"]
    assert "polarity" in inverted["reason"]
    assert judge(-RQ.J_INVERSION_FLOOR)["verdict"] == RQ.VERDICT_NOT_EVALUATED
    # …and the check has NOT been made unfailable. A real misregistration scores near chance,
    # and chance is still a FAIL. If this ever passes, `abs(J)` has crept in.
    for chance in (0.0, 0.1, -0.1, 0.3):
        assert judge(chance)["verdict"] == "fail", chance


def test_the_polarity_is_read_from_a_band_wide_enough_to_survive_edge_tissue():
    """TEST-28 [covers: ITEM-3] — the audit's own counter-example, as a fixture.

    A 200x200 plane that is 90% dark tissue touching every edge. Under a one-pixel border ring
    this measured `border_dark_fraction = 0.701` and inverted the mask; under a band it is
    still a heuristic, but the reported `polarity_margin` says how near the boundary the call
    was, which is the honest thing a verdict word cannot carry.
    """
    _, RQ = modules()
    plane = np.full((200, 200), 60, dtype=np.uint8)      # dark tissue everywhere…
    plane[95:105, 95:105] = 240                          # …with a small pale hole
    mask, info = RQ.tissue_mask(plane)
    assert info["border_band_px"] >= 4, (
        "the polarity is being read from a one-pixel ring, which a blind audit demonstrated "
        "inverting the mask on a section that reaches the frame edge"
    )
    assert 0.0 <= info["polarity_margin"] <= 1.0
    # The margin is REPORTED whichever way the call went, so a reader can see a near-coin-flip.
    assert "polarity_margin" in info and "border_dark_fraction" in info


def test_a_render_failure_costs_the_picture_and_never_the_verdict(registered, monkeypatch,
                                                                    tmp_path_factory):
    """TEST-29 [covers: ITEM-1, ITEM-4] — DEC-7's laundering, in the direction that HIDES.

    `render_overlay` used to run OUTSIDE any guard of its own, so a PNG failure propagated to
    the per-image handler, which replaced the whole block with a fresh `not-evaluated` — and
    the aggregate then treats `not-evaluated` as not-a-failure, so a correctly computed FAIL
    never reached the top-level verdict. A drawing bug could silently suppress a real
    misregistration alarm.

    The verdict is computed BEFORE the render for exactly this reason, and the render now has
    its own guard. Driven by making the renderer raise, then asserting the FAIL survived.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    original = VF.entry_by_id(entries, HIRES)
    # A doubled affine, which is a real FAIL — established independently by TEST-2. Written
    # into the BYTES so the verdict comes from the score and not from the divergence guard.
    doubled = [v * 2 if i in (0, 4) else v
               for i, v in enumerate(original["meta"]["to_space"])]
    entry, where = reemit_with_affine(original, out, doubled, tmp_path_factory, "render-fail")

    def explode(*args, **kwargs):
        raise RuntimeError("the canvas caught fire")

    monkeypatch.setattr(RQ, "render_overlay", explode)
    block, uri = RQ.check_registration(
        entry, where, coords, flag,
        microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, spot_diameter_um=55.0,
    )
    assert "declaration_mismatch" not in block
    assert block["verdict"] == "fail", (
        f"a render failure downgraded the verdict to {block['verdict']!r}; a drawing bug can "
        "suppress a real misregistration alarm"
    )
    assert uri is None and "overlay" not in block
    assert "the canvas caught fire" in block["overlay_omitted"]
    assert "still stands" in block["overlay_omitted"]


def test_a_two_channel_plane_is_drawable_because_it_is_scorable():
    """TEST-30 [covers: ITEM-4] — the renderer and the metric must admit the same images.

    `ome_writer.read_image` accepts a plane with samples ('YXS'), which includes a grayscale +
    alpha TIFF at two channels. `tissue_mask` handles `chans < 3`; `render_overlay` indexed
    channel 2 unconditionally and raised `IndexError`. So there were images the metric could
    score and the renderer could not draw — and before TEST-29's fix, that exception also
    destroyed the metric's answer.
    """
    _, RQ = modules()
    xy = (np.array([10.0, 20.0]), np.array([10.0, 20.0]))
    labels = np.array([True, False])
    for shape in ((50, 60), (50, 60, 1), (50, 60, 2), (50, 60, 3), (50, 60, 4)):
        arr = np.zeros(shape, dtype=np.uint8)
        arr[10:30, 10:30, ...] = 200
        mask, _ = RQ.tissue_mask(arr)          # the metric accepts it…
        png, info = RQ.render_overlay(arr, xy, labels, spot_diameter_image_px=6.0)
        assert png[:4] == b"\x89PNG", shape    # …and so must the renderer
        assert info["width"] > 0 and info["height"] > 0


def test_one_bad_coordinate_does_not_disable_the_whole_scale_check():
    """TEST-31 [covers: ITEM-2] — a NaN in one row used to cost the entire measurement.

    `float(v)` accepts the CSV text "nan" and "inf", and a single NaN coordinate makes the
    distance to it NaN from EVERY spot — so every row minimum is NaN, nothing is finite, and
    `check_scale` reported "fewer than two spots carry a position". That statement is false,
    and the external referent silently stopped being applied to the dataset.
    """
    _, RQ = modules()
    clean = np.array([[i * 113.0, 0.0] for i in range(20)])
    assert RQ.measure_spot_pitch(clean)["median_nn_px"] == pytest.approx(113.0)

    for bad in (np.nan, np.inf, -np.inf):
        dirty = clean.copy()
        dirty[7, 0] = bad
        measured = RQ.measure_spot_pitch(dirty)
        assert measured["median_nn_px"] == pytest.approx(113.0), (
            f"one {bad} coordinate changed the measured pitch to "
            f"{measured['median_nn_px']} — it should be excluded, not propagated"
        )
        # …and the exclusion is REPORTED. A row that silently vanishes from a measurement is
        # a measurement over a population nobody described.
        assert measured["n_dropped_non_finite"] == 1
        assert measured["n_spots"] == 20 and measured["n_measured"] == 19
        assert RQ.check_scale(dirty, 100.0 / 113.0)["verdict"] == "pass"


def test_coincident_spots_are_checked_and_wrong_not_unable_to_check():
    """TEST-32 [covers: ITEM-2] — the reportable defect that was unreachable.

    `measure_spot_pitch` masks only the diagonal, deliberately, so that two spots at the SAME
    position are "a real (and reportable) defect" rather than being hidden behind a plausible
    pitch. But the report was unreachable: `implied_microns_per_pixel` divided by the pitch
    BEFORE the verdict branch, raised `ZeroDivisionError` on a pitch of 0, and the outer guard
    turned the whole thing into `not-evaluated` — losing the measured pitch, the spot count
    and the verdict together.
    """
    _, RQ = modules()
    # The MEDIAN nearest-neighbour distance is 0 only when most spots have a coincident twin,
    # which is what a genuinely degenerate positions table looks like. A single duplicated pair
    # among many good spots leaves the median intact and is not this case — asserted below, so
    # the two are not confused.
    duplicated = np.array([[100.0, 200.0], [100.0, 200.0],
                           [213.0, 200.0], [213.0, 200.0],
                           [326.0, 200.0], [326.0, 200.0]])
    scale = RQ.check_scale(duplicated, 100.0 / 113.0, scale_source="probe")
    assert scale["measured_pitch_px"] == 0.0
    assert scale["verdict"] == "fail", (
        f"a positions table with coincident spots reported {scale['verdict']!r}; at "
        "`not-evaluated` a real defect reads as an unrunnable check"
    )
    assert scale["verdict"] != RQ.VERDICT_NOT_EVALUATED
    assert "share a position" in scale["reason"]
    # The measurement survives into the report rather than being swallowed with the exception.
    assert scale["n_spots"] == 6
    assert "implied_microns_per_pixel" not in scale, (
        "an implied scale was published from a division by zero"
    )
    # ONE duplicated pair among good spots is NOT this case: the median survives, the referent
    # still applies, and the check must go on measuring rather than refusing.
    mostly_fine = np.array([[i * 113.0, 0.0] for i in range(10)] + [[0.0, 0.0]])
    ok = RQ.check_scale(mostly_fine, 100.0 / 113.0, scale_source="probe")
    assert ok["measured_pitch_px"] == pytest.approx(113.0)
    assert ok["verdict"] == "pass"


def test_the_pitch_estimator_is_bounded_and_stays_correct_when_it_windows():
    """TEST-33 [covers: ITEM-2] — an O(n^2) estimator inside a user's import at 95%.

    Measured: 4,992 spots (a full Visium V1 slide) 0.85 s, 20,000 spots 13.2 s. A denser array
    — #162's Visium HD bins run to millions — would hang the import. Above the cap the
    estimator takes a contiguous spatial WINDOW, which is correct here in a way a scattered
    subsample would NOT be: sampling scattered points removes a lattice point's true nearest
    neighbours and INFLATES the pitch, corrupting the one measurement this module rests on.

    Asserted by measuring the same lattice twice — once whole, once windowed — and requiring
    the same answer.
    """
    _, RQ = modules()
    side = int(np.ceil(np.sqrt(RQ.PITCH_EXACT_MAX_SPOTS + 500)))
    yy, xx = np.mgrid[0:side, 0:side]
    lattice = np.column_stack([xx.ravel() * 113.0, yy.ravel() * 113.0]).astype(float)
    assert len(lattice) > RQ.PITCH_EXACT_MAX_SPOTS

    windowed = RQ.measure_spot_pitch(lattice)
    assert windowed["windowed"] is True
    assert windowed["n_spots"] == len(lattice)
    assert windowed["median_nn_px"] == pytest.approx(113.0), (
        f"the windowed estimate is {windowed['median_nn_px']}, not the lattice's own 113 — "
        "the window is removing nearest neighbours and inflating the pitch"
    )
    # …and it is DETERMINISTIC: the same bundle must not report a different pitch per run.
    assert RQ.measure_spot_pitch(lattice)["median_nn_px"] == windowed["median_nn_px"]
    # Below the cap nothing is windowed, so the common case is still exact.
    small = lattice[: RQ.PITCH_EXACT_MAX_SPOTS - 1]
    assert RQ.measure_spot_pitch(small)["windowed"] is False


def test_the_mask_lookup_uses_the_corner_convention_the_affine_declares():
    """TEST-34 [covers: ITEM-3] — a half-pixel offset against the settled convention.

    #176 settled the affine convention as CORNER by proof: pixel index i spans
    `[i*a, (i+1)*a)`. The in-frame test uses that convention (`xs < width`), but the mask
    lookup rounded, which is a pixel-CENTRE convention — a systematic half-pixel offset in the
    OPPOSITE direction from the one the affine declares. At the hires level that is 2.5
    full-resolution pixels, about 2.2 um, biasing both rates on boundary-dense real tissue.

    Inherited from #176, not relitigated: this test pins the convention rather than arguing it.
    """
    mask = np.zeros((20, 20), dtype=bool)
    mask[:, 5:] = True                       # tissue starts at column 5
    # x = 4.6 is INSIDE background pixel 4 under the corner convention, and rounds to 5 under
    # the centre convention. The two conventions disagree about exactly this spot.
    result = _scored(mask, (np.array([4.6]), np.array([10.0])), np.array([False]))
    assert result["specificity"] == 1.0, (
        "a spot at x=4.6 was scored as a tissue hit; the lookup is rounding to pixel 5, which "
        "is a pixel-CENTRE convention, while the affine is corner-anchored"
    )
    # …and the neighbouring cases behave, so this is a convention test and not an off-by-one.
    assert _scored(mask, (np.array([5.0]), np.array([10.0])), np.array([True]))["sensitivity"] == 1.0
    assert _scored(mask, (np.array([4.0]), np.array([10.0])), np.array([False]))["specificity"] == 1.0


def test_the_overlay_is_omitted_rather_than_making_the_report_unopenable(registered,
                                                                        monkeypatch):
    """TEST-35 [covers: ITEM-4] — bounding the edge length does not bound the file.

    `OVERLAY_MAX_EDGE`'s reasoning cites the vendor-diagnostic BYTE cap as its precedent, but
    it caps only pixels. A noisy 900x900 RGB plane compresses poorly, and two of them plus the
    two vendor JPEGs can push the report to several megabytes with nothing saying why.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)
    monkeypatch.setattr(RQ, "OVERLAY_MAX_BYTES", 32)
    block, uri = RQ.check_registration(
        copy.deepcopy(entry), out, coords, flag,
        microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, spot_diameter_um=55.0,
    )
    assert uri is None and "overlay" not in block
    assert "inline cap" in block["overlay_omitted"]
    # THE VERDICT IS UNAFFECTED — the same laundering direction TEST-29 closes.
    assert block["verdict"] == "pass", block["reason"]
    assert "unaffected" in block["overlay_omitted"]


def test_the_whole_qc_never_raises_into_the_import():
    """TEST-36 [covers: ITEM-1] — the promise the header dict did not keep.

    The docstring says "Never raises (DEC-7)", and the descriptive header was built OUTSIDE
    the guard: a 0-d `coords` (TypeError from `len`) or an `in_tissue` that will not cast to
    bool escaped into `run_import` and aborted the whole import — costing the user the matrix,
    the coordinates, the columns and the report, which is the exact outcome DEC-7 exists to
    prevent.
    """
    _, RQ = modules()
    for coords, flag in ((np.float64(1.0), np.array([True])),
                         (np.zeros((3, 2)), object()),
                         (None, None),
                         ("not an array", "neither")):
        block, overlays = RQ.registration_qc(
            coords=coords, in_tissue=flag, microns_per_pixel=0.88, scale_source="probe",
            image_entries=[], outputs_dir=".", spot_diameter_um=55.0, scope="probe",
        )
        assert block["kind"] == "visium-registration-qc"
        assert block["verdict"] != RQ.VERDICT_PASS, (coords, flag)
        assert overlays == {}


# ═════════════════════════════════════════════════════════════════════════════════════
# ROUND 3 — "an image nobody opens is not a check", measured rather than assumed.
#
# DEC-2 originally claimed the user reads the rendered overlay in the report inspector,
# reasoning from the design (§7.2: the importer is launchable precisely so "the user must be
# able to see and confirm the registration") and from the fact that the vendor's own JPEGs are
# already embedded there. That reasoning was sound and the conclusion was WRONG, because
# nobody had traced what the app does with a `report/html`.
#
# It does nothing. Traced end to end:
#   * `artifactRegistry.defaultForKind` maps anything not matching /stat|metric/ or
#     /provenance|methods/ to 'generic', so `report/html` gets `GenericResult`;
#   * `GenericResult.tsx:57-90` renders the artifact's CATALOG ROW — datatype, output_id,
#     created_at, `structure`, `meta` — under the heading "No specialized view for
#     'report/html'". It never calls `readOpaque`. Not one byte of the blob is fetched;
#   * `data_api.rs:1026` serves every artifact body as `application/octet-stream`, so even a
#     direct fetch downloads rather than renders;
#   * there is no iframe path (`ViewHost.tsx:55-62` is an explicit stub) and no
#     `dangerouslySetInnerHTML` anywhere in the UI.
#
# So the visual half of this check was, as shipped, invisible. What the app DOES show —
# automatically, zero clicks, the moment a run finishes — is `artifact.meta`, carried from the
# producer's entry unchanged by `ingest.rs:208`. The verdict now goes there.
#
# These tests hold the Python end of that. They cannot assert what React renders, and they do
# not pretend to: what they pin is that the verdict is IN the channel, in a form a human can
# read, on every report artifact — so the claim rests on one traced fact about the UI rather
# than on an assumption about it.
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_verdict_rides_in_meta_where_the_app_actually_shows_it(registered, uncovered,
                                                                   shipped):
    """TEST-37 [covers: ITEM-5] — the QC reaches a human, or it is not a check.

    `meta` is the ONE channel: `GenericResult` prints it verbatim for any datatype with no
    specialised view, which is every datatype this package emits. So the verdict has to be
    there and it has to be legible — a nested block would render as a wall of JSON in a
    `max-h-40` box, which is why `qc_verdict_lines` flattens it to one line per check.

    Asserted on BOTH the passing and the failing bundle, because a verdict channel whose
    failing state is unexercised is a channel that can be broken in the case it exists for.
    """
    module, _ = modules()
    for label, (out, entries, report) in (("registered", registered),
                                          ("uncovered", uncovered),
                                          ("shipped", shipped)):
        qc = report["registration_qc"]
        for output_id in ("visium-import-report", "visium-import-summary"):
            entry = VF.entry_by_id(entries, output_id)
            meta = entry["meta"]
            assert meta["registration_qc_verdict"] == qc["verdict"], (label, output_id)
            lines = meta["registration_qc"]
            assert isinstance(lines, list) and lines, (label, output_id)
            assert all(isinstance(line, str) for line in lines)
            # One line per FACT the block carries: the scale verdict, the slide design the
            # scale numerator came from when there is one (#257), and one per image.
            #
            # #257 ADDS THE SECOND, and does so here rather than by lengthening the first,
            # which is what this count is protecting. The design note rode inside the scale
            # `reason` in that item's first cut, where `QC_META_REASON_CHARS` (200) truncated
            # it: the committed fixture's line went from 136 characters to 308, started ending
            # mid-word, and on an `assumed-standard` bundle the sentence telling the reader
            # what to check fell off the end — in the one channel this whole test exists to
            # protect. A second fact needs a second line. The count is still EXACT and still
            # derived from what actually ran, so an unbounded dump fails exactly as before.
            expected = 1 + (1 if qc["scale"].get("slide_design_note") else 0)
            expected += max(1, len(qc["images"]))
            assert len(lines) == expected, (label, lines)
            assert lines[0].startswith("scale vs the slide's spot pitch: ")
            if qc["scale"].get("slide_design_note"):
                assert lines[1].startswith("scale numerator: "), (label, lines)
            # The VERDICT WORD is in the line, not only in the sibling key — a reader scanning
            # the block must not have to correlate two fields to learn what happened.
            assert qc["scale"]["verdict"] in lines[0]
            # …and the line carries the MEASUREMENT, not just a colour. DEC-5's point is that a
            # bare pass/fail asks the reader to trust a threshold calibrated on a synthetic
            # control.
            if "measured_pitch_um" in qc["scale"]:
                assert f"{qc['scale']['measured_pitch_px']:.3f} pixels" in lines[0]
        # BOUNDED. `meta` renders inside a fixed-height scroll box, so an unbounded reason
        # would push every other row out of view.
        for line in VF.entry_by_id(entries, "visium-import-report")["meta"]["registration_qc"]:
            assert len(line) < 400, (label, len(line), line[:80])

    # The bundles really did produce DIFFERENT verdicts, so this test is not passing because
    # every verdict happens to be the same string.
    #
    # The contrast used to be `registered` vs `shipped`. Since #243 the shipped bundle is
    # coherent and PASSES, so it no longer supplies a failing verdict — `uncovered` does, and
    # it is a bundle broken on purpose rather than a fixture that happened to be wrong. The
    # shipped bundle stays in the loop above as a third case: a REAL vendor image whose meta
    # must carry the verdict channel correctly too.
    assert (registered[2]["registration_qc"]["verdict"]
            != uncovered[2]["registration_qc"]["verdict"])


def test_the_report_says_the_overlay_is_embedded_where_nothing_renders_it(registered,
                                                                         tmp_path_factory):
    """TEST-38 [covers: ITEM-4, ITEM-5] — the honest half of DEC-2's correction.

    A reader who sees `diagnostics_embedded` and an overlay in the report's own JSON could
    reasonably conclude they have LOOKED at the registration. They have not, and cannot, in
    this build. Saying so in the artifact record costs one key and is the difference between a
    known gap and a silent one.

    The note is OMITTED, not nulled, when there is no overlay — the same discipline the report
    applies to `display_derivative`, and asserted here so a future `.get()` cannot reintroduce
    the null this package refuses everywhere else.
    """
    out, entries, report = registered
    summary = VF.entry_by_id(entries, "visium-import-summary")["meta"]
    assert summary["overlay_embedded"], "no overlay was embedded, so this test is vacuous"
    assert "report/html" in summary["overlay_note"]
    assert "no renderer" in summary["overlay_note"]
    # …and the ids in `meta` are the overlays really in the HTML, not a claim about them.
    html = (out / "visium-import-summary.html").read_text()
    assert len(overlay_uris(html)) == len(summary["overlay_embedded"])
    for image_id in summary["overlay_embedded"]:
        assert image_id in html

    # ABSENCE IS THE KEY NOT BEING THERE. A bundle with no micron scale renders no overlay.
    bundle = VF.make_imaged(tmp_path_factory.mktemp("nonote-src"),
                            scalefactors_text=json.dumps(
                                {"tissue_hires_scalef": 0.2, "tissue_lowres_scalef": 0.06}))
    _, no_overlay_entries, _ = run(bundle, tmp_path_factory, "nonote-out")
    bare = VF.entry_by_id(no_overlay_entries, "visium-import-summary")["meta"]
    assert bare["overlay_embedded"] == []
    assert "overlay_note" not in bare, (
        "an overlay note was written as an explicit null/empty for a report that has no "
        "overlay; this package spells absence by the key not being there"
    )


# ═════════════════════════════════════════════════════════════════════════════════════
# ROUND 4 — what a blind DESIGN-CONFORMANCE audit found, and its headline was the picture.
#
# The two round-1 angles asked "is this correct?" and "would the tests catch it if not?".
# This one asked the question neither does: does the shipped BEHAVIOUR uphold the DESIGN's
# invariants, or does it satisfy the plan while reframing the intent? It judged INV-3 UPHELD
# and R1 of INV-4 UPHELD, and it found the mechanical half strong. What it found weak was the
# thing §7.5 actually asks for — the picture:
#
#   "I mutated render_overlay to discard `image_xy` entirely and lay the circles on an
#    arbitrary square lattice (correct radius kept) — the full 38-test suite stays GREEN,
#    TEST-2 included. TEST-2's `assert base_uri != moved_uri` is carried ENTIRELY by the
#    radius: re-mutating `radius` to a constant makes TEST-2 fail immediately."
#
# So the overlay could draw every spot in the wrong place and the acceptance gate that claims
# to prove INV-1 reaches the renderer would not notice. TEST-2 was a real assertion about a
# real difference — and the difference it was sensitive to was the circle SIZE, not the spot
# POSITION. That is the D2 tautology in miniature: the test could not fail on the thing it
# named.
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_overlay_draws_each_spot_where_the_declared_affine_puts_it(registered,
                                                                      tmp_path_factory):
    """TEST-39 [acceptance] [invariant: INV-1] [covers: ITEM-4] — WHERE, not just whether.

    INV-1 is about the overlay being generated from the declared `to_space`. Until now the
    only evidence that the renderer used the mapping at all was that its output BYTES changed
    when the affine moved — and a blind audit showed that difference was carried by the circle
    radius, so a renderer that ignored `image_xy` completely passed every test.

    This asserts the positions themselves: the centres the renderer actually marked, against
    centres computed HERE from the declared affine by an independent inverse. And it asserts
    they MOVE, correctly, when the declared affine moves — so it cannot pass by the renderer
    ignoring the mapping and it cannot pass by the expectation being copied out of the code.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)
    declared = list(entry["meta"]["to_space"])

    def marks(to_space, name):
        mutant, where = reemit_with_affine(entry, out, to_space, tmp_path_factory, name)
        block, _ = RQ.check_registration(
            mutant, where, coords, flag,
            microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, spot_diameter_um=55.0,
        )
        return block

    base = marks(declared, "where-base")
    overlay = base["overlay"]
    assert overlay["marks_drawn"] > 100, overlay

    # THE INDEPENDENT EXPECTATION. A pure-scale affine `[a,0,0,0,d,0]` maps an image pixel
    # into the space by multiplying; the overlay needs the other direction, so a spot at
    # full-resolution (x, y) lands at (x/a, y/d), then times the render scale. Computed from
    # the declared numbers with plain arithmetic — not by calling the module's own inverse.
    a, d = declared[0], declared[4]
    render_scale = overlay["render_scale"]
    width, height = overlay["width"], overlay["height"]
    expected = []
    for x, y in coords:
        cx, cy = (x / a) * render_scale, (y / d) * render_scale
        if 0 <= cx < width and 0 <= cy < height:
            expected.append([round(float(cx), 3), round(float(cy), 3)])
    assert overlay["first_marks"] == expected[: len(overlay["first_marks"])], (
        f"the renderer marked {overlay['first_marks']} where the declared affine puts "
        f"{expected[: len(overlay['first_marks'])]} — the circles are not at the spots"
    )
    assert overlay["marks_drawn"] == len(expected)

    # …AND THE POSITIONS FOLLOW THE DECLARATION. Halving the affine halves every mapped
    # coordinate, so a renderer that ignored `image_xy` and drew on any fixed lattice would
    # produce the same marks here and fail.
    halved = marks([a / 2, 0.0, 0.0, 0.0, d / 2, 0.0], "where-halved")
    if halved["overlay"]["marks_drawn"]:
        for (bx, by), (hx, hy) in zip(base["overlay"]["first_marks"],
                                      halved["overlay"]["first_marks"]):
            assert hx == pytest.approx(bx * 2, rel=1e-6), (bx, hx)
            assert hy == pytest.approx(by * 2, rel=1e-6), (by, hy)


def test_an_overlay_with_no_marks_is_not_embedded_as_if_it_were_one(uncovered, registered):
    """TEST-40 [acceptance] [invariant: INV-2] [covers: ITEM-4] — INV-2, at the product.

    INV-2 says an absent overlay and a correct overlay must not be the same green test. The
    test-level version was honoured from the start. The PRODUCT-level version was not, and a
    blind audit found it: on a bundle whose spots all map outside its image frame, the
    rendered PNG contained **zero drawn marks** — a bare tissue thumbnail, pixel-identical to
    what an overlay that was never drawn would look like. A reader opening that report would
    see a picture and conclude they had checked something.

    An overlay with nothing on it is now not embedded, and the report says why.

    The mark-free bundle used to be the SHIPPED fixture, which was incoherent. Since #243 it
    is `make_downscaled_hires`, which rebuilds that exact artifact deliberately — the audit
    finding this test encodes is unchanged, only its source is no longer a bug in a fixture
    the rest of the tree depends on being correct.
    """
    out, entries, report = uncovered
    _, RQ = modules()
    image = next(i for i in report["registration_qc"]["images"] if i["image_id"] == HIRES)
    assert image["spots_inside_image"] == 0
    assert image["overlay"]["marks_drawn"] == 0
    assert image["overlay"]["marks_outside_frame"] == 160
    assert "map outside this image's frame" in image["overlay_omitted"]
    # `overlay_note` is CONDITIONAL on an overlay actually being embedded, and this is the
    # branch that proves it. #243 widened `test_producer_end_to_end`'s meta key-set pin by
    # this key on the ground that it is overlay-conditional pre-existing compute rather than
    # a new unconditional field; that ground was prose until this line.
    for output_id in ("visium-import-report", "visium-import-summary"):
        meta = VF.entry_by_id(entries, output_id)["meta"]
        assert "overlay_note" not in meta, (
            "`overlay_note` is present on a bundle whose overlay was OMITTED, so it is not "
            "overlay-conditional and widening the meta key-set pin for it was wrong"
        )
    html = (out / "visium-import-summary.html").read_text()
    assert not overlay_uris(html), (
        "a mark-free overlay was embedded anyway; it is indistinguishable from a registration "
        "nobody checked, which is exactly what INV-2 forbids"
    )
    # THE POSITIVE CONTROL, so "not embedded" is not simply what always happens.
    reg_out, _, reg_report = registered
    reg_image = next(i for i in reg_report["registration_qc"]["images"]
                     if i["image_id"] == HIRES)
    assert reg_image["overlay"]["marks_drawn"] == 160
    assert "overlay_omitted" not in reg_image
    assert overlay_uris((reg_out / "visium-import-summary.html").read_text())


def test_the_two_copies_of_the_declaration_are_cross_checked(registered, tmp_path_factory):
    """TEST-41 [covers: ITEM-3] — the artifact as STORED, which ITEM-2 asked for.

    The pixels were read back from disk while the affine came from the in-memory entry dict,
    so a writer that serialised a different affine than the entry held was outside this
    check's reach — and §7.3's rule is about the declaration on disk.

    They agree today by construction (`emit_images` builds one `meta`; `write_ome_tiff`
    derives both copies from it), and that is asserted rather than assumed. A divergence is a
    FAIL in its own right, because then the artifact a consumer reads is not the one the
    producer believes it wrote and no score computed from either copy describes it.
    """
    out, entries, report = registered
    _, RQ = modules()
    coords, flag = full_positions()
    entry = VF.entry_by_id(entries, HIRES)

    block, _ = RQ.check_registration(
        copy.deepcopy(entry), out, coords, flag,
        microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, spot_diameter_um=55.0,
    )
    assert block["persisted_to_space"] == list(entry["meta"]["to_space"]), (
        "the OME-XML and the manifest entry disagree on a normal run — they are one fact "
        "written twice from a single object"
    )
    assert "declaration_mismatch" not in block
    assert block["verdict"] == "pass"

    # A DIVERGENCE, built by moving ONLY the manifest entry's copy and leaving the bytes.
    diverged = copy.deepcopy(entry)
    diverged["meta"]["to_space"] = [v * 2 if i in (0, 4) else v
                                    for i, v in enumerate(entry["meta"]["to_space"])]
    bad, _ = RQ.check_registration(
        diverged, out, coords, flag,
        microns_per_pixel=VF.REGISTERED_MICRONS_PER_PIXEL, spot_diameter_um=55.0,
    )
    assert bad["verdict"] == "fail"
    assert "declaration_mismatch" in bad
    assert "A consumer reads the OME-XML" in bad["declaration_mismatch"]


def test_the_aggregate_does_not_absorb_not_evaluated_into_pass():
    """TEST-42 [covers: ITEM-3] — the third value, kept at the roll-up too.

    `registration_verdict` was FAIL if any image failed, else PASS if ANY image passed. With
    two images where one passed and one could not be checked, the aggregate read `pass` —
    "could not be checked" absorbed into "checked and fine" at exactly the summary a machine
    reads, while every per-image row still said otherwise. The one-word answer is the one a
    gate would refuse on.
    """
    _, RQ = modules()

    def aggregate(verdicts):
        entries = [{"id": f"i{n}", "meta": {"to_space": [1, 0, 0, 0, 1, 0],
                                            "extent": {"width": 1, "height": 1}},
                    "path": "missing.ome.tif"} for n, _ in enumerate(verdicts)]
        block, _ = RQ.registration_qc(
            coords=np.zeros((0, 2)), in_tissue=np.zeros(0, dtype=bool),
            microns_per_pixel=0.88, scale_source="probe", image_entries=entries,
            outputs_dir=".", spot_diameter_um=55.0, scope="probe",
        )
        # Every image above is unreadable, so they all come back not-evaluated; the point is
        # the ROLL-UP rule, which is exercised directly below on synthetic verdicts.
        block["images"] = [dict(image, verdict=v) for image, v in zip(block["images"], verdicts)]
        verdict_set = [i["verdict"] for i in block["images"]]
        return (RQ.VERDICT_FAIL if RQ.VERDICT_FAIL in verdict_set
                else (RQ.VERDICT_PASS
                      if verdict_set and all(v == RQ.VERDICT_PASS for v in verdict_set)
                      else RQ.VERDICT_NOT_EVALUATED))

    assert aggregate(["pass", "pass"]) == "pass"
    assert aggregate(["pass", "fail"]) == "fail"
    assert aggregate(["fail", "not-evaluated"]) == "fail"
    assert aggregate(["pass", "not-evaluated"]) == "not-evaluated", (
        "a passing image absorbed an unchecked one into `pass` at the aggregate"
    )
    assert aggregate(["not-evaluated"]) == "not-evaluated"

    # …and the SHIPPED function agrees with that rule on a real mixed case: one image that
    # cannot be read at all alongside none that pass.
    block, _ = RQ.registration_qc(
        coords=np.zeros((0, 2)), in_tissue=np.zeros(0, dtype=bool), microns_per_pixel=0.88,
        scale_source="probe",
        image_entries=[{"id": "gone", "path": "nope.ome.tif",
                        "meta": {"to_space": [1, 0, 0, 0, 1, 0],
                                 "extent": {"width": 2, "height": 2}}}],
        outputs_dir=".", spot_diameter_um=55.0, scope="probe",
    )
    assert block["registration_verdict"] == RQ.VERDICT_NOT_EVALUATED
    assert block["verdict"] != RQ.VERDICT_PASS


# ═════════════════════════════════════════════════════════════════════════════════════
# #222 — the vendor-internal invariant, and TEST-5's measurement after the fix.
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_vendors_own_two_files_say_which_circle_spot_diameter_fullres_measures(
    shipped,
):
    """TEST-2 [acceptance] [invariant: INV-2] [covers: ITEM-4] — #222's regression pin.

    ## The check that would have caught #222 at import time

    Three numbers, none of them chosen by this repo:

      * `measured_pitch_px` — the spot spacing measured off the vendor's own
        `tissue_positions.csv`;
      * `spot_diameter_fullres` — the vendor's own number in `scalefactors_json.json`;
      * `SLIDE_SPOT_PITCH_UM` = 100 — a property of manufactured glass.

    The pixel scale CANCELS in the ratio of the first two, so
    `measured_pitch_px / spot_diameter_fullres == 100 / (whatever spot_diameter_fullres
    measures, in um)`. The ratio therefore names that circle directly, using no constant of
    ours at all. That is what makes it a regression pin rather than a restatement of the
    fix: it is computed from the vendor's files and the slide, and the importer's constant is
    then held against it.

    ## The number, and the number it is NOT

    The committed bundle gives 113.000 / 73.61433 = 1.53503. That is 0.22% from
    100/65 = 1.53846 and 15.6% from 100/55 = 1.81818. So `spot_diameter_fullres` measures the
    ~65 um RENDERED circle, not the 55 um capture spot — which is why the scale numerator is
    65 and why `resolution_um` (a different question) stays 55.

    Both legs are asserted. A test that only agreed with 1.538 would not say which reading it
    refutes, and the refuted reading is the one that shipped.
    """
    module, RQ = modules()
    _out, _entries, report = shipped
    scale = report["registration_qc"]["scale"]

    # THE RATIO, FROM THE VENDOR'S RAW FILES. `spot_diameter_fullres` is read out of
    # `scalefactors_json.json` and the pitch off the report's measurement of
    # `tissue_positions.csv`. Neither is a number this repo chose.
    pitch_px = scale["measured_pitch_px"]
    diameter_px = float(VF.scalefactors()["spot_diameter_fullres"])
    ratio = pitch_px / diameter_px

    # ── the invariant, against the numerator THE IMPORTER ACTUALLY APPLIED ─────────────
    # This is the load-bearing leg and it is deliberately NOT
    # `ratio == 100 / module.VISIUM_RENDERED_SPOT_DIAMETER_UM`. That form reads a CONSTANT,
    # so it stays green while the importer divides by the OTHER one — a blind audit
    # demonstrated exactly that by restoring the #222 defect at the call site and watching
    # this test pass. What the importer applied is recoverable from the emitted artifact:
    # `microns_per_pixel * spot_diameter_fullres` is, by construction, the numerator it used.
    # So the check is "the circle the importer assumed" against "the circle the vendor's two
    # files imply", and it goes red for any numerator that is not the right one.
    applied_numerator_um = scale["microns_per_pixel"] * diameter_px
    implied_numerator_um = RQ.SLIDE_SPOT_PITCH_UM / ratio
    assert applied_numerator_um == pytest.approx(implied_numerator_um, rel=0.01), (
        f"the importer divided `spot_diameter_fullres` into {applied_numerator_um:.3f} um, "
        f"but the vendor's own two files say that field spans {implied_numerator_um:.3f} um "
        "(pitch/diameter against the slide's 100 um). The scale numerator is measuring a "
        "different circle from the one the field measures — this is #222"
    )
    assert applied_numerator_um != pytest.approx(
        module.VISIUM_CAPTURE_SPOT_DIAMETER_UM, rel=0.10
    ), "the importer is back on the 55 um capture footprint as its scale numerator (#222)"

    # …and the same statement in the ratio form the issue's ruling asks for.
    expected = RQ.SLIDE_SPOT_PITCH_UM / module.VISIUM_RENDERED_SPOT_DIAMETER_UM
    assert expected == pytest.approx(1.53846, abs=1e-5)
    assert ratio == pytest.approx(expected, rel=0.01), (
        f"the vendor's own two files give pitch/diameter = {ratio:.5f}, which is not "
        f"{expected:.5f} = 100 um / {module.VISIUM_RENDERED_SPOT_DIAMETER_UM} um. Either the "
        "declared rendered diameter no longer matches the circle `spot_diameter_fullres` "
        "measures, or the fixture changed"
    )

    # ── and the reading it refutes: the 55 um capture spot is NOT that circle ─────────
    capture_ratio = RQ.SLIDE_SPOT_PITCH_UM / module.VISIUM_CAPTURE_SPOT_DIAMETER_UM
    assert capture_ratio == pytest.approx(1.81818, abs=1e-5)
    assert ratio != pytest.approx(capture_ratio, rel=0.10), (
        "the vendor's files now agree with `spot_diameter_fullres` spanning the 55 um "
        "capture spot, which is the pre-#222 premise this test exists to refute"
    )
    assert abs(ratio - capture_ratio) / capture_ratio > 0.10

    # ── stated the other way round: the diameter the vendor's files IMPLY ─────────────
    # `spot_diameter_fullres * (100 / measured_pitch_px)` is the same arithmetic read as a
    # length instead of a ratio, and it is the form #222's analysis quotes.
    implied_diameter_um = diameter_px * (RQ.SLIDE_SPOT_PITCH_UM / pitch_px)
    assert implied_diameter_um == pytest.approx(65.145, abs=0.01)
    assert implied_diameter_um == pytest.approx(
        module.VISIUM_RENDERED_SPOT_DIAMETER_UM, rel=0.005
    ), f"the vendor's files imply a {implied_diameter_um:.3f} um circle"
    assert abs(implied_diameter_um - module.VISIUM_CAPTURE_SPOT_DIAMETER_UM) > 5.0

    # ── the pin's left-hand side is independent of the fix, PROVEN by recomputing it ──
    # `ratio` must be a property of the vendor's two files and of nothing this branch wrote.
    # Asserted by re-deriving it from the RAW bundle — the committed `tissue_positions.csv`
    # parsed here, and the committed `scalefactors_json.json` — with the importer's report
    # not consulted at all. If the two agree, the ratio cannot have been produced by the code
    # under test. (The earlier `microns_per_pixel not in (...)` spelling of this was a float
    # identity check that could never fail; a blind audit caught it.)
    import csv as _csv

    with open(VF.FIXTURE / "spatial" / "tissue_positions.csv", newline="") as fh:
        rows = list(_csv.DictReader(fh))
    pts = np.asarray(
        [[float(r["pxl_col_in_fullres"]), float(r["pxl_row_in_fullres"])] for r in rows]
    )
    d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=-1)
    np.fill_diagonal(d, np.inf)
    raw_pitch_px = float(np.median(d.min(axis=1)))
    raw_ratio = raw_pitch_px / json.loads(
        (VF.FIXTURE / "spatial" / "scalefactors_json.json").read_text()
    )["spot_diameter_fullres"]

    assert raw_pitch_px == pytest.approx(pitch_px, rel=1e-9), (
        "the pitch this test re-derives from the vendor's positions table disagrees with the "
        "one the importer reports, so one of the two is not measuring the committed file"
    )
    assert raw_ratio == pytest.approx(ratio, rel=1e-9)
    assert raw_ratio == pytest.approx(1.53503, abs=1e-5), (
        f"the committed bundle's own vendor-internal ratio is {raw_ratio:.5f}; it was 1.53503 "
        "when #222 was fixed, and it depends on no constant this repo chose"
    )


def test_the_shipped_bundle_now_passes_the_slide_referent_it_used_to_fail(shipped):
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-6] — TEST-5, after #222.

    INV-3 is "keep TEST-5's measurement assertion exactly as it is". This test is the
    independent statement that the kept half really is untouched by the fix, asserted here
    rather than only in place: the measurement is a property of the vendor's positions table
    and of the estimators, and it must not have moved when the constant did.

    It also records, in one place, the number that DID move — because #222's whole finding is
    that a 15.573% error was sitting in a report nobody read as a defect.
    """
    _out, _entries, report = shipped
    scale = report["registration_qc"]["scale"]

    # THE MEASUREMENT — unchanged by the fix, because it never involved the constant.
    assert scale["measured_pitch_px"] == pytest.approx(113.0, abs=0.5)
    assert scale["lattice_fit"]["pitch_px"] == pytest.approx(
        scale["measured_pitch_px"], rel=0.01
    )
    assert scale["lattice_fit"]["residual_rms_px"] < 1.0
    assert scale["implied_microns_per_pixel"] == pytest.approx(
        100.0 / scale["measured_pitch_px"]
    )
    assert scale["referent_um"] == 100.0

    # THE VERDICT STILL FOLLOWS THE NUMBER — the property TEST-5 exists for, restated over
    # the post-fix numbers so a verdict that stopped tracking its own measurement is caught
    # on this side of the change too.
    implied = "pass" if scale["relative_error"] <= scale["tolerance"] else "fail"
    assert scale["verdict"] == implied

    # WHAT MOVED. The derived scale is now the one the slide implies, to 0.22%.
    assert scale["microns_per_pixel_source"] == "derived-from-spot-diameter"
    assert scale["microns_per_pixel"] == pytest.approx(
        scale["implied_microns_per_pixel"], rel=0.005
    )
    assert scale["relative_error"] < 0.005
    assert scale["verdict"] == "pass"

    # …and it moved UP by exactly 65/55, which is the whole of the change. Any other factor
    # means something besides the constant moved.
    module, _RQ = modules()
    old_scale = (module.VISIUM_CAPTURE_SPOT_DIAMETER_UM
                 / float(VF.scalefactors()["spot_diameter_fullres"]))
    assert scale["microns_per_pixel"] / old_scale == pytest.approx(65.0 / 55.0, rel=1e-9)
    assert abs(old_scale * scale["measured_pitch_px"] - 100.0) / 100.0 == pytest.approx(
        0.15573, abs=1e-4
    ), "the pre-#222 error on this bundle is no longer 15.573%; the fixture moved"

    # ── THE THIRD USE SITE OF THE CAPTURE CONSTANT, which nothing else covered ─────────
    # The registration overlay draws each spot at its DECLARED physical size, and that size
    # is the 55 um CAPTURE footprint — not the 65 um circle the scale divides. Before #222
    # the two coincided by accident (the drawn circle landed exactly on the vendor's
    # `spot_diameter_fullres`), which is precisely why nothing noticed they were different
    # questions. A mutation battery found this call site UNGUARDED by every other test here:
    # switching it to the rendered constant left the whole suite green.
    #
    # Asserted by inverting the report's own number back through the declared scale and
    # affine: `spot_diameter_image_px * to_space[0] * microns_per_pixel` is the diameter in
    # micrometres that the overlay actually drew.
    _out, entries, _report = shipped
    hires = next(i for i in _report["registration_qc"]["images"] if i["image_id"] == HIRES)
    to_space_x = abs(float(VF.entry_by_id(entries, HIRES)["meta"]["to_space"][0]))
    drawn_um = hires["spot_diameter_image_px"] * to_space_x * scale["microns_per_pixel"]
    assert drawn_um == pytest.approx(55.0, rel=1e-6), (
        f"the overlay drew a {drawn_um:.3f} um spot. It must draw the 55 um CAPTURE "
        "footprint — the area transcripts came from — not the 65 um rendered circle the "
        "micron scale divides (#222)"
    )
    assert hires["spot_diameter_image_px"] == pytest.approx(12.458, abs=0.01), (
        "the drawn diameter moved off 55 um / the post-#222 scale; before #222 it was "
        "14.716 px and coincided with the vendor's `spot_diameter_fullres`, which is the "
        "coincidence that hid the two circles being different"
    )
