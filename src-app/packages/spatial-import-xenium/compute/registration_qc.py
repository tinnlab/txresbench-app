#!/usr/bin/env python3
# ruff: noqa
"""The registration QC — §7.5's required output, for the producer that had none (#301).

## Why this module exists

`docs/design/spatial-storage-layout.md` §7.5, verbatim:

    Nothing in the conformance gate can check an affine (§12.2). The compensating control is
    a **rendered overlay in the `report/qc`**: the spot centres drawn on the tissue image at
    the declared transform, exactly as Space Ranger's own `detected_tissue_image.jpg` does. A
    human sees a misregistration instantly and sees nothing else about it. **This is a
    required output of the importer, not a nice-to-have** — it is the entire verification
    story for step 7.3.

#156 built that overlay for `spatial-import-visium` and closed. Until this module,
`spatial-import-xenium` had none — no module, no staged helper, no emitted overlay — so the
placement of this importer's geometry was judged by nothing, and this package carried a
disclosure saying exactly that (#291), enumerating the prose sites that would go stale the
day someone built one. This is that day; #301 is the work item.

Every other guard in this importer reconciles the artifact **with itself**. `stated_scales`
compares the vendor's two statements of one number to each other; `coverage_note` compares the
image extent to the cell extent; `_reconcile_scale` requires the affine, the extent and the
recorded resolution to agree. A uniform misscale satisfies all of them, because it is wrong in
the same proportion everywhere — #269 recorded that residue explicitly and named §7.5's
overlay as the only thing that could see it. This module is the check with a referent OUTSIDE
the artifact.

## The referent (`score_registration`)

The morphology image's PIXELS and the vendor's CELL TABLE are two independent recordings of
the same slide, and neither is a function of `to_space`. The vendor segmented the cells IN THE
IMAGE'S OWN PIXEL FRAME and reported them in micrometres; this importer converts back through
a declared affine. So: derive a signal mask from the pixels, place every cell centre through
the image's DECLARED `to_space` — read back out of the emitted artifact's own OME-XML — and
measure how much better than CHANCE the cells land on signal.

    signal_lift = (hit_rate - mask_fraction) / (1 - mask_fraction)

0 is exactly chance (the image says nothing about where the cells are, which is what a wrong
affine produces) and 1 is perfect. This is "put the cells on top of the image and look at
whether they land on the tissue", made computable.

Measured on this package's own two real vendor bundles, over the emitted artifact:

| placement | xenium-prime-outs | xenium-protein-outs |
|---|---|---|
| the declared one   | **0.608** | **0.536** |
| 2% misscale        | 0.303 | 0.244 |
| 20 um translation  | 0.172 | 0.261 |
| 5% misscale        | 0.041 | 0.126 |
| 10% misscale       | 0.000 | 0.070 |
| transpose          | 0.000 | 0.000 |
| 2x / 0.5x misscale | 0.000 | 0.000 |

## Why NOT Youden's J, which the sibling uses (DEC-2)

Visium's R2 scores the pixel mask against the vendor's own `in_tissue` flag, which gives it a
real negative class. Xenium ships no such flag. Inventing one — calling some cells
"background" using the same pixels the mask came from — would be an internal-consistency
assertion wearing an overlay's clothes, which is the one thing this module may not be. So the
negative class is the frame's own GEOMETRY: the fraction of the plane the mask covers is the
rate at which random points would land on it, and that is what the lift is measured against.

## Why NOT a slide-pitch referent, which the sibling also uses (DEC-1)

`spatial-import-visium/compute/registration_qc.py`'s R1 measures the spot lattice against a
Visium capture slide's manufactured 100 um pitch — a property of glass. Xenium has no capture
array and no such pitch; its cells are segmented objects at tissue-determined positions. That
module's own docstring anticipates this: *"R1 is specific to a fixed-pitch capture array. It
self-declines on any platform that has no such pitch, rather than inventing a referent."* This
producer declines it at the source rather than shipping a leg that answers `not-evaluated` on
every bundle forever.

## WHICH STATEMENT PLACED THE IMAGE (`stated_scale_candidates`) — the Xenium-specific half

A Xenium bundle states its pixel size TWICE, in two files written by two parts of the vendor
pipeline: `experiment.xenium`'s `pixel_size` and the morphology TIFF's own OME-XML
`PhysicalSizeX/Y`. `stated_scale_agreement` (#269) measures them against each other and
reports `agreement: identical | differs | single-source | unreadable-unit`. What it cannot do
is say which one is RIGHT — it says so itself, and named §7.5's overlay as the thing that
would decide it.

This module is that thing, so it does three separable things about it rather than one:

1. the block records `placed_by` — the applied value, its source, the competing statement and
   the agreement verdict;
2. the rendered PNG carries a caption BURNED INTO THE PIXELS naming the applied statement. A
   caption beside a picture is separable from it; one inside it travels wherever the picture
   travels, and §7.5's premise is that the picture is what a human reads;
3. when the two DIFFER, the counterfactual placement the image's own OME-XML implies is
   SCORED against the same pixels and reported beside the applied one — so the reader is
   handed the comparison, not just the disagreement.

(3) invents no threshold and picks no winner: it reports two measurements against the same
external referent, each carrying its own verdict. #247 removed an invented band
(`_SCALE_HINT_MAX = 5.0`) and #269 removed an invented tolerance (`_STATED_SCALE_RTOL = 1e-6`),
both of which ruled from numbers this repo chose. A score against the image's own pixels is
not a number this repo chose.

## What this module CANNOT check, stated rather than implied

* It cannot see a misregistration that moves the image and the cells TOGETHER. Nothing can;
  that is not a misregistration, it is a different frame.
* It does not resolve a misscale below about 2% — measured above: a 2% error scores 0.303 on
  the prime bundle, under `SIGNAL_LIFT_FLOOR`'s 0.4 but not by much, and 0.244 on the protein
  bundle. The score is therefore reported as a NUMBER beside every verdict so a reader sees
  the margin rather than a word.
* `SIGNAL_LIFT_FLOOR` is read off the statistic's own scale and cross-checked against measured
  ends (see the constant). It is not calibrated against a population of real Xenium runs,
  because this repo has two bundles and neither is a population.
* The mask is a heuristic over one plane. A morphology image whose frame is entirely tissue
  defeats the border-based polarity call, which is why `MASK_FRACTION_CEILING` refuses to
  score at all rather than reporting the vacuous pass an inverted mask produces.

## This module never raises into the import (DEC-7)

A diagnostic that destroys a user's access to their data is worse than one that reports
loudly. `registration_qc` wraps its whole body the way `emit_image` does, and any failure
becomes a `not-evaluated` verdict naming the exception type. `not-evaluated` is a THIRD value,
distinct from both `pass` and `fail`, so "could not be checked" can never be read as "checked
and fine" — the same four-state discipline `stated_scale_agreement` uses one module over.
"""
import base64
import io
import math
from pathlib import Path

import numpy as np

# The VENDORED write-time contract, staged beside this module by `run.helpers`. Used for ONE
# thing: reading the placement back out of an emitted artifact's own OME-XML, which is the
# declaration a sandboxed consumer actually gets (#211).
import spatial_declarations as SD

# ── the thresholds, and where each number comes from ─────────────────────────────────

#: THE FLOOR on `signal_lift` — the fraction of the cells' agreement with the image that is
#: above chance. 0 is exactly chance; 1 is perfect.
#:
#: DERIVED BEFORE ANY VERDICT WAS COMPUTED, from the two ends it has to separate — the same
#: method `spatial-import-visium/compute/registration_qc.py`'s `PITCH_TOLERANCE` records, and
#: recorded here the same way:
#:
#:   correct end   the two REAL vendor bundles at their declared placement, scored over the
#:                 EMITTED artifact: 0.608 (prime) and 0.536 (protein).
#:   wrong end     the same pixels and the same cells through a wrong affine. The LARGEST
#:                 score any wrong placement reached is 0.303 (a 2% misscale on prime);
#:                 every factor-scale error, the transpose and a 10% misscale score at or
#:                 below 0.070.
#:
#: 0.4 is the geometric midpoint of 0.303 and 0.536: 32% above the worst wrong, 25% below the
#: worst correct. Nothing depends on where in that gap it sits.
#:
#: NOT A KNOB, and deliberately not an admin setting (DEC-11) — the sibling module's own DEC-11
#: settles the principle for this exact class: *"a check whose referent can be moved to make it
#: pass is not a check"*. An operator who can lower this floor until an import goes green has an
#: import that proves nothing, and this is the ONE check on this producer's placement.
#:
#: ITS HONEST LIMIT: it does not resolve a misscale below about 2%. That residue is real, is
#: reported as a number beside every verdict, and is why `test_registration_qc.py`'s TEST-20
#: RE-MEASURES both ends on both real bundles rather than quoting the table above — a constant
#: pinned only by a comment can be moved anywhere between the extremes the other tests observe.
SIGNAL_LIFT_FLOOR = 0.4

#: Before the lift is computed at all, at least this fraction of cells must land inside the
#: image. A lift over a handful of survivors is not a measurement, and a badly wrong affine's
#: FIRST symptom is that the geometry leaves the frame entirely — which deserves to be
#: reported as itself rather than laundered into a low score. Same value and same reasoning as
#: the sibling's `MIN_SPOTS_INSIDE_FRACTION`.
MIN_CELLS_INSIDE_FRACTION = 0.5

#: THE CEILING ON THE MASK'S OWN AREA, above which no lift is computed.
#:
#: This is the guard against the one way this statistic can go VACUOUSLY GREEN. `signal_lift`
#: is a one-class measure, so unlike Youden's J it cannot go meaningfully negative — the worst
#: a wrong affine drives it to is `-mask_fraction / (1 - mask_fraction)`, which is ~0 for a
#: sparse mask. What an INVERTED polarity call produces instead is a mask covering almost the
#: whole frame, on which every cell "lands on signal" and the lift reads ~1.0 for ANY affine.
#: An inverted mask therefore does not make this check fail; it makes it pass. That is worse.
#:
#: So a mask covering more than half the frame is refused rather than scored: above 50% "the
#: cells landed on it" is the majority outcome by AREA and carries less than one bit, whatever
#: the placement. Read off the geometry, not tuned — and measured far from it: the two real
#: bundles' masks cover 0.22% and 0.60% of their frames, two orders of magnitude below.
#:
#: The verdict is `not-evaluated`, never `pass`: a check that could not run must not look like
#: one that ran and was satisfied.
MASK_FRACTION_CEILING = 0.5

#: Longest edge of the rendered overlay's IMAGE part. The overlay is embedded as a `data:` URI
#: in a report a browser renders, so it is bounded for the same reason the sibling bounds its
#: own: a multi-thousand-pixel plane inlined as base64 makes the report unopenable. The
#: caption band (see `render_overlay`) is added BELOW this and is not counted in it — the
#: bound is on the evidence, and the caption is not evidence.
OVERLAY_MAX_EDGE = 900

#: …and a cap on the ENCODED bytes, because bounding the edge length does not bound the file.
#: A noisy 900x900 plane compresses poorly. Same value as the sibling's, for the same reason
#: and against the same reader.
OVERLAY_MAX_BYTES = 2 * 1024 * 1024

#: The pixel budget for the plane this module READS BACK. Above it the coarsest pyramid level
#: that still clears [`_MIN_ANALYSIS_EDGE`] is used instead, and the mapping is rescaled from
#: the level's OWN shape against the declared extent — derived from the array, never assumed —
#: so a level choice cannot silently misplace a cell.
#:
#: Both real bundles' emitted images are far under this (1929x1174 and 987x2305). The budget
#: exists because a Xenium morphology plane is 5789x3522 BEFORE the display downsample and
#: design §8.3 is explicit that it must not be range-read at full size.
ANALYSIS_PIXEL_BUDGET = 64_000_000
_MIN_ANALYSIS_EDGE = 256

#: HOW MANY MARKS THE OVERLAY DRAWS, above which it draws a DECLARED SUBSAMPLE.
#:
#: The picture is the control, and a picture whose marks cover the evidence is not one. A
#: blind design-conformance angle rendered a production-shaped probe — 300,000 cells on a
#: 5789x3522 plane, through this module's own path to a 900 px canvas — and the outlines
#: completely covered the morphology: the tissue underneath was invisible, so a reader could
#: not check what any cell was sitting on, and "drawn as OUTLINES so the morphology stays
#: visible" was void. The two committed fixtures are 23 and 358 cells; a real Xenium run is
#: 10^5-10^6, so no test observes that regime and neither did this module until it was
#: measured.
#:
#: DERIVED from the canvas, not chosen: at `OVERLAY_MAX_EDGE` = 900 the canvas holds at most
#: 810,000 pixels, and a mark is an outline of at least 8 pixels (the floor radius is 1), so
#: 20,000 marks is about 20% of the canvas covered in the best case and is where a scatter of
#: outlines is still readable. Above it the marks are the picture rather than the evidence.
#:
#: DECLARED, NEVER SILENT — design §8.3 asks for exactly that: a subsample for display "stated
#: as a product decision, not silently applied". So the count drawn, the count considered and
#: the stride are in the block, in the artifact's catalog row and in the caption burned into
#: the picture. And it is the PICTURE ONLY: `score_registration` uses every cell, so no
#: verdict and no number in this module is computed from a subsample.
#:
#: A STRIDE, never a random sample or a contiguous window: a stride over the vendor's own row
#: order preserves spatial coverage (a window would show one corner of the tissue and imply
#: the rest was checked), and it is deterministic, so two runs over one bundle draw the same
#: picture.
OVERLAY_MAX_MARKS = 20_000

#: THE LARGEST MARK RADIUS THE RENDERER WILL DRAW, in the overlay's own pixels.
#:
#: `cell_area` is vendor data and is the only numeric column this importer reads without a
#: range check, so the radius derived from it is unbounded. That is not merely untidy: PIL's
#: `ellipse` cost is catastrophic and NON-MONOTONIC in the radius — measured on Pillow 12.2.0,
#: r = 5e4 takes 31.8 s for ONE mark while r = 2e4 and r = 2e5 are sub-millisecond — so a
#: single cell with an absurd but FINITE area stalls the render for half a minute per mark. A
#: stall is not an exception: the sandbox's wall-clock kill is a SIGKILL, which no `except`
#: converts into `not-evaluated`, so it would cost the whole import rather than the picture.
#: Found by a blind error-handling angle, reproduced through the real renderer.
#:
#: Set to the canvas's own longest edge: a mark larger than the whole picture conveys nothing
#: a mark that size does not, and clamping is reported (`marks_clamped`) rather than silent.
OVERLAY_MAX_MARK_RADIUS_PX = float(OVERLAY_MAX_EDGE)

#: THE FRACTION OF THE FRAME'S BORDER BAND THAT MUST BE BACKGROUND for a FAIL to be
#: attributable to placement.
#:
#: `signal_mask` DECLARES the polarity (Xenium morphology is a fluorescence stain, so signal is
#: bright) rather than inferring it, and a declaration needs a check. The outer frame of a
#: morphology image should be background — i.e. mostly on the dark side of the threshold — so
#: this is that corroboration, read off the fraction's own scale: "mostly" is more than half.
#:
#: WHAT IT GATES, and only this: a FAIL. When the border is not background, this module has
#: misread the frame, and a low score cannot be attributed to placement rather than to that
#: misreading — so the verdict becomes `not-evaluated` naming the real cause instead of a
#: confidently-worded misregistration claim about the wrong thing. A PASS is untouched: cells
#: landing on bright stain is real agreement whatever the frame does.
#:
#: MEASURED far from it on both real vendor bundles — 1.000 (prime) and 0.994 (protein).
BORDER_BACKGROUND_MIN = 0.5

VERDICT_PASS = "pass"
VERDICT_FAIL = "fail"
VERDICT_NOT_EVALUATED = "not-evaluated"

#: THE COMPETING statement's name — the image's OWN OME-XML, i.e. the one that did NOT place
#: it. `stated_scales.applied_source` is always `experiment.xenium:pixel_size`
#: (`import_xenium._APPLIED_SCALE_SOURCE`, written unconditionally), so this is the source of
#: the COUNTERFACTUAL candidate and never of the applied one.
#:
#: The comment here first said the opposite — that this is what `applied_source` records —
#: which is false and which its own next sentence contradicted. Caught by a blind
#: design-conformance angle. Minor as prose, and it names the one thing §7.5's overlay is
#: being asked to decide, in a module whose whole posture is that an unchecked claim becomes
#: a stale one.
OME_SCALE_SOURCE = "morphology OME-XML:PhysicalSizeX/Y"

#: Mark colours, by whether the cell's mapped pixel landed on signal. Drawn as OUTLINES so the
#: morphology underneath stays visible — the whole question the reader is answering is what
#: the cell is sitting on. The colour is derived from the MASK, which is derived from the
#: PIXELS; it is not derived from the cells table, so it is a second observation of the same
#: thing the score measures rather than a restatement of the input.
_COLOUR_ON_SIGNAL = (0, 220, 255)
_COLOUR_OFF_SIGNAL = (255, 96, 0)
#: The caption band: ink on a dark ground, under the image.
_CAPTION_INK = (255, 255, 255)
_CAPTION_GROUND = (18, 18, 22)


class RegistrationQCError(RuntimeError):
    """Raised INSIDE this module and caught at its own boundary. Never escapes to the import."""


# ── placing the cells: the DECLARED affine, inverted ─────────────────────────────────


def invert_affine(to_space):
    """The inverse of a 2x3 row-major `[a, b, tx, c, d, ty]`, as a callable `(x, y) -> (u, v)`.

    `to_space` maps THIS IMAGE's pixels INTO the coordinate space; the overlay needs the other
    direction, to put a cell's micrometre position onto the image.

    Written as a general 2x2 inverse rather than as `x / a`, even though every affine this
    package emits today is a pure diagonal scale. The reason is that a TRANSPOSED affine —
    `a = d = 0`, `b = c = s` — is precisely the defect §7.3 calls *"the single most likely bug
    in the whole importer"*, and a reciprocal-of-`a` shortcut would divide by zero on it and
    report an exception instead of a failed registration. The check has to MAP the wrong
    affine and see where it puts the cells, not decline to evaluate it.
    """
    a, b, tx, c, d, ty = (float(v) for v in to_space)
    det = a * d - b * c
    if not math.isfinite(det) or det == 0.0:
        raise RegistrationQCError(
            f"the declared affine {list(to_space)!r} is singular (determinant {det!r}); it "
            "collapses the image onto a line or a point, so no cell has a well-defined "
            "position on it"
        )

    def apply(xs, ys):
        px = np.asarray(xs, dtype=np.float64) - tx
        py = np.asarray(ys, dtype=np.float64) - ty
        return (d * px - b * py) / det, (a * py - c * px) / det

    return apply


# ── the referent: what the pixels say is there ───────────────────────────────────────


def signal_mask(arr):
    """`(mask, info)` — a boolean signal mask derived from the PIXELS, and how it was derived.

    Otsu's threshold on the plane, with the BRIGHT class taken as signal — DECLARED for this
    producer, not inferred, and the difference is load-bearing.

    ## Why the polarity is declared here and MEASURED in the sibling

    Every plane this module ever sees comes from `xenium_image.read_plane`, and every Xenium
    morphology image is a FLUORESCENCE STAIN — DAPI by default (`xenium_image.PREFERRED_CHANNEL`),
    which is the channel the vendor's own segmentation registers against. Stain is brighter
    than background. `spatial-import-visium`'s sibling cannot say that: Space Ranger ships
    brightfield H&E (tissue DARKER) alongside fluorescence, so it has to decide the polarity
    per image, and it decides it from the frame's border.

    **Inferring it here was a real defect, found by a blind correctness angle, and it fired in
    the direction this docstring used to claim was impossible.** The old text said an inverted
    mask "makes it PASS for any affine at all" and pointed at `MASK_FRACTION_CEILING` as the
    guard. That is only true when the signal is sparse. On the case the sibling's own comment
    names — a plane that is ~90% tissue reaching all four edges — the border band is mostly
    BRIGHT, so a `border_dark_fraction < 0.5` test flipped the polarity, the mask became the
    small BACKGROUND class, its fraction sat well UNDER the ceiling, and a PERFECTLY REGISTERED
    import scored `hit_rate = 0.000` and reported **fail**. Reproduced: 1000x1000, 90.95%
    bright tissue touching every edge, 500 cells placed exactly on it, lift -0.0995, verdict
    `fail`. A false alarm on the only check this producer has is worse than the vacuous pass
    the guard was written for, and it reached the report, the overlay's `meta`, the rendered
    banner and the burned-in caption.

    With the polarity declared, that same plane yields a mask of 0.9095 — over
    `MASK_FRACTION_CEILING` — and is REFUSED as unscoreable, which is what the ceiling's own
    docstring always claimed. The guard now guards the case it names.

    ## The border is still measured, and it still does something

    A declaration needs a check. The outer frame of a morphology image should be background,
    so `border_dark_fraction` is measured and reported — and when it CONTRADICTS the
    declaration (the frame is mostly bright, i.e. not background), `border_confirms_background`
    is False and `registration_verdict` refuses to return a FAIL on that image. A low score
    there cannot be attributed to placement rather than to a frame this module has misread, and
    reporting it as a misregistration would be a confidently-worded claim about the wrong
    thing. A PASS is still allowed: cells landing on bright stain is real agreement whatever
    the frame does.

    A BAND, not a one-pixel ring: the sibling records a blind audit defeating the one-pixel
    version with exactly the mostly-tissue plane described above.
    """
    plane = np.asarray(arr)
    if plane.ndim == 3:
        band = plane[..., :3].astype(np.float64)
        if plane.shape[2] >= 3:
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
            "this image is a single constant value, so it carries no structure to measure a "
            "registration against"
        )
    # THE HISTOGRAM IS TAKEN OVER `lum` DIRECTLY, at its own range. Building a normalised
    # COPY of the plane just so the range could be (0, 1) doubled this function's peak: a
    # blind error-handling angle measured +1217 MB of RSS on an 8000x8000 plane — the size
    # this module's own ANALYSIS_PIXEL_BUDGET says it is willing to read — for a path whose
    # only product is a 900 px PNG. The bin edges are identical either way; what changes is
    # that one full float64 plane is never allocated.
    hist, _ = np.histogram(lum, bins=256, range=(lo, hi))
    weight = hist.astype(np.float64) / max(1, hist.sum())
    omega = np.cumsum(weight)
    mu = np.cumsum(weight * np.arange(256))
    total = mu[-1]
    with np.errstate(invalid="ignore", divide="ignore"):
        between = (total * omega - mu) ** 2 / (omega * (1.0 - omega))
    index = int(np.nanargmax(between))
    # THE CLASS BOUNDARY, not the bin's midpoint. The maximisation puts bins [0..index] in the
    # dark class, so the boundary sits at (index + 1) / 256; `(index + 0.5) / 256` would hand
    # half of bin `index` to the bright class even though the between-class variance placed it
    # in the dark one, which makes the reported `threshold_normalised` not the Otsu threshold
    # its name claims.
    threshold = (index + 1) / 256.0
    # …and the comparison is made at the plane's OWN scale, which is the same partition:
    # `norm < t` is `lum < lo + t * (hi - lo)` exactly, because the map is affine and
    # increasing. `threshold_normalised` is still reported on the 0..1 scale its name claims.
    dark = lum < (lo + threshold * (hi - lo))
    depth = max(1, min(dark.shape[0], dark.shape[1]) // 50)
    border = np.zeros(dark.shape, dtype=bool)
    border[:depth, :] = border[-depth:, :] = True
    border[:, :depth] = border[:, -depth:] = True
    border_dark_fraction = float(dark[border].mean())
    # THE BRIGHT CLASS IS THE SIGNAL, declared (see the docstring). Not `dark if <heuristic>`.
    mask = ~dark
    return mask, {
        "method": "otsu-luminance",
        "threshold_normalised": threshold,
        # DECLARED, and stated as a declaration rather than as a measurement, so a reader is
        # not left thinking this module decided it from the pixels.
        "polarity": "signal-is-brighter-than-background",
        "polarity_source": (
            "declared for this producer: every Xenium morphology image is a fluorescence "
            "stain (`xenium_image.read_plane` selects DAPI where the vendor names channels), "
            "so signal is brighter than background. Not inferred from this image."
        ),
        "border_dark_fraction": border_dark_fraction,
        "border_band_px": int(depth),
        # THE CHECK ON THE DECLARATION. The outer frame of a morphology image should be
        # background, i.e. mostly on the DARK side of the threshold. When it is not, this
        # module has misread the frame and `registration_verdict` will not return a FAIL on
        # the strength of it — see that function's own branch.
        "border_confirms_background": bool(border_dark_fraction >= BORDER_BACKGROUND_MIN),
        # HOW CLEARLY the frame is one thing. 0.5 is a coin flip; the further from it, the
        # more clearly the border is background (or is not). Reported so a reader can see when
        # the corroboration was near its boundary, which no verdict word can convey.
        "border_margin": abs(border_dark_fraction - 0.5) * 2.0,
        "mask_fraction": float(mask.mean()),
        "mask_fraction_ceiling": MASK_FRACTION_CEILING,
    }


def score_registration(mask, image_xy):
    """`signal_lift` and the counts behind it, for cells placed at `image_xy`.

    `hit_rate` = the fraction of ALL cells whose mapped pixel is inside the mask.
    `chance_rate` = the fraction of the plane the mask covers, i.e. the hit rate a random
    scatter of the same number of points would reach.
    `signal_lift = (hit_rate - chance_rate) / (1 - chance_rate)` — 0 at chance, 1 at perfect.

    A cell that fell OFF the plane is scored as a MISS rather than dropped. Dropping it is
    what would let a wildly wrong affine score well on the handful that happened to stay in
    frame, and the coverage fraction is reported separately so the two failure modes stay
    distinguishable.
    """
    height, width = mask.shape[:2]
    xs, ys = image_xy
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    finite = np.isfinite(xs) & np.isfinite(ys)
    inside = finite & (xs >= 0) & (xs < width) & (ys >= 0) & (ys < height)
    hit = np.zeros(len(xs), dtype=bool)
    if inside.any():
        # FLOOR, not round. #176 settled the affine convention as CORNER by proof — pixel
        # index i spans `[i*a, (i+1)*a)` — and the in-frame test just above uses that same
        # convention (`xs < width`). Rounding would be a pixel-CENTRE lookup, i.e. a
        # systematic half-pixel offset in the OPPOSITE direction from the convention the
        # affine declares. Inherited from the sibling, not relitigated.
        jx = np.clip(np.floor(xs[inside]).astype(np.int64), 0, width - 1)
        jy = np.clip(np.floor(ys[inside]).astype(np.int64), 0, height - 1)
        hit[inside] = mask[jy, jx]
    n = int(len(xs))
    chance = float(mask.mean())
    hit_rate = float(hit.mean()) if n else 0.0
    # The denominator is bounded below by `1 - MASK_FRACTION_CEILING` for any block that
    # reaches a verdict, because `registration_verdict` refuses a mask above that ceiling
    # before reading the lift. Guarded anyway: this function is public and the suite calls it
    # directly with masks the verdict would refuse.
    lift = (hit_rate - chance) / (1.0 - chance) if chance < 1.0 else None
    return {
        "n_cells": n,
        "cells_inside_image": int(inside.sum()),
        "cells_inside_fraction": float(inside.mean()) if n else 0.0,
        "cells_non_finite": int((~finite).sum()),
        "cells_on_signal": int(hit.sum()),
        "hit_rate": hit_rate,
        "chance_rate": chance,
        "signal_lift": lift,
        # THE MASK'S OWN HITS, in the overlay's colouring — carried out so `render_overlay`
        # colours each mark by the same boolean the score counted, rather than recomputing a
        # second, silently-divergent lookup.
        "_hit": hit,
    }


# ── the judgement, separated so both thresholds can be exercised on their boundary ───


def registration_verdict(block):
    """`{verdict, reason}` from a SCORED registration block.

    Split out of [`check_registration`] so every threshold can be exercised ON ITS BOUNDARY
    without needing a file on disk. That split is not tidiness: the sibling module records a
    blind audit setting its own floor to 0.03 and then to 0.99 with the whole suite green both
    times, because the only values any test ever observed were the two extremes. A threshold
    whose observed inputs are only the extremes is pinned by nothing.

    THE ORDER MATTERS and is not arbitrary:

    1. COVERAGE first — a badly wrong affine's first symptom is that the cells leave the frame
       entirely, and a lift computed over the few that stayed in is not a measurement.
       Reporting that as itself is more use to a reader than laundering it into a low score.
    2. THE MASK'S OWN AREA second — a mask covering most of the frame makes "the cells landed
       on it" carry almost no information, and it is what an inverted polarity call produces.
       This is the one branch that exists to stop a VACUOUS PASS rather than to catch a
       failure, which is why it is checked before the lift is read and not after.
    3. THE LIFT.
    4. AND, ONLY WHEN THE LIFT IS BELOW THE FLOOR, the frame's own corroboration
       (`BORDER_BACKGROUND_MIN`). `signal_mask` DECLARES the polarity for this producer rather
       than inferring it, and the border is what checks that declaration; when the border is
       not background this module has misread the frame, and a low score cannot then be
       attributed to PLACEMENT. It gates the FAIL and nothing else — a PASS is real agreement
       whatever the frame does. This is the branch a blind correctness angle produced a false
       `fail` through, on a perfectly registered 90%-tissue plane.
    """
    to_space = block.get("to_space", [])
    if block["cells_inside_fraction"] < MIN_CELLS_INSIDE_FRACTION:
        return {"verdict": VERDICT_FAIL, "reason": (
            f"only {block['cells_inside_image']} of {block['n_cells']} cells land inside "
            f"this image when placed through its declared affine "
            f"{[round(float(v), 8) for v in to_space]!r}. The image and the cell positions "
            "are not describing the same imaged region, so there is nothing to score a "
            "registration over. This is what a badly wrong affine looks like from the "
            "outside."
        )}
    mask_info = block.get("signal_mask") or {}
    mask_fraction = float(mask_info.get("mask_fraction", block.get("chance_rate", 0.0)))
    if mask_fraction > MASK_FRACTION_CEILING:
        return {"verdict": VERDICT_NOT_EVALUATED, "reason": (
            f"the signal mask covers {mask_fraction * 100:.1f}% of this image, over the "
            f"{MASK_FRACTION_CEILING * 100:.0f}% ceiling. Above that, 'the cells landed on "
            "signal' is the majority outcome by AREA whatever the placement is, so the "
            "measurement carries almost no information: it would read near 1.0 for any affine "
            "at all, which is a PASS nobody earned. Two things reach it — an image that is "
            "mostly tissue, and one whose stain this module has read backwards — and neither "
            "is separable from the other here, so it is refused rather than scored. The "
            "registration is UNCHECKED here, not wrong."
        )}
    if block.get("signal_lift") is None:
        return {"verdict": VERDICT_NOT_EVALUATED, "reason": (
            "the signal mask covers the entire plane, so there is no chance rate to measure "
            "against and no lift is defined. Inventing one would be a fabricated "
            "measurement — which is why this is NOT a pass."
        )}
    if block["signal_lift"] >= SIGNAL_LIFT_FLOOR:
        return {"verdict": VERDICT_PASS, "reason": (
            f"placed through the declared affine, {block['cells_on_signal']} of "
            f"{block['n_cells']} cell centres land on the signal this image's own pixels "
            f"carry — a hit rate of {block['hit_rate']:.3f} against a chance rate of "
            f"{block['chance_rate']:.4f}, i.e. a signal lift of {block['signal_lift']:.3f}, "
            f"at or above the {SIGNAL_LIFT_FLOOR:g} floor."
        )}
    # BELOW THE FLOOR — and this is the last question before it becomes a FAIL: is the frame
    # one this module read correctly? Placed HERE and not earlier, so it gates ONLY the FAIL.
    # A pass is untouched: cells landing on bright stain is real agreement whatever the border
    # does, and refusing a good placement because its frame is unusual would be the same
    # false alarm one direction over.
    if not mask_info.get("border_confirms_background", True):
        return {"verdict": VERDICT_NOT_EVALUATED, "reason": (
            f"this image's outer border is only "
            f"{float(mask_info.get('border_dark_fraction', 0.0)) * 100:.1f}% background, "
            f"under the {BORDER_BACKGROUND_MIN * 100:.0f}% this check needs to trust its own "
            "reading of the frame. The polarity is DECLARED for this producer (a Xenium "
            "morphology image is a fluorescence stain, so signal is brighter than background) "
            "and the border is what corroborates it; a frame that is not background means "
            "this module has misread the image, and a low score then cannot be attributed to "
            "PLACEMENT rather than to that misreading. Reporting it as a misregistration "
            "would be a confidently-worded claim about the wrong thing. The registration is "
            "UNCHECKED here, not wrong."
        )}
    return {"verdict": VERDICT_FAIL, "reason": (
        f"placed through the declared affine, only {block['cells_on_signal']} of "
        f"{block['n_cells']} cell centres land on the signal this image's own pixels carry — "
        f"a hit rate of {block['hit_rate']:.3f} against a chance rate of "
        f"{block['chance_rate']:.4f}, i.e. a signal lift of {block['signal_lift']:.3f}, below "
        f"the {SIGNAL_LIFT_FLOOR:g} floor where 0 is chance. The vendor segmented these cells "
        "FROM this image, so under a correct placement they land on it far better than chance "
        "and under a wrong one they decorrelate toward it. Read the overlay before reading "
        "anything off this image."
    )}


# ── which of the vendor's two statements placed the image ────────────────────────────


def stated_scale_candidates(stated_scales, to_space, downsample_factor):
    """The placements this bundle's OWN statements imply — the applied one, and the other one.

    Returns a list of `{name, source, pixel_size_um, to_space, applied}`. The first entry is
    always the placement that was actually used. A SECOND entry appears only when
    `stated_scales.agreement == "differs"` — i.e. when the bundle states its pixel size twice
    and the two are not the same number.

    ## Why the second entry exists at all

    `stated_scale_agreement` (#269) measures the disagreement and reports both raw numbers,
    and says in its own warning that it does not guess which is right because deciding it
    needs the control §7.5 asks for. This module IS that control, so reporting the
    disagreement again would add nothing: the reader already has it. What they do not have is
    the two placements scored against the image's own pixels — which is the comparison that
    decides it.

    ## Where the counterfactual affine comes from

    `emit_image` builds the applied affine as `ome_writer.emitted_affine(1 / pixel_size,
    factor)`, i.e. `[pixel_size * factor, 0, 0, 0, pixel_size * factor, 0]` — the physical
    size of ONE EMITTED pixel, in the space's own micrometre unit. The counterfactual is the
    identical composition with the OME-XML's stated size substituted per axis, using the
    emitted `display_derivative.downsample_factor` that is already in `meta`. Nothing is
    re-read from the vendor file and no re-import is needed.

    Per axis, because an image can state X and Y differently and folding them would invent a
    number neither statement made. An axis the OME-XML did not state (or stated in a unit this
    importer cannot convert, which `stated_scale_agreement` records as
    `unreadable_unit_axes`) keeps the APPLIED value on that axis, and the candidate says so —
    a half-substituted affine is still a real placement the bundle's statements imply, and
    dropping it would lose the case where exactly one axis disagrees.
    """
    stated_scales = stated_scales if isinstance(stated_scales, dict) else {}
    applied_value = stated_scales.get("applied_pixel_size_um")
    applied = {
        "name": "the applied placement",
        "source": stated_scales.get("applied_source"),
        "pixel_size_um": applied_value,
        "to_space": [float(v) for v in to_space],
        "applied": True,
    }
    candidates = [applied]
    if stated_scales.get("agreement") != "differs":
        return candidates

    # AN ABSENT FACTOR IS 1; AN INVALID ONE DECLINES. The two are different facts and folding
    # them was a real bug: `float(x) if x else 1.0` reads a `downsample_factor` of 0 — which
    # is not a factor at all — as "the image was not downsampled" and builds a counterfactual
    # from an affine the bundle never implied. An image with no `display_derivative` genuinely
    # was not downsampled, so 1 is its real factor; a factor of 0, a NaN or a negative is a
    # damaged record, and a comparison built on one would be a fabricated placement.
    if downsample_factor is None:
        factor = 1.0
    else:
        try:
            factor = float(downsample_factor)
        except (TypeError, ValueError):
            return candidates
        if not (math.isfinite(factor) and factor > 0):
            return candidates
    ome_x = stated_scales.get("ome_physical_size_x_um")
    ome_y = stated_scales.get("ome_physical_size_y_um")
    if ome_x is None and ome_y is None:
        # `agreement == "differs"` cannot be reached without at least one comparable axis,
        # so this is unreachable through `emit_image`. Guarded because this function is
        # public and a stored report can arrive with any shape.
        return candidates
    a = float(ome_x) * factor if ome_x is not None else float(to_space[0])
    d = float(ome_y) * factor if ome_y is not None else float(to_space[4])
    substituted = [axis for axis, v in (("x", ome_x), ("y", ome_y)) if v is not None]
    candidates.append({
        "name": "the placement the image's OWN OME-XML implies",
        "source": OME_SCALE_SOURCE,
        "pixel_size_um": {"x": ome_x, "y": ome_y},
        "substituted_axes": substituted,
        # The translation is carried over unchanged: neither statement says anything about an
        # origin, so substituting one would be inventing a second difference the bundle did
        # not state.
        "to_space": [a, float(to_space[1]), float(to_space[2]),
                     float(to_space[3]), d, float(to_space[5])],
        "applied": False,
    })
    return candidates


# ── the overlay a human reads ────────────────────────────────────────────────────────


def mark_stride(n_marks):
    """The declared display stride for `n_marks` cells: 1, or the smallest k that fits.

    ONE function, called by BOTH the renderer and the caption builder, because the caption is
    an INPUT to the render and so cannot read the render's own report. Two independent
    computations of the same stride is a caption that can disagree with the picture it is
    burned into — which is the failure this module spends its whole `placed_by` block avoiding
    one field over.
    """
    n = int(n_marks)
    if n <= OVERLAY_MAX_MARKS:
        return 1
    return max(1, int(math.ceil(n / OVERLAY_MAX_MARKS)))


def _display_levels(band, mask):
    """`(black, white)` display levels DERIVED FROM THE MASK, or `None` to fall back.

    ## Why a plain min/max stretch makes this overlay unreadable

    A Xenium morphology plane is fluorescence and is overwhelmingly EMPTY. Measured on the
    emitted artifacts of both real vendor bundles: the 99th percentile of both is **0**, and
    the signal occupies 0.22% (prime) and 0.60% (protein) of the frame. Under a global
    min/max map the entire visible range is spent on a handful of bright pixels, and then the
    render's own downscale — a bilinear average over a mostly-zero neighbourhood — takes what
    is left to nearly black. The first cut did exactly that and the protein bundle's overlay
    came out as marks floating on an empty field: a picture in which a human cannot see the
    tissue is a picture in which they cannot see a misregistration, which is the whole of
    INV-3.

    ## The levels are DERIVED, not a new tunable

    Black is the median of the pixels the mask calls BACKGROUND; white is the median of the
    pixels it calls SIGNAL. So half the signal saturates and the background sits at black,
    which is what makes a sparse fluorescence plane legible — and neither number is a
    threshold this module chose. It reuses the mask that is already computed for the score.

    THIS IS DISPLAY ONLY, and the separation matters. `signal_mask` and `score_registration`
    read the RAW plane; nothing here can move a verdict. What it changes is what a human sees,
    which is the half a number cannot carry.

    Returns `None` when the two medians do not separate (a mask that selected nothing, or a
    plane whose signal and background have the same median) — the caller then falls back to
    the plain min/max map rather than inventing a range.
    """
    # NO FULL float64 CAST. `np.median` promotes what it is given, so the two boolean-indexed
    # SELECTIONS are the only copies, and on a real plane the signal selection is under 1% of
    # it. Casting the whole plane first — for two medians — was a second avoidable full copy
    # a blind error-handling angle measured.
    values = np.asarray(band)
    selected = np.asarray(mask, dtype=bool)
    if selected.shape != values.shape[:2] or not selected.any() or selected.all():
        return None
    black = float(np.median(values[~selected]))
    white = float(np.median(values[selected]))
    if not (math.isfinite(black) and math.isfinite(white)) or white <= black:
        return None
    return black, white


def _stretch_uint8(band, levels):
    """One channel to `uint8` between explicit `(black, white)` levels, clipped."""
    black, white = levels
    data = np.asarray(band, dtype=np.float64)
    return np.clip((data - black) / (white - black) * 255.0, 0, 255).astype(np.uint8)


def _block_max_downscale(band, target):
    """Downscale a uint8 plane to at most `target` (width, height) by BLOCK MAXIMUM.

    ## Why not the bilinear resize PIL would do

    A Xenium morphology plane is SPARSE: measured on the emitted artifacts of both real
    vendor bundles, the mask covers 0.22% and 0.60% of the frame and the 99th percentile of
    both is zero. A bilinear (or box-mean) downscale averages each output pixel over a
    neighbourhood that is almost entirely background, so a plane whose signal is 100% bright
    comes out at a few percent grey and the overlay renders as marks floating on an empty
    field. That is what the first cut did, and a picture in which a human cannot see the
    tissue is not the control §7.5 asks for.

    A block MAXIMUM keeps a signal pixel visible in every block it falls in. It is the right
    reduction for a sparse presence/absence question, and it is the WRONG one for a
    measurement — which is exactly why `ome_writer.downsample` uses a box MEAN for the
    emitted artifact and this does not. **Nothing here touches the artifact or the score.**
    The mask and every number come from the raw plane read off disk; this is the display
    path and it ends in a PNG.

    The integer block is taken first and the remainder is left to PIL, so the result is
    exactly `target` and the mark coordinates (computed from the same `scale`) still land
    where they belong.
    """
    from PIL import Image

    values = np.asarray(band)
    height, width = values.shape[:2]
    target_w, target_h = target
    factor = int(min(width // max(1, target_w), height // max(1, target_h)))
    if factor > 1:
        rows, cols = (height // factor) * factor, (width // factor) * factor
        blocks = values[:rows, :cols].reshape(rows // factor, factor, cols // factor, factor)
        values = blocks.max(axis=(1, 3))
    if (values.shape[1], values.shape[0]) != (target_w, target_h):
        # THE REMAINDER, left to PIL. `Image.fromarray` needs a mode it knows and the plane is
        # still in its SOURCE dtype here (the display stretch runs after this, on ~1/50th the
        # data), so the remainder is resized as a 32-bit integer image and read back.
        image = Image.fromarray(np.ascontiguousarray(values.astype(np.int32)), mode="I")
        values = np.asarray(image.resize((target_w, target_h), Image.BILINEAR))
    return values


def _to_uint8(band):
    """One channel, normalised to `uint8` for display. Never assumes the source dtype.

    Every Xenium morphology plane this importer emits is `uint16` (measured on both real
    bundles), so a bare `.astype(uint8)` would wrap the plane into noise and make a correctly
    registered overlay unreadable. `ome_writer.read_image`'s contract is explicit that the
    dtype is not constrained, so this normalises rather than casts.
    """
    values = np.asarray(band)
    if values.dtype == np.uint8:
        return values
    data = values.astype(np.float64)
    lo, hi = float(np.nanmin(data)), float(np.nanmax(data))
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        return np.zeros(data.shape, dtype=np.uint8)
    return np.clip((data - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)


def _to_uint8_rgb(band):
    """Three channels to `uint8` under ONE shared linear map, so hues survive.

    Normalising each channel separately would give a 16-bit or float RGB plane three different
    linear maps, so the overlay's colours would not be the image's colours.
    """
    values = np.asarray(band)
    if values.dtype == np.uint8:
        return values
    data = values.astype(np.float64)
    lo, hi = float(np.nanmin(data)), float(np.nanmax(data))
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        return np.zeros(data.shape, dtype=np.uint8)
    return np.clip((data - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)


def _caption_font():
    """A bitmap font that needs no font FILE on disk.

    `ImageFont.load_default()` ships inside Pillow, so the caption cannot fail because a
    sandbox image lacks a system font — which is the failure mode a `truetype("DejaVuSans")`
    would have, silently, only in production. `size=` was added in Pillow 10.1 and this
    package declares `pillow >=10,<14`, so it is attempted and fallen back from rather than
    required.
    """
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=13)
    except TypeError:
        return ImageFont.load_default()


#: The characters `ImageFont.load_default()`'s bitmap face actually carries. It is a
#: latin-1-ish face, and a glyph it lacks is drawn as a hollow BOX — so an em dash or a `um`
#: written with the micro sign turns the burned-in provenance into a caption with squares in
#: it. Measured, not assumed: the first render of this overlay put a box where every `—` was.
#: Folded rather than dropped, because dropping a character silently shortens a number.
_CAPTION_FOLD = {
    "\u2014": "-", "\u2013": "-", "\u2018": "'", "\u2019": "'",
    "\u201c": '"', "\u201d": '"', "\u00b5": "u", "\u03bc": "u", "\u00a0": " ",
    # The section sign is the one non-ASCII character this repo's prose uses constantly, and
    # it is spelled out rather than folded to a letter: "design S7.5" reads like a typo where
    # "design section 7.5" reads like the citation it is.
    "\u00a7": "section ",
}


def _ascii(text):
    """`text` with the characters the default bitmap font cannot draw folded to ones it can."""
    folded = "".join(_CAPTION_FOLD.get(ch, ch) for ch in str(text))
    # Anything still outside the printable ASCII range becomes `?` rather than a box: a
    # visible substitution says "a character was lost here", where a box says nothing.
    return "".join(ch if 32 <= ord(ch) < 127 else "?" for ch in folded)


def _wrap(draw, font, text, max_width):
    """`text` broken into lines that fit `max_width` pixels, measured with the real font."""
    words, lines, current = _ascii(text).split(), [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [""]


def render_overlay(arr, image_xy, on_signal, *, cell_diameter_image_px, caption_lines,
                   mask=None):
    """The overlay PNG bytes: the image, the cells drawn where the declaration puts them, and
    a caption saying WHICH vendor statement placed it.

    Marks are drawn as OUTLINES, not fills, so the morphology under each cell stays visible —
    the whole question the reader is answering is what the cell is sitting on.

    The radius comes from the vendor's own per-cell `cell_area` carried through the DECLARED
    affine, never from a constant (DEC-10). That is what makes a misscale visible to a HUMAN
    and not only to `score_registration`: if the scale is wrong the circles are drawn the wrong
    size relative to the nuclei they sit on, and the ratio of a cell to the nucleus it contains
    is something an eye reads immediately.

    ## The caption is BURNED IN, and that is the point (DEC-5)

    A Xenium bundle states its pixel size twice and they can disagree; §7.5's control is the
    thing that decides which is right, so an overlay that renders without saying which
    statement placed it has not done the job (#301). A caption in a sibling field is separable
    from the picture — copied out of a report, pasted into a slide, mailed to a collaborator,
    the picture arrives and the provenance does not. A caption in the PIXELS travels with it.

    It is drawn in a band BELOW the image, never over it: covering the evidence to label the
    evidence is not a trade this check gets to make. `OVERLAY_MAX_EDGE` therefore bounds the
    image part; the band is extra.
    """
    from PIL import Image, ImageDraw

    plane = np.asarray(arr)
    # THE DISPLAY STRETCH, from the mask the score already computed (see `_display_levels`).
    # `None` when there is no mask or the two medians do not separate, in which case every
    # branch below falls back to the plain min/max map.
    levels = _display_levels(plane, mask) if (mask is not None and plane.ndim == 2) else None
    if plane.ndim == 2:
        # RAW, not yet mapped to uint8 — the display map is applied AFTER the reduction below.
        grey = plane
    elif plane.ndim == 3 and plane.shape[2] >= 3:
        grey = None
        rgb = _to_uint8_rgb(plane[..., :3])
    elif plane.ndim == 3:
        # 1 or 2 samples (a grayscale, or grayscale + alpha, plane). Indexing channel 2
        # unconditionally would raise here, so a plane `signal_mask` could score would be one
        # the renderer could not draw.
        grey = plane[..., 0]
    else:
        raise RegistrationQCError(
            f"expected a 2-D or 3-D image plane to render, got ndim={plane.ndim}"
        )
    source_h, source_w = plane.shape[0], plane.shape[1]
    scale = min(1.0, OVERLAY_MAX_EDGE / max(source_w, source_h))
    target = (max(1, int(round(source_w * scale))), max(1, int(round(source_h * scale))))
    if grey is not None:
        # SINGLE-CHANNEL: reduced by BLOCK MAXIMUM (see `_block_max_downscale`), because a
        # mean over a sparse fluorescence plane erases the very signal the reader is being
        # asked to look at.
        #
        # THE REDUCTION RUNS BEFORE THE STRETCH, on ~1/50th the data. Both are MONOTONE
        # INCREASING maps, and a monotone map commutes with a maximum — `max(f(a), f(b))` is
        # `f(max(a, b))` — so the pixels are identical either way and the full-resolution
        # float64 stretch a blind error-handling angle measured is simply not allocated. The
        # clip is monotone too (non-strictly, which is enough).
        reduced = _block_max_downscale(grey, target) if scale < 1.0 else grey
        if levels is not None:
            reduced = _stretch_uint8(reduced, levels)
        else:
            reduced = _to_uint8(reduced)
        image = Image.fromarray(np.repeat(reduced[:, :, None], 3, axis=2), mode="RGB")
    else:
        # MULTI-CHANNEL: a colour plane is not sparse in the same way and a per-channel block
        # max would shift its hues, so this keeps PIL's resample. No Xenium morphology image
        # reaches here today (`xenium_image.read_plane` returns one plane), which is why the
        # cheaper path is the one that is not special-cased.
        image = Image.fromarray(rgb, mode="RGB")
        if scale < 1.0:
            image = image.resize(target, Image.BILINEAR)
    draw = ImageDraw.Draw(image)
    xs, ys = image_xy
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    labels = np.asarray(on_signal, dtype=bool)
    radii = np.asarray(cell_diameter_image_px, dtype=np.float64) * 0.5 * scale
    width, height = image.size
    # THE DECLARED SUBSAMPLE (see `OVERLAY_MAX_MARKS`). A STRIDE over the vendor's own row
    # order, so the drawn set covers the whole tissue rather than one corner of it, and so two
    # runs over one bundle draw the same picture. The SCORE is untouched — every number in
    # this module is computed over every cell — and the counts are reported below and burned
    # into the caption, because §8.3 asks for a declared subsample and not a silent one.
    considered = len(xs)
    stride = mark_stride(considered)
    indices = range(0, considered, stride)
    drawn, placed, clamped = 0, [], 0
    for index in indices:
        x, y = xs[index], ys[index]
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        cx, cy = x * scale, y * scale
        # A mark whose centre is off the canvas is NOT drawn and NOT counted. PIL would
        # happily clip it, which is what would make an all-off-frame overlay
        # indistinguishable from a correctly drawn one: both produce a valid PNG of the right
        # size.
        if not (0 <= cx < width and 0 <= cy < height):
            continue
        # Floored at 1 so a cell on a heavily downscaled overview is still a visible mark
        # rather than vanishing — an invisible cell would make an unregistered overlay look
        # like an empty one.
        radius = radii[index] if index < len(radii) and math.isfinite(radii[index]) else 1.0
        radius = max(1.0, float(radius))
        # CAPPED. `cell_area` is unvalidated vendor data and PIL's ellipse cost is
        # catastrophic and non-monotonic in the radius (measured: r = 5e4 is 31.8 s for ONE
        # mark), so an absurd-but-finite area would stall the render past the sandbox's
        # wall-clock kill — a SIGKILL, which no guard converts into `not-evaluated`. Counted
        # rather than silently clamped.
        if radius > OVERLAY_MAX_MARK_RADIUS_PX:
            radius = OVERLAY_MAX_MARK_RADIUS_PX
            clamped += 1
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=_COLOUR_ON_SIGNAL if (index < len(labels) and labels[index])
            else _COLOUR_OFF_SIGNAL,
            width=1,
        )
        drawn += 1
        if len(placed) < 8:
            placed.append([round(float(cx), 3), round(float(cy), 3)])

    font = _caption_font()
    pad = 6
    wrapped = []
    for line in caption_lines:
        wrapped.extend(_wrap(draw, font, str(line), max(1, width - 2 * pad)))
    line_height = int(math.ceil(font.getbbox("Ag")[3] - font.getbbox("Ag")[1])) + 4
    band_height = pad * 2 + line_height * len(wrapped)
    canvas = Image.new("RGB", (width, height + band_height), _CAPTION_GROUND)
    canvas.paste(image, (0, 0))
    band = ImageDraw.Draw(canvas)
    for row, line in enumerate(wrapped):
        band.text((pad, height + pad + row * line_height), line,
                  fill=_CAPTION_INK, font=font)

    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), {
        "width": canvas.size[0], "height": canvas.size[1],
        "image_height": height,
        "caption_band_height": band_height,
        "caption_lines": list(wrapped),
        "render_scale": scale,
        # HOW MANY MARKS ARE ACTUALLY ON THE CANVAS, and where the first ones went.
        #
        # When every cell maps outside the image's frame the overlay contains ZERO drawn
        # marks, so the emitted picture is the bare morphology thumbnail — and an overlay
        # with no marks and an ABSENT overlay are then the same picture. Counted here so the
        # report can say it, and so a test can assert the correct case draws something rather
        # than only that a PNG exists.
        "marks_drawn": int(drawn),
        "marks_considered": int(considered),
        # THE SUBSAMPLE, DECLARED (§8.3). `stride == 1` is the ordinary case and says so by
        # `marks_subsampled` being False rather than by the key being absent.
        "marks_subsampled": bool(stride > 1),
        "mark_stride": int(stride),
        # HOW MANY MARKS HIT THE RADIUS CAP. A clamped mark is a mark drawn at the wrong size,
        # which is the one thing DEC-10 says the reader is reading; silence would make an
        # absurd `cell_area` look like an ordinary one.
        "marks_clamped_to_max_radius": int(clamped),
        # OF THE MARKS IT TRIED TO DRAW. Not of every cell: with a stride, the cells that were
        # never considered are not "outside the frame", and counting them as such would report
        # a placement failure that did not happen.
        "marks_outside_frame": int(len(indices) - drawn),
        # The first few DRAWN centres, in the overlay's own pixels. This is the only record
        # of WHERE the renderer put anything: without it, a renderer that ignored the mapping
        # entirely and laid the circles on an arbitrary lattice would be indistinguishable
        # from a correct one at every observable, which is how a visual check goes vacuous.
        # `test_registration_qc.py`'s TEST-8 asserts these MOVE when the placement is
        # mutated.
        "first_marks": placed[:8],
        # WHAT THE DISPLAY STRETCH DID, so a reader of the report can tell a dim picture from
        # a dim plane. `None` means the plain min/max map was used.
        "display_levels": ([round(levels[0], 3), round(levels[1], 3)]
                           if levels is not None else None),
        "median_mark_radius_px": (
            float(np.median(np.clip(radii[np.isfinite(radii)], 1.0, None)))
            if np.isfinite(radii).any() else None),
    }


def data_uri(png_bytes):
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")


# ── reading the artifact back, as stored ─────────────────────────────────────────────


def read_emitted_plane(path, declared_extent):
    """`(array, (level_scale_x, level_scale_y), info)` for an emitted `spatial/image`.

    Read back from DISK, not from the in-memory array the importer happened to have — so the
    check exercises the bytes a consumer would actually get, which is what makes it a check on
    the shipped path rather than on a variable.

    `level_scale` maps DECLARED-extent pixels to the returned array's pixels and is derived
    from the array's OWN shape against the declared extent, per axis, rather than from the
    level index: a pyramid level's height and width are rounded INDEPENDENTLY, so applying the
    x ratio to y would silently misplace every cell along y in proportion to the mismatch.
    """
    import tifffile

    placement = None
    with tifffile.TiffFile(str(path)) as handle:
        if not handle.series:
            raise RegistrationQCError("the emitted image carries no series")
        # THE DECLARATION AS PERSISTED. Read from the OME-XML this artifact carries, which is
        # what a sandboxed consumer gets (#211: `meta` reaches no sandboxed consumer; an
        # OME-TIFF escapes that because it carries its own metadata). Without this the PIXELS
        # would be read back from disk while the AFFINE came from the in-memory entry dict,
        # so a writer that serialised a different affine than the entry held would be outside
        # this check's reach — and §7.3's whole rule is about the declaration ON DISK.
        try:
            placement = SD.require_placement(
                handle.ome_metadata, consumer="the Xenium registration QC"
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
    return arr, (float(arr.shape[1]) / declared_w, float(arr.shape[0]) / declared_h), {
        "persisted_to_space": list(placement["to_space"]) if placement else None,
        "pyramid_level": chosen_index,
        "level_extent": {"width": int(arr.shape[1]), "height": int(arr.shape[0])},
        "level_scale": float(arr.shape[1]) / declared_w,
        "level_scale_y": float(arr.shape[0]) / declared_h,
    }


# ── the whole check, per image ───────────────────────────────────────────────────────


def _place(to_space, coords, level_scale):
    """Cell micrometre positions -> the read-back level's own pixel grid."""
    inverse = invert_affine(to_space)
    pts = np.asarray(coords, dtype=np.float64)
    ux, uy = inverse(pts[:, 0], pts[:, 1])
    return ux * level_scale[0], uy * level_scale[1]


def _pixel_size_text(value):
    """A stated pixel size as a reader would write it — one number when the axes agree.

    A candidate's size is per AXIS (an image can state X and Y differently), so the raw value
    is a dict. Rendering `{'x': 0.31875, 'y': 0.31875}` into a caption a human reads turns the
    one number that matters into a data structure; rendering only `x` would hide the case the
    per-axis shape exists for. So: one number when they agree, both when they do not.
    """
    if isinstance(value, dict):
        x, y = value.get("x"), value.get("y")
        if x is not None and y is not None and float(x) == float(y):
            return f"{x:g}"
        parts = [f"{axis}={v:g}" for axis, v in (("x", x), ("y", y)) if v is not None]
        return ", ".join(parts) if parts else "not stated"
    if value is None:
        return "not stated"
    return f"{float(value):g}"


def _caption_for(block, candidates):
    """The lines burned into the overlay: what placed this image, and what the alternative scored.

    Written from the SCORED block rather than from `stated_scales` directly, so the caption
    cannot say one thing while the verdict says another.
    """
    placed = block.get("placed_by") or {}
    lines = [
        f"{block.get('source') or block.get('image_id')} - registration QC "
        f"({block.get('verdict', VERDICT_NOT_EVALUATED).upper()}): signal lift "
        + (f"{block['signal_lift']:.3f}" if block.get("signal_lift") is not None else "n/a")
        + f" vs a {SIGNAL_LIFT_FLOOR:g} floor, over {block.get('n_cells', 0)} cells.",
        "PLACED BY: " + str(placed.get("source")) + " = "
        + _pixel_size_text(placed.get("pixel_size_um")) + " um/pixel"
        + f" (the bundle's two statements of it: {placed.get('agreement')}).",
    ]
    # THE SUBSAMPLE, IN THE PICTURE (§8.3). A reader looking at 20,000 of 300,000 cells has
    # to be told so BY THE PICTURE; a count in a JSON block travels separately from it, and
    # DEC-5's whole argument is that what is separable gets separated.
    subsample = None
    considered = int(block.get("n_cells") or 0)
    stride = mark_stride(considered)
    if stride > 1:
        subsample = (
            f"SHOWING EVERY {stride}TH OF {considered} CELLS in the vendor's own row order — "
            "at this density every cell would cover the morphology underneath. The score "
            "above uses ALL of them."
        )
    others = [c for c in candidates if not c.get("applied")]
    if others:
        lines.append(
            "THE OTHER STATEMENT: " + "; ".join(
                f"{c['source']} = {_pixel_size_text(c.get('pixel_size_um'))} um/pixel would "
                "score "
                + (f"{c['signal_lift']:.3f}" if c.get("signal_lift") is not None else "n/a")
                for c in others
            )
            + ". This overlay is what decides which of the two is right (design section 7.5)."
        )
    elif placed.get("agreement") == "identical":
        lines.append(
            "The bundle states this pixel size TWICE and the two are the same number, so "
            "there is no competing placement to compare against."
        )
    else:
        # THE OTHER TWO OUTCOMES, SAID AS THEMSELVES. `stated_scale_agreement` has FOUR
        # outcomes and only ONE of them means "the two agree"; this branch used to say "the
        # bundle's two statements do not disagree" for all three of the non-`differs` cases,
        # which reports a check that NEVER RAN (`single-source`: the image stated nothing;
        # `unreadable-unit`: it stated something in a unit this importer cannot convert) as a
        # check that was satisfied. That is exactly the fold `stated_scale_agreement`'s own
        # docstring forbids — "a check that silently stopped running must never look like one
        # that was never available" — and it was burned into the picture, which is the one
        # place a reader cannot go back and qualify it. Found by a blind design-conformance
        # angle on a bundle whose OME-XML carries no PhysicalSize.
        lines.append(
            "The two-statement cross-check did NOT run on this bundle ("
            + str(placed.get("agreement"))
            + "), so there is no competing placement to compare against and this overlay "
              "decides nothing about which statement is right."
        )
    if subsample:
        lines.append(subsample)
    return lines


def check_registration(entry, outputs_dir, coords, *, cell_area_um2):
    """The whole check for ONE emitted `spatial/image`. Returns `(block, png_bytes_or_None)`."""
    meta = entry["meta"]
    to_space = meta["to_space"]
    stated_scales = meta.get("stated_scales") or {}
    derivative = meta.get("display_derivative") or {}
    block = {
        "image_id": entry["id"],
        "source": meta.get("source"),
        "role": meta.get("role"),
        # THE DECLARATION, echoed into the report. The check reads it from the artifact's own
        # meta; recording it here is what lets a reader confirm which affine was actually
        # exercised rather than taking the claim on trust.
        "to_space": list(to_space),
        "extent": dict(meta["extent"]),
        # `coordinate_space`, NOT `space`. The first cut read `meta.get("space")`, which no
        # emitted image `meta` carries — `SD.image_meta` merges `coordinate_space(...)` flat
        # and that helper spells the key `coordinate_space` (as do `_PLACEMENT_KEYS` and the
        # OME `Description` payload). The field was therefore `null` on every run: the one
        # place a reader could confirm WHICH frame the cells and the image were reconciled in
        # reported nothing, on an artifact whose own OME-XML carries the id. Found by a blind
        # correctness angle; a `.get` that silently yields None is exactly the shape no test
        # notices, so TEST-6 now asserts it against `SD.require_placement`'s answer.
        "coordinate_space": meta.get("coordinate_space"),
        "plane_selection": meta.get("plane_selection"),
        "signal_lift_floor": SIGNAL_LIFT_FLOOR,
        "min_cells_inside_fraction": MIN_CELLS_INSIDE_FRACTION,
    }
    arr, level_scale, level_info = read_emitted_plane(
        Path(outputs_dir) / entry["path"], meta["extent"]
    )
    block.update(level_info)

    # THE TWO COPIES OF THE DECLARATION, CROSS-CHECKED. They cannot differ today for a
    # structural reason — `emit_image` builds ONE `meta` and `write_ome_tiff` derives both the
    # manifest copy and the OME-XML copy from it — so this does not OVERRIDE the entry's copy,
    # which would make the artifact unmutatable and quietly disarm every test that moves a
    # declared affine. It asserts they AGREE, and treats a divergence as a registration defect
    # in its own right: if they ever do differ then the artifact a consumer reads is not the
    # artifact the producer believes it wrote, and no score computed from either describes it.
    persisted = block.get("persisted_to_space")
    declaration_mismatch = (
        persisted is not None
        and [float(v) for v in persisted] != [float(v) for v in to_space]
    )

    mask, mask_info = signal_mask(arr)
    block["signal_mask"] = mask_info

    image_xy = _place(to_space, coords, level_scale)
    scored = score_registration(mask, image_xy)
    on_signal = scored.pop("_hit")
    block.update(scored)

    # WHICH STATEMENT PLACED IT, and what the other one would have done (#301, DEC-5/DEC-6).
    candidates = stated_scale_candidates(
        stated_scales, to_space, derivative.get("downsample_factor"))
    for candidate in candidates:
        if candidate.get("applied"):
            # THE APPLIED CANDIDATE IS NOT RE-SCORED — it IS the block. Copying the block's
            # own numbers rather than recomputing them is what stops the two from ever
            # disagreeing, which is the failure a reader of a side-by-side comparison could
            # not possibly detect. Its verdict is filled in AFTER the block's own is decided,
            # below, for the same reason.
            candidate.update({"signal_lift": block.get("signal_lift"),
                              "cells_inside_fraction": block.get("cells_inside_fraction"),
                              "hit_rate": block.get("hit_rate"),
                              "cells_on_signal": block.get("cells_on_signal"),
                              "agreement": stated_scales.get("agreement")})
            continue
        # THE COUNTERFACTUAL, SCORED OVER THE SAME PIXELS. Guarded on its own: a candidate the
        # bundle's own statements imply can still be degenerate (a singular affine from a
        # zero-valued OME statement), and losing the comparison must not cost the verdict that
        # is already in `block`.
        try:
            alt_xy = _place(candidate["to_space"], coords, level_scale)
            alt = score_registration(mask, alt_xy)
            alt.pop("_hit")
            candidate.update({k: alt[k] for k in
                              ("signal_lift", "cells_inside_fraction", "hit_rate",
                               "cells_on_signal")})
            candidate.update(registration_verdict(dict(alt, to_space=candidate["to_space"],
                                                       signal_mask=mask_info)))
        except Exception as exc:
            candidate["not_scored"] = (
                f"this placement could not be scored — {type(exc).__name__}: {exc}"
            )
    block["placed_by"] = {
        "source": stated_scales.get("applied_source"),
        "pixel_size_um": stated_scales.get("applied_pixel_size_um"),
        "agreement": stated_scales.get("agreement"),
        "competing_statement": next(
            (c["source"] for c in candidates if not c.get("applied")), None),
        "note": (
            "a Xenium bundle states its pixel size TWICE — `experiment.xenium`'s `pixel_size` "
            "and the morphology image's own OME-XML `PhysicalSizeX/Y`. This names the one "
            "that placed the image. When the two disagree, the placement the OTHER statement "
            "implies is scored beside it in `stated_scale_placements` and both are named in "
            "the rendered overlay's caption, because deciding which statement is right is "
            "what design §7.5 assigns to this overlay."
        ),
    }
    block["stated_scale_placements"] = candidates

    # THE MARK RADIUS: the vendor's own per-cell area, through the DECLARED affine, into the
    # read-back level's pixels (DEC-10). `to_space[0]` IS the emitted pixel's micron pitch,
    # because the space is micrometres — there is no second scale to keep in step.
    micron_pitch = abs(float(to_space[0])) or abs(float(to_space[1]))
    areas = np.asarray(cell_area_um2, dtype=np.float64) if cell_area_um2 is not None \
        else np.full(len(np.asarray(coords)), np.nan)
    with np.errstate(invalid="ignore"):
        diameters_um = 2.0 * np.sqrt(np.clip(areas, 0.0, None) / math.pi)
    diameters_px = (diameters_um / micron_pitch * level_scale[0]) if micron_pitch else \
        np.full(len(areas), np.nan)
    finite_d = diameters_px[np.isfinite(diameters_px)]
    block["cell_diameter_image_px"] = {
        "median": float(np.median(finite_d)) if len(finite_d) else None,
        "source": "cells.csv.gz:cell_area, as an equivalent-circle diameter",
    }

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
    for candidate in candidates:
        # The applied candidate's verdict IS the block's, copied once the block has one. A
        # side-by-side comparison whose two rows were judged by two different call sites is a
        # comparison a reader cannot trust.
        if candidate.get("applied"):
            candidate["verdict"] = block.get("verdict")
            candidate["reason"] = block.get("reason")

    png = None
    # THE RENDER IS GUARDED SEPARATELY, and that is the point of the arrangement. The verdict
    # is already in `block` by the time we get here. Letting a PNG failure propagate to the
    # caller's per-image handler would REPLACE the whole block with a fresh `not-evaluated` —
    # silently downgrading a correctly computed FAIL because the drawing code choked, and then
    # aggregating it as pass-or-not-evaluated so the FAIL never reaches the top-level verdict.
    # Losing the picture must cost the picture and nothing else.
    try:
        rendered, overlay_info = render_overlay(
            arr, image_xy, on_signal,
            cell_diameter_image_px=diameters_px,
            caption_lines=_caption_for(block, candidates),
            # THE SAME MASK THE SCORE USED, for the display stretch only. A sparse
            # fluorescence plane under a global min/max map renders as an empty field, and a
            # picture a human cannot read is not the control §7.5 asks for.
            mask=mask,
        )
        if len(rendered) > OVERLAY_MAX_BYTES:
            block["overlay_omitted"] = (
                f"the rendered overlay came to {len(rendered)} bytes, over the "
                f"{OVERLAY_MAX_BYTES}-byte cap. It is omitted rather than emitted, because a "
                "report a browser cannot open is not a report. The verdict and every number "
                "behind it are unaffected."
            )
            block["overlay"] = overlay_info
        elif not overlay_info["marks_drawn"]:
            # A PICTURE WITH NOTHING ON IT. Every cell mapped outside the frame, so what was
            # rendered is the bare morphology plane — indistinguishable from an overlay that
            # was never drawn. The verdict above already says the registration failed; this
            # stops the picture from quietly implying otherwise.
            block["overlay"] = overlay_info
            block["overlay_omitted"] = (
                f"every one of the {overlay_info['marks_outside_frame']} cells this overlay "
                "tried to draw maps outside the image's frame, so the picture would carry no "
                "marks at all — a bare thumbnail that looks exactly like a registration "
                "nobody checked. It is NOT emitted, and this run therefore has no overlay "
                "artifact. The verdict above says what happened, and every number behind it "
                "is in this block."
            )
        else:
            block["overlay"] = overlay_info
            png = rendered
    except Exception as exc:
        block["overlay_omitted"] = (
            f"the overlay could not be rendered — {type(exc).__name__}: {exc}. The verdict "
            "above was computed before the render and still stands."
        )
    return block, png


def _qc_header(coords, scope):
    """The QC block's descriptive header — WHAT was checked, before any verdict.

    Its own function so it can sit inside `registration_qc`'s guard. The sibling module
    records this exact block being inline and OUTSIDE the guard once, which made its
    "never raises" promise a claim the code did not enforce: a 0-d `coords` raises `TypeError`
    from `len` and escaped into `run_import`, aborting the whole import.
    """
    return {
        "scope": scope,
        "n_cells_checked": int(len(np.asarray(coords))),
        "referent_note": (
            "This is the only check in this importer with a referent OUTSIDE the artifact. "
            "Every other guard reconciles the artifact with itself — `stated_scales` compares "
            "the vendor's two statements to each other, `coverage_note` compares the image "
            "extent to the cell extent — and a uniform misscale satisfies all of them. The "
            "referent here is the morphology image's OWN PIXELS: the vendor segmented these "
            "cells from that image, so under a correct placement the cell centres land on its "
            "signal far better than chance, and under a wrong affine they decorrelate toward "
            "chance. Neither the pixels nor the cell table is a function of the declared "
            "affine."
        ),
        "does_not_check": (
            "a misregistration that moves the image and the cells TOGETHER (that is not a "
            "misregistration, it is a different frame); and a scale error below about 2%, "
            "which this statistic does not resolve — every score is therefore reported as a "
            "NUMBER beside its verdict so the margin is visible."
        ),
    }


def registration_qc(*, coords, cell_area_um2, image_entries, outputs_dir, scope=None):
    """The whole QC. Returns `(report_block, {image_id: png_bytes})`.

    Never raises (DEC-7). Any failure becomes a `not-evaluated` verdict naming the exception
    type, because losing a diagnostic must never cost the user the matrix, the coordinates,
    the columns and the report.
    """
    overlays = {}
    block = {"kind": "xenium-registration-qc"}
    try:
        block.update(_qc_header(coords, scope))
    except Exception as exc:
        block["header_error"] = f"{type(exc).__name__}: {exc}"

    images = []
    for entry in image_entries:
        try:
            image_block, png = check_registration(
                entry, outputs_dir, coords, cell_area_um2=cell_area_um2)
            if png is not None:
                overlays[entry["id"]] = png
        except Exception as exc:
            # ONE guard around the WHOLE per-image body, for the same reason `emit_image` has
            # one: the raises are spread across a read-back, a matrix inverse, a threshold and
            # a render, and a per-call `except` will always miss the next one.
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
        block["verdict"] = VERDICT_NOT_EVALUATED
        block["reason"] = (
            "no `spatial/image` was emitted from this bundle, so there is nothing to place "
            "the cells on. `images_not_emitted` in this report says why. An unchecked "
            "registration is not a correct one."
        )
        return block, overlays

    verdicts = [image.get("verdict", VERDICT_NOT_EVALUATED) for image in images]
    # FAIL if any failed; PASS only if EVERY image passed; otherwise not-evaluated. "PASS if
    # ANY passed" would let "could not be checked" absorb into "checked and fine" at the
    # aggregate, which is the exact distinction the third value exists to keep — and the
    # one-word aggregate is what a machine reads.
    block["verdict"] = (
        VERDICT_FAIL if VERDICT_FAIL in verdicts
        else (VERDICT_PASS if verdicts and all(v == VERDICT_PASS for v in verdicts)
              else VERDICT_NOT_EVALUATED)
    )
    return block, overlays


def verdict_lines(qc, limit=400):
    """The QC verdict as short lines, for the artifact `meta`.

    ## Why this exists, and it is not a nicety

    The rendered overlay is emitted as its own `report/qc` artifact AND embedded in
    `xenium-import-summary.html` — and **this application does not render `report/html`**.
    `import_visium.qc_verdict_lines` traces that end to end (`artifactRegistry.defaultForKind`
    maps anything that is not `stat`/`provenance` to `generic`; `GenericResult` displays the
    catalog ROW and never fetches a byte of the blob; `data_api.rs` serves every artifact body
    as `application/octet-stream`; there is no iframe path). What the app DOES show, with zero
    clicks the moment a run finishes, is one card per produced datatype whose body prints
    `artifact.meta` verbatim.

    So `meta` is the channel by which this check reaches a human in the shipped app today, and
    the verdict goes there. The overlay stays where §7.5 puts it — a `report/qc` output the
    user can open — and becomes visible in-app when something renders it.
    """
    lines = []
    for image in qc.get("images", []):
        who = image.get("source") or image.get("image_id")
        lines.append(
            f"registration {who}: {image.get('verdict', '?')} — "
            f"{str(image.get('reason', ''))[:limit]}"
        )
    if not qc.get("images"):
        lines.append(
            f"registration: {qc.get('verdict', '?')} — {str(qc.get('reason', ''))[:limit]}"
        )
    return lines
