#!/usr/bin/env python3
# ruff: noqa
"""The registration QC — the only check in this arm with a referent OUTSIDE the artifact.

## This file is THIS PACKAGE'S OWN, and deliberately not a vendored copy

There are now three `registration_qc.py` files in this tree — this one,
`spatial-import-visium/compute/registration_qc.py` and
`spatial-import-xenium/compute/registration_qc.py` — and the two that already existed
ALREADY DIFFER FROM EACH OTHER. They have to: the whole value of this check is that its
referent comes from outside the artifact, and what lies outside the artifact is a property
of the PLATFORM. Visium's referent is the manufactured 100 um spot pitch of a capture slide;
this module's is the bin lattice pitch of an HD capture grid; Xenium's is its own.

So this file is not a copy that has drifted and not a copy waiting to be de-duplicated. A
byte-compare between any two of them would assert an identity that is FALSE BY DESIGN, and
the "shared" abstraction that would make them identical is exactly the abstraction that
would let one platform's referent be applied to another platform's data. The parts that are
genuinely platform-independent — Youden's J, the Otsu polarity call, the affine inverse, the
DEC-7 guard — are the same algorithm written per-platform on purpose, and each copy is free
to state the truth about ITS platform in its own comments rather than carry the other's.

Where a number in this file was MEASURED, it was measured here. Where a number was measured
on the Visium side, it is cited as such and NOT restated as if it had been re-measured on
this package's fixture — this package's fixture is SYNTHESIZED (`tests/make_fixture.py`),
and a synthetic bundle cannot corroborate a claim about real vendor data.

## Why this module exists

Every other guard in this arm reconciles the artifact **with itself** — the coordinates, the
pixels and the declared scale are required to agree. A uniform misscale satisfies all of
them, because it is wrong in the same proportion everywhere. Nothing that only looks inside
the artifact can ever see it.

That is not a hypothesis. It was DEMONSTRATED one package over, by two shipped tests that
assert a WRONG artifact PASSES and name this check as the only thing that could catch it —
`spatial-import-visium/tests/test_sandbox_reachability.py` TEST-9 (#155), where a
deliberately wrong affine survives the declaration constructor, the OME writer, the reader
and the placement round trip; and `spatial-import-visium/tests/test_image_downsample.py`
TEST-11 (#176), where a wrong vendor `spot_diameter_fullres` yields a different resolution,
a different factor, a different pixel grid and a different number of bytes on disk and
*"every check still passes, because every derived value agrees with every other."* Nothing
about that argument is Visium-specific; it is a statement about internal-consistency checks.

So this module does not add another internal-consistency assertion. It measures two things
against referents that are not functions of the artifact's coordinates at all.

## R1 — the bin lattice (`check_scale`)

Visium HD does not have a manufactured slide design with a fixed spot pitch. What it has
instead is a capture area that is *"a continuous grid of 2x2 um squares (no gaps)"*
(`docs/research/data-processing/06-spatial-processing.md:120`). CONTIGUOUS is the whole
point: with no gaps between squares, a bin's SIDE is also its centre-to-centre PITCH, so one
number describes both. The vendor states it as `bin_size_um` in `scalefactors_json.json`
(`docs/research/data-processing/01-file-formats.md:602`), and it reaches this module as the
`bin_pitch_um` argument rather than as a module constant.

### Why this is still an EXTERNAL check, and where it is weaker than Visium's

The obvious objection is that the referent now comes out of the bundle, so the check must be
circular. It is not, and the reason is which FILE each side comes from:

* `bin_size_um` is a **DECLARATION**, and it lives in `scalefactors_json.json` — the same
  file `microns_per_pixel` / `spot_diameter_fullres` come from.
* the pitch is **MEASURED**, off the PIXEL columns of `tissue_positions`, a file that never
  touches `scalefactors_json.json` and is not derived from it.

So the two sides are independent observations in exactly the way the Visium check's 100 um
slide constant is independent of `spot_diameter_fullres`: a wrong `microns_per_pixel` moves
`measured_pitch_px * microns_per_pixel` in exact proportion while `bin_size_um` stays put,
and the check sees it.

What is HONESTLY weaker: Visium's referent is a property of MANUFACTURED GLASS that no
vendor field can move, whereas this one is VENDOR-DECLARED. A bundle whose `bin_size_um` is
wrong in the same proportion as its `microns_per_pixel` would pass here and would not pass
on Visium. That is one notch weaker, it is not parity, and this module says so rather than
implying otherwise — the report carries `referent_strength` for that reason. It remains far
stronger than no external referent at all, because the two numbers are written by different
stages of Space Ranger into different files and nothing in this importer reconciles them.

The pitch is estimated as a MEDIAN NEAREST-NEIGHBOUR DISTANCE between bin centres, and
deliberately NOT from `array_row`/`array_col`.
`docs/research/spatial-platforms/01-sequencing-platforms.md:67-71` -- a document that is NOT
on `main`; it lives on `origin/docs/research-spatial-platforms` (introduced by 2ba1bf0f), and
the ref is named here because a bare path a reader cannot open reads as an invented citation
-- is explicit: *"Orientation
is NOT derivable from array indices... Slide rotation at imaging time decides it. Never
reconstruct positions from `array_row`/`array_col`."* A median nearest-neighbour distance is
invariant to that rotation, to reflection, and to the index convention entirely. The
least-squares lattice fit against the indices is computed too, but purely as a corroborating
diagnostic in the report; it gates nothing.

## R2 — the tissue in the image (`check_registration`)

Space Ranger's `in_tissue` flag is the VENDOR'S OWN tissue detection, produced by the
vendor's pipeline in the vendor's frame. The image pixels are a separate observation of the
same tissue. Neither is a function of `to_space`.

So: map every bin into the image's own grid through the image's DECLARED `to_space`, derive
a tissue mask from the PIXELS, and score that mask against `in_tissue` with Youden's J. Under
a correct registration the two agree; under a wrong affine they decorrelate toward chance.
This is "put the coordinates on top of the image and look at whether the bins land on the
tissue", made computable.

The mask comes from the pixels and NOT from `in_tissue` (DEC-3). A mask built from the
positions table and scored against bins from the same positions table would agree with
itself by construction — an internal-consistency assertion wearing an overlay's clothes,
which is the one thing this module may not be.

## What this module CANNOT check, stated rather than implied

* It cannot detect a misregistration that moves the image and the bins TOGETHER. Nothing
  can; that is not a misregistration, it is a different frame.
* It cannot detect a `bin_size_um` that is wrong in the same proportion as
  `microns_per_pixel`. See the honesty note under R1.
* `J_FLOOR` is read off Youden's J's own scale (0 = chance, 1 = perfect), not calibrated
  against real H&E. This package's positive control is SYNTHETIC — `tests/make_fixture.py`
  paints tissue where the fixture says the bins are, so the right answer is known by
  construction. A synthetic control proves the check DISCRIMINATES between a right and a
  wrong mapping over identical pixels; it does not prove the floor is right for real
  staining, and this package has not run it over a real HD bundle. That is why every score
  is reported as a NUMBER beside its verdict, and why `positive_control` says `synthetic`.
* R1 is specific to a regular capture lattice. It self-declines when no pitch referent is
  supplied, rather than inventing one.

## This module never raises into the import (DEC-7)

A diagnostic that destroys a user's access to their data is worse than one that reports
loudly. `registration_qc` wraps its whole body the way `emit_images` does, and any failure
becomes a `not-evaluated` verdict naming the exception type. `not-evaluated` is a THIRD
value, distinct from both `pass` and `fail`, so "could not be checked" can never be read as
"checked and fine".
"""
import base64
import io
import math
from pathlib import Path

import numpy as np

# The VENDORED write-time contract, staged beside this module by `run.helpers`. Used for ONE
# thing: reading the placement back out of an emitted artifact's own OME-XML, which is the
# declaration a sandboxed consumer actually gets.
import spatial_declarations as SD

# ── the referent, and the thresholds ─────────────────────────────────────────────────
#
# THERE IS NO MODULE-LEVEL PITCH CONSTANT HERE, AND THAT ABSENCE IS DELIBERATE.
#
# The Visium module carries the referent as a module constant because a capture slide's
# 100 um spot pitch is one number for every V1/V2 bundle that will ever exist. Visium HD has
# no such number: the same bundle ships `square_002um`, `square_008um` and `square_016um`,
# and the pitch of the lattice under test is whichever binning this import selected. So the
# referent ARRIVES as the `bin_pitch_um` argument, from the bin the caller actually imported.
#
# That makes it look like a knob, and it is not one: the caller does not choose the value,
# it reads it out of the selected bin's own `scalefactors_json.json` (`bin_size_um`). The
# DEC-11 rule the Visium constant states — "a check whose referent can be moved to make it
# pass is not a check" — is preserved by there being no path from an operator or an admin
# setting to this argument, not by the value being hard-coded.

#: Relative tolerance on `measured_pitch_px * microns_per_pixel` against the declared bin
#: pitch.
#:
#: INHERITED FROM THE VISIUM MODULE, NOT RE-DERIVED HERE, and that is a real qualification
#: rather than a formality. Over there the value was derived BEFORE any verdict was computed
#: (DEC-4) from two ends it had to separate — a lattice-residual noise floor and the smallest
#: defect in evidence — both MEASURED on a committed REAL vendor bundle. See
#: `spatial-import-visium/compute/registration_qc.py` for those numbers; they are not
#: restated here, because this package's fixture is synthesized and re-quoting a measurement
#: taken on other data as if it had been made here is the exact dishonesty this file's header
#: refuses.
#:
#: What carries over WITHOUT a fixture is the shape of the argument: a misscale defect is
#: proportional (TEST-11's own mutation doubles the scale), so the signal is tens of percent,
#: while a regular lattice's own departure from ideal is a fraction of one percent. 5% sits
#: an order of magnitude away from both ends of that gap and nothing depends on where in the
#: gap it sits. Recalibrating it against a real HD bundle is work this package has not done.
PITCH_TOLERANCE = 0.05

#: The floor on Youden's J = sensitivity + specificity - 1, scoring the pixel-derived tissue
#: mask against the vendor's `in_tissue` call.
#:
#: Read off the STATISTIC'S OWN SCALE, not calibrated to a fixture: J = 0 is exactly chance
#: (the image says nothing about where the vendor found tissue, which is what a wrong affine
#: produces) and J = 1 is perfect agreement. 0.5 says "the declared mapping recovers at least
#: half of the vendor's own tissue call". A threshold taken from the metric's range does not
#: move when the fixture changes, which is what keeps it from being tuned until green — and
#: it is the one threshold in this module that needs no platform-specific justification at
#: all, because Youden's J has the same scale wherever it is computed.
J_FLOOR = 0.5

#: Before J is computed at all, at least this fraction of bins must land inside the image.
#: J over a handful of survivors is not a measurement, and a badly wrong affine's FIRST
#: symptom is that the bins leave the frame entirely — which deserves to be reported as
#: itself rather than laundered into a low score.
MIN_SPOTS_INSIDE_FRACTION = 0.5

#: Longest edge of the rendered overlay PNG. The overlay is a `data:` URI inside a report a
#: browser renders, so it is bounded for the same reason `DIAGNOSTIC_INLINE_CAP_BYTES` exists:
#: a multi-thousand-pixel plane inlined as base64 would make the report unopenable.
OVERLAY_MAX_EDGE = 900

#: …and a cap on the ENCODED bytes, because bounding the edge length does not bound the file.
#: `OVERLAY_MAX_EDGE`'s reasoning cites `DIAGNOSTIC_INLINE_CAP_BYTES` as its precedent, and
#: that constant caps BYTES. A noisy 900x900 RGB plane compresses poorly, and two of them plus
#: the vendor's own diagnostics can push the report to several megabytes with nothing saying
#: why. Same value as the vendor-diagnostic cap, for the same reason and against the same
#: reader.
OVERLAY_MAX_BYTES = 2 * 1024 * 1024

#: The pixel budget for the plane this module READS BACK. Above it the coarsest pyramid level
#: that still clears [`_MIN_ANALYSIS_EDGE`] is used instead, and the mapping is rescaled from
#: the level's OWN shape against the declared extent — derived from the array, never assumed —
#: so a level choice cannot silently misplace a bin.
ANALYSIS_PIXEL_BUDGET = 64_000_000
_MIN_ANALYSIS_EDGE = 256

#: Above this many bins the nearest-neighbour estimator switches from the whole array to a
#: contiguous spatial WINDOW of this size. The estimator is O(n^2), and THIS is the platform
#: that constant was written for: a Visium capture slide holds a few thousand spots, while an
#: HD bundle's 2 um bins run to millions, so an unwindowed estimator would hang a user's
#: import at 95%.
#:
#: A WINDOW, never a scattered subsample: sampling scattered points removes a lattice point's
#: true nearest neighbours and inflates the pitch, which would corrupt the one measurement
#: this whole module rests on. A contiguous region does not, because a capture lattice is
#: homogeneous — the pitch inside any sub-region IS the pitch of the whole — and an HD grid is
#: contiguous by construction, which makes the homogeneity argument stronger here than on a
#: slide with fiducials and edges. The report says when a window was used.
PITCH_EXACT_MAX_SPOTS = 20_000

#: A cap on how many marks the overlay DRAWS, which the Visium module has no need of.
#:
#: The renderer is a per-mark Python loop with one PIL draw call per entity. That is fine for
#: the few thousand spots of a capture slide and it is not fine for an HD bundle, which
#: presents orders of magnitude more entities from the same capture area — the same asymmetry
#: `PITCH_EXACT_MAX_SPOTS` exists for, arriving at a different loop. And the extra marks buy
#: NOTHING: past roughly one mark per overlay pixel the squares overprint into a solid mass,
#: so a picture drawn from every bin is both slower and less readable than one drawn from a
#: subset.
#:
#: A DETERMINISTIC STRIDE, and here — unlike in the pitch estimator — a stride is the RIGHT
#: choice rather than the forbidden one. The estimator refuses a scattered subsample because
#: it destroys nearest-neighbour distances; the overlay measures no distances at all. What it
#: has to answer is "do the bins land on the tissue", and that question is answered better by
#: a coarser lattice spread over the WHOLE capture area than by a contiguous corner window
#: that might show nothing but background. The result is a regular sub-lattice of the real
#: one, and the overlay info records the stride so the picture cannot be mistaken for a
#: complete one.
#:
#: The value is a BOUND ON THE LOOP, not a measured visual optimum — no timing was taken on
#: this package's synthesized fixture and none is claimed. It is set well above the entity
#: count of any Visium-generation bundle, so this module draws such data exactly as the
#: sibling does, and well below the millions an HD 2 um bundle presents.
OVERLAY_MAX_MARKS = 100_000

#: A Youden's J at or below MINUS this is not a misregistration — it is an INVERTED MASK.
#:
#: A wrong affine scatters the bins, which drives J toward 0 (chance). Driving it toward -1
#: takes systematic ANTI-correlation: in-tissue bins landing on background AND out-of-tissue
#: bins landing on tissue, together. The only thing that produces that is the tissue mask
#: having the wrong polarity, and reporting it as "the vendor's own in_tissue call and this
#: image's own pixels disagree about where the tissue is" would be a confidently-worded FAIL
#: about the wrong thing. So it becomes `not-evaluated` naming the real cause.
#:
#: This is NOT `abs(J)`. Taking the absolute value would make the statistic unable to fail,
#: which is the defect this module exists to remove; a genuine misregistration still scores
#: near 0 and still fails.
J_INVERSION_FLOOR = 0.5

VERDICT_PASS = "pass"
VERDICT_FAIL = "fail"
VERDICT_NOT_EVALUATED = "not-evaluated"

#: Bin outline colours in the overlay, by the vendor's `in_tissue` call. Drawn as outlines so
#: the tissue underneath stays visible — the whole point is to see what the bin is sitting on.
#: The same two colours as the Visium module, because a reader who has looked at one report
#: should not have to relearn the legend to read the other.
_COLOUR_IN_TISSUE = (0, 200, 255)
_COLOUR_OUT_TISSUE = (255, 96, 0)

#: The verdict banner's colours, by verdict. A `not-evaluated` must not be able to look like
#: a pass at a glance — that is the whole reason it is a third value and not a missing one.
#:
#: Lives HERE rather than in `import_visium_hd`, unlike its Visium counterpart: this package
#: keeps the banner beside the check that produces it, so the wording and the verdict cannot
#: drift apart across a module boundary.
_VERDICT_STYLE = {
    "pass": ("#0a7", "#eafaf3", "Registration QC passed"),
    "fail": ("#c22", "#fdecec", "Registration QC FAILED"),
    "not-evaluated": ("#a70", "#fdf6e6", "Registration QC could not be evaluated"),
}


class RegistrationQCError(RuntimeError):
    """Raised INSIDE this module and caught at its own boundary. Never escapes to the import."""


# ── R1: the scale, against the bin lattice ───────────────────────────────────────────


def measure_spot_pitch(coords):
    """`{median_nn_px, n_spots, n_measured, min_nn_px, max_nn_px}` from bin centres alone.

    The median distance from each bin to its nearest other bin. On an HD capture grid every
    interior bin has four neighbours at exactly the pitch (and four more at pitch * sqrt(2),
    which the MINIMUM never selects), so the median is the pitch even on a subset that has
    lost some of them, and it is invariant to the slide rotation that
    `01-sequencing-platforms.md:67-71` says makes the array indices unusable for this.

    Returns `None` for the pitch when fewer than two bins carry a position — absence is
    absence, and a pitch invented from one point would be worse than no check.
    """
    pts = np.asarray(coords, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 2:
        return {"median_nn_px": None, "n_spots": int(len(pts)), "n_measured": 0}
    total = int(len(pts))
    # NON-FINITE POINTS ARE DROPPED, AND COUNTED. `float(v)` accepts the text "nan" and "inf"
    # happily, and a single NaN coordinate makes `dist[:, j]` NaN for EVERY i — so the row
    # minimum is NaN for every bin, `finite` comes back empty, and the whole external scale
    # check disables itself while reporting "fewer than two bins carry a position", which is
    # false. One bad row must not cost the measurement, and a reader is entitled to know a row
    # was excluded rather than have it vanish.
    usable = np.isfinite(pts).all(axis=1)
    n_dropped = int((~usable).sum())
    pts = pts[usable]
    if len(pts) < 2:
        return {"median_nn_px": None, "n_spots": total, "n_measured": 0,
                "n_dropped_non_finite": n_dropped}
    windowed = False
    if len(pts) > PITCH_EXACT_MAX_SPOTS:
        # Deterministic (lowest y, then lowest x) so two runs over one bundle agree.
        order = np.lexsort((pts[:, 0], pts[:, 1]))
        pts = pts[order[:PITCH_EXACT_MAX_SPOTS]]
        windowed = True
    # O(n^2) on purpose, over a WINDOWED point set: `PITCH_EXACT_MAX_SPOTS` bounds n before we
    # get here, so this is at most ~400M distances' worth of work in float64 — bounded, and
    # bought against a `scipy.spatial` import whose cost is a declared dependency this module
    # does not otherwise need. Chunked so the peak memory is bounded by the chunk rather than
    # by n^2, which is what makes it safe to keep simple if the window is ever widened.
    n = len(pts)
    nn = np.empty(n, dtype=np.float64)
    chunk = max(1, min(n, 4_000_000 // max(1, n)))
    for start in range(0, n, chunk):
        stop = min(n, start + chunk)
        block = pts[start:stop, None, :] - pts[None, :, :]
        dist = np.sqrt((block ** 2).sum(axis=2))
        # A bin is its own nearest neighbour at distance 0; mask the diagonal, not every
        # zero — two bins at the SAME position is a real (and reportable) defect, and
        # dropping all zeros would hide it behind a plausible pitch.
        dist[np.arange(stop - start), np.arange(start, stop)] = np.inf
        nn[start:stop] = dist.min(axis=1)
    finite = nn[np.isfinite(nn)]
    if not len(finite):
        return {"median_nn_px": None, "n_spots": total, "n_measured": 0,
                "n_dropped_non_finite": n_dropped}
    return {
        "median_nn_px": float(np.median(finite)),
        "n_spots": total,
        "n_measured": int(len(finite)),
        "n_dropped_non_finite": n_dropped,
        "windowed": windowed,
        "min_nn_px": float(finite.min()),
        "max_nn_px": float(finite.max()),
    }


#: How far, as a fraction of the fitted pitch, the lattice fit's own RMS residual may sit
#: before the fit stops being CORROBORATION and becomes a second number that agrees with
#: nothing. A quarter of a pitch is generous: on a contiguous square grid a correct fit's
#: residual is numerical noise (4.9e-13 px on the committed fixture, against a pitch of 80),
#: and every measured near-miss in this module's history is orders of magnitude out, not
#: fractionally. The bound is on the fit's own statement about itself rather than on the
#: input, because the input is exactly what a robust estimator would have to distrust.
LATTICE_FIT_MAX_RESIDUAL_FRACTION = 0.25


def lattice_fit_pitch(coords, array_row, array_col):
    """A CORROBORATING pitch from a least-squares fit against the array indices, or `None`.

    Gates nothing (DEC-13). It is reported beside the nearest-neighbour measurement so a
    reader can see two independent estimators agree, without the check ever depending on the
    index semantics that `01-sequencing-platforms.md` forbids relying on. No agreement figure
    is quoted here: the Visium module quotes one because it was measured on a real committed
    bundle, and this package's fixture is synthesized.

    Fits `[x; y] = A @ [col; row] + b` and returns the length of the `+1 array_col` step.

    THE STEP MULTIPLIER IS THE ONE ARITHMETIC DIFFERENCE FROM THE VISIUM VERSION, and it is
    not cosmetic. Visium's array is a HEX lattice whose within-row nearest neighbour is TWO
    array columns away, so that module returns `2 * step`. An HD bundle's bins are a
    CONTIGUOUS SQUARE GRID (`06-spatial-processing.md:120`), so consecutive `array_col` values
    are adjacent bins and the `+1` step IS the pitch. Carrying the `2 *` over would publish a
    corroborating pitch that is exactly twice the truth — an INVENTED corroboration, which is
    worse than none, and the more dangerous for gating nothing and therefore failing no test.
    """
    try:
        pts = np.asarray(coords, dtype=np.float64)
        ar = np.asarray(array_row, dtype=np.float64)
        ac = np.asarray(array_col, dtype=np.float64)
        if len(pts) < 4 or len(ar) != len(pts) or len(ac) != len(pts):
            return None
        if len(np.unique(ar)) < 2 or len(np.unique(ac)) < 2:
            return None
        design = np.column_stack([ac, ar, np.ones_like(ac)])
        cx, _res_x, rank_x, _sv_x = np.linalg.lstsq(design, pts[:, 0], rcond=None)
        cy, _res_y, rank_y, _sv_y = np.linalg.lstsq(design, pts[:, 1], rcond=None)
        # THE DESIGN MUST HAVE FULL RANK, and the residual cannot tell you that.
        #
        # `lstsq` returns the rank and this call was discarding it (`cx, *_ =`). On an
        # affinely DEPENDENT index set -- every bin on one diagonal, so `array_row == array_col`
        # -- the design is rank 2, `lstsq` silently returns the minimum-norm solution, and an
        # under-determined fit reproduces its own points EXACTLY. So the residual is numerical
        # noise, the `corroborates` test below passes, and the block is stamped
        # `"corroborates": true` on a `pitch_px` wrong by a factor of `hypot(1, k)` -- exactly
        # 2 on the diagonal case -- sitting beside a nearest-neighbour measurement that says
        # otherwise. MEASURED at the function level: 30 bins on a real 80 px lattice with
        # `array_row == array_col` gives `pitch_px 56.57`, `residual_rms_px 2.4e-12`,
        # `corroborates True`, against `measured_pitch_px 113.14` -- a ratio of exactly 2.
        #
        # It is NOT reachable through the shipped entrypoint (it needs a positions table whose
        # bins all lie on one index line, which no HD bundle produces), and it is closed anyway
        # because the residual criterion this round added would otherwise CERTIFY the very
        # thing the round exists to stop -- affirmatively, rather than by implication.
        if rank_x < design.shape[1] or rank_y < design.shape[1]:
            return None
        residual = np.hypot(design @ cx - pts[:, 0], design @ cy - pts[:, 1])
        step = float(np.hypot(cx[0], cy[0]))
        if not math.isfinite(step) or step <= 0:
            return None
        # AND THE FIT SAYS WHETHER IT CORROBORATES ANYTHING, which for two rounds it did not.
        #
        # A least-squares fit is not robust: it always returns numbers, and one point far off
        # the lattice drags the coefficients without failing anything. This block is stored
        # unconditionally beside `measured_pitch_px` for a reader to "see two independent
        # estimators agree" -- so a fit that agrees with nothing was being published AS an
        # agreement. MEASURED through the shipped entrypoint on the committed fixture, each
        # value in ONE row the vendor already marked `in_tissue=0` and each within the range
        # this importer accepts, so nothing is refused and no warning is raised:
        #
        #   clean                       pitch_px 80.000     residual_rms_px 4.9e-13
        #   `array_row` = int32 max     pitch_px 80.004     residual_rms_px 2.3e+02
        #   `array_col` = int32 min     pitch_px 2.9e-07    residual_rms_px 3.7e+02
        #   `pxl_col`  = float32 max    pitch_px 7.5e+35    residual_rms_px 2.6e+37
        #
        # and in every one of those `measured_pitch_px` stays 80.0 and the scale verdict stays
        # `pass`. Two estimators disagreeing by up to 34 orders of magnitude, published side by
        # side as corroboration. That is precisely the INVENTED CORROBORATION this function's
        # own docstring calls "worse than none, and the more dangerous for gating nothing and
        # therefore failing no test" -- it just arrived through the residual rather than
        # through the step multiplier.
        #
        # The residual is the fit's own statement about itself, so it is the criterion. It
        # gates nothing still; it is DISCLOSED, which is what turns a number a reader would
        # have trusted into one they can weigh.
        residual_rms = float(np.sqrt((residual ** 2).mean()))
        tolerance = LATTICE_FIT_MAX_RESIDUAL_FRACTION * step
        corroborates = math.isfinite(residual_rms) and residual_rms <= tolerance
        fit = {
            "pitch_px": step,
            "index_step_per_pitch": 1,
            "residual_rms_px": residual_rms,
            "residual_tolerance_px": tolerance,
            "corroborates": corroborates,
        }
        if not corroborates:
            fit["not_corroborating_because"] = (
                f"the least-squares fit leaves an RMS residual of {residual_rms:.3g} pixels "
                f"against a fitted pitch of {step:.3g} pixels, which is more than "
                f"{LATTICE_FIT_MAX_RESIDUAL_FRACTION:.0%} of it -- the bins this fit was "
                "given do not lie on the lattice it assumed, so its pitch corroborates "
                "nothing and must not be read as agreeing with the measured one."
            )
        return fit
    except (ValueError, np.linalg.LinAlgError, TypeError):
        # A diagnostic that cannot be computed is simply absent. It gates nothing, so a
        # degenerate index set must not cost the measurement that does.
        return None


def _finite_float(value):
    """`float(value)` or `None`. TOTAL, including over an `int` too large for a double.

    `isinstance(x, (int, float))` is NOT enough to make `f"{x:g}"` safe: `json.loads` yields
    unbounded Python ints, and formatting one raises `OverflowError`.

    It matters MORE in this module than in the Visium one, and for a new reason. Over there
    the referent is a module constant that no caller can touch; here it ARRIVES as
    `bin_pitch_um`, read out of a vendor JSON file, so the one number the whole scale check
    rests on is now attacker-shaped data on every code path that formats or divides by it.
    Every use of it goes through here first.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (OverflowError, TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


#: WHERE THE REFERENT COMES FROM, cited rather than asserted. Carried into every `scale` block
#: so a reader auditing a verdict can go and read the two claims it rests on instead of taking
#: this module's word for them.
_REFERENT_SOURCE = (
    "docs/research/data-processing/06-spatial-processing.md:120 — a Visium HD capture area "
    "is \"a continuous grid of 2x2 um squares (no gaps)\", so a bin's SIDE is also its "
    "centre-to-centre pitch; and docs/research/data-processing/01-file-formats.md:602 — the "
    "bin size is stated by the vendor as `bin_size_um` in `scalefactors_json.json`"
)

#: THE HONESTY NOTE ON R1's STRENGTH, carried in the block rather than left in a docstring.
#:
#: The Visium check's referent is manufactured glass; this one is a vendor DECLARATION. The
#: check is still external — the declaration lives in `scalefactors_json.json` while the pitch
#: is measured off `tissue_positions`, two files nothing in this importer reconciles — but a
#: bundle whose `bin_size_um` is wrong in the same proportion as its `microns_per_pixel`
#: passes here and would not pass on Visium. Stated in the report because a reader comparing
#: two green banners across the two importers would otherwise read parity into them.
_REFERENT_STRENGTH = (
    "vendor-declared, not manufactured. `bin_size_um` is a DECLARATION in "
    "`scalefactors_json.json`; the pitch it is checked against is MEASURED off "
    "`tissue_positions`, which never touches that file — so the two are independent and this "
    "is a genuine external check. It is nonetheless ONE NOTCH WEAKER than the Visium arm's, "
    "whose 100 um referent is a property of manufactured glass no vendor field can move: a "
    "`bin_size_um` wrong in the same proportion as `microns_per_pixel` would pass here."
)


def check_scale(coords, microns_per_pixel, *, bin_pitch_um, scale_source=None,
                array_row=None, array_col=None):
    """R1. `{verdict, measured_pitch_px, measured_pitch_um, expected_pitch_um, relative_error, ...}`.

    The whole external check on the micron scale, and therefore on the vendor number every
    micron measurement in this dataset descends from.

    `bin_pitch_um` is the referent — the selected binning's centre-to-centre pitch, which on
    a contiguous HD grid is the bin's own side. It arrives as an ARGUMENT where the Visium
    module has a module-level constant, and the caller is required to have read it from the
    bundle's own `scalefactors_json.json` rather than to have chosen it.
    """
    referent_um = _finite_float(bin_pitch_um)
    pitch = measure_spot_pitch(coords)
    block = {
        "referent": "visium-hd-bin-pitch",
        "referent_um": referent_um,
        "referent_source": _REFERENT_SOURCE,
        "referent_strength": _REFERENT_STRENGTH,
        "tolerance": PITCH_TOLERANCE,
        "measured_pitch_px": pitch["median_nn_px"],
        "pitch_estimator": "median-nearest-neighbour",
        "n_spots": pitch["n_spots"],
        "microns_per_pixel": microns_per_pixel,
        "microns_per_pixel_source": scale_source,
    }
    if array_row is not None and array_col is not None:
        corroboration = lattice_fit_pitch(coords, array_row, array_col)
        if corroboration is not None:
            block["lattice_fit"] = corroboration

    # THE REFERENT IS VALIDATED BEFORE ANYTHING ELSE, which the Visium module has no need to
    # do. Its referent is a literal in the source; ours came out of a JSON file, so a bundle
    # declaring `"bin_size_um": null`, `"8um"` or an integer too large for a double reaches
    # here. Each of those would raise inside the first f-string that formats it — the outer
    # DEC-7 guard would catch it and report "the scale check raised TypeError", which is true
    # and useless. Naming the actual defect is the whole difference.
    if referent_um is None or referent_um <= 0:
        block["verdict"] = VERDICT_NOT_EVALUATED
        block["reason"] = (
            f"no usable bin pitch reached this check (`bin_pitch_um` was {bin_pitch_um!r}), "
            "so there is no referent to test the micron scale against. The bin spacing may "
            "still have been measured and is reported above; what is missing is the number "
            "to compare it with. The scale is UNCHECKED, which is a different fact from "
            "checked-and-correct."
        )
        return block

    if pitch["median_nn_px"] is None:
        block["verdict"] = VERDICT_NOT_EVALUATED
        block["reason"] = (
            "fewer than two bins carry a position, so there is no spacing to measure. The "
            "scale is UNCHECKED, which is a different fact from checked-and-correct."
        )
        return block
    if microns_per_pixel is None:
        block["verdict"] = VERDICT_NOT_EVALUATED
        block["reason"] = (
            "this bundle declares no micron scale, so there is no number to test against "
            f"the {referent_um:g} um bin lattice pitch. The bin spacing WAS measured "
            f"({pitch['median_nn_px']:.3f} pixels) and is reported above, so a reader who "
            "obtains a scale can apply the referent by hand."
        )
        return block

    measured_um = pitch["median_nn_px"] * float(microns_per_pixel)
    error = abs(measured_um - referent_um) / referent_um
    block["measured_pitch_um"] = measured_um
    block["expected_pitch_um"] = referent_um
    block["relative_error"] = error
    # The scale the referent IMPLIES, so a reader who sees a failure is handed the number the
    # measurement points at rather than being left to divide. It is stated as an implication
    # of the referent, never written into any artifact.
    # GUARDED, because `measure_spot_pitch` masks only the diagonal: two bins at the SAME
    # position are "a real (and reportable) defect" and give a pitch of exactly 0. Dividing
    # unguarded here would raise BEFORE the FAIL branch below, the outer guard would swallow
    # it, and a degenerate positions table would report "could not be checked" instead of
    # "checked and wrong" — losing the measured pitch, the bin count and the verdict with it.
    if pitch["median_nn_px"] > 0:
        block["implied_microns_per_pixel"] = referent_um / pitch["median_nn_px"]
    if pitch["median_nn_px"] <= 0:
        block["verdict"] = VERDICT_FAIL
        block["reason"] = (
            "at least two bins in this table share a position, so the measured bin spacing "
            "is 0 pixels. That is not a spacing, and the micron scale cannot be checked "
            "against the bin lattice pitch until it is resolved — but the tissue map itself "
            "carries points that cannot both be right, which is why this is a FAIL and not "
            "an `unable to check`."
        )
        return block
    if error <= PITCH_TOLERANCE:
        block["verdict"] = VERDICT_PASS
        block["reason"] = (
            f"the bins are {pitch['median_nn_px']:.3f} pixels apart, which at the declared "
            f"{float(microns_per_pixel):.6g} um/pixel is {measured_um:.3f} um — within "
            f"{error * 100:.2f}% of the {referent_um:g} um bin lattice pitch this bundle "
            "declares."
        )
    else:
        block["verdict"] = VERDICT_FAIL
        block["reason"] = (
            f"the bins are {pitch['median_nn_px']:.3f} pixels apart, which at the declared "
            f"{float(microns_per_pixel):.6g} um/pixel is {measured_um:.3f} um — "
            f"{error * 100:.1f}% away from the {referent_um:g} um centre-to-centre pitch of "
            "the bin lattice this import selected. The bin POSITIONS are the vendor's own "
            "and are not in question; what this measures is the micron scale they are read "
            f"with. A scale of {referent_um / pitch['median_nn_px']:.6g} um/pixel would put "
            "them at exactly the declared pitch. Every micron measurement on this dataset — "
            "a neighbour-graph radius, a distance threshold — is off by this factor."
        )
    return block


# ── R2: the registration, against the tissue in the image ────────────────────────────


def invert_affine(to_space):
    """The inverse of a 2x3 row-major `[a, b, tx, c, d, ty]`, as a callable `(x, y) -> (u, v)`.

    `to_space` maps THIS IMAGE's pixels INTO the coordinate space; the overlay needs the other
    direction, to put a bin's full-resolution position onto the image.

    Written as a general 2x2 inverse rather than as `x / a`, even though every affine this
    package emits today is a pure diagonal scale. The reason is INV-3: a TRANSPOSED affine —
    `a = d = 0`, `b = c = s` — is precisely the defect this check exists to catch, and a
    reciprocal-of-`a` shortcut would divide by zero on it and report an exception instead of a
    failed registration. The check has to MAP the wrong affine and see where it puts the
    bins, not decline to evaluate it.
    """
    a, b, tx, c, d, ty = (float(v) for v in to_space)
    det = a * d - b * c
    if not math.isfinite(det) or det == 0.0:
        raise RegistrationQCError(
            f"the declared affine {list(to_space)!r} is singular (determinant {det!r}); it "
            "collapses the image onto a line or a point, so no bin has a well-defined "
            "position on it"
        )

    def apply(xs, ys):
        px = np.asarray(xs, dtype=np.float64) - tx
        py = np.asarray(ys, dtype=np.float64) - ty
        return (d * px - b * py) / det, (a * py - c * px) / det

    return apply


def tissue_mask(arr):
    """`(mask, info)` — a boolean tissue mask derived from the PIXELS, and how it was derived.

    Otsu's threshold on luminance, with the POLARITY decided by the image border rather than
    assumed. Brightfield H&E puts tissue darker than the slide; a fluorescence plane puts it
    brighter. Guessing wrong would invert the mask, and Youden's J is antisymmetric under a
    label flip — so a wrong guess would turn a good registration into a J of about -1 and a
    bad one into about +1, i.e. it would invert the whole check.

    Taking `abs(J)` would "fix" that and is refused: a statistic that cannot go negative
    cannot fail. The polarity is instead measured — the outer frame of a capture-area image is
    background, so whichever side of the threshold the border mostly sits on is background and
    the other side is tissue.
    """
    plane = np.asarray(arr)
    if plane.ndim == 3:
        chans = plane.shape[2]
        band = plane[..., :3].astype(np.float64)
        if chans >= 3:
            lum = 0.2126 * band[..., 0] + 0.7152 * band[..., 1] + 0.0722 * band[..., 2]
        else:
            lum = band.mean(axis=2)
    elif plane.ndim == 2:
        lum = plane.astype(np.float64)
    else:
        raise RegistrationQCError(
            f"expected a 2-D or 3-D image plane, got ndim={plane.ndim}"
        )
    lo, hi = float(np.nanmin(lum)), float(np.nanmax(lum))
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        raise RegistrationQCError(
            "this image is a single constant value, so it carries no tissue boundary to "
            "measure a registration against"
        )
    norm = (lum - lo) / (hi - lo)
    hist, _ = np.histogram(norm, bins=256, range=(0.0, 1.0))
    weight = hist.astype(np.float64) / max(1, hist.sum())
    omega = np.cumsum(weight)
    mu = np.cumsum(weight * np.arange(256))
    total = mu[-1]
    with np.errstate(invalid="ignore", divide="ignore"):
        between = (total * omega - mu) ** 2 / (omega * (1.0 - omega))
    index = int(np.nanargmax(between))
    # THE CLASS BOUNDARY, not the bin's midpoint. The maximisation above puts histogram bins
    # [0..index] in the dark class, so the boundary sits at (index + 1) / 256;
    # `(index + 0.5) / 256` would hand half of bin `index` to the bright class even though the
    # between-class variance placed it in the dark one, which makes the reported
    # `threshold_normalised` not the Otsu threshold its name claims. ("bin" here is a
    # HISTOGRAM bin and has nothing to do with a capture bin — the collision of vocabulary is
    # unfortunate and worth naming once, in the one place both meanings appear.)
    threshold = (index + 1) / 256.0
    dark = norm < threshold
    # THE BORDER BAND. On a capture-area image the outer frame is slide, not tissue.
    #
    # A one-pixel ring was the first implementation and it is too small a sample: a blind
    # audit on the Visium side demonstrated a plane that is 90% tissue reaching all four edges
    # reading `border_dark_fraction = 0.701` and inverting the mask outright. A band is a
    # bigger sample of the same evidence, and it is still only a heuristic — which is why an
    # inversion is DETECTED downstream rather than assumed away (see `J_INVERSION_FLOOR`).
    depth = max(1, min(dark.shape[0], dark.shape[1]) // 50)
    border = np.zeros(dark.shape, dtype=bool)
    border[:depth, :] = border[-depth:, :] = True
    border[:, :depth] = border[:, -depth:] = True
    border_dark_fraction = float(dark[border].mean())
    tissue_is_dark = border_dark_fraction < 0.5
    mask = dark if tissue_is_dark else ~dark
    return mask, {
        "method": "otsu-luminance",
        "threshold_normalised": threshold,
        "tissue_is_darker_than_background": bool(tissue_is_dark),
        "border_dark_fraction": border_dark_fraction,
        "border_band_px": int(depth),
        # HOW CONFIDENT the polarity call is. 0.5 is a coin flip; the further from it, the
        # more clearly the frame is one thing. Reported so a reader can see when the heuristic
        # was working near its boundary, which no verdict word can convey.
        "polarity_margin": abs(border_dark_fraction - 0.5) * 2.0,
        "mask_fraction": float(mask.mean()),
    }


def score_registration(mask, image_xy, in_tissue):
    """Youden's J for the pixel mask against the vendor's own `in_tissue` call.

    `sensitivity` = of the bins the VENDOR says are on tissue, the fraction whose mapped
    pixel is inside the mask. `specificity` = of the bins the vendor says are off tissue, the
    fraction outside it. `J = sensitivity + specificity - 1` is 0 at chance and 1 at perfect
    agreement, and is what a wrong affine destroys.

    The `spots`/`n_spots` vocabulary in the returned keys is kept verbatim from the Visium
    module and read verbatim by [`registration_verdict`]. On this platform an entry is a BIN,
    not a spot; the names are shared because the statistic is, and renaming them would fork
    the one piece of this module that genuinely is platform-independent.
    """
    height, width = mask.shape[:2]
    xs, ys = image_xy
    inside = (xs >= 0) & (xs < width) & (ys >= 0) & (ys < height)
    labels = np.asarray(in_tissue, dtype=bool)
    hit = np.zeros(len(xs), dtype=bool)
    if inside.any():
        # FLOOR, not round. #176 settled the affine convention as CORNER by proof — pixel
        # index i spans `[i*a, (i+1)*a)` — and the in-frame test just above uses that same
        # convention (`xs < width`). Rounding would be a pixel-CENTRE lookup, i.e. a
        # systematic half-pixel offset in the OPPOSITE direction from the convention the
        # affine declares, which biases sensitivity and specificity on boundary-dense real
        # tissue. That bias matters MORE here than on a slide: an HD bin is a small fraction
        # of a Visium spot's footprint, so a half-pixel offset is a larger fraction of the
        # entity being placed. Inherited, not relitigated.
        jx = np.clip(np.floor(xs[inside]).astype(np.int64), 0, width - 1)
        jy = np.clip(np.floor(ys[inside]).astype(np.int64), 0, height - 1)
        hit[inside] = mask[jy, jx]
    # A bin that fell OFF the image is not on tissue. Scoring it as a miss rather than
    # dropping it is what keeps a wildly wrong affine from scoring well on the handful of
    # bins that happened to stay in frame.
    sensitivity = float(hit[labels].mean()) if labels.any() else None
    specificity = float((~hit[~labels]).mean()) if (~labels).any() else None
    result = {
        "n_spots": int(len(xs)),
        "spots_inside_image": int(inside.sum()),
        "spots_inside_fraction": float(inside.mean()) if len(xs) else 0.0,
        "n_in_tissue": int(labels.sum()),
        "n_out_of_tissue": int((~labels).sum()),
        "sensitivity": sensitivity,
        "specificity": specificity,
    }
    result["youden_j"] = (
        sensitivity + specificity - 1.0
        if sensitivity is not None and specificity is not None else None
    )
    return result


# ── the overlay a human reads ────────────────────────────────────────────────────────


def render_overlay(arr, image_xy, in_tissue, *, entity_size_image_px):
    """The overlay PNG bytes: the image, with every bin drawn at its DECLARED physical size.

    A SQUARE, NOT A CIRCLE, and this is the visible difference from the Visium overlay. A
    Visium spot is a printed disc of oligos on glass, so a circle describes its footprint. An
    HD bin is a contiguous square of the capture grid (`06-spatial-processing.md:120`), and
    the counts in a row of the matrix are the counts collected under that square. Drawing a
    disc would MISDESCRIBE the footprint the counts came from — it would show gaps at the
    corners where the grid has none, and it would imply an inter-entity spacing the platform
    does not have. Since a contiguous grid's side and pitch are the same number, a correctly
    scaled overlay tiles the capture area exactly, and a reader can see a misscale as a
    lattice that has come apart or begun to overlap.

    Drawn as an OUTLINE, not a fill, so the tissue under each bin stays visible — the whole
    question the reader is answering is what the bin is sitting on.

    The side comes from the DECLARED micron scale through the DECLARED affine, never from a
    constant. That is what makes a misscale visible to a human and not only to `check_scale`.
    """
    from PIL import Image, ImageDraw

    plane = np.asarray(arr)
    if plane.ndim == 2:
        rgb = np.repeat(_to_uint8(plane)[:, :, None], 3, axis=2)
    elif plane.shape[2] >= 3:
        # ONE min/max across the three bands, not three independent ones. Normalising each
        # channel separately gives a 16-bit or float RGB plane three different linear maps,
        # so the overlay's colours are not the image's colours — a hue and white-balance shift
        # in exactly the case `_to_uint8` exists for. A uint8 plane short-circuits untouched.
        rgb = _to_uint8_rgb(plane[..., :3])
    else:
        # 1 or 2 samples (a grayscale, or grayscale + alpha, TIFF — both of which
        # `ome_writer.read_image` accepts as 'YXS'). Indexing channel 2 unconditionally
        # raised IndexError here on the Visium side, so a plane `tissue_mask` could score was
        # one the renderer could not draw — and, before the verdict was made durable, that
        # exception also destroyed the metric's own answer. Mirrors `tissue_mask`'s chans < 3
        # branch.
        rgb = np.repeat(_to_uint8(plane[..., 0])[:, :, None], 3, axis=2)
    image = Image.fromarray(rgb, mode="RGB")
    scale = min(1.0, OVERLAY_MAX_EDGE / max(image.size))
    if scale < 1.0:
        image = image.resize(
            (max(1, int(round(image.size[0] * scale))),
             max(1, int(round(image.size[1] * scale)))),
            Image.BILINEAR,
        )
    draw = ImageDraw.Draw(image)
    xs = np.asarray(image_xy[0], dtype=np.float64)
    ys = np.asarray(image_xy[1], dtype=np.float64)
    labels = np.asarray(in_tissue, dtype=bool)
    # THE STRIDE. See `OVERLAY_MAX_MARKS`: the loop below is one PIL call per entity and an HD
    # bundle can present millions. A regular sub-lattice over the whole capture area answers
    # "do the bins land on the tissue" as well as the full lattice does, and it is REPORTED
    # rather than silent, because an overlay that quietly shows a fraction of the data is a
    # picture a reader would misread as complete.
    n_total = int(len(labels))
    stride = 1
    if n_total > OVERLAY_MAX_MARKS:
        stride = int(math.ceil(n_total / OVERLAY_MAX_MARKS))
        xs, ys, labels = xs[::stride], ys[::stride], labels[::stride]
    # Half the DECLARED side, in the overlay's own pixels. Floored at 1 so a bin on a heavily
    # downscaled overview is still visible as a mark rather than vanishing — an invisible bin
    # would make an unregistered overlay look like an empty one. That floor BINDS far more
    # often here than on Visium: a 2 um bin on a downscaled hires plane is sub-pixel, so the
    # drawn square is a floor artifact and not a measurement. `entity_half_side_overlay_px`
    # and `half_side_at_floor` are reported so the report says which of the two it was.
    exact_half_side = 0.5 * float(entity_size_image_px) * scale
    half_side = max(1.0, exact_half_side)
    width, height = image.size
    drawn, placed = 0, []
    for x, y, on_tissue in zip(xs, ys, labels):
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        cx, cy = x * scale, y * scale
        # A mark whose centre is off the canvas is not drawn and is not counted. PIL would
        # happily clip it, which is what made an all-off-frame overlay indistinguishable from
        # a correctly drawn one: both produce a valid PNG of the right size.
        if not (0 <= cx < width and 0 <= cy < height):
            continue
        draw.rectangle(
            [cx - half_side, cy - half_side, cx + half_side, cy + half_side],
            outline=_COLOUR_IN_TISSUE if on_tissue else _COLOUR_OUT_TISSUE,
            width=1,
        )
        drawn += 1
        if len(placed) < 8:
            placed.append([round(float(cx), 3), round(float(cy), 3)])
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), {
        "width": image.size[0], "height": image.size[1],
        "render_scale": scale,
        "mark_shape": "square",
        "entity_half_side_overlay_px": half_side,
        # WHETHER THE SIDE ABOVE IS A MEASUREMENT OR A FLOOR. Without this a 2 um bin's
        # 1-pixel square and a correctly scaled 1-pixel square are the same record, and a
        # reader would take the floor for the declared size.
        "half_side_at_floor": bool(exact_half_side < 1.0),
        "entity_half_side_exact_px": exact_half_side,
        # HOW MUCH OF THE LATTICE IS ON THE CANVAS, stated as a stride rather than implied.
        "mark_stride": int(stride),
        "n_entities": n_total,
        "n_entities_considered": int(len(labels)),
        # HOW MANY MARKS ARE ACTUALLY ON THE CANVAS, and where the first ones went.
        #
        # When every bin maps outside the image's frame the overlay contains ZERO drawn
        # marks, so the emitted picture is the bare tissue thumbnail. An overlay with no
        # marks and an ABSENT overlay are then the same picture, which is INV-2's own
        # failure mode arriving at the product rather than at the test. Counted here so the
        # report can say it, and so a test can assert the correct case draws something
        # rather than only that a PNG exists.
        "marks_drawn": int(drawn),
        "marks_outside_frame": int(len(labels) - drawn),
        # The first few DRAWN centres, in the overlay's own pixels. This is the only record
        # of WHERE the renderer put anything: without it a renderer that ignored the mapping
        # entirely and laid the squares on an arbitrary lattice would be indistinguishable
        # from a correct one at every observable — which a blind audit on the Visium side
        # demonstrated by doing exactly that and watching the whole suite stay green.
        "first_marks": placed[:8],
    }


def _to_uint8_rgb(band):
    """Three channels to `uint8` under ONE shared linear map, so hues survive."""
    values = np.asarray(band)
    if values.dtype == np.uint8:
        return values
    data = values.astype(np.float64)
    lo, hi = float(np.nanmin(data)), float(np.nanmax(data))
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        return np.zeros(data.shape, dtype=np.uint8)
    return np.clip((data - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)


def _to_uint8(band):
    """One channel, normalised to `uint8` for display. Never assumes the source dtype.

    `ome_writer.read_image`'s contract is explicit that the dtype is NOT constrained — a
    float, signed or bilevel TIFF comes back with its own dtype — so a bare `.astype(uint8)`
    here would wrap a 16-bit plane into noise and make a correctly registered overlay
    unreadable.
    """
    values = np.asarray(band)
    if values.dtype == np.uint8:
        return values
    data = values.astype(np.float64)
    lo, hi = float(np.nanmin(data)), float(np.nanmax(data))
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        return np.zeros(data.shape, dtype=np.uint8)
    return np.clip((data - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)


def data_uri(png_bytes):
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")


# ── reading the artifact back, as stored ─────────────────────────────────────────────


def read_emitted_plane(path, declared_extent):
    """`(array, level_scale, info)` for an emitted `spatial/image`, read back from DISK.

    The check runs over the artifact AS STORED, not over the in-memory array the importer
    happened to have — so it exercises the bytes a consumer would actually get, which is what
    makes it a check on the shipped path rather than on a variable.

    `level_scale` maps DECLARED-extent pixels to the returned array's pixels, and is derived
    from the array's OWN shape against the declared extent rather than from the level index.
    A level chosen for cost cannot then silently misplace a bin: if the two disagree the
    scale absorbs it by construction.
    """
    import tifffile

    placement = None
    with tifffile.TiffFile(str(path)) as handle:
        if not handle.series:
            raise RegistrationQCError("the emitted image carries no series")
        # THE DECLARATION AS PERSISTED. Read from the OME-XML this artifact carries, which is
        # what a sandboxed consumer gets (#211: `meta` reaches no sandboxed consumer;
        # an OME-TIFF escapes that because it carries its own metadata).
        #
        # This closes an asymmetry a blind design-conformance audit named on the Visium side:
        # the PIXELS were read back from disk "over the artifact AS STORED", while the AFFINE
        # was taken from the in-memory entry dict — so a writer that serialised a different
        # affine than the entry held was outside this check's reach, and §7.3's whole rule is
        # "declare the space", i.e. the thing on disk.
        try:
            placement = SD.require_placement(
                handle.ome_metadata, consumer="the registration QC"
            )
        except Exception:
            # A declaration that cannot be read back is reported by the CALLER against the
            # entry's own copy, so a damaged OME-XML costs the cross-check and not the check.
            placement = None
        levels = list(handle.series[0].levels) or [handle.series[0]]
        chosen, chosen_index = levels[0], 0
        for index, level in enumerate(levels):
            shape = tuple(level.shape)
            height, width = shape[0], shape[1]
            if min(height, width) < _MIN_ANALYSIS_EDGE and index:
                break
            chosen, chosen_index = level, index
            if height * width <= ANALYSIS_PIXEL_BUDGET:
                break
        arr = chosen.asarray()
    declared_w = float(declared_extent["width"])
    declared_h = float(declared_extent["height"])
    if declared_w <= 0 or declared_h <= 0:
        raise RegistrationQCError(
            f"the declared extent {declared_extent!r} has no width or no height"
        )
    # ONE SCALE PER AXIS. A pyramid level's height and width are rounded INDEPENDENTLY, so
    # `shape[1]/width` is not `shape[0]/height` in general — applying the x ratio to y would
    # silently misplace every bin along y in proportion to the mismatch, which is exactly
    # what the "a level choice cannot silently misplace a bin" claim above is supposed to
    # rule out. Sub-pixel for a halved level of a large plane, and wrong for free otherwise.
    level_scale_x = float(arr.shape[1]) / declared_w
    level_scale_y = float(arr.shape[0]) / declared_h
    return arr, (level_scale_x, level_scale_y), {
        "persisted_to_space": list(placement["to_space"]) if placement else None,
        "pyramid_level": chosen_index,
        "level_extent": {"width": int(arr.shape[1]), "height": int(arr.shape[0])},
        "level_scale": level_scale_x,
        "level_scale_y": level_scale_y,
    }


# ── the whole check ──────────────────────────────────────────────────────────────────


def registration_verdict(block):
    """`{verdict, reason}` from a SCORED registration block — the judgement, separated.

    Split out of [`check_registration`] so both thresholds can be exercised ON THEIR
    BOUNDARY without needing a file on disk.

    That split is not tidiness. A blind audit of the first version of the Visium module set
    `J_FLOOR` to 0.03 and then to 0.99 and the whole suite stayed green both times, because
    the only J values any test ever observed were the saturating positive control and the
    mutants at the other end. A threshold whose observed inputs are only the two extremes is
    pinned by nothing and can be moved anywhere in between. Judgement had to become callable
    on a synthetic block before it could be pinned, and it is callable here for the same
    reason.

    The ORDER matters and is not arbitrary: coverage is decided BEFORE agreement, because a
    badly wrong affine's first symptom is that the bins leave the frame entirely, and a
    Youden's J computed over the few that stayed in is not a measurement. Reporting that as
    itself is more use to a reader than laundering it into a low score.
    """
    to_space = block.get("to_space", [])
    if block["spots_inside_fraction"] < MIN_SPOTS_INSIDE_FRACTION:
        return {"verdict": VERDICT_FAIL, "reason": (
            f"only {block['spots_inside_image']} of {block['n_spots']} bins land inside "
            f"this image when placed through its declared affine "
            f"{[round(float(v), 8) for v in to_space]!r}. The image and the positions are "
            "not describing the same capture area, so there is nothing to score a "
            "registration over. This is what a badly wrong affine looks like from the "
            "outside."
        )}
    if block["youden_j"] is None:
        # THE ONE-CLASS GUARD. Kept exactly as the Visium module has it, and it fires MORE
        # readily here: the matrix-joined sample of an HD bundle is in-tissue-only, so a run
        # whose positions table could not be parsed falls back to a scope with a single class
        # by construction. `scope` in the header says which sample was used, so this verdict
        # is attributable rather than mysterious.
        return {"verdict": VERDICT_NOT_EVALUATED, "reason": (
            "every bin carries the same `in_tissue` value, so there is no contrast to "
            "score the tissue mask against. A one-class label makes sensitivity or "
            "specificity undefined, and inventing the missing one would be a fabricated "
            "measurement — which is why this is NOT a pass."
        )}
    if block["youden_j"] <= -J_INVERSION_FLOOR:
        return {"verdict": VERDICT_NOT_EVALUATED, "reason": (
            f"the tissue mask is systematically ANTI-correlated with the vendor's `in_tissue` "
            f"call (Youden's J = {block['youden_j']:.3f}). A wrong affine scatters the bins "
            "and drives J toward 0; only an INVERTED MASK drives it toward -1. So this is a "
            "polarity failure, not a misregistration: the tissue in this image was read as "
            "background and the background as tissue, which happens when the frame's own "
            "border is not slide — a section that reaches the edge of a cropped or CytAssist "
            "image. The registration is UNCHECKED here, not wrong; reporting it as a "
            "misregistration would be a confidently-worded claim about the wrong thing."
        )}
    if block["youden_j"] >= J_FLOOR:
        return {"verdict": VERDICT_PASS, "reason": (
            f"placed through the declared affine, the bins agree with the tissue visible "
            f"in this image at Youden's J = {block['youden_j']:.3f} "
            f"(sensitivity {block['sensitivity']:.3f}, specificity "
            f"{block['specificity']:.3f}), at or above the {J_FLOOR:g} floor."
        )}
    return {"verdict": VERDICT_FAIL, "reason": (
        f"placed through the declared affine, the bins agree with the tissue visible in "
        f"this image at only Youden's J = {block['youden_j']:.3f} "
        f"(sensitivity {block['sensitivity']:.3f}, specificity "
        f"{block['specificity']:.3f}), below the {J_FLOOR:g} floor — where 0 is chance. The "
        "vendor's own `in_tissue` call and this image's own pixels disagree about where the "
        "tissue is, which is what a misregistration looks like. Read the overlay before "
        "reading anything off this image."
    )}


def check_registration(entry, outputs_dir, coords, in_tissue, *, microns_per_pixel,
                       entity_size_um):
    """R2 for ONE emitted `spatial/image`. Returns `(block, overlay_uri_or_None)`.

    `entity_size_um` is the side of one bin. It is passed separately from the scale check's
    `bin_pitch_um` even though a contiguous grid makes them the same number, because they
    answer different questions — "how far apart are the entities" and "how big is one" — and a
    platform where those differ (Visium: a 55 um spot on a 100 um pitch) must not be able to
    reuse this call site by accident.
    """
    meta = entry["meta"]
    to_space = meta["to_space"]
    block = {
        "image_id": entry["id"],
        "source": meta.get("source"),
        "role": meta.get("role"),
        # THE DECLARATION, echoed into the report (INV-1). The check reads it from the
        # artifact's own meta; recording it here is what lets a reader confirm which affine
        # was actually exercised rather than taking the claim on trust.
        "to_space": list(to_space),
        "extent": dict(meta["extent"]),
        "j_floor": J_FLOOR,
        "min_spots_inside_fraction": MIN_SPOTS_INSIDE_FRACTION,
        # SYNTHETIC, and said out loud. This package's fixture is generated by
        # `tests/make_fixture.py`, which paints tissue where it has placed the bins — so the
        # control proves the check DISCRIMINATES, and proves nothing about whether `J_FLOOR`
        # is right for real H&E.
        "positive_control": "synthetic",
    }
    arr, (level_scale_x, level_scale_y), level_info = read_emitted_plane(
        Path(outputs_dir) / entry["path"], meta["extent"]
    )
    block.update(level_info)
    # THE TWO COPIES OF THE DECLARATION, CROSS-CHECKED.
    #
    # A blind design-conformance audit named an asymmetry here: the PIXELS are read back from
    # disk "over the artifact AS STORED", while the AFFINE came from the in-memory entry dict —
    # so a writer that serialised a different affine than the entry held was outside this
    # check's reach, and §7.3's rule is about the declaration ON DISK.
    #
    # The reason they cannot differ today is structural, not lucky: `emit_images` builds ONE
    # `meta` and `write_ome_tiff` derives both the manifest copy and the OME-XML copy from it
    # (#155's DEC-6, "never computed twice"). So this does not OVERRIDE the entry's copy — that
    # would make the artifact under test unmutatable and quietly disarm every test that moves
    # a declared affine. It asserts they AGREE, and treats a divergence as a registration
    # defect in its own right, because if they ever do differ then the artifact a consumer
    # reads is not the artifact the producer believes it wrote, and no score computed from
    # either copy describes what shipped.
    persisted = block.get("persisted_to_space")
    declaration_mismatch = (
        persisted is not None
        and [float(v) for v in persisted] != [float(v) for v in to_space]
    )

    inverse = invert_affine(to_space)
    pts = np.asarray(coords, dtype=np.float64)
    ux, uy = inverse(pts[:, 0], pts[:, 1])
    # Into the READ-BACK level's own grid. They are the seam that keeps a coarser-level read
    # honest, and they are applied per-axis because a pyramid level rounds its two dimensions
    # independently.
    image_xy = (ux * level_scale_x, uy * level_scale_y)

    mask, mask_info = tissue_mask(arr)
    block["tissue_mask"] = mask_info
    block.update(score_registration(mask, image_xy, in_tissue))

    # The bin's DECLARED side, carried through the DECLARED affine into this image's grid.
    # `to_space[0]` is micrometres-per-space-unit's reciprocal in this image's pixels, so
    # dividing by it is the same composition the overlay is testing.
    #
    # `_finite_float` on the way in for the same reason `check_scale` uses it on the referent:
    # this number came out of a vendor JSON file, and a `None` or a string here would raise
    # inside the arithmetic, be caught by the caller's per-image handler, and REPLACE a
    # correctly computed verdict with `not-evaluated` — the laundering DEC-7 exists to
    # prevent, in the direction that hides a real failure.
    size_um = _finite_float(entity_size_um)
    entity_size_image_px = None
    if microns_per_pixel and size_um is not None and size_um > 0:
        side_fullres_px = size_um / float(microns_per_pixel)
        scale_x = abs(float(to_space[0])) or abs(float(to_space[1]))
        if scale_x:
            entity_size_image_px = side_fullres_px / scale_x * level_scale_x
    block["entity_size_um"] = size_um
    block["entity_size_image_px"] = entity_size_image_px

    if declaration_mismatch:
        block["declaration_mismatch"] = (
            f"this artifact's own OME-XML declares the affine {persisted!r} while its "
            f"manifest entry declares {list(to_space)!r}. A consumer reads the OME-XML. The "
            "two are supposed to be one fact written twice from a single object, so a "
            "divergence means the artifact that shipped is not the one the producer thinks "
            "it wrote — and no registration score computed from either copy describes it."
        )
        block["verdict"] = VERDICT_FAIL
        block["reason"] = block["declaration_mismatch"]
    else:
        block.update(registration_verdict(block))

    overlay_uri = None
    if entity_size_image_px is not None:
        # THE RENDER IS GUARDED SEPARATELY, and this is the point of the whole arrangement.
        #
        # The verdict is already in `block` by the time we get here. Letting a PNG failure
        # propagate to the caller's per-image handler would REPLACE the whole block with a
        # fresh `not-evaluated` — silently downgrading a correctly computed FAIL because the
        # drawing code choked, and then aggregating it as pass-or-not-evaluated so the FAIL
        # never reaches the top-level verdict. That is DEC-7's laundering in the direction
        # that HIDES a real failure, which is the worse direction. Losing the picture must
        # cost the picture and nothing else.
        try:
            png, overlay_info = render_overlay(
                arr, image_xy, in_tissue, entity_size_image_px=entity_size_image_px
            )
            if len(png) > OVERLAY_MAX_BYTES:
                block["overlay_omitted"] = (
                    f"the rendered overlay came to {len(png)} bytes, over the "
                    f"{OVERLAY_MAX_BYTES}-byte inline cap. It is omitted rather than "
                    "embedded, because a report a browser cannot open is not a report. The "
                    "verdict and every number behind it are unaffected."
                )
            elif not overlay_info["marks_drawn"]:
                # A PICTURE WITH NOTHING ON IT. Every bin mapped outside the frame, so what
                # was rendered is the bare image — indistinguishable from an overlay that was
                # never drawn, which is INV-2's failure mode at the product rather than at the
                # test. The verdict above already says the registration failed; this stops the
                # picture from quietly implying otherwise.
                block["overlay"] = overlay_info
                block["overlay_omitted"] = (
                    f"all {overlay_info['marks_outside_frame']} bins considered for this "
                    "overlay map outside the image's frame, so it would carry no marks at "
                    "all — a bare thumbnail that looks exactly like a registration nobody "
                    "checked. It is not embedded. The verdict above says what happened."
                )
            else:
                block["overlay"] = overlay_info
                overlay_uri = data_uri(png)
        except Exception as exc:
            block["overlay_omitted"] = (
                f"the overlay could not be rendered — {type(exc).__name__}: {exc}. The "
                "verdict above was computed before the render and still stands."
            )
    elif not microns_per_pixel:
        block["overlay_omitted"] = (
            "this bundle declares no micron scale, so a bin has no declared physical size "
            "to draw at. An overlay with an invented side would look exactly like a "
            "measured one."
        )
    else:
        block["overlay_omitted"] = (
            f"no usable bin size reached the renderer (`entity_size_um` was "
            f"{entity_size_um!r}), so there is no declared square to draw. An overlay with "
            "an invented side would look exactly like a measured one. The verdict above was "
            "computed without it and still stands."
        )
    return block, overlay_uri


def _qc_header(coords, in_tissue, scope, referent_um):
    """The QC block's descriptive header — WHAT was checked, before any verdict.

    Its own function so it can sit inside `registration_qc`'s guard. On the Visium side it was
    inline and OUTSIDE that guard once, which made the "never raises (DEC-7)" promise a claim
    the code did not enforce: a 0-d `coords` (TypeError from `len`) or an `in_tissue` that
    will not cast to bool escaped into `run_import` and aborted the whole import.
    """
    referent = _finite_float(referent_um)
    pitch_phrase = (
        f"the {referent:g} um bin lattice pitch this bundle declares"
        if referent is not None and referent > 0
        else "the bin lattice pitch this bundle declares (not supplied to this run)"
    )
    return {
        # WHICH bins were checked. `all-bins-in-positions-table` is the only scope in which
        # the registration check has two classes to score against: the filtered matrix holds
        # only in-tissue bins, so a matrix-joined sample makes Youden's J undefined by
        # construction. Recorded so a `not-evaluated` here is attributable rather than
        # mysterious.
        "scope": scope,
        "n_spots_checked": int(len(np.asarray(coords))),
        "n_in_tissue": int(np.asarray(in_tissue, dtype=bool).sum()),
        "referent_note": (
            "This is the only check in this importer with a referent OUTSIDE the artifact's "
            "coordinates. Every other guard reconciles the artifact with itself, which a "
            f"uniform misscale satisfies. The two referents here are {pitch_phrase} — "
            "measured against a positions table that never touches the file that declares "
            "it — and the tissue visible in the vendor's own image scored against the "
            "vendor's own `in_tissue` call."
        ),
    }


def registration_qc(*, coords, in_tissue, microns_per_pixel, scale_source,
                    image_entries, outputs_dir, bin_pitch_um, entity_size_um,
                    array_row=None, array_col=None, scope=None):
    """The whole QC. Returns `(report_block, {image_id: overlay_data_uri})`.

    `bin_pitch_um` is R1's referent — the selected binning's centre-to-centre pitch, read by
    the caller from the bundle's own `scalefactors_json.json`. `entity_size_um` is the side of
    one bin, which the overlay draws. On a contiguous HD grid they are the same number; they
    are separate parameters because they are separate questions.

    Never raises (DEC-7). Any failure becomes a `not-evaluated` verdict naming the exception
    type, because losing a diagnostic must never cost the user the matrix, the coordinates,
    the columns and the report.
    """
    overlays = {}
    block = {"kind": "visium-hd-registration-qc"}
    try:
        block.update(_qc_header(coords, in_tissue, scope, bin_pitch_um))
    except Exception as exc:
        # The header is built INSIDE this guard. On the Visium side it was outside it once,
        # which made "never raises (DEC-7)" a claim the code did not enforce: a 0-d `coords`
        # (TypeError from `len`) or an `in_tissue` that will not cast to bool escaped into
        # `run_import` and aborted the whole import — costing the user the matrix, the
        # coordinates, the columns and the report, which is precisely the outcome DEC-7
        # exists to prevent.
        block["header_error"] = f"{type(exc).__name__}: {exc}"
    try:
        block["scale"] = check_scale(
            coords, microns_per_pixel, bin_pitch_um=bin_pitch_um,
            scale_source=scale_source, array_row=array_row, array_col=array_col,
        )
    except Exception as exc:
        block["scale"] = {
            "verdict": VERDICT_NOT_EVALUATED,
            "reason": f"the scale check raised {type(exc).__name__}: {exc}",
            # THE REFERENT AND ITS PROVENANCE ARE CARRIED HERE TOO. `check_scale` puts them in
            # every block it RETURNS; this path is the one `not-evaluated` that is not one of
            # its returns, and rebuilding the block from scratch without them would drop the
            # very fields a reader needs most — the check could not run, so the referent it
            # WOULD have tested against is the only thing left to reason from. `!r` and not a
            # format spec, because an unformattable referent is exactly how this branch is
            # most likely to be reached.
            "referent": "visium-hd-bin-pitch",
            "referent_um": _finite_float(bin_pitch_um),
            "referent_declared_as": repr(bin_pitch_um),
            "referent_source": _REFERENT_SOURCE,
            "referent_strength": _REFERENT_STRENGTH,
        }

    images = []
    for entry in image_entries:
        try:
            image_block, overlay_uri = check_registration(
                entry, outputs_dir, coords, in_tissue,
                microns_per_pixel=microns_per_pixel, entity_size_um=entity_size_um,
            )
            if overlay_uri is not None:
                overlays[entry["id"]] = overlay_uri
        except Exception as exc:
            # ONE guard around the WHOLE per-image body, for the same reason `emit_images`
            # has one: the raises are spread across a read-back, a matrix inverse, a
            # threshold and a render, and a per-call `except` will always miss the next one.
            image_block = {
                "image_id": entry.get("id") if isinstance(entry, dict) else None,
                "source": (entry.get("meta") or {}).get("source")
                if isinstance(entry, dict) else None,
                "verdict": VERDICT_NOT_EVALUATED,
                "reason": (
                    f"the registration check could not be run over this image — "
                    f"{type(exc).__name__}: {exc}. The image itself was emitted; what is "
                    "missing is the check on it."
                ),
            }
        images.append(image_block)
    block["images"] = images

    if not image_entries:
        block["registration_verdict"] = VERDICT_NOT_EVALUATED
        block["registration_reason"] = (
            "no `spatial/image` was emitted from this bundle, so there is nothing to place "
            "the bins on. `images_not_emitted` in this report says why. An unchecked "
            "registration is not a correct one."
        )
    else:
        verdicts = [image.get("verdict", VERDICT_NOT_EVALUATED) for image in images]
        # FAIL if any failed; PASS only if EVERY image passed; otherwise not-evaluated.
        #
        # The middle clause used to be "PASS if ANY passed", so two images where one passed
        # and one could not be checked rolled up to `pass` — "could not be checked" absorbed
        # into "checked and fine" at the aggregate, which is the exact distinction the third
        # value exists to keep. Every per-image row is rendered separately, so a reader of the
        # table would have seen it; the one-word aggregate is what hid it, and the one-word
        # aggregate is what a machine reads.
        block["registration_verdict"] = (
            VERDICT_FAIL if VERDICT_FAIL in verdicts
            else (VERDICT_PASS if verdicts and all(v == VERDICT_PASS for v in verdicts)
                  else VERDICT_NOT_EVALUATED)
        )

    scale_verdict = block["scale"].get("verdict", VERDICT_NOT_EVALUATED)
    both = (scale_verdict, block["registration_verdict"])
    block["verdict"] = (
        VERDICT_FAIL if VERDICT_FAIL in both
        else (VERDICT_PASS if both == (VERDICT_PASS, VERDICT_PASS) else VERDICT_NOT_EVALUATED)
    )
    return block, overlays


# ── the banner a human reads ─────────────────────────────────────────────────────────


def render_registration_qc(qc, overlays):
    """The #156 block: a verdict banner, the measured numbers, and the rendered overlays.

    LIVES IN THIS MODULE, not in `import_visium_hd`. The Visium arm keeps its twin in the
    importer, and the cost of that split is visible over there: the banner's wording ("the
    slide's ... um spot pitch") is a claim about the referent, composed in a file that does
    not own the referent. Here the check and the sentence describing it are one unit, so a
    change to what R1 measures cannot leave a stale description of it behind in another file.

    Placed FIRST in the report body, before the facts table, because this is the surface the
    user is already looking at when the import finishes and `spatial.import-visium-hd` is
    deliberately launchable rather than `trigger: on-ingest` (DEC-1) precisely so *"the user
    must be able to see and confirm the registration"* (design §7.2). An overlay below a
    table of provenance strings is an overlay nobody scrolls to.

    Every score is printed as a NUMBER beside its verdict. A bare red/green would make the
    reader trust a threshold this package can only calibrate against a synthetic control.
    """
    def esc(v):
        return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    verdict = qc.get("verdict", "not-evaluated")
    colour, wash, headline = _VERDICT_STYLE.get(verdict, _VERDICT_STYLE["not-evaluated"])
    scale = qc.get("scale", {})
    rows = [
        f"<tr><th align='left'>Scale vs the "
        f"{esc(scale.get('referent_um', '?'))} um bin lattice pitch</th>"
        f"<td><b>{esc(scale.get('verdict', 'not-evaluated'))}</b> — {esc(scale.get('reason', ''))}"
        "</td></tr>"
    ]
    # THE REFERENT'S OWN ROW, which replaces the Visium banner's slide-design row and is there
    # for the opposite reason. Over there the extra row names the NUMERATOR the check divided
    # by; here it names WHERE THE REFERENT CAME FROM and how strong it therefore is. A reader
    # who has seen the Visium banner would otherwise carry "the referent is manufactured
    # glass" across to this one, and it is not — it is a vendor declaration in a different
    # file from the thing it is checked against. That is a real external check and a weaker
    # one, and the banner is the only place a human learns the difference.
    if str(scale.get("referent_strength", "")).strip():
        rows.append(
            "<tr><th align='left'>Referent</th><td>"
            f"{esc(str(scale['referent_strength']).strip())}</td></tr>"
        )
    for image in qc.get("images", []):
        rows.append(
            f"<tr><th align='left'>Registration — {esc(image.get('source') or image.get('image_id'))}"
            f"</th><td><b>{esc(image.get('verdict', 'not-evaluated'))}</b> — "
            f"{esc(image.get('reason', ''))}</td></tr>"
        )
    if not qc.get("images"):
        rows.append(
            "<tr><th align='left'>Registration</th><td><b>"
            f"{esc(qc.get('registration_verdict', 'not-evaluated'))}</b> — "
            f"{esc(qc.get('registration_reason', ''))}</td></tr>"
        )
    figures = "".join(
        f"<figure style='margin:12px 0'><figcaption>{esc(image_id)} — bin centres placed "
        "through the DECLARED affine, each drawn as a square of the declared bin side"
        f"</figcaption><img alt='registration overlay for {esc(image_id)}' src='{uri}' "
        "style='max-width:900px;border:1px solid #ccc'></figure>"
        for image_id, uri in sorted(overlays.items())
    )
    return (
        f"<section style='border-left:6px solid {colour};background:{wash};padding:12px 16px;"
        "margin:0 0 20px'>"
        f"<h3 style='margin:0 0 8px;color:{colour}'>{esc(headline)}</h3>"
        "<p style='margin:0 0 10px;max-width:70ch'>This is the only check in this import "
        "with a referent <b>outside</b> the artifact's coordinates. Everything else verifies "
        "that the coordinates, the image and the declared scale agree with each other — "
        "which a uniformly wrong scale also does.</p>"
        "<table style='font:13px/1.5 system-ui,sans-serif;border-collapse:collapse'>"
        + "".join(rows) + "</table>"
        + (figures or "<p><em>no overlay was rendered; see the verdicts above for why.</em></p>")
        + "</section>"
    )
