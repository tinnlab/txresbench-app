#!/usr/bin/env python3
# ruff: noqa
"""spatial.import-visium-hd — a 10x Visium HD `binned_outputs/` bundle → workbench artifacts.

Reads `/inputs` (the auto-grouped `spatial/visium-hd-bundle` dataset), writes
`/outputs/<file>` plus `/outputs/manifest.json` = `{"outputs":[{id,datatype,path,layout,
role,structure,meta}]}`. Progress lines `phase|pct|message` go to `$TXR_PROGRESS_FIFO`.
`/inputs` and `/outputs` are overridable via `TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR` — the
ONLY seam that lets a test drive the REAL script off-sandbox, which is what
`tests/test_producer_end_to_end.py` does.

## ONE RUN IMPORTS ONE BIN, and the bin is a DECLARED choice

Visium HD writes three square-bin resolutions from one run — `square_002um`,
`square_008um`, `square_016um`, "each `square_XXXum/` mirrors a full Visium `outs/`"
(`docs/research/data-processing/01-file-formats.md:621-631`). This importer reads exactly
one of them, named by `params.json`'s `bin_um` and defaulting to [`DEFAULT_BIN_UM`].

**The default is not owner-confirmed.** It is 8 um because three of this repo's own
research documents say 8 um is 10x's recommended analysis bin
(`02-platforms.md:388`, `06-spatial-processing.md:582`, `01-file-formats.md:630-631`), and
because the alternative that would need no choice — importing the native 2 um grid — is
"defensible on fidelity and indefensible on usability" (#313). It is shipped VISIBLE: one
module constant, one report line derived from it, one run parameter. See
`.lifecycle/visium-hd-import/DECISIONS.md` DEC-1 for the full option table.

The bins that were NOT imported are named in the report, not silently dropped, and every
emitted artifact is stamped with `measured_entity` — so two imports of one run at two bins
are the design's **resolution group** (`spatial-storage-layout.md` §15.1) and are told
apart by a field a human reads rather than by row count. That stamping is the half that is
"unrecoverable from the bytes once artifacts exist", which is why it is here from day one
even though emitting all three bins in one run is not.

## What this emits

`filtered_feature_bc_matrix.h5` of the selected bin → an ORDINARY `single-cell/counts`
`sparse_csc` store over `bins x genes`; nothing downstream needs to know it is spatial.
`spatial/tissue_positions.parquet` → a `spatial/coordinates` artifact in FULL-RESOLUTION
PIXELS, ordered `(x, y)`. `tissue_hires_image.png` (and the lowres image when present) →
one `spatial/image` each, a tiled pyramidal OME-TIFF placed by the INVERSE of its own
scalefactor. Plus the per-bin columns, the axis-key artifacts, and the registration QC
report.

## Three things that are DIFFERENT from `spatial-import-visium`, and why

1. **The micron scale is STATED, never derived.** Visium HD writes `microns_per_pixel`
   into `scalefactors_json.json` (`01-file-formats.md:602`), so this module takes it
   verbatim and NEVER divides a rendered-spot constant by `spot_diameter_fullres`. Neither
   `VISIUM_RENDERED_SPOT_DIAMETER_UM` nor a slide-design table appears anywhere below,
   which makes #222's defect (the wrong numerator) and #257's (the wrong slide design)
   structurally unreachable rather than merely fixed.
2. **The positions are PARQUET.** A different reader (`pyarrow.parquet`, streamed by row
   group) and a different scale class — "millions of squares" (`01-file-formats.md:629`).
3. **EVERY refusal fires before the first writer.** The sibling's barcode join leaves 51
   paths behind and `docs/design/vendor-text-encodability-refusal.md` §6.7 records the
   general form — "every refusal a bundle can trigger should be reachable before the first
   writer call" — as an OPEN item. It is closed here, whole: every read this module can
   refuse on, the barcode join included, happens above `write_csc_zarr`, so a refused
   import leaves ZERO paths on disk. `tests/test_zero_partial_store.py` asserts that on the
   FILESYSTEM, per refusal, rather than by exception type.

## The axis-order transpose is the single most likely bug in the whole importer

`tissue_positions.parquet` writes `pxl_row_in_fullres` (y) BEFORE `pxl_col_in_fullres`
(x); the stored convention is `(x, y)` (`spatial-storage-layout.md` §7.3 rule 5). Getting
it wrong does not error — it draws the tissue transposed and every downstream
neighbourhood is measured in the wrong place. The committed fixture is deliberately
NON-SQUARE in BOTH the image and the lattice so a transposed read cannot pass silently.
"""
import base64
import csv
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
import txr_columns
import txr_csc
import txr_deps

# The VENDORED write-time contract (#152). Staged beside this entry by `run.helpers`.
# Byte-identical to `spatial-types/compute/spatial_declarations.py`; never edited here.
import spatial_declarations as SD

# The OME-TIFF writer. VENDORED too — byte-identical to
# `spatial-types/compute/ome_writer.py`, which is the promoted source of truth since #162.
import ome_writer

# The registration QC. This package's OWN, and deliberately NOT vendored: the referent is
# per-platform and for HD it is the bin lattice pitch (DEC-5).
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
DT_SPATIAL_IMAGE = ("spatial/image", "opaque")

IMAGE_MEDIA_TYPE = "image/tiff; application=ome"

# ── the platform's own vocabulary ────────────────────────────────────────────────────

#: THE PLATFORM NAME, as `measured_entity.platform` and as the column value. `visium-hd`
#: is the spelling `spatial-storage-layout.md` §15.1's own example block uses.
PLATFORM = "visium-hd"

#: WHAT ONE ROW IS. `"bin"` is already in `spatial_declarations.MEASURED_ENTITY_KINDS`, and
#: it is the honest answer for a capture grid: an HD square is neither a Visium spot nor a
#: segmented cell. The constructor requires a `segmentation` block only for `cell`/`nucleus`,
#: which an unsegmented capture-grid assay has none of.
ENTITY_KIND = "bin"

#: THE BIN THIS IMPORTER READS WHEN NOTHING SAYS OTHERWISE — and the ONLY place this number
#: is written. The report's disclosure line is derived from it (see [`bin_choice_note`]), so
#: moving the default moves what the report says about the default, and the two cannot drift.
#:
#: **NOT OWNER-CONFIRMED.** See the module docstring and DECISIONS.md DEC-1. The evidence for
#: 8 um is three repo-internal citations, not a preference:
#:   * `docs/research/data-processing/02-platforms.md:388` — 8 um is the "recommended default
#:     for analysis";
#:   * `docs/research/data-processing/06-spatial-processing.md:582` — "Native 2 um is too
#:     sparse; 8 um is 10x's recommended analysis bin";
#:   * `docs/research/data-processing/01-file-formats.md:630-631` — "the 2 um matrix is enormous
#:     and very sparse; most analyses start at 8 um".
DEFAULT_BIN_UM = 8

#: The run parameter that overrides it. Read from `/inputs/params.json`.
BIN_PARAM = "bin_um"

#: The slot the upload planner binds the auto-grouped `spatial/visium-hd-bundle` dataset to
#: (`appliesTo.slot` in the manifest). Named as a constant so the view↔compute seam's reader
#: can see the vocabulary this compute resolves — the same `*_SLOT` convention the other
#: shipped computes use. The `"input"` / `"dataset"` fallbacks below are the generic
#: single-file arms, not this container's slot.
BUNDLE_SLOT = "bundle"

#: The DECLARED MEMBER LIST of `spatial/visium-hd-bundle`, in DECLARATION ORDER.
#:
#: A SECOND SPELLING of a fact `spatial-types/manifest.yaml` owns, and it is here only
#: because a compute cannot read a manifest: the sandbox stages a flat `/code` dir holding
#: the entry and its declared helpers, and nothing else. The duplication is therefore
#: CHECKED rather than trusted — `tests/test_locate_bins.py` parses the container's own
#: declaration out of the manifest and compares it to this tuple, so a container change
#: reddens the suite instead of drifting past it.
#:
#: The ORDER is load-bearing and not cosmetic. `dataset/process.rs::build_dataset_inputs`
#: binds a multi-file dataset's files at `{slot}_{i}` with sandbox subpath `{i}_{basename}`,
#: and the ordinal is the link order, which is the declared member order. So in the layout a
#: real sandbox actually presents, the `square_NNNum/` segment — the entire distinction
#: between the three resolutions — survives ONLY as that integer. That is the contract
#: `spatial-types/tests/test_hd_bundle_container.py::test_the_declared_member_ORDER_is_pinned`
#: freezes, and this tuple is its consumer.
DECLARED_MEMBERS = (
    "square_002um/filtered_feature_bc_matrix.h5",
    "square_002um/spatial/tissue_positions.parquet",
    "square_002um/spatial/scalefactors_json.json",
    "square_002um/spatial/tissue_hires_image.png",
    "square_008um/filtered_feature_bc_matrix.h5",
    "square_008um/spatial/tissue_positions.parquet",
    "square_008um/spatial/scalefactors_json.json",
    "square_008um/spatial/tissue_hires_image.png",
    "square_016um/filtered_feature_bc_matrix.h5",
    "square_016um/spatial/tissue_positions.parquet",
    "square_016um/spatial/scalefactors_json.json",
    "square_016um/spatial/tissue_hires_image.png",
)

#: The four ROLES a bin's members play, in the order `DECLARED_MEMBERS` lists them within a
#: bin. Derived from that tuple by [`declared_bin_layout`] rather than restated, so a
#: container that reorders a bin's members cannot leave this mapping stale.
MEMBER_ROLES = ("matrix", "positions", "scalefactors", "image")

#: The directory-name grammar the container declares its bins with. A CLOSED literal set is
#: what the core's member matcher supports ("there is no intra-segment wildcard"), so the
#: bins this importer can see are exactly the bins the container declares — which is the
#: correct coupling: a fourth bin is a container change first.
BIN_DIR_RE = re.compile(r"^square_(\d{3})um$")

MATRIX_BASENAME = "filtered_feature_bc_matrix.h5"
POSITIONS_BASENAME = "tissue_positions.parquet"
SCALEFACTORS_BASENAME = "scalefactors_json.json"

#: The vendor images this importer converts to `spatial/image`, each with the scalefactor
#: key that PLACES it and the role it plays. A TABLE, not a branch, because "N images, one
#: coordinate space, every pair placeable" (§7.3 rule 3) is the property the space model
#: exists for — adding a platform's image is a row here.
#:
#: `tissue_hires_image.png` is a DECLARED member of the container; `tissue_lowres_image.png`
#: is not, and is read opportunistically when the upload retained it (the ARCHIVE arm does;
#: the FOLDER arm uploads only declared members, so on that path it is structurally absent).
VENDOR_IMAGES = (
    {"basename": "tissue_hires_image.png", "scalef_key": "tissue_hires_scalef",
     "role": "display", "output_id": "spatial-image-hires"},
    {"basename": "tissue_lowres_image.png", "scalef_key": "tissue_lowres_scalef",
     "role": "overview", "output_id": "spatial-image-lowres"},
)

#: Vendor images this importer will NEVER emit, and WHY. Separate from `VENDOR_IMAGES`
#: because the two tables answer different questions: that one says which scalefactor places
#: an image, this one says that nothing does. Carried over from #257's measurement on the
#: Visium side, whose conclusion is about the FILE and not about the assay: 10x documents
#: `regist_target_img_scalef` as placing the registration target, and no single scalar maps
#: the CytAssist instrument's square frame onto the full-resolution one.
NON_PLACEABLE_VENDOR_IMAGES = (
    {
        "basename": "cytassist_image.tiff",
        "reason": (
            "not emitted — this bundle carries no scalefactor that places it in the "
            "full-resolution coordinate space. `regist_target_img_scalef` places the "
            "registration target (`aligned_tissue_image.jpg`), not this file, and no single "
            "scale factor maps the CytAssist instrument's own square frame onto the "
            "full-resolution one. Emitting it under a constructed affine would place the "
            "tissue wrongly with every internal check still passing, so it is reported here "
            "instead. See docs/design/visium-slide-design-scale.md §6 and issue #257."
        ),
    },
)

#: THE PHRASES THAT ASSERT AN IMAGE WAS EMITTED. A note containing one of these is only true
#: PAST THE COMMIT POINT, so every such note is buffered and flushed there rather than
#: appended where it is composed (#298). Named as a constant because the test that pins "no
#: emission-asserting note accompanies a FAILED image" is a NEGATIVE assertion over prose,
#: and a negative substring assertion goes vacuously green the moment the prose is reworded.
EMISSION_ASSERTING_PHRASES = ("emitted,", "is emitted", "written to disk")

#: What the per-image handlers call an image whose bundle entry carries no `basename`.
UNNAMED_IMAGE = "<an image whose bundle entry has no basename>"

#: Read for the report only, never emitted as artifacts (§7.2: they are "diagnostics, not
#: data"). `aligned_tissue_image.jpg` is a CytAssist/HD-only member and belongs exactly here
#: — 10x describes it as a checkerboard MERGE of the registered images, i.e. a QC rendering
#: of a registration rather than tissue data.
DIAGNOSTIC_BASENAMES = ("aligned_fiducials.jpg", "detected_tissue_image.jpg",
                        "aligned_tissue_image.jpg")
DIAGNOSTIC_INLINE_CAP_BYTES = 2 * 1024 * 1024

#: The `tissue_positions.parquet` columns this importer reads, with the meaning each
#: carries. Visium HD writes the SAME six column names Space Ranger >= 2.0 writes into
#: `tissue_positions.csv` (`01-file-formats.md:568` records the file's rename to parquet for
#: HD, not a rename of its columns), so the vocabulary below is the headered-CSV vocabulary.
POSITION_COLUMNS = (
    "barcode", "in_tissue", "array_row", "array_col",
    "pxl_row_in_fullres", "pxl_col_in_fullres",
)

#: How many parquet ROWS are decoded at a time. A WORK bound, not a message bound: an HD
#: 2 um positions table is "millions of squares" (`01-file-formats.md:629`), and decoding it
#: as one arrow table materialises every column at once. Streaming by row-group batch keeps
#: the peak proportional to the batch. Fixed rather than operator-configurable for the reason
#: DEC-11 states: a compute runs under `--clearenv` in a flat `/code` dir with no channel to
#: a settings row.
POSITIONS_BATCH_ROWS = 65_536

#: The two 1-D component columns (#183 Option A). Their NAMES are the address the client
#: resolves them by, so they are declared once, here, and used for the column name, the
#: output id and the `component_columns` declaration alike.
COMPONENT_X = "spatial_x"
COMPONENT_Y = "spatial_y"


class VisiumImportError(RuntimeError):
    """A bundle this importer cannot carry. Caught by `main()`, printed, exit 2.

    THE NAME IS THE SIBLING'S ON PURPOSE (DEC-4). `tests/visium_hd_refusal_sites.py` — the AST guard
    #336 established, which proves every value any refusal interpolates is either funnelled
    or provably incapable of carrying a vendor byte — reads its subject from a module-level
    `REFUSAL = "VisiumImportError"` constant. Keeping the class name lets that 777-line guard
    be vendored BYTE-IDENTICALLY with a byte-compare test, instead of forked over one string;
    a forked structural guard is the "second implementation wearing the first one's name"
    that `test_vendored_contract.py` exists to refuse. The class is module-private and never
    reaches a user — `main()` prints `spatial.import-visium-hd: <message>`.
    """


# ── the sandbox I/O contract ─────────────────────────────────────────────────────────


def io_dirs():
    inp = Path(os.environ.get("TXR_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("TXR_OUTPUTS_DIR", "/outputs"))
    out.mkdir(parents=True, exist_ok=True)
    return inp, out


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, UnicodeDecodeError):
        return {} if default is None else default


def load_inputs_index(inputs_dir):
    """`slot -> host path`, resolved from `inputs.json` (`sandbox_path` = `/inputs/<sub>`).

    `encoding="utf-8"` is EXPLICIT through [`read_json`], and that is not cosmetic here.
    `inputs.json` carries a user-chosen mount name the server does not ASCII-escape, and
    reading it at the LOCALE default is measured on the Visium side to refuse a COMPLETE
    ordinary bundle under `LC_ALL=C` with a false statement about it
    (`docs/design/vendor-text-encodability-refusal.md` §6.8 item 9). That defect is in a
    shared runtime block there; here the read is this module's own, so it is simply correct.
    """
    idx = read_json(inputs_dir / "inputs.json", {"inputs": []})
    slots = {}
    for e in idx.get("inputs", []):
        if not isinstance(e, dict) or "slot" not in e:
            continue
        sp_path = e.get("sandbox_path", "") or ""
        if sp_path.startswith("/inputs/"):
            sub = sp_path[len("/inputs/"):]
        else:
            sub = Path(sp_path).name or e.get("slot", "")
        slots[str(e["slot"])] = inputs_dir / sub
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
        try:
            if _PROGRESS_FD[0] < 0:
                _PROGRESS_FD[0] = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            os.write(_PROGRESS_FD[0], (line + "\n").encode("utf-8"))
        except OSError:
            pass
    print(f"progress: {line}", file=sys.stderr, flush=True)


def write_manifest(outputs_dir, entries):
    """`/outputs/manifest.json`, the LAST thing written -- and the RUN-ENVIRONMENT record.

    `txr_deps.augment` appends this run's environment record and REFUSES the run if the
    environment does not satisfy the manifest's declared `run.dependencies`. It is called
    HERE, not in `run_import`, because this is the one point every successful run passes
    through -- `_lib/txr_deps.py` states the invariant it buys: "a compute cannot emit its
    outputs without also emitting the record of the environment that produced them, and there
    is no path where an entry 'forgot' to record."

    THE FIRST CUT OF THIS MODULE FORGOT. It copied the sibling's `DT_RUN_ENVIRONMENT`
    constant, never called `augment`, and every import shipped with no environment provenance
    at all -- invisible to the whole suite, because the output-set tests compare what is
    emitted against the manifest's own `produces`, and `report/qc` was already in it.

    COMPACT, not `indent=2`: only the server reads this file, and pretty-printing doubles it
    against `outputs.rs`'s `MAX_MANIFEST_BYTES` (1 MiB, a hard failure past it).
    `ensure_ascii=True` (the default) is deliberate too: a non-ASCII vendor string that
    survived every guard above is written as an escape rather than as raw bytes.
    """
    txr_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    (Path(outputs_dir) / "manifest.json").write_text(
        json.dumps({"outputs": entries}), encoding="utf-8"
    )


def output_entry(id, datatype_layout, path, role, *, structure, meta=None, label=None,
                 axis=None, media_type=None):
    datatype, layout = datatype_layout
    entry = {
        "id": id, "datatype": datatype, "layout": layout, "path": path, "role": role,
        "structure": structure,
    }
    if meta is not None:
        entry["meta"] = meta
    if label is not None:
        entry["label"] = label
    if axis is not None:
        entry["axis"] = axis
    if media_type is not None:
        entry["media_type"] = media_type
    return entry


# ── the refusal contract (#330 / #336), carried over VERBATIM ────────────────────────
#
# THE CODE IN THIS SECTION IS A VERBATIM COPY of the refusal machinery
# `spatial-import-visium/compute/import_visium.py` carries, minus its narrative docstrings.
# It is copied rather than vendored-with-a-byte-compare because it is bound to THIS module's
# `VisiumImportError` and its own constants; what IS byte-compared is the STRUCTURAL GUARD
# over it (`tests/visium_hd_refusal_sites.py`), which is the thing that has to be identical for the
# property to transfer.
#
# THE MEASUREMENTS THAT JUSTIFY EACH LINE WERE MADE THERE, ON THAT MODULE'S OWN FIXTURES,
# and are NOT restated here as if they had been re-made on this one. That matters: this
# package's whole fixture is synthesized (DEC-9), so a number quoted here would be a
# measurement nobody took. The citations are:
#
#   * `docs/design/vendor-text-encodability-refusal.md` §6.1-§6.9 — the two parse boundaries
#     (h5 root attributes and the scale JSON), why an unwritable vendor string is REFUSED and
#     never sanitised, and the measured cost of walking the whole attribute dict;
#   * `spatial-import-visium/manifest.yaml` 0.12.0 — the four amplification measurements the
#     two funnels bound (7,200,587 B -> 1,630 B; 600,212 B -> 987 B; 1,800,513 B -> 2,816 B;
#     and the FORGED `import SUCCEEDED` stderr row a raw `\n` in a directory name produced);
#   * `spatial-import-visium/tests/test_refusal_escaping.py` TEST-12/TEST-13 — the
#     BEHAVIOURAL proof that the funnels escape, which the AST guard's own docstring says it
#     cannot supply. This package ships its own copy of that proof
#     (`tests/test_refusal_escaping.py`), because a routing guard over a funnel nobody
#     exercised is a guard over nothing.
#
# WHY IT IS HERE AT ALL: `scheduler.rs::drain_logs` reads a compute's stderr with
# `BufReader::lines()` and writes EACH LINE as its own `job_logs` row with no per-line cap,
# and the UI renders that text HTML-safe but ANSI-unsafe. So an unbounded, un-escaped
# interpolation of vendor text into a refusal is a log-injection and a flood, not an
# untidiness.

#: How much of an attacker-controlled value (and of the path to it) a refusal quotes.
#: Fixed, not operator-configurable (DEC-11): a compute runs under `--clearenv` in a flat
#: `/code` dir with no channel to a settings row, and a stderr-flood bound an operator can
#: raise is a bound an attacker can benefit from.
_REFUSAL_QUOTE_CHARS = 120

#: How many ELEMENTS of an offending SEQUENCE a refusal quotes. A per-element bound is NOT a
#: message bound — bounding each of 60 header fields to 120 units still leaves 7,200
#: characters — so the COUNT is bounded too and the true count is always stated. 8 is above
#: every legitimate case this module quotes (the positions table declares 6 columns; a 10x
#: matrix h5 has one or two top-level members; the missing-barcode refusal slices to 3).
_REFUSAL_QUOTE_ITEMS = 8

#: The largest h5 root attribute this importer will WALK, in bytes. A WORK bound, not a
#: message bound, and the two are different failures: past this the cost is not a long line
#: on stderr, it is an OOM SIGKILL with no message at all.
_MAX_WALKED_ATTRIBUTE_BYTES = 1 << 20


def unencodable_vendor_text(node, _trail=()):
    r"""The first `(where, text, at)` in a parsed vendor document that CANNOT BE WRITTEN — or `None`.

    ONE predicate, applied at EVERY boundary where this module parses a vendor document, to
    EVERY string each carries: every key and every value, `str` and `bytes`, at every depth
    (`vendor-text-encodability-refusal.md` §6.5 INV-3). Not per field, and not at one door.

    Two shapes reach it and only one of them crashes. h5py decodes a UTF-8-typed attribute
    with `surrogateescape`, so invalid bytes come back as lone surrogates — a `str` no UTF-8
    encoder can write. A fixed-length `|S` attribute comes back as raw invalid `bytes`, which
    a loose `decode(errors="replace")` would silently collapse into replacement characters —
    three distinct vendor byte strings becoming ONE sample identity and ONE coordinate frame.
    The silent shape is the one a real bundle actually uses for `library_ids`.

    The dtype skip is stated as a DENY-list (bool, int, uint, float, complex, datetime64,
    timedelta64) rather than an allow-list, so an unknown or future dtype kind is WALKED. `V`
    is deliberately walked: it is not only the HDF5 OPAQUE dtype, it is the STRUCTURED dtype
    whose fields can be text.
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
    # `np.bytes_` is NOT listed: it subclasses `bytes`, and it IS the shape this boundary
    # really produces, so it is covered by the first name in the tuple rather than by an
    # omission. `bytearray` and `memoryview` do NOT subclass `bytes` and are listed for that
    # reason. `np.void`, `set`/`frozenset` and every numeric dtype fall through and return
    # `None` — none of them is text and none reaches a writer as text; that is a narrow claim
    # about the callers, not a completeness claim about the walk.
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
            # EVERY key, not only the `str` ones — no caller can produce a `bytes` key today,
            # which is exactly why the cheap thing is to make the code match the invariant
            # rather than to narrow the invariant to the callers that happen to exist.
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
        # An h5 attribute is as likely to be an ARRAY of strings as a scalar one — a real
        # bundle's `library_ids` IS one — so a walker without this arm would let this
        # boundary's commonest shape through while looking guarded. `.tolist()` on a 0-D array
        # returns a SCALAR, which the recursion handles as itself rather than iterating it.
        #
        # The SIZE bound is not redundant with the dtype skip: `|S1` is kind `S`, passes any
        # text check, and materialises one Python object per element. Refusing BY NAME above
        # the cap — rather than returning a hit — is deliberate: this is not "the document
        # carries something unwritable", it is "this document cannot be examined", and giving
        # it the hit tuple's shape would make the two indistinguishable.
        if node.dtype.kind in "biufcMm":
            return None
        if node.nbytes > _MAX_WALKED_ATTRIBUTE_BYTES:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} carries a root attribute at "
                # `int(...)` is a no-op on a numpy `intp` and is what lets the #336 structural
                # guard PROVE these two are integers. A by-name rule ("the attribute is called
                # `nbytes`") would say nothing about what the object returns, so the source
                # states the fact instead.
                f"{_quoted_for_refusal(_trail_text(_trail))} of {int(node.nbytes)} bytes "
                f"({int(node.size)} entries), past the {_MAX_WALKED_ATTRIBUTE_BYTES}-byte cap "
                "this importer will examine. A root attribute is METADATA -- this importer "
                "reads three short strings from there -- and one this large cannot be checked "
                "for text it could not write without doing the work the check exists to "
                "bound. Re-export the complete Space Ranger `outs/` bundle."
            )
        return unencodable_vendor_text(node.tolist(), _trail)
    if isinstance(node, np.void):
        # A SCALAR of the compound/opaque dtype above. It is not an `ndarray`, so without this
        # arm it reaches the fall-through `return None` and is invisible — the scalar twin of
        # the structured-dtype hole. `.tolist()` gives a tuple for a compound and `bytes` for
        # an opaque, both of which the arms above handle.
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


def _quoted_for_refusal(value, focus=None, *, noun="path"):
    r"""One attacker-controlled value, safe to put in a message: ASCII, bounded, and ABOUT THE OFFENCE.

    Four properties, each of which was a defect a blind angle reproduced against an earlier
    revision of the original: ASCII (`ascii()` is DEFINED to return it, where `repr()` merely
    happens to for some inputs); BOUNDED (clipped at [`_REFUSAL_QUOTE_CHARS`], with the TRUE
    length always stated, so the message grows only with the decimal digits of that number);
    FOCUSED (when the caller knows where the offence is, the window is around it rather than
    at the head, because the offending unit of a 200,000-character field is not in its first
    120 characters); and TOTAL (a `Path`, an `Exception` or an `int` is coerced, so a call
    site cannot leak a raw value by passing a non-string).
    """
    if not isinstance(value, (str, bytes)):
        # A `Path`, an `Exception`, an `int`. `len()` raises on all of these, so the value is
        # rendered first; `str` and `bytes` are left alone so the original's output cannot move.
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
    """A SEQUENCE of attacker-controlled values, safe to put in a message.

    Bounding each ELEMENT is not bounding the MESSAGE — that is the whole reason this exists
    beside the scalar funnel. Both the element count and each element are bounded, and both
    true totals are stated.
    """
    values = list(values)
    shown = [_quoted_for_refusal(v, noun=noun) for v in values[:_REFUSAL_QUOTE_ITEMS]]
    body = "[" + ", ".join(shown) + "]"
    if len(values) <= _REFUSAL_QUOTE_ITEMS:
        return body
    return f"{body} (the first {_REFUSAL_QUOTE_ITEMS} of {len(values)} entries)"


def json_safe_vendor_numbers(node, path=()):
    """A copy of a parsed vendor document with every number STRICT JSON cannot carry
    replaced by a statement of what it was, plus the list of key paths that were replaced.

    ## The defect

    `NaN`, `Infinity` and `-Infinity` are not JSON. `json.loads` accepts them anyway (a
    Python extension) and `json.dumps` writes them straight back out, because `allow_nan`
    defaults to True. The whole scale document is copied verbatim into this run's report, and
    `spot_diameter_fullres` is copied into an artifact's `meta` -- so ONE non-finite number,
    in a key this importer never reads, made `visium-hd-import-report.json` (declared
    `application/json`) and `/outputs/manifest.json` unparseable by a strict reader.
    `outputs.rs::parse_manifest` uses `serde_json::from_slice`, which is strict RFC 8259 and
    rejects `Infinity`, so a COMPLETE, CORRECT import was discarded as
    `OUTPUTS_MANIFEST_INVALID` after paying the full compute cost, with no statement anywhere
    about which bundle caused it. (`node -e "JSON.parse(...)"` refuses both files identically.)

    ## Why this REPLACES rather than REFUSES

    `refuse_unencodable_vendor_text` refuses, and the difference is not inconsistency. That
    guard is about TEXT, and the reason it refuses is stated there: those strings become the
    run's IDENTITY, so a repaired one is a silently altered sample. A number in a scale
    document is not an identity, and INV-5's posture for damaged data is the one this module
    already takes everywhere else -- degrade, and SAY SO: a scale this importer cannot use
    means "no scale declared", an unplaceable image is dropped with a named note, and the
    import survives. Refusing here was tried and is strictly worse: it turns one damaged
    optional key into a total loss, and TEST-5 (`[acceptance, INV-5]`) pins the opposite for
    exactly this input.

    Every consumer inside this module already rejects the replacement: `_positive_finite`
    answers False for a string, so a sanitised `tissue_hires_scalef` drops its image with the
    note it would have got anyway, and a sanitised `microns_per_pixel` declares no scale.

    A Python `int` too large for a double is included, because `math.isfinite` RAISES on it
    rather than answering, and a predicate that raises cannot decide what damaged input costs.
    """
    replaced = []
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            clean, hits = json_safe_vendor_numbers(value, path + (str(key),))
            out[key] = clean
            replaced.extend(hits)
        return out, replaced
    if isinstance(node, (list, tuple)):
        out = []
        for i, value in enumerate(node):
            clean, hits = json_safe_vendor_numbers(value, path + (str(i),))
            out.append(clean)
            replaced.extend(hits)
        return out, replaced
    if isinstance(node, bool) or not isinstance(node, (int, float)):
        return node, replaced
    try:
        if math.isfinite(node):
            return node, replaced
    except (OverflowError, TypeError, ValueError):
        pass
    where = ".".join(path) or "<root>"
    return f"unrepresentable ({node!r})", [where]


def refuse_unencodable_vendor_text(node, *, source, remedy):
    """REFUSE a parsed vendor document carrying text this platform could not write.

    Refused rather than repaired (`vendor-text-encodability-refusal.md` §6.5 INV-4): these
    strings become the run's identity and its provenance, and a replaced character in a
    `library_ids` is a silently altered sample AND a silently altered coordinate frame.
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
        # what lets the #336 structural guard PROVE it. It is not decoration: `focus` is
        # INTERPOLATED into the funnel's own output ("the offending unit is at {focus}"), so an
        # unprovable value there is the same hole one keyword over.
        f"Unicode and cannot be written: {_quoted_for_refusal(text, int(at))}. {diagnosis}. It "
        "is refused rather than repaired, because these strings become the run's identity and "
        "its provenance, and a replaced character in a `library_ids` is a silently altered "
        "sample AND a silently altered coordinate frame -- three different invalid byte strings "
        "would all emit the one identifier and the one `coordinate_space`, which is the false "
        "collision this importer exists not to make. Left in, it would either abort the writer "
        "after the coordinate store was already on disk, or ship a report no strict JSON reader "
        f"can parse. {remedy}"
    )


def decoded_h5_strings(group, name, label=None):
    """A 10x h5 string dataset as `list[str]`, decoded STRICTLY and refused BY NAME.

    These values are JOIN KEYS — a barcode is what this importer joins the positions table
    on, a feature id is what a gene list is matched against — so a loose decode would pair
    one bin's position with another bin's counts. An absent member, a rank-0 scalar, an
    `h5py.Empty` null dataspace and a GROUP where a dataset belongs are all named refusals
    rather than raw `KeyError`/`ValueError`/`TypeError` tracebacks.
    """
    label = label or f"/matrix/{name}"
    # THE RAW DATASET READ IS GUARDED (#650) -- the last door #648's sweep found on the
    # dataset reads. `group[name][:]` MATERIALISES the declared array: a corrupted chunk /
    # unavailable filter raises `OSError` (MEASURED on this base through the shipped
    # entrypoint: a fletcher32-corrupt `/matrix/barcodes` gave rc 1 and a raw traceback at
    # this exact line, 0 paths), a rank-0 / null dataspace raises ValueError, a GROUP of
    # that name raises TypeError, and file-declared dims exceeding C ssize_t raise
    # OverflowError (non-integer/negative dims raise ValueError on the numpy path) -- all
    # four are now named refusals. A length merely too large to ALLOCATE is `MemoryError`,
    # which is in NO tuple here and still escapes as rc 1 + traceback: the #468/#475
    # work-bound class, a recorded follow-up (DEC-12). The re-raise is handler 0 (it was
    # second, after `KeyError` -- behaviourally invisible in a one-expression try, which is
    # exactly why the structural canary pins the order, #517). NARROW in POSITION: only the
    # read is wrapped; the decode loop below is a SIBLING AFTER the try.
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
    except (TypeError, ValueError, RuntimeError, OverflowError) as exc:
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` cannot be read as a list of values "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). A 10x "
            f"feature-barcode matrix stores it as a "
            "one-dimensional dataset; this file has something else there."
        ) from None
    except OSError as exc:
        # THE MEMBER IS PRESENT but its BYTES cannot be read -- an unavailable filter, a
        # truncated chunk, a checksum failure. The refusal says the bytes could not be read
        # and does NOT claim the dataset is absent: the link exists, its content does not
        # decode (the sibling's rule, import_visium.py:1119-1137).
        raise VisiumImportError(
            f"{MATRIX_BASENAME}'s `{label}` is present but its bytes cannot be read "
            f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
            "matrix stores it as a one-dimensional dataset; a dataset whose bytes cannot "
            "be read (an unavailable filter, a truncated chunk, a checksum failure) is not "
            "a matrix this importer can carry. Refusing rather than importing a matrix "
            "whose identities cannot be read."
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
                "it cannot be decoded loosely without silently pairing one bin's position with "
                "another bin's counts. Re-export the bundle from Space Ranger."
            ) from None
    return out


# ── resolving the twelve declared members into three bins ────────────────────────────


def declared_bin_layout():
    """`{bin_um: {role: declared-member-path}}` and `{ordinal: (bin_um, role)}`, DERIVED.

    Both maps come from [`DECLARED_MEMBERS`] and [`MEMBER_ROLES`] rather than being written
    out a second time, so a container that reorders a bin's members cannot leave a hand-typed
    mapping stale. The ordinal map is what the flattened staging layout is read through: the
    ordinal a file was staged at IS its index in the declared member list.
    """
    by_bin, by_ordinal = {}, {}
    for ordinal, member in enumerate(DECLARED_MEMBERS):
        head = member.split("/", 1)[0]
        match = BIN_DIR_RE.match(head)
        if not match:
            raise VisiumImportError(
                f"the declared member list carries {_quoted_for_refusal(member, noun='member')}, "
                f"whose first segment is not a `square_NNNum` bin directory. This importer's "
                "copy of the container's member list is out of step with the container; it is "
                "checked by `tests/test_locate_bins.py` and should never reach a user."
            )
        bin_um = int(match.group(1))
        role = MEMBER_ROLES[len(by_bin.get(bin_um, {}))]
        by_bin.setdefault(bin_um, {})[role] = member
        by_ordinal[ordinal] = (bin_um, role)
    return by_bin, by_ordinal


#: A `square_NNNum` path segment, the one segment that says which bin a file belongs to.
RE_BIN_SEGMENT = re.compile(r"^square_(\d+)um$", re.IGNORECASE)


def _inside_a_bin_directory(path):
    """Is this file under SOME `square_NNNum/` directory?

    The question `_named` needs when it is scoped to one bin: a file under another bin is
    evidence about that bin, and a file under no bin at all is evidence about the RUN. Only
    the first must be excluded. Asked on the path segments rather than on the parent, because
    a bin's `spatial/` subdirectory is one level further down.
    """
    return any(RE_BIN_SEGMENT.match(part) for part in Path(path).parts)


def _named(files, basename, scope, layout):
    """Every staged file whose name IS `basename`, scoped to one bin where that is meaningful.

    EQUALITY, not `endswith`. The first cut matched on a suffix so that the flattened staging
    layout's `7_tissue_lowres_image.png` would be found -- and a suffix test also adopts
    `run2_tissue_lowres_image.png` as THE lowres image and `old_metrics_summary.csv` as the
    run's metrics, silently, because these are optional members that report nothing when they
    are simply absent. The ordinal prefix is stripped explicitly instead, which finds exactly
    what staging writes and nothing that merely ends the same way.

    Under the path-preserving layout the search is confined to the bin's own `spatial/`
    directory PLUS everything that is not inside ANY bin -- and the second half is not a
    loosening, it is the correction of one.

    The first cut of this scoping excluded a file simply because its parent was not the bin's
    directory. That is right for a picture belonging to ANOTHER bin, which is what the rule
    was written for; it is wrong for a RUN-ROOT file, because the vendor's own layout
    (`01-file-formats.md:568-575`) puts `cytassist_image.tiff`, `aligned_fiducials.jpg`,
    `detected_tissue_image.jpg` and `aligned_tissue_image.jpg` in the run's `spatial/`
    directory, not under a bin. MEASURED across the two commits: with a CytAssist image and a
    fiducials image at the bundle root, the pre-scoping build reported both
    (`images_not_emitted` naming the CytAssist file, `diagnostics_embedded` naming the
    fiducials); the scoped build reported `[]` for both -- indistinguishable from a bundle
    that carries neither, while `NON_PLACEABLE_VENDOR_IMAGES`' own text still promises "it is
    reported here instead". §7.2 requires exactly that report.

    So the test is "not another bin's", which is what was actually meant, rather than "inside
    this bin's".

    ## And the run root is a FALLBACK, not a UNION — which the first cut of this got wrong

    The same citation that puts the diagnostics in the run's `spatial/` puts
    `tissue_hires_image.png` and `tissue_lowres_image.png` there too, one line above them.
    So on the DOCUMENTED layout a plain union matches the run-root copy AND the bin's own
    copy of the same basename, `len(hits) > 1`, and the caller reports the member as
    AMBIGUOUS -- which for the lowres image means the artifact the pre-scoping build emitted
    is not emitted at all. An artifact LOST, not a note gained; and the diagnostics collapse
    the same way from the other side, back to the `[]` this scoping was written to stop.

    A bundle that carries both is not ambiguous, though. The bin's own copy is the one that
    belongs to the bin, by the same reasoning that excludes another bin's. So the search is
    LAYERED: if the bin's own directory has the file, that is the answer; the run root is
    consulted only when it does not. Ambiguity within one layer is still ambiguity, which is
    what keeps two copies inside the bin's own `spatial/` from being resolved by sort order.
    """
    local, rooted = [], []
    for path in files:
        name = path.name.lower()
        head, _, tail = name.partition("_")
        if not (name == basename or (head.isdigit() and tail == basename)):
            continue
        if layout != "path-preserving" or scope is None or path.parent == scope:
            local.append(path)
        elif not _inside_a_bin_directory(path):
            rooted.append(path)
    return local or rooted


def _bin_from_scalefactors(doc):
    """The `bin_size_um` a scale document DECLARES, as an `int`, or `None`.

    `bin_size_um` is one of the two fields `01-file-formats.md:602` records as Visium HD's
    own, and it is the only statement inside the bundle about which resolution a group of
    files IS. Everything else — the directory name, the staging ordinal — is a statement
    about where the file sits.

    Non-integral, non-finite, boolean and absent values all return `None` rather than
    raising: this is a QUESTION, and its caller decides what an unanswerable one costs.
    """
    value = doc.get("bin_size_um")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        if not math.isfinite(value) or value <= 0:
            return None
    except (OverflowError, TypeError, ValueError):
        # `math.isfinite` RAISES on a Python `int` too large for a double, which
        # `json.loads` produces from a long integer literal. A predicate that raises on
        # damaged input cannot be used to decide what damaged input costs.
        return None
    if float(value) != int(value):
        return None
    return int(value)


def _ordinal_of(path, slot_ordinals):
    """The staging ordinal of one staged file, or `None`.

    Two sources, in order of authority: `inputs.json`'s own slot names (`bundle_7` -> 7),
    which the server WROTE; and the `{i}_` filename prefix, which the server also wrote but
    which a user could in principle reproduce by hand. Falling back to the prefix is what
    lets a test — and a developer running the entry by hand — build the staged layout without
    also hand-writing an `inputs.json`.
    """
    if slot_ordinals is not None and path in slot_ordinals:
        return slot_ordinals[path]
    head = path.name.split("_", 1)[0]
    return int(head) if head.isdigit() else None


def locate_bins(root, slot_ordinals=None):
    """`{bin_um: {role: Path}}` for every bin present, VERIFIED against the data.

    ## Two layouts, because the platform really does present two

    **(a) PATH-PRESERVING.** A tree that still has its `square_NNNum/` directories — an
    archive expanded on a host path, a developer pointing the entry at an `outs/`. Resolved
    on the `square_NNNum/` segment, which is exactly the segment the container declares and
    the reason #160 could express this bundle at all.

    **(b) FLATTENED BY ORDINAL.** What a real sandbox actually gets.
    `dataset/process.rs::build_dataset_inputs` binds a multi-file dataset's files at
    `{slot}_{i}` with sandbox subpath `{i}_{basename}`, so `/inputs` holds twelve files whose
    names carry no bin at all. The ordinal IS the index into the declared member list — that
    is the contract
    `spatial-types/tests/test_hd_bundle_container.py::test_the_declared_member_ORDER_is_pinned`
    freezes, and whose own docstring calls it "deliberately unpleasant to update" and names
    the real repair as making staging carry the path.

    THAT REPAIR IS TRACKED AS #360, and the number is written HERE, in the shipped module.
    `spatial-storage-layout.md` §6.7 says a directory-aware member matcher must be "filed as
    a `[shared]` platform item, **not** worked around in the importer"; this module does read
    both layouts, so the deferral is real and the pointer is the whole of what makes it
    honest. #313 exists because `import_visium.py` sent its reader to #160 AFTER #160 closed
    -- and a deferral naming no issue at all fails the same reader one step earlier.

    ## The answer is then CHECKED, which is what makes leg (b) safe to rely on

    A group resolved either way must agree with the `bin_size_um` its OWN
    `scalefactors_json.json` declares. Under leg (b) that is the difference between an
    importer that reads a contract and one that trusts it: a staging change that reordered
    the ordinals would otherwise import the 16 um matrix while stamping every artifact 2 um,
    silently, with every internal check still passing.

    The strictness follows the strength of the evidence, deliberately. Under leg (b) the
    ordinal is the ONLY evidence, so a group whose scale file declares no `bin_size_um` is
    REFUSED — there is nothing to corroborate it with. Under leg (a) the path names the bin
    directly, so a missing `bin_size_um` is recorded and the path stands.

    ## Every located member realpaths under the bundle root (option 1, #508 OWNER DECISION)

    The ONE containment check at the end of this locator enforces the #508 owner
    decision's option-1 rule: every path-bearing member — each bin's `matrix`,
    `positions`, `scalefactors` and `image`, every `extra_images[i]["path"]`, every
    `diagnostics` element and `metrics` when present — AND every located candidate of
    the presence-only / ambiguous members must realpath under
    `realpath(root) + os.sep` (both sides realpath'd: the staged root IS the
    `/inputs/<name>` symlink), or `locate_bins` refuses the member by name at rc 2 with
    zero output paths, before the first writer. The non-path values
    (`bin_size_um_declared` bool, `bin_um` int, `layout` str, `metrics = None`, the
    `ambiguous_images` basename strings and the `non_placeable_images` spec dicts) are
    EXEMPT BY CONSTRUCTION and never reach `os.path.realpath` — the two measured
    over-refusal traps do not exist here. The containment check runs at the END of this
    locator; `_refuse_outside_matrix_objects` remains the same-FILE HDF5-object check
    that runs when the matrix file is opened — containment first, that same-FILE walk
    on top of the member-level rule.
    """
    root = Path(root)
    if root.is_file():
        root = root.parent
    by_bin, by_ordinal = declared_bin_layout()

    files = [p for p in sorted(root.rglob("*")) if p.is_file()]
    if not files:
        raise VisiumImportError(
            f"there are no files under {_quoted_for_refusal(root)} to import. A "
            "`spatial/visium-hd-bundle` dataset carries twelve declared members -- the "
            "matrix, the parquet tissue positions, the scale factors and the tissue image "
            "of each of the three square-bin resolutions."
        )

    # ── leg (a): the tree still names its bins ──────────────────────────────────────
    located, layout = {}, None
    for bin_um, roles in by_bin.items():
        found, parents = {}, {}
        for role, member in roles.items():
            # The member's OWN segment count, matched at the SUFFIX — the core's rule
            # (`dataset/repository.rs::matches_member`), applied here so this importer and the
            # upload planner agree about what a member is. Anchoring at the suffix rather than
            # at the whole relative path is what lets the bundle's root directory be whatever
            # the user called it.
            wanted = tuple(s.lower() for s in member.split("/"))
            hits = [p for p in files
                    if tuple(s.lower() for s in p.parts[-len(wanted):]) == wanted]
            if len(hits) == 1:
                found[role] = hits[0]
                # WHICH `square_NNNum` DIRECTORY it came out of. Each member is matched at the
                # SUFFIX over the whole tree -- the core's own rule, and the reason a bundle's
                # root directory can be called anything -- but that means four members can
                # resolve into four DIFFERENT trees and still each be unique. Recorded here so
                # the check below can refuse that; see it for what it costs not to.
                parents[role] = hits[0].parts[:len(hits[0].parts) - len(wanted)]
            elif len(hits) > 1:
                raise VisiumImportError(
                    f"the bundle offers {len(hits)} candidates for the declared member "
                    f"{_quoted_for_refusal(member, noun='member')} "
                    f"{_quoted_list_for_refusal([p.relative_to(root) for p in hits])}. Member "
                    "matching is unambiguous by design; choosing one here would be a guess "
                    "about which run's data this is."
                )
        if len(found) == len(MEMBER_ROLES):
            # ONE RUN, not four files that each happen to be unique. MEASURED on this
            # package's own fixture: put a copy of the tree under `leftover/` with its
            # positions table shifted 5,000 px, delete the original bin's positions table, and
            # the bin assembles from TWO directories -- import succeeds, `bundle_layout` reads
            # `path-preserving`, and the tissue map is 5,000 px out. The registration QC does
            # say `fail`, but the report records only basenames, so the mixture itself is
            # unauditable. A bundle whose members come from different places is not a bundle.
            roots = set(parents.values())
            if len(roots) > 1:
                raise VisiumImportError(
                    f"the {int(bin_um)} um bin's four declared members do not come from one "
                    f"directory: they resolve under "
                    f"{_quoted_list_for_refusal(['/'.join(r[-3:]) for r in sorted(roots)], noun='path')}. "
                    "Each member is matched on the path segments it declares, so four files "
                    "from four places can each be unique and still not be one run -- and a "
                    "bundle assembled that way imports cleanly with its squares in the wrong "
                    "place. Upload one Space Ranger `binned_outputs/` tree."
                )
            located[bin_um] = found
    if located:
        layout = "path-preserving"

    # ── leg (b): the flattened staging layout ───────────────────────────────────────
    if not located:
        by_role = {}
        for path in files:
            ordinal = _ordinal_of(path, slot_ordinals)
            if ordinal is None or ordinal not in by_ordinal:
                continue
            bin_um, role = by_ordinal[ordinal]
            # The BASENAME still has to be the one the declared member names. Without this,
            # a staged directory with an unrelated `7_notes.txt` would be read as the 8 um
            # bin's tissue image — the ordinal says where a file sits, not what it is.
            if path.name.split("_", 1)[-1].lower() != DECLARED_MEMBERS[ordinal].rsplit("/", 1)[-1]:
                continue
            by_role.setdefault(bin_um, {})[role] = path
        located = {b: r for b, r in by_role.items() if len(r) == len(MEMBER_ROLES)}
        if located:
            layout = "flattened-by-staging-ordinal"

    if not located:
        raise VisiumImportError(
            f"this is not a Visium HD bundle this importer can read. Under "
            f"{_quoted_for_refusal(root)} it found no complete `square_NNNum` bin -- neither "
            "as a `binned_outputs/square_NNNum/` tree nor as the ordinal-prefixed flat "
            "layout the platform stages a multi-file dataset as. A complete bin needs all "
            f"four of its declared members {_quoted_list_for_refusal(MEMBER_ROLES, noun='role')}. "
            "If this is a standard (non-HD) Visium `outs/` bundle, import it with `Import "
            "Visium (Space Ranger)` instead; a Visium HD run always writes at least the 2 um, "
            "8 um and 16 um bins."
        )

    # ── EVERY DECLARED BIN, or none ─────────────────────────────────────────────────
    #
    # The container declares twelve members — four files for each of the three bins Space
    # Ranger writes by default — and the upload route REFUSES a bundle missing any of them by
    # name (`MANIFEST_GROUP_INCOMPLETE`). `spatial-types/manifest.yaml` states that assumption
    # and states this failure mode for it: "a loud, self-explaining failure rather than a
    # silent partial import. That is the correct failure mode for an assumption that could not
    # be checked against real bytes."
    #
    # THAT REFUSAL IS TRUE ONLY FOR A LOOSE-FILE (FOLDER-MODE) UPLOAD; that paragraph is
    # corrected rather than removed, because a disclosure of absence and its retirement are
    # the same claim in two directions. An ARCHIVE upload of this declared type takes a
    # different path: `dataset/routes.rs`'s `archives_only` escape (in the
    # `ManifestGroupOutcome::Gap` arm) fires when every declared member is missing and
    # every uploaded filename is an archive (`is_archive_name`), and when it fires the
    # `MANIFEST_GROUP_INCOMPLETE` refusal is SKIPPED — the archive is stored as-is
    # (`opaque_as_is`) and its contents are never expanded or re-checked against the
    # declared member list anywhere in the server (there is no archive expansion in
    # src-app/server at all). So a bundle reaching this importer incomplete via
    # the archive arm is a real, expected state, and the refusal below is the importer's own.
    #
    # So the importer mirrors the container rather than being laxer than it. Two reasons, and
    # the second is the dangerous one:
    #
    #   1. A bundle the upload route would refuse must not import through a host path or a
    #      developer's tree either, or the product has two different answers to "is this a
    #      Visium HD bundle" depending on how it arrived.
    #   2. In the FLATTENED layout the ordinal is an index into the twelve-member list. With a
    #      bin absent there are eight staged files, the ordinals still run 0..7, and the third
    #      bin's members land at the SECOND bin's positions. The `bin_size_um` check below
    #      catches that — but it catches it as "the bundle's files disagree with themselves",
    #      which is a true statement about a confusing thing rather than the plain one.
    #      Refusing here says what is actually wrong.
    missing_bins = [b for b in sorted(by_bin) if b not in located]
    if missing_bins:
        raise VisiumImportError(
            f"this bundle carries only the "
            f"{_quoted_list_for_refusal(sorted(located), noun='bin size')} um bin(s); the "
            f"{_quoted_list_for_refusal(missing_bins, noun='bin size')} um bin(s) are absent "
            "or incomplete. A `spatial/visium-hd-bundle` declares all twelve members -- four "
            "files for each of the three bins Space Ranger writes by default -- and an upload "
            "missing any of them is refused by name rather than grouped, and that refusal is "
            "enforced for a loose-file (folder-mode) upload. A bundle that reaches this "
            "importer incomplete via the ARCHIVE arm is a real, expected state -- the archive "
            "route stores it as-is and never re-checks it against the declared member list -- "
            "and this importer refuses it by name here. Re-export the complete Space Ranger "
            "`binned_outputs/` with all three bins."
        )

    # ── the verification, on both legs ──────────────────────────────────────────────
    verified = {}
    for bin_um in sorted(located):
        roles = located[bin_um]
        declared = _bin_from_scalefactors(read_scalefactors(roles["scalefactors"]))
        if declared is None:
            if layout == "flattened-by-staging-ordinal":
                raise VisiumImportError(
                    f"the file staged as the {int(bin_um)} um bin's "
                    f"`{SCALEFACTORS_BASENAME}` "
                    "declares no usable `bin_size_um`, and in this layout the staging ordinal "
                    "is the ONLY thing that says which resolution these files are. Importing "
                    "on the ordinal alone would stamp every artifact with a bin size nothing "
                    "in the bundle confirms. Re-upload the bundle as an archive so the "
                    "`square_NNNum/` directories are retained, or re-export it from Space "
                    "Ranger with complete scale factors."
                )
            roles = dict(roles, bin_size_um_declared=False)
        elif declared != bin_um:
            raise VisiumImportError(
                f"the {int(bin_um)} um bin's own `{SCALEFACTORS_BASENAME}` declares "
                f"`bin_size_um` = {int(declared)}, not {int(bin_um)}. The bundle's own files "
                "disagree with the position they were presented at, so importing either "
                "number would be a guess about which resolution this data is -- and the "
                "resulting artifacts would be stamped with a bin size that is not the one "
                "the counts came from. Re-upload the bundle as an archive so the "
                "`square_NNNum/` directories are retained."
            )
        else:
            roles = dict(roles, bin_size_um_declared=True)
        verified[bin_um] = dict(roles, bin_um=bin_um)

    # The OPTIONAL members, located per bin by basename WITHIN that bin's own directory (leg
    # a) or by ordinal-free basename across the flat dir (leg b). Optional throughout: an
    # ambiguous match is reported rather than resolved, because an optional member that
    # vanishes in silence is what `images_not_emitted` exists to prevent.
    for bin_um, roles in verified.items():
        scope = roles["scalefactors"].parent if layout == "path-preserving" else root
        roles["extra_images"], roles["ambiguous_images"] = [], []
        for spec in VENDOR_IMAGES[1:]:
            hits = [p for p in _named(files, spec["basename"], scope, layout)]
            if len(hits) == 1:
                roles["extra_images"].append(dict(spec, path=hits[0]))
            elif len(hits) > 1:
                roles["ambiguous_images"].append(spec["basename"])
        roles["non_placeable_images"] = [
            spec for spec in NON_PLACEABLE_VENDOR_IMAGES
            if _named(files, spec["basename"], scope, layout)
        ]
        # AMBIGUOUS DIAGNOSTICS ARE DROPPED, not taken first. These are report-only images and
        # nothing computes from them, but "the first file whose name ends in
        # `aligned_fiducials.jpg` anywhere in the tree" can be another run's, and an archive
        # upload really does carry three copies (one per bin). A diagnostic from the wrong bin
        # is a picture a human reads as evidence about THIS one.
        roles["diagnostics"] = [
            hits[0] for name in DIAGNOSTIC_BASENAMES
            for hits in [_named(files, name, scope, layout)] if len(hits) == 1
        ]

    # A RUN-ROOT file, so it is NOT scoped to a bin directory -- `scope=None` says so rather
    # than leaving `_named`'s third argument to be read as an oversight.
    metrics = _named(files, "metrics_summary.csv", None, layout)

    # ── THE ONE CONTAINMENT CHECK (#508 OWNER DECISION, option 1) ─────────────────────
    #
    # "every bundle member must realpath to a path under the bundle root" -- the owner's
    # one-line option-1 rule on #508 (the sibling's owner decision), realized at HD's own
    # seam and quoted here verbatim. This locator's return dict is the ONLY way any
    # consumer reaches a bundle member (`run_import` picks one bin and reads through it at
    # the `run_import` -> `locate_bins` call, `run_import` :2426; the report reads the
    # same dict), so ONE check at its END is the single choke point: it covers every bin's
    # selections (2/8/16 um -- the locator always returns all three) and every candidate.
    # MEASURED before writing this predicate, the traps it exists to dodge:
    #
    #   (i)   THE STAGED ROOT IS A SYMLINK. The STAGING HARNESS (each suite's own
    #         `_staged` helper — tests/test_508_bundle_containment.py :106 and
    #         tests/test_refusals.py :62; `_entry_invocation` itself only writes
    #         `params.json`/`inputs.json`) mounts `/inputs` through the
    #         `/inputs/<name>` symlink, and `load_inputs_index` returns it unresolved,
    #         so `str(root)` is `<tmp>/inputs/real-bundle` while every member realpaths
    #         under `<tmp>/real-bundle` -- comparing against `str(root)` refuses EVERY
    #         staged bundle (measured). Hence the comparison realpaths BOTH sides:
    #         `realpath(member)` against `realpath(root) + os.sep` (the `os.sep` so a
    #         sibling directory named like the root cannot prefix-match).
    #   (ii)  THE NON-PATH MEMBER VALUES NEVER REACH realpath. `ambiguous_images` are
    #         BASENAME STRINGS (realpath of a bare basename resolves against the
    #         process CWD), `non_placeable_images` are spec DICTS (realpath of a dict
    #         is a TypeError), `bin_size_um_declared` is a BOOL, `bin_um` is an int,
    #         `layout` is a str, and the LOCAL `metrics` binding is a LIST
    #         (`_named(...)` always returns a list) — appending the list itself would
    #         realpath a LIST and TypeError on EVERY bundle, so only the RETURNED
    #         member value is a path: the list's SOLE element when the locator found
    #         exactly one `metrics_summary.csv` (that unique-hit element is what the
    #         `located_paths` leg appends), and `None` on the folder-upload arm
    #         (realpath(None) is a TypeError — `None` is skipped, never realpath'd).
    #         So `located_paths` is built PATH-ONLY BY CONSTRUCTION: the four declared
    #         roles of every bin, the `["path"]` of every extra image, every diagnostic,
    #         and the `metrics` list's sole element. Never a str()-ed value, never the
    #         list.
    #   (iii) F-1: THE AMBIGUOUS / PRESENCE-ONLY MEMBERS STORE NO PATH AT ALL. An
    #         ambiguous match keeps `extra_images` empty, `diagnostics` empty and
    #         `metrics = None`, so the stored values alone would miss an outside-
    #         resolving second candidate (measured: a run-root lowres copy is
    #         ADOPTED by `_named`'s layered fallback into `extra_images[0]["path"]`;
    #         two lowres candidates in one `spatial/` store only the basename
    #         string). So the check ALSO walks every `_named` candidate of the seven
    #         member basenames -- the two `VENDOR_IMAGES`, the one
    #         `NON_PLACEABLE_VENDOR_IMAGES`, the three `DIAGNOSTIC_BASENAMES` and
    #         `metrics_summary.csv` -- with `scope=None`, so the flattened layout's
    #         `{i}_`-prefixed spellings are covered by the locator's OWN name test.
    #   (iv)  PLACEMENT NUANCE: this site is AFTER the per-bin
    #         `scalefactors_json.json` verification READ at `locate_bins` :1111
    #         (`_bin_from_scalefactors(read_scalefactors(...))`) -- a READ only; the
    #         first writer is `write_csc_zarr`, so the refusal contract here is rc 2,
    #         zero output paths, before the first WRITER (not "before any read"). The
    #         matrix member-level check is just another member here ("the matrix is
    #         just another located member"); `_refuse_outside_matrix_objects`'s
    #         same-FILE HDF5-object walk remains, and runs on top of that member-level
    #         rule -- containment first, then the walk.
    #
    # CEILING, INHERENT TO OPTION 1: containment is by resolved path, not by inode. A
    # member hard-linked from outside shares the bundle's inode and is not caught -- its
    # resolved path IS the bundle's, while some of its bytes also exist outside. The
    # owner's option 1 is a path-containment rule; hard links are outside it by
    # construction.
    #
    # BOUNDARY OF THE NAMED REFUSAL (= "must name the member and where it resolved to" is
    # scoped to the containment check itself): an outside-resolving shape that fails
    # EARLIER refuses with a DIFFERENT message — still rc 2 with zero output paths (the
    # safe direction: no outside bytes import at rc 0), but it names its own subject
    # rather than member + resolved path. Two such shapes are known: a
    # `scalefactors_json.json` that resolves outside and DECLARES a `bin_size_um` that
    # disagrees with the bin it was presented at refuses at the verification READ above
    # ("the bundle's own files disagree"), and a member reached THROUGH a SYMLINKED
    # DIRECTORY is never enumerated into `files` at all, so the bundle fails already as
    # "no complete `square_NNNum` bin" / "not a Visium HD bundle" before this check runs.
    located_paths = (
        [roles[role] for roles in verified.values() for role in MEMBER_ROLES]
        + [extra["path"] for roles in verified.values()
           for extra in roles["extra_images"]]
        + [p for roles in verified.values() for p in roles["diagnostics"]]
        + ([metrics[0]] if len(metrics) == 1 else [])
    )
    for basename in ([spec["basename"] for spec in VENDOR_IMAGES]
                     + [spec["basename"] for spec in NON_PLACEABLE_VENDOR_IMAGES]
                     + list(DIAGNOSTIC_BASENAMES) + ["metrics_summary.csv"]):
        located_paths.extend(_named(files, basename, None, layout))
    for p in located_paths:
        if not (_resolved := os.path.realpath(p)).startswith((root_real := os.path.realpath(root)) + os.sep):
            raise VisiumImportError(
                f"{_quoted_for_refusal(p.name, noun='member name')} resolves to "
                f"{_quoted_for_refusal(_resolved, noun='resolved path')} (it was located "
                f"at {_quoted_for_refusal(p, noun='located path')}), which is outside the "
                "bundle root. Every bundle member must realpath to a path under the "
                "bundle root: a member whose bytes come from outside the bundle root is "
                "not part of the Visium HD bundle this importer can verify. Refusing "
                "rather than importing a bundle member whose bytes come from outside the "
                "bundle root."
            )
    return {
        "layout": layout,
        "bins": verified,
        # Read for provenance and the report only. A run-root file, so it is NOT a declared
        # member and is simply absent on the folder-upload arm.
        "metrics": metrics[0] if len(metrics) == 1 else None,
        "root": root,
    }


# ── the vendor documents ─────────────────────────────────────────────────────────────


#: Where `read_scalefactors` records the key paths whose numbers it had to replace. A
#: dunder-ish spelling no vendor writes, so it cannot collide with a real scale key.
UNREPRESENTABLE_KEYS = "__txr_unrepresentable_numbers__"


def read_scalefactors(path):
    """`scalefactors_json.json` -> a dict, or `{}` when it cannot be parsed.

    UNPARSEABLE DEGRADES, UNWRITABLE REFUSES, and the difference is deliberate: a scale file
    this importer cannot read leaves the coordinate space with NO declared scale (which
    `SD.require_micron_scale` then refuses on the consumer side, so nothing measures in
    micrometres by accident), while a scale file carrying text this platform could not write
    is refused outright, because that text becomes the run's identity.

    `encoding="utf-8"` is EXPLICIT. At the locale default, an ORDINARY bundle whose scale
    file carries legitimate UTF-8 raises `UnicodeDecodeError` under `LC_ALL=C` — which, being
    a `ValueError`, is swallowed into `{}` here, and the run then reports "no scale declared"
    about a file that declares one. That is a false statement about the vendor's document,
    produced by the machine's locale (#330/#333/#336/#339).

    `RecursionError` is caught beside `ValueError` because it subclasses `RuntimeError`, not
    `ValueError`: `json.loads` raises it at nesting depth >= 992, and a document too deep for
    the parser is exactly what this arm is for.
    """
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError, UnicodeDecodeError):
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
    # UNWRITABLE NUMBERS, at the same boundary -- but replaced rather than refused, for the
    # reason `json_safe_vendor_numbers` records. The whole document is copied verbatim into
    # the report, so a non-finite value in a key this importer never reads is still a value
    # this run has to be able to WRITE. The replaced key paths ride on the returned dict under
    # a NAME OF THIS MODULE'S OWN, so the report can disclose them and nothing mistakes them
    # for a vendor key.
    doc, replaced = json_safe_vendor_numbers(doc)
    if replaced:
        doc[UNREPRESENTABLE_KEYS] = replaced
    return doc


def _positive_finite(value):
    """A vendor number that can be divided by. TOTAL over every JSON value.

    `bool` is excluded deliberately: it is an `int` subclass, so `True` would otherwise read
    as a scale of 1.0. `json.loads` also accepts `Infinity`, which passes `> 0` and then
    makes every derived ratio 0.0 or `nan`. And `math.isfinite` ITSELF RAISES on a Python
    `int` too large for a double, which `json.loads` produces from a long integer literal —
    so a predicate that raises on damaged input cannot deliver "a bundle with a damaged scale
    file is still importable; it simply declares no scale".
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and value > 0
    except (OverflowError, TypeError, ValueError):
        return False


def micron_scale(scalefactors):
    """`(microns_per_pixel_or_None, source)` — the physical scale of the pixel frame.

    TWO legs for Visium HD, where the sibling has three, and the missing one is the point.

    1. the vendor STATES `microns_per_pixel` -> use it VERBATIM (`"vendor"`);
    2. it does not -> `(None, "unavailable")`. No `microns_per_pixel` key is written and
       `SD.require_micron_scale` REFUSES on the consumer side. Never 1.0.

    **There is deliberately no derive-from-`spot_diameter_fullres` leg.** On standard Visium
    that leg exists because `scalefactors_json.json` ships four keys and none of them is
    `microns_per_pixel` — and getting its NUMERATOR wrong was #222 (15.4 % low on every
    import) and then #257 (one slide design's rendered circle applied to another). Visium HD
    writes `microns_per_pixel` itself (`01-file-formats.md:602`), so the derivation has no
    reason to exist here, and not writing it is what makes those two defect classes
    unreachable rather than merely fixed.

    **What `spot_diameter_fullres` MEANS on an HD bundle is NOT ESTABLISHED HERE.** An
    earlier draft of this docstring asserted it is "the bin's side in full-resolution pixels,
    not a rendered circle". That claim carried no citation and this repo's only description of
    the field contradicts its shape: a direct 10x quote that it "is intended for visualization
    purposes, and can vary for different slide designs, ranging from 60-70 um"
    (`01-file-formats.md:611-612`), with no HD carve-out -- and #257 is the defect of taking
    one reading of that field to be true of every bundle. So this module makes NO claim about
    it, DERIVES nothing from it, and passes the vendor's number through under the vendor's own
    key. The scale comes from `microns_per_pixel` alone, and the registration check's referent
    is the bin lattice pitch, which is independent of this field entirely.
    """
    stated = scalefactors.get("microns_per_pixel")
    if _positive_finite(stated):
        return float(stated), "vendor"
    # THE VENDORED CONSTANT, not a hand-copied literal. `SD.SCALE_SOURCE_UNAVAILABLE` is the
    # one string `coordinate_space` accepts beside a MISSING scale; spelling it here made this
    # module's copy independent of the contract it has to satisfy, so a rename in
    # `spatial-declarations` would have shown up as a declaration refusal at run time rather
    # than as a red byte-comparison.
    return None, SD.SCALE_SOURCE_UNAVAILABLE


# ── the bin choice ───────────────────────────────────────────────────────────────────


def select_bin(available, requested):
    """`(bin_um, chose_by)` — which bin this run imports.

    `chose_by` is `"parameter"` or `"default"`, and it is RECORDED rather than inferred: a
    run that asked for 8 um and a run that got 8 um because nobody asked are the same
    artifacts and different decisions, and the report has to be able to tell them apart.

    `requested` may be a NUMBER or a STRING that denotes an exact integer (issue #361): the
    declarative select is string-valued at the kit level, so the form passes "8" rather than
    8. A string is parsed to its integer and treated exactly like that number; anything that
    is not an exact integer is refused by name, as before.
    """
    if requested is None:
        if DEFAULT_BIN_UM not in available:
            raise VisiumImportError(
                f"this bundle carries no {int(DEFAULT_BIN_UM)} um bin, which is the "
                "resolution this importer reads when a run does not name one. It carries "
                f"{_quoted_list_for_refusal(sorted(available), noun='bin size')}. Re-run this "
                f"import with the `{BIN_PARAM}` parameter set to one of those."
            )
        return DEFAULT_BIN_UM, "default"
    # `bool` first: it is an `int` subclass, so `True` would otherwise read as the 1 um bin.
    if isinstance(requested, bool):
        raise VisiumImportError(
            f"the `{BIN_PARAM}` parameter is {_quoted_for_refusal(requested, noun='value')}, "
            "which is not a bin size. It must be one of the square-bin resolutions this "
            f"bundle carries: {_quoted_list_for_refusal(sorted(available), noun='bin size')}."
        )
    # THE STRING ARM (issue #361). The declarative select is STRING-valued at the kit level
    # (`sdk/packages/kit`'s `ValueBinding<string>`), so the form passes the chosen bin as a
    # STRING — "8", not 8 — and the compute is the side that parses it. A string that
    # denotes an exact integer ("8", " 16 ", "08") is normalized to that int and falls
    # through to the same checks as a number; anything else is refused exactly as a
    # non-number was before.
    #
    # This is a deliberately NARROWER, ASCII-scoped EXACT-INTEGER grammar — NOT the shared
    # decimal grammar (`_DECIMAL_BOUND` in cell-filter's compute / `DECIMAL_BOUND` in
    # `criteria.ts`), which admits a fraction and an exponent. A bin must be an INTEGER:
    # it names one of the container's `square_NNNum` directories, and a fractional or
    # exponentiated resolution is not a directory this bundle carries. `re.ASCII` is
    # load-bearing: Python's `\d` matches Unicode digits and `str.strip()` strips Unicode
    # whitespace, while the JS regex and Rust's `is_ascii_digit` are ASCII-only — without
    # it a fullwidth / Arabic-Indic digit ("８", "٨") or an NBSP / ideographic-space-padded
    # spelling would be accepted here while the exported methods text prints the raw
    # spelling and the artifacts carry 8. The strip is the same six ASCII whitespace
    # characters the shared grammar's readers trim (F2-1). The pattern also accepts a
    # leading `+`/`-` sign, which then falls through to the "not a bin this bundle
    # carries" check unless the signed value is one of the available bins.
    if isinstance(requested, str):
        stripped = requested.strip(" \t\n\r\f\v")
        if not re.fullmatch(r"[+-]?\d+", stripped, re.ASCII):
            raise VisiumImportError(
                f"the `{BIN_PARAM}` parameter is {_quoted_for_refusal(requested, noun='value')}, "
                "which is not a bin size. It must be one of the square-bin resolutions this "
                f"bundle carries: {_quoted_list_for_refusal(sorted(available), noun='bin size')}."
            )
        requested = int(stripped)
    if not isinstance(requested, (int, float)):
        raise VisiumImportError(
            f"the `{BIN_PARAM}` parameter is {_quoted_for_refusal(requested, noun='value')}, "
            "which is not a bin size. It must be one of the square-bin resolutions this "
            f"bundle carries: {_quoted_list_for_refusal(sorted(available), noun='bin size')}."
        )
    try:
        usable = math.isfinite(requested)
    except (OverflowError, TypeError, ValueError):
        usable = False
    if not usable or int(requested) != requested or int(requested) not in available:
        raise VisiumImportError(
            f"the `{BIN_PARAM}` parameter is {_quoted_for_refusal(requested, noun='value')}, "
            "which is not a bin this bundle carries. Space Ranger writes the bins "
            f"{_quoted_list_for_refusal(sorted(available), noun='bin size')} for this run, and "
            "this importer reads exactly one of them. A bin that is not in that list cannot "
            "be produced by aggregating another one here -- re-run Space Ranger with the bin "
            "you need."
        )
    return int(requested), "parameter"


def bin_choice_note(bin_um, chose_by, available):
    """The sentence the report says about the bin choice. DERIVED from [`DEFAULT_BIN_UM`].

    The number and the sentence about the number come from the same constant on purpose: the
    default is not owner-confirmed (DEC-1), so moving it has to move what the report claims
    about it, or the disclosure goes stale the moment the owner rules.
    """
    others = [b for b in sorted(available) if b != bin_um]
    tail = (
        f" The other bins this run carries — "
        f"{', '.join(f'{b} um' for b in others)} — were NOT imported and nothing was emitted "
        f"from them; re-run this import with `{BIN_PARAM}` set to one of them to get a second "
        "resolution. The two results share this run's coordinate space and differ only in "
        "`measured_entity`, which is what makes them a resolution group rather than two "
        "unrelated datasets."
        if others else
        " This bundle carries no other bin."
    )
    if chose_by == "parameter":
        return f"imported the {bin_um} um bin, named by the `{BIN_PARAM}` run parameter." + tail
    return (
        f"imported the {bin_um} um bin. No `{BIN_PARAM}` was supplied, so this importer's "
        f"default of {DEFAULT_BIN_UM} um applied — 10x's recommended analysis bin, and the "
        "resolution most analyses start at; the native 2 um grid is far sparser and far "
        "larger." + tail
    )


# ── the positions table, which is PARQUET on Visium HD ───────────────────────────────


def read_positions(path):
    """`tissue_positions.parquet` -> `{column name: list}`, for the six declared columns.

    ## Why `pyarrow.parquet` directly and not `pandas.read_parquet`

    The same reason `spatial-import-xenium/compute/boundaries.py` gives: a vendor's own
    column dtype VARIES between bundles, and going through pandas puts a dtype-coercion layer
    between this reader and the file. `in_tissue` is written `int8` by one exporter and
    `bool` by another; both mean the same thing and both must read the same way. Reading the
    arrow types directly is what makes that a stated conversion instead of a coincidence.

    ## STREAMED BY ROW GROUP, because an HD positions table is not a Visium one

    "Positions are **Parquet** (millions of squares)" (`01-file-formats.md:629`). Reading the
    whole file as one arrow table materialises every column at once; iterating row-group
    batches keeps the peak proportional to [`POSITIONS_BATCH_ROWS`]. The columns are also
    PROJECTED — only the six this importer reads are decoded — so a vendor that adds a
    thirteenth column costs nothing.

    ## What it refuses, and why each is a refusal rather than a degrade

    The positions table is not optional: without it there is no tissue map, and a bin with no
    position cannot be given one. So a file that is not parquet, a missing declared column, a
    `barcode` that is not valid UTF-8 and a non-numeric coordinate are all named refusals —
    all of them reachable BEFORE the first writer, which is what leaves zero paths behind.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    path = Path(path)
    try:
        handle = pq.ParquetFile(path)
    except Exception as exc:
        # DELIBERATELY BROAD. `pyarrow` raises its own `ArrowInvalid`/`ArrowNotImplementedError`
        # for a truncated file, a wrong magic number, an unsupported encoding and a corrupt
        # footer, and those are not one exception family — narrowing here would convert a
        # damaged vendor file into an uncaught traceback, which is the failure shape
        # `vendor-text-encodability-refusal.md` §6.5 INV-1 exists to remove.
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} is not a readable parquet "
            f"file ({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). Visium HD writes the tissue "
            "positions as parquet, not as the CSV standard Visium writes; if this file came "
            "from a standard Space Ranger `outs/`, import it with `Import Visium (Space "
            "Ranger)` instead."
        ) from None

    names = list(handle.schema_arrow.names)
    have = set(names)
    # AMBIGUOUS COLUMN NAMES ARE REFUSED, and this is not pedantry -- it is the one defect in
    # this reader that produces a plausible WRONG ANSWER rather than an error.
    # `pyarrow`'s `Schema.get_field_index` returns **-1** for a name that appears more than
    # once, and `RecordBatch.column(-1)` resolves Python-style to the LAST projected column.
    # MEASURED on this package's own fixture: append a second `pxl_row_in_fullres` column and
    # the import exits 0 with every bin on the diagonal (`all(x == y)`); duplicate `in_tissue`
    # instead and every square reads in-tissue, which also switches the registration check off
    # (`not-evaluated`) with no note anywhere. A vendor file with a repeated column is damaged,
    # and a damaged file must not be readable as a different, coherent one.
    duplicated = sorted({c for c in POSITION_COLUMNS if names.count(c) > 1})
    if duplicated:
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} declares the column(s) "
            f"{_quoted_list_for_refusal(duplicated, noun='column name')} more than once. A "
            "tissue-positions table has one column per meaning, and choosing between two "
            "columns of the same name would be a guess about which one holds the positions "
            "-- a guess that produces a complete, coherent tissue map in the wrong place "
            "rather than an error. Re-export the bundle from Space Ranger."
        )
    missing = [c for c in POSITION_COLUMNS if c not in have]
    if missing:
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} is missing the column(s) "
            f"{_quoted_list_for_refusal(missing, noun='column name')} that a Space Ranger "
            f"tissue-positions table declares. It carries "
            f"{_quoted_list_for_refusal(sorted(have), noun='column name')}. An incomplete "
            "positions table cannot be imported: without the pixel columns there is no tissue "
            "map, and without the barcode there is nothing to join the counts to."
        )

    # THE NUMERIC COLUMNS ACCUMULATE AS NUMPY, the barcode column as a list of `str`.
    #
    # The first cut `.extend()`ed all six into Python lists, which made this reader's own
    # "streaming keeps the peak proportional to the batch" claim FALSE: the batches were
    # streamed and then all of them were kept. MEASURED on an 84 MB, 10,562,500-row positions
    # table (a real 6.5x6.5 mm capture area at 2 um -- the bin this module documents as
    # "millions of rows"): `read_positions` alone peaked at 2,706 MiB RSS against a 29 MiB
    # baseline, ~270 bytes per row against ~8 on disk, and everything downstream held it live.
    # The `normal` schedule class is 4 GiB.
    #
    # A numpy column is 8 bytes per row and one object, so the five numeric columns cost ~420
    # MB instead of ~2 GB. WHAT THIS DOES NOT FIX, stated rather than left to be discovered:
    # the `barcode` column is still one Python `str` per row, and `run_import`'s
    # `by_barcode` dict is another, which together dominate at that scale. That is the join,
    # it is not addressable by a dtype change, and it is TRACKED AS #367 (open) with the
    # measurements above -- a pointer, because "it is filed" with no number is a promise the
    # reader cannot check and nobody planning work can see.
    numeric = [c for c in POSITION_COLUMNS if c != "barcode"]
    chunks = {name: [] for name in numeric}
    out = {"barcode": []}
    try:
        batches = handle.iter_batches(batch_size=POSITIONS_BATCH_ROWS,
                                      columns=list(POSITION_COLUMNS))
        # THE RUNNING OFFSET, and it is not bookkeeping. `enumerate` inside a batch counts
        # from zero, so without this a bad barcode at file row 65,543 is refused as "row 7" --
        # a row that exists, is intact, and has nothing wrong with it. That is reachable on
        # the first real bundle this importer meets: `POSITIONS_BATCH_ROWS` is 65,536 and an
        # HD 2 um positions table is millions of squares, so EVERY refusal past the first
        # batch would name the wrong row. A refusal that misdirects is worse than one that
        # says less.
        seen = 0
        for batch in batches:
            for name in POSITION_COLUMNS:
                # NOT `column`: that name is also the joined-column helper in
                # `run_import`, and a name bound twice in one module makes the #336
                # structural guard unable to trace the helper's `name` parameter to its
                # call sites -- so it refuses it, correctly, as unprovable.
                index = batch.schema.get_field_index(name)
                if index < 0:
                    # Unreachable given the duplicate and missing checks above; asserted here
                    # anyway because the failure it guards is `column(-1)` reading the LAST
                    # column, which is silent.
                    raise VisiumImportError(
                        f"{_quoted_for_refusal(path.name, noun='file name')} does not resolve "
                        f"the column {_quoted_for_refusal(name, noun='column name')} to a "
                        "single field."
                    )
                field = batch.column(index)
                if name == "barcode":
                    out[name].extend(_decoded_barcodes(field, path, first_row=seen))
                else:
                    # `zero_copy_only=False` because a nullable or dictionary-encoded arrow
                    # column cannot be viewed in place; `float64` because a vendor may write
                    # any numeric width and the consumer casts once, downstream, with a
                    # NAMED refusal for a value that will not fit.
                    #
                    # THE COLUMN IS NAMED, and it was not. A non-numeric column fell to the
                    # blanket handler at the bottom of this function, whose message says only
                    # that "the file's footer parsed but its row groups did not, so the table
                    # is damaged" -- a diagnosis that is both WRONG (the row groups parsed
                    # fine; one column is text) and unactionable (five different columns
                    # produced the identical sentence, which the table's own
                    # `test_TEST_9_the_refusals_are_DISTINGUISHABLE_from_one_another` caught
                    # the moment all five became rows). A reader cannot re-export a column
                    # nobody named.
                    try:
                        chunks[name].append(field.to_numpy(zero_copy_only=False).astype(
                            np.float64, copy=False))
                    except VisiumImportError:
                        raise
                    except Exception as exc:
                        raise VisiumImportError(
                            f"{_quoted_for_refusal(path.name, noun='file name')} column "
                            f"{_quoted_for_refusal(name, noun='column name')} does not hold "
                            f"numbers "
                            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
                            f"{_quoted_for_refusal(exc, noun='message')}). Every column of a "
                            "10x tissue-positions table except `barcode` is numeric; a "
                            "textual one is not a coordinate, a lattice index or a flag, and "
                            "no reading of it would be this importer's to invent."
                        ) from None
            seen += batch.num_rows
        for name in numeric:
            out[name] = (np.concatenate(chunks[name]) if chunks[name]
                         else np.empty(0, dtype=np.float64))
    except VisiumImportError:
        raise
    except Exception as exc:
        raise VisiumImportError(
            f"{_quoted_for_refusal(path.name, noun='file name')} could not be decoded "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). The file's footer parsed but its "
            "row groups did not, so the table is damaged rather than merely unexpected."
        ) from None
    return out


def _decoded_barcodes(column, path, *, first_row=0):
    """One batch's `barcode` column as `list[str]`, decoded STRICTLY and refused BY NAME.

    `first_row` is the FILE row this batch starts at, so a refusal names a row a reader can
    find. See the running offset in [`read_positions`] for why that is load-bearing rather
    than cosmetic.

    A barcode is the key this importer joins the counts to, so a loose decode would pair one
    bin's position with another bin's counts. Arrow gives back `bytes` for a binary column and
    `str` for a string one; the binary spelling is decoded here rather than by arrow so the
    failure is a named refusal naming the ROW rather than an `ArrowInvalid` from inside a
    library.
    """
    import pyarrow as pa

    if pa.types.is_binary(column.type) or pa.types.is_large_binary(column.type):
        out = []
        for index, value in enumerate(column.to_pylist()):
            if value is None:
                out.append(None)
                continue
            try:
                out.append(value.decode())
            except UnicodeDecodeError as exc:
                raise VisiumImportError(
                    f"{_quoted_for_refusal(path.name, noun='file name')} carries a `barcode` "
                    f"at row {int(first_row) + int(index)} that is not valid UTF-8 "
                    f"({_quoted_for_refusal(exc, noun='message')}). A barcode is an IDENTITY "
                    "-- it is the key this importer joins the counts to -- so it cannot be "
                    "decoded loosely without silently pairing one bin's position with another "
                    "bin's counts."
                ) from None
        return out
    return column.to_pylist()


# ── provenance and the coordinate space's identity ───────────────────────────────────


def vendor_provenance(matrix_attrs, metrics_path):
    """What the VENDOR's pipeline was, from the matrix's root attributes + the optional metrics.

    A processing step we did not run, whose version is as load-bearing as any of our own
    parameters (§7.4). Absence stays absence: a key nobody could fill is DROPPED, never
    written as "unknown", so a reader cannot mistake our placeholder for the vendor's answer.
    """
    def text(v):
        if isinstance(v, bytes):
            return v.decode(errors="replace")
        if isinstance(v, np.ndarray):
            return ", ".join(text(x) for x in v.tolist())
        if isinstance(v, (list, tuple)):
            return ", ".join(text(x) for x in v)
        return None if v is None else str(v)

    prov = {
        "pipeline": text(matrix_attrs.get("software_version")),
        "chemistry": text(matrix_attrs.get("chemistry_description")),
        "library_id": text(matrix_attrs.get("library_ids")),
    }
    if metrics_path is not None:
        try:
            # `encoding="utf-8"`, not the locale default. This file's `Sample ID` becomes
            # `SD.section(sample_id=...)` on the coordinate store, so the LOCALE must not
            # decide it — measured on the Visium side, the SAME bundle stamped two different
            # identities into the store depending on `LC_ALL`.
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
        except (OSError, ValueError, csv.Error, UnicodeDecodeError):
            # `csv.Error` IS NOT A `ValueError` — `_csv.Error.__mro__` is `(_csv.Error,
            # Exception, BaseException, object)` — so a field over `csv`'s 131,072-character
            # limit escapes a two-name tuple as an UNCAUGHT traceback. That is the twin the
            # sibling discovered a release late (its 0.12.0 TEST-18); it is guarded here from
            # the start.
            #
            # A DEGRADE and not a refusal, because `metrics_summary.csv` is an OPTIONAL
            # run-root file with a documented fallback ladder for the sample id — and on the
            # folder-upload arm it is structurally absent, since it is not a declared member.
            # One unreadable optional file is not a reason to refuse a complete bundle.
            prov["metrics_summary_unreadable"] = True
    return {k: v for k, v in prov.items() if v is not None}


def _nonblank(value):
    """The value with surrounding whitespace removed, or `None` if nothing is left.

    An identity made of spaces is not an identity. Every rung of `coordinate_space_id` is a
    STRING THE VENDOR WROTE, and the declaration contract downstream refuses a blank one by
    raising a class this module does not catch -- after the first writer. So blankness is
    decided HERE, where it is still a refusal, rather than there, where it is a traceback.
    """
    if value is None:
        return None
    text = str(value).strip()
    return text or None


#: THE FRAME-IDENTITY PREDICATES, ported from `spatial-import-visium` after #327/#328 landed
#: on `main` while this branch was in its fix loop (`4165326f7`). Ported rather than shared
#: because that is this repo's established shape for them: `spatial-import-visium` and
#: `spatial-import-xenium` each carry their own copy, and neither lives in `spatial-types`.
#:
#: WHAT THE MERGE EXPOSED, and why it is not caught by any gate. The sibling's repair says the
#: identity path must NOT borrow the provenance reader, and this module's did exactly that:
#: `coordinate_space_id` read `provenance["library_id"]`, which is built by stringifying and
#: `", "`-JOINING whatever `library_ids` holds. So three doors the sibling closed were open
#: here, each of them the FALSE-COLLISION direction — two unrelated runs declared to share one
#: coordinate frame, which `resolveOverlayBinding` compares by equality and by nothing else, so
#: one tissue's image is silently registered against the other's bins:
#:
#:   `library_ids: "unknown"` (or any placeholder)  -> BOTH runs answer `visium-hd:unknown`
#:   `library_ids: [b"A", b"B"]` and `[b"A, B"]`    -> BOTH answer `visium-hd:A, B` (#328)
#:   `library_ids: [0]`                             -> `visium-hd:0`, an unfilterable identity
#:   `library_ids: "unverified-space:<32 hex>"`     -> a forged value indistinguishable from a
#:                                                     derived one, claiming `library_id`
#:
#: The sibling's tests are package-scoped, so nothing in the repo would have gone red on any of
#: them. This is the "a branch cut before a main invariant can still reintroduce a repaired
#: defect" case, found by READING the merged change rather than by a guard.
#:
#: WHAT IS **NOT** PORTED, deliberately: the derived `unverified-space:<digest>` bottom rung.
#: This module has no bottom rung at all — it REFUSES when the vendor stated no identity, which
#: is strictly safer than any shared value and is already recorded below. Narrowing rung 1 in a
#: package whose bottom is a refusal is therefore STRICTLY narrowing, and cannot hit the
#: ordering trap #320 measured (gating an upper rung while the bottom is still a shared value
#: moves bundles onto the wider collision). Whether this platform should ALSO emit a derived id
#: instead of refusing is a design question about the ladder, not a fix-round repair.
_VENDOR_PLACEHOLDERS = ("", "n/a", "na", "unknown", "none", "null", "-", "0000000_0000000")

#: The key suffixes stripped before a value is compared against its own field name. The
#: sibling's tuple, unchanged; TEST-50 asserts the two stay equal, so a widening there is not
#: silently missed here.
_NON_IDENTIFYING_KEY_SUFFIXES = ("_name", "_id", "_label", "_uuid")

#: The `coordinate_space_source` each rung of [`coordinate_space_id`] reports — and, since
#: #377, ALSO the namespace token that rung's value is emitted under. ONE constant for both, so
#: the value is self-describing and the token can never drift from the source beside it (design
#: §4.2's last line: *"the `<source-token>` and `coordinate_space_source` are the SAME string by
#: construction"*).
LIBRARY_ID_SOURCE = "library_id"
METRICS_SAMPLE_ID_SOURCE = "metrics-sample-id"

#: The platform namespace every frame identity this package emits opens with.
PLATFORM_SPACE_PREFIX = "visium-hd:"

#: THE PER-RUNG NAMESPACES, and the whole of #377.
#:
#: This package's ladder has TWO STATED rungs — `library_ids` from the matrix's root attributes,
#: then `metrics_summary.csv`'s `Sample ID` — and until #377 both emitted their value VERBATIM
#: into one undelimited space:
#:
#:     run A: library_ids='HD_Colon_01', no metrics_summary  -> visium-hd:HD_Colon_01
#:     run B: no library_ids, Sample ID='HD_Colon_01'        -> visium-hd:HD_Colon_01
#:     SAME FRAME
#:
#: Two unrelated runs, each making a DIFFERENT and fully identifying vendor statement, declared
#: to share one coordinate frame. `coordinate_space_source` differs on those two rows and
#: NOTHING READS IT: `resolveOverlayBinding`
#: (`src-app/libs/viz/src/viz-core/spatial/coordinateBinding.ts`) compares the frame VALUE by
#: equality and by nothing else. So it is one tissue's image silently registered against
#: another's bins — the exact CROSS-RUNG half of #328, which `spatial-import-xenium` closed at
#: `4165326f7` three and a half hours before this package merged.
#:
#: ## Why design §4.1's "a single stated identity is VERBATIM" does not cover this
#:
#: §4.1's first property is written about a ladder with ONE stated rung — which is what
#: `spatial-import-visium` has, and is exactly why §4.5 records that package as unaffected. Its
#: three namespaces (stated / composed / derived) are disjoint only while the STATED one is
#: reached by a single field. Two stated rungs SUBDIVIDE that namespace, and two subdivisions
#: that carry no token are not disjoint. So the token is required here for the same reason
#: §4.1's third property requires the others: not because the values look alike, but because
#: nothing downstream can tell them apart if they collide.
#:
#: ## Why a TOKEN and not a length prefix
#:
#: [`framed_frame_components`] in the sibling exists for a MULTI-component statement, where a
#: bare `_` join is not injective because neither component is free of `_`. Neither rung here is
#: composed: each is exactly ONE vendor string, and it is the LAST thing in the id, so it needs
#: no terminator and no length — the suffix after the token IS the value, whole.
#:
#: What must hold instead is that the TOKEN SET IS PREFIX-FREE, which is what makes reading the
#: id total: no token is a prefix of another, so the token an id opens with is unambiguous, and
#: `<token><value>` is therefore injective in `(rung, value)`. `library_id:` and
#: `metrics-sample-id:` differ in their first character, so the property holds today — but it is
#: a property of the SET and not of those two strings, so TEST-51 asserts it over the tuple. A
#: third rung tokened `library_id:v2:` would be a legal-looking name and would reintroduce #377
#: exactly (`library_id:` + the value `v2:X` is the same id), and it goes red the day it is
#: added rather than the day two bundles collide.
STATED_SPACE_PREFIXES = (f"{LIBRARY_ID_SOURCE}:", f"{METRICS_SAMPLE_ID_SOURCE}:")
LIBRARY_ID_SPACE_PREFIX, METRICS_SAMPLE_ID_SPACE_PREFIX = STATED_SPACE_PREFIXES

#: The DERIVED namespace of the shared scheme (design §4.1), reserved here although this package
#: emits nothing under it: this ladder has NO derived bottom rung, it REFUSES instead (see
#: [`coordinate_space_id`]). Reserved anyway because §4.1's third property is written about the
#: SCHEME, and because the `.h5` is untrusted — "no vendor writes this prefix" is a claim about
#: attacker input.
UNVERIFIED_SPACE_PREFIX = "unverified-space:"

#: The tokens no vendor value may OPEN with. One tuple so a namespace is refused everywhere the
#: moment it is named here, rather than at whichever call sites someone remembers.
#:
#: WHAT #377 CHANGED, and why it is not a weakening. This tuple used to be
#: `(UNVERIFIED_SPACE_PREFIX, "slide_id+region_name:")` — the SIBLING'S composed token, carried
#: across with the rest of the ported predicates. That is a namespace no code in this repository
#: writes under `visium-hd:` and a vocabulary that describes nothing here: this platform has no
#: slides and no regions, and the run this package imports is named by a library id or by a
#: metrics sample id or by nothing at all. So the module reserved a token it never wrote while
#: emitting its two real namespaces WITHOUT one — it had vendored the defensive half of #328 and
#: not the injectivity half. The forged-value door the sibling's token closes is closed here by
#: the two tokens this package actually writes, which is what the refusal now guards; the
#: sibling's own token cannot forge anything in `visium-hd:` space, because every id this module
#: emits opens with one of `STATED_SPACE_PREFIXES` and neither of those is `slide_id+region…`.
RESERVED_SPACE_PREFIXES = (UNVERIFIED_SPACE_PREFIX,) + STATED_SPACE_PREFIXES

#: The `.h5` root attribute, and the FIELD NAME `non_identifying_vendor_label` compares a value
#: against. Deliberately its own literal rather than an alias of [`LIBRARY_ID_SOURCE`]: the two
#: are the same string today and are two different things — a vendor field name and this
#: scheme's namespace token — and one may be renamed without the other.
LIBRARY_ID_ATTR = "library_ids"
LIBRARY_ID_KEY = "library_id"


def sole_stated_text(value):
    """The ONE text value the vendor stated in an `.h5` root attribute, or `None`.

    The IDENTITY path's reader, and deliberately NOT the provenance one. TEXT, or nothing: a
    NUMERIC `library_ids` is an UNFILTERABLE identity, because both predicates below are blind
    to anything but a string. ONE value, or nothing: `library_ids` is plural and array-shaped in
    every real bundle, and the provenance reader's `", "` join is NOT INJECTIVE — `[b"A", b"B"]`
    and `[b"A, B"]` are two different vendor statements and both became one frame id (#328).

    Both refusals are MISSED collisions, visible in `coordinate_space_source` and recoverable by
    re-exporting with a single quoted `library_ids` — the error direction this module chooses
    everywhere.
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


def vendor_statement(value):
    """The vendor's answer, or `None` when the vendor gave a PLACEHOLDER for one.

    `library_ids: "unknown"` was, before this repair, the whole of this importer's coordinate
    frame — so two unrelated tissues both saying `"unknown"` were declared to share one.
    """
    if isinstance(value, str):
        text = value.strip()
        return None if text.lower() in _VENDOR_PLACEHOLDERS else text
    return None


def non_identifying_vendor_label(key, value):
    """True when `value` is only the generic name of the FIELD it fills.

    `library_ids: "library"` is the word every unfilled instance of that field carries, so it
    cannot distinguish this run from any other that left it generic. Derived from the KEY rather
    than from a vocabulary, which is what makes it a rule and not a denylist.
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
            subject = subject[:-len(suffix)]
            break
    return text in (subject, whole)


def identifying_label(key, value):
    """`value` if it IDENTIFIES a frame, else `None` — the four questions, in order.

    One predicate for BOTH rungs of the ladder below, because two spellings of "does this
    identify anything" is how two rungs start disagreeing: the sibling's own docstring records
    that #320's live defect was exactly two readers of one field reading it differently.
    """
    text = vendor_statement(value)
    if text is None:
        return None
    if non_identifying_vendor_label(key, text):
        return None
    if text.lower().startswith(RESERVED_SPACE_PREFIXES):
        return None
    return text


def vendor_frame_label(matrix_attrs):
    """The library id the vendor stated, if it IDENTIFIES a frame — else `None`."""
    return identifying_label(LIBRARY_ID_KEY,
                             sole_stated_text(matrix_attrs.get(LIBRARY_ID_ATTR)))


def coordinate_space_id(provenance, matrix_attrs):
    """`(space id, how it was identified)` — the frame every artifact of this run declares.

    The BIN IS NOT IN IT, deliberately. All three bins of one run share one capture area and
    one full-resolution pixel frame; putting the bin in the space id would make the 8 um
    coordinates and the 16 um coordinates two unrelated frames, and an image emitted by one
    import unplaceable against the other's spots. What distinguishes the bins is
    `measured_entity` (§15.1), which is a different question and has its own field.

    ## EACH RUNG HAS ITS OWN NAMESPACE (#377), and that is the whole of what this emits

    | what the vendor stated | `coordinate_space` | `coordinate_space_source` |
    |---|---|---|
    | an identifying `library_ids` | `visium-hd:library_id:<value>` | `library_id` |
    | no identifying `library_ids`, an identifying metrics `Sample ID` | `visium-hd:metrics-sample-id:<value>` | `metrics-sample-id` |
    | neither | REFUSED by name — no third rung, see below | — |

    The token is the `coordinate_space_source` string itself
    ([`STATED_SPACE_PREFIXES`]), so the id says which rung answered it and the two cannot
    drift. Without it the two rungs emitted into ONE undelimited space and a run whose
    `library_ids` equalled an unrelated run's `Sample ID` shared that run's frame — silently,
    because `resolveOverlayBinding` compares the frame VALUE by equality and by nothing else.

    **The value is still the vendor's string, whole and verbatim, after the token.** Nothing is
    escaped, folded or truncated: the token is a PREFIX, so the suffix is the statement, and the
    map from `(rung, what the vendor stated)` to the id is injective.

    **This moved an id format, and it cost nothing (#377 vs #328's DEC-2).** #328 took the same
    change on Xenium knowing it broke re-import binding for already-imported rung-2 datasets.
    Re-measured here on `3445bc502`, the commit that merged this package: `git grep 'visium-hd:'`
    finds the token in this package's own source and tests and NOWHERE else — no committed
    artifact, no fixture, no baked OME `Description` carries one, because this processor had not
    yet imported anything. So this is a correction BEFORE FIRST USE, not a break.
    """
    # BLANK IS ABSENT, and the difference cost the whole invariant. `if library:` is bare
    # truthiness, so an h5 whose `library_ids` attribute is `b"   "` or `b"\n"` walked past
    # the refusal below, became the `space_id`, crossed the first writer, and died inside the
    # VENDORED declaration contract at `SD.section(sample_id=...)` -- `SpatialDeclarationError`,
    # which `main()` does not catch. MEASURED through the shipped entrypoint: exit **1** with a
    # raw traceback (INV-9 forbids both) and **51 paths on disk** (INV-8 forbids any) -- which
    # is, to the path, the sibling defect this module's own docstring cites as the thing it
    # closed. `b""` was refused correctly at exit 2 with nothing on disk, so the refusal was
    # present and simply mis-conditioned: one space made it a different outcome entirely.
    # READ THROUGH THE IDENTITY PATH'S OWN READER, not the provenance block's. The provenance
    # value is EVIDENCE and must keep saying what the vendor wrote — including a number, a
    # placeholder and a `", "`-joined array. None of those is a frame.
    library = vendor_frame_label(matrix_attrs)
    if library:
        # THE RUNG'S OWN NAMESPACE (#377). `f"visium-hd:{library}"` -- what this line used to
        # be -- put this rung's value and the NEXT rung's value in one undelimited space, so a
        # `library_ids` equal to an unrelated run's metrics `Sample ID` was the same frame.
        return (f"{PLATFORM_SPACE_PREFIX}{LIBRARY_ID_SPACE_PREFIX}{library}",
                LIBRARY_ID_SOURCE)
    sample = identifying_label("sample_id", _nonblank(provenance.get("sample_id")))
    if sample:
        # The vendor's own `Sample ID` from `metrics_summary.csv`. A rung down from
        # `library_ids` because that file is an OPTIONAL run-root member -- structurally
        # absent on the folder-upload arm -- but it is still a fact ABOUT THE RUN. In its own
        # namespace for the same reason rung 1 is (#377): it is a DIFFERENT vendor statement,
        # and two different statements must never answer one frame.
        return (f"{PLATFORM_SPACE_PREFIX}{METRICS_SAMPLE_ID_SPACE_PREFIX}{sample}",
                METRICS_SAMPLE_ID_SOURCE)
    # AND NO THIRD RUNG. The sibling falls back to the bundle DIRECTORY NAME, and here that
    # is not a fact about the run at all: in the layout a real sandbox presents, a multi-file
    # dataset is spread across `/inputs` itself, so the name is always `inputs`. MEASURED
    # through the shipped entrypoint on the flat staged layout: every such bundle would
    # declare `coordinate_space = "visium-hd:inputs"` and the same `section.sample_id`, so
    # two unrelated runs would place themselves in ONE frame -- a false collision that no
    # later reader can detect, which is precisely what `refuse_unencodable_vendor_text`
    # exists further up to prevent from a different door.
    #
    # §7.3 rule 2 says the space is "identified by the library id". A bundle carrying no
    # identity has none to declare, and inventing one is worse than refusing.
    raise VisiumImportError(
        f"{MATRIX_BASENAME} declares no `library_ids` and this run's `metrics_summary.csv` "
        "declares no `Sample ID`, so there is nothing to identify the capture area with. "
        "The coordinate space every artifact of this run declares -- and that every later "
        "image and section places itself into -- is named after the run; minting a name from "
        "the upload's directory would give two unrelated runs the SAME frame, which nothing "
        "downstream could detect. Re-export the bundle from Space Ranger with its library id."
    )


def inline_diagnostic(path):
    """A vendor diagnostic image as a `data:` URI for the report, or `None`.

    Capped so a multi-megabyte vendor JPEG cannot inflate the report; over the cap the report
    SAYS it omitted it rather than shipping a truncated image.
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


# ── the images ───────────────────────────────────────────────────────────────────────


def emit_images(images, outputs_dir, *, space_id, microns_per_pixel,
                microns_per_pixel_source, scalefactors, ambiguous=(), non_placeable=(),
                coverage_bounds=None):
    """Convert each present vendor image to a `spatial/image`. Returns `(entries, skipped, warnings)`.

    ## Every image declares its OWN affine INTO the one space (INV-2)

    The coordinates sit at `to_space = identity` in the full-resolution pixel frame, and each
    image maps into that frame by the INVERSE of its own vendor scalefactor. That is the
    direction that composes: a hires image at `scalef 0.25` and a lowres one at `0.06` share
    one `coordinate_space`, and a consumer can place either against the bins or against the
    other. A forward affine cannot express that.

    ## An unplaceable image is DROPPED, not emitted (INV-5)

    An image whose scalefactor key is missing or unusable produces NO artifact and a note in
    the report. Emitting it with an identity affine would not be a missing declaration but a
    WRONG one — the claim that these pixels are already full-resolution pixels. §7.3 opens by
    pointing out that getting this wrong "does not error"; a dropped image is visibly absent,
    a misplaced one is silently wrong.

    ## The structure of the loop is the sibling's, and the reasons are its measurements

    One guard around the WHOLE per-image body (the raises are spread across nine calls, and a
    per-call `except` always misses the next one); the COMMIT POINT deliberately outside it
    (once `write_ome_tiff` returns the bytes are on disk, and an exception after that would
    put the same image in `entries` AND in `images_not_emitted`); and emission-asserting notes
    BUFFERED until past that point (a note saying "emitted, but…" appended before the write is
    a false statement when the write then fails). Those three shapes are #296/#297/#298's
    conclusions and are carried over rather than rediscovered.
    """
    entries, skipped, warnings = [], [], []
    for basename in ambiguous:
        skipped.append(
            f"{basename}: the bundle carries more than one file with this name and no "
            "declared member names it, so choosing one would be a guess about which run's "
            "data this is. No image was emitted from it."
        )
    # BEFORE the loop: a non-placeable image has no write to commit and no failure to catch,
    # so it has no business inside the body that carries the commit-point discipline.
    for spec in non_placeable:
        skipped.append(f"{spec.get('basename', UNNAMED_IMAGE)}: "
                       f"{spec.get('reason', 'not emitted — no reason was recorded.')}")

    for spec in images:
      # RESOLVED BEFORE THE `try`, NOT INSIDE IT. The handler below reports the failure it
      # caught using `basename`, and reading `spec['basename']` in the handler means a `spec`
      # without that key makes the HANDLER raise — replacing a caught failure with an abort,
      # which is the one line here that can turn "one image lost" back into "the import lost".
      basename = spec.get("basename", UNNAMED_IMAGE)
      pending_warnings = []
      try:
          scalef = scalefactors.get(spec["scalef_key"])
          # `math.isfinite` is part of the guard, not an afterthought: `json.loads` accepts
          # `Infinity`, which passes `> 0`, and then `1/inf = 0.0` reaches
          # `SD._number(..., allow_zero=False)` and raises a DIFFERENT exception type from the
          # one this loop catches — so the whole import would abort on one damaged number.
          if not _positive_finite(scalef):
              skipped.append(
                  f"{basename}: the bundle declares no usable `{spec['scalef_key']}`, so "
                  "this image cannot be placed in the coordinate space and was NOT emitted. "
                  "An identity affine would claim it is already in full-resolution pixels, "
                  "which would silently misregister every bin drawn on it."
              )
              continue
          try:
              arr = ome_writer.read_image(spec["path"])
          except ome_writer.ImageConversionError as exc:
              skipped.append(f"{basename}: {exc}")
              continue

          # The image's OWN resolution: the full-res scale divided by the vendor's
          # scalefactor. Unknown stays unknown — there is no default (INV-5).
          image_um_per_px = (
              microns_per_pixel / float(scalef) if microns_per_pixel is not None else None
          )
          derivative, factor, emitted_um_per_px = None, 1, None
          if image_um_per_px is not None:
              source_extent = ome_writer.extent_of(arr)
              factor, applied_um, _emitted_extent = ome_writer.downsample_plan(
                  image_um_per_px, SD.DEFAULT_RESOLUTION_CAP_UM, source_extent
              )
              derivative = SD.display_derivative_provenance(
                  original_resolution_um=image_um_per_px,
                  # The SOURCE grid, captured BEFORE the resample — the only recorded fact
                  # anchored to a pixel count, and unrecoverable afterwards.
                  original_extent=source_extent,
                  # WHERE THE ORIGINAL IS PRESERVED. Not re-emitted: it stays in the retained
                  # `spatial/visium-hd-bundle` upload, which is `opaque_as_is`. A basename,
                  # because basename is how that container matches its members.
                  original_source=basename,
                  codec=ome_writer.CODEC,
                  tifffile_version=ome_writer.tifffile_version(),
                  resolution_cap_um=SD.DEFAULT_RESOLUTION_CAP_UM,
              )
              if factor > 1:
                  arr = ome_writer.downsample(arr, factor)
              emitted_um_per_px = applied_um
          else:
              # SAID OUT LOUD, because otherwise the two cases are indistinguishable: an image
              # emitted UNCHECKED carries no `display_derivative` block, exactly like one that
              # was checked and passed.
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
              # AFTER the resample — `arr` was reassigned above when `factor > 1`.
              extent=ome_writer.extent_of(arr),
              # THE SPACE's scale, NOT this image's own pixel pitch. `microns_per_pixel` is
              # defined on the COORDINATE SPACE; passing the image's own pitch here would make
              # artifacts that declare the SAME space disagree about its scale by the
              # scalefactor — and because the image's block is the only one a sandboxed
              # consumer can read, a neighbour radius resolved through it would be silently
              # wrong by exactly that factor. This image's own pitch is not lost: it is
              # `microns_per_pixel * to_space[0]`, it is recorded verbatim in
              # `display_derivative.original_resolution_um`, and it is written natively into
              # the OME-XML as `PhysicalSizeX/Y`.
              microns_per_pixel=microns_per_pixel,
              microns_per_pixel_source=microns_per_pixel_source,
          )
          meta = SD.image_meta(space=space, derivative=derivative, role=spec["role"],
                              source=basename)

          # COVERAGE, computed BEFORE the artifact is committed, precisely so nothing after
          # the commit point can raise. A note rather than a refusal: a legitimately cropped
          # vendor image exists, but silence would be worst of all — this is what a
          # misregistration looks like from the outside.
          coverage_note = None
          if coverage_bounds is not None:
              covered_w = meta["extent"]["width"] * meta["to_space"][0]
              covered_h = meta["extent"]["height"] * meta["to_space"][4]
              max_x, max_y = coverage_bounds
              if covered_w < max_x or covered_h < max_y:
                  coverage_note = (
                      f"{basename}: emitted, but it covers only "
                      f"{covered_w:.0f} x {covered_h:.0f} full-resolution pixels while the "
                      f"bins extend to {max_x:.0f} x {max_y:.0f}. The image and the positions "
                      "may not describe the same capture area — check the registration "
                      "overlay before reading anything off this image."
                  )

          downsample_note = None
          if factor > 1:
              # The RAGGED STRIP, named rather than left to be derived from the two grids: a
              # floor division discards up to `factor-1` rows AND columns of real measured
              # tissue. Only the axis that ACTUALLY lost something is named — saying "0 row(s)
              # were dropped" asserts a loss that did not occur, in the one channel this note
              # exists to be honest in.
              dropped_w = derivative["original_extent"]["width"] % factor
              dropped_h = derivative["original_extent"]["height"] % factor
              parts = ([f"{dropped_w} column(s)"] if dropped_w else []) + \
                      ([f"{dropped_h} row(s)"] if dropped_h else [])
              dropped = (
                  f" The last {' and '.join(parts)} of the source did not fill a whole block "
                  "and were dropped rather than padded, because padding would invent a "
                  "measurement." if parts else ""
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

          rel = f"{spec['output_id']}.ome.tif"
          # ONE call site builds the placement; the manifest copy and the OME-XML copy are
          # both derived from `meta` here, never computed twice.
          ome_writer.write_ome_tiff(
              outputs_dir / rel, arr, placement=meta,
              # THE EMITTED image's own pixel pitch -> OME `PhysicalSizeX/Y`, whose semantics
              # are exactly that. The SPACE's scale went into `meta` above. They are different
              # numbers for different readers and they do not share a parameter name.
              image_microns_per_pixel=emitted_um_per_px,
          )
      except (ome_writer.ImageConversionError, SD.SpatialDeclarationError, OSError) as exc:
        # ONE guard around the WHOLE body. The tuple is DELIBERATELY not widened to bare
        # `ValueError` (which `SpatialDeclarationError` subclasses): catching it costs nothing
        # any test needs, while converting a genuine logic bug on an untested path into a
        # plausible "image skipped" note that reads exactly like a damaged input.
        skipped.append(
            # FUNNELLED even though this is NOT a refusal and the structural guard's subject
            # set therefore cannot see it: `{exc}` is vendor-derived (it echoes what
            # `tifffile`/`PIL` read out of the vendor's own image), it is unbounded, and it is
            # a DIAGNOSTIC A USER READS. `basename` is NOT funnelled and that is deliberate —
            # it comes from this module's own `VENDOR_IMAGES` table or from the
            # `UNNAMED_IMAGE` constant, so it is not attacker-chosen, and escaping a module
            # constant costs a real assertion and buys nothing.
            f"{basename}: not emitted — "
            f"{_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}"
        )
        continue

      # ── THE COMMIT POINT, deliberately OUTSIDE the guard ─────────────────────────
      # `write_ome_tiff` has returned, so the bytes are on disk; from here the image IS
      # emitted. Every statement below is total — list appends and truth tests on values
      # computed before the write — because an exception here would put the SAME image in
      # `entries`, on disk, AND in `images_not_emitted` at once.
      entries.append(output_entry(
          spec["output_id"], DT_SPATIAL_IMAGE, rel, "artifact",
          structure=txr_columns.opaque(IMAGE_MEDIA_TYPE),
          meta=meta,
          label=f"Tissue image ({spec['role']})",
      ))
      warnings.extend(pending_warnings)
      if downsample_note:
          warnings.append(downsample_note)
      if coverage_note:
          warnings.append(coverage_note)
    return entries, skipped, warnings


# ── the report ───────────────────────────────────────────────────────────────────────

#: How much of a QC `reason` reaches the artifact `meta`. A cap, because `meta` is what a
#: human sees in the app and one long reason must not push the other rows out of view.
QC_META_REASON_CHARS = 200


def qc_verdict_lines(qc):
    """The QC verdicts as short lines for the artifact `meta` — the ONE channel a human sees.

    NOTHING IN THIS APP RENDERS `report/html` (#223), so a verdict that lives only in the
    embedded HTML reaches nobody. These lines ride in `meta` for exactly that reason.
    """
    lines = []
    scale = qc.get("scale") or {}
    reason = str(scale.get("reason", ""))[:QC_META_REASON_CHARS]
    lines.append(f"scale vs the bin lattice pitch: {scale.get('verdict', '?')} — {reason}")
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


def render_report_html(report, diagnostics, overlays=None):
    """The human-readable summary, with the registration overlay embedded above the facts.

    §7.5: the overlay "is a required output of the importer, not a nice-to-have — it is the
    entire verification story for step 7.3". Nothing in the conformance gate can check an
    affine; a human looking at the bins drawn on the tissue can.
    """
    def esc(v):
        return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    rows = []
    for key, value in (
        ("Coordinate space", report["coordinate_space"]),
        ("Bin size (um)", report["bin_um"]),
        ("Bin chosen by", report["bin_chosen_by"]),
        ("Bins in this bundle", ", ".join(f"{b} um" for b in report["bins_available"])),
        ("Bins", report["n_bins"]),
        ("Genes", report["n_genes"]),
        ("Entity", report["measured_entity_label"]),
        ("Scale (um/pixel)", report.get("microns_per_pixel", "not declared")),
        ("Scale source", report["microns_per_pixel_source"]),
        ("Bundle layout", report["bundle_layout"]),
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
    qc = report.get("registration_qc") or {}
    banner = registration_qc.render_registration_qc(qc, overlays or {}) if qc else ""
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Visium HD import summary</title></head><body>"
        "<h2>Visium HD import summary</h2>"
        f"<p><strong>Bin:</strong> {esc(report['bin_choice_note'])}</p>"
        + banner
        + "<h3>Space Ranger's own registration diagnostics</h3>"
        + (imgs or "<p><em>none in this bundle.</em></p>")
        + omitted
        + "<h3>Run summary</h3>"
        + "<table style='font:14px/1.5 system-ui,sans-serif'>" + "".join(rows) + "</table>"
        + "<script type='application/json' id='visium-hd-import-summary'>"
        + json.dumps(report) + "</script>"
        "</body></html>"
    )


# ─────────────────────────────── the import ───────────────────────────────


def run_import(bundle_root, outputs_dir, *, requested_bin=None, slot_ordinals=None):
    """The whole import. Returns the manifest `entries` list.

    Factored out of `main` so the end-to-end test can drive the REAL code over the REAL
    fixture and read the artifacts back, rather than testing a re-implementation of it.

    ## THE ORDER OF THIS FUNCTION IS ITS MOST LOAD-BEARING PROPERTY (INV-8)

    Everything that can REFUSE happens above the first line that WRITES. `write_csc_zarr` is
    the first writer, and by the time control reaches it this function has already: resolved
    and VERIFIED the bins, selected one, read and refused on its scale document, read and
    refused on its positions parquet, opened the matrix and refused on its root attributes,
    its `/matrix` group, its shape and its three identity datasets, and completed the
    BARCODE JOIN.

    That last one is the difference from the sibling. `spatial-import-visium` does the join
    after `write_csc_zarr`, so every join refusal there leaves 51 paths on disk, and
    `docs/design/vendor-text-encodability-refusal.md` §6.7 records the general form of the
    rule — "every refusal a bundle can trigger should be reachable before the first writer
    call" — as an OPEN item rather than a delivered one. It is delivered here: the join needs
    only the h5's `barcodes` dataset, which is metadata, so it can be settled while the file
    is still open and before a single byte of `expression.zarr` exists.

    The visible consequence is ORDERING, and it is worth stating: a bundle that is bad in
    several ways reports whichever of these reads refuses first, not necessarily the one a
    reader would have expected.
    """
    import h5py
    import pandas as pd

    outputs_dir = Path(outputs_dir)
    progress("read", 3, "locating the Visium HD bins")
    bundle = locate_bins(bundle_root, slot_ordinals=slot_ordinals)
    available = sorted(bundle["bins"])
    bin_um, chose_by = select_bin(available, requested_bin)
    selected = bundle["bins"][bin_um]
    progress("read", 6, f"reading the {bin_um} um bin")

    # BOTH VENDOR DOCUMENTS ARE READ HERE AND CONSUMED FAR BELOW, for one reason: every
    # refusal must precede the first writer (see the docstring). Both reads are pure and both
    # results are bound once, so nothing else about the import moves.
    scalefactors = read_scalefactors(selected["scalefactors"])
    positions = read_positions(selected["positions"])

    entries = []
    try:
        matrix_file = h5py.File(selected["matrix"], "r")
    except (OSError, ValueError, RuntimeError) as exc:
        # THE OPEN, WHICH THE FIRST CUT LEFT BARE. `h5py.File` raises `OSError` for a
        # truncated, zero-byte or non-HDF5 file -- three shapes a damaged upload really
        # produces -- and an unguarded open makes those an exit-1 traceback, which is exactly
        # what INV-9 forbids. The parquet reader one function away already has a deliberately
        # broad guard for the same class of damage; this is that guard, on the door the
        # sibling leaves open too.
        raise VisiumImportError(
            f"{MATRIX_BASENAME} could not be opened as an HDF5 file "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
            f"{_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix is "
            "HDF5; a file that is truncated, empty, or in another format entirely cannot be "
            "read as one. Re-export the complete Space Ranger `binned_outputs/` bundle."
        ) from None
    with matrix_file as h5:
        if "matrix" not in h5:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} has no `/matrix` group -- this is not a 10x "
                f"feature-barcode matrix. Found top-level members "
                f"{_quoted_list_for_refusal(sorted(h5.keys()), noun='member name')}."
            )
        # THE LINK, NOT THE RESOLVED OBJECT. `h5["matrix"]` follows an h5py link
        # transparently, so a `/matrix` that is an ExternalLink to a file OUTSIDE this
        # bundle resolves to an ordinary group in that other file and the member loop below
        # never sees the link. MEASURED through the shipped entrypoint: `/matrix` as an
        # ExternalLink to a copy of the matrix group in a file NOT in the bundle imported at
        # rc 0 with 120 output paths -- the values came from outside the bundle. The
        # reasoning recorded on #450 is that Space Ranger never writes an ExternalLink into
        # a `filtered_feature_bc_matrix.h5`, so refusing the link class outright is safe.
        # This leg exists for the DIAGNOSIS -- a message naming `/matrix` itself -- while
        # the structural walk below provides the GUARANTEE.
        matrix_link = h5.get("matrix", getlink=True)
        if isinstance(matrix_link, h5py.ExternalLink):
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix` is an ExternalLink. A 10x feature-barcode "
                "matrix stores its non-zero values, feature ids and column offsets INLINE "
                "under `/matrix`; a group that is a link rather than an inline group is not "
                "a matrix this importer can carry. Refusing rather than shipping a wrong "
                "matrix."
            )
        # THE TARGET, NOT JUST THE LINK (#587). `h5.get("matrix", getlink=True)` inspects
        # the link without following it, so the ExternalLink leg above refuses an
        # ExternalLink BY NAME whether its target file exists or is missing (MEASURED
        # through the shipped entrypoint on this node's base: an ExternalLink to a missing
        # file already refused as "is an ExternalLink" at rc 2, 0 output paths -- the link
        # class is the defect, not the target's existence). A same-file SoftLink passes
        # that leg, and `h5["matrix"]` then FOLLOWS the link; a link whose target does not
        # resolve -- a dangling SoftLink, or a SoftLink chain ending nowhere -- raises a
        # raw h5py KeyError. MEASURED through the shipped entrypoint on this node's base
        # (0.14.0), `/matrix` replaced by a same-file `SoftLink("/does_not_exist_anywhere")`:
        # rc=1, raw traceback at this subscript, 0 output paths --
        # `KeyError: 'Unable to synchronously open object (component not found)'` -- INV-9's
        # prohibited outcome, reached because the presence test `"matrix" not in h5` passed
        # (it is `H5Lexists`, which is TRUE for a dangling link) AND the ExternalLink leg
        # passed (the link is a SoftLink, not an ExternalLink). The sibling importer closes
        # the SAME subscript first -- `refuse_unreadable_matrix_group`
        # (`spatial-import-visium/compute/import_visium.py:1787-1798`) guards it with the
        # SAME tuple and the SAME `except VisiumImportError: raise` first clause -- and this
        # is the leg the #585 comment below records as having been open (#587). NOTE THE
        # ORDERING, THE ONE PLACE THIS SHAPE CAN GO WRONG AND STAY GREEN: `VisiumImportError`
        # IS a `RuntimeError` subclass, so the try is MINIMAL (its body is exactly this one
        # assignment), the re-raise clause comes FIRST, and the isinstance refusal BELOW is
        # OUTSIDE the try -- a widened try would swallow that refusal into the tuple handler
        # and report the #585 Dataset-at-`/matrix` case as "cannot be read", a FALSE
        # diagnosis replacing the pinned "is not a group ('Dataset')" sentence (TEST-106 /
        # TEST-107 are the canaries for exactly that; structural because deleting the
        # re-raise is behaviorally invisible here).
        try:
            group = h5["matrix"]
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, RuntimeError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix` link exists but its target cannot be read "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                "matrix stores its non-zero values, feature ids and column offsets under "
                "`/matrix` INLINE; a link whose target does not resolve is not a matrix "
                "this importer can carry. Refusing rather than shipping a wrong matrix."
            ) from None
        # ── THE RESOLVED OBJECT MUST BE A GROUP (#585). `group = h5["matrix"]` was never
        # type-checked anywhere in this module -- the structural walk's descent test and the
        # #539 features check are the only `isinstance(..., h5py.Group)` sites, and neither
        # covers `group` -- and the next executable use is the membership test
        # `if member not in group:` below. An `h5py.Dataset` is not a Group, so `in` falls
        # through to membership-by-comparison: MEASURED through the shipped entrypoint on
        # this node's base (0.13.0), a `/matrix` that is a plain 2-D `float64` Dataset --
        # inline, or reached as a same-file SoftLink / HARD LINK to a Dataset -- escaped as
        # `ValueError: The truth value of an array with more than one element is ambiguous.
        # Use a.any() or a.all()` at the membership test, rc 1, raw traceback, 0 output
        # paths -- INV-9's prohibited outcome -- while a 1-D Dataset did NOT raise (the
        # membership test iterates the values and returns False) and was refused with a
        # FALSE diagnosis, "has no `/matrix/data`", sending the operator to fix a member
        # that is not the problem. The SAME `isinstance` refusal fixes both. A SoftLink or
        # hard link that resolves to a Dataset is reported as what it IS -- the RESOLVED
        # object's type, `'Dataset'` -- not merely that a link exists. The sibling importer
        # closes the SAME boundary at `refuse_unreadable_matrix_group`
        # (`spatial-import-visium/compute/import_visium.py:1799`) with TWO legs -- leg B: a
        # guarded subscript refusing an UNREADABLE `h5["matrix"]` target; leg A: this
        # isinstance check. THIS is the HD half of the `/matrix`-resolves-to-Dataset
        # boundary, one level above
        # #539's features check in this same function, and the sibling's unreadable-target
        # leg -- a dangling same-file SoftLink, MEASURED on the base (0.14.0) as a raw rc-1
        # `KeyError` at this subscript with 0 output paths -- was open in HD as #587 until
        # the guarded subscript immediately above this comment closed it. BOTH legs of the
        # pair are now closed in HD (leg A, the #585 Dataset leg, here; leg B, the #587
        # unreadable-target leg, above), so the two importers agree on the full `/matrix`
        # leg pair (#533/#548).
        # Refusing here, before the membership loop, keeps every later `group[...]` read on a
        # verified Group.
        if not isinstance(group, h5py.Group):
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix` is not a group "
                f"({_quoted_for_refusal(type(group).__name__, noun='type name')}). A 10x "
                "feature-barcode matrix stores its non-zero values, feature ids and column "
                "offsets under `/matrix` in a GROUP; a `/matrix` that is not a group has no "
                "`/matrix/data`, `/matrix/indices` or `/matrix/indptr` member to read the "
                "counts from. Refusing rather than shipping a wrong matrix."
            )
        # ── THE MEMBERS MUST BE REAL, SELF-CONTAINED, INLINE DATASETS, checked before the
        # first read of `indptr` below. This check is VENDORED from the sibling's
        # `refuse_malformed_counts` (commit 90e18f7d6); HD keeps it INLINE because HD's whole
        # matrix validation is inline in `run_import` -- the two stay findable from each other
        # by that function name. HD is now STRONGER than the sibling it was vendored from:
        # the sibling still has only the enumerated form with no link inspection and remains
        # bypassable by an ExternalLink (#462). A VIRTUAL dataset or EXTERNAL raw storage is
        # refused OUTRIGHT, without resolving its sources and deciding: a 10x Space Ranger
        # feature-barcode matrix stores `data`/`indices`/`indptr` INLINE, and a dataset whose
        # values depend on files OUTSIDE this bundle cannot be imported -- the importer cannot
        # know what it will read, and an unresolvable source silently yields the FILL VALUE
        # (0) rather than an error. MEASURED through the shipped entrypoint on the 8 um bin:
        # a virtual `/matrix/indices` with a missing source imported at rc 0 with every count
        # attributed to feature 0; a virtual `/matrix/data` imported at rc 0 with `data` all
        # zero; an external-storage `indices`/`data` died inside `_lib/txr_csc.py` with a raw
        # traceback and (for `data`) a five-path partial store. `ds.is_virtual` is False for
        # external storage, so BOTH predicates are needed. A member that is PRESENT but not a
        # dataset is the same refusal class, and is named here too. The loop also refuses a
        # MISSING member, a member that cannot be READ (a broken ExternalLink/SoftLink), and
        # an ExternalLink to a file outside this bundle -- each by name, before the first
        # read of `indptr`.
        for member in ("data", "indices", "indptr"):
            if member not in group:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME} has no `/matrix/{member}`. A 10x feature-barcode "
                    "matrix stores its non-zero values, feature ids and column offsets as "
                    "flat datasets under `/matrix`; a matrix missing one of them cannot be "
                    "imported. Refusing rather than handing a partial matrix to the store "
                    "writer."
                )
            # A member that is PRESENT but cannot be READ is a different defect from one
            # that is absent, and the operator needs to know which. An h5py ExternalLink to
            # a file outside this bundle, or a SoftLink to a path that does not exist, makes
            # `group[member]` raise -- MEASURED through the shipped entrypoint: `/matrix/
            # indices` as an ExternalLink to a nonexistent file escaped as `KeyError:
            # Unable to synchronously open object (can't open file)` at rc 1 with a raw
            # traceback, and `/matrix/data` as a SoftLink to a nonexistent path escaped the
            # same way (`component not found`). HDF5 enforces its OWN link-traversal limit
            # too, so a DEEP same-file SoftLink chain raises `RuntimeError: Special link
            # traversal failed (too many links)` here -- MEASURED at 51 hops, rc 1 with a
            # raw traceback -- which is why `RuntimeError` is in the tuple. The "has no
            # `/matrix/...`" refusal above means the member is MISSING; this one says the
            # member is there but unreadable.
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
            # THE LINK, NOT THE RESOLVED OBJECT. `group[member]` FOLLOWS an h5py link
            # transparently, so an ExternalLink to an EXISTING file outside this bundle
            # resolves to an ordinary inline Dataset in that other file: `isinstance(...,
            # h5py.Dataset)` is True, `is_virtual` is False and `external` is empty, and the
            # check below would pass it while its values come from a file OUTSIDE the
            # bundle. MEASURED through the shipped entrypoint: `/matrix/data` as an
            # ExternalLink to a file NOT in the bundle holding all-7s data imported at rc 0
            # with 120 output paths -- a full store built from outside data. The reasoning
            # recorded on #450 is that Space Ranger never writes an ExternalLink into a
            # `filtered_feature_bc_matrix.h5`, so refusing the link class outright is safe.
            # This leg exists for the DIAGNOSIS -- a message naming the specific member --
            # while the structural walk below provides the GUARANTEE.
            link = group.get(member, getlink=True)
            if isinstance(link, h5py.ExternalLink):
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s `/matrix/{member}` is an ExternalLink. A 10x "
                    "feature-barcode matrix stores its non-zero values, feature ids and "
                    "column offsets INLINE; a member that is a link rather than an inline "
                    "dataset is not a matrix this importer can carry. Refusing rather than "
                    "shipping a wrong matrix."
                )
            if not isinstance(ds, h5py.Dataset):
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s `/matrix/{member}` is not a dataset "
                    f"({_quoted_for_refusal(type(ds).__name__, noun='type name')}). A 10x "
                    "feature-barcode matrix stores its non-zero values, feature ids and "
                    "column offsets as flat datasets; anything else is not a matrix this "
                    "importer can read. Refusing rather than handing it to the store writer."
                )
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
                    "this bundle cannot be imported -- the importer cannot know what it "
                    "will read, and an unresolvable source silently yields the fill value "
                    "rather than an error. Refusing rather than shipping a wrong matrix."
                )
        # ── THE STRUCTURAL NET: EVERY OBJECT REACHABLE UNDER `/matrix` MUST LIVE IN THIS
        # BUNDLE'S OWN MATRIX FILE, INLINE. ─────────────────────────────────────────────
        #
        # The member loop above enumerates the CSC triple and refuses each by name. An
        # enumeration cannot see tomorrow's member: MEASURED through the shipped entrypoint,
        # `/matrix/barcodes` as an ExternalLink to an outside file holding the bundle's own
        # barcodes REVERSED imported at rc 0 with 120 output paths -- the join passes (same
        # SET) and the store's barcode axis ends up reversed while the counts columns stay
        # in the bundle's original order: a silently MISLABELED matrix. And a SoftLink CHAIN
        # walks straight through the member loop's own-link inspection: `/matrix/data` ->
        # SoftLink("/matrix/zzz") -> ExternalLink(outside.h5:/data) imported at rc 0 with a
        # full store built from the outside file's all-7s values, because
        # `group.get(member, getlink=True)` inspects only the member's OWN link while
        # `group[member]` resolves the WHOLE chain. So the rule is STRUCTURAL, not
        # enumerated: every object reachable under `/matrix` must resolve to THIS file.
        # `visititems` does NOT follow soft/external links and would silently skip exactly
        # the objects this walk hunts, so the walk is written by hand: `get(key,
        # getlink=True)` + a guarded `group[key]`.
        matrix_realpath = os.path.realpath(selected["matrix"])
        #: A path deeper than this many levels under `/matrix` is refused BY NAME. The 10x
        #: matrix is a few levels deep (`/matrix/features/id`); a group tree this deep is not
        #: a matrix this importer can carry, and the cap keeps the walk's depth bounded.
        MAX_MATRIX_DEPTH = 64

        def _refuse_outside_matrix_objects(group):
            """Refuse any object under `/matrix` that does not live INLINE in this file.

            Four predicates, each a door the enumerated member loop cannot see:
            (1) the resolved object's file must be this bundle's own matrix file -- the
            realpath comparison catches an ExternalLink at ANY depth, through ANY number of
            SoftLink hops, for ANY member name; (2) no dataset may be VIRTUAL; (3) no
            dataset may use EXTERNAL raw storage; (4) resolving a link must not raise -- a
            broken link is a named refusal, not a traceback.

            `seen` holds the HDF5 object ids already checked. A SoftLink can point at an
            ANCESTOR group, so the same object is reachable through many paths; without the
            set, a cyclic SoftLink (`/matrix/zzz` -> SoftLink("/matrix")) would revisit the
            same object forever. The checks are path-independent (the file an object lives
            in, and its storage kind), so checking an object once is checking it everywhere.

            Depth is bounded twice over. The walk is ITERATIVE -- an explicit stack, so no
            recursion frame is consumed per level and a deep group nesting cannot blow
            Python's recursion limit into a raw `RecursionError` -- INV-9's prohibited
            outcome. And a path deeper than `MAX_MATRIX_DEPTH` levels under `/matrix` is a
            NAMED refusal: a group tree that deep is not a matrix this importer can carry
            (MEASURED at 3000 nested groups, which the recursive walk died on).
            """
            seen = set()
            stack = [(group, "/matrix", 0)]
            while stack:
                obj, path, depth = stack.pop()
                try:
                    obj_file = os.path.realpath(obj.file.filename)
                except Exception:
                    # Defensive: an h5py object freshly resolved from the open file always
                    # has a `.file`, so this is unreachable in practice; if it ever fires,
                    # the dataset predicates below still run and the walk still descends.
                    obj_file = None
                if obj_file is not None and obj_file != matrix_realpath:
                    raise VisiumImportError(
                        f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} resolves "
                        f"to {_quoted_for_refusal(obj_file, noun='file path')}, not this "
                        f"bundle's own matrix file "
                        f"{_quoted_for_refusal(matrix_realpath, noun='file path')}. A 10x "
                        "feature-barcode matrix stores every value INLINE in its own file; an "
                        "object whose values live in another file cannot be imported -- the "
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
                if obj.id in seen:
                    continue
                seen.add(obj.id)
                if isinstance(obj, h5py.Group):
                    # Push in REVERSE key order so the LIFO stack pops the first key first,
                    # reproducing the recursive walk's depth-first in-order descent.
                    for key in list(obj.keys())[::-1]:
                        # THE LINK IS INSPECTED BEFORE IT IS RESOLVED. h5py FOLLOWS an
                        # `h5py.ExternalLink` transparently, so `obj[key]` would return an
                        # ordinary object IN ANOTHER FILE -- or, for a link back into this
                        # same file, an object the realpath comparison cannot tell apart.
                        # Space Ranger never writes an ExternalLink into a
                        # `filtered_feature_bc_matrix.h5`, and a matrix whose members are
                        # links to *anywhere* -- even back into the same file -- is not a
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
                                "imported -- the importer cannot know what it will read. "
                                "Refusing rather than shipping a wrong matrix."
                            )
                        try:
                            child = obj[key]
                        except VisiumImportError:
                            raise
                        except (KeyError, OSError, TypeError, RuntimeError) as exc:
                            raise VisiumImportError(
                                f"{MATRIX_BASENAME}'s "
                                f"{_quoted_for_refusal(f'{path}/{key}', noun='path')} cannot be "
                                f"read ({_quoted_for_refusal(exc, noun='message')}). A 10x "
                                "feature-barcode matrix stores every value INLINE in its own file; "
                                "a member that cannot be read is not a matrix this importer can "
                                "carry. Refusing rather than handing a partial matrix to the store "
                                "writer."
                            ) from None
                        stack.append((child, f"{path}/{key}", depth + 1))
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
                            "INLINE; a dataset whose values depend on files outside this bundle "
                            "cannot be imported -- the importer cannot know what it will read, "
                            "and an unresolvable source silently yields the fill value rather "
                            "than an error. Refusing rather than shipping a wrong matrix."
                        )
                else:
                    raise VisiumImportError(
                        f"{MATRIX_BASENAME}'s {_quoted_for_refusal(path, noun='path')} is "
                        f"neither a dataset nor a group "
                        f"({_quoted_for_refusal(type(obj).__name__, noun='type name')}). A 10x "
                        "feature-barcode matrix stores its non-zero values, feature ids and "
                        "column offsets as flat datasets; anything else is not a matrix this "
                        "importer can read. Refusing rather than handing it to the store writer."
                    )

        def _matrix_member_identity(parent, label, member):
            """The (fileno, addr) identity of one consumed member, or None if it is genuinely absent.

            Absence is refused by name elsewhere, so a missing member is SKIPPED here -- a
            collision check must not turn a clean "has no `/matrix/shape`" into a confusing
            collision message. An object whose identity cannot be determined is REFUSED: the
            whole point of the check is that the seven members are provably distinct, and an
            identity that cannot be read proves nothing.

            The two `features/*` members are passed in with a VERIFIED `h5py.Group` parent — the
            caller resolves `/matrix/features` and refuses a non-Group by name (#539) before
            they are passed — so for those two, `parent[member]` cannot raise the
            Dataset-subscript `ValueError` or the numpy `AttributeError` that motivated #539.
            The other five were passed `group` (`h5["matrix"]`), whose type was NOT checked
            here or anywhere: a `/matrix` that was itself a Dataset died earlier, at the
            unguarded `member not in group` membership test, with a raw traceback at rc 1 —
            an open INV-9 defect of the same class one level up, filed separately as #585,
            NOT closed by #539. RETIRED BY #585: the `isinstance(group, h5py.Group)`
            refusal now sits immediately after `group = h5["matrix"]` in `run_import`,
            before the membership loop, so the `group` parent of the other five members is
            a VERIFIED Group too and the class is closed — this sentence is the record of
            the open state (and of #539 deliberately not closing it), not of the module
            today.
            """
            try:
                obj = parent[member]
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

        def _refuse_aliased_matrix_members(group):
            """The seven consumed `/matrix` members must be SEVEN DISTINCT OBJECTS.

            `run_import` consumes exactly seven members: `/matrix/barcodes`,
            `/matrix/features/id`, `/matrix/features/name`, `/matrix/shape`, `/matrix/data`,
            `/matrix/indices` and `/matrix/indptr`. A HARD LINK or a SAME-FILE SoftLink chain
            can make two of those names resolve to ONE object -- MEASURED through the shipped
            entrypoint on the sibling importer `spatial-import-visium` (#507): `/matrix/data`
            as a HARD LINK to `/matrix/indices` imported at rc 0 with the store's `data`
            holding the INDICES values instead of counts, and `/matrix/data` as a 15-hop
            SAME-FILE SoftLink chain ending at `/matrix/indices` imported at rc 0 the same
            way. HD was only ASSUMED to carry the same class until measured (#507); the new
            tests in this package verify POST-fix that both spellings are refused here too.
            The realpath check in `_refuse_outside_matrix_objects` compares the FILE an
            object lives in, never the OBJECT a name resolves to -- a same-file alias passes
            it. So the seven consumed members are resolved here and required to be seven
            DISTINCT HDF5 objects, identified by the file-number + object-address pair
            (`h5py.h5o.get_info(obj.id)` exposes `.fileno` and `.addr`), not by the Python
            object and not by `id()`.

            A legitimate bundle can never trip this: those seven are seven semantically
            distinct arrays and no writer aliases them. A member that is genuinely ABSENT is
            skipped -- absence is refused by name elsewhere, and this check must not turn a
            clean "has no `/matrix/shape`" into a confusing collision message. The check is
            scoped to those seven consumed paths ONLY: an extra hard link or same-file
            SoftLink under `/matrix` under a name this importer does not consume is
            legitimate and must keep importing.

            One case is deliberately NOT closed, and no structural check can close it: a
            consumed member redirected -- by hard link or same-file SoftLink -- to an EXTRA
            dataset planted inside this same file that is not one of the seven consumed
            members and collides with none of them. The distinctness check cannot see it:
            the planted dataset is a distinct object, so no two consumed names resolve to
            one object. #461's own review comment records that nothing structural can catch
            this -- a self-contained dataset holding wrong values is byte-indistinguishable
            from a legitimate one -- and that comment is the source of this check's scoping
            decision. So "a consumed member SoftLinked to an extra planted dataset still
            imports" is documented, deliberate scope, not a missed bug.

            One more thing this function requires of a PRESENT `/matrix/features`: it must
            resolve to a GROUP (#539). The two `features/*` members are resolved through it,
            and a Dataset there -- plain inline, same-file SoftLink, hard link or
            compound-dtype -- escaped as a raw `ValueError`/`AttributeError` traceback at
            rc 1 (MEASURED; the sibling importer closed the same boundary in
            `refuse_malformed_features` (#451)). So a non-Group is refused HERE, before the
            identity check, on the resolved object's type; absence (`KeyError` above) is
            still skipped and named by the later guarded resolution (#536).
            """
            # The consumed members, as (label, parent, member) triples -- seven when
            # `/matrix/features` is present, five when it is absent (the two `features/*`
            # rows are skipped). Each label is a
            # literal, so a collision message can name both paths without a subscript. The two
            # `features` members resolve through `group["features"]` -- resolved ONCE, guarded,
            # because a group that cannot be read cannot be verified distinct either. A
            # `KeyError` here means the group is genuinely ABSENT -- only because
            # `_refuse_outside_matrix_objects` (called immediately before this function) has
            # already refused any dangling or broken link at `/matrix/features`, so a
            # `KeyError` reaching this point can only mean the key was never present: the two
            # `features/*` rows
            # are skipped, exactly as `_matrix_member_identity` skips a member whose parent
            # lookup raised `KeyError` -- absence is refused by name in the later guarded
            # `features = group["features"]` resolution, which raises the precise "has no
            # `/matrix/features` group" message. A PRESENT `/matrix/features` that is NOT a
            # Group is refused by name below (#539) -- the only other way this resolution can
            # end -- so the two `features/*` rows are resolved through a verified Group.
            try:
                features_group = group["features"]
            except VisiumImportError:
                raise
            except KeyError:
                features_group = None
            except (OSError, TypeError, RuntimeError) as exc:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s `/matrix/features` group cannot be read "
                    f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                    "matrix carries the feature ids and names under `/matrix/features`; a "
                    "group that cannot be read cannot be verified distinct, so it cannot be "
                    "imported. Refusing rather than shipping a wrong matrix."
                ) from None
            # A PRESENT `/matrix/features` MUST RESOLVE TO A GROUP (#539). The structural
            # walk above refuses an ExternalLink, a broken link, virtual/external storage and
            # a non-dataset/non-group object -- but a plain inline Dataset, a same-file
            # SoftLink to a Dataset and a HARD LINK to a Dataset all PASS it (same file,
            # inline, an h5py.Dataset), and this function then resolves the two `features/*`
            # members through `features_group`. Subscripting a NON-compound Dataset with a
            # name is h5py's `ValueError: Field names only allowed for compound types`, and
            # a COMPOUND-dtype Dataset's `dataset["id"]` SUCCEEDS returning a numpy field
            # array whose `.id` is an `AttributeError` -- MEASURED through the shipped
            # entrypoint on main (0.12.0): all four shapes escaped as a raw traceback at
            # rc 1 with zero output paths. (The sibling importer closed the SAME boundary at
            # `refuse_malformed_features`, #451: "is not a group".) Widening the exception
            # tuples here is NOT equally false-framed for every spelling: for the
            # NON-compound shapes it would turn the crash into a FALSE diagnosis -- the
            # message would quote h5py's field-name error under "link exists but its target
            # cannot be read", and the target IS readable. For the COMPOUND-dtype spelling
            # it changes NOTHING: `dataset["id"]` never raises (the subscript succeeds and
            # returns a numpy field array), so the crash merely moves to the `AttributeError`
            # on that field array and the run STILL dies at rc 1 -- TEST-91 is the row for
            # this spelling; the counterfactual itself is MEASURED in its docstring, not
            # asserted by it. So
            # the class is refused on the RESOLVED OBJECT, BY NAME: whatever an inline
            # object or a link resolves to, if it is not a Group the matrix is not a
            # feature-barcode matrix this importer can carry. Absence (`KeyError` above) is
            # untouched: the later guarded resolution
            # still raises the precise "has no `/matrix/features` group" message (#536).
            if features_group is not None and not isinstance(features_group, h5py.Group):
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s `/matrix/features` is not a group "
                    f"({_quoted_for_refusal(type(features_group).__name__, noun='type name')}). "
                    "A 10x feature-barcode matrix stores the feature ids, names and types "
                    "under `/matrix/features` in a GROUP; a `/matrix/features` that is not "
                    "a group has no `/matrix/features/id` or `/matrix/features/name` member "
                    "to label the columns of its counts matrix with. Refusing rather than "
                    "shipping a wrong matrix."
                )
            consumed = [
                ("/matrix/barcodes", group, "barcodes"),
                ("/matrix/shape", group, "shape"),
                ("/matrix/data", group, "data"),
                ("/matrix/indices", group, "indices"),
                ("/matrix/indptr", group, "indptr"),
            ]
            if features_group is not None:
                consumed.extend(
                    [
                        ("/matrix/features/id", features_group, "id"),
                        ("/matrix/features/name", features_group, "name"),
                    ]
                )
            for label_a, parent_a, member_a in consumed:
                identity_a = _matrix_member_identity(parent_a, label_a, member_a)
                if identity_a is None:
                    continue
                for label_b, parent_b, member_b in consumed:
                    if label_b == label_a:
                        continue
                    identity_b = _matrix_member_identity(parent_b, label_b, member_b)
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

        _refuse_outside_matrix_objects(group)
        _refuse_aliased_matrix_members(group)
        # THE ROOT-ATTRIBUTE READ IS GUARDED (#648). `dict(h5.attrs)` MATERIALISES every
        # attribute value, and h5py raises while doing so on a truncated or corrupt
        # attribute, a datatype it cannot map, or an attribute whose object header or
        # global-heap backing is damaged. None of those is a `VisiumImportError`, so
        # they escaped `main()`'s `except VisiumImportError` as rc 1 and a raw
        # traceback with absolute source paths — INV-1's prohibited outcome. MEASURED
        # through the shipped entrypoint on this base: a vlen root attribute whose
        # global-heap object length is corrupt raised
        # `OSError: Can't synchronously read data (ran off end of input buffer while
        # decoding)` at this exact line, rc 1, 0 paths. The guard is NARROW in
        # POSITION on purpose: only the materialisation is wrapped, so a genuine
        # internal error in the hundreds of lines below is not laundered into a
        # refusal about the customer's bundle. And it is NARROW in MEMBERSHIP:
        # `refuse_unencodable_vendor_text` (the parse boundary immediately below) is
        # NOT wrapped, and its semantics do not change. The read is before the first
        # writer (`txr_csc.write_csc_zarr`), so a refusal here leaves no store, no
        # partial store and nothing for a later reader to find (INV-2).
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
                "`binned_outputs/` bundle. Refusing rather than shipping a matrix "
                "this importer cannot describe."
            ) from None
        # A PARSE BOUNDARY. h5py decodes a UTF-8-typed string attribute with
        # `surrogateescape`, so a root attribute holding invalid bytes comes back as lone
        # surrogates — a `str` no UTF-8 encoder can write — and a fixed-length `|S` attribute
        # comes back as raw invalid `bytes`, which is the shape a real bundle uses for
        # `library_ids`. Both reach `vendor_provenance`, and from there `provenance.library_id`
        # and `coordinate_space_id`.
        refuse_unencodable_vendor_text(
            attrs,
            source=f"`{MATRIX_BASENAME}`'s root attributes",
            remedy="Re-export the complete Space Ranger `binned_outputs/` bundle.",
        )
        # THE SHAPE-DATASET READ IS GUARDED (#650). `group["shape"][:]` MATERIALISES the
        # whole declared shape, and a dataset whose metadata is fine but whose BYTES are
        # undecodable (an unavailable filter, a truncated chunk, a checksum failure) raises
        # `OSError`, while file-declared dims exceeding C ssize_t raise OverflowError and
        # non-integer/negative dims raise ValueError -- none of which reached `main()`'s
        # `except VisiumImportError` before this node (a length merely too large to
        # ALLOCATE is `MemoryError`, in no tuple here, still rc 1 + traceback: the
        # #468/#475 work-bound class, a recorded follow-up, DEC-12). MEASURED through the
        # shipped entrypoint on this base, a fletcher32-corrupt `/matrix/shape` gave rc 1
        # and a raw traceback at this exact line -- INV-1's prohibited outcome. The guard
        # is NARROW
        # in POSITION (only this one expression is wrapped, so a genuine internal error
        # below is not laundered into a refusal about the customer's bundle); the re-raise
        # is handler 0 (`VisiumImportError` IS a `RuntimeError`); the tuple is the six-name
        # fence #648's DEC-3 established, with ValueError/OverflowError IN ON PURPOSE
        # because the read allocates `numpy.zeros(shape, dtype)` from the FILE-DECLARED
        # dataspace dims (the a788ec896 rationale). The `len(shape) != 2` parse boundary
        # below is a SIBLING AFTER the try, never inside it.
        try:
            shape = [int(x) for x in np.asarray(group["shape"][:]).tolist()]
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, ValueError, RuntimeError, OverflowError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} has no readable `/matrix/shape` "
                f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
                f"{_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
                "stores its dimensions there, and this importer declares the CSC orientation "
                "from that dataset rather than sniffing it."
            ) from None
        if len(shape) != 2:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/shape` has "
                f"{_quoted_list_for_refusal(shape, noun='dimension')}, which is not the two "
                "dimensions a feature-barcode matrix has."
            )
        # `int(...)` is a no-op at runtime — `shape` is already `[int(x) for x in ...]` — and
        # is written so the #336 structural guard can PROVE these two names are integers where
        # they are interpolated into a refusal below. A guard that cannot prove a value safe
        # must refuse it, so the source states the fact rather than the guard guessing.
        n_features, n_barcodes = int(shape[0]), int(shape[1])
        # STRICTLY, and refused BY NAME. These are join keys, so a loose decode would pair one
        # bin's position with another bin's counts.
        barcodes = decoded_h5_strings(group, "barcodes")
        # RESOLVED THROUGH ITS OWN GUARD, not inline. `decoded_h5_strings` guards `group[name]`
        # -- but `group["features"]` was being evaluated at the CALL SITE, outside that guard,
        # so an h5 with no `/matrix/features` raised a raw `KeyError` from the argument list
        # and never reached the helper that exists to name it.
        # THE FEATURES-GROUP RESOLUTION IS GUARDED (#650). The alias check's own resolution
        # immediately above (`_refuse_aliased_matrix_members`) already refuses an unreadable
        # `/matrix/features` by name, and THIS
        # second resolution keeps the same discipline: a `KeyError` means the group is
        # genuinely ABSENT (#536 -- the "has no ... group" sentence below, true for
        # absence), while a present-but-unreadable member (`OSError`), a corrupted/dotted
        # object (`TypeError`) or a traversal failure (`RuntimeError`) must NEVER be
        # reported as absent -- the sibling's rule ("a member that exists but cannot be
        # read must never be reported as absent", import_visium.py:1126-1129), which the
        # pre-existing `(KeyError, RuntimeError)` tuple violated for RuntimeError.
        # `VisiumImportError` re-raises FIRST (handler 0) for the same RuntimeError-subclass
        # reason as everywhere in this module.
        try:
            features = group["features"]
        except VisiumImportError:
            raise
        except KeyError:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} has no `/matrix/features` group. A 10x feature-barcode "
                "matrix carries the feature ids, names and types there; without it there is "
                "nothing to label the columns of the counts matrix with."
            ) from None
        except (OSError, TypeError, RuntimeError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/features` cannot be read "
                f"({_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode "
                "matrix carries the feature ids, names and types there; a member that "
                "cannot be read is not a matrix this importer can carry. Refusing rather "
                "than importing a matrix whose features cannot be named."
            ) from None
        gene_ids = decoded_h5_strings(features, "id", "/matrix/features/id")
        gene_names = decoded_h5_strings(features, "name", "/matrix/features/name")
        if len(barcodes) != n_barcodes or len(gene_ids) != n_features:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} declares shape "
                f"{_quoted_list_for_refusal(shape, noun='dimension')} but carries "
                f"{len(gene_ids)} features and {len(barcodes)} barcodes."
            )

        # ── THE BARCODE JOIN, ABOVE THE FIRST WRITER (INV-8) ─────────────────────────
        #
        # `tissue_positions.parquet` holds EVERY square on the capture area; the filtered
        # matrix holds only the in-tissue subset, in ITS OWN order. A positional zip of the
        # two would align the wrong square to the wrong barcode for every row — which is not
        # an error, it is a picture of the tissue with the values shuffled.
        #
        # It runs HERE, inside the `h5py` context and before `write_csc_zarr`, purely so that
        # its refusals leave nothing on disk. It needs only `barcodes`, which is already read.
        progress("positions", 20, "joining tissue positions to the matrix barcodes")
        by_barcode = {}
        for i, bc in enumerate(positions["barcode"]):
            if bc in by_barcode:
                raise VisiumImportError(
                    f"{_quoted_for_refusal(Path(selected['positions']).name, noun='file name')} "
                    f"lists barcode {_quoted_for_refusal(bc, noun='barcode')} more than once; "
                    "a square has one position and choosing between two would be a guess."
                )
            by_barcode[bc] = i
        # THE OTHER SIDE OF THE SAME QUESTION. The positions-side duplicate is refused above
        # ("a square has one position"); the MATRIX-side duplicate was silently accepted, and
        # it is worse: two matrix columns map onto ONE position, `axis/barcode.zarr` ships a
        # non-unique key sequence, and every downstream `aligned_to` join on the cells axis is
        # then ambiguous. The digest self-check further down cannot see it -- it checks that
        # the digest matches, not that the keys are distinct.
        seen_barcodes, repeated = set(), []
        for bc in barcodes:
            (repeated.append(bc) if bc in seen_barcodes else seen_barcodes.add(bc))
        if repeated:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} lists {len(repeated)} barcode(s) more than once "
                f"(first: {_quoted_list_for_refusal(repeated[:3], noun='barcode')}). A "
                "barcode is the key every artifact on the cells axis is joined by, so a "
                "repeated one makes the emitted axis index ambiguous -- two rows of counts "
                "claiming one square, and no downstream join able to tell them apart."
            )
        if not barcodes:
            # An EMPTY matrix imports cleanly otherwise: the length cross-check passes (0 ==
            # 0), every writer accepts an empty column, and the result is a complete,
            # coherent, empty dataset. That is a plausible wrong answer rather than an error
            # -- a user sees an import that "worked" and a tissue map with nothing on it.
            raise VisiumImportError(
                f"{MATRIX_BASENAME} carries no barcodes at all, so the {int(bin_um)} um bin "
                "has no squares under tissue. An empty matrix imports at exit 0 and is "
                "reported as SUCCESS, and there is no outcome REPORTED TO THE OPERATOR as "
                "anything other than SUCCESS: the process would exit 0 and emit the same "
                "closing `progress(\"done\", 100, ...)` line as a full import -- 17 outputs "
                "on this node's committed fixture, a number that is `len(entries)` and so "
                "bundle-dependent -- and the report's `image_warnings` / note fields are "
                "PASSIVE: they change nothing about the exit code or stderr and are only "
                "visible to someone who opens the report artifact. (MEASURED on this "
                "node's committed fixture with the empty-matrix refusals set aside: "
                "the same import then streams "
                "`progress: matrix|35|0 "
                f"bins x {int(n_features)} genes` and `progress: coordinates|60|0 bin "
                "positions`, and its report states `n_bins: 0` and `n_bins_in_tissue: 0` -- "
                "so the emptiness IS visible in the stream and the report; what still does "
                "not exist is any non-SUCCESS outcome: no warning and no error, and the "
                "operator would still be told the import SUCCEEDED while downstream analysis "
                "runs on an empty matrix.) Check that Space Ranger detected tissue on this "
                "run. Refusing rather than shipping an empty matrix as a successful import."
            )
        missing = [bc for bc in barcodes if bc not in by_barcode]
        if missing:
            raise VisiumImportError(
                f"{len(missing)} of the matrix's {n_barcodes} barcodes have no row in "
                f"{_quoted_for_refusal(Path(selected['positions']).name, noun='file name')} "
                f"(first: {_quoted_list_for_refusal(missing[:3], noun='barcode')}). Absence is "
                "absence: a square with no position cannot be given one, and writing a "
                "placeholder coordinate would put those squares somewhere real-looking on the "
                "tissue. Re-export the bundle with a positions table covering the filtered "
                f"matrix of the {int(bin_um)} um bin."
            )
        rows = np.asarray([by_barcode[bc] for bc in barcodes], dtype=np.int64)

        def column(name, kind):
            """One positions column, joined to the matrix order and CHECKED, as a numpy array.

            The check is the point. A parquet column is TYPED, so unlike the sibling's CSV --
            where every value arrives as a `str` and only `float()` can fail -- a vendor may
            legitimately write `pxl_row_in_fullres` as a float and put `inf` or `nan` in it,
            or write `array_row` as an int64 holding a value no `int32` can hold. Neither is
            a `TypeError` or a `ValueError`: `int(float('inf'))` raises `OverflowError`, and
            `np.asarray(2**40, dtype=np.int32)` raises `OverflowError` under numpy 2. Both
            escaped `main()` as exit-1 tracebacks, which is INV-9's prohibited outcome, and
            both are shapes only the parquet reader can present.

            So the values are tested rather than cast-and-hoped, and the refusal NAMES the
            offending row -- which is the file's own row, because `rows` indexes the whole
            table.
            """
            taken = np.asarray(positions[name], dtype=np.float64)[rows]
            bad = ~np.isfinite(taken)
            if bad.any():
                first = int(np.flatnonzero(bad)[0])
                raise VisiumImportError(
                    f"{_quoted_for_refusal(Path(selected['positions']).name, noun='file name')} "
                    # FUNNELLED rather than left as `{name!r}`. `name` is one of this
                    # module's own `POSITION_COLUMNS` literals at every call site, so it
                    # carries no vendor byte -- but the #336 structural guard cannot PROVE
                    # that through a nested helper's parameter, and its rule is that a value
                    # it cannot prove safe must be routed.
                    f"column {_quoted_for_refusal(name, noun='column name')} holds a value "
                    f"that is not a finite number, at the row matching barcode "
                    f"{_quoted_for_refusal(barcodes[first], noun='barcode')}. A coordinate "
                    "that is infinite or not-a-number places a square nowhere, and carrying "
                    "it would poison every aggregate computed over the tissue map."
                )
            if kind is float:
                return taken
            integral = np.equal(np.rint(taken), taken)
            in_range = (taken >= np.iinfo(np.int32).min) & (taken <= np.iinfo(np.int32).max)
            usable = integral & in_range
            if not usable.all():
                first = int(np.flatnonzero(~usable)[0])
                raise VisiumImportError(
                    f"{_quoted_for_refusal(Path(selected['positions']).name, noun='file name')} "
                    f"column {_quoted_for_refusal(name, noun='column name')} holds "
                    f"{_quoted_for_refusal(float(taken[first]), noun='value')} at the row "
                    f"matching barcode {_quoted_for_refusal(barcodes[first], noun='barcode')}, "
                    "which is not a whole number this importer can store as a 32-bit grid "
                    "index. `array_row` and `array_col` are lattice indices and `in_tissue` "
                    "is a flag; none of them has a fractional or out-of-range value."
                )
            return taken.astype(np.int32)

        def coordinate(name):
            """One coordinate column at `float32`, RANGE-CHECKED before the cast.

            `column()` proves the value is finite IN FLOAT64 and its refusal says an infinite
            coordinate "places a square nowhere" -- and then a bare `.astype(np.float32)`
            threw that guarantee away. A parquet column is typed, so a vendor can carry
            `1e39`: perfectly finite as a double, `inf` as a single. MEASURED on this
            package's own fixture with `1e39` in an IN-TISSUE row: exit 0, 120 paths, an
            `inf` in `spatial/coordinates.zarr` AND in the `spatial_x` component column, the
            registration QC still `pass` (it reads the same column at float64), and the only
            trace a human gets is an image warning reading "the bins extend to inf x 640",
            which reads like a cropped image rather than a poisoned coordinate.

            That is INV-5 inverted: a real square given a coordinate that is not a place,
            with every internal check green. The cast is checked against float32's own range,
            and the refusal names the barcode.
            """
            values = column(name, float)
            limit = float(np.finfo(np.float32).max)
            over = np.abs(values) > limit
            if over.any():
                first = int(np.flatnonzero(over)[0])
                raise VisiumImportError(
                    f"{_quoted_for_refusal(Path(selected['positions']).name, noun='file name')} "
                    f"column {_quoted_for_refusal(name, noun='column name')} holds "
                    f"{_quoted_for_refusal(float(values[first]), noun='value')} at the row "
                    f"matching barcode "
                    f"{_quoted_for_refusal(barcodes[first], noun='barcode')}, which is larger "
                    "than the largest number this importer can store as a coordinate. "
                    "Coordinates are written as 32-bit floats; a value past that range "
                    "becomes infinite on the way in and would place a square nowhere while "
                    "every internal check still passed."
                )
            return values.astype(np.float32)

        # Materialised BEFORE the first writer too, for the same reason: `column` refuses on a
        # non-numeric value, and a refusal here must also leave nothing behind.
        xs = coordinate("pxl_col_in_fullres")
        ys = coordinate("pxl_row_in_fullres")
        array_row = column("array_row", int)
        array_col = column("array_col", int)
        in_tissue = column("in_tissue", int) != 0

        # THE RUN'S IDENTITY, resolved HERE and not after the writer. `coordinate_space_id`
        # REFUSES a bundle that carries no library id and no sample id (see there), and a
        # refusal must leave nothing behind -- so both reads move above the first write rather
        # than the refusal being softened to fit where they used to sit. Both are pure and
        # both results are bound once, so nothing else about the import moves.
        provenance = vendor_provenance(attrs, bundle["metrics"])
        space_id, space_id_source = coordinate_space_id(provenance, attrs)

        # THE MATRIX'S OWN INTERNAL CONSISTENCY, checked before it is handed to the writer.
        # `txr_csc.write_csc_zarr` streams `indptr`/`indices` and raises out of `_lib` on a
        # malformed one -- MEASURED, a non-monotonic `indptr` gives `ValueError: repeats may
        # not contain negative values` from inside the framework, which `main()` does not
        # catch: exit 1, a raw traceback, and paths already on disk. `_lib` is shared
        # framework and its raise is not this package's to change; validating the vendor's
        # file before handing it over is.
        #
        # THE INDPTR-DATASET READ IS GUARDED (#650), the same narrow shape as the shape
        # read above: `group["indptr"][:]` MATERIALISES the whole declared array, and a
        # chunk corruption / unavailable filter raises `OSError`, while file-declared dims
        # exceeding C ssize_t raise OverflowError and non-integer/negative dims raise
        # ValueError -- none of which reached `main()`'s `except VisiumImportError` before
        # this node (a length merely too large to ALLOCATE is `MemoryError`, in no tuple
        # here, still rc 1 + traceback: the #468/#475 work-bound class, a recorded
        # follow-up, DEC-12). MEASURED on this base: a fletcher32-corrupt
        # `/matrix/indptr` gave rc 1 and a raw traceback at :3322, 0 paths. Re-raise
        # FIRST, six-name fence, narrow position; the
        # `indptr.ndim != 1` parse boundary below is a SIBLING AFTER the try.
        try:
            indptr = np.asarray(group["indptr"][:])
        except VisiumImportError:
            raise
        except (KeyError, OSError, TypeError, ValueError, RuntimeError, OverflowError) as exc:
            raise VisiumImportError(
                f"{MATRIX_BASENAME} has no readable `/matrix/indptr` "
                f"({_quoted_for_refusal(type(exc).__name__, noun='type name')}: "
                f"{_quoted_for_refusal(exc, noun='message')}). A 10x feature-barcode matrix "
                "stores the CSC column offsets there."
            ) from None
        # THE DIMENSIONALITY IS NAMED SEPARATELY, because folding it into the entry count
        # produces a refusal that states a contradiction. A `(53, 1)` `indptr` has ndim 2 and
        # `size` 53, so the single message read "has 53 entries; a CSC matrix over 52 barcodes
        # has exactly 53" -- literally true, unactionable, and the reader is left believing the
        # importer cannot count. INV-9 asks for a line a human can act on, not merely one line.
        if indptr.ndim != 1:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indptr` is "
                f"{int(indptr.ndim)}-dimensional (shape "
                f"{_quoted_for_refusal(tuple(int(d) for d in indptr.shape), noun='shape')}). "
                "A CSC offset array is a flat list of column offsets."
            )
        if len(indptr) != n_barcodes + 1:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indptr` has {int(indptr.size)} entries; a CSC "
                f"matrix over {int(n_barcodes)} barcodes has exactly "
                f"{int(n_barcodes) + 1}."
            )
        # AND EVERY MEMBER OF THE TRIPLE MUST BE A NUMBER, checked BY DTYPE before any
        # arithmetic touches it. Every shape and value check below is written in numpy, and
        # numpy's failure on a non-numeric array is an exception from inside numpy rather than
        # a False -- so a guard that only bounds VALUES becomes the thing that raises.
        # MEASURED through the shipped entrypoint, each with the member rewritten as an `|S1`
        # dataset of the same length (a legal HDF5 dataset a vendor tool can produce):
        #
        #   `indptr`  -> exit 1, `ValueError: invalid literal for int() with base 10: b'x'`
        #                out of the `astype(np.int64)` on the line below -- inside this very
        #                guard block, which is the shape a value-only check always has
        #   `data`    -> exit 1 and FIVE PATHS ON DISK, `ValueError: could not convert string
        #                to float` from `_lib/txr_csc.py::_scatter_band` -- past the first
        #                writer, so INV-8 as well as INV-9
        #   `indices` -> exit 1, `_UFuncNoLoopError: ufunc 'minimum' did not contain a loop
        #                with signature matching types (dtype('S1'), dtype('S1'))` out of the
        #                id-range scan below
        #
        # `indptr` and `indices` are INDICES and must be integers; a float `indices` imports
        # today by silently truncating toward zero in `_lib`'s `astype(np.intp)`, which turns a
        # damaged file into a plausible wrong answer. `data` may be any numeric width the
        # vendor writes (10x writes int32; float and boolean are legal CSC values).
        # Each member is checked at the point its own SHAPE has already been settled, so the
        # "not a one-dimensional dataset" refusals below keep naming the defect they name;
        # `indptr`'s is here because its cast is the very next line.
        def _refuse_wrong_dtype(member, kinds, noun, what):
            try:
                kind = group[member].dtype.kind
            except Exception:
                kind = None
            if kind in tuple(kinds):
                return
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/{member}` is not stored as {noun} "
                f"({_quoted_for_refusal(kind, noun='dtype kind')}). A 10x feature-barcode "
                f"matrix stores {what} there; anything else is not a matrix this importer "
                "can read, and every check below it is written in numpy -- so the guard "
                "becomes the thing that raises, from inside numpy or from inside the store "
                "writer, rather than saying anything about this bundle."
            )

        _refuse_wrong_dtype("indptr", "iu", "an integer", "the CSC column offsets")
        # CAST TO SIGNED FIRST, and this is the whole check rather than a tidiness.
        # `np.diff` inherits the array's dtype, and h5py hands back whatever the FILE
        # declares -- 10x writes int64, but a `uint32`/`uint64` `indptr` is a legal HDF5
        # dataset. On an unsigned array a DECREASE wraps to a huge positive number, so
        # `(np.diff(indptr) < 0).any()` is unconditionally False and the guard passes
        # everything. MEASURED at uint32 through the shipped entrypoint: the failure this
        # guard exists to prevent arrives verbatim -- `ValueError: repeats may not contain
        # negative values` out of `_lib/txr_csc.py`, exit 1, five paths on disk. The suite
        # could not see it because the hostile builder writes back through
        # `h5["matrix/indptr"][:] = ...`, which PRESERVES the fixture's int64.
        indptr = indptr.astype(np.int64, copy=False)
        if indptr.size and (int(indptr[0]) != 0
                            or bool(np.any(indptr[1:] < indptr[:-1]))):
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indptr` is not a valid CSC offset array -- it "
                "must start at 0 and never decrease. A malformed one does not describe a "
                "matrix at all, and handing it to the store writer produces a failure from "
                "inside the framework rather than a statement about this bundle."
            )
        # AND IT MUST END AT `nnz`. `indptr[-1]` is the total stored-value count by
        # definition; a monotonic array that disagrees with `len(data)` still describes no
        # matrix, and the writer reads past the end or silently truncates the last columns.
        # `/matrix/data` MUST BE A SIZEABLE 1-D DATASET, and failing to size it is a REFUSAL
        # rather than a reason to skip the check.
        #
        # The first cut wrote `except (KeyError, IndexError, TypeError): nnz = None`, and that
        # tuple was wrong in both directions. A `/matrix/data` that is a GROUP has no `.shape`
        # at all, so `AttributeError` escaped `main()` entirely -- exit 1 with a raw traceback,
        # which INV-9 forbids by name. And a SCALAR dataset has `shape == ()`, so `shape[0]`
        # raised `IndexError`, which WAS caught: the cross-check was silently skipped, the run
        # sailed past the first writer, and it died inside `_lib/txr_csc.py` with
        # `ValueError: Illegal slicing argument for scalar dataspace` -- exit 1 and FIVE PATHS
        # ON DISK. INV-8 and INV-9 broken together, by the exact mechanism this guard's own
        # refusal text says it exists to prevent.
        #
        # An unsizeable `data` is EVIDENCE the matrix is unimportable. Swallowing it converted
        # a refusable bundle into a partial store.
        try:
            shape = tuple(group["data"].shape)
        except Exception:
            shape = None
        if shape is None or len(shape) != 1:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/data` is not a one-dimensional dataset "
                f"({_quoted_for_refusal(shape, noun='shape')}). A 10x feature-barcode matrix "
                "stores its non-zero values there as a flat array; anything else is not a "
                "matrix this importer can read, and handing it to the store writer produces a "
                "failure from inside the framework rather than a statement about this bundle."
            )
        _refuse_wrong_dtype("data", "iufb", "a number", "the matrix's non-zero values")
        nnz = int(shape[0])
        if indptr.size and int(indptr[-1]) != nnz:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indptr` ends at {int(indptr[-1])} but "
                f"`/matrix/data` holds {nnz} value(s). The last CSC offset IS the count of "
                "stored values; a file where they disagree describes no matrix, and the "
                "store writer would read past the end of the data or drop the final columns."
            )
        # `/matrix/indices` GETS THE SAME THREE CHECKS `data` DOES, and it had none.
        #
        # The guard above hardened `data` and `indptr` and stopped there, so the THIRD member
        # of the same CSC triple was handed to `txr_csc.H5CsrSource` unexamined. MEASURED
        # through the shipped entrypoint, each on the committed fixture:
        #
        #   `indices` a GROUP    -> exit 1, `TypeError: Accessing a group is done with bytes
        #                           or str, not <class 'slice'>` out of `_lib/txr_csc.py`
        #   `indices` a SCALAR   -> exit 1, `ValueError: Illegal slicing argument for scalar
        #                           dataspace`, same file
        #   a feature id >= n    -> exit 1, `ValueError: operands could not be broadcast
        #                           together`, from `np.bincount`
        #   a NEGATIVE id        -> exit 1, `ValueError: 'list' argument must have no negative
        #                           elements`
        #
        # All four are raw tracebacks out of shared framework code, which INV-9 forbids by
        # name; the refusal text three blocks up says exactly that and was only ever true of
        # `data`. INV-8 held in all four (the failure lands in `column_counts()`, before the
        # first writer) -- so this is INV-9 alone, and it is fixed where the sibling checks
        # already are rather than in `_lib`, which is shared and not this package's to change.
        try:
            ind_shape = tuple(group["indices"].shape)
        except Exception:
            ind_shape = None
        if ind_shape is None or len(ind_shape) != 1:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indices` is not a one-dimensional dataset "
                f"({_quoted_for_refusal(ind_shape, noun='shape')}). A 10x feature-barcode "
                "matrix stores its feature ids there as a flat array; anything else is not a "
                "matrix this importer can read, and handing it to the store writer produces a "
                "failure from inside the framework rather than a statement about this bundle."
            )
        # AND IT MUST BE EXACTLY `nnz` LONG. `data` and `indices` are the two halves of one
        # stored value -- the count is the same number by definition. A SHORT `indices` is the
        # dangerous direction and the reason this is a refusal rather than a warning: h5py
        # clamps an over-long slice, so `write_csc_zarr` reads what is there and silently DROPS
        # every value past the truncation point. MEASURED with `indices` replaced by its own
        # first half: exit 0, 17 outputs, and a complete, coherent counts store holding 313 of
        # the bundle's 627 non-zero values -- a plausible wrong answer rather than an error,
        # which is the one outcome this module refuses to produce.
        if int(ind_shape[0]) != nnz:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/indices` holds {int(ind_shape[0])} feature "
                f"id(s) but `/matrix/data` holds {nnz} value(s). They are the two halves of "
                "one stored value and their counts are the same number by definition; a file "
                "where they disagree describes no matrix, and the store writer would silently "
                "drop the values it has no id for rather than fail."
            )
        _refuse_wrong_dtype("indices", "iu", "an integer", "the CSC feature ids")
        # AND EVERY ID MUST NAME A FEATURE THIS FILE DECLARES. Scanned in bounded blocks off
        # the dataset -- never materialised whole -- because the 2 um bin's `indices` is
        # millions of entries and this module's memory ceiling is already the open question
        # #367 records. `min`/`max` is the whole test: the writer's `np.bincount` needs
        # `0 <= id < n_features`, and both ends of that arrive as a framework traceback.
        if nnz:
            ind_ds = group["indices"]
            # The SAME block size the writer itself streams at, read off `_lib` rather than
            # re-declared here: a second constant would drift from the one that matters.
            step = max(1, int(txr_csc.READ_NNZ))
            id_lo, id_hi = None, None
            for lo in range(0, nnz, step):
                # THE BLOCK SCAN IS GUARDED (#650) -- the twin of the `/matrix/data` scan
                # below, which was guarded while THIS one was bare. MEASURED on this base
                # through the shipped entrypoint: a fletcher32-corrupt `/matrix/indices`
                # chunk escaped as rc 1 and a raw traceback at this exact line
                # (`OSError: Can't synchronously read data (filter returned failure during
                # read)`, absolute source paths, 0 paths) while the IDENTICAL corruption in
                # `/matrix/data` refused by name at rc 2 -- the asymmetry #650 is about.
                # The guard mirrors the twin EXACTLY (same six-name fence, same message
                # class) and is NARROW in POSITION: only the block read is wrapped, so
                # `ind_ds = group["indices"]` above stays OUTSIDE (symmetric with the
                # twin, and a `group[...]` subscript is not the dataset scan), and the
                # `if not blk.size:` parse boundary below stays a SIBLING AFTER the try.
                try:
                    blk = np.asarray(ind_ds[lo:min(lo + step, nnz)])
                except VisiumImportError:
                    raise
                except (KeyError, OSError, TypeError, ValueError, RuntimeError, OverflowError) as exc:
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
                b_lo, b_hi = int(blk.min()), int(blk.max())
                id_lo = b_lo if id_lo is None else min(id_lo, b_lo)
                id_hi = b_hi if id_hi is None else max(id_hi, b_hi)
            if id_lo is not None and (id_lo < 0 or id_hi >= int(n_features)):
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s `/matrix/indices` holds feature id(s) outside the "
                    f"{int(n_features)} feature(s) this file declares (range {int(id_lo)}.."
                    f"{int(id_hi)}). A CSC column index names a "
                    "row of the matrix; one that names no feature describes no matrix, and "
                    "the store writer fails from inside the framework rather than saying "
                    "anything about this bundle."
                )

        # REFUSAL — `nnz == 0` with `n_barcodes > 0` (the #470 shape). After the two length
        # checks above, `nnz = int(shape[0])` is trustworthy (`shape` here is `/matrix/data`'s
        # own shape, rebound at the `data` check above, NOT `/matrix/shape`): `indptr[-1] ==
        # nnz` and `len(indices) == nnz` are both proven, so the stored-value count is exactly
        # `nnz`. (`indptr[-1] == nnz` is enforced CONDITIONALLY — `if indptr.size` — but the
        # earlier `len(indptr) != n_barcodes + 1` check forces `indptr.size >= 1`, so at this
        # point `indptr[-1]` is unconditionally defined and the equality is unconditionally
        # true.)
        #
        # THE DECISION — REFUSE, and the reason does not depend on any claim about vendor
        # internals:
        #
        # 1. THE LOAD-BEARING REASON, stated alone because it carries BOTH refusals (the
        #    `n_barcodes == 0` refusal above and this one) verbatim: an empty matrix imports
        #    at exit 0 and is reported as SUCCESS, and `main()` has exactly two DESIGNED
        #    outcomes — refuse (`sys.exit(2)`) or succeed (an uncaught exception exits 1 with
        #    a raw traceback, which is INV-9's PROHIBITED outcome, not a designed one). There
        #    is no outcome REPORTED TO THE OPERATOR as anything other than SUCCESS: the
        #    process exits 0 and emits the identical `progress("done", 100, ...)` line
        #    whether the matrix is empty or full, and the report's `image_warnings` / note
        #    fields are PASSIVE — they change nothing about the exit code or stderr and are
        #    only visible to someone who opens the report artifact. It deliberately makes no
        #    blanket claim about detectability: the zero-barcode shape
        #    streams `progress: matrix|35|0 bins x N genes` and a report with `n_bins: 0`/
        #    `n_bins_in_tissue: 0` (the message says so, measured), while the `nnz == 0`
        #    shape streams progress and a report byte-identical to a real import (MEASURED;
        #    the `nnz == 0` message itself states the diagnosis without restating the
        #    measurement). The operator
        #    is told the import SUCCEEDED and downstream analysis runs on nothing. That is a
        #    plausible wrong answer rather than an error, and it is true whether the emptiness
        #    is `n_barcodes == 0` or `nnz == 0` — so this reason, and no claim about what
        #    Space Ranger does or does not produce, is what refuses both shapes.
        # 2. The sibling importer `spatial-import-visium` refuses this exact shape before
        #    its first writer (#445), and #470 requires the two importers to agree.
        # 3. "Import but disclose" cannot meet the issue's own bar. The disclosure channels
        #    that exist are a whisper: `report/html` has no renderer in this application
        #    (#223), `meta` is passive JSON on an artifact card, and `main()` has exactly two
        #    DESIGNED outcomes — refuse (`sys.exit(2)`) or succeed. The report's
        #    `image_warnings` / note fields are a PASSIVE channel that exists but changes
        #    nothing about the exit code or stderr, so a disclosure would not displace the
        #    "SUCCESS" the operator sees. Making it loud would mean building a new channel,
        #    which the issue itself names as an argument for refusing. (The manifest's
        #    `structure.nnz` DOES differ — 0 vs non-zero — but it is the same passive class
        #    as `meta`: a JSON artifact a human opens after the fact, not a signal the
        #    operator acts on, so it does not change the conclusion.)
        #
        # THE COUNTER-ARGUMENT, stated rather than suppressed: the vendor's own model is
        # COMPLETE-WITH-ALERTS, not hard failure — Space Ranger does not fail a zero-spot run
        # (a reading of the vendor's published pipeline source, not verified in this tree: its
        # `spatial_metrics.csv` is understood to mark even 0 spots "acceptable" and raise only
        # an alert rather than an error). The whole downstream ecosystem accepts a zero-nnz
        # matrix silently (a reading of those projects' published sources, not verified in
        # this tree: `scanpy.read_10x_h5` is understood to build a CSR with no `nnz > 0`
        # check; `Seurat::Read10X_h5` an empty `sparseMatrix` with no check; `anndata`
        # likewise). So this refusal is deliberately STRICTER than both the vendor and the
        # ecosystem, and it refuses a shape that may be real. The mitigation is the refusal
        # text itself: it names the raw matrix and `metrics_summary.csv` so an operator whose
        # run was genuinely empty knows exactly how to tell "damaged file" from "real but
        # empty run" — and it names the bin, because HD is multi-bin and the operator needs
        # to know which bin was empty. The refusal is evaluated on the SELECTED bin alone:
        # `run_import` imports exactly one bin (`select_bin`; default `DEFAULT_BIN_UM = 8`),
        # so a bundle whose selected bin is empty while ANOTHER bin carries data is refused
        # even though the bundle is not empty overall. The re-run remedy is NARROW: on Visium
        # HD the 8/16 um bins are aggregations of the same 2 um grid (a reading of the
        # vendor's documented binning model, not verified in this tree), so a bundle empty at
        # one bin is empty at every bin — the recoverable case is essentially reachable only
        # from a corrupted or hand-assembled bundle.
        #
        # INV-8 and INV-9 both hold: within `run_import`'s body the refusal fires before the
        # first writer (nothing above this line has written a byte), and it is a NAMED
        # refusal — `VisiumImportError` — never a traceback and never an exit-1. The sandbox
        # contract creates an EMPTY `outputs/` directory for EVERY run, refused or not
        # (`io_dirs()` does `out.mkdir(parents=True, exist_ok=True)` before `run_import`), so
        # a refused run leaves a directory but no file, no manifest and no partial store —
        # which is why the zero-paths metric counts CHILDREN (`HF.output_paths(out)` uses
        # `rglob("*")`) and not the directory itself.
        if nnz == 0:
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/data` and `/matrix/indices` are both empty "
                f"({int(nnz)} stored values) while the matrix declares {int(n_barcodes)} "
                f"barcode(s) and {int(n_features)} feature(s) for the {int(bin_um)} um bin. "
                "Either the file is damaged or truncated, or this run produced no read that "
                "yielded a usable UMI (tissue detected, library or sequencing failed). Check "
                "`metrics_summary.csv`'s \"Number of Bins Under Tissue\" and the raw matrix "
                "(`raw_feature_bc_matrix.h5`) to tell the two apart."
            )

        # REFUSAL — #533: `nnz > 0` but every `/matrix/data` value is exactly 0. The
        # `nnz == 0` refusal above (#470) and this one are the SAME harm reached by a
        # DIFFERENT shape: the operator is told the import SUCCEEDED and downstream
        # analysis runs on a matrix whose every stored value is 0 — nothing usable.
        #
        # THE DECISION — REFUSE, and the reason is the SAME load-bearing reason that
        # carries the two refusals above, restated here because it is the whole argument:
        # an all-zero matrix imports at exit 0 and is reported as SUCCESS, and there is
        # no outcome reported to the operator as anything other than SUCCESS: the process
        # exits 0 and emits the identical `progress("done", 100, ...)` line whether the
        # matrix is full, all-zero, mixed or all non-finite, and the report's
        # `image_warnings` / note fields are PASSIVE — they change nothing about the exit
        # code or stderr and are only visible to someone who opens the report artifact.
        # MEASURED on this node's committed fixture with the refusals set aside: for the
        # all-zero and mixed shapes every streamed `progress:` line and
        # `visium-hd-import-report.json` are byte-identical to a real import of the
        # bundle, so for those shapes the operator-visible signal does not distinguish
        # them from a real one — and even the manifest's `expression` entry carries
        # the same `structure.nnz` in both, because `nnz` counts stored values and the
        # all-zero/mixed mutation preserves that count; the only difference in anything
        # the report or manifest states is `data.stored_bytes`, a byte count. That reason
        # is AGNOSTIC to WHY the matrix has no usable counts: `nnz == 0` and "`nnz > 0`
        # but every value is exactly 0" are both "downstream analysis runs on nothing
        # usable", so the #470 reasoning extends verbatim — and #548 extends it once
        # more: `nnz > 0` with every stored value non-finite (NaN or Inf) is the SAME
        # "downstream analysis runs on nothing usable", so the #533 reasoning extends
        # verbatim to the non-finite shape too. The operator is told the import
        # SUCCEEDED and downstream analysis runs on a matrix whose every stored value is
        # 0 — or whose every stored value is NaN or Inf — which is why it is refused
        # rather than imported.
        #
        # THE COUNTER-ARGUMENT, stated rather than suppressed: a sparse format
        # LEGITIMATELY permits explicitly stored zeros, so "every stored value is zero"
        # needs a decision about where the boundary sits between a degenerate matrix and
        # one that merely has some stored zeros. The boundary this check draws is the
        # only one that is not a guess: SOME stored zeros among non-zeros is
        # unremarkable (the check does not fire), and EVERY stored value zero is the
        # same "nothing usable" as `nnz == 0` (the check fires). A matrix with some
        # stored zeros and some non-zeros — and one that merely CONTAINS some NaN or Inf
        # among real counts — is untouched.
        #
        # THE COST, stated honestly: this is a blockwise scan that SHORT-CIRCUITS on the
        # first non-zero value — for a healthy matrix that is the first block, so the
        # common case is O(1), not O(nnz). It is the first content read of `/matrix/data`
        # (the checks above sized and typed it but never scanned its values), and on a
        # healthy matrix it reads nothing more than that first block. `data_ds` is bound
        # here from the already-validated `/matrix/data` member; the scan is guarded the
        # same way the reads above are, so an unexpected read failure here is still a
        # named refusal rather than a traceback.
        #
        # THE BOUNDARY IS "EXACTLY 0" AND DOES NOT COVER NaN/Inf: `np.any(blk)` treats
        # NaN as truthy, so an all-NaN or all-Inf `/matrix/data` (dtype kind `f`, which
        # passes the `"iufb"` gate) is NOT refused here and imports at rc 0 with unusable
        # "counts" (MEASURED). That is deliberately out of scope: no measurement in
        # this tree supports a vendor-wide claim about what Space Ranger emits — a
        # NaN in `/matrix/data` is stated here only as this block's inferred reading
        # of a different failure mode (a corrupt file), not yet observed on this
        # tree's committed fixture, tracked separately — and extending this check
        # would widen the divergence #533 closes. — that paragraph is corrected rather than
        # removed, because a disclosure of absence and its retirement are the same claim
        # in two directions. The check NOW covers it (#548): the scan predicate is
        # "usable = FINITE AND NON-ZERO" (`np.isfinite(blk) & (blk != 0)`), so a matrix
        # with NO usable stored value — all-NaN, all-Inf, all-zero, or any mix with no
        # finite non-zero value — is refused before the first writer, while a matrix that
        # merely CONTAINS some NaN/Inf among real counts still imports (the boundary is
        # ALL stored values unusable, mirroring #533's "every one of them exactly 0").
        # The all-zero, the non-finite and the mixed diagnoses are stated in SEPARATE messages, and
        # the sibling importer applies the same predicate, so the agreement #533
        # established is preserved.
        #
        # INV-8 and INV-9 hold for this refusal too: it fires before the first writer
        # (nothing above this line has written a byte), and it is a NAMED refusal —
        # `VisiumImportError` — never a traceback and never an exit-1.
        data_ds = group["data"]
        step = max(1, int(txr_csc.READ_NNZ))
        any_usable = False
        saw_nonfinite = False
        saw_zero = False
        for lo in range(0, len(data_ds), step):
            try:
                blk = np.asarray(data_ds[lo:min(lo + step, len(data_ds))])
            except VisiumImportError:
                raise
            except (KeyError, OSError, TypeError, ValueError, RuntimeError, OverflowError) as exc:
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
                    f"{MATRIX_BASENAME}'s `/matrix/data` holds {int(nnz)} stored "
                    "value(s), not one of them a usable count -- some exactly 0 and some "
                    "non-finite, while the matrix declares "
                    f"{int(n_barcodes)} barcode(s) and {int(n_features)} feature(s) for "
                    f"the {int(bin_um)} um bin. This is not a shape a matrix of real read counts "
                    "produces, and it supports BOTH readings "
                    "honestly: a corrupt or mis-written FILE (damage, truncation or a "
                    "faulty write), OR a genuine run whose reads produced no usable UMI "
                    "and whose matrix was then damaged or truncated -- and the two "
                    "cannot be told apart from this file alone. The refusal takes the "
                    "operator-signal stance: importing at rc 0 reports SUCCESS with "
                    "nothing usable underneath, and there is no outcome REPORTED TO THE "
                    "OPERATOR as anything other than SUCCESS: the process would exit 0 "
                    "and emit the same closing `progress(\"done\", 100, ...)` line as a "
                    "full import (17 outputs on this node's committed fixture; the count "
                    "is `len(entries)`, bundle-dependent), and the report's "
                    "`image_warnings` / note fields are PASSIVE -- they change nothing "
                    "about the exit code or stderr and are only visible to someone who "
                    "opens the report artifact. MEASURED on this node's committed "
                    "fixture with the refusals set aside: every streamed `progress:` "
                    "line and `visium-hd-import-report.json` are byte-identical to a "
                    "real import of this bundle -- so in the streamed progress and the "
                    "report the operator-visible signal does not distinguish this shape "
                    "from a real one, and even the manifest's `expression` entry carries "
                    f"`structure.nnz` {int(nnz)} in both (the only "
                    "difference in anything the report or manifest STATES is "
                    "`data.stored_bytes` (92 vs 763 on this node's committed fixture -- "
                    "a machine-readable byte count, not a stated value count, which no "
                    "note field restates)). The process "
                    "would exit 0 with no warning and no error, and the operator is told "
                    "the import SUCCEEDED while downstream analysis runs on a matrix "
                    "with no usable stored value. Refusing rather than shipping a matrix "
                    "with no usable stored value as a successful import."
                )
            if saw_nonfinite:
                raise VisiumImportError(
                    f"{MATRIX_BASENAME}'s `/matrix/data` holds {int(nnz)} stored "
                    f"value(s), every one of them non-finite, while the matrix declares "
                    f"{int(n_barcodes)} barcode(s) and {int(n_features)} feature(s) for "
                    f"the {int(bin_um)} um bin. A count that is NaN or infinite is not a "
                    "count a matrix of real read counts stores -- the only readings "
                    "supported by this tree are a corrupt or mis-written file, or a "
                    "genuine run whose reads produced no usable UMI and whose matrix was "
                    "then damaged or truncated -- and the two cannot be told apart from "
                    "this file alone. Refusing rather than shipping "
                    "a matrix whose every stored value is unusable as a successful "
                    "import."
                )
            raise VisiumImportError(
                f"{MATRIX_BASENAME}'s `/matrix/data` holds {int(nnz)} stored value(s), "
                f"every one of them exactly 0, while the matrix declares {int(n_barcodes)} "
                f"barcode(s) and {int(n_features)} feature(s) for the {int(bin_um)} um bin. "
                "Such a dataset imports at exit 0 and is reported as SUCCESS, and there is "
                "no outcome REPORTED TO THE OPERATOR as anything other than SUCCESS: the "
                "process would exit 0 and emit the same closing `progress(\"done\", 100, "
                "...)` line as a full import (17 outputs on this node's committed fixture; "
                "the count is `len(entries)`, bundle-dependent), and the report's "
                "`image_warnings` / note fields are PASSIVE -- they change nothing about "
                "the exit code or stderr and are only visible to someone who opens the "
                "report artifact. MEASURED on this node's committed fixture with the "
                "refusals set aside: every streamed `progress:` line and "
                "`visium-hd-import-report.json` are byte-identical to a real import of "
                "this bundle -- so in the streamed progress and the report the "
                "operator-visible signal does not distinguish this shape from a real "
                f"one, and even the manifest's `expression` entry carries `structure.nnz` "
                f"{int(nnz)} in both (the only difference in anything the report or manifest "
                "STATES is `data.stored_bytes` (71 vs 763 on this node's committed "
                "fixture -- a machine-readable byte count, not a stated value count, "
                "which no note field restates)). The process would "
                "exit 0 with no warning and no error, and the operator is told the import "
                "SUCCEEDED while downstream analysis runs on a matrix whose every stored "
                "value is 0 -- which is why it is refused rather than imported. Either the "
                "file is damaged or truncated, or this run produced no read that yielded a "
                "usable UMI (tissue detected, library or sequencing failed). Check "
                "`metrics_summary.csv`'s \"Number of Bins Under Tissue\" and the raw matrix "
                "(`raw_feature_bc_matrix.h5`) to tell the two apart. Refusing rather than "
                "shipping an all-zero matrix as a successful import."
            )

        # ── THE FIRST WRITER. Everything above this line can refuse cleanly. ─────────
        #
        # 10x stores the matrix CSC over (features x barcodes): `indptr` has one entry per
        # BARCODE and `indices` holds FEATURE ids. Read column-per-barcode with row-per-feature
        # is, term for term, CSR over (barcodes x features) — exactly the `bins x genes`
        # row-major source the writer's streaming transpose wants. So the orientation is
        # DECLARED from the file's own shape dataset rather than sniffed, and the whole import
        # stays out-of-core, which matters more here than on Visium: the 2 um bin is millions
        # of rows.
        source = txr_csc.H5CsrSource(group, shape=(n_barcodes, n_features))
        progress("matrix", 35, f"{n_barcodes} bins x {n_features} genes")
        counts_structure = txr_csc.write_csc_zarr(
            source, outputs_dir / "expression.zarr", axes=("cells", "genes"),
        )

    # WHAT ONE ROW IS (INV-4), declared ONCE and stamped on every artifact whose rows are
    # bins. `resolution_um` is read from the BUNDLE, not from a module constant: on a
    # contiguous capture grid a bin's side IS its pitch, so the one number answers both "how
    # big is the area one row measured?" and "how far apart are two rows?". On Visium those
    # are 55 um and 100 um and conflating them was #222; here they genuinely coincide, and
    # saying so is what stops the coincidence being read as an oversight.
    entity = SD.measured_entity(
        kind=ENTITY_KIND, platform=PLATFORM, resolution_um=float(bin_um),
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

    # `measured_entity` on the counts matrix: WHAT IS TRUE, and what is not.
    #
    # §15.1's motivating case IS this bundle -- "Visium HD's 2/8/16 um bins" -- and the counts
    # matrix is the artifact every existing analysis actually consumes, so the identity is
    # stamped here as well as on the tissue map. The design's own instruction is "Stamp it in
    # `meta` at write time", and that is done.
    #
    # WHAT THAT DOES NOT BUY, stated rather than left for a reader to discover: `meta` is a
    # catalog column and it does NOT cross into the sandbox (#211). `MaterializedInput`
    # becomes an `inputs.json` entry of `{slot, kind, content_hash, sandbox_path}` and nothing
    # more; what crosses is the STORE's own bytes. The coordinates store carries the identity
    # in its bytes because `SD.mirror_declarations_into_store` puts it there -- and that
    # mirror is only available to a SPATIALLY PLACED artifact: it requires a full
    # `coordinate_space()` (frame, unit and the affine into it), and refuses a block without
    # one, because "a block without it declares positions in an unknown space".
    #
    # A counts matrix HAS no placement. Giving it a `to_space` to satisfy the mirror would be
    # a false declaration -- the claim that its rows carry positions -- which is a worse
    # defect than the one it would paper over. So the honest statement is:
    #
    #   * a sandboxed consumer handed the COORDINATES artifact can read the identity out of
    #     its bytes (TEST-4 asserts exactly that);
    #   * a sandboxed consumer handed ONLY `expression.zarr` cannot, and falls back to the
    #     `aligned_to` digest it shares with the coordinates.
    #
    # That gap is not this package's to close -- the only mirror the platform has is bound to
    # the spatial declaration block -- and it is TRACKED AS #372 rather than described here
    # and forgotten. An earlier draft of this comment claimed the store carried it; it did
    # not, and a blind audit read the emitted `zarr.json` to prove it.

    entries.append(output_entry(
        "expression", DT_COUNTS, "expression.zarr", "artifact",
        structure=counts_structure,
        meta={"kind": "counts", "n_cells": n_barcodes, "n_genes": n_features,
              "platform": PLATFORM, "provenance": provenance,
              "bin_um": int(bin_um),
              "measured_entity": entity,
              "measured_entity_label": SD.measured_entity_label(entity)},
    ))

    # ── the axis key artifacts ───────────────────────────────────────────────────────
    # A column whose VALUES ARE the axis's entity keys, marked `is_axis_index` so the server
    # can resolve the axis from it. The digest SELF-CHECK is not ceremony: an `aligned_to`
    # stamped on every other artifact and a key artifact whose stored bytes digest to
    # something else would make every alignment on this dataset silently wrong.
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
                "emitting a dataset whose alignment is wrong in a way nothing downstream can "
                "see."
            )
        meta["is_axis_index"] = True
        entries.append(output_entry(
            f"metadata-column:{name}", DT_METADATA_COLUMN, f"axis/{name}.zarr",
            "artifact", label=name, axis=axis, structure=structure, meta=meta,
        ))

    structure, meta = txr_columns.write_metadata_column(
        outputs_dir, "axis/gene_symbol.zarr", "gene_symbol",
        pd.Series([str(g) for g in gene_names]), axis="genes",
        aligned_to=aligned_to["genes"], membership=membership_of["genes"],
    )
    entries.append(output_entry(
        "metadata-column:gene_symbol", DT_METADATA_COLUMN, "axis/gene_symbol.zarr",
        "artifact", label="gene_symbol", axis="genes", structure=structure, meta=meta,
    ))

    # ── the coordinate space ─────────────────────────────────────────────────────────
    # THE TRANSPOSE (INV-3). The table writes `pxl_row_in_fullres` (y) BEFORE
    # `pxl_col_in_fullres` (x); the stored convention is `(x, y)`. Getting this backwards does
    # not error — it draws the tissue transposed, and every downstream neighbourhood is then
    # measured in the wrong place. The committed fixture is NON-SQUARE precisely so a test can
    # see the difference.
    coords = np.ascontiguousarray(np.stack([xs, ys], axis=1), dtype=np.float32)
    microns_per_pixel, scale_source = micron_scale(scalefactors)
    space = SD.coordinate_space(
        space=space_id,
        # FULL-RESOLUTION PIXELS, always (INV-1). Storing hires-scaled coordinates would bake
        # in a choice of image and make a second image unplaceable. The coordinates therefore
        # map into their own space by the IDENTITY affine, and each image declares its own
        # affine INTO this frame — the direction that composes.
        unit="pixel",
        to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        microns_per_pixel=microns_per_pixel,
        # Declared INSIDE the space block — not bolted onto `meta` afterwards — because this
        # block is what crosses into the sandbox (#211): a provenance recorded outside it is a
        # provenance no analysis can read.
        microns_per_pixel_source=scale_source,
        coordinate_space_source=space_id_source,
    )
    placement = SD.positioning(
        # Every barcode in the filtered matrix has a position — the join above REFUSED the run
        # otherwise — so this is a measured claim, not an optimistic default.
        partial=False,
    )
    series = SD.section(
        sample_id=provenance.get("sample_id") or provenance.get("library_id") or space_id,
        # One section per bundle: a Space Ranger run is one capture area. The bin does not
        # change the section — that is what makes two bins of one run a resolution group
        # rather than two sections.
        index=0,
    )

    coord_structure, coord_meta = SD.write_spatial_coordinates(
        outputs_dir, "spatial/coordinates.zarr", coords,
        axis="cells", space=space, entity=entity, placement=placement, series=series,
        aligned_to=aligned_to["cells"], membership=membership_of["cells"],
    )
    coord_meta.update({
        "platform": PLATFORM,
        "provenance": provenance,
        "bin_um": int(bin_um),
        # #183 OPTION A — the two 1-D siblings this artifact's positions can also be read as.
        # Declared HERE, in `meta`, because the filter-VD gather re-mints `structure` and
        # copies `meta` verbatim, so this is the only channel the declaration survives a filter
        # in. The client uses the SAME declaration to offer the tissue map in the Coordinates
        # picker and to draw it, so the artifact can never be offered-but-blank.
        "component_columns": [COMPONENT_X, COMPONENT_Y],
    })
    if "spot_diameter_fullres" in scalefactors:
        # §7.3 rule 4: an entity is an AREA, not a point, and the renderer needs its size to
        # draw it at every zoom. Carried through VERBATIM, under the vendor's own key, and
        # with no statement about what it means on HD — see `micron_scale`'s docstring: this
        # repo's only description of the field is 10x's own "intended for visualization
        # purposes, and can vary for different slide designs" (`01-file-formats.md:611-612`),
        # and #257 is what taking one reading of it as universal costs. Nothing here derives
        # from it.
        coord_meta["spot_diameter_fullres"] = scalefactors["spot_diameter_fullres"]
    entries.append(output_entry(
        "spatial-coordinates", DT_COORDINATES, "spatial/coordinates.zarr", "artifact",
        label="tissue map", axis="cells",
        structure=coord_structure, meta=coord_meta,
    ))
    progress("coordinates", 60, f"{len(coords)} bin positions")

    # ── the per-bin columns ──────────────────────────────────────────────────────────
    per_bin = [
        # `in_tissue` as a BOOL, which `write_metadata_column` stores as a categorical with a
        # declared `["false","true"]` legend — a filterable, colour-by-able flag rather than a
        # number a user has to know the encoding of.
        ("in_tissue", pd.Series(in_tissue)),
        ("array_row", pd.Series(array_row)),
        ("array_col", pd.Series(array_col)),
        # A `platform` / `measurement_unit` column so a future scientific-disclosure layer has
        # something to DISPATCH ON. This item owes the column; it does not owe the disclosure.
        ("platform", pd.Series([PLATFORM] * n_barcodes)),
        ("measurement_unit", pd.Series([entity["kind"]] * n_barcodes)),
        # #183 Option A. Ordinary 1-D numeric columns, and nothing about them is special to
        # the gather — which is the entire point: they survive a filter through the path that
        # already works. `float32`, so they are bit-identical to the columns of the 2-D member
        # they mirror.
        (COMPONENT_X, pd.Series(xs)),
        (COMPONENT_Y, pd.Series(ys)),
    ]
    for name, values in per_bin:
        rel = f"metadata/{name}.zarr"
        structure, meta = txr_columns.write_metadata_column(
            outputs_dir, rel, name, values, axis="cells",
            aligned_to=aligned_to["cells"], membership=membership_of["cells"],
        )
        entries.append(output_entry(
            f"metadata-column:{name}", DT_METADATA_COLUMN, rel, "artifact",
            label=name, axis="cells", structure=structure, meta=meta,
        ))
    progress("columns", 78, f"{len(per_bin)} per-bin columns")

    # ── the images ───────────────────────────────────────────────────────────────────
    # After the coordinates, because every image places itself INTO the space they define.
    progress("images", 86, "converting the tissue images")
    image_specs = [dict(VENDOR_IMAGES[0], path=selected["image"])] + list(
        selected.get("extra_images", [])
    )
    image_entries, image_skipped, image_warnings = emit_images(
        image_specs, outputs_dir, space_id=space_id,
        microns_per_pixel=microns_per_pixel, microns_per_pixel_source=scale_source,
        scalefactors=scalefactors,
        ambiguous=selected.get("ambiguous_images", ()),
        non_placeable=selected.get("non_placeable_images", ()),
        # The bins' own extent in the full-resolution frame, so an image that does not cover
        # them can say so. Computed from the coordinates that were just written.
        coverage_bounds=(float(coords[:, 0].max()), float(coords[:, 1].max()))
        if len(coords) else None,
    )
    entries.extend(image_entries)

    # ── the registration QC ──────────────────────────────────────────────────────────
    # AFTER the images are on disk, because the check reads the artifact AS STORED — the bytes
    # a consumer would actually get — rather than the in-memory array this function happened
    # to have. That is what makes it a check on the shipped path.
    progress("registration", 93, "checking the registration against the bin grid and the tissue")
    # THE WHOLE POSITIONS TABLE, not the matrix-joined subset, and this is load-bearing rather
    # than an optimisation. The filtered matrix holds ONLY the squares under tissue, so
    # `in_tissue` is uniformly 1 across every row of the coordinates artifact; scored over
    # that subset the registration check has ONE class, specificity is undefined, and it would
    # report `not-evaluated` on every real bundle — a check that cannot fail. The positions
    # table carries every square with the vendor's own call for each, which is the two-class
    # label the mask has to be scored against.
    #
    # The transpose is applied here AGAIN, from the same columns and in the same direction,
    # rather than reusing `xs`/`ys` — those are matrix-ordered. Getting it wrong here would
    # draw a correct import as a misregistration.
    def _qc_column(name):
        """One WHOLE positions column for the QC as `float64`, or `None`. NEVER raises.

        IT NO LONGER VETOES ON INTEGRALITY, and the `kind` parameter that did is gone. That
        veto was a whole-COLUMN answer to a per-ROW defect, which is the failure this block's
        own comment two paragraphs down says it closed for the non-finite case and then
        reintroduced for the non-integral one. MEASURED on the committed fixture with a single
        `in_tissue=0` row's `array_row` set to 3.5: the wide two-class sample (160 squares,
        52 in tissue, `youden_j: 1.0`, verdict `pass`) collapsed to the matrix-joined subset,
        which is ONE-CLASS BY CONSTRUCTION -- so the only check in this importer with a
        referent outside the artifact reported `not-evaluated`, giving as its reason "every bin
        carries the same `in_tissue` value", which points at the wrong column entirely. A
        genuine misregistration would have been hidden by a value that has nothing to do with
        it. Integrality is a property of a ROW and is tested in the mask below, beside
        finiteness and int32 range, so the bad row is dropped and NAMED and the verdict
        survives.

        `None` is a real answer here -- the caller falls back to the matrix-joined sample and
        SAYS which scope it used. That is why the guard is total rather than a named tuple of
        exception types: this runs at 93 %, after every writer, so anything that escapes it
        costs the user their matrix, their coordinates, their columns and their report, and
        leaves a partial store behind. MEASURED on the first cut, with a non-finite value in a
        row the filtered matrix does not use (so `column()` above never sees it): exit 1, a
        raw `OverflowError`, and 115 paths already on disk -- which falsified this module's own
        INV-8 headline. The narrow tuple was copied from `column()`, where it is correct
        because that path is allowed to refuse.
        """
        try:
            return np.asarray(positions[name], dtype=np.float64)
        except Exception:
            return None

    # THE BAD ROWS ARE DROPPED, NOT THE COLUMN. `_qc_column` used to veto a whole column if
    # ANY of its rows was non-finite, and all three columns were abandoned together -- so ONE
    # damaged value, in a row the filtered matrix never uses, converted the registration check
    # from a real two-class score into `not-evaluated`, which this module's own comment calls
    # "a check that cannot fail".
    #
    # MEASURED: the fixture's tissue image shifted 300 full-resolution pixels scores `fail` on
    # the clean table, and `not-evaluated` once a single NaN is added to `pxl_col_in_fullres`
    # in a row the vendor already marked `in_tissue=0`. A genuine misregistration, hidden by a
    # value that has nothing to do with it -- and nothing named the cause, because the reason
    # a reader gets says only "every bin carries the same `in_tissue` value".
    #
    # `measure_spot_pitch` one file over already drops non-finite points row-wise and reports
    # `n_dropped_non_finite`, so the all-or-nothing veto was also stricter than the consumer
    # needs. The wide scope is kept, minus the rows that cannot be placed, and the COUNT is
    # carried into the QC so the picture the reader gets says what was left out.
    qc_x = _qc_column("pxl_col_in_fullres")
    qc_y = _qc_column("pxl_row_in_fullres")
    qc_flag = _qc_column("in_tissue")
    # THE LATTICE INDICES ARE PART OF THE MASK, not filtered by it afterwards.
    #
    # They are read here rather than after the branch because the first cut built `usable`
    # from THREE columns and then filtered `array_row`/`array_col` by it without ever testing
    # them: a NaN in a lattice index survived the mask verbatim and reached a bare
    # `.astype(np.int64)`, which is UNDEFINED -- it becomes INT64_MIN and is handed to
    # `lattice_fit_pitch` as a real array index. MEASURED through the shipped entrypoint on an
    # otherwise clean bundle: exit 0, a `RuntimeWarning: invalid value encountered in cast`
    # written to STDERR (two non-`progress:` lines, which `scheduler.rs::drain_logs` turns
    # into two job_logs rows on a run this module treats as clean), and the lattice-fit
    # corroboration silently ABSENT from the report with no note.
    #
    # The block's own comment claimed the mask made the indices "line up with the coordinates
    # row for row". That was true of length and of nothing else.
    qc_rows_all = _qc_column("array_row")
    qc_cols_all = _qc_column("array_col")
    qc_dropped = 0
    if (qc_x is not None and qc_y is not None and qc_flag is not None
            and qc_rows_all is not None and qc_cols_all is not None):
        # PLACEABLE, not merely FINITE. `_qc_column` proves only that a column can be read as
        # `float64`, so a finite, integral `array_row` outside `int64`'s range still reaches
        # the `.astype(np.int64)` below as an UNDEFINED cast -- the same defect the finiteness
        # mask was added to close, wearing a different value. `float64(2**63 - 1)` rounds UP
        # past `int64`'s own maximum, so testing against `iinfo(int64)` does not close it
        # either. The lattice indices are `int32` columns by declaration (`array_row` /
        # `array_col` are emitted at `int32`), and `column()` already bounds the matrix-joined
        # path by exactly that range -- so the QC's wider read is bounded the same way, which
        # is representable in `float64` exactly and leaves the cast defined.
        #
        # MEASURED on an otherwise clean bundle with `array_row = iinfo(int64).max` in one
        # `in_tissue=0` row: exit 0, `RuntimeWarning: invalid value encountered in cast` on a
        # SUCCESSFUL run's stderr (two `job_logs` rows a human reads), and `lattice_fit: null`
        # in the report with nothing saying why.
        _idx_lo, _idx_hi = float(np.iinfo(np.int32).min), float(np.iinfo(np.int32).max)

        def _whole(a):
            # `np.rint` of a NaN is a NaN and `np.equal(nan, nan)` is False, so this term
            # never fires a warning on the rows `np.isfinite` already excludes.
            return np.equal(np.rint(a), a)

        def _placeable_flag(a):
            return np.isfinite(a) & _whole(a)

        def _placeable_index(a):
            return _placeable_flag(a) & (a >= _idx_lo) & (a <= _idx_hi)

        # THE COORDINATES ARE BOUNDED TOO, and for two rounds they were not. The mask
        # hardened the LATTICE columns and left the two coordinate columns tested for
        # finiteness alone -- while the matrix-joined path refuses the identical value:
        # `coordinate()` range-checks the same columns against `float32`'s own range, and its
        # docstring cites `1e39` as the measured defect. So the wide read was bounded for
        # three of its five columns and unbounded for the other two.
        #
        # A finite-but-enormous coordinate does not overflow on its way in; it overflows when
        # `registration_qc` SQUARES it. MEASURED with `pxl_col_in_fullres = 1e300` in one
        # `in_tissue=0` row: exit 0, the row NOT counted in `qc_dropped` and NOT named in the
        # scope, and `RuntimeWarning: overflow encountered in square` from
        # `measure_spot_pitch` AND from `lattice_fit_pitch` on a SUCCESSFUL run's stderr --
        # four non-`progress:` lines, which `scheduler.rs::drain_logs` turns into four
        # job_logs rows on a run this module treats as clean. At `1.7e308` a third site joins.
        # That is the exact outcome the block above says the mask exists to close.
        #
        # `float32`'s range is the bound rather than something new, because it is the one the
        # matrix-joined path already applies to these two columns: a value this importer
        # would refuse if the matrix used the row cannot be sound to MEASURE from when it
        # does not, and `3.4e38` squared is nowhere near `float64`'s ceiling.
        _crd = float(np.finfo(np.float32).max)

        def _placeable_coord(a):
            return np.isfinite(a) & (a >= -_crd) & (a <= _crd)

        usable = (_placeable_coord(qc_x) & _placeable_coord(qc_y) & _placeable_flag(qc_flag)
                  & _placeable_index(qc_rows_all) & _placeable_index(qc_cols_all))
        qc_dropped = int((~usable).sum())
        if qc_dropped and usable.any():
            qc_x, qc_y, qc_flag = qc_x[usable], qc_y[usable], qc_flag[usable]
        elif qc_dropped:
            # EVERY row unusable is not a narrower sample, it is no sample.
            qc_x = qc_y = qc_flag = None
    # THE GATE TESTS ALL FIVE COLUMNS, and the round that introduced the two-column split had
    # it testing three. `qc_rows_all`/`qc_cols_all` were hoisted above this line and the
    # `if qc_rows is not None:` guards that used to stand around the cast were deleted with
    # them -- but the fallback test was left at three columns. So a bundle whose
    # `pxl_col`/`pxl_row`/`in_tissue` all parse while `array_row` does NOT (one non-integral
    # lattice index anywhere in the positions table, in a row the filtered matrix never
    # carries, is enough) skipped the mask block entirely, took the `else` branch, and reached
    # `None.astype(np.int64)`.
    #
    # MEASURED through the shipped entrypoint on the committed fixture with a single
    # `in_tissue=0` row's `array_row` set to 3.5: exit 1, a raw `AttributeError` traceback out
    # of `run_import`, and 116 paths already on disk -- INV-9 and INV-8 broken together, at
    # 93 %, after every writer. The three-column test was the whole of the difference.
    if (qc_x is None or qc_y is None or qc_flag is None
            or qc_rows_all is None or qc_cols_all is None):
        # A positions table this importer already ACCEPTED for the matrix's own barcodes can
        # still hold an unparseable value in a row the matrix does not use. That must not cost
        # the whole check, and it must not silently fall back to the one-class subset either —
        # so the QC gets the matrix-ordered arrays and SAYS which sample it used.
        qc_coords, qc_in_tissue, qc_scope = coords, in_tissue, "matrix-joined-bins"
        qc_rows, qc_cols = array_row, array_col
    else:
        qc_coords = np.ascontiguousarray(
            np.stack([np.asarray(qc_x, dtype=np.float64),
                      np.asarray(qc_y, dtype=np.float64)], axis=1))
        qc_in_tissue = np.asarray(qc_flag) != 0
        # The scope NAMES the exclusion when there was one, so a narrower sample is never
        # reported as the whole table. `qc_dropped` is 0 on every ordinary bundle, and the
        # unqualified string is what a reader then sees.
        qc_scope = ("all-bins-in-positions-table" if not qc_dropped else
                    f"all-bins-in-positions-table-minus-{qc_dropped}-unplaceable")
        # Gated on the SAME three-way test, not on `qc_x` alone: if `qc_x` parsed but `qc_y`
        # did not, the coords would fall back to the matrix-joined subset while the array
        # indices came from the whole table — and when the two have EQUAL row counts in a
        # different ORDER, the lattice fit runs over mismatched pairs and publishes a
        # FABRICATED pitch as independent corroboration. Corroboration that is invented is
        # worse than none.
        # Filtered by the SAME mask that PROVED them finite, so the cast below is defined and
        # the lattice fit's indices line up with the coordinates row for row. Gated on the
        # same all-five test for the reason recorded above: a partial fallback pairs one
        # column's rows with another's and publishes a FABRICATED pitch as independent
        # corroboration, and corroboration that is invented is worse than none.
        qc_rows, qc_cols = qc_rows_all, qc_cols_all
        if qc_dropped:
            qc_rows, qc_cols = qc_rows[usable], qc_cols[usable]
        qc_rows = qc_rows.astype(np.int64)
        qc_cols = qc_cols.astype(np.int64)
    qc, overlays = registration_qc.registration_qc(
        coords=qc_coords,
        in_tissue=qc_in_tissue,
        scope=qc_scope,
        microns_per_pixel=microns_per_pixel,
        scale_source=scale_source,
        image_entries=image_entries,
        outputs_dir=outputs_dir,
        # THE REFERENT, and the whole reason this module is not the sibling's. An HD capture
        # area is a contiguous grid of squares, so the manufactured centre-to-centre pitch IS
        # the bin size — read from this bundle's own `bin_size_um`, which `locate_bins` has
        # already verified against the position the files were presented at.
        bin_pitch_um=float(bin_um),
        # What the overlay draws one bin AS: the square's own side, which for a contiguous
        # grid is the same number again. Passed separately from the referent because they are
        # different questions and a platform where they differ (Visium: 55 um vs 100 um) must
        # not be able to reuse this call site by accident.
        entity_size_um=float(bin_um),
        array_row=qc_rows,
        array_col=qc_cols,
    )

    # ── the report ───────────────────────────────────────────────────────────────────
    diagnostics, omitted = {}, []
    for path in selected.get("diagnostics", []):
        uri = inline_diagnostic(path)
        if uri is None:
            omitted.append(Path(path).name)
        else:
            diagnostics[Path(path).name] = uri
    report = {
        "kind": "visium-hd-import-report",
        "analysis": "spatial.import-visium-hd",
        "coordinate_space": space_id,
        "coordinate_space_source": space_id_source,
        # THE BIN CHOICE, in three fields rather than one: WHICH bin, HOW it was chosen, and
        # WHAT ELSE was there. A report that named only the bin would leave a reader unable to
        # tell an owner-confirmed choice from this importer's unconfirmed default (DEC-1).
        "bin_um": int(bin_um),
        "bin_chosen_by": chose_by,
        "bin_default_um": int(DEFAULT_BIN_UM),
        "bins_available": [int(b) for b in available],
        "bins_not_imported": [int(b) for b in available if b != bin_um],
        "bin_choice_note": bin_choice_note(bin_um, chose_by, available),
        "bin_size_um_declared_by_vendor": bool(selected.get("bin_size_um_declared")),
        # WHICH layout the bundle arrived in, because the two are not equally strong evidence
        # (see `locate_bins`) and a reader auditing a bin attribution needs to know which one
        # this run rested on.
        "bundle_layout": bundle["layout"],
        "n_bins": n_barcodes,
        "n_genes": n_features,
        "n_bins_in_tissue": int(in_tissue.sum()),
        "n_positions_in_bundle": len(positions["barcode"]),
        "measured_entity": entity,
        "measured_entity_label": coord_meta["measured_entity_label"],
        "microns_per_pixel_source": scale_source,
        # THE SANITISED COPY. `read_scalefactors` has already replaced any number strict JSON
        # cannot carry -- see `json_safe_vendor_numbers` -- so this copy, and therefore both
        # this report and `/outputs/manifest.json`, parse under a strict reader.
        "scalefactors": scalefactors,
        "provenance": provenance,
        "positions_file": Path(selected["positions"]).name,
        "component_columns": [COMPONENT_X, COMPONENT_Y],
        "diagnostics_omitted": omitted,
        # WHICH images were emitted, and — the half that matters — which were NOT and why. A
        # silently absent image is how a user discovers at overlay time that there is nothing
        # to overlay on. `display_derivative` is OMITTED rather than set to null when there is
        # none, because absence is spelled by the key not being there everywhere else here.
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
        # TWO channels, because one was being read as the other: `images_not_emitted` is the
        # set a consumer filters on to learn what is MISSING, and folding "emitted, but the cap
        # could not be evaluated" into it made a successfully emitted image count as absent.
        "images_not_emitted": image_skipped,
        "image_warnings": image_warnings,
        "registration_qc": qc,
        "library_versions": txr_deps.resolve_and_check()["libraries"],
    }
    # SAID OUT LOUD when the vendor's scale document carried a number this platform could not
    # write. Silently substituting would leave a reader believing they had the vendor's file.
    unrepresentable = scalefactors.get(UNREPRESENTABLE_KEYS)
    if unrepresentable:
        report["scalefactors_unrepresentable_numbers"] = list(unrepresentable)
        report["scalefactors_note"] = (
            f"this bin's {SCALEFACTORS_BASENAME} carries a value at "
            f"{', '.join(f'`{k}`' for k in unrepresentable)} that JSON cannot express "
            "(`NaN` or `Infinity`, which `json.loads` accepts and strict readers reject). The "
            "value is reported above as text rather than as a number, because carrying it "
            "through would make this report -- and the outputs manifest the server reads to "
            "find every artifact -- unparseable, discarding a complete import with no "
            "statement about the bundle. Nothing was computed from it."
        )

    if microns_per_pixel is not None:
        report["microns_per_pixel"] = microns_per_pixel
    else:
        # Said out loud, in the artifact a human reads. A silently absent scale is how a user
        # discovers three analyses later that nothing can measure a distance.
        report["scale_note"] = (
            f"this bin's {SCALEFACTORS_BASENAME} declares no usable `microns_per_pixel`, so "
            "the coordinate space declares NO physical scale. Analyses that measure in "
            "micrometres (a neighbour-graph radius, a distance threshold) will refuse rather "
            "than assume one. Visium HD normally writes this field; a bundle without it was "
            "either produced by an older Space Ranger or has a damaged scale file."
        )

    (outputs_dir / "visium-hd-import-report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    entries.append(output_entry(
        "visium-hd-import-report", DT_REPORT_QC, "visium-hd-import-report.json", "artifact",
        structure=txr_columns.opaque("application/json"),
        meta={"kind": "visium-hd-import-report", "n_bins": n_barcodes,
              "coordinate_space": space_id,
              "bin_um": int(bin_um),
              "bin_chosen_by": chose_by,
              # The bin choice reaches a human HERE. `meta` is the one channel this app shows;
              # a disclosure that lives only in the embedded HTML reaches nobody (#223).
              "bin_choice": report["bin_choice_note"],
              "registration_qc_verdict": qc["verdict"],
              "registration_qc": qc_verdict_lines(qc)},
    ))
    # THE LOAD-BEARING `encoding=`. This write carries FREE PROSE, and this module's own prose
    # contains an em dash. With the LOCALE default, an ORDINARY bundle on a machine at
    # `ANSI_X3.4-1968` dies with an uncaught `UnicodeEncodeError` and exit 1 after every other
    # artifact is on disk — the hostile-bundle failure shape, reached by the ENVIRONMENT
    # instead of by an attacker, on a bundle with nothing wrong with it.
    (outputs_dir / "visium-hd-import-summary.html").write_text(
        render_report_html(report, diagnostics, overlays), encoding="utf-8"
    )
    entries.append(output_entry(
        "visium-hd-import-summary", DT_REPORT_HTML, "visium-hd-import-summary.html",
        "intermediate",
        structure=txr_columns.opaque("text/html"),
        meta=dict(
            {"kind": "visium-hd-import-summary",
             "diagnostics_embedded": sorted(diagnostics),
             "registration_qc_verdict": qc["verdict"],
             "registration_qc": qc_verdict_lines(qc),
             "overlay_embedded": sorted(overlays)},
            # SAID OUT LOUD in the artifact record, because the alternative is a reader
            # believing they have seen the overlay. This report EMBEDS the rendered overlay and
            # this application has no renderer for `report/html`.
            # SAID OUT LOUD in the artifact record, with the issue number, because the
            # alternative is a reader believing they have seen the overlay. The overlay IS
            # rendered and IS embedded here; what is missing is a renderer for `report/html`,
            # which is #223 and is not this package's to build. Emitting the picture as its
            # own artifact instead was tried and rejected: §7.2 calls the diagnostics
            # "diagnostics, not data", and TEST-7 pins the overlay out of the artifact plane
            # so a rendered picture cannot be read by a later analysis as tissue.
            **({"overlay_note": (
                "the rendered registration overlay is embedded in this HTML, and this "
                "application has no renderer for `report/html` (#223) — the verdict lines "
                "above, carried in `meta`, are what reaches a reader today."
            )} if overlays else {}),
        ),
    ))
    return entries


def main():
    inputs_dir, outputs_dir = io_dirs()
    run_params = params(inputs_dir)
    slots = load_inputs_index(inputs_dir)

    # THE STAGING ORDINALS, taken from the slot NAMES the server wrote. A multi-file dataset
    # binds at `{slot}_{i}`, so the integer after the last underscore is the file's index into
    # the declared member list — see `locate_bins`. Read here rather than in `locate_bins`
    # because it is a fact about the SANDBOX contract, not about the bundle.
    slot_ordinals = {}
    for slot, path in slots.items():
        head, _, tail = slot.rpartition("_")
        if head and tail.isdigit():
            slot_ordinals[Path(path)] = int(tail)

    # The bundle ROOT. A single-file dataset binds at the bare slot; a multi-file one spreads
    # across `/inputs`, so the root is the inputs directory itself and `locate_bins` does the
    # rest. Both are handled by taking the parent of whatever was staged.
    bundle = None
    for name in (BUNDLE_SLOT, "input", "dataset"):
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
        requested = run_params.get(BIN_PARAM) if isinstance(run_params, dict) else None
        entries = run_import(bundle, outputs_dir, requested_bin=requested,
                             slot_ordinals=slot_ordinals or None)
    except VisiumImportError as exc:
        print(f"spatial.import-visium-hd: {exc}", file=sys.stderr, flush=True)
        sys.exit(2)
    write_manifest(outputs_dir, entries)
    progress("done", 100, f"{len(entries)} outputs")


if __name__ == "__main__":
    main()
