#!/usr/bin/env python3
# ruff: noqa
"""#301 — design §7.5's registration QC overlay, and the proof that it DISCRIMINATES.

## The claim this file has to make non-vacuous

The correctness of an overlay is a VISUAL claim, and a visual claim is the kind that goes
vacuous by default. "A valid PNG was written" is satisfied identically by a correct overlay
and by a renderer that ignored the mapping entirely and laid its circles on an arbitrary
lattice — the sibling module's own comments record a blind audit doing exactly that and
watching the whole suite stay green. So the question every test here is written against is:

    **how would a WRONG placement make this go red?**

Three tests answer it by making the placement wrong and observing the failure, on REAL vendor
bundles through the REAL importer:

* TEST-8 re-scores the emitted artifact's own pixels and the vendor's own cells through four
  wrong affines — a 2x misscale, a 0.5x misscale, a transpose, and a 20 um translation — and
  requires the verdict to flip, the lift to collapse toward chance, and the DRAWN MARK
  POSITIONS to move.
* TEST-9 drives an import over a bundle whose two vendor pixel-size statements disagree, with
  `experiment.xenium` carrying the wrong one, and requires the overlay to score the OTHER
  statement higher — which is §7.5's control doing the job #301 exists for.
* TEST-20 re-measures both ends of `SIGNAL_LIFT_FLOOR`'s derivation and requires the constant
  to sit strictly between them.

And `test_scale_referent.py`'s residue test carries the fourth: a 1.5x scale wrong the SAME
way in BOTH vendor statements — internally consistent on every leg, the case #176 recorded as
caught by nothing — is now FAILED by this overlay, with the unmutated fixture passing as the
control.

## Why the thresholds are exercised on their boundaries

`registration_verdict` is a separate callable so every threshold can be driven ON its boundary
without a file on disk. That is not tidiness. The sibling module records a blind audit setting
its own floor to 0.03 and then to 0.99 with the whole suite green both times, because the only
values any test ever observed were the two extremes — a threshold whose observed inputs are
only the extremes is pinned by nothing and can be moved anywhere in between. TEST-4 observes
each threshold at, and one float step past, its own value.

## The one way this statistic can go VACUOUSLY GREEN, and the test for it

`signal_lift` is a one-class measure, so unlike Youden's J it cannot go meaningfully negative:
the worst a wrong affine drives it to is about 0. What an INVERTED polarity call produces is
not a failure but a PASS — a mask covering nearly the whole frame, on which every cell "lands
on signal" whatever the affine. TEST-4's third leg is `MASK_FRACTION_CEILING`, which refuses
to score at all above 50% coverage, and it is the branch in this module that exists to prevent
a false green rather than to catch a failure.
"""
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

_XENIUM = XF.PKG


def _load_qc():
    """`compute/registration_qc.py`, by PATH, under a SUFFIXED name.

    Two reasons, and the first is not hygiene. `spatial-import-visium` ships a file of this
    exact basename, so `sys.path` resolution would let whichever suite ran first win
    `sys.modules` for the whole session — and this package's tests would then be asserting
    about the SIBLING's overlay, which measures a Visium slide's spot pitch and scores against
    an `in_tissue` flag Xenium does not have. `xenium_fixtures.load_compute` records the same
    hazard for the three vendored helpers.

    Second, the SUFFIX: `load_compute` installs this module under the bare name
    `registration_qc` because that is what `/code` gives the entry. Loading a separate object
    here means a test that monkeypatches a constant cannot reach through `sys.modules` and
    change the module a shipped import is using.
    """
    # `spatial_declarations` first, under its BARE name: `registration_qc` imports it the way
    # `/code` gives it to the entry, and this suite is not that flat directory. Loaded by path
    # for the same reason — `spatial-types` and `spatial-import-visium` both ship files of
    # that name, and whichever suite runs first would otherwise win `sys.modules`.
    XF._load_by_path("spatial_declarations", _XENIUM / "compute" / "spatial_declarations.py")
    return XF._load_by_path("xenium_registration_qc_helper",
                            _XENIUM / "compute" / "registration_qc.py")


@pytest.fixture(scope="module")
def RQC():
    return _load_qc()


# ── the real imports, once ───────────────────────────────────────────────────────────


def _imported(tmp_path_factory, bundle, slug):
    out = tmp_path_factory.mktemp(slug)
    module, entries = XF.run_over(bundle, out)
    return {"out": out, "entries": entries, "module": module, "bundle": Path(bundle),
            "report": json.loads((out / "xenium-import-report.json").read_text())}


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PRIME, "regqc-prime")


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PROTEIN, "regqc-protein")


def _overlay_entry(ctx):
    matches = [e for e in ctx["entries"] if e["id"].endswith("-registration-overlay")]
    assert len(matches) == 1, (
        f"expected exactly one emitted overlay, found {[e['id'] for e in ctx['entries']]}"
    )
    return matches[0]


def _cells(bundle):
    """The vendor's own centroids and areas, parsed from the RAW TEXT.

    Not read back from the importer's output: a test that compares the importer against
    another decode of the importer's own writing proves only that it agrees with itself.
    """
    import csv
    import gzip

    xs, ys, areas = [], [], []
    with gzip.open(Path(bundle) / "cells.csv.gz", "rt", newline="") as fh:
        for row in csv.DictReader(fh):
            xs.append(float(row["x_centroid"]))
            ys.append(float(row["y_centroid"]))
            areas.append(float(row["cell_area"]))
    return (np.ascontiguousarray(np.stack([np.asarray(xs), np.asarray(ys)], axis=1)),
            np.asarray(areas))


def _rescore(RQC, ctx, to_space):
    """Score the EMITTED artifact's own pixels and the VENDOR's own cells through `to_space`.

    The one thing that varies between the correct call and the four mutants in TEST-8 is the
    affine. Everything else — the plane read back off disk, the mask derived from it, the
    cells parsed from the vendor's text — is held identical, which is what makes the
    comparison a measurement of the placement rather than of anything else.
    """
    entry = XF.entry(ctx["entries"], "spatial-image-morphology")
    arr, level_scale, _info = RQC.read_emitted_plane(
        ctx["out"] / entry["path"], entry["meta"]["extent"])
    mask, mask_info = RQC.signal_mask(arr)
    coords, _areas = _cells(ctx["bundle"])
    image_xy = RQC._place(to_space, coords, level_scale)
    scored = RQC.score_registration(mask, image_xy)
    hit = scored.pop("_hit")
    block = dict(scored, to_space=list(to_space), signal_mask=mask_info)
    block.update(RQC.registration_verdict(block))
    return block, (arr, image_xy, hit, mask_info)


# ── TEST-1: the affine, inverted ─────────────────────────────────────────────────────


def test_the_declared_affine_is_inverted_as_a_general_matrix_not_as_a_reciprocal(RQC):
    """TEST-1 [covers: ITEM-2] — a TRANSPOSED affine must be MAPPED, not declined.

    §7.3 names the transpose as *"the single most likely bug in the whole importer"*. A
    reciprocal-of-`a` shortcut divides by zero on `a = d = 0, b = c = s` and reports an
    exception — so the check would decline to evaluate precisely the defect it exists to
    catch. It has to map the wrong affine and see where it puts the cells.
    """
    apply = RQC.invert_affine([2.0, 0.0, 10.0, 0.0, 4.0, 20.0])
    ux, uy = apply(np.array([10.0, 30.0]), np.array([20.0, 60.0]))
    # (10, 20) is the origin in image pixels; (30, 60) is 10 px right and 10 px down.
    assert ux == pytest.approx([0.0, 10.0])
    assert uy == pytest.approx([0.0, 10.0])

    # THE TRANSPOSE: a pure swap. It is a perfectly invertible matrix, so the inverse must
    # exist and must swap back.
    swapped = RQC.invert_affine([0.0, 2.0, 0.0, 2.0, 0.0, 0.0])
    sx, sy = swapped(np.array([6.0]), np.array([10.0]))
    assert sx == pytest.approx([5.0]) and sy == pytest.approx([3.0]), (
        "a transposed affine must be MAPPED. If this raises, the check declines to evaluate "
        "the one defect §7.3 says is most likely, and reports an exception where it should "
        "report a failed registration."
    )

    # AND A GENUINELY SINGULAR ONE IS REFUSED BY NAME. It collapses the image onto a line, so
    # no cell has a well-defined position on it — that is a different fact from "misregistered"
    # and is reported as itself.
    with pytest.raises(RQC.RegistrationQCError) as excinfo:
        RQC.invert_affine([1.0, 2.0, 0.0, 2.0, 4.0, 0.0])
    assert "singular" in str(excinfo.value) and "determinant" in str(excinfo.value)


# ── TEST-2: the mask, and its polarity ───────────────────────────────────────────────


def test_the_mask_polarity_is_DECLARED_and_the_border_CHECKS_the_declaration(RQC):
    """TEST-2 [covers: ITEM-1, ITEM-3] — the bright class is signal, always, and it is checked.

    Every plane this module sees comes from `xenium_image.read_plane` and every Xenium
    morphology image is a FLUORESCENCE STAIN, so signal is brighter than background. The
    sibling importer cannot say that (Space Ranger ships brightfield H&E as well) and infers
    the polarity from the frame's border; this one declares it.

    ## The defect this replaces, because it fired in the direction the code called impossible

    Inferring it here — `signal_is_dark = border_dark_fraction < 0.5` — produced a FALSE FAIL
    on a perfectly registered image, found by a blind correctness angle. On a plane that is
    mostly tissue reaching all four edges the border band is mostly BRIGHT, so the polarity
    flipped, the mask became the small BACKGROUND class, its fraction sat UNDER
    `MASK_FRACTION_CEILING` (so the guard never fired), and cells sitting exactly on the
    tissue scored `hit_rate = 0.000`. A false alarm on the only check this producer has is
    worse than the vacuous pass the ceiling was written for. Both cases are exercised below.

    The border is still measured, and it still gates something: it is what CHECKS the
    declaration, and `registration_verdict` refuses to return a FAIL when it does not
    corroborate.
    """
    # A dark frame with a bright block: the ordinary fluorescence case.
    fluorescence = np.zeros((200, 200), dtype=np.uint16)
    fluorescence[80:120, 80:120] = 4000
    mask, info = RQC.signal_mask(fluorescence)
    assert info["polarity"] == "signal-is-brighter-than-background"
    assert "declared for this producer" in info["polarity_source"]
    assert mask[100, 100] and not mask[5, 5], "the BRIGHT block is the signal"
    assert info["mask_fraction"] == pytest.approx(1600 / 40000, abs=1e-6)
    assert info["border_dark_fraction"] == pytest.approx(1.0)
    assert info["border_confirms_background"] is True
    assert info["border_margin"] == pytest.approx(1.0)

    # THE INVERTED PLANE IS NOT SILENTLY RE-READ. A bright frame with a dark block is not a
    # Xenium morphology image, and the bright class is still taken as signal — which makes the
    # mask 96% of the frame, over the ceiling, and therefore REFUSED downstream rather than
    # scored under a guessed polarity.
    brightfield = np.full((200, 200), 4000, dtype=np.uint16)
    brightfield[80:120, 80:120] = 0
    mask2, info2 = RQC.signal_mask(brightfield)
    assert mask2[5, 5] and not mask2[100, 100], (
        "the polarity must NOT flip: inferring it is the defect this replaces"
    )
    assert info2["mask_fraction"] > RQC.MASK_FRACTION_CEILING
    assert info2["border_confirms_background"] is False

    # ── THE REPRODUCTION OF THE FALSE FAIL, and its fix ─────────────────────────────────
    #
    # ~90% bright tissue reaching every edge, with 500 cells placed EXACTLY on the tissue —
    # a perfect registration. Under the old inferred polarity this scored hit_rate 0.000 and
    # read `fail`. It must now be REFUSED, by the ceiling, which is what that constant's own
    # docstring always claimed it did.
    rng = np.random.default_rng(0)
    mostly_tissue = np.full((1000, 1000), 3000, dtype=np.uint16)
    mostly_tissue[:300, :300] = 0
    mask3, info3 = RQC.signal_mask(mostly_tissue)
    assert info3["mask_fraction"] > 0.85, "the fixture is not mostly-tissue"
    assert info3["border_dark_fraction"] < 0.5, (
        "the fixture's border is not mostly bright, so it does not reproduce the case that "
        "flipped the inferred polarity"
    )
    on_tissue = (rng.uniform(600, 990, 500), rng.uniform(600, 990, 500))
    scored = RQC.score_registration(mask3, on_tissue)
    scored.pop("_hit")
    verdict = RQC.registration_verdict(
        dict(scored, to_space=[1.0, 0, 0, 0, 1.0, 0], signal_mask=info3))
    assert scored["hit_rate"] == pytest.approx(1.0), (
        "the cells are on the tissue and the polarity is declared, so they must HIT — under "
        f"the inferred polarity this was 0.000: {scored}"
    )
    assert verdict["verdict"] == "not-evaluated", (
        "a mostly-tissue frame carries almost no information either way and must be REFUSED, "
        f"not scored: {verdict}"
    )
    assert verdict["verdict"] != "fail", (
        "this is the false alarm a blind correctness angle produced on a PERFECTLY REGISTERED "
        "image; a fail here is the worst outcome this module can have"
    )

    # A CONSTANT PLANE IS REFUSED BY NAME. It carries no structure to measure a registration
    # against, and scoring it would report agreement with nothing.
    with pytest.raises(RQC.RegistrationQCError) as excinfo:
        RQC.signal_mask(np.zeros((50, 50), dtype=np.uint16))
    assert "single constant value" in str(excinfo.value)

    # THE REPORTED THRESHOLD IS THE CLASS BOUNDARY `(index + 1) / 256`, not a bin midpoint. A
    # midpoint would hand half of the boundary bin to the wrong class, which makes the reported
    # number not the Otsu threshold its name claims.
    assert (info["threshold_normalised"] * 256.0) == pytest.approx(
        round(info["threshold_normalised"] * 256.0))
    assert 0.0 < info["threshold_normalised"] <= 1.0
    assert info["border_band_px"] == max(1, 200 // 50)

    # …and so is a plane that is not a plane.
    with pytest.raises(RQC.RegistrationQCError) as excinfo:
        RQC.signal_mask(np.zeros((4, 4, 4, 4), dtype=np.uint8))
    assert "ndim=4" in str(excinfo.value)


# ── TEST-3: the statistic ────────────────────────────────────────────────────────────


def test_the_lift_is_zero_at_chance_and_one_at_perfect_on_a_mask_of_known_area(RQC):
    """TEST-3 [covers: ITEM-3] — the statistic's own scale, on a mask built to have one.

    `signal_lift = (hit_rate - chance) / (1 - chance)`, where `chance` is the fraction of the
    plane the mask covers. The two anchors are asserted EXACTLY rather than approximately,
    because they are what `SIGNAL_LIFT_FLOOR` is read off: a floor taken from a statistic's
    range means nothing if the range is not what the code computes.
    """
    mask = np.zeros((100, 100), dtype=bool)
    mask[:, :25] = True                      # exactly 25% of the plane
    assert mask.mean() == pytest.approx(0.25)

    # PERFECT: every cell inside the mask.
    perfect = RQC.score_registration(mask, (np.array([1.0, 2.0, 3.0]),
                                            np.array([1.0, 2.0, 3.0])))
    assert perfect["hit_rate"] == 1.0
    assert perfect["chance_rate"] == pytest.approx(0.25)
    assert perfect["signal_lift"] == pytest.approx(1.0)

    # CHANCE: cells scattered so the hit rate IS the mask's area fraction. Four cells, one in.
    chance = RQC.score_registration(mask, (np.array([1.0, 30.0, 60.0, 90.0]),
                                           np.array([1.0, 1.0, 1.0, 1.0])))
    assert chance["hit_rate"] == pytest.approx(0.25)
    assert chance["signal_lift"] == pytest.approx(0.0), (
        "a hit rate equal to the mask's own area is exactly chance and must read 0.0 — this "
        "is the anchor SIGNAL_LIFT_FLOOR is measured from"
    )

    # A CELL THAT FELL OFF THE PLANE IS A MISS, NOT A DROP. Dropping it is what would let a
    # wildly wrong affine score well on the handful that stayed in frame.
    off = RQC.score_registration(mask, (np.array([1.0, 1.0, -5.0, 500.0]),
                                        np.array([1.0, 1.0, 1.0, 1.0])))
    assert off["n_cells"] == 4 and off["cells_inside_image"] == 2
    assert off["cells_inside_fraction"] == pytest.approx(0.5)
    assert off["hit_rate"] == pytest.approx(0.5), (
        "two of four cells landed on signal; the two that left the frame must count as "
        "misses, not vanish from the denominator"
    )

    # THE LOOKUP IS AT THE FLOOR (corner) PIXEL, matching the in-frame test's own convention.
    # Rounding would be a pixel-CENTRE lookup, a systematic half-pixel offset the opposite
    # way from the convention #176 settled by proof.
    edge = np.zeros((10, 10), dtype=bool)
    edge[0, 0] = True
    got = RQC.score_registration(edge, (np.array([0.9, 1.1]), np.array([0.9, 1.1])))
    assert got["cells_on_signal"] == 1, (
        "x=0.9 floors to pixel 0 (inside) and x=1.1 floors to pixel 1 (outside); a rounding "
        "lookup would put both in pixel 1 and score zero"
    )

    # NON-FINITE POSITIONS ARE COUNTED, NOT SILENTLY DROPPED.
    nan = RQC.score_registration(mask, (np.array([1.0, np.nan]), np.array([1.0, 1.0])))
    assert nan["cells_non_finite"] == 1 and nan["cells_inside_image"] == 1


# ── TEST-4: the judgement, ON its boundaries ─────────────────────────────────────────


def _block(**kw):
    """A synthetic scored block, so `registration_verdict` can be driven without a file."""
    base = {"n_cells": 100, "cells_inside_image": 100, "cells_inside_fraction": 1.0,
            "cells_on_signal": 60, "hit_rate": 0.6, "chance_rate": 0.01,
            "signal_lift": 0.6, "to_space": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "signal_mask": {"mask_fraction": 0.01, "border_dark_fraction": 1.0,
                            "border_confirms_background": True}}
    base.update(kw)
    return base


def test_every_threshold_is_exercised_ON_its_boundary_and_none_can_be_moved_silently(RQC):
    """TEST-4 [acceptance] [invariant: INV-3] [covers: ITEM-1, ITEM-3].

    §7.5: *"A human sees a misregistration instantly and sees nothing else about it."* The
    verdict is what turns that into something a machine can carry, and a verdict is only worth
    the thresholds behind it. Each is observed AT its value and one float step past it.

    Without this, a threshold whose only observed inputs are the two extremes could be moved
    anywhere in between with every other test green — measured on the sibling module, where a
    blind audit set the floor to 0.03 and then to 0.99 and nothing went red.
    """
    floor = RQC.SIGNAL_LIFT_FLOOR
    # ON the floor: pass. This is the `>=` boundary, and it is the one an off-by-one in the
    # comparison would move.
    assert RQC.registration_verdict(_block(signal_lift=floor))["verdict"] == "pass"
    # ONE FLOAT STEP BELOW: fail. `math.nextafter`, not `floor - 0.01`, because a coarse step
    # would leave a whole band in which the comparison could be changed with this test green.
    just_under = math.nextafter(floor, 0.0)
    assert RQC.registration_verdict(_block(signal_lift=just_under))["verdict"] == "fail", (
        f"a lift one float step below {floor} must FAIL; if it passes the comparison is `>` "
        "on a different number than the constant, or the constant is not what gates"
    )

    # COVERAGE IS DECIDED BEFORE AGREEMENT, and the order is not arbitrary: a badly wrong
    # affine's first symptom is that the cells leave the frame, and a lift over the few that
    # stayed is not a measurement. A block with a PERFECT lift and too little coverage must
    # still fail, and must say the cells left the frame rather than that they disagree.
    covered = RQC.registration_verdict(
        _block(cells_inside_fraction=RQC.MIN_CELLS_INSIDE_FRACTION))
    assert covered["verdict"] == "pass"
    starved = RQC.registration_verdict(_block(
        cells_inside_fraction=math.nextafter(RQC.MIN_CELLS_INSIDE_FRACTION, 0.0),
        signal_lift=1.0, cells_inside_image=49))
    assert starved["verdict"] == "fail", (
        "coverage one float step below the minimum must FAIL even at a perfect lift"
    )
    assert "land inside this image" in starved["reason"], (
        "…and it must be reported as cells leaving the frame, not laundered into a low score: "
        f"{starved['reason']}"
    )

    # THE MASK CEILING — the branch that exists to prevent a false GREEN rather than to catch
    # a failure. An inverted polarity call produces a mask covering nearly the whole frame, on
    # which every cell lands on signal for ANY affine, so the lift reads ~1.0 and the check
    # passes vacuously. Above the ceiling it must be `not-evaluated`, and NOT `pass`.
    ceiling = RQC.MASK_FRACTION_CEILING
    at_ceiling = RQC.registration_verdict(
        _block(signal_mask={"mask_fraction": ceiling}, chance_rate=ceiling))
    assert at_ceiling["verdict"] == "pass", (
        "the ceiling is a `>` bound; a mask exactly at it is still scored"
    )
    over = RQC.registration_verdict(_block(
        signal_mask={"mask_fraction": math.nextafter(ceiling, 1.0),
                     "border_confirms_background": True},
        chance_rate=ceiling, signal_lift=0.99))
    assert over["verdict"] == "not-evaluated", (
        "a mask one float step over the ceiling must be NOT-EVALUATED even at a near-perfect "
        f"lift — a lift near 1.0 is what a mask this large produces for ANY affine: {over}"
    )
    assert over["verdict"] != "pass", "and it must never be a pass"
    assert "mostly tissue" in over["reason"] and "read backwards" in over["reason"], (
        "…and it must name BOTH causes a reader can act on, because neither is separable from "
        f"the other here: {over['reason']}"
    )

    # A DEGENERATE MASK COVERING THE WHOLE PLANE HAS NO CHANCE RATE TO MEASURE AGAINST, so the
    # lift is undefined and inventing one would be a fabricated measurement.
    undefined = RQC.registration_verdict(_block(signal_lift=None, chance_rate=1.0,
                                                signal_mask={"mask_fraction": 0.2}))
    assert undefined["verdict"] == "not-evaluated"

    # THE BORDER GATE — the branch that exists to stop a FALSE ALARM, and the only one that
    # is ORDER-sensitive in the other direction: it must gate the FAIL and NOT the PASS.
    #
    # `signal_mask` DECLARES the polarity for this producer and the border is what checks that
    # declaration. When the border is not background, this module has misread the frame, and a
    # low score cannot then be attributed to PLACEMENT — which is exactly the false `fail` a
    # blind correctness angle produced on a perfectly registered image. Refusing a PASS on the
    # same signal would be that same false alarm one direction over, so the two are asserted
    # against ONE block whose only difference is the flag.
    unconfirmed = {"mask_fraction": 0.19, "border_dark_fraction": 0.0,
                   "border_confirms_background": False}
    confirmed = dict(unconfirmed, border_dark_fraction=1.0,
                     border_confirms_background=True)
    low = _block(signal_lift=0.05, hit_rate=0.05, cells_on_signal=5, chance_rate=0.19)
    assert RQC.registration_verdict(dict(low, signal_mask=confirmed))["verdict"] == "fail", (
        "the control: with the frame corroborated, a low lift IS a failed registration"
    )
    gated = RQC.registration_verdict(dict(low, signal_mask=unconfirmed))
    assert gated["verdict"] == "not-evaluated", (
        "…and with the SAME numbers on a frame this module could not read, it must not be "
        f"reported as a misregistration: {gated}"
    )
    assert "not background" in gated["reason"] or "% background" in gated["reason"]
    # THE PASS IS UNTOUCHED. Cells landing on bright stain is real agreement whatever the
    # frame does, and refusing a good placement because its frame is unusual would be the
    # same false alarm in the other direction.
    high = _block(signal_lift=0.9, hit_rate=0.9, cells_on_signal=90, chance_rate=0.19)
    assert RQC.registration_verdict(dict(high, signal_mask=unconfirmed))["verdict"] == "pass", (
        "an unconfirmed border must gate the FAIL and nothing else"
    )
    # AND THE DEFAULT IS PERMISSIVE, so a stored block written before this key existed is
    # judged rather than silently refused.
    assert RQC.registration_verdict(
        dict(low, signal_mask={"mask_fraction": 0.19}))["verdict"] == "fail"

    # EVERY REASON CARRIES THE NUMBER. A verdict word with no figure beside it is exactly what
    # this module's honest limit (a sub-2% error it cannot resolve) makes unacceptable.
    passing = RQC.registration_verdict(_block())
    failing = RQC.registration_verdict(_block(signal_lift=0.05, hit_rate=0.06,
                                              cells_on_signal=6))
    for verdict in (passing, failing):
        assert re.search(r"\d\.\d{3}", verdict["reason"]), (
            f"the reason states a verdict with no measured figure in it: {verdict['reason']}"
        )


# ── TEST-5: the two vendor statements, enumerated ────────────────────────────────────


def test_the_competing_vendor_statement_becomes_a_second_candidate_only_when_they_DIFFER(RQC):
    """TEST-5 [covers: ITEM-4] — one candidate, or two, and never a third.

    `stated_scale_agreement` has FOUR outcomes and only ONE of them means "the bundle stated
    two different numbers". Producing a counterfactual for `identical` would compare a
    placement against itself; producing one for `single-source` or `unreadable-unit` would
    invent a statement the bundle never made.
    """
    to_space = [0.6375, 0.0, 0.0, 0.0, 0.6375, 0.0]      # 0.2125 um/px at factor 3
    for agreement in ("identical", "single-source", "unreadable-unit"):
        stated = {"applied_pixel_size_um": 0.2125,
                  "applied_source": "experiment.xenium:pixel_size",
                  "ome_physical_size_x_um": 0.2125, "ome_physical_size_y_um": 0.2125,
                  "agreement": agreement}
        got = RQC.stated_scale_candidates(stated, to_space, 3)
        assert len(got) == 1 and got[0]["applied"] is True, (
            f"agreement={agreement!r} means the two statements do not disagree, so there is "
            f"no competing placement to score: {got}"
        )
        assert got[0]["source"] == "experiment.xenium:pixel_size"
        assert got[0]["to_space"] == to_space

    # AND WHEN THEY DIFFER: exactly two, with the counterfactual derived from the OME
    # statement THROUGH THE EMITTED DOWNSAMPLE FACTOR. The emitted pixel is `factor` source
    # pixels wide, so the physical size of one emitted pixel under the other statement is
    # `ome * factor` — the identical composition `emit_image` used, with one number swapped.
    stated = {"applied_pixel_size_um": 0.2125,
              "applied_source": "experiment.xenium:pixel_size",
              "ome_physical_size_x_um": 0.5, "ome_physical_size_y_um": 0.25,
              "agreement": "differs"}
    got = RQC.stated_scale_candidates(stated, to_space, 3)
    assert len(got) == 2
    other = got[1]
    assert other["applied"] is False
    assert "OME-XML" in other["source"]
    assert other["to_space"][0] == pytest.approx(1.5), "0.5 um/px at factor 3"
    assert other["to_space"][4] == pytest.approx(0.75), "0.25 um/px at factor 3, PER AXIS"
    assert other["substituted_axes"] == ["x", "y"]
    # THE TRANSLATION IS CARRIED OVER UNCHANGED. Neither statement says anything about an
    # origin, so substituting one would invent a second difference the bundle did not state.
    assert other["to_space"][2] == to_space[2] and other["to_space"][5] == to_space[5]

    # ONE AXIS ONLY: the other keeps the applied value, and the candidate says which moved.
    one_axis = RQC.stated_scale_candidates(
        dict(stated, ome_physical_size_y_um=None), to_space, 3)
    assert one_axis[1]["substituted_axes"] == ["x"]
    assert one_axis[1]["to_space"][4] == pytest.approx(to_space[4]), (
        "an axis the OME-XML did not state must keep the APPLIED value, not be dropped — a "
        "half-substituted affine is still a real placement the bundle's statements imply"
    )

    # A MISSING FACTOR IS TREATED AS 1, and a nonsense one declines rather than fabricates.
    assert len(RQC.stated_scale_candidates(stated, to_space, None)) == 2
    assert RQC.stated_scale_candidates(stated, to_space, 0)[0]["applied"] is True
    assert len(RQC.stated_scale_candidates(stated, to_space, 0)) == 1


# ── TEST-6 / TEST-7: the REQUIRED output ─────────────────────────────────────────────


def test_a_real_import_emits_the_overlay_into_report_qc_at_the_DECLARED_transform(prime, RQC):
    """TEST-6 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-2, ITEM-5].

    §7.5, verbatim: *"The compensating control is a **rendered overlay in the `report/qc`**:
    the spot centres drawn on the tissue image at the declared transform."*

    Every clause of that sentence is asserted against a REAL import of a REAL vendor bundle:
    it is rendered (PNG bytes on disk), it is IN the `report/qc` (a manifest entry of that
    datatype), the centres are drawn (marks on the canvas, counted), and the transform used is
    the DECLARED one — read back out of the emitted artifact's own OME-XML, which is the
    declaration a sandboxed consumer actually gets, and cross-checked against the manifest
    entry's copy.
    """
    entry = _overlay_entry(prime)
    assert entry["datatype"] == "report/qc", (
        f"§7.5 asks for a rendered overlay IN the `report/qc`; this is a {entry['datatype']!r}"
    )
    assert entry["structure"]["encoding"] == "opaque"
    assert entry["structure"]["media_type"] == "image/png"
    body = (prime["out"] / entry["path"]).read_bytes()
    assert body[:8] == b"\x89PNG\r\n\x1a\n", (
        "the emitted overlay is not a PNG, so whatever the manifest promises a reader, they "
        "cannot open it"
    )
    assert len(body) <= RQC.OVERLAY_MAX_BYTES

    qc = prime["report"]["registration_qc"]
    assert qc["kind"] == "xenium-registration-qc"
    assert qc["verdict"] == "pass", (
        "the real vendor bundle's declared placement must PASS; if it does not, either the "
        f"importer or this check is wrong: {qc['images']}"
    )
    image_qc = qc["images"][0]

    # THE TRANSFORM IS THE DECLARED ONE, READ BACK FROM THE ARTIFACT. Without this, the pixels
    # would be read from disk while the affine came from the in-memory entry dict — so a
    # writer that serialised a different affine than the entry held would be outside this
    # check's reach, and §7.3's rule is about the declaration ON DISK.
    entry_image = XF.entry(prime["entries"], "spatial-image-morphology")
    assert image_qc["to_space"] == list(entry_image["meta"]["to_space"])
    assert image_qc["persisted_to_space"] == list(entry_image["meta"]["to_space"]), (
        "the affine in the emitted OME-XML must equal the one in the manifest entry — they "
        "are one fact written twice from a single object, and a divergence means the artifact "
        "that shipped is not the one the producer thinks it wrote"
    )
    assert "declaration_mismatch" not in image_qc

    # …AND THE SPACE THE TWO WERE RECONCILED IN IS REPORTED. The first cut read
    # `meta.get("space")`, a key no emitted image meta carries, so this field was `null` on
    # every run — the one place a reader could confirm WHICH frame the cells and the image
    # share reported nothing. Asserted against `SD.require_placement`'s answer on the artifact
    # itself, not against the entry's own copy, so a `.get` that silently yields None cannot
    # satisfy it.
    import spatial_declarations as SD

    import tifffile

    with tifffile.TiffFile(str(prime["out"] / entry_image["path"])) as handle:
        persisted = SD.require_placement(handle.ome_metadata, consumer="this test")
    assert image_qc["coordinate_space"], (
        "the QC block reports no coordinate space; the artifact's own OME-XML carries "
        f"{persisted['coordinate_space']!r}"
    )
    assert image_qc["coordinate_space"] == persisted["coordinate_space"]

    # …AND IT IS NOT THE RAW VENDOR SCALE. The declared affine is the EMITTED pixel's pitch,
    # which is `pixel_size * downsample_factor`; placing through the raw vendor pixel size
    # would validate a code path that does not ship.
    derivative = entry_image["meta"]["display_derivative"]
    assert derivative["downsample_factor"] > 1, (
        "this fixture must be downsampled, or 'the declared transform is not the raw vendor "
        "scale' is not being tested"
    )
    assert image_qc["to_space"][0] == pytest.approx(
        derivative["original_resolution_um"] * derivative["downsample_factor"])

    # THE CENTRES ARE ACTUALLY DRAWN. `marks_drawn` is the only observable that separates a
    # correct overlay from a bare thumbnail; a PNG of the right size exists either way.
    overlay = image_qc["overlay"]
    assert overlay["marks_drawn"] == prime["report"]["n_cells"], (
        f"every cell must be drawn on a correctly placed bundle: {overlay}"
    )
    assert overlay["marks_outside_frame"] == 0
    assert len(overlay["first_marks"]) == 8
    assert max(overlay["width"], overlay["image_height"]) <= RQC.OVERLAY_MAX_EDGE

    # AND EACH MARK IS DRAWN AT THE CELL'S OWN DECLARED PHYSICAL SIZE, through the same
    # declared affine — which is what makes a misscale visible to an eye and not only to the
    # statistic. Recomputed from the vendor's text, not read back from the block.
    _coords, areas = _cells(prime["bundle"])
    expected = float(np.median(2.0 * np.sqrt(areas / math.pi))) / image_qc["to_space"][0]
    assert image_qc["cell_diameter_image_px"]["median"] == pytest.approx(expected, rel=1e-6), (
        "the mark radius must come from the vendor's own `cell_area` carried through the "
        "DECLARED affine; a constant radius would make a misscale invisible to a reader"
    )


def test_the_overlay_is_a_REQUIRED_output_on_both_real_vendor_bundles(prime, protein, RQC):
    """TEST-7 [acceptance] [invariant: INV-2] [covers: ITEM-5, ITEM-6].

    §7.5, verbatim: *"**This is a required output of the importer, not a nice-to-have** — it
    is the entire verification story for step 7.3."*

    "Required" is a claim about EVERY bundle, so it is asserted on both real vendor fixtures —
    which differ in axis order (`YX` vs `CYX` across twelve files), channel count, pyramid
    depth, XOA version, cell count and feature mix. One bundle would let a fixture-shaped
    assumption survive.

    And the manifest half: the module is STAGED, or the entry's bare-name import is an
    ImportError inside a user's sandbox with no build-time signal at all.
    """
    for name, ctx in (("prime", prime), ("protein", protein)):
        entry = _overlay_entry(ctx)
        assert entry["datatype"] == "report/qc", name
        assert (ctx["out"] / entry["path"]).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n", name
        assert ctx["report"]["registration_qc"]["verdict"] == "pass", (
            f"{name}: {ctx['report']['registration_qc']['images']}")

    # THE TWO BUNDLES REALLY DO DIFFER, or "on both" proves nothing.
    prime_sel = XF.entry(prime["entries"], "spatial-image-morphology")["meta"]["plane_selection"]
    protein_sel = XF.entry(protein["entries"],
                           "spatial-image-morphology")["meta"]["plane_selection"]
    assert prime_sel["axes"] != protein_sel["axes"], (
        f"the two fixtures' morphology images have the same axis order ({prime_sel['axes']}), "
        "so this is one case asserted twice"
    )
    assert prime["report"]["n_cells"] != protein["report"]["n_cells"]

    # AND THE MANIFEST ID SETS STILL MATCH. The new output must be a property of the importer,
    # not something one bundle happens to get — which is the identity `test_output_budget`
    # asserts and this restates for the artifact this branch adds.
    assert ({e["id"] for e in prime["entries"]} == {e["id"] for e in protein["entries"]}), (
        "the overlay appears on one bundle and not the other, so it is not a REQUIRED output"
    )

    import yaml
    manifest = yaml.safe_load((_XENIUM / "manifest.yaml").read_text())
    analysis = manifest["contributes"]["analyses"][0]
    assert "compute/registration_qc.py" in analysis["run"]["helpers"]
    assert "report/qc" in analysis["produces"]


# ── TEST-8: THE DISCRIMINATION PROOF ─────────────────────────────────────────────────


_MUTANTS = {
    # name: (affine builder, what it models)
    "2x-misscale": (lambda t: [t[0] * 2, t[1], t[2], t[3], t[4] * 2, t[5]],
                    "a pixel size stated twice too large"),
    "half-misscale": (lambda t: [t[0] / 2, t[1], t[2], t[3], t[4] / 2, t[5]],
                      "a pixel size stated twice too small"),
    "transpose": (lambda t: [0.0, t[0], t[2], t[4], 0.0, t[5]],
                  "§7.3's 'single most likely bug in the whole importer'"),
    "translate-20um": (lambda t: [t[0], t[1], t[2] + 20.0, t[3], t[4], t[5] + 20.0],
                       "an origin offset of about two cell diameters"),
}


@pytest.mark.parametrize("mutant", sorted(_MUTANTS))
def test_a_WRONG_placement_makes_this_check_go_RED_on_a_real_vendor_bundle(mutant, prime, RQC):
    """TEST-8 [acceptance] [invariant: INV-3] [covers: ITEM-1, ITEM-2, ITEM-3].

    §7.5, verbatim: *"A human sees a misregistration instantly and sees nothing else about
    it."* This is the test that makes that claim mean something rather than describe a picture.

    THE ONLY THING THAT VARIES between the control call and each mutant is the AFFINE. The
    plane is the same bytes read back off the same emitted artifact; the mask is derived from
    those same pixels; the cells are the vendor's own text. So a difference in the verdict is
    a measurement of the placement and of nothing else.

    Three observables must move together, because any one alone is defeatable:

    * the VERDICT flips to `fail` — the machine-readable half;
    * the SIGNAL LIFT collapses toward chance — the number behind it, so a verdict flip
      cannot be produced by a threshold rather than by the geometry;
    * the DRAWN MARK POSITIONS move — the picture's half. Without this, a renderer that
      ignored the mapping entirely and laid its circles on an arbitrary lattice would be
      indistinguishable from a correct one at every observable, which is exactly how a visual
      check goes vacuous. The sibling module records a blind audit doing precisely that.
    """
    entry = XF.entry(prime["entries"], "spatial-image-morphology")
    to_space = list(entry["meta"]["to_space"])

    # THE CONTROL, in this test rather than only in a sibling. "The mutant fails" is satisfied
    # by a check that fails on everything, which is a check that cannot discriminate.
    control, (arr, control_xy, control_hit, mask_info) = _rescore(RQC, prime, to_space)
    assert control["verdict"] == "pass", (
        f"the UNMUTATED placement must pass, or the mutant's failure proves nothing: {control}"
    )
    assert control["signal_lift"] >= RQC.SIGNAL_LIFT_FLOOR

    build, models = _MUTANTS[mutant]
    wrong = build(to_space)
    assert wrong != to_space
    mutated, (_arr, mutated_xy, mutated_hit, _mask) = _rescore(RQC, prime, wrong)

    assert mutated["verdict"] == "fail", (
        f"{mutant} ({models}) still PASSES §7.5's registration check. The overlay is the only "
        "control on this producer's placement; one that cannot tell a correct affine from "
        f"this is not a control: {mutated}"
    )
    assert mutated["signal_lift"] < control["signal_lift"], (
        f"{mutant}: the lift did not fall ({mutated['signal_lift']} vs "
        f"{control['signal_lift']}), so the verdict flip came from something other than the "
        "geometry"
    )
    assert mutated["signal_lift"] < RQC.SIGNAL_LIFT_FLOOR

    # THE PICTURE MOVES TOO. Rendered from the same pixels with the same cell diameters, so
    # the only thing that can move a mark is the mapping.
    _coords, areas = _cells(prime["bundle"])
    diameters = 2.0 * np.sqrt(areas / math.pi) / to_space[0]
    _png_a, info_a = RQC.render_overlay(arr, control_xy, control_hit,
                                        cell_diameter_image_px=diameters,
                                        caption_lines=["control"])
    _png_b, info_b = RQC.render_overlay(arr, mutated_xy, mutated_hit,
                                        cell_diameter_image_px=diameters,
                                        caption_lines=["mutant"])
    assert info_a["marks_drawn"] > 0, "the control overlay drew nothing to compare against"
    assert info_a["first_marks"] != info_b["first_marks"] or \
        info_a["marks_drawn"] != info_b["marks_drawn"], (
        f"{mutant}: the renderer put its marks in the SAME places under a different affine. "
        "It is not using the mapping, so the picture is decoration and the human check §7.5 "
        f"describes is impossible: {info_a['first_marks']} vs {info_b['first_marks']}"
    )


def test_the_mutation_battery_covers_the_failure_modes_section_7_3_names(RQC):
    """TEST-8 — the battery's own control: the mutants are really different placements.

    A parametrised battery whose cases collapse to the same affine tests one thing four times.
    """
    to_space = [0.6375, 0.0, 0.0, 0.0, 0.6375, 0.0]
    built = {name: tuple(build(to_space)) for name, (build, _why) in _MUTANTS.items()}
    assert len(set(built.values())) == len(_MUTANTS), f"two mutants are the same affine: {built}"
    assert tuple(to_space) not in set(built.values())
    for name, affine in built.items():
        # Each must still be INVERTIBLE — a mutant that raises would be caught by the guard
        # and reported as an exception, which is not the same evidence as a failed placement.
        RQC.invert_affine(list(affine))


# ── TEST-9: which statement placed the image ─────────────────────────────────────────


def _rewrite_ome_physical_size(bundle, value):
    """Rewrite the vendor TIFF's OME-XML `PhysicalSizeX/Y` in place.

    A LOCAL COPY of `test_scale_referent.py`'s helper, deliberately not shared. The two files
    pin different claims about the same bytes — that one pins the disagreement being REPORTED,
    this one pins the overlay DECIDING it — and a shared helper would couple them so that
    changing one silently changes the other's subject. The description tag is fixed-length in
    the file, so the replacement is padded inside the XML's own trailing whitespace rather
    than resized, which is what keeps these the vendor's own bytes.
    """
    import tifffile

    path = Path(bundle) / "morphology_focus" / "morphology_focus_0000.ome.tif"
    with tifffile.TiffFile(str(path)) as handle:
        xml = handle.ome_metadata or ""
        offset = handle.pages[0].tags["ImageDescription"].valueoffset
        count = handle.pages[0].tags["ImageDescription"].count
    patched = re.sub(r'PhysicalSize([XY])="[^"]+"',
                     lambda m: f'PhysicalSize{m.group(1)}="{value}"', xml)
    if len(patched.encode()) >= count:
        patched = re.sub(r">\s+<", "><", patched)
    encoded = patched.encode()
    if len(encoded) < count:
        encoded = encoded + b" " * (count - len(encoded) - 1) + b"\0"
    assert len(encoded) <= count
    with open(path, "r+b") as fh:
        fh.seek(offset)
        fh.write(encoded)


def test_the_overlay_DECIDES_which_vendor_statement_placed_the_image(tmp_path):
    """TEST-9 [acceptance] [invariant: INV-4] [covers: ITEM-4].

    §7.3, verbatim: *"the design rule is: **declare the space, never the scale factor
    alone.**"*

    A Xenium bundle declares its scale TWICE, and `stated_scale_agreement` (#269) says in its
    own emitted warning that when the two differ, *"WHICH is not decidable from the bundle,
    and this importer does not guess."* §7.5's overlay is what decides it — that is the whole
    reason #301 exists — so reporting the disagreement again in a picture would add nothing.

    THE BUNDLE HERE IS BUILT SO THE APPLIED STATEMENT IS THE WRONG ONE. `experiment.xenium`'s
    `pixel_size` is moved 5% off and the image's own OME-XML keeps the vendor's original, so
    the placement that shipped is wrong and the competing statement is right. The overlay has
    to say so — with a lower score on the applied placement, a higher one on the other, a
    verdict on each, and both named in the caption BURNED INTO THE PICTURE.

    Reverse the two and the assertions reverse with them; that is the point of scoring rather
    than asserting a rule.
    """
    bundle = XF.stage_bundle(tmp_path, name="scale-dispute")
    experiment = json.loads((bundle / "experiment.xenium").read_text())
    truth = float(experiment["pixel_size"])
    experiment["pixel_size"] = truth * 1.05
    (bundle / "experiment.xenium").write_text(json.dumps(experiment))
    # The image keeps the vendor's ORIGINAL statement, so the bundle now disagrees with itself
    # and the truth is on the image's side.
    _rewrite_ome_physical_size(bundle, truth)

    out = tmp_path / "out-dispute"
    _module, entries = XF.run_over(bundle, out)
    report = json.loads((out / "xenium-import-report.json").read_text())
    stated = XF.entry(entries, "spatial-image-morphology")["meta"]["stated_scales"]
    assert stated["agreement"] == "differs", (
        f"the fixture did not produce a disagreement, so nothing here is being decided: {stated}"
    )

    image_qc = report["registration_qc"]["images"][0]
    placed = image_qc["placed_by"]
    assert placed["source"] == "experiment.xenium:pixel_size", (
        f"the block must name WHICH statement placed the image: {placed}"
    )
    assert placed["pixel_size_um"] == pytest.approx(truth * 1.05)
    assert placed["agreement"] == "differs"
    assert "OME-XML" in placed["competing_statement"]

    placements = image_qc["stated_scale_placements"]
    assert len(placements) == 2
    applied = next(p for p in placements if p["applied"])
    other = next(p for p in placements if not p["applied"])

    # THE DECISION. The applied statement is the wrong one; the image's own is the truth.
    assert other["signal_lift"] > applied["signal_lift"], (
        "the overlay must score the CORRECT statement's placement higher. If it cannot "
        f"separate them it decides nothing, which is what #301 exists to fix: {placements}"
    )
    assert applied["verdict"] == "fail" and other["verdict"] == "pass", (
        f"each placement must carry its own verdict, not just a score: {placements}"
    )
    assert image_qc["verdict"] == "fail", (
        "the image's own verdict is the APPLIED placement's — the artifact that shipped is "
        "the one placed wrongly, and a pass here would describe a bundle nobody has"
    )

    # AND THE PICTURE SAYS IT TOO. A caption that lives beside the picture is separable from
    # it: copied into a slide, mailed to a collaborator, the picture arrives and the
    # provenance does not. This one is in the pixels.
    caption = " ".join(image_qc["overlay"]["caption_lines"])
    assert "PLACED BY: experiment.xenium:pixel_size" in caption, (
        f"the burned-in caption does not name the statement that placed the image: {caption}"
    )
    assert "THE OTHER STATEMENT" in caption and "OME-XML" in caption, (
        f"…nor the one it was decided against: {caption}"
    )
    assert f"{applied['signal_lift']:.3f}" in caption and \
        f"{other['signal_lift']:.3f}" in caption, (
        f"…nor the two scores that decide between them: {caption}"
    )
    # THE CAPTION IS DRAWABLE. The default bitmap font has no glyph for an em dash or a micro
    # sign and draws a hollow BOX instead, which turns burned-in provenance into squares.
    for line in image_qc["overlay"]["caption_lines"]:
        assert all(32 <= ord(ch) < 127 for ch in line), (
            f"a caption line carries a character the overlay's font cannot draw: {line!r}"
        )
    # …and it is really in the image: the canvas is TALLER than the plane by the band.
    overlay = image_qc["overlay"]
    assert overlay["caption_band_height"] > 0
    assert overlay["height"] == overlay["image_height"] + overlay["caption_band_height"]

    # THE VERDICT REACHES A READER WITHOUT OPENING THE PICTURE, too — the disagreement warning
    # names where the comparison is, and the report's own referent block says the control ran.
    warnings = [w for w in report["image_warnings"] if "pixel size TWICE" in w]
    assert warnings and "stated_scale_placements" in warnings[0]


# ── TEST-10 / 11 / 12: the guards ────────────────────────────────────────────────────


def test_the_check_NEVER_raises_into_the_import(RQC, tmp_path):
    """TEST-10 [covers: ITEM-1] — every failure becomes `not-evaluated`, naming its cause.

    A diagnostic that destroys a user's access to their data is worse than one that reports
    loudly. And `not-evaluated` is a THIRD value: it must never aggregate into `pass`, or
    "could not be checked" becomes indistinguishable from "checked and fine" — the exact
    distinction `stated_scale_agreement`'s four-state design exists to keep, one module over.
    """
    absent = {"id": "spatial-image-morphology", "path": "nowhere.ome.tif",
              "meta": {"to_space": [1.0, 0, 0, 0, 1.0, 0],
                       "extent": {"width": 10, "height": 10}, "source": "gone"}}
    block, overlays = RQC.registration_qc(
        coords=np.zeros((3, 2)), cell_area_um2=np.ones(3),
        image_entries=[absent], outputs_dir=tmp_path, scope="test")
    assert block["images"][0]["verdict"] == "not-evaluated"
    assert "could not be run over this image" in block["images"][0]["reason"]
    assert block["verdict"] == "not-evaluated", (
        "an unchecked image must never roll up to `pass`"
    )
    assert overlays == {}

    # A 0-d `coords` raises `TypeError` from `len` in the HEADER, which the sibling module
    # records escaping into `run_import` and aborting a whole import when the header sat
    # outside the guard.
    header_broken, _ = RQC.registration_qc(
        coords=np.float64(1.0), cell_area_um2=None,
        image_entries=[], outputs_dir=tmp_path, scope="test")
    assert "header_error" in header_broken
    assert header_broken["verdict"] == "not-evaluated"

    # NO IMAGE AT ALL is its own answer, and it is not a pass either.
    empty, _ = RQC.registration_qc(coords=np.zeros((2, 2)), cell_area_um2=None,
                                   image_entries=[], outputs_dir=tmp_path, scope="test")
    assert empty["verdict"] == "not-evaluated"
    assert "nothing to place the cells on" in empty["reason"]

    # (THE AGGREGATE — `all`, not `any` — IS ASSERTED IN TEST-24, over a really mixed image
    # set. A leg here asserted it over a local dict literal, which is a tautology: a blind
    # angle changed the production aggregate to `any` and the whole suite stayed green.)


def test_an_overlay_with_no_marks_is_refused_rather_than_emitted_as_a_thumbnail(RQC):
    """TEST-11 [covers: ITEM-1, ITEM-5] — a bare thumbnail is not an overlay.

    When every cell maps outside the frame, the rendered picture is the plain morphology
    plane — indistinguishable from an overlay nobody drew. A valid PNG of the right size
    exists either way, which is the failure mode of every "the artifact was produced"
    assertion. So the marks are COUNTED and an empty one is not embedded.
    """
    plane = np.zeros((100, 100), dtype=np.uint16)
    plane[40:60, 40:60] = 5000
    diameters = np.full(3, 6.0)

    on_canvas, info = RQC.render_overlay(
        plane, (np.array([50.0, 51.0, 52.0]), np.array([50.0, 50.0, 50.0])),
        np.array([True, True, False]),
        cell_diameter_image_px=diameters, caption_lines=["x"])
    assert info["marks_drawn"] == 3 and info["marks_outside_frame"] == 0
    assert len(info["first_marks"]) == 3

    # A MARK WHOSE CENTRE IS OFF THE CANVAS IS NOT DRAWN AND NOT COUNTED. PIL would happily
    # clip it, which is what makes an all-off-frame overlay look correctly drawn.
    _png, off = RQC.render_overlay(
        plane, (np.array([-5.0, 500.0]), np.array([50.0, 50.0])),
        np.array([True, True]),
        cell_diameter_image_px=np.full(2, 6.0), caption_lines=["x"])
    assert off["marks_drawn"] == 0 and off["marks_outside_frame"] == 2
    assert off["first_marks"] == []

    # NON-FINITE POSITIONS ARE SKIPPED rather than crashing the render.
    _png2, nan = RQC.render_overlay(
        plane, (np.array([50.0, np.nan]), np.array([50.0, 50.0])),
        np.array([True, True]),
        cell_diameter_image_px=np.full(2, 6.0), caption_lines=["x"])
    assert nan["marks_drawn"] == 1

    # A 16-BIT PLANE IS NORMALISED, NOT CAST. A bare `.astype(uint8)` wraps it into noise and
    # makes a correctly registered overlay unreadable.
    assert len(on_canvas) > 0
    dark = RQC._to_uint8(np.array([[0, 65535]], dtype=np.uint16))
    assert dark.tolist() == [[0, 255]]


def test_a_SPARSE_fluorescence_plane_is_still_VISIBLE_under_the_marks(RQC):
    """TEST-11 [acceptance] [invariant: INV-3] [covers: ITEM-1].

    §7.5, verbatim: *"A human sees a misregistration instantly and sees nothing else about
    it."* That is a claim about a PICTURE, and it fails silently if the picture is black.

    A Xenium morphology plane is fluorescence and is overwhelmingly EMPTY — measured on the
    emitted artifacts of both real vendor bundles, the 99th percentile of both is ZERO and the
    signal covers 0.22% and 0.60% of the frame. Two things would each, alone, render it as an
    empty field:

    * a global min/max display map, which spends the whole visible range on a handful of
      bright pixels; and
    * a mean/bilinear downscale, which averages each output pixel over a neighbourhood that is
      almost entirely background.

    The first cut had both, and the protein bundle's overlay came out as marks floating on
    black. So the display path takes its levels FROM THE MASK (median background to median
    signal — derived, not a new tunable) and reduces by BLOCK MAXIMUM. Both are DISPLAY ONLY;
    the mask and every number come from the raw plane, so neither can move a verdict.

    This test builds a plane with exactly that sparsity and requires the signal to SURVIVE at
    a scale that would erase it under a mean.
    """
    # One bright pixel in every 8x8 block of a 512x512 frame: 1.5% coverage, sparser than
    # anything a mean survives at an 8x reduction.
    plane = np.zeros((512, 512), dtype=np.uint16)
    plane[::8, ::8] = 900
    mask = plane > 0
    assert mask.mean() < 0.02, "the fixture is not sparse, so it tests nothing"

    levels = RQC._display_levels(plane, mask)
    assert levels == (0.0, 900.0), (
        "the display levels must be the median BACKGROUND and the median SIGNAL, taken from "
        f"the mask the score already computed: {levels}"
    )
    # …and they DECLINE rather than invent a range when the mask separates nothing.
    assert RQC._display_levels(plane, np.zeros_like(mask)) is None
    assert RQC._display_levels(plane, np.ones_like(mask)) is None
    assert RQC._display_levels(np.zeros_like(plane), plane > -1) is None

    # THE REDUCTION KEEPS THE SIGNAL. A block MEAN at 1/8 would put every output pixel at
    # 900/64 = 14 (5% grey); a block MAX keeps it at 900 (saturated).
    stretched = RQC._stretch_uint8(plane, levels)
    reduced = RQC._block_max_downscale(stretched, (64, 64))
    assert reduced.shape == (64, 64)
    assert reduced.max() == 255
    assert float(reduced.mean()) > 200.0, (
        f"the reduced plane has a mean of {reduced.mean():.1f}; a mean-based downscale would "
        "put it near 4 and the tissue would be invisible under the marks — which is INV-3's "
        "failure mode arriving at the product rather than at the test"
    )
    # THE CONTROL: the same reduction of an EMPTY plane is empty. Without this, "the output is
    # bright" would be satisfied by a reducer that returns a constant.
    assert RQC._block_max_downscale(np.zeros((512, 512), dtype=np.uint8), (64, 64)).max() == 0

    # AND THE RENDER USES IT, end to end: the same plane through `render_overlay` WITH the
    # mask must come out visibly brighter than the same plane WITHOUT it.
    xy = (np.array([256.0]), np.array([256.0]))
    _with, info_with = RQC.render_overlay(plane, xy, np.array([True]),
                                          cell_diameter_image_px=np.array([4.0]),
                                          caption_lines=["with"], mask=mask)
    _without, info_without = RQC.render_overlay(plane, xy, np.array([True]),
                                                cell_diameter_image_px=np.array([4.0]),
                                                caption_lines=["without"])
    assert info_with["display_levels"] == [0.0, 900.0]
    assert info_without["display_levels"] is None, (
        "without a mask the renderer must fall back to the plain min/max map and SAY it did, "
        "rather than reporting levels it did not use"
    )
    # Both are under OVERLAY_MAX_EDGE here, so the block reduction is a no-op and the two
    # differ only in the stretch.
    assert info_with["render_scale"] == info_without["render_scale"] == 1.0
    # AND THE DIFFERENCE IS IN THE PIXELS, not only in the metadata. This paragraph used to
    # promise "visibly brighter" and then compare two dicts; a blind angle pointed out that
    # the two rendered byte strings were bound and never used. On THIS fixture the two maps
    # happen to agree (min 0, max 900 = the median signal), so the leg with teeth is the
    # SHIPPED-path comparison in TEST-23; what is asserted here is that both renders really
    # are pictures of the same plane and that neither came back blank.
    from PIL import Image
    import io as _io

    def _mean(png):
        with Image.open(_io.BytesIO(png)) as handle:
            return float(np.asarray(handle.convert("RGB")).mean())

    assert _mean(_with) > 0.0 and _mean(_without) > 0.0


def test_the_render_bounds_are_separately_load_bearing(RQC):
    """TEST-12 [covers: ITEM-1] — the edge cap and the byte cap bound different things.

    Bounding the edge length does not bound the file: a noisy plane compresses poorly. Both
    are asserted, and the byte cap's branch is asserted to leave the VERDICT alone — losing
    the picture must cost the picture and nothing else.
    """
    big = (np.random.default_rng(0).integers(0, 65535, size=(2000, 1500))).astype(np.uint16)
    _png, info = RQC.render_overlay(
        big, (np.array([10.0]), np.array([10.0])), np.array([True]),
        cell_diameter_image_px=np.array([40.0]), caption_lines=["cap"])
    assert max(info["width"], info["image_height"]) == RQC.OVERLAY_MAX_EDGE, (
        "the longest edge of the IMAGE part must be exactly the cap after downscaling"
    )
    assert info["render_scale"] < 1.0
    # THE MARK RADIUS SCALES WITH THE IMAGE. A radius left in source pixels would draw a
    # circle the size of the whole thumbnail.
    assert info["median_mark_radius_px"] == pytest.approx(20.0 * info["render_scale"])
    # The caption band is EXTRA, and deliberately not counted in the cap: covering the
    # evidence to label the evidence is not a trade this check gets to make.
    assert info["height"] == info["image_height"] + info["caption_band_height"]

    # THE BYTE CAP: driven by lowering the constant rather than by building a 2 MB fixture, so
    # the branch is exercised without a slow test — and driven through `check_registration`
    # rather than asserted about the constant, because what is being pinned is that losing the
    # PICTURE does not lose the VERDICT. TEST-12b below does that on the real bundle.
    # (The cap's own branch is exercised through `check_registration` in the next test, and
    # its VALUE is pinned in TEST-25. A line here read `monkeypatch.setattr(...)` and then
    # asserted the constant equalled what it had just been set to, which asserts that
    # monkeypatch works.)


def test_losing_the_picture_costs_the_picture_and_nothing_else(prime, RQC, monkeypatch):
    """TEST-12 [covers: ITEM-1, ITEM-5] — every `overlay_omitted` branch, on the real bundle.

    This is the arrangement the whole per-image body is built around and it is easy to get
    backwards. The verdict is computed BEFORE the render. Letting a PNG failure propagate to
    the caller's per-image handler would REPLACE the whole block with a fresh
    `not-evaluated` — silently downgrading a correctly computed FAIL because the drawing code
    choked, and then aggregating it as pass-or-not-evaluated so the FAIL never reaches the top
    level. That is laundering in the direction that HIDES a real failure, which is the worse
    direction, so each of the three ways a picture can be lost is exercised here and each must
    leave the verdict and its number untouched.
    """
    entry = XF.entry(prime["entries"], "spatial-image-morphology")
    coords, areas = _cells(prime["bundle"])

    baseline, png = RQC.check_registration(entry, prime["out"], coords, cell_area_um2=areas)
    assert baseline["verdict"] == "pass" and png is not None

    # (a) OVER THE BYTE CAP. A report a browser cannot open is not a report.
    monkeypatch.setattr(RQC, "OVERLAY_MAX_BYTES", 1)
    capped, capped_png = RQC.check_registration(entry, prime["out"], coords,
                                                cell_area_um2=areas)
    assert capped_png is None, "an over-cap overlay must not be emitted"
    assert "over the" in capped["overlay_omitted"] and "cap" in capped["overlay_omitted"]
    assert capped["verdict"] == baseline["verdict"]
    assert capped["signal_lift"] == baseline["signal_lift"], (
        "the verdict was computed before the render and must be untouched by losing it"
    )
    assert capped["overlay"]["marks_drawn"] == baseline["overlay"]["marks_drawn"], (
        "the render still happened and its measurements are still reported; what is withheld "
        "is the bytes"
    )
    monkeypatch.undo()

    # (b) THE RENDER RAISES. Driven by breaking the renderer itself, so the guard around it is
    # what is being exercised rather than a data shape that happens to fail.
    def _explode(*_a, **_kw):
        raise MemoryError("no room for the canvas")

    monkeypatch.setattr(RQC, "render_overlay", _explode)
    exploded, exploded_png = RQC.check_registration(entry, prime["out"], coords,
                                                    cell_area_um2=areas)
    assert exploded_png is None
    assert "MemoryError" in exploded["overlay_omitted"], (
        f"the omission must name the real cause: {exploded.get('overlay_omitted')}"
    )
    assert exploded["verdict"] == baseline["verdict"], (
        "a drawing failure silently downgraded a computed verdict — this is the laundering "
        "the separate guard exists to prevent, in the direction that hides a real failure"
    )
    monkeypatch.undo()

    # (c) EVERY CELL OFF THE FRAME. The picture is then the bare morphology plane, which is
    # indistinguishable from an overlay nobody drew — so it is not emitted, and the report
    # says which of the two happened.
    far = dict(entry, meta=dict(entry["meta"],
                                to_space=[entry["meta"]["to_space"][0], 0.0, 1e9,
                                          0.0, entry["meta"]["to_space"][4], 1e9]))
    blank, blank_png = RQC.check_registration(far, prime["out"], coords, cell_area_um2=areas)
    assert blank_png is None
    assert "maps outside the image's frame" in blank["overlay_omitted"]
    assert blank["verdict"] == "fail", (
        "…and the verdict must still say the registration failed, rather than the picture's "
        "absence being the only signal"
    )
    assert blank["overlay"]["marks_drawn"] == 0

    # (d) THE TWO COPIES OF THE DECLARATION DISAGREE. The manifest entry's affine is moved
    # while the emitted OME-XML keeps the real one, so the artifact a consumer reads is not
    # the artifact the producer believes it wrote — a registration defect in its own right,
    # and one no score computed from either copy describes.
    mismatched = dict(entry, meta=dict(entry["meta"],
                                       to_space=[v * 1.000001 for v in
                                                 entry["meta"]["to_space"][:1]]
                                       + list(entry["meta"]["to_space"][1:])))
    diverged, _ = RQC.check_registration(mismatched, prime["out"], coords,
                                         cell_area_um2=areas)
    assert diverged["verdict"] == "fail"
    assert "declaration_mismatch" in diverged
    assert "A consumer reads the OME-XML" in diverged["reason"], (
        "a divergence between the two copies must be reported as itself, not as a low score"
    )


# ── TEST-13: the verdict reaches a human ─────────────────────────────────────────────


def test_the_verdict_rides_in_meta_and_the_overlay_renders_above_the_facts_table(prime):
    """TEST-13 [covers: ITEM-5] — `meta` is the channel this app actually shows.

    `import_visium.qc_verdict_lines` traces it end to end: nothing in this application renders
    `report/html`, and what it DOES show with zero clicks the moment a run finishes is one card
    per produced datatype printing `artifact.meta` verbatim. An overlay that lives only in an
    HTML nobody renders is "an image nobody opens — which is exactly the thing a QC must not
    be".

    So three surfaces are asserted: both report entries' `meta`, the overlay entry's own
    `meta`, and the rendered page — where §7.2 requires the picture to be somewhere a human
    will see it, i.e. ABOVE the facts table rather than below a list of provenance strings.
    """
    for entry_id in ("xenium-import-report", "xenium-import-summary"):
        meta = XF.entry(prime["entries"], entry_id)["meta"]
        assert meta["registration_qc_verdict"] == "pass", entry_id
        assert meta["registration_qc"] and isinstance(meta["registration_qc"], list), entry_id
        assert "registration" in meta["registration_qc"][0], entry_id

    overlay_meta = _overlay_entry(prime)["meta"]
    assert overlay_meta["kind"] == "xenium-registration-overlay"
    assert overlay_meta["registration_qc_verdict"] == "pass"
    assert "DECLARED transform" in overlay_meta["what_this_shows"], (
        "the overlay's catalog row must say what the picture shows, or it is a blob a reader "
        "has no reason to open"
    )
    assert "each at its own vendor-measured area" in overlay_meta["what_this_shows"], (
        "this bundle HAS `cell_area`, so the row must say the marks carry it — that is DEC-10's "
        "stated mechanism for making a misscale visible to an eye"
    )

    summary_meta = XF.entry(prime["entries"], "xenium-import-summary")["meta"]
    assert summary_meta["overlay_embedded"] == ["spatial-image-morphology"]
    assert "report/qc" in summary_meta["overlay_note"], (
        "the summary must point a reader at the artifact they CAN open, since nothing renders "
        "this HTML"
    )

    html = (prime["out"] / "xenium-import-summary.html").read_text()
    visible = html.split("<script", 1)[0]
    assert "Registration QC" in visible
    assert "data:image/png;base64," in visible, "the overlay is not embedded in the summary"
    assert visible.index("Registration QC") < visible.index("Coordinate space"), (
        "§7.2 puts the QC where a human must be able to SEE and confirm the registration; an "
        "overlay below a table of provenance strings is an overlay nobody scrolls to"
    )
    assert "placed by experiment.xenium:pixel_size" in visible.lower(), (
        "the rendered block must name which vendor statement placed the image"
    )


# ── TEST-21..24: the PIXELS, because everything above reads the renderer's own report ─
#
# A blind tests-quality angle replaced the shipped PNG's bytes with a 1x1 TRANSPARENT PNG,
# left the `overlay` info dict untouched, and the whole suite stayed green — every assertion
# about the artifact checked either the PNG magic number or the dict `render_overlay` reports
# ABOUT ITSELF. That is the vacuous visual claim this file's docstring says it exists to close,
# arriving one level down. The same angle then deleted the caption's `draw.text` call, replaced
# the per-cell radius with a constant, filled the marks instead of outlining them, and reverted
# the shipped path's display stretch — four documented decisions, four green suites.
#
# So these decode the emitted file and read its PIXELS.


def _decoded(ctx):
    """The SHIPPED overlay artifact, decoded — bytes off disk, not the renderer's report."""
    from PIL import Image

    entry = _overlay_entry(ctx)
    with Image.open(ctx["out"] / entry["path"]) as handle:
        return np.asarray(handle.convert("RGB"))


def _colour_hits(pixels, colour, tolerance=24):
    """A boolean mask of pixels within `tolerance` of `colour`, per channel.

    A tolerance because PNG round-trips exactly but PIL's `ellipse` antialiases nothing while
    the block-max reduction beneath it can shift a mark's neighbours; the two mark colours are
    ~200 apart in at least one channel, so 24 separates them with room.
    """
    delta = np.abs(pixels.astype(np.int16) - np.asarray(colour, dtype=np.int16))
    return (delta <= tolerance).all(axis=2)


def test_the_EMITTED_PNG_carries_in_its_PIXELS_what_the_info_dict_claims(prime, RQC):
    """TEST-21 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-5].

    §7.5, verbatim: *"the spot centres drawn on the tissue image at the declared transform"*.
    Every other test in this file takes the renderer's word for that. This one opens the file
    a user opens.

    Four claims, each of which a blind angle broke while the suite stayed green:
    the picture is the size it says it is; the caption is IN THE PIXELS and in the band BELOW
    the evidence; both mark classes are really drawn, in their two colours; and the marks are
    where `first_marks` says they are.
    """
    pixels = _decoded(prime)
    overlay = prime["report"]["registration_qc"]["images"][0]["overlay"]

    assert pixels.shape[:2] == (overlay["height"], overlay["width"]), (
        f"the shipped PNG is {pixels.shape[:2][::-1]} and the report claims "
        f"{(overlay['width'], overlay['height'])}. A 1x1 placeholder satisfies every "
        "magic-number check in this suite; this is the assertion that does not let it."
    )

    image_part = pixels[:overlay["image_height"]]
    band = pixels[overlay["image_height"]:]
    assert band.shape[0] == overlay["caption_band_height"] > 0

    # THE CAPTION IS IN THE PIXELS, AND IT IS IN THE BAND. One assertion catches both of the
    # ways this was broken: deleting the text draw leaves the band uniform ground, and drawing
    # the text over the IMAGE instead leaves the band uniform ground too.
    ink = _colour_hits(band, RQC._CAPTION_INK, tolerance=40)
    assert int(ink.sum()) > 200, (
        f"the caption band carries only {int(ink.sum())} ink pixels — the provenance is not "
        "burned into the picture. DEC-5's whole argument is that a caption beside the picture "
        "is separable from it and one inside it travels with it; a band with no text in it is "
        "the separable case with extra height."
    )
    ground = _colour_hits(band, RQC._CAPTION_GROUND, tolerance=8)
    assert int(ground.sum()) > int(ink.sum()), (
        "the band is mostly ink rather than mostly ground, which is not a caption"
    )

    # BOTH MARK CLASSES ARE DRAWN, IN THEIR TWO COLOURS. A single-colour render satisfies
    # `marks_drawn`; it does not satisfy "coloured by whether the cell landed on signal".
    on = _colour_hits(image_part, RQC._COLOUR_ON_SIGNAL)
    off = _colour_hits(image_part, RQC._COLOUR_OFF_SIGNAL)
    qc_image = prime["report"]["registration_qc"]["images"][0]
    assert qc_image["cells_on_signal"] > 0 and \
        qc_image["cells_on_signal"] < qc_image["n_cells"], (
        "this fixture must have BOTH classes, or 'two colours are drawn' is untestable here"
    )
    assert int(on.sum()) > 0 and int(off.sum()) > 0, (
        f"the picture carries {int(on.sum())} on-signal and {int(off.sum())} off-signal "
        "pixels; the mark colour is derived from the same boolean the score counted, so a "
        "render with one colour has stopped showing the reader what each cell landed on"
    )

    # AND THE MARKS ARE WHERE THE REPORT SAYS. `first_marks` is the only record of WHERE the
    # renderer put anything.
    marked = on | off
    for cx, cy in overlay["first_marks"]:
        x, y = int(round(cx)), int(round(cy))
        window = marked[max(0, y - 6):y + 7, max(0, x - 6):x + 7]
        assert window.any(), (
            f"the report says a mark was drawn at ({cx}, {cy}) and the emitted picture has no "
            "mark within 6 pixels of it"
        )

    # ── AND THE MARKS ARE WHERE THE TEST'S OWN ARITHMETIC SAYS ──────────────────────────
    #
    # This is the assertion with teeth, and the two above do not have it. `first_marks` is
    # written by the SAME LOOP that draws the marks, so any systematic error in the mapping is
    # self-consistent and invisible to a comparison against it. A blind design-conformance
    # angle proved exactly that: flipping the drawn position vertically in `render_overlay`
    # (`cy = source_h * scale - 1 - y * scale`) — a picture in which every mark sits off the
    # tissue, under a banner reading PASS — left the ENTIRE suite green. TEST-8 only requires
    # the marks to MOVE between two affines, which a flipped renderer also satisfies.
    #
    # So THIS TEST computes where each cell belongs, from the vendor's own micrometre
    # centroids and the artifact's own declared affine, and requires a mark to be there. The
    # renderer contributes nothing to the expectation but the reported `render_scale`.
    entry_image = XF.entry(prime["entries"], "spatial-image-morphology")
    a, _b, tx, _c, d, ty = (float(v) for v in entry_image["meta"]["to_space"])
    coords, _areas = _cells(prime["bundle"])
    qc_block = prime["report"]["registration_qc"]["images"][0]
    lsx, lsy = qc_block["level_scale"], qc_block["level_scale_y"]
    render_scale = overlay["render_scale"]
    expected = [(((cx - tx) / a) * lsx * render_scale, ((cy - ty) / d) * lsy * render_scale)
                for cx, cy in coords]
    marked = on | off
    reach = 3
    found = 0
    for ex, ey in expected:
        x, y = int(round(ex)), int(round(ey))
        if not (0 <= x < overlay["width"] and 0 <= y < overlay["image_height"]):
            continue
        window = marked[max(0, y - reach):y + reach + 1, max(0, x - reach):x + reach + 1]
        found += bool(window.any())
    in_frame = sum(1 for ex, ey in expected
                   if 0 <= ex < overlay["width"] and 0 <= ey < overlay["image_height"])
    assert in_frame == overlay["marks_drawn"] > 0, (
        f"this test's own arithmetic puts {in_frame} cells on the canvas and the renderer "
        f"reports {overlay['marks_drawn']}; the two disagree before any pixel is looked at"
    )
    assert found == in_frame, (
        f"only {found} of {in_frame} cells have a mark within {reach} px of where the "
        "DECLARED affine puts them, computed by this test from the vendor's own centroids. "
        "The picture is systematically misplaced while every number in the report is right — "
        "which is a PASS banner over an overlay whose marks sit off the tissue, and it is "
        "invisible to any comparison against `first_marks`, because that list is written by "
        "the same loop that draws them."
    )


def test_the_marks_are_OUTLINES_drawn_at_each_cells_OWN_declared_size(prime, RQC):
    """TEST-22 [acceptance] [invariant: INV-3] [covers: ITEM-1].

    Two pixel-level claims the module makes and a blind angle broke with the suite green.

    **Outlines, not fills.** *"Drawn as OUTLINES, not fills, so the morphology under each cell
    stays visible — the whole question the reader is answering is what the cell is sitting
    on."* A filled disc hides the exact evidence the overlay exists to show.

    **Each at its OWN size (DEC-10).** The radius comes from the vendor's per-cell `cell_area`
    through the declared affine, *"which is what makes a misscale visible to a HUMAN and not
    only to `score_registration`"*. Both prior assertions read numbers computed OUTSIDE the
    draw loop, so a constant radius passed them.
    """
    # OUTLINE: on a synthetic plane with one isolated mark, the CENTRE must not be the mark
    # colour and the RING must be. Synthetic rather than the real bundle because there the
    # marks overlap and a neighbour's ring can land on this one's centre.
    plane = np.zeros((200, 200), dtype=np.uint16)
    plane[90:110, 90:110] = 4000
    png, info = RQC.render_overlay(plane, (np.array([100.0]), np.array([100.0])),
                                   np.array([True]),
                                   cell_diameter_image_px=np.array([40.0]),
                                   caption_lines=["outline"])
    from PIL import Image
    import io as _io

    with Image.open(_io.BytesIO(png)) as handle:
        drawn = np.asarray(handle.convert("RGB"))
    assert info["render_scale"] == 1.0
    ring = _colour_hits(drawn[:200], RQC._COLOUR_ON_SIGNAL)
    assert ring[100, 80] or ring[100, 120] or ring[80, 100] or ring[120, 100], (
        "no mark colour on the ring at radius 20; the mark was not drawn where it was asked to"
    )
    assert not ring[100, 100], (
        "the mark's CENTRE carries the mark colour — it is a filled disc, and the morphology "
        "the reader is being asked to look at is underneath it"
    )
    assert int(ring.sum()) < 400, (
        f"{int(ring.sum())} mark pixels for one r=20 mark; a circumference is about 126 "
        "pixels and a filled disc is about 1257, so this is a fill"
    )

    # PER-CELL SIZE: the SAME cells rendered with each cell's own radius and with a single
    # constant radius must produce DIFFERENT pixels. This is the assertion a constant radius
    # cannot pass, and it is driven off the real bundle's real areas.
    entry = XF.entry(prime["entries"], "spatial-image-morphology")
    arr, level_scale, _ = RQC.read_emitted_plane(prime["out"] / entry["path"],
                                                 entry["meta"]["extent"])
    coords, areas = _cells(prime["bundle"])
    xy = RQC._place(entry["meta"]["to_space"], coords, level_scale)
    mask, _mask_info = RQC.signal_mask(arr)
    hit = RQC.score_registration(mask, xy).pop("_hit")
    per_cell = 2.0 * np.sqrt(areas / math.pi) / entry["meta"]["to_space"][0]
    assert per_cell.std() > 0.5 * per_cell.mean() * 0.1, (
        f"the fixture's cells are all the same size ({per_cell.min():.2f}..{per_cell.max():.2f}"
        " px), so 'each at its own size' is untestable here"
    )
    real, _ = RQC.render_overlay(arr, xy, hit, cell_diameter_image_px=per_cell,
                                 caption_lines=["real"], mask=mask)
    flat, _ = RQC.render_overlay(arr, xy, hit,
                                 cell_diameter_image_px=np.full_like(per_cell,
                                                                     float(np.median(per_cell))),
                                 caption_lines=["real"], mask=mask)
    assert real != flat, (
        "rendering every cell at the MEDIAN radius produced byte-identical pixels to "
        "rendering each at its own vendor-measured area. The radius is not coming from "
        "`cell_area`, so a misscale would not change the drawn circles and DEC-10's claim "
        "that an eye reads it immediately is false."
    )


def test_a_MULTI_CHANNEL_plane_is_drawable_and_keeps_its_hues(RQC):
    """TEST-22b [covers: ITEM-1] — the branch no Xenium bundle reaches, pinned anyway.

    `xenium_image.read_plane` always returns a 2-D plane, so nothing this importer emits ever
    enters `render_overlay`'s multi-channel arm. It exists for the same reason `signal_mask`
    has one: a plane the scorer can score must be a plane the renderer can draw, and
    `ome_writer.read_image`'s contract admits a `YXS` plane. A blind angle changed
    `_to_uint8_rgb` to normalise each channel separately — the exact thing its docstring says
    it must not do — and the suite stayed green, because nothing exercised it.

    Unreachable-from-this-producer is a reason to say so, not a reason to leave the claim
    unchecked: a dead branch that is wrong is still wrong the day something reaches it.
    """
    # ONE SHARED LINEAR MAP: a plane whose three channels have different ranges must keep
    # their RATIOS. Per-channel normalisation would map each channel's own max to 255 and
    # make a dim blue channel as bright as a saturated red one — a hue shift.
    band = np.zeros((4, 4, 3), dtype=np.uint16)
    band[..., 0] = 1000
    band[..., 1] = 500
    band[..., 2] = 0
    mapped = RQC._to_uint8_rgb(band)
    assert mapped[0, 0].tolist() == [255, 127, 0], (
        f"the three channels were not mapped through ONE range: {mapped[0, 0].tolist()}. "
        "Per-channel normalisation would give [255, 255, 0] — a different colour from the "
        "one the image carries."
    )
    # A uint8 plane short-circuits untouched.
    already = np.array([[[1, 2, 3]]], dtype=np.uint8)
    assert RQC._to_uint8_rgb(already) is already

    # AND THE RENDERER DRAWS SUCH A PLANE rather than raising. Both the 3-channel arm and the
    # 1-channel (`YXS` with one sample) arm, which would otherwise `IndexError`.
    rgb_plane = np.zeros((60, 60, 3), dtype=np.uint16)
    rgb_plane[20:40, 20:40, 0] = 4000
    png, info = RQC.render_overlay(rgb_plane, (np.array([30.0]), np.array([30.0])),
                                   np.array([True]),
                                   cell_diameter_image_px=np.array([10.0]),
                                   caption_lines=["rgb"])
    assert info["marks_drawn"] == 1 and info["display_levels"] is None
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    single = np.zeros((60, 60, 1), dtype=np.uint16)
    single[20:40, 20:40, 0] = 4000
    _png2, info2 = RQC.render_overlay(single, (np.array([30.0]), np.array([30.0])),
                                      np.array([True]),
                                      cell_diameter_image_px=np.array([10.0]),
                                      caption_lines=["grey"])
    assert info2["marks_drawn"] == 1


def test_the_SHIPPED_overlay_really_applies_the_display_stretch(prime, RQC):
    """TEST-23 [acceptance] [invariant: INV-3] [covers: ITEM-1, ITEM-5].

    A blind angle changed `check_registration`'s `render_overlay(..., mask=mask)` to
    `mask=None` — so every real overlay reverts to the plain min/max map on a plane whose 99th
    percentile is ZERO, which is the empty-field render the readability fix was written to
    remove — and the suite stayed green. The display functions were pinned; the SHIPPED PATH
    was not.

    So this compares the artifact a user opens against the same plane rendered without the
    mask, in decoded PIXELS.
    """
    pixels = _decoded(prime)
    overlay = prime["report"]["registration_qc"]["images"][0]["overlay"]
    assert overlay["display_levels"] is not None, (
        "the emitted overlay reports no display levels, so the shipped path did not use the "
        "mask — a sparse fluorescence plane then renders as an empty field"
    )

    entry = XF.entry(prime["entries"], "spatial-image-morphology")
    arr, level_scale, _ = RQC.read_emitted_plane(prime["out"] / entry["path"],
                                                 entry["meta"]["extent"])
    coords, areas = _cells(prime["bundle"])
    xy = RQC._place(entry["meta"]["to_space"], coords, level_scale)
    mask, _info = RQC.signal_mask(arr)
    hit = RQC.score_registration(mask, xy).pop("_hit")
    diameters = 2.0 * np.sqrt(areas / math.pi) / entry["meta"]["to_space"][0]
    unmasked_png, _ = RQC.render_overlay(arr, xy, hit, cell_diameter_image_px=diameters,
                                         caption_lines=["x"])
    from PIL import Image
    import io as _io

    with Image.open(_io.BytesIO(unmasked_png)) as handle:
        unmasked = np.asarray(handle.convert("RGB"))

    # HOW MUCH OF THE TISSUE READS AS BRIGHT, not the frame-wide mean. The plane is >99%
    # background either way, so a mean over the whole frame moves only 0.45 -> 0.66 and would
    # need a threshold too fine to mean anything. The count of near-white pixels is what the
    # reader actually perceives, and it moves by an order of magnitude: measured 76 without
    # the stretch and 714 with it.
    #
    # 200 is above BOTH mark colours in grey (the on-signal mark reads 158, the off-signal one
    # 117), so this counts TISSUE and not the marks drawn over it.
    def _bright(rgb):
        return int((rgb[:overlay["image_height"]].astype(np.float64).mean(axis=2) > 200).sum())

    shipped_bright, unmasked_bright = _bright(pixels), _bright(unmasked)
    assert shipped_bright > unmasked_bright * 3, (
        f"the shipped overlay has {shipped_bright} near-white tissue pixels and the same plane "
        f"rendered WITHOUT the mask has {unmasked_bright}. The shipped path is not applying "
        "the display stretch, so the tissue a human is asked to look at is not visible under "
        "the marks."
    )
    # THE CONTROL: the two renders are the same picture with the same marks, so the difference
    # above is the stretch and nothing else. (The two canvases differ in TOTAL height only
    # because this comparison render carries a one-line caption; the IMAGE regions are the
    # same shape, which is what is compared.)
    assert unmasked.shape[1] == pixels.shape[1]
    assert unmasked.shape[0] >= overlay["image_height"]
    assert _colour_hits(pixels[:overlay["image_height"]], RQC._COLOUR_ON_SIGNAL).sum() == \
        _colour_hits(unmasked[:overlay["image_height"]], RQC._COLOUR_ON_SIGNAL).sum(), (
        "the two renders drew different marks, so the brightness difference above is not the "
        "display stretch"
    )


def test_the_aggregate_is_ALL_not_ANY_over_a_really_mixed_image_set(prime, RQC, tmp_path):
    """TEST-24 [covers: ITEM-1] — one passing image beside one that could not be checked.

    A blind angle changed `all(v == VERDICT_PASS ...)` to `any(...)` and the suite stayed
    green: the leg that claimed to pin it asserted a tautology over a local dict literal and
    never called the production aggregate. So this calls it, over a genuinely mixed set.

    The distinction is the whole reason `not-evaluated` is a third value: every per-image row
    is rendered separately, so a reader of the table would see it — the ONE-WORD AGGREGATE is
    what hid it, and the one-word aggregate is what a machine reads.
    """
    good = XF.entry(prime["entries"], "spatial-image-morphology")
    broken = {"id": "spatial-image-second", "path": "does-not-exist.ome.tif",
              "meta": {"to_space": list(good["meta"]["to_space"]),
                       "extent": dict(good["meta"]["extent"]), "source": "gone"}}
    coords, areas = _cells(prime["bundle"])

    alone, _ = RQC.registration_qc(coords=coords, cell_area_um2=areas,
                                   image_entries=[good], outputs_dir=prime["out"],
                                   scope="test")
    assert alone["verdict"] == "pass", (
        "the control: the good image alone must pass, or 'mixed rolls up to not-evaluated' "
        f"is satisfied by everything failing: {alone['images']}"
    )

    mixed, _ = RQC.registration_qc(coords=coords, cell_area_um2=areas,
                                   image_entries=[good, broken],
                                   outputs_dir=prime["out"], scope="test")
    verdicts = [image["verdict"] for image in mixed["images"]]
    assert verdicts == ["pass", "not-evaluated"], (
        f"the fixture did not produce a mixed set: {verdicts}"
    )
    assert mixed["verdict"] == "not-evaluated", (
        "one image passed and one COULD NOT BE CHECKED, and the aggregate says `pass`. "
        "'Could not be checked' has absorbed into 'checked and fine', which is exactly the "
        "distinction the third value exists to keep — and the aggregate is what a machine "
        f"reads: {mixed['verdict']}"
    )
    assert mixed["verdict"] != "pass"


def test_the_constants_have_a_referent_OUTSIDE_the_constants(RQC):
    """TEST-25 [covers: ITEM-1, ITEM-3] — each threshold pinned to a LITERAL and to behaviour.

    A blind angle moved `MASK_FRACTION_CEILING` to 0.95, `MIN_CELLS_INSIDE_FRACTION` to 0.02,
    `OVERLAY_MAX_EDGE` to 600 and `OVERLAY_MAX_BYTES` to 2 GiB, and the suite stayed green
    every time: every assertion read `RQC.<CONST>`, so moving the constant moved its own
    oracle with it. A boundary driven at the constant proves the comparison is the one the
    code writes; it proves NOTHING about the value.

    So each is asserted twice — as the literal its docstring derives, and at a FIXED point on
    the far side of it, which is what a moved constant cannot satisfy.
    """
    # THE LITERALS, with the derivation each one's `#:` comment records.
    assert RQC.SIGNAL_LIFT_FLOOR == 0.4, (
        "the geometric midpoint of the two measured ends (0.303 worst-wrong, 0.536 "
        "worst-correct). TEST-20 re-measures the interval; this pins the point inside it."
    )
    assert RQC.MIN_CELLS_INSIDE_FRACTION == 0.5
    assert RQC.MASK_FRACTION_CEILING == 0.5, (
        "read off the geometry: above half the frame, 'the cells landed on signal' is the "
        "majority outcome by AREA whatever the placement is"
    )
    assert RQC.BORDER_BACKGROUND_MIN == 0.5
    assert RQC.OVERLAY_MAX_EDGE == 900
    assert RQC.OVERLAY_MAX_BYTES == 2 * 1024 * 1024
    assert RQC.ANALYSIS_PIXEL_BUDGET == 64_000_000
    assert RQC._MIN_ANALYSIS_EDGE == 256

    # AND THE BEHAVIOUR AT FIXED POINTS, which is what a moved constant cannot satisfy.
    #
    # A mask covering 90% of the frame must be REFUSED. This is the case the ceiling exists
    # for and the one the angle's 0.95 would have scored — and scored as a PASS, for any
    # affine at all.
    refused = RQC.registration_verdict(_block(
        signal_mask={"mask_fraction": 0.9, "border_confirms_background": True},
        chance_rate=0.9, signal_lift=0.99))
    assert refused["verdict"] == "not-evaluated", (
        "a mask covering 90% of the frame was SCORED. Every cell lands on a mask that size "
        "whatever the affine, so this is a pass nobody earned."
    )
    # A tenth of the cells in frame must FAIL, and must say the cells left the frame. This is
    # the case the angle's 0.02 would have scored on a handful of survivors.
    starved = RQC.registration_verdict(_block(
        cells_inside_fraction=0.1, cells_inside_image=10, signal_lift=1.0))
    assert starved["verdict"] == "fail" and "land inside this image" in starved["reason"], (
        "90% of the cells left the frame and the block was scored on the rest"
    )
    # A 4000px plane must come back at or under 900. The angle's 600 would also satisfy a
    # `<=`; this asserts the EXACT edge, which only the declared value produces.
    plane = np.zeros((4000, 2000), dtype=np.uint16)
    plane[::7, ::7] = 5000
    _png, info = RQC.render_overlay(plane, (np.array([100.0]), np.array([100.0])),
                                    np.array([True]),
                                    cell_diameter_image_px=np.array([10.0]),
                                    caption_lines=["cap"])
    assert info["image_height"] == 900 and info["width"] == 450, (
        f"a 2000x4000 plane must render at exactly 450x900: {info}"
    )


def test_the_level_scale_is_PER_AXIS_and_a_coarser_level_is_really_reachable(prime, RQC,
                                                                             monkeypatch):
    """TEST-26 [covers: ITEM-2] — the branch both real bundles leave at (1.0, 1.0).

    `read_emitted_plane`'s docstring says a pyramid level's height and width are rounded
    INDEPENDENTLY, so *"applying the x ratio to y would silently misplace every cell along y
    in proportion to the mismatch"*. A blind angle made `_place` use `level_scale[0]` for both
    axes — that exact bug — and the suite stayed green, because both real bundles are read at
    level 0 where the two scales are 1.0 and the claim is unexercised.

    Two legs. `_place` is driven directly with a deliberately ASYMMETRIC scale, so the axis
    binding is pinned whatever the artifact happens to contain. And the coarser-level branch
    is actually REACHED on the real artifact, by lowering the pixel budget, so the per-axis
    derivation is exercised on a real non-square pyramid.
    """
    # (a) THE AXIS BINDING, directly. x must use [0] and y must use [1].
    ux, uy = RQC._place([2.0, 0.0, 0.0, 0.0, 2.0, 0.0],
                        np.array([[10.0, 20.0]]), (3.0, 7.0))
    assert ux == pytest.approx([15.0]) and uy == pytest.approx([70.0]), (
        "x must be scaled by level_scale[0] and y by level_scale[1]; using [0] for both is "
        "the defect `read_emitted_plane`'s docstring says would misplace every cell along y"
    )

    # (b) THE COARSER LEVEL, on the real artifact. Both bundles sit far under the budget, so
    # the branch is reached by lowering it — the same way a Xenium plane too large to hold
    # would reach it in production.
    entry = XF.entry(prime["entries"], "spatial-image-morphology")
    path = prime["out"] / entry["path"]
    extent = entry["meta"]["extent"]
    _arr0, scale0, info0 = RQC.read_emitted_plane(path, extent)
    assert info0["pyramid_level"] == 0 and scale0 == (1.0, 1.0), (
        f"the control: the real artifact is read at level 0 with unit scales: {info0}"
    )
    monkeypatch.setattr(RQC, "ANALYSIS_PIXEL_BUDGET", 1_000_000)
    arr1, scale1, info1 = RQC.read_emitted_plane(path, extent)
    assert info1["pyramid_level"] > 0, (
        f"lowering the budget did not reach a coarser level: {info1}"
    )
    assert arr1.shape == (info1["level_extent"]["height"], info1["level_extent"]["width"])
    assert scale1[0] != scale1[1], (
        f"the coarser level's two scales are equal ({scale1}), so 'rounded independently' is "
        "still unexercised — pick a level whose dimensions round differently"
    )
    assert scale1[0] == pytest.approx(arr1.shape[1] / extent["width"])
    assert scale1[1] == pytest.approx(arr1.shape[0] / extent["height"])

    # AND THE VERDICT SURVIVES THE LEVEL CHANGE. A level chosen for cost must not move the
    # answer; if it does, the per-axis rescale is not absorbing what it claims to.
    coords, _areas = _cells(prime["bundle"])
    mask1, info_mask = RQC.signal_mask(arr1)
    scored = RQC.score_registration(mask1, RQC._place(entry["meta"]["to_space"], coords, scale1))
    scored.pop("_hit")
    coarse = RQC.registration_verdict(dict(scored, to_space=entry["meta"]["to_space"],
                                           signal_mask=info_mask))
    assert coarse["verdict"] == "pass", (
        f"reading a coarser pyramid level changed the verdict: {coarse}"
    )


def test_the_report_carries_the_modules_own_account_of_what_it_does_not_close(prime):
    """TEST-27 [covers: ITEM-5] — the emitted disclosure, asserted where a reader meets it.

    A blind angle emptied `_qc_header`'s `referent_note` and `does_not_check` and the suite
    stayed green: nothing in the package referenced either key. They are the module's own
    statement of what its referent IS and what it does NOT close — including the ~2% limit —
    and this branch's whole posture is that a claim which is not checked is the next stale
    claim.

    The verdict LINES in `meta` are asserted for content here too, for the same reason: a
    blind angle truncated every reason to one character and nothing noticed, on the one
    channel `verdict_lines`'s own docstring argues reaches a human in the shipped app.
    """
    qc = prime["report"]["registration_qc"]
    assert "OUTSIDE the artifact" in qc["referent_note"], (
        "the report no longer says what makes this check different from every other guard in "
        f"this importer: {qc.get('referent_note')!r}"
    )
    assert "morphology image's OWN PIXELS" in qc["referent_note"]
    assert "2%" in qc["does_not_check"] and "TOGETHER" in qc["does_not_check"], (
        "the report must state the two things this check does NOT see — a sub-2% scale error "
        "and a misregistration that moves the image and the cells together — or 'pass' reads "
        f"as 'everything is checked': {qc.get('does_not_check')!r}"
    )
    assert qc["n_cells_checked"] == prime["report"]["n_cells"]

    # THE VERDICT LINES CARRY THEIR REASON, not just the word. `meta` is the channel this app
    # renders, and a one-character reason is a verdict with nothing behind it.
    for entry_id in ("xenium-import-report", "xenium-import-summary"):
        lines = XF.entry(prime["entries"], entry_id)["meta"]["registration_qc"]
        assert len(lines) == 1
        assert len(lines[0]) > 120, (
            f"{entry_id}'s verdict line is {len(lines[0])} characters — the reason has been "
            f"truncated away: {lines[0]!r}"
        )
        assert "signal lift" in lines[0] and "floor" in lines[0], (
            f"{entry_id}'s verdict line carries no measured figure: {lines[0]!r}"
        )


# ── TEST-28..31: the round-2 findings ────────────────────────────────────────────────


def test_a_failed_overlay_WRITE_costs_the_picture_and_not_the_import(tmp_path, monkeypatch):
    """TEST-28 [acceptance] [invariant: INV-2] [covers: ITEM-5].

    `registration_qc` never raises (DEC-7) — and the WRITE its whole purpose is to produce
    sat outside every guard, so an `OSError` there aborted `run_import` at 95% with the
    matrix, the coordinates, 15 columns and the morphology image already on disk and NO
    manifest returned. Found and reproduced by a blind error-handling angle. That is the exact
    outcome DEC-7 forbids, reached through the one statement the guard did not cover.

    §7.5 calls the overlay a REQUIRED output; it does not make it a prerequisite for the
    data. Losing the picture must cost the picture.
    """
    module = XF.load_compute()
    real_write = Path.write_bytes

    def refuse(self, data, *args, **kwargs):
        if self.name.endswith("-registration-overlay.png"):
            raise OSError(28, "No space left on device")
        return real_write(self, data, *args, **kwargs)

    monkeypatch.setattr(Path, "write_bytes", refuse)
    out = tmp_path / "out-nospace"
    out.mkdir()
    entries = module.run_import(Path(XF.PRIME), out)

    ids = {e["id"] for e in entries}
    assert not any(i.endswith("-registration-overlay") for i in ids), (
        "a manifest row points at an overlay whose write failed — the manifest is what "
        f"decides what exists, and it must not name a file that is not there: {sorted(ids)}"
    )
    # AND EVERYTHING ELSE SURVIVED. This is the claim, not "the run did not crash".
    assert {"expression", "spatial-coordinates", "spatial-image-morphology",
            "xenium-import-report", "xenium-import-summary"} <= ids, sorted(ids)
    assert len([i for i in ids if i.startswith("metadata-column:")]) >= 15
    assert (out / "xenium-import-report.json").exists()

    report = json.loads((out / "xenium-import-report.json").read_text())
    assert "overlay_not_written" in report["registration_qc"], (
        "the failure must be REPORTED; a silently absent artifact is indistinguishable from "
        "a broken importer"
    )
    assert "OSError" in report["registration_qc"]["overlay_not_written"]
    # …and the VERDICT is unaffected. The check ran; only the picture was lost.
    assert report["registration_qc"]["verdict"] == "pass"
    assert report["registration_qc"]["images"][0]["signal_lift"] > 0.4


def test_the_display_SUBSAMPLE_is_declared_and_the_score_is_not_subsampled(RQC, monkeypatch):
    """TEST-29 [acceptance] [invariant: INV-3] [covers: ITEM-1].

    §8.3 asks that a display subsample be *"stated as a product decision, not silently
    applied"*, and §7.5 asks that a human see a misregistration INSTANTLY. A blind
    design-conformance angle rendered a production-shaped probe — 300,000 cells, the cell
    count of a real Xenium run against this repo's 23 and 358 — and the outlines completely
    covered the morphology: the tissue was invisible, so the reader could not check what any
    cell was sitting on and "drawn as OUTLINES so the morphology stays visible" was void.

    Three things are asserted: the stride exists and is DECLARED; the picture SAYS so in its
    own pixels; and the SCORE is computed over every cell, because a subsampled verdict would
    be a different check wearing this one's name.
    """
    assert RQC.mark_stride(RQC.OVERLAY_MAX_MARKS) == 1, "at the budget, every cell is drawn"
    assert RQC.mark_stride(RQC.OVERLAY_MAX_MARKS + 1) == 2, "one over, every second"
    assert RQC.mark_stride(0) == 1 and RQC.mark_stride(1) == 1
    assert RQC.mark_stride(300_000) == 15

    # A DENSE PLANE, driven at a lowered budget so the branch is reached without rendering
    # 300k marks in a unit test. The stride is what is under test, not the number.
    monkeypatch.setattr(RQC, "OVERLAY_MAX_MARKS", 50)
    rng = np.random.default_rng(3)
    plane = np.zeros((300, 300), dtype=np.uint16)
    plane[100:200, 100:200] = 5000
    n = 500
    xs = rng.uniform(100, 200, n)
    ys = rng.uniform(100, 200, n)
    mask = plane > 0
    scored = RQC.score_registration(mask, (xs, ys))
    hit = scored.pop("_hit")
    assert scored["n_cells"] == n, (
        "the SCORE must see every cell; a subsampled verdict is a different check"
    )
    _png, info = RQC.render_overlay(plane, (xs, ys), hit,
                                    cell_diameter_image_px=np.full(n, 6.0),
                                    caption_lines=["x"], mask=mask)
    assert info["marks_subsampled"] is True
    assert info["mark_stride"] == 10
    assert info["marks_considered"] == n
    assert info["marks_drawn"] == 50, (
        f"the stride must draw exactly the budget: {info}"
    )
    # AND THE PICTURE SAYS SO. A count in a JSON block travels separately from the picture,
    # which is the whole reason DEC-5 burns the provenance in.
    block = dict(scored, n_cells=n, to_space=[1.0, 0, 0, 0, 1.0, 0], signal_mask={},
                 overlay=info, placed_by={"source": "x", "pixel_size_um": 1.0,
                                          "agreement": "identical"}, verdict="pass",
                 signal_lift=0.9)
    caption = " ".join(RQC._caption_for(block, [{"applied": True}]))
    assert f"SHOWING EVERY {info['mark_stride']}TH OF {n} CELLS" in caption, (
        f"the picture does not say it is showing a subsample: {caption}"
    )
    assert "score above uses ALL of them" in caption

    # BELOW THE BUDGET NOTHING IS SUBSAMPLED, and the picture says nothing about it.
    monkeypatch.setattr(RQC, "OVERLAY_MAX_MARKS", 20_000)
    _png2, plain = RQC.render_overlay(plane, (xs, ys), hit,
                                      cell_diameter_image_px=np.full(n, 6.0),
                                      caption_lines=["x"], mask=mask)
    assert plain["marks_subsampled"] is False and plain["mark_stride"] == 1
    assert plain["marks_drawn"] == n
    block2 = dict(block, overlay=plain)
    assert "SHOWING EVERY" not in " ".join(RQC._caption_for(block2, [{"applied": True}]))


def test_an_absurd_cell_area_cannot_STALL_the_render(RQC):
    """TEST-30 [covers: ITEM-1] — the radius is capped, and the clamp is reported.

    `cell_area` is the only numeric vendor column this importer reads with no range check,
    and PIL's `ellipse` cost is catastrophic AND non-monotonic in the radius: a blind
    error-handling angle measured 31.8 s for ONE mark at r = 5e4 while r = 2e4 and r = 2e5 are
    sub-millisecond. A stall is not an exception — the sandbox's wall-clock kill is a SIGKILL,
    which no `except` converts into `not-evaluated` — so an absurd but FINITE area would cost
    the whole import rather than the picture.

    The wall-clock bound is asserted, not just the reported number: the number is what the
    code says it did and the clock is what the sandbox measures.
    """
    import time

    plane = np.zeros((200, 200), dtype=np.uint16)
    plane[80:120, 80:120] = 4000
    started = time.monotonic()
    _png, info = RQC.render_overlay(
        plane, (np.array([100.0, 110.0]), np.array([100.0, 110.0])),
        np.array([True, True]),
        # 1.5e10 um^2 through a typical affine is the ~5e4 px radius that measured 31.8 s.
        cell_diameter_image_px=np.array([1.0e5, 8.0]),
        caption_lines=["huge"])
    elapsed = time.monotonic() - started
    assert elapsed < 5.0, (
        f"one absurd `cell_area` took {elapsed:.1f}s to draw. The sandbox kills on wall clock "
        "with a SIGKILL, which no guard converts into a `not-evaluated` verdict, so this "
        "costs the matrix and the coordinates rather than the picture."
    )
    assert info["marks_clamped_to_max_radius"] == 1, (
        "a mark drawn at the wrong size is the one thing DEC-10 says the reader is reading; "
        f"clamping it silently would make an absurd area look like an ordinary one: {info}"
    )
    assert info["marks_drawn"] == 2
    # AND AN ORDINARY BUNDLE CLAMPS NOTHING, or the counter says nothing.
    _png2, ordinary = RQC.render_overlay(
        plane, (np.array([100.0]), np.array([100.0])), np.array([True]),
        cell_diameter_image_px=np.array([8.0]), caption_lines=["ok"])
    assert ordinary["marks_clamped_to_max_radius"] == 0


def test_the_caption_says_WHICH_of_the_four_cross_check_outcomes_happened(RQC):
    """TEST-31 [acceptance] [invariant: INV-4] [covers: ITEM-4].

    `stated_scale_agreement` has FOUR outcomes and its own docstring says why: *"folding any
    pair together would make a check that silently stopped running look exactly like a check
    that was never available"*. The caption folded three of them into one sentence — "the
    bundle's two statements of the pixel size do not disagree" — which reports a check that
    NEVER RAN (`single-source`: the image stated nothing; `unreadable-unit`: it stated
    something in a unit this importer cannot convert) as a check that was SATISFIED.

    Burned into the picture, which is the one place a reader cannot go back and qualify it.
    Found by a blind design-conformance angle on a bundle whose OME-XML carries no
    PhysicalSize.
    """
    def caption(agreement, candidates):
        block = {"n_cells": 10, "verdict": "pass", "signal_lift": 0.6, "source": "img",
                 "placed_by": {"source": "experiment.xenium:pixel_size",
                               "pixel_size_um": 0.2125, "agreement": agreement}}
        return " ".join(RQC._caption_for(block, candidates))

    applied = [{"applied": True}]
    identical = caption("identical", applied)
    assert "states this pixel size TWICE and the two are the same number" in identical, (
        f"the one outcome where the check RAN and agreed must say so: {identical}"
    )
    for agreement in ("single-source", "unreadable-unit"):
        text = caption(agreement, applied)
        assert "did NOT run" in text and agreement in text, (
            f"{agreement}: a check that never ran must not be reported as one that agreed: "
            f"{text}"
        )
        assert "do not disagree" not in text, (
            f"{agreement}: the picture still claims the two statements agree, when there was "
            f"no second statement to agree with: {text}"
        )
        assert "decides nothing about which statement is right" in text

    differs = caption("differs", applied + [{"applied": False, "source": "OME", "signal_lift": 0.1,
                                             "pixel_size_um": 0.5}])
    assert "THE OTHER STATEMENT" in differs and "decides which of the two is right" in differs


def test_the_display_stretch_COMMUTES_with_the_reduction(RQC):
    """TEST-32 [covers: ITEM-1] — the memory fix does not change a pixel.

    The stretch was moved to AFTER the block-max reduction, so a full-resolution float64 copy
    of the plane is never allocated (a blind error-handling angle measured +1.6 GB of peak RSS
    on an 8000x8000 plane, for a path whose only product is a 900 px PNG). That is only sound
    because both maps are MONOTONE INCREASING and a monotone map commutes with a maximum.

    "Sound because of an argument" is what this branch does not accept. So the two orders are
    computed and required to be pixel-identical.
    """
    rng = np.random.default_rng(11)
    plane = (rng.integers(0, 4000, size=(400, 620))).astype(np.uint16)
    plane[100:150, 100:150] = 60000
    mask = plane > 3500
    levels = RQC._display_levels(plane, mask)
    assert levels is not None
    target = (155, 100)

    stretch_then_reduce = RQC._block_max_downscale(RQC._stretch_uint8(plane, levels), target)
    reduce_then_stretch = RQC._stretch_uint8(RQC._block_max_downscale(plane, target), levels)
    assert np.array_equal(stretch_then_reduce, reduce_then_stretch), (
        "the two orders differ, so moving the stretch after the reduction changed the "
        "picture — the commuting argument the memory fix rests on does not hold here"
    )
    # THE CONTROL: the reduction is not a no-op, or the equality above is trivial.
    assert stretch_then_reduce.shape == (100, 155) != plane.shape
    assert stretch_then_reduce.max() == 255 and stretch_then_reduce.min() < 255

    # AND THE ALLOCATION IS ACTUALLY BOUNDED, which is the point of the reorder and is the
    # half an equivalence property cannot carry. Measured with `tracemalloc` rather than RSS,
    # because RSS is noisy and the allocator's own reuse is not this module's business.
    #
    # The bound is stated relative to THE PLANE'S OWN BYTES: a display path whose only product
    # is a <=900px PNG has no business allocating several times the image it is reducing. A
    # full-resolution float64 stretch alone is 4x a uint16 plane; the pre-fix path allocated
    # that plus two more full planes in `signal_mask` and another in `_display_levels`.
    import tracemalloc

    big = np.zeros((2400, 2400), dtype=np.uint16)
    big[::11, ::11] = 5000
    big_mask = big > 0
    plane_bytes = big.nbytes
    tracemalloc.start()
    RQC.render_overlay(big, (np.array([100.0]), np.array([100.0])), np.array([True]),
                       cell_diameter_image_px=np.array([8.0]), caption_lines=["m"],
                       mask=big_mask)
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert peak < plane_bytes * 3, (
        f"rendering peaked at {peak / 1e6:.0f} MB for a {plane_bytes / 1e6:.0f} MB plane "
        f"({peak / plane_bytes:.1f}x). The display path reduces to at most "
        f"{RQC.OVERLAY_MAX_EDGE}px; a full-resolution float64 copy of the plane is what this "
        "bound exists to keep out, and under the sandbox's cgroup limit an over-budget "
        "allocation is an OOM SIGKILL, which no guard converts into `not-evaluated`."
    )


def test_the_overlays_catalog_row_does_not_claim_a_size_the_bundle_did_not_give(tmp_path):
    """TEST-33 [covers: ITEM-5] — the row's prose follows the run, not a literal.

    `meta.what_this_shows` claimed unconditionally that the marks are drawn "each at its own
    vendor-measured area" — DEC-10's stated mechanism for making a misscale visible to an eye.
    `cell_area` is absent on an XOA version that does not write it, and the radius then falls
    back to a minimum visible mark, so the human-facing claim in the artifact row was FALSE
    exactly when the machine-readable half of the same block recorded
    `cell_diameter_image_px.median: None`. Found by a blind design-conformance angle,
    reproduced by removing the column.
    """
    import csv
    import gzip

    bundle = XF.stage_bundle(tmp_path, name="no-area")
    path = bundle / "cells.csv.gz"
    with gzip.open(path, "rt", newline="") as fh:
        rows = list(csv.reader(fh))
    drop = rows[0].index("cell_area")
    stripped = [[v for i, v in enumerate(row) if i != drop] for row in rows]
    with gzip.open(path, "wt", newline="") as fh:
        csv.writer(fh).writerows(stripped)

    out = tmp_path / "out-no-area"
    _module, entries = XF.run_over(bundle, out)
    report = json.loads((out / "xenium-import-report.json").read_text())
    block = report["registration_qc"]["images"][0]
    assert block["cell_diameter_image_px"]["median"] is None, (
        "the fixture still carries `cell_area`, so the fallback is not being exercised"
    )
    row = XF.entry(entries, "spatial-image-morphology-registration-overlay")["meta"]
    assert "each at its own vendor-measured area" not in row["what_this_shows"], (
        "the catalog row claims the marks carry the vendor's measured areas on a bundle that "
        f"has none: {row['what_this_shows']!r}"
    )
    assert "no `cell_area`" in row["what_this_shows"], (
        "…and it must say WHY the marks are a fallback size, or a reader reads a minimum mark "
        f"as a measured one: {row['what_this_shows']!r}"
    )
    # THE CONTROL: the same importer over the UNMODIFIED fixture DOES make the claim, so the
    # assertion above is about this bundle and not about the sentence having been deleted.
    control_out = tmp_path / "out-with-area"
    _m, control_entries = XF.run_over(XF.PRIME, control_out)
    control_row = XF.entry(control_entries,
                           "spatial-image-morphology-registration-overlay")["meta"]
    assert "each at its own vendor-measured area" in control_row["what_this_shows"]


# ── TEST-19 / TEST-20: the residues, and the constant's derivation ───────────────────


def test_the_residues_this_branch_could_not_reach_are_DISCLOSED_not_left_false():
    """TEST-19 [covers: ITEM-11] — the scope boundary is stated where a reader meets it.

    Two things this branch could not fix, and neither may be left as prose that is simply
    wrong:

    * `spatial-types/compute/`'s shared modules carry the pre-#301 position and are vendored
      BYTE-IDENTICALLY into all three spatial packages, so correcting them there forces a
      matching edit inside `spatial-import-visium`, which a concurrent branch owns. That is
      #302, and the corrected sites here name it — the same discipline #291 applied to the gap
      this branch closes, one level up.
    * every invariant this module realizes is lifted from a design section, and the sites say
      which, so a reader who disbelieves the claim has somewhere to go.

    A finding reported only in a commit message is a finding that is lost.
    """
    for rel in ("compute/import_xenium.py", "compute/boundaries.py", "manifest.yaml",
                "compute/registration_qc.py"):
        text = (_XENIUM / rel).read_text(encoding="utf-8")
        assert "§7.5" in text or "section 7.5" in text, (
            f"{rel} makes claims about the registration overlay without naming the design "
            "section they come from"
        )
    for rel in ("compute/import_xenium.py", "compute/boundaries.py", "manifest.yaml"):
        assert "#302" in (_XENIUM / rel).read_text(encoding="utf-8"), (
            f"{rel} does not name #302 — the same prose, still stale in the shared modules "
            "this package vendors byte-identically. A residue named nowhere is a stale claim "
            "with no pointer, which is what #291 and #294 were both filed about"
        )
    # AND THE VENDORED COPIES ARE UNTOUCHED, which is what makes #302 the right answer rather
    # than an excuse. If this branch had edited them, the byte-identity guard would be red and
    # the sibling package would need a matching change.
    for name in ("spatial_declarations.py", "ome_writer.py"):
        mine = (_XENIUM / "compute" / name).read_bytes()
        source = (_XENIUM.parent / "spatial-types" / "compute" / name).read_bytes()
        assert mine == source, (
            f"{name} has drifted from `spatial-types/compute/`. This branch must not edit "
            "either copy: they are vendored into all three spatial packages, so a change "
            "here forces one inside `spatial-import-visium` (#300 records five consecutive "
            "branches colliding on exactly that)"
        )


def test_the_signal_lift_floor_is_pinned_to_its_DERIVATION_by_re_measuring_both_ends(
        prime, protein, RQC):
    """TEST-20 [acceptance] [invariant: INV-4] [covers: ITEM-3, ITEM-10].

    §7.3, verbatim: *"the design rule is: **declare the space, never the scale factor
    alone.**"* A floor that can be moved to make a placement pass is a scale factor by another
    name — it decides, from a number this repo chose, whether a declared space is accepted.

    So the constant is not quoted from a comment; both ends of its derivation are RE-MEASURED
    here, on both real vendor bundles, and the floor must sit strictly between them:

        worst CORRECT score  >  SIGNAL_LIFT_FLOOR  >  best WRONG score

    Move the constant outside that interval and this goes red. Let a mutation start scoring
    above a correct placement — which is what would happen if the statistic stopped
    discriminating — and it goes red from the other side. The comment in the module records
    0.608 / 0.536 at the correct end and 0.303 at the wrong end; this recomputes them rather
    than trusting them, because a derivation that lives only in prose drifts away from the
    number it derived.
    """
    correct, wrong = [], []
    for ctx in (prime, protein):
        to_space = list(XF.entry(ctx["entries"],
                                 "spatial-image-morphology")["meta"]["to_space"])
        block, _ = _rescore(RQC, ctx, to_space)
        correct.append(block["signal_lift"])
        # The wrong end is measured over the SAME defect class the module's table records,
        # including the smallest one it claims to catch: a 2% misscale.
        for factor in (2.0, 0.5, 1.10, 1.05, 1.02):
            skewed = [to_space[0] * factor, 0.0, to_space[2],
                      0.0, to_space[4] * factor, to_space[5]]
            mutant, _ = _rescore(RQC, ctx, skewed)
            wrong.append(mutant["signal_lift"])
        translated = [to_space[0], 0.0, to_space[2] + 20.0,
                      0.0, to_space[4], to_space[5] + 20.0]
        wrong.append(_rescore(RQC, ctx, translated)[0]["signal_lift"])

    worst_correct, best_wrong = min(correct), max(wrong)
    assert best_wrong < RQC.SIGNAL_LIFT_FLOOR < worst_correct, (
        f"SIGNAL_LIFT_FLOOR = {RQC.SIGNAL_LIFT_FLOOR} is not between the two ends it was "
        f"derived from. Measured on the real vendor bundles: the worst CORRECT placement "
        f"scores {worst_correct:.3f} (all: {[round(c, 3) for c in correct]}) and the best "
        f"WRONG one scores {best_wrong:.3f} (all: {[round(w, 3) for w in sorted(wrong)]}). "
        "Either the constant moved, or the statistic stopped separating the two — and a floor "
        "outside its own derivation is a number nothing pins."
    )
    # AND THE GAP IS REAL, not a hair. A floor wedged between two values a rounding apart
    # would satisfy the line above while pinning nothing.
    assert worst_correct > best_wrong * 1.5, (
        f"the two ends are {best_wrong:.3f} and {worst_correct:.3f} — too close for the floor "
        "between them to mean anything. The statistic has stopped discriminating."
    )
    # THE HONEST LIMIT, ASSERTED RATHER THAN CLAIMED: the module says it does not resolve a
    # misscale below about 2%. If it suddenly did, the docstring would be understating the
    # check — which is the safer direction, but it is still a stale claim, so it is pinned.
    assert best_wrong > 0.15, (
        f"the best wrong score is {best_wrong:.3f}. The module's stated limit is that a ~2% "
        "misscale is NOT resolved; if every mutation now scores near zero, that sentence is "
        "wrong and the docstring must be corrected rather than left flattering."
    )
