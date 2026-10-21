#!/usr/bin/env python3
# ruff: noqa
"""The registration QC — the only check in this arm with a referent OUTSIDE the artifact.

## Why this module exists

Two shipped tests in this package assert that a WRONG artifact PASSES, and both name this
module as the only thing that could catch it:

* `tests/test_sandbox_reachability.py` TEST-9 (#155) — a deliberately wrong affine survives
  the declaration constructor, the OME writer, the reader and the placement round trip. The
  wrong and correct artifacts *"differ in EXACTLY ONE key, and it is the one no gate reads."*
* `tests/test_image_downsample.py` TEST-11 (#176) — a wrong vendor `spot_diameter_fullres`
  yields a different resolution, a different factor, a different pixel grid and a different
  number of bytes on disk, and *"every check still passes, because every derived value
  agrees with every other."*

Every other guard in this arm reconciles the artifact **with itself** — the coordinates, the
pixels and the declared scale are required to agree. A uniform misscale satisfies all of
them, because it is wrong in the same proportion everywhere. Nothing that only looks inside
the artifact can ever see it.

So this module does not add another internal-consistency assertion. It measures two things
against referents that are not functions of the artifact at all.

## R1 — the slide (`check_scale`)

A Visium V1/V2 capture slide is MANUFACTURED with its spots on a fixed 100 um centre-to-centre
pitch (`docs/research/data-processing/02-platforms.md:357` — *"~5,000 spots (55 um diameter,
100 um center-to-center) over a 6.5 x 6.5 mm area"*). That number is a property of glass. It
is not in the bundle, it is not derived here, and no vendor field can move it.

The independent observation it is applied to is the spot lattice measured from
`tissue_positions.csv`'s PIXEL columns — a file that never touches
`scalefactors_json.json`. So `measured_pitch_px * microns_per_pixel` must be 100 um, and a
`microns_per_pixel` derived from a wrong `spot_diameter_fullres` moves it in exact
proportion. That is the quantity TEST-11 says nothing in this system can see.

The pitch is estimated as a MEDIAN NEAREST-NEIGHBOUR DISTANCE between spot centres, and
deliberately NOT from `array_row`/`array_col`.
`docs/research/spatial-platforms/01-sequencing-platforms.md:67-71` is explicit: *"Orientation
is NOT derivable from array indices... Slide rotation at imaging time decides it. Never
reconstruct positions from `array_row`/`array_col`."* The committed fixture confirms it —
`pxl_col` DECREASES as `array_col` increases. A median nearest-neighbour distance is
invariant to that rotation, to reflection, and to the index convention entirely. The
least-squares lattice fit against the indices is computed too, but purely as a corroborating
diagnostic in the report; it gates nothing.

## R2 — the tissue in the image (`check_registration`)

Space Ranger's `in_tissue` flag is the VENDOR'S OWN tissue detection, produced by the
vendor's pipeline in the vendor's frame. The image pixels are a separate observation of the
same tissue. Neither is a function of `to_space`.

So: map every spot into the image's own grid through the image's DECLARED `to_space`, derive
a tissue mask from the PIXELS, and score that mask against `in_tissue` with Youden's J. Under
a correct registration the two agree; under a wrong affine they decorrelate toward chance.
This is "put the coordinates on top of the image and look at whether the spots land on the
tissue", made computable.

The mask comes from the pixels and NOT from `in_tissue` (DEC-3). A mask built from the
positions table and scored against spots from the same positions table would agree with
itself by construction — an internal-consistency assertion wearing an overlay's clothes,
which is the one thing this module may not be.

## What this module CANNOT check, stated rather than implied

* It cannot detect a misregistration that moves the image and the spots TOGETHER. Nothing
  can; that is not a misregistration, it is a different frame.
* `J_FLOOR` is read off Youden's J's own scale (0 = chance, 1 = perfect), not calibrated
  against real H&E. The positive control this repo can offer is synthetic (DEC-6). It used
  to have to be, because the committed fixture's image did not cover its own spots at all;
  #243 ended that — the fixture now carries 10x's own 2000x2000 emission and all 160 of its
  spots land on it, so the check DOES run over real vendor H&E, and does so in
  `test_registration_qc`'s TEST-6.
  What that did not give us is a CONTROL. `make_registered` paints tissue where the vendor
  says the spots are, so the right answer is known by construction; on the real bundle the
  tissue mask and the `in_tissue` flags are two independent measurements, and their
  agreement is a finding about the data rather than a calibration. So the synthetic control
  proves the check DISCRIMINATES between a right and a wrong mapping over identical pixels;
  it still does not prove the floor is right for real staining. Calibrating it against the
  now-coherent real bundle is #156's work. That is why every score is reported as a NUMBER
  beside its verdict, and why `positive_control` says `synthetic`.
* R1 is specific to a fixed-pitch capture array. It self-declines on any platform that has
  no such pitch, rather than inventing a referent.

## This module never raises into the import (DEC-7)

A diagnostic that destroys a user's access to their data is worse than one that reports
loudly. `registration_qc` wraps its whole body the way `emit_images` does, and any failure
becomes a `not-evaluated` verdict naming the exception type. `not-evaluated` is a THIRD
value, distinct from both `pass` and `fail`, so "could not be checked" can never be read as
"checked and fine".
"""
import base64
import io
import json
import math
from pathlib import Path

import numpy as np

# The VENDORED write-time contract, staged beside this module by `run.helpers`. Used for ONE
# thing: reading the placement back out of an emitted artifact's own OME-XML, which is the
# declaration a sandboxed consumer actually gets.
import spatial_declarations as SD

# ── the referent, and the thresholds ─────────────────────────────────────────────────

#: THE EXTERNAL REFERENT (R1). The centre-to-centre spot pitch of a Visium V1/V2 capture
#: slide, in micrometres. A property of manufactured glass, cited in this repo's own research
#: corpus at `docs/research/data-processing/02-platforms.md:357` (source: UMN Spatialomics,
#: `02-platforms.md:771`).
#:
#: NOT a knob, and deliberately not an admin setting (DEC-11). Making it configurable would
#: let an operator retune the one number that makes this check EXTERNAL, which is precisely
#: the failure `import_visium.VISIUM_CAPTURE_SPOT_DIAMETER_UM` /
#: `import_visium.VISIUM_RENDERED_SPOT_DIAMETER_UM` (one constant until #222 split it) refuse
#: for the same reason. A check whose referent can be moved to make it pass is not a check.
#:
#: This referent is also what makes the #222 fix checkable rather than merely asserted: this
#: pitch, the positions table's own measured spacing, and `spot_diameter_fullres` are three
#: numbers none of which this repo chose, and together they pin which circle
#: `spot_diameter_fullres` measures.
SLIDE_SPOT_PITCH_UM = 100.0

#: Relative tolerance on `measured_pitch_px * microns_per_pixel` against
#: [`SLIDE_SPOT_PITCH_UM`]. Derived BEFORE any verdict was computed, from the two ends it has
#: to separate (DEC-4):
#:
#:   noise floor — the least-squares lattice residual on the committed real vendor bundle is
#:                 0.39 px RMS on a 113 px pitch (0.35%), and the hex lattice's own departure
#:                 from ideal is 0.46%. This is ~10x above both.
#:   signal floor — the smallest defect in evidence is 18.2%; TEST-11's own mutation is 200%.
#:                 This is ~3.6x below the smaller of those.
#:
#: Nothing depends on where in that gap it sits, and the tolerance has NOT moved since it was
#: derived. What HAS moved is the spread it separates, so the original note's illustration is
#: restated rather than left stale: before #222 the shipped bundle recorded 15.573% (the
#: defect) and the positive control recorded < 0.1%; after #222 the shipped bundle records
#: 0.223% — still an order of magnitude inside the tolerance — and the two scalefactor
#: mutations record 66.7% and 199.3%, an order of magnitude outside it. Recorded because the
#: sibling item's post-mortem is that a tolerance was widened in the same commit as the
#: behaviour it measures; this one was not touched by the commit that moved the numbers.
PITCH_TOLERANCE = 0.05

#: The floor on Youden's J = sensitivity + specificity - 1, scoring the pixel-derived tissue
#: mask against the vendor's `in_tissue` call.
#:
#: Read off the STATISTIC'S OWN SCALE, not calibrated to a fixture: J = 0 is exactly chance
#: (the image says nothing about where the vendor found tissue, which is what a wrong affine
#: produces) and J = 1 is perfect agreement. 0.5 says "the declared mapping recovers at least
#: half of the vendor's own tissue call". A threshold taken from the metric's range does not
#: move when the fixture changes, which is what keeps it from being tuned until green.
J_FLOOR = 0.5

#: Before J is computed at all, at least this fraction of spots must land inside the image.
#: J over a handful of survivors is not a measurement, and a badly wrong affine's FIRST
#: symptom is that the spots leave the frame entirely — which deserves to be reported as
#: itself rather than laundered into a low score.
MIN_SPOTS_INSIDE_FRACTION = 0.5

#: Longest edge of the rendered overlay PNG. The overlay is a `data:` URI inside a report a
#: browser renders, so it is bounded for the same reason `DIAGNOSTIC_INLINE_CAP_BYTES` exists:
#: a multi-thousand-pixel plane inlined as base64 would make the report unopenable.
OVERLAY_MAX_EDGE = 900

#: …and a cap on the ENCODED bytes, because bounding the edge length does not bound the file.
#: `OVERLAY_MAX_EDGE`'s reasoning cites `DIAGNOSTIC_INLINE_CAP_BYTES` as its precedent, and
#: that constant caps BYTES. A noisy 900x900 RGB plane compresses poorly, and two of them plus
#: the two vendor JPEGs can push the report to several megabytes with nothing saying why.
#: Same value as the vendor-diagnostic cap, for the same reason and against the same reader.
OVERLAY_MAX_BYTES = 2 * 1024 * 1024

#: The pixel budget for the plane this module READS BACK. Above it the coarsest pyramid level
#: that still clears [`_MIN_ANALYSIS_EDGE`] is used instead, and the mapping is rescaled from
#: the level's OWN shape against the declared extent — derived from the array, never assumed —
#: so a level choice cannot silently misplace a spot. Visium's images are far under this; the
#: budget exists for #162's Xenium morphology plane.
ANALYSIS_PIXEL_BUDGET = 64_000_000
_MIN_ANALYSIS_EDGE = 256

#: Above this many spots the nearest-neighbour estimator switches from the whole array to a
#: contiguous spatial WINDOW of this size. The estimator is O(n^2): measured on this host, a
#: full Visium V1 slide (4,992 spots) takes 0.85 s and 20,000 spots take 13.2 s, so a denser
#: array — #162's Visium HD bins run to millions — would hang a user's import at 95%.
#:
#: A WINDOW, never a scattered subsample: sampling scattered points removes a lattice point's
#: true nearest neighbours and inflates the pitch, which would corrupt the one measurement
#: this whole module rests on. A contiguous region does not, because a capture lattice is
#: homogeneous — the pitch inside any sub-region IS the pitch of the whole — and the report
#: says when a window was used.
PITCH_EXACT_MAX_SPOTS = 20_000

#: A Youden's J at or below MINUS this is not a misregistration — it is an INVERTED MASK.
#:
#: A wrong affine scatters the spots, which drives J toward 0 (chance). Driving it toward -1
#: takes systematic ANTI-correlation: in-tissue spots landing on background AND out-of-tissue
#: spots landing on tissue, together. The only thing that produces that is the tissue mask
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

#: Spot fill colours in the overlay, by the vendor's `in_tissue` call. Drawn as outlines so
#: the tissue underneath stays visible — the whole point is to see what the spot is sitting on.
_COLOUR_IN_TISSUE = (0, 200, 255)
_COLOUR_OUT_TISSUE = (255, 96, 0)


class RegistrationQCError(RuntimeError):
    """Raised INSIDE this module and caught at its own boundary. Never escapes to the import."""


# ── R1: the scale, against the slide ─────────────────────────────────────────────────


def measure_spot_pitch(coords):
    """`{median_nn_px, n_spots, n_measured, min_nn_px, max_nn_px}` from spot centres alone.

    The median distance from each spot to its nearest other spot. On a Visium capture array
    every interior spot has six neighbours at exactly the pitch, so the median is the pitch
    even on a subset that has lost some of them, and it is invariant to the slide rotation
    that `01-sequencing-platforms.md:67-71` says makes the array indices unusable for this.

    Returns `None` for the pitch when fewer than two spots carry a position — absence is
    absence, and a pitch invented from one point would be worse than no check.
    """
    pts = np.asarray(coords, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 2:
        return {"median_nn_px": None, "n_spots": int(len(pts)), "n_measured": 0}
    total = int(len(pts))
    # NON-FINITE POINTS ARE DROPPED, AND COUNTED. `float(v)` accepts the CSV text "nan" and
    # "inf" happily, and a single NaN coordinate makes `dist[:, j]` NaN for EVERY i — so the
    # row minimum is NaN for every spot, `finite` comes back empty, and the whole external
    # scale check disables itself while reporting "fewer than two spots carry a position",
    # which is false. One bad row must not cost the measurement, and a reader is entitled to
    # know a row was excluded rather than have it vanish.
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
    # O(n^2) on purpose: a Visium capture area holds 4992 spots, so this is ~25M distances of
    # float64 — under a second and a few hundred MB, against a `scipy.spatial` import whose
    # cost is a declared dependency this module does not otherwise need. Chunked so the peak
    # is bounded by the chunk rather than by n^2, which is what makes it safe to keep simple
    # if a later platform's array is larger.
    n = len(pts)
    nn = np.empty(n, dtype=np.float64)
    chunk = max(1, min(n, 4_000_000 // max(1, n)))
    for start in range(0, n, chunk):
        stop = min(n, start + chunk)
        block = pts[start:stop, None, :] - pts[None, :, :]
        dist = np.sqrt((block ** 2).sum(axis=2))
        # A spot is its own nearest neighbour at distance 0; mask the diagonal, not every
        # zero — two spots at the SAME position is a real (and reportable) defect, and
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


def lattice_fit_pitch(coords, array_row, array_col):
    """A CORROBORATING pitch from a least-squares fit against the array indices, or `None`.

    Gates nothing (DEC-13). It is reported beside the nearest-neighbour measurement so a
    reader can see two independent estimators agree — on the committed fixture they agree to
    0.22% (113.000 vs 113.2527 px) — without the check ever depending on the index semantics
    that `01-sequencing-platforms.md` forbids relying on.

    Fits `[x; y] = A @ [col; row] + b` and returns the length of the `+2 array_col` step,
    which is the within-row nearest-neighbour spacing on a Visium hex array.
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
        cx, *_ = np.linalg.lstsq(design, pts[:, 0], rcond=None)
        cy, *_ = np.linalg.lstsq(design, pts[:, 1], rcond=None)
        residual = np.hypot(design @ cx - pts[:, 0], design @ cy - pts[:, 1])
        step = float(np.hypot(cx[0], cy[0]))
        if not math.isfinite(step) or step <= 0:
            return None
        return {
            "pitch_px": 2.0 * step,
            "residual_rms_px": float(np.sqrt((residual ** 2).mean())),
        }
    except (ValueError, np.linalg.LinAlgError, TypeError):
        # A diagnostic that cannot be computed is simply absent. It gates nothing, so a
        # degenerate index set must not cost the measurement that does.
        return None


#: How `check_scale` explains that the design's diameter was NOT the number the scale came
#: from, keyed by `micron_scale`'s own recorded leg (DEC-6). A TABLE, because the first cut
#: hard-coded leg 1's sentence and then applied it to leg 3 as well — telling the reader that
#: "the vendor stated `microns_per_pixel` directly" on a bundle that declared NO scale at all.
#: A blind audit measured that end to end. Keyed on the source the importer RECORDED, so a new
#: leg is a row here and an unknown one gets the honest generic line rather than a wrong one.
_NOT_APPLIED_BECAUSE = {
    "vendor": "the vendor stated `microns_per_pixel` directly",
    "unavailable": "this bundle declares no micron scale at all",
}

#: The longest this note may be. It is carried into the artifact `meta` by
#: `import_visium.qc_verdict_lines`, which truncates at `QC_META_REASON_CHARS` (200) — and
#: `meta` is the only channel by which this check reaches a human in the shipped app. So the
#: note is SHORT BY CONSTRUCTION rather than short by luck, and the sentences below are
#: composed MOST-ACTIONABLE FIRST so that even a future cap change cannot cut the part a
#: reader has to act on.
#:
#: This is the third shape of this note. The first appended it to `reason` and pushed the
#: measurement line past the cap; the second split it out but composed identity-then-warning
#: and ran to 380 characters on an `assumed` bundle, cutting the warning off again. Both were
#: measured, the second by re-running the very probe that found the first. A budget the code
#: enforces is the only version of this that stays fixed.
MAX_SLIDE_DESIGN_NOTE_CHARS = 200


def _finite_float(value):
    """`float(value)` or `None`. TOTAL, including over an `int` too large for a double.

    `isinstance(x, (int, float))` is NOT enough to make `f"{x:g}"` safe: `json.loads` yields
    unbounded Python ints, and formatting one raises `OverflowError`. That matters here more
    than it looks, because `_slide_design_clause` is called from inside `registration_qc`'s
    DEC-7 `except` handler — a raise there escapes the handler and costs the user the whole
    import, which is the #298 E4 shape one package over. Found by a blind audit; the same
    class this branch had already fixed in `import_visium._positive_finite`.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (OverflowError, TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _slide_design_clause(slide_design):
    """The sentence(s) naming WHICH slide design the scale under test came from (#257).

    Carried as its own field, `slide_design_note` — see `check_scale`. #222's post-mortem is
    that the check FIRED and it took a human to work out what it meant, and the number under
    test is `rendered_spot_diameter_um / spot_diameter_fullres`, so a reader acting on a
    verdict needs the numerator and where it came from.

    THREE INDEPENDENT FACTS, composed most-actionable-first and never one branch chosen among
    three:

      1. was the design IDENTIFIED or ASSUMED — the assumption is the actionable one, so it
         leads;
      2. WHICH design, and the ratio it was identified from;
      3. WHETHER this import actually divided by that diameter — `True`, `False`, or NOT
         RECORDED, which are three answers rather than two.

    An earlier cut collapsed 1 and 3 into one early-returning branch, which told a
    no-scale-at-all bundle that the vendor had stated a scale AND shadowed the assumption
    warning entirely — presenting an ASSUMED design as an identified fact, which is the defect
    this note exists to prevent, moved one leg over. Both measured by a blind audit.

    Returns `""` when there is no usable design record, so a caller that does not pass one
    reads exactly as it did before.
    """
    if not isinstance(slide_design, dict):
        return ""
    diameter = _finite_float(slide_design.get("rendered_spot_diameter_um"))
    if diameter is None:
        # A record with no usable diameter says NOTHING rather than raising or half-claiming.
        return ""
    assumed = slide_design.get("matched_by") == "assumed-standard"
    applied = slide_design.get("applied_as_scale_numerator")

    if assumed:
        parts = [f" ASSUMED the standard {diameter:g} um spot circle — this design was NOT "
                 "identified; check that first."]
    else:
        ratio = _finite_float(slide_design.get("fiducial_over_spot"))
        parts = [f" Slide design `{slide_design.get('id')}`, {diameter:g} um spot circle"
                 + (f", fiducial/spot {ratio:.6f}." if ratio is not None else ".")]

    # `.get(...) is False` alone was FAIL-OPEN: a record that never went through `run_import`
    # — which is every record `slide_design()` returns, and the viz gate calls it directly —
    # carries no such key, and the affirmative reading was printed for it. Absence is now its
    # own answer.
    if applied is True:
        parts.append(" It IS this import's scale numerator.")
    elif applied is False:
        # `.get(<unhashable>)` RAISES `TypeError`, and this function is called from inside
        # `registration_qc`'s DEC-7 `except` handler where a raise escapes and costs the user
        # the whole import. `_finite_float` was added one round ago for precisely this class
        # and the same change introduced a new instance of it two lines down. A blind audit
        # caught it with `scale_source: []`.
        source = slide_design.get("scale_source")
        why = (_NOT_APPLIED_BECAUSE.get(source) if isinstance(source, str) else None)
        parts.append(" NOT this import's numerator: "
                     + (why or "the scale came from elsewhere") + ".")
    else:
        parts.append(" Application not recorded here.")

    note = "".join(parts)
    if len(note.strip()) > MAX_SLIDE_DESIGN_NOTE_CHARS:
        # BUDGET ENFORCED, not hoped for. Truncating HERE, with an explicit marker, is
        # different in kind from being silently cut by the meta cap downstream: the reader
        # sees that there is more and knows where it is. `test_the_slide_design_note_fits the
        # channel that carries it` asserts this branch is never taken on any shipped path, so
        # reaching it is a signal rather than a fallback that hides a regression.
        note = note[:MAX_SLIDE_DESIGN_NOTE_CHARS - 40].rstrip() + " … (full text in `slide_design`)"
    return note


def check_scale(coords, microns_per_pixel, *, scale_source=None,
                array_row=None, array_col=None, slide_design=None):
    """R1. `{verdict, measured_pitch_px, measured_pitch_um, expected_pitch_um, relative_error, ...}`.

    The whole external check on the micron scale, and therefore on the vendor number every
    micron measurement in this dataset descends from.

    `slide_design` (#257) is the record `import_visium.slide_design()` produced — WHICH
    rendered-spot circle the numerator under test is, and how that was decided. It is carried
    into the block and named in the `reason`, and it changes NO verdict: the referent is still
    the slide's 100 um pitch and nothing about the design can move it.
    """
    pitch = measure_spot_pitch(coords)
    block = {
        "referent": "visium-slide-spot-pitch",
        "referent_um": SLIDE_SPOT_PITCH_UM,
        "referent_source": (
            "docs/research/data-processing/02-platforms.md:357 — a Visium V1/V2 capture "
            "slide places its spots on a fixed 100 um centre-to-centre pitch"
        ),
        "tolerance": PITCH_TOLERANCE,
        "measured_pitch_px": pitch["median_nn_px"],
        "pitch_estimator": "median-nearest-neighbour",
        "n_spots": pitch["n_spots"],
        "microns_per_pixel": microns_per_pixel,
        "microns_per_pixel_source": scale_source,
        # #257. Carried whatever the verdict, including on the `not-evaluated` returns below —
        # "we could not check the scale" is a report a reader still has to act on, and the
        # numerator that would have been checked is part of what they need.
        "slide_design": slide_design,
        # ITS OWN FIELD, NOT A SUFFIX ON `reason` (#257 round 2). Appending it to `reason` was
        # the first shape and it was measured to be worse than saying nothing:
        # `import_visium.qc_verdict_lines` truncates `reason` at
        # `QC_META_REASON_CHARS` = 200 into the artifact `meta`, and `meta` is — by that
        # function's own docstring — THE ONLY CHANNEL BY WHICH THIS CHECK REACHES A HUMAN IN
        # THE SHIPPED APP. The committed fixture's reason went from 136 characters to 308, so
        # the app's line started ending mid-word, and on the `assumed-standard` branch the
        # whole "that assumption is the first thing to check" sentence — the one piece of
        # guidance #257 added for exactly the #222 situation — fell off the end. A blind audit
        # measured it. Two facts, two fields, and `qc_verdict_lines` gives each its own line.
        "slide_design_note": _slide_design_clause(slide_design).strip(),
    }
    if array_row is not None and array_col is not None:
        corroboration = lattice_fit_pitch(coords, array_row, array_col)
        if corroboration is not None:
            block["lattice_fit"] = corroboration

    if pitch["median_nn_px"] is None:
        block["verdict"] = VERDICT_NOT_EVALUATED
        block["reason"] = (
            "fewer than two spots carry a position, so there is no spacing to measure. The "
            "scale is UNCHECKED, which is a different fact from checked-and-correct."
        )
        return block
    if microns_per_pixel is None:
        block["verdict"] = VERDICT_NOT_EVALUATED
        block["reason"] = (
            "this bundle declares no micron scale, so there is no number to test against "
            f"the slide's {SLIDE_SPOT_PITCH_UM:g} um spot pitch. The spot spacing WAS "
            f"measured ({pitch['median_nn_px']:.3f} pixels) and is reported above, so a "
            "reader who obtains a scale can apply the referent by hand."
        )
        return block

    measured_um = pitch["median_nn_px"] * float(microns_per_pixel)
    error = abs(measured_um - SLIDE_SPOT_PITCH_UM) / SLIDE_SPOT_PITCH_UM
    block["measured_pitch_um"] = measured_um
    block["expected_pitch_um"] = SLIDE_SPOT_PITCH_UM
    block["relative_error"] = error
    # The scale the referent IMPLIES, so a reader who sees a failure is handed the number the
    # measurement points at rather than being left to divide. It is stated as an implication
    # of the referent, never written into any artifact.
    # GUARDED, because `measure_spot_pitch` masks only the diagonal: two spots at the SAME
    # position are "a real (and reportable) defect" and give a pitch of exactly 0. Dividing
    # unguarded here would raise BEFORE the FAIL branch below, the outer guard would swallow
    # it, and a degenerate positions table would report "could not be checked" instead of
    # "checked and wrong" — losing the measured pitch, the spot count and the verdict with it.
    if pitch["median_nn_px"] > 0:
        block["implied_microns_per_pixel"] = SLIDE_SPOT_PITCH_UM / pitch["median_nn_px"]
    if pitch["median_nn_px"] <= 0:
        block["verdict"] = VERDICT_FAIL
        block["reason"] = (
            "at least two spots in this table share a position, so the measured spot spacing "
            "is 0 pixels. That is not a spacing, and the micron scale cannot be checked "
            "against the slide's pitch until it is resolved — but the tissue map itself "
            "carries points that cannot both be right, which is why this is a FAIL and not "
            "an `unable to check`."
        )
        return block
    if error <= PITCH_TOLERANCE:
        block["verdict"] = VERDICT_PASS
        block["reason"] = (
            f"the spots are {pitch['median_nn_px']:.3f} pixels apart, which at the declared "
            f"{float(microns_per_pixel):.6g} um/pixel is {measured_um:.3f} um — within "
            f"{error * 100:.2f}% of the slide's {SLIDE_SPOT_PITCH_UM:g} um spot pitch."
        )
    else:
        block["verdict"] = VERDICT_FAIL
        block["reason"] = (
            f"the spots are {pitch['median_nn_px']:.3f} pixels apart, which at the declared "
            f"{float(microns_per_pixel):.6g} um/pixel is {measured_um:.3f} um — "
            f"{error * 100:.1f}% away from the {SLIDE_SPOT_PITCH_UM:g} um centre-to-centre "
            "pitch a Visium capture slide is manufactured with. The spot POSITIONS are the "
            "vendor's own and are not in question; what this measures is the micron scale "
            f"they are read with. A scale of {SLIDE_SPOT_PITCH_UM / pitch['median_nn_px']:.6g} "
            "um/pixel would put them at exactly the slide's pitch. Every micron measurement "
            "on this dataset — a neighbour-graph radius, a distance threshold — is off by "
            "this factor."
        )
    return block


# ── R2: the registration, against the tissue in the image ────────────────────────────


def invert_affine(to_space):
    """The inverse of a 2x3 row-major `[a, b, tx, c, d, ty]`, as a callable `(x, y) -> (u, v)`.

    `to_space` maps THIS IMAGE's pixels INTO the coordinate space; the overlay needs the other
    direction, to put a spot's full-resolution position onto the image.

    Written as a general 2x2 inverse rather than as `x / a`, even though every affine this
    package emits today is a pure diagonal scale. The reason is INV-3: a TRANSPOSED affine —
    `a = d = 0`, `b = c = s` — is precisely the defect this check exists to catch, and a
    reciprocal-of-`a` shortcut would divide by zero on it and report an exception instead of a
    failed registration. The check has to MAP the wrong affine and see where it puts the
    spots, not decline to evaluate it.
    """
    a, b, tx, c, d, ty = (float(v) for v in to_space)
    det = a * d - b * c
    if not math.isfinite(det) or det == 0.0:
        raise RegistrationQCError(
            f"the declared affine {list(to_space)!r} is singular (determinant {det!r}); it "
            "collapses the image onto a line or a point, so no spot has a well-defined "
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
    # THE CLASS BOUNDARY, not the bin's midpoint. The maximisation above puts bins [0..index]
    # in the dark class, so the boundary sits at (index + 1) / 256; `(index + 0.5) / 256`
    # would hand half of bin `index` to the bright class even though the between-class
    # variance placed it in the dark one, which makes the reported `threshold_normalised` not
    # the Otsu threshold its name claims.
    threshold = (index + 1) / 256.0
    dark = norm < threshold
    # THE BORDER BAND. On a capture-area image the outer frame is slide, not tissue.
    #
    # A one-pixel ring was the first implementation and it is too small a sample: a blind
    # audit demonstrated a plane that is 90% tissue reaching all four edges reading
    # `border_dark_fraction = 0.701` and inverting the mask outright. A band is a bigger
    # sample of the same evidence, and it is still only a heuristic — which is why an
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

    `sensitivity` = of the spots the VENDOR says are on tissue, the fraction whose mapped
    pixel is inside the mask. `specificity` = of the spots the vendor says are off tissue, the
    fraction outside it. `J = sensitivity + specificity - 1` is 0 at chance and 1 at perfect
    agreement, and is what a wrong affine destroys.
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
        # affine declares: at the hires level that is 0.5 image px = 2.5 full-resolution px =
        # about 2.2 um, which biases sensitivity and specificity on boundary-dense real
        # tissue. Inherited, not relitigated.
        jx = np.clip(np.floor(xs[inside]).astype(np.int64), 0, width - 1)
        jy = np.clip(np.floor(ys[inside]).astype(np.int64), 0, height - 1)
        hit[inside] = mask[jy, jx]
    # A spot that fell OFF the image is not on tissue. Scoring it as a miss rather than
    # dropping it is what keeps a wildly wrong affine from scoring well on the handful of
    # spots that happened to stay in frame.
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


def render_overlay(arr, image_xy, in_tissue, *, spot_diameter_image_px):
    """The overlay PNG bytes: the image, with every spot drawn at its DECLARED physical size.

    Drawn as an OUTLINE, not a fill, so the tissue under each spot stays visible — the whole
    question the reader is answering is what the spot is sitting on.

    The radius comes from the DECLARED micron scale through the DECLARED affine, never from a
    constant. That is what makes a misscale visible to a human and not only to `check_scale`:
    if the scale is wrong the circles are drawn the wrong size relative to the lattice they
    sit on, and the spacing-to-diameter ratio of a Visium array is something an eye reads
    immediately.
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
        # raised IndexError here, so a plane `tissue_mask` could score was one the renderer
        # could not draw — and, before the verdict was made durable below, that exception
        # also destroyed the metric's own answer. Mirrors `tissue_mask`'s chans < 3 branch.
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
    xs, ys = image_xy
    labels = np.asarray(in_tissue, dtype=bool)
    # Half the DECLARED diameter, in the overlay's own pixels. Floored at 1 so a spot on a
    # heavily downscaled overview is still visible as a mark rather than vanishing — an
    # invisible spot would make an unregistered overlay look like an empty one.
    radius = max(1.0, 0.5 * float(spot_diameter_image_px) * scale)
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
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
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
        "spot_radius_overlay_px": radius,
        # HOW MANY MARKS ARE ACTUALLY ON THE CANVAS, and where the first ones went.
        #
        # When every spot maps outside the image's frame the overlay contains ZERO drawn
        # marks, so the emitted picture is the bare tissue thumbnail. An overlay with no
        # marks and an ABSENT overlay are then the same picture, which is INV-2's own
        # failure mode arriving at the product rather than at the test. Counted here so the
        # report can say it, and so a test can assert the correct case draws something
        # rather than only that a PNG exists.
        #
        # That used to be the state of the repo's OWN committed vendor bundle, whose image
        # was a downscale that covered none of its spots. #243 fixed the fixture, so the
        # real bundle now draws all 160; `test_registration_qc` reaches the zero-mark branch
        # through a bundle broken on purpose (`make_downscaled_hires`) rather than through a
        # fixture that happened to be wrong.
        "marks_drawn": int(drawn),
        "marks_outside_frame": int(len(labels) - drawn),
        # The first few DRAWN centres, in the overlay's own pixels. This is the only record
        # of WHERE the renderer put anything: without it a renderer that ignored the mapping
        # entirely and laid the circles on an arbitrary lattice would be indistinguishable
        # from a correct one at every observable — which a blind audit demonstrated by doing
        # exactly that and watching the whole suite stay green.
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
    A level chosen for cost cannot then silently misplace a spot: if the two disagree the
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
        # This closes an asymmetry a blind design-conformance audit named: the PIXELS were
        # read back from disk "over the artifact AS STORED", while the AFFINE was taken from
        # the in-memory entry dict — so a writer that serialised a different affine than the
        # entry held was outside this check's reach, and §7.3's whole rule is "declare the
        # space", i.e. the thing on disk. The plan's ITEM-2 said "compose it from the
        # artifacts as stored"; this is the half that was missing.
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
    # silently misplace every spot along y in proportion to the mismatch, which is exactly
    # what the "a level choice cannot silently misplace a spot" claim above is supposed to
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

    That split is not tidiness. A blind audit of the first version of this module set
    `J_FLOOR` to 0.03 and then to 0.99 and the whole suite stayed green both times, because
    the only J values any test ever observed were 1.0 (the saturating positive control) and
    0.0 / 0.025 (the mutants). A threshold whose observed inputs are only the two extremes is
    pinned by nothing and can be moved anywhere in between. Judgement had to become callable
    on a synthetic block before it could be pinned.

    The ORDER matters and is not arbitrary: coverage is decided BEFORE agreement, because a
    badly wrong affine's first symptom is that the spots leave the frame entirely, and a
    Youden's J computed over the few that stayed in is not a measurement. Reporting that as
    itself is more use to a reader than laundering it into a low score.
    """
    to_space = block.get("to_space", [])
    if block["spots_inside_fraction"] < MIN_SPOTS_INSIDE_FRACTION:
        return {"verdict": VERDICT_FAIL, "reason": (
            f"only {block['spots_inside_image']} of {block['n_spots']} spots land inside "
            f"this image when placed through its declared affine "
            f"{[round(float(v), 8) for v in to_space]!r}. The image and the positions are "
            "not describing the same capture area, so there is nothing to score a "
            "registration over. This is what a badly wrong affine looks like from the "
            "outside."
        )}
    if block["youden_j"] is None:
        return {"verdict": VERDICT_NOT_EVALUATED, "reason": (
            "every spot carries the same `in_tissue` value, so there is no contrast to "
            "score the tissue mask against. A one-class label makes sensitivity or "
            "specificity undefined, and inventing the missing one would be a fabricated "
            "measurement — which is why this is NOT a pass."
        )}
    if block["youden_j"] <= -J_INVERSION_FLOOR:
        return {"verdict": VERDICT_NOT_EVALUATED, "reason": (
            f"the tissue mask is systematically ANTI-correlated with the vendor's `in_tissue` "
            f"call (Youden's J = {block['youden_j']:.3f}). A wrong affine scatters the spots "
            "and drives J toward 0; only an INVERTED MASK drives it toward -1. So this is a "
            "polarity failure, not a misregistration: the tissue in this image was read as "
            "background and the background as tissue, which happens when the frame's own "
            "border is not slide — a section that reaches the edge of a cropped or CytAssist "
            "image. The registration is UNCHECKED here, not wrong; reporting it as a "
            "misregistration would be a confidently-worded claim about the wrong thing."
        )}
    if block["youden_j"] >= J_FLOOR:
        return {"verdict": VERDICT_PASS, "reason": (
            f"placed through the declared affine, the spots agree with the tissue visible "
            f"in this image at Youden's J = {block['youden_j']:.3f} "
            f"(sensitivity {block['sensitivity']:.3f}, specificity "
            f"{block['specificity']:.3f}), at or above the {J_FLOOR:g} floor."
        )}
    return {"verdict": VERDICT_FAIL, "reason": (
        f"placed through the declared affine, the spots agree with the tissue visible in "
        f"this image at only Youden's J = {block['youden_j']:.3f} "
        f"(sensitivity {block['sensitivity']:.3f}, specificity "
        f"{block['specificity']:.3f}), below the {J_FLOOR:g} floor — where 0 is chance. The "
        "vendor's own `in_tissue` call and this image's own pixels disagree about where the "
        "tissue is, which is what a misregistration looks like. Read the overlay before "
        "reading anything off this image."
    )}


def check_registration(entry, outputs_dir, coords, in_tissue, *, microns_per_pixel,
                       spot_diameter_um):
    """R2 for ONE emitted `spatial/image`. Returns `(block, overlay_uri_or_None)`."""
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
    # Into the READ-BACK level's own grid. Both scales are 1.0 for every Visium image; they
    # are the seam that keeps a coarser-level read honest, and they are applied per-axis
    # because a pyramid level rounds its two dimensions independently.
    image_xy = (ux * level_scale_x, uy * level_scale_y)

    mask, mask_info = tissue_mask(arr)
    block["tissue_mask"] = mask_info
    block.update(score_registration(mask, image_xy, in_tissue))

    # The spot's DECLARED diameter, carried through the DECLARED affine into this image's
    # grid. `to_space[0]` is micrometres-per-space-unit's reciprocal in this image's pixels,
    # so dividing by it is the same composition the overlay is testing.
    diameter_image_px = None
    if microns_per_pixel:
        diameter_fullres_px = float(spot_diameter_um) / float(microns_per_pixel)
        scale_x = abs(float(to_space[0])) or abs(float(to_space[1]))
        if scale_x:
            diameter_image_px = diameter_fullres_px / scale_x * level_scale_x
    block["spot_diameter_image_px"] = diameter_image_px

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
    if diameter_image_px is not None:
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
                arr, image_xy, in_tissue, spot_diameter_image_px=diameter_image_px
            )
            if len(png) > OVERLAY_MAX_BYTES:
                block["overlay_omitted"] = (
                    f"the rendered overlay came to {len(png)} bytes, over the "
                    f"{OVERLAY_MAX_BYTES}-byte inline cap. It is omitted rather than "
                    "embedded, because a report a browser cannot open is not a report. The "
                    "verdict and every number behind it are unaffected."
                )
            elif not overlay_info["marks_drawn"]:
                # A PICTURE WITH NOTHING ON IT. Every spot mapped outside the frame, so what
                # was rendered is the bare image — indistinguishable from an overlay that was
                # never drawn, which is INV-2's failure mode at the product rather than at the
                # test. The verdict above already says the registration failed; this stops the
                # picture from quietly implying otherwise.
                block["overlay"] = overlay_info
                block["overlay_omitted"] = (
                    f"all {overlay_info['marks_outside_frame']} spots map outside this "
                    "image's frame, so an overlay would carry no marks at all — a bare "
                    "thumbnail that looks exactly like a registration nobody checked. It is "
                    "not embedded. The verdict above says what happened."
                )
            else:
                block["overlay"] = overlay_info
                overlay_uri = data_uri(png)
        except Exception as exc:
            block["overlay_omitted"] = (
                f"the overlay could not be rendered — {type(exc).__name__}: {exc}. The "
                "verdict above was computed before the render and still stands."
            )
    else:
        block["overlay_omitted"] = (
            "this bundle declares no micron scale, so a spot has no declared physical size "
            "to draw at. An overlay with an invented radius would look exactly like a "
            "measured one."
        )
    return block, overlay_uri


def _qc_header(coords, in_tissue, scope):
    """The QC block's descriptive header — WHAT was checked, before any verdict.

    Its own function so it can sit inside `registration_qc`'s guard. It was inline and
    OUTSIDE that guard once, which made the "never raises (DEC-7)" promise a claim the code
    did not enforce: a 0-d `coords` (TypeError from `len`) or an `in_tissue` that will not
    cast to bool escaped into `run_import` and aborted the whole import.
    """
    return {
        # WHICH spots were checked. `all-spots-in-positions-table` is the only scope in which
        # the registration check has two classes to score against: the filtered matrix holds
        # only in-tissue spots, so a matrix-joined sample makes Youden's J undefined by
        # construction. Recorded so a `not-evaluated` here is attributable rather than
        # mysterious.
        "scope": scope,
        "n_spots_checked": int(len(np.asarray(coords))),
        "n_in_tissue": int(np.asarray(in_tissue, dtype=bool).sum()),
        "referent_note": (
            "This is the only check in this importer with a referent OUTSIDE the artifact. "
            "Every other guard reconciles the artifact with itself, which a uniform misscale "
            "satisfies. The two referents here are the Visium slide's manufactured "
            f"{SLIDE_SPOT_PITCH_UM:g} um spot pitch, and the tissue visible in the vendor's "
            "own image scored against the vendor's own `in_tissue` call."
        ),
    }


def registration_qc(*, coords, in_tissue, microns_per_pixel, scale_source,
                    image_entries, outputs_dir, spot_diameter_um,
                    array_row=None, array_col=None, scope=None, slide_design=None):
    """The whole QC. Returns `(report_block, {image_id: overlay_data_uri})`.

    Never raises (DEC-7). Any failure becomes a `not-evaluated` verdict naming the exception
    type, because losing a diagnostic must never cost the user the matrix, the coordinates,
    the columns and the report.
    """
    overlays = {}
    block = {"kind": "visium-registration-qc"}
    try:
        block.update(_qc_header(coords, in_tissue, scope))
    except Exception as exc:
        # The header was built OUTSIDE this guard once, which made "never raises (DEC-7)" a
        # claim the code did not enforce: a 0-d `coords` (TypeError from `len`) or an
        # `in_tissue` that will not cast to bool escaped into `run_import` and aborted the
        # whole import — costing the user the matrix, the coordinates, the columns and the
        # report, which is precisely the outcome DEC-7 exists to prevent.
        block["header_error"] = f"{type(exc).__name__}: {exc}"
    try:
        block["scale"] = check_scale(
            coords, microns_per_pixel, scale_source=scale_source,
            array_row=array_row, array_col=array_col, slide_design=slide_design,
        )
    except Exception as exc:
        block["scale"] = {
            "verdict": VERDICT_NOT_EVALUATED,
            "reason": f"the scale check raised {type(exc).__name__}: {exc}",
            # CARRIED HERE TOO (#257 round 2). `check_scale` puts the design in every block it
            # RETURNS, and its comment says "carried whatever the verdict" — but this path is
            # the one `not-evaluated` that is not one of its returns, and it rebuilt the block
            # from scratch, silently dropping the very field the comment promised. A blind
            # audit caught the mismatch between the two. This is also the path where a reader
            # needs it most: the check could not run, so the numerator it WOULD have tested is
            # the only thing left to reason from.
            "slide_design": slide_design,
            "slide_design_note": _slide_design_clause(slide_design).strip(),
        }

    images = []
    for entry in image_entries:
        try:
            image_block, overlay_uri = check_registration(
                entry, outputs_dir, coords, in_tissue,
                microns_per_pixel=microns_per_pixel, spot_diameter_um=spot_diameter_um,
            )
            if overlay_uri is not None:
                overlays[entry["id"]] = overlay_uri
        except Exception as exc:
            # ONE guard around the WHOLE per-image body, for the same reason `emit_images`
            # has one: the raises are spread across a read-back, a matrix inverse, a
            # threshold and a render, and a per-call `except` will always miss the next one.
            image_block = {
                "image_id": entry.get("id"),
                "source": (entry.get("meta") or {}).get("source"),
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
            "the spots on. `images_not_emitted` in this report says why. An unchecked "
            "registration is not a correct one."
        )
    else:
        verdicts = [image["verdict"] for image in images]
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
