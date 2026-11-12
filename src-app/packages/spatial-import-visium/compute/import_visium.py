#!/usr/bin/env python3
# ruff: noqa
"""spatial.import-visium — a 10x Visium Space Ranger `outs/` bundle → workbench artifacts.

Reads `/inputs/<slot>` (the auto-grouped `spatial/visium-bundle` dataset), writes
`/outputs/<file>` plus `/outputs/manifest.json` = `{"outputs":[{id,datatype,path,layout,
role,structure,meta}]}`. Progress lines `phase|pct|message` go to `$TXR_PROGRESS_FIFO`.
`/inputs` and `/outputs` are overridable via `TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR` — the
ONLY seam that lets a test drive the REAL script off-sandbox, which is what
`tests/test_producer_end_to_end.py` does.

## What this emits, and the one thing that is easy to get wrong

`filtered_feature_bc_matrix.h5` → an ORDINARY `single-cell/counts` `sparse_csc` store over
`cells x genes`. Nothing downstream needs to know it is spatial (INV-7). `tissue_positions`
→ a `spatial/coordinates` artifact in FULL-RESOLUTION PIXELS (INV-1), ordered `(x, y)`.

**The axis-order transpose is the single most likely bug in the whole importer** (design
§7.3 rule 5). `tissue_positions.csv` writes `pxl_row_in_fullres` (y) BEFORE
`pxl_col_in_fullres` (x); the stored convention is `(x, y)`. Getting it wrong does not
error — it draws the tissue rotated and every downstream neighbourhood is measured in the
wrong place. The committed fixture is deliberately NON-SQUARE so a transposed read cannot
pass a test silently.

## Following `squidpy.read.visium()` without importing it (DEC-2)

The reader below mirrors `squidpy.read.visium()`'s semantics exactly — the same member
basenames, the same headerless-`tissue_positions_list.csv` (Space Ranger <= 1.x) vs
headered-`tissue_positions.csv` (>= 2.0) split, the same six columns in the same order —
and deliberately does not import it. `squidpy` is in the rootfs but NOT on the
`just check-py` host, so importing it would put this reader behind the one gate that has
to run it; and `read_visium` returns an `AnnData` we would immediately decompose, forcing
a full in-memory materialisation that `txr_csc`'s streaming transpose exists to avoid.

## The #183 Option A siblings

Filtering cells on a spatial dataset mints a virtual dataset whose gather is strictly 1-D:
it discards the source `structure` and re-mints one with `columns:[{path:"values",
shape:[n]}]`, so the 2-D coordinates member loses its second dimension and points at a
member that does not exist. Owner ruling: this importer ALSO emits `spatial_x`/`spatial_y`
as ordinary 1-D `metadata-column`s, which gather correctly, and DECLARES them on the
coordinates artifact as `meta.component_columns` — `meta` is copied verbatim by the gather
(`virtual_dataset.rs:1714`) while `structure` is not, so it is the only channel the
declaration can survive a filter in. The client reads that declaration to both OFFER and
DRAW the tissue map on a filter VD.
"""
import base64
import csv
import hashlib
import io
import json
import math
import os
import sys
from pathlib import Path

# Single-thread the numeric stack BEFORE numpy imports: the sandbox caps PIDs, and the
# BLAS/OpenMP pools otherwise exhaust it (`pthread_create: Resource temporarily
# unavailable` -> SIGABRT). Also makes the compute deterministic.
for _v in (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
):
    os.environ.setdefault(_v, "1")

import numpy as np

# `_lib` is staged into `/code` alongside every Python entry.
import txr_columns
import txr_csc
import txr_deps

# The VENDORED write-time contract (#152). Staged beside this entry by `run.helpers`.
# Byte-identical to `spatial-types/compute/spatial_declarations.py`; never edited here.
import spatial_declarations as SD

# The OME-TIFF writer (#155). This package's OWN helper, staged by `run.helpers`.
import ome_writer

# The registration QC (#156). This package's OWN helper too, and the ONLY check in this
# importer with a referent OUTSIDE the artifact — every other guard here reconciles the
# artifact with itself, which is exactly what a uniform misscale satisfies.
import registration_qc

# ── datatype vocabulary ──────────────────────────────────────────────────────────────
# The `(datatype id, storage-layout string)` pairs this package emits. Declared HERE
# because the package knows its own output types; `_lib` is framework code and may not
# name a contributed domain's vocabulary.
DT_COUNTS = ("single-cell/counts", "chunked-sparse")
DT_COORDINATES = ("spatial/coordinates", "chunked-dense")
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_QC = ("report/qc", "opaque")
DT_REPORT_HTML = ("report/html", "opaque")
DT_RUN_ENVIRONMENT = ("report/qc", "opaque")
#: `opaque_as_is` per `spatial/image`'s declared storage (#152): the pixel grid has no
#: axis, no row order and no key sequence, so there is no member structure to declare.
DT_SPATIAL_IMAGE = ("spatial/image", "opaque")

#: The media type the image artifact declares. A real RFC 6838 `type/subtype` with a
#: parameter, which `conformance._MEDIA_TYPE_RE` accepts (§6.3).
IMAGE_MEDIA_TYPE = "image/tiff; application=ome"

# ── the vendor's own constants ───────────────────────────────────────────────────────
# TWO CIRCLES, TWO CONSTANTS (#222). There is a 55 um circle and a 65 um circle on a Visium
# slide's data, and for one release this file spelled both of them `VISIUM_SPOT_DIAMETER_UM`.
# That single name divided `spot_diameter_fullres` — the LARGER, rendered circle — by the
# SMALLER, physical one, and every micron-denominated Visium result was 15.4% low (1 - 55/65),
# uniformly and silently. (15.6% is the closely-related but DIFFERENT number the issue
# headlines: the old scale's error against the slide's 100 um pitch ON THE COMMITTED BUNDLE,
# 15.573%, which differs because that bundle implies a 65.145 um circle rather than exactly 65.
# The constant change is worth 1 - 55/65 = 15.385% on every bundle; the referent error is
# bundle-specific. They are kept apart throughout this package.) They are separated here, and each says which circle it measures, because the
# defect was never a wrong number: it was one name for two quantities.
#
# Neither is a knob, and neither is an admin setting (DEC-11 / DEC-4): they are properties of
# manufactured glass and of Space Ranger's output. Making either configurable would let an
# operator silently rescale every downstream micron measurement, which is the precise failure
# `registration_qc`'s external referent exists to prevent. Visium HD's geometry differs and HD
# is REFUSED outright (DEC-5), so neither can be applied to the assay it would be wrong for.
#
# #257 SPLIT THE RENDERED CIRCLE AGAIN, one level down. `VISIUM_RENDERED_SPOT_DIAMETER_UM` is
# not one number for all of Visium: 10x documents that field as varying BY SLIDE DESIGN. See
# `SLIDE_DESIGNS` below and `docs/design/visium-slide-design-scale.md`. The CAPTURE spot and
# the slide's 100 um pitch do NOT move with it — the vendor's glossary states 55 um / 100 um
# for "Visium v1 and v2 capture areas" alike, and CytAssist slides ARE v2 — so this constant
# and `registration_qc.SLIDE_SPOT_PITCH_UM` are untouched by that split.

#: The PHYSICAL CAPTURE SPOT diameter, in micrometres — the area transcripts actually came
#: from, and therefore the resolution of one row of the matrix. 10x's own specification, and
#: this repo's corpus at `docs/research/data-processing/02-platforms.md:357`: "~5,000 spots
#: (55 um diameter, 100 um center-to-center)".
#:
#: This is what `measured_entity(kind="spot", resolution_um=...)` MUST report, and what the
#: registration overlay draws a spot AS. It is NOT the scale numerator — dividing it by
#: `spot_diameter_fullres` is the #222 defect, because those two numbers do not measure the
#: same circle.
VISIUM_CAPTURE_SPOT_DIAMETER_UM = 55.0

#: The RENDERED SPOT diameter, in micrometres — the physical size of the circle Space Ranger
#: writes into `scalefactors_json.json`'s `spot_diameter_fullres`. LARGER than the capture
#: spot, because that field exists for drawing spots over the H&E rather than for describing
#: the capture area. Seurat's maintainer states this outright
#: (satijalab/seurat#6980): "you can get the scaling factor from the `spot_diameter_fullres`
#: key ... If that value is 80, then you can multiply all of your barcode positions by 65/80
#: to convert to microns", and, of the same fields, "the values you're looking at are largely
#: for plotting purposes (aligning the spots on top of the H&E stain)". CellChat ships the
#: same conversion (jinworks/CellChat#92: `spot.size = 65`,
#: `conversion.factor = spot.size / scalefactors$spot_diameter_fullres`), validated by the
#: same nearest-neighbour-spacing-approx-100-um check `registration_qc` uses.
#:
#: This is the correct numerator for `microns_per_pixel` ON THE SLIDE DESIGN IT DESCRIBES,
#: because it is the one that measures the same circle `spot_diameter_fullres` does there. It
#: is cited, not fitted: the committed vendor bundle's own two files imply 65.145 um for that
#: circle (0.22% off 65), which is corroboration of a number taken from the two sources above,
#: not its derivation. Four further vendor bundles imply 65.011-65.038 um (design doc §3).
#:
#: #257: it is ALSO the `assumed-standard` fallback — what a bundle gets when its slide design
#: cannot be identified — because that is what every bundle got before #257 and a fallback may
#: only be a strict improvement on the behaviour it replaces (DEC-3).
VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0

# ── the slide designs (#257) ─────────────────────────────────────────────────────────
# ONE FIELD, SEVERAL CIRCLES. 10x documents `spot_diameter_fullres` as varying with the SLIDE
# DESIGN, in as many words (Space Ranger > Analysis > Outputs > Spatial Outputs):
#
#   "spot_diameter_fullres: The number of pixels that span the diameter of a spot in the
#    original, full-resolution image. THIS FIELD IS INTENDED FOR VISUALIZATION PURPOSES, AND
#    CAN VARY FOR DIFFERENT SLIDE DESIGNS, RANGING FROM 60-70 um."
#
# So the numerator is a property of the SLIDE, not of the assay — and the assay is measured to
# be the WRONG key for it: eight spatialLIBD DLPFC sections are direct-placement Visium
# (`chemistry_description: "custom"`, no `regist_target_img_scalef`, no CytAssist image, from
# before the instrument existed) and render their spots at 70 um, the same circle as CytAssist
# 6.5 mm; while CytAssist 11 mm renders at 60 um, not 70. "If CytAssist then 70 else 65" is
# wrong in both directions before it ships. `docs/design/visium-slide-design-scale.md` §3-§4
# carries the whole 24-bundle table and the reasoning; the summary is below.
#
# WHAT IDENTIFIES A DESIGN: `fiducial_diameter_fullres / spot_diameter_fullres`. Both fields
# are, per the same vendor page, "estimated ... based on the registration solution as well as
# the known size of the spots and fiducial frame" — ONE registration solution over TWO known
# physical sizes, so the pixel scale CANCELS and what is left is the ratio of the two physical
# circles. Measured over 24 real bundles it is not merely near a rational, it IS one: exactly
# 3/2 and 7/4 in IEEE-754 double, and 21/13 to 5.2e-8. Nothing this repo chose appears in it.
#
# WHY THE THREE DIAMETERS ARE ROUND, AND WHY THAT IS NOT A FIT. The measured means are
# 65.047, 69.911 and 60.017, and no vendor sentence states 70.0 or 60.0 as such — so on the
# measurements alone, "round" would be doing the work, which is the objection a blind audit
# raised against an earlier draft of this comment. It is not, because of a fourth constraint
# the measurements do not supply: `fiducial_over_spot * rendered_spot_diameter_um` is 105.0 for
# ALL THREE rows (21/13 x 65, 3/2 x 70, 7/4 x 60). Those three ratios are EXACT and
# INDEPENDENT — three slide designs, three rationals, 24 bundles, five Space Ranger versions —
# and there is exactly ONE assignment of diameters consistent with a single rendered fiducial
# circle across them. (65, 70, 60) is that solution, and the measured means sit 0.07%, 0.13%
# and 0.03% from it. 69.911 would require the fiducial circle to be physically different on
# the CytAssist 6.5 mm slide than on the other two, which nothing supports.
#
# WHY A TABLE OF MEASURED CONSTANTS AND NOT `105 / ratio` (DEC-2): 105 um is NOT vendor-stated
# — it is an inference from the same measurements — so using it in the code path would swap
# three constants each cited to its own bundles for one cited to arithmetic, and would move
# standard Visium's numerator off the 65.0 #222 pinned by 5e-8 for no gain. It is load-bearing
# ABOVE, as the consistency argument that makes the rounding forced rather than chosen, and
# nowhere as a value. `test_the_three_designs_are_consistent_with_one_rendered_fiducial_circle`
# is that argument in executable form.
#
# Not a knob and not an admin setting, for the reason stated above this block: a scale an
# operator can retune is a scale nothing checks.

#: The slide designs observed across the corpus in `docs/design/visium-slide-design-scale.md`
#: §3 — 14 bundles downloaded from `cf.10xgenomics.com`, 8 spatialLIBD DLPFC sections, this
#: package's own committed fixture, and one further vendor archive.
#:
#: A TABLE, not a branch, for the reason `VENDOR_IMAGES` is one: a design 10x ships next is a
#: row here, and a row carries its own evidence. `implied_um` is what the bundles MEASURED —
#: `spot_diameter_fullres * 100 um / measured_pitch_px`, the same arithmetic #222 used to fix
#: 65.0 — and it is recorded beside the constant so a reader can see the constant is the
#: measurement rounded, never the measurement chosen to make something else come out.
SLIDE_DESIGNS = (
    {
        "id": "visium-6.5mm-65um-rendered-spot",
        # THE FALLBACK DESIGN, declared rather than inferred. `slide_design`'s
        # `assumed-standard` leg needs a row to name, and it used to take `SLIDE_DESIGNS[0]` —
        # a POSITION, in a table that explicitly invites new rows. Inserting one at the front
        # would have produced a record naming that design and carrying this one's diameter,
        # with every test green because they all assert the value. Binding it to the diameter
        # instead was the first repair and was worse: a mutation battery that sets another
        # row's diameter to 65 then has TWO standard rows and the importer refuses. A flag is
        # the honest form — being the fallback is a decision about this row, not a fact
        # derivable from its number.
        "is_standard_fallback": True,
        "fiducial_over_spot": 21 / 13,
        # THE NAMED CONSTANT, not a second literal 65.0. This row and
        # [`VISIUM_RENDERED_SPOT_DIAMETER_UM`] are the same number by construction: it is the
        # standard design's diameter AND the `assumed-standard` fallback, and two spellings of
        # one quantity is the shape #222 was — one name for two circles, read here as two
        # names for one circle, which fails the same way in the other direction. It is also
        # what keeps `scripts/check-viz-producer-magnitudes.mjs` binding: that gate derives
        # the numerator by RUNNING this producer, and a duplicated literal would let the
        # constant move while the applied value did not.
        "rendered_spot_diameter_um": VISIUM_RENDERED_SPOT_DIAMETER_UM,
        "capture_area": "6.5 mm",
        "vendor_spot_count": 4992,
        # 5 bundles: Visium_Mouse_Olfactory_Bulb (this package's fixture),
        # V1_Breast_Cancer_Block_A_Section_1, Parent_Visium_Human_BreastCancer,
        # Visium_FFPE_Human_Breast_Cancer, Visium_FFPE_Mouse_Brain. Space Ranger 1.1.0-2.0.0.
        "implied_um_measured": "65.011-65.145 over 5 bundles",
        "seen_on": "Visium v1/v2 6.5 mm, direct placement and CytAssist-era Space Ranger >= 1.1",
        "source": (
            "10x's own worked example on the Space Ranger spatial-outputs page — "
            "\"microns/pixels = 65/89.44 ~= 0.73\" — corroborated by satijalab/seurat#6980 "
            "and jinworks/CellChat#92, and measured against the slide's 100 um pitch on 5 "
            "real vendor bundles (#222, #257)"
        ),
    },
    {
        "id": "visium-6.5mm-70um-rendered-spot",
        "fiducial_over_spot": 3 / 2,
        "rendered_spot_diameter_um": 70.0,
        "capture_area": "6.5 mm",
        "vendor_spot_count": 4992,
        # 14 bundles: 6 CytAssist V4 (CytAssist_FFPE_Human_Breast_Cancer,
        # ..._Human_Lung_Squamous_Cell_Carcinoma, ..._Mouse_Brain_Rep1, ..._Mouse_Brain_Rep2,
        # ..._Protein_Expression_Human_Tonsil, CytAssist_Fresh_Frozen_Mouse_Brain) and the 8
        # spatialLIBD DLPFC sections, which are NOT CytAssist and land on the same circle.
        "implied_um_measured": "69.827-70.075 over 14 bundles",
        "seen_on": (
            "Visium CytAssist v2 6.5 mm (chemistry_description 'Visium V4 Slide'), and "
            "direct-placement Visium under pre-1.1 Space Ranger (spatialLIBD DLPFC)"
        ),
        "source": (
            "measured against the slide's 100 um pitch on 14 real vendor bundles, mean "
            "69.911 um (docs/design/visium-slide-design-scale.md §3); the upper endpoint of "
            "the 60-70 um range 10x states this field spans across slide designs; and the "
            "unique value consistent with this design's exact 3/2 fiducial/spot ratio under "
            "the one rendered fiducial circle all three designs share (3/2 x 70 = 105)"
        ),
    },
    {
        "id": "visium-11mm-60um-rendered-spot",
        "fiducial_over_spot": 7 / 4,
        "rendered_spot_diameter_um": 60.0,
        "capture_area": "11 mm",
        "vendor_spot_count": 14336,
        # 5 bundles: CytAssist_11mm_FFPE_Human_Colorectal_Cancer, ..._Human_Glioblastoma,
        # ..._Human_Ovarian_Carcinoma, ..._Mouse_Embryo, and
        # CytAssist_FFPE_Human_Colon_Post_Xenium_Rep1 — which is an 11 mm slide DESPITE its
        # name, which is why the design is never inferred from a sample name.
        "implied_um_measured": "59.925-60.052 over 5 bundles",
        "seen_on": "Visium CytAssist v2 11 mm (chemistry_description 'Visium V5 Slide')",
        "source": (
            "measured against the slide's 100 um pitch on 5 real vendor bundles, mean "
            "60.017 um (docs/design/visium-slide-design-scale.md §3); the lower endpoint of "
            "the 60-70 um range 10x states this field spans across slide designs; and the "
            "unique value consistent with this design's exact 7/4 fiducial/spot ratio under "
            "the one rendered fiducial circle all three designs share (7/4 x 60 = 105)"
        ),
    },
)

#: Relative tolerance on `fiducial_diameter_fullres / spot_diameter_fullres` against a row's
#: `fiducial_over_spot`. Derived from the two ends it has to separate, the way
#: `registration_qc.PITCH_TOLERANCE` was, and NOT from a fixture:
#:
#:   noise floor  — the worst departure from the exact rational anywhere in the 24-bundle
#:                  corpus is 5.2e-8 (relative), on the 21/13 design; the other two designs
#:                  are exact in IEEE-754 double on every bundle. This is ~19,000x above it.
#:   signal floor — the CLOSEST two designs are 3/2 vs 21/13, which differ by 7.1%. This is
#:                  ~71x below that.
#:
#: Nothing depends on where in that gap it sits. It is deliberately loose enough to survive a
#: vendor writing the ratio through a lossy round trip and far too tight to let one design be
#: read as another.
SLIDE_DESIGN_RATIO_TOLERANCE = 1e-3

#: `spatial/visium-bundle`'s declared members, by basename. The `|`-alternation is the
#: vendor's own rename: Space Ranger <= 1.x wrote a HEADERLESS
#: `tissue_positions_list.csv`; >= 2.0 wrote `tissue_positions.csv` WITH a header.
MATRIX_BASENAME = "filtered_feature_bc_matrix.h5"
POSITIONS_BASENAMES = ("tissue_positions.csv", "tissue_positions_list.csv")
SCALEFACTORS_BASENAME = "scalefactors_json.json"

#: The vendor images this importer converts to `spatial/image` (#155), each with the
#: scalefactor key that PLACES it and the role it plays. Declared as a table, not as a
#: branch, because "N images, one coordinate space, every pair placeable" (§7.3 rule 3) is
#: the property the space model exists for — adding a platform's image is a row here.
#:
#: The affine is the INVERSE of the scalefactor (`ome_writer.inverse_scalefactor_affine`),
#: which is what makes two images at two different scalefactors land in ONE frame.
#:
#: `cytassist_image.tiff` is NOT listed here, and #257 settled that it never can be: this
#: table's second column is THE SCALEFACTOR THAT PLACES THE IMAGE, and the bundle carries no
#: scalefactor that places that one. See `NON_PLACEABLE_VENDOR_IMAGES` below for the
#: measurement. An unplaceable image has no row to occupy, which is a different fact from
#: "no fixture carries one" — the reason this comment used to give.
VENDOR_IMAGES = (
    {"basename": "tissue_hires_image.png", "scalef_key": "tissue_hires_scalef",
     "role": "display", "output_id": "spatial-image-hires"},
    {"basename": "tissue_lowres_image.png", "scalef_key": "tissue_lowres_scalef",
     "role": "overview", "output_id": "spatial-image-lowres"},
)

#: Vendor images this importer will NEVER emit, and WHY (#257 / DEC-5). Separate from
#: `VENDOR_IMAGES` because the two tables answer different questions: that one says which
#: scalefactor places an image, this one says that nothing does.
#:
#: `cytassist_image.tiff` is a copy of the CytAssist instrument's own input. 10x states its
#: geometry outright ("It has a resolution of 3,200 x 3,000 pixels (Visium HD) or 3,000 pixels
#: in both dimensions (Visium v2)") and states what the one CytAssist-only scalefactor is for
#: ("regist_target_img_scalef: A scaling factor that converts pixel positions in the original,
#: full-resolution microscope image to the downsampled version used in image registration").
#: Measured on `CytAssist_FFPE_Mouse_Brain_Rep2`, that key (0.21381228) takes the 23740 x 28062
#: full-resolution frame to 5076 x 6000 — exactly `aligned_tissue_image.jpg`'s size, i.e. the
#: registration target, as documented, and NOT the CytAssist image. The CytAssist image is a
#: square 3000 x 3000 frame, and no scalar maps a square onto a 0.846-aspect one.
#:
#: So it is reported, not emitted. Constructing an affine for it would be the exact failure
#: `registration_qc` exists to catch: #155's TEST-9 records that a deliberately wrong affine
#: survives the declaration constructor, the OME writer, the reader AND the placement round
#: trip. Reporting it through `images_not_emitted` is what keeps "we decided not to" distinct
#: from "there was none" (INV-9/DEC-8).
NON_PLACEABLE_VENDOR_IMAGES = (
    {
        "basename": "cytassist_image.tiff",
        "reason": (
            "not emitted — this bundle carries no scalefactor that places it in the "
            "full-resolution coordinate space. It is the CytAssist instrument's own 3000x3000 "
            "input image, in its own frame; `regist_target_img_scalef` places the registration "
            "target (`aligned_tissue_image.jpg`), not this file, and no single scale factor "
            "maps a square frame onto the full-resolution one. Emitting it under a constructed "
            "affine would place the tissue wrongly with every internal check still passing "
            "(#155 TEST-9), so it is reported here instead. See "
            "docs/design/visium-slide-design-scale.md §6 and issue #257."
        ),
    },
)

#: The `scalefactors_json.json` key Space Ranger writes only on a CytAssist run, and the
#: AUTHORITATIVE signal for the assay (#257 / DEC-4). Present in 11 of 11 measured CytAssist
#: bundles, absent from 13 of 13 measured non-CytAssist ones. Chosen over the two corroborating
#: signals because it lives in a file this importer MUST read and already parses, so an upload
#: that flattens or renames the tree cannot lose it.
CYTASSIST_SCALEFACTOR_KEY = "regist_target_img_scalef"

#: CORROBORATING only. It agrees on all 24 measured bundles, but it is an OPTIONAL member
#: matched by basename over a possibly-flattened upload, so its ABSENCE is not evidence.
CYTASSIST_IMAGE_BASENAME = "cytassist_image.tiff"

#: CORROBORATING only. `chemistry_description` from the matrix `.h5` root attributes reads
#: these on CytAssist bundles — but it is a free-text vendor string that reads `custom` on real
#: data (the spatialLIBD DLPFC set), and gating on it would need a new arm for every slide
#: version 10x ships. Recorded and compared; never decisive.
CYTASSIST_CHEMISTRY_DESCRIPTIONS = ("visium v4 slide", "visium v5 slide")

ASSAY_CYTASSIST = "visium-cytassist"
ASSAY_DIRECT_PLACEMENT = "visium-direct-placement"


#: THE PHRASES THAT ASSERT AN IMAGE WAS EMITTED. A note containing one of these is only true
#: PAST THE COMMIT POINT, so every such note is buffered in `pending_warnings` and flushed
#: there rather than appended where it is composed (#298 / the round-2 audit). Named as a
#: constant because the test that pins "no emission-asserting note accompanies a FAILED image"
#: is a NEGATIVE assertion over prose, and a negative substring assertion goes vacuously green
#: the moment the prose is reworded — measured: rewording "emitted, but" to "written to disk,
#: but" and moving the note back out of the buffer reintroduced the whole contradiction with
#: the suite still green. The test reads THIS tuple, so the prose and its pin cannot drift.
EMISSION_ASSERTING_PHRASES = ("emitted,", "is emitted", "written to disk")

#: What the per-image handlers call an image whose bundle entry carries no `basename`. A
#: CONSTANT rather than an inline literal because a test asserting "the note says WHICH image"
#: must be able to compare against the exact label — an earlier assertion checked for the
#: substring "basename", which this sentence contains, and so passed on a note that identified
#: nothing (#298 E4).
UNNAMED_IMAGE = "<an image whose bundle entry has no basename>"

#: Read for the report only, never emitted as artifacts (INV-5 / design §7.2: they are
#: "diagnostics, not data"). Capped so a multi-megabyte vendor JPEG cannot inflate the
#: report; over the cap the report SAYS it omitted them rather than shipping a truncated
#: image.
#: `aligned_tissue_image.jpg` (#257) is a CytAssist/HD-only member and belongs exactly here.
#: 10x: "This image is generated when both CytAssist and microscope image inputs are provided
#: (Visium CytAssist v2 and Visium HD). It captures the results of the image registration by
#: merging the registered images in a checkerboard pattern" — i.e. it is a QC rendering of a
#: registration, in the same class as the two above it, not tissue data.
#:
#: It is listed because leaving it out left it SILENT, which is what `images_not_emitted` and
#: this table both exist to prevent: unlike `cytassist_image.tiff`, this one IS placeable
#: (`regist_target_img_scalef` is measured to map the full-resolution frame onto exactly its
#: pixel dimensions), so "no scalefactor places it" would have been a false reason and
#: `NON_PLACEABLE_VENDOR_IMAGES` is the wrong home. A diagnostic is what it is.
DIAGNOSTIC_BASENAMES = ("aligned_fiducials.jpg", "detected_tissue_image.jpg",
                        "aligned_tissue_image.jpg")
DIAGNOSTIC_INLINE_CAP_BYTES = 2 * 1024 * 1024

#: The headerless `tissue_positions_list.csv` column order, which is positional and is the
#: only thing that gives those files meaning. Same order as the headered file's columns.
POSITION_COLUMNS = (
    "barcode", "in_tissue", "array_row", "array_col",
    "pxl_row_in_fullres", "pxl_col_in_fullres",
)

#: The two 1-D component columns (#183 Option A). Their NAMES are the address the client
#: resolves them by, so they are declared once, here, and used for the column name, the
#: output id and the `component_columns` declaration alike.
COMPONENT_X = "spatial_x"
COMPONENT_Y = "spatial_y"


class VisiumImportError(RuntimeError):
    """A refusal. Every one of them names what was missing and what to do about it."""


# ─────────────────────────── shared compute runtime ───────────────────────────
# Inlined rather than imported: the sandbox stages this ONE entry file plus the declared
# `run.helpers`, and this block is deliberately identical across the builtins' computes.


def io_dirs():
    inp = Path(os.environ.get("TXR_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("TXR_OUTPUTS_DIR", "/outputs"))
    out.mkdir(parents=True, exist_ok=True)
    return inp, out


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return {} if default is None else default


def load_inputs_index(inputs_dir):
    """slot -> host path, resolved from inputs.json (`sandbox_path` = /inputs/<sub>)."""
    idx = read_json(inputs_dir / "inputs.json", {"inputs": []})
    slots = {}
    for e in idx.get("inputs", []):
        sp_path = e.get("sandbox_path", "") or ""
        if sp_path.startswith("/inputs/"):
            sub = sp_path[len("/inputs/"):]
        else:
            sub = Path(sp_path).name or e.get("slot", "")
        slots[e["slot"]] = inputs_dir / sub
    return slots


def params(inputs_dir):
    return read_json(inputs_dir / "params.json", {})


_PROGRESS_FD = [-1]


def progress(phase, pct=None, message=None):
    parts = [str(phase)]
    if pct is not None:
        parts.append(str(int(pct)))
    if message is not None:
        if pct is None:
            parts.append("")
        parts.append(str(message))
    line = "|".join(parts)
    fifo = os.environ.get("TXR_PROGRESS_FIFO")
    if fifo:
        if _PROGRESS_FD[0] < 0:
            try:
                _PROGRESS_FD[0] = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            except OSError:
                _PROGRESS_FD[0] = -1
        if _PROGRESS_FD[0] >= 0:
            try:
                os.write(_PROGRESS_FD[0], (line + "\n").encode())
            except OSError:
                try:
                    os.close(_PROGRESS_FD[0])
                except OSError:
                    pass
                _PROGRESS_FD[0] = -1
    print("progress:", line, file=sys.stderr, flush=True)


def write_manifest(outputs_dir, entries):
    # #80 — append this run's ENVIRONMENT RECORD before the manifest is written, and
    # refuse the run if the environment does not satisfy `run.dependencies`. On the one
    # path every successful run takes, so recording is structural rather than remembered.
    txr_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    # Compact, not `indent=2`: only the server reads this, and pretty-printing doubles it
    # against `outputs.rs::MAX_MANIFEST_BYTES` (1 MiB, a hard failure past it).
    # `encoding="utf-8"`, not the LOCALE default (#330). This one and the report below are
    # serialised by `json.dumps` at its default `ensure_ascii=True`, so they are pure ASCII by
    # construction and could not have raised under any locale — they are the cheap half of a rule
    # that should hold for every text write here, not a fix. The load-bearing one is
    # `visium-import-summary.html`; see its own comment.
    (outputs_dir / "manifest.json").write_text(
        json.dumps({"outputs": entries}, separators=(",", ":")), encoding="utf-8"
    )


def output_entry(id, datatype_layout, path, role, *, structure, meta=None, label=None,
                 axis=None):
    """One `/outputs/manifest.json` entry.

    `structure` (HOW to decode the bytes) and `meta` (what they MEAN) are producer
    declarations with NO default on either side of the wire, so both are named at every
    call site. `axis` tags a per-entity output with its datatype AXIS name.
    """
    dt, layout = datatype_layout
    entry = {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
             "structure": structure, "meta": meta}
    if label is not None:
        entry["label"] = label
    if axis is not None:
        entry["axis"] = axis
    return entry


# ──────────────────── vendor text this importer cannot write ────────────────────
#
# PORTED, function for function, from `spatial-import-xenium/compute/import_xenium.py`
# (#329's landed guard) rather than reinvented — see `.lifecycle/hostile-vendor-text-visium/
# DECISIONS.md` DEC-2. The two packages cannot share it: `runner.rs::stage_and_launch` writes a
# FLAT `/code` dir holding ONE package's entry plus its own declared `run.helpers`, so there is
# no import that reaches across, and the one file that IS shared (`spatial_declarations.py`) is
# vendored byte-identically across three packages and pinned by `tests/test_vendored_contract.py`
# — #330 says in as many words that it must not be edited. What changes from the original is the
# error type, the measurements in the docstrings (this package's, not the Xenium ones), and ONE
# deleted justification that a measurement falsified (see `unencodable_vendor_text` below).
#
# The design is `docs/design/vendor-text-encodability-refusal.md` §6.


def unencodable_vendor_text(node, _trail=()):
    r"""The first `(where, text, at)` in a parsed vendor document that CANNOT BE WRITTEN — or `None`.

    THE PARSE-BOUNDARY GUARD (#330). ONE predicate, TWO callers, because this package has TWO
    doors and a fix at one of them is not a fix.

    ## The two doors, MEASURED on the committed `Visium_Mouse_Olfactory_Bulb` fixture

    Against `origin/main` @ `d263fac0`, one mutation at a time.

    **(a) The h5 ROOT attributes.** `run_import` does `attrs = dict(h5.attrs)` and hands the dict
    to [`vendor_provenance`], which reads `software_version`, `chemistry_description` and
    `library_ids`. h5py returns a DIFFERENT Python type per attribute dtype, and only one of them
    is a `str` — on the real fixture:

        'chemistry_description'  -> str      'Visium V1 Slide'
        'software_version'       -> str      'spaceranger-2.0.0'
        'library_ids'            -> ndarray  array([b'Visium_Mouse_Olfactory_Bulb'], dtype='|S27')

    With `b"\xff\xfeSR"` written into each, in each dtype:

        utf-8 string dtype -> h5py decodes with SURROGATEESCAPE -> '\udcff\udcfeSR'
            UNCAUGHT UnicodeEncodeError, exit 1, a traceback, and 59 (library_ids, dying in the
            declaration mirror inside `SD.write_spatial_coordinates`) to 117 (the other two,
            dying at the `visium-import-summary.html` write) paths already under /outputs with
            NO manifest.json. `main()` catches only `VisiumImportError`.
        fixed-length |S dtype -> raw `bytes`
            NO CRASH AT ALL. The import reported SUCCESS and shipped a SANITISED identifier,
            because `vendor_provenance`'s own `text()` helper spells `decode(errors="replace")`.

    So the crash is the LOUDEST outcome, not the largest — and the shape the vendor ACTUALLY
    writes for `library_ids` on the real fixture is the silent one.

    **(b) `scalefactors_json.json`.** [`read_scalefactors`] parses it with the identical
    `json.loads(Path(path).read_text())` #329 guards on the Xenium side, and `json.loads`
    ACCEPTS a `"\ud800"` escape out of a file that is itself PURE ASCII. Measured, adding
    `"vendor_note": "\ud800BAD"` and writing the file back as ASCII:

        file bytes pure ASCII: True     json.loads -> '\ud800BAD'  (unencodable)
        IMPORT COMPLETED, exit 0, 117 paths
        visium-import-report.json line 22:  "vendor_note": "\ud800BAD"

    The whole parsed scale document is echoed into the report under `"scalefactors"`, so this
    door poisons rather than crashes — and the emitted report is then unreadable by `serde_json`,
    the crate the server parses `/outputs/manifest.json` and this report with ("unexpected end of
    hex escape", #329 §1.2). A hostile KEY and a hostile value on the real `spot_diameter_fullres`
    key were measured too: both COMPLETE, 117 paths.

    ## Why the BOUNDARY and not the identity path

    The same string reaches an artifact through `vendor_provenance` as well as through
    [`coordinate_space_id`], so a guard on the identity path leaves the crash exactly where it is
    while making the report look defended. This module has already shipped the "same rule applied
    to one field fewer" defect three times (#319's channel list, #320's `section_sample_id`,
    #323's root attributes), which is what makes a per-consumer guard the wrong shape: WHICH
    fields are read onto an artifact is a property of TODAY's module.

    ## THE TEST IS THE ENCODE, not a codepoint range — and #329's stated reason for that is FALSE

    `value.encode("utf-8")` is the operation the writers actually perform
    (`write_text(..., encoding="utf-8")`, `json.dumps`), so the guard cannot drift from the
    failure it prevents.

    #329's copy of this docstring adds that a `U+D800..U+DFFF` range check "would also REFUSE a
    legitimate astral character". **That is false in CPython and is deliberately NOT carried
    forward** (DEC-7). Measured:

        json.loads('"\\ud83e\\uddec"')  ->  '\U0001f9ec'   len=1   ord=0x1f9ec
        any(0xD800 <= ord(c) <= 0xDFFF for c in it)  ->  False
        it.encode('utf-8')                           ->  b'\xf0\x9f\xa7\xac'

    `json.loads` assembles the surrogate PAIR into one codepoint before any guard sees it, so a
    range scan over the resulting `str` accepts every astral character. A true rule justified by
    a false reason is a rule the next reader deletes after checking the reason. The reasons that
    ARE true: a range scan cannot see the BYTES arm AT ALL — `b"\xff\xfeSR"` has no codepoints to
    scan, and that is the shape the real fixture's `library_ids` arrives in — and it is a second,
    hand-maintained spelling of what the writer does. The astral character stays as a mandatory
    POSITIVE CONTROL in the suite either way.

    ## BYTES ARE CHECKED TOO, and on this boundary they are the COMMON shape

    See the `|S27` above. A `str`-only walk is invisible to the only shape the vendor actually
    writes for the identity attribute, and [`vendor_provenance`] then puts it through
    `decode(errors="replace")`. Measured on this base, `b"\xff\xfeSR"`, `b"\xfe\xffSR"` and
    `b"\x80\x81SR"` ALL imported cleanly and ALL emitted `provenance.library_id = '��SR'`
    and `coordinate_space = 'visium:��SR'` — three vendor byte strings collapsing into
    ONE sample identity and ONE coordinate frame, sanitised, which is the one outcome the design
    refuses to produce. So bytes are decoded STRICTLY here.

    ## Keys and every depth

    Keys are walked as well as values: `json.dumps` writes a key into the same artifact bytes a
    value goes into, so an unencodable key poisons the file identically. Nesting is walked because
    `scalefactors_json.json` is arbitrary vendor JSON and an h5 attribute is as likely to be an
    ARRAY as a scalar.

    Returns `(where, text, at)` or `None`. `where` is a dotted trail into the document, kept RAW
    here and escaped ONCE at the message so there is exactly one place that can forget. `at` is
    the offset of the offending unit **in the units of `text`'s own type** — a CHARACTER index
    for the `str` arm (`UnicodeEncodeError.start`) and a BYTE index for the `bytes` arm
    (`UnicodeDecodeError.start`). That difference is invisible in a positional tuple, so it is
    stated here; both are the right unit for slicing the value they came from.
    """
    if isinstance(node, str):
        try:
            node.encode("utf-8")
        except UnicodeEncodeError as exc:
            # `str(node)`, not `node`: `np.str_` subclasses `str`, and `ascii()` of one renders
            # as `np.str_('...')` under numpy 2 — a refusal quoting a Python repr instead of the
            # vendor's value.
            return (_trail_text(_trail), str(node), exc.start)
        return None
    # `np.bytes_` is NOT listed: it subclasses `bytes` (measured, numpy 2.2.6), and it IS the
    # shape this boundary really produces, so it is covered by the first name in the tuple rather
    # than by an omission. `bytearray` and `memoryview` do NOT subclass `bytes` and are listed for
    # that reason; neither is reachable from today's two callers.
    #
    # WHAT IS NOT WALKED, said out loud rather than left to be discovered: `np.void` (the HDF5
    # OPAQUE dtype, which h5py really does produce for an opaque attribute), `set`/`frozenset`,
    # and every numeric dtype, all fall through and return `None`. That is deliberate — none of
    # them is text and none of them reaches a writer as text — but an earlier revision of this
    # comment claimed the tuple was "cheap completeness on a predicate whose whole job is
    # whatever the vendor really produces", which a blind angle correctly read as a completeness
    # claim the code does not make. The claim is narrowed rather than the code widened.
    if isinstance(node, (bytes, bytearray, memoryview)):
        try:
            bytes(node).decode("utf-8")
        except UnicodeDecodeError as exc:
            return (_trail_text(_trail), bytes(node), exc.start)
        return None
    if isinstance(node, dict):
        for key, value in node.items():
            # The KEY is checked under the trail it would be written at, and reported with
            # `<key ...>` so a reader can tell "the name is unwritable" from "the value is".
            # EVERY key, not only the `str` ones — no caller can produce a `bytes` key today
            # (JSON keys are `str`; `h5.attrs` keys are `str`), which is exactly why the cheap
            # thing is to make the code match the invariant rather than to narrow the invariant
            # to the callers that happen to exist.
            hit = unencodable_vendor_text(key, _trail + (f"<key {key}>",))
            if hit is not None:
                return hit
            hit = unencodable_vendor_text(
                value, _trail + (key if isinstance(key, str) else str(key),)
            )
            if hit is not None:
                return hit
        return None
    if isinstance(node, np.ndarray):
        # An h5 attribute is as likely to be an ARRAY of strings as a scalar one — the real
        # fixture's `library_ids` IS one — and `vendor_provenance`'s own `text()` helper already
        # has an arm for exactly this. A walker without one would let this boundary's commonest
        # shape through while looking guarded. `.tolist()` on a 0-D array returns a SCALAR, which
        # the recursion below handles as itself rather than iterating it.
        #
        # TWO BOUNDS HERE, and the first version of each was WRONG in a way a blind angle
        # measured. Both are about `.tolist()`, which materialises EVERY element of an array as a
        # Python object before this function recurses over them.
        #
        # (1) WHICH DTYPES ARE SKIPPED, as a DENY-list and not an allow-list. The first version
        #     allowed `"SUO"` and skipped everything else, on the stated ground that "nothing
        #     else can carry text". FALSE, and it re-opened door (a): `V` is not only the HDF5
        #     OPAQUE dtype, it is also the STRUCTURED/COMPOUND dtype, whose fields can be `S` or
        #     `U`. MEASURED end to end on the committed fixture with
        #     `library_ids = np.array([(b"\xff\xfeSR",)], dtype=[("v", "S8")])` (h5py round-trips
        #     that as `dtype.kind == "V"`):
        #
        #         rc=0, 119 paths, provenance.library_id = '\ufffd\ufffdSR',
        #         coordinate_space = 'visium:\ufffd\ufffdSR'   -- and 3 distinct vendor byte
        #         strings again collapsing to ONE frame
        #
        #     i.e. the exact false collision this module exists not to make, re-introduced by a
        #     bound meant to be free. The skip is now stated as what CANNOT carry text -- bool,
        #     signed and unsigned int, float, complex, datetime64, timedelta64 -- so an unknown
        #     or future dtype kind is WALKED rather than silently skipped. A guard's default has
        #     to be to look.
        #
        # (2) A SIZE BOUND, because the dtype check alone does not bound the work. `|S1` is kind
        #     `S`, passes any text check, and materialises one Python object per element.
        #     MEASURED, one root attribute of `np.zeros(100_000_000, dtype="|S1")` in an h5
        #     written with `libver="latest"` (dense attribute storage lifts HDF5's 64 KB
        #     object-header cap):
        #
        #         dict(h5.attrs)   0.28 s, maxrss 323 MB   <- the cost `origin/main` already paid
        #         THE WALK        28.85 s, maxrss 894 MB    <- and it returns None
        #
        #     which is the same order as the `np.arange(100_000_000, np.int64)` case the dtype
        #     check removes (2.42 s vs 44.20 s in the walk, +1.6 GB RSS) and a WORSE amplification
        #     ratio. In a memory-capped sandbox either is an OOM SIGKILL: no refusal, no message,
        #     no exit code this module chose. So the array is refused BY NAME above a declared
        #     cap instead of being walked -- see [`_MAX_WALKED_ATTRIBUTE_BYTES`]. Raising from
        #     inside the predicate rather than returning a hit is deliberate: this is not "the
        #     document carries something unwritable", it is "this document cannot be examined",
        #     and giving it the hit tuple's shape would make the two indistinguishable.
        if node.dtype.kind in "biufcMm":
            return None
        if node.nbytes > _MAX_WALKED_ATTRIBUTE_BYTES:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} carries a root attribute at "
                # `int(...)` is a no-op on a numpy `intp` and is what lets the #336 structural
                # guard PROVE these two are integers (DEC-2). Its first revision blessed them
                # because the ATTRIBUTE was called `nbytes`/`size`, which says nothing about what
                # the object returns for it; that by-name rule is gone, so the source states the
                # fact instead.
                f"{_quoted_for_refusal(_trail_text(_trail))} of {int(node.nbytes)} bytes "
                f"({int(node.size)} entries), past the {_MAX_WALKED_ATTRIBUTE_BYTES}-byte cap this "
                "importer will examine. A root attribute is METADATA -- this importer reads "
                "three short strings from there -- and one this large cannot be checked for "
                "text it could not write without doing the work the check exists to bound. "
                "Re-export the complete Space Ranger `outs/` bundle."
            )
        return unencodable_vendor_text(node.tolist(), _trail)
    if isinstance(node, np.void):
        # A SCALAR of the compound/opaque dtype above. It is not an `ndarray`, so it reached the
        # fall-through `return None` and was invisible -- the scalar twin of the hole (1)
        # describes. `.tolist()` gives a tuple for a compound and `bytes` for an opaque, both of
        # which the arms above handle.
        return unencodable_vendor_text(node.tolist(), _trail)
    if isinstance(node, (list, tuple)):
        for i, value in enumerate(node):
            hit = unencodable_vendor_text(value, _trail + (f"[{i}]",))
            if hit is not None:
                return hit
        return None
    return None


def _trail_text(trail):
    """A walked trail as one readable path: `images.notes[2].vendor`, not `images.notes.[2].vendor`."""
    if not trail:
        return "<the document itself>"
    out = trail[0]
    for part in trail[1:]:
        out += part if part.startswith("[") else "." + part
    return out


#: How much of an offending value (and of the path to it) a refusal quotes. A vendor file can
#: make both arbitrarily long: MEASURED on the Xenium side, an 8 MB `run_name` ending in a lone
#: surrogate produced an 8,000,718-character single-line refusal, and the server accumulates a
#: job's stderr with `BufReader::lines()` and no per-line cap (unlike `sandbox.rs`'s
#: `OUTPUT_CAP_BYTES` and `streaming.rs`'s explicit 64 KiB clamp). Amplification is ~1:1, so this
#: is a flood rather than a bomb — and 120 characters is more than enough to identify which value
#: was refused. A NAMED constant rather than an inline number so promoting it is a rename; it is
#: deliberately NOT operator-configurable (DEC-10): a compute runs under `--clearenv` in a flat
#: `/code` dir with no channel to a settings row, and a stderr-flood bound an operator can raise
#: is a bound an attacker can benefit from.
_REFUSAL_QUOTE_CHARS = 120

#: How many ELEMENTS of an offending SEQUENCE a refusal quotes. A per-element bound is NOT a
#: message bound, and #336 is the measurement that proves it: `read_positions`' `Found {names}`
#: interpolates the positions CSV's header row, and a header of 60 fields x 120,000 characters
#: (every field under `csv`'s own 131,072 limit) produced a **7,200,587-byte SINGLE stderr line**
#: -- MEASURED on `c34b3a1f` through the shipped entrypoint. Bounding each field to
#: [`_REFUSAL_QUOTE_CHARS`] would still leave 60 x 120 = 7,200 characters, and an h5 file can
#: carry far more top-level members than a CSV can carry columns (MEASURED: 600,212 bytes from
#: ONE group name). So the COUNT is bounded too, and the true count is always stated.
#:
#: 8 is above every legitimate case this module quotes: a Visium positions table declares 6
#: columns, a 10x feature-barcode matrix h5 has one or two top-level members, and the
#: missing-barcode refusal already slices to 3. Fixed rather than operator-configurable for the
#: identical reason [`_REFUSAL_QUOTE_CHARS`] is (DEC-3, mirroring #330's DEC-10): a compute runs
#: under `--clearenv` in a flat `/code` dir with no channel to a settings row, and a stderr-flood
#: bound an operator can raise is a bound an attacker can benefit from.
#: The DERIVED output bound, stated rather than left to be worked out: 8 elements x 120 units x
#: the widest `ascii()` escape a single unit can produce (10 characters, `\U0001f9ec`) = 9,600
#: characters, plus each element's clip sentence. Not constant, and the slack is honest: the
#: message states the true COUNT and the true LENGTH, so it grows by the DECIMAL DIGITS of those
#: numbers and by nothing else -- logarithmic in the vendor's input, which is the same bound
#: [`_quoted_for_refusal`] already carries and which `test_refusal_escaping.py` asserts directly
#: (a 10x larger header buys at most 32 more bytes).
_REFUSAL_QUOTE_ITEMS = 8

#: The largest h5 root attribute this importer will WALK, in bytes. Not a message bound -- see
#: [`_REFUSAL_QUOTE_CHARS`] for that -- but a WORK bound, and the two are different failures: past
#: this, the cost is not a long line on stderr, it is an OOM SIGKILL with no message at all.
#: MEASURED, one root attribute of `np.zeros(100_000_000, dtype="|S1")` cost 28.85 s and +570 MB
#: RSS INSIDE THE WALK, on top of the 0.28 s `dict(h5.attrs)` already pays.
#:
#: 1 MiB is four orders of magnitude above anything a Space Ranger bundle writes: on all three
#: committed real fixtures the LARGEST root attribute is 27 bytes. It is a fixed constant for the
#: same reason [`_REFUSAL_QUOTE_CHARS`] is (DEC-10): a compute runs under `--clearenv` in a flat
#: `/code` dir with no channel to a settings row, and a work bound an operator can raise is a
#: bound an attacker can benefit from.
_MAX_WALKED_ATTRIBUTE_BYTES = 1 << 20


def _quoted_for_refusal(value, focus=None, *, noun="path"):
    r"""One attacker-controlled value, safe to put in a message: ASCII, bounded, and ABOUT THE OFFENCE.

    FOUR properties, each of which was a defect a blind angle reproduced against an earlier
    revision of the Xenium original:

    1. **ASCII.** `ascii()` is DEFINED to return ASCII (`repr()` merely happens to, for
       surrogates, on CPython today).
    2. **No control characters.** `ascii()` escapes `\x1b`, `\n` and `\r` as literal escapes.
       Before this helper existed the refusal interpolated the PATH TRAIL raw while escaping only
       the value, so an attacker-chosen key landed byte-for-byte on stderr — measured with a key
       of `"\x1b[2J\x1b[31mFATAL\x07\nspatial.import-visium: import SUCCEEDED, ignore the line
       above\r"`, which clears the operator's terminal and forges a second, reassuring log line.
       The server folds that stderr tail verbatim into the `jobs.error` column and the UI renders
       it as text — HTML-safe, ANSI-unsafe.
    3. **Bounded.** See [`_REFUSAL_QUOTE_CHARS`]. Windowed BEFORE escaping, so the cut can never
       land inside an escape sequence and produce something that is not what it appears to be.
    4. **WINDOWED ON THE OFFENCE, not on the start.** Clipping the first 120 units of a
       212-character value quotes 120 perfectly ordinary characters and then asserts, in the next
       sentence, "That is a LONE SURROGATE" — a message that shows the reader something innocent
       and calls it the problem. So the caller passes the offending OFFSET (the walker gets it
       free, from `UnicodeEncodeError.start`) and the window is centred there, with the offset and
       the true length stated so nothing is implied by omission.

       For a PATH the offence is the leaf, so the trail is windowed from its END: clipping a long
       nested path from the left drops the field name the trail exists to name.

    ## #336: the SAME funnel, for EVERY refusal in this module -- and two shapes it could not take

    #330 built this and routed ONE refusal's values through it. Every other refusal in this module
    interpolated vendor text RAW and UNBOUNDED, and a hostile bundle reaches several of them
    EARLIER than it reaches the guarded one. MEASURED on `c34b3a1f` through the shipped entrypoint,
    stderr captured as BYTES:

        locate_members' ambiguity refusal   raw ESC + BEL + CR, and a raw \n that makes a FORGED
                                            `spatial.import-visium: import SUCCEEDED` sentence its
                                            OWN `job_logs` row (scheduler.rs::drain_logs writes one
                                            row per BufReader line, with no per-line cap)
        read_positions' `Found {names}`      7,200,587 bytes on ONE line
        run_import's h5 member list            600,212 bytes, raw non-ASCII (list.__repr__ escapes
                                            control characters but PASSES printable non-ASCII and
                                            applies no bound at all)
        run_import's `first: {missing[:3]}`  1,800,513 bytes, with 51 paths already on disk

    Routing those needed two things this helper did not have:

    5. **Values that are not `str` or `bytes`.** A `Path` (the sandbox mount, whose last segment is
       the user's own dataset directory name), an `Exception` (h5py's and `float()`'s messages both
       echo vendor text back), an `int`. `len()` RAISES on all three, so they are coerced with
       `str()` first. `str` and `bytes` are deliberately NOT coerced: `ascii(b"\xff\xfeSR")` is
       `b'\xff\xfeSR'` and `ascii(str(b"\xff\xfeSR"))` is a quoted repr OF a repr, so coercing
       them would silently move #330's own messages.
    6. **Prose that is TRUE.** The over-long branch said "of the path" unconditionally, which is a
       false statement about a CSV header field. `noun=` carries what the value actually is; the
       default keeps #330's two call sites byte-identical.

    A SEQUENCE is a genuinely different shape and gets its own funnel -- see
    [`_quoted_list_for_refusal`] -- because bounding each element is not bounding the message.
    """
    if not isinstance(value, (str, bytes)):
        # A `Path`, an `Exception`, an `int`. `len()` raises on all of these, so the value is
        # rendered first; `str` and `bytes` are left alone so #330's output cannot move (above).
        value = str(value)
    total = len(value)
    if total <= _REFUSAL_QUOTE_CHARS:
        return ascii(value)
    if focus is None:
        # A PATH. There is no "offending unit" in it — the offence is in the value — so the
        # window is simply the TAIL, which is the leaf field name, and it says only that.
        return (f"{ascii(value[total - _REFUSAL_QUOTE_CHARS:])} (the last "
                f"{_REFUSAL_QUOTE_CHARS} of {total} characters of the {noun})")
    lead = _REFUSAL_QUOTE_CHARS // 3
    start = max(0, min(focus - lead, total - _REFUSAL_QUOTE_CHARS))
    window = value[start:start + _REFUSAL_QUOTE_CHARS]
    return (f"{ascii(window)} (a {_REFUSAL_QUOTE_CHARS}-unit window at offset {start} of "
            f"{total}; the offending unit is at {focus})")


def _quoted_list_for_refusal(values, noun="value"):
    r"""A SEQUENCE of attacker-controlled values, safe to put in a message (#336).

    ## Why a list is not just N values

    Four refusals in this module interpolate a SEQUENCE, and all four did it by handing the list
    straight to an f-string, i.e. to `list.__repr__`. That has exactly one of the four properties
    [`_quoted_for_refusal`] holds: it escapes control characters. It is NOT ASCII (it passes
    printable non-ASCII through byte for byte -- MEASURED, 600,212 bytes of `U+30C6` out of one h5
    group name), and it is NOT BOUNDED, in EITHER dimension:

    * **per element** -- one 120,000-character CSV header field is one 120,000-character message;
    * **per count** -- 60 such fields is 7,200,587 bytes on a single stderr line, which
      `scheduler.rs::drain_logs` stores as one `job_logs` row with no per-line cap.

    So both dimensions are bounded here: each element goes through [`_quoted_for_refusal`], and
    the number of elements shown is capped at [`_REFUSAL_QUOTE_ITEMS`]. The worst case is
    8 x 120 UNITS, and a unit can escape to ten characters (`\U0001f9ec`), so ~9,600 characters
    plus the per-element clip sentences -- see [`_REFUSAL_QUOTE_ITEMS`], which states the same
    figure. An earlier draft of this paragraph said "a few hundred bytes"; a blind angle MEASURED
    the widest site at a **9,140-byte** single log row and it was right, so the sentence is
    corrected rather than the measurement argued with. Nine kilobytes is three orders of
    magnitude below the 7,200,587 bytes this replaces and is the honest number.

    ## The true count is always stated

    A silent truncation is the failure mode [`_quoted_for_refusal`]'s property (4) exists to
    avoid, one dimension over: showing an operator three of sixty header fields and letting the
    surrounding sentence imply that is all of them is a message that is safe and WRONG. When the
    sequence is longer than the cap the count is spelled out, so nothing is implied by omission.

    The rendering deliberately MIRRORS `list.__repr__`'s bracketed, comma-separated shape, because
    that is what these four refusals read like today and an operator reading a log should not have
    to learn a second spelling to recognise the same fact.
    """
    values = list(values)
    shown = [_quoted_for_refusal(v, noun=noun) for v in values[:_REFUSAL_QUOTE_ITEMS]]
    body = "[" + ", ".join(shown) + "]"
    if len(values) <= _REFUSAL_QUOTE_ITEMS:
        return body
    return f"{body} (the first {_REFUSAL_QUOTE_ITEMS} of {len(values)} entries)"


def refuse_unencodable_vendor_text(node, *, source, remedy):
    r"""Raise the named refusal if `node` carries text this importer could not write (#330).

    ONE predicate, TWO callers — the `/matrix` file's ROOT ATTRIBUTES and
    [`read_scalefactors`] — and the reason is the one [`vendor_provenance`] already records for
    itself: a second spelling of one rule is a rule that answers differently in two places. The
    two boundaries differ only in HOW the unwritable text got in (a `\udXXX` escape `json.loads`
    accepted; `h5py` decoding an invalid UTF-8 attribute with `surrogateescape`; or raw invalid
    bytes in an h5 `|S` attribute), never in what is wrong with it or what to do about it.

    ## BOTH CALLERS FIRE BEFORE THE FIRST WRITER, and one of them had to MOVE for that

    Measured on this base: the first artifact write is
    `txr_csc.write_csc_zarr(..., "expression.zarr")` — the first writer, called from
    `run_import` after every refusal this design adds. The root-attribute read (the
    `refuse_unencodable_vendor_text` call on `h5.attrs`) sits before it — free. But
    `read_scalefactors` was CALLED in the coordinate-space block, after the expression
    store, both axis stores and the metadata columns were already on disk, so a refusal
    raised where that call sat would have fired with those artifacts already written. The
    scale file is therefore read immediately after `locate_members` and the parsed document
    passed down (DEC-4). Without that move INV-2 would be true at one door and false at the
    other, which is the "same rule applied to one field fewer" defect this package has
    already shipped three times.

    ## THE MESSAGE IS ASCII, BOUNDED AND ESCAPED — for reasons that were MEASURED, not assumed

    The Xenium original's first justification for this was that a raw surrogate in the message
    "would raise `UnicodeEncodeError` AT THE REPORTING SITE, under ANY encoding". A blind angle
    measured that claim and it is FALSE: CPython gives `sys.stderr` `errors="backslashreplace"`
    unconditionally, so `main()`'s own `print` never raises. The real reasons:

    1. **The message is re-encoded and re-rendered downstream.** It is not consumed by `print`;
       it is captured, stored in the job's error column and displayed. `backslashreplace`
       protects the one hop that happens to be lenient, not the consumers after it.
    2. **It is an INJECTION SURFACE.** The path trail is attacker-chosen — see
       [`_quoted_for_refusal`], which is the single place any vendor byte can enter a message.
    3. **An ASCII locale is a real case here**, and on this package it was not hypothetical:
       measured on an ORDINARY bundle under `LC_ALL=C`, `visium-import-summary.html` raised
       `UnicodeEncodeError` on this module's own em dash with 117 paths on disk. A refusal whose
       prose carried an em dash would be unprintable for a reason having nothing to do with the
       bundle, on the one path whose whole job is to say what is wrong with the bundle. So the
       prose here is plain ASCII, deliberately.
    """
    hit = unencodable_vendor_text(node)
    if hit is None:
        return
    where, text, at = hit
    if isinstance(text, bytes):
        diagnosis = (
            "Those are BYTES THAT ARE NOT VALID UTF-8. Decoded loosely they would become "
            "replacement characters, so two different vendor byte strings would arrive as one "
            "value"
        )
    else:
        diagnosis = (
            "That is a LONE SURROGATE: half of a character, with no meaning of its own"
        )
    raise VisiumImportError(
        f"{source} carries text at {_quoted_for_refusal(where)} that is not valid "
        # `int(at)` is a no-op — `at` is `UnicodeEncodeError.start`, an integer offset — and is
        # what lets the #336 structural guard PROVE it (DEC-2). It is not decoration: `focus` is
        # INTERPOLATED into the funnel's own output ("the offending unit is at {focus}"), so an
        # unprovable value there is the same hole one keyword over from the one this item closes.
        f"Unicode and cannot be written: {_quoted_for_refusal(text, int(at))}. {diagnosis}. It is "
        "refused rather than repaired, because these strings become the run's identity and its "
        "provenance, and a replaced character in a `library_ids` is a silently altered sample "
        "AND a silently altered coordinate frame -- MEASURED, three different invalid byte "
        "strings all emitted the one identifier and the one `coordinate_space`, which is the "
        "false collision this importer exists not to make. Left in, it would either abort the "
        "writer after the coordinate store was already on disk, or ship a report no strict JSON "
        f"reader can parse. {remedy}"
    )


# ─────────────────────────────── the bundle ───────────────────────────────


def decoded_h5_strings(group, name, label=None):
    """One untrusted h5 string dataset, decoded STRICTLY, refused BY NAME on every way it can fail.

    THE THIRD DOOR IN THE SAME FILE (#330 FIX_ROUND-1), found by all three blind angles
    independently and sitting in the same `run_import` block, below the root-attribute guard.

    `run_import` read `/matrix/barcodes` and the two `/matrix/features` name datasets as
    `[b.decode() if isinstance(b, bytes) else str(b) for b in ...]`. A bare `.decode()` is
    STRICT, which is right — see below — but nothing caught what it raises, and `main()` catches
    only `VisiumImportError`. MEASURED on the committed fixture with
    `matrix/features/name[0] = b"\xff\xfeEVIL"` (and again on `barcodes`, and again on
    `features/id` under `h5py.string_dtype("utf-8")`):

        rc=1  paths=0  UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff in position 0
          import_visium.py  run_import

    A raw traceback and exit 1 — INV-1's exact prohibited outcome, on the same file the guard
    above had just walked, carrying orders of magnitude more vendor text than the three root
    attributes do. (INV-2 survived by ordering alone: these reads precede the first writer.)
    #323 closed exactly this on the Xenium side and this is that rule, one package over.

    ## STRICT, and why it is not a candidate for the boundary predicate

    These three datasets are IDENTITIES: a barcode is the key the positions table is joined on
    and a feature id is what a gene list is matched against. `errors="replace"` would silently
    mangle a key and turn a join FAILURE into a WRONG join — a picture of the tissue with the
    values shuffled — which is the false-collision class this whole item exists to remove. So
    they are decoded strictly and the failure is NAMED rather than routed through
    `refuse_unencodable_vendor_text`: that predicate's message is about a document being
    unwritable, and this one is about a join key being undecodable. Different fact, different
    remedy, and the ROW is named because "position 0" in a codec's message is a byte offset
    inside one value, which is not what an operator needs in order to go and look.

    ## Every way the read itself can fail, because a guard on one of three is a guard on none

    `group[name][:]` has four more reachable failures: a rank-0 (scalar) dataset and an
    `h5py.Empty` null dataspace raise `ValueError`, a GROUP of that name raises `TypeError`,
    an ABSENT member raises `KeyError`, and a dataset whose METADATA is fine but whose BYTES
    are undecodable (an unavailable filter, a truncated chunk, a fletcher32 checksum
    failure) raises `OSError`. All are named here, once, for all three call sites.

    `KeyError` was missing from the first version of this function, whose heading said "every way"
    while an h5 with no `/matrix/barcodes` still produced `rc=1` and a raw
    `KeyError: "Unable to synchronously open object"` traceback — a blind angle measured it, and
    it is the same INV-1 violation this function was added to remove, inside the function that
    removed it.
    """
    label = label or f"/matrix/{name}"
    try:
        raw = group[name][:]
    except VisiumImportError:
        raise
    except KeyError:
        raise VisiumImportError(
            f"{MATRIX_BASENAME} has no `{label}`. A 10x feature-barcode matrix carries the "
            "barcodes and all three feature columns; an incomplete one cannot be imported, "
            "because there would be nothing to align the counts to."
        ) from None
    except (ValueError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` cannot be read as a list of values "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). A 10x "
            f"feature-barcode matrix stores it as a "
            "one-dimensional dataset; this file has something else there."
        ) from None
    except (OSError, RuntimeError) as exc:
        # A dataset whose METADATA is fine but whose BYTES are undecodable — an
        # unavailable filter, a truncated chunk, a fletcher32 checksum failure — raises
        # `OSError` HERE rather than inside the writer, the same model
        # [`refuse_malformed_shape`] and [`refuse_malformed_counts`] apply to `shape`,
        # `indptr`, `data` and `indices`. The refusal says the bytes could not be read
        # and does NOT claim the dataset is absent: the link exists, its content does
        # not decode. `RuntimeError` lands in the two UNREADABLE arms, never in the
        # "has no" arm above — a member that exists but cannot be read must never be
        # reported as absent (`RecursionError` and `NotImplementedError` are
        # `RuntimeError` subclasses and land here too).
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` is present but its bytes cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
            "matrix stores it as a one-dimensional dataset; a dataset whose bytes "
            "cannot be read (an unavailable filter, a truncated chunk, a checksum "
            "failure) is not a matrix this importer can carry. Refusing rather than "
            "importing a matrix whose identities cannot be read."
        ) from None
    out = []
    for index, value in enumerate(raw):
        if not isinstance(value, bytes):
            out.append(str(value))
            continue
        try:
            out.append(value.decode())
        except UnicodeDecodeError as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `{label}` entry {index} is not valid UTF-8 "
                f"({_quoted_for_refusal(exc, noun='message')}). "
                "That value is an IDENTITY -- a barcode is the key this importer joins the "
                "positions table on, a feature id is what a gene list is matched against -- so "
                "it cannot be decoded loosely without silently pairing one spot's position with "
                "another spot's counts. Re-export the bundle from Space Ranger."
            ) from None
    return out


#: THE CANONICAL REASON behind every no-usable-count refusal (#445, #474, #548), stated
#: ONCE and interpolated verbatim into every refusal message that carries it (#489): an
#: import of a matrix with no usable stored value would be reported to the operator as
#: SUCCESS at exit 0 — the process would emit the same closing `progress("done", 100, ...)`
#: line whether the matrix is empty or full, and the report's passive warning channels
#: change nothing about the exit code or stderr. Whether the emptiness is itself VISIBLE
#: mid-stream is per-shape and is stated per-shape in each message; the load-bearing
#: reason here is what is true of ALL four shapes: the operator is told SUCCESS and
#: downstream analysis runs on nothing usable. Stated here so the messages, the decision
#: comments, the manifest changelog and the test docstring cannot drift apart;
#: `tests/test_retracted_reason_absent.py` asserts all of them agree with THIS string.
#: It is bound to plain adjacent literals, which is the shape
#: `tests/visium_refusal_sites.py` proves safe by (a name bound only to literals), so
#: interpolating it needs no new proof.
REASON_NO_USABLE_COUNTS = (
    "Without this refusal such an import is reported as SUCCESS at exit 0: `main()` has "
    "exactly two DESIGNED outcomes — refuse (`sys.exit(2)`) or succeed (an uncaught "
    "exception exits 1 with a raw traceback, which is INV-1's PROHIBITED outcome, not a "
    "designed one) — and there is no outcome REPORTED TO THE OPERATOR as anything other "
    "than SUCCESS: the process exits 0 and emits the same closing `progress(\"done\", 100, "
    "...)` line whether the matrix is empty or full (MEASURED — `progress: done|100|16 "
    "outputs` is the identical closing line in every measured case, all of them on this "
    "node's committed fixture; the count in that line is `len(entries)` at "
    "`progress(\"done\", ...)` — one entry per emitted artifact, including one per "
    "emitted vendor image — so the number is bundle-dependent, and what is identical for "
    "every measured shape is that the SUCCESS path emits that line at the end), and the "
    "report's `image_warnings` and `images_not_emitted` lists, the `registration_qc` "
    "block, the `scale_note` field and every output entry's `meta` are PASSIVE channels — "
    "they change nothing about the exit code or stderr and are only visible to someone who "
    "opens the report or manifest artifact. The operator is told the import SUCCEEDED and "
    "downstream analysis runs on nothing usable — a plausible wrong answer rather than an "
    "error."
)


def refuse_malformed_counts(group, n_barcodes, n_features):
    r"""The `/matrix` CSC triple's INTERNAL CONSISTENCY, checked before it is handed to the writer.

    `run_import` reads the 10x `/matrix` group and hands it straight to
    `txr_csc.H5CsrSource` and then `txr_csc.write_csc_zarr` — the FIRST WRITER. The content
    and shape of `/matrix/data`, `/matrix/indices` and `/matrix/indptr` were never validated;
    they were first touched INSIDE the writer, i.e. AFTER artifact bytes already existed on
    disk. MEASURED through the shipped entrypoint:

      * `/matrix/indices` truncated to 100 entries while `indptr[-1]` still says 17677
        -> exit 0, a manifest, and a WRONG matrix (every count attributed to feature 0);
      * `/matrix/indptr` = 121 entries all `999999999` (length correct)
        -> exit 1, a raw traceback out of `_lib/txr_csc.py`, and a PARTIAL STORE on
        disk (`RuntimeError: transpose scatter did not fill the band exactly -- the
        counting pass and the scatter pass disagree about the matrix (did the source
        change under us?)` at `_lib/txr_csc.py:626` in `_scatter_band`);
      * a non-monotonic `indptr` -> exit 1, a raw traceback out of `_lib/txr_csc.py`, and
        a PARTIAL STORE on disk.

    `_lib` is shared framework and its raise is not this package's to change; validating the
    vendor's file before handing it over is. Every check here fires BEFORE the first writer,
    so a refused bundle leaves no store, no partial store and nothing for a later reader to
    find — INV-2 — and every failure is a named `VisiumImportError`, never a traceback and
    never an exit-1 — INV-1.

    ## The orientation, stated once because it is the fact most likely to be got wrong

    10x stores `/matrix` as CSC over (features x barcodes): `indptr` has one entry per
    BARCODE and `indices` holds FEATURE ids. `run_import` re-reads that store AS CSR of shape
    `(n_barcodes, n_features)`, so under this module's own reading:

      * `len(indptr)` must be `n_barcodes + 1`;
      * `indptr[-1]` must equal the number of stored values, i.e. `len(indices) == len(data)`;
      * `indptr[0]` must be 0 and `indptr` must never decrease;
      * every value in `indices` must satisfy `0 <= v < n_features`.

    The checks below are ordered so the most structural failure is reported first: presence
    and kind of each member, then the two lengths, then `indptr`'s content, then the
    `indices` range — which is scanned BLOCKWISE and OUT-OF-CORE, because a 10x matrix can
    hold billions of stored values and this module's whole design is to stay bounded by a
    block, not by the matrix.

    Two EMPTY-matrix refusals sit at the two ends of this ladder (#445). `n_barcodes == 0`
    — the documented "empty" case, a capture area with no tissue detected — is refused at
    the TOP, before any member is read, because it is the most structural fact about the
    matrix. `nnz == 0` with `n_barcodes > 0` — the #445 shape — is refused where `nnz` is
    proven, after the two length checks and the `indptr` content checks. Both fire before
    the first writer.
    """
    import h5py

    # REFUSAL A — `n_barcodes == 0`: the matrix carries no barcodes at all. The sibling
    # importer (`spatial-import-visium-hd`) refuses this exact case before its first writer
    # with the same reasoning: an EMPTY matrix imports cleanly otherwise — the length
    # cross-check passes (0 == 0), every writer accepts an empty column, and the result is
    # a complete, coherent, empty dataset. That is a plausible wrong answer rather than an
    # error — a user sees an import that "worked" and a tissue map with nothing on it.
    #
    # This ALSO fixes a real ordering defect. The Visium importer's only empty-barcodes
    # refusal lives in `unverified_space_id` (reached from `coordinate_space_id`) — AFTER
    # the first writer (`txr_csc.write_csc_zarr`). For
    # `n_barcodes == 0` the importer today writes an empty `expression.zarr` and then
    # refuses (when it refuses at all — with an identifying `library_ids` present it does
    # not even reach that rung), leaving paths on disk: INV-2 broken. This check moves the
    # refusal before the first writer. The `unverified_space_id` check is NOT deleted or
    # weakened: it covers a DIFFERENT condition — barcodes that are present but all empty
    # strings — and it is still reachable.
    if n_barcodes == 0:
        raise VisiumImportError(
            f"{MATRIX_BASENAME} carries no barcodes at all, so the capture area has no "
            f"spots under tissue. {REASON_NO_USABLE_COUNTS} (MEASURED on this node's "
            "committed fixture with this refusal set aside: the same import then streams "
            f"`progress: matrix|15|0 spots x {int(n_features)} genes` and `progress: "
            "coordinates|65|0 spot positions`, its report states `n_spots: 0`, and the "
            "manifest's expression entry carries `structure.nnz: 0` — so the emptiness is "
            "VISIBLE in the stream and in the artifacts; what still does not exist is any "
            "non-SUCCESS outcome: the process would exit 0 with the same closing "
            "`progress(\"done\", 100, ...)` line as a full import — 16 outputs on this "
            "node's committed fixture, a number that is `len(entries)` and so "
            "bundle-dependent — no warning and no error, and "
            "the operator would still be told the import SUCCEEDED while downstream "
            "analysis runs on nothing.) Check that Space Ranger "
            "detected tissue on this run, or that the file is not damaged or truncated "
            "with its barcodes and shape both zeroed. `metrics_summary.csv`'s \"Number "
            "of Spots Under Tissue\" and the raw matrix (`raw_feature_bc_matrix.h5`) "
            "tell the two apart. Refusing rather than shipping an empty matrix as a "
            "successful import."
        )

    for member in ("data", "indices", "indptr"):
        if member not in group:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} has no `/matrix/{member}`. A 10x feature-barcode "
                "matrix stores its non-zero values, feature ids and column offsets as "
                "flat datasets under `/matrix`; a matrix missing one of them cannot be "
                "imported. Refusing rather than handing a partial matrix to the store "
                "writer."
            )
        # A member that is PRESENT but cannot be READ is a different defect from one that
        # is absent, and the operator needs to know which. An h5py ExternalLink to a file
        # outside the bundle's matrix file makes `group[member]` raise — MEASURED: `/matrix/indices` as
        # an ExternalLink to a nonexistent file escaped as
        # `KeyError: Unable to synchronously open object (can't open file)`, rc 1, a raw
        # traceback, INV-1 broken. The "has no `/matrix/...`" refusal above means the
        # member is MISSING; this one says the member is there but unreadable.
        try:
            ds = group[member]
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, RuntimeError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/{member}` cannot be read "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                "matrix stores its non-zero values, feature ids and column offsets as "
                "flat datasets under `/matrix`; a member that cannot be read is not a "
                "matrix this importer can carry. Refusing rather than handing a partial "
                "matrix to the store writer."
            ) from None
        if not isinstance(ds, h5py.Dataset):
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/{member}` is not a dataset "
                f"({_quoted_for_refusal(type(ds).__name__, noun='type name')}). A 10x "
                "feature-barcode matrix stores its non-zero values, feature ids and "
                "column offsets as flat datasets; anything else is not a matrix this "
                "importer can read. Refusing rather than handing it to the store writer."
            )
        # A VIRTUAL dataset or EXTERNAL raw storage is refused OUTRIGHT, without
        # resolving its sources and deciding. A 10x Space Ranger feature-barcode matrix
        # stores `data`/`indices`/`indptr` INLINE; a virtual dataset's values depend on
        # files OUTSIDE the bundle's matrix file, and so does HDF5 external raw storage
        # (`create_dataset(..., external=[...])`) — for both, the importer cannot know
        # what it will read, and an unresolvable source silently yields the FILL VALUE
        # (0) rather than an error. MEASURED: a virtual `/matrix/indices` with a missing
        # source file imported at rc 0 with every count attributed to feature 0; an
        # external-storage dataset is the same hole (`ds.is_virtual` is False for it,
        # so only the `.external` check sees it). Refusing is the only way to avoid a
        # silent wrong answer.
        is_virtual = bool(getattr(ds, "is_virtual", False))
        external = getattr(ds, "external", None) or ()
        if is_virtual or external:
            storage_kind = (
                "a VIRTUAL dataset" if is_virtual
                else "a dataset with EXTERNAL raw storage"
            )
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/{member}` is {storage_kind}. A 10x "
                "feature-barcode matrix stores its non-zero values, feature ids and "
                "column offsets INLINE; a dataset whose values depend on files outside "
                "the bundle's matrix file cannot be imported — the importer cannot know "
                "what it will read, and an unresolvable source silently yields the fill "
                "value rather than an error. Refusing rather than shipping a wrong "
                "matrix."
            )
        if ds.shape is None or ds.shape == ():
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/{member}` is not a one-dimensional "
                f"dataset ({_quoted_for_refusal(ds.shape, noun='shape')}). A 10x "
                "feature-barcode matrix stores its non-zero values, feature ids and "
                "column offsets as flat datasets; anything else is not a matrix this "
                "importer can read. Refusing rather than handing it to the store writer."
            )
        if ds.ndim != 1:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/{member}` is {int(ds.ndim)}-dimensional "
                f"(shape {_quoted_for_refusal(ds.shape, noun='shape')}). A 10x "
                "feature-barcode matrix stores its non-zero values, feature ids and "
                "column offsets as flat datasets; anything else is not a matrix this "
                "importer can read. Refusing rather than handing it to the store writer."
            )
        if member in ("indices", "indptr") and ds.dtype.kind not in "iu":
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/{member}` is not stored as an integer "
                f"({_quoted_for_refusal(ds.dtype, noun='type name')}). A 10x "
                "feature-barcode matrix stores its feature ids and column offsets as "
                "integers; anything else is not a matrix this importer can read. "
                "Refusing rather than handing it to the store writer."
            )
        # `data`'s dtype is validated too, and the allowed kinds are EXACTLY what the
        # sibling importer (`spatial-import-visium-hd`) requires for the same member:
        # `"iufb"` — signed integer, unsigned integer, float, bool. A silent divergence
        # between two importers doing the same check is itself a defect. `data` is NOT
        # restricted to integers: real Space Ranger matrices can hold floats, and a
        # float32 `data` must still import. Without this, a string (`|S1`) or compound
        # `data` dies inside `_lib/txr_csc.py` with a raw traceback and a five-path
        # partial store — and a compound dtype echoes the vendor's own field names onto
        # stderr unbounded.
        if member == "data" and ds.dtype.kind not in "iufb":
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/data` is not stored as a number "
                f"({_quoted_for_refusal(ds.dtype, noun='type name')}). A 10x "
                "feature-barcode matrix stores its non-zero values as numbers; "
                "anything else is not a matrix this importer can read. Refusing "
                "rather than handing it to the store writer."
            )

    data = group["data"]
    indices = group["indices"]
    indptr = group["indptr"]

    if len(data) != len(indices):
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/data` holds {len(data)} value(s) but "
            f"`/matrix/indices` holds {len(indices)} feature id(s). They are the two "
            "halves of one stored value and their counts are the same number by "
            "definition; a file where they disagree describes no matrix. Depending on "
            "which array is short, the store writer either silently drops the values it "
            "has no id for or dies partway through leaving a partial store on disk; "
            "either way the file is not a matrix this importer can carry. Refusing "
            "rather than shipping a wrong matrix."
        )

    if len(indptr) != n_barcodes + 1:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/indptr` has {len(indptr)} entries; a CSC "
            f"matrix over {int(n_barcodes)} barcodes has exactly "
            f"{int(n_barcodes) + 1}."
        )

    # Read `indptr` ONCE: it is `n_barcodes + 1` int64s — small — and `_lib`'s reader
    # materialises exactly this array, so this costs nothing extra. The read is wrapped
    # in the same refusal the unreadable-member case uses: an HDF5 `OSError` raised here
    # would otherwise be a raw traceback at exit 1 (INV-1). The FULL `data` DECODABILITY
    # SCAN sits in the SAME guarded region (#505): it reads EVERY block of `/matrix/data`
    # — the one-element `data[0:1]` probe it widens could only see chunk 0, and a corrupt
    # LATER chunk escaped it and died inside `write_csc_zarr` with a raw traceback and a
    # partial store (MEASURED: chunked + fletcher32, corrupt chunk 5 -> rc 1, 5 paths) —
    # and it is what catches a `data` whose METADATA is fine but whose BYTES are
    # undecodable (an unavailable filter, a truncated chunk, a fletcher32 checksum
    # failure) BEFORE the first writer. This is a FULL EXTRA STREAMING PASS over `data`,
    # on top of the counting pass and the write pass — the honesty the `indices` range
    # scan's comment below shows is owed here too: the scan is blockwise and out-of-core,
    # but it is not free.
    try:
        indptr_arr = np.asarray(group["indptr"][:], dtype=np.int64)
        data_ds = group["data"]
        step = max(1, int(txr_csc.READ_NNZ))
        for lo in range(0, len(data_ds), step):
            np.asarray(data_ds[lo:min(lo + step, len(data_ds))])
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/indptr` or `/matrix/data` cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
            "matrix stores its non-zero values, feature ids and column offsets as "
            "flat datasets under `/matrix`; a member that cannot be read is not a "
            "matrix this importer can carry. Refusing rather than handing a partial "
            "matrix to the store writer."
        ) from None
    if int(indptr_arr[0]) != 0:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/indptr` starts at {int(indptr_arr[0])} "
            "rather than 0. A CSC offset array starts at 0; one that does not describes "
            "no matrix. Refusing rather than handing it to the store writer."
        )
    # The non-decreasing check is ELEMENT-WISE, never `np.diff`, and the reason is
    # overflow: `np.diff` inherits the array's dtype, and on int64 a DECREASE wraps
    # silently to a huge positive number, so `(np.diff(indptr) < 0).any()` is
    # unconditionally False and the guard passes everything. The sibling importer
    # (`spatial-import-visium-hd`) first measured this trap and spells the check
    # element-wise for the same reason. The payoff of the element-wise spelling is
    # real: with `indptr[0] == 0` + non-decreasing + `indptr[-1] == len(indices)`,
    # every entry is genuinely bounded to `[0, len(indices)]` — with `np.diff` they
    # were not.
    if bool(np.any(indptr_arr[1:] < indptr_arr[:-1])):
        pos = int(np.argmax(indptr_arr[1:] < indptr_arr[:-1]))
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/indptr` decreases at position {int(pos)} "
            f"({int(indptr_arr[pos])} -> {int(indptr_arr[pos + 1])}). A CSC offset "
            "array never decreases; one that does describes no matrix. Refusing rather "
            "than handing it to the store writer."
        )
    # `indptr[-1]` IS the stored-value count by definition, and this check catches a
    # THIRD silent-corruption class, distinct from the truncated-`indices` one (which
    # fails EARLIER, at `len(data) != len(indices)`): `indptr[-1]` UNDER-DECLARING while
    # `data` and `indices` agree with each other. `_lib`'s `H5CsrSource.nnz` is
    # `int(self._indptr[-1])` and `column_counts` reads `ind[0:nnz]`, so the store lands
    # silently TRUNCATED at rc 0 — MEASURED: an `indptr` valid in every way except
    # `indptr[-1] = len(indices) - 1`, with `data`/`indices` both at full length,
    # imported wrongly pre-fix and now refused here at rc 2.
    if int(indptr_arr[-1]) != len(indices):
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/indptr` ends at {int(indptr_arr[-1])} but "
            f"`/matrix/indices` holds {len(indices)} feature id(s). The last CSC offset "
            "IS the count of stored values; a file where they disagree describes no "
            "matrix, and the store writer would read past the end of the data or drop "
            "the final columns. Refusing rather than shipping a wrong matrix."
        )

    # REFUSAL B — `nnz == 0` with `n_barcodes > 0` (the #445 shape). After the two length
    # checks above, `nnz = len(indices)` is trustworthy: `len(data) == len(indices)` and
    # `indptr[-1] == len(indices)` are both proven, so the stored-value count is exactly
    # `len(indices)`.
    #
    # THE DECISION — REFUSE, and the reason does not depend on any claim about vendor
    # internals: it is the outcome signal — there is no outcome REPORTED TO THE OPERATOR
    # as anything other than SUCCESS — and it is stated once, below.
    #
    # 1. THE LOAD-BEARING REASON, stated alone because it carries BOTH refusals (Refusal A
    #    above and this one) verbatim — it is the exact sentence the four reason-carrying
    #    refusals interpolate as `REASON_NO_USABLE_COUNTS` (defined above), so this comment
    #    and the messages cannot drift apart:
    #
    #    Without this refusal such an import is reported as SUCCESS at exit 0: `main()` has
    #    exactly two DESIGNED outcomes — refuse (`sys.exit(2)`) or succeed (an uncaught
    #    exception exits 1 with a raw traceback, which is INV-1's PROHIBITED outcome, not a
    #    designed one) — and there is no outcome REPORTED TO THE OPERATOR as anything other
    #    than SUCCESS: the process exits 0 and emits the same closing `progress("done", 100,
    #    ...)` line whether the matrix is empty or full (MEASURED — `progress: done|100|16
    #    outputs` is the identical closing line in every measured case, all of them on this
    #    node's committed fixture; the count in that line is `len(entries)` at
    #    `progress("done", ...)` — one entry per emitted artifact, including one per emitted
    #    vendor image — so the number is bundle-dependent, and what is identical for every
    #    measured shape is that the SUCCESS path emits that line at the end), and the report's
    #    `image_warnings` and `images_not_emitted` lists, the `registration_qc` block, the
    #    `scale_note` field and every output entry's `meta` are PASSIVE channels — they
    #    change nothing about the exit code or stderr and are only visible to someone who
    #    opens the report or manifest artifact. The operator is told the import SUCCEEDED
    #    and downstream analysis runs on nothing usable — a plausible wrong answer rather
    #    than an error.
    #
    #    That is true whether the emptiness is `n_barcodes == 0`, `nnz == 0`, all-zero or
    #    non-finite — so this reason, and no claim about what Space Ranger does or does
    #    not produce, is what refuses all of them. It deliberately makes NO claim about
    #    which shape is detectable mid-stream: the zero-barcodes shape streams
    #    `progress: matrix|15|0 spots ...` and a report with `n_spots: 0` (the Refusal A
    #    message says so, measured), while the `nnz == 0` shape streams progress and a
    #    report byte-identical to a real import (the Refusal B message says so, measured).
    #    The "DESIGNED" qualification and the named exit-1 path are
    #    #503's correction: MEASURED through the shipped entrypoint, an uncaught exception
    #    (e.g. `FileExistsError` from `io_dirs()`'s `out.mkdir` when `TXR_OUTPUTS_DIR` is
    #    an existing regular file, raised OUTSIDE `main()`'s `except VisiumImportError`)
    #    exits 1 with a raw traceback and no `spatial.import-visium:` prefix — INV-1's
    #    prohibited outcome, named rather than hidden.
    # 2. The sibling importer already refuses the empty case:
    #    `spatial-import-visium-hd/compute/import_visium_hd.py` refuses `n_barcodes == 0`
    #    before its first writer, and #445 explicitly requires the two importers to agree.
    # 3. "Import but disclose" cannot meet the issue's own bar. The disclosure channels
    #    that exist are a whisper: `report/html` has no renderer in this application
    #    (#223), the report's `image_warnings`/`scale_note` fields and every output entry's
    #    `meta` are PASSIVE (point 1: there is no outcome REPORTED TO THE OPERATOR as
    #    anything other than SUCCESS), and `main()` has exactly two DESIGNED outcomes —
    #    refuse (`sys.exit(2)`) or succeed (an uncaught exception exits 1 with a raw
    #    traceback, INV-1's prohibited outcome). A disclosure through a passive channel
    #    would not displace the "SUCCESS" the operator sees. Making it loud would mean
    #    building a new channel, which the issue itself names as an argument for refusing.
    #
    # SUPPORTING NOTE — the vendor material, demoted because it is NOT load-bearing and
    # because the vendor facts are disputed (this branch's own research and an independent
    # review read the same documentation differently, so none of it is stated as settled
    # fact). The refusal's reason is point 1 above — the outcome signal: there is no
    # outcome REPORTED TO THE OPERATOR as anything other than SUCCESS — and for THIS shape
    # (the `nnz == 0` one) that reason is complete: MEASURED with the refusal set aside,
    # the streamed `progress:` lines and `visium-import-report.json` are byte-identical to
    # a real import, so in the stream and the report the operator-visible signal does not
    # distinguish this shape from a real one (the manifest's expression entry differs in
    # its machine-readable structure record (the stored-value count, the shapes and the
    # byte counts), which no note field restates). (The zero-barcodes shape is
    # NOT that case — its stream and report show the zeros; the Refusal A message states it
    # measured.) The reason holds whether or not
    # any of this vendor material is right, so the decision does not change with it.
    #
    # 4. What is DOCUMENTED: 10x documents the FILTERED matrix as containing only
    #    TISSUE-ASSOCIATED barcodes — selected from the image and/or a Loupe manual
    #    alignment. What is INFERRED, not documented: that the selection is not by
    #    counts — the documentation's silence on counts is our reading, not a vendor
    #    statement. IF selection is by tissue association alone, THEN a spot under
    #    tissue with zero UMIs is admissible by construction, and this shape
    #    (`n_barcodes > 0`, `nnz == 0`) can come from a legitimate if pathological
    #    run — tissue detected on the image, library or sequencing failed — which is
    #    why the refusal names both causes rather than asserting a damaged file.
    # 5. THE COUNTER-ARGUMENT, stated rather than suppressed — and STRONGER than the
    #    vendor chain ever made it: the vendor's own model is COMPLETE-WITH-ALERTS, not
    #    hard failure — Space Ranger does not fail a zero-spot run (a reading of the
    #    vendor's published pipeline source, not verified in this tree: its
    #    `spatial_metrics.csv` is understood to mark even 0 spots "acceptable" and raise
    #    only an alert rather than an error), and if the tissue-association reading above
    #    is right, a legitimate run can produce this shape. The whole downstream ecosystem
    #    accepts a zero-nnz matrix silently (`scanpy.read_10x_h5` builds a CSR with no
    #    `nnz > 0` check; `Seurat::Read10X_h5` builds an empty `sparseMatrix` with no
    #    check; `anndata` likewise). So this refusal is STRICTER than both the vendor and
    #    the ecosystem, and it refuses a shape that can be real. The mitigation is the
    #    refusal text itself: it names the raw matrix and `metrics_summary.csv` so an
    #    operator whose run was genuinely empty knows exactly how to tell "damaged file"
    #    from "real but empty run".
    # 6. THE LIMIT, stated honestly: this refusal fires on `nnz == 0` — the stored-value
    #    count is exactly zero. The same failure mode reached by a DIFFERENT shape — `nnz
    #    > 0` but every `/matrix/data` value equal to 0 — is NOT refused here. Not for
    #    cost: the module already streams the full `nnz`-length `indices` pass, and an
    #    all-zero check short-circuits on the first non-zero value — for a healthy matrix
    #    that is the first block, one the code already reads via its `data[0:1]` probe, so
    #    the common case is O(1), not O(nnz). The real reason is that a sparse format
    #    legitimately permits explicitly stored zeros, so "every stored value is zero"
    #    needs a decision about what it MEANS, and about where the boundary sits between
    #    a degenerate matrix and one that merely has some stored zeros — and that decision
    #    has to agree with the HD sibling (#470). That variant is filed as #474.
    nnz = int(len(indices))
    if nnz == 0:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/data` and `/matrix/indices` are both empty "
            f"({int(nnz)} stored values) while the matrix declares {int(n_barcodes)} "
            f"barcode(s) and {int(n_features)} feature(s). {REASON_NO_USABLE_COUNTS} "
            "(MEASURED on this node's committed fixture with this refusal set aside: every "
            "streamed `progress:` line — including `progress: matrix|15|"
            f"{int(n_barcodes)} spots x {int(n_features)} genes` and the closing "
            "`progress(\"done\", 100, ...)` line (16 outputs on this node's committed "
            "fixture; the count is `len(entries)`, bundle-dependent) — is byte-identical "
            "to a real import of this "
            "bundle, and `visium-import-report.json` is byte-identical too, with the "
            "stored-value count appearing nowhere in it; in the streamed progress and the "
            "report the operator-visible signal does not distinguish this shape from a "
            "real import — the manifest's expression entry differs in its machine-readable "
            "structure record (the stored-value count, the shapes and the byte counts), "
            "which no note field restates. The process would exit 0 with no "
            "warning and no error, and the operator would be told the import SUCCEEDED "
            "while downstream analysis runs on nothing.) "
            "Either the file is damaged or truncated, or this run produced no read that "
            "yielded a usable UMI (tissue detected, library or sequencing failed). "
            "Check `metrics_summary.csv`'s \"Number of Spots Under Tissue\" and the raw "
            "matrix (`raw_feature_bc_matrix.h5`) to tell the two apart. Refusing "
            "rather than shipping an empty matrix as a successful import."
        )

    # REFUSAL C — #474: `nnz > 0` but every `/matrix/data` value is exactly 0. The
    # `nnz == 0` refusal above (Refusal B, #445) and this one are the SAME harm reached
    # by a DIFFERENT shape: the operator is told the import SUCCEEDED and downstream
    # analysis runs on a matrix whose every stored value is 0 — nothing usable.
    #
    # THE DECISION — REFUSE, and the reason is the SAME load-bearing reason that carries
    # Refusals A and B — there is no outcome REPORTED TO THE OPERATOR as anything other
    # than SUCCESS: an all-zero matrix is reported as SUCCESS at exit 0, `main()` has
    # exactly two DESIGNED outcomes — refuse (`sys.exit(2)`) or succeed (an uncaught
    # exception exits 1 with a raw traceback, which is INV-1's PROHIBITED outcome, not a
    # designed one) — and the process emits the same closing `progress("done", 100, ...)`
    # line whether the matrix is empty or full (MEASURED — `progress: done|100|16
    # outputs` is the identical closing line in every measured case, all of them on this
    # node's committed fixture; the count in that line is `len(entries)` — one entry per
    # emitted artifact, including one per emitted vendor image — so it is bundle-dependent,
    # and what is identical for every measured shape is that the SUCCESS path emits that
    # line at the end). The full sentence is
    # the `REASON_NO_USABLE_COUNTS` constant above; the reason is restated here in
    # SHORTENED form, not quoted verbatim, because this comment's point is the shape, not
    # the wording. That reason is AGNOSTIC to WHY the matrix has no
    # usable counts: `nnz == 0` and "`nnz > 0` but every value is exactly 0" are both
    # "downstream analysis runs on nothing usable", so the #445 reasoning extends
    # verbatim — and #548 extends it once more: `nnz > 0` with every stored value
    # non-finite (NaN or Inf) is the SAME "downstream analysis runs on nothing usable",
    # so the #474 reasoning extends verbatim to the non-finite shape too. The operator
    # is told the import SUCCEEDED and downstream analysis runs on a matrix whose every
    # stored value is 0 — or whose every stored value is NaN or Inf — which is why it is
    # refused rather than imported.
    #
    # THE COUNTER-ARGUMENT, stated rather than suppressed: a sparse format LEGITIMATELY
    # permits explicitly stored zeros, so "every stored value is zero" needs a decision
    # about where the boundary sits between a degenerate matrix and one that merely has
    # some stored zeros. The boundary this check draws is the only one that is not a
    # guess: SOME stored zeros among non-zeros is unremarkable (the check does not
    # fire), and EVERY stored value zero is the same "nothing usable" as `nnz == 0`
    # (the check fires). A matrix with some stored zeros and some non-zeros — and one
    # that merely CONTAINS some NaN or Inf among real counts — is untouched.
    #
    # THE COST, stated honestly: this is a blockwise scan that SHORT-CIRCUITS on the
    # first non-zero value — for a healthy matrix that is the first block, so the common
    # case is O(1), not O(nnz). It re-reads the first block the decodability scan above
    # already read, and nothing more on a healthy matrix. `data_ds` is the same dataset
    # object the decodability scan bound above; the scan is guarded the same way, so an
    # unexpected read failure here is still a named refusal rather than a traceback.
    #
    # THE BOUNDARY IS "EXACTLY 0" AND DOES NOT COVER NaN/Inf (audit round 2, Finding F):
    # `np.any(blk)` treats NaN as truthy, so an all-NaN or all-Inf `/matrix/data` (dtype
    # kind `f`, which passes the `"iufb"` gate) is NOT refused here and imports at rc 0
    # with unusable "counts" (MEASURED). That is deliberately out of scope: no
    # measurement in this tree supports a vendor-wide claim about what Space Ranger
    # emits — a NaN in `/matrix/data` is stated here only as this block's inferred
    # reading of a different failure mode (a corrupt file), not yet observed on this
    # tree's committed fixture, tracked separately — and extending this check would
    # widen the sibling divergence #533 already tracks. — that paragraph is
    # corrected rather than removed, because a disclosure of absence and its retirement
    # are the same claim in two directions. The check NOW covers it (#548): the scan
    # predicate is "usable = FINITE AND NON-ZERO" (`np.isfinite(blk) & (blk != 0)`), so
    # a matrix with NO usable stored value — all-NaN, all-Inf, all-zero, or any mix with
    # no finite non-zero value — is refused before the first writer, while a matrix that
    # merely CONTAINS some NaN/Inf among real counts still imports (the boundary is ALL
    # stored values unusable, mirroring #474's "every one of them exactly 0"). The
    # all-zero, the non-finite and the mixed diagnoses are stated in SEPARATE messages, and the
    # sibling importer applies the same predicate, so the #533 agreement is preserved.
    step = max(1, int(txr_csc.READ_NNZ))
    any_usable = False
    saw_nonfinite = False
    saw_zero = False
    for lo in range(0, len(data_ds), step):
        try:
            blk = np.asarray(data_ds[lo:min(lo + step, len(data_ds))])
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, RuntimeError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/data` cannot be read "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                "matrix stores its non-zero values, feature ids and column offsets as "
                "flat datasets under `/matrix`; a member that cannot be read is not a "
                "matrix this importer can carry. Refusing rather than handing a partial "
                "matrix to the store writer."
            ) from None
        if blk.size:
            finite = np.isfinite(blk)
            if np.any(finite & (blk != 0)):
                any_usable = True
                break
            if not saw_nonfinite and not finite.all():
                saw_nonfinite = True
            if not saw_zero and np.any(finite & (blk == 0)):
                saw_zero = True
    if not any_usable:
        if saw_nonfinite and saw_zero:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/data` holds {int(nnz)} stored value(s), "
                "not one of them a usable count — some exactly 0 and some non-finite, "
                f"while the matrix declares {int(n_barcodes)} barcode(s) and "
                f"{int(n_features)} feature(s). This is not a shape a matrix of real "
                "read counts produces, and it supports BOTH readings honestly: "
                "a corrupt or mis-written FILE (damage, truncation or a faulty write), "
                "OR a genuine run whose reads produced no usable UMI and whose matrix "
                "was then damaged or truncated — and the two cannot be told apart from "
                f"this file alone. {REASON_NO_USABLE_COUNTS} (MEASURED on this node's "
                "committed fixture with this refusal set aside: the declared counts are "
                "unchanged and every streamed `progress:` line — `progress: matrix|15|"
                f"{int(n_barcodes)} spots x {int(n_features)} genes` and the closing "
                "`progress(\"done\", 100, ...)` line (16 outputs on this node's committed "
                "fixture; the count is `len(entries)`, bundle-dependent) — is "
                "byte-identical to a real import of this bundle; nothing in the report "
                "states the matrix's stored values or their count — so over the streamed "
                "progress and the report the operator-visible signal "
                "does not reveal what the counts ARE. The process would exit 0 with no "
                "warning and no error, and the operator would be told the import SUCCEEDED "
                "while downstream analysis runs on a matrix with no usable stored value.) "
                "Refusing rather than shipping "
                "a matrix with no usable stored value as a successful import."
            )
        if saw_nonfinite:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/data` holds {int(nnz)} stored value(s), "
                f"every one of them non-finite, while the matrix declares "
                f"{int(n_barcodes)} barcode(s) and {int(n_features)} feature(s). A count "
                "that is NaN or infinite is not a count a matrix of real read counts "
                "stores — the only readings supported by this tree are a corrupt or "
                "mis-written file, or a genuine run whose reads produced no usable UMI "
                "and whose matrix was then damaged or truncated — and the two cannot be "
                "told apart from this file alone. Refusing rather than shipping a matrix "
                "whose every stored value is unusable as a successful import."
            )
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/data` holds {int(nnz)} stored value(s), "
            f"every one of them exactly 0, while the matrix declares {int(n_barcodes)} "
            f"barcode(s) and {int(n_features)} feature(s). {REASON_NO_USABLE_COUNTS} "
            "(MEASURED on this node's committed fixture with this refusal set aside: the "
            "declared counts are unchanged and every streamed `progress:` line — "
            f"`progress: matrix|15|{int(n_barcodes)} spots x {int(n_features)} genes` and "
            "the closing `progress(\"done\", 100, ...)` line (16 outputs on this node's "
            "committed fixture; the count is `len(entries)`, bundle-dependent) — is "
            "byte-identical to a real import "
            "of this bundle; nothing in the report states the matrix's stored values or "
            "their count — so over the streamed progress and the report the operator-visible "
            "signal does not reveal what the counts ARE. The process would exit 0 with no "
            "warning and no error, and the operator would be told the import SUCCEEDED "
            "while downstream analysis runs on a matrix whose every stored value is 0.) "
            "Either the file is damaged or truncated, or this run produced no read that "
            "yielded a usable UMI (tissue detected, library or sequencing failed). "
            "Check `metrics_summary.csv`'s \"Number of Spots Under Tissue\" and the raw "
            "matrix (`raw_feature_bc_matrix.h5`) to tell the two apart. Refusing rather "
            "than shipping an all-zero matrix as a successful import."
        )

    # EVERY FEATURE ID MUST NAME A FEATURE THIS FILE DECLARES. Scanned in bounded blocks
    # off the dataset — never materialised whole — because a 10x matrix can hold billions
    # of stored values and this module's memory ceiling is a block, not the matrix. The
    # writer's `np.bincount` needs `0 <= id < n_features`, and both ends of that arrive as
    # a framework traceback. This scan is a FULL EXTRA STREAMING PASS over `indices`, on
    # top of `column_counts()`'s pass and `iter_entries`' pass — the honesty the `indptr`
    # comment above shows ("this costs nothing extra") is owed here too: the range check
    # is blockwise and out-of-core, but it is not free.
    indices_ds = group["indices"]
    step = max(1, int(txr_csc.READ_NNZ))
    for lo in range(0, len(indices), step):
        try:
            blk = np.asarray(indices_ds[lo:min(lo + step, len(indices))])
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, RuntimeError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indices` cannot be read "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                "matrix stores its non-zero values, feature ids and column offsets as "
                "flat datasets under `/matrix`; a member that cannot be read is not a "
                "matrix this importer can carry. Refusing rather than handing a partial "
                "matrix to the store writer."
            ) from None
        if not blk.size:
            continue
        bad = np.flatnonzero((blk < 0) | (blk >= n_features))
        if bad.size:
            at = int(lo) + int(bad[0])
            value = int(blk[bad[0]])
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indices` holds feature id "
                f"{int(value)} at position {int(at)}, but this file declares only "
                f"{int(n_features)} feature(s) (ids 0..{int(n_features) - 1}). A CSC "
                "column index names a row of the matrix; one that names no feature "
                "describes no matrix, and the store writer fails from inside the "
                "framework rather than saying anything about this bundle. Refusing "
                "rather than shipping a wrong matrix."
            )


def refuse_unopenable_matrix_file(path):
    r"""The matrix file itself cannot be opened as HDF5 — refused BY NAME (#345 / #451).

    `run_import` opens `members["matrix"]` with `h5py.File(..., "r")` and `main()` catches
    only `VisiumImportError`. MEASURED through the shipped entrypoint on this base: a
    `filtered_feature_bc_matrix.h5` that is not HDF5 at all (a plain text file) escaped as

        rc=1  paths=0
        OSError: Unable to synchronously open file (file signature not found)

    — a raw traceback at exit 1, INV-1's prohibited outcome. h5py can also raise
    `ValueError` on a malformed file, so both are caught here and turned into a named
    refusal. The guard is NARROW in POSITION on purpose: only the OPEN is wrapped, so an
    internal defect anywhere in the hundreds of lines below is not laundered into a
    refusal about the customer's bundle — a defect in this importer is a defect, and it
    must not be reported as a problem with the bundle.
    """
    import h5py

    try:
        return h5py.File(path, "r")
    except (OSError, ValueError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME} could not be opened as an HDF5 file "
            f"({_quoted_for_refusal(exc, noun='message')}). Either the file is not an "
            "HDF5 file at all, or it could not be read at all — permissions, an I/O "
            "error, an unreachable mount. A 10x feature-barcode matrix is an HDF5 file; "
            "a file that cannot be opened as one cannot be imported. Refusing rather "
            "than importing a file that cannot be read as a matrix."
        ) from None


def refuse_unreadable_matrix_group(h5):
    r"""The `/matrix` group: ABSENT, PRESENT-BUT-UNREADABLE, or NOT A GROUP — three refusals (#451).

    `run_import` read `h5["matrix"]` after a bare `"matrix" not in h5` presence test, and
    `main()` catches only `VisiumImportError`. The presence test is `H5Lexists`, which
    answers about the LINK, not its target: for a DANGLING SoftLink `"matrix" in h5` is
    True while `h5["matrix"]` raises `KeyError`. MEASURED through the shipped entrypoint on
    this base:

        rc=1  paths=0
        KeyError: "Unable to synchronously open object (component not found)"

    — a raw traceback at exit 1, INV-1's prohibited outcome, from a bundle whose `/matrix`
    link points at nothing. And a `/matrix` that is a DATASET where the group belongs
    (MEASURED: `/matrix` replaced by `[1, 2, 3]`) escaped as a `ValueError` out of h5py's
    field-name selection on a non-compound dataset:

        rc=1  paths=0
        ValueError: ... (h5py dataset.py)

    So the one presence test is replaced by three states, because they are three different
    things for the operator: absent, present but unreadable, present but not a group.
    """
    import h5py

    if "matrix" not in h5:
        raise VisiumImportError(
            f"{MATRIX_BASENAME} has no `/matrix` group — this is not a 10x "
            f"feature-barcode matrix. Found top-level members "
            f"{_quoted_list_for_refusal(sorted(h5.keys()), noun='member name')}."
        )
    # A DIRECT link-kind check on `/matrix` itself (#462). h5py FOLLOWS an
    # `h5py.ExternalLink` transparently, so `h5["matrix"]` would return an ordinary
    # group IN ANOTHER FILE and every predicate below would pass — the counts would
    # come from a file OUTSIDE this bundle's matrix file. `getlink=True` inspects the link itself
    # without resolving it, so an ExternalLink is refused BY NAME here, with a better
    # message than the structural walk's realpath one for this common case. (The walk
    # — [`refuse_outside_matrix_objects`] — is the structural guarantee behind it.)
    try:
        matrix_link = h5.get("matrix", getlink=True)
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix` link cannot be inspected "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
            "matrix stores its counts under a `/matrix` group; a link that cannot be "
            "inspected is not a matrix this importer can carry. Refusing rather than "
            "handing a partial matrix to the store writer."
        ) from None
    if isinstance(matrix_link, h5py.ExternalLink):
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix` is an ExternalLink. A 10x feature-barcode "
            "matrix stores its counts under a `/matrix` group INLINE in its own file; a "
            "link to another file cannot be imported — the importer cannot know what it "
            "will read. Refusing rather than shipping a wrong matrix."
        )
    # A member that is PRESENT but cannot be READ is a different defect from one that is
    # absent, and the operator needs to know which — the same distinction
    # [`refuse_malformed_counts`] draws for the three counts members. A dangling
    # SoftLink/ExternalLink makes `h5["matrix"]` raise — MEASURED above — so the guarded
    # subscript turns it into a named refusal instead of a raw `KeyError` traceback.
    try:
        group = h5["matrix"]
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix` link exists but its target cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
            "stores its counts under a `/matrix` group; a link whose target does not "
            "resolve is not a matrix this importer can carry. Refusing rather than "
            "handing a partial matrix to the store writer."
        ) from None
    if not isinstance(group, h5py.Group):
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix` is not a group "
            f"({_quoted_for_refusal(type(group).__name__, noun='type name')}). A 10x "
            "feature-barcode matrix stores its counts under a `/matrix` group; anything "
            "else is not a matrix this importer can read. Refusing rather than handing "
            "it to the store writer."
        )
    return group


#: A path deeper than this many levels under `/matrix` is refused BY NAME (#462). The
#: 10x matrix is a few levels deep (`/matrix/features/id`); a group tree this deep is
#: not a matrix this importer can carry, and the cap keeps the walk's depth bounded.
#: `/matrix` itself counts as depth 0, so 64 levels import and 65 refuse.
MAX_MATRIX_DEPTH = 64


def refuse_outside_matrix_objects(group, matrix_path):
    r"""Every object reachable under `/matrix` must live INLINE in this bundle's own matrix file (#462).

    `run_import` resolves `/matrix` and its members with a BARE subscript
    (`h5["matrix"]`, `group[member]`). h5py FOLLOWS an `h5py.ExternalLink`
    transparently, so a member that is an ExternalLink resolves to an ordinary inline
    `Dataset` IN ANOTHER FILE: `isinstance(..., h5py.Dataset)` is True, `.is_virtual`
    is False, `.external` is empty — every existing predicate passes and the counts
    come from a file OUTSIDE the bundle's matrix file. MEASURED through the shipped entrypoint on
    this base:

      * `/matrix/data` as an ExternalLink to an outside file holding all-7s data
        imported at rc 0 with a full store built from the outside file's values;
      * `/matrix/barcodes` as an ExternalLink to an outside file holding the bundle's
        own barcodes REVERSED imported at rc 0 with a silently MISLABELED store (the
        join passes — same SET — and the barcode axis ends up reversed);
      * a SoftLink CHAIN (`/matrix/data` -> SoftLink("/matrix/zzz") ->
        ExternalLink(outside.h5:/data)) walked straight through the member loop's
        own-link inspection, because `group.get(member, getlink=True)` inspects only
        the member's OWN link while `group[member]` resolves the WHOLE chain.

    So the rule is STRUCTURAL, not enumerated: every object reachable under `/matrix`
    must resolve to THIS file. `visititems` does NOT follow soft/external links and
    would silently skip exactly the objects this walk hunts, so the walk is written by
    hand: for every key of every group it visits, `get(key, getlink=True)` inspects
    the LINK before a guarded `group[key]` resolves it. An `ExternalLink` on any key
    of a group the walk VISITS (i.e. reachable from `/matrix`) is refused BY NAME —
    Space Ranger never writes one into a `filtered_feature_bc_matrix.h5`, and a
    matrix whose members are links to *anywhere* is not a matrix this importer can
    verify. A chain that routes an ExternalLink hop through a group OUTSIDE `/matrix`
    before returning to a same-file target is not named by this check — but such a
    chain still cannot bring in outside data: the realpath backstop below refuses any
    resolved object whose backing file differs from `matrix_realpath` (the file the
    located matrix path resolves to), regardless of which links it passed through.

    `seen` holds the HDF5 object ids already checked. A SoftLink can point at an
    ANCESTOR group, so the same object is reachable through many paths; without the
    set, a cyclic SoftLink (`/matrix/zzz` -> SoftLink("/matrix")) would be refused by
    the depth cap — a WRONG-but-terminating refusal — and `seen` turns that into a
    correct acceptance. `seen` guards CYCLES and NOT depth — the depth is bounded by
    [`MAX_MATRIX_DEPTH`], below.

    Depth is bounded twice over. The walk is ITERATIVE — an explicit stack of
    `(parent, key, path, depth)` tuples, so no recursion frame is consumed per level
    and a deep group nesting cannot blow Python's recursion limit into a raw
    `RecursionError`. And a path deeper than [`MAX_MATRIX_DEPTH`] levels under
    `/matrix` is a NAMED refusal.

    THE SCOPE OF THIS RULE (#508), AS THE OWNER'S OPTION-1 DECISION LEFT IT: the
    realpath/outside check above is a SAME-FILE check, not a bundle-root check —
    `matrix_realpath` is the realpath of the path [`locate_members`] LOCATED, so the
    walk pins each `/matrix` object's backing file to the file that path RESOLVES TO.
    The BUNDLE-ROOT containment check now lives at the END of [`locate_members`]:
    every bundle member — this matrix file's own path included — must realpath to a
    path under the bundle root. A filesystem symlink AT `filtered_feature_bc_matrix.h5`
    pointing OUTSIDE the bundle root is therefore REFUSED there, before this walk ever
    runs (the `.h5` OWN-path gap, MEASURED at rc 0 before this node — TEST-17's marked
    value landing in `expression.zarr`; TEST-18 is the inside-relative sibling, rc 0,
    accepted by the owner's option 1). This walk remains the same-FILE HDF5-object
    check ON TOP of that containment check: it is what stops an `h5py.ExternalLink`
    from feeding values that live in a file other than the located matrix file. The
    other members read by path — `tissue_positions.csv` (or its headerless sibling
    `tissue_positions_list.csv`), `scalefactors_json.json`, the placeable
    `VENDOR_IMAGES`, `metrics_summary.csv` and the `DIAGNOSTIC_BASENAMES` images — are
    contained by that same one check; the presence-only members
    (`NON_PLACEABLE_VENDOR_IMAGES`, the `cytassist_image` assay signal) are contained
    through their located candidates, and the bool is exempt (presence only, never
    opened).
    """
    import h5py
    import os

    matrix_realpath = os.path.realpath(matrix_path)
    seen = set()
    stack = [(group, None, "/matrix", 0)]
    while stack:
        parent, key, path, depth = stack.pop()
        if key is None:
            obj = parent
        else:
            # Resolve LAZILY at pop time, so only the object being processed is open
            # at once (an eager push loop opened every child and pinned it on the
            # stack) and a broken member is attributed to the FIRST one the walk
            # reaches in key order, not the last.
            try:
                obj = parent[key]
            except VisiumImportError:
                raise
            except (KeyError, OSError, TypeError, RuntimeError) as exc:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s "
                    f"{_quoted_for_refusal(path, noun='path')} link exists "
                    f"but its target cannot be read "
                    f"({_quoted_for_refusal(exc, noun='message')}). A 10x "
                    "feature-barcode matrix stores every value INLINE in its own "
                    "file; a member that cannot be read is not a matrix this "
                    "importer can carry. Refusing rather than handing a partial "
                    "matrix to the store writer."
                ) from None
        # FAIL CLOSED: the whole premise of this walk is "no data from outside the
        # bundle's matrix file", so an object whose backing file cannot be determined
        # is REFUSED, not admitted.
        try:
            obj_file = os.path.realpath(obj.file.filename)
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, RuntimeError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} is an "
                f"object whose backing file cannot be determined "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                "matrix stores every value INLINE in its own file; an object whose "
                "file cannot be determined cannot be verified to live in the bundle's "
                "located matrix file, so it cannot be imported. Refusing rather than "
                "shipping a wrong matrix."
            ) from None
        if obj_file != matrix_realpath:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} resolves "
                f"to {_quoted_for_refusal(obj_file, noun='file path')}, not the located "
                f"matrix file "
                f"{_quoted_for_refusal(matrix_realpath, noun='file path')}. A 10x "
                "feature-barcode matrix stores every value INLINE in its own file; an "
                "object whose values live in another file cannot be imported — the "
                "importer cannot know what it will read. Refusing rather than shipping "
                "a wrong matrix."
            )
        if depth > MAX_MATRIX_DEPTH:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} is "
                f"deeper than {int(MAX_MATRIX_DEPTH)} levels under `/matrix`. A 10x "
                "feature-barcode matrix stores its non-zero values, feature ids and "
                "column offsets as flat datasets a few levels deep; a group tree this "
                "deep is not a matrix this importer can carry. Refusing rather than "
                "handing it to the store writer."
            )
        # `obj.id` is hashed for the `seen` set, and h5py's `ObjectID.__hash__`
        # raises `TypeError` for an object it cannot identify — guard the read and
        # the set operations.
        try:
            obj_id = obj.id
            if obj_id in seen:
                continue
            seen.add(obj_id)
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, RuntimeError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} object "
                f"cannot be identified ({_quoted_for_refusal(exc, noun='message')}). A "
                "10x feature-barcode matrix stores every value INLINE in its own file; "
                "an object that cannot be identified is not a matrix this importer can "
                "carry. Refusing rather than handing a partial matrix to the store "
                "writer."
            ) from None
        if isinstance(obj, h5py.Group):
            # `obj.keys()` reads the group's link table, which a corrupt table
            # answers with `OSError`/`RuntimeError` — guard the read.
            try:
                keys = list(obj.keys())
            except VisiumImportError:
                raise
            except (KeyError, OSError, TypeError, RuntimeError) as exc:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} "
                    f"group cannot be enumerated "
                    f"({_quoted_for_refusal(exc, noun='message')}). A 10x "
                    "feature-barcode matrix stores every value INLINE in its own "
                    "file; a group whose members cannot be listed is not a matrix "
                    "this importer can carry. Refusing rather than handing a partial "
                    "matrix to the store writer."
                ) from None
            # Push in REVERSE key order so the LIFO stack pops the first key first,
            # reproducing a depth-first in-order descent.
            for key in keys[::-1]:
                # THE LINK IS INSPECTED BEFORE IT IS RESOLVED. h5py FOLLOWS an
                # `h5py.ExternalLink` transparently, so `parent[key]` would return an
                # ordinary object IN ANOTHER FILE — or, for a link back into this same
                # file, an object the realpath comparison cannot tell apart. Space
                # Ranger never writes an ExternalLink into a
                # `filtered_feature_bc_matrix.h5`, and a matrix whose members are
                # links to *anywhere* — even back into the same file — is not a
                # matrix this importer can verify.
                try:
                    link = obj.get(key, getlink=True)
                except VisiumImportError:
                    raise
                except (KeyError, OSError, TypeError, RuntimeError) as exc:
                    raise VisiumImportError(
                        f"{MATRIX_BASENAME}'s "
                        f"{_quoted_for_refusal(f'{path}/{key}', noun='path')} link "
                        f"cannot be inspected "
                        f"({_quoted_for_refusal(exc, noun='message')}). A 10x "
                        "feature-barcode matrix stores every value INLINE in its own "
                        "file; a link that cannot be inspected is not a matrix this "
                        "importer can carry. Refusing rather than handing a partial "
                        "matrix to the store writer."
                    ) from None
                if isinstance(link, h5py.ExternalLink):
                    raise VisiumImportError(
                        f"{MATRIX_BASENAME}'s "
                        f"{_quoted_for_refusal(f'{path}/{key}', noun='path')} is an "
                        "ExternalLink. A 10x feature-barcode matrix stores every value "
                        "INLINE in its own file; a link to another file cannot be "
                        "imported — the importer cannot know what it will read. "
                        "Refusing rather than shipping a wrong matrix."
                    )
                stack.append((obj, key, f"{path}/{key}", depth + 1))
        elif isinstance(obj, h5py.Dataset):
            is_virtual = bool(getattr(obj, "is_virtual", False))
            external = getattr(obj, "external", None) or ()
            if is_virtual or external:
                storage_kind = (
                    "a VIRTUAL dataset" if is_virtual
                    else "a dataset with EXTERNAL raw storage"
                )
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} is "
                    f"{storage_kind}. A 10x feature-barcode matrix stores every value "
                    "INLINE; a dataset whose values depend on files outside the "
                    "bundle's matrix file cannot be imported — the importer cannot know "
                    "what it will read, and an unresolvable source silently yields the "
                    "fill value rather than an error. Refusing rather than shipping a "
                    "wrong matrix."
                )
        elif isinstance(obj, h5py.Datatype):
            # A committed datatype holds no values and cannot reference another file's
            # data; `h5repack` and shared string-type dedup produce them. Skip it —
            # do not descend, do not refuse. (The realpath check above still catches a
            # committed datatype living in an external file.)
            continue
        else:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} is "
                f"neither a dataset nor a group "
                f"({_quoted_for_refusal(type(obj).__name__, noun='type name')}). A 10x "
                "feature-barcode matrix stores its non-zero values, feature ids and "
                "column offsets as flat datasets; anything else is not a matrix this "
                "importer can read. Refusing rather than handing it to the store writer."
            )


def refuse_aliased_matrix_members(group):
    r"""The seven consumed `/matrix` members must be SEVEN DISTINCT OBJECTS (#462).

    `run_import` consumes exactly seven members: `/matrix/barcodes`,
    `/matrix/features/id`, `/matrix/features/name`, `/matrix/shape`, `/matrix/data`,
    `/matrix/indices` and `/matrix/indptr`. A HARD LINK or a SAME-FILE SoftLink chain
    can make two of those names resolve to ONE object — MEASURED through the shipped
    entrypoint on this base:

      * `/matrix/features/id` as a HARD LINK to `/matrix/features/name` imported at
        rc 0 with `axis/gene_id.zarr` holding feature NAMES instead of ids;
      * `/matrix/data` as a HARD LINK to `/matrix/indices` imported at rc 0 with
        `expression.zarr/data` holding feature-id values instead of counts;
      * `/matrix/data` as a 15-hop SAME-FILE SoftLink chain ending at
        `/matrix/indices` imported at rc 0 with `expression.zarr/data` holding
        feature-id values instead of counts.

    The realpath check in [`refuse_outside_matrix_objects`] compares the FILE an
    object lives in, never the OBJECT a name resolves to — a same-file alias passes
    it. So the seven consumed members are resolved here and required to be seven
    DISTINCT HDF5 objects, identified by the file-number + object-address pair
    (`h5py.h5o.get_info(obj.id)` exposes `.fileno` and `.addr`), not by the Python
    object and not by `id()`.

    A legitimate bundle can never trip this: those seven are seven semantically
    distinct arrays and no writer aliases them. A member that is genuinely ABSENT is
    skipped — absence is refused by name elsewhere, and this check must not turn a
    clean "has no `/matrix/shape`" into a confusing collision message. The check is
    scoped to those seven consumed paths ONLY: an extra hard link or same-file
    SoftLink under `/matrix` under a name this importer does not consume is
    legitimate and must keep importing.
    """
    import h5py

    # The seven consumed members, as (label, member) pairs. Each label is a literal,
    # so a collision message can name both paths without a subscript.
    consumed = [
        ("/matrix/barcodes", "barcodes"),
        ("/matrix/features/id", "features/id"),
        ("/matrix/features/name", "features/name"),
        ("/matrix/shape", "shape"),
        ("/matrix/data", "data"),
        ("/matrix/indices", "indices"),
        ("/matrix/indptr", "indptr"),
    ]
    for label_a, member_a in consumed:
        identity_a = _matrix_member_identity(group, label_a, member_a)
        if identity_a is None:
            continue
        for label_b, member_b in consumed:
            if label_b == label_a:
                continue
            identity_b = _matrix_member_identity(group, label_b, member_b)
            if identity_b is not None and identity_b == identity_a:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s {_quoted_for_refusal(label_a, noun='path')} "
                    f"and {_quoted_for_refusal(label_b, noun='path')} are the SAME "
                    "object. A 10x feature-barcode matrix stores its barcodes, feature "
                    "ids, feature names, shape and counts triple as seven distinct "
                    "arrays; two of them resolving to one object means the matrix is "
                    "aliased and the importer cannot know which values it would read. "
                    "Refusing rather than shipping a wrong matrix."
                )


def _matrix_member_identity(group, label, member):
    """The (fileno, addr) identity of one consumed member, or None if it is genuinely absent.

    Absence is refused by name elsewhere, so a missing member is SKIPPED here — a
    collision check must not turn a clean "has no `/matrix/shape`" into a confusing
    collision message. An object whose identity cannot be determined is REFUSED: the
    whole point of the check is that the seven members are provably distinct, and an
    identity that cannot be read proves nothing.
    """
    import h5py

    try:
        obj = group[member]
    except VisiumImportError:
        raise
    except KeyError:
        return None
    except (OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s {_quoted_for_refusal(label, noun='path')} link exists "
            f"but its target cannot be read ({_quoted_for_refusal(exc, noun='message')}). A "
            "10x feature-barcode matrix stores its seven consumed members as seven distinct, "
            "readable objects; a member that cannot be read cannot be verified distinct, so "
            "it cannot be imported. Refusing rather than shipping a wrong matrix."
        ) from None
    try:
        info = h5py.h5o.get_info(obj.id)
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s {_quoted_for_refusal(label, noun='path')} object "
            f"identity cannot be determined "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
            "matrix stores its seven consumed members as seven distinct objects; an "
            "object whose identity cannot be determined cannot be verified distinct, "
            "so it cannot be imported. Refusing rather than shipping a wrong matrix."
        ) from None
    return (info.fileno, info.addr)


def refuse_malformed_shape(group):
    r"""The `/matrix/shape` dataset, validated BEFORE it is read (#451).

    `run_import` read `group["shape"][:]` and unpacked the result as a two-tuple with no
    validation, and `main()` catches only `VisiumImportError`. MEASURED through the shipped
    entrypoint on this base, five different malformed shapes each escaped as a raw
    traceback at exit 1 (INV-1's prohibited outcome):

      * `/matrix/shape` DELETED             -> `KeyError` from `group["shape"]`;
      * `/matrix/shape` = `[5]`             -> `IndexError` from the 2-tuple unpack;
      * `/matrix/shape` = `[b"XX", b"YY"]`  -> `ValueError` from `int(x)`;
      * `/matrix/shape` = `[[150,120],...]` -> `TypeError` from `int(x)`;
      * `/matrix/shape` a SCALAR dataset    -> `ValueError: Illegal slicing argument for
                                               scalar dataspace`.

    Each is refused BY NAME here, before the read, exactly the way
    [`refuse_malformed_counts`] validates a counts member. The one deliberate boundary: a
    shape whose values are ZERO is NOT refused — whether a zero-dimension matrix is
    importable at all is #445's decision, not this check's. Only NEGATIVE dimensions are
    refused.
    """
    import h5py

    if "shape" not in group:
        raise VisiumImportError(
            f"{MATRIX_BASENAME} has no `/matrix/shape`. A 10x feature-barcode matrix "
            "declares its dimensions as a two-element integer dataset under `/matrix`; a "
            "matrix without one cannot be imported. Refusing rather than guessing at the "
            "matrix's dimensions."
        )
    try:
        ds = group["shape"]
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
            "declares its dimensions as a two-element integer dataset under `/matrix`; a "
            "member that cannot be read is not a matrix this importer can carry. "
            "Refusing rather than handing a partial matrix to the store writer."
        ) from None
    if not isinstance(ds, h5py.Dataset):
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` is not a dataset "
            f"({_quoted_for_refusal(type(ds).__name__, noun='type name')}). A 10x "
            "feature-barcode matrix declares its dimensions as a two-element integer "
            "dataset under `/matrix`; anything else is not a matrix this importer can "
            "read. Refusing rather than handing it to the store writer."
        )
    # A VIRTUAL dataset or EXTERNAL raw storage is refused OUTRIGHT, without resolving its
    # sources and deciding — the same rule [`refuse_malformed_counts`] applies to the
    # counts members. A 10x Space Ranger matrix declares its shape INLINE; a virtual
    # dataset's values depend on files OUTSIDE the bundle's matrix file, and so does
    # HDF5 external raw storage, and an unresolvable source silently yields the FILL
    # VALUE rather than an error.
    is_virtual = bool(getattr(ds, "is_virtual", False))
    external = getattr(ds, "external", None) or ()
    if is_virtual or external:
        storage_kind = (
            "a VIRTUAL dataset" if is_virtual
            else "a dataset with EXTERNAL raw storage"
        )
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` is {storage_kind}. A 10x "
            "feature-barcode matrix declares its dimensions INLINE; a dataset whose "
            "values depend on files outside the bundle's matrix file cannot be "
            "imported — the importer cannot know what it will read, and an "
            "unresolvable source silently yields the fill value rather than an error. "
            "Refusing rather than shipping a wrong matrix."
        )
    if ds.shape is None or ds.shape == ():
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` is not a one-dimensional dataset "
            f"({_quoted_for_refusal(ds.shape, noun='shape')}). A 10x feature-barcode "
            "matrix declares its dimensions as a two-element integer dataset under "
            "`/matrix`; anything else is not a matrix this importer can read. Refusing "
            "rather than handing it to the store writer."
        )
    if ds.ndim != 1:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` is {int(ds.ndim)}-dimensional "
            f"(shape {_quoted_for_refusal(ds.shape, noun='shape')}). A 10x "
            "feature-barcode matrix declares its dimensions as a two-element integer "
            "dataset under `/matrix`; anything else is not a matrix this importer can "
            "read. Refusing rather than handing it to the store writer."
        )
    if ds.dtype.kind not in "iu":
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` is not stored as an integer "
            f"({_quoted_for_refusal(ds.dtype, noun='type name')}). A 10x feature-barcode "
            "matrix declares its dimensions as integers; anything else is not a matrix "
            "this importer can read. Refusing rather than handing it to the store writer."
        )
    # THE ELEMENT COUNT IS CHECKED FROM THE DATASET'S OWN METADATA, BEFORE ANY READ.
    # `ds.shape[0]` is the DECLARED element count, and a hostile `/matrix/shape` of shape
    # `(10**9,)` would otherwise be fully read into memory before the element-count
    # refusal fired — this branch exists precisely for hostile files, and this module's
    # stated principle elsewhere is that reads are bounded. The declared count is enough
    # to refuse it, so the refusal fires without materialising a single value.
    if int(ds.shape[0]) != 2:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` has {int(ds.shape[0])} element(s); a "
            "10x feature-barcode matrix declares exactly two dimensions, `[n_features, "
            "n_barcodes]`. Refusing rather than guessing at the matrix's dimensions."
        )
    # The read itself is guarded too, the way [`refuse_malformed_counts`] guards its
    # `indptr` read: a dataset whose METADATA is fine but whose BYTES are undecodable (an
    # unavailable filter, a truncated chunk, a fletcher32 checksum failure) raises `OSError`
    # here rather than inside the writer.
    try:
        values = [int(x) for x in np.asarray(ds[:]).tolist()]
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
            "declares its dimensions as a two-element integer dataset under `/matrix`; a "
            "member that cannot be read is not a matrix this importer can carry. "
            "Refusing rather than handing a partial matrix to the store writer."
        ) from None
    # The post-read element-count check is KEPT as a backstop: the metadata check above
    # already fires for any declared count other than two, so this arm is unreachable for
    # a well-formed 1-D dataset — but if the metadata and the bytes ever disagreed, the
    # refusal would still be named rather than a later unpack raising raw.
    if len(values) != 2:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` has {len(values)} element(s); a 10x "
            "feature-barcode matrix declares exactly two dimensions, `[n_features, "
            "n_barcodes]`. Refusing rather than guessing at the matrix's dimensions."
        )
    # NEGATIVE only. A shape whose values are ZERO is deliberately NOT refused here: whether
    # a zero-dimension / zero-count matrix is importable at all is #445's decision, and
    # refusing zero would pre-empt it.
    if values[0] < 0 or values[1] < 0:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/shape` is "
            f"{_quoted_list_for_refusal(values, noun='dimension')}; a 10x feature-barcode "
            "matrix declares non-negative dimensions, `[n_features, n_barcodes]`. "
            "Refusing rather than guessing at the matrix's dimensions."
        )
    return [int(values[0]), int(values[1])]


def _refuse_malformed_member_dataset(group, member, label, *, absent_what,
                                     unreadable_what, not_dataset_what, inline_what,
                                     must_be_string=False):
    r"""One member dataset under `/matrix` (or `/matrix/features`), in its FOUR states.

    ABSENT / PRESENT-BUT-UNREADABLE / NOT-A-DATASET / VIRTUAL-OR-EXTERNAL — the same
    treatment [`refuse_unreadable_matrix_group`] gives `/matrix`,
    [`refuse_malformed_shape`] gives `/matrix/shape`, and [`refuse_malformed_counts`]
    gives the three counts members. Hoisted so `/matrix/barcodes` gets the treatment
    its two neighbours (`/matrix/features/id` and `/matrix/features/name`) already get
    WITHOUT a fourth inline spelling of the same validation (Finding C).

    `must_be_string` is the optional FIFTH state: the member must be stored as an HDF5
    STRING. The three string members (`/matrix/barcodes`, `/matrix/features/id`,
    `/matrix/features/name`) pass `must_be_string=True`. The check is
    `h5py.check_string_dtype(ds.dtype)`, which returns a truthy `StringInfo` for a real
    HDF5 string dtype — fixed-length `|S` bytes OR a variable-length string — and `None`
    for everything else, INCLUDING a variable-length INT (`h5py.vlen_dtype(np.int32)`),
    whose numpy kind is `O` just like a vlen string's. The round-1 check matched on
    numpy KIND (`kinds="SO"`), so a vlen-int member passed it and was then
    `str()`-coerced by [`decoded_h5_strings`] into plausible-looking garbage ("[0 1]",
    "[1 2]", ...) and imported at rc 0 — MEASURED: `/matrix/features/id` recreated as
    vlen-int imports at rc 0 with the arrays stringified as gene ids, and
    `/matrix/barcodes` as vlen-int sails past the matrix validation and dies at the
    positions join AFTER the first writer, leaving 51 paths on disk. The check fires
    BEFORE the first writer, closing the INV-2 violation.

    Each arm takes its OWN rationale sentence — `absent_what`, `unreadable_what`,
    `not_dataset_what` and `inline_what` — so the reason always describes the case it
    fires on: a member that is PRESENT is never refused with a reason about a MISSING
    one, and a member that is a GROUP is never refused with a reason about an absent
    dataset. All four are PROSE, passed as literals at every call site, so the #336
    structural guard can prove them safe.
    """
    import h5py

    if member not in group:
        raise VisiumImportError(
            f"{MATRIX_BASENAME} has no `{label}`. {absent_what} Refusing rather than "
            "importing a matrix whose member cannot be read."
        )
    # PRESENT but UNREADABLE is a different defect from ABSENT, and the operator needs
    # to know which. `"member" in group` is `H5Lexists`, which answers about the LINK,
    # not its target: a DANGLING SoftLink/ExternalLink answers True to `in` while
    # `group[member]` raises `KeyError`/`OSError`. Without this guarded subscript the
    # link's existence would be reported one level down inside `decoded_h5_strings` as
    # "has no `{label}`" — a FALSE reason (the link exists, its target does not), the
    # same defect class #451's first item removes one level up.
    try:
        ds = group[member]
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` link exists but its target cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). {unreadable_what} Refusing "
            "rather than importing a matrix whose member cannot be read."
        ) from None
    if not isinstance(ds, h5py.Dataset):
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` is not a dataset "
            f"({_quoted_for_refusal(type(ds).__name__, noun='type name')}) and so "
            f"cannot be read as a list of values. {not_dataset_what} Refusing rather "
            "than importing a matrix whose member cannot be read."
        )
    # THE STRING-DTYPE STATE (#506). `decoded_h5_strings` decodes exactly two HDF5 string
    # kinds — fixed-length `|S` bytes and variable-length strings — and `str()`-coerces
    # EVERYTHING else into plausible-looking garbage: an int32 `/matrix/features/id`
    # imports at rc 0 with the ints stringified as gene ids, and an int32
    # `/matrix/barcodes` sails past the matrix validation and dies at the positions join
    # AFTER the first writer (51 paths on disk). The check is `h5py.check_string_dtype`,
    # NOT a numpy-kind test: kind `O` is ALSO how h5py spells every variable-length type,
    # so `kinds="SO"` admitted a vlen-INT (`h5py.vlen_dtype(np.int32)`) whose arrays were
    # then stringified as "[0 1]", "[1 2]", ... — the same silent-garbage harm. The check
    # fires here, before the read it protects and before the first writer.
    if must_be_string and h5py.check_string_dtype(ds.dtype) is None:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` is not stored as a string "
            f"({_quoted_for_refusal(ds.dtype, noun='type name')}). A 10x feature-barcode "
            "matrix stores its barcodes and feature ids and names as strings; anything "
            "else is not a matrix this importer can read. Refusing rather than importing "
            "a matrix whose identities cannot be read."
        )
    # A VIRTUAL dataset or EXTERNAL raw storage is refused OUTRIGHT, without resolving
    # its sources and deciding — the same rule [`refuse_malformed_shape`] and
    # [`refuse_malformed_counts`] apply to their members. A 10x Space Ranger matrix
    # declares its members INLINE; a virtual dataset's values depend on files OUTSIDE
    # the bundle's matrix file, and so does HDF5 external raw storage, and an
    # unresolvable source silently yields the FILL VALUE rather than an error.
    is_virtual = bool(getattr(ds, "is_virtual", False))
    external = getattr(ds, "external", None) or ()
    if is_virtual or external:
        storage_kind = (
            "a VIRTUAL dataset" if is_virtual
            else "a dataset with EXTERNAL raw storage"
        )
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` is {storage_kind}. {inline_what} Refusing "
            "rather than shipping a wrong matrix."
        )
    return ds


def refuse_malformed_features(group):
    r"""The `/matrix/features` group, validated BEFORE the call sites read it (#451).

    `run_import` subscripted `group["features"]` AT THE CALL SITES
    (`decoded_h5_strings(group["features"], "id", ...)`), i.e. OUTSIDE
    `decoded_h5_strings`' own try/except, so a missing or wrong-kind `/matrix/features`
    escaped as a raw traceback at exit 1. MEASURED through the shipped entrypoint on this
    base: deleting `/matrix/features` escaped as

        rc=1  paths=0
        KeyError: "Unable to synchronously open object (object 'features' doesn't exist)"

    — INV-1's prohibited outcome. This check validates the group BEFORE those call sites:
    present, readable, a GROUP (not a dataset), and carrying the `id` and `name` datasets
    a 10x feature-barcode matrix puts under `/matrix/features`.

    Each of `id` and `name` is then checked in the SAME four states
    [`_refuse_malformed_member_dataset`] draws for every member dataset: ABSENT (the
    message above), PRESENT-BUT-UNREADABLE (a dangling SoftLink/ExternalLink — the link
    exists, its target does not), PRESENT-BUT-NOT-A-DATASET (a group where the dataset
    belongs), and VIRTUAL-OR-EXTERNAL raw storage. Without the unreadable arm a dangling
    link or a wrong-kind member passed this validator and was caught one
    level down inside `decoded_h5_strings`, which reported "has no `/matrix/features/id`"
    for a link that EXISTS — a refusal whose stated reason is not the real one, the same
    defect class #451's first item removes one level up. `decoded_h5_strings`' guards are
    NOT weakened: they stay as the backstop for everything this check does not reach.
    """
    import h5py

    if "features" not in group:
        raise VisiumImportError(
            f"{MATRIX_BASENAME} has no `/matrix/features`. A 10x feature-barcode matrix "
            "carries its feature `id` and `name` datasets under a `/matrix/features` "
            "group; a matrix without one cannot be imported, because there would be "
            "nothing to name the counts. Refusing rather than importing a matrix whose "
            "features cannot be named."
        )
    try:
        features = group["features"]
    except VisiumImportError:
        raise
    except (KeyError, OSError, TypeError, RuntimeError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/features` cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
            "carries its feature `id` and `name` datasets under a `/matrix/features` "
            "group; a member that cannot be read is not a matrix this importer can "
            "carry. Refusing rather than importing a matrix whose features cannot be "
            "named."
        ) from None
    if not isinstance(features, h5py.Group):
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `/matrix/features` is not a group "
            f"({_quoted_for_refusal(type(features).__name__, noun='type name')}). A 10x "
            "feature-barcode matrix carries its feature `id` and `name` datasets under a "
            "`/matrix/features` group; anything else is not a matrix this importer can "
            "read. Refusing rather than importing a matrix whose features cannot be "
            "named."
        )
    for member in ("id", "name"):
        # Each member is checked in the SAME four states [`_refuse_malformed_member_dataset`]
        # draws for every member dataset: ABSENT, PRESENT-BUT-UNREADABLE (a dangling
        # SoftLink/ExternalLink — the link exists, its target does not), PRESENT-BUT-NOT-A-
        # DATASET (a group where the dataset belongs), and VIRTUAL-OR-EXTERNAL raw storage.
        # Without the unreadable arm a dangling link passed this validator and was caught
        # one level down inside `decoded_h5_strings`, which reported "has no
        # `/matrix/features/id`" for a link that EXISTS — a refusal whose stated reason is
        # not the real one, the same defect class #451's first item removes one level up.
        # `decoded_h5_strings`' guards are NOT weakened: they stay as the backstop for
        # everything this check does not reach.
        _refuse_malformed_member_dataset(
            features, member, f"/matrix/features/{member}",
            absent_what="A 10x feature-barcode matrix carries its feature `id` and "
                        "`name` datasets under `/matrix/features`; a matrix missing "
                        "one of them cannot be imported, because there would be "
                        "nothing to name the counts.",
            unreadable_what="A 10x feature-barcode matrix carries its feature `id` and "
                            "`name` datasets under `/matrix/features`; a member that "
                            "cannot be read is not a matrix this importer can carry.",
            not_dataset_what="A 10x feature-barcode matrix stores its feature `id` and "
                             "`name` as datasets under `/matrix/features`; anything that "
                             "is not a dataset is not a matrix this importer can read.",
            inline_what="A 10x feature-barcode matrix stores its feature `id` and "
                        "`name` datasets INLINE; a dataset whose values depend on "
                        "files outside the bundle's matrix file cannot be imported — "
                        "the importer cannot know what it will read, and an "
                        "unresolvable source silently yields the fill value rather "
                        "than an error.",
            must_be_string=True,
        )


def locate_members(root):
    """Find the Space Ranger members under `root`, BY BASENAME, exactly as the container
    declares them (`spatial/visium-bundle.input_requirements.members`).

    A Space Ranger `outs/` tree nests `spatial/` under the run directory, and an upload
    may flatten it, so the search is recursive. Grouping returns nothing unless EXACTLY
    ONE file matches each member — the same rule the upload planner used to build this
    dataset — so an ambiguous match is refused here too rather than resolved by depth or
    by alphabetical order.

    #508 — THE UNIFORM CONTAINMENT RULE, STATED HERE BECAUSE THIS IS WHERE A READER
    LOOKS: since the owner's option-1 decision for issue #508, ONE containment check
    lives at the END of this locator — every bundle member must realpath to a path
    under the bundle root. The members the importer READS BY PATH are found by basename
    here and opened by path there, so a filesystem symlink at one of their paths
    pointing OUTSIDE the bundle root is followed and its bytes read (issue #508;
    MEASURED at rc 0 through the shipped entrypoint BEFORE this node — see the flipped
    pins in `tests/test_508_symlinked_members.py`, which now assert the refusal). The
    members covered are:
      * `filtered_feature_bc_matrix.h5` — NOW just another located member, so the
        `.h5` OWN-path gap is CLOSED (the matrix file's own path is contained by the
        same check as every other member). [`refuse_outside_matrix_objects`] remains a
        SAME-FILE HDF5-object check ON TOP of it: it pins each `/matrix` object's
        backing file to the file this path RESOLVES TO, which a filesystem symlink AT
        the matrix path used to defeat (MEASURED before this node — TEST-17: rc 0 and
        the outside matrix's marked value landing in `expression.zarr`; TEST-18: the
        inside-relative sibling, rc 0, accepted by option 1).
      * `tissue_positions.csv` and its headerless sibling
        `tissue_positions_list.csv` — read by [`read_positions`];
      * `scalefactors_json.json` — read by [`read_scalefactors`];
      * the placeable `VENDOR_IMAGES` (`tissue_hires_image.png`,
        `tissue_lowres_image.png`) — read by [`emit_images`] and converted to
        `spatial/image`;
      * `metrics_summary.csv` — read by [`vendor_provenance`] for the provenance
        (`sample_id` and the reference/probe-set fields) and the report (an OPTIONAL
        member: when absent, `members["metrics"]` is `None`; the check walks EVERY
        [`found`] candidate of this basename, because an ambiguous match stores `None`
        and would otherwise evade the rule through its second, possibly outside-resolving
        candidate — F-1);
      * the `DIAGNOSTIC_BASENAMES` images (`aligned_fiducials.jpg`,
        `detected_tissue_image.jpg`, `aligned_tissue_image.jpg`) — read by
        [`inline_diagnostic`] into the report's embedded `data:` URIs; the check walks
        EVERY [`found`] candidate of these basenames for the same reason (an ambiguous
        match keeps NONE of them in `members["diagnostics"]` unless it is unique — F-1);
      * every located CANDIDATE of the presence-only members too —
        `NON_PLACEABLE_VENDOR_IMAGES` (`cytassist_image.tiff` and its siblings) and
        `ambiguous_images` are checked through the [`found`] candidates they were built
        from, because the members' own values are a spec dict / a basename string with
        no directory: realpath of a dict raises and realpath of a bare basename
        resolves against the process CWD (both MEASURED — the over-refusal causes).
        The `cytassist_image` assay signal (a BOOL, presence only, never opened) is
        EXEMPT — never passed to realpath.
    THE STAGED-ROOT CRUX (MEASURED): `root` at this point is the UNRESOLVED
    `/inputs/<name>` staging symlink on every entrypoint run (`_entry_invocation`
    symlinks the top-level inputs mount; `load_inputs_index` returns it unresolved),
    so the comparison realpaths BOTH sides — `realpath(member)` vs
    `realpath(root) + os.sep`. Comparing against `str(root)` instead refuses EVERY
    staged bundle (STEP0-MEASUREMENT §1, §3(ii)): members realpath under the real dir,
    the raw root does not.
    """
    root = Path(root)
    if root.is_file():
        root = root.parent
    found = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        found.setdefault(path.name, []).append(path)

    # VISIUM HD IS REFUSED, BY NAME (DEC-5). Its `binned_outputs/square_*um/` directories
    # hold identically-named files, so every member has several candidates and the
    # ambiguity below would fire with a message about duplicates rather than about the
    # platform. A previous version of this message pointed its reader at #160 — which
    # CLOSED without ever shipping an importer (measured 2026-09-26), so the pointer
    # outlived the issue it pointed to — and the reader is now told to import it with
    # `Import Visium HD (Space Ranger binned_outputs)` instead. #160 is named here as
    # HISTORY, never as a destination: a closed issue is a legitimate citation, never
    # somewhere to go.
    if any(p.name == "binned_outputs" or "binned_outputs" in p.parts
           for p in root.rglob("binned_outputs")):
        raise VisiumImportError(
            "this is a Visium HD bundle (`binned_outputs/` is present) and this importer "
            "reads standard Visium only. HD emits several bin resolutions from one run "
            "under identically-named files, which defeats the bundle container's "
            "basename member matching entirely — it needs a per-bin upload or a "
            "directory-aware matcher. Import it with "
            "`Import Visium HD (Space Ranger binned_outputs)` instead; "
            "picking one bin here would hide the platform gap rather than close it."
        )

    def one(basenames, what):
        hits = [p for name in basenames for p in found.get(name, [])]
        if not hits:
            raise VisiumImportError(
                f"the bundle has no {what} (looked for {' / '.join(basenames)} anywhere "
                f"under {_quoted_for_refusal(root)}). A Space Ranger `outs/` bundle carries all "
                f"four declared "
                f"members; an incomplete one cannot be imported, and importing part of it "
                f"would produce coordinates with no matrix to align to."
            )
        if len(hits) > 1:
            raise VisiumImportError(
                f"the bundle has {len(hits)} candidates for {what} "
                f"{_quoted_list_for_refusal([p.relative_to(root) for p in hits])}. Member "
                f"matching "
                f"is by basename and is unambiguous by design; choosing one here would be "
                f"a guess about which run's data this is."
            )
        return hits[0]

    members = {
        "matrix": one((MATRIX_BASENAME,), "filtered feature-barcode matrix"),
        "positions": one(POSITIONS_BASENAMES, "tissue positions table"),
        "scalefactors": one((SCALEFACTORS_BASENAME,), "scale factors"),
    }
    # Optional, read for provenance and the report only. The CHECK below covers every
    # `found` candidate of this basename even though the member stores only the unique
    # one (an ambiguous match stores None with NEITHER candidate listed — F-1).
    for name, key in (("metrics_summary.csv", "metrics"),):
        hits = found.get(name, [])
        members[key] = hits[0] if len(hits) == 1 else None
    # Ambiguous or absent diagnostics stay out of the list (never opened), but the CHECK
    # covers every candidate basename (F-1); the member list itself is unchanged.
    members["diagnostics"] = [
        found[name][0] for name in DIAGNOSTIC_BASENAMES if len(found.get(name, [])) == 1
    ]
    # The vendor images, in declaration order (#155). Each is OPTIONAL and each is emitted
    # as its OWN `spatial/image` in the SAME coordinate space with its OWN affine. An
    # ambiguous match is skipped for the same reason `one()` refuses it: choosing between
    # two files of the same name would be a guess about which run's data this is — but it
    # is REPORTED rather than merely skipped, because an optional member that vanishes in
    # silence is what `images_not_emitted` exists to prevent.
    members["images"] = [
        dict(spec, path=found[spec["basename"]][0])
        for spec in VENDOR_IMAGES
        if len(found.get(spec["basename"], [])) == 1
    ]
    members["ambiguous_images"] = [
        spec["basename"] for spec in VENDOR_IMAGES
        if len(found.get(spec["basename"], [])) > 1
    ]
    # Vendor images this importer will never emit (#257 / DEC-5). Located rather than ignored
    # for exactly one reason: `emit_images` has to be able to SAY that one was here and was
    # not emitted, which is a different fact from there having been none. Recorded by
    # PRESENCE, not by path — nothing reads the bytes — so an ambiguous match is still a
    # presence, unlike `VENDOR_IMAGES` where two candidates mean "which run's data is this?".
    members["non_placeable_images"] = [
        spec for spec in NON_PLACEABLE_VENDOR_IMAGES if found.get(spec["basename"])
    ]
    # The CytAssist image as an ASSAY signal (`detect_assay`), which is a different use from
    # the line above and is why it is its own key: that one drives a report note, this one is
    # corroboration for a classification and is never decisive.
    members["cytassist_image"] = bool(found.get(CYTASSIST_IMAGE_BASENAME))

    # #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath
    # to a path under the bundle root. ONE containment check, at the END of this locator,
    # because every consumer reads through the `members` dict (the single choke point).
    # MEASURED (STEP0-MEASUREMENT.md), the two traps this predicate exists to dodge:
    # (i) the raw `root` is the UNRESOLVED `/inputs/<name>` staging symlink
    # (`_entry_invocation` symlinks the inputs mount; `load_inputs_index` returns it
    # unresolved), so the comparison realpaths BOTH sides — against `str(root)` every
    # staged bundle would refuse; (ii) the values that are NOT paths must never be
    # realpath'd: `non_placeable_images` are spec DICTS and `ambiguous_images` are
    # BASENAME STRINGS (realpath of a dict is a TypeError; realpath of a bare basename
    # resolves against the process CWD), so those two are checked through the `found`
    # candidates they were built from. Path-bearing members are checked directly, but the
    # OPTIONAL ones — `metrics` and the `DIAGNOSTIC_BASENAMES` — have the check walk EVERY
    # `found` candidate, not only the path `members` stores: when a basename has TWO
    # candidates the member stores neither (the diagnostic keeps `found[name][0]` only on
    # len == 1, `metrics` becomes `None`), so the single stored path would miss the
    # outside-resolving second candidate — the same escape class `ambiguous_images`
    # already closes for the vendor images (F-1, DEC-16). `metrics` is `None`-safe (both
    # committed CytAssist fixtures carry `metrics = None`) and `cytassist_image` (bool,
    # presence only, never opened) is EXEMPT. Kept as ONE line so the module-wide
    # realpath-site pin (TEST-13) still counts exactly three.
    located_paths = ([members["matrix"], members["positions"], members["scalefactors"]]
                     + [candidate for candidate in found.get("metrics_summary.csv", ())]
                     + [candidate for name in DIAGNOSTIC_BASENAMES
                        for candidate in found.get(name, ())]
                     + [image["path"] for image in members["images"]]
                     + [candidate for spec in members["non_placeable_images"]
                        for candidate in found.get(spec["basename"], ())]
                     + [candidate for name in members["ambiguous_images"]
                        for candidate in found.get(name, ())])
    for p in located_paths:
        if not (_resolved := os.path.realpath(p)).startswith((_root_real := os.path.realpath(root)) + os.sep):
            raise VisiumImportError(
                f"{_quoted_for_refusal(p.name, noun='member name')} resolves to "
                f"{_quoted_for_refusal(_resolved, noun='resolved path')} (it was located "
                f"at {_quoted_for_refusal(p, noun='located path')}), which is outside the "
                "bundle root. Every bundle member must realpath to a path under the "
                "bundle root: a member whose bytes come from outside the bundle root is "
                "not part of the Space Ranger bundle this importer can verify. Refusing "
                "rather than importing a bundle member whose bytes come from outside the "
                "bundle root."
            )
    return members


def read_positions(path):
    """`tissue_positions[_list].csv` -> a dict of column name -> list, honouring BOTH
    vendor spellings.

    Space Ranger <= 1.x wrote a HEADERLESS `tissue_positions_list.csv` whose meaning is
    entirely positional; >= 2.0 wrote a HEADERED `tissue_positions.csv`. The header is
    detected by looking for the literal `barcode` in field 0 of row 1 rather than by the
    filename, because an uploader may rename a file and a positional read of a headered
    file would silently take the header row as a spot.
    """
    # `encoding="utf-8"`, not the LOCALE default (#330 FIX_ROUND-1). Without it this read
    # decodes with whatever `LC_ALL` says: MEASURED on an ORDINARY bundle whose positions table
    # carries a legitimate UTF-8 barcode, `LC_ALL=C` gave an uncaught `UnicodeDecodeError`,
    # exit 1 and 51 paths already under `/outputs` — the same shape #330 reports for a hostile
    # bundle, on a bundle with nothing wrong with it. A producer's text READ is as much part of
    # its refusal contract as its text write; guarding only the writes was half the rule.
    #
    # `utf-8-sig`, matching `spatial-import-xenium`'s `read_cells_csv`, which takes it for
    # exactly this reason. The first version of this comment argued the OPPOSITE -- that the
    # header check below already strips a BOM "and it must keep doing so for the HEADERLESS
    # spelling too" -- and a blind angle measured that backwards. The header check `lstrip`s the
    # BOM off a TEMPORARY `header` list that the headerless branch then DISCARDS, and `.strip()`
    # does not remove `U+FEFF` (it is `Cf`, not whitespace), so the BOM survived into the
    # barcode:
    #
    #     HEADERED   + BOM ->  barcode 'AAA-1'        rc=0, 119 paths
    #     HEADERLESS + BOM ->  barcode '\ufeffAAA-1'   rc=2, 51 paths
    #                          ("1 of the matrix's 120 barcodes have no row")
    #
    # `utf-8-sig` is precisely what fixes the headerless case. The `lstrip` below is kept as a
    # no-op belt on the headered path rather than removed, because a file can be BOM-free and
    # still be re-encoded by a hand-edit later.
    try:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            rows = list(csv.reader(fh))
    except csv.Error as exc:
        # THE SAME HOLE ONE EXCEPTION TYPE OVER (#336 / DEC-5), found by REPRODUCING #336 rather
        # than reported in it. `csv` refuses a field over 131,072 characters, and that
        # `_csv.Error` is not a `VisiumImportError`, so `main()` did not catch it either.
        # MEASURED on `c34b3a1f`, one positions field of 200,000 characters:
        #
        #     rc=1  _csv.Error: field larger than field limit (131072)   <- UNCAUGHT, traceback
        #
        # which is the identical prohibited outcome the `UnicodeDecodeError` arm below was added
        # to remove, reached by the identical hostile vendor text. The limit is `csv`'s own and is
        # deliberately NOT raised: a positions field is a barcode or a number, and a 131,072-
        # character one is not a value this importer should be trying to read.
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} cannot be read as CSV "
            f"({_quoted_for_refusal(exc, noun='message')}). A Visium positions table holds one "
            "barcode and five numbers per row; a field this importer cannot read as a field "
            "means the file is not that table. Re-export the bundle from Space Ranger."
        ) from None
    except UnicodeDecodeError as exc:
        # NAMED, not a traceback. `main()` catches only `VisiumImportError`, so before this a
        # positions table with one invalid byte was a stack trace and exit 1.
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} is not valid UTF-8 "
            f"({_quoted_for_refusal(exc, noun='message')}). Its first column is the BARCODE, "
            "which is "
            "the key this importer joins the matrix on, so it cannot be decoded loosely without "
            "silently pairing one spot's position with another spot's counts. Re-export the "
            "bundle from Space Ranger."
        ) from None
    if not rows:
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} is empty — it carries no spot "
            "positions."
        )
    header = [c.strip() for c in rows[0]]
    if header and header[0].lstrip("﻿").strip().lower() == "barcode":
        names, body = header, rows[1:]
        names[0] = "barcode"
    else:
        names, body = list(POSITION_COLUMNS), rows
    missing = [c for c in POSITION_COLUMNS if c not in names]
    if missing:
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} is missing column(s) "
            f"{_quoted_list_for_refusal(missing, noun='column name')}; a Visium positions table "
            f"carries {list(POSITION_COLUMNS)}. Found "
            f"{_quoted_list_for_refusal(names, noun='column name')}."
        )
    idx = {c: names.index(c) for c in POSITION_COLUMNS}
    out = {c: [] for c in POSITION_COLUMNS}
    for r, row in enumerate(body):
        if not row or all(not c.strip() for c in row):
            continue
        if len(row) < len(names):
            raise VisiumImportError(
                f"{_quoted_for_refusal(path.name, noun='file name')} row {r + 1} has "
                f"{len(row)} fields, fewer than the "
                f"{len(names)} the table declares — a short row would shift every "
                f"column after it."
            )
        for c in POSITION_COLUMNS:
            out[c].append(row[idx[c]].strip())
    return out


def read_scalefactors(path):
    r"""`scalefactors_json.json` -> a dict, or `{}` when it cannot be parsed.

    Returning `{}` rather than raising is deliberate and is the whole of INV-6's negative
    leg: a bundle with a damaged scale file is still importable — the coordinates are
    still correct in pixels — it simply DECLARES NO SCALE, and a consumer that needs
    microns then refuses. What is refused is inventing one.

    "or `{}` when it is ABSENT" is what this line used to say, and it was FALSE: an absent
    scale file never reaches here at all, because `locate_members`' `one()` refuses the
    bundle first ("the bundle has no scale factors"). Measured identically on `origin/main`.
    The `OSError` arm is therefore reachable only for a file that exists and cannot be
    opened. The paragraph below said "An ABSENT or UNPARSEABLE file is DAMAGED" eight lines
    after this correction, contradicting it; it now says UNPARSEABLE alone.

    ## THE SECOND PARSE BOUNDARY (#330), and it is a DIFFERENT fact from the one above

    An UNPARSEABLE file is DAMAGED: something is missing, and `{}` says so honestly.
    A file that parses CLEANLY and carries a string this importer cannot write is MALFORMED —
    nothing is missing, so nothing is being invented, and the document is refused as a whole
    (DEC-3). `json.loads` ACCEPTS a `"\ud800"` escape out of a file that is itself PURE ASCII,
    and the whole parsed document is echoed into `visium-import-report.json` under
    `"scalefactors"`: MEASURED on the committed fixture, an added `"vendor_note": "\ud800BAD"`
    left the import reporting SUCCESS with the escape at report line 22 — an artifact
    `serde_json`, the crate the server parses it with, then refuses.

    `VisiumImportError` subclasses `RuntimeError`, and so does `RecursionError`, which is why the
    narrowing below names all three of `(OSError, ValueError, RecursionError)` explicitly rather
    than catching `RuntimeError`: the refusal must propagate while the parser's own depth failure
    must not. The refusal is raised AFTER the narrowing so that only a real vendor document
    reaches it.
    """
    try:
        # `encoding="utf-8"`, not the locale default (#330 FIX_ROUND-1). MEASURED: with the
        # locale default, an ORDINARY bundle whose scale file carries legitimate UTF-8 (a `µ`)
        # decoded fine under a UTF-8 locale and raised `UnicodeDecodeError` under `LC_ALL=C` —
        # which, being a `ValueError`, was swallowed by the arm below into `{}`. The same bundle
        # then reported `microns_per_pixel: null` and a `scale_note` saying the file "declares
        # neither `microns_per_pixel` nor `spot_diameter_fullres`", which is a FALSE statement
        # about the vendor's document, produced by the machine's locale. That is the "declare a
        # value the vendor did not write" defect §2 exists to prevent, arriving from the
        # environment.
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        # `RecursionError` subclasses `RuntimeError`, NOT `ValueError`, so a deeply nested
        # vendor document walked straight past this arm and out through `main()` as a raw
        # traceback. MEASURED: `json.loads` raises it at nesting depth >= 992 on a file that is
        # otherwise pure ASCII. A document too deep for the parser is UNPARSEABLE, which is
        # exactly the case this arm exists for.
        return {}
    if not isinstance(doc, dict):
        return {}
    refuse_unencodable_vendor_text(
        doc,
        source=f"`{SCALEFACTORS_BASENAME}`",
        remedy=(
            "Re-export the bundle from Space Ranger; if the file was hand-edited, restore the "
            "vendor's own text."
        ),
    )
    return doc


def micron_scale(scalefactors, *, rendered_spot_diameter_um):
    """`(microns_per_pixel_or_None, source)` — the physical scale of the pixel frame.

    Three legs, in order (DEC-6), and the leg used is RECORDED so a stated number and a
    derived one stay distinguishable downstream:

    1. the vendor STATES `microns_per_pixel` -> use it verbatim (`"vendor"`);
    2. it states only `spot_diameter_fullres` ->
       `rendered_spot_diameter_um / spot_diameter_fullres`
       (`"derived-from-spot-diameter"`). This is the ratio of a vendor-stated number to the
       physical size of THE CIRCLE THAT NUMBER MEASURES. The numerator is therefore
       [`VISIUM_RENDERED_SPOT_DIAMETER_UM`] (65 um) and never the capture footprint (55 um):
       `spot_diameter_fullres` is the circle Space Ranger writes for RENDERING, and it is
       larger than the capture spot. Dividing by the capture footprint instead is #222 — it
       under-estimates um/pixel by 1 - 55/65 = 15.4%, silently, on every Visium import. The parameter is
       named for the circle rather than for a "resolution" precisely because the old name is
       what licensed that substitution;
    3. neither -> `(None, "unavailable")`. NO `microns_per_pixel` key is written, and
       `SD.require_micron_scale` then REFUSES. Never 1.0.

    Leg 2 is not a nicety. Measured against three real 10x bundles — Space Ranger 1.1.0
    `V1_Human_Lymph_Node`, 1.3.0 `Visium_FFPE_Mouse_Brain` and 2.0.0
    `Visium_Mouse_Olfactory_Bulb` — `scalefactors_json.json` ships exactly four keys and
    NONE of them is `microns_per_pixel`; the field is a Visium HD / newer-Space-Ranger
    addition. A vendor-only rule would therefore leave the COMMON case with no scale and
    every neighbour-graph analysis refusing, which is the outcome the field exists to
    prevent.
    """
    # BOTH LEGS THROUGH THE SAME PREDICATE (#257 round 2). This used to inline
    # `isinstance(...) and not bool and > 0`, which admits two values that are not scales:
    # `Infinity` (which `json.loads` accepts, and which then declares an infinite micron
    # scale), and a Python `int` too large for a double — on which the `float(...)` two lines
    # down raises `OverflowError` and aborts the whole import.
    #
    # THE SECOND IS WHY THIS IS IN #257'S SCOPE RATHER THAN LEFT AS PRE-EXISTING. This branch
    # made `slide_design` read `fiducial_diameter_fullres` for the first time and guarded it
    # against exactly that value; leaving `spot_diameter_fullres` unguarded would ship a guard
    # that cannot deliver its promise, because the same bundle would clear `slide_design` and
    # then abort here, one function later, on the same defect. INV-6's negative leg — "a
    # bundle with a damaged scale file is still importable ... it simply DECLARES NO SCALE" —
    # is the promise, and it is now delivered on both fields instead of on neither.
    stated = scalefactors.get("microns_per_pixel")
    if _positive_finite(stated):
        return float(stated), "vendor"
    diameter_px = scalefactors.get("spot_diameter_fullres")
    if _positive_finite(diameter_px):
        return (float(rendered_spot_diameter_um) / float(diameter_px),
                "derived-from-spot-diameter")
    return None, "unavailable"


def _positive_finite(value):
    """A vendor number that can be divided by. TOTAL over every JSON value.

    `bool` is excluded deliberately: it is an `int` subclass, so `True` would otherwise read
    as the diameter 1.0. `json.loads` also accepts `Infinity`, which passes `> 0` and then
    makes every ratio 0.0 or `nan` — the same guard `emit_images` states for `scalef`, for the
    same reason.

    AND `math.isfinite` ITSELF RAISES on a Python `int` too large for a double, which
    `json.loads` produces from a long integer literal. That is not a hypothetical: a blind
    audit fed a 400-digit `fiducial_diameter_fullres` to this branch and the whole import
    aborted with `OverflowError` on a bundle `origin/main` imported cleanly — a REGRESSION,
    because pre-#257 nothing read that field. INV-6's negative leg is that a bundle with a
    damaged scale file is still importable and simply declares no scale; a predicate that
    raises on damaged input cannot deliver it. Guarded here rather than at each call site,
    because "can this be divided by" is exactly this function's question.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and value > 0
    except (OverflowError, TypeError, ValueError):
        return False


def slide_design(scalefactors):
    """Which SLIDE DESIGN wrote this `scalefactors_json.json`, and therefore which circle
    `spot_diameter_fullres` measures (#257).

    Returns a record, never a bare number, for the reason `micron_scale` returns
    `(value, source)`: a matched design and an assumed one must stay distinguishable
    downstream, and the report has to be able to say WHICH it was and on what.

        {"id", "rendered_spot_diameter_um", "capture_area", "matched_by", "reason",
         "fiducial_over_spot", "fiducial_over_spot_expected", "relative_error",
         "fiducial_diameter_fullres", "spot_diameter_fullres", "source"}

    `matched_by` is `"fiducial-spot-ratio"` or `"assumed-standard"`.

    ## Why the ratio, and not the assay

    `fiducial_diameter_fullres` and `spot_diameter_fullres` come out of ONE registration
    solution applied to TWO known physical sizes (10x's own words), so the pixel scale cancels
    in their ratio and it names the design directly — using nothing this repo chose and
    nothing about how the tissue got onto the slide. Keying on the ASSAY instead is measured
    to be wrong on real public data in both directions (see `SLIDE_DESIGNS`).

    ## The `assumed-standard` leg is not a silent default

    A bundle with no usable `fiducial_diameter_fullres`, or a ratio matching no known row,
    keeps the standard 65.0 um — which is what EVERY bundle got before #257, so the fallback
    cannot be worse than what it replaces — and says so, naming the ratio it saw. The import
    does not refuse (DEC-7), and `registration_qc`'s 100 um referent is the backstop: an
    unrecognised design whose real circle is 60 or 70 fails that check by ~8%, loudly, with
    this record's `id` in the reason.
    """
    # `read_scalefactors` already returns `{}` for anything that is not a dict, so this is a
    # belt on a brace — but `slide_design` is now a PUBLIC entry point (the viz
    # producer-magnitude gate calls it to derive the numerator), and a public predicate that
    # raises `AttributeError` on `None` is a worse contract than one that treats it as absent.
    if not isinstance(scalefactors, dict):
        scalefactors = {}
    fiducial = scalefactors.get("fiducial_diameter_fullres")
    diameter = scalefactors.get("spot_diameter_fullres")
    # THE STANDARD ROW, SELECTED BY ITS VALUE, never by its position. `SLIDE_DESIGNS[0]`
    # worked and was a trap: the table invites new rows ("a design 10x ships next is a row
    # here"), and inserting one at the front would have produced a fallback record whose `id`
    # and `source` came from that new design while its diameter came from the constant — a
    # self-contradictory record that every test stayed green on, because the tests assert the
    # VALUE and the mutation battery selects by value too. Bound by the constant instead, and
    # the binding is asserted rather than assumed.
    def fallback():
        """The `assumed-standard` record, built ONLY when the fallback is actually taken.

        Lazy on purpose, and that is the second correction to this block. The row is selected
        by its own `is_standard_fallback` declaration rather than by position (`SLIDE_DESIGNS[0]`
        was a trap: the table invites new rows, and one inserted at the front produced a record
        naming that design and carrying this one's diameter, with every test green because they
        all assert the VALUE). Doing that lookup EAGERLY then over-coupled the other direction:
        a malformed table broke every import, including the ones whose design was identified
        outright and never needed a fallback at all. It is the fallback's precondition, so it is
        checked on the fallback's path.
        """
        rows = [d for d in SLIDE_DESIGNS if d.get("is_standard_fallback")]
        if len(rows) != 1:
            raise VisiumImportError(
                f"{len(rows)} slide designs declare `is_standard_fallback`, so this bundle's "
                "slide design could not be identified AND there is no unambiguous standard to "
                "assume. Exactly one row of SLIDE_DESIGNS must carry it, and its "
                "`rendered_spot_diameter_um` must be VISIUM_RENDERED_SPOT_DIAMETER_UM."
            )
        standard = rows[0]
        return {
            "id": standard["id"],
            "rendered_spot_diameter_um": standard["rendered_spot_diameter_um"],
            "capture_area": standard["capture_area"],
            "matched_by": "assumed-standard",
            "fiducial_diameter_fullres": fiducial if _positive_finite(fiducial) else None,
            "spot_diameter_fullres": diameter if _positive_finite(diameter) else None,
            "fiducial_over_spot": None,
            "source": standard["source"],
        }

    if not (_positive_finite(fiducial) and _positive_finite(diameter)):
        assumed = fallback()
        assumed["reason"] = (
            "this bundle's scalefactors_json.json carries no usable "
            "`fiducial_diameter_fullres`/`spot_diameter_fullres` pair, so the slide design "
            f"could not be identified. The standard {VISIUM_RENDERED_SPOT_DIAMETER_UM:g} um "
            "rendered spot diameter is ASSUMED — which is what every bundle got before #257 "
            "— and the scale check against the slide's 100 um pitch is what will catch it if "
            "that assumption is wrong for this slide."
        )
        return assumed

    ratio = float(fiducial) / float(diameter)
    best = min(SLIDE_DESIGNS,
               key=lambda d: abs(ratio - d["fiducial_over_spot"]) / d["fiducial_over_spot"])
    error = abs(ratio - best["fiducial_over_spot"]) / best["fiducial_over_spot"]
    if error > SLIDE_DESIGN_RATIO_TOLERANCE:
        assumed = fallback()
        assumed["fiducial_over_spot"] = ratio
        assumed["reason"] = (
            f"this bundle's fiducial/spot ratio is {ratio:.6f}, which matches no slide design "
            f"this importer knows (the nearest is {best['id']} at "
            f"{best['fiducial_over_spot']:.6f}, {error * 100:.2f}% away, outside the "
            f"{SLIDE_DESIGN_RATIO_TOLERANCE:g} tolerance). The standard "
            f"{VISIUM_RENDERED_SPOT_DIAMETER_UM:g} um rendered spot diameter is ASSUMED, "
            "which is what every bundle got before #257. If this is a slide design 10x has "
            "shipped since, the scale check against the slide's 100 um pitch will say so."
        )
        assumed["nearest_design"] = best["id"]
        assumed["relative_error"] = error
        return assumed

    return {
        "id": best["id"],
        "rendered_spot_diameter_um": best["rendered_spot_diameter_um"],
        "capture_area": best["capture_area"],
        "matched_by": "fiducial-spot-ratio",
        "fiducial_diameter_fullres": float(fiducial),
        "spot_diameter_fullres": float(diameter),
        "fiducial_over_spot": ratio,
        "fiducial_over_spot_expected": best["fiducial_over_spot"],
        "relative_error": error,
        "source": best["source"],
        "reason": (
            f"the vendor's own fiducial/spot ratio is {ratio:.6f}, which is "
            f"{error * 100:.4f}% from {best['fiducial_over_spot']:.6f} — the "
            f"{best['capture_area']} slide design whose rendered spot circle measures "
            f"{best['rendered_spot_diameter_um']:g} um "
            f"({best['implied_um_measured']}). The pixel scale cancels in that ratio, so it "
            "names the design using no number this importer chose."
        ),
    }


def detect_assay(scalefactors, members, provenance):
    """WHICH ASSAY produced this bundle — CytAssist, or direct placement (#257).

    This answers "what kind of run was this?", which is a DIFFERENT question from
    `slide_design`'s "what circle does `spot_diameter_fullres` measure?". Keeping them apart
    is the whole finding of #257: the DLPFC corpus is direct placement on the same 70 um
    circle CytAssist 6.5 mm uses, so an answer to one is not an answer to the other.

    Nothing about the SCALE gates on this. It exists so the run report names the assay
    instead of leaving a reader to derive it — #222's lesson, which was that a check fired
    and a human had to work out what it meant.

    One signal decides and two corroborate, and all three are recorded so a human sees
    agreement or disagreement rather than a bare classification.
    """
    # `or {}` guards a falsy provenance; `isinstance` guards a truthy non-dict, which is the
    # case that used to raise. Same reasoning as `slide_design`'s guard above.
    chemistry = (provenance if isinstance(provenance, dict) else {}).get("chemistry")
    if not isinstance(scalefactors, dict):
        scalefactors = {}
    if not isinstance(members, dict):
        members = {}
    signals = {
        CYTASSIST_SCALEFACTOR_KEY: CYTASSIST_SCALEFACTOR_KEY in scalefactors,
        CYTASSIST_IMAGE_BASENAME: bool(members.get("cytassist_image")),
        "chemistry_description": chemistry,
    }
    decided = signals[CYTASSIST_SCALEFACTOR_KEY]
    corroborating = {
        CYTASSIST_IMAGE_BASENAME: signals[CYTASSIST_IMAGE_BASENAME],
        "chemistry_description": (
            isinstance(chemistry, str)
            and chemistry.strip().lower() in CYTASSIST_CHEMISTRY_DESCRIPTIONS
        ),
    }
    # THREE STATES, NOT TWO. A corroborating signal that says CytAssist when the decider says
    # direct placement CONTRADICTS; one that says nothing when the decider says CytAssist is
    # merely SILENT, and silence is not disagreement — `cytassist_image.tiff` is an OPTIONAL
    # member matched by basename over a possibly-flattened upload, and `chemistry_description`
    # reads `custom` on real vendor bundles. Collapsing the two into one boolean made every
    # bundle that simply did not carry the optional image report `disagree`, which is a
    # warning a reader learns to ignore — and a warning nobody reads is the #222 failure in
    # miniature.
    contradicting = sorted(k for k, v in corroborating.items() if v and not decided)
    silent = sorted(k for k, v in corroborating.items() if decided and not v)
    assay = ASSAY_CYTASSIST if decided else ASSAY_DIRECT_PLACEMENT
    if decided:
        reason = (
            f"`{CYTASSIST_SCALEFACTOR_KEY}` is present in scalefactors_json.json. Space "
            "Ranger writes that key only when a CytAssist image was registered against a "
            "microscope image, and it was present in 11 of 11 CytAssist bundles measured for "
            "#257 and absent from 13 of 13 others."
        )
    else:
        reason = (
            f"`{CYTASSIST_SCALEFACTOR_KEY}` is absent from scalefactors_json.json, so this "
            "is a direct-placement Visium run. NOTE that this says nothing about the micron "
            "scale: the slide design is read separately, from the fiducial/spot ratio, "
            "because direct-placement bundles are measured to span the same range of "
            "rendered spot diameters CytAssist bundles do (#257)."
        )
    return {
        "assay": assay,
        "decided_by": CYTASSIST_SCALEFACTOR_KEY,
        "reason": reason,
        "signals": signals,
        "corroborating_signals_agree": corroborating,
        "corroborating_signals_contradicting": contradicting,
        "corroborating_signals_silent": silent,
        "corroboration": (
            f"CONTRADICTED by {', '.join(contradicting)} — the decision stands on "
            f"`{CYTASSIST_SCALEFACTOR_KEY}` alone (DEC-4), and a bundle where these "
            "disagree is worth a look" if contradicting
            else (f"agree, with {', '.join(silent)} silent (an absent optional member is "
                  "not evidence either way)" if silent else "agree")
        ),
    }


def vendor_provenance(matrix_attrs, metrics_path):
    """The vendor pipeline, recorded — a processing step we did not run (INV-8).

    Its version is as load-bearing as any of our own parameters: 10x changed Xenium's
    default nucleus expansion from 15 um to 5 um between versions, which alters every cell
    in the dataset. The matrix `.h5` ROOT ATTRIBUTES are the reliable source (always
    present, measured on real bundles: `software_version`, `chemistry_description`,
    `library_ids`); `metrics_summary.csv` adds the reference transcriptome and probe set
    where the run recorded them.

    Recorded into the artifact `meta` and the report — the EXISTING channels. #77 (a
    methods narrator that cannot express a versioned tool / reference asset) is open and
    is not worked around here: the design explicitly forbids inventing a second
    provenance channel.
    """
    # `decoded_vendor_text` is MODULE LEVEL (#327), not the closure this used to hold: the frame
    # identity reads the same `library_ids` attribute this block reads, and one field with two
    # readers that decode it differently is #320's live defect. NOT filtered through
    # `vendor_statement` (DEC-6): this block is EVIDENCE, and a placeholder recorded here verbatim
    # is the only record of what the operator has to go and replace. The identity path is where the
    # predicates belong, and `coordinate_space_id` is where they are.
    text = decoded_vendor_text
    prov = {
        "pipeline": text(matrix_attrs.get("software_version")),
        "chemistry": text(matrix_attrs.get("chemistry_description")),
        "library_id": text(matrix_attrs.get(LIBRARY_ID_ATTR)),
    }
    if metrics_path is not None:
        try:
            # `encoding="utf-8"` for the same reason as the two reads above (#330
            # FIX_ROUND-1). This file's `Sample ID` becomes `SD.section(sample_id=...)` on the
            # coordinate store, so the LOCALE must not decide it: MEASURED with a legitimate
            # UTF-8 `Sample ID`, the SAME bundle stamped TWO DIFFERENT identities into
            # `spatial/coordinates.zarr/zarr.json` depending on `LC_ALL` — the vendor's value
            # under a UTF-8 locale and the library id fallback under an ASCII one.
            #
            # WHAT THIS DOES NOT CLOSE, said out loud because an earlier draft of this comment
            # implied it did: the `except (OSError, ValueError, csv.Error)` below still swallows a
            # `UnicodeDecodeError`, so a metrics file whose BYTES are not UTF-8 (latin-1, say)
            # still degrades and the sample id falls to the library-id rung. That is the
            # documented contract for this OPTIONAL member — `metrics_summary_unreadable: true`
            # is recorded in the report — and it is a documented LADDER rather than a fabricated
            # value, so it is left alone and recorded in the design note §6.8 rather than turned
            # into a refusal on an optional file.
            with open(metrics_path, newline="", encoding="utf-8") as fh:
                rows = list(csv.reader(fh))
            if len(rows) >= 2:
                summary = dict(zip([c.strip() for c in rows[0]], rows[1]))
                for wanted, key in (
                    ("Reference", "reference_transcriptome"),
                    ("Transcriptome", "reference_transcriptome"),
                    ("Probe Set Name", "probe_set"),
                    ("Pipeline Version", "pipeline_from_metrics"),
                    ("Sample ID", "sample_id"),
                ):
                    if wanted in summary and summary[wanted].strip():
                        prov.setdefault(key, summary[wanted].strip())
        except (OSError, ValueError, csv.Error):
            # A damaged metrics file loses the OPTIONAL half of provenance; it does not
            # lose the half that came off the matrix, and it is not a reason to refuse an
            # otherwise-complete bundle. The report says which fields are absent.
            #
            # `csv.Error` IS NOT A `ValueError` (#336 FIX_ROUND-1). `_csv.Error.__mro__` is
            # `(_csv.Error, Exception, BaseException, object)`, so the two-name tuple above
            # caught the `OSError` and the `int()`/decode failures and let a field over `csv`'s
            # 131,072-character limit escape as an UNCAUGHT `_csv.Error`. MEASURED by a blind
            # security angle on the FIX_ROUND-1 branch, with `metrics_summary.csv` holding one
            # 200,000-character field:
            #
            #     rc=1  12 lines of raw TRACEBACK  14 output paths already on disk, no manifest
            #
            # Worse than the twin in `read_positions` (which leaves 0 paths), because
            # `vendor_provenance` is called AFTER `write_csc_zarr`. It is caught into the DEGRADE
            # here rather than refused, unlike the positions twin, for the reason this handler
            # already gives: `metrics_summary.csv` is an OPTIONAL member with a documented
            # degrade contract, and one unreadable optional file is not a reason to refuse an
            # otherwise-complete bundle. The positions table is not optional.
            prov["metrics_summary_unreadable"] = True
    # Absence stays absence: a key nobody could fill is DROPPED, never written as
    # "unknown", so a reader cannot mistake our placeholder for the vendor's answer.
    return {k: v for k, v in prov.items() if v is not None}


# ── the frame identity (#327, realizing design §3.3 + §4) ────────────────────────────
#
# EVERY construct below is a NAMED SIBLING of one this repo already ships in
# `spatial-import-xenium/compute/import_xenium.py`, at #323's insistence and #327's: *"The fix
# already exists next door."* The names, the argument order, the source tokens and the docstring
# shape are deliberately the same. Two importers spelling one rule two ways is two rules.

#: The spellings a vendor uses for NO ANSWER. Byte-for-byte the sibling's tuple, and TEST-15
#: asserts they stay equal — one frame scheme spelled two ways is two frame schemes.
#:
#: A CLOSED list rather than a heuristic: dropping any short or odd-looking string would eventually
#: drop a real id. `0000000_0000000` is here on a MEASUREMENT (#327/#328 DEC-8, design §4.6):
#: #270's DEC-7 rejected `library_ids` as the XENIUM frame identity precisely because both real
#: Xenium bundles carry that value there, and #327's own table has the Visium consequence —
#: `library_id='0000000_0000000'` answering ONE frame for two unrelated runs. It is one exact-match
#: spelling on one measurement, not a denylist; #320's DEC-4 refused a longer list as the ANSWER to
#: the self-naming-field problem, which is a different and unbounded problem.
_VENDOR_PLACEHOLDERS = ("", "n/a", "na", "unknown", "none", "null", "-", "0000000_0000000")


def vendor_statement(value):
    """The vendor's answer, or `None` when the vendor gave a PLACEHOLDER for one.

    The sibling's predicate, and the sibling's reason: a bundle stating `library_ids: "unknown"`
    was, before #327, the whole of this importer's coordinate frame — so two unrelated tissues both
    saying `"unknown"` were declared to share one, and one tissue's image was registered against the
    other's cells. That is the FALSE COLLISION this module names as the unrecoverable direction.

    ## The one place it DIVERGES from `spatial-import-xenium`'s copy, and why

    The sibling's non-string arm is `_finite(value)` — a vendor writing a NUMBER is stating
    something — because `experiment.xenium` is untrusted JSON and a numeric `region_name` has to
    reach the provenance block. This importer has no JSON vendor document: its vendor statements
    come from an `.h5` root-attribute table (already decoded by [`decoded_vendor_text`]) and a CSV
    cell (already a `str`), and its provenance block is built by [`vendor_provenance`] WITHOUT this
    predicate (DEC-6 — the provenance is EVIDENCE and must keep saying what the vendor wrote). So
    the non-string arm here has nothing to be right about and answers `None`, which is also the
    design's rule for an IDENTITY: *a frame label must be a STRING*, because both identity
    predicates are blind to anything else.
    """
    if isinstance(value, str):
        text = value.strip()
        return None if text.lower() in _VENDOR_PLACEHOLDERS else text
    return None


#: The key suffixes stripped before a value is compared against its own field name — the sibling's
#: tuple, unchanged, and TEST-15 asserts the two stay equal. A field is named for its SUBJECT plus
#: what kind of thing it holds, so the subject is what is left when the kind is removed:
#: `library_id` holds the id of a library, so its subject is `library`.
_NON_IDENTIFYING_KEY_SUFFIXES = ("_name", "_id", "_label", "_uuid")


def non_identifying_vendor_label(key, value):
    """True when `value` is only the generic name of the FIELD it fills — #320's rule, ported.

    `library_ids: "library"` is the word every unfilled instance of that field carries, so it
    cannot distinguish this run from any other run that left it generic. Derived from the KEY
    rather than from a vocabulary, which is what makes it a rule and not a denylist: a new frame
    key is covered the day it is added, with nobody updating a list.

    Both spellings — the stripped SUBJECT and the WHOLE key — because a value repeating its entire
    key (`library_id: "library_id"`) identifies exactly as much as one repeating the subject.

    `""` is False here rather than True: an empty value is `_VENDOR_PLACEHOLDERS`' question, not
    this one, and answering it twice is how two predicates start disagreeing.
    """
    if not isinstance(value, str) or not isinstance(key, str):
        return False
    text = value.strip().lower()
    if not text:
        return False
    whole = key.strip().lower()
    subject = whole
    for suffix in _NON_IDENTIFYING_KEY_SUFFIXES:
        if subject.endswith(suffix):
            # `break` — the FIRST matching suffix is the kind, and stripping a second would eat
            # part of the subject: `x_label_id` names the id of `x_label`, not of `x`.
            subject = subject[:-len(suffix)]
            break
    return text in (subject, whole)


#: The namespace a COORDINATE FRAME carries when the vendor stated no identity for it — the
#: sibling's `unverified-space:`, identically, because a consumer reading either importer's
#: `coordinate_space` must be reading one vocabulary.
#:
#: `spatial_declarations.coordinate_space(*, space, ...)` requires a non-empty `space`, so "leave it
#: absent" is not expressible. The machine-authoritative disclosure is `coordinate_space_source`,
#: which travels INSIDE the same block and therefore reaches a sandboxed consumer (#211); this
#: prefix is belt-and-braces for a HUMAN reading the value on its own.
UNVERIFIED_SPACE_PREFIX = "unverified-space:"

#: The COMPOSED namespace token — the sibling's, which THIS module never writes and still reserves.
#:
#: `spatial-import-visium` names a frame with ONE field, so it has no composed rung to emit into
#: (design §4.5: giving `library_id` a namespace token would move every real bundle's id for no
#: property gained). Reserving the token is a DIFFERENT question from emitting it, and design §4.1's
#: INV-3 is written about the scheme rather than about a package: *the composed and derived
#: namespaces are RESERVED: a vendor value that opens with either token (case-folded) is refused as
#: an identity.* A blind design-conformance angle measured the gap — `library_ids:
#: "slide_id+region_name:1:a|1:b|"` was accepted as a stated identity and emitted verbatim, a stated
#: frame sitting inside the composed namespace, so the three namespaces were not disjoint here.
#:
#: The cost is a MISSED collision for a Visium operator who genuinely names a library
#: `slide_id+region_name:...` — a spelling no Space Ranger run produces — recoverable by renaming.
#: The alternative is the FALSE-collision direction this module refuses everywhere else.
COMPOSED_SPACE_PREFIX = "slide_id+region_name:"

#: The tokens no vendor value may OPEN with, because this SCHEME writes them itself (design §4.1).
#: Both, not just the one this package emits — see [`COMPOSED_SPACE_PREFIX`]. One tuple, so a third
#: namespace is refused everywhere the moment it is named here rather than at whichever call sites
#: someone remembers, which is the same "one predicate, every caller" rule `vendor_statement`'s
#: docstring records the defect for.
RESERVED_SPACE_PREFIXES = (UNVERIFIED_SPACE_PREFIX, COMPOSED_SPACE_PREFIX)

#: The `.h5` root ATTRIBUTE that can name a coordinate frame, and the SINGULAR key this module
#: files it under. They differ — 10x writes `library_ids` (plural, an array) and this module records
#: `library_id` — and the difference is load-bearing for [`non_identifying_vendor_label`], which
#: derives its question from the KEY: `library_id` strips to the subject `library`, so
#: `library_ids: "library"` is correctly refused, while the plural spelling strips to nothing and
#: would let it through. The predicate is asked about the field as this module NAMES it.
LIBRARY_ID_ATTR = "library_ids"
LIBRARY_ID_KEY = "library_id"


def decoded_vendor_text(value):
    """One `.h5` attribute as text — bytes decoded, arrays and sequences joined, `None` for absent.

    HOISTED OUT OF [`vendor_provenance`], where it was a closure, because #327 gave it a SECOND
    caller: [`vendor_frame_label`] must read the same attribute the provenance block reads, and the
    module's own rule — recorded in the sibling's `vendor_statement` docstring, from a defect it
    shipped — is *one predicate, every caller, no second spelling to drift*. #320's live defect was
    exactly two readers of one field disagreeing about how to read it.

    `errors="replace"` is preserved from the closure. It is not a sanitisation of the identity path:
    `refuse_unencodable_vendor_text` has already REFUSED the whole bundle at the parse boundary for
    any root attribute this app cannot write (#329/#330), so by the time this runs, a replacement
    character can only come from bytes that were already refused. What it stops is an uncaught
    `UnicodeDecodeError` from a caller that reaches here on some future path `main()` would print as
    a traceback.
    """
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    if isinstance(value, np.ndarray):
        return ", ".join(decoded_vendor_text(x) for x in value.tolist())
    if isinstance(value, (list, tuple)):
        return ", ".join(decoded_vendor_text(x) for x in value)
    return None if value is None else str(value)


def sole_stated_text(value):
    """The ONE text value the vendor stated in an `.h5` root attribute, or `None` (#327).

    The IDENTITY path's reader, and deliberately NOT [`decoded_vendor_text`]'s. The two answer
    different questions and a blind correctness angle measured what happens when the identity path
    borrows the provenance reader:

    * **TEXT, or nothing.** `h5py` hands back a different Python type per dtype, and for
      `library_ids` written as a NUMBER it hands back an `np.ndarray` — which the first version of
      [`vendor_frame_label`] accepted, stringified through `decoded_vendor_text`, and emitted as the
      frame. Two unrelated bundles both carrying `library_ids: [0]` each answered `visium:0` with
      `coordinate_space_source: "library_id"`. That is #327's own defect at the rung meant to remove
      it, and design §3.3 states the rule it breaks in one line — *a frame label must be a STRING*,
      because BOTH identity predicates are blind to anything else (`_VENDOR_PLACEHOLDERS` is a
      string vocabulary and [`non_identifying_vendor_label`] returns False for a non-string), so a
      number is an UNFILTERABLE identity in the one field whose whole job is not to falsely collide.
      The sibling spells this `isinstance(raw, str)`; here it cannot, because `experiment.xenium` is
      JSON and this is an h5 attribute, where the vendor's STRING arrives as `bytes` inside a
      length-1 array. So the rule is "text after decoding", not "already a `str`".
    * **ONE value, or nothing.** `library_ids` is PLURAL and array-shaped in every real bundle.
      `decoded_vendor_text` joins a multi-element array with a bare `", "` — right for the
      provenance block, which is EVIDENCE and must show what the vendor wrote, and wrong here,
      because that join is not injective: `[b"A", b"B"]` and `[b"A, B"]` are two different vendor
      statements and both became `visium:A, B`. That is #328's unframed-concatenation defect, one
      package over. It is not answered by framing the join — design §4.1's stated namespace is
      *the vendor identified the frame with ONE field -> that field's value, VERBATIM*, and a
      two-element `library_ids` is not one stated value. So a multi-element attribute is not an
      identity and the run falls to the derived rung, where it is DECLARED unverified (INV-4)
      rather than given a value another run can answer.

    Both refusals are MISSED collisions, visible in `coordinate_space_source` and recoverable by
    re-exporting with a single quoted `library_ids` — the error direction §3 already chose.
    [`_wrote_a_frame_label`] still reports these runs as *the vendor wrote something you can
    replace*, which is the row the operator needs.
    """
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            return None
        value = value[0]
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value if isinstance(value, str) else None


def vendor_frame_label(matrix_attrs):
    """The library id the vendor stated, if it IDENTIFIES a frame — else `None` (#327).

    The sibling's `vendor_frame_label`, with the loop over three keys collapsed because this
    platform names a frame with one. The four questions, asked once, in the right order:

    * **it must be ONE TEXT value** — [`sole_stated_text`], which is this rung's reader and not
      [`decoded_vendor_text`]. `library_ids` is an h5 root attribute, so h5py returns a different
      Python type per dtype and the vendor's STRING arrives as `bytes` inside a length-1 array; a
      NUMERIC attribute is not a frame identity, because both identity predicates below are blind
      to it, and a MULTI-ELEMENT attribute is not ONE stated value, which is what design §4.1's
      stated namespace is. The first version of this function asked only "is it one of the
      container types" and then borrowed the provenance reader, and a blind correctness angle
      measured both holes: `library_ids: [0]` answered `visium:0`, and `[b"A", b"B"]` /
      `[b"A, B"]` both answered `visium:A, B` — for two unrelated runs, on the rung whose entire
      job is not to falsely collide.
    * [`vendor_statement`] — *did the vendor answer at all?* This is the rung #327 measured: on
      `origin/main` the value was read RAW, so `library_ids: "unknown"` and
      `library_ids: "0000000_0000000"` each WERE the coordinate frame, identically, for two
      unrelated runs.
    * [`non_identifying_vendor_label`] — *does the answer identify anything?* `library_ids:
      "library"` is the word every unfilled instance of that field carries.
    * ...and it must not be READABLE AS A VALUE THIS MODULE WRITES ITSELF — see
      [`RESERVED_SPACE_PREFIXES`]. The `.h5` is untrusted, so "no vendor writes this prefix" is a
      claim about attacker input and is ENFORCED here rather than assumed. Without it a bundle
      stating `library_ids: "unverified-space:<32 hex>"` read off a victim's exported report would
      emit a value byte-indistinguishable from a derived one while claiming
      `coordinate_space_source: "library_id"`.

    CASE-FOLDED on the last check, because the claim is about what a READER can tell apart, not
    about bytes. It is a TRIPWIRE, not a proof: a homoglyph or a fullwidth colon still produces a
    value a human cannot distinguish. That is accepted rather than answered with a normalisation
    arms race, and it is acceptable because the harm stops at the reader — the BYTES differ, so the
    forgery collides with no real frame, and `coordinate_space_source` is written by this module and
    is not forgeable.
    """
    stated = sole_stated_text(matrix_attrs.get(LIBRARY_ID_ATTR))
    if stated is None:
        # Absent, `None`, a NUMBER, or MORE THAN ONE value — see [`sole_stated_text`]. Read through
        # that predicate rather than `decoded_vendor_text`: the provenance reader stringifies a
        # number and `", "`-joins an array, and a blind correctness angle measured both reaching the
        # identity as `visium:0` and `visium:A, B` for two unrelated runs.
        return None
    text = vendor_statement(stated)
    if text is None:
        return None
    if non_identifying_vendor_label(LIBRARY_ID_KEY, text):
        return None
    if text.lower().startswith(RESERVED_SPACE_PREFIXES):
        return None
    return text


def _wrote_a_frame_label(matrix_attrs):
    """True when the vendor put SOMETHING in `library_ids` — placeholder spellings and unreadable
    types included; absent, `None` and a blank string excluded.

    The OPERATOR-RECOVERABILITY question, which is a different question from
    [`vendor_frame_label`]'s. `library_ids: "unknown"` identifies nothing AND is something a human
    can go and replace; an absent attribute is not. The sibling's copy got this backwards once —
    it asked whether the value survived `vendor_statement`, so a PLACEHOLDER was reported as *the
    vendor wrote nothing*, telling the operator there was nothing to rename when a placeholder is
    precisely the thing they can replace. A blind angle measured it; this is the corrected split.

    ANY non-text type counts, for the same reason the sibling states: a `library_ids` holding a
    number is plainly a value the operator can replace, and sending it to the "nothing to rename"
    row is the same mis-report one rung over.
    """
    raw = matrix_attrs.get(LIBRARY_ID_ATTR)
    if raw is None:
        return False
    text = decoded_vendor_text(raw)
    if isinstance(text, str):
        return bool(text.strip())
    return True


#: HEX CHARACTERS KEPT from the SHA-256 in [`unverified_space_id`], as a named constant rather than
#: an inline literal — the sibling's `_SPACE_DIGEST_HEX`, at the same width and for the same
#: arithmetic. 32 hex = 128 bits: over even 10**12 coordinate spaces the birthday bound is ~1.5e-15,
#: while at 64 bits (16 characters) the same corpus is ~2.7e-2 — a false collision this module would
#: then be shipping knowingly, in the one field whose entire job is not to falsely collide.
#:
#: The upper bound is real too: `dataset/models.rs`'s `compact_declaration` truncates a declaration
#: string past `DECL_MAX_VALUE_CHARS = 120` on a LISTING row, and `workbenchDataSource.ts` records
#: that a MANGLED frame id is worse than a missing one. At 32 the emitted space id is 56 characters
#: and the `section.sample_id` that quotes it is 74.
#:
#: DELIBERATELY NOT operator-configurable: an operator-lowerable identity length is an
#: operator-lowerable false-collision rate.
_SPACE_DIGEST_HEX = 32


def unverified_space_id(cell_ids, positions):
    """A frame identity DERIVED from the run's own MEASUREMENT, when the vendor gave none (#327).

    The sibling's function, over this platform's measurement: the vendor's own per-spot identities
    (`filtered_feature_bc_matrix.h5`'s `/matrix/barcodes`) AND the full-resolution pixel positions
    joined to them from `tissue_positions.csv` — the same `(N, 2)` array that becomes
    `spatial/coordinates.zarr`. A frame is a set of positions; this is that set, keyed by the
    vendor's own names for the things in it.

    THE IDS ALONE ARE NOT ENOUGH, and that is a correction the sibling had to make twice rather than
    a precaution: a blind design-conformance angle there drove two genuinely different measurements
    whose matrices carried generically numbered ids into ONE coordinate space. With the positions in
    the preimage the claim is true rather than probable. This module inherits the corrected version
    rather than repeating the mistake.

    The framing is INJECTIVE: each id is length-prefixed (self-delimiting whatever it contains, so
    the digest is a function of the LIST and not merely of its concatenation — without it
    `["ab", "c"]` and `["a", "bc"]` are one frame), `|` closes the id block, and the positions are a
    fixed 8 bytes per spot whose count is recoverable from the ids.

    IT IS PERMUTATION-INVARIANT: the records are digested in ID ORDER, not file order, so a
    re-export of the SAME run with its rows shuffled is the same frame. The sort is on `(id,
    position)` TUPLES so equal ids fall through to comparing their positions; the tiebreak is total
    (every id is a `str` and `points.tolist()` is Python floats) and cannot raise.

    `-0.0` is normalised to `0.0`: it is the same POSITION with different bytes, and a frame identity
    must not turn on the sign of a zero. Measured over all 2**32 float32 patterns, `0x80000000` is
    the only non-NaN one whose bytes change.

    ## §12.3 says `coordinate_space` is "a CONVENTION, not a recomputed digest". Which half is this?

    The half that carries the meaning: *derive it from what the vendor wrote, never MINT one*,
    because a minted id makes every import a new, unrelatable frame. Every byte in this preimage is
    the vendor's — nothing generated, nothing random, nothing depending on the clock or the machine
    — so two imports of the same bundle are the same frame, which is the property §12.3's sentence
    exists to protect. What it forbids is a digest STANDING IN for a stated identity; this one is
    reached only where there is no stated identity to stand in for.

    ## What it REPLACED, and why that rung could not be narrowed instead (#327)

    `Path(bundle_root).name`. That is the sandbox MOUNT name — `sandbox/spec.rs`'s
    `derive_artifact_mount_name` / `InputDecl::declared_mount_name` derive it from the SLOT — so for
    an artifact-backed input it is plausibly the constant `bundle` for every Visium import in a
    deployment, and where it IS the user's own directory, `outs` is Space Ranger's own output
    directory name and therefore the single most likely basename in existence for a Visium upload.
    The rung this ladder fell to was the rung most likely to be SHARED, which inverts the ladder's
    own law (*the fallbacks get more specific, never less*). It is gone, and `bundle_root` is gone
    from [`coordinate_space_id`]'s signature with it, so it cannot return by a later edit.

    ## The one case that is REFUSED rather than minted

    A matrix carrying no spot identity at all — an empty barcode list, or barcodes that are all
    empty strings — would digest to ONE CONSTANT shared by every such bundle, which is the exact
    defect this function exists to remove, reintroduced at the bottom of the ladder that removes it.
    It refuses by name instead. Narrow, and said as narrowly as it is true: the empty-LIST half is
    defensive (`run_import`'s shape check and the positions join fire first), and the all-blank half
    is reachable only where the positions table carries matching blank barcodes.
    """
    ids = [] if cell_ids is None else [
        c.decode(errors="replace") if isinstance(c, bytes) else str(c) for c in cell_ids]
    if not any(i.strip() for i in ids):
        raise VisiumImportError(
            f"{MATRIX_BASENAME} carries no spot identity in `/matrix/barcodes` "
            f"({len(ids)} entries, none of them a non-empty string), and the matrix declares no "
            f"usable `{LIBRARY_ID_ATTR}` either — the report's `coordinate_space_source` says "
            "which of those two cases you are in. There is nothing left to derive a coordinate "
            "frame from, and a frame id derived from nothing would be the SAME id for every such "
            "bundle: two unrelated tissues declared to share one frame. Re-export the Space Ranger "
            "bundle with its barcodes, or give the matrix a real library id."
        )
    try:
        points = np.asarray(positions).astype("<f4")
    except (TypeError, ValueError, OverflowError) as exc:
        # NAMED rather than a traceback: `main()` catches only `VisiumImportError`. `OverflowError`
        # is in the tuple because an integer too large for a float reaches `astype` as one. The
        # message says "as an (N, 2) array of numbers" rather than "as numbers" because a RAGGED
        # list of perfectly good numbers lands here too, and calling that a number problem sends a
        # reader looking at the wrong thing.
        raise VisiumImportError(
            f"the spot positions cannot be read as an (N, 2) array of numbers "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). The coordinate frame is derived from "
            "the positions AND the barcodes together. This is an INTERNAL invariant: `run_import` "
            "builds them as a float32 array over the matrix's own barcodes, so it cannot be "
            "reached from a real import."
        ) from None
    if points.shape != (len(ids), 2):
        raise VisiumImportError(
            f"the joined spot positions have shape "
            f"{_quoted_for_refusal(points.shape, noun='shape')} but the matrix declares "
            f"{len(ids)} spots. The coordinate frame is derived from the positions AND the "
            "barcodes together, so a mismatch here would digest a different run's geometry. This "
            "is an INTERNAL invariant, not a statement about your bundle: `run_import` joins the "
            "positions to those same barcodes and REFUSES the run when one is missing, so it "
            "cannot be reached from a real import."
        )
    # `+ 0.0` normalises `-0.0` to `0.0`: the same position, and it must not be a different frame.
    points = points + np.float32(0.0)
    digest = hashlib.sha256()
    # SORTED BY ID, so the same measurement re-exported in a different row order is the same frame.
    # The pairing is preserved because the id travels with its own point.
    ordered = sorted(zip(ids, points.tolist()))
    for cid, _point in ordered:
        # `errors="replace"`: an identity function must not turn a lone surrogate into an uncaught
        # `UnicodeEncodeError` — `main()` catches only `VisiumImportError`. Reachable in principle
        # even after `refuse_unencodable_vendor_text`, which covers the ATTRIBUTE table.
        raw = cid.encode("utf-8", errors="replace")
        digest.update(f"{len(raw)}:".encode("ascii"))
        digest.update(raw)
    digest.update(b"|")
    # `<f4` — LITTLE-ENDIAN float32, STATED rather than inherited. `tobytes()` writes the array's
    # NATIVE byte order, so a plain `float32` view would make this id a function of the machine that
    # computed it, and `coordinate_space` is a value two producers on two machines have to agree on.
    digest.update(np.asarray([point for _cid, point in ordered], dtype="<f4").tobytes())
    return f"{UNVERIFIED_SPACE_PREFIX}{digest.hexdigest()[:_SPACE_DIGEST_HEX]}"


#: The two things a bottom-rung run can be, distinguished because only ONE of them is fixable by the
#: operator. A run that landed on the first can be given a frame identity by re-exporting with a
#: real `library_ids`; a run that landed on the second wrote nothing and there is nothing to rename.
#: The sibling's two tokens, spelled identically — a consumer reading `coordinate_space_source` off
#: either importer is reading one vocabulary.
NON_IDENTIFYING_SPACE_SOURCE = "unverified-space-non-identifying-labels"
NO_VENDOR_SPACE_SOURCE = "unverified-space-no-vendor-statement"


def coordinate_space_id(matrix_attrs, cell_ids, positions):
    """The `coordinate_space` id — the vendor's own frame identity, or a derived one that SAYS so.

    §12.3 records that `coordinate_space` is a CONVENTION, not a recomputed digest, so producer
    discipline is the whole mechanism: it is the only thing that makes two imports of ONE slide
    collide correctly, and a minted UUID would make every import a new, unrelatable frame. (Which
    half of §12.3 the bottom rung stands on is answered in [`unverified_space_id`]: derived from
    the vendor's own bytes, never minted.)

    Between the two error directions, a MISSED collision is visible and recoverable while a FALSE
    collision is silent wrong data, so the fallbacks get more specific, never less.

    ## #327 — that last sentence was the ladder's law and the shipped ladder broke it

    Two rungs, neither guarded. MEASURED on `4b63a482`, driving the shipped function, and every row
    is two unrelated runs declared to share one coordinate frame:

        library_id='unknown'          run-A / run-B      -> BOTH visium:unknown
        library_id='0000000_0000000'  run-A / run-B      -> BOTH visium:0000000_0000000
        no library_id, /uploads/x/outs, /uploads/y/outs  -> BOTH visium:outs
        no library_id, artifact-mounted A / B            -> BOTH visium:bundle

    `resolveOverlayBinding` compares the frame id by EQUALITY and by nothing else, so none of those
    errors: each is one tissue's image silently registered against the other's cells.

    `bundle-directory-name` was the worse of the two — see [`unverified_space_id`]'s own section on
    what it replaced, and why narrowing the rung above it first would have bought a WIDER false
    collision rather than a narrower one. That is not a hypothetical: #320 gated the sibling's
    `slide_id+region_name` rung while ITS bottom was still a directory name, measured that this
    moved bundles onto a value shared by ALL runs, and WITHDREW the change. The order is the trap,
    and it is why the three changes land together — once the bottom cannot be shared, every gate
    above it is strictly narrowing.

    ## The three changes, which had to land together

    * the vendor rung reads through [`vendor_frame_label`], so a placeholder, a self-naming label,
      a non-text attribute or a value forging this module's own namespace can never BE a frame;
    * `bundle-directory-name` is GONE, and `bundle_root` is gone from the signature with it — a
      run's coordinate identity must not be a function of where it happened to be mounted, and the
      parameter's absence is what stops that returning by a later edit;
    * the bottom rung is [`unverified_space_id`], derived from the run's own measurement and
      unreadable as a vendor id by construction.

    ## What is emitted now (design §4.2)

    | what the vendor stated | value | `coordinate_space_source` |
    |---|---|---|
    | an identifying `library_ids` | `visium:<library_id>` | `library_id` |
    | anything else in `library_ids` | `visium:unverified-space:<digest>` | `unverified-space-non-identifying-labels` |
    | nothing in `library_ids` | `visium:unverified-space:<digest>` | `unverified-space-no-vendor-statement` |

    The vendor rung's value is VERBATIM and does not move (design §4.1, DEC-3): one component
    cannot be non-injectively concatenated with anything, so there is nothing to escape and no
    namespace to add — and every bundle that imports today keeps the frame id it has.
    `visium:Visium_Mouse_Olfactory_Bulb` is still `visium:Visium_Mouse_Olfactory_Bulb`. The
    sibling's rung 2 needed a namespace and a length-prefixed framing because it names a frame with
    TWO fields (#328); this platform names one with one.

    The two bottom rows share a VALUE and differ in SOURCE, because only one of them is fixable by
    the operator.

    ## What it costs

    A library genuinely named `library`, and a bundle whose `library_ids` the vendor left as a
    placeholder, do not get a vendor-derived frame — two such runs are not declared to share one
    even if they genuinely are two imports of one slide. That is a MISSED collision, bought
    knowingly on this function's own rule, and it is visible (the source token, plus the operator's
    verbatim `provenance.library_id`) and recoverable (re-export with a real library id, and the
    same two bundles share a frame again). The full argument:
    `docs/design/xenium-declaration-residues.md` §3 and §4.
    """
    library = vendor_frame_label(matrix_attrs)
    if library:
        return f"visium:{library}", "library_id"
    source = (NON_IDENTIFYING_SPACE_SOURCE if _wrote_a_frame_label(matrix_attrs)
              else NO_VENDOR_SPACE_SOURCE)
    return f"visium:{unverified_space_id(cell_ids, positions)}", source


#: The namespace an emitted `section.sample_id` carries when the bundle states NO sample (#327).
#:
#: A prefix rather than a second key, and that is forced rather than chosen: the vendored
#: `spatial_declarations.section(*, sample_id, index, z_offset_um=None, **forbidden)` REQUIRES a
#: non-empty `sample_id` and REFUSES every other keyword by name, so neither "leave it absent" nor
#: "record a `sample_id_source` beside it" is expressible in the block that crosses into the
#: sandbox. Folding the disclosure into the VALUE is the only channel a sandboxed consumer can see
#: it in, and no top-level report key is added for it either (DEC-7). The contract gap is filed
#: rather than worked around silently: **issue #318** proposes both an optional `sample_id` and a
#: `sample_id_source` on the shared block, and this convention is retired — in both importers at
#: once — when that lands. Cited by ISSUE NUMBER on purpose: a branch's lifecycle artifacts are
#: stripped at merge, so a pointer into them is one a reader of this module cannot follow.
#:
#: Spelled identically to `spatial-import-xenium`'s `UNVERIFIED_SAMPLE_PREFIX`, for the reason
#: every shared token here is: a consumer reading `section.sample_id` off either importer is
#: reading one vocabulary.
UNVERIFIED_SAMPLE_PREFIX = "unverified-sample:"

#: The `metrics_summary.csv` column this module files under the key `sample_id`, named here so
#: [`non_identifying_vendor_label`] can be asked about the field as this module NAMES it — the same
#: singular/plural care [`LIBRARY_ID_KEY`] exists for.
SAMPLE_ID_KEY = "sample_id"


def section_sample_id(provenance, matrix_attrs, space_id):
    """`(sample_id)` for §15.4's `section` — the twin of [`coordinate_space_id`] (#327).

    ## What was wrong, and it is #270's defect one package over

    `provenance.get("sample_id") or provenance.get("library_id") or space_id`. Three raw reads,
    and each leg is a value a consumer reads as *the vendor's sample identity*:

    * the `library_id` leg emitted a PLACEHOLDER as a stated sample id — `unknown`,
      `0000000_0000000` — so two unrelated tissues declared themselves sections of one sample;
    * the bare `space_id` leg inherited every frame collision [`coordinate_space_id`] could make,
      verbatim, into a field that does not even say it is a frame id. #270 removed exactly that leg
      from the sibling — *"A field a consumer reads as the vendor's sample identity, filled from an
      accident of how the user zipped their download"* — and #320 replaced it with
      `unverified-sample:<space_id>`, a value unreadable as a vendor id by construction.

    ## The ladder now

    | what the vendor stated | value |
    |---|---|
    | an identifying `Sample ID` in `metrics_summary.csv` | that value, verbatim |
    | else, an identifying `library_ids` | that value, verbatim |
    | else | `unverified-sample:<space_id>` |

    Both vendor rungs read through the SAME predicates as the frame ladder — one predicate, every
    caller, no second spelling to drift. That rule is not decoration: #320's shipped defect was
    precisely two readers of one field, one filtered and one raw.

    ## Why it returns one value and not `(value, source)`

    Its sibling returns a source token because its report has a key to put it in. This one does
    not, and adding one is a manifest-contract change with no consumer (DEC-7): `section()` cannot
    carry it, `test_producer_end_to_end` pins the report's exact key set, and the disclosure a
    reader needs is already in the VALUE. A returned token nothing emits is dead weight that reads
    like a feature.

    ## The forgery this closes

    `metrics_summary.csv` is untrusted vendor text, so a bundle could state a victim's real
    `unverified-sample:visium:unverified-space:<32 hex>` — readable out of any exported report — and
    be declared a section of that victim's sample while sitting in a correctly-derived, DIFFERENT
    coordinate frame. That is the FALSE collision this module names as the unrecoverable direction,
    and the sibling shipped it once before a blind security angle found the asymmetry. Both vendor
    rungs refuse a value opening with this module's own prefix, in either case spelling.
    """
    stated = vendor_statement(provenance.get(SAMPLE_ID_KEY))
    if (stated is not None
            and not non_identifying_vendor_label(SAMPLE_ID_KEY, stated)
            and not stated.lower().startswith(UNVERIFIED_SAMPLE_PREFIX)):
        return stated
    library = vendor_frame_label(matrix_attrs)
    if library and not library.lower().startswith(UNVERIFIED_SAMPLE_PREFIX):
        return library
    return f"{UNVERIFIED_SAMPLE_PREFIX}{space_id}"


def inline_diagnostic(path):
    """A vendor diagnostic image as a `data:` URI, or `None` when it is over the cap.

    Emitted ONLY inside the report body. Design §7.2: `aligned_fiducials.jpg` and
    `detected_tissue_image.jpg` are "QC overlays... diagnostics, not data" — "embed them
    in the report HTML instead of emitting artifacts".
    """
    try:
        raw = Path(path).read_bytes()
    except OSError:
        return None
    if len(raw) > DIAGNOSTIC_INLINE_CAP_BYTES:
        return None
    suffix = Path(path).suffix.lower()
    media = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}.get(suffix)
    if media is None:
        return None
    return f"data:{media};base64,{base64.b64encode(raw).decode('ascii')}"


#: The verdict banner's colours, by verdict. A `not-evaluated` must not be able to look like
#: a pass at a glance — that is the whole reason it is a third value and not a missing one.
_VERDICT_STYLE = {
    "pass": ("#0a7", "#eafaf3", "Registration QC passed"),
    "fail": ("#c22", "#fdecec", "Registration QC FAILED"),
    "not-evaluated": ("#a70", "#fdf6e6", "Registration QC could not be evaluated"),
}


#: How many characters of a verdict `reason` ride in the artifact `meta`. The UI renders
#: `meta` inside a `max-h-40` scroll area, so the whole reason would push the other rows out
#: of view; the full text is in the report JSON, and this is the part a reader sees first.
QC_META_REASON_CHARS = 200


def qc_verdict_lines(qc):
    """The QC verdict as short lines, for the artifact `meta`.

    ## Why this exists, and it is not a nicety

    The rendered overlay is embedded in `visium-import-summary.html`, and **this application
    does not render that HTML.** Traced end to end: `report/html` has no renderer —
    `artifactRegistry.defaultForKind` maps anything that is not `stat`/`provenance` to
    `generic`, and `GenericResult` displays the artifact's CATALOG ROW and never fetches a
    byte of the blob (`GenericResult.tsx:57-90`). `data_api.rs:1026` serves every artifact
    body as `application/octet-stream`, so even a direct fetch would download rather than
    render. There is no iframe path (`ViewHost.tsx:55-62` is an explicit stub) and no
    `dangerouslySetInnerHTML` anywhere in the UI. Rendering it needs work this item does not
    own.

    So an overlay embedded in that HTML is, today, **an image nobody opens** — which is
    exactly the thing a QC must not be.

    What the app DOES show, automatically and with zero clicks the moment a run finishes
    (`AnalysisRunPanel.tsx:764` mounts `ArtifactReview` on `runState === 'done'`), is one card
    per produced datatype whose body prints `artifact.meta` verbatim as JSON. And `meta` is
    carried from this entry to that row unchanged — `ingest.rs:208` is `meta: entry.meta.clone()`.

    **`meta` is therefore the only channel by which this check reaches a human in the shipped
    app**, so the verdict goes there. The overlay stays where the design puts it (§7.2: a
    report output, never an artifact) and becomes visible when something renders the report.
    """
    lines = []
    scale = qc.get("scale") or {}
    reason = str(scale.get("reason", ""))[:QC_META_REASON_CHARS]
    lines.append(f"scale vs the slide's spot pitch: {scale.get('verdict', '?')} — {reason}")
    # THE SLIDE DESIGN GETS ITS OWN LINE (#257), and that is not cosmetic. It rode inside
    # `reason` in the first cut, where this very truncation ate it: the committed fixture's
    # reason went from 136 characters to 308, so the app's line ended mid-word, and on the
    # `assumed-standard` branch the sentence telling a reader WHAT TO CHECK fell off entirely.
    # A second fact needs a second line, not a longer first one — the cap exists to stop one
    # reason pushing the other rows out of view, and widening it to fit would spend the whole
    # budget on the case this note exists for.
    note = str(scale.get("slide_design_note", "")).strip()
    if note:
        lines.append(f"scale numerator: {note[:QC_META_REASON_CHARS]}")
    for image in qc.get("images", []):
        who = image.get("source") or image.get("image_id")
        lines.append(
            f"registration {who}: {image.get('verdict', '?')} — "
            f"{str(image.get('reason', ''))[:QC_META_REASON_CHARS]}"
        )
    if not qc.get("images"):
        lines.append(
            f"registration: {qc.get('registration_verdict', '?')} — "
            f"{str(qc.get('registration_reason', ''))[:QC_META_REASON_CHARS]}"
        )
    return lines


def render_registration_qc(qc, overlays):
    """The #156 block: a verdict banner, the measured numbers, and the rendered overlays.

    Placed FIRST in the report body, before the facts table, because this is the surface the
    user is already looking at when the import finishes and `spatial.import-visium` is
    deliberately launchable rather than `trigger: on-ingest` (DEC-1) precisely so *"the user
    must be able to see and confirm the registration"* (design §7.2). An overlay below a
    table of provenance strings is an overlay nobody scrolls to.

    Every score is printed as a NUMBER beside its verdict. A bare red/green would make the
    reader trust a threshold this repo can only calibrate against a synthetic control.
    """
    def esc(v):
        return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    verdict = qc.get("verdict", "not-evaluated")
    colour, wash, headline = _VERDICT_STYLE.get(verdict, _VERDICT_STYLE["not-evaluated"])
    scale = qc.get("scale", {})
    rows = [
        f"<tr><th align='left'>Scale vs the slide's "
        f"{esc(scale.get('referent_um', '?'))} um spot pitch</th>"
        f"<td><b>{esc(scale.get('verdict', 'not-evaluated'))}</b> — {esc(scale.get('reason', ''))}"
        "</td></tr>"
    ]
    # #257, and its own row for the same reason it is its own field: the number under test is
    # `rendered_spot_diameter_um / spot_diameter_fullres`, so a reader acting on the verdict
    # above needs the numerator and where it came from — including, on a vendor-stated scale,
    # that it came from somewhere else entirely.
    if str(scale.get("slide_design_note", "")).strip():
        rows.append(
            "<tr><th align='left'>Scale numerator</th><td>"
            f"{esc(str(scale['slide_design_note']).strip())}</td></tr>"
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
        f"<figure style='margin:12px 0'><figcaption>{esc(image_id)} — spot centres placed "
        "through the DECLARED affine, drawn at the declared physical spot diameter"
        f"</figcaption><img alt='registration overlay for {esc(image_id)}' src='{uri}' "
        "style='max-width:900px;border:1px solid #ccc'></figure>"
        for image_id, uri in sorted(overlays.items())
    )
    return (
        f"<section style='border-left:6px solid {colour};background:{wash};padding:12px 16px;"
        "margin:0 0 20px'>"
        f"<h3 style='margin:0 0 8px;color:{colour}'>{esc(headline)}</h3>"
        "<p style='margin:0 0 10px;max-width:70ch'>This is the only check in this import "
        "with a referent <b>outside</b> the artifact. Everything else verifies that the "
        "coordinates, the image and the declared scale agree with each other — which a "
        "uniformly wrong scale also does.</p>"
        "<table style='font:13px/1.5 system-ui,sans-serif;border-collapse:collapse'>"
        + "".join(rows) + "</table>"
        + (figures or "<p><em>no overlay was rendered; see the verdicts above for why.</em></p>")
        + "</section>"
    )


def _report_assay_line(report):
    """The one-line assay summary the run-summary table shows (#257).

    Composed here rather than inline in the table so the string a test asserts on and the
    string a human reads are the same object — a report row built inside a comprehension is
    only assertable by re-deriving it, which is how a "the report says X" test comes to assert
    about a copy of the code instead of about the report.
    """
    assay = report.get("assay")
    if not assay:
        return "not determined"
    corroboration = assay.get("corroboration", "")
    return f"{assay['assay']} (decided by `{assay['decided_by']}`; corroboration: {corroboration})"


def _report_slide_design_line(report):
    """The one-line slide-design summary, same rule as `_report_assay_line`.

    THE SAME THREE FACTS `registration_qc._slide_design_clause` composes, and deliberately
    THROUGH ITS TABLE rather than through wording of its own — so the two channels cannot say
    different things about one run, which is exactly what happened when this function carried
    its own.

    AND TOTAL OVER EVERY RECORD, for the same reason that clause is. An earlier round hardened
    the clause with `_finite_float` and left this twin unguarded; a blind audit then fed both
    the same 19 hostile records and got ZERO raises from the clause and EIGHT from here —
    `KeyError` on a missing `id` or diameter, `OverflowError` on an int too large for a double,
    `ValueError` on a string, `TypeError` on `None`, `AttributeError` on a non-dict. And this
    one is WORSE placed: the clause sits inside `registration_qc`'s DEC-7 handler, which
    degrades a raise to `not-evaluated`, while this is called from the summary-HTML builder on
    the plain success path — so a raise here aborts the whole import. Not reachable from vendor
    data today, which is the same "unreachable until it isn't" argument `_finite_float` exists
    to refuse.
    """
    design = report.get("slide_design")
    if not isinstance(design, dict):
        return "not determined"
    diameter = registration_qc._finite_float(design.get("rendered_spot_diameter_um"))
    if diameter is None:
        return "not determined"
    assumed = design.get("matched_by") == "assumed-standard"
    verb = "ASSUMED" if assumed else "identified"
    line = f"{design.get('id')} — {diameter:g} um rendered spot ({verb}"
    ratio = registration_qc._finite_float(design.get("fiducial_over_spot"))
    if ratio is not None:
        # SHOWN ON THE ASSUMED BRANCH TOO. An earlier cut dropped it there, and that is the one
        # branch where it matters most: on the `matches no design` leg the ratio IS the
        # observed number, and it is the single most diagnostic fact for "10x shipped a slide
        # design this importer does not know". Suppressing it left the report saying a design
        # was assumed without saying what it saw. Labelled, because an unmatched ratio and a
        # matched one are different claims.
        line += (f", observed fiducial/spot = {ratio:.6f} matched no known design"
                 if assumed else f" from fiducial/spot = {ratio:.6f}")
    line += ")"

    # THREE ANSWERS, not two. `is False` alone was fail-open: a record that never went
    # through `run_import` carries no such key, and this row then silently omitted the
    # qualifier and read as an affirmative claim.
    applied = design.get("applied_as_scale_numerator")
    if applied is True:
        return line
    if applied is False:
        source = design.get("scale_source")
        why = (registration_qc._NOT_APPLIED_BECAUSE.get(source)
               if isinstance(source, str) else None)
        return line + " — NOT this import's scale numerator: " + (
            why or "the scale came from elsewhere")
    return line + " — whether it was applied as the scale numerator is not recorded"


def render_report_html(report, diagnostics, overlays=None):
    """A self-contained `report/html` — the registration QC, the run summary, the diagnostics.

    Same shape as `anndata-import`'s inspect report: a table of facts plus the structured
    JSON in a script tag, so the inspector view reads the numbers rather than the prose —
    with #156's registration QC placed AHEAD of all of it.
    """
    def esc(v):
        return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    rows = []
    for key, value in (
        ("Coordinate space", report["coordinate_space"]),
        ("Spots", report["n_spots"]),
        ("Genes", report["n_genes"]),
        ("Entity", report["measured_entity_label"]),
        ("Scale (um/pixel)", report.get("microns_per_pixel", "not declared")),
        ("Scale source", report["microns_per_pixel_source"]),
        # #257. The assay first, then the slide design that fixed the numerator — in that
        # order because a reader who sees a scale verdict asks "what was this run?" before
        # "what did it divide by?", and both used to be absent from every channel a human reads.
        ("Assay", _report_assay_line(report)),
        ("Slide design", _report_slide_design_line(report)),
        ("Space Ranger", report["provenance"].get("pipeline", "not recorded")),
        ("Chemistry", report["provenance"].get("chemistry", "not recorded")),
        ("Reference", report["provenance"].get("reference_transcriptome", "not recorded")),
        ("Probe set", report["provenance"].get("probe_set", "not recorded")),
    ):
        rows.append(f"<tr><th align='left'>{esc(key)}</th><td>{esc(value)}</td></tr>")
    imgs = "".join(
        f"<figure style='margin:12px 0'><figcaption>{esc(name)}</figcaption>"
        f"<img alt='{esc(name)}' src='{uri}' style='max-width:480px'></figure>"
        for name, uri in diagnostics.items()
    )
    omitted = "".join(
        f"<p><em>{esc(name)} was not embedded: over the {DIAGNOSTIC_INLINE_CAP_BYTES}-byte "
        f"inline cap.</em></p>"
        for name in report.get("diagnostics_omitted", [])
    )
    embedded = json.dumps(report)
    qc = report.get("registration_qc")
    # The QC banner and OUR overlay, then the VENDOR's own overlays immediately under them —
    # epic ITEM-3: the reader compares our registration against Space Ranger's without
    # leaving the report. They stay embedded diagnostics and never become artifacts (#154
    # INV-4); `test_registration_qc.py` asserts both halves of that.
    banner = render_registration_qc(qc, overlays or {}) if qc else ""
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Visium import summary</title></head><body>"
        "<h2>Visium import summary</h2>"
        + banner
        + "<h3>Space Ranger's own registration diagnostics</h3>"
        + (imgs or "<p><em>none in this bundle.</em></p>")
        + omitted
        + "<h3>Run summary</h3>"
        + "<table style='font:14px/1.5 system-ui,sans-serif'>" + "".join(rows) + "</table>"
        + f"<script type='application/json' id='visium-import-summary'>{embedded}</script>"
        "</body></html>"
    )


def emit_images(members, outputs_dir, *, space_id, microns_per_pixel,
                microns_per_pixel_source, scalefactors, coverage_bounds=None):
    """Convert each present vendor image to a `spatial/image`. Returns `(entries, notes)`.

    ## Every image declares its OWN affine INTO the one space (INV-2)

    The coordinates sit at `to_space = identity` in the full-resolution pixel frame, and
    each image maps into that frame by the INVERSE of its own vendor scalefactor. That is
    the direction that composes: the hires image (`scalef 0.2`) and the lowres image
    (`scalef 0.06`) are at different scales, share one `coordinate_space`, and a consumer
    can place either against the spots or against the other. A forward affine cannot
    express that.

    ## An unplaceable image is DROPPED, not emitted (INV-9 / DEC-8)

    An image whose scalefactor key is missing or unusable produces NO artifact and a note
    in the report. Emitting it with an identity affine would not be a missing declaration
    but a WRONG one — the claim that these pixels are already full-resolution pixels,
    which on this fixture is off by 5x. §7.3 opens by pointing out that getting this wrong
    "does not error"; a dropped image is visibly absent, a misplaced one is silently
    wrong.
    """
    entries, skipped, warnings = [], [], []
    # An image the bundle CARRIES but that could not be addressed unambiguously. Recorded
    # here rather than dropped in `locate_members`, because a silently absent image is the
    # exact failure `images_not_emitted` exists to surface — the `one()` helper refuses an
    # ambiguous REQUIRED member loudly, and an optional one must not degrade to silence.
    for basename in members.get("ambiguous_images", []):
        skipped.append(
            f"{basename}: the bundle carries more than one file with this name, and "
            "member matching is by basename. Choosing one would be a guess about which "
            "run's data this is, so no image was emitted from it."
        )
    # BEFORE the loop, deliberately (DEC-7). A non-placeable image has no write to commit and
    # no failure to catch, so it has no business inside the body that carries #296/#297/#298's
    # commit-point discipline. Same channel as the ambiguity above, because a consumer asking
    # "what is missing and why" must find both in one place.
    for spec in members.get("non_placeable_images", []):
        # `.get`, not `[...]`, and outside a `try` on purpose: this is the exact pattern #298
        # E4 removed one loop down, where reading `spec['basename']` in a HANDLER turned a
        # caught refusal into an abort. Here there is no handler at all, so a hand-built
        # `members` entry missing a key would cost the whole import rather than one note.
        # Guarded by construction today (the specs are a module constant) — this is the pin on
        # that construction, in the same shape and for the same reason as `UNNAMED_IMAGE`.
        skipped.append(f"{spec.get('basename', UNNAMED_IMAGE)}: "
                       f"{spec.get('reason', 'not emitted — no reason was recorded.')}")
    for spec in members.get("images", []):
      # RESOLVED BEFORE THE `try`, NOT INSIDE IT (#298 E4). The handler below reports the
      # refusal it caught using `basename`, and reading `spec['basename']` in the handler
      # meant a `spec` without that key made the HANDLER raise — replacing a caught refusal
      # with an abort, which is the one line in this whole mechanism that can turn "one image
      # lost" back into "the import lost". Guarded by construction today (`VENDOR_IMAGES` is
      # a module constant), and this is the regression pin on that construction rather than a
      # fix for a reachable input.
      basename = spec.get("basename", UNNAMED_IMAGE)
      # WARNINGS ARE BUFFERED UNTIL THE COMMIT POINT, for the same reason `entries` is.
      #
      # The note below says "emitted, but the cap could NOT be evaluated" and is appended
      # BEFORE `write_ome_tiff` runs. When the write then failed, the report asserted in one
      # channel that the image WAS emitted and in the other that it was NOT — measured, on this
      # branch, by injecting a `MemoryError` into the contiguous copy. That contradiction is
      # exactly what splitting the two note channels was supposed to remove, and it became
      # REACHABLE here because this branch converts failures that used to abort the import
      # instead of producing a report at all.
      pending_warnings = []
      try:
          scalef = scalefactors.get(spec["scalef_key"])
          # `math.isfinite` is part of the guard, not an afterthought: `json.loads` accepts
          # `Infinity`, which passes `> 0`, and then `1/inf = 0.0` reaches
          # `SD._number(..., allow_zero=False)` and raises a `SpatialDeclarationError` —
          # a DIFFERENT exception type from the `ImageConversionError` this loop catches, so
          # the whole import would abort on one damaged number. INV-6's stated posture is
          # that a bundle with a damaged scale file is still importable.
          if not (isinstance(scalef, (int, float)) and not isinstance(scalef, bool)
                  and math.isfinite(scalef) and scalef > 0):
              skipped.append(
                  f"{basename}: the bundle declares no usable `{spec['scalef_key']}`, so "
                  "this image cannot be placed in the coordinate space and was NOT emitted. "
                  "An identity affine would claim it is already in full-resolution pixels, "
                  "which would silently misregister every spot drawn on it."
              )
              continue
          try:
              arr = ome_writer.read_image(spec["path"])
          except ome_writer.ImageConversionError as exc:
              skipped.append(f"{basename}: {exc}")
              continue

          # The image's OWN resolution: the full-res scale divided by the vendor's
          # scalefactor. A hires image scaled to 0.2 has pixels 5x coarser than full-res.
          # Unknown stays unknown — there is no default (INV-9).
          image_um_per_px = (
              microns_per_pixel / float(scalef) if microns_per_pixel is not None else None
          )
          derivative = None
          # THE DISPLAY DERIVATIVE (#176). `factor == 1` is the pass-through and is every
          # image in a standard Visium bundle; a finer-than-cap source is downsampled by a
          # box mean, and #155's refusal here (which named this issue) is now that
          # downsample.
          #
          # FOUR things move together when `factor != 1`, and they are set on four different
          # lines below: the PIXELS (`arr`), the EXTENT (recomputed from `arr`), the AFFINE
          # (`emitted_affine` folds the factor) and the OME PhysicalSize
          # (`emitted_um_per_px`). Dropping any one of them produces an artifact that opens,
          # conforms and is silently misscaled — which is why `write_ome_tiff` reconciles all
          # four before writing a byte.
          factor = 1
          emitted_um_per_px = None
          if image_um_per_px is not None:
              source_extent = ome_writer.extent_of(arr)
              factor, applied_um, _emitted_extent = ome_writer.downsample_plan(
                  image_um_per_px, SD.DEFAULT_RESOLUTION_CAP_UM, source_extent
              )
              derivative = SD.display_derivative_provenance(
                  original_resolution_um=image_um_per_px,
                  # The SOURCE grid, captured BEFORE the resample — it is the only recorded
                  # fact anchored to a pixel count, and it is unrecoverable afterwards.
                  original_extent=source_extent,
                  # WHERE THE ORIGINAL IS PRESERVED (INV-2). Not re-emitted: it stays in the
                  # retained `spatial/visium-bundle` upload, whose own declaration says "the
                  # bundle is retained after import, so the vendor's own image files stay
                  # recoverable". A basename, because basename is how that container matches
                  # its members. NOT "the full-resolution original": Space Ranger ships no
                  # such file, so this names the SOURCE these pixels came from and claims
                  # nothing about how close it is to the instrument.
                  original_source=basename,
                  codec=ome_writer.CODEC,
                  tifffile_version=ome_writer.tifffile_version(),
                  resolution_cap_um=SD.DEFAULT_RESOLUTION_CAP_UM,
              )
              if factor > 1:
                  arr = ome_writer.downsample(arr, factor)
              # The resolution of the pixels ACTUALLY EMITTED, which is what OME
              # `PhysicalSizeX/Y` means. `applied_um` is `image_um_per_px * factor`, so for a
              # pass-through it is the source's own pitch, unchanged from #155.
              emitted_um_per_px = applied_um
          else:
              # SAID OUT LOUD, because otherwise the two cases are indistinguishable. With no
              # micron scale the cap CANNOT be evaluated, so this image is emitted unchecked —
              # and it carries no `display_derivative` block, exactly like an image that was
              # checked and passed. Without this note a reader cannot tell "coarse,
              # pass-through, verified" from "resolution unknown, never checked" without
              # going to a different artifact's `microns_per_pixel_source`.
              pending_warnings.append(
                  f"{basename}: emitted, but the {SD.DEFAULT_RESOLUTION_CAP_UM} um/pixel "
                  "display cap could NOT be evaluated — this bundle declares no micron "
                  "scale, so the image's own resolution is unknown. It carries no "
                  "display-derivative provenance for the same reason: absence is absence, "
                  "and a fabricated resolution is indistinguishable from a measured one."
              )

          space = SD.coordinate_space(
              space=space_id,
              unit="pixel",
              # The affine for the pixels this artifact CONTAINS, so it folds the downsample
              # factor. `emitted_affine(s, 1)` is exactly `inverse_scalefactor_affine(s)`.
              to_space=ome_writer.emitted_affine(scalef, factor),
              # AFTER the resample — `arr` was reassigned above when `factor > 1`, and this
              # must be the emitted grid, never the source's.
              extent=ome_writer.extent_of(arr),
              # THE SPACE's scale, NOT this image's own pixel pitch.
              #
              # `microns_per_pixel` is defined on the COORDINATE SPACE — `coordinate_space`'s
              # docstring frames it that way and `require_micron_scale(space, ...)` is
              # documented as "the micron scale of `space`". Passing the image's own pitch
              # here (`microns_per_pixel / scalef`) would make three artifacts that declare
              # the SAME `coordinate_space` disagree about its scale by 5x and 16.7x — and
              # because the image's block is the ONLY one a sandboxed consumer can read, a
              # neighbour-graph radius resolved through it would be silently wrong by exactly
              # that factor. That is the failure `require_micron_scale` exists to prevent,
              # reintroduced one level up.
              #
              # This image's own pixel pitch is not lost: it is derivable as
              # `microns_per_pixel * to_space[0]`, it is recorded verbatim as
              # `display_derivative.original_resolution_um`, and it is written natively into
              # the OME-XML as `PhysicalSizeX/Y` (where OME's own semantics ARE "the physical
              # size of a pixel in THIS image").
              microns_per_pixel=microns_per_pixel,
              # ...and WHICH leg produced it. `_PLACEMENT_KEYS` carries this into the
              # OME-XML, so a sandboxed image consumer can audit the scale it is handed
              # rather than only apply it (#211/#222). A value without its provenance is
              # the pairing this contract refuses on the coordinates channel; carrying it
              # on one channel and not the other was the asymmetry.
              microns_per_pixel_source=microns_per_pixel_source,
          )
          meta = SD.image_meta(space=space, derivative=derivative, role=spec["role"],
                              source=basename)

          # COVERAGE, computed here — BEFORE the artifact is committed — precisely so that
          # nothing after the commit point can raise. Applying the image's own affine to
          # its own far corner gives the region of the space it covers; if the spots fall
          # outside that, the image and the coordinates are not describing the same
          # capture area.
          #
          # A note rather than a refusal, because a legitimately cropped or partial vendor
          # image exists and refusing it would be worse than reporting it — but silence
          # would be worst of all, since this is what a misregistration looks like from
          # the outside and it is the one symptom available WITHOUT the human overlay
          # (#156).
          # SAID OUT LOUD, in the artifact a human reads (#176 / DEC-11). The pixels this
          # user will look at are averages the importer computed, not what the instrument
          # measured, and the report is where the existing `images_not_emitted` and coverage
          # channels already say that kind of thing. A pass-through says NOTHING — a note on
          # every import would train the reader to ignore the channel.
          downsample_note = None
          if factor > 1:
              # The RAGGED STRIP, named rather than left to be derived from the two grids.
              # A floor division discards up to `factor-1` rows AND columns of real
              # measured tissue, and the reader of a display derivative is entitled to know
              # how much of the source is simply not in it.
              dropped_w = derivative["original_extent"]["width"] % factor
              dropped_h = derivative["original_extent"]["height"] % factor
              # Only the axis that ACTUALLY lost something is named. Saying "the last 2
              # column(s) and 0 row(s) were dropped" asserts a loss that did not occur, in
              # the one channel this note exists to be honest in.
              parts = ([f"{dropped_w} column(s)"] if dropped_w else []) + \
                      ([f"{dropped_h} row(s)"] if dropped_h else [])
              dropped = (
                  f" The last {' and '.join(parts)} of the source did not fill a whole "
                  "block and were dropped rather than padded, because padding would invent "
                  "a measurement."
                  if parts else ""
              )
              downsample_note = (
                  f"{basename}: emitted as a DISPLAY DERIVATIVE — downsampled {factor}x by "
                  f"box mean, from {derivative['original_resolution_um']:g} to "
                  f"{derivative['applied_resolution_um']:g} um/pixel (the "
                  f"{derivative['resolution_cap_um']:g} um/pixel display cap), "
                  f"{derivative['original_extent']['width']}x"
                  f"{derivative['original_extent']['height']} -> "
                  f"{derivative['emitted_extent']['width']}x"
                  f"{derivative['emitted_extent']['height']} pixels. Compression is lossless "
                  "and every emitted pixel is the mean of a real block of real measurements, "
                  "but these are not the pixels this importer was given: its SOURCE is "
                  f"preserved in the uploaded bundle as `{basename}`." + dropped
              )

          coverage_note = None
          if coverage_bounds is not None:
              # #155's formula, UNCHANGED — and under the CORNER convention the emitted
              # affine uses (DEC-14) it is not an approximation but the EXACT outer edge:
              # pixel index i spans `[i*a, (i+1)*a)`, so W pixels reach exactly `W*a`, and
              # the translation is identically 0.
              #
              # Two variants were tried here while a block-centre translation was briefly in
              # the affine, and both are recorded because each was wrong in a way worth not
              # repeating: `+ to_space[2]` LOOSENS the estimate, so the under-coverage
              # warning would fire less often exactly when the pixels got bigger — the wrong
              # direction for the only misregistration symptom available without #156's
              # overlay — and `(W - 0.5)*a + tx` is the exact edge only under CENTRE
              # anchoring, which this affine does not use, while also moving the numbers
              # #155's coverage test pins.
              covered_w = meta["extent"]["width"] * meta["to_space"][0]
              covered_h = meta["extent"]["height"] * meta["to_space"][4]
              max_x, max_y = coverage_bounds
              if covered_w < max_x or covered_h < max_y:
                  coverage_note = (
                      f"{basename}: emitted, but it covers only "
                      f"{covered_w:.0f} x {covered_h:.0f} full-resolution pixels while the "
                      f"spots extend to {max_x:.0f} x {max_y:.0f}. The image and the "
                      "positions may not describe the same capture area — check the "
                      "registration overlay before reading anything off this image."
                  )

          rel = f"{spec['output_id']}.ome.tif"
          # ONE call site builds the placement; the manifest copy and the OME-XML copy are
          # both derived from `meta` here (DEC-6), never computed twice.
          ome_writer.write_ome_tiff(
              outputs_dir / rel, arr, placement=meta,
              # THE EMITTED image's own pixel pitch -> OME `PhysicalSizeX/Y`, whose semantics
              # are exactly that. The SPACE's scale went into `meta` above. They are
              # different numbers (5x apart on a hires image) for different readers, and
              # they do not share a parameter name.
              #
              # `emitted_um_per_px`, NOT `image_um_per_px`: after a downsample a pixel in
              # this image is `factor` times larger, and a generic OME reader — one that
              # knows nothing about the `txr` payload — measures with this number alone.
              # `write_ome_tiff` refuses if this disagrees with the recorded
              # `applied_resolution_um` or with the affine.
              image_microns_per_pixel=emitted_um_per_px,
          )
      except (ome_writer.ImageConversionError, SD.SpatialDeclarationError,
              OSError) as exc:
        # ONE guard around the WHOLE per-image body, because the failure this closes is
        # not a missing branch — it is that the raises are spread across nine calls and a
        # per-call `except` will always miss the next one. Round 1 added `math.isfinite`
        # to the scalefactor guard and still aborted the entire import on a SUBNORMAL
        # scalefactor (1e-320 is finite and positive; 1/1e-320 is `inf`), because the
        # failure is in the DERIVED quantity, not the input. A truncated vendor PNG did
        # the same through `OSError`.
        #
        # Losing one image must never cost the matrix, the coordinates, the columns and
        # the report — INV-6's stated posture is that a bundle with a damaged scale file
        # is still importable, and a damaged IMAGE is the same class of problem.
        #
        # The tuple is DELIBERATELY not widened to bare `ValueError`, even though
        # `SpatialDeclarationError` subclasses it. Catching `ValueError` costs nothing that
        # any test needs — the subnormal case raises `SpatialDeclarationError` and the
        # truncated PNG raises `OSError`, both named — while converting a genuine logic bug
        # on an untested path into a plausible "image skipped" note that reads exactly like
        # a damaged input. `AttributeError`/`TypeError` already propagate, and a real bug
        # should too.
        skipped.append(
            # FUNNELLED (#336 FIX_ROUND-2), even though this is NOT a refusal and the structural
            # guard's subject set therefore cannot see it. A blind correctness angle pointed out
            # that "every value is funnelled" would be read more broadly than it was true: this
            # string is vendor-derived (`{exc}` comes from `tifffile`/`PIL` reading the vendor's
            # own image and echoes its text), it is UNBOUNDED, and it is a DIAGNOSTIC A USER
            # READS — it lands in the report's `images_not_emitted` and in the summary HTML. The
            # report is `json.dumps(..., ensure_ascii=True)`, so control characters and non-ASCII
            # are escaped there; the LENGTH was not bounded anywhere, and the same string reaches
            # the operator through paths that are not JSON.
            # `basename` is NOT funnelled and that is deliberate: it comes from the module's own
            # `VENDOR_IMAGES` table, or from the `UNNAMED_IMAGE` constant when the entry carries
            # none. It is not vendor-derived, and quoting it broke
            # `test_image_robustness.py::test_a_spec_without_a_basename_cannot_turn_a_caught_
            # refusal_into_an_abort`, which asserts the note STARTS WITH that constant — a
            # legitimate guard this fix had no business moving. Escaping is for values an attacker
            # chooses; applying it to a module constant costs a real assertion and buys nothing.
            f"{basename}: not emitted — "
            f"{_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}"
        )
        continue

      # ── THE COMMIT POINT, deliberately OUTSIDE the guard ─────────────────────────
      #
      # `write_ome_tiff` has returned, so the bytes are on disk; from here the image IS
      # emitted. Nothing below may raise into the handler above, because the handler
      # appends to `skipped` — and an exception here would then put the SAME image in
      # `entries`, on disk, AND in `images_not_emitted` at once. That is the exact defect
      # the two note channels were split to remove, and leaving the commit inside the
      # `try` would have reintroduced it structurally rather than by oversight.
      #
      # Every statement here is total: list appends and truth tests on values computed
      # before the write.
      entries.append(output_entry(
          spec["output_id"], DT_SPATIAL_IMAGE, rel, "artifact",
          structure=txr_columns.opaque(IMAGE_MEDIA_TYPE),
          meta=meta,
          label=f"Tissue image ({spec['role']})",
      ))
      # PAST THE COMMIT POINT — the bytes are on disk, so every note that ASSERTS emission is
      # now true. Flushed here rather than appended in place for the reason above.
      warnings.extend(pending_warnings)
      if downsample_note:
          warnings.append(downsample_note)
      if coverage_note:
          warnings.append(coverage_note)
    return entries, skipped, warnings


# ─────────────────────────────── the import ───────────────────────────────


def run_import(bundle_root, outputs_dir):
    """The whole import. Returns the manifest `entries` list.

    Factored out of `main` so the end-to-end test can drive the REAL code over the REAL
    fixture and read the artifacts back, rather than testing a re-implementation of it.
    """
    import h5py
    import pandas as pd

    outputs_dir = Path(outputs_dir)
    members = locate_members(bundle_root)
    progress("read", 5, "reading the Space Ranger bundle")

    # BOTH VENDOR TEXT DOCUMENTS ARE READ HERE AND CONSUMED FAR BELOW (#330 / DEC-4), for one
    # reason: every refusal THIS DESIGN ADDS must precede the first writer, which is
    # `txr_csc.write_csc_zarr`.
    #
    # `read_scalefactors` was called in the coordinate-space block, after the
    # expression store, both axis stores and every metadata column were on disk — MEASURED by
    # un-hoisting it again on the fixed body, a refusal there left 51 paths behind.
    #
    # `read_positions` joined it at FIX_ROUND-2. Its new not-valid-UTF-8 refusal was correctly
    # NAMED but fired at its old site, and MEASURED it left the same 51 paths — which made the
    # design's own INV-2 scope note ("OTHER, correctly-named refusals still fire after the first
    # writer") false about a refusal this design had just added. A blind angle caught that the
    # sentence was self-contradictory; the honest repair is to move the read, not to widen the
    # sentence.
    #
    # Both reads are pure, both results are bound once and only read, and `locate_members` has
    # already proved both members exist — so nothing else about the import moves. The one visible
    # consequence is ORDERING: a bundle that is bad in several ways now reports whichever of
    # these two refusals fires first rather than the matrix refusal.
    scalefactors = read_scalefactors(members["scalefactors"])
    positions = read_positions(members["positions"])

    # ── the matrix ───────────────────────────────────────────────────────────────────
    entries = []
    # The OPEN is guarded NARROWLY (#345 / #451): only `h5py.File(...)` is wrapped, so a
    # file that is not HDF5 at all becomes a named refusal instead of an `OSError`
    # traceback at exit 1. The guard is NARROW in POSITION on purpose: only the OPEN is
    # wrapped, so an internal defect anywhere in the hundreds of lines below is not
    # laundered into a refusal about the customer's bundle — a defect in this importer is
    # a defect, and it must not be reported as a problem with the bundle.
    h5 = refuse_unopenable_matrix_file(members["matrix"])
    with h5:
        group = refuse_unreadable_matrix_group(h5)
        # THE STRUCTURAL NET (#462): every object reachable under `/matrix` must live
        # INLINE in this bundle's own matrix file. h5py FOLLOWS an `h5py.ExternalLink`
        # transparently, so a bare `group[member]` would return an ordinary dataset IN
        # ANOTHER FILE and every predicate below would pass — the counts would come
        # from a file OUTSIDE this bundle's matrix file. This walk fires BEFORE ANY MEMBER READ and
        # before the first writer (`txr_csc.write_csc_zarr`), so a refused bundle
        # leaves no store, no partial store and nothing for a later reader to find
        # (INV-2).
        refuse_outside_matrix_objects(group, members["matrix"])
        # THE ALIAS NET (#462): the seven consumed members must be seven DISTINCT
        # objects. The walk above refuses every ExternalLink and every object that
        # resolves outside the bundle's matrix file, but a HARD LINK or a SAME-FILE SoftLink chain
        # makes two consumed names resolve to ONE object in THIS file — the realpath
        # comparison cannot see it. This fires BEFORE ANY MEMBER READ and before the
        # first writer, so a refused bundle leaves no store (INV-2).
        refuse_aliased_matrix_members(group)
        # THE ROOT-ATTRIBUTE READ IS GUARDED (#471). `dict(h5.attrs)` MATERIALISES every
        # attribute value, and h5py raises while doing so on a truncated or corrupt
        # attribute, a datatype it cannot map, or an attribute whose object header or
        # global-heap backing is damaged. None of those is a `VisiumImportError`, so
        # they escaped `main()`'s `except VisiumImportError` as rc 1 and a raw
        # traceback with absolute source paths — INV-1's prohibited outcome. MEASURED
        # through the shipped entrypoint on this base: a vlen root attribute whose
        # global-heap object length is corrupt raised
        # `OSError: Can't synchronously read data (ran off end of input buffer while
        # decoding)` at this exact line, rc 1, 0 paths. The guard is NARROW in
        # POSITION on purpose, like the open guard above: only the materialisation is
        # wrapped, so a genuine internal error in the hundreds of lines below is not
        # laundered into a refusal about the customer's bundle. And it is NARROW in
        # MEMBERSHIP: `refuse_unencodable_vendor_text` (the parse boundary immediately
        # below) is NOT wrapped, and its semantics do not change. The read is before
        # the first writer (`txr_csc.write_csc_zarr`), so a refusal here leaves no
        # store, no partial store and nothing for a later reader to find (INV-2).
        # **ValueError/OverflowError ARE IN THE TUPLE ON PURPOSE:** materialising an
        # attribute allocates `numpy.zeros(shape, dtype)` from the FILE-DECLARED
        # dataspace dims, so absurd/negative dims raise ValueError/OverflowError — the
        # malformed-file class the sibling open guard already catches (`ValueError`).
        try:
            attrs = dict(h5.attrs)
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, ValueError, RuntimeError, OverflowError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s root attributes cannot be read "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                "matrix carries its identity there: `library_ids`, "
                "`software_version`, `chemistry_description` and `filetype`. A file "
                "whose root attributes cannot be materialised cannot be named by "
                "this importer, and its coordinate frame cannot be declared. Check "
                "that the matrix file is complete, or re-export the Space Ranger "
                "`outs/` bundle. Refusing rather than shipping a matrix this "
                "importer cannot describe."
            ) from None
        # THE FIRST PARSE BOUNDARY (#330). `h5py` decodes a UTF-8-typed string attribute with
        # `surrogateescape`, so a root attribute holding bytes that are not valid UTF-8 comes
        # back as lone surrogates in `U+DC80..U+DCFF` — a `str` no UTF-8 encoder can write — and
        # a fixed-length `|S` attribute comes back as raw invalid `bytes`, which is the shape the
        # REAL fixture uses for `library_ids` (`|S27`). Both reach `vendor_provenance` as
        # `matrix_attrs`, and from there `provenance.library_id` and `coordinate_space_id`.
        # MEASURED on the committed fixture: the `str` shape aborted the writer with an uncaught
        # `UnicodeEncodeError` and 59-117 paths already on disk, and the `bytes` shape completed
        # and shipped `provenance.library_id = '\ufffd\ufffdSR'` — three different vendor byte
        # strings collapsing into that one identifier and one `coordinate_space`.
        #
        # It fires BEFORE ANY ARTIFACT BYTE EXISTS: the first writer is `write_csc_zarr`,
        # below inside the same `with h5:` block, so a refused bundle leaves no store, no
        # partial store and nothing for a later reader to find.
        refuse_unencodable_vendor_text(
            attrs,
            source=f"`{MATRIX_BASENAME}`'s root attributes",
            remedy="Re-export the complete Space Ranger `outs/` bundle.",
        )
        shape = refuse_malformed_shape(group)
        # `int(...)` is a no-op at runtime -- `refuse_malformed_shape` has already proved
        # `shape` holds exactly two integers -- and is written so the #336 structural guard can
        # PROVE these two names are integers where they are interpolated into a refusal below
        # (DEC-2). A guard that cannot prove a value safe must refuse it, so the source states
        # the fact rather than the guard guessing at it.
        n_features, n_barcodes = int(shape[0]), int(shape[1])
        # STRICTLY, and refused BY NAME rather than as a traceback -- see
        # [`decoded_h5_strings`]. These are join keys, so a loose decode would pair one spot's
        # position with another spot's counts.
        # `/matrix/features` is subscripted AT THE CALL SITES below, outside
        # `decoded_h5_strings`' own try/except, so it is validated here first (#451).
        refuse_malformed_features(group)
        # `/matrix/barcodes` gets the same ABSENT / PRESENT-BUT-UNREADABLE /
        # NOT-A-DATASET / VIRTUAL-OR-EXTERNAL treatment the features members get
        # (Finding C). A dangling SoftLink there used to fall into
        # `decoded_h5_strings`' `except KeyError` and be refused as "has no
        # `/matrix/barcodes`" — a FALSE reason (the link exists, its target does not)
        # — and a VIRTUAL `/matrix/barcodes` was refused nowhere and silently yielded
        # fill-value bytes, letting the import proceed deep into the writer with
        # garbage barcodes (MEASURED: rc 2 for an unrelated positions reason, 51 paths
        # on disk). This fires BEFORE the read it protects and before the first writer.
        _refuse_malformed_member_dataset(
            group, "barcodes", "/matrix/barcodes",
            absent_what="A 10x feature-barcode matrix carries the barcodes and all "
                        "three feature columns; a matrix missing one of them cannot be "
                        "imported, because there would be nothing to align the counts "
                        "to.",
            unreadable_what="A 10x feature-barcode matrix carries the barcodes and all "
                            "three feature columns; a member that cannot be read is not "
                            "a matrix this importer can carry.",
            not_dataset_what="A 10x feature-barcode matrix stores its barcodes as a "
                             "dataset; anything that is not a dataset is not a matrix "
                             "this importer can read.",
            inline_what="A 10x feature-barcode matrix stores its barcodes INLINE; a "
                        "dataset whose values depend on files outside the bundle's "
                        "matrix file cannot be imported — the importer cannot know "
                        "what it will read, and an unresolvable source silently "
                        "yields the fill value rather than an error.",
            must_be_string=True,
        )
        barcodes = decoded_h5_strings(group, "barcodes")
        gene_ids = decoded_h5_strings(group["features"], "id", "/matrix/features/id")
        gene_names = decoded_h5_strings(group["features"], "name", "/matrix/features/name")
        # THE THREE STRING DATASETS ARE CROSS-CHECKED AGAINST THE DECLARED SHAPE,
        # BEFORE THE FIRST WRITER. `gene_names` was missing from this check (Finding A):
        # it is consumed much later, at the `write_metadata_column` call that writes
        # `axis/gene_symbol.zarr`, and `_lib` then raised a bare `ValueError` ("this
        # table declares N rows while its membership(s) name M") AFTER `write_csc_zarr`
        # and the axis stores were on disk — MEASURED: rc 1, a raw traceback, 39 paths
        # left behind. Each arm names WHICH dataset disagreed and both numbers, so an
        # operator can go and look at the right member.
        if (len(barcodes) != n_barcodes or len(gene_ids) != n_features
                or len(gene_names) != n_features):
            if len(gene_names) != n_features:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME} declares shape "
                    f"{_quoted_list_for_refusal(shape, noun='dimension')} but "
                    f"`/matrix/features/name` carries {int(len(gene_names))} entries "
                    f"while the matrix declares {int(n_features)} features."
                )
            if len(gene_ids) != n_features:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME} declares shape "
                    f"{_quoted_list_for_refusal(shape, noun='dimension')} but "
                    f"`/matrix/features/id` carries {int(len(gene_ids))} entries "
                    f"while the matrix declares {int(n_features)} features."
                )
            raise VisiumImportError(
                f"{MATRIX_BASENAME} declares shape "
                f"{_quoted_list_for_refusal(shape, noun='dimension')} but "
                f"`/matrix/barcodes` carries {int(len(barcodes))} entries "
                f"while the matrix declares {int(n_barcodes)} barcodes."
            )

        # THE MATRIX-SIDE DUPLICATE (#478). The positions-side duplicate is refused below
        # ("a spot has one position"); the MATRIX-side duplicate was silently accepted, and
        # it is worse: two matrix columns map onto ONE position, `axis/barcode.zarr` ships a
        # non-unique key sequence, and every downstream `aligned_to` join on the cells axis
        # is then ambiguous. The digest self-check further down cannot see it -- it checks
        # that the digest matches, not that the keys are distinct. "Duplicate" means the
        # DECODED strings `decoded_h5_strings` produced -- the exact values that become the
        # `axis/barcode.zarr` key sequence -- compared as-is (no stripping, no case
        # folding), because those are the keys every downstream join actually sees.
        seen_barcodes, repeated = set(), []
        for bc in barcodes:
            (repeated.append(bc) if bc in seen_barcodes else seen_barcodes.add(bc))
        if repeated:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} lists {len(repeated)} barcode(s) more than once "
                f"(first: {_quoted_list_for_refusal(repeated[:3], noun='barcode')}). A "
                "barcode is the key every artifact on the cells axis is joined by, so a "
                "repeated one makes the emitted axis index ambiguous -- two rows of counts "
                "claiming one spot, and no downstream join able to tell them apart."
            )

        # 10x stores the matrix CSC over (features x barcodes): `indptr` has one entry per
        # BARCODE and `indices` holds FEATURE ids. Read column-per-barcode with row-per-
        # feature is, term for term, CSR over (barcodes x features) — which is exactly the
        # `cells x genes` row-major source the writer's streaming transpose wants. So the
        # orientation is DECLARED here from the file's own shape dataset rather than
        # sniffed: `source_for_h5` reads the shape from an ATTRIBUTE (the h5ad spelling)
        # and 10x writes it as a DATASET, so the generic sniffer cannot read this file.
        # Constructing the source directly also keeps the whole import out-of-core; the
        # alternative (scanpy's `read_10x_h5` -> AnnData -> re-serialise) materialises the
        # entire matrix, which is what `txr_csc` exists to avoid.
        # THE MATRIX'S OWN INTERNAL CONSISTENCY, checked before it is handed to the
        # writer (INV-1 / INV-2): `_lib`'s writer raises out of shared framework on a
        # malformed `indptr`/`indices`, and a truncated `indices` imports SILENTLY with
        # a wrong matrix (rc 0, manifest written, store nnz=100 with every index 0);
        # a lying `indptr` was a raw traceback plus a five-path partial store.
        # Validating the vendor's file before handing it over is this package's job,
        # not `_lib`'s.
        refuse_malformed_counts(group, n_barcodes, n_features)
        source = txr_csc.H5CsrSource(group, shape=(n_barcodes, n_features))
        progress("matrix", 15, f"{n_barcodes} spots x {n_features} genes")
        counts_structure = txr_csc.write_csc_zarr(
            source, outputs_dir / "expression.zarr", axes=("cells", "genes"),
        )

    provenance = vendor_provenance(attrs, members.get("metrics"))
    # `coordinate_space_id` IS NOT CALLED HERE ANY MORE (#327). Its bottom rung is derived from the
    # run's own measurement — the matrix's barcodes AND the positions joined to them — so it cannot
    # answer until the join below has run. Nothing else moves: every reader of `space_id` /
    # `space_id_source` is downstream of the join already (the coordinate-space block, the section,
    # `emit_images`, and the report), which is what makes the move safe rather than merely possible.
    # WHAT ONE ROW IS — declared ONCE, here, before the first artifact that carries it, and
    # stamped on every artifact whose rows are spots. It depends on nothing but the
    # platform's own constants, so its position is free.
    #
    # A Visium spot is 1-10 cells. `kind="cell"` would be a scientific error, not a naming
    # one, and it is additionally unreachable: the constructor REQUIRES a segmentation block
    # for `cell`, which an unsegmented capture-spot assay has none of.
    entity = SD.measured_entity(
        # THE CAPTURE FOOTPRINT, not the rendered circle (#222). `resolution_um` answers
        # "how big is the area one row measured?", which is the 55 um capture spot. The
        # 65 um constant beside it answers a different question and belongs only to the
        # micron SCALE; a single constant serving both is the defect #222 removes.
        kind="spot", platform="visium", resolution_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM,
    )

    cells_keys = pd.Series([str(b) for b in barcodes])
    genes_keys = pd.Series([str(g) for g in gene_ids])
    aligned_to = {
        "cells": txr_columns.axis_key_digest(cells_keys),
        "genes": txr_columns.axis_key_digest(genes_keys),
    }
    membership_of = {
        axis: {"aligned_to": aligned_to[axis],
               "derived_from": txr_columns.axis_key_sequence(keys),
               "members": None}
        for axis, keys in (("cells", cells_keys), ("genes", genes_keys))
    }

    entries.append(output_entry(
        "expression", DT_COUNTS, "expression.zarr", "artifact",
        structure=counts_structure,
        # `measured_entity` rides HERE TOO, not only on the coordinates. §15.1's motivating
        # case is precisely a set of sibling MATRICES that differ only in what one row is
        # (Visium HD's 2/8/16 um bins, a 5 um vs a 15 um Xenium expansion), and this is the
        # artifact every existing analysis actually consumes — so an importer that stamped it
        # only on the tissue map would leave the counts matrix saying nothing about whether a
        # row is a 55 um spot or a cell, which is the identity the field exists to record and
        # which is unrecoverable from the bytes afterwards.
        meta={"kind": "counts", "n_cells": n_barcodes, "n_genes": n_features,
              "platform": "visium", "provenance": provenance,
              "measured_entity": entity,
              "measured_entity_label": SD.measured_entity_label(entity)},
    ))

    # ── the axis key artifacts ───────────────────────────────────────────────────────
    # A column whose VALUES ARE the axis's entity keys, marked `is_axis_index` so the
    # server can resolve the axis from it. The digest SELF-CHECK is not ceremony: an
    # `aligned_to` stamped on every other artifact from `axis_key_digest` and a key
    # artifact whose stored bytes digest to something else would make every alignment on
    # this dataset silently wrong, and the conformance gate would fail the rows one by one
    # with nothing saying why.
    for axis, name, keys in (("cells", "barcode", cells_keys),
                             ("genes", "gene_id", genes_keys)):
        structure, meta = txr_columns.write_metadata_column(
            outputs_dir, f"axis/{name}.zarr", name, keys, axis=axis,
            holds_axis_keys=True,
        )
        if structure.get("key_sequence_digest") != aligned_to[axis]:
            raise VisiumImportError(
                f"the {axis} key artifact digests to "
                f"{_quoted_for_refusal(structure.get('key_sequence_digest'), noun='digest')} "
                f"but every artifact on this axis was stamped "
                f"{_quoted_for_refusal(aligned_to[axis], noun='digest')}. Refusing rather than "
                f"emitting a "
                f"dataset whose alignment is wrong in a way nothing downstream can see."
            )
        meta["is_axis_index"] = True
        entries.append(output_entry(
            f"metadata-column:{name}", DT_METADATA_COLUMN, f"axis/{name}.zarr",
            "artifact", label=name, axis=axis, structure=structure, meta=meta,
        ))

    # The gene SYMBOL column, on the genes axis — the vendor ships it and it is what a
    # human reads. Not an axis index (the id is), so it carries `aligned_to`.
    structure, meta = txr_columns.write_metadata_column(
        outputs_dir, "axis/gene_symbol.zarr", "gene_symbol",
        pd.Series([str(g) for g in gene_names]), axis="genes",
        aligned_to=aligned_to["genes"], membership=membership_of["genes"],
    )
    entries.append(output_entry(
        "metadata-column:gene_symbol", DT_METADATA_COLUMN, "axis/gene_symbol.zarr",
        "artifact", label="gene_symbol", axis="genes", structure=structure, meta=meta,
    ))

    # ── the positions, JOINED to the matrix's barcode order ──────────────────────────
    # `tissue_positions.csv` holds EVERY spot on the slide (4,992 on a V1 slide); the
    # filtered matrix holds only the in-tissue subset, in ITS OWN order. A positional zip
    # of the two would align the wrong spot to the wrong barcode for every row — which is
    # not an error, it is a picture of the tissue with the values shuffled.
    progress("positions", 45, "joining tissue positions to the matrix barcodes")
    # `positions` was read at the top of `run_import`, before the first writer — see there.
    by_barcode = {}
    for i, bc in enumerate(positions["barcode"]):
        if bc in by_barcode:
            raise VisiumImportError(
                f"{_quoted_for_refusal(Path(members['positions']).name, noun='file name')} "
                f"lists barcode {_quoted_for_refusal(bc, noun='barcode')} more than once; "
                f"a spot has one position and choosing between two would be a guess."
            )
        by_barcode[bc] = i
    missing = [bc for bc in barcodes if bc not in by_barcode]
    if missing:
        raise VisiumImportError(
            f"{len(missing)} of the matrix's {n_barcodes} barcodes have no row in "
            f"{_quoted_for_refusal(Path(members['positions']).name, noun='file name')} "
            f"(first: {_quoted_list_for_refusal(missing[:3], noun='barcode')}). Absence is "
            f"absence: a spot with no position cannot be given one, and writing a "
            f"placeholder coordinate would put those spots somewhere real-looking on the "
            f"tissue. Re-export the bundle with a positions table covering the filtered "
            f"matrix."
        )
    rows = [by_barcode[bc] for bc in barcodes]

    def column(name, cast):
        raw = positions[name]
        try:
            return [cast(raw[i]) for i in rows]
        except (TypeError, ValueError) as exc:
            raise VisiumImportError(
                f"{_quoted_for_refusal(Path(members['positions']).name, noun='file name')} "
                f"column {name!r} holds a value that is not a number "
                f"({_quoted_for_refusal(exc, noun='message')})."
            ) from None

    # THE TRANSPOSE (INV-2). The CSV writes `pxl_row_in_fullres` (y) BEFORE
    # `pxl_col_in_fullres` (x); the stored convention is `(x, y)`. Column 0 of the member
    # is therefore the CSV's `pxl_col_*` and column 1 is its `pxl_row_*`. Getting this
    # backwards does not error — it draws the tissue transposed, and every downstream
    # neighbourhood is then measured in the wrong place. The committed fixture is
    # NON-SQUARE precisely so a test can see the difference.
    xs = np.asarray(column("pxl_col_in_fullres", float), dtype=np.float32)
    ys = np.asarray(column("pxl_row_in_fullres", float), dtype=np.float32)
    coords = np.ascontiguousarray(np.stack([xs, ys], axis=1), dtype=np.float32)

    # ── the frame identity (#327) ────────────────────────────────────────────────────
    # HERE, and not beside `vendor_provenance` where it used to sit, because the bottom rung is a
    # digest of THIS run's measurement: the matrix's own barcodes and the positions just joined to
    # them. `attrs` — the `.h5` ROOT ATTRIBUTES, not the provenance block — because the identity
    # path reads the vendor's value through `vendor_frame_label` while the provenance block records
    # it verbatim (DEC-6), and a function reading the already-stringified copy could not tell a
    # numeric attribute from a stated one.
    space_id, space_id_source = coordinate_space_id(attrs, barcodes, coords)

    # ── the coordinate space ─────────────────────────────────────────────────────────
    # `scalefactors` was read at the top of `run_import`, before the first writer — see there.
    # WHICH SLIDE DESIGN, and therefore which circle `spot_diameter_fullres` measures (#257).
    # Read from the vendor's own fiducial/spot ratio, in which the pixel scale cancels — NOT
    # from the assay, which is measured to be the wrong key for it (see `SLIDE_DESIGNS`).
    design = slide_design(scalefactors)
    # WHICH ASSAY. Deliberately AFTER both producers it reads (DEC-6): `vendor_provenance`
    # has the `.h5` attributes and `read_scalefactors` the JSON. Nothing about the scale gates
    # on this — it exists so the report NAMES the assay rather than leaving a reader to derive
    # it, which is #222's lesson.
    assay = detect_assay(scalefactors, members, provenance)
    microns_per_pixel, scale_source = micron_scale(
        # THE RENDERED CIRCLE (#222) — the only numerator that measures what
        # `spot_diameter_fullres` measures. NOT `VISIUM_CAPTURE_SPOT_DIAMETER_UM`.
        # #257: and the rendered circle of THIS SLIDE DESIGN, not of Visium in general —
        # `design["rendered_spot_diameter_um"]` is 65/70/60 um depending on which design the
        # bundle's own two vendor numbers identify, or the standard 65 um where it identifies
        # none (and `design["matched_by"]` then says `assumed-standard`, in the report).
        scalefactors, rendered_spot_diameter_um=design["rendered_spot_diameter_um"]
    )
    # WAS THE DESIGN'S NUMERATOR ACTUALLY APPLIED? Only on DEC-6's leg 2. Leg 1 takes a
    # vendor-STATED `microns_per_pixel` verbatim and divides nothing, and leg 3 declares no
    # scale at all — on both, the design is a fact ABOUT the bundle that the scale does not
    # descend from. Recorded rather than inferred, because the report and the scale check both
    # SAY which numerator was used, and saying "the numerator is the 70 um circle" about a run
    # that never divided by it is a false provenance statement in the exact channel #257 added
    # so that a reader would not have to derive provenance. Caught by a blind audit.
    # …and WHICH LEG produced the scale, recorded beside the flag rather than inferred from
    # it. `applied_as_scale_numerator` is False on leg 1 AND on leg 3, and those are different
    # facts — a blind audit measured the first cut telling a bundle that declares NO scale at
    # all that "the vendor stated `microns_per_pixel` directly". The explanation is keyed on
    # this, in `registration_qc._NOT_APPLIED_BECAUSE`.
    design = dict(design,
                  applied_as_scale_numerator=(scale_source == "derived-from-spot-diameter"),
                  scale_source=scale_source)
    space = SD.coordinate_space(
        space=space_id,
        # FULL-RESOLUTION PIXELS, always (INV-1). Storing hires-scaled coordinates would
        # bake in a choice of image and make a second image (CytAssist, a post-hoc H&E)
        # unplaceable. The coordinates therefore map into their own space by the IDENTITY
        # affine, and each image declares its own affine INTO this frame — the direction
        # that composes.
        unit="pixel",
        to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        microns_per_pixel=microns_per_pixel,
        # WHICH leg of DEC-6 produced the scale, and which produced the space id. Declared
        # INSIDE the space block — not bolted onto `meta` afterwards — because after #211
        # this block is what crosses into the sandbox: a provenance recorded outside it is
        # a provenance no analysis can read. Without it a stated number and a derived one
        # are indistinguishable downstream, which is the property `require_micron_scale`
        # exists to protect (and the disagreement #222 is about).
        microns_per_pixel_source=scale_source,
        coordinate_space_source=space_id_source,
    )
    placement = SD.positioning(
        # Every barcode in the filtered matrix has a position — the join above REFUSED
        # the run otherwise — so this is a measured claim, not an optimistic default.
        partial=False,
    )
    series = SD.section(
        # #327. The value, through the same predicates the frame identity uses — the three raw
        # reads this replaced are in `section_sample_id`'s own docstring, with what each emitted.
        sample_id=section_sample_id(provenance, attrs, space_id),
        # One section per bundle: a Space Ranger run is one capture area. Recording the
        # ordinal now is free and unrecoverable later; the section->section transform is
        # deliberately NOT designed (serial-section registration is frequently non-linear,
        # so an affine would be worse than nothing).
        index=0,
    )

    coord_structure, coord_meta = SD.write_spatial_coordinates(
        outputs_dir, "spatial/coordinates.zarr", coords,
        axis="cells", space=space, entity=entity, placement=placement, series=series,
        aligned_to=aligned_to["cells"], membership=membership_of["cells"],
    )
    coord_meta.update({
        # `microns_per_pixel_source` and `coordinate_space_source` are NOT set here any
        # more: they are declared inside `coordinate_space(...)` above, which merges flat
        # into this same `meta`, so the emitted row is unchanged and the two keys now also
        # reach a sandboxed consumer (#211). Everything below is a CATALOG/DISPLAY fact
        # with no analysis consumer, which is why it stays in `meta` only.
        "platform": "visium",
        "provenance": provenance,
        # #183 OPTION A — the two 1-D siblings this artifact's positions can also be read
        # as. Declared HERE, in `meta`, because the filter-VD gather re-mints `structure`
        # and copies `meta` verbatim, so this is the only channel the declaration survives
        # a filter in. The client uses the SAME declaration to offer the tissue map in the
        # Coordinates picker and to draw it, so the artifact can never be
        # offered-but-blank.
        "component_columns": [COMPONENT_X, COMPONENT_Y],
    })
    if "spot_diameter_fullres" in scalefactors:
        # §7.3 rule 4: a spot is a DISC, not a point, and the renderer needs its radius to
        # draw it at the right size at every zoom. In the same units as the coordinates.
        #
        # Written only when the vendor states it. This used to be an unconditional
        # `scalefactors.get(...)`, which spelled an unknown diameter as an explicit `null` —
        # the same "written as unknown rather than dropped" shape `vendor_provenance` refuses
        # three hundred lines up, and a reader would have had to special-case it.
        coord_meta["spot_diameter_fullres"] = scalefactors["spot_diameter_fullres"]
    entries.append(output_entry(
        "spatial-coordinates", DT_COORDINATES, "spatial/coordinates.zarr", "artifact",
        label="tissue map", axis="cells",
        structure=coord_structure, meta=coord_meta,
    ))
    progress("coordinates", 65, f"{len(coords)} spot positions")

    # ── the per-spot columns ─────────────────────────────────────────────────────────
    in_tissue = np.asarray(column("in_tissue", int)) != 0
    per_spot = [
        # `in_tissue` as a BOOL, which `write_metadata_column` stores as a categorical
        # with a declared `["false","true"]` legend — a filterable, colour-by-able flag
        # rather than a number a user has to know the encoding of.
        ("in_tissue", pd.Series(in_tissue)),
        ("array_row", pd.Series(np.asarray(column("array_row", int), dtype=np.int32))),
        ("array_col", pd.Series(np.asarray(column("array_col", int), dtype=np.int32))),
        # INV-7 of the epic plan: a `platform` / `measurement_unit` column so a future
        # scientific-disclosure layer has something to DISPATCH ON. This item owes the
        # column; it does not owe the disclosure.
        ("platform", pd.Series(["visium"] * n_barcodes)),
        ("measurement_unit", pd.Series([entity["kind"]] * n_barcodes)),
        # #183 Option A. These are ordinary 1-D numeric columns and nothing about them is
        # special to the gather — which is the entire point: they survive a filter through
        # the path that already works. `float32`, so they are bit-identical to the columns
        # of the 2-D member they mirror.
        (COMPONENT_X, pd.Series(xs)),
        (COMPONENT_Y, pd.Series(ys)),
    ]
    for name, values in per_spot:
        rel = f"metadata/{name}.zarr"
        structure, meta = txr_columns.write_metadata_column(
            outputs_dir, rel, name, values, axis="cells",
            aligned_to=aligned_to["cells"], membership=membership_of["cells"],
        )
        entries.append(output_entry(
            f"metadata-column:{name}", DT_METADATA_COLUMN, rel, "artifact",
            label=name, axis="cells", structure=structure, meta=meta,
        ))
    progress("columns", 85, f"{len(per_spot)} per-spot columns")

    # ── the images (#155) ────────────────────────────────────────────────────────────
    # After the coordinates, because every image places itself INTO the space they define.
    progress("images", 90, "converting the tissue images")
    image_entries, image_skipped, image_warnings = emit_images(
        members, outputs_dir, space_id=space_id,
        microns_per_pixel=microns_per_pixel, microns_per_pixel_source=scale_source,
        scalefactors=scalefactors,
        # The spots' own extent in the full-resolution frame, so an image that does
        # not cover them can say so. Computed from the coordinates that were just
        # written, not re-read from the CSV.
        coverage_bounds=(float(coords[:, 0].max()), float(coords[:, 1].max()))
        if len(coords) else None,
    )
    entries.extend(image_entries)

    # ── the registration QC (#156) ───────────────────────────────────────────────────
    # AFTER the images are on disk, because the check reads the artifact AS STORED — the
    # bytes a consumer would actually get — rather than the in-memory array this function
    # happened to have. That is what makes it a check on the shipped path.
    #
    # This is the only thing in this importer that measures against a referent OUTSIDE the
    # artifact: the Visium slide's manufactured 100 um spot pitch, and the tissue visible in
    # the vendor's own image scored against the vendor's own `in_tissue` call. TEST-9 (#155)
    # and TEST-11 (#176) both assert that a wrong artifact passes everything else, and both
    # name this as the only real check.
    progress("registration", 95, "checking the registration against the slide and the tissue")
    # THE WHOLE POSITIONS TABLE, not the matrix-joined subset — and this is load-bearing, not
    # an optimisation.
    #
    # `filtered_feature_bc_matrix.h5` holds ONLY the spots under tissue, so `in_tissue` is
    # uniformly 1 across every row of the coordinates artifact. Scored over that subset the
    # registration check has ONE class, specificity is undefined, and Youden's J can never be
    # computed — the check would report `not-evaluated` on every real Visium bundle in
    # existence, which is a check that cannot fail. (Measured: the committed fixture's matrix
    # carries 120 barcodes and all 120 are in-tissue.)
    #
    # `tissue_positions.csv` carries EVERY spot on the slide — 4,992 on a V1 — with the
    # vendor's `in_tissue` call for each, which is exactly the two-class label the mask has to
    # be scored against. The registration is a property of the coordinate space and the image,
    # not of which spots survived filtering, so there is no reason to inherit that filter here;
    # Space Ranger's own `detected_tissue_image.jpg` draws the whole array for the same reason.
    #
    # The axis transpose is applied here AGAIN, from the same columns and in the same
    # direction, rather than reusing `xs`/`ys` — those are matrix-ordered. Getting it wrong
    # here would draw a correct import as a misregistration.
    def _qc_column(name, cast):
        try:
            return [cast(v) for v in positions[name]]
        except (TypeError, ValueError):
            return None

    qc_x = _qc_column("pxl_col_in_fullres", float)
    qc_y = _qc_column("pxl_row_in_fullres", float)
    qc_flag = _qc_column("in_tissue", int)
    if qc_x is None or qc_y is None or qc_flag is None:
        # A positions table this importer already ACCEPTED for the matrix's own barcodes can
        # still hold an unparseable value in a row the matrix does not use. That must not cost
        # the whole check, and it must not silently fall back to the one-class subset either —
        # so the QC gets the matrix-ordered arrays and says which sample it used.
        qc_coords, qc_in_tissue, qc_scope = coords, in_tissue, "matrix-joined-spots"
    else:
        qc_coords = np.ascontiguousarray(
            np.stack([np.asarray(qc_x, dtype=np.float64),
                      np.asarray(qc_y, dtype=np.float64)], axis=1))
        qc_in_tissue = np.asarray(qc_flag) != 0
        qc_scope = "all-spots-in-positions-table"
    qc, overlays = registration_qc.registration_qc(
        coords=qc_coords,
        in_tissue=qc_in_tissue,
        scope=qc_scope,
        microns_per_pixel=microns_per_pixel,
        scale_source=scale_source,
        image_entries=image_entries,
        outputs_dir=outputs_dir,
        # The spot's real physical diameter — what the overlay draws a spot AS. This is the
        # 55 um capture spot, which is what `measured_entity.resolution_um` also carries and
        # is a different question from what the vendor's `spot_diameter_fullres` spans. #222
        # made that sentence load-bearing by giving the other question its own constant: the
        # overlay draws the area transcripts came from, so it stays on the CAPTURE diameter.
        spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM,
        # Corroboration only, and gated on nothing (DEC-13). `01-sequencing-platforms.md:70`
        # forbids reconstructing positions from these; measuring a SPACING from them is a
        # different operation, and it is reported beside the nearest-neighbour estimate so a
        # reader sees two independent estimators rather than one.
        # Gated on `qc_scope`, i.e. on the SAME three-way test the coords/in_tissue fallback
        # above uses. Gating these on `qc_x` alone meant that if `qc_x` parsed but `qc_y` or
        # `in_tissue` did not, `coords` fell back to the matrix-joined subset while the array
        # indices came from the whole positions table. `lattice_fit_pitch`'s length guard
        # catches the usual mismatch — but when the two have EQUAL row counts in a different
        # ORDER (an all-in-tissue bundle), the lengths agree, the fit runs over mismatched
        # (index, position) pairs, and a FABRICATED pitch is published in the report as
        # independent corroboration. Corroboration that is invented is worse than none.
        array_row=(_qc_column("array_row", int) if qc_scope == "all-spots-in-positions-table"
                   else column("array_row", int)),
        array_col=(_qc_column("array_col", int) if qc_scope == "all-spots-in-positions-table"
                   else column("array_col", int)),
        # #257. WHICH rendered-spot circle the scale under test came from, so the check's own
        # `reason` names it on both branches. It gates nothing: the referent is still the
        # slide's 100 um pitch, which no slide design can move — that is what makes this check
        # external, and threading a producer's own record into it must not change that.
        slide_design=design,
    )

    # ── the report ───────────────────────────────────────────────────────────────────
    diagnostics, omitted = {}, []
    for path in members["diagnostics"]:
        uri = inline_diagnostic(path)
        if uri is None:
            omitted.append(Path(path).name)
        else:
            diagnostics[Path(path).name] = uri
    report = {
        "kind": "visium-import-report",
        "analysis": "spatial.import-visium",
        "coordinate_space": space_id,
        "coordinate_space_source": space_id_source,
        "n_spots": n_barcodes,
        "n_genes": n_features,
        "n_spots_in_tissue": int(in_tissue.sum()),
        "n_positions_in_bundle": len(positions["barcode"]),
        "measured_entity": entity,
        "measured_entity_label": coord_meta["measured_entity_label"],
        "microns_per_pixel_source": scale_source,
        "scalefactors": scalefactors,
        "provenance": provenance,
        # WHICH ASSAY, said out loud (#257 / INV-2). A CytAssist bundle used to import with
        # nothing anywhere saying it was one; a report that does not name the assay leaves the
        # reader to derive it from the scalefactor keys, which is the work #222 cost a human.
        "assay": assay,
        # WHICH SLIDE DESIGN the micron scale came from, and HOW it was identified. Carried
        # beside `microns_per_pixel_source` because the two together are the whole provenance
        # of the number: `microns_per_pixel_source` says which LEG produced it,
        # `slide_design.matched_by` says which NUMERATOR that leg divided and on what evidence.
        "slide_design": design,
        "positions_file": Path(members["positions"]).name,
        "component_columns": [COMPONENT_X, COMPONENT_Y],
        "diagnostics_omitted": omitted,
        # WHICH images were emitted, and — the half that matters — which were NOT and why.
        # A silently absent image is how a user discovers at overlay time that there is
        # nothing to overlay on (INV-9/DEC-8).
        # The display-derivative provenance travels verbatim (#176), and the key is OMITTED
        # rather than set to null when there is none — `.get()` would have written
        # `"display_derivative": null`, which is a value where the rest of this package is
        # scrupulous that absence is spelled by the key not being there (`image_meta` omits
        # it; TEST-5 asserts `not in`). The report was the one place a consumer would have
        # seen a null and had to know it meant the same thing.
        #
        # Absent means the image's resolution could never be evaluated (no micron scale),
        # which is a DIFFERENT fact from "evaluated and untouched" — `image_warnings` says
        # which.
        "images": [
            dict(
                {"id": e["id"], "source": e["meta"].get("source"),
                 "role": e["meta"].get("role"), "to_space": e["meta"]["to_space"],
                 "extent": e["meta"]["extent"]},
                **({"display_derivative": e["meta"]["display_derivative"]}
                   if "display_derivative" in e["meta"] else {}),
            )
            for e in image_entries
        ],
        # TWO channels, because one was being read as the other. `images_not_emitted` is
        # the set a consumer filters on to learn what is MISSING; folding "emitted, but
        # the cap could not be evaluated" into it made a successfully emitted image count
        # as absent.
        "images_not_emitted": image_skipped,
        "image_warnings": image_warnings,
        # #156. The verdicts and every number behind them, machine-readable — so a consumer,
        # or a later gate, can refuse on this without re-deriving it. The import itself does
        # NOT refuse (DEC-7): a diagnostic that destroys a user's access to their data when it
        # is uncertain is worse than one that reports loudly, which is the same posture
        # `emit_images` takes for a damaged image.
        "registration_qc": qc,
        "library_versions": txr_deps.resolve_and_check()["libraries"],
    }
    if microns_per_pixel is not None:
        report["microns_per_pixel"] = microns_per_pixel
    else:
        # Said out loud, in the artifact a human reads. A silently absent scale is how a
        # user discovers three analyses later that nothing can measure a distance.
        report["scale_note"] = (
            "this bundle's scalefactors_json.json declares neither `microns_per_pixel` "
            "nor `spot_diameter_fullres`, so the coordinate space declares NO physical "
            "scale. Analyses that measure in micrometres (a neighbour-graph radius, a "
            "distance threshold) will refuse rather than assume one."
        )

    (outputs_dir / "visium-import-report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    entries.append(output_entry(
        "visium-import-report", DT_REPORT_QC, "visium-import-report.json", "artifact",
        structure=txr_columns.opaque("application/json"),
        meta={"kind": "visium-import-report", "n_spots": n_barcodes,
              "coordinate_space": space_id,
              # #156's verdict, in the ONE channel this app shows a human — see
              # `qc_verdict_lines`. The full block is in the JSON body; these are the lines a
              # reader sees without opening anything.
              #
              # #257 puts the assay and the slide design in the SAME channel and for the same
              # reason: the assay is the first thing a reader needs when a scale check fires,
              # and it must not require opening the JSON to get it.
              "assay": assay["assay"],
              "slide_design": design["id"],
              "slide_design_matched_by": design["matched_by"],
              "registration_qc_verdict": qc["verdict"],
              "registration_qc": qc_verdict_lines(qc)},
    ))
    # THE LOAD-BEARING `encoding=` (#330 / DEC-6). This write carries FREE PROSE, and this
    # module's own prose contains an em dash. With the LOCALE default, MEASURED on the ORDINARY
    # committed fixture in a subprocess at `ANSI_X3.4-1968`:
    #
    #     UnicodeEncodeError: 'ascii' codec can't encode character '\u2014' in position 517
    #       import_visium.py  run_import  ->  visium-import-summary.html
    #     paths on disk: 117
    #
    # i.e. on a machine with a non-UTF-8 locale EVERY import died with an uncaught
    # `UnicodeEncodeError` and exit 1 after 117 paths were on disk — the same shape #330 reports
    # for a hostile bundle, reached by the ENVIRONMENT instead of by an attacker, on a bundle
    # with nothing wrong with it. A producer's text write is part of its refusal contract: a
    # write whose encoding comes from the environment can abort a job for a reason the job's own
    # inputs cannot explain.
    (outputs_dir / "visium-import-summary.html").write_text(
        render_report_html(report, diagnostics, overlays), encoding="utf-8"
    )
    entries.append(output_entry(
        "visium-import-summary", DT_REPORT_HTML, "visium-import-summary.html",
        "intermediate",
        structure=txr_columns.opaque("text/html"),
        meta=dict(
            {"kind": "visium-import-summary",
             "diagnostics_embedded": sorted(diagnostics),
             "registration_qc_verdict": qc["verdict"],
             "registration_qc": qc_verdict_lines(qc),
             "overlay_embedded": sorted(overlays)},
            # SAID OUT LOUD in the artifact record, because the alternative is a reader
            # believing they have seen the overlay. This report EMBEDS the rendered overlay
            # and nothing in this app renders `report/html`.
            #
            # The key is OMITTED rather than set to null when there is no overlay — the same
            # discipline the report applies to `display_derivative`, where a `.get()` would
            # have written a null into a document that everywhere else spells absence by the
            # key not being there.
            **({"overlay_note": (
                "the rendered registration overlay is embedded in this HTML, and this "
                "application has no renderer for `report/html` — the verdict lines above are "
                "what reaches a reader today."
            )} if overlays else {}),
        ),
    ))
    return entries


def main():
    inputs_dir, outputs_dir = io_dirs()
    params(inputs_dir)  # no parameters today; read so a future one has a place to land
    slots = load_inputs_index(inputs_dir)
    bundle = None
    for name in ("bundle", "input", "dataset"):
        if name in slots and Path(slots[name]).exists():
            bundle = Path(slots[name])
            break
    if bundle is None:
        for path in slots.values():
            if Path(path).exists():
                bundle = Path(path)
                break
    if bundle is None:
        bundle = inputs_dir
    try:
        entries = run_import(bundle, outputs_dir)
    except VisiumImportError as exc:
        print(f"spatial.import-visium: {exc}", file=sys.stderr, flush=True)
        sys.exit(2)
    write_manifest(outputs_dir, entries)
    progress("done", 100, f"{len(entries)} outputs")


if __name__ == "__main__":
    main()
