#!/usr/bin/env python3
"""`spatial/boundaries` — the Xenium segmentation polygons, as a LONG VERTEX TABLE (#163).

Realizes `docs/design/spatial-storage-layout.md` §6.4 (`origin/docs/spatial-design-revisions`
@ `e55b16ef`), whose declaration half already landed as
`spatial-types/manifest.yaml:386-422`. This module is the PRODUCER half and nothing else.

## The claim this module exists to test

§6.4, verbatim:

    any ragged per-entity structure can be encoded as a long table plus per-entity offset
    metadata-columns, with zero framework change.

The alternative it displaces is an `aux` member with an entity extent, which would need two
new `_AUX_ROLES` entries in `_lib/conformance.py` — a framework-owned gate change on the
critical path of a domain declaration. Nothing here touches `_lib`. The vertex table is an
ordinary `txr_zarr.Table` over an ordinary axis, and the offsets are ordinary
`metadata-column`s; both go through the same conformance gate every other artifact does.

## What the VENDOR actually ships, measured rather than assumed

Measured over the two real full-size Xenium bundles available (295,883 and 167,780 cells;
3,846,353 and 2,181,086 vertices):

  * **one row per vertex**, columns `cell_id, vertex_x, vertex_y`;
  * **6..13 vertices per cell** — and 99.98% of cells have exactly 13. The raggedness is
    real but shallow, which is why the hostile cases in `test_boundaries_ragged_edges.py`
    are constructed rather than sampled, and why the fixture builder picks the RAREST
    lengths first;
  * **every ring is CLOSED** — last vertex == first, in 463,663 of 463,663 rings across both
    bundles. That duplicate is the vendor's convention and is STORED as written (DEC-6);
  * vertex runs are contiguous per cell and in `cells.csv.gz` order — which this module
    deliberately does NOT assume;
  * `cell_id` is typed INCONSISTENTLY BY THE VENDOR ACROSS BUNDLES — `binary` in one real
    bundle's parquet and `int32` in another's. `normalise_ids` exists for that, and it is why
    this module reads `pyarrow.parquet` directly rather than `pandas.read_parquet`:
    `b"aaaaaahk-1"` stringifying to `"b'aaaaaahk-1'"` mis-keys every vertex in the file.

## Why it STREAMS

The ceiling has to be a claim about the PEAK, and the first cut's was not: it sized 4M rows
at "~16 bytes a row" while `to_pylist()` was materialising one Python `str` per row
(~63 B/object plus an 8 B pointer) before anything else ran. Measured with `tracemalloc`,
that shape peaked at ~505 MB where its own comment claimed ~64 MB.

So ids are mapped to entity indices **one record batch at a time** and the strings are
dropped immediately. What survives a batch is 16 bytes a row (`int64` entity + two
`float32`), and the peak adds the stable-sort index and one gathered copy — see
[`estimated_peak_bytes`], which is EXECUTABLE and asserted, rather than a number in a
comment that nothing can check.
"""
from __future__ import annotations

import math
import os

import numpy as np

#: The vendor's own column names. Not configurable: a file that does not have these is not
#: a Xenium `cell_boundaries` table, and guessing which column is x would be a guess about
#: where a cell's edge is.
CELL_ID_COLUMN = "cell_id"
VERTEX_X_COLUMN = "vertex_x"
VERTEX_Y_COLUMN = "vertex_y"
BOUNDARIES_BASENAME = "cell_boundaries.parquet"

#: The member names of the emitted `vertex`-axis table, and the two sibling offset columns.
#: The three member names come from the LANDED declaration
#: (`spatial-types/manifest.yaml:419-421`); the two column names are the design's own words
#: (§6.4 line 651). `write_boundaries` uses THESE constants and
#: `test_boundaries_long_table.py` drives THAT function while reading the names out of the
#: manifest — so a rename here goes red. (The first cut asserted this and did not do it: the
#: test built its own table with the names spelled again as literals, so a rename left the
#: whole suite green. That is the difference between a claim and a check.)
ENTITY_INDEX_MEMBER = "entity_index"
X_MEMBER = "x"
Y_MEMBER = "y"
START_COLUMN = "boundary_vertex_start"
COUNT_COLUMN = "boundary_vertex_count"

#: Rows per streamed record batch. Not a tunable anyone should need: it trades a fixed
#: ~64 MB of transient decode buffer against syscall count, and it is named rather than
#: inlined so [`estimated_peak_bytes`] can account for it.
BATCH_ROWS = 1 << 20

#: The transient cost of ONE decoded batch: a Python `str` per row from `normalise_ids` plus
#: two float64 columns plus arrow's own buffers. Measured with headroom; it is a fixed cost
#: that does not scale with the file.
BATCH_BYTES_PER_ROW = 96

#: THE DESIGN'S OWN ENVELOPE, quoted so the ceiling below is sized from the design instead of
#: from whichever bundles happened to be on the build machine. §8.2's sizing table:
#: *"Xenium cell boundaries (~10^6 cells x ~20 vertices) | ~1 GB | fine"* — i.e. ~2x10^7
#: vertices is explicitly IN SCOPE. The first cut refused at 4x10^6, sized from the two small
#: bundles measured, which would have refused a bundle the design declares supported.
DESIGN_VERTEX_ENVELOPE = 20_000_000

#: THE ALLOCATION CEILING (DEC-9 / DEC-18). A `Limits`-style overridable constant, following
#: the identical tunable in `differential-abundance/compute/_shared.py:66-67`, NOT a settings
#: table: the governing operator lever is already the admin `code_sandbox_settings`
#: memory/timeout this job runs under, and adding a settings row plus a permission plus a
#: sync entity for a producer-side allocation guard would put a NEW PERMISSION on a branch
#: whose whole claim is zero core change. It is promotable to a settings row without a
#: rewrite, which is the property the configurable-settings rule protects.
#: HEADROOM OVER THE ENVELOPE, and the previous comment here was a CATEGORY ERROR that a
#: blind angle caught. It read §8.2's `~1 GB | fine` as an estimate of this importer's
#: resident memory and concluded the encoding was more expensive than the design allowed.
#: It is not: that table's columns are `artifact | size | sandbox verdict`, so "~1 GB" is the
#: ARTIFACT'S SIZE ON DISK and "fine" is the staging verdict against the 8 GiB per-file cap.
#: The design does not estimate producer memory anywhere. On the same shape this encoding's
#: store is 16 B/row (~320 MB at the envelope) — BELOW the design's number, not above it.
#:
#: The ceiling was briefly pinned to the envelope on the strength of that misreading, which
#: introduced a real regression: §8.2 writes the envelope as `~10^6 cells x ~20 vertices`,
#: and a 1.6M-cell run at the vendor's MEASURED 13 vertices/cell is 2.08x10^7 — inside the
#: class the design calls supported, and it would have silently lost its boundaries. The
#: default is back above the envelope, with the `~` given room, and the model at that point
#: (~1.3 GiB of tracemalloc-visible allocation) is 16% of §8.1's 8 GiB sandbox memory limit.
_DEFAULT_MAX_VERTICES = 30_000_000

#: The DEFAULT, exported so a test can assert it against `DESIGN_VERTEX_ENVELOPE` and against
#: `estimated_peak_bytes`. The RUNTIME value comes from `_ceiling_from_env()` at call time —
#: a module-scope `int(os.environ[...])` is what turned a malformed tunable into a traceback
#: during `import boundaries`, before any handler existed.
MAX_BOUNDARY_VERTICES = _DEFAULT_MAX_VERTICES


def _ceiling_from_env():
    """The ceiling, VALIDATED. A bad value must not be a traceback at import time.

    `int(os.environ.get(...))` at module scope raises `ValueError` during
    `import boundaries` — before `run_import` exists and outside any handler — and a zero or
    negative value silently makes EVERY boundaries file refuse.
    """
    raw = os.environ.get("XENIUM_MAX_BOUNDARY_VERTICES")
    if raw is None:
        return _DEFAULT_MAX_VERTICES
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise BoundariesError(
            f"XENIUM_MAX_BOUNDARY_VERTICES is {raw!r}, which is not an integer. The ceiling "
            "is an allocation guard; an unparseable one would either crash at import or be "
            "silently ignored, and both are worse than saying so."
        ) from None
    if value <= 0:
        raise BoundariesError(
            f"XENIUM_MAX_BOUNDARY_VERTICES is {value}, which refuses every boundaries file "
            "there can be. A ceiling of zero is a disable switch wearing a limit's name; if "
            "boundaries should not be imported, do not ship the file."
        )
    return value


class BoundariesError(Exception):
    """A refusal from this module, phrased for the user whose bundle it is.

    Deliberately NOT a subclass of the entry's `XeniumImportError`: this module is imported
    BY the entry, so it cannot import the entry's exception without a cycle. The entry
    therefore catches this type explicitly and records a SKIP — the same shape
    `emit_image` already has for `ImageConversionError`. That matters more than the class
    hierarchy: the boundaries file is an optional side file of an otherwise complete bundle,
    and a bad one must not destroy the counts matrix, the coordinates and the image with it.
    """


def _fail(message: str):
    raise BoundariesError(message)


#: Per ENTITY, MEASURED at an entity-heavy shape (1M entities x 1 vertex) rather than at a
#: vertex-heavy one, because the vertex-heavy shape hides this term entirely: `first_xy` and
#: `last_xy` at 16 B each, `seen_first`/`count`/`start` at 8, and — the two large ones a
#: third blind angle found still unmodelled — `index_of`, a full `{str: int}` dict, plus
#: pandas' object-dtype Index hashtable, together ~200 B/entity. The FIRST model had no
#: per-entity term at all (1.3x-2.8x under); the second had 80 and was still 1.58x under at
#: 1M entities. A model that errs optimistic is the defect this constant exists to end.
PER_ENTITY_BYTES = 288
#: Per VERTEX at the peak: `entity` int64 (8) + `x`/`y` float32 (8) + the stable-sort index
#: int64 (8) + the gathered copy of the three (16) = 40 accounted, plus headroom for the
#: per-chunk lists the concatenate holds alongside their result. MEASURED against the real
#: reader under `tracemalloc` — the accounted 40 alone was a 3% UNDER-estimate at 400k rows,
#: and a model that is optimistic is the defect this constant exists to end.
PER_VERTEX_BYTES = 48


def estimated_peak_bytes(n_rows: int, n_entities: int = 0) -> int:
    """The resident peak this module reaches — EXECUTABLE, not prose.

    The first cut carried its memory model as a comment, and both blind angles found the
    comment wrong by ~5x with nothing able to notice. A number a test can evaluate is a
    number a test can refuse — but only if it models what the code actually holds, and the
    first executable version still did not: it had no `n_entities` term, while `encode`
    holds `axis_index` plus `first_xy` plus `last_xy`, all of which scale with the ENTITY
    count. A third blind angle measured the gap. Both terms are here now, and
    `test_the_memory_model_is_EXECUTABLE_and_bounds_the_ceiling` drives the real reader
    under `tracemalloc` and refuses an under-estimate.

    `n_entities` defaults to 0 so a caller asking only about the vertex term still gets a
    number; every call that has an entity count passes it.

    The per-vertex peak is reached at the gather in `encode` — after the stable sort, where
    `entity`/`x`/`y`, the argsort index and the gathered copy of the three coexist; the
    transient decode batch
    (`BATCH_ROWS` rows of a `str` list plus two f64 columns, ~79 B/row) is a fixed cost that
    does NOT scale with the file.
    """
    return (PER_VERTEX_BYTES * int(n_rows)
            + PER_ENTITY_BYTES * int(n_entities)
            + BATCH_ROWS * BATCH_BYTES_PER_ROW)


# ── reading the vendor's parquet ─────────────────────────────────────────────────────


def normalise_ids(column) -> list:
    """A vendor `cell_id` column → the SAME string form the cells axis is keyed on.

    The cells axis's keys are `str(c)` over the matrix's own `cell_id` dataset
    (`import_xenium.py:1224,1436`), so this must produce exactly that and nothing near it.

    Three vendor dtypes are accepted because three have been OBSERVED in real bundles:
    `binary` / `large_binary` (decoded UTF-8 — never `str(bytes)`, which yields
    `"b'aaaaaahk-1'"` and would make every id an orphan), the string types, and the integer
    types (`int32` in one real bundle, where a cell id is literally `1`). Anything else
    REFUSES by name rather than being coerced.
    """
    import pyarrow as pa

    kind = column.type
    if pa.types.is_binary(kind) or pa.types.is_large_binary(kind):
        out = []
        for v in column.to_pylist():
            if v is None:
                out.append(None)
                continue
            try:
                out.append(v.decode("utf-8"))
            except UnicodeDecodeError:
                # Raised as OUR error, not as a bare UnicodeDecodeError: the entry catches
                # this type, and an escaping decode error is a traceback where a named
                # refusal belongs.
                _fail(
                    f"`{BOUNDARIES_BASENAME}` column {CELL_ID_COLUMN!r} holds bytes that are "
                    f"not UTF-8 ({v[:16]!r}...). A cell id that cannot be rendered as text "
                    "cannot be matched against the matrix's own ids."
                )
        return out
    if pa.types.is_string(kind) or pa.types.is_large_string(kind):
        return column.to_pylist()
    if pa.types.is_integer(kind):
        return [None if v is None else str(v) for v in column.to_pylist()]
    _fail(
        f"`{BOUNDARIES_BASENAME}` column {CELL_ID_COLUMN!r} has type {kind}, which this "
        "importer has no rendering for. Real Xenium bundles write it as binary, string or "
        "int32; a fourth rendering would have to be read the same way the cell-feature "
        "matrix renders its own ids, and guessing would mis-key every vertex in the file."
    )


def _coords_of(batch, name):
    """One vertex-coordinate column as `float64`, or a REFUSAL naming the column.

    The first cut validated `cell_id`'s dtype by name and left these two entirely unchecked,
    so a STRING `vertex_x` was silently parsed (`["1.5", "2.5"]` imported as 1.5/2.5) and a
    non-numeric string raised a bare `ValueError` from numpy. The module's stated principle —
    *"anything else REFUSES by name rather than being coerced"* — was applied to one of the
    three columns.
    """
    import pyarrow as pa

    column = batch.column(name)
    if not (pa.types.is_floating(column.type) or pa.types.is_integer(column.type)):
        _fail(
            f"`{BOUNDARIES_BASENAME}` column {name!r} has type {column.type}, which is not a "
            "number. A coordinate this importer had to parse out of text would be a guess "
            "about the vendor's own encoding, and every polygon rests on it."
        )
    return np.asarray(column.to_numpy(zero_copy_only=False), dtype=np.float64)


def _batches(path, columns):
    """The vendor's rows, one record batch at a time. Wrapped so a decode error is OURS."""
    import pyarrow.parquet as pq

    try:
        file = pq.ParquetFile(str(path))
    except Exception as exc:
        _fail(f"`{path.name}` is not a readable parquet file ({type(exc).__name__}: {exc}).")

    present = set(file.schema_arrow.names)
    missing = [c for c in columns if c not in present]
    if missing:
        _fail(
            f"`{path.name}` is missing column(s) {missing} (it has {sorted(present)}). "
            "A boundaries table without a cell id and both vertex coordinates is not one."
        )

    ceiling = _ceiling_from_env()
    declared = file.metadata.num_rows
    if declared > ceiling:
        _fail(
            f"`{path.name}` declares {declared:,} vertices, above this importer's ceiling of "
            f"{ceiling:,} (~{estimated_peak_bytes(ceiling, ceiling // 20) / 1024 ** 3:.1f} "
            "GiB resident at the peak, at the design's ~20-vertices-per-cell shape). "
            "Refusing here is deliberate rather than "
            "letting the job die to the OOM killer with nothing that says why. Raise "
            "`XENIUM_MAX_BOUNDARY_VERTICES` if "
            "the environment can carry it."
        )

    seen = 0
    try:
        for batch in file.iter_batches(batch_size=BATCH_ROWS, columns=list(columns)):
            seen += batch.num_rows
            # The footer is METADATA and can under-declare. The ceiling above is checked
            # against it, so the real lengths are re-checked here, per batch, BEFORE the next
            # one is decoded — a footer that lies costs one batch, not the whole file.
            if seen > ceiling:
                _fail(
                    f"`{path.name}` has decoded {seen:,} vertices, past the ceiling of "
                    f"{ceiling:,}, although its footer declared {declared:,}. The file's own "
                    "metadata under-reports its size."
                )
            yield batch
    except BoundariesError:
        raise
    except Exception as exc:
        _fail(f"`{path.name}` could not be decoded ({type(exc).__name__}: {exc}).")


# ── the ragged → long-table-plus-offsets encoding (INV-1) ────────────────────────────


def _empty_result(n_entities):
    return {
        "entity": np.zeros(0, dtype=np.int64),
        "x": np.zeros(0, dtype=np.float32),
        "y": np.zeros(0, dtype=np.float32),
        "start": np.zeros(n_entities, dtype=np.int64),
        "count": np.zeros(n_entities, dtype=np.int64),
        "stats": {"n_vertices": 0, "n_entities_with_boundary": 0,
                  "n_entities_without_boundary": n_entities, "min_vertices": 0,
                  "max_vertices": 0, "closure": "vendor-as-written", "rings_closed": 0,
                  "rings_with_at_least_two_vertices": 0, "n_single_vertex_entities": 0,
                  "n_vertices_not_written": 0, "unmatched_cell_ids_sample": [],
                  "n_unmatched_vertex_rows": 0,
                  "n_distinct_unmatched_cell_ids_sampled": 0, "n_null_cell_ids": 0},
        "bbox": None,
    }


def encode(batches, axis_keys):
    """§6.4's encoding, over an ITERABLE OF BATCHES. The one route; nothing re-derives it.

    `batches` yields `(ids, xs_float64, ys_float64)`. `axis_keys` is the CELLS AXIS in its own
    order — the matrix's `cell_id` sequence, which is the one place that order is decided
    (`import_xenium.py:1385,1436`). `entity_index` is a row index INTO THAT, so this never
    re-derives an identity it was handed.

    Ordering: vertices are grouped by entity and emitted in ascending `entity_index`, with the
    vendor's own row order preserved WITHIN each entity by a stable sort. That makes every
    entity's slice contiguous and every `start` monotonic — which is what makes
    `[start, start + count)` a slice rather than a gather — WITHOUT assuming the contiguity the
    two real bundles happen to have.

    ## A vertex with no entity is NOT WRITTEN (INV-4) — and the count is reported

    The invariant's own words, from `spatial-types/manifest.yaml:415-418`: *"Valid-only: a
    negative sentinel is never stored ... A vertex with no entity is not written."* That is a
    per-vertex OMISSION rule, and the first cut reframed it into a whole-bundle refusal — a
    reading that satisfies "no sentinel is stored" vacuously (nothing is stored) while not
    doing what the sentence says, and that escalates a per-row condition into the loss of the
    counts matrix, the coordinates and the image.

    So: such a vertex is dropped, and `n_vertices_not_written` plus a sample of the offending
    ids go into the artifact's `meta` and the import report. Dropping is only honest when it
    is COUNTED — a silently shorter polygon set is the failure this platform's absence rule
    exists to prevent.

    The one case that IS refused is every vertex being unmatched: a boundaries file with no
    cell in common with its own bundle's matrix is not a partial result, it is the wrong file,
    and importing zero polygons from it as though that were the measurement would be worse
    than saying so.

    ## float32 is checked AFTER the narrowing

    `np.isfinite` on the float64 values passes for `1e300`, which becomes `inf` in the stored
    `float32`. The sibling centroid path in `import_xenium.py` documents fixing exactly this;
    the first cut here reintroduced it. The check runs on the NARROWED values.
    """
    n_entities = len(axis_keys)
    index_of = {key: i for i, key in enumerate(axis_keys)}
    if len(index_of) != n_entities:
        _fail(
            "the cells axis contains a repeated key, so a vertex cannot be attributed to one "
            "row of it. This is a defect in the caller, not in the bundle."
        )

    # Built ONCE for the whole stream, not once per batch: the index is the expensive half of
    # the vectorized lookup, and rebuilding it per batch would give back what it buys.
    import pandas as pd
    axis_index = pd.Index(list(axis_keys), dtype=object)

    ceiling = _ceiling_from_env()
    entity_chunks, x_chunks, y_chunks = [], [], []
    total_rows = 0
    # Ring ENDPOINTS are kept at full float64 precision, two per entity, so the closure
    # statistic is exact. Computing it from the narrowed f32 store counts two distinct f64
    # endpoints that collide under f32 as a closed ring — and at micron scale f32 resolves
    # only ~1e-3 um, so that over-reports closure on real data.
    # NUMPY, NOT DICTS. Two `{int: (float, float)}` dicts cost a MEASURED 418 bytes per
    # entity and were the single largest term `estimated_peak_bytes` did not model — ~800 MB
    # at the ceiling. Three small arrays carry the same information at 40 B/entity and are
    # part of the model.
    first_xy = np.zeros((n_entities, 2), dtype=np.float64)
    last_xy = np.zeros((n_entities, 2), dtype=np.float64)
    seen_first = np.zeros(n_entities, dtype=bool)
    dropped = 0
    unmatched_sample = []
    unmatched_total = 0
    null_ids = 0
    seen_rows = 0

    for ids, xs, ys in batches:
        if not (len(ids) == len(xs) == len(ys)):
            _fail(
                f"a boundaries batch holds {len(ids)} cell id(s), {len(xs)} x value(s) and "
                f"{len(ys)} y value(s). The three columns of a vertex table are one row each; "
                "a mismatch is a caller bug, and letting numpy raise it would abort the whole "
                "import with a traceback instead of this sentence."
            )
        seen_rows += len(ids)
        total_rows += len(ids)
        # THE CEILING APPLIES HERE TOO. `_batches` checks it against the parquet footer, but
        # `encode`/`assemble` are public and are what most callers (and most of this suite)
        # drive — an in-memory caller had no allocation guard at all while DEC-9/DEC-18 framed
        # the ceiling as the module's guard.
        if total_rows > ceiling:
            _fail(
                f"the boundaries table has reached {total_rows:,} vertices, above this "
                f"importer's ceiling of {ceiling:,} "
                f"(~{estimated_peak_bytes(ceiling, n_entities) / 1024 ** 3:.1f} GiB resident "
                "at the peak). Raise `XENIUM_MAX_BOUNDARY_VERTICES` if the environment can "
                "carry it."
            )
        # VECTORIZED, and not as micro-optimisation. A per-row Python loop over `ids` cost
        # more than the rest of this function put together — at the ceiling's 25M rows it
        # dominates the job, and it made this module's own `tracemalloc` test take tens of
        # minutes, which is a suite nobody runs. `Index.get_indexer` is the same lookup in C.
        #
        # The -1 it returns for a key the axis does not have is a numpy INTERMEDIATE that
        # becomes the `keep` mask on the very next line. It is never written and never
        # reaches a store — which is the whole of INV-4, and the mutation that drops the mask
        # is caught by `test_no_negative_entity_index_survives_a_MUTATION_of_the_join`.
        mapped = np.asarray(axis_index.get_indexer(ids), dtype=np.int64)
        keep = mapped >= 0
        if not keep.all():
            for i in np.flatnonzero(~keep):
                cid = ids[int(i)]
                if cid is None:
                    null_ids += 1
                else:
                    unmatched_total += 1
                    # DE-DUPLICATED. A cell's vertices are consecutive in the vendor's file,
                    # so an undeduplicated cap of 5 filled with five copies of ONE id — the
                    # diagnostic whose whole job is to name the offending cells named one of
                    # them, five times, and hid the other four.
                    if len(unmatched_sample) < 5 and cid not in unmatched_sample:
                        unmatched_sample.append(cid)
        dropped += int((~keep).sum())

        e = mapped[keep]
        bx = np.asarray(xs, dtype=np.float64)[keep]
        by = np.asarray(ys, dtype=np.float64)[keep]
        # `errstate`: the narrowing is EXPECTED to overflow on exactly the input the next
        # four lines refuse by name, and numpy's `RuntimeWarning: overflow encountered in
        # cast` reaching the user's job log ahead of that sentence is a traceback wearing a
        # warning's clothes. The condition is not ignored — it is detected below.
        with np.errstate(over="ignore", invalid="ignore"):
            x32 = bx.astype(np.float32)
            y32 = by.astype(np.float32)
        bad = int((~np.isfinite(x32)).sum() + (~np.isfinite(y32)).sum())
        if bad:
            _fail(
                f"`{BOUNDARIES_BASENAME}` holds {bad} vertex coordinate(s) that are not "
                "finite at the declared float32 precision (a NaN, an infinity, or a "
                "magnitude past float32 range). A polygon placed at one of those would sit "
                "somewhere real-looking on the tissue."
            )
        # Ring ENDPOINTS, per entity, in vendor order — a loop over UNIQUE ENTITIES, not
        # over rows. A ring that spans two batches keeps the first batch's first vertex (set
        # once) and the last batch's last (overwritten), which is what "the ring's first and
        # last in vendor order" means when the file is read in pieces.
        if e.size:
            o = np.argsort(e, kind="stable")
            es = e[o]
            run_starts = np.flatnonzero(np.concatenate(([True], es[1:] != es[:-1])))
            run_ends = np.concatenate((run_starts[1:] - 1, [es.size - 1]))
            ents = es[run_starts]
            fi, li = o[run_starts], o[run_ends]
            fresh = ~seen_first[ents]
            if fresh.any():
                idx = ents[fresh]
                first_xy[idx, 0] = bx[fi[fresh]]
                first_xy[idx, 1] = by[fi[fresh]]
                seen_first[idx] = True
            last_xy[ents, 0] = bx[li]
            last_xy[ents, 1] = by[li]
        entity_chunks.append(e)
        x_chunks.append(x32)
        y_chunks.append(y32)

    # `dropped`, NOT `unmatched_total`. `seen_rows` counts every decoded row including nulls,
    # so comparing it against `unmatched_total` (non-null ids only) meant ONE null id
    # anywhere in the file disabled this refusal entirely and the user got the vaguer
    # empty-result message instead. Found blind, reproduced with
    # `assemble(["ghost", "ghost", None], ...)`.
    if seen_rows and dropped == seen_rows and unmatched_total:
        _fail(
            f"`{BOUNDARIES_BASENAME}` attributes every one of its {seen_rows:,} vertices to "
            f"cells that are not in this bundle's matrix (first: {unmatched_sample!r}). That "
            "is not a partial result, it is the wrong file for this bundle — importing zero "
            "polygons from it as though that were the measurement would be worse than "
            "refusing."
        )

    if not entity_chunks or sum(c.shape[0] for c in entity_chunks) == 0:
        result = _empty_result(n_entities)
        result["stats"]["n_vertices_not_written"] = dropped
        result["stats"]["n_unmatched_vertex_rows"] = unmatched_total
        result["stats"]["n_distinct_unmatched_cell_ids_sampled"] = len(unmatched_sample)
        result["stats"]["unmatched_cell_ids_sample"] = list(unmatched_sample)
        result["stats"]["n_null_cell_ids"] = null_ids
        return result

    entity = np.concatenate(entity_chunks)
    x = np.concatenate(x_chunks)
    y = np.concatenate(y_chunks)
    del entity_chunks, x_chunks, y_chunks

    order = np.argsort(entity, kind="stable")
    entity_sorted = entity[order]
    x = x[order]
    y = y[order]
    del entity, order

    count = np.bincount(entity_sorted, minlength=n_entities).astype(np.int64)
    start = np.zeros(n_entities, dtype=np.int64)
    if n_entities:
        start[1:] = np.cumsum(count)[:-1]

    # VECTORIZED, at FULL float64 precision. Comparing the narrowed f32 store counts two
    # distinct f64 endpoints that collide under f32 as a closed ring, and at micron scale f32
    # resolves only ~1e-3 um — so the statistic would over-report closure on exactly the real
    # data it describes.
    ring = count >= 2
    ringed = int(ring.sum())
    closed = int(np.all(first_xy[ring] == last_xy[ring], axis=1).sum()) if ringed else 0

    stats = {
        "n_vertices": int(entity_sorted.shape[0]),
        "n_entities_with_boundary": int((count > 0).sum()),
        "n_entities_without_boundary": int((count == 0).sum()),
        "min_vertices": int(count[count > 0].min()) if (count > 0).any() else 0,
        "max_vertices": int(count.max()) if n_entities else 0,
        # DEC-6: the vendor's own convention, DECLARED so the next reader does not have to
        # re-derive it from the bytes. `vendor-as-written` is the only value this producer
        # emits — it never closes or opens a ring itself.
        "closure": "vendor-as-written",
        "rings_closed": closed,
        "rings_with_at_least_two_vertices": ringed,
        "n_single_vertex_entities": int((count == 1).sum()),
        # INV-4's reporting half. Zero on both real bundles, which is exactly why it has to
        # be a number in the artifact rather than a promise in a docstring.
        "n_vertices_not_written": dropped,
        # ROWS, not distinct ids — named for what it counts. One orphan cell carrying
        # 13 vertices was reported as "13 unmatched cell ids", an order of magnitude
        # off on real vendor data.
        "n_unmatched_vertex_rows": unmatched_total,
        "n_distinct_unmatched_cell_ids_sampled": len(unmatched_sample),
        "unmatched_cell_ids_sample": list(unmatched_sample),
        "n_null_cell_ids": null_ids,
    }
    bbox = {"x_min": float(x.min()), "x_max": float(x.max()),
            "y_min": float(y.min()), "y_max": float(y.max())} if x.size else None
    return {"entity": entity_sorted, "x": x, "y": y, "start": start, "count": count,
            "stats": stats, "bbox": bbox}


def assemble(ids, xs, ys, axis_keys):
    """`encode` over ONE in-memory batch. A thin adapter, so tests drive the shipped path."""
    return encode([(list(ids), np.asarray(xs, dtype=np.float64),
                    np.asarray(ys, dtype=np.float64))], axis_keys)


def read_boundaries(path, axis_keys):
    """The production path: stream `path`'s batches straight into [`encode`]."""
    columns = (CELL_ID_COLUMN, VERTEX_X_COLUMN, VERTEX_Y_COLUMN)

    def stream():
        for batch in _batches(path, columns):
            yield (normalise_ids(batch.column(CELL_ID_COLUMN)),
                   _coords_of(batch, VERTEX_X_COLUMN),
                   _coords_of(batch, VERTEX_Y_COLUMN))

    return encode(stream(), axis_keys)


# ── the writer (and why the MIRROR lives here, not in the entry) ─────────────────────


def _entities_without_boundary(value):
    """Read the declared count, or answer `None` for "the caller does not know".

    §15.3's rule is that a reader must not infer a declared state from a null, and this is
    the one place that reading happens. Both halves of the coverage decision call it, so an
    unreadable count cannot make the producer's note and the report's predicate disagree —
    which is exactly what a raw `int()` in one and a guarded one in the other did: the note
    raised where the predicate had already answered "not complete".
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, float) and not (math.isfinite(value) and value.is_integer()):
        # 2.9 cells is not a count, and `int()` would silently make it 2 and then quote the 2
        # back at the reader as the bundle's own number. A non-integral or non-finite value is
        # unreadable, not roundable.
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        # OverflowError is `float("inf")`, which `int()` refuses and which reaches here
        # intact through a stored report's JSON (`json.loads` parses the bare token). Leaving
        # it out of this tuple is how a malformed count crashed the summary it was guarded to
        # protect.
        return None


def coverage_against(bbox, centroid_bbox, *, entities_without_boundary=0):
    """Report the two placement FACTS the artifact can support, and no verdict (#247).

    Design §7.3 names the silent failure mode: *"Getting the affine wrong does not error; it
    draws spots in the wrong place."* The sibling image path already answers it — `emit_image`
    is handed `coverage_bounds` from the just-written coordinates and produces a
    `coverage_note`. Geometry stamped with the coordinates' space and never checked against
    them has exactly the same exposure, so the extents are measured and reported here.

    ## What is reported, and what is deliberately NOT

    Two facts are derivable from the artifact alone and are reported as facts:

      * `overlaps` — do the two extents intersect at all (the weakest claim);
      * `centroids_contained` — does the vertex extent contain the centroid extent. Every
        cell's polygon surrounds its own centroid, so on a correctly placed pair this holds,
        and a y-flip or an x/y transpose breaks it while a plain box intersection still
        reports agreement.

    plus `extent_ratios`, the raw vertex-span ÷ centroid-span per axis — a number a reader can
    judge.

    **No `consistent` verdict, and no scale band.** An earlier cut folded those facts plus a
    hard-coded `_SCALE_HINT_MAX = 5.0` into a `consistent: true|false|null` boolean that
    reached the artifact's `meta` and the user-facing report as though it were a declared
    property. §7.3 prescribes no coverage arithmetic at all — its rules are about storing
    full-resolution coordinates and DECLARING the affine (*"declare the space, never the scale
    factor alone"*) — and the ratio that `5.0` bounded is a function of the tissue's cell
    density and border margin, neither of which is measured anywhere. The field's own answer
    (SpatialData, *Nature Methods* 2024) is an explicitly declared coordinate transformation,
    never placement inferred from data extents; the pixel/micron confusion the band chased is
    a named failure whose published remedy is declaration.

    The judgement belongs to §7.5's registration QC overlay — *"the only defence against a
    silent affine bug"* — which compares against an EXTERNAL referent rather than against the
    artifact's own extents.

    ## AND THAT OVERLAY NOW EXISTS FOR THIS PRODUCER (#301)

    #247 wrote the sentence above as *"the judgement therefore belongs to §7.5's registration
    QC overlay (#156)"*, which read as a deferral to a control that would pick this up. For
    four issues it was not there to pick anything up: **#156 built that overlay for
    `spatial-import-visium` only**, `compute/registration_qc.py` lived in that package and in
    no other, and #291 replaced the deferral with a disclosure that said so. #301 built one
    here. `spatial-import-xenium/compute/registration_qc.py` is this package's own, staged in
    `run.helpers`, and every run that emits a morphology image emits the overlay beside it as
    a `report/qc` artifact.

    WHAT IT SETTLES FOR THESE POLYGONS, AND WHAT IT DOES NOT — because "judged, fully" would
    be the same overstatement as #291's "judged by nothing" with the sign flipped, and this
    docstring has now carried both directions.

    * IT SETTLES THE SCALE. #247's DEC-5 recorded the acknowledged gap — *"a uniform scale
      error, a 1000x pair, satisfies both remaining booleans and is now caught by nothing"* —
      and #156's overlay was its named mitigation. `write_boundaries` stamps the polygons with
      the SAME `space` object the centroids got, from the same writer call, so a uniform scale
      error on the polygons is a uniform scale error on the centres; the overlay places those
      centres on the morphology image through the DECLARED transform and scores them against
      the signal the image's own pixels carry. A 1000x pair does not survive that. Measured on
      this package's two real vendor bundles: a correct placement scores 0.608 and 0.536, a 2x
      misscale scores 0.000.
    * IT DOES NOT SETTLE THE SHAPE. The overlay draws each cell as a disc of its
      vendor-measured `cell_area`, not as its outline, so a polygon set that is correctly
      SCALED and wrongly SHAPED — reordered rings, a mirrored vertex table, a per-cell offset
      — is still described by the two facts below and ruled on by nothing. That is the
      residue this docstring now owns, and it is narrower than the one it owned before rather
      than absent.
    * IT DOES NOT SETTLE A SUB-2% SCALE ERROR either, in either direction. Measured: a 2%
      misscale scores 0.303 against the overlay's 0.4 floor. The raw extent ratios below are
      still the only thing that speaks to a small uniform error, and they are still reported
      unjudged.

    THIS IS NOT AN ARGUMENT FOR A PRODUCER-SIDE CHECK, and #301 did not introduce one here.
    Removing `_SCALE_HINT_MAX` was right and the reasoning above stands unchanged; #269
    removed a second invented number (`_STATED_SCALE_RTOL`) one module over for the same
    reason. A third would still be the defect. What #301 added is a measurement against a
    referent OUTSIDE the artifact, which is a different thing from a band this repo chose —
    and it lives in its own module, reported beside its own number, not folded into this
    function's key set. `coverage_against` returns exactly the facts #247 left it returning.

    AND THE CLAIM IS CHECKED RATHER THAN TRUSTED, WITHIN A STATED LIMIT.
    `tests/test_placement_judgement_disclosure.py` used to go RED when a registration QC
    appeared here; it is INVERTED and now goes red when one DISAPPEARS — the same detector,
    the same three probes (a `registration_qc`-shaped module, Visium's five overlay entry
    points, a matching staged helper in the manifest), with `spatial-import-visium` kept as
    the positive control. It remains a DETECTOR, not a proof: it can tell that an overlay of
    the expected shape is present and staged, not that it measures anything. What proves the
    measurement is `tests/test_registration_qc.py`, which mutates the placement on a real
    vendor bundle and requires the verdict to flip.

    THE SAME PROSE IS STILL STALE ONE LEVEL UP (#302). `spatial-types/compute/`'s shared
    modules were written when no overlay existed for this producer, and they are vendored
    byte-identically into all three spatial packages — so correcting them there forces a
    matching edit inside `spatial-import-visium`, which this branch may not make. Named here
    rather than left as a stale claim with no pointer.

    Still a NOTE and not a refusal: there is no ground truth here, and a polygon set
    legitimately extends past its own centroids. What it must not do is stay silent.
    """
    if bbox is None or centroid_bbox is None:
        return None

    # A PARTIAL polygon set has no containment expectation, and asserting one produced a
    # FALSE silent-affine alarm on correctly placed data. §15.3 makes partial coverage a
    # DECLARED legitimate state and INV-4 makes it reachable here (a cell the vendor drew no
    # polygon for), so the note says so and the reader is pointed at the declaration rather
    # than left to read the containment fact as a defect.
    #
    # NOT-COMPLETE, not "greater than zero", and read through the SAME function the report
    # reads it with: `coverage_is_reportable` calls a set complete at exactly `== 0`, so a
    # `> 0` test here left a NEGATIVE count neither partial nor complete, and a bare `int()`
    # here RAISED on an unreadable one the predicate had already answered for. Both are
    # unreachable from `run_import` and both are reachable from a stored report, and both
    # broke the coupling this pair of functions exists to keep.
    declared = _entities_without_boundary(entities_without_boundary)
    partial = declared != 0

    def _span(b, axis):
        return float(b[f"{axis}_max"]) - float(b[f"{axis}_min"])

    overlaps = (bbox["x_min"] <= centroid_bbox["x_max"]
                and bbox["x_max"] >= centroid_bbox["x_min"]
                and bbox["y_min"] <= centroid_bbox["y_max"]
                and bbox["y_max"] >= centroid_bbox["y_min"])
    contains = (bbox["x_min"] <= centroid_bbox["x_min"]
                and bbox["x_max"] >= centroid_bbox["x_max"]
                and bbox["y_min"] <= centroid_bbox["y_min"]
                and bbox["y_max"] >= centroid_bbox["y_max"])
    # DEGENERATE MEANS THE DENOMINATOR IS A POINT, on both axes — a one-cell bundle, or every
    # cell at one coordinate. A ratio with a zero denominator is undefined, not large.
    #
    # AN UNDEFINED AXIS STILL TAKES ITS SLOT. Dropping it made the list SHORTER, and every
    # reader of `extent_ratios` — the note, the rendered summary line, a consumer — reads it
    # POSITIONALLY as [x, y]. A single-element list from a degenerate x axis therefore showed
    # the Y ratio in the X position with nothing saying so. `None` in the slot is the same
    # answer the non-finite guard below already gives, and it keeps the pair addressable.
    ratios = []
    degenerate = True
    for axis in ("x", "y"):
        v, c = _span(bbox, axis), _span(centroid_bbox, axis)
        if c > 0:
            degenerate = False
            ratios.append(v / c)
        else:
            ratios.append(None)
    # THE NOTE IS DERIVED FROM THE FACTS ABOVE AND FROM NOTHING ELSE. No branch here judges a
    # ratio: the two loud branches are the two FACT failures §7.3's failure mode produces,
    # and the remaining branches explain why a fact is unavailable (a degenerate extent) or
    # why a false containment fact is expected (a declared-partial polygon set, §15.3).
    #
    # A NON-OVERLAP OUTRANKS BOTH EXPLANATIONS, and that precedence is load-bearing. A
    # declared-partial set explains a CONTAINMENT failure — some cells have no polygon, so
    # the polygon extent need not cover every centroid — and it explains nothing about two
    # extents that do not intersect AT ALL; a degenerate centroid extent likewise says only
    # that no ratio is defined. Ordering the explanations first answered a wholly disjoint
    # pair with "§15.3 makes partial coverage a declared legitimate state, not a defect",
    # i.e. a reassurance about the one failure §7.3 says must not stay silent.
    #
    # `coverage_is_reportable` reads this SAME precedence and is the only thing that decides
    # whether the note reaches a human. Two independent derivations of "what is worth
    # reporting" is how the note above and the renderer's condition came to disagree.
    if not overlaps:
        note = ("THE POLYGON EXTENT DOES NOT OVERLAP THE CENTROID EXTENT AT ALL. Both are "
                "stamped with the same coordinate space, so one of them is placed wrongly — "
                "this is the silent-affine failure mode (design §7.3), reported rather than "
                "refused because this importer has no ground truth to decide which side is "
                "wrong.")
    elif partial:
        # THE NOTE QUOTES THE COUNT ONLY WHEN THE COUNT IS ONE. A negative or unreadable
        # value is not-complete (so this branch is right) but it is not a number of cells,
        # and "-5 of this bundle's cells have no polygon" is a sentence about no bundle.
        how_many = (f"{declared} of this bundle's cells have no polygon"
                    if declared is not None and declared > 0 else
                    "this bundle does not state how many of its cells have no polygon (the "
                    "count is absent or not a usable number)")
        note = (
            f"{how_many}, so "
            "the centroid extent is NOT expected to lie inside the polygon extent. The "
            "extents are reported for a reader to judge, with a ratio per axis wherever one "
            "is defined; §15.3 makes partial coverage a declared legitimate state, not a "
            "defect."
        )
    elif degenerate:
        # ONLY THE DENOMINATOR. `degenerate` says the CENTROID extent is a single position on
        # both axes; the polygon extent may be a real box. The earlier wording said "both
        # extents are degenerate", which is false for a one-cell bundle with a real polygon —
        # and unreachable prose is exactly where a wrong sentence survives. (A point centroid
        # inside an overlapping box is contained by construction, so this branch is reached
        # only when the pair DOES overlap, and it is never reportable.)
        note = ("the centroid extent is a single position (a degenerate extent), so neither "
                "axis has a defined extent ratio and the containment fact carries no "
                "information")
    elif not contains:
        note = ("THE CENTROIDS ARE NOT INSIDE THE POLYGON EXTENT. Every cell's polygon "
                "surrounds its own centroid, so a containment failure means the two are not "
                "in the same frame — a flip or a transpose looks exactly like this while a "
                "plain box intersection still reports agreement (design §7.3).")
    else:
        # THE BENIGN NOTE POINTS AT A CONTROL THAT EXISTS (#301). It has now carried three
        # wordings and each was true when written: #247's deferral to "the external referent
        # the registration overlay uses (#156, design §7.5)"; #291's disclosure that for THIS
        # producer that overlay was not built and nothing was coming; and this one, since
        # #301 built it here. What has to stay true in every version is that the note names
        # the control's real STATUS in the same breath as the control — a note that names an
        # absent judge and a note that implies a present one settles everything are the same
        # defect, in the two directions. So this one names it, says where to read it, and says
        # what it still does not decide.
        note = ("the centroid extent lies inside the polygon extent, which is what a "
                "correctly placed segmentation looks like. The extent ratios are recorded "
                "beside this note, unjudged — a uniform scale error satisfies both facts, "
                "and separating that from a correct placement needs an EXTERNAL referent "
                "this function does not have. THE CONTROL THAT DECIDES IT IS BUILT FOR THIS "
                "IMPORTER: design §7.5 makes the registration QC overlay (cells drawn on the "
                "tissue image at the declared transform, judged by a human) the verification "
                "story for placement; #156 built that overlay for the Visium importer only "
                "and #301 built this producer's, so this run emits one as a `report/qc` "
                "artifact — read it. It places the cell centres, which these polygons share "
                "a coordinate space with, and scores them against the signal the morphology "
                "image's own pixels carry. WHAT IT STILL DOES NOT DECIDE, said rather than "
                "implied: the polygons' own SHAPE, which the overlay does not draw, and a "
                "uniform scale error under about 2%. For those the two facts above and the "
                "raw ratio beside them are what a reader has.")
    # THE ECHOED BOXES ARE SANITISED TOO. A non-finite bound in either input reaches
    # `json.dumps` by this route as the non-standard bare token `Infinity`/`NaN`, and a
    # manifest entry that is not valid JSON is an artifact nothing can read. Unreachable
    # through `run_import` today (both extents are finite by construction) — but this
    # function is public and the suite calls it directly.
    def _finite(b):
        return {k: (float(v) if math.isfinite(float(v)) else None) for k, v in b.items()}

    return {
        "vertex_bbox": _finite(bbox),
        "centroid_bbox": _finite(centroid_bbox),
        "overlaps": bool(overlaps),
        "centroids_contained": bool(contains),
        # `None` for a ratio that is not finite, so `json.dumps` never sees an `inf` — a
        # manifest entry that is not valid JSON is an artifact nothing can read.
        "extent_ratios": [round(r, 4) if r is not None and math.isfinite(r) else None
                          for r in ratios],
        "note": note,
    }


def coverage_is_reportable(coverage, *, entities_without_boundary=None):
    """Is a coverage report worth a human's attention? THE ONE derivation, shared with the note.

    `coverage_against` picks its note by a precedence — a non-overlap outranks the
    partial and degenerate explanations, which outrank a containment failure — and this
    answers, from the SAME precedence, whether that note describes something a reader should
    see. Both halves live here because they were once derived twice, once in the producer and
    once in `render_report_html`, and the two disagreed: a wholly disjoint pair on a
    declared-partial bundle got the partial note ("not a defect") and the renderer showed it.

    Two conditions qualify, and they are the two FACT failures, never a ratio:

      * the extents do not intersect at all;
      * the centroids are not inside the polygon extent AND every cell has a polygon.

    **Unknown is not complete.** `entities_without_boundary=None` means the caller does not
    know how many cells lack a polygon, and §15.3's rule is that a reader must not infer a
    declared state from a null — so an unknown count makes a containment failure UNreportable
    rather than reportable. `spatial_declarations.require_full_positioning` takes the same
    position on the same question.

    This is a PRESENTATION predicate — it is never written into the artifact. It decides only
    whether a FACT failure is worth a human's attention; it rules on placement no more than
    `coverage_against` does.

    AND THERE IS A DOWNSTREAM RULING NOW, ON THIS PATH TOO (#301). The placement JUDGEMENT
    belongs to §7.5's registration QC overlay, which has an external referent — #156 built
    that overlay for `spatial-import-visium` only, and for four issues
    `compute/registration_qc.py` lived there and nowhere else, which is what #291 disclosed.
    `spatial-import-xenium` now has its own, staged in `run.helpers` and emitted as a
    `report/qc` artifact on every bundle with a morphology image. So this predicate still
    surfaces the two FACT failures and still rules on nothing, and what decides the rest is a
    control that exists rather than one that would.
    Scoped, because the overlay draws cell CENTRES and this predicate is about POLYGONS: it
    settles a uniform SCALE error (the polygons and the centroids share one coordinate space,
    written by one call) and does not settle the polygons' own SHAPE.
    `tests/test_placement_judgement_disclosure.py` is INVERTED as of #301 — it went red when a
    registration QC APPEARED here and now goes red when one disappears, on the same detector
    keyed to Visium's module name, its entry points and its manifest staging, with the evasion
    space that implies. `tests/test_registration_qc.py` is what proves the overlay MEASURES
    something, by mutating a real bundle's placement and requiring the verdict to flip.
    """
    if not isinstance(coverage, dict) or not coverage:
        return False
    if coverage.get("overlaps") is False:
        return True
    if coverage.get("centroids_contained") is not False:
        return False
    # A count that cannot be read is not a count. The renderer used to coerce with
    # `int(x or 0)`, which turned `""` into "complete"; refusing to guess keeps this on the
    # same side as an absent count, keeps a malformed report from crashing the summary a user
    # is trying to read, and — because `coverage_against` reads the count through the SAME
    # function — keeps the note and this answer on the same side of every input.
    return _entities_without_boundary(entities_without_boundary) == 0


def write_boundaries(outputs_dir, rel_dir, encoded, *, space, series,
                     centroid_bbox=None):
    """Write the `spatial/boundaries` store and return `(structure, meta)`.

    ## The mirror is the WRITER'S property

    #211 established that a declaration reaches a sandboxed consumer in the artifact's own
    file format, written at ONE ENFORCED CALL SITE — and `test_coordinate_space.py` pins the
    consequence as an assertion that the ENTRY does not contain the string
    `mirror_declarations_into_store` at all: *"the importer asks for nothing: the mirror is
    the writer's property"*. This is that arrangement for `spatial/boundaries`.

    ## NO `measured_entity` AND NO `positioning` on this artifact

    The first cut omitted `measured_entity` for the reason below and then stamped the CELLS
    artifact's `positioning` verbatim — the identical mistake, caught blind. §15.3 defines
    `partial` as *"not every entity has a position"*, and the value copied here was built
    from *"Every cell in the matrix has a centroid"*: a claim about CENTROIDS. A consumer
    reading `partial: false` off a boundaries store is told every entity has a POLYGON, which
    `n_entities_without_boundary > 0` directly contradicts — and `require_full_positioning`
    REFUSES on partial, so the false value is the one that silently passes. `section` stays:
    it is a property of the physical section and is true of any artifact from the run.

    ## NO `measured_entity` on this artifact

    Design §15.1 defines that field explicitly as *"what one row IS"*, and §15.0 records that
    the entity-agnostic reading is the whole reason it exists. **One row here is a VERTEX.**
    Copying the coordinates' `measured_entity` (kind `cell`) onto a vertex-axis table states
    that a row is a cell, which is false, and §15.1 says the UI label derives from that field.
    `_validated_declaration_block` does not invent an absent sub-block, so omitting it is
    legal and is the honest answer. Which cells these polygons belong to is carried where it
    actually lives: `entity_index`, the two offset columns, and `entity_axis_aligned_to`.

    ## No `aligned_to` on the table

    `aligned_to` names the row space a member LINES UP WITH. One row per vertex is not one row
    per cell; stamping the cells digest here would claim a per-cell alignment this table does
    not have.
    """
    import txr_zarr
    import spatial_declarations as SD

    dest = outputs_dir / rel_dir
    with txr_zarr.Table(dest, axis="vertex", n=int(encoded["entity"].shape[0])) as table:
        table.numeric(ENTITY_INDEX_MEMBER, encoded["entity"], dtype="int64")
        table.numeric(X_MEMBER, encoded["x"], dtype="float32")
        table.numeric(Y_MEMBER, encoded["y"], dtype="float32")
        structure = table.close()

    # FLAT, because that is the shape `_validated_declaration_block` rebuilds: the space's own
    # keys at top level plus the optional sub-blocks. A nested `{"coordinate_space": space}`
    # is refused at write time — correctly, since a consumer reading one would find no `unit`
    # and no affine.
    declarations = {**space, "section": series}
    SD.mirror_declarations_into_store(dest, structure=structure, declarations=declarations)

    meta = dict(declarations)
    # ONE nested key, not nine flat ones. `dataset/models.rs` keeps only the first
    # `DECL_MAX_KEYS = 8` keys of a group's compact declaration IN SORTED ORDER, and nine flat
    # statistics crowded out `unit`, `to_space`, `positioning`, `section` and `offset_columns`
    # — including the one key this module justifies as "the only artifact that still says how
    # to read it after a filter".
    meta.update({
        "offset_columns": {"start": START_COLUMN, "count": COUNT_COLUMN},
        "boundary_stats": encoded["stats"],
    })
    coverage = coverage_against(
        encoded["bbox"], centroid_bbox,
        entities_without_boundary=encoded["stats"]["n_entities_without_boundary"],
    )
    if coverage is not None:
        meta["boundary_coverage"] = coverage
    return structure, meta
