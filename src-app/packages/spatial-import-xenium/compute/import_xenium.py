#!/usr/bin/env python3
# ruff: noqa
"""spatial.import-xenium — a 10x Xenium Onboard Analysis `outs/` bundle -> workbench
artifacts (#162, epic #151).

The SECOND importer. #154 shipped Visium; this one exists to find out whether the spatial
abstraction generalises past one vendor, and to say plainly where it does not. It follows
`import_visium.py` in every respect that Xenium does not genuinely differ in, and each
place it diverges is a decision with a reason, recorded below and in DECISIONS.md.

Reads `/inputs/<slot>` (the auto-grouped `spatial/xenium-bundle` dataset), writes
`/outputs/<file>` plus `/outputs/manifest.json`. `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR` are
the ONLY seam that lets a test drive the REAL script off-sandbox, which is what
`tests/test_producer_end_to_end.py` does.

## The four places Xenium is genuinely a different problem

**1. The coordinates are already MICROMETRES.** Visium's are full-resolution PIXELS and
carry a `microns_per_pixel` derived from `spot_diameter_fullres`. Xenium's `x_centroid` /
`y_centroid` are microns, so the space declares `unit: "micrometre"` and NO
`microns_per_pixel` — `spatial_declarations.coordinate_space` REFUSES that field there, and
`require_micron_scale` answers `1.0` by definition. The entire class of defect that field
exists to prevent is therefore *structurally absent* on the coordinates. It does not
disappear: it moves onto the IMAGE, which is the only pixel grid left, and that is what the
scale cross-check below is for.

**2. The image is a JPEG-2000 Z-stack or channel stack, not a PNG.** `ome_writer.read_image`
refuses everything but a plain `YX`/`YXS` plane — correctly, and it names the Xenium
morphology image as the case it guards against. `xenium_image.read_plane` is the sanctioned
reduction to a plane, done in this package, with the selection DECLARED.

**3. Provenance is not in the matrix.** Xenium's `cell_feature_matrix.h5` root attributes
are `{filetype, library_ids, original_gem_groups, version}` and nothing else — no
`software_version`, no `chemistry_description`. Everything §7.4 wants lives in
`experiment.xenium`, which the design's own table names for the Xenium row. And
`library_ids` is `0000000_0000000` on real bundles, so it is USELESS as a coordinate-space
id and actively dangerous as one: two unrelated experiments would collide into one declared
frame. `roi_uuid` is used instead (DEC-7).

**4. One row is a SEGMENTED CELL, and the segmentation can vary row by row.** `kind="cell"`
requires a segmentation block, which is right; but XOA >= 3 mixes boundary-stain,
interior-stain and nucleus-expansion segmentation WITHIN ONE RUN (measured: three methods
across 358 cells in a real bundle), and `measured_entity.segmentation.method` is a single
string. The mixture is named rather than reduced to one of its parts, and the per-cell truth
is kept as a column. That the declaration cannot express it is a finding against #152, not
something to paper over here.

## The external referent — what #176 could not close, and how much of it Xenium closes

#176 recorded a standing limitation: a wrong vendor scale produces a fully self-consistent,
uniformly misscaled artifact that passes every check this system has, because every guard
checks INTERNAL consistency and Visium states its scale exactly once.

Xenium states the same number TWICE, in two files written by two parts of the vendor
pipeline — `experiment.xenium`'s `pixel_size`, and the morphology TIFF's own OME-XML
`PhysicalSizeX`/`PhysicalSizeY` — and supplies a third, GEOMETRIC constraint: the cell
centroids are in microns and the image is in pixels, so the centroids must fall inside
`extent_px * pixel_size`. A single-source error is therefore VISIBLE here, and is
REPORTED — both raw numbers, the measured relative difference, and which statement placed
the image, in `stated_scales`. It is not refused: 0.4.0 refused above a hard-coded `1e-6`
that nothing justified, and refusing costs the user the image while removing the only input
#156's overlay needs (#269). What is still not caught, said plainly rather than implied: a
vendor whose two statements are wrong the same way, by a factor small enough to keep the
centroids inside the image. `tests/test_scale_referent.py` asserts that case still passes,
deliberately, so the residue is measured rather than claimed shut. §7.5's registration
overlay remains the only real check on the affine itself — AND IT NOW EXISTS FOR THIS
PRODUCER (#301). `compute/registration_qc.py` is this package's own: it places every cell
centre through the image's DECLARED `to_space`, read back out of the emitted artifact's own
OME-XML, onto a signal mask derived from the emitted PIXELS, and reports how far above CHANCE
the cells land on signal. The vendor segmented these cells FROM that image, so the pixels and
the cell table are two independent recordings and neither is a function of the affine — which
is what makes the referent external, and is the one thing every other guard in this file
cannot be. Until #301 this file said, correctly, that no such control existed here (#291);
that paragraph is corrected rather than removed, because a disclosure of absence and its
retirement are the same claim in two directions.

WHICH LEAVES A NARROWER RESIDUE, NOT NONE. The overlay decides between the two vendor
statements when they differ — it scores the placement each one implies over the same pixels —
and it sees every factor-scale and axis-order error. What it still cannot see is a scale wrong
the SAME way in both statements by an amount small enough to keep the cells on their own
nuclei: measured, a 2% error scores 0.303 against a 0.4 floor. So `test_the_residue_*` still
asserts that case passes, and every score is reported as a NUMBER beside its verdict so the
margin is visible rather than laundered into a word.
"""
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
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
import cyto_columns
import cyto_csc
import cyto_deps

# The VENDORED write-time contract (#152) and its executable OME half (#155/#176), both
# staged beside this entry by `run.helpers` and both byte-identical to
# `spatial-types/compute/`. `tests/test_vendored_contract.py` holds that shut.
import spatial_declarations as SD
import ome_writer
import xenium_image
import boundaries as BD
# This package's OWN: design §7.5's registration QC overlay, built for this producer by #301.
# Staged beside the entry by `run.helpers` and imported by bare name, exactly as the sibling
# importer imports its own copy.
import registration_qc as RQC

# ── datatype vocabulary ──────────────────────────────────────────────────────────────
# Declared HERE because the package knows its own output types; `_lib` is framework code
# and may not name a contributed domain's vocabulary.
DT_COUNTS = ("single-cell/counts", "chunked-sparse")
DT_COORDINATES = ("spatial/coordinates", "chunked-dense")
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_QC = ("report/qc", "opaque")
DT_REPORT_HTML = ("report/html", "opaque")
DT_RUN_ENVIRONMENT = ("report/qc", "opaque")
DT_SPATIAL_IMAGE = ("spatial/image", "opaque")
#: #163. `columnar-table` is `StorageLayout::ColumnarTable.as_str()`
#: (`workstore/artifact/mod.rs:64`) — the SAME layout `da/result` already uses for a
#: multi-column table over a non-`cells` axis, which is why that writer is the pattern this
#: one mirrors rather than inventing a shape.
DT_BOUNDARIES = ("spatial/boundaries", "columnar-table")

#: WHAT JUDGES THE PLACEMENT OF THIS PRODUCER'S BOUNDARIES: §7.5's registration QC overlay,
#: which this importer now produces (#301).
#:
#: Design §7.5 makes a rendered registration QC overlay — geometry drawn on the tissue image
#: at the DECLARED transform, judged by a human — "a required output of the importer, not a
#: nice-to-have ... the entire verification story for step 7.3". #156 built that overlay for
#: `spatial-import-visium` and CLOSED, and until #301 this block said, correctly, that this
#: producer had none: no registration QC module, none staged, no `report/qc` overlay for any
#: bundle (#291). That is no longer true. `compute/registration_qc.py` is this package's own
#: and every run that emits a morphology image emits the overlay beside it.
#:
#: WHAT IT DOES AND DOES NOT SETTLE FOR *BOUNDARIES* SPECIFICALLY, because this block is about
#: polygons and the overlay draws CENTRES. #247 removed `boundaries.coverage_against`'s
#: invented `_SCALE_HINT_MAX = 5.0` — correctly, §7.3 prescribes no such arithmetic — and
#: recorded the residue in DEC-5: "a uniform scale error satisfies both remaining booleans and
#: is now caught by nothing". The overlay is that residue's mitigation and it now exists: the
#: polygons and the centroids are written into the SAME coordinate space by the SAME writer
#: call, so a uniform scale error on the boundaries is a uniform scale error on the centres,
#: and the overlay sees it. What the overlay does NOT do is check the polygons' own SHAPE
#: against the image — it draws each cell as a disc of its vendor-measured area, not as its
#: outline — so a boundary set that is correctly SCALED and wrongly SHAPED is still judged by
#: the two facts `boundary_coverage` reports and by nothing else.
#:
#: SCOPED DELIBERATELY, and still not widened into "everything here is checked". The package's
#: other producer-side measurements are unchanged: `stated_scales` cross-checks the bundle's
#: two independent statements of the pixel size, and `coverage_note` checks the image extent
#: against the cell centroids. Neither can decide a registration on its own, which is exactly
#: why §7.5 assigns that to a human looking at an overlay — and why the overlay reports a
#: NUMBER beside its verdict rather than only a word.
#:
#: Mirrors `scale_referent.compensating_control`'s shape (#269) rather than inventing a
#: second convention.
PLACEMENT_JUDGEMENT = {
    "what": ("the registration QC overlay — cell centres drawn on the tissue image at the "
             "declared transform, judged by a human (design §7.5)"),
    "issue": "#301 (built here); #156 built the Visium sibling",
    "built_for": ("this importer AND `spatial-import-visium`, as two different checks "
                  "answering the same design section — Xenium has no fixed-pitch capture "
                  "slide and no vendor `in_tissue` flag, so neither of #156's two referents "
                  "transfers"),
    "status": ("PRODUCED by this importer. It is computed on every bundle that emits a "
               "morphology image; the rendered PICTURE is withheld in the one case where it "
               "would carry no marks at all — every cell mapping outside the image's frame, "
               "which is what a badly wrong affine looks like — because a bare thumbnail is "
               "indistinguishable from a registration nobody checked. The verdict and every "
               "number behind it are in `registration_qc` either way, and that block says "
               "which of the two happened"),
    "judged_by_here": ("the overlay in `report/qc` — every cell centre placed through the "
                       "image's DECLARED `to_space`, read back out of the emitted artifact's "
                       "own OME-XML, onto a signal mask derived from the emitted pixels, "
                       "scored as how far above CHANCE the cells land on signal. The vendor "
                       "segmented these cells from that image, so the pixels and the cell "
                       "table are two independent recordings and neither is a function of the "
                       "affine"),
    "consequence": ("a uniform scale error on the boundaries is a uniform scale error on the "
                    "centres — they are written into the same coordinate space by the same "
                    "writer call — so the overlay now sees the class of defect #247's DEC-5 "
                    "recorded as caught by nothing. What it still does not see: a scale wrong "
                    "the same way in BOTH vendor statements by under about 2% (measured: a 2% "
                    "error scores 0.303 against a 0.4 floor), a misregistration that moves the "
                    "image and the cells TOGETHER, and a boundary set correctly scaled but "
                    "wrongly shaped, which the two facts below are still the whole of. The "
                    "workbench can also draw these coordinates on the image at the declared "
                    "transform (#228's image-to-coordinates binding); that is now a second "
                    "way to see the same picture rather than the only one"),
    "the_fix": ("read the overlay — a `report/qc` artifact of any run whose cells land on its "
                "own image — and read `registration_qc` for the verdict, which is there "
                "whether or not the picture was"),
    "tracked_as": ("#301 (built it); #291 (the disclosure it retires); #302 (the same prose, "
                   "still stale in the shared modules this package vendors)"),
}

#: The media type the image artifact declares — a real RFC 6838 `type/subtype` with a
#: parameter, which `conformance._MEDIA_TYPE_RE` accepts (§6.3). Same string the Visium
#: importer writes; one image kind, one media type.
IMAGE_MEDIA_TYPE = "image/tiff; application=ome"

# ── the bundle's declared members ────────────────────────────────────────────────────
#: `spatial/xenium-bundle`'s members, by basename. THREE, and the image is not among them
#: (DEC-2): its name changes between XOA versions (`morphology_focus.ome.tif` ->
#: `morphology_focus/morphology_focus_0000.ome.tif` -> `morphology_focus/ch####_<stain>.
#: ome.tif`), and since member matching is by basename a name that moves would make the
#: whole bundle ungroupable on exactly the versions it was added for. `experiment.xenium`
#: names its own images, so the image is located from the vendor's manifest instead.
MATRIX_BASENAME = "cell_feature_matrix.h5"
CELLS_BASENAME = "cells.csv.gz"
EXPERIMENT_BASENAME = "experiment.xenium"

#: The `cells.csv.gz` columns this importer reads. `cells.parquet` carries the identical
#: values — VERIFIED BIT-EXACT at float32 on two real bundles — and reading the CSV avoids a
#: parquet reader, which this tree pins nowhere (DEC-3). The vendor writes 17 significant
#: digits, so the text form is the full float, not a rounding of it.
CELL_ID_COLUMN = "cell_id"
X_COLUMN = "x_centroid"
Y_COLUMN = "y_centroid"
SEGMENTATION_COLUMN = "segmentation_method"

#: The vendor's own per-cell numeric columns, emitted verbatim as `metadata-column`s. Every
#: one is a measurement the vendor made and none is recoverable from the matrix: the control
#: classes in particular are how a user judges a Xenium run's decoding quality.
VENDOR_CELL_COLUMNS = (
    ("transcript_counts", int),
    ("control_probe_counts", int),
    ("genomic_control_counts", int),
    ("control_codeword_counts", int),
    ("unassigned_codeword_counts", int),
    ("deprecated_codeword_counts", int),
    ("total_counts", int),
    ("cell_area", float),
    ("nucleus_area", float),
    ("nucleus_count", int),
)

#: The two 1-D component columns (#183 Option A). IDENTICAL names to the Visium importer's,
#: deliberately (DEC-19): #203 is currently a LOUD 404 on the shipped Visium shape because
#: the member is named `coordinates` while the recipe hardcodes `values`. Renaming would
#: convert that into silent wrong data, and diverging here would make it two bugs instead of
#: one affecting two importers identically.
COMPONENT_X = "spatial_x"
COMPONENT_Y = "spatial_y"

#: THE ONLY feature class that becomes a `single-cell/counts` artifact.
GENE_EXPRESSION = "Gene Expression"

#: Xenium protein, named rather than dropped in silence (design §15.5). It is a
#: `MEAN_PER_CELL_STAIN` metric multiplied by a root-attribute `protein_scaling_factor` (10
#: on the real bundle) "that must be divided out". Emitting it unscaled would be a
#: fabrication; emitting it scaled would still put a mean-intensity metric into a kind that
#: MEANS integer UMI counts. Its correct home is a protein-aware kind, which is a later item.
PROTEIN_EXPRESSION = "Protein Expression"

#: EVERY OTHER FEATURE CLASS IS DROPPED FROM THE EXPRESSION MATRIX, and this is the design's
#: own Xenium-specific rule rather than a judgement made here — §6.5, verbatim:
#:
#:     "Negative controls are dropped from the expression matrix and kept in the points
#:      table flagged … That is a QC input, not expression."
#:
#: An earlier cut of this importer followed the HOUSE rule instead — `multimodal.
#: split_by_feature_types`' "EVERY distinct value becomes its own modality; NONE collapsed
#: into RNA, NONE discarded" — and emitted one `single-cell/counts` store per class. That is
#: right for a CITE-seq h5ad, where every class is a real measurement of a real analyte, and
#: it is wrong here, measurably: the real XOA-3 bundle carries 8,096 `Unassigned Codeword`
#: and 609 `Negative Control Codeword` features, and `single-cell/counts` is EXACTLY the
#: datatype every shipped `subtypes_of: single-cell/expression` selector resolves. So
#: `qc.10x`, `cell.filter`, `embedding.reduce` and `de.compare` would each have offered to
#: cluster and differentially-express 8,096 decoding FAILURES as though they were genes —
#: a plausible-looking wrong analysis, which is the outcome this whole arm exists to prevent.
#:
#: Nothing measured is lost at the level a user acts on: the vendor's PER-CELL totals for
#: every control class are emitted as ordinary `metadata-column`s straight from
#: `cells.csv.gz` (`control_probe_counts`, `genomic_control_counts`,
#: `control_codeword_counts`, `unassigned_codeword_counts`, `deprecated_codeword_counts`),
#: which is how a Xenium user actually judges decoding quality. What IS deferred is the
#: PER-FEATURE control counts, and §6.5 says where they belong — the transcripts points
#: table, flagged — which is #164. Recorded so that item inherits the obligation rather
#: than rediscovering it. The raw matrix stays in the retained bundle either way.
CONTROL_CLASSES_ARE_NOT_EXPRESSION = (
    "design §6.5: \"Negative controls are dropped from the expression matrix and kept in "
    "the points table flagged … That is a QC input, not expression.\" `single-cell/counts` "
    "is what every shipped `subtypes_of: single-cell/expression` selector resolves, so "
    "emitting this class would offer it to qc, filtering, embedding and differential "
    "expression as though it were a gene panel. The vendor's per-cell total for this class "
    "IS emitted, as a metadata-column; the per-feature counts belong to the transcripts "
    "points table (#164)."
)

#: WHICH per-cell column carries a dropped control class's own total. Named as a mapping so
#: the report can point a reader at what IS emitted rather than only at what is not — a drop
#: with no forwarding address reads as data loss even when nothing was lost.
_CONTROL_CLASS_COLUMNS = {
    "Negative Control Probe": "control_probe_counts",
    "Genomic Control": "genomic_control_counts",
    "Negative Control Codeword": "control_codeword_counts",
    "Unassigned Codeword": "unassigned_codeword_counts",
    "Deprecated Codeword": "deprecated_codeword_counts",
}

#: WHICH statement of the pixel size the emitted affine is built from, named in the artifact
#: rather than left to be inferred. When the bundle's two statements disagree, a placement
#: with no record of which side produced it is a silent pick — which is the hazard DEC-15's
#: refusal was written to avoid and which this declaration, not a refusal, now closes (#269).
_APPLIED_SCALE_SOURCE = f"{EXPERIMENT_BASENAME}:pixel_size"

#: THERE IS NO AGREEMENT TOLERANCE HERE, AND THAT IS THE MEASURED POSITION (#269, DEC-2).
#:
#: 0.4.0 carried `_STATED_SCALE_RTOL = 1e-6` and REFUSED the image above it. The magnitude had
#: no basis: no vendor statement about the precision of `PhysicalSizeX` relative to
#: `pixel_size`, no measurement, no design section. (#269 also said it was "tighter than a
#: float32 round-trip in places". THAT IS ARITHMETICALLY FALSE and is corrected here rather
#: than repeated: float32's worst relative round-trip error is 2^-24 = 5.96e-08, always
#: below 1e-6, and 0.2125 round-trips at 2.80e-08 — so the band was ~17x LOOSER than that
#: population's worst case (and ~36x looser than 0.2125's own), not tighter, and no
#: re-exported bundle could have tripped it. The band's
#: problem was never that it was too tight. It was that no measurement said anything about
#: where it should sit, and it destroyed a user's image on the strength of that.)
#:
#: So it was measured, on 10x's own published bundles rather than on this package's fixtures.
#: Eight real bundles spanning XOA 1.0.1 -> 3.0.0 (breast Rep1/Rep2, mouse brain, colon,
#: breast 2fov, lung 2fov, pancreas, Prime skin): every one writes the SAME decimal literal
#: `0.2125` in `experiment.xenium` and in the morphology OME-XML, parsing to bit-identical
#: float64 on both axes. Observed relative difference: exactly 0.0, on all eight, N=8,
#: SPREAD ZERO.
#:
#: A tolerance is calibrated from the spread of a legitimate population. With no spread there
#: is no calibrating population, so every candidate band from 1e-16 to 1e0 is equally
#: consistent with the evidence — which is the definition of an invented number. What the
#: measurement DOES settle is that these are not two measurements of one quantity; they are
#: two serializations of one literal. "Identical or not" therefore needs no number at all,
#: and the magnitude of any difference is REPORTED for a human to judge.
#:
#: THE MEASUREMENT IS THE ARGUMENT. What follows is corroboration, and is stated as such
#: because an earlier draft overreached: §12.2 sits under "Known weaknesses of this design"
#: and says no gate CAN check a registration — it does not forbid a producer from refusing a
#: self-inconsistent bundle, and the deleted check was not a registration check anyway (it
#: compared two vendor statements of one number and never touched an external referent).
#: What §12.2 does establish is that no mechanical test can DECIDE this question, so an
#: uncalibrated one must not be allowed to decide a user-visible outcome; and §7.5 names the
#: control that can — the registration QC overlay, where a human sees whether the cells land
#: on the tissue. An overlay needs the image, so refusing the image removed its only input.
#:
#: BE HONEST ABOUT THAT OVERLAY: it is #156 and IT IS NOT BUILT. This importer emits none
#: today (see the manifest's "NO registration overlay" note). So the position 0.6.0 ships is
#: "report the measurement and emit the artifact the eventual control will need", NOT "the
#: human control has taken over from the mechanical one". `scale_referent` says so in the
#: emitted report rather than only here.
#:
#: Same shape as #247 one module over (`boundaries.py::coverage_against`), for the same reason.

#: THE VENDOR'S OWN PLACEHOLDER SPELLINGS, dropped rather than recorded.
#:
#: Measured, not anticipated: the protein bundle writes `panel_design_id: "N/A"` and the
#: prime bundle writes `panel_predesigned_id: ""` and `segmentation_stain: ""`. Copying
#: those through would put a value where the vendor has none — and a consumer reading
#: `panel_design_id` would get the string `"N/A"` as though a design id existed. Absence is
#: absence, and the vendor saying so in words does not make it a fact.
#:
#: A CLOSED list rather than a heuristic: dropping any short or odd-looking string would
#: eventually drop a real id. These are the exact spellings observed in real bundles, and a
#: new one shows up as a value nobody can use rather than as silent data loss.
#:
#: `0000000_0000000` joined at #327/#328 (DEC-8), and it is a MEASUREMENT rather than a guess:
#: #270's DEC-7 rejected `library_ids` as this importer's frame identity precisely BECAUSE both
#: committed real bundles carry exactly that value there, and
#: `test_provenance.py::test_the_visium_rule_would_collide_on_both_real_bundles` pins the
#: measurement. #327's own table carries the consequence one package over —
#: `library_id='0000000_0000000'` answering ONE frame for two unrelated Visium runs.
#:
#: This tuple is NOT "a vocabulary of real words" — `-` never was one. It is the vocabulary of the
#: spellings a vendor uses for NO ANSWER, and that is the only thing that gets added to it. #320's
#: DEC-4 refused a longer `_VENDOR_PLACEHOLDERS` as the ANSWER to the self-naming-field problem,
#: which is unbounded because there is a generic label for every field name; recording one measured
#: null spelling is a different act, and it is what this list is for. The limit is stated in
#: `docs/design/xenium-declaration-residues.md` §4.6: a vendor-stated identity is only ever as
#: unique as the vendor made it, and two runs a human genuinely gave one name DO share one frame.
#:
#: KEPT BYTE-FOR-BYTE IN STEP with `spatial-import-visium`'s copy. The two importers are siblings,
#: not a vendored pair, so nothing mechanical holds them equal — TEST-15 asserts the two tuples
#: agree, because one frame scheme spelled two ways is two frame schemes.
_VENDOR_PLACEHOLDERS = ("", "n/a", "na", "unknown", "none", "null", "-", "0000000_0000000")

#: `experiment.xenium` keys copied verbatim into provenance. Every one is a processing step
#: we did not run (INV-6 / §7.4), recorded into the EXISTING channel; no second provenance
#: channel is created and #77 is not worked around.
PROVENANCE_KEYS = (
    ("analysis_sw_version", "pipeline"),
    ("instrument_sw_version", "instrument_software"),
    ("chemistry_version", "chemistry"),
    ("panel_name", "panel"),
    ("panel_organism", "panel_organism"),
    ("panel_design_id", "panel_design_id"),
    ("panel_type", "panel_type"),
    ("preservation_method", "preservation_method"),
    ("run_name", "run_name"),
    ("region_name", "region_name"),
    ("slide_id", "slide_id"),
    ("instrument_sn", "instrument_serial"),
)

#: Parsed out of the vendor's own free-text `segmentation_method` — the ONE number §15.1
#: says is unrecoverable and decisive ("a 5 um-expansion cell set and a 15 um one have the
#: SAME row count and differ in every cell").
_EXPANSION_RE = re.compile(r"nucleus expansion of\s*([0-9]*\.?[0-9]+)\s*(?:µm|um)",
                           re.IGNORECASE)

#: The run-level segmentation mixture the vendor states in `experiment.xenium`. Recorded in
#: `params` so a mixed run's composition is a number, not an adjective.
_SEGMENTATION_FRACTION_KEYS = (
    "segmented_cell_stain_frac",
    "segmented_cell_boundary_frac",
    "segmented_cell_interior_frac",
    "segmented_cell_nuc_expansion_frac",
    "imported_cell_frac",
)


class XeniumImportError(RuntimeError):
    """A refusal. Every one of them names what was missing and what to do about it."""


def unencodable_vendor_text(node, _trail=()):
    r"""The first `(where, text)` in a parsed vendor document that CANNOT BE WRITTEN — or `None`.

    THE PARSE-BOUNDARY GUARD (#329), and it is the whole of the fix rather than one field's share
    of it.

    ## What gets in, and why nothing downstream can see it coming

    `experiment.xenium` is attacker-controlled JSON. `json.loads` ACCEPTS a `"\ud800"` escape —
    a lone surrogate — out of a file that is itself PURE ASCII, and hands back a `str` that no
    UTF-8 encoder can write. Every read path in this module then passes it through unexamined:
    `_text` calls `str()` on it, `vendor_statement` only asks whether it is a placeholder,
    `_VENDOR_PLACEHOLDERS` is a vocabulary of real words, and `non_identifying_vendor_label`
    compares it to a field name. None of them is looking at whether the characters exist.

    MEASURED on a copy of the real prime bundle, one lone surrogate per field AT A TIME, against
    the body this guard replaces -- nineteen mutants, THREE outcomes. (An earlier revision of this
    comment said "two failure modes and no third" and split them 5/14. Both blind angles caught
    that, because the measurement behind it had set every field AT ONCE. Re-measured one field at
    a time:)

    * **five CRASH** (`analysis_sw_version`, `chemistry_version`, `panel_name`, `region_name`,
      `roi_uuid`). THREE of them (`analysis_sw_version`, `region_name`, `roi_uuid`) die in the
      declaration MIRROR inside `SD.write_spatial_coordinates`; the other two get past it and die
      at the `xenium-import-summary.html` write instead. (An earlier revision of this bullet said
      all five reached the mirror, and contradicted itself two paragraphs later; a blind angle
      re-measured the traceback frames per field.) The mirror is --
      named by what it does rather than by its identifier, because `test_coordinate_space.py`
      guards this file's source text against that name ("the importer asks for nothing: the
      mirror is the writer's property") and the guard is right: this module must not reach for it.
      Its `write_text(body, encoding="utf-8")` raised `UnicodeEncodeError`. `main()` catches only
      `XeniumImportError`, so that was a TRACEBACK and exit 1 -- and it arrived AFTER
      `spatial/coordinates.zarr`, `expression.zarr`, `cell_id.zarr` and the column stores were on
      disk, with no `manifest.json`. The same shape #301 recorded for `ENOSPC`: a write outside
      every guard, aborting the import at 95%.
    * **eleven COMPLETE AND SHIP A POISONED ARTIFACT.** The import reported SUCCESS, because
      `json.dumps` defaults to `ensure_ascii=True` and wrote the surrogate straight back out as
      the ASCII escape `\ud800`, into `xenium-import-report.json` and
      `xenium-import-summary.html`. The report is then unreadable: measured with the crate the
      server parses it with, `serde_json: REFUSED -- unexpected end of hex escape`. That is
      exactly the failure [`_finite`] already argues about `NaN` -- "fail the whole job at ingest
      AFTER every byte of compute, with a message about a malformed manifest and nothing pointing
      at the vendor file". TWO of the five crashers (`chemistry_version`, `panel_name`) leave such
      a report behind as well, so THIRTEEN of nineteen put an unreadable escape on disk.
    * **three COMPLETE CLEANLY** -- `segmentation_method`, a value nested under `images`, and a
      hostile KEY. Nothing reads those onto an artifact, so they left no trace anywhere under
      `/outputs`. **This guard refuses them anyway, and that is a real reduction in what imports.**
      Recorded rather than glossed, because it is the honest cost of guarding at the boundary
      instead of at each consumer -- and it is the right trade here: WHICH fields are read onto an
      artifact is a property of THIS revision of the module, so a rule scoped to today's readers
      would silently stop covering a field the day someone reads one more. A document carrying an
      unwritable string is malformed as a whole.

    So the crash is the LOUDEST outcome, not the largest, and a guard sized to the reported
    traceback would have closed five of nineteen.

    ## Why the boundary, and not the identity path

    #329 reasons this out and it is worth keeping here: the same string reaches the artifact
    through `vendor_provenance` as well as through `vendor_frame_label`, so a guard on the identity
    path leaves the crash exactly where it is while making the report look defended. Measured one
    field at a time on the pre-change body: only THREE fields reach the coordinates store's
    `zarr.json` at all -- `analysis_sw_version`, `region_name`, `roi_uuid`. (An earlier revision of
    this comment said TWO; the blind design-conformance angle re-measured it and was right.)
    `chemistry_version` and `panel_name` crash LATER, arriving through the provenance block, and
    every one of the eleven poisoning mutants reaches its artifact that way. Eight read paths and
    three write sites downstream is what makes a per-consumer guard the "same rule applied to one
    field fewer" defect this module has already shipped twice (#319's channel list, #320's
    `section_sample_id`).

    ## THE TEST IS THE ENCODE, not a codepoint range

    `value.encode("utf-8")` is the operation the declaration mirror actually performs
    (`write_text(body, encoding="utf-8")`), so the guard cannot drift from the failure it
    prevents. A `U+D800..U+DFFF` regex would be a
    second, hand-maintained spelling of it — the kind of syntactic guard that has an unbounded
    evasion space — and it would also REFUSE a legitimate astral character, because `json.loads`
    assembles a surrogate PAIR (`"🧬"`) into the single codepoint U+1F9EC, which encodes
    perfectly. Real vendor text with real non-ASCII in it must import; that control is a test, not
    a hope.

    ## BYTES ARE CHECKED TOO, and this is the arm the first revision was missing

    `str` is not the only unwritable shape, and on the h5 boundary it is not even the COMMON one.
    Both blind angles found this independently, and one of them measured the part that makes it
    decisive: **the real prime fixture stores `library_ids` as `|S15` fixed-length bytes**, which
    is the shape the vendor actually writes -- not the UTF-8 str dtype the first version of TEST-7
    poisoned. A `bytes` attribute was invisible to a `str`-only walk, and [`_text`] and
    [`vendor_provenance`] then put it through `decode(errors="replace")`. MEASURED on this branch
    before this arm existed: `b"\xff\xfeBAD"`, `b"\xfe\xffBAD"` and `b"\x80\x81BAD"` all imported
    cleanly and all emitted `provenance.matrix_library_id = "\ufffd\ufffdBAD"`. THREE distinct
    vendor byte strings collapsing into ONE identifier is the false collision this guard exists to
    prevent, arriving through the boundary it claimed to close -- and arriving SANITISED, which is
    the one outcome the decision above says never happens.

    So bytes are decoded STRICTLY here and invalid bytes are refused exactly as a lone surrogate
    is. That makes those `errors="replace"` decodes unreachable for anything that came through a
    guarded boundary, rather than merely unlikely.

    ## Keys and every depth

    Keys are walked as well as values: `json.dumps` writes a key into the same artifact bytes a
    value goes into, so an unencodable key poisons the file identically, and a document carrying
    one is malformed as a whole. Nesting is walked because `images` is a mapping this importer
    reads (`experiment.get("images")`), and both the nested and the key mutant passed unrefused
    before this.

    Returns `(where, text, at)` or `None` — or raises `XeniumImportError` when the array is past
    the walk bound (see [`_MAX_WALKED_ATTRIBUTE_BYTES`]). `where` is a dotted trail into the
    document, so the
    refusal can name the field rather than hand the user a two-thousand-byte JSON file and a
    bisection job; it is kept RAW here and escaped ONCE, at the message, so there is exactly one
    place that can forget. `at` is the offset of the offending unit **in the units of `text`'s own
    type** — a CHARACTER index for the `str` arm (`UnicodeEncodeError.start`) and a BYTE index for
    the `bytes` arm (`UnicodeDecodeError.start`). That difference is invisible in a positional
    tuple, so it is stated here; both are the right unit for slicing the value they came from,
    which is all the one consumer ([`_quoted_for_refusal`]) does with it.
    """
    if isinstance(node, str):
        try:
            node.encode("utf-8")
        except UnicodeEncodeError as exc:
            # `str(node)`, not `node`: `np.str_` subclasses `str`, and `ascii()` of one renders
            # as `np.str_('...')` under numpy 2 -- a refusal quoting a Python repr instead of the
            # vendor's value. Unreachable from today's two callers and one word to close.
            return (_trail_text(_trail), str(node), exc.start)
        return None
    # `np.bytes_` is NOT listed: it subclasses `bytes` (measured, numpy 2.2.6), so naming it would
    # be a redundancy a reader has to check rather than a case the tuple needs -- and it IS the
    # shape the h5 boundary really produces, so it is covered by the first name in the tuple, not
    # by an omission. `bytearray` and `memoryview` do NOT subclass `bytes` and are listed for that
    # reason; neither is reachable from today's two callers (JSON yields no bytes at all, and h5py
    # yields `str`/`bytes`/numpy scalars/arrays), so they are cheap completeness on a predicate
    # whose whole job is "whatever the vendor really produces" -- the same argument `_text`'s own
    # ndarray arm makes for its unreachable-today branch.
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
            # RAW, not pre-escaped: escaping happens once, at the message.
            #
            # EVERY key, not only the `str` ones. The `isinstance(key, str)` guard that used to sit
            # here made the design's "every key and every value" false for a `bytes` key -- a blind
            # angle measured it (`{b"\xff\xfeBAD": "ok"}` walked clean). No caller can produce one
            # today (JSON keys are `str`; `h5.attrs` keys are `str`), which is exactly why the
            # cheap thing is to make the code match the invariant rather than to narrow the
            # invariant to the callers that happen to exist.
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
        # An h5 attribute is as likely to be an ARRAY of strings as a scalar one — `_text` already
        # has an arm for exactly this, and a walker without one would let the second boundary's
        # commonest shape through while looking guarded. `.tolist()` on a 0-D array returns a
        # SCALAR, which the recursion below handles as itself rather than iterating it (the same
        # `TypeError: 'int' object is not iterable` `_text`'s own ndarray arm records).
        #
        # TWO BOUNDS HERE (#456), ported from the Visium sibling, and both are about `.tolist()`,
        # which materialises EVERY element of an array as a Python object before this function
        # recurses over them.
        #
        # (1) WHICH DTYPES ARE SKIPPED, as a DENY-list and not an allow-list. An allow-list of
        #     `"SUO"` was the first spelling, on the stated ground that "nothing else can carry
        #     text". FALSE: `V` is not only the HDF5 OPAQUE dtype, it is also the
        #     STRUCTURED/COMPOUND dtype, whose fields can be `S` or `U` — MEASURED on the sibling
        #     with `library_ids = np.array([(b"\xff\xfeSR",)], dtype=[("v", "S8")])` (h5py
        #     round-trips that as `dtype.kind == "V"`), which imported clean and collapsed three
        #     distinct vendor byte strings into one frame. The skip is now stated as what CANNOT
        #     carry text -- bool, signed and unsigned int, float, complex, datetime64, timedelta64
        #     -- so an unknown or future dtype kind is WALKED rather than silently skipped. A
        #     guard's default has to be to look.
        #
        # (2) A SIZE BOUND, because the dtype check alone does not bound the work. `|S1` is kind
        #     `S`, passes any text check, and materialises one Python object per element.
        #     MEASURED on the sibling, one root attribute of `np.zeros(100_000_000, dtype="|S1")`
        #     in an h5 written with `libver="latest"` (dense attribute storage lifts HDF5's 64 KB
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
            raise XeniumImportError(
                f"{MATRIX_BASENAME} carries a root attribute at "
                # `int(...)` is a no-op on a numpy `intp` and is what lets the #343 structural
                # guard PROVE these two are integers (DEC-2). Its first revision blessed them
                # because the ATTRIBUTE was called `nbytes`/`size`, which says nothing about what
                # the object returns for it; that by-name rule is gone, so the source states the
                # fact instead.
                f"{_quoted_for_refusal(_trail_text(_trail))} of {int(node.nbytes)} bytes "
                f"({int(node.size)} entries), past the {_MAX_WALKED_ATTRIBUTE_BYTES}-byte cap this "
                "importer will examine. A root attribute is METADATA -- this importer reads "
                "three short values from there -- and one this large cannot be checked for "
                "text it could not write without doing the work the check exists to bound. "
                "Re-export the complete Onboard Analysis output."
            )
        return unencodable_vendor_text(node.tolist(), _trail)
    if isinstance(node, np.void):
        # A SCALAR of the compound/opaque dtype above. It is not an `ndarray`, so it reached the
        # fall-through `return None` and was invisible -- the scalar twin of the hole (1)
        # describes. `.tolist()` gives a tuple for a compound and `bytes` for an opaque, both of
        # which the arms above handle. It carries the SAME size bound as the `ndarray` arm: an
        # opaque scalar is capped at 64 KiB only under default libver -- under `latest` dense
        # attribute storage lifts that cap, so a large opaque scalar is reachable and `.tolist()`
        # would materialise it. `node.nbytes` is the payload size (MEASURED:
        # `np.void(b"x" * 5000).nbytes == 5000`), so the same cap applies.
        if node.nbytes > _MAX_WALKED_ATTRIBUTE_BYTES:
            raise XeniumImportError(
                f"{MATRIX_BASENAME} carries a root attribute at "
                f"{_quoted_for_refusal(_trail_text(_trail))} of {int(node.nbytes)} bytes, past "
                f"the {_MAX_WALKED_ATTRIBUTE_BYTES}-byte cap this importer will examine. A root "
                "attribute is METADATA -- this importer reads three short values from there -- "
                "and one this large cannot be checked for text it could not write without doing "
                "the work the check exists to bound. Re-export the complete Onboard Analysis "
                "output."
            )
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
#: make both arbitrarily long: MEASURED, an 8 MB `run_name` ending in a lone surrogate produced an
#: 8,000,718-character single-line refusal, and the server accumulates a job's stderr with
#: `BufReader::lines()` and no per-line cap (unlike `sandbox.rs`'s `OUTPUT_CAP_BYTES` and
#: `streaming.rs`'s explicit 64 KiB clamp). Amplification is ~1:1, so this is a flood rather than a
#: bomb -- and 120 characters is more than enough to identify which value was refused. A NAMED
#: constant rather than an inline number so promoting it is a rename; it is deliberately NOT
#: operator-configurable (DEC-10): a compute runs under `--clearenv` in a flat `/code` dir with no
#: channel to a settings row, and a stderr-flood bound an operator can raise is a bound an
#: attacker can benefit from.
_REFUSAL_QUOTE_CHARS = 120

#: How many ELEMENTS of an offending SEQUENCE a refusal quotes. A per-element bound is NOT a
#: message bound: `read_cells_csv`'s `Found {header}` interpolates the cells table's header row,
#: and a header of many fields x long field names would land on ONE stderr line proportional to
#: the whole header; an h5 file can carry far more top-level members than a CSV can carry columns.
#: So the COUNT is bounded too, and the true count is always stated.
#:
#: 8 is above every legitimate case this module quotes: a Xenium cells table declares a handful of
#: columns, a 10x feature-barcode matrix h5 has one or two top-level members, and the
#: missing-barcode refusal already slices to 3. Fixed rather than operator-configurable for the
#: identical reason [`_REFUSAL_QUOTE_CHARS`] is (DEC-10): a compute runs under `--clearenv` in a
#: flat `/code` dir with no channel to a settings row, and a stderr-flood bound an operator can
#: raise is a bound an attacker can benefit from.
#: The DERIVED output bound, stated rather than left to be worked out: 8 elements x 120 units x
#: the widest `ascii()` escape a single unit can produce (10 characters, `\U0001f9ec`) = 9,600
#: characters, plus each element's clip sentence. Not constant, and the slack is honest: the
#: message states the true COUNT and the true LENGTH, so it grows by the DECIMAL DIGITS of those
#: numbers and by nothing else -- logarithmic in the vendor's input, which is the same bound
#: [`_quoted_for_refusal`] already carries.
_REFUSAL_QUOTE_ITEMS = 8

#: The largest h5 root attribute this importer will WALK, in bytes. Not a message bound -- see
#: [`_REFUSAL_QUOTE_CHARS`] for that -- but a WORK bound, and the two are different failures: past
#: this, the cost is not a long line on stderr, it is an OOM SIGKILL with no message at all.
#: MEASURED on the Visium sibling, one root attribute of `np.zeros(100_000_000, dtype="|S1")`
#: cost 28.85 s and +570 MB RSS INSIDE THE WALK, on top of the 0.28 s `dict(h5.attrs)` already
#: pays.
#:
#: 1 MiB is four orders of magnitude above anything a 10x Onboard Analysis bundle writes. MEASURED
#: on both committed fixtures, `dict(h5.attrs)` holds exactly two `ndarray` root attributes —
#: `library_ids` (`|S15`, 15 bytes) and `original_gem_groups` (`int64`, 8 bytes) — and every other
#: value is a `str` or a numpy scalar, which never reach the `node.nbytes` arm this cap guards.
#: The attribute an earlier revision of this comment cited as the largest (`protein_metric`,
#: "76 bytes") is a Python `str` on the `xenium-protein-outs` fixture — h5py returns attribute
#: strings as `str`, not as `<U19` arrays — so it is not an `ndarray` at all and never reaches
#: this arm. The largest `ndarray` root attribute on either fixture is 15 bytes, so 1 MiB is
#: ~70,000x that, and the cap has never been exercised by real data. It is a fixed constant for
#: the same reason [`_REFUSAL_QUOTE_CHARS`] is (DEC-10): a compute runs under `--clearenv` in a
#: flat `/code` dir with no channel to a settings row, and a work bound an operator can raise is
#: a bound an attacker can benefit from.
_MAX_WALKED_ATTRIBUTE_BYTES = 1 << 20

#: The largest `/matrix/shape` dataset this importer will READ, in BYTES. Not a message bound and
#: not a new policy -- see the pre-read guard at the read site for the full argument -- but a WORK
#: bound on the `[:]` read, and it is stated in BYTES because that is the unit the read's cost is
#: proportional to: `shape_ds[:]` materialises `size x itemsize` bytes, so an element count alone
#: does not bound the work (a 2-element dataset of `S1073741824` is a 2 GiB read that passes ANY
#: element cap). A legitimate shape dataset holds exactly TWO integers -- 16 bytes as `int64` --
#: so 4096 bytes is ~256x that: enormous slack against the only legal value, while still a
#: genuinely bounded, genuinely cheap read for the fixed-width dtypes that reach this point --
#: vlen/object (and compound-with-vlen) are refused by the dtype gate before the read, so the
#: byte cap never has to see them. Fixed rather than operator-configurable for the
#: identical reason [`_MAX_WALKED_ATTRIBUTE_BYTES`] is (DEC-10): a compute runs under `--clearenv`
#: in a flat `/code` dir with no channel to a settings row, and a work bound an operator can raise
#: is a bound an attacker can benefit from.
_MAX_SHAPE_BYTES = 4096

#: The largest `/matrix/shape` dataset this importer will READ, in ELEMENTS. The byte bound above
#: is the binding one for fixed-width dtypes; this element cap is a second, independent check
#: alongside it, bounding the element COUNT for those fixed-width dtypes. It is not a vlen
#: backstop: an element cap cannot bound a byte exposure whose per-element size is
#: attacker-chosen (1024 elements x 1 GiB each is still 1 TiB), and vlen/object dtypes are
#: refused outright by the dtype gate below, before the read, on the dtype alone -- so the byte
#: cap never has to see them. A legitimate shape dataset holds exactly TWO integers, so 1024
#: elements is 512x that: enormous slack against the only legal value, while still a genuinely
#: bounded, genuinely cheap read for the fixed-width dtypes that reach this point. Fixed rather
#: than operator-configurable for the identical reason [`_MAX_WALKED_ATTRIBUTE_BYTES`] is
#: (DEC-10): a compute runs under `--clearenv` in a flat `/code` dir with no channel to a
#: settings row, and a work bound an operator can raise is a bound an attacker can benefit from.
_MAX_SHAPE_ELEMENTS = 1024


def _dtype_is_vlen_or_object(dtype):
    """True when `dtype` is a vlen/object dtype, or a compound carrying one.

    `Dataset.nbytes` is `dtype.itemsize * size`, and for a vlen dtype `itemsize` is 8 — the size
    of a POINTER, not the payload — so the byte cap cannot see a vlen/object shape dataset: a
    two-element vlen dataset reports `nbytes == 16` and passes ANY byte cap while `[:]` still
    materialises the attacker-chosen payloads, and the element cap does not save it because the
    per-element size is attacker-chosen. The gate is therefore on the DTYPE, not the size.

    `h5py` gives every vlen dtype `kind == "O"` — MEASURED on this box: `h5py.vlen_dtype(bytes)`,
    `h5py.vlen_dtype(str)` and `h5py.vlen_dtype(np.float64)` are all `dtype('O')` with
    `itemsize == 8`, and `h5py.check_vlen_dtype` returns the payload class for each — so the
    object kind is the detector, and it also covers a plain object dtype. A compound dtype with a
    vlen field under-reports identically (`kind == "V"`, `itemsize` counts the descriptor, not the
    heap), so its fields are checked too, recursively.
    """
    if dtype.kind == "O":
        return True
    if dtype.kind == "V" and dtype.fields is not None:
        return any(_dtype_is_vlen_or_object(f[0]) for f in dtype.fields.values())
    return False


def _quoted_for_refusal(value, focus=None, *, noun="path"):
    r"""One attacker-controlled value, safe to put in a message: ASCII, bounded, and ABOUT THE OFFENCE.

    FOUR properties. Three of them are defects a blind angle reproduced against an earlier version
    of this function, and the fourth is one it reproduced against the version that fixed those:

    1. **ASCII.** `ascii()` is DEFINED to return ASCII (`repr()` merely happens to, for surrogates,
       on CPython today).
    2. **No control characters.** `ascii()` escapes `\x1b`, `\n` and `\r` as literal escapes. Before
       this helper existed the refusal interpolated the PATH TRAIL raw while escaping only the
       value, so an attacker-chosen JSON key landed byte-for-byte on stderr: MEASURED with a key of
       `"\x1b[2J\x1b[31mFATAL\x07\nspatial.import-xenium: import SUCCEEDED, ignore the line
       above\r"`, which clears the operator's terminal and forges a second, reassuring log line.
       The server folds that stderr tail verbatim into the `jobs.error` column and the UI renders
       it as text -- HTML-safe, ANSI-unsafe.
    3. **Bounded.** See [`_REFUSAL_QUOTE_CHARS`]. Windowed BEFORE escaping, so the cut can never
       land inside an escape sequence and produce something that is not what it appears to be.
    4. **WINDOWED ON THE OFFENCE, not on the start.** This is the one the second round found, and
       it is the one that mattered: clipping the first 120 units of a 212-character `run_name`
       quoted 120 perfectly ordinary characters and then asserted, in the next sentence, "That is
       a LONE SURROGATE" -- a message that shows the reader something innocent and calls it the
       problem. MEASURED on a real bundle. So the caller passes the offending OFFSET (the walker
       gets it free, from `UnicodeEncodeError.start`) and the window is centred there, with the
       offset and the true length stated so nothing is implied by omission.

       For a PATH the offence is the leaf, so the trail is windowed from its END: a 565-character
       nested path used to be clipped from the left, dropping `final` -- the field name the trail
       exists to name.

    ## #343: the SAME funnel, for EVERY refusal in this module -- and two shapes it could not take

    #329/#330 built this and routed ONE refusal's values through it (the parse-boundary refusal in
    [`refuse_unencodable_vendor_text`]). Every other refusal in this module interpolated vendor
    text RAW and UNBOUNDED, and a hostile bundle reaches several of them EARLIER than it reaches
    the guarded one: `_one`/`_at_most_one`'s ambiguity refusal interpolates the bundle's own file
    paths, `read_experiment`/`read_cells_csv`/`_decoded_strings` interpolate `{exc}` (exception
    messages that echo vendor bytes back), `read_cells_csv` interpolates the header row, and
    `run_import` interpolates the h5 top-level member names, the missing-barcode list and the
    cast errors. `scheduler.rs::drain_logs` writes one `job_logs` row per BufReader line with no
    per-line cap, so a raw vendor `\n` forges a row and a long value floods one.

    Routing those needed two things this helper did not have:

    5. **Values that are not `str` or `bytes`.** A `Path` (the sandbox mount, whose last segment is
       the user's own dataset directory name), an `Exception` (h5py's and `float()`'s messages both
       echo vendor text back), an `int`. `len()` RAISES on all three, so they are coerced with
       `str()` first. `str` and `bytes` are deliberately NOT coerced: `ascii(b"\xff\xfeSR")` is
       `b'\xff\xfeSR'` and `ascii(str(b"\xff\xfeSR"))` is a quoted repr OF a repr, so coercing
       them would silently move #329's own messages.
    6. **Prose that is TRUE.** The over-long branch said "of the path" unconditionally, which is a
       false statement about a CSV header field. `noun=` carries what the value actually is; the
       default keeps #329's two call sites byte-identical.

    A SEQUENCE is a genuinely different shape and gets its own funnel -- see
    [`_quoted_list_for_refusal`] -- because bounding each element is not bounding the message.
    """
    if not isinstance(value, (str, bytes)):
        # A `Path`, an `Exception`, an `int`. `len()` raises on all of these, so the value is
        # rendered first; `str` and `bytes` are left alone so #329's output cannot move (above).
        value = str(value)
    total = len(value)
    if total <= _REFUSAL_QUOTE_CHARS:
        return ascii(value)
    if focus is None:
        # A PATH. There is no "offending unit" in it -- the offence is in the value -- so the
        # window is simply the TAIL, which is the leaf field name, and it says only that.
        # Reporting `focus=len(where)` here (an earlier spelling) produced "the offending unit is
        # at 2000000" for a 2,000,000-character key: an offset one past the end, naming nothing,
        # in the same round whose whole subject is a refusal not pointing at the wrong thing.
        return (f"{ascii(value[total - _REFUSAL_QUOTE_CHARS:])} (the last "
                f"{_REFUSAL_QUOTE_CHARS} of {total} characters of the {noun})")
    lead = _REFUSAL_QUOTE_CHARS // 3
    start = max(0, min(focus - lead, total - _REFUSAL_QUOTE_CHARS))
    window = value[start:start + _REFUSAL_QUOTE_CHARS]
    return (f"{ascii(window)} (a {_REFUSAL_QUOTE_CHARS}-unit window at offset {start} of "
            f"{total} characters of the {noun}; the offending unit is at {focus})")


def _quoted_list_for_refusal(values, noun="value"):
    r"""A SEQUENCE of attacker-controlled values, safe to put in a message (#343).

    ## Why a list is not just N values

    Several refusals in this module interpolate a SEQUENCE, and all of them did it by handing the
    list straight to an f-string, i.e. to `list.__repr__`. That has exactly one of the four
    properties [`_quoted_for_refusal`] holds: it escapes control characters. It is NOT ASCII (it
    passes printable non-ASCII through byte for byte), and it is NOT BOUNDED, in EITHER dimension:

    * **per element** -- one long CSV header field is one long message;
    * **per count** -- many such fields land on a single stderr line, which
      `scheduler.rs::drain_logs` stores as one `job_logs` row with no per-line cap.

    So both dimensions are bounded here: each element goes through [`_quoted_for_refusal`], and
    the number of elements shown is capped at [`_REFUSAL_QUOTE_ITEMS`]. The worst case is
    8 x 120 UNITS, and a unit can escape to ten characters (`\U0001f9ec`), so ~9,600 characters
    plus the per-element clip sentences -- see [`_REFUSAL_QUOTE_ITEMS`], which states the same
    figure.

    ## The true count is always stated

    A silent truncation is the failure mode [`_quoted_for_refusal`]'s property (4) exists to
    avoid, one dimension over: showing an operator three of sixty header fields and letting the
    surrounding sentence imply that is all of them is a message that is safe and WRONG. When the
    sequence is longer than the cap the count is spelled out, so nothing is implied by omission.

    The rendering deliberately MIRRORS `list.__repr__`'s bracketed, comma-separated shape, because
    that is what these refusals read like today and an operator reading a log should not have to
    learn a second spelling to recognise the same fact.
    """
    values = list(values)
    shown = [_quoted_for_refusal(v, noun=noun) for v in values[:_REFUSAL_QUOTE_ITEMS]]
    body = "[" + ", ".join(shown) + "]"
    if len(values) <= _REFUSAL_QUOTE_ITEMS:
        return body
    return f"{body} (the first {_REFUSAL_QUOTE_ITEMS} of {len(values)} entries)"


def refuse_unencodable_vendor_text(node, *, source, remedy):
    r"""Raise the named refusal if `node` carries text this importer could not write (#329).

    ONE predicate, TWO callers -- `read_experiment` and the `/matrix` file's root attributes -- and
    the reason is the one [`vendor_statement`]'s docstring already records for itself: a second
    spelling of one rule is a rule that answers differently in two places. The two boundaries
    differ only in HOW the unwritable text got in (a `\udXXX` escape `json.loads` accepted; `h5py`
    decoding an invalid UTF-8 attribute with `surrogateescape`; or raw invalid bytes in an h5
    `|S` attribute), never in what is wrong with it or what to do about it.

    ## THE MESSAGE IS ASCII, BOUNDED AND ESCAPED -- and the first reason given for that was wrong

    This docstring used to argue that a raw surrogate in the message "would raise
    `UnicodeEncodeError` AT THE REPORTING SITE, under ANY encoding". A blind angle measured that
    claim and it is FALSE: CPython gives `sys.stderr` `errors="backslashreplace"` unconditionally,
    so `main()`'s own `print` never raises -- under `LC_ALL=C` and `PYTHONIOENCODING=ascii:strict`
    alike. Keeping a true rule justified by a false reason is how the rule gets removed later by
    someone who checks the reason. The real reasons, both measured:

    1. **The message is re-encoded and re-rendered downstream.** It is not consumed by `print`; it
       is captured, stored in the job's error column and displayed. `backslashreplace` protects the
       one hop that happens to be lenient, not the consumers after it.
    2. **It is an INJECTION SURFACE.** The path trail is attacker-chosen and used to be emitted
       raw -- see [`_quoted_for_refusal`], which is now the single place any vendor byte can enter
       a message.

    And a third, which the module already reasoned about before this branch: an ASCII locale is a
    real case here -- the declaration mirror says so in its own words, "with `ensure_ascii=False` a
    non-ASCII library id would abort the writer under an ASCII locale". A refusal whose prose
    carried an em dash would be unprintable for a reason having nothing to do with the bundle, on
    the one path whose whole job is to say what is wrong with the bundle. So the prose here is
    plain ASCII, deliberately.
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
    raise XeniumImportError(
        f"{source} carries text at {_quoted_for_refusal(where)} that is not valid "
        # `int(at)` is a no-op — `at` is `UnicodeEncodeError.start`, an integer offset — and is
        # what lets the #343 structural guard PROVE it (DEC-2). It is not decoration: `focus` is
        # INTERPOLATED into the funnel's own output ("the offending unit is at {focus}"), so an
        # unprovable value there is the same hole one keyword over from the one this item closes.
        f"Unicode and cannot be written: {_quoted_for_refusal(text, int(at))}. {diagnosis}. It is "
        "refused rather than "
        "repaired, because these strings become the run's identity and its provenance, and a "
        "replaced character in a `roi_uuid` is a silently altered coordinate frame while one in a "
        "`slide_id` is a silently altered sample -- the false collision this importer exists not "
        "to make. Left in, it would either abort the writer after the coordinate store was "
        "already on disk, or ship a report no strict JSON reader can parse. "
        f"{remedy}"
    )


def _text(value):
    """An h5 attribute or a JSON value as a plain `str`, or `None` when it is absent."""
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    if isinstance(value, np.ndarray):
        # `.tolist()` on a 0-D array returns a SCALAR, not a list, and iterating it raises
        # `TypeError: 'int' object is not iterable`. Not reachable from today's inputs —
        # h5py returns numpy SCALARS rather than 0-D arrays for scalar attributes, and
        # `experiment.xenium` is JSON — but this helper's whole job is "whatever the vendor
        # really produces", and an unreachable-today branch is how that stops being true.
        listed = value.tolist()
        if not isinstance(listed, (list, tuple)):
            return _text(listed)
        return ", ".join(_text(x) or "" for x in listed)
    if isinstance(value, (list, tuple)):
        return ", ".join(_text(x) or "" for x in value)
    return str(value)


def _finite(value):
    """A finite number, or `None`. THE JSON GUARD, and it is not defensive decoration.

    `json.loads` ACCEPTS the bare `NaN` / `Infinity` literals that `json.dump` writes, and
    `json.dumps` writes them straight back out — but `/outputs/manifest.json` is parsed by
    `serde_json`, which refuses them, so ONE such number anywhere in `experiment.xenium`
    would fail the whole job at ingest AFTER every byte of compute, with a message about a
    malformed manifest and nothing pointing at the vendor file.

    Everywhere else in this tree a float reaches an artifact through `SD._number`, which
    refuses non-finite. The paths that do not go through it are the ones this guards: a
    run-level segmentation fraction, the reported pixel size, and the protein scaling
    factor.

    ## NUMPY SCALARS ARE NUMBERS, and this rejected them

    `isinstance(np.int64(10), (int, float))` is **False** in Python 3 — `np.int64` does not
    subclass `int`. h5py hands back exactly that for an integer root attribute, so the real
    protein bundle's `protein_scaling_factor = np.int64(10)` was silently dropped and the
    structured field added for it never appeared. That defeated the whole point of adding
    it: §15.5's one interpretable number survived only as free text in a prose sentence.
    Measured, not anticipated — the blind correctness audit reproduced it. `np.number`
    covers `int8..64`, `uint*`, `float16..64` and the bool_ that `np.bool_` would otherwise
    smuggle through as 1.

    ## An INTEGER stays an integer

    An earlier revision returned `float(value)` unconditionally, which quietly rewrote an
    integer-valued provenance key as `2.0`. Inert on both real bundles (every provenance
    value there is a string) and still wrong: this function's job is to REFUSE a
    non-serialisable number, not to retype a serialisable one.
    """
    if isinstance(value, (bool, np.bool_)):
        return None
    if isinstance(value, np.number):
        value = value.item()
    if not isinstance(value, (int, float)):
        return None
    if isinstance(value, int):
        return value                     # an int is finite by construction
    return value if math.isfinite(value) else None


# ─────────────────────────── shared compute runtime ───────────────────────────
# Inlined rather than imported: the sandbox stages this ONE entry file plus the declared
# `run.helpers`, and this block is deliberately identical across the builtins' computes.


def io_dirs():
    inp = Path(os.environ.get("CYTO_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("CYTO_OUTPUTS_DIR", "/outputs"))
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
            sub = e.get("slot") or ""
        if not sub:
            continue
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
    fifo = os.environ.get("CYTO_PROGRESS_FIFO")
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
    cyto_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    # Compact, not `indent=2`: only the server reads this, and pretty-printing doubles it
    # against `outputs.rs::MAX_MANIFEST_BYTES` (1 MiB, a hard failure past it).
    # `encoding="utf-8"` EXPLICITLY, not the LOCALE default. The measurement and the argument are
    # in `docs/design/vendor-text-encodability-refusal.md` §4b, kept THERE rather than repeated at
    # each of the three sites -- a later blind angle pointed out this history was being narrated in
    # three shipped files at once, with hard numbers that nothing asserts.
    #
    # ONE OF THE THREE IS LOAD-BEARING, and saying "three" was wrong. `manifest.json` and
    # `xenium-import-report.json` are serialised by `json.dumps` at its default
    # `ensure_ascii=True`, so they are pure ASCII by construction and could not have raised under
    # any locale -- measured: 0 non-ASCII bytes in each, and removing both keywords leaves the
    # whole package suite green. Only `xenium-import-summary.html` (free prose through
    # `render_report_html`) actually fails, and TEST-14 kills exactly that one. The other two are
    # kept as the cheap half of a rule that should hold for every text write here, and are
    # labelled as such rather than as a fix.
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


# ─────────────────────────────── the bundle ───────────────────────────────


def _one(root, basename):
    """The single file with this basename anywhere under `root`, or a refusal.

    Mirrors the container's own grouping precondition rather than being more permissive
    than it: `detect_manifest_group` returns nothing unless EXACTLY ONE file matches each
    member, so an importer that quietly picked one of several would be accepting a dataset
    the platform would never have grouped.
    """
    matches = sorted(p for p in Path(root).rglob(basename) if p.is_file())
    if not matches:
        raise XeniumImportError(
            f"this bundle has no `{basename}`. A Xenium `outs/` always ships one; without "
            "it there is nothing to import. Re-upload the complete Onboard Analysis output."
        )
    if len(matches) > 1:
        raise XeniumImportError(
            f"this bundle carries {len(matches)} files named "
            f"{_quoted_for_refusal(basename, noun='file name')} "
            f"({_quoted_list_for_refusal([str(m.relative_to(root)) for m in matches[:3]], noun='path')}). "
            "Member matching is by basename, so choosing one would be a guess about which run's "
            "data this is. Upload one run per dataset."
        )
    return matches[0]


def _at_most_one(root, basename):
    """`_one`, but ABSENCE is an answer rather than a refusal — `None` for zero matches.

    #163/DEC-3. `cell_boundaries.parquet` is deliberately NOT a declared member of
    `spatial/xenium-bundle`: member matching is by basename and grouping returns NOTHING
    unless exactly one file matches EACH member, so declaring it would make every bundle
    without one ungroupable. That is not hypothetical — both real full-size Xenium bundles
    available when this was written ship their boundaries only as `cell_boundaries.csv.gz`
    (older Onboard Analysis) and have no parquet at all, and #162 verified its grouping
    against bundles of exactly that vintage.

    TWO matches still refuse, for `_one`'s reason unchanged: choosing between them is a
    guess about which run's data this is.
    """
    matches = sorted(p for p in Path(root).rglob(basename) if p.is_file())
    if not matches:
        return None
    if len(matches) > 1:
        raise XeniumImportError(
            f"this bundle carries {len(matches)} files named "
            f"{_quoted_for_refusal(basename, noun='file name')} "
            f"({_quoted_list_for_refusal([str(m.relative_to(root)) for m in matches[:3]], noun='path')}). "
            "Choosing one would be a guess about which run's boundaries these are. Upload one "
            "run per dataset."
        )
    return matches[0]


def locate_members(root):
    """The three declared members plus whatever the vendor's manifest points at."""
    root = Path(root)
    members = {
        "matrix": _one(root, MATRIX_BASENAME),
        "cells": _one(root, CELLS_BASENAME),
        "experiment": _one(root, EXPERIMENT_BASENAME),
    }
    members["root"] = root
    return members


def read_experiment(path):
    """`experiment.xenium` -> a dict, or a REFUSAL.

    Unlike Visium's `scalefactors_json.json` — whose absence is survivable because the
    coordinates are still correct in pixels — this file is the bundle's manifest, its
    provenance and its scale at once. Continuing without it would mean inventing a
    coordinate-space id and having no image at all, so it is refused rather than defaulted.
    """
    try:
        # `encoding="utf-8"` EXPLICITLY, not the locale default. Two reasons, and the first is
        # this guard's own premise: without it, a non-UTF-8 locale would decode arbitrary vendor
        # bytes into legal, ENCODABLE characters, so "the only way an unwritable string gets in is
        # a `\udXXX` escape" would stop being true and mojibake identities would ship instead. A
        # blind angle raised it as a hypothesis and could NOT reproduce it, because this host
        # forces PEP 540 UTF-8 mode under every settable locale -- which is exactly the kind of
        # premise that should rest on a keyword rather than on the host's flags. Second: with an
        # explicit encoding, invalid bytes raise `UnicodeDecodeError`, which subclasses
        # `ValueError` and so becomes the named refusal three lines below.
        #
        # `RecursionError` is in the tuple for the same reason `EOFError` and `csv.Error` are in
        # `read_cells_csv`'s: it subclasses NEITHER `OSError` NOR `ValueError`, it is reachable
        # from ordinary attacker input (`json.loads` raises it from `raw_decode` on a document
        # nested past ~990 deep, in a file that is pure ASCII), and `main()` catches only
        # `XeniumImportError` -- so it was a raw traceback and exit 1 at the very boundary this
        # module now promises a named refusal at. Both blind angles reproduced it. The guard's own
        # walk is NOT the weak link and this is not a fix for it: measured, `json.loads` fails
        # FIRST at every depth -- a blind angle tried list nesting, dict nesting and mixed nesting
        # at every depth from 985 to 999, under stacks padded by 0/10/20/50 frames, and could not
        # construct an input where the walker went first. (An earlier revision of this comment
        # said "clean refusals at 700-990"; that is wrong twice over -- a 700-deep document with
        # no unwritable text IMPORTS, and the threshold is stack-depth dependent, measured here at
        # 993/994 rather than 991. The load-bearing half, "json.loads fails first", is what was
        # measured and it holds.) The margin is thin -- the walker survives about two levels
        # deeper than `json.loads` at the same stack depth -- so this is a refusal that rests on a
        # measurement, not on a wide margin.
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as exc:
        raise XeniumImportError(
            f"`{EXPERIMENT_BASENAME}` could not be read "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). It "
            "is the run's own manifest — the analysis version, the panel, the pixel size "
            "and the image paths all live in it — and every one of those is unrecoverable "
            "from the other files. Refusing rather than importing a run with no identity."
        ) from None
    if not isinstance(doc, dict):
        raise XeniumImportError(
            f"`{EXPERIMENT_BASENAME}` is not a JSON object; this is not a Xenium run manifest."
        )
    # THE PARSE BOUNDARY, and the only place this rule is stated (#329). Everything downstream —
    # `_text`, `vendor_statement`, `vendor_provenance`, `vendor_frame_label`, `section_sample_id`,
    # `coordinate_space_id` — inherits a document whose strings can be WRITTEN, so none of them
    # has to ask again and none of them can be the one that forgot. Placed here rather than at any
    # consumer for the reason #329 states: the same string reaches the artifact through
    # `vendor_provenance` as well as through the identity path, so a guard on the identity path
    # would leave the crash exactly where it is while making the report look defended.
    #
    # It fires BEFORE ANY ARTIFACT BYTE EXISTS. `run_import` calls this immediately after
    # `locate_members` and ~400 lines before the first writer, so a refused bundle leaves no store,
    # no partial store and nothing for a later reader to find — the same rule
    # `write_spatial_coordinates` already states for its own shape refusal, and the answer to the
    # half-written-store half of #329 rather than a cleanup path that would have to run under
    # whatever just failed (#301's `ENOSPC` is the case where cleanup is what cannot be relied on).
    refuse_unencodable_vendor_text(
        doc,
        source=f"`{EXPERIMENT_BASENAME}`",
        remedy=(
            "Re-export the run from Onboard Analysis; if the value was hand-edited, restore the "
            "vendor's own text."
        ),
    )
    return doc


def read_cells_csv(path):
    """`cells.csv.gz` -> `(header, rows)` with the rows kept as raw strings.

    Strings, not floats, so the caller decides the cast and a malformed value names its own
    column. `gzip` + `csv` are stdlib, which is the whole point of DEC-3.
    """
    try:
        # `utf-8-sig` rather than the default: a BOM otherwise makes the first header cell
        # `'\ufeffcell_id'` and the run stops with "has no cell_id column", which is a true
        # statement about a file the user believes has one.
        with gzip.open(path, "rt", newline="", encoding="utf-8-sig") as fh:
            reader = csv.reader(fh)
            rows = list(reader)
    # `EOFError` and `csv.Error` subclass NEITHER `OSError` nor `ValueError`, and both are
    # reachable on the most likely real damage there is: a gzip stream truncated by an
    # interrupted upload raises `EOFError`, and a NUL byte or an over-long field raises
    # `csv.Error`. `main()` catches only `XeniumImportError`, so each was a raw traceback
    # and exit 1 instead of the named refusal three lines below that already existed for a
    # non-gzip file. Found by damaging a real bundle, not by reading the code.
    except (OSError, ValueError, EOFError, csv.Error) as exc:
        raise XeniumImportError(
            f"`{CELLS_BASENAME}` could not be read "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}); it holds "
            "every cell's position and there is no other source for them in the bundle."
        ) from None
    if not rows:
        raise XeniumImportError(f"`{CELLS_BASENAME}` is empty.")
    header = [c.strip() for c in rows[0]]
    # A REPEATED HEADER NAME IS REFUSED, not resolved. `{name: i for i, name in ...}` is
    # last-occurrence-wins, and a blind audit proved what that costs: renaming `cell_area`
    # to `x_centroid` — a plausible spreadsheet round trip — produced a fully SUCCESSFUL
    # import whose `spatial_x` was the cell AREA for every cell, with the real centroid
    # discarded, the `cell_area` column silently gone and no note anywhere. Every other
    # duplicate-versus-guess case in this importer refuses (a repeated `cell_id`, an
    # ambiguous member basename); this one silently picked. It picks no longer.
    read_by_this_importer = {CELL_ID_COLUMN, X_COLUMN, Y_COLUMN, SEGMENTATION_COLUMN}
    read_by_this_importer.update(name for name, _cast in VENDOR_CELL_COLUMNS)
    repeated = sorted({name for name in header
                       if name in read_by_this_importer and header.count(name) > 1})
    if repeated:
        raise XeniumImportError(
            f"`{CELLS_BASENAME}`'s header repeats "
            f"{_quoted_list_for_refusal(repeated, noun='column name')}, and this importer reads "
            "those columns. Which of the duplicates holds the value is a guess, and the "
            "guess is invisible: the last one silently wins and the others vanish. A "
            "coordinate taken from the wrong column is not an error, it is a picture of "
            "the tissue with the values shuffled. Re-export the cells table with unique "
            "column names."
        )
    for required in (CELL_ID_COLUMN, X_COLUMN, Y_COLUMN):
        if required not in header:
            raise XeniumImportError(
                f"`{CELLS_BASENAME}` has no {required!r} column (found "
                f"{_quoted_list_for_refusal(header, noun='column name')}). Without "
                "it the cells cannot be positioned, and a position cannot be invented."
            )
    return header, rows[1:]


# ─────────────────────────── identity and provenance ───────────────────────────


def _decoded_strings(group, name, path=None):
    """One untrusted h5 string dataset, decoded STRICTLY, refused BY NAME on every way it can fail.

    ## Why strict, and why wrapped

    These four datasets — `/matrix/barcodes` and the three under `/matrix/features` — are the
    vendor's own bytes and every one of them is an IDENTITY: a barcode is the key `cells.csv.gz` is
    joined on, and a feature id is what a gene list is matched against. `errors="replace"` would
    silently mangle a key and turn a join failure into a WRONG join — a picture of the tissue with
    the values shuffled — so strict is right. What was wrong is that a non-UTF-8 byte left `main()`
    as an uncaught `UnicodeDecodeError` traceback, and `main()` catches only `XeniumImportError`.

    ## All four, and every failure mode, because a guard on one of four is a guard on none

    #323 first wrapped the BARCODE read alone, with a comment claiming "the one place the bytes are
    read". A blind error-handling angle pointed out there are four such places and the other three
    were still bare; and that even on the wrapped one, the `[:]` read itself has two more reachable
    failures the up-front presence sweep lets through, because `"barcodes" in group` is true for
    both — a rank-0 (scalar) dataset raises `ValueError`, and a GROUP of that name raises
    `TypeError`. The same presence sweep lets through a DANGLING EXTERNAL LINK: `"barcodes" in
    group` is true for a link (the name exists in the group's namespace) and `group["barcodes"]`
    then raises `KeyError` when the link is resolved — the exact hole the shape read's guard
    already closes, four fields over — and a corrupt chunk makes the `[:]` read itself raise
    `OSError`. `OverflowError` and `MemoryError` are named too, matching the shape read's tuple:
    h5py raises the former for a dataset whose declared size overflows, and the latter gets its
    OWN handler below because it is not a file defect — a legitimate large bundle on an
    under-provisioned worker must not be told its file "has something else there". That handler
    is BEST EFFORT, not a guarantee: under default Linux overcommit the realistic outcome of a
    huge read is a SIGKILL, which no `except` catches, and the handler itself allocates, so it
    is not reliably deliverable even when it does fire. A guard on one read site but not the
    other is the same "one of four" defect one level up. All five failure modes in this
    handler's tuple are named here, once, for all four call sites (`MemoryError` is not in the
    tuple — it gets its own handler below, as described above). The "all four" claim is
    measured, not assumed: three of the four call sites dereference `group["features"]`
    outside this `try`, but a dangling `features` link is refused cleanly by the presence
    sweep before that dereference — MEASURED, recorded at the `features` call site.

    The offending ROW is named where it can be, because that is this file's own convention for a
    per-row refusal (`cells.csv.gz` line N; "first at matrix row {first}, cell {id!r}"): the decode
    runs per entry so the index is known, and "position 0" in a codec's own message is a byte
    offset inside one value, which is not what an operator needs to go and look at.
    """
    label = path or f"/matrix/{name}"
    # The presence sweep in `run_import` proves `name` is in `group` before this is called, so a
    # plain missing name cannot reach here — the `KeyError` the read catches below is the
    # DANGLING-LINK case (the name exists in the namespace, the link cannot be resolved), which
    # IS a file defect. The assertion is still made, cheaply, so a future refactor that drops the
    # sweep cannot turn our own bug into "the vendor's file has something else there".
    if name not in group:
        raise XeniumImportError(
            f"`{MATRIX_BASENAME}`'s `{label}` is not present in the `/matrix` group — this is "
            "an internal inconsistency in the importer, not a defect in the bundle."
        ) from None
    try:
        raw = group[name][:]
    except MemoryError:
        # A MEMORY failure is not a file defect: the bundle may be perfectly good and the worker
        # under-provisioned, so blaming the file would tell an operator to re-export a good
        # bundle when the remedy is to raise the memory limit — and a retryable resource failure
        # would be permanently classified as vendor fault. `MemoryError`'s `str()` is typically
        # empty, so the message does not quote one. This handler is BEST EFFORT, not a
        # guarantee: under default Linux overcommit the realistic outcome of a huge read is a
        # SIGKILL, which no `except` catches, and the handler itself allocates.
        raise XeniumImportError(
            f"`{MATRIX_BASENAME}`'s `{label}` could not be read in the memory available to this "
            "import. This is not a defect in the file — the bundle may be fine and the worker "
            "under-provisioned — so re-exporting it will not help; raise the memory limit and "
            "retry."
        ) from None
    except (ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
        raise XeniumImportError(
            f"`{MATRIX_BASENAME}`'s `{label}` cannot be read as a list of values "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix stores it as a "
            "one-dimensional dataset; this file has something else there."
        ) from None
    out = []
    for index, value in enumerate(raw):
        if not isinstance(value, bytes):
            out.append(str(value))
            continue
        try:
            out.append(value.decode())
        except UnicodeDecodeError as exc:
            raise XeniumImportError(
                f"`{MATRIX_BASENAME}`'s `{label}` entry {index} is not valid UTF-8 "
                f"({_quoted_for_refusal(exc, noun='message')}). "
                "That value is an IDENTITY — a cell id is the key this importer joins the cells "
                "table on, a feature id is what a gene list is matched against — so it cannot be "
                "decoded loosely without silently pairing one row's values with another row's. "
                "Re-export the bundle."
            ) from None
    return out


def vendor_statement(value):
    """The vendor's answer, or `None` when the vendor gave a PLACEHOLDER for one.

    Module level with FOUR call sites rather than a closure inside `vendor_provenance` — two in
    `vendor_provenance`, one in `section_sample_id`, one in `vendor_frame_label` (#323) — and the
    reason is a defect #320 shipped and the blind audit caught: `section_sample_id`
    read `experiment["region_name"]` RAW while the old call site read
    `provenance["region_name"]`, which had already been through this filter. So a bundle
    stating `region_name: "unknown"` — one of `_VENDOR_PLACEHOLDERS` — was emitted as a
    vendor-stated `sample_id` with `sample_id_source: "region_name"`, while the provenance
    block in the same report had DROPPED the key for being a placeholder. Two unrelated
    tissues both saying `"unknown"` then declared themselves sections of one sample: the
    FALSE COLLISION this branch exists to remove, reintroduced on the leg it claimed not to
    touch. One predicate, two callers, no second spelling to drift.

    `_finite` for the non-string arm: a vendor writing a number is stating something, a
    vendor writing `NaN`/`Infinity` or a mapping is not.
    """
    if isinstance(value, str):
        text = value.strip()
        return None if text.lower() in _VENDOR_PLACEHOLDERS else text
    return _finite(value)


#: The key suffixes stripped before a value is compared against its own field name. A field is
#: named for its SUBJECT plus what kind of thing it holds — `region_name` holds the name of a
#: region, `slide_id` the id of a slide — so the subject is what is left when the kind is removed.
#: A TUPLE rather than an inline literal so this can be promoted to a configurable later without a
#: rewrite (DEC-8), though it is deliberately NOT operator-configurable: an "accept `region` as a
#: sample identity after all" switch would re-introduce the silent false collision #320 is about.
#:
#: `_uuid` joined the tuple at #323, when the rule was asked of `roi_uuid` for the first time.
#: It is the same KIND suffix as the other three by this constant's own derivation — a field
#: is named for its SUBJECT plus what kind of thing it holds, and `roi_uuid` holds the uuid of
#: an ROI — so leaving it out would have made the rule answer differently for two spellings of
#: one idea (`roi_id` rejected, `roi_uuid` accepted). Nothing else moves: no shipped call site
#: passes a `_uuid` key except the one #323 adds, and the whole-key spelling (`roi_uuid:
#: "roi_uuid"`) was already rejected without it.
_NON_IDENTIFYING_KEY_SUFFIXES = ("_name", "_id", "_label", "_uuid")


def non_identifying_vendor_label(key, value):
    """True when `value` is only the generic name of the FIELD it fills — #320's rule.

    ## The question this answers, and the one it deliberately does not

    `_VENDOR_PLACEHOLDERS` answers *"did the vendor give an answer at all?"* — `""`, `"n/a"`,
    `"unknown"` are the spellings for **no answer**, and a key holding one is DROPPED from the
    provenance block. This answers a different question, and only for the fields that are read as
    an IDENTITY: *"does this string identify anything?"*

    `region_name = "region"` is an answer. It is also the word every unnamed region carries, so it
    cannot distinguish this run from any other run that left the field generic — and
    `section.sample_id` is read by a consumer as *these are sections of ONE sample*. MEASURED on two
    staged copies of the shipped `xenium-prime-outs` bundle with DIFFERENT `roi_uuid`s: both got
    `sample_id='region'` and both `index: 0`, i.e. two unrelated experiments declaring themselves
    section 0 of one sample, with only the coordinate space telling them apart.

    ## Why this is not the denylist #270's DEC-4 refused, and not a longer `_VENDOR_PLACEHOLDERS`

    #270 refused *"a denylist of names that look like placeholders ... the importer would be
    deciding that a string the vendor wrote is not really a statement, on a heuristic derived from
    two bundles."* Both halves of that objection are answered rather than argued with:

    * **No list, and nothing about the vocabulary.** The predicate is DERIVED FROM THE KEY: strip
      the kind suffix, case-fold, compare. It asks one structural question — *does the value repeat
      its own field name* — and asks it identically of a field this importer has never seen. There
      is nothing to grow and nothing to keep in step with a vendor's spellings.

      Said precisely, because a blind angle noticed the sentence above can be read as a claim about
      the shipped BEHAVIOUR rather than about the rule: when #320 shipped this it had exactly ONE
      call site, with the literal key `"region_name"`. **#323 gave it a second**
      ([`vendor_frame_label`]), which asks it of `roi_uuid`, `slide_id` and `region_name`, so what
      it operationally rejects today is `roi`/`slide`/`region` and the whole-key spellings, on four
      fields across two call sites. That is the rule's generality being USED, not widened: the
      predicate is unchanged, and `_uuid` joined `_NON_IDENTIFYING_KEY_SUFFIXES` for the same
      derivation the tuple already states. The generality is in the RULE, and it is what makes the
      answer to #270's DEC-4 honest — there is no list that a new vendor spelling has to be added
      to. The unit rows for `REGION_NAME`, `x_label_id` and `panel_label` still test the rule
      rather than a call site.
    * **It does not decide the string is not a statement.** `_VENDOR_PLACEHOLDERS` is untouched and
      `vendor_provenance` still records `region_name: "region"` VERBATIM (DEC-5) — which is what a
      human needs in order to see why the sample id was namespaced. This decides only that the
      string does not IDENTIFY, which is the question the field it guards actually asks.

    ## The evidence #320 asked for

    `xenium-prime-outs` writes `slide_id='slide'`, `region_name='region'`, `run_name='run'`,
    `cassette_name='cassette'` — FOUR independent operator-supplied fields, each exactly the subject
    of its own key — while `xenium-protein-outs` writes real values for all four (`Slide_1`,
    `hKidney_sample`, `Xenium_4_Tiny_Test_Data`, `Cassette_1`). Four fields simultaneously carrying
    their own field name is not four independent operator choices; it is the shape of an unfilled
    form, and the second bundle is the control that says so.

    The claim stops there ON PURPOSE. 10x's documentation records Region name / Slide ID / Cassette
    name as REQUIRED operator inputs at instrument initialization, so *"this is 10x's default"* is
    NOT established and this importer does not assert it — asserting it would be the same
    unverified-declaration defect one field over. Whoever typed it, the string names no sample.

    ## What it costs, stated plainly

    A sample GENUINELY named "region" is not emitted as a `sample_id`; it is namespaced per
    coordinate space, with `sample_id_source: "non-identifying-region-name"` and its own string
    still in the provenance block. Two real sections of such a sample are not grouped: a MISSED
    collision, chosen knowingly, on the rule `coordinate_space_id` already states — *"a MISSED
    collision is visible and recoverable while a FALSE collision is silent wrong data"*. The missed
    one is visible in the report and the operator can fix it by naming the region; the false one is
    silent and nobody can.

    `""` is False here rather than True: an empty value is `_VENDOR_PLACEHOLDERS`' question, not
    this one, and answering it twice is how two predicates start disagreeing.

    The full argument, the evidence and the cost: `docs/design/xenium-declaration-residues.md` §2.
    """
    if not isinstance(value, str) or not isinstance(key, str):
        return False
    text = value.strip().lower()
    if not text:
        return False
    # BOTH SPELLINGS, and the reason there is no `len(subject) > len(suffix)` guard on the strip
    # below: a key that is ENTIRELY a kind suffix (`"_name"`) strips to `""`, and the only value
    # that could then match is `""` — which the `not text` return above has already refused. The
    # guard was there, a blind tests-quality angle mutated it to `>=` and the whole suite stayed
    # GREEN, and the reason is that it is genuinely unreachable rather than merely untested. A
    # statement no input can reach is removed, not given a fixture that pretends to reach it.
    whole = key.strip().lower()
    subject = whole
    for suffix in _NON_IDENTIFYING_KEY_SUFFIXES:
        if subject.endswith(suffix):
            # `break` — the FIRST matching suffix is the kind, and stripping a second would eat
            # part of the subject: `x_label_id` names the id of `x_label`, not of `x`. A blind
            # tests-quality angle found this statement unpinned and it now has its own row.
            subject = subject[:-len(suffix)]
            break
    # `whole` as well as `subject`, added by the blind design-conformance audit: a value that
    # repeats its ENTIRE key (`region_name: "region_name"`) identifies exactly as much as one that
    # repeats the subject, and the design's own justification — "a value that is only the generic
    # name of the field it fills does not identify anything" — covers it in the same sentence. The
    # first version answered False and would have emitted `sample_id: "region_name"` with
    # `sample_id_source: "region_name"`, an inference occupying the field this rule guards.
    return text in (subject, whole)


def vendor_provenance(experiment, matrix_attrs):
    """The vendor pipeline, recorded — a processing step we did not run (INV-6).

    Sourced from `experiment.xenium`, which is what §7.4's own table names for the Xenium
    row, because the h5 has almost nothing: measured on two real bundles, its root
    attributes are `{filetype, library_ids, original_gem_groups, version}` (plus
    `protein_metric` / `protein_scaling_factor` on a protein run) — no `software_version`
    and no `chemistry_description`, which are exactly the two the Visium path reads.

    Absence stays absence: a key nobody could fill is DROPPED, never written as "unknown",
    so a reader cannot mistake our placeholder for the vendor's answer.
    """
    prov = {}
    for source_key, out_key in PROVENANCE_KEYS:
        value = vendor_statement(experiment.get(source_key))
        if value is not None:
            prov[out_key] = value
    for uuid_key in ("experiment_uuid", "roi_uuid", "analysis_uuid"):
        value = vendor_statement(experiment.get(uuid_key))
        if value is not None:
            prov[uuid_key] = value
    # The h5's own library id, recorded but NOT used as identity (DEC-7). Kept because it is
    # what a reader coming from the Visium path will look for, and its uselessness here is
    # itself worth being able to see.
    lib = matrix_attrs.get("library_ids")
    if isinstance(lib, bytes):
        lib = lib.decode(errors="replace")
    elif isinstance(lib, np.ndarray):
        lib = ", ".join(x.decode(errors="replace") if isinstance(x, bytes) else str(x)
                        for x in lib.tolist())
    # NOT filtered through `stated()`: this key exists precisely to record what the Visium
    # rule WOULD have used, and its uselessness (a placeholder, identically, on every real
    # bundle) is the thing worth being able to see. Dropping it would hide DEC-7's evidence.
    if lib:
        prov["matrix_library_id"] = str(lib)
    return prov


#: The namespace a COORDINATE FRAME carries when the vendor stated no identity for it — the twin
#: of [`UNVERIFIED_SAMPLE_PREFIX`] in FORM — a prefix no vendor writes, folded into a value — and
#: NOT in reason; the two differ in exactly one way, recorded below (#323).
#:
#: `spatial_declarations.coordinate_space(*, space, ...)` requires a non-empty `space`, so "leave
#: it absent" is not expressible.
#:
#: ## WHAT THIS PREFIX IS, AND WHAT IT IS NOT — corrected twice, by two blind angles
#:
#: It is **belt-and-braces for a HUMAN**, not the load-bearing disclosure. This comment used to
#: claim the value was "the only channel a sandboxed consumer can see it in", copied from
#: [`UNVERIFIED_SAMPLE_PREFIX`], where it is TRUE: `section(*, sample_id, index, z_offset_um=None,
#: **forbidden)` refuses every other keyword by name, so the sample disclosure has nowhere else to
#: live. The argument does not survive the transplant. `coordinate_space(...)` takes
#: `coordinate_space_source=` as a keyword, `run_import` passes it INSIDE that block, and after
#: #211 that block is what crosses into the sandbox — so the machine-authoritative disclosure for
#: the SPACE already has its own key, and both bottom-rung tokens begin `unverified-space-`, i.e.
#: they already say the answer is derived. (This matters to #318: for the space half, the key that
#: retires this convention already exists.)
#:
#: And it is a TRIPWIRE, not a proof. [`vendor_frame_label`] refuses a vendor label carrying this
#: prefix in any case spelling, which blocks the straightforward forgery a second blind angle
#: measured (`roi_uuid: "unverified-space:<32 hex>"` emitted with `coordinate_space_source:
#: "roi_uuid"`). It does NOT block a determined one: a zero-width space, a Cyrillic homoglyph or a
#: fullwidth colon produces a value a READER cannot tell from a derived id. That is accepted rather
#: than answered with a normalisation arms race, and the reason it is acceptable is that the harm
#: stops at the reader: the value's BYTES differ, so it collides with no real frame, and
#: `coordinate_space_source` — in the same block, and not forgeable, because the importer writes it
#: — says `roi_uuid`. A guard that pattern-matches a semantic property has an unbounded evasion
#: space; the answer is to say what it covers, not to grow it.
UNVERIFIED_SPACE_PREFIX = "unverified-space:"

#: The namespace a frame identity carries when the vendor named the frame with MORE THAN ONE
#: field — #328, and the second half of `docs/design/xenium-declaration-residues.md` §4.1.
#:
#: The token is deliberately the SAME STRING as the `coordinate_space_source` this rung reports,
#: so the value is self-describing and the two can never drift into disagreeing.
#:
#: ## Why a namespace AND a length prefix, when either alone looks sufficient
#:
#: They answer two different halves of #328 and neither covers the other's:
#:
#: * the LENGTH PREFIX closes the rung-2-internal half — `slide_id="Slide_1_HeartBlock",
#:   region_name="R2"` and `slide_id="Slide_1", region_name="HeartBlock_R2"` are two fully
#:   identifying vendor statements that `f"xenium:{slide}_{region}"` collapsed into ONE frame,
#:   because `_` is a separator neither component is free of (the shipped protein bundle is
#:   `Slide_1` / `hKidney_sample`);
#: * the NAMESPACE closes the CROSS-rung half — `roi_uuid: "Slide_1_R2"` and an unrelated
#:   `slide_id: "Slide_1"` + `region_name: "R2"` also answered one frame, because rungs 1 and 2
#:   emitted into one undelimited space. Both statements are fully identifying and both pass every
#:   predicate; `coordinate_space_source` differed and nothing reads it, because
#:   `resolveOverlayBinding` compares the frame VALUE by equality.
#:
#: ENFORCED, not assumed, exactly as [`UNVERIFIED_SPACE_PREFIX`] is: `experiment.xenium` is
#: untrusted, so a `roi_uuid` opening with this token would otherwise emit a value
#: byte-indistinguishable from a composed one while claiming `coordinate_space_source: "roi_uuid"`.
#: [`vendor_frame_label`] refuses both tokens in one loop over [`RESERVED_SPACE_PREFIXES`].
COMPOSED_SPACE_PREFIX = "slide_id+region_name:"

#: The tokens no vendor value may OPEN with, because this module writes them itself. One tuple so a
#: third namespace is refused everywhere the moment it is named here, rather than at whichever call
#: sites someone remembers — the same "one predicate, every caller" rule `vendor_statement`'s
#: docstring records the defect for.
RESERVED_SPACE_PREFIXES = (UNVERIFIED_SPACE_PREFIX, COMPOSED_SPACE_PREFIX)


def framed_frame_components(parts):
    """The INJECTIVE framing of a multi-component vendor frame statement (#328).

    `"".join(f"{len(part)}:{part}|" for part in parts)` — a prefix-free code. Decoding reads
    decimal digits up to the first `:`, takes exactly that many CODE POINTS, and expects a `|`;
    the read is total and deterministic, so `decode(encode(parts)) == parts` and the encoding is
    injective. Over sequences of ANY arity, which is the part that also separates a one-component
    rung from a two-component one.

    ## CODE POINTS, not UTF-8 bytes, and that is not a detail (DEC-4)

    [`unverified_space_id`] length-prefixes on UTF-8 bytes because it is building a digest preimage
    out of `bytes`. This builds a `str`, and `len()` on a `str` is EXACTLY ADDITIVE over
    concatenation for every input there is — lone surrogates included. A byte count would need
    `.encode()`, which RAISES on a lone surrogate (reachable: `h5py` decodes an invalid UTF-8
    attribute with `surrogateescape`, and `experiment.xenium` is untrusted JSON), and softening it
    with `errors="replace"` would make the length no longer additive over concatenation — which is
    the single property injectivity rests on. So the encode is removed rather than softened.

    ## Which half is load-bearing (DEC-9)

    The LENGTH PREFIX. The trailing `|` is a read aid so a human can see the component boundaries
    in a report — it is written and never parsed, so a component containing `|` changes nothing.
    Said out loud because the opposite mistake is one edit away: deleting the length prefix and
    keeping the delimiter looks tidier and restores #328 exactly.
    """
    return "".join(f"{len(part)}:{part}|" for part in parts)



def vendor_frame_label(experiment, key):
    """What the vendor stated for ONE frame key, if it identifies anything — else `None` (#323).

    The FOUR questions a coordinate frame identity has to ask, asked once, in the right order —
    the two predicates this module already ships, one rule about TYPE, and one about this module's
    own vocabulary:

    * **it must be a STRING.** `vendor_statement` accepts a finite NUMBER as a statement — which is
      right for a provenance value and wrong here, because both identity predicates are blind to
      it: `_VENDOR_PLACEHOLDERS` is a string vocabulary and [`non_identifying_vendor_label`]
      returns False for a non-string. So a number is an UNFILTERABLE identity, in the one field
      whose entire job is not to falsely collide. Measured by a blind angle on the first version of
      this function: `roi_uuid: 0` — expressible in untrusted vendor JSON — answered `xenium:0`
      with source `roi_uuid`, identically for two unrelated runs. `origin/main`'s rung 1 was
      `isinstance(roi, str)`, so that shape fell PAST rung 1 before #323 touched it; this restores
      the type check and extends it to all three keys (DEC-15).
    * `vendor_statement` — *did the vendor answer at all?* It drops `_VENDOR_PLACEHOLDERS`
      (`""`, `n/a`, `na`, `unknown`, `none`, `null`, `-`), so `"unknown"` can never BE an identity.
    * [`non_identifying_vendor_label`] — *does the answer identify anything?* #320's
      self-naming-field rule, derived from the KEY rather than from a vocabulary: `region_name:
      "region"`, `slide_id: "slide"`, `roi_uuid: "roi"` are the word every unfilled instance of that
      field carries, so they cannot distinguish this run from any other run that left it generic.
    * ...and it must not be READABLE AS A VALUE THIS MODULE WRITES ITSELF — see
      [`RESERVED_SPACE_PREFIXES`]. `unverified-space:` (#323) and, since #328,
      `slide_id+region_name:`; both "no vendor writes this" claims are claims about untrusted
      input and both are enforced here, in one check over the tuple rather than one check per
      token remembered separately.

    ## Why this exists as one function instead of three call sites doing it inline

    `vendor_statement`'s own docstring records the defect that produced it: one caller read
    `provenance["region_name"]` (already filtered) while another read `experiment["region_name"]`
    RAW, and the raw one emitted `"unknown"` as a vendor-stated sample id. `coordinate_space_id`
    then shipped THREE raw reads of its own — that is #323 — so the fix is the same shape as the
    fix that predicate got: one predicate, every caller, no second spelling to drift.

    ## What is NOT asked here

    Whether the value is *sufficient* — a real `slide_id` with no `region_name` answers here and
    still cannot name a frame, because a slide carries several regions. That is
    [`coordinate_space_id`]'s question, and keeping it there is what lets this one be a pure
    per-key predicate that a fourth key could join with no edit.

    THE COST, stated: a vendor writing a NUMERIC `slide_id` (`38418` rather than `"0038418"`) no
    longer names a frame — that run falls to the derived rung. A MISSED collision, visible in the
    report and recoverable by quoting the value, on the direction this module already chose. Both
    real bundles write strings for all three keys.
    """
    raw = experiment.get(key)
    if not isinstance(raw, str):
        return None
    # `vendor_statement` returns the STRIPPED string, or `None` for a placeholder spelling. There
    # is deliberately no `if not text` guard after it: for a `str` input it answers either `None`
    # or a non-empty stripped string (`""` is itself in `_VENDOR_PLACEHOLDERS`), so the guard the
    # first version carried was UNREACHABLE — and this file's own rule, written into
    # `non_identifying_vendor_label` after a blind angle mutated exactly such a statement with the
    # suite green, is that a statement no input can reach is removed rather than given a fixture
    # that pretends to reach it.
    text = vendor_statement(raw)
    if text is None:
        return None
    if non_identifying_vendor_label(key, text):
        return None
    # CASE-FOLDED, because the claim is about what a READER can tell apart, not about bytes: a
    # blind angle pointed out that `roi_uuid: "Unverified-Space:<32 hex>"` slipped past an
    # exact-prefix check and emitted a value a human reads as this module's own derived id while
    # `coordinate_space_source` claimed a vendor statement. `non_identifying_vendor_label` folds
    # case for the same reason one predicate over.
    if text.lower().startswith(RESERVED_SPACE_PREFIXES):
        return None
    return text


#: HEX CHARACTERS KEPT from the SHA-256 below, as a named constant rather than an inline literal
#: (DEC-4). 32 hex = 128 bits, and the arithmetic is the reason: over even 10**12 coordinate
#: spaces the birthday bound at 128 bits is ~1.5e-15, while at 64 bits (16 characters) the same
#: corpus is ~2.7e-2 — a false collision this module would then be shipping knowingly, in the one
#: field whose entire job is not to falsely collide.
#:
#: The upper bound is real too and was measured, not guessed: `dataset/models.rs`'s
#: `compact_declaration` truncates a declaration string past `DECL_MAX_VALUE_CHARS = 120` on a
#: LISTING row, and `workbenchDataSource.ts` records that a MANGLED frame id is worse than a
#: missing one. At 32 the emitted space id is 56 characters and the `section.sample_id` that quotes
#: it is 74; at a full 64-hex digest they would be 88 and 106, with almost no headroom left.
#:
#: DELIBERATELY NOT operator-configurable, the same call `_NON_IDENTIFYING_KEY_SUFFIXES` makes one
#: predicate up: an operator-lowerable identity length is an operator-lowerable false-collision
#: rate. Named, so it can be promoted to a configurable later without a rewrite if that ever
#: stops being true.
_SPACE_DIGEST_HEX = 32


def unverified_space_id(cell_ids, positions):
    """A frame identity DERIVED from the run's own MEASUREMENT, when the vendor gave none.

    ## What is digested, and why it is both halves

    The vendor's own per-cell identities (`cell_feature_matrix.h5`'s `/matrix/barcodes`) **and**
    the centroids those cells were measured at (`cells.csv.gz`'s
    `x_centroid`/`y_centroid`, joined to the matrix's cell order — the same array that becomes
    `spatial/coordinates.zarr`). A frame is a set of positions; this is that set, keyed by the
    vendor's own names for the things in it.

    THE IDS ALONE WERE NOT ENOUGH, and this is the correction that matters. The first version of
    this function digested only the barcodes, and a blind design-conformance angle drove two
    genuinely different measurements — one shifted 137.5 um from the other — whose matrices carried
    generically numbered ids (`"1"`..`"23"`; nothing validates the vendor's id format) into ONE
    coordinate space and ONE `section.sample_id`. That is #323's own defect, reintroduced at the
    rung meant to remove it: the bottom rung was the one rung applying no identity check at all.
    With the positions in the preimage the claim below is true rather than probable.

    The framing is INJECTIVE: each id is length-prefixed (so it is self-delimiting whatever it
    contains), `|` closes the id block (neither a digit nor `:`, so the boundary is unambiguous),
    and the positions are a fixed 8 bytes per cell whose count is recoverable from the ids. There
    is no cell-COUNT prefix: the first version had one, a blind angle and the branch's own mutation
    battery independently showed it was deletable with every test green, and this file's rule is
    that such a statement is removed rather than given a fixture that pretends to reach it.

    IT IS ALSO PERMUTATION-INVARIANT, and that is a correction: the records are digested in ID
    ORDER, not file order. A blind angle pointed out that the sentence above ("a frame is a SET of
    positions") was false of the first version — a re-export of the SAME run with its rows in a
    different order is the same set of (id, position) pairs and was minting a DIFFERENT frame. That
    is the safe direction, but it is a missed collision the design's own framing says will not
    happen, and sorting costs nothing.

    The sort is on `(id, position)` TUPLES, so equal ids fall through to comparing their position
    lists. A later angle showed that IS reachable and corrected the reason an earlier version of
    this paragraph gave for thinking it was not: the duplicate-id refusal is on `cells.csv.gz`, not
    on `/matrix/barcodes`, so a matrix that repeats a barcode imports. The tiebreak is total and
    cannot raise — every id is coerced to `str` above and `points.tolist()` is a list of Python
    floats — and it is permutation-invariant for the duplicates too, which is the property this
    sort exists for.

    `-0.0` is normalised to `0.0` for the same reason as the sort: it is the same POSITION with
    different bytes, and a frame identity must not turn on the sign of a zero. It is a normalisation
    of ONE bit pattern and nothing else — measured over all 2**32 float32 patterns, `0x80000000` is
    the only non-NaN one whose bytes change.

    ## §12.3 says `coordinate_space` is "a CONVENTION, not a recomputed digest". Which half is this?

    The half that survives, and it is the half that carries the meaning: §12.3's rule is *derive it
    from what the vendor wrote, never MINT one*, because a minted id makes every import a new,
    unrelatable frame. Every byte in this preimage is the vendor's — nothing is generated, nothing
    is random, nothing depends on the clock or the machine — so two imports of the same bundle are
    the same frame, which is the property §12.3's sentence exists to protect. What it forbids is a
    digest STANDING IN for a stated identity; this one is reached only where there is no stated
    identity to stand in for.

    ## What #270's DEC-7 rejected, and why this is not that

    DEC-7 rejected `experiment_uuid` because it changes on every re-analysis, which would mint an
    unrelatable second frame for one slide. That is the right call for a rung COMPETING with a
    vendor-stated identity. This rung is not: it is reached only when the vendor stated none, and
    in that state nothing can relate two re-analyses of one slide anyway. What the shipped ladder
    did in that state was not "relate them" — it was relate them AND every unrelated run alongside
    them (`xenium:bundle`, `xenium:outs`; #323's own measurements).

    So the trade is stated exactly: two imports of the SAME bytes still collide correctly. A
    re-analysis that re-segments the cells or moves a centroid is a MISSED collision — visible in
    the report (`coordinate_space_source` says the frame identity was not taken from the vendor's
    labels, and the labels themselves are in the provenance block) and recoverable by naming the
    region AND the slide. That is the direction this module already chose by name.

    ## The one case that is REFUSED rather than minted

    A matrix carrying no cell identity at all — an empty barcode list, or barcodes that are all
    empty strings — would digest to ONE CONSTANT shared by every such run, which is the exact
    defect this function exists to remove, reintroduced at the bottom of the ladder that removes
    it. It refuses by name instead.

    HOW REACHABLE, said as narrowly as it was measured. The empty-LIST half is defensive:
    `run_import`'s `n_cells == 0` guard fires first. The all-blank half is reachable but narrower
    than an earlier version of this paragraph implied — a blind angle drove it and found that the
    ORDINARY all-blank shape (N blank barcodes joined to N blank-id rows) is refused EARLIER, by
    the duplicate-cell-id guard, and never gets here. What reaches here is the asymmetric shape: a
    multi-cell matrix of blank barcodes against a cells table carrying exactly one blank id. The
    design's claim (refused, not minted) holds either way; this paragraph now says which guard
    actually answers.
    """
    ids = [] if cell_ids is None else [
        c.decode(errors="replace") if isinstance(c, bytes) else str(c) for c in cell_ids]
    if not any(i.strip() for i in ids):
        raise XeniumImportError(
            f"`{MATRIX_BASENAME}` carries no cell identity in `/matrix/barcodes` "
            f"({len(ids)} entries, none of them a non-empty string), and no `roi_uuid`, "
            "`slide_id` or `region_name` in `experiment.xenium` IDENTIFIES this acquisition "
            "either — the report's `coordinate_space_source` says which of those two cases you "
            "are in. There is nothing left to derive a coordinate frame from, and a frame id "
            "derived from nothing would be the SAME id for every such bundle: two unrelated "
            "tissues declared to share one frame. Either name the region AND the slide (or supply "
            "a real `roi_uuid`) in `experiment.xenium`, or re-export the bundle with its cell ids."
        )
    # `<f4` — LITTLE-ENDIAN float32, stated rather than inherited. `tobytes()` writes the array's
    # NATIVE byte order, so a plain `float32` view would make this id a function of the machine
    # that computed it, and `coordinate_space` is a value two producers on two machines have to
    # agree on. (That clause cannot be falsified on little-endian hardware; TEST-14's golden value
    # is what would redden on a big-endian host, which is the only place the two differ.)
    #
    # The `ascontiguousarray` this line used to carry is gone, and the FIRST reason given for that
    # was wrong: `astype` defaults to `order="K"`, so it preserves an F-ordered input's layout. The
    # real reason is one level down — `tobytes()` itself defaults to `order="C"` and writes C-order
    # bytes whatever the layout is — so the wrapper could not change the digest for any input.
    try:
        # `<f4` — LITTLE-ENDIAN float32, and the CONVERSION IS GUARDED, which the first version was
        # not: it ran before the shape check, so a ragged list, a list of strings or a mapping died
        # as a bare `ValueError`/`TypeError` and `main()` catches only `XeniumImportError`. The
        # shape guard could not answer the shapes it names.
        points = np.asarray(positions).astype("<f4")
    except (TypeError, ValueError, OverflowError) as exc:
        # `OverflowError` joined the tuple after an angle reached it with an integer too large for
        # a float; a guard that names three of four ways one call fails is the same shape as a
        # guard on one of four reads. The message says "as an (N, 2) array of numbers" rather than
        # "as numbers" because a RAGGED list of perfectly good numbers lands here too, and calling
        # that a number problem sends a reader looking at the wrong thing.
        raise XeniumImportError(
            f"the cell positions cannot be read as an (N, 2) array of numbers "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). The coordinate frame is derived from the positions "
            "AND the ids together. This is an INTERNAL invariant: `run_import` builds them as a "
            "float32 array over the matrix's own ids, so it cannot be reached from a real import."
        ) from None
    if points.shape != (len(ids), 2):
        raise XeniumImportError(
            f"the joined cell positions have shape "
            f"{_quoted_for_refusal(points.shape, noun='shape')} but the matrix declares "
            f"{len(ids)} cells. The coordinate frame is derived from the positions AND the ids "
            "together, so a mismatch here would digest a different run's geometry. This is an "
            "INTERNAL invariant, not a statement about your bundle: `run_import` length-checks the "
            "ids against `/matrix/shape` and builds the positions over those same ids, so it "
            "cannot be reached from a real import. If you are seeing it, this function was called "
            "directly with mismatched arguments."
        )
    # `+ 0.0` normalises `-0.0` to `0.0`: the same position, and it must not be a different frame.
    # (It changes nothing else — every other value is unaffected, and non-finite centroids are
    # refused upstream by `run_import` before they can reach here.)
    points = points + np.float32(0.0)
    digest = hashlib.sha256()
    # SORTED BY ID, so the same measurement re-exported in a different row order is the same frame
    # (see the docstring). The pairing is preserved because the id travels with its own point.
    ordered = sorted(zip(ids, points.tolist()))
    # Each id LENGTH-PREFIXED — a self-delimiting framing, so the digest is a function of the LIST
    # and not merely of its concatenation: without it `["ab", "c"]` and `["a", "bc"]` are one frame.
    for cid, _point in ordered:
        # `errors="replace"`: `experiment.xenium` and the h5 are untrusted, and a lone surrogate
        # must not turn an identity function into an uncaught `UnicodeEncodeError` — `main()`
        # catches only `XeniumImportError`.
        raw = cid.encode("utf-8", errors="replace")
        digest.update(f"{len(raw)}:".encode("ascii"))
        digest.update(raw)
    digest.update(b"|")
    digest.update(np.asarray([point for _cid, point in ordered], dtype="<f4").tobytes())
    return f"{UNVERIFIED_SPACE_PREFIX}{digest.hexdigest()[:_SPACE_DIGEST_HEX]}"


#: The two things a bottom-rung run can be, distinguished because only ONE of them is fixable by
#: the operator — the same reason `section_sample_id` ships two tokens for its two fallback rows.
#: A run that landed on the first can be given a frame identity by naming its region AND its slide
#: (rung 2 needs both, because a slide carries several regions), or by carrying a real `roi_uuid`;
#: a run that landed on the second wrote nothing, and there is nothing to rename.
#:
#: THE SPLIT IS "DID THE VENDOR WRITE ANYTHING", NOT "DID IT SURVIVE `vendor_statement`", and a
#: blind angle is why: the first version asked the second question, so `roi_uuid: "unknown"` — the
#: FIRST row of #323's measured table — was reported as `no-vendor-statement`, telling the operator
#: there was nothing to rename when a placeholder is precisely the thing they can replace.
NON_IDENTIFYING_SPACE_SOURCE = "unverified-space-non-identifying-labels"
NO_VENDOR_SPACE_SOURCE = "unverified-space-no-vendor-statement"

#: The `experiment.xenium` keys that can name a coordinate FRAME, in ladder order.
_FRAME_LABEL_KEYS = ("roi_uuid", "slide_id", "region_name")


def _wrote_a_frame_label(experiment):
    """True when the vendor put a value in a frame key — placeholder spellings and unreadable
    types included; `null` and a blank string excluded, because neither is distinguishable from
    the key being absent and neither gives the operator anything to replace.

    The operator-recoverability question, which is a different question from
    [`vendor_frame_label`]'s: `region_name: "unknown"` identifies nothing AND is something a human
    can go and replace, while an absent key is not.
    """
    for key in _FRAME_LABEL_KEYS:
        value = experiment.get(key)
        if value is None:
            # `null` and an absent key are the same statement: nothing.
            continue
        if isinstance(value, str):
            # A blank string is nothing written either — nothing distinguishes `""` from the key
            # being absent, and the operator has nothing to replace in it.
            if value.strip():
                return True
            continue
        # ANY OTHER TYPE COUNTS, including a mapping, a list or a bool. A blind angle found the
        # first version asking `_finite`, which sent `roi_uuid: {...}` to the "the vendor wrote
        # nothing, there is nothing to rename" row while there was plainly a value to replace —
        # the same mis-report the placeholder row had one round earlier. This function answers the
        # RECOVERABILITY question; deciding whether a value is usable is `vendor_frame_label`'s job
        # and it is a separate one.
        return True
    return False


def coordinate_space_id(experiment, cell_ids, positions):
    """The `coordinate_space` id — the vendor's own frame identity, or a derived one that SAYS so.

    §12.3 records that `coordinate_space` is a CONVENTION, not a recomputed digest, so producer
    discipline is the whole mechanism. Visium derives it from the matrix's library id; Xenium
    CANNOT — measured on two real bundles, `library_ids` is the placeholder `0000000_0000000` in
    BOTH, so that rule would declare two unrelated experiments to share one frame and place one
    tissue's image against the other's cells. (Which half of §12.3 the bottom rung stands on is
    answered in [`unverified_space_id`]: derived from the vendor's own bytes, never minted.)

    `roi_uuid` identifies the region of interest at ACQUISITION (it sits with `cassette_uuid` /
    `well_uuid` / `calibration_uuid`, not with the analysis), so it is stable across a re-analysis
    — which is the property "two imports of ONE slide collide correctly" needs — and it is distinct
    between the two real bundles. `experiment_uuid` was rejected for the opposite reason: it
    changes on every re-analysis, so re-running XOA on one slide would mint an unrelatable second
    frame.

    Between the two error directions, a MISSED collision is visible and recoverable while a FALSE
    collision is silent wrong data, so the fallbacks get more specific, never less.

    ## #323 — that last sentence was the ladder's law and the shipped ladder broke it

    Every rung used to read the vendor string RAW and the bottom rung used to be
    `Path(bundle_root).name`. MEASURED on `origin/main` @ `5c6b499e`, and every row is two
    unrelated runs declared to share one coordinate frame:

        roi_uuid='unknown'   run-A / run-B       -> BOTH xenium:unknown          (roi_uuid)
        slide/region='unknown'   run-A / run-B   -> BOTH xenium:unknown_unknown  (slide_id+region_name)
        nothing stated, root=/inputs/bundle      ->      xenium:bundle           (bundle-directory-name)
        nothing stated, /uploads/x|y/outs        -> BOTH xenium:outs             (bundle-directory-name)

    `bundle-directory-name` was the worst of the three: `bundle_root`'s basename is the SANDBOX
    MOUNT NAME, which `sandbox/spec.rs` derives from the SLOT (`derive_artifact_mount_name` /
    `InputDecl::declared_mount_name`), so it is plausibly the constant `bundle` for every Xenium
    import in a deployment — and where it IS the user's own directory, `outs` is XOA's own output
    directory name. The rung the ladder fell to was the rung most likely to be SHARED, which
    inverts the law stated one paragraph up.

    ## The three changes, and why they had to land together

    * every rung reads through [`vendor_frame_label`], so a placeholder, a self-naming label or a
      value of a type neither identity predicate can inspect can never BE a frame identity;
    * `bundle-directory-name` is GONE, and `bundle_root` is gone from the signature with it — a
      run's coordinate identity must not be a function of where it happened to be mounted, and the
      parameter's absence is what stops that returning by a later edit;
    * the bottom rung is [`unverified_space_id`], derived from the run's own measurement and
      unreadable as a vendor id by construction.

    They land together because a gate on ONE rung moves the values it rejects DOWN. #320 gated the
    `slide_id+region_name` rung while the bottom was still the directory name, measured that this
    moved prime-shaped bundles onto a value shared by ALL runs, and WITHDREW the change (its DEC-7
    CORRECTION) rather than ship a wider false collision. That reasoning is not reversed here, it
    is satisfied: once the bottom cannot be shared, every gate above it is strictly narrowing.

    ## What is emitted now

    | what the vendor stated | value | `coordinate_space_source` |
    |---|---|---|
    | an identifying `roi_uuid` | `xenium:<roi_uuid>` | `roi_uuid` |
    | an identifying `slide_id` + `region_name` | `xenium:slide_id+region_name:` then each component length-prefixed (see [`framed_frame_components`]) | `slide_id+region_name` |
    | anything else, in any frame key | `xenium:unverified-space:<digest>` | `unverified-space-non-identifying-labels` |
    | nothing in any frame key | `xenium:unverified-space:<digest>` | `unverified-space-no-vendor-statement` |

    The two bottom rows share a VALUE and differ in SOURCE, exactly as `section_sample_id`'s two
    fallback rows do and for the same reason: only one of them is fixable by the operator.

    ## THE RESIDUE #323 LEFT, AND WHY IT IS CLOSED HERE (#328)

    #323 shipped the RULE and did not constrain the FRAMING, and two collisions lived in that gap.
    Both were found by blind design-conformance angles, both were measured end to end, and both
    were left as characterization tests rather than fixed, because the fix moves a SHIPPED id:

        slide='Slide_1_HeartBlock' region='R2'   -> xenium:Slide_1_HeartBlock_R2  (slide_id+region_name)
        slide='Slide_1' region='HeartBlock_R2'   -> xenium:Slide_1_HeartBlock_R2  (slide_id+region_name)
        roi_uuid='Slide_1_R2'                    -> xenium:Slide_1_R2             (roi_uuid)
        slide='Slide_1' region='R2'              -> xenium:Slide_1_R2             (slide_id+region_name)

    Every row is two unrelated runs, each making a DIFFERENT and fully identifying vendor
    statement, declared to share one coordinate frame. `coordinate_space_source` differs on the
    second pair and nothing reads it: `resolveOverlayBinding` compares the frame VALUE by equality
    and by nothing else.

    #328's trade table said the fix costs a systematic MISSED collision — an already-imported
    rung-2 dataset would not bind to its own re-import — and that nobody can recover from it. It
    is taken anyway (DEC-2, design §4.3) on three measurements that table did not have:

    * **no committed real bundle is on rung 2.** Both `xenium-prime-outs` and
      `xenium-protein-outs` carry a `roi_uuid` and answer on rung 1, whose value does not move —
      and `roi_uuid` sits with `cassette_uuid` / `well_uuid` / `calibration_uuid` in every real
      `experiment.xenium` observed, so a bundle without one is the exception;
    * **the missed collision is VISIBLE**: `coordinate_space_source` still reads
      `slide_id+region_name` on both sides, the verbatim labels are still in the provenance block,
      and the manifest changelog states the format move — which is what an operator needs to
      understand a re-import that no longer binds;
    * **the false collision is visible to nobody and recoverable by nobody.** The frame id is
      baked into the artifact on BOTH sides, and the user gets a plausible picture and no error.

    This function's own rule decides it: *a MISSED collision is visible and recoverable while a
    FALSE collision is silent wrong data.* The recoverability half is weaker here than usual, which
    is why it was a decision rather than an obvious call — but it weakens the argument without
    reversing it.

    ## What it costs

    A slide genuinely named `slide` holding a region genuinely named `region`, with no `roi_uuid`,
    does not get a vendor-derived frame — two such runs are not declared to share one even if they
    genuinely are two acquisitions of one region. That is a MISSED collision, bought knowingly on
    this function's own rule, and it is visible (the source token, plus the operator's verbatim
    labels still in the provenance block) and recoverable (name the region AND the slide, or supply
    a `roi_uuid`, and the same two bundles share a frame again). The full argument:
    `docs/design/xenium-declaration-residues.md` §3.
    """
    roi = vendor_frame_label(experiment, "roi_uuid")
    if roi:
        return f"xenium:{roi}", "roi_uuid"
    slide = vendor_frame_label(experiment, "slide_id")
    region = vendor_frame_label(experiment, "region_name")
    # BOTH, still: a slide carries several regions, so `slide_id` alone names no frame — the same
    # reason `section_sample_id` refuses it as a sample id.
    if slide and region:
        # THE COMPOSED NAMESPACE (#328). `f"xenium:{slide}_{region}"` — what this line used to be
        # — is not an injective framing, and both fields routinely contain `_`. See
        # [`COMPOSED_SPACE_PREFIX`] for the two collisions that removed, and
        # [`framed_frame_components`] for why the length prefix rather than an escaped delimiter.
        return (f"xenium:{COMPOSED_SPACE_PREFIX}{framed_frame_components((slide, region))}",
                "slide_id+region_name")
    source = (NON_IDENTIFYING_SPACE_SOURCE if _wrote_a_frame_label(experiment)
              else NO_VENDOR_SPACE_SOURCE)
    return f"xenium:{unverified_space_id(cell_ids, positions)}", source


#: The namespace an emitted `section.sample_id` carries when the bundle states NO sample.
#:
#: A prefix rather than a second key, and that is forced rather than chosen: the vendored
#: `spatial_declarations.section(*, sample_id, index, z_offset_um=None, **forbidden)` REQUIRES a
#: non-empty `sample_id` and REFUSES every other keyword by name, so neither "leave it absent"
#: nor "record a `sample_id_source` beside it" is expressible in the block that crosses into the
#: sandbox. Folding the disclosure into the VALUE is the only channel a sandboxed consumer can
#: see it in. The contract gap is filed rather than worked around silently: **issue #318**
#: proposes both an optional `sample_id` and a `sample_id_source` on the shared block, and this
#: convention is retired when that lands. Cited by ISSUE NUMBER on purpose — a branch's
#: lifecycle artifacts are stripped at merge, so a pointer into them is one a reader of this
#: module cannot follow.
UNVERIFIED_SAMPLE_PREFIX = "unverified-sample:"

#: WHAT `section.index = 0` IS A CLAIM ABOUT, disclosed in the report for the same reason
#: `sample_id_source` is. `section()` takes a bare `int` and has no way to carry a basis, and
#: the honest content of the value is narrow: the bundle STATES one region — one
#: `region_name`, one `roi_uuid`, one `images` block — so its series has exactly one section
#: and `0` is that series' only ordinal. It is NOT a statement about where this section sits
#: among a sample's others; one bundle cannot know that. Also part of #318.
SECTION_INDEX_SOURCE = "single-region-bundle"


def section_sample_id(experiment, space_id):
    """`(sample_id, source)` for §15.4's `section` — the twin of [`coordinate_space_id`] (#270).

    ## What §15.4 asks for, and what a Xenium bundle actually states

    The design's example is `sample_id: "donor-04-blockA"`, and the field's stated purpose is
    grouping *"several sections of one sample intended to align into a volume"*. Measured
    against two real bundles' `experiment.xenium`: there is NO donor, block or sample key in
    the manifest at all. The nearest vendor statement is `region_name` — the operator's own
    name for the imaged region (`hKidney_sample` on one bundle, the generic `region` on
    the other) — and that is leg 1, kept, because it is a string the VENDOR wrote.

    ## The leg #320 added between the statement and the fallback

    "The vendor wrote a string" and "the string identifies a sample" are two facts, and #270 shipped
    only the first. MEASURED on two staged copies of `xenium-prime-outs` with different `roi_uuid`s:
    both got `sample_id='region'`, both `index: 0` — two unrelated experiments declaring themselves
    section 0 of one sample. So a `region_name` that is only the generic name of its own field
    (see [`non_identifying_vendor_label`], which carries the rule, the evidence and the cost)
    falls through to the namespaced value with its OWN source, `non-identifying-region-name`:

    | `region_name` | `sample_id` | `sample_id_source` |
    |---|---|---|
    | `hKidney_sample` | `hKidney_sample` | `region_name` |
    | `region` | `unverified-sample:<space_id>` | `non-identifying-region-name` |
    | absent / `unknown` / `""` | `unverified-sample:<space_id>` | `no-vendor-sample-statement` |

    The two fallback rows share a VALUE and differ in SOURCE on purpose: what a consumer needs from
    the value is uniqueness PER COORDINATE SPACE, and what a human needs from the report is which of
    the two happened — in the second row the provenance block still carries `region_name: "region"`
    verbatim, and in the third it carries nothing, so the pair is self-consistent either way.

    **"Unique per coordinate space" is exactly as strong as the coordinate space, and no stronger.**
    That was a STANDING DEBT and it is now paid, one function up. When #320 shipped this leg,
    [`coordinate_space_id`] answered three values two unrelated runs share — `xenium:unknown`,
    `xenium:slide_region`, `xenium:bundle`; all three MEASURED end to end — and the namespaced
    sample id inherited every one of them whole. #320 deliberately did not half-fix that (gating
    one rung moves the values it rejects onto a rung that is LESS discriminating; its DEC-7
    CORRECTION) and filed **#323**, which closed all three by replacing the ladder's bottom rung
    with a value that is unique BY CONSTRUCTION before tightening the rungs above it.

    So this leg's promise holds on every shape #320 recorded it AT-RISK for: the value is unique
    per coordinate space (#320) AND the coordinate space is unique per run (#323), and neither half
    is sufficient alone. The two halves are asserted separately — by TEST-8/TEST-9b here and by the
    coordinate-space suite one file over — because each can regress without the other.

    IT DOES NOT HOLD OUTRIGHT, and this docstring will not say it does. #323 found a fourth shape
    that #320 had not: rung 2's `f"xenium:{slide}_{region}"` is not an injective framing (and rungs
    1 and 2 share one namespace), so two unrelated runs with fully identifying vendor labels can
    still share a frame and therefore a sample id. It is open as **#328**, asserted by
    `test_coordinate_space_identity.py`'s characterization rows, and the design note's §3.6 says the
    same thing in the same words. Claiming an invariant one measurement wider than the code
    delivers is the mistake §2.5 exists to record; repeating it with a smaller residue would be the
    same mistake in a politer font.

    ## The two legs that are gone, and why each was worse than nothing

    * `slide_id` — a SLIDE carries several regions, so it is not a sample. Grouping on it
      declares two unrelated tissues to be sections of one sample: a FALSE collision, which is
      the error direction [`coordinate_space_id`] already names as the unrecoverable one
      (*"a MISSED collision is visible and recoverable while a FALSE collision is silent wrong
      data"*).
    * the bare coordinate-space id — which is `xenium:<roi_uuid>` or, at its own last leg, the
      UPLOAD DIRECTORY'S NAME. A field a consumer reads as the vendor's sample identity, filled
      from an accident of how the user zipped their download.

    ## What is emitted when the vendor states nothing

    Not absence — `section()` refuses that — and not a bare inference either. The value is
    `unverified-sample:<space_id>`, which is:

    * unmistakable for a vendor sample id, because no vendor writes that prefix;
    * unique per coordinate space, so two bundles that state no sample do NOT falsely collide;
    * PAIRED with a provenance after all, in the only way this contract allows: `<space_id>` is
      the coordinate space declared five lines away, whose own `coordinate_space_source` sits in
      the SAME mirrored block. A consumer reading `section.sample_id` can therefore see exactly
      how the id it is looking at was derived, which is what
      `spatial_declarations.py:451-473` asks for (*"a value and the record of where it came
      from are a PAIR"*).

    The returned `source` is the same record in machine form; `run_import` puts it in the
    report, next to the sample id, the way the report already pairs the coordinate space with
    its `Space id source`.
    """
    # THROUGH [`vendor_frame_label`] AT #323 — the SAME predicate the coordinate frame uses, not a
    # second reading of the raw key. It composes `vendor_statement` (so a `_VENDOR_PLACEHOLDERS`
    # spelling is not a sample), #320's self-naming-field rule (so `region` is not a sample), the
    # STRING rule, and the derived-prefix refusal.
    #
    # THE STRING RULE IS WHY THIS MOVED, and it is #323's DEC-15 applied to the twin field.
    # `vendor_statement` accepts a finite NUMBER — right for a PROVENANCE value — but both identity
    # predicates are blind to one, so a number was an UNFILTERABLE identity here exactly as it was
    # on the frame keys. MEASURED by a blind design-conformance angle, end to end: two unrelated
    # runs stating `region_name: 0`, correctly given DIFFERENT coordinate frames by #323, both
    # declared themselves *section 0 of sample "0"* — the FALSE collision this module names as the
    # unrecoverable direction, on the one field #320 exists to protect. The rule was written for
    # the frame keys and applied to two of three identity fields; this is the third.
    #
    # WHAT IT COSTS: a vendor writing `region_name: 7` (a JSON number, not `"7"`) no longer names a
    # sample; that bundle gets the namespaced value with `sample_id_source:
    # "non-identifying-region-name"`, and `provenance.region_name` still carries `7` verbatim. A
    # MISSED collision, visible and recoverable by quoting the value. #270/#271's own row for that
    # input is inverted rather than deleted, keeping its control content.
    identifying = vendor_frame_label(experiment, "region_name") or ""
    if identifying and not identifying.lower().startswith(UNVERIFIED_SAMPLE_PREFIX):
        return identifying, "region_name"
    # THE SOURCE DECISION IS A SEPARATE READ, and it has to be: `vendor_frame_label` answers "does
    # this identify a sample", and the two fallback tokens answer "did the vendor WRITE one" — the
    # same split `coordinate_space_id` makes with `_wrote_a_frame_label`. Collapsing them makes
    # every non-identifying row report `no-vendor-sample-statement`, which is the mis-report #323's
    # own FIX_ROUND-1 corrected one function up. `vendor_statement` rather than
    # `vendor_frame_label` so a NUMBER still counts as something the operator wrote and can
    # replace, even though it can no longer BE the sample id.
    #
    # AND A VALUE NEITHER PREDICATE CAN READ COUNTS AS WRITTEN. A blind angle measured the two
    # disclosures in ONE report contradicting each other: `region_name: {"tissue": "kidney-A"}`
    # reported `coordinate_space_source: "unverified-space-non-identifying-labels"` ("the vendor
    # wrote something you can replace") and `sample_id_source: "no-vendor-sample-statement"`
    # ("the vendor wrote nothing") for the same key and the same value — while `vendor_provenance`
    # dropped the key, so nothing in the report recorded that the vendor had written anything at
    # all. A mapping, a list, a bool, a NaN: `vendor_statement` answers None for every one, and
    # none of them is nothing.
    #
    # A PLACEHOLDER IS DELIBERATELY NOT IN THIS SET, and that asymmetry with the space leg is
    # #320's, documented and pinned: `region_name: "unknown"` stays `no-vendor-sample-statement`,
    # because `_VENDOR_PLACEHOLDERS` is the vendor's own spelling for "no answer" and this field's
    # rule was written that way. Pinned by
    # `test_unverified_declarations.py::test_a_vendor_placeholder_is_not_a_vendor_sample_statement`
    # — named by path because an earlier version of this line pointed at design §2.4, which names
    # no test at all.
    raw_region = experiment.get("region_name")
    stated = vendor_statement(raw_region)
    wrote = stated is not None or (raw_region is not None and not isinstance(raw_region, str))
    # THE `unverified-sample:` CLAUSE IS #323's, and it is the twin of the one
    # [`vendor_frame_label`] carries — added because a blind security angle measured the two
    # prefixes' enforcement being ASYMMETRIC after #323 tightened one of them. `region_name` is
    # attacker-controlled vendor JSON, so a bundle stating
    # `region_name: "unverified-sample:xenium:unverified-space:<a victim's 32 hex>"` was emitted
    # VERBATIM as `section.sample_id` with `sample_id_source: "region_name"` — two artifacts in
    # DIFFERENT, correctly-derived coordinate frames declaring themselves sections of ONE sample.
    # That is the FALSE collision this module names as the unrecoverable direction, and it
    # falsified this function's own docstring twice over ("unmistakable for a vendor sample id,
    # because no vendor writes that prefix"; "two bundles that state no sample do NOT falsely
    # collide"). Case-folded, and — like its twin — a tripwire on the spellings a reader cannot
    # tell apart rather than a proof: a homoglyph still renders alike, but its BYTES differ so it
    # collides with nothing, and `sample_id_source` still says which leg answered.
    #
    # #320. THE VENDOR WROTE SOMETHING AND IT NAMES NO SAMPLE — a distinct fact from "the vendor
    # gave no answer", and it gets its own source token so the report can tell them apart. The
    # value takes the same namespaced form because the property that matters is identical: it is
    # unique PER COORDINATE SPACE.
    #
    # "TWO UNRELATED RUNS CANNOT COLLIDE" IS TRUE OF EVERY SHAPE #320 MEASURED — and not outright;
    # #328 is the one that remains, and the docstring above says so.
    # This comment claimed it, two blind angles measured otherwise, and it was corrected to say so.
    # `<space_id>` is only as unique as [`coordinate_space_id`] makes it, and when #320 shipped,
    # three reachable shapes gave two unrelated runs ONE space and therefore one sample id:
    # `roi_uuid='unknown'`; the prime-shaped bundle with no `roi_uuid` (`xenium:slide_region`); and
    # a bundle stating nothing, mounted under the sandbox's slot name (`xenium:bundle`). All three
    # were filed as **#323** and all three are CLOSED there — the ladder's bottom rung is now
    # unique by construction, so each of those shapes mints a distinct frame per run. A FOURTH
    # shape, found by #323's own audit and NOT closed, is #328.
    # `test_declaration_residues.py`'s TEST-17 and TEST-26 assert exactly those shapes, INVERTED:
    # they used to be the executable record that the residue was open and are now the executable
    # record that it is shut. What this leg is responsible for it delivers; what it inherits, it
    # now inherits clean.
    if wrote:
        return f"{UNVERIFIED_SAMPLE_PREFIX}{space_id}", "non-identifying-region-name"
    return f"{UNVERIFIED_SAMPLE_PREFIX}{space_id}", "no-vendor-sample-statement"


def segmentation_declaration(methods, experiment):
    """`measured_entity.segmentation` for a run whose cells may not agree (DEC-12).

    `methods` is the DISTINCT set of the vendor's own per-cell `segmentation_method`
    strings, sorted. The declaration's `method` is a single string and XOA >= 3 is not:
    measured, one real bundle carries THREE methods across 358 cells (boundary stain,
    interior stain, nucleus expansion). Reducing them to the most common one would be a
    plausible-looking lie in the one field whose entire purpose is identity, so a mixture is
    NAMED as a mixture and the run-level fractions the vendor states go into `params`
    alongside it. The per-cell truth is never lost — it is emitted as a `metadata-column`.

    This is a finding against the #152 declaration, reported upward rather than fixed here:
    changing the shape of `segmentation` is a shared-vocabulary change touching every
    producer and consumer.
    """
    ordered = sorted(m for m in methods if m)
    if not ordered:
        method = "unstated"
    elif len(ordered) == 1:
        method = ordered[0]
    else:
        method = "mixed: " + " | ".join(ordered)
    params_block = {"methods": ordered, "n_methods": len(ordered)}
    for key in _SEGMENTATION_FRACTION_KEYS:
        value = _finite(experiment.get(key))
        if value is not None:
            params_block[key] = value
    # The ONE number §15.1 says is decisive and unrecoverable. Parsed from the vendor's own
    # string rather than assumed, and written only when the vendor stated it.
    expansions = sorted({float(m.group(1)) for s in ordered
                         for m in [_EXPANSION_RE.search(s)] if m})
    if len(expansions) == 1:
        params_block["expansion_um"] = expansions[0]
    elif expansions:
        params_block["expansion_um"] = expansions
    version = experiment.get("analysis_sw_version")
    return {
        "method": method,
        "params": params_block,
        # REQUIRED by the declaration, and rightly: 10x changed the default nucleus
        # expansion from 15 um to 5 um between versions, which alters every cell.
        "software_version": str(version).strip() if version else "unstated",
    }


# ─────────────────────────── the scale cross-check ───────────────────────────


#: OME's length units, in MICROMETRES per unit. Read because they sit right next to the
#: number: `<Pixels … PhysicalSizeX="0.2125" PhysicalSizeXUnit="µm" …>`. Ignoring the unit
#: would make a legal OME-TIFF written in nanometres (which a bioformats or QuPath round
#: trip really produces) read as a factor-1000 disagreement, and the report would blame the
#: bundle for being self-inconsistent when it is not. (Until 0.6.0 it did worse than blame
#: it: the image was refused outright.) A check that declines to read half of the statement
#: it compares is not a check.
#: MATCHED EXACTLY, never case-folded. OME's `UnitsLength` symbols are CASE-SIGNIFICANT:
#: `Mm` is a megametre and `mm` a millimetre (1e9 apart), `Pm` a petametre and `pm` a
#: picometre (1e27 apart). A `.lower()` fallback silently conflates each pair — reproduced —
#: so the only safe lookup is the literal symbol, plus the handful of spelled-out aliases
#: real writers emit. An unrecognised symbol is `None`, which is handled below.
_OME_LENGTH_UM = {
    "m": 1e6, "dm": 1e5, "cm": 1e4, "mm": 1e3,
    # U+00B5 MICRO SIGN and U+03BC GREEK SMALL LETTER MU are different codepoints and OME
    # writers emit both, so both are needed. (A fourth entry spelling U+00B5 literally used
    # to sit here — the same key twice, so the table held 15 entries where the source read
    # 16. Harmless to behaviour, but it made every "every unit in `_OME_LENGTH_UM`" claim
    # cover one fewer alias than a reader counting the line would expect.)
    "\u00b5m": 1.0, "\u03bcm": 1.0, "um": 1.0,
    "micron": 1.0, "microns": 1.0, "micrometer": 1.0, "micrometre": 1.0,
    "nm": 1e-3, "pm": 1e-6, "\u00c5": 1e-4, "angstrom": 1e-4,
}

#: OME's own DEFAULT when the unit attribute is absent is micrometres, so absence is a
#: stated unit rather than an unknown one.
_OME_DEFAULT_UNIT = "\u00b5m"

#: The sentinel for "the image DID state a physical size, in a unit this importer cannot
#: convert". Distinct from `None` (no statement at all) because the two lose the scale
#: cross-check for different reasons and a reader is entitled to know which.
_UNREADABLE_UNIT = object()


def ome_physical_size(ome_xml):
    """`(x_um, y_um)` from an OME-XML `Pixels` element, or `(None, None)`.

    The SECOND, independently-authored statement of the pixel size. It is written into the
    image file by a different part of 10x's pipeline than the one that writes
    `experiment.xenium`, which is exactly why it is worth reading — and why it is converted
    to micrometres rather than compared raw.

    An UNRECOGNISED unit yields `None` for that axis rather than a number in an unknown
    unit: absence is absence, and a length with no unit is precisely the bug the
    coordinate-space declaration exists to prevent one layer up.
    """
    if not ome_xml:
        return None, None
    match = re.search(r"<Pixels[^>]*>", ome_xml)
    if not match:
        return None, None
    block = match.group(0)

    def one(axis):
        found = re.search(f"PhysicalSize{axis}=\"([^\"]+)\"", block)
        if not found:
            return None
        try:
            value = float(found.group(1))
        except ValueError:
            return None
        if not (math.isfinite(value) and value > 0):
            return None
        unit = re.search(f"PhysicalSize{axis}Unit=\"([^\"]+)\"", block)
        unit = (unit.group(1) if unit else _OME_DEFAULT_UNIT).strip()
        factor = _OME_LENGTH_UM.get(unit)
        if factor is None:
            # STATED, not silently absent. Returning `None` here would make an unreadable
            # unit indistinguishable from an image that declares no physical size at all —
            # and those are different facts: the first LOSES the cross-check while a second
            # statement was sitting right there, the second never had one. `stated_scales`
            # records which happened.
            return _UNREADABLE_UNIT
        return value * factor

    return one("X"), one("Y")


def readable(stated):
    """The stated micron size, or `None` when there was none this importer can read.

    One place converts the `_UNREADABLE_UNIT` sentinel back to "no usable number", so no
    caller has to know the sentinel exists — and the ONE caller that must distinguish the
    two cases (`emit_image`, for `stated_scales.agreement`) tests the sentinel itself.
    """
    return None if stated is _UNREADABLE_UNIT or stated is None else stated


#: HOW MANY float64 STEPS OUR OWN ARITHMETIC CAN MOVE THE TWO NUMBERS APART.
#:
#: This is NOT a tolerance for vendor disagreement — #269 deleted that and measured why. It
#: bounds the error THIS IMPORTER introduces between two numbers the vendor wrote to mean the
#: same thing, and it is ENUMERATED rather than chosen. One rounding per step, each at most
#: half an ulp:
#:
#:   1. `experiment.xenium`'s literal -> float64                    <= 0.5 ulp
#:   2. the OME-XML's literal -> float64                            <= 0.5 ulp
#:   3. the `_OME_LENGTH_UM` factor -> float64 (1e-3, 1e-4, 1e-6
#:      are NOT exactly representable)                              <= 0.5 ulp
#:   4. `value * factor`                                            <= 0.5 ulp
#:                                                                  -------------
#:                                                                    2.0 ulp
#:
#: THE PRECONDITION, stated because a blind round found the claim standing without it:
#: summing half-ulps taken at four different magnitudes is licensed only while every
#: intermediate is a NORMAL float64. Leave that range and the sum is not a bound at all — a
#: quantity of `1e-303 um` restated in metres has a SUBNORMAL literal (`1e-309`) and lands
#: 12 ulp away; `2e-305` in metres lands 415 ulp away. Both compared values are ordinary
#: normal doubles there, so this is the floor being far too STRICT, and it is the opposite
#: direction from the leniency recorded under KNOWN LIMIT below. Neither is reachable by a
#: pixel size: the nearest is 300 orders of magnitude from any real one, and
#: `test_the_conversion_floor_is_pinned_from_both_sides` asserts that every intermediate in
#: its sweep is normal, so the precondition is checked rather than assumed.
#:
#: `_STATED_SCALE_ULP_STEPS` below is that enumeration in executable form, so the constant
#: cannot drift away from its own derivation: `test_the_conversion_floor_is_pinned_from_both
#: _sides` re-derives the sum AND re-measures the worst case, and refuses a value that is
#: below the measurement or above the enumeration.
#:
#: WHAT THAT DETERMINES — and it is now a SINGLE VALUE, which it was not for four rounds.
#: The measurement bounds this constant from below (2.0 ulp observed) and the enumeration
#: from above (2.0 ulp proved), and the two COINCIDE, so the evidence admits exactly one
#: value. `_CONVERSION_ULPS = 1` is not merely unsupported, it is wrong: the bundle stating
#: `517.7` angstrom (measured below) is self-consistent and 2.0 ulp apart, and at 1 this
#: importer would report it as disagreeing. Nor is that an exotic magnitude — dozens of
#: five-decimal pixel sizes in [0.15, 0.30] um reach 2.0 ulp the same way, including
#: `0.21313` and `0.21338`, immediately either side of Xenium's real `0.2125`.
#:
#: The first version of this constant was unpinned across seven orders of magnitude; the
#: second was pinned to the interval [1, 2] and said so; this one is pinned to a point. The
#: sweep that closed it had to be rebuilt twice — once for measuring a float division the
#: vendor never makes, once for a quantity list that never reached the bound it was meant to
#: find. Both were found by blind audit, not by review of the comment. (An earlier draft summed a fifth term for
#: "the measure itself" and got 2.5, hence 4. That term does not belong: `_within_our_own_
#: rounding` compares the two RAW values and never touches the relative-difference measure.)
#:
#: MEASURED across every unit in `_OME_LENGTH_UM`, over quantities restated by EXACT DECIMAL
#: SCALING — the literal a vendor writes, not `float64(x) / float64(factor)`, which is a
#: division the vendor never performs. Worst observed distance **2.0 ulp**, attained by an
#: ordinary four-digit pixel size restated in a power-of-ten unit: `0.05177 um` written as
#: `517.7` angstrom converts to `0.05177000000000001`. The documented `0.2125 um` ->
#: `0.00002125 cm` sits one step below at 1.0 ulp.
#:
#: THE BOUND IS ATTAINED THROUGH ONE FACTOR ONLY, which is worth knowing before editing the
#: table above: of the eight distinct factors, only `1e-4` (the angstrom aliases) has an
#: envelope above 2, so only an angstrom restatement can measure 2.0. Every other factor caps
#: below it. If the angstrom aliases were ever dropped, the measured bound would legitimately
#: fall to 1.0 and this constant should become 1 — the test would go red, and its message
#: says so rather than sending the maintainer to widen a quantity list that cannot help.
#:
#: TWO EARLIER DRAFTS OF THIS FIGURE WERE WRONG and are corrected rather than repeated: "1.18
#: ulp" was the RELATIVE difference divided by 2^-53 (half-eps steps at magnitude 1.0, not
#: ulps at 0.2125), and "1.0 ulp" came from a sweep whose hand-picked quantities never
#: reached the bound.
#:
#: IT SEPARATES CLEANLY from anything a vendor could write. The nearest real difference is a
#: re-export through 32-bit float, which moves 0.2125 to 0.21250000596046448 — 2.1e8 ulp,
#: eight orders of magnitude above this floor. So it cannot swallow a real disagreement.
#:
#: WHY IT IS NEEDED. Without it, exact `!=` on a CONVERTED value calls a perfectly
#: self-consistent bundle written in centimetres "NOT the same number" over a difference this
#: importer created — the false accusation `_OME_LENGTH_UM`'s own comment exists to prevent,
#: re-created one step later.
#:
#: WHAT IT DOES NOT DO: it decides no artifact's fate. `agreement` is a label on a figure that
#: is reported in full either way, and no value of it withholds the image.
#:
#: KNOWN LIMIT (leniency), stated rather than discovered — see the PRECONDITION above for
#: the same range's opposite failure, where the floor is instead far too strict:
#: in the SUBNORMAL range `math.ulp` degenerates
#: and 2 ulp is a large RELATIVE tolerance. Both `emit_image` and `ome_physical_size` admit a
#: denormal (they require only finite and positive), so a bundle stating `5e-324` against
#: `1.5e-323` — 2.0 ulp apart, but 67% apart relatively — reads as `identical`. No Xenium
#: pixel size is within 300 orders of magnitude of that, and the figure is reported either
#: way, so this is named rather than guarded. (The example was `2e-323` while the constant
#: was 4; at 2 that pair is 3.0 ulp and reads as `differs`. A worked example has to be
#: recomputed when the value it works through changes — it was not, and a blind round caught
#: it. Recorded because a stale example is a false claim with arithmetic attached.)
_STATED_SCALE_ULP_STEPS = (
    ("experiment.xenium literal -> float64", 0.5),
    ("OME-XML literal -> float64", 0.5),
    ("_OME_LENGTH_UM factor -> float64", 0.5),
    ("value * factor", 0.5),
)
_CONVERSION_ULPS = 2


def _within_our_own_rounding(a, b):
    """True when `a` and `b` differ by no more than this importer's own float64 error.

    Compared in ULPs rather than as a relative epsilon because that is what the enumeration
    above actually bounds: a count of rounding steps, not a fraction of the value.
    """
    return abs(a - b) <= _CONVERSION_ULPS * math.ulp(max(abs(a), abs(b)))


def stated_scale_agreement(pixel_size, ome_x, ome_y):
    """MEASURE the vendor's two statements of one number and report them (DEC-15, revised #269).

    This is the record #176 could not have: Visium states its scale exactly once, so
    "internally consistent" and "correct" are the same sentence there. Here they are not.

    0.4.0 REFUSED above a hard-coded `1e-6`, so a bundle whose two statements disagreed lost
    its image entirely. The magnitude was invented and the refusal was the wrong response to
    it — the block comment at `_APPLIED_SCALE_SOURCE` carries the eight-bundle measurement
    that settled both halves. What this returns instead is FACTS, in the shape `emit_image`
    writes straight into the artifact `meta` and into the report:

      experiment_pixel_size_um   the run manifest's statement            (always)
      ome_physical_size_x_um     the image's own statement, per axis     (when readable)
      ome_physical_size_y_um
      relative_difference_x      |a-b| / max(|a|,|b|), per COMPARABLE    (when comparable)
      relative_difference_y      axis — measured, never thresholded
      applied_pixel_size_um      WHICH number placed the image, and
      applied_source             where that number came from             (always)
      agreement                  identical | differs |                   (always)
                                 single-source | unreadable-unit

    FOUR outcomes, not two, and the distinction is load-bearing. `single-source` and
    `unreadable-unit` both LOSE the cross-check and lose it for different reasons — one image
    never stated a second scale, the other stated one in a unit this importer cannot convert.
    `identical` and `differs` are the two ways it RAN. Folding any pair together would make a
    check that silently stopped running look exactly like a check that was never available,
    which is the shape this whole referent exists to avoid.

    `relative_difference_*` is ABSENT for an axis that could not be compared, never `0.0`: a
    zero for an axis nothing was compared against is a fabricated agreement.

    `unreadable_unit_axes` names any axis that DID state a size in a unit this importer
    cannot convert, even when the OTHER axis compared fine. Without it the mixed case folded
    into `identical`/`differs` and the unreadable axis left no trace at all — which is the
    fold the paragraph above forbids, one level down.

    Returns `(stated_scales, warning_or_None)`. It decides nothing about whether the image is
    emitted — that is the point — and it raises nothing ABOUT THE DATA. The single exception
    is a `ValueError` for a `pixel_size` that is not a scale at all, which is a caller
    contract violation rather than something the bundle said, and which `emit_image` refuses
    upstream.
    """
    stated_scales = {"experiment_pixel_size_um": pixel_size,
                     "applied_pixel_size_um": pixel_size,
                     "applied_source": _APPLIED_SCALE_SOURCE}
    # A NON-POSITIVE OR NON-FINITE `pixel_size` IS NOT A SCALE. It is a CALLER CONTRACT
    # violation, not a state of the data, so it is REFUSED rather than labelled — `emit_image`
    # already rejects it upstream, so nothing in production reaches this.
    #
    # Two earlier spellings both invented a verdict instead, and each was caught by a blind
    # audit: `(... / denominator) if denominator else 0.0` answered `agreement: "identical"`
    # with a 0.0 difference (a fabricated agreement), and skipping the axis answered
    # `single-source` for an image that HAD stated a second scale while silently dropping
    # `ome_physical_size_*_um`. There is no honest label for "the caller passed a non-scale",
    # because it is not something the bundle said.
    if not (math.isfinite(pixel_size) and pixel_size > 0):
        raise ValueError(
            f"pixel_size={pixel_size!r} is not a scale, so there is nothing for the image's "
            "own stated size to agree or disagree with. `emit_image` refuses this before it "
            "gets here; a direct caller must too, rather than be handed a verdict about a "
            "comparison that could not happen."
        )
    comparable = []
    unreadable_axes = []
    for axis, raw in (("x", ome_x), ("y", ome_y)):
        if raw is _UNREADABLE_UNIT:
            # PER AXIS, not only when BOTH are unreadable. An image can state X in um and Y
            # in a unit this importer cannot convert; folding that into the other axis's
            # verdict would make an axis whose check STOPPED RUNNING indistinguishable from
            # one that never had a second statement.
            unreadable_axes.append(axis)
            continue
        stated = readable(raw)
        if stated is None:
            continue
        stated_scales[f"ome_physical_size_{axis}_um"] = stated
        # THE MEASUREMENT, not a verdict. Symmetric in its two arguments because neither
        # statement is the reference — that is the whole reason a second one is worth reading.
        # The denominator is positive by construction: the `ValueError` guard above and
        # `ome_physical_size`'s own refusal of a non-positive size are what make it so, which
        # is why there is no fallback here.
        difference = abs(stated - pixel_size) / max(abs(stated), abs(pixel_size))
        stated_scales[f"relative_difference_{axis}"] = difference
        comparable.append((axis.upper(), stated, difference))
    if unreadable_axes:
        stated_scales["unreadable_unit_axes"] = unreadable_axes

    if not comparable:
        stated_scales["agreement"] = (
            "unreadable-unit" if unreadable_axes else "single-source"
        )
        return stated_scales, None

    differing = [entry for entry in comparable
                 if not _within_our_own_rounding(entry[1], pixel_size)]
    if not differing:
        stated_scales["agreement"] = "identical"
        return stated_scales, None

    stated_scales["agreement"] = "differs"
    detail = ", ".join(
        f"PhysicalSize{axis}={stated!r} um (relative difference {difference:.3e})"
        for axis, stated, difference in differing
    )
    warning = (
        f"the bundle states this image's pixel size TWICE and the two are NOT the same "
        f"number: `{EXPERIMENT_BASENAME}` says pixel_size={pixel_size!r} um while the "
        f"image's own OME-XML says {detail}. They describe the same physical thing, so at "
        f"most one of them is right — but WHICH is not decidable from the bundle, and this "
        f"importer does not guess. The image IS emitted, placed on "
        f"`{_APPLIED_SCALE_SOURCE}` and recorded as `applied_source` alongside both raw "
        "numbers, so nothing is picked silently. AND THE CONTROL THAT DECIDES IT IS NOW "
        "BUILT, AND RAN ON THIS BUNDLE: design §7.5 makes the registration QC overlay "
        "(cells drawn on the tissue, judged by a human) the verification story for image "
        "placement; #156 built that overlay for the Visium importer only, and #301 built "
        "this producer's. It scores BOTH placements — the one applied above and the one "
        "the other statement implies — against the signal this image's own pixels carry, "
        "and reports them side by side in "
        "`registration_qc.images[].stated_scale_placements`, in the rendered overlay's own "
        "burned-in caption, and in the verdict on this run's `report/qc` overlay artifact. "
        "Read that before deciding which statement to believe: it is the only thing here "
        "with a referent outside the bundle. Also available: the two numbers above, their "
        "measured difference, and the untouched source image in the retained bundle. A "
        "difference at the 1e-8 level is usually a re-export through a 32-bit float; a "
        "difference of a percent or more is usually a real units or version mix-up, and is "
        "worth taking back to the bundle's producer."
    )
    return stated_scales, warning


def within_bundle(root, rel):
    """The bundle-relative path `rel` resolves to, or `None` when it escapes.

    `experiment.xenium` is VENDOR-SUPPLIED DATA that names files this importer then opens.
    That makes it an input steering a filesystem read, and it is confined the way any such
    input must be: resolved, then required to be under the bundle root.

    Two escapes, both real and both proven by a blind audit against this code:

    * `../../elsewhere/scan.ome.tif` — read, downsampled and EMITTED as the dataset's own
      `spatial/image`, with `meta.source` and the report recording the escaping path and
      claiming it was "preserved in the uploaded bundle";
    * `/etc/passwd` — `Path(root) / "/etc/passwd"` is `/etc/passwd`, because pathlib
      discards the left operand when the right is absolute. The refusal message then echoed
      the decoder's error, which embeds the file's leading bytes, making it a probing
      oracle as well.

    `os.path.realpath` rather than `Path.resolve(strict=True)` so a name that does not exist
    still resolves (the caller reports "no such file" separately, which is a better message
    than "escapes the bundle" for a simple typo), and so a symlink pointing out of the
    bundle is caught rather than followed.
    """
    root_real = os.path.realpath(str(root))
    candidate = os.path.realpath(os.path.join(root_real, rel))
    if candidate == root_real:
        return None
    if not candidate.startswith(root_real + os.sep):
        return None
    return Path(candidate)


def coverage_note(basename, meta, bounds):
    """The GEOMETRIC leg of the referent — a note, not a refusal.

    The cell centroids are in microns and the image is in pixels, so the centroids must lie
    inside `extent_px * pixel_size`. A legitimately cropped vendor image exists and refusing
    it would be worse than reporting it — but silence would be worst of all, since this is
    what a misregistration looks like from the outside. It is no longer the ONLY symptom
    available: #301 built §7.5's overlay for this producer, so this note now names a control
    a reader can actually open rather than an absent one (#291 was the disclosure that it
    was absent). The two are different measurements and the note says which is which —
    containment is arithmetic on extents, the overlay is a picture with an external
    referent.

    Note the direction, stated so it is not over-read: containment bounds the scale from
    BELOW only. A pixel size too LARGE makes the image cover more than the cells, which this
    cannot see.
    """
    if bounds is None:
        return None
    covered_w = meta["extent"]["width"] * meta["to_space"][0]
    covered_h = meta["extent"]["height"] * meta["to_space"][4]
    max_x, max_y = bounds
    if covered_w >= max_x and covered_h >= max_y:
        return None
    return (
        f"{basename}: emitted, but it covers only {covered_w:.1f} x {covered_h:.1f} um "
        f"while the cells extend to {max_x:.1f} x {max_y:.1f} um. The image and the "
        "positions may not describe the same capture area, or the stated pixel size may be "
        "too small. READ THE REGISTRATION OVERLAY BEFORE READING ANYTHING OFF THIS IMAGE: "
        "design §7.5 makes that overlay the control that settles a placement question, and "
        "this run emits one as a `report/qc` artifact (#301) — it draws every cell centre on "
        "this image at the DECLARED transform and scores how far above chance the cells land "
        "on the signal the image's own pixels carry. This note is arithmetic on extents and "
        "cannot decide a registration; that overlay can. Compare both against the untouched "
        "source in the retained bundle."
    )


# ─────────────────────────────── the image ───────────────────────────────


#: THE PHRASES THAT ASSERT AN IMAGE WAS EMITTED — see `import_visium.EMISSION_ASSERTING_PHRASES`
#: for why this is a constant rather than a literal in a test. Every note containing one is
#: buffered until the commit point, where it becomes true.
EMISSION_ASSERTING_PHRASES = ("emitted,", "is emitted", "written to disk")


def emit_image(members, experiment, outputs_dir, *, space_id, coverage_bounds=None):
    """Convert the vendor's declared morphology image to a `spatial/image`.

    Returns `(entries, skipped, warnings)` — the same three channels the Visium importer
    uses, so a reader of either report finds the same shapes.

    ## The image is located from the vendor's OWN manifest (DEC-9)

    `experiment.xenium` names its images (`images.morphology_focus_filepath`,
    `images.morphology_filepath`), so this follows the pointer instead of a basename table.
    Visium needed a table because a Space Ranger bundle has no manifest; using one here
    would break on the very XOA versions that renamed the file.

    ## The affine maps PIXELS INTO A MICROMETRE SPACE

    That is the divergence, and it is one substitution, not new arithmetic. Visium's image
    affine is the inverse of a unitless vendor scalefactor; Xenium's "scalefactor" is
    `1 / pixel_size` (pixels per micron), so `ome_writer.emitted_affine(1/pixel_size,
    factor)` yields `[pixel_size*factor, 0, 0, 0, pixel_size*factor, 0]` — the size of one
    EMITTED pixel, in the space's own unit. Because the space IS micrometres,
    `to_space[0]` is the image's micron pitch directly, with no second number to keep in
    step; `SD.require_micron_scale` answers `1.0` and `_reconcile_scale`'s leg 3 reduces to
    `to_space[0] == applied_resolution_um`.

    ## ONE guard around the WHOLE body

    Same reasoning as the Visium importer's: the raises are spread across a dozen calls and
    a per-call `except` will always miss the next one. Losing the image must never cost the
    matrix, the coordinates and the columns.
    """
    entries, skipped, warnings = [], [], []
    images = experiment.get("images")
    images = images if isinstance(images, dict) else {}
    # `morphology_focus` FIRST: it is the vendor's own extended-depth-of-field projection,
    # i.e. their answer to "which plane" — which is why preferring it makes the `ZYX`
    # middle-plane rule a rarely-taken fallback rather than the normal path.
    candidates = [
        (images.get("morphology_focus_filepath"), "morphology_focus"),
        (images.get("morphology_filepath"), "morphology"),
    ]
    chosen = None
    candidates_found = []
    for rel, kind in candidates:
        if not isinstance(rel, str) or not rel.strip():
            if rel is not None:
                skipped.append(
                    f"`{EXPERIMENT_BASENAME}`'s `images.{kind}_filepath` is {rel!r}, which "
                    "is not a path. Nothing was emitted from it."
                )
            continue
        rel = rel.strip()
        path = within_bundle(members["root"], rel)
        if path is None:
            # THE VENDOR FILE STEERS A FILESYSTEM READ, so it is CONFINED. Not a
            # hypothetical: a blind audit pointed `morphology_focus_filepath` two levels
            # above the bundle and this importer opened, downsampled and EMITTED a foreign
            # image as the dataset's `spatial/image` — with `meta.source` and the report
            # both recording the escaping path and claiming it was "preserved in the
            # uploaded bundle". An ABSOLUTE path is worse still: `Path(root) / "/etc/passwd"`
            # discards the root entirely, by pathlib's own semantics.
            skipped.append(
                f"{rel}: `{EXPERIMENT_BASENAME}` names an image OUTSIDE this bundle. A path "
                "in the run manifest addresses a file inside the uploaded bundle and "
                "nothing else; an absolute path or one escaping through `..` is refused "
                "rather than followed. Nothing was emitted from it."
            )
            continue
        if path.is_file():
            candidates_found.append((path, rel, kind))
            break
        skipped.append(
            f"{rel}: `{EXPERIMENT_BASENAME}` names this image but no such file is "
            "in the bundle. Nothing was emitted from it; re-upload with the image "
            "directory intact."
        )
    if not candidates_found:
        if not any(isinstance(rel, str) and rel.strip() for rel, _ in candidates):
            skipped.append(
                f"this bundle's `{EXPERIMENT_BASENAME}` names no morphology image, so no "
                "`spatial/image` was emitted. The coordinates and the matrix are "
                "unaffected — an image is optional, a position is not."
            )
        return entries, skipped, warnings

    # THE FIRST CANDIDATE THAT EXISTS IS THE ONE EMITTED — a KNOWN LIMITATION, recorded
    # rather than fixed here (LEDGER round 3). A blind audit showed the fallback is reachable
    # by ABSENCE but not by DAMAGE: zeroing `morphology_focus` on a real bundle yields no
    # image at all while a readable `morphology.ome.tif` sits beside it, untried. The fix is
    # a retry loop, and it was implemented and then REVERTED: it required splitting a
    # 215-line function that three audit rounds had gone over, and it broke four tests in the
    # image path at the very end of the branch. Trading a proven-good path for an
    # unproven-better one under time pressure is how a working feature ships broken. The
    # cost of the limitation is bounded — one image, on a bundle that is already damaged, on
    # a run that already reports the failure by name — and it is handed to a follow-up with
    # the reproduction in the ledger.
    path, rel_name, kind = candidates_found[0]
    basename = path.name
    # WARNINGS ARE BUFFERED UNTIL THE COMMIT POINT, for the same reason `entries` is. The
    # two-source scale notes below are appended BEFORE `write_ome_tiff` runs and one of them
    # says "The image is emitted using `experiment.xenium`'s pixel_size alone" — so when the
    # write then failed, the report asserted in one channel that the image WAS emitted and in
    # the other that it was NOT. Measured on this branch by injecting a `MemoryError` into the
    # contiguous copy; it became reachable because this branch converts failures that used to
    # abort the import instead of producing a report at all.
    pending_warnings = []
    try:
        pixel_size = experiment.get("pixel_size")
        if not (isinstance(pixel_size, (int, float)) and not isinstance(pixel_size, bool)
                and math.isfinite(pixel_size) and pixel_size > 0):
            skipped.append(
                f"{basename}: `{EXPERIMENT_BASENAME}` declares no usable `pixel_size`, so "
                "this image's pixels have no known physical size and it cannot be placed "
                "in a micrometre coordinate space. An identity affine would claim one "
                "pixel is one micrometre, which is wrong by about 5x on every Xenium run "
                "and would silently misregister every cell drawn on it."
            )
            return entries, skipped, warnings
        pixel_size = float(pixel_size)

        plane, selection = xenium_image.read_plane(path)

        # THE EXTERNAL REFERENT, leg 1+2 — MEASURED before anything is written, and after the
        # file is open because the second statement lives inside it. It no longer decides
        # whether the image is emitted (#269): it records what the two statements are, how
        # far apart they are, and which one placed the image.
        try:
            # THE ONLY UNWRAPPED THIRD-PARTY CALL LEFT IN THIS GUARDED BODY, until #298 E1.
            # `xenium_image.read_plane` wraps the identical calls; this SECOND open did not,
            # and `tifffile.TiffFileError` subclasses `Exception` directly — its `__mro__` is
            # `(TiffFileError, Exception, BaseException, object)` — so it was in no guard and
            # cost the matrix, the coordinates, the columns and the report. Reachable by
            # TOCTOU: the file is opened by `read_plane` above and RE-OPENED here, so a
            # truncation in between surfaced as `TiffFileError`, not `OSError`. The deferred
            # `import` moves inside for the same reason (E2).
            import tifffile

            with tifffile.TiffFile(str(path)) as handle:
                ome_x, ome_y = ome_physical_size(handle.ome_metadata or "")
        except (ome_writer.ImageConversionError, SD.SpatialDeclarationError):
            # BOTH refusal taxonomies pass through — see `xenium_image.read_plane` for the
            # argument. This arm was left with only one while its siblings got both.
            raise
        except Exception as exc:
            # A bug in THIS file PROPAGATES, unchanged — the discriminator is the raising
            # site, not the exception type. See `ome_writer.image_failure_is_a_bug`.
            if ome_writer.image_failure_is_a_bug(exc, __file__):
                raise
            raise ome_writer.ImageConversionError(
                f"this image's own OME metadata could not be re-read for the two-source "
                f"scale cross-check ({type(exc).__name__}: {exc}). The file was readable a "
                "moment earlier, so it was most likely truncated or replaced mid-import."
            ) from exc
        stated_scales, disagreement = stated_scale_agreement(pixel_size, ome_x, ome_y)
        if disagreement is not None:
            pending_warnings.append(f"{basename}: {disagreement}")
        # NOT `elif agreement == "unreadable-unit"`. That verdict is reached only when NO axis
        # was comparable; the case it missed is one axis unreadable and the other COMPARABLE —
        # an image stating X in um and Y in a unit this importer cannot convert kept an
        # `identical`/`differs` verdict from X and lost half its cross-check in silence. The
        # check STOPPED RUNNING on that axis and nothing said so, which is the one thing
        # `stated_scales` exists to prevent. (An earlier draft of this comment said the old
        # spelling "fired only when BOTH axes were unreadable", which is false: one unreadable
        # axis and one ABSENT axis also reaches it.)
        if stated_scales.get("unreadable_unit_axes"):
            axes = ", ".join(a.upper() for a in stated_scales["unreadable_unit_axes"])
            both = len(stated_scales["unreadable_unit_axes"]) == 2
            pending_warnings.append(
                f"{basename}: this image DOES state a physical pixel size on "
                f"{'both axes' if both else f'axis {axes}'}, in a unit this importer cannot "
                f"convert, so the two-source scale cross-check could not run "
                f"{'at all' if both else f'on {axes}'}. The image is emitted using "
                "`experiment.xenium`'s pixel_size alone — which is the position every "
                "Visium image is in, and is weaker than the check this bundle was capable "
                "of supporting. What did NOT stop running is §7.5's registration QC "
                "overlay (#301): it scores the applied placement against this image's own "
                "pixels whatever unit the OME-XML states, so the placement IS checked even "
                "though the two-statement cross-check is not. Read this run's `report/qc` "
                "overlay artifact."
            )

        source_extent = ome_writer.extent_of(plane)
        factor, applied_um, _emitted = ome_writer.downsample_plan(
            pixel_size, SD.DEFAULT_RESOLUTION_CAP_UM, source_extent
        )
        derivative = SD.display_derivative_provenance(
            original_resolution_um=pixel_size,
            # The SOURCE grid, captured BEFORE the resample — the only recorded fact
            # anchored to a pixel count, and unrecoverable afterwards.
            original_extent=source_extent,
            # WHERE THE ORIGINAL IS PRESERVED. Not re-emitted: it stays in the retained
            # `spatial/xenium-bundle` upload. The bundle-relative path, not the bare
            # basename, because a Xenium image can live in a subdirectory whose siblings
            # share a stem.
            original_source=rel_name,
            codec=ome_writer.CODEC,
            tifffile_version=ome_writer.tifffile_version(),
            resolution_cap_um=SD.DEFAULT_RESOLUTION_CAP_UM,
        )
        if factor > 1:
            plane = ome_writer.downsample(plane, factor)

        space = SD.coordinate_space(
            space=space_id,
            # MICROMETRES — the coordinates' own unit, so image and cells share one frame
            # (INV-5). `microns_per_pixel` is deliberately ABSENT: `coordinate_space`
            # REFUSES it here ("the coordinates are already in microns. Stating a scale for
            # a space that has none invites a consumer to apply it twice"), and
            # `require_micron_scale` answers 1.0 by definition.
            unit="micrometre",
            to_space=ome_writer.emitted_affine(1.0 / pixel_size, factor),
            # AFTER the resample — `plane` was reassigned above when `factor > 1`, and this
            # must be the emitted grid, never the source's.
            extent=ome_writer.extent_of(plane),
        )
        meta = SD.image_meta(space=space, derivative=derivative, role="display",
                             source=rel_name)
        # WHICH plane these pixels are, declared rather than left to be inferred (DEC-10).
        meta["plane_selection"] = selection
        # The referent's own record, so a reader can see that the check RAN and what it
        # compared — a check whose result is invisible is indistinguishable from no check.
        meta["stated_scales"] = stated_scales
        meta["image_kind"] = kind

        note = coverage_note(basename, meta, coverage_bounds)

        rel = "spatial-image-morphology.ome.tif"
        ome_writer.write_ome_tiff(
            outputs_dir / rel, plane, placement=meta,
            # THE EMITTED image's own pixel pitch -> OME `PhysicalSizeX/Y`, whose semantics
            # are exactly that. `write_ome_tiff` refuses if it disagrees with the recorded
            # `applied_resolution_um` or with the affine.
            image_microns_per_pixel=applied_um,
        )
    except (ome_writer.ImageConversionError, SD.SpatialDeclarationError, OSError) as exc:
        skipped.append(f"{basename}: not emitted — {type(exc).__name__}: {exc}")
        return entries, skipped, warnings

    # ── THE COMMIT POINT, deliberately OUTSIDE the guard ─────────────────────────
    # The bytes are on disk; from here the image IS emitted. Nothing below may raise into
    # the handler above, because that handler appends to `skipped` — and an exception here
    # would put the SAME image on disk, in `entries` AND in `images_not_emitted` at once.
    #
    # The buffered warnings are flushed HERE for the same reason: each of them asserts the
    # image was emitted, and that only becomes true at this line.
    warnings.extend(pending_warnings)
    entries.append(output_entry(
        "spatial-image-morphology", DT_SPATIAL_IMAGE, rel, "artifact",
        structure=cyto_columns.opaque(IMAGE_MEDIA_TYPE),
        meta=meta,
        label="Morphology image (display)",
    ))
    if factor > 1:
        dropped_w = derivative["original_extent"]["width"] % factor
        dropped_h = derivative["original_extent"]["height"] % factor
        parts = ([f"{dropped_w} column(s)"] if dropped_w else []) + \
                ([f"{dropped_h} row(s)"] if dropped_h else [])
        dropped = (
            f" The last {' and '.join(parts)} of the source did not fill a whole block and "
            "were dropped rather than padded, because padding would invent a measurement."
            if parts else ""
        )
        warnings.append(
            f"{rel_name}: emitted as a DISPLAY DERIVATIVE — downsampled {factor}x by box "
            f"mean, from {derivative['original_resolution_um']:g} to "
            f"{derivative['applied_resolution_um']:g} um/pixel (the "
            f"{derivative['resolution_cap_um']:g} um/pixel display cap), "
            f"{derivative['original_extent']['width']}x"
            f"{derivative['original_extent']['height']} -> "
            f"{derivative['emitted_extent']['width']}x"
            f"{derivative['emitted_extent']['height']} pixels. Compression is lossless and "
            "every emitted pixel is the mean of a real block of real measurements, but "
            "these are not the pixels this importer was given: its SOURCE is preserved in "
            f"the uploaded bundle as `{rel_name}`." + dropped
        )
    if selection.get("rule") not in (None, "single-plane"):
        warnings.append(
            f"{rel_name}: this image is a {selection['axes']} stack of "
            f"{selection.get('of')} planes and ONE was emitted — "
            f"{selection.get('axis')} index {selection.get('index')}"
            + (f" ({selection['channel_name']})" if selection.get("channel_name") else "")
            + f", by the `{selection['rule']}` rule. The other planes are real measurements "
            "that are not in this artifact; they remain in the uploaded bundle."
        )
    # #271, and it is the half the issue's TITLE is about ("and it reaches the HTML report").
    # Removing the parenthetical stain is necessary and NOT sufficient: a name that silently
    # vanishes leaves a reader unable to tell "this importer declines to say" from "this image
    # has no channel", and the artifact's `channel_name_rule` is a note only a MACHINE reads —
    # which the boundaries-note comment in `render_report_html` states is not enough ("a note
    # only a machine reads does not meet it"). So the refusal is SAID, with its evidence.
    if selection.get("channel_name_rule") == "unverified-channel":
        declared = selection.get("declared_channels") or []
        warnings.append(
            f"{rel_name}: NO STAIN IS DECLARED for the emitted plane. Its OME-XML names "
            f"{len(declared)} channel(s) ({', '.join(declared)}), and this importer could not "
            "VERIFY which of them — if any — belongs to the plane that was emitted. Naming one "
            "anyway would be a stain this "
            "importer did not verify, so the plane is emitted with its shape, its index and "
            "its selection rule, and with no channel name."
        )
    if note:
        warnings.append(note)
    return entries, skipped, warnings


def _overlay_row_prose(registration, image_id):
    """The overlay artifact's catalog row — WHAT the picture shows, for THIS run.

    Conditional rather than a literal, because a blind design-conformance angle caught the
    literal claiming more than the run delivered. `cell_area` is absent on an XOA version that
    does not write the column, and the radius then falls back to a minimum visible mark — so
    "each at its own vendor-measured area" was false exactly when the machine-readable half
    of the same block recorded `cell_diameter_image_px.median: None`. Same for the two
    disagreeing statements: a bundle that made only ONE statement has no choice to disclose.
    """
    block = next((image for image in (registration.get("images") or [])
                  if image.get("image_id") == image_id), {})
    sized = (block.get("cell_diameter_image_px") or {}).get("median") is not None
    competing = (block.get("placed_by") or {}).get("competing_statement")
    overlay = block.get("overlay") or {}
    parts = [
        "every cell centre drawn on the morphology image at the DECLARED transform",
        ("each at its own vendor-measured area" if sized else
         "each at a minimum visible mark — this bundle's `cells.csv.gz` carries no "
         "`cell_area`, so there is no declared per-cell size to draw at"),
    ]
    if overlay.get("marks_subsampled"):
        parts.append(
            f"{overlay['marks_drawn']} of {overlay['marks_considered']} cells drawn, by a "
            "declared deterministic stride — at this density every cell would cover the "
            "morphology the reader is being asked to look at. The SCORE uses every cell"
        )
    parts.append(
        ("with a caption naming which of the bundle's two pixel-size statements placed the "
         "image, and what the other one would have scored" if competing else
         "with a caption naming the statement that placed the image")
    )
    return (
        "; ".join(parts)
        + ". Design §7.5 makes this the verification story for image placement: a human sees "
          "a misregistration in it instantly and sees nothing else about it."
    )


def render_registration_qc(qc, overlays):
    """The #301 block: a verdict banner, the rendered overlays, and the numbers behind them.

    ## Why this is FIRST on the page

    Design §7.2 puts the QC where *"a human must be able to see and confirm the
    registration"*. An overlay below a table of provenance strings is an overlay nobody
    scrolls to, so this renders ABOVE the facts table — the same position the sibling
    importer's `render_registration_qc` takes, for the same stated reason.

    ## What the caption in the picture and the caption under it are for

    The picture carries its own burned-in caption naming which of the bundle's two pixel-size
    statements placed the image (DEC-5), so the provenance survives the picture being copied
    out of this page. This block repeats it in text for a reader who is on the page, and adds
    the numbers a caption has no room for.
    """
    def esc(v):
        return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    verdict = str(qc.get("verdict", "not-evaluated"))
    tone = {"pass": "#1a7f37", "fail": "#b3261e"}.get(verdict, "#8a6d00")
    rows = []
    for image in qc.get("images", []):
        placed = image.get("placed_by") or {}
        lift = image.get("signal_lift")
        rows.append(
            "<tr><th align='left'>"
            + esc(image.get("source") or image.get("image_id"))
            + f"</th><td><b>{esc(image.get('verdict', '?'))}</b> — "
            + esc(image.get("reason", ""))
            + "<br><small>signal lift "
            + (f"{lift:.3f}" if isinstance(lift, float) else "n/a")
            + f" against a {RQC.SIGNAL_LIFT_FLOOR:g} floor; placed by "
            + esc(placed.get("source"))
            + " = " + esc(placed.get("pixel_size_um")) + " um/pixel (the bundle's two "
            + "statements: " + esc(placed.get("agreement")) + ")"
            + "".join(
                "; " + esc(alt.get("source")) + " would score "
                + (f"{alt['signal_lift']:.3f}" if isinstance(alt.get("signal_lift"), float)
                   else "n/a")
                for alt in (image.get("stated_scale_placements") or [])
                if not alt.get("applied")
            )
            + "</small></td></tr>"
        )
        if image.get("overlay_omitted"):
            rows.append("<tr><th align='left'>overlay</th><td>"
                        + esc(image["overlay_omitted"]) + "</td></tr>")
    figures = "".join(
        f"<figure style='margin:0 0 12px'><figcaption style='font:12px/1.4 system-ui'>"
        f"registration overlay — {esc(image_id)}</figcaption>"
        f"<img alt='registration overlay for {esc(image_id)}' src='{uri}' "
        "style='max-width:100%;height:auto;border:1px solid #ccc'></figure>"
        for image_id, uri in sorted(overlays.items())
    )
    return (
        "<h3>Registration QC (design &sect;7.5)</h3>"
        f"<p style='font:14px/1.5 system-ui;color:{tone}'><b>{esc(verdict)}</b> — the cell "
        "centres placed on the morphology image at the DECLARED transform, scored against the "
        "signal the image&rsquo;s own pixels carry. This is the only check in this importer "
        "with a referent outside the artifact.</p>"
        + (f"<table style='font:13px/1.5 system-ui,sans-serif'>{''.join(rows)}</table>"
           if rows else "")
        + (figures or "<p><em>no overlay was rendered; see the verdicts above for why.</em>"
                      "</p>")
    )


def render_report_html(report, overlays=None):
    """A self-contained `report/html` — the run summary a human reads.

    Same shape as the Visium importer's: the #301 registration banner and its overlays, then
    a table of facts, then the structured JSON in a script tag so the inspector view reads the
    numbers rather than the prose. No vendor diagnostics are inlined: Xenium's
    `analysis_summary.html` is 5-6 MB on a real bundle and inlining it would blow the report
    past anything a viewer wants to open. It stays in the retained upload.

    `overlays` maps an image id to the rendered PNG BYTES. They are turned into `data:` URIs
    here rather than by the caller, so the one place that decides how a picture is embedded is
    the one place that decides how the page is built.
    """
    def esc(v):
        return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    rows = []
    for key, value in (
        ("Coordinate space", report["coordinate_space"]),
        ("Space id source", report["coordinate_space_source"]),
        # #270. The value and its derivation, as a PAIR and in the same shape as the two rows
        # above — a human reading this page can tell a vendor-stated sample name from an id
        # this importer had to fall back to, which is precisely what the emitted declaration
        # alone could not tell them before.
        ("Sample id", report["section"]["sample_id"]),
        ("Sample id source", report["section"]["sample_id_source"]),
        ("Cells", report["n_cells"]),
        ("Genes (Gene Expression)", report["n_genes"]),
        ("Entity", report["measured_entity_label"]),
        ("Coordinate unit", report["unit"]),
        ("Segmentation", report["measured_entity"]["segmentation"]["method"]),
        ("XOA version", report["provenance"].get("pipeline", "not recorded")),
        ("Panel", report["provenance"].get("panel", "not recorded")),
        ("Chemistry", report["provenance"].get("chemistry", "not recorded")),
        ("Pixel size (um)", report.get("pixel_size_um", "not declared")),
    ):
        rows.append(f"<tr><th align='left'>{esc(key)}</th><td>{esc(value)}</td></tr>")
    classes = "".join(
        f"<li>{esc(name)}: {esc(info['n_features'])} features — {esc(info['disposition'])}"
        + (f" ({esc(info['reason'])})" if info.get("reason") else "")
        + "</li>"
        for name, info in sorted(report["feature_classes"].items())
    )
    # THE BOUNDARIES NOTE BELONGS HERE TOO. It reached the JSON payload and nothing else, so
    # the human-readable summary a user actually opens said nothing at all when a boundaries
    # file was present and refused — while the analogous image notes DID get a section. The
    # block's own justification is that "a silently missing artifact is indistinguishable
    # from a broken importer"; a note only a machine reads does not meet it.
    boundary_notes = []
    boundaries = report.get("boundaries") if isinstance(report.get("boundaries"), dict) else {}
    if boundaries.get("reason"):
        boundary_notes.append(boundaries["reason"])
    coverage = boundaries.get("coverage") if isinstance(boundaries.get("coverage"), dict) else {}
    # SURFACED FROM THE FACTS, NOT FROM A VERDICT (#247). The producer used to fold the
    # extents into a `consistent` boolean — part of it a hard-coded 5x scale band this
    # importer invented — and this block rendered that derived heuristic to the user as
    # though it were a declared property. `coverage_against` now reports only what the
    # artifact supports, so the two conditions worth a human's attention are read here,
    # directly: the extents do not overlap at all, or the centroids are not inside the
    # polygon extent (design §7.3's failure mode, in the two forms a box intersection alone
    # misses). Nothing here rules on a ratio — and the correction #301 makes to this comment
    # is that something downstream now DOES rule on placement: the judgement belongs to §7.5's
    # registration overlay, #156 built one for `spatial-import-visium` and #301 built this
    # producer's, so a reader of this section is no longer looking at the whole of what Xenium
    # boundary placement is checked by. The Registration QC section at the top of this page is
    # the other half, and `boundaries.py::coverage_against`'s note points at it.
    #
    # THE TWO ARE DIFFERENT MEASUREMENTS AND THIS BLOCK STILL SHOWS ONLY ITS OWN. Containment
    # is arithmetic on extents and rules on nothing; the overlay is a picture with an external
    # referent. What the overlay does NOT cover for boundaries specifically is the polygons'
    # own SHAPE — it draws each cell as a disc of its vendor-measured area, not as its outline
    # — so a boundary set correctly scaled and wrongly shaped is still judged by the two facts
    # below and by nothing else. Saying otherwise here would be the same
    # reassurance-with-nothing-behind-it #269 removed from `scale_referent`, one sign flipped.
    #
    # THE PREDICATE IS THE PRODUCER'S, not a second copy written here: `coverage_against`
    # picks the note by a precedence and `coverage_is_reportable` answers, from that same
    # precedence, whether the note describes something a reader should see. The first cut
    # re-derived the condition in this file, and the two disagreed — a wholly disjoint pair
    # on a partial bundle carried the partial note ("not a defect") and this block showed it.
    #
    # The partial count is passed rather than defaulted: `.get` yields None when the report
    # carries no count, and `coverage_is_reportable` treats unknown as "not complete" (§15.3
    # — a reader must not infer a declared state from a null), so a missing count cannot turn
    # a legitimate partial set's containment failure into a reported defect.
    if BD.coverage_is_reportable(
            coverage,
            entities_without_boundary=boundaries.get("n_entities_without_boundary")):
        # `.get`, because the line's own guard below is defeated by a KeyError above it.
        # (The bare access is pre-existing; a coverage dict from a stored report that carries
        # the facts and no note lost the WHOLE summary, not just this section.)
        #
        # AND THE NOTE GATES THE MEASUREMENT. Without that, a stored coverage with the facts
        # and no note rendered the ratios under the boundaries heading with no warning beside
        # them — the §7.3 failure dropped and its number displayed, which is worse than
        # rendering nothing. A measurement is shown only with the statement it belongs to.
        if coverage.get("note"):
            boundary_notes.append(coverage["note"])
        # AND THE MEASUREMENT ITSELF, because the note now says a reader can judge the ratio
        # and until this line the ratio existed only inside the embedded JSON payload. A
        # human reading the visible summary could not see the number the note points at.
        # NAMED AXES, not positions. The list is [x, y] with `None` for an axis whose
        # centroid extent is a point, and a positional rendering of it showed a lone y ratio
        # where a reader reads x. `isinstance` because this dict can arrive from a stored
        # report rather than from `coverage_against`, and a malformed field must not crash
        # the summary.
            ratios = coverage.get("extent_ratios")
            ratios = list(ratios) if isinstance(ratios, (list, tuple)) else []
            # EXACTLY TWO, or nothing. A list of another length cannot be attributed to
            # axes: an artifact written before the undefined slot existed carries `[<the y
            # ratio>]` for a degenerate x axis, and labelling that `x` would turn the old
            # renderer's ambiguity into a false statement. A measurement whose axis is
            # unknown is not shown.
            if len(ratios) == 2 and any(r is not None for r in ratios):
                boundary_notes.append(
                    "measured extents — polygon extent / centroid extent: "
                    + ", ".join(f"{axis} " + ("undefined" if r is None else f"{r}x")
                                for axis, r in zip(("x", "y"), ratios))
                )
    # ITS OWN SECTION, not appended to the Images list. A boundaries refusal rendered under
    # an `<h3>Images</h3>` heading is a note filed under the wrong subject, which barely
    # clears the bar the block was added to meet.
    boundaries_html = (
        "<h3>Segmentation boundaries</h3><ul>"
        + "".join(f"<li>{esc(n)}</li>" for n in boundary_notes)
        + "</ul>"
    ) if boundary_notes else ""
    # THE PLACEMENT DISCLOSURE REACHES THE PAGE, UNCONDITIONALLY (#291).
    #
    # `placement_judgement` was first emitted into the report JSON only — and this block's own
    # justification is that "a note only a machine reads does not meet it". A blind angle put
    # the two together: on a WELL-PLACED bundle `coverage_is_reportable` is False, so the
    # section above renders nothing, and the disclosure that §7.5's human control does not
    # exist reached no human at all. That is the same defect the block was written to fix,
    # one artifact along.
    #
    # ITS OWN HEADING, and not appended to `boundary_notes`. Two reasons, both load-bearing:
    # the "Segmentation boundaries" section is about THIS BUNDLE's polygons and a reader must
    # not read a standing fact about the IMPORTER as a finding about their data; and #247's
    # acceptance test asserts that a correctly placed pair renders no such section at all, so
    # folding an unconditional line into it would delete that guard rather than satisfy it.
    #
    # #301 CHANGED WHAT THIS SECTION SAYS, NOT WHETHER IT RENDERS. It was written to disclose
    # that §7.5's control did not exist here; it now states that it does, what it measures and
    # what it still does not settle. Retiring the section instead would leave a reader who had
    # met it before with no record that the position changed — and a placement fact a reader
    # is entitled to is a placement fact whichever direction it points.
    #
    # Rendered only when boundaries were emitted, because that is when there is a placement
    # to disclose about. `.get` throughout: a STORED report written before this key existed
    # must render the rest of the page rather than raise.
    judgement = (boundaries.get("placement_judgement")
                 if isinstance(boundaries.get("placement_judgement"), dict) else {})
    placement_html = ""
    if judgement:
        placement_html = (
            "<h3>What checks this import's placement</h3><ul>"
            + "".join(
                f"<li>{esc(label)}: {esc(judgement[key])}</li>"
                for label, key in (("the control design §7.5 requires", "what"),
                                   ("built for", "built_for"),
                                   ("in this import", "status"),
                                   ("judged here by", "judged_by_here"),
                                   ("what that costs", "consequence"),
                                   ("tracked as", "tracked_as"))
                if isinstance(judgement.get(key), str) and judgement[key]
            )
            + "</ul>"
        )
    notes = "".join(f"<li>{esc(n)}</li>" for n in
                    report["images_not_emitted"] + report["image_warnings"])
    # `</script>` inside ANY vendor string (a panel name, a run name, an image path echoed
    # into a warning) would terminate the block early: the structured payload the inspector
    # reads is truncated to invalid JSON and the remainder becomes live markup. The visible
    # table rows go through `esc()`; this is the one place that does not, so `<` is escaped
    # at the JSON level, which is valid JSON and inert as markup. (The sibling Visium
    # importer has the same line and the same gap; reported rather than edited from here.)
    embedded = json.dumps(report).replace("<", "\\u003c")
    # #301. The QC banner and the overlay go ABOVE the facts table (design §7.2: a human must
    # be able to SEE and confirm the registration). `.get`, because a STORED report written
    # before this key existed must render the rest of the page rather than raise.
    qc = report.get("registration_qc")
    banner = render_registration_qc(
        qc,
        {image_id: RQC.data_uri(png) for image_id, png in (overlays or {}).items()},
    ) if isinstance(qc, dict) and qc else ""
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Xenium import summary</title></head><body>"
        "<h2>Xenium import summary</h2>"
        + banner
        + "<table style='font:14px/1.5 system-ui,sans-serif'>" + "".join(rows) + "</table>"
        "<h3>Feature classes</h3><ul>" + classes + "</ul>"
        "<h3>Images</h3>" + (f"<ul>{notes}</ul>" if notes
                             else "<p><em>no notes.</em></p>")
        + boundaries_html
        + placement_html
        + f"<script type='application/json' id='xenium-import-summary'>{embedded}</script>"
        "</body></html>"
    )


# ─────────────────────────────── the import ───────────────────────────────


def run_import(bundle_root, outputs_dir):
    """The whole import. Returns the manifest `entries` list.

    Factored out of `main` so the end-to-end test can drive the REAL code over a REAL
    bundle and read the artifacts back, rather than testing a re-implementation of it.
    """
    import h5py
    import pandas as pd

    outputs_dir = Path(outputs_dir)
    members = locate_members(bundle_root)
    progress("read", 5, "reading the Xenium onboard-analysis bundle")
    experiment = read_experiment(members["experiment"])

    entries = []
    try:
        handle = h5py.File(members["matrix"], "r")
    except OSError as exc:
        # The sibling read paths both wrap their open in a named refusal; this one did not,
        # so a truncated or zero-byte `.h5` — the most ordinary upload damage there is —
        # exited 1 with an h5py traceback about `stored_eof` and no hint what to do.
        raise XeniumImportError(
            f"`{MATRIX_BASENAME}` could not be opened as an HDF5 file "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). It is usually truncated or empty — re-upload "
            "the complete Onboard Analysis output."
        ) from None
    with handle as h5:
        if "matrix" not in h5:
            raise XeniumImportError(
                f"{MATRIX_BASENAME} has no `/matrix` group — this is not a 10x "
                f"feature-barcode matrix. Found top-level members "
                f"{_quoted_list_for_refusal(sorted(h5.keys()), noun='member name')}."
            )
        # `"matrix" in h5` is True for a DANGLING EXTERNAL LINK — the name exists in the
        # group's namespace — and `h5["matrix"]` then raises `KeyError` when the link is
        # resolved. MEASURED on this box: a `/matrix` that is an `h5py.ExternalLink` to a
        # missing file passes the presence test above and `h5["matrix"]` raises
        # `KeyError: "Unable to synchronously open object (can't open file)"`. This is #452's
        # exact class at the FIRST dereference of this function, so it is guarded the same way
        # the shape read is: refused BY NAME, never a bare traceback.
        try:
            group = h5["matrix"]
        except (KeyError, OSError, TypeError) as exc:
            raise XeniumImportError(
                f"{MATRIX_BASENAME}'s `/matrix` group cannot be read "
                f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
                f"{_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
                "stores its data under `/matrix`; a member that cannot be read is not a matrix "
                "this importer can carry."
            ) from None
        # EVERY MEMBER READ BELOW, CHECKED UP FRONT. The `/matrix` guard above names its
        # absence; the five datasets read after it did not, so deleting any one of them
        # produced a bare `KeyError: "Unable to synchronously open object ..."` and a
        # traceback — `main()` catches only `XeniumImportError`.
        required = ("shape", "barcodes", "features/id", "features/name",
                    "features/feature_type")
        absent = [name for name in required if name not in group]
        if absent:
            raise XeniumImportError(
                f"{MATRIX_BASENAME}'s `/matrix` group is missing "
                f"{_quoted_list_for_refusal(absent, noun='member name')}. A 10x "
                "feature-barcode matrix carries all of "
                f"{list(required)}; re-export the bundle."
            )
        attrs = dict(h5.attrs)
        # THE SECOND PARSE BOUNDARY, guarded by the SAME predicate (#329). `h5py` decodes a
        # UTF-8-typed string attribute with `surrogateescape`, so a root attribute holding bytes
        # that are not valid UTF-8 comes back as lone surrogates in `U+DC80..U+DCFF` — the same
        # unwritable `str` `experiment.xenium` can smuggle in through a `\udXXX` escape, arriving
        # by a different door. It is not hypothetical: MEASURED on a copy of the real prime bundle
        # with `library_ids = b"\xff\xfeBAD"`, the import COMPLETED and shipped
        # `provenance.matrix_library_id = "\udcff\udcfeBAD"` into `xenium-import-report.json`,
        # which `serde_json` — the crate the server parses that file with — then refuses. #323
        # closed the sibling on `/matrix/barcodes` (a cell id is a join key and cannot be decoded
        # loosely); the root ATTRIBUTES were the half it did not cover, and leaving them is the
        # "same rule applied to one field fewer" defect that branch found three times in its own
        # work. Like the first boundary, this is before every write.
        refuse_unencodable_vendor_text(
            attrs,
            source=f"`{MATRIX_BASENAME}`'s root attributes",
            remedy="Re-export the complete Onboard Analysis output.",
        )
        # `/matrix/shape` is READ and COERCED here, and both can fail on a hostile bundle. The
        # `required` presence check above proves the name EXISTS; it never checks the dtype. A
        # fixed-length `S` or vlen string dataset makes `int(b"...")` raise `ValueError`, a float
        # dataset carrying `NaN` makes `int(nan)` raise `ValueError`, a 2-D dataset makes
        # `int([1, 2])` raise `TypeError`, a scalar dataset makes the `[:]` read itself raise
        # `ValueError` ("Illegal slicing argument for scalar dataspace"), and a GROUP of that name
        # makes it raise `TypeError` ("Accessing a group is done with bytes or str, not <class
        # 'slice'>") -- all MEASURED on this branch. None is an `XeniumImportError`, so each
        # escaped `main()`'s `except` as a raw traceback at exit 1. The arity guard below was
        # written for the one-element case and never measured the dtype case; this guard is the
        # dtype case, and it fires before the first writer like every other refusal here.
        try:
            shape_ds = group["shape"]
        except (KeyError, OSError, TypeError) as exc:
            raise XeniumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/shape` cannot be read "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
                "stores `/matrix/shape` as a one-dimensional dataset of two integers; a member "
                "that cannot be read is not a matrix this importer can carry."
            ) from None
        # A shape dataset holds exactly TWO integers, and the arity guard below enforces that
        # AFTER the read. The read itself is the hazard: `shape_ds[:]` materialises EVERY element
        # of the dataset and `.tolist()` boxes each one, so a 1-D int dataset of 100 million
        # elements is an 800 MB read plus ~2.8 GB of boxed Python ints -- the exact OOM-SIGKILL
        # shape #456 exists to prevent, one field over. The arity guard cannot protect against
        # that because it runs after the full read and materialisation. So the SAME arity
        # requirement -- a shape dataset holds two integers -- is enforced HERE, before `[:]` is
        # evaluated, from the dataset's DECLARED metadata (`shape_ds.nbytes` and `shape_ds.size`
        # read no data). The bound is not a new policy: it is the existing "two integers"
        # invariant, applied to the declared size instead of the materialised list. The binding
        # quantity is BYTES, because the read's cost is `size x itemsize`: an element cap alone
        # does not bound the work, since a 2-element dataset of `S1073741824` is a 2 GiB read
        # that passes ANY element cap. So [`_MAX_SHAPE_BYTES`] = 4096 is checked first -- ~256x
        # the 16 bytes a legitimate two-int64 shape occupies -- and [`_MAX_SHAPE_ELEMENTS`] =
        # 1024 alongside it as a second, independent check on the element COUNT for these
        # fixed-width dtypes (an element cap cannot bound a byte exposure whose per-element
        # size is attacker-chosen, and vlen/object never reaches this check: the dtype gate
        # below refuses it before the read). Both are far beyond the two elements a shape
        # dataset can hold, so no small wrong-arity dataset can collide with this refusal --
        # those still flow to the arity guard below and produce its byte-identical message --
        # yet both are small enough that reading a dataset under them is a genuinely bounded,
        # genuinely cheap operation for the fixed-width dtypes that reach this point, since
        # vlen/object (and compound-with-vlen) are refused by the dtype gate before the read.
        # `shape_ds.size` is the product of every dimension, so a multi-dimensional dataset is
        # caught by the same check, not only a long 1-D one.
        #
        # The vlen/object gate below is a THIRD refusal, and it fires BEFORE both size checks,
        # for a different reason: `Dataset.nbytes` is `dtype.itemsize * size`, and for a vlen
        # dtype `itemsize` is 8 -- the size of a POINTER, not the payload -- so a two-element
        # vlen shape dataset reports `nbytes == 16` and passes ANY byte cap while `[:]` still
        # materialises the attacker-chosen payloads. The element cap does not save it either:
        # the per-element size is attacker-chosen, so the true ceiling is `1024 x
        # attacker-chosen` -- no ceiling. The gate is on the DTYPE, not the size, and it reads
        # no data. A vlen/object shape dtype is not "too large", it is "not two integers", so
        # its message says that rather than quoting a byte count.
        if isinstance(shape_ds, h5py.Dataset) and _dtype_is_vlen_or_object(shape_ds.dtype):
            raise XeniumImportError(
                f"{MATRIX_BASENAME} declares `/matrix/shape` as "
                f"{_quoted_for_refusal(shape_ds.dtype, noun='dtype')} "
                f"({_quoted_for_refusal(shape_ds.shape, noun='shape')}), which is not the two "
                "integers (features, cells) a 10x feature-barcode matrix stores there. A shape "
                "dataset holds two integers; a variable-length or object dtype cannot be read "
                "as them without doing the work this importer refuses to do. Re-export the "
                "complete Onboard Analysis output."
            ) from None
        if isinstance(shape_ds, h5py.Dataset) and (
            shape_ds.nbytes > _MAX_SHAPE_BYTES or shape_ds.size > _MAX_SHAPE_ELEMENTS
        ):
            raise XeniumImportError(
                f"{MATRIX_BASENAME} declares `/matrix/shape` as a dataset of "
                f"{int(shape_ds.size)} elements / {int(shape_ds.nbytes)} bytes "
                f"({_quoted_for_refusal(shape_ds.shape, noun='shape')}), which is not the two "
                "integers (features, cells) a 10x feature-barcode matrix stores there. A shape "
                "dataset holds two integers; one this large cannot be read without doing the "
                "work this importer refuses to do. Re-export the complete Onboard Analysis "
                "output."
            ) from None
        try:
            shape = [int(x) for x in np.asarray(shape_ds[:]).tolist()]
        except MemoryError:
            # A MEMORY failure is not a file defect: the bundle may be perfectly good and the
            # worker under-provisioned, so blaming the file would tell an operator to re-export a
            # good bundle when the remedy is to raise the memory limit — and a retryable resource
            # failure would be permanently classified as vendor fault. `MemoryError`'s `str()` is
            # typically empty, so the message does not quote one. This handler is BEST EFFORT,
            # not a guarantee: under default Linux overcommit the realistic outcome of a huge
            # read is a SIGKILL, which no `except` catches, and the handler itself allocates.
            raise XeniumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/shape` could not be read in the memory available "
                "to this import. This is not a defect in the file — the bundle may be fine and "
                "the worker under-provisioned — so re-exporting it will not help; raise the "
                "memory limit and retry."
            ) from None
        except (ValueError, TypeError, OSError, KeyError, OverflowError) as exc:
            found = (
                f"{_quoted_for_refusal(shape_ds.dtype, noun='dtype')} "
                f"{_quoted_for_refusal(shape_ds.shape, noun='shape')}"
                if isinstance(shape_ds, h5py.Dataset)
                else _quoted_for_refusal(type(shape_ds).__name__, noun='type name')
            )
            raise XeniumImportError(
                f"{MATRIX_BASENAME} declares `/matrix/shape` as {found}, which cannot be read "
                "as the two integers (features, cells) a 10x feature-barcode matrix stores "
                f"there ({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
                f"{_quoted_for_refusal(exc, noun='message')})."
            ) from None
        if len(shape) != 2:
            # Exactly the bare-`IndexError` class the truncated-row guard was written for,
            # one file over: `shape[1]` on a one-element dataset is a traceback, not a
            # refusal.
            raise XeniumImportError(
                f"{MATRIX_BASENAME} declares `/matrix/shape` = "
                f"{_quoted_list_for_refusal(shape, noun='dimension')}, which is not a "
                "(features, cells) pair. This is not a 10x feature-barcode matrix."
            )
        n_features, n_cells = shape[0], shape[1]
        # `group["features"]` is evaluated HERE, outside `_decoded_strings`'s `try`. Whether a
        # dangling `features` link can reach it was MEASURED on this box: with `features` an
        # `h5py.ExternalLink` to a missing file, `"features" in group` is True but
        # `"features/id" in group` is FALSE — the presence sweep above refuses cleanly before
        # this line, so the dereference is never reached for a dangling link. Recorded so the
        # next reader does not re-derive it.
        cell_ids = _decoded_strings(group, "barcodes")
        feature_ids = _decoded_strings(group["features"], "id", "/matrix/features/id")
        feature_names = _decoded_strings(group["features"], "name", "/matrix/features/name")
        feature_types = _decoded_strings(group["features"], "feature_type",
                                         "/matrix/features/feature_type")
        if n_cells == 0:
            # A ZERO-CELL IMPORT USED TO SUCCEED, emitting every artifact at length 0 and a
            # `spatial/image` placed against no cells at all — and `coverage_bounds` then
            # became `None`, so the GEOMETRIC leg of the scale referent silently stopped
            # running with nothing recording that it had. That is the exact failure
            # `stated_scales.agreement`'s four-state design exists to prevent, one field
            # over: a check that stopped running must never look like one that was never
            # available.
            raise XeniumImportError(
                f"{MATRIX_BASENAME} declares ZERO cells. There is nothing to import, and "
                "an empty dataset would still carry a coordinate space, an image and a "
                "full set of empty artifacts — which reads as a successful import of a "
                "sample with no cells rather than as a bundle that did not arrive."
            )
        if len(cell_ids) != n_cells or len(feature_ids) != n_features:
            raise XeniumImportError(
                f"{MATRIX_BASENAME} declares shape "
                f"{_quoted_list_for_refusal(shape, noun='dimension')} but carries "
                f"{len(feature_ids)} features and {len(cell_ids)} cells."
            )

        # 10x stores the matrix CSC over (features x cells): `indptr` has one entry per
        # CELL and `indices` holds FEATURE ids. Read column-per-cell with row-per-feature
        # is, term for term, CSR over (cells x features) — exactly the `cells x genes`
        # row-major source the writer's streaming transpose wants. Declared from the file's
        # own shape DATASET rather than sniffed: `source_for_h5` reads the shape from an
        # ATTRIBUTE (the h5ad spelling) and 10x writes it as a dataset, so the generic
        # sniffer cannot read this file. Identical to the Visium path — this part of 10x's
        # format did not change between platforms.
        source = cyto_csc.H5CsrSource(group, shape=(n_cells, n_features))

        # ── THE FEATURE CLASSES (DEC-11) ────────────────────────────────────────────
        # SPLIT, never drop. The house rule is `multimodal.split_by_feature_types`' — "EVERY
        # distinct value becomes its own modality; NONE collapsed into RNA, NONE discarded"
        # — executed the way `h5ad_import.py` executes it. Xenium's matrix carries SIX
        # classes on a real bundle (Gene Expression plus five control/codeword classes, plus
        # Protein Expression on an XOA 4 protein run); a Visium filtered matrix carries one.
        # A single undifferentiated store would put Negative Control Codewords into every
        # normalisation and every user's gene list.
        by_class = {}
        for index, ftype in enumerate(feature_types):
            by_class.setdefault(ftype, []).append(index)
        if GENE_EXPRESSION not in by_class:
            raise XeniumImportError(
                f"{MATRIX_BASENAME} declares no {GENE_EXPRESSION!r} features (classes "
                f"found: {_quoted_list_for_refusal(sorted(by_class), noun='feature type')}). "
                "There is no expression matrix to import."
            )

        feature_classes = {}
        for ftype in sorted(by_class):
            if ftype == GENE_EXPRESSION:
                continue
            entry_reason = (
                "Xenium protein is a "
                f"{_text(attrs.get('protein_metric')) or 'MEAN_PER_CELL_STAIN'} metric "
                f"scaled by protein_scaling_factor="
                f"{_text(attrs.get('protein_scaling_factor')) or 'unstated'}, not integer "
                "UMI counts. Emitting it unscaled would fabricate counts; emitting it "
                "scaled would still put a mean-intensity metric into a kind that means "
                "counts, and every total-UMI figure computed from it would be meaningless. "
                "It stays in the retained bundle until a protein-aware kind exists."
                if ftype == PROTEIN_EXPRESSION else CONTROL_CLASSES_ARE_NOT_EXPRESSION
            )
            feature_classes[ftype] = {
                "n_features": len(by_class[ftype]),
                "disposition": "dropped from the expression matrix",
                "reason": entry_reason,
            }
            if ftype == PROTEIN_EXPRESSION:
                # §15.5's OWN NUMBER, as a structured field rather than only inside the
                # prose above. The design says the factor "must be divided out"; this
                # importer does not emit the class at all, so the one fact that would make
                # the withheld values interpretable must survive somewhere a consumer can
                # DISPATCH on — a sentence is not that. Recorded verbatim from the h5 root
                # attributes, dropped when the vendor states neither (absence is absence).
                scaling = _finite(attrs.get("protein_scaling_factor"))
                if scaling is not None:
                    feature_classes[ftype]["protein_scaling_factor"] = scaling
                metric = _text(attrs.get("protein_metric"))
                if metric:
                    feature_classes[ftype]["protein_metric"] = metric
                feature_classes[ftype]["recoverable_from"] = MATRIX_BASENAME
            else:
                # ASSIGNED ONLY WHEN KNOWN. A future XOA control class not in the table
                # would otherwise get `"per_cell_column": null` — a forwarding address that
                # goes nowhere, and the same "written as unknown rather than dropped" shape
                # `vendor_provenance` and `report["pixel_size_um"]` both refuse. The class
                # is still named, with its reason; only the pointer is absent.
                column = _CONTROL_CLASS_COLUMNS.get(ftype)
                if column:
                    feature_classes[ftype]["per_cell_column"] = column

        # ONE store, ONE feature class. `columns=` selects and re-indexes without a second
        # read of the matrix (`cyto_csc.write_csc_zarr`'s own contract), so the controls cost
        # nothing to skip.
        gene_columns = by_class[GENE_EXPRESSION]
        counts_structure = cyto_csc.write_csc_zarr(
            source, outputs_dir / "expression.zarr", columns=gene_columns,
            axes=("cells", "genes"),
        )
        feature_classes[GENE_EXPRESSION] = {
            "n_features": len(gene_columns), "disposition": "emitted as the counts matrix",
        }
        progress("matrix", 20, f"{n_cells} cells x {len(gene_columns)} genes")

    provenance = vendor_provenance(experiment, attrs)

    # ── the cells table, JOINED to the matrix's cell order ───────────────────────────
    # `cells.csv.gz` and the matrix agree on order in both real bundles — and this JOINS
    # anyway. A positional zip that happens to be right is a coincidence one vendor release
    # away from putting every cell's transcripts at another cell's position, which is not an
    # error but a picture of the tissue with the values shuffled.
    progress("positions", 40, "joining cell centroids to the matrix cell ids")
    header, rows = read_cells_csv(members["cells"])
    col_of = {name: i for i, name in enumerate(header)}
    by_id = {}
    id_index = col_of[CELL_ID_COLUMN]
    # THE WIDEST COLUMN THIS IMPORTER ACTUALLY READS, not just the id's. Guarding on
    # `id_index` alone was near-vacuous: `cell_id` is column 0 in every real bundle, so only
    # a completely EMPTY line could trip it, and a short-but-nonempty row fell through to be
    # reported by `column()` as "x_centroid holds a value that is not a float (list index
    # out of range)" — safe, but not the refusal this guard promises and not a message that
    # names the real problem.
    widest = max([id_index]
                 + [col_of[name] for name, _ in VENDOR_CELL_COLUMNS if name in col_of]
                 + [col_of[name] for name in (X_COLUMN, Y_COLUMN, SEGMENTATION_COLUMN)
                    if name in col_of])
    for i, row in enumerate(rows):
        if len(row) <= widest:
            # A short or blank line would otherwise raise a bare `IndexError`, which
            # `main()` does not catch — the job would die with a traceback instead of this
            # package's own named refusal, which is what every other read path here does.
            raise XeniumImportError(
                f"`{CELLS_BASENAME}` line {int(i + 2)} has {len(row)} field(s), but this "
                f"importer reads up to column {int(widest + 1)} of it. A truncated cells table "
                "cannot be joined to the matrix, and guessing which cell a short row "
                "belongs to would be a guess about where a cell is."
            )
        cid = row[id_index]
        if cid in by_id:
            raise XeniumImportError(
                f"`{CELLS_BASENAME}` lists cell "
                f"{_quoted_for_refusal(cid, noun='cell id')} more than once; a cell has one "
                "position and choosing between two would be a guess."
            )
        by_id[cid] = i
    missing = [c for c in cell_ids if c not in by_id]
    if missing:
        raise XeniumImportError(
            f"{len(missing)} of the matrix's {int(n_cells)} cells have no row in "
            f"`{CELLS_BASENAME}` (first: "
            f"{_quoted_list_for_refusal(missing[:3], noun='barcode')}). Absence is absence: a cell with no "
            "position cannot be given one, and writing a placeholder coordinate would put "
            "those cells somewhere real-looking on the tissue."
        )
    order = [by_id[c] for c in cell_ids]

    def column(name, cast):
        if name not in col_of:
            return None
        index = col_of[name]
        try:
            return [cast(rows[i][index]) for i in order]
        except (TypeError, ValueError, IndexError) as exc:
            raise XeniumImportError(
                f"`{CELLS_BASENAME}` column "
                f"{_quoted_for_refusal(name, noun='column name')} holds a value that is not a "
                f"{_quoted_for_refusal(cast.__name__, noun='type name')} "
                f"({_quoted_for_refusal(exc, noun='message')})."
            ) from None

    # NO TRANSPOSE, and that is the divergence worth naming. Visium's CSV writes
    # `pxl_row_*` (y) BEFORE `pxl_col_*` (x) and the importer must transpose — §7.3 rule 5
    # calls it "the single most likely bug in the whole importer". Xenium's `cells.csv.gz`
    # is already (x, y): `x_centroid` precedes `y_centroid`, and both are read BY NAME
    # rather than by position, so the trap is closed by construction rather than by care.
    xs = np.asarray(column(X_COLUMN, float), dtype=np.float32)
    ys = np.asarray(column(Y_COLUMN, float), dtype=np.float32)
    # A NON-FINITE CENTROID IS REFUSED. `float()` parses `"nan"`, `"Infinity"` and `"1e300"`
    # (which overflows float32 to inf) perfectly happily, and all three imported clean: the
    # values reached `spatial/coordinates.zarr`, and the only symptom anywhere was a
    # coverage note reading "the cells extend to nan x 392.2 um" — which blames the IMAGE
    # and sends the user to the registration overlay for a defect in the cells table.
    # `_finite` already exists in this file for exactly this class of value; it was applied
    # to every number EXCEPT the positions.
    for name, values in ((X_COLUMN, xs), (Y_COLUMN, ys)):
        bad = int(np.count_nonzero(~np.isfinite(values)))
        if bad:
            first = int(np.flatnonzero(~np.isfinite(values))[0])
            raise XeniumImportError(
                f"`{CELLS_BASENAME}` column "
                f"{_quoted_for_refusal(name, noun='column name')} holds {bad} non-finite value(s) "
                f"(first at matrix row {first}, cell "
                f"{_quoted_for_refusal(cell_ids[first], noun='barcode')}). A position that "
                "is NaN or infinite is not a position, and it does not error downstream — "
                "it silently makes every extent, neighbourhood and distance computed from "
                "this dataset meaningless. Absence is absence: re-export the cells table."
            )
    coords = np.ascontiguousarray(np.stack([xs, ys], axis=1), dtype=np.float32)

    # ── the coordinate frame's identity (#323) ──────────────────────────────────────
    # HERE rather than beside `provenance` above, and the move is the whole of a blind
    # design-conformance finding: the derived rung digests the run's MEASUREMENT — the vendor's own
    # cell ids AND the centroids joined to them — so it cannot be computed before the join. Digesting
    # the ids alone let two genuinely different measurements whose matrices carried generically
    # numbered ids (`"1"`..`"23"`, and nothing validates the vendor's id format) share one frame.
    #
    # `cell_ids`/`coords` rather than the bundle root: a run's coordinate identity must not be a
    # function of where it happened to be MOUNTED. Both are already in hand — the ids decoded from
    # `/matrix/barcodes` and length-checked against `/matrix/shape`, the coordinates just built and
    # already refused for non-finiteness — so this costs no extra read of anything.
    space_id, space_id_source = coordinate_space_id(experiment, cell_ids, coords)

    segmentation_methods = column(SEGMENTATION_COLUMN, str) or []
    entity = SD.measured_entity(
        # A Xenium row IS a segmented cell — §6.1: "A Visium spot barcode *is* a barcode; a
        # Xenium segmented cell *is* a cell." Unlike Visium's `spot`, this kind REQUIRES a
        # segmentation block, and rightly: two runs differing only in expansion distance
        # have equal row counts and differ in every cell.
        kind="cell", platform="xenium",
        segmentation=segmentation_declaration(set(segmentation_methods), experiment),
    )

    cells_keys = pd.Series([str(c) for c in cell_ids])
    aligned_to = {"cells": cyto_columns.axis_key_digest(cells_keys)}
    membership_of = {
        "cells": {"aligned_to": aligned_to["cells"],
                  "derived_from": cyto_columns.axis_key_sequence(cells_keys),
                  "members": None}
    }

    # The genes axis is the GENE-EXPRESSION class's own key sequence, not the whole file's:
    # the emitted matrix's columns are a subset, so a digest over every feature would be
    # wrong for the one artifact that exists.
    gene_ids = pd.Series([str(feature_ids[i]) for i in gene_columns])
    genes_aligned_to = cyto_columns.axis_key_digest(gene_ids)
    entries.append(output_entry(
        "expression", DT_COUNTS, "expression.zarr", "artifact",
        structure=counts_structure,
        # `measured_entity` rides HERE TOO, not only on the coordinates: §15.1's motivating
        # case is a set of sibling MATRICES that differ only in what one row is, and this is
        # the artifact every existing analysis actually consumes.
        meta={"kind": "counts", "n_cells": n_cells, "n_genes": len(gene_columns),
              "platform": "xenium", "provenance": provenance,
              "feature_type": GENE_EXPRESSION,
              "feature_classes": {k: v["n_features"] for k, v in feature_classes.items()},
              "measured_entity": entity,
              "measured_entity_label": SD.measured_entity_label(entity),
              "aligned_to": aligned_to["cells"],
              "genes_key_sequence_digest": genes_aligned_to},
    ))
    feature_classes[GENE_EXPRESSION]["output_id"] = "expression"
    feature_classes[GENE_EXPRESSION]["genes_key_sequence_digest"] = genes_aligned_to

    # ── the axis key artifacts ───────────────────────────────────────────────────────
    # A column whose VALUES ARE the axis's entity keys, marked `is_axis_index`. The digest
    # SELF-CHECK is not ceremony: an `aligned_to` stamped on every other artifact and a key
    # artifact whose stored bytes digest to something else would make every alignment on
    # this dataset silently wrong, with the conformance gate failing rows one by one and
    # nothing saying why.
    aligned_to["genes"] = genes_aligned_to
    membership_of["genes"] = {"aligned_to": genes_aligned_to,
                              "derived_from": cyto_columns.axis_key_sequence(gene_ids),
                              "members": None}
    for axis, name, keys in (("cells", "cell_id", cells_keys),
                             ("genes", "gene_id", gene_ids)):
        structure, meta = cyto_columns.write_metadata_column(
            outputs_dir, f"axis/{name}.zarr", name, keys, axis=axis,
            holds_axis_keys=True,
        )
        if structure.get("key_sequence_digest") != aligned_to[axis]:
            raise XeniumImportError(
                f"the {axis} key artifact digests to "
                f"{_quoted_for_refusal(structure.get('key_sequence_digest'), noun='digest')} "
                f"but every artifact on this axis was stamped "
                f"{_quoted_for_refusal(aligned_to[axis], noun='digest')}. Refusing rather than "
                "emitting a dataset "
                "whose alignment is wrong in a way nothing downstream can see."
            )
        meta["is_axis_index"] = True
        entries.append(output_entry(
            f"metadata-column:{name}", DT_METADATA_COLUMN, f"axis/{name}.zarr", "artifact",
            label=name, axis=axis, structure=structure, meta=meta,
        ))

    # The gene SYMBOL and the vendor's own feature CLASS, on the genes axis. `feature_type`
    # is emitted because it is the only per-feature record of which class a gene came from
    # once the stores are split, and INV-7 of `anndata-import` requires the raw string to
    # survive rather than be reconstructed from an artifact id.
    for name, values in (
        ("gene_symbol", [str(feature_names[i]) for i in gene_columns]),
        ("feature_type", [str(feature_types[i]) for i in gene_columns]),
    ):
        structure, meta = cyto_columns.write_metadata_column(
            outputs_dir, f"axis/{name}.zarr", name, pd.Series(values), axis="genes",
            aligned_to=genes_aligned_to, membership=membership_of["genes"],
        )
        entries.append(output_entry(
            f"metadata-column:{name}", DT_METADATA_COLUMN, f"axis/{name}.zarr", "artifact",
            label=name, axis="genes", structure=structure, meta=meta,
        ))

    # ── the coordinate space ─────────────────────────────────────────────────────────
    space = SD.coordinate_space(
        space=space_id,
        # MICROMETRES — the headline divergence. Xenium reports `x_centroid`/`y_centroid`
        # in microns, so there is no pixel frame to declare and no scale to get wrong: the
        # coordinates map into their own space by the IDENTITY affine and the IMAGE declares
        # its own affine into this frame, which is the direction that composes (INV-5).
        #
        # `microns_per_pixel` is deliberately NOT passed. `coordinate_space` REFUSES it for
        # this unit — "Stating a scale for a space that has none invites a consumer to apply
        # it twice" — and `require_micron_scale` answers 1.0 by definition, so a
        # micron-measuring consumer gets a correct answer with nothing invented. The whole
        # class of defect INV-2 guards is structurally absent here rather than merely
        # guarded.
        unit="micrometre",
        to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        # WHICH leg produced the space id. Declared INSIDE the space block — not bolted
        # onto `meta` afterwards — because after #211 this block is what crosses into the
        # sandbox. No `microns_per_pixel_source`: there is no scale to source, and
        # `coordinate_space` REFUSES a provenance for a value it does not carry.
        coordinate_space_source=space_id_source,
    )
    placement = SD.positioning(
        # Every cell in the matrix has a centroid — the join above REFUSED the run otherwise
        # — so this is a measured claim, not an optimistic default.
        partial=False,
    )
    # #270. The value and the record of WHERE IT CAME FROM, together — the shape
    # `coordinate_space_id` uses eight lines up. The `slide_id` and bare-`space_id` legs this
    # replaced were inferences emitted where a sandboxed consumer reads a vendor fact.
    sample_id, sample_id_source = section_sample_id(experiment, space_id)
    series = SD.section(
        sample_id=sample_id,
        # One section per bundle: a Xenium run images one region — `experiment.xenium` states
        # exactly one `region_name` and one `roi_uuid`, so "this bundle carries exactly one
        # section" is READ, not assumed, and 0 is that series' only ordinal. What it is NOT is
        # a claim about a wider series: nothing in one bundle can say where its section sits
        # among a sample's others, and `section()` has no way to express that ignorance (#270
        # question 2 / DEC-3). Recording the ordinal now is free and unrecoverable later; the
        # section->section transform is deliberately NOT designed (serial-section registration
        # is frequently non-linear, so an affine would be worse than nothing).
        index=0,
    )

    # NO `z` (DEC-13 / INV-1). Measured: `cells.csv.gz` carries no z centroid on either real
    # bundle — Xenium reports z per TRANSCRIPT (`transcripts.parquet`'s `z_location`, which
    # is #164's), not per cell. `experiment.xenium.z_step_size` is present (3.0 um) and
    # describes the IMAGE focal-plane spacing; using it to synthesise a cell z would invent
    # a measurement. Absence stays absence.
    coord_structure, coord_meta = SD.write_spatial_coordinates(
        outputs_dir, "spatial/coordinates.zarr", coords,
        axis="cells", space=space, entity=entity, placement=placement, series=series,
        aligned_to=aligned_to["cells"], membership=membership_of["cells"],
    )
    coord_meta.update({
        # `coordinate_space_source` is NOT set here any more: it is declared inside
        # `coordinate_space(...)` above, which merges flat into this same `meta`, so the
        # emitted row is unchanged and the key now also reaches a sandboxed consumer
        # (#211). Everything below is a CATALOG/DISPLAY fact with no analysis consumer.
        "platform": "xenium",
        "provenance": provenance,
        # #183 OPTION A — the two 1-D siblings these positions can also be read as. Declared
        # in `meta` because the filter-VD gather re-mints `structure` and copies `meta`
        # verbatim, so this is the only channel the declaration survives a filter in.
        "component_columns": [COMPONENT_X, COMPONENT_Y],
        # No `microns_per_pixel_source` key: there is no scale to source. Said by the
        # ABSENCE of the key rather than by a "not applicable" string, which is the same
        # discipline `image_meta` uses for `display_derivative`.
        "unit_note": (
            "these coordinates are already micrometres, so the space declares no "
            "`microns_per_pixel` — `require_micron_scale` answers 1.0 by definition."
        ),
    })
    entries.append(output_entry(
        "spatial-coordinates", DT_COORDINATES, "spatial/coordinates.zarr", "artifact",
        label="tissue map", axis="cells",
        structure=coord_structure, meta=coord_meta,
    ))
    progress("coordinates", 60, f"{len(coords)} cell positions")

    # ── the per-cell columns ─────────────────────────────────────────────────────────
    per_cell = []
    # THE VENDOR'S OWN CELL AREAS, kept out of `per_cell` so they survive its deletion before
    # the image phase. `registration_qc.render_overlay` draws each cell at ITS OWN declared
    # physical size (DEC-10), which is what makes a misscale visible to a human eye and not
    # only to the statistic — and this column is already read here, so nothing new is parsed.
    # `None` when this XOA version does not write it: absence stays absence, and the renderer
    # falls back to a minimum visible mark rather than to an invented diameter.
    cell_area_um2 = None
    for name, cast in VENDOR_CELL_COLUMNS:
        values = column(name, cast)
        if values is None:
            # A column this XOA version does not write is ABSENT, not zero-filled.
            continue
        dtype = np.int32 if cast is int else np.float64
        if name == "cell_area":
            cell_area_um2 = np.asarray(values, dtype=np.float64)
        per_cell.append((name, pd.Series(np.asarray(values, dtype=dtype))))
    if segmentation_methods:
        # The per-cell truth DEC-12's run-level `method` string cannot hold. This is the
        # artifact that makes a mixed-segmentation run analysable rather than merely
        # labelled.
        per_cell.append((SEGMENTATION_COLUMN, pd.Series(segmentation_methods)))
    per_cell.extend([
        # A `platform` / `measurement_unit` column so a future scientific-disclosure layer
        # has something to DISPATCH ON (design §9 point 3). This item owes the column; it
        # does not owe the disclosure.
        ("platform", pd.Series(["xenium"] * n_cells)),
        ("measurement_unit", pd.Series([entity["kind"]] * n_cells)),
        # #183 Option A. Ordinary 1-D numeric columns, and nothing about them is special to
        # the gather — which is the entire point: they survive a filter through the path
        # that already works. `float32`, so they are bit-identical to the columns of the
        # 2-D member they mirror.
        (COMPONENT_X, pd.Series(xs)),
        (COMPONENT_Y, pd.Series(ys)),
    ])
    for name, values in per_cell:
        rel = f"metadata/{name}.zarr"
        structure, meta = cyto_columns.write_metadata_column(
            outputs_dir, rel, name, values, axis="cells",
            aligned_to=aligned_to["cells"], membership=membership_of["cells"],
        )
        entries.append(output_entry(
            f"metadata-column:{name}", DT_METADATA_COLUMN, rel, "artifact",
            label=name, axis="cells", structure=structure, meta=meta,
        ))
    progress("columns", 80, f"{len(per_cell)} per-cell columns")

    # ── the segmentation boundaries (#163, design §6.4) ──────────────────────────────
    #
    # HERE, and not after the image, for the same reason the image comes after the
    # coordinates: this needs `cell_ids` and the `aligned_to`/`membership` derived from it,
    # and those are released a few lines below. It also runs BEFORE the memory-heavy image
    # phase, so the vertex table's peak and the morphology plane's peak do not coincide.
    #
    # ISOLATED, and that is the load-bearing part. `cell_boundaries.parquet` is an OPTIONAL
    # side file that is not even a declared member of the bundle container: a bad one must
    # not destroy the counts matrix, the coordinates, the image and the report along with
    # itself. The first cut let every named refusal in `boundaries.py` escape `main()` as a
    # raw traceback and abort the whole run — which also falsified this version's own
    # "additive" changelog line for any bundle carrying a broken file. The shape here is the
    # one `emit_image` already uses: catch, record the reason, carry on.
    #
    # ABSENCE IS ABSENCE, and it has TWO cases, not one. The first cut keyed only on file
    # presence, so a PRESENT but 0-row parquet emitted exactly the artifact its own comment
    # forbade — a `spatial/boundaries` with n=0 plus two all-zero offset columns, i.e. the
    # claim that every cell in the tissue has no shape. Both are handled below and both are
    # named in the report, because a silently missing artifact is indistinguishable from a
    # broken importer.
    boundaries_path = _at_most_one(members["root"], BD.BOUNDARIES_BASENAME)
    boundaries_report = {"emitted": False, "reason": None}
    if boundaries_path is None:
        boundaries_report["reason"] = (
            f"this bundle has no `{BD.BOUNDARIES_BASENAME}`; segmentation boundaries were "
            "not imported. The bundle is retained, so nothing is lost — an older Onboard "
            "Analysis writes them as `cell_boundaries.csv.gz`, which this importer "
            "deliberately does not read (the parquet reader is the dependency this "
            "capability rests on)."
        )
    else:
        progress("boundaries", 84, "reading the segmentation boundaries")
        # THE WHOLE OPTIONAL LEG IS INSIDE THE GUARD, read AND write. The first cut wrapped
        # only `read_boundaries`, leaving `write_boundaries` and both `write_metadata_column`
        # calls outside it — so a failure in the WRITER still aborted the run, and could do
        # so after the store had been written and its entry appended, leaving a half-emitted
        # output set. `emit_image`'s guard covers its whole leg; so does this one now.
        #
        # `Exception` and not just `BoundariesError`: the claim this block makes is that an
        # OPTIONAL side file cannot destroy a complete import, and a `MemoryError` from the
        # concatenate or an unexpected decode error keeps that from being true just as
        # effectively as a named refusal would. The reason string carries the exception type
        # so an unexpected one is visible as unexpected rather than laundered into a
        # vendor-file complaint.
        boundaries_entries = []
        try:
            encoded = BD.read_boundaries(boundaries_path, cells_keys.tolist())
        except BD.BoundariesError as exc:
            # A NAMED skip, not a traceback and not a dead import. The user keeps every other
            # artifact and is told, in this file's own words, what was wrong with the one
            # they lost.
            encoded = None
            boundaries_report["reason"] = (
                f"`{boundaries_path.name}` could not be imported and was skipped; every "
                f"other artifact in this run is unaffected. {exc}"
            )
        except Exception as exc:  # noqa: BLE001 — see the paragraph above
            encoded = None
            boundaries_report["reason"] = (
                f"`{boundaries_path.name}` could not be imported and was skipped; every "
                f"other artifact in this run is unaffected. An UNEXPECTED "
                f"{type(exc).__name__} was raised while reading it: {exc}"
            )
        if encoded is not None and int(encoded["entity"].shape[0]) == 0:
            boundaries_report = {"emitted": False, "reason": (
                f"`{boundaries_path.name}` holds no vertices this bundle's cells can be "
                "matched to, so no boundaries artifact was written. An empty polygon set is "
                "the claim that every cell has no shape, and a thing not measured is not "
                "written."
            ), **encoded["stats"]}
            encoded = None
        if encoded is not None:
          try:
            # THE SAME COORDINATE SPACE, through the WRITER. `write_boundaries` owns the
            # store AND the #211 mirror, exactly as `write_spatial_coordinates` does for the
            # tissue map — this entry asks for neither, which is the property
            # `test_coordinate_space.py` pins and the reason a second producer requesting a
            # mirror by hand would be a second route to one fact (#214). The polygons get the
            # SAME `space` object the centroids got, not a re-derived copy.
            #
            # And they are CHECKED against those centroids: `centroid_bbox` is the extent of
            # the positions written a few lines above, so a polygon set stamped with a space
            # it does not lie in produces a note instead of a silently wrong picture (§7.3).
            boundaries_rel = "spatial/boundaries.zarr"
            centroid_bbox = {"x_min": float(np.min(xs)), "x_max": float(np.max(xs)),
                             "y_min": float(np.min(ys)), "y_max": float(np.max(ys))}
            boundaries_structure, boundaries_meta = BD.write_boundaries(
                outputs_dir, boundaries_rel, encoded,
                space=space, series=series, centroid_bbox=centroid_bbox,
            )
            boundaries_meta.update({
                # CATALOG/DISPLAY facts, added after the writer returned. Deliberately NOT in
                # the mirrored block: the block's vocabulary is closed, and these are
                # producer facts a sandboxed consumer has no use for.
                "platform": "xenium",
                "provenance": provenance,
                "entity_axis_aligned_to": aligned_to["cells"],
                "vendor_source": boundaries_path.name,
            })
            boundaries_entries.append(output_entry(
                "spatial-boundaries", DT_BOUNDARIES, boundaries_rel, "artifact",
                label="segmentation boundaries", axis="vertex",
                structure=boundaries_structure, meta=boundaries_meta,
            ))

            # THE TWO OFFSET COLUMNS (INV-2). Ordinary `metadata-column`s over `cells`,
            # carrying the same `aligned_to`/`membership` every other per-cell column this
            # importer emits carries — which is what makes them conformance-checked like
            # every other column and what makes them survive a row filter through the path
            # that already works.
            #
            # `(start, count)` and NOT a cumulative `indptr` (DEC-4): each entity's pair is
            # self-contained, so a filtered subset of the cells axis still names the right
            # vertices, where an `indptr` would need its neighbours.
            for name, values in ((BD.START_COLUMN, encoded["start"]),
                                 (BD.COUNT_COLUMN, encoded["count"])):
                rel = f"metadata/{name}.zarr"
                structure, meta = cyto_columns.write_metadata_column(
                    outputs_dir, rel, name, pd.Series(np.asarray(values, dtype=np.int64)),
                    axis="cells", aligned_to=aligned_to["cells"],
                    membership=membership_of["cells"],
                )
                meta.update({"produced_by": "spatial.import-xenium",
                             "describes": DT_BOUNDARIES[0],
                             # `column_role`, NOT `role`: that key already carries two
                             # vocabularies in this tree (the manifest entry's own promotion
                             # tier, and the raster DISPLAY role the workbench data source
                             # reads off producer meta), and a third would be a collision
                             # waiting for the first consumer that looks.
                             "column_role": "boundary-offsets"})
                boundaries_entries.append(output_entry(
                    f"metadata-column:{name}", DT_METADATA_COLUMN, rel, "artifact",
                    label=name, axis="cells", structure=structure, meta=meta,
                ))
            # THE DISCLOSURE IS UNCONDITIONAL, and that is the whole point (#291). The
            # coverage NOTE carries it too, but `coverage_is_reportable` suppresses that
            # note for a well-placed pair — so on exactly the bundles a reader is most
            # likely to accept without question, the note says nothing. A reader of a clean
            # import is equally entitled to know that the control design §7.5 requires for
            # placement does not exist on this path. Same shape, and the same reason, as
            # `scale_referent.compensating_control` above (#269): name the control, name the
            # issue, say it is not built HERE, say what that costs.
            boundaries_report = {"emitted": True, "reason": None,
                                 **encoded["stats"],
                                 "coverage": boundaries_meta.get("boundary_coverage"),
                                 # A COPY. The constant is module-level and the report is
                                 # handed to callers in-process; inserting it by reference
                                 # lets one consumer's mutation rewrite the disclosure for
                                 # every later run in the same interpreter. `scale_referent`
                                 # rebuilds its literal per call for the same reason.
                                 "placement_judgement": dict(PLACEMENT_JUDGEMENT)}
            progress("boundaries", 88,
                     f"{encoded['stats']['n_vertices']} vertices over "
                     f"{encoded['stats']['n_entities_with_boundary']} cells")
            # THE EXTEND IS LAST, and that is not style. It used to sit ABOVE the two
            # statements above, so a failure in either — `progress` re-raises an OSError
            # from its stderr write — ran the handler below, which sets
            # `boundaries_entries = []` (already consumed, and therefore dead) while
            # `entries` still carried all three rows. A blind angle REPRODUCED it: a
            # manifest listing `spatial-boundaries` beside a report saying `emitted: false`.
            # Nothing may reach `entries` until every statement that can fail has run.
            entries.extend(boundaries_entries)
          except Exception as exc:  # noqa: BLE001 — the writer half of the same guard
            # NOTHING from this leg reaches the manifest: `boundaries_entries` is a LOCAL
            # list that is only extended into `entries` on the success path above, so a
            # writer that failed halfway cannot leave an entry pointing at a partial store.
            # The bytes on disk are orphaned, which is the same outcome a failed image
            # conversion has, and the manifest is the thing that decides what exists.
            boundaries_entries = []
            boundaries_report = {"emitted": False, "reason": (
                f"`{boundaries_path.name}` was read but could not be written, and was "
                f"skipped; every other artifact in this run is unaffected. A "
                f"{type(exc).__name__} was raised: {exc}"
            )}
        del encoded

    # ── the image ────────────────────────────────────────────────────────────────────
    # After the coordinates, because the image places itself INTO the space they define.
    #
    # THE CELLS TABLE IS RELEASED FIRST, and that is not tidiness. `rows` is a
    # list-of-lists-of-str over every cell and `by_id` is a dict over every cell id;
    # measured on a Xenium-shaped 14-column table they cost ~790 MB resident at 1M cells,
    # and the NEXT phase is the memory-heavy one — a real morphology plane is read whole and
    # `downsample`'s reshape of a non-contiguous slice makes a second full copy. Holding a
    # text table nothing reads any more THROUGH that peak is exactly the assumption that was
    # free on Visium's ~5,000 spots and is not free here. Everything still needed downstream
    # is already a numpy array or an int.
    n_cells_in_bundle = len(rows)
    del rows, by_id, order, col_of, segmentation_methods, per_cell
    progress("image", 90, "converting the morphology image")
    image_entries, image_skipped, image_warnings = emit_image(
        members, experiment, outputs_dir, space_id=space_id,
        # The cells' own extent IN MICRONS — the geometric leg of the scale referent.
        # Computed from the coordinates just written, not re-read from the CSV.
        coverage_bounds=(float(coords[:, 0].max()), float(coords[:, 1].max()))
        if len(coords) else None,
    )
    entries.extend(image_entries)

    # ── the registration QC (#301, design §7.5) ──────────────────────────────────────
    #
    # THE ONE CHECK ON THIS PRODUCER WITH A REFERENT OUTSIDE THE ARTIFACT, and the required
    # output §7.5 asks of every importer in this arm. It runs AFTER the image is on disk
    # because it reads the artifact AS STORED — the placement out of the emitted OME-XML, the
    # pixels out of the emitted pyramid — so what it scores is the bytes a consumer gets
    # rather than the in-memory plane this function happened to hold.
    #
    # It never raises (DEC-7) and never refuses the import: a failing verdict is recorded
    # loudly and every artifact is still emitted, which is the posture a damaged image and a
    # broken boundaries file already get.
    progress("registration-qc", 95, "checking the image registration")
    registration, overlays = RQC.registration_qc(
        coords=coords,
        # The vendor's own per-cell areas, for the mark radius (DEC-10). `None` on an XOA
        # version that does not write the column.
        cell_area_um2=cell_area_um2,
        image_entries=image_entries,
        outputs_dir=outputs_dir,
        scope="all-cells-in-the-matrix",
    )
    # THE RENDERED OVERLAY AS ITS OWN `report/qc` ARTIFACT (DEC-12). §7.5 asks for "a rendered
    # overlay in the `report/qc`" and calls it "a required output of the importer, not a
    # nice-to-have"; a manifest entry is what makes both of those true of something a user can
    # open. The sibling importer embeds its overlay in `report/html` ONLY, and its own
    # `qc_verdict_lines` records why that is not enough — nothing in this app renders
    # `report/html`, so an overlay that lives only there is "an image nobody opens".
    #
    # `report/qc` is already in this analysis's `produces`, so the declared output set does
    # not change; what changes is that a run now emits one more row of it.
    #
    # ONE PER EMITTED IMAGE, keyed by the image's own id, so a bundle that ever emits two
    # images gets two overlays rather than one silently overwriting the other.
    #
    # AND THE WHOLE LEG IS GUARDED, with `entries` extended LAST. `registration_qc` itself
    # never raises (DEC-7) — but the WRITE that its whole purpose is to produce did, because
    # it sat outside every guard. A blind error-handling angle reproduced it: patching
    # `write_bytes` to raise `OSError(ENOSPC)` on the overlay name aborted `run_import` at 95%
    # with the matrix, the coordinates, 15 columns and the morphology image already on disk
    # and NO manifest returned. That is exactly the outcome DEC-7 forbids, reached through the
    # one statement the guard did not cover.
    #
    # The shape is the one both neighbours in this file already use: a LOCAL list, extended
    # into `entries` only after every statement that can fail has run — so a write that failed
    # halfway can never leave a manifest row pointing at a file that is not there. The bytes
    # on disk are orphaned, which is the same outcome a failed image conversion has, and the
    # manifest is the thing that decides what exists.
    overlay_entries = []
    try:
        for image_id, png in sorted(overlays.items()):
            overlay_rel = f"{image_id}-registration-overlay.png"
            (outputs_dir / overlay_rel).write_bytes(png)
            overlay_entries.append(output_entry(
                f"{image_id}-registration-overlay", DT_REPORT_QC, overlay_rel, "artifact",
                structure=cyto_columns.opaque("image/png"),
                label="Registration QC overlay",
                meta={"kind": "xenium-registration-overlay",
                      "image_id": image_id,
                      "coordinate_space": space_id,
                      # THE VERDICT TRAVELS WITH THE PICTURE. `meta` is the one channel this
                      # app renders for a human today, so an overlay whose row says nothing
                      # would be a blob a reader has no reason to open.
                      "registration_qc_verdict": registration.get("verdict"),
                      "registration_qc": RQC.verdict_lines(registration),
                      "what_this_shows": _overlay_row_prose(registration, image_id)},
            ))
        entries.extend(overlay_entries)
    except Exception as exc:  # noqa: BLE001 — the same posture as the boundaries leg
        overlay_entries = []
        overlay_write_failure = (
            f"the registration QC overlay could not be written and was skipped; every other "
            f"artifact in this run is unaffected. A {type(exc).__name__} was raised: {exc}. "
            "The verdict and every number behind it are in `registration_qc` regardless — "
            "what is missing is the picture."
        )
        registration = dict(registration, overlay_not_written=overlay_write_failure)

    # ── the report ───────────────────────────────────────────────────────────────────    # ── the report ───────────────────────────────────────────────────────────────────
    report = {
        "kind": "xenium-import-report",
        "analysis": "spatial.import-xenium",
        "coordinate_space": space_id,
        "coordinate_space_source": space_id_source,
        # #270. The EMITTED `section` block plus the one thing the block itself cannot carry:
        # which derivation produced `sample_id`. `section()` refuses every keyword outside
        # `{sample_id, index, z_offset_um}` (DEC-1), so the machine-readable source lives here,
        # beside `coordinate_space_source`, and the artifact's own copy carries it in the
        # value's namespace. `coord_meta["section"]` rather than a re-derivation: this must be
        # the block that was WRITTEN, not a second construction of it that could drift.
        "section": dict(coord_meta["section"], sample_id_source=sample_id_source,
                        index_source=SECTION_INDEX_SOURCE),
        "unit": "micrometre",
        "n_cells": n_cells,
        "n_genes": len(gene_columns),
        "n_features_in_matrix": n_features,
        "n_cells_in_bundle": n_cells_in_bundle,
        "measured_entity": entity,
        "measured_entity_label": coord_meta["measured_entity_label"],
        "segmentation_methods": entity["segmentation"]["params"]["methods"],
        "feature_classes": feature_classes,
        "provenance": provenance,
        "cells_file": Path(members["cells"]).name,
        # #163. `emitted: false` with a REASON is the load-bearing half: a bundle whose
        # boundaries ship only as `.csv.gz` produces no artifact, and a silently absent
        # artifact is indistinguishable from a broken importer.
        "boundaries": boundaries_report,
        "component_columns": [COMPONENT_X, COMPONENT_Y],
        "z_note": (
            "no z column was emitted: `cells.csv.gz` carries no z centroid, and "
            "`experiment.xenium.z_step_size` describes the image focal-plane spacing, not a "
            "cell position. Absence stays absence — a fabricated z is indistinguishable "
            "from a measured one downstream."
        ),
        # WHICH image was emitted, and — the half that matters — which was NOT and why. A
        # silently absent image is how a user discovers at overlay time that there is
        # nothing to overlay on.
        "images": [
            dict(
                {"id": e["id"], "source": e["meta"].get("source"),
                 "role": e["meta"].get("role"), "to_space": e["meta"]["to_space"],
                 "extent": e["meta"]["extent"],
                 "plane_selection": e["meta"].get("plane_selection"),
                 "stated_scales": e["meta"].get("stated_scales")},
                **({"display_derivative": e["meta"]["display_derivative"]}
                   if "display_derivative" in e["meta"] else {}),
            )
            for e in image_entries
        ],
        "images_not_emitted": image_skipped,
        "image_warnings": image_warnings,
        # #301. §7.5's overlay, and every number behind its verdict — machine-readable, so a
        # consumer or a later gate can act on it without re-deriving it. The import itself does
        # NOT refuse on a failing verdict (DEC-7): a diagnostic that destroys a user's access
        # to their data when it is uncertain is worse than one that reports loudly, which is
        # the same posture `emit_image` takes for a damaged image.
        "registration_qc": registration,
        # THE EXTERNAL REFERENT, and its honest limit — recorded in the artifact a human
        # reads, not only in a design document.
        "scale_referent": {
            "stated_sources": [f"{EXPERIMENT_BASENAME}:pixel_size",
                               "morphology OME-XML:PhysicalSizeX/Y"],
            "geometric": "cell centroids (um) must fall inside extent_px * pixel_size",
            # WHAT IT REPORTS, not what it closes (#269). 0.4.0 said this referent
            # "closes" a one-sided disagreement, because it REFUSED the image above an
            # invented 1e-6 band. It no longer refuses: it measures. A producer with no
            # external referent cannot close a registration question (design §12.2), and a
            # sentence in the artifact claiming otherwise is a reassurance printed over the
            # real failure.
            "reports": ("a scale stated DIFFERENTLY in the two vendor statements — both raw "
                        "numbers, the measured relative difference per axis, and which "
                        "statement placed the image, in stated_scales; and a scale too "
                        "small to contain the cells, as a coverage warning"),
            "closes": ("nothing on its own. Both legs are measurements a reader judges; "
                       "neither decides on a threshold this importer invented"),
            # THE CONTROL THAT WOULD CLOSE IT, AND WHETHER IT EXISTS. Naming the overlay as
            # the answer while it was unbuilt would have been a reassurance with nothing
            # behind it, which is why #269 wrote this block and #291 corrected it from a
            # deferral into a disclosure of absence. #301 built the overlay, so this block
            # becomes a statement about a control that RAN — and it is worded to what the
            # control actually settles, because "judged, fully" would be the same
            # overstatement as "judged by nothing" with the sign flipped.
            "compensating_control": {
                "what": ("the registration QC overlay — cell centres drawn on the tissue "
                         "image at the declared transform, judged by a human (design §7.5)"),
                "issue": "#301 (built here); #156 built the Visium sibling",
                "built_for": ("this importer AND `spatial-import-visium`, as two DIFFERENT "
                              "checks answering the same design section: Xenium has no "
                              "fixed-pitch capture slide and no vendor `in_tissue` flag, so "
                              "neither of #156's two referents transfers"),
                # PER-IMPORTER, and worded to what the code actually does. This block is
                # asserted IDENTICAL across runs (`test_scale_referent.py`), which is right —
                # it is a fact about the importer, not a reaction to the bundle — and that is
                # exactly why it may not make a per-RUN claim. It said "emitted as a
                # `report/qc` artifact of this run", and on a badly misregistered bundle the
                # picture is withheld (it would carry no marks), so the same report contained
                # both that sentence and "no overlay was rendered". Found by a blind
                # design-conformance angle, reproduced on a bundle with a 100x wrong pixel
                # size.
                "status": ("PRODUCED by this importer. Computed on every bundle that emits a "
                           "morphology image, and emitted as a `report/qc` artifact whenever "
                           "the cells land on that image at all — the picture is withheld "
                           "only when every cell maps outside the frame, where it would be a "
                           "bare thumbnail. `registration_qc` carries the verdict either way "
                           "and says which happened"),
                "what_it_measures": (
                    "every cell centre placed through the image's DECLARED `to_space`, read "
                    "back out of the emitted artifact's own OME-XML, onto a signal mask "
                    "derived from the emitted PIXELS, scored as how far above CHANCE the "
                    "cells land on signal. The vendor segmented these cells FROM this image, "
                    "so the pixels and the cell table are two independent recordings and "
                    "neither is a function of the affine — which is what makes this referent "
                    "EXTERNAL, and what every other measurement in this report is not"),
                "consequence": ("the placement question this producer cannot decide from "
                                "inside the artifact now has a REQUIRED output that answers "
                                "it, and when the two vendor statements DIFFER the overlay "
                                "scores both placements so the disagreement is decided "
                                "rather than only reported. The workbench's "
                                "image-to-coordinates binding (#228) can show the same "
                                "picture and is now a second route to it rather than the "
                                "only one"),
                "still_not_decided": ("a scale wrong the SAME way in both vendor statements "
                                      "by under about 2% — measured, a 2% error scores 0.303 "
                                      "against a 0.4 floor — and a misregistration that moves "
                                      "the image and the cells TOGETHER, which is not a "
                                      "misregistration but a different frame. Both are named "
                                      "rather than claimed shut, and every score is reported "
                                      "as a NUMBER beside its verdict so the margin is "
                                      "visible"),
                "tracked_as": ("#301 (built it); #291 (the disclosure it retires); #302 (the "
                               "same prose, still stale in the shared modules this package "
                               "vendors)"),
            },
            "does_not_close": ("a scale wrong the SAME way in both vendor statements by a "
                               "factor that still contains the cells — that artifact is "
                               "internally consistent everywhere and only a §7.5 "
                               "registration overlay can see it, which this importer NOW "
                               "produces (#301), down to about a 2% error; below that the "
                               "residue stands. WHICH of two DIFFERING statements is correct "
                               "is decided by that same overlay, which scores both "
                               "placements — see `compensating_control` and "
                               "`registration_qc`. What is still NOT closed by any of it: "
                               "the disagreement does not reach an IN-SANDBOX consumer — "
                               "`stated_scales` and the overlay's verdict ride this report "
                               "and the catalog `meta`, not the OME `Description` payload "
                               "that carries the affine into a sandboxed analysis, so that "
                               "consumer still sees a placement with no record that its "
                               "scale was contested or checked (#279)"),
        },
        "library_versions": cyto_deps.resolve_and_check()["libraries"],
    }
    reported_pixel_size = _finite(experiment.get("pixel_size"))
    if reported_pixel_size is not None:
        report["pixel_size_um"] = reported_pixel_size

    (outputs_dir / "xenium-import-report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    entries.append(output_entry(
        "xenium-import-report", DT_REPORT_QC, "xenium-import-report.json", "artifact",
        structure=cyto_columns.opaque("application/json"),
        meta={"kind": "xenium-import-report", "n_cells": n_cells,
              "coordinate_space": space_id,
              # #301's verdict, in the ONE channel this app shows a human — see
              # `registration_qc.verdict_lines`. The full block is in the JSON body; these
              # are the lines a reader sees without opening anything.
              "registration_qc_verdict": registration.get("verdict"),
              "registration_qc": RQC.verdict_lines(registration)},
    ))
    (outputs_dir / "xenium-import-summary.html").write_text(
        render_report_html(report, overlays), encoding="utf-8"
    )
    entries.append(output_entry(
        "xenium-import-summary", DT_REPORT_HTML, "xenium-import-summary.html",
        "intermediate",
        structure=cyto_columns.opaque("text/html"),
        meta=dict(
            {"kind": "xenium-import-summary",
             "registration_qc_verdict": registration.get("verdict"),
             "registration_qc": RQC.verdict_lines(registration),
             "overlay_embedded": sorted(overlays)},
            # SAID OUT LOUD in the artifact record, because the alternative is a reader
            # believing they have seen the overlay. This report EMBEDS it and nothing in this
            # app renders `report/html` — but unlike the sibling, the same picture is ALSO a
            # `report/qc` artifact of its own, so there is somewhere to send them.
            #
            # The key is OMITTED rather than set to null when there is no overlay, which is
            # the same discipline the report applies to `display_derivative`.
            **({"overlay_note": (
                "the rendered registration overlay is embedded in this HTML, and this "
                "application has no renderer for `report/html`. The same picture is emitted "
                "as its own `report/qc` artifact — "
                + ", ".join(f"`{image_id}-registration-overlay.png`"
                            for image_id in sorted(overlays))
                + " — which is what design §7.5 asks for and what a reader can open."
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
        if name in slots:
            bundle = slots[name]
            break
    if bundle is None:
        for path in slots.values():
            if Path(path).exists():
                bundle = path
                break
    if bundle is None:
        bundle = inputs_dir
    try:
        entries = run_import(bundle, outputs_dir)
    except XeniumImportError as exc:
        print(f"spatial.import-xenium: {exc}", file=sys.stderr, flush=True)
        sys.exit(2)
    write_manifest(outputs_dir, entries)
    progress("done", 100, f"{len(entries)} artifacts")


if __name__ == "__main__":
    main()
