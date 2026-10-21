#!/usr/bin/env python3
# ruff: noqa
"""THE EXTERNAL REFERENT FOR SCALE — how much of #176's standing limitation Xenium closes,
and, precisely, how much it does not.

#176 could not close this and named it as a standing limitation for whoever came next:

    a wrong vendor scale produces a fully self-consistent, uniformly misscaled artifact
    that passes every check this system has — TEST-11 asserts the wrong artifact *passes*.

That is true of Visium because Visium states its scale EXACTLY ONCE. Every guard in the
system verifies internal consistency, and a single source cannot be inconsistent with
itself.

Xenium states the same number TWICE, in two files, written by two parts of 10x's pipeline:

  1. `experiment.xenium` -> `pixel_size`                  (a JSON run manifest)
  2. the morphology OME-TIFF -> `PhysicalSizeX`/`Y`       (XML inside the image itself)

and supplies a THIRD, geometric constraint that neither of them can satisfy by agreeing:

  3. the cell centroids are in MICRONS and the image is in PIXELS, so the centroids must
     fall inside `extent_px * pixel_size`.

So a scale wrong in ONE source is catchable here, and is REPORTED — with both raw numbers,
the measured relative difference, and which statement placed the image. It is not refused:
0.4.0 refused above an invented `1e-6` band, which cost the user the image and removed the
only input §7.5's registration overlay needs (#269).

`test_the_residue_*` below is the honest other half: a scale wrong the SAME way in BOTH
sources, by a factor that still contains the cells, passes every check IN THIS FILE. It is
asserted to pass — deliberately, exactly as #176's TEST-11 asserted its wrong artifact
passes — so the gap is MEASURED rather than claimed shut.

WHAT #301 CHANGED ABOUT THAT RESIDUE, because leaving this paragraph as it stood would make
it the stale claim it was written to prevent: the overlay that was the residue's named
mitigation is now BUILT for this producer, and it catches the 1.5x case this file measures.
The residue did not disappear; it narrowed, from "any uniform misscale" to "a uniform
misscale under about 2%". `test_the_residue_*` therefore now asserts BOTH halves — every
check in this file still says yes, and the overlay says no — which is what keeps the two
claims from drifting apart.
"""
import decimal
import gzip
import json
import math
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

import cyto_zarr_read as CZR  # noqa: E402


def _bundle_copy(tmp_path, name, src=None):
    dest = tmp_path / name
    shutil.copytree(src or XF.PRIME, dest)
    return dest


def _set_pixel_size(bundle, value):
    path = bundle / "experiment.xenium"
    doc = json.loads(path.read_text())
    doc["pixel_size"] = value
    path.write_text(json.dumps(doc))


def _report(out):
    return json.loads((Path(out) / "xenium-import-report.json").read_text())


# ── the positive control: all three agree on real data ───────────────────────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_all_three_statements_of_the_scale_agree_on_real_vendor_data(case, tmp_path):
    """TEST-17 / TEST-5 — the POSITIVE CONTROL, without which nothing below proves anything.

    A test suite that only ever asserts a `differs` finding cannot distinguish "the
    cross-check works" from "the importer reports a disagreement for everything". This is
    the arm that says the fixtures look like real vendor data — and real vendor data was
    measured: eight published 10x bundles, XOA 1.0.1 -> 3.0.0, relative difference exactly
    0.0 on every one.
    """
    bundle = {"prime": XF.PRIME, "protein": XF.PROTEIN}[case]
    out = tmp_path / "out"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    assert report["images_not_emitted"] == [], (
        "the real bundle must import its image cleanly — every disagreement test below is "
        "measured against this baseline"
    )
    image = XF.entry(entries, "spatial-image-morphology")
    stated = image["meta"]["stated_scales"]

    # TEST-5 [covers: ITEM-2] — 1 and 2, two independently-authored vendor statements.
    assert stated["agreement"] == "identical", (
        "the cross-check must have RUN and found the two statements to be the same number. "
        "`single-source` here would mean the OME-XML carried no PhysicalSize and this whole "
        "referent collapsed back to Visium's situation; `differs` would mean the fixture "
        "stopped being a positive control"
    )
    assert stated["experiment_pixel_size_um"] == XF.PIXEL_SIZE_UM
    assert stated["ome_physical_size_x_um"] == XF.PIXEL_SIZE_UM
    assert stated["ome_physical_size_y_um"] == XF.PIXEL_SIZE_UM
    # THE MEASURED FIGURE, and it is exactly zero — which is what eight real 10x bundles
    # (XOA 1.0.1 -> 3.0.0) also report, and is why no tolerance replaced the deleted
    # `_STATED_SCALE_RTOL`: a band is calibrated from a spread, and the spread is nil.
    assert stated["relative_difference_x"] == 0.0
    assert stated["relative_difference_y"] == 0.0
    # WHICH statement placed the image, declared rather than left to be inferred.
    assert stated["applied_source"] == "experiment.xenium:pixel_size"
    assert stated["applied_pixel_size_um"] == XF.PIXEL_SIZE_UM

    # 3 — the geometric constraint, computed from the artifacts rather than the inputs.
    coords = CZR.read_array(out / "spatial/coordinates.zarr", "coordinates")
    covered_w = image["meta"]["extent"]["width"] * image["meta"]["to_space"][0]
    covered_h = image["meta"]["extent"]["height"] * image["meta"]["to_space"][4]
    assert float(coords[:, 0].max()) <= covered_w
    assert float(coords[:, 1].max()) <= covered_h
    assert not [w for w in report["image_warnings"] if "covers only" in w]


def test_the_report_states_what_the_referent_closes_and_what_it_does_not(tmp_path):
    """TEST-17 — the honesty is IN THE ARTIFACT, not only in a design document.

    A limitation recorded only in a lifecycle file is a limitation the next reader of the
    data will not see.
    """
    out = tmp_path / "out"
    XF.run_over(XF.PRIME, out)
    referent = _report(out)["scale_referent"]
    assert len(referent["stated_sources"]) == 2
    assert "pixel_size" in referent["stated_sources"][0]
    assert "PhysicalSize" in referent["stated_sources"][1]
    assert "cell centroids" in referent["geometric"]
    assert referent["closes"] and referent["does_not_close"]
    assert "same way in both" in referent["does_not_close"].lower() or \
           "SAME way in both" in referent["does_not_close"]

    # TEST-6 [covers: ITEM-4] — THE CLAIM MUST MATCH THE BEHAVIOUR (#269).
    #
    # 0.4.0's block said this referent `closes` "a scale wrong in ONE of the two vendor
    # statements", which was true only because it REFUSED the image above an invented 1e-6
    # band. It no longer refuses; it measures. Leaving the sentence would put a reassurance
    # in the artifact a human reads, printed over the exact failure it claims to have
    # handled — which is the shape of #247's sharpest audit finding, one issue earlier.
    #
    # The assertions above are the ones this file already had, and they PASS with the false
    # claim intact (they only require the keys to be non-empty). That is why the wording
    # itself is asserted here.
    assert "reports" in referent, (
        "the referent must say what it REPORTS, now that neither leg refuses anything"
    )
    assert "relative difference" in referent["reports"]
    assert "which statement placed the image" in referent["reports"]
    assert "nothing on its own" in referent["closes"], (
        "a producer with no external referent cannot close a registration question "
        "(design 12.2); claiming it does is the reassurance this assertion exists to stop"
    )
    # WHICH OF TWO DIFFERING STATEMENTS IS RIGHT MOVED OUT OF THIS LIST AT #301, and that is
    # the one entry here that is allowed to leave it — but only by being answered, not by
    # being dropped. #269 put it in the list when it removed the refusal; §7.5's overlay is
    # what decides it, and #301 built that overlay for this producer. So the assertion is
    # that the case is now named as DECIDED, in the block that decides it, rather than merely
    # missing from the block that used to disclaim it. Delete the overlay and this goes red
    # in both places at once.
    assert "DIFFERING statements is correct is decided" in referent["does_not_close"], (
        "the newly-answered case — which of two DIFFERING statements is right — must be named "
        "as ANSWERED and pointed at the thing that answers it, not quietly dropped from the "
        f"list: {referent['does_not_close']!r}"
    )
    assert "PRODUCED by this importer" in referent["compensating_control"]["status"], (
        "…and the block it points at must actually claim to produce that control, or the "
        "sentence above is a pointer to nothing"
    )
    assert "IN-SANDBOX" in referent["does_not_close"], (
        "the disagreement rides this report and the catalog `meta`, NOT the OME Description "
        "payload that carries the affine into a sandboxed analysis. That gap is real and is "
        "newly reachable now that a disagreeing image is emitted at all, so it belongs in "
        "the list of what the referent does not close"
    )

    # AND THE PROSE MUST BE TRUE OF THE ARTIFACT, not merely present in the dict. Every
    # assertion above compares one hardcoded English literal against another; reverting
    # `stated_scale_agreement` to raise would leave all of them green. So the same test now
    # RUNS a disagreeing bundle and checks the behaviour each clause claims.
    skew_bundle = _bundle_copy(tmp_path, "referent-behaviour")
    _set_pixel_size(skew_bundle, XF.PIXEL_SIZE_UM * 1.01)
    skew_out = tmp_path / "out-referent-behaviour"
    _, skew_entries = XF.run_over(skew_bundle, skew_out)
    skew_report = _report(skew_out)

    #   "closes: nothing on its own"  ->  the disagreement did not withhold the image.
    assert [e for e in skew_entries if e["datatype"] == "spatial/image"]
    assert skew_report["images_not_emitted"] == []
    #   "reports: ... the measured relative difference per axis"  ->  it is really there.
    stated = XF.entry(skew_entries, "spatial-image-morphology")["meta"]["stated_scales"]
    assert stated["relative_difference_x"] > 0.0
    assert stated["relative_difference_y"] > 0.0
    #   "reports: ... which statement placed the image"  ->  and so is that.
    assert stated["applied_source"] == "experiment.xenium:pixel_size"
    #   "compensating_control: PRODUCED"  ->  and it is UNCONDITIONAL. The statement must not
    #   be something the importer only remembers to make when it has already noticed a
    #   disagreement: a reader of a clean import is equally entitled to know what checks their
    #   placement. Asserting it on BOTH runs is what makes this different from the
    #   literal-vs-literal checks above.
    assert (skew_report["scale_referent"]["compensating_control"]
            == referent["compensating_control"]), (
        "the statement about §7.5's control must be identical on a clean import and on a "
        "disagreeing one — it is a fact about this importer, not a reaction to the bundle"
    )
    #   AND THE TRIPWIRE THAT USED TO STAND HERE IS NOW LOAD-BEARING. An
    #   `assert not [entry with "overlay" in its id]` stood at this line under #269 and was
    #   DELETED, with the reason recorded: "nothing in this importer emits such an entry, so
    #   the comprehension is empty for every bundle and the assertion could not fail. A
    #   tripwire for a future #156 is not coverage now." #301 made it emit one, so the same
    #   comprehension is asserted in the opposite direction — where it can now fail.
    overlays = [e for e in skew_entries if "registration-overlay" in e["id"]]
    assert len(overlays) == 1, (
        "the disagreeing bundle emitted no registration overlay. §7.5 calls it a REQUIRED "
        "output, and this is the bundle that most needs one: two vendor statements, and the "
        f"overlay is what decides between them. Emitted {sorted(e['id'] for e in skew_entries)}"
    )
    assert overlays[0]["datatype"] == "report/qc", (
        "§7.5 asks for a rendered overlay IN the `report/qc`; this one is a "
        f"{overlays[0]['datatype']!r}"
    )
    assert (skew_out / overlays[0]["path"]).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n", (
        "the emitted overlay is not a PNG, so whatever the manifest promises a reader, they "
        "cannot open it"
    )


# ── arm (a): a scale stated DIFFERENTLY in the two sources is REPORTED ───────────────
#
# 0.4.0 REFUSED here, above a hard-coded `_STATED_SCALE_RTOL = 1e-6`. #269 removed both the
# constant and the refusal: the magnitude had no basis, and the refusal cost the user the
# image while removing the only input design §7.5's registration overlay (#156) needs. The
# arm still exists and still discriminates — it reports instead of refusing.


#: The disagreement sweep, covering the WHOLE REACHABLE RANGE of the reported figure.
#:
#: The figure is `|a-b| / max(|a|,|b|)`, which lies in `[0, 1)` BY CONSTRUCTION. So a
#: reintroduced band at or above 1.0 could never refuse anything, and one in `[0.999, 1.0)`
#: sits above every member of this list. Below 0.999 a band at any magnitude must refuse
#: somewhere here, which is what makes TEST-1 an executable proof that no band exists rather
#: than an assertion that one particular band is gone.
#:
#: ONE OVERCLAIM RETRACTED, AND ONE RETRACTION WITHDRAWN — both recorded, because getting a
#: correction wrong is the same defect as the original claim.
#:
#: RETRACTED: the first draft said "a threshold at ANY magnitude must refuse somewhere",
#: naming `1e3` as an example. Impossible — the measure cannot reach 1.0. A band that
#: survives this sweep has to sit above 0.999, i.e. refuse only a disagreement worse than a
#: factor of 1000; a producer doing only that is not the shape #269 is about, but the honest
#: bound is worth more than a stronger claim that is false.
#:
#: WITHDRAWN: a later draft also "retracted" the phrase "spanning NINE ORDERS OF MAGNITUDE"
#: as an overclaim. It was not one. The figures run from 1.0e-09 to 0.999 — a ratio of
#: almost exactly 1e9, which IS nine orders of magnitude — while occupying six distinct
#: DECADES. Span and decade-count are different quantities and the correction confused them.
#: TEST-9 now asserts both, so neither number can drift and neither can be "corrected" into
#: a wrong one again.
#:
#: THE DELETED BAND IS STRADDLED FROM BOTH SIDES, which the earlier draft did not do:
#: `1.0000001` produces 1.0e-07 (below `1e-6`, so the old predicate PASSED it) and `1.0001`
#: produces 1.0e-04 (above, so the old predicate REFUSED it). An off-by-one reintroduction
#: therefore has nowhere to hide. `1.000001` is kept because its figure (9.99999e-07) is the
#: closest member to the old constant, not because it is "within an ulp" of it — an earlier
#: draft said that and it is wrong by a factor of ~5e9. It evaluates FALSE under
#: `abs(d) > rtol * max(...)`, so on its own it proves nothing; the straddle is what does.
#:
#: `1 + 1e-9` sits below any plausible band; `1000.0` is a unit error, at 0.999 — near the
#: top of the measure's range, though not its supremum (the measure approaches 1.0 without
#: reaching it, so no factor is "the largest", which an earlier draft claimed).
_DISAGREEMENT_FACTORS = [1 + 1e-9, 1 + 1e-7, 1.000001, 1.0001, 1.01, 2.0, 0.5, 1000.0]


#: The smallest NORMAL float64. Below it `math.ulp` degenerates and the enumerated bound
#: stops holding in both directions — see `_CONVERSION_ULPS`'s PRECONDITION and KNOWN LIMIT.
_SMALLEST_NORMAL = sys.float_info.min


def _relative_difference(a, b):
    """The reported figure, recomputed independently of the producer."""
    return abs(a - b) / max(abs(a), abs(b))


def test_the_disagreement_sweep_is_distinct_and_straddles_the_deleted_band():
    """TEST-9 [covers: ITEM-6] — the sweep's own parameters, asserted rather than trusted.

    Two properties this file cannot claim in prose and leave unchecked, because the first
    draft got both wrong:

    1. **Distinctness.** `1 + 1e-6` and `1.000001` are the SAME float64. The first draft
       listed both; pytest disambiguated them to `[1.000001_0]` / `[1.000001_1]` and ran the
       full end-to-end import twice over a bit-identical bundle. Seven advertised cases,
       six real ones — coverage inflation, in the one file whose whole thesis is that a test
       which cannot discriminate is not a test.
    2. **Straddling the deleted band.** The first draft's members all sat either far above
       `1e-6` or below it; the one described as guarding the boundary was on the PASSING
       side. Re-adding `_STATED_SCALE_RTOL = 1e-6` verbatim has to turn a member red from
       ABOVE and leave one green from BELOW, or the sweep is not bracketing anything.
    """
    assert len(set(_DISAGREEMENT_FACTORS)) == len(_DISAGREEMENT_FACTORS), (
        "two factors are the same float64; the list claims more coverage than it has"
    )
    base = XF.PIXEL_SIZE_UM
    figures = sorted(_relative_difference(base, base * f) for f in _DISAGREEMENT_FACTORS)

    assert all(0.0 < f < 1.0 for f in figures), (
        "the measure is |a-b|/max(|a|,|b|), which lives in [0,1); a factor landing outside "
        "it would be testing something the producer cannot report"
    )
    assert figures[0] < 1e-8 and figures[-1] > 0.9, (
        "the sweep must run from below any plausible band to the top of the measure's "
        "range, or a band could sit outside the sweep and survive it"
    )

    # THE STRADDLE, computed with the EXACT predicate 0.4.0 used, not an approximation of it.
    deleted_band = 1e-6
    refused = [f for f in _DISAGREEMENT_FACTORS
               if abs(base * f - base) > deleted_band * max(base * f, base)]
    passed = [f for f in _DISAGREEMENT_FACTORS if f not in refused]
    assert refused and passed, (
        "the deleted 1e-6 band must refuse SOME members and pass others, or the sweep does "
        "not bracket it and an off-by-one reintroduction has somewhere to hide"
    )

    # THE COUNT, not a lower bound. Two prose references ("six decades") promise that this
    # assertion stops the number drifting; `>= 6` does not — adding a factor in a seventh
    # decade would leave both stale and this green. Changing the sweep must now change the
    # prose in the same commit, which is what the promise was.
    decades = {math.floor(math.log10(f)) for f in figures}
    assert len(decades) == 6, (
        f"the sweep covers {len(decades)} decades ({sorted(decades)}), not the six the "
        "module comment and TEST-1's docstring both state. Update them together."
    )
    # AND THE SPAN, which is a different quantity and was confused with the count: the
    # figures run from ~1e-9 to ~1, a ratio of about nine orders of magnitude, occupying six
    # distinct decades. An earlier revision "retracted" the nine-orders claim as an
    # overclaim; it was correct, and the retraction was the error.
    assert 8.5 <= math.log10(figures[-1] / figures[0]) <= 9.5


@pytest.mark.parametrize("factor", _DISAGREEMENT_FACTORS)
def test_no_magnitude_of_disagreement_costs_the_image_and_the_figure_is_reported(
    factor, tmp_path
):
    """TEST-1 [acceptance] [invariant: INV-2] [covers: ITEM-1, ITEM-6] — NO BAND EXISTS.

    Design §12.2, verbatim: *"The affine is producer-declared and unverifiable. No gate can
    check a registration. The compensating control is the rendered overlay (§7.5) — a human
    check, not a mechanical one."*

    Read exactly: §12.2 sits under "Known weaknesses" and says no gate CAN decide this
    question — it does not forbid a producer from refusing a bundle, and the deleted check
    was not a registration check anyway. (An earlier draft of this docstring said it was
    both; corrected here rather than left standing.) What §12.2 does establish is that a
    mechanical verdict cannot settle placement, so an UNCALIBRATED mechanical verdict must
    not be the thing that decides whether the user gets the image. THE MEASUREMENT is the
    primary argument and it is in the block comment at `_APPLIED_SCALE_SOURCE`; this test is
    what holds the result shut. Perturbing `experiment.xenium`'s
    `pixel_size` alone leaves the image's own OME-XML stating the truth, so the two
    statements differ by a known amount. For EVERY factor across six decades the image is
    emitted and the artifact carries the measured figure — independently recomputed here
    from the two inputs rather than read back from the producer's own arithmetic. (The sweep
    spans nine orders of magnitude of the figure across six distinct decades; TEST-9 asserts
    both, because an earlier revision of this line confused the two and "corrected" the
    correct one.)

    THE MEASUREMENT THAT LICENSES THIS: eight real 10x bundles, XOA 1.0.1 -> 3.0.0, every
    one writing the identical decimal literal `0.2125` in both files. Observed relative
    difference exactly 0.0, spread zero — so there is no legitimate-disagreement population
    from which any band could be calibrated, `1e-6` included.
    """
    bundle = _bundle_copy(tmp_path, f"skew-{factor}")
    skewed = XF.PIXEL_SIZE_UM * factor
    _set_pixel_size(bundle, skewed)
    out = tmp_path / f"out-{factor}"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    images = [e for e in entries if e["datatype"] == "spatial/image"]
    assert images, (
        f"a relative difference of {abs(skewed - XF.PIXEL_SIZE_UM) / max(skewed, XF.PIXEL_SIZE_UM):.3e} "
        "must NOT cost the user the image. If this is red, a producer-side band has been "
        "reintroduced — which is what #269 removed, and which disables #156's overlay on "
        "exactly the bundles that need it"
    )
    assert report["images_not_emitted"] == []

    stated = images[0]["meta"]["stated_scales"]
    assert stated["agreement"] == "differs"
    # RECOMPUTED, not echoed. Reading the producer's number back would make this a
    # tautology; the expected value is derived from the two inputs this test controls.
    expected = abs(XF.PIXEL_SIZE_UM - skewed) / max(XF.PIXEL_SIZE_UM, skewed)
    assert stated["relative_difference_x"] == pytest.approx(expected, rel=1e-9)
    assert stated["relative_difference_y"] == pytest.approx(expected, rel=1e-9)
    assert stated["relative_difference_x"] > 0.0, (
        "a `differs` verdict with a zero difference would mean the two are being classified "
        "by something other than the number"
    )

    # LOSING NOTHING ELSE, EITHER. The coordinates are in micrometres and depend on no
    # pixel size at all, which is the structural half of why Xenium's scale exposure is
    # smaller than Visium's.
    assert [e for e in entries if e["datatype"] == "spatial/coordinates"]
    assert [e for e in entries if e["datatype"] == "single-cell/counts"]
    coords = CZR.read_array(out / "spatial/coordinates.zarr", "coordinates")
    ids = XF.matrix_cell_ids(bundle)
    xs, ys = XF.expected_xy(bundle, ids)
    assert np.array_equal(coords[:, 0], xs) and np.array_equal(coords[:, 1], ys)


def test_a_disagreeing_bundle_declares_which_statement_placed_its_image(tmp_path):
    """TEST-2 [acceptance] [invariant: INV-1] [covers: ITEM-2] — DECLARE THE SPACE.

    Design §7.3, verbatim: *"the design rule is: **declare the space, never the scale factor
    alone.**"*

    Emitting an image whose two vendor-stated scales disagree means choosing one of them.
    The hazard DEC-15's refusal was written against was that the choice would be SILENT.
    Refusal is not what closes that — declaration is. So on a disagreeing bundle the
    artifact must carry the full space declaration AND say which of the two conflicting
    numbers built the affine, next to both raw numbers.

    This goes red if the producer places an image on a number it does not name.
    """
    bundle = _bundle_copy(tmp_path, "declared")
    skewed = XF.PIXEL_SIZE_UM * 1.01
    _set_pixel_size(bundle, skewed)
    out = tmp_path / "out-declared"
    _, entries = XF.run_over(bundle, out)

    image = XF.entry(entries, "spatial-image-morphology")
    meta = image["meta"]

    # THE SPACE, declared in full — not a bare scale factor.
    assert meta["coordinate_space"]
    assert meta["unit"] == "micrometre"
    assert len(meta["to_space"]) == 6
    assert meta["extent"]["width"] > 0 and meta["extent"]["height"] > 0

    stated = meta["stated_scales"]
    assert stated["agreement"] == "differs"
    # BOTH raw numbers survive, so a reader can see the disagreement itself.
    assert stated["experiment_pixel_size_um"] == pytest.approx(skewed, rel=1e-12)
    assert stated["ome_physical_size_x_um"] == pytest.approx(XF.PIXEL_SIZE_UM, rel=1e-12)
    assert stated["ome_physical_size_y_um"] == pytest.approx(XF.PIXEL_SIZE_UM, rel=1e-12)
    # AND WHICH ONE WAS USED. Without this the placement is a silent pick.
    assert stated["applied_source"] == "experiment.xenium:pixel_size"
    assert stated["applied_pixel_size_um"] == pytest.approx(skewed, rel=1e-12)
    # The declaration must be TRUE of the emitted affine, not merely present: the affine is
    # the applied pixel size times the downsample factor.
    factor = meta["display_derivative"]["downsample_factor"]
    assert meta["to_space"][0] == pytest.approx(stated["applied_pixel_size_um"] * factor,
                                                rel=1e-12)
    assert meta["to_space"][0] != pytest.approx(stated["ome_physical_size_x_um"] * factor,
                                                rel=1e-9), (
        "the two candidates must be genuinely distinguishable here, or `applied_source` is "
        "asserting something this fixture cannot tell apart"
    )


def test_a_disagreement_reaches_the_user_facing_report_naming_both_numbers(tmp_path):
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-3] — THE OVERLAY'S INPUT SURVIVES.

    Design §7.5, verbatim: *"The compensating control is a **rendered overlay in the
    `report/qc`** ... **This is a required output of the importer, not a nice-to-have** — it
    is the entire verification story for step 7.3."*

    An overlay draws the cells on the image. 0.4.0's refusal deleted the image, so on
    exactly the bundles where a human most needed to look, there was nothing to look at.

    AND SINCE #301 THE OVERLAY IS BUILT. This docstring carried two earlier positions and
    both were true when written: #269's, that the image is the eventual control's INPUT and
    refusing it removes the only thing that could decide the case; and #291's, that for THIS
    producer the control was not built and asserting "the image exists" alone would stay
    green if it were cancelled outright. #301 built it here, so the assertion that was
    unavailable to both is available now: the report must carry a registration verdict, and
    the warning must send the reader to the overlay this run actually emits rather than to
    an absent one. Four things are asserted — the image exists, the disagreement is LOUD in
    the report rather than buried in `meta`, the warning names the control AND that it ran,
    and the structured `compensating_control` says the same. Restoring the refusal, deleting
    the overlay, or reverting the warning to "NOT BUILT, AND IS NOT COMING" all turn this
    red.
    """
    bundle = _bundle_copy(tmp_path, "loud")
    skewed = XF.PIXEL_SIZE_UM * 2.0
    _set_pixel_size(bundle, skewed)
    out = tmp_path / "out-loud"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    assert [e for e in entries if e["datatype"] == "spatial/image"], (
        "§7.5's registration overlay is the design's compensating control and it needs an "
        "image; refusing one here removes the only check that could have decided the case"
    )
    notes = [w for w in report["image_warnings"] if "pixel size TWICE" in w]
    assert notes, "a disagreement must be REPORTED, not merely recorded in `meta`"
    note = notes[0]
    # BOTH numbers, or a user cannot tell which file to fix.
    assert repr(skewed) in note and "PhysicalSize" in note
    assert str(XF.PIXEL_SIZE_UM) in note
    # The measured figure, and the honest limit of what this producer can say about it.
    assert "relative difference" in note
    assert "registration QC overlay" in note
    assert "applied_source" in note and "experiment.xenium:pixel_size" in note
    # And it must NOT read as a refusal any more.
    assert "is NOT emitted" not in note
    assert report["images_not_emitted"] == []

    # THE CONTROL, AND THAT IT RAN — INV-3's half, inverted by #301. This clause has carried
    # three positions and each was true when written. #269's asserted the warning does not
    # send a reader to an artifact this importer withholds. #291's asserted "NOT BUILT, AND
    # IS NOT COMING", because #156 shipped the overlay for the Visium importer only and
    # closed, so "not built" alone would have read as "not built yet" — a blind angle
    # reverted that whole clause with the entire suite green, which is why the warning's
    # VALUE is asserted rather than its presence. #301 built the overlay here, so the same
    # discipline now points the other way: the warning must say the control EXISTS and that
    # it ran on this bundle, and reverting it to either earlier wording must go red.
    assert "IS NOW BUILT" in note and "#301" in note, (
        "the warning no longer tells the reader that the control which decides this exists: "
        f"{note}"
    )
    assert "IS NOT COMING" not in note and "NOT BUILT" not in note, (
        "the warning has gone back to disclosing an ABSENT control (#291's wording), which "
        f"#301 made false: {note}"
    )
    assert "stated_scale_placements" in note, (
        "a disagreement warning must name where the two placements are scored side by side, "
        f"or the reader is told a control exists without being told what it said: {note}"
    )
    # AND THE OVERLAY REALLY RAN ON THIS BUNDLE, which is the half no wording can fake. A
    # warning that says a control exists while the report carries no verdict from it is the
    # same reassurance-with-nothing-behind-it in the opposite direction.
    qc = report["registration_qc"]
    assert qc["images"] and qc["images"][0]["verdict"] in ("pass", "fail"), (
        f"the warning names a control that produced no verdict on this bundle: {qc}"
    )
    placements = qc["images"][0]["stated_scale_placements"]
    assert len(placements) == 2, (
        "the two vendor statements DIFFER here, so the overlay must score BOTH placements — "
        f"that comparison is what decides which statement is right: {placements}"
    )
    applied = [p for p in placements if p["applied"]]
    other = [p for p in placements if not p["applied"]]
    assert len(applied) == 1 and len(other) == 1
    assert applied[0]["source"] == "experiment.xenium:pixel_size"
    assert "OME-XML" in other[0]["source"]
    # THE OVERLAY DECIDES IT, and this is the assertion that makes the claim non-vacuous.
    # `experiment.xenium` was doubled, so the applied placement is the WRONG one and the
    # image's own OME-XML carries the truth. The scores must say so.
    assert other[0]["signal_lift"] > applied[0]["signal_lift"], (
        "the applied statement is the doubled (wrong) one and the image's own statement is "
        "the vendor's original, so the overlay must score the OTHER placement higher. If it "
        f"does not, the comparison cannot decide anything: {placements}"
    )
    assert applied[0]["verdict"] == "fail" and other[0]["verdict"] == "pass", (
        f"the overlay must RULE on each placement, not merely score it: {placements}"
    )
    control = report["scale_referent"]["compensating_control"]
    assert "#301" in control["issue"]
    assert "PRODUCED by this importer" in control["status"]
    assert "NOT PRODUCED" not in control["status"], (
        "the structured disclosure has gone back to #291's absence claim, which #301 made "
        f"false: {control['status']!r}"
    )
    assert "registration QC overlay" in control["what"]
    assert control["still_not_decided"], (
        "and it must still say what the control does NOT settle, or 'PRODUCED' reads as "
        "'everything is now checked' — the same overstatement as 'judged by nothing' with "
        "the sign flipped"
    )


def test_the_stated_scale_path_holds_no_tolerance_constant_and_raises_nothing(tmp_path):
    """TEST-4 [covers: ITEM-1] — the constant is GONE, and so is the raiser.

    Replaces `test_the_tolerance_is_tight_enough_to_be_a_check_and_loose_enough_not_to_be_
    noise`, whose own justification (`assert rtol < 1e-4` ... "a 0.1% vendor error") was a
    SECOND invented number pinning the first: nothing measured said 1e-4, or 1e-6, and a
    test that asserts one arbitrary constant bounds another is not evidence.

    What is assertable without inventing a number: no tolerance attribute survives on the
    module, the old raiser is gone by NAME (so a stale caller fails loudly rather than
    quietly keeping a refusal), and the replacement returns facts for all four inputs.
    """
    module = XF.load_compute()

    assert not hasattr(module, "_STATED_SCALE_RTOL"), (
        "the agreement band is deleted, not renamed. A constant here is calibrated from "
        "the spread of a legitimate population, and eight real 10x bundles measured a "
        "spread of exactly zero — so no magnitude is supported by evidence"
    )
    assert not hasattr(module, "check_stated_scales"), (
        "the name is removed rather than aliased, so a caller expecting a REFUSAL gets an "
        "AttributeError instead of a silently absent check"
    )

    base = XF.PIXEL_SIZE_UM
    # IDENTICAL — the case eight real bundles are in.
    facts, warning = module.stated_scale_agreement(base, base, base)
    assert warning is None
    assert facts["agreement"] == "identical"
    assert facts["relative_difference_x"] == 0.0
    assert facts["applied_source"] == "experiment.xenium:pixel_size"

    # DIFFERING, by an amount far below the deleted 1e-6 — reported, not raised, and the
    # figure is the measurement rather than a verdict.
    tiny = base * (1 + 1e-9)
    facts, warning = module.stated_scale_agreement(base, tiny, base)
    assert warning is not None and "pixel size TWICE" in warning
    assert facts["agreement"] == "differs"
    assert facts["relative_difference_x"] == pytest.approx(1e-9, rel=1e-3)
    assert facts["relative_difference_y"] == 0.0, (
        "the per-axis figures are independent; folding them together would hide a "
        "single-axis disagreement, which is what a transpose looks like"
    )

    # DIFFERING by orders of magnitude — still no refusal, because 'large enough to be a
    # unit error' is itself an uncalibrated band, and `_OME_LENGTH_UM` already converts the
    # unit case upstream.
    facts, warning = module.stated_scale_agreement(base, base * 1000, base * 1000)
    assert warning is not None
    assert facts["agreement"] == "differs"

    # ABSENT — nothing to disagree with. Note the ABSENCE of the figures: a `0.0` for an
    # axis nothing was compared against would be a fabricated agreement.
    facts, warning = module.stated_scale_agreement(base, None, None)
    assert warning is None
    assert facts["agreement"] == "single-source"
    assert "relative_difference_x" not in facts
    assert "relative_difference_y" not in facts

    # UNREADABLE UNIT — the check was available and could not run, which is a third thing.
    facts, warning = module.stated_scale_agreement(
        base, module._UNREADABLE_UNIT, module._UNREADABLE_UNIT
    )
    assert warning is None
    assert facts["agreement"] == "unreadable-unit"
    assert "relative_difference_x" not in facts



def test_an_image_whose_ome_xml_states_no_scale_is_still_emitted_and_says_so(tmp_path):
    """TEST-17 arm (a) — absence of the second statement is not a disagreement.

    A vendor file with no `PhysicalSize` leaves us exactly where Visium is: one source, no
    external referent. That is a REDUCTION in assurance, not an error, so the image is
    emitted and the artifact records `single-source` rather than `identical` — otherwise a
    reader cannot distinguish "cross-checked and the same" from "never checkable".
    """
    module = XF.load_compute()
    assert module.ome_physical_size("") == (None, None)
    assert module.ome_physical_size("<Pixels SizeX=\"10\"/>") == (None, None)
    # TEST-8 [covers: ITEM-2] — FOUR outcomes now, and the widening must not collapse the
    # three the 0.4.0 design already distinguished. Nothing to disagree with here, so the
    # answer is `single-source` and — the half that matters — the measured figures are
    # ABSENT rather than `0.0`: a zero for an axis nothing was compared against would read
    # as agreement that was never established.
    facts, warning = module.stated_scale_agreement(XF.PIXEL_SIZE_UM, None, None)
    assert warning is None
    assert facts["agreement"] == "single-source"
    assert "relative_difference_x" not in facts and "relative_difference_y" not in facts
    assert "ome_physical_size_x_um" not in facts
    # A check that STOPPED RUNNING must stay distinguishable from one that was NEVER
    # AVAILABLE, which is the whole reason the sentinel exists one level down.
    unreadable, _ = module.stated_scale_agreement(
        XF.PIXEL_SIZE_UM, module._UNREADABLE_UNIT, None
    )
    assert unreadable["agreement"] == "unreadable-unit"
    assert unreadable["unreadable_unit_axes"] == ["x"]
    # (The obvious `assert unreadable["agreement"] != facts["agreement"]` was here and has
    # been DELETED: it is entailed by the two literal equality assertions and cannot fail
    # independently. An assertion that cannot fail is decoration.)

    # THE MIXED CASE, which is where the four-outcome claim was actually false. One axis
    # unreadable and the other fine: `agreement` reports on the axis that COULD be compared,
    # and the axis whose check stopped running is named rather than vanishing.
    mixed, mixed_warning = module.stated_scale_agreement(
        XF.PIXEL_SIZE_UM, module._UNREADABLE_UNIT, XF.PIXEL_SIZE_UM
    )
    assert mixed["agreement"] == "identical", (
        "the Y axis compared and agreed, so the comparison's own verdict is `identical` — "
        "collapsing the whole image to `unreadable-unit` would discard a check that ran"
    )
    assert mixed["unreadable_unit_axes"] == ["x"], (
        "and the X axis DID state a size this importer could not read. Leaving no trace of "
        "it makes a check that STOPPED RUNNING look exactly like one that was never "
        "available — which is the fold this whole field exists to prevent"
    )
    assert "relative_difference_x" not in mixed
    assert mixed["relative_difference_y"] == 0.0
    assert mixed_warning is None, (
        "the axes that could be compared agreed, so there is no DISAGREEMENT to report; the "
        "unreadable axis is reported by `emit_image` on its own channel"
    )

    x, y = module.ome_physical_size(
        '<Pixels PhysicalSizeX="0.2125" PhysicalSizeY="0.2125"/>'
    )
    assert (x, y) == (0.2125, 0.2125)
    # A non-finite or non-positive stated size is NOT a scale and must not be compared
    # against — it would report a disagreement for a file that simply declares nothing.
    assert module.ome_physical_size('<Pixels PhysicalSizeX="0" PhysicalSizeY="-1"/>') == \
        (None, None)


# ── arm (b): a scale too small to contain the cells is REPORTED ──────────────────────


def test_a_pixel_size_too_small_to_contain_the_cells_is_reported(tmp_path):
    """TEST-17 arm (b) — the GEOMETRIC leg, and its one-sidedness, both asserted.

    To reach the geometric check the two stated sources must AGREE, so both are perturbed
    together — which is precisely the case arm (a) cannot see. Shrinking the pixel size
    shrinks the image's micron extent until the cells fall outside it.

    Stated rather than implied: containment bounds the scale from BELOW only. A pixel size
    too LARGE makes the image cover more than the cells, which nothing here can see, and
    the second half of this test asserts that limitation rather than leaving a reader to
    assume the check is two-sided.
    """
    bundle = _bundle_copy(tmp_path, "tiny-pixels")
    # The prime fixture: image 5789 x 3522 px, cells reach 920.4 x 392.2 um. At the real
    # 0.2125 the image covers 1230 x 748 um. A pixel size of 0.10 covers 579 x 352 um,
    # which is smaller than the cells on BOTH axes.
    shrunk = 0.10
    _set_pixel_size(bundle, shrunk)
    _rewrite_ome_physical_size(bundle, shrunk)

    out = tmp_path / "out-tiny"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)
    assert report["images_not_emitted"] == [], (
        "the two stated scales now AGREE, so arm (a) must not fire — otherwise this test "
        "would be measuring arm (a) again and the geometric leg would be untested"
    )
    notes = [w for w in report["image_warnings"] if "covers only" in w]
    assert notes, (
        "a uniformly-shrunk scale that puts the cells outside the image must be REPORTED. It "
        "was the ONLY misregistration symptom available on this path until #301 built §7.5's "
        "overlay for this producer; it is still the only one that is pure arithmetic on "
        "extents, and it is still one-sided"
    )
    # THE WARNING MUST SEND THE READER TO A CONTROL THAT EXISTS (#301). This line has now
    # carried three positions and each was right when written. #269's asserted
    # `"check the registration overlay" in notes[0]` — which pinned, as a contract, an
    # instruction to consult a control this importer did not produce. #291 replaced it with
    # `"UNCHECKED"`, because a user following the old sentence found nothing. #301 built the
    # overlay here, so the sentence #269 wanted is finally TRUE, and the assertion is the
    # #291 one inverted: the note must point at the overlay this run emits, and must NOT
    # still be telling the reader their placement is unchecked.
    assert "READ THE REGISTRATION OVERLAY" in notes[0], (
        "the warning no longer points the reader at the control that can settle this — §7.5's "
        f"overlay, which this run emits as a `report/qc` artifact (#301): {notes[0]}"
    )
    assert "#301" in notes[0] and "report/qc" in notes[0], (
        "the warning must say WHERE the control is and which work item built it, or a reader "
        f"cannot find the artifact it names: {notes[0]}"
    )
    assert "UNCHECKED" not in notes[0], (
        "the warning has gone back to #291's disclosure that the placement is unchecked, "
        f"which #301 made false: {notes[0]}"
    )
    # AND THE NOTE STILL SAYS WHAT IT ITSELF CANNOT DO. A note that hands the question to the
    # overlay and stops there would leave a reader thinking containment arithmetic decided
    # something. It did not; it never could.
    assert "cannot decide a registration" in notes[0], (
        f"the note must still say that IT cannot decide a registration: {notes[0]}"
    )
    # THE CONTROL IT NAMES REALLY RAN, and disagreed — the cells are outside a 0.10 um/px
    # image, so the placement is wrong and the overlay must say so rather than pass.
    qc = _report(out)["registration_qc"]
    assert qc["verdict"] == "fail", (
        "the note sends the reader to the overlay; on a bundle whose cells fall outside its "
        f"own image the overlay must FAIL rather than agree with nothing: {qc['images']}"
    )

    # THE ONE-SIDEDNESS, asserted so it is not over-read: growing the scale produces NO
    # finding, because a larger image still contains the cells.
    grown = _bundle_copy(tmp_path, "huge-pixels")
    _set_pixel_size(grown, XF.PIXEL_SIZE_UM * 4)
    _rewrite_ome_physical_size(grown, XF.PIXEL_SIZE_UM * 4)
    out2 = tmp_path / "out-huge"
    _, entries2 = XF.run_over(grown, out2)
    report2 = _report(out2)
    assert [e for e in entries2 if e["datatype"] == "spatial/image"]
    assert not [w for w in report2["image_warnings"] if "covers only" in w], (
        "a 4x-too-LARGE pixel size passes the geometric check unremarked. That is a real "
        "limit of containment, asserted here so nobody reads this referent as two-sided."
    )


def _patch_ome_xml(bundle, substitute):
    """Rewrite the vendor TIFF's OME-XML in place, via `substitute(xml) -> xml`.

    The generalisation of `_rewrite_ome_physical_size` below, extracted so the UNIT can be
    patched as well as the value. The description tag is fixed-length in the file, so the
    replacement is padded inside the XML's own trailing whitespace rather than resized —
    which is what keeps these the vendor's own bytes rather than a file this test wrote.
    """
    import tifffile

    path = bundle / "morphology_focus" / "morphology_focus_0000.ome.tif"
    with tifffile.TiffFile(str(path)) as handle:
        xml = handle.ome_metadata or ""
        offset = handle.pages[0].tags["ImageDescription"].valueoffset
        count = handle.pages[0].tags["ImageDescription"].count
    patched = substitute(xml)
    if len(patched.encode()) >= count:
        # A LONGER value (a unit prefix change turns `0.2125` into `2.125e-05`) does not fit
        # a fixed-length tag. Reclaim the room from the XML's own inter-element indentation,
        # which is insignificant to every parser — rather than rewriting the file, which
        # would stop these being the vendor's own bytes in the vendor's own tag.
        patched = re.sub(r">\s+<", "><", patched)
    encoded = patched.encode()
    if len(encoded) < count:
        encoded = encoded + b" " * (count - len(encoded) - 1) + b"\0"
    assert len(encoded) <= count, (
        "the patched OME-XML does not fit the original tag even with indentation removed; "
        "widen the fixture's description tag rather than rewriting the file"
    )
    with open(path, "r+b") as fh:
        fh.seek(offset)
        fh.write(encoded)


#: The LITERAL a writer would put in the file for `0.2125 um` in each unit — NOT
#: `repr(0.2125 / factor)`.
#:
#: The distinction is the whole test. `repr(0.2125/1e4)` is `2.1249999999999998e-05`, and
#: that literal multiplied back by `1e4` returns EXACTLY `0.2125` — zero ulps, so it passes
#: under exact comparison and exercises nothing. The literal a human or a writer emits is
#: `2.125e-05`, which converts to `0.21250000000000002` — one ulp away, which is the case
#: the conversion floor exists for. An earlier draft used `repr(base/factor)` and three of
#: its four parametrised cases were consequently vacuous: a blind re-audit reverted the floor
#: and only the angstrom case went red.
_UNIT_LITERALS = {
    "cm": "2.125e-05",
    "mm": "0.0002125",
    "nm": "212.5",
    "\u00c5": "2125.0",
    "m": "2.125e-07",
    "fathom": None,          # value left alone: the point is that the UNIT is unreadable
}


def _rewrite_ome_physical_unit(bundle, unit):
    """Restate the image's physical size in `unit`, using the literal a writer would emit.

    The bundle stays self-consistent — it says the same physical thing in a different unit —
    which is the only way to test that the importer's own unit conversion does not
    manufacture a disagreement out of float64 round-off.
    """
    literal = _UNIT_LITERALS[unit]

    def substitute(xml):
        out = re.sub(r'PhysicalSize([XY])Unit="[^"]+"',
                     lambda m: f'PhysicalSize{m.group(1)}Unit="{unit}"', xml)
        if literal is not None:
            out = re.sub(r'PhysicalSize([XY])="[^"]+"',
                         lambda m: f'PhysicalSize{m.group(1)}="{literal}"', out)
        return out

    _patch_ome_xml(bundle, substitute)


def _rewrite_one_axis_unit(bundle, axis, unit):
    """Restate ONE axis's unit, leaving the other exactly as the vendor wrote it.

    Builds the mixed case: an image that states X in a unit this importer can read and Y in
    one it cannot. That case has no other constructor, and it is the one the `emit_image`
    warning branch exists for.
    """
    def substitute(xml):
        return re.sub(f'PhysicalSize{axis}Unit="[^"]+"',
                      f'PhysicalSize{axis}Unit="{unit}"', xml)

    _patch_ome_xml(bundle, substitute)


def _rewrite_ome_physical_size(bundle, value):
    """Rewrite the vendor TIFF's OME-XML `PhysicalSizeX/Y` in place.

    This is the ONLY way to build the "both sources wrong the same way" case, and it is
    what makes `test_the_residue_*` an honest measurement rather than a claim. The bytes
    are edited in the TIFF's description tag; nothing else about the file changes.
    """
    _patch_ome_xml(bundle, lambda xml: re.sub(
        r'PhysicalSize([XY])="[^"]+"',
        lambda m: f'PhysicalSize{m.group(1)}="{value}"',
        xml,
    ))


# ── the residue: what Xenium does NOT close ──────────────────────────────────────────


def test_the_residue_a_scale_wrong_the_same_way_in_both_sources_still_passes(tmp_path):
    """TEST-18 — THE HONEST RESIDUE, asserted to PASS.

    This is the direct descendant of #176's TEST-11, which asserted that its wrong artifact
    passes. The same shape holds here for a NARROWER class of error: both vendor statements
    wrong identically, by a factor small enough to keep the cells inside the image.

    NOTHING IN THIS FILE CLOSES IT, and that half is unchanged. The artifact is internally
    consistent on every one of `_reconcile_scale`'s four legs, the two stated sources agree,
    and the cells are contained — so every INTERNAL check this system has says yes, and every
    downstream micron measurement taken from the image is wrong by exactly the factor.

    AND SINCE #301 SOMETHING DOES CLOSE IT, WHICH IS THE HALF THIS DOCSTRING NOW OWES. The
    sentence here used to end: *"#156's registration overlay is the only real check, because
    the only remaining evidence is whether the cells land on the tissue a human can see."*
    That was exactly right and the overlay was not built for this producer — #291 disclosed
    that, #301 built it. So the remaining evidence is now GATHERED: the cells' micrometre
    positions come from `cells.csv.gz` and are untouched by `pixel_size`, while the image's
    affine is wrong by the factor, so the cells no longer land on the nuclei they were
    segmented from. Measured here: the 1.5x artifact below scores a signal lift of 0.000
    against a 0.4 floor.

    THE RESIDUE THEREFORE NARROWED RATHER THAN CLOSED, and the test asserts the new boundary
    rather than a slogan: a uniform error under about 2% still passes everything including
    the overlay (a 2% misscale scores 0.303). Asserting BOTH — that every internal check says
    yes AND that the overlay says no — is what keeps the measurement honest in both
    directions. Delete the overlay and the second half goes red; widen its floor past 0.303
    and `test_registration_qc.py`'s TEST-20 goes red.
    """
    bundle = _bundle_copy(tmp_path, "uniform-wrong")
    # 1.5x: large enough to ruin every micron measurement taken off the image, small enough
    # that the image (1845 x 1123 um at 1.5x) still contains the cells (920 x 392 um).
    wrong = XF.PIXEL_SIZE_UM * 1.5
    _set_pixel_size(bundle, wrong)
    _rewrite_ome_physical_size(bundle, wrong)

    out = tmp_path / "out-wrong"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    image = XF.entry(entries, "spatial-image-morphology")
    assert report["images_not_emitted"] == []
    assert not [w for w in report["image_warnings"] if "covers only" in w]
    assert image["meta"]["stated_scales"]["agreement"] == "identical", (
        "both statements were rewritten to the SAME wrong number, so the cross-check ran "
        "and found them identical — which is exactly why it cannot see this class of error"
    )
    assert image["meta"]["stated_scales"]["relative_difference_x"] == 0.0
    # And it is WRONG, consistently. The DOWNSAMPLE FACTOR is derived from the artifact
    # rather than hardcoded, because the wrong scale moves it too: `ceil(0.5/0.31875) = 2`
    # where the true 0.2125 gives 3. That is worth noticing — a uniformly wrong scale
    # changes the emitted PIXEL GRID as well as the numbers describing it, and the result
    # is still internally consistent on every leg, which is precisely the point.
    derivative = image["meta"]["display_derivative"]
    factor = derivative["downsample_factor"]
    assert derivative["original_resolution_um"] == pytest.approx(wrong, rel=1e-12)
    assert image["meta"]["to_space"][0] == pytest.approx(wrong * factor, rel=1e-12)
    assert derivative["applied_resolution_um"] == pytest.approx(wrong * factor, rel=1e-12)
    assert image["meta"]["to_space"][0] != pytest.approx(XF.PIXEL_SIZE_UM * factor,
                                                         rel=1e-9), (
        "the emitted affine must genuinely differ from the truthful one, or this test is "
        "measuring nothing"
    )

    # THE MEASUREMENT: a fully self-consistent, uniformly misscaled artifact passed every
    # check this system has, INCLUDING the OME header a generic reader measures with.
    # Recorded, not fixed.
    with __import__("tifffile").TiffFile(str(out / image["path"])) as handle:
        xml = handle.ome_metadata or ""
    assert f'PhysicalSizeX="{wrong * factor}"' in xml, (
        "even the OME header carries the wrong number, consistently — which is exactly why "
        "no consistency check can see it"
    )

    # AND THE ONE CHECK THAT IS NOT A CONSISTENCY CHECK SEES IT (#301). This is the assertion
    # that turns the paragraph above from a standing residue into a MEASURED boundary. The
    # cells' micrometre positions are the vendor's own and are untouched by `pixel_size`; the
    # image's affine is wrong by 1.5x; so the cells no longer land on the nuclei they were
    # segmented from, and the overlay's referent is outside the artifact, so nothing about
    # the artifact's internal consistency helps it.
    qc = report["registration_qc"]
    assert qc["verdict"] == "fail", (
        "a 1.5x uniform misscale passed §7.5's registration overlay. That overlay is the "
        "named mitigation for #176's residue and the ONLY check here with an external "
        f"referent; if it cannot see this, the residue is back to unqualified: {qc['images']}"
    )
    image_qc = qc["images"][0]
    assert image_qc["signal_lift"] < image_qc["signal_lift_floor"], (
        f"the lift must be BELOW the floor, not merely the verdict red: {image_qc}"
    )
    # THE CONTROL, in this test, on this bundle: the same importer over the UNMUTATED fixture
    # must PASS. Without it "the overlay fails" is satisfied by an overlay that fails on
    # everything — which would be a check that cannot discriminate, i.e. the defect this whole
    # arm is about.
    control_out = tmp_path / "out-residue-control"
    XF.run_over(_bundle_copy(tmp_path, "residue-control"), control_out)
    control_qc = _report(control_out)["registration_qc"]
    assert control_qc["verdict"] == "pass", (
        "the UNMUTATED fixture must pass the same overlay, or 'the misscaled bundle fails' "
        f"proves nothing about the misscale: {control_qc['images']}"
    )


def test_the_coordinates_are_immune_to_the_residue(tmp_path):
    """TEST-18 — the half of #176's limitation Xenium removes STRUCTURALLY.

    On Visium the wrong scale contaminates the COORDINATES' declared
    `microns_per_pixel`, so a neighbour-graph radius resolved through
    `require_micron_scale` is wrong by the factor. On Xenium the coordinates are already
    micrometres and the space declares no scale at all — `require_micron_scale` answers
    `1.0` BY DEFINITION — so a pixel_size wrong by any factor whatsoever leaves every
    micron measurement over the CELLS exactly right. Only the image is affected.

    That is not a mitigation, it is the absence of the exposure, and it is worth pinning.
    """
    import spatial_declarations as SD

    bundle = _bundle_copy(tmp_path, "immune")
    _set_pixel_size(bundle, XF.PIXEL_SIZE_UM * 1.5)
    _rewrite_ome_physical_size(bundle, XF.PIXEL_SIZE_UM * 1.5)
    out = tmp_path / "out-immune"
    _, entries = XF.run_over(bundle, out)

    coord = XF.entry(entries, "spatial-coordinates")
    assert "microns_per_pixel" not in coord["meta"]
    assert SD.require_micron_scale(coord["meta"], consumer="a neighbour graph") == 1.0
    coords = CZR.read_array(out / "spatial/coordinates.zarr", "coordinates")
    ids = XF.matrix_cell_ids(bundle)
    xs, ys = XF.expected_xy(bundle, ids)
    assert np.array_equal(coords[:, 0], xs) and np.array_equal(coords[:, 1], ys)


# ── the two populations the eight-bundle measurement does NOT cover ──────────────────
#
# The measurement behind #269 (eight published 10x bundles, XOA 1.0.1 -> 3.0.0, relative
# difference exactly 0.0) was taken on files 10x itself wrote, all in micrometres. Two real
# populations sit outside it, and both were found by audit rather than by the measurement.
# They get pinned tests so the behaviour is a stated position instead of an accident.


@pytest.mark.parametrize("unit", ["cm", "mm", "nm", "Å", "m"])
def test_a_bundle_stating_its_scale_in_another_unit_is_not_accused_of_disagreeing(
    unit, tmp_path
):
    """TEST-10 [covers: ITEM-1] — OUR OWN ARITHMETIC MUST NOT MANUFACTURE A DISAGREEMENT.

    `_OME_LENGTH_UM` converts the OME-XML's stated unit to micrometres, and that conversion
    is float64 multiplication. `0.00002125` cm and `2125.0` angstrom both convert to
    `0.21250000000000002` — 1.0 ulp away from the `0.2125` in `experiment.xenium`, for a
    bundle that is perfectly self-consistent and says so twice.

    Under exact `!=` that bundle was told "the two are NOT the same number ... at most one
    of them is right", over a difference this importer created. That is the false accusation
    `_OME_LENGTH_UM`'s own comment exists to prevent, re-created one step later. The
    `_CONVERSION_ULPS` floor is what separates our rounding from a real difference in the
    WRITTEN value, and it is derived from an enumeration of this importer's own rounding
    steps — not from any claim about vendor precision, and it withholds no artifact.
    """
    module = XF.load_compute()
    literal = _UNIT_LITERALS[unit]
    converted = float(literal) * module._OME_LENGTH_UM[unit]

    bundle = _bundle_copy(tmp_path, f"unit-{unit}")
    _rewrite_ome_physical_unit(bundle, unit)
    out = tmp_path / f"out-unit-{unit}"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    stated = XF.entry(entries, "spatial-image-morphology")["meta"]["stated_scales"]
    assert stated["agreement"] == "identical", (
        f"a bundle restating 0.2125 um as {literal} {unit} says the SAME physical thing; "
        "calling that a disagreement blames the bundle for this importer's own float64 "
        "conversion"
    )
    assert not [w for w in report["image_warnings"] if "pixel size TWICE" in w]
    # The figure is still REPORTED in full — the floor labels, it does not hide.
    assert stated["relative_difference_x"] < 1e-15
    assert stated["relative_difference_y"] < 1e-15

    # NON-VACUITY, per case. A parametrised case whose literal happens to round-trip EXACTLY
    # would pass with the floor deleted, so it proves nothing about the floor — and three of
    # the four cases in the first draft were exactly that. TEST-15 asserts the sweep as a
    # whole is not vacuous; this asserts the case at least stays inside the floor it claims.
    assert _unit_literal_ulps(module, unit) <= module._CONVERSION_ULPS, (
        f"{unit} converts to {converted!r}, "
        f"{_unit_literal_ulps(module, unit)} ulp from {XF.PIXEL_SIZE_UM!r} — outside the "
        "floor this importer's own arithmetic is supposed to stay inside"
    )


def _unit_literal_ulps(module, unit):
    """How far `_UNIT_LITERALS[unit]`, converted, lands from `XF.PIXEL_SIZE_UM`, in ULPs.

    SELF-CONTAINED on purpose. An earlier version had the parametrised test write its
    measurements into a module-level dict that a later test read, so the later test's meaning
    depended on collection order and on nobody running it with `-k`. A test whose assertion
    silently measures an empty dict is the same false green everything else here is about.
    """
    converted = float(_UNIT_LITERALS[unit]) * module._OME_LENGTH_UM[unit]
    return abs(converted - XF.PIXEL_SIZE_UM) / math.ulp(
        max(converted, XF.PIXEL_SIZE_UM)
    )


def test_at_least_one_unit_case_actually_exercises_the_conversion_floor():
    """TEST-15 [covers: ITEM-8] — the unit sweep must not be all-vacuous.

    A unit case whose literal round-trips to the identical double (`0.0002125` mm does)
    passes with the floor DELETED. Those cases are worth keeping — they are the common
    shape — but a sweep made only of them proves nothing, and the first draft was one:
    reverting the floor turned exactly one of its four cases red.

    Computed here from `_UNIT_LITERALS` and the module's own `_OME_LENGTH_UM`, so this holds
    whatever order the file is collected in and however it is filtered.
    """
    observed = {unit: _unit_literal_ulps(XF.load_compute(), unit)
                for unit, literal in _UNIT_LITERALS.items() if literal is not None}
    assert observed, "the unit table is empty; there is nothing to be non-vacuous about"

    # THE SWEEP HAS TWO KINDS OF CASE AND BOTH ARE WANTED, so both are named rather than
    # left for a later reader to discover one of them is doing nothing:
    #
    #   ROUNDING  (cm, angstrom) — the literal converts to a DIFFERENT double, so the case
    #             fails with the conversion floor deleted. This is what the floor is for.
    #   EXACT     (mm, nm, m)    — the literal converts back bit-for-bit, so the case passes
    #             with or without the floor. It is the COMMON shape and worth covering as a
    #             regression guard, but it proves nothing about the floor and must not be
    #             counted as if it did.
    rounding = {u: n for u, n in observed.items() if n > 0}
    exact = {u: n for u, n in observed.items() if n == 0}
    assert rounding, (
        "every unit case round-tripped to the identical double, so ALL of them pass with "
        f"the conversion floor deleted. Observed: {observed}"
    )
    assert exact, (
        "and the sweep should still carry the common shape — a unit whose literal converts "
        f"back exactly — or it is only testing the exception. Observed: {observed}"
    )
    # AND THE DOCUMENTED CASE SPECIFICALLY. `cm` is the example the module comment, the
    # manifest changelog and three docstrings all name as the motivating one. If the sweep's
    # literal for it ever stops rounding, every one of those prose references is describing
    # a case the suite does not exercise — which is exactly how the first draft shipped a
    # documented example that passed with the floor deleted.
    assert "cm" in rounding, (
        "the `cm` case is the one every comment cites; it must be the literal a writer would "
        "emit (`2.125e-05`, which rounds) and not `repr(0.2125/1e4)` (which does not). "
        f"Observed: {observed}"
    )


def test_a_scale_re_exported_through_float32_is_reported_as_the_difference_it_is(tmp_path):
    """TEST-11 [covers: ITEM-1, ITEM-2] — the deliberate position on re-exported images.

    A bioformats or QuPath round-trip stores the physical size as 32-bit float and writes it
    back, moving `0.2125` to `0.21250000596046448` — a relative difference of 2.80e-08. That
    is a real difference in the number the vendor's file now WRITES, ~2.1e8 ulp, eight
    orders of magnitude above what this importer's own conversion can produce. So it is
    reported as `differs`, with the figure, and the image is emitted.

    Pinned because the two neighbouring positions are both wrong and both plausible:
    swallowing it would need a tolerance nothing measured (which is #269 itself), and
    refusing it would cost a user their image over a lossless-looking re-export. 0.4.0's
    `1e-6` band swallowed it silently — that band was ~17x LOOSER than float32's worst case,
    not tighter as #269's text supposed.
    """
    import numpy as np

    bundle = _bundle_copy(tmp_path, "float32-roundtrip")
    round_tripped = float(np.float32(XF.PIXEL_SIZE_UM))
    assert round_tripped != XF.PIXEL_SIZE_UM
    _rewrite_ome_physical_size(bundle, round_tripped)
    out = tmp_path / "out-float32"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    assert report["images_not_emitted"] == [], (
        "a re-exported image must not cost the user their image — that is exactly the "
        "outcome #269 removed"
    )
    stated = XF.entry(entries, "spatial-image-morphology")["meta"]["stated_scales"]
    assert stated["agreement"] == "differs", (
        "the file really does write a different number now; calling it `identical` would "
        "need a tolerance no measurement supports, which is the defect #269 is about"
    )
    expected = abs(round_tripped - XF.PIXEL_SIZE_UM) / max(round_tripped, XF.PIXEL_SIZE_UM)
    assert stated["relative_difference_x"] == pytest.approx(expected, rel=1e-9)
    assert 1e-9 < expected < 1e-7, (
        "and this population sits between our own rounding floor and any real units error, "
        "which is why neither of the two neighbouring behaviours is right"
    )
    # The warning must give the reader enough to tell this apart from a units error.
    note = [w for w in report["image_warnings"] if "pixel size TWICE" in w][0]
    assert "32-bit float" in note


def test_an_unreadable_unit_reaches_the_user_facing_report(tmp_path):
    """TEST-12 [covers: ITEM-3] — the degraded-check warning, end to end.

    `agreement == "unreadable-unit"` had NO end-to-end coverage anywhere in this package:
    every assertion on it was a unit-level check of the returned dict, so renaming the
    verdict would have deleted the user-facing warning in silence. This drives a bundle
    whose OME-XML states its size in a unit `_OME_LENGTH_UM` does not carry and asserts the
    warning reaches `report["image_warnings"]` — and that the image is still emitted, since
    losing the cross-check is a REDUCTION in assurance, not an error.
    """
    bundle = _bundle_copy(tmp_path, "unreadable-unit")
    _rewrite_ome_physical_unit(bundle, "fathom")
    out = tmp_path / "out-unreadable"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    assert [e for e in entries if e["datatype"] == "spatial/image"]
    assert report["images_not_emitted"] == []
    stated = XF.entry(entries, "spatial-image-morphology")["meta"]["stated_scales"]
    assert stated["agreement"] == "unreadable-unit"
    assert stated["unreadable_unit_axes"] == ["x", "y"]
    notes = [w for w in report["image_warnings"]
             if "cross-check could not run" in w]
    assert notes, (
        "a check that STOPPED RUNNING must say so where a user reads it; recording it only "
        "in `meta` is how a degraded check becomes indistinguishable from an absent one"
    )
    assert "both axes" in notes[0]


def test_a_non_scale_pixel_size_never_produces_a_fabricated_agreement():
    """TEST-13 [covers: ITEM-1] — zero is not a scale, and must not read as agreement.

    The first cut carried `difference = (... / denominator) if denominator else 0.0` as a
    defensive guard. It was unreachable from `emit_image` — and it answered a DIRECT call
    with `agreement: "identical"` and a relative difference of `0.0`, which is precisely the
    fabricated agreement the function's own docstring forbids. The one line meant to be
    defensive was the only line in the module that contradicted its stated rule.

    A caller with a non-scale on either side now gets "there was nothing usable to compare",
    which is true, rather than "the two agree", which is not — and no `ZeroDivisionError`,
    which would be a third wrong answer.

    Added after a MUTATION round, not after a review: deleting the guard was itself
    uncovered, so re-introducing it would have gone unnoticed.
    """
    module = XF.load_compute()
    for pixel_size in (0.0, -1.0, float("nan"), float("inf")):
        with pytest.raises(ValueError, match="is not a scale"):
            module.stated_scale_agreement(pixel_size, 0.2125, 0.2125)
    # THE POINT IS THAT NO VERDICT IS INVENTED. Two earlier spellings each invented one and
    # each was caught by a blind audit: `identical` with a 0.0 difference (a fabricated
    # agreement), and `single-source` for an image that HAD stated a second scale — which
    # also silently dropped `ome_physical_size_*_um`. "The caller passed a non-scale" is not
    # something the bundle said, so there is no honest label for it.
    #
    # The production path is unaffected: `emit_image` refuses a non-positive `pixel_size`
    # before this is reached.
    good, warning = module.stated_scale_agreement(XF.PIXEL_SIZE_UM, 0.2125, 0.2125)
    assert good["agreement"] == "identical" and warning is None

    # And the other direction: `ome_physical_size` already refuses a non-positive stated
    # size, so it arrives here as `None` rather than as a zero to divide by.
    assert module.ome_physical_size('<Pixels PhysicalSizeX="0" PhysicalSizeY="-1"/>') == \
        (None, None)


def test_ONE_axis_stated_in_an_unreadable_unit_still_reaches_the_report(tmp_path):
    """TEST-16 [covers: ITEM-3, ITEM-8] — the mixed case, END TO END.

    THE HUNK THIS COVERS HAD NO COVERAGE AT ALL, and a blind re-audit proved it: reverting
    `emit_image`'s guard to the `elif agreement == "unreadable-unit"` spelling it argues
    against left the whole suite green, and the two single-axis message branches were dead
    to every test. TEST-12 drives BOTH axes to an unreadable unit — which the OLD spelling
    caught too — so it never tested the change.

    The case that only the new spelling catches is one axis readable and the other not. The
    comparison still has a verdict from X, so `agreement` is `identical`; the check on Y
    STOPPED RUNNING, and under the old spelling nothing anywhere said so. A degraded check
    that looks exactly like a complete one is the single failure mode `stated_scales` exists
    to prevent, and it was reintroduced one field over by the fix for it.
    """
    bundle = _bundle_copy(tmp_path, "mixed-unit")
    _rewrite_one_axis_unit(bundle, "Y", "fathom")
    out = tmp_path / "out-mixed"
    _, entries = XF.run_over(bundle, out)
    report = _report(out)

    assert [e for e in entries if e["datatype"] == "spatial/image"]
    assert report["images_not_emitted"] == []

    stated = XF.entry(entries, "spatial-image-morphology")["meta"]["stated_scales"]
    assert stated["agreement"] == "identical", (
        "X was readable and agreed, so the comparison that RAN has a verdict; collapsing the "
        "whole image to `unreadable-unit` would discard a check that succeeded"
    )
    assert stated["unreadable_unit_axes"] == ["y"]
    assert "relative_difference_x" in stated
    assert "relative_difference_y" not in stated, (
        "no figure for an axis nothing was compared on — absence, never a fabricated 0.0"
    )

    notes = [w for w in report["image_warnings"] if "cross-check could not run" in w]
    assert notes, (
        "this is the assertion the whole fix exists for: with the old `elif` spelling the "
        "verdict is `identical`, so no warning was emitted and the user was never told that "
        "half the cross-check did not run"
    )
    assert "axis Y" in notes[0] and "both axes" not in notes[0], (
        "and it must name WHICH axis — the single-axis message branch was dead to the suite "
        "until this test existed"
    )
    # THE SECOND TERNARY, which the first version of this test left unpinned: collapsing
    # `{'at all' if both else f'on {axes}'}` to the constant "at all" kept the WHOLE package
    # suite green while telling a user the cross-check "could not run at all" when it ran on
    # X — a degraded check reported as a wholly absent one, which is the inverse of the
    # failure the surrounding code argues against and just as misleading.
    assert "on Y" in notes[0] and "at all" not in notes[0], (
        "the message must say the check could not run ON Y, not that it could not run at "
        "all — X compared and agreed"
    )


def test_the_conversion_floor_is_pinned_from_both_sides():
    """TEST-14 [covers: ITEM-8] — `_CONVERSION_ULPS` must not drift from its derivation.

    A branch whose subject is an unfounded constant does not get to ship a constant nothing
    pins. A blind re-audit showed the first version was unpinned across SEVEN orders of
    magnitude: every value from 1 to ~7e6 left the suite green, so nothing distinguished the
    derived constant from an arbitrary one — which is the exact defect the surrounding prose
    claimed to have cured.

    Both bounds are recomputed here rather than asserted as literals:

    * **From below, by MEASUREMENT.** Every unit in `_OME_LENGTH_UM`, for a range of
      quantities restated by EXACT DECIMAL SCALING (what a vendor actually writes), must
      land inside the floor — otherwise a self-consistent bundle is accused of disagreeing.
    * **From above, by the ENUMERATION.** `_STATED_SCALE_ULP_STEPS` is the module's own list
      of rounding steps; their sum is the most our arithmetic can move the two numbers apart,
      and the constant may not exceed it. Widening it past the enumeration turns it into a
      vendor tolerance, which is what #269 deleted. Both the size of each entry AND the
      number of entries are constrained — bounding only the sizes still let a fifth term be
      appended, which a blind round demonstrated.

    THE TWO BOUNDS MEET, so this determines the constant to a single value: 2.0 measured
    from below, 2.0 proved from above. An earlier version of this test measured only 1.0 —
    its hand-picked quantities never reached the bound — and honestly reported an interval
    [1, 2] that does not exist. `_CONVERSION_ULPS = 1` passed then; it is refused now, and it
    would have been WRONG in production: a bundle stating `0.05177 um` as `517.7` angstrom is
    self-consistent and 2.0 ulp apart, and at 1 it would have been reported as disagreeing.
    """
    module = XF.load_compute()
    floor = module._CONVERSION_ULPS

    # ── from above: the module's own enumeration, summed here rather than trusted ──
    enumerated = sum(cost for _step, cost in module._STATED_SCALE_ULP_STEPS)
    assert enumerated > 0
    assert floor <= enumerated, (
        f"_CONVERSION_ULPS = {floor} exceeds its own enumerated bound of {enumerated} ulp "
        f"({[step for step, _ in module._STATED_SCALE_ULP_STEPS]}). Beyond the enumeration "
        "it stops bounding OUR error and becomes a tolerance for the vendor's — which is "
        "the constant #269 deleted."
    )

    # ── each step is one CORRECTLY-ROUNDED operation, so none may cost more than half an
    #    ulp. Without this the enumeration is a hand-written tuple nothing constrains:
    #    inflating one entry to 5.0 would let the constant be raised to 6 with both bounds
    #    below still satisfied, which is the "becomes a vendor tolerance" outcome the
    #    assertion above says it prevents. Half an ulp is not a chosen figure — it is what
    #    correctly-rounded IEEE-754 arithmetic means.
    for step, cost in module._STATED_SCALE_ULP_STEPS:
        assert 0 < cost <= 0.5, (
            f"step {step!r} claims {cost} ulp; a single correctly-rounded float64 operation "
            "errs by at most half an ulp, so a larger entry is not an enumeration of "
            "rounding steps any more"
        )

    # ── from above, part two: the enumeration's LENGTH, not only each entry's size ──
    #
    # Bounding each cost at half an ulp stops one entry being inflated; it does not stop a
    # FIFTH entry being appended. A blind round proved that gap by appending exactly the
    # spurious "the measure itself" term the module comment records as an earlier draft's
    # mistake and raising the constant to 2.5 — green. The conversion performs four rounding
    # operations and no more, so the count is asserted with them named.
    assert len(module._STATED_SCALE_ULP_STEPS) == 4, (
        "the conversion this floor bounds performs exactly four roundings — the two decimal "
        "literals becoming float64, the `_OME_LENGTH_UM` factor becoming float64, and the "
        "multiply. A fifth entry means either a fifth operation (name it) or the enumeration "
        f"is being padded to license a larger constant. Got: "
        f"{[step for step, _ in module._STATED_SCALE_ULP_STEPS]}"
    )

    # ── from below: the measurement, over every unit the importer will convert ──
    #
    # THE LITERALS ARE BUILT BY EXACT DECIMAL SCALING, not by dividing in float64. That
    # distinction is the whole validity of this sweep and an earlier version got it wrong.
    #
    # A vendor restating `0.2125 um` in centimetres does not compute `float64(0.2125) /
    # float64(1e4)`; it writes the exact decimal `0.00002125`. Those are DIFFERENT doubles
    # (2.125e-05 vs 2.1249999999999998e-05), so a sweep that generates its literals by float
    # division is measuring a division error the vendor never makes — and the earlier version
    # then had to add a round-trip filter to discard the mismatch, which threw away two of
    # the four `cm` spellings — the pair every docstring cites. STATED PRECISELY, because an
    # earlier version of this comment overstated it: the old sweep's measured worst was also
    # 1.0 ulp, attained at `2125.0` angstrom instead, so the BOUND did not move. What was
    # wrong is that the number was being measured on a value the vendor never writes, and the
    # case the prose named was not the case being measured. A blind round caught it.
    #
    # Scaling in `Decimal` removes both problems at once: every literal is an exact
    # restatement of the same physical quantity (the factors are powers of ten), so nothing
    # needs filtering and nothing is excluded. What remains is exactly the error this
    # importer's own `float(literal) * factor` introduces, which is what the floor bounds.
    # THE LIST MUST REACH THE ENUMERATED BOUND, or the measurement is a floor on nothing.
    # A hand-picked list that topped out below the bound was the previous version's defect:
    # it reported 1.0 and concluded the evidence narrowed the constant only to [1, 2]. It
    # does better than that — `0.05177 um` restated as `517.7` angstrom lands at exactly
    # 2.0 ulp — so measurement MEETS enumeration and the constant is determined to a single
    # value. The last three entries are there for that, and the assertion below requires it.
    quantities = ["0.2125", "0.1", "0.85", "1", "2.125", "0.001", "1000",
                  "0.3", "0.5", "0.4250", "12.5", "0.000625",
                  "0.05177", "0.01373", "0.0009034"]
    worst, worst_case, total = 0.0, None, 0
    for text in quantities:
        base = float(text)
        exact = decimal.Decimal(text)
        for unit, factor in module._OME_LENGTH_UM.items():
            scaled = exact / decimal.Decimal(repr(factor))
            literal = format(scaled.normalize(), "f")
            converted = float(literal) * factor
            total += 1
            if not (math.isfinite(converted) and converted > 0):
                continue
            # THE PRECONDITION THE ENUMERATION RESTS ON, checked rather than assumed.
            # Summing half-ulps taken at four magnitudes bounds the error only while every
            # intermediate is a NORMAL float64. A blind round showed the claim standing
            # without that qualifier and broke it: `1e-303 um` restated in metres has a
            # SUBNORMAL literal and lands 12 ulp out, `2e-305` lands 415 out. No pixel size
            # is within 300 orders of magnitude of that, so the sweep stays in the normal
            # range — and asserts that it does, rather than trusting the quantity list.
            assert abs(float(literal)) >= _SMALLEST_NORMAL and base >= _SMALLEST_NORMAL, (
                f"{text} um restated as {literal} {unit} leaves the normal float64 range, "
                "where the enumerated bound does not hold. The sweep must stay inside the "
                "precondition it is measuring under"
            )
            ulps = abs(converted - base) / math.ulp(max(converted, base))
            if ulps > worst:
                worst, worst_case = ulps, (text, unit, literal, converted)
    assert total >= 100, f"the sweep ran only {total} combinations; it is not a sweep"
    assert worst > 0, (
        "the sweep found no conversion that moves the value at all, so it is not measuring "
        "the thing the floor exists for"
    )
    assert worst <= floor, (
        f"_CONVERSION_ULPS = {floor} is below the measured worst case {worst} ulp at "
        f"{worst_case!r}; a self-consistent bundle in that unit would be reported as "
        "disagreeing over this importer's own rounding. NOTE: raising the constant is only "
        f"available up to the enumerated bound of {enumerated} — beyond that the measurement "
        "is telling you the ENUMERATION is wrong (a rounding step is missing, or an "
        "intermediate left the normal float64 range), not that the constant is too low."
    )
    # AND THE MEASUREMENT MUST MEET THE ENUMERATION — this is what closes the constant to a
    # single value instead of an interval. Asserted as a PROPERTY of the measured maximum and
    # not as the identity of whichever combination attained it first: `worst` updates on
    # strict `>`, so `worst_case` is merely the first of however many tie. An earlier version
    # asserted that identity, which pinned dict iteration order, said nothing about the
    # module, and reddened on any attempt to ADD a quantity that measured higher — it made
    # the sweep un-strengthenable, which is how the under-measurement survived a round.
    # Only the LOWER case can reach this line: `worst <= floor <= enumerated` is already
    # established above, so `worst > enumerated` fires there instead — which is why that
    # assertion now carries the "the enumeration is wrong" half of the diagnosis and this one
    # does not pretend to.
    assert worst == enumerated, (
        f"the sweep's worst case is {worst} ulp but the enumeration proves {enumerated}, so "
        f"the evidence pins _CONVERSION_ULPS only to the interval [{worst}, {enumerated}] "
        "rather than to a value. The population is missing the case that attains the bound. "
        "NOTE BEFORE WIDENING THE QUANTITY LIST: of the eight distinct factors in "
        "`_OME_LENGTH_UM`, only 1e-4 (the angstrom aliases) has an envelope above 2, so only "
        "an angstrom restatement can attain 2.0. If those aliases have been removed, no "
        "quantity can reach it and the correct fix is to LOWER the constant to the new "
        f"measured bound, not to add quantities. Attained at {worst_case!r}."
    )
    # And the case every comment cites must still be present and non-trivial, even though it
    # is not the maximum — otherwise the module comment and three docstrings would describe a
    # case nothing exercises.
    for text, unit in (("0.2125", "cm"),):
        factor = module._OME_LENGTH_UM[unit]
        literal = format((decimal.Decimal(text) / decimal.Decimal(repr(factor))).normalize(), "f")
        converted = float(literal) * factor
        ulps = abs(converted - float(text)) / math.ulp(max(converted, float(text)))
        assert text in quantities and 0 < ulps <= floor, (
            f"the documented case {text} um -> {literal} {unit} must be in the sweep and must "
            f"actually round; measured {ulps} ulp"
        )

    # ── AND THE FLOOR MUST NOT SWALLOW A LITERAL THAT SAYS A DIFFERENT NUMBER ──
    #
    # The property the discarded round-trip filter was reaching for, asserted directly
    # instead. A truncated spelling is the writer stating a materially different quantity,
    # and it must land far outside the floor — otherwise "our own rounding" has quietly
    # become a tolerance for the vendor's, which is what #269 deleted.
    # Asserted with the PREDICATE ITSELF, not with a chosen multiple of the floor. An
    # earlier spelling here was `truncated_ulps > floor * 1e6`, and `1e6` was a number
    # nothing derived — an arbitrary constant smuggled into a branch about arbitrary
    # constants. What is actually wanted has no number in it: the production classifier must
    # say these are different.
    #
    # WHAT COUNTS AS A TRUNCATION is decided by DECIMAL DIGIT COUNT, not by comparing the
    # converted result — a distinction two successive drafts of this assertion got wrong and
    # its own run caught both times. `%.6g` of `0.000085` is `8.5e-05`: nothing is truncated,
    # and any ulp that appears afterwards is conversion error, which is precisely what the
    # floor is FOR. Worse, deriving the stated value as `quantity / 1e4` reintroduces the
    # very float-division error this whole test was rewritten to remove, so even the
    # "did the spelling change it" check answered yes for a faithful literal.
    #
    # A literal with `d` significant digits truncates iff the exact decimal has more than
    # `d`. That is a statement about the DECIMAL, decided before any float arithmetic
    # happens, and it is the only non-circular way to ask the question.
    checked = 0
    for text in (repr(XF.PIXEL_SIZE_UM * math.pi), repr(1 / 3), "0.85", "12.5"):
        quantity = float(text)
        stated_exact = decimal.Decimal(text) / decimal.Decimal("10000")
        significant = len(stated_exact.normalize().as_tuple().digits)
        for digits in (6, 4, 3):
            if digits >= significant:
                continue          # the spelling holds every digit — nothing is truncated
            truncated = float(f"%.{digits}g" % float(stated_exact)) * 1e4
            checked += 1
            assert not module._within_our_own_rounding(truncated, quantity), (
                f"a {digits}-significant-digit spelling of {stated_exact} (which needs "
                f"{significant}) is a MATERIALLY different number and must be reported as a "
                "difference. If the floor swallows it, 'this importer's own rounding' has "
                "become a tolerance for the vendor's — which is exactly what #269 deleted. "
                f"({abs(truncated - quantity) / math.ulp(max(truncated, quantity))} ulp "
                f"against a floor of {floor})"
            )
    assert checked >= 6, (
        f"only {checked} genuine truncations were produced, so this assertion is barely "
        "exercised — widen the quantities or the digit widths"
    )

    # (An `assert floor < float32_ulps / 1e6` stood here and was REMOVED. With the
    # enumeration assertions above forcing `floor <= 2.0` it needed `floor >= 214.75` to
    # fail — provably unreachable, so it could not discriminate. The property it reached for
    # is covered where it can actually bite: TEST-11 asserts a 32-bit-float re-export is
    # still reported as `differs`, and the truncation loop above asserts the same for any
    # materially different decimal.)
