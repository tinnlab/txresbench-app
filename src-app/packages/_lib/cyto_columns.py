#!/usr/bin/env python3
# ruff: noqa
"""cyto_columns — the pandas→Zarr output adapter every processor writes through (ITEM-26).

`cyto_zarr` is the FORMAT layer: numpy + stdlib, no opinions about what a column means.
This is the layer above it — the one that knows a `pandas.Series` from an embedding
matrix, and turns either into the Zarr artifact the browser reads. It replaced four
near-identical copies of `write_metadata_column` that each emitted a single JSON blob of
Python `float`s, which is what "everything is Zarr" retires: a 150k-cell column was a
2 MB JSON array the client had to parse in full before painting anything.

pandas is imported LAZILY inside each function, so `import cyto_columns` still costs
numpy + stdlib — the same floor `cyto_zarr` holds to (DEC-7). Keeping the pandas
knowledge here and out of `cyto_zarr` is deliberate: the format layer is the thing the
browser reader must agree with byte-for-byte, and it should have nothing in it that a
non-pandas producer would have to route around.

## What a column becomes

    pandas CategoricalDtype  → categorical: codes + the DECLARED level set
    bool                     → a `bool` array; the display levels ride on `meta`
    integer / float          → numeric, at the SOURCE width (an int column stays an
                               int — cluster ids and counts must not become 1.0/2.0)
    anything else (object)   → string, arrow layout

There is no cardinality heuristic promoting an object column to a categorical. A
categorical is a column whose producer DECLARED a level set (pandas already models
this); a free-text column is a string column and scales like one. Guessing from
distinct-value counts is exactly the inference INV-2 forbids, and it would make a
column's storage flip as rows are added.

## Missing values

Floats carry `NaN` natively. A categorical with missing values gets ONE extra declared
level (a non-colliding label, recorded as `meta.missing_level`). A string column has no
null bitmap in the arrow layout the design specifies, so a missing value is written as
the empty string and counted in `meta.missing` — recorded, never silent.

## This module knows NO domain (INV-5), and defaults NOTHING (INV-2)

It is FRAMEWORK code: it is staged into every processor's `/code`, so anything it names is
named on behalf of every producer that will ever exist. It therefore has no domain
vocabulary in it and no default for anything a producer declares.

It used to have both, in the same three places: `axis` defaulted to a single-cell axis
name, and `write_embedding`'s `name` + its emitted `meta.kind` both defaulted to a
contributed datatype id. `axis` is the worst of the three — a *framework library* was
authoring the producer's `structure.axis`, so a producer that said nothing got a
single-cell axis and the artifact was silently keyed to a domain this file must not know.
The other two additionally NAMED a contributed datatype id, which the derived-vocabulary
guard forbids in framework code and which only survived because this file sat outside that
guard's scanned surface. Both halves are closed together.

Prose here obeys the same rule as code: `scripts/check-derived-vocabulary.sh` scans this
file, and a Python docstring is a STRING, not a comment, so a contributed datatype id
quoted in this header would (correctly) read as a hit. Describe such an id, do not spell
it.

`axis`, `name` and `kind` are now REQUIRED keyword arguments. INV-2: absence is an error,
not an assumed `"cells"`. A producer's own module may of course carry its own default —
`anndata-import` knows perfectly well that its obs axis is `cells` — but that default
belongs where the domain is, not here.
"""
import numpy as np

import cyto_zarr

#: Geometry for an embedding: one 2-D member, rows chunked, full width per chunk. A
#: DECLARED default (DEC-5) — mirrors the `(min(8192, rows), cols)` the previous
#: zarr-python writer used, so the fetch granularity of a scatter plot is unchanged.
#:
#: Only the INNER chunk is a constant. The shard count is derived from the row count by
#: `cyto_zarr.shard_chunks` (ITEM-35), because a constant is wrong at both ends of the
#: scale in opposite directions — see the `cyto_zarr` module header.
EMBEDDING_INNER_CHUNK = 8192

#: The display vocabulary shared with `colsummary.summarize_column`, so both describers
#: of a column speak one language: a legend or a colormap, nothing else.
KIND_CATEGORICAL = "categorical"
KIND_CONTINUOUS = "continuous"


def opaque(media_type, **extra):
    """The `structure` for an output whose bytes are NOT Zarr — an HTML report, a JSON
    summary, an `.h5ad` passed through.

    It still has to be DECLARED (ITEM-5/INV-2): the artifact row's `structure` column
    has no default, so "there is nothing to decode, the media type is the whole story"
    is a statement the producer makes, not an absence the server interprets.
    """
    out = {"encoding": "opaque", "media_type": media_type}
    out.update(extra)
    return out


def _declared(value, what, fn):
    """Return `value` as a non-empty `str`, or raise — the INV-2 enforcement for a
    producer declaration this module must never invent.

    A required keyword already makes OMISSION a `TypeError`, which is the language doing
    half the job. This closes the other half: `axis=None` (or `""`) would otherwise reach
    `cyto_zarr.Table`, which does `str(axis)`, and the artifact would be keyed to an axis
    literally named `"None"`. A declaration that stringifies to nonsense is not a
    declaration.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"{fn}: {what}={value!r} is not a declaration — a producer must name its "
            f"{what} explicitly (INV-2: absence is an error, and this library holds no "
            "default because it knows no domain, INV-5)"
        )
    return value


def _missing_level(levels, base="NA"):
    """A level label for "missing" that cannot collide with a declared one. Derived from
    the declared set, so it is deterministic — the same column always gets the same
    label and therefore the same bytes."""
    label = base
    while label in levels:
        label += "_"
    return label


def write_metadata_column(outputs_dir, rel_dir, name, series, *, axis,
                          holds_axis_keys=False, aligned_to=None, membership=None):
    """Write ONE per-entity column as a Zarr artifact directory at `<outputs_dir>/<rel_dir>`.

    Returns `(structure, meta)` — the two producer declarations the manifest entry
    carries into the artifact row. `structure` says how to decode the bytes; `meta` says
    what they mean, for display.

    `axis` is REQUIRED and has no default. It is the producer's INV-3 statement about
    which axis these values are aligned to, and it ends up in `structure.axis` — so a
    default here would be this framework library authoring a domain fact on the producer's
    behalf (it was `"cells"`, which this file has no business knowing — INV-5).

    `holds_axis_keys=True` says this column's VALUES ARE the axis's entity keys — the cell
    barcodes on a `cells` axis, the gene ids on a `genes` axis — rather than some property
    measured over them. It is the producer's INV-3/ITEM-19 declaration and cannot be
    inferred: a column of ids and a column of cluster labels are the same shape, and only
    the producer knows which one the axis is keyed by. It makes the writer declare
    `structure.key` + `structure.key_sequence_digest`, which is what gives the artifact an
    identity that is not its name.

    NOTE it is a claim about the VALUES only. Whether the artifact IS the axis is the
    separate `meta.is_axis_index` declaration the caller makes on the manifest entry — a
    column can legitimately carry the axis's keys (a `cell_id` column) without being the
    artifact the server resolves the axis to.

    `aligned_to` is the OTHER half of the same identity story, for the ordinary column that
    carries no keys of its own (ITEM-15): the `key_sequence_digest` of the axis these values
    line up with, taken off that axis's key artifact. `axis` above says WHICH LABEL; this
    says WHICH ROW SPACE, and only the second one identifies — three datasets in a project
    all spell their row axis with the same label, so without it a consumer cannot tell whether
    may be painted on a given set of points. It is OPTIONAL because a producer that does not
    hold the axis's keys cannot honestly declare it, and inventing one would be the inference
    INV-2 forbids; the absence is a real state the viewer renders (alignment not declared)
    rather than a silent pass.

    `membership` is the THIRD statement in the same story, and the one that says WHICH ROWS
    (ITEM-1/4). `aligned_to` says these values line up with that axis; it does not say
    whether they are all of it. A column over a selected population declares the same
    `aligned_to` as the column over the parent it was selected from, so on the declarations
    alone the two are indistinguishable — and a consumer painting the 6,000 onto the
    1,000,000 is wrong by the difference, with every declaration well-formed. Pass
    `membership={"aligned_to": <digest>, "derived_from": <the axis key artifact's
    structure>, "members": <positions>}` (or a LIST of those, one per axis, for an
    artifact that rests on two) and the writer declares the pair, writes the index body,
    and REFUSES a set whose evidence digests to a different axis. See
    `cyto_zarr._membership_entries` for the whole contract. Optional, and absent means
    absent — the same honest state `aligned_to` has.
    """
    import pandas as pd

    axis = _declared(axis, "axis", "write_metadata_column")
    s = pd.Series(series)
    n = int(s.shape[0])
    dest = outputs_dir / rel_dir
    meta = {"name": name, "dtype": str(s.dtype), "n": n, "axis": axis}

    with cyto_zarr.Table(dest, axis=axis, n=n,
                         key="values" if holds_axis_keys else None,
                         aligned_to=aligned_to, membership=membership) as t:
        # The TEXT branch is tested FIRST, through the same predicate `axis_key_digest`
        # consults, so the two cannot drift about which series this writer stores as
        # strings. Order is otherwise unchanged: `_stores_as_text` is by construction the
        # negation of the four typed branches below, so each still matches exactly what it
        # matched before.
        if _stores_as_text(s):
            values, n_missing = _as_strings(s)
            t.string("values", values)
            meta.update({"kind": KIND_CATEGORICAL, "stored_dtype": "utf8"})
            if n_missing:
                # The arrow layout the design specifies carries no null bitmap, so a
                # missing string is the empty string — counted here rather than lost.
                meta["missing"] = {"n": n_missing, "encoded_as": ""}

        elif isinstance(s.dtype, pd.CategoricalDtype):
            levels = [str(c) for c in s.cat.categories.tolist()]
            codes = np.asarray(s.cat.codes, dtype=np.int64)
            if (codes < 0).any():
                # pandas encodes a missing categorical as -1. Give it a real, declared
                # level rather than dropping it or storing an out-of-range code.
                missing = _missing_level(levels)
                codes = np.where(codes < 0, len(levels), codes)
                levels = levels + [missing]
                meta["missing_level"] = missing
                meta["n_missing"] = int((np.asarray(s.cat.codes) < 0).sum())
            t.categorical("values", codes=codes, levels=levels,
                          ordered=bool(getattr(s.dtype, "ordered", False)),
                          # ITEM-51 — the level invented a few lines up (only when pandas
                          # wrote a -1 code), named so the vocabulary digest can EXCLUDE it.
                          # `meta["missing_level"]` records the same string for readers;
                          # this is the writer telling the digest which level is not part of
                          # the vocabulary. Without it, two genuinely identical vocabularies
                          # disagree whenever one dataset happened to have missing values.
                          missing_level=meta.get("missing_level"))
            # `n_levels`, NOT the level list. The manifest is metadata, not data
            # (`outputs.rs::MAX_MANIFEST_BYTES` caps it at 1 MiB and FAILS the run
            # past it), and a level set is the column's dictionary — data. A var-axis
            # `gene_symbol` over 35,477 genes put ~450 KB here, and the same list
            # again in the member's `structure`, so ONE column spent ~900 KB of a
            # 1 MiB budget and a normal 3.5k x 35k h5ad import failed at 2.1 MB.
            #
            # Nothing is lost: `t.categorical` above writes the authoritative set to
            # the array's `attributes.cyto.levels`, which is where EVERY reader gets
            # it — `cyto_zarr_read.read_column` reads only from there, and both
            # browser readers fall back to it (`artifactReader.ts`,
            # `zarrReader.ts`). The display legend is `meta.categories`, which
            # `colsummary` already caps at MAX_SUMMARY_CATEGORIES=200 for exactly
            # this reason. This copy was the one channel that never got that rule.
            meta.update({"kind": KIND_CATEGORICAL, "n_levels": len(levels),
                         "ordered": bool(getattr(s.dtype, "ordered", False))})

        elif s.dtype == bool:
            t.numeric("values", np.asarray(s.values, dtype=bool), dtype="bool")
            # Stored as one byte per value; the legend is a display fact, not a storage
            # one, so it rides on `meta` rather than turning this into a code array.
            # Unlike the categorical branch above, this `levels` is the ONLY copy —
            # a bool is written as a plain bool array, so there is no
            # `attributes.cyto.levels` to fall back to. It is also two items long.
            # Both reasons it stays.
            meta.update({"kind": KIND_CATEGORICAL, "levels": ["false", "true"]})

        elif pd.api.types.is_integer_dtype(s.dtype) and not _has_na(s):
            # Integers stay integers at the SOURCE width — cluster codes, ids and counts
            # must not become 1.0/2.0 or lose precision past 2^53.
            arr = np.asarray(s.values)
            dt = arr.dtype.name if arr.dtype.name in _INT_NAMES else "int64"
            t.numeric("values", arr, dtype=dt)
            meta.update({"kind": KIND_CONTINUOUS, "stored_dtype": dt})

        else:
            # Floats (and a nullable integer that actually holds NA, which cannot be an
            # int array): NaN is the missing value and needs no sentinel. Reached only
            # when `_stores_as_text` was False and the three branches above did not match,
            # which is exactly `is_numeric_dtype`.
            arr = np.asarray(s.astype("float64").values, dtype=np.float64)
            dt = "float32" if str(s.dtype) == "float32" else "float64"
            t.numeric("values", arr, dtype=dt)
            meta.update({"kind": KIND_CONTINUOUS, "stored_dtype": dt,
                         "n_missing": int(np.isnan(arr).sum())})
        structure = t.close()

    return structure, meta


def _stores_as_text(series):
    """Would `write_metadata_column` store this series through its TEXT branch?

    ONE rule, consulted by the writer's own dispatch and by [`axis_key_digest`] — so the
    function that ANTICIPATES what a key member will store cannot drift from the dispatch
    that stores it. It is the negation of the four typed encodings (declared categorical,
    bool, exact-width integer, float); everything else is arrow strings.
    """
    import pandas as pd

    s = series if isinstance(series, pd.Series) else pd.Series(series)
    if isinstance(s.dtype, pd.CategoricalDtype):
        return False
    if s.dtype == bool:
        return False
    if pd.api.types.is_integer_dtype(s.dtype) and not _has_na(s):
        return False
    return not pd.api.types.is_numeric_dtype(s.dtype)


def axis_key_digest(series):
    """The `key_sequence_digest` a TEXT key column written from `series` will declare.

    The one thing a producer needs BEFORE it can stamp `aligned_to` on anything (ITEM-15):
    the axis's identity, available while the axis's own key artifact has not been written
    yet. It exists so a caller never re-implements the coercion — `write_metadata_column`
    digests the values the member STORES (`_as_strings`: `str(v)`, missing → `""`), and a
    caller digesting its raw series instead would produce a digest that disagrees with the
    key artifact for every column that needed coercing, i.e. exactly the silent
    disagreement the declaration exists to make loud.

    Scoped to TEXT keys, which is what an entity key normally is and what the
    string branch of the writer stores — and the scope is ENFORCED, not documented: a series
    the writer would store as codes, bools or numbers is REFUSED here rather than answered
    with a digest over its stringified form, which would disagree with the key member for
    every artifact in the run and disagree silently. A producer keying an axis that way
    takes `structure["key_sequence_digest"]` off the key artifact it just wrote, which is
    the source of truth this function only anticipates.
    """
    import pandas as pd

    s = series if isinstance(series, pd.Series) else pd.Series(series)
    if not _stores_as_text(s):
        raise ValueError(
            f"axis_key_digest: a {s.dtype} column is stored by `write_metadata_column` as "
            "codes/bools/numbers, not as text, so the digest anticipated here would not be "
            "the one its key member declares — read `key_sequence_digest` off the key "
            "artifact instead"
        )
    return cyto_zarr.key_sequence_digest(axis_key_sequence(series))


def axis_key_sequence(series):
    """The ORDERED KEY STRINGS a text key column written from `series` will store.

    The evidence half of {@link axis_key_digest}. ITEM-4's `membership=` requires
    `derived_from` — the axis the positions were selected out of — and digests it with the
    same function the key artifact's own writer used. A producer holding a raw pandas series
    cannot supply that without re-implementing the coercion, and a caller that passed the RAW
    series would produce a sequence agreeing with the stored one on ordinary data and
    disagreeing silently on anything the writer had to coerce (a missing value, a non-str
    label) — which is precisely the class the digest exists to make loud.

    So the coercion is exposed once and both callers read it: this is what `axis_key_digest`
    hashes, and it is what a `membership`'s `derived_from` should be. Same scope enforcement
    (text keys only), because it is the same anticipation of the same writer branch.
    """
    import pandas as pd

    s = series if isinstance(series, pd.Series) else pd.Series(series)
    if not _stores_as_text(s):
        raise ValueError(
            f"axis_key_sequence: a {s.dtype} column is stored by `write_metadata_column` as "
            "codes/bools/numbers, not as text, so the sequence anticipated here would not be "
            "the one its key member stores — read the key artifact's own members instead"
        )
    values, _n_missing = _as_strings(s)
    return values


def _has_na(series):
    try:
        return bool(series.isna().any())
    except Exception:
        return False


_INT_NAMES = ("int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64")


def _as_strings(series):
    """Coerce to `str`, mapping missing to `""` and reporting how many there were."""
    out = []
    n_missing = 0
    for v in series.tolist():
        if v is None or (isinstance(v, float) and np.isnan(v)):
            out.append("")
            n_missing += 1
        else:
            out.append(str(v))
    return out, n_missing


def write_embedding(outputs_dir, rel_dir, arr, *, axis, name, kind, method=None,
                    aligned_to=None, membership=None):
    """Write a dense `(n_entities × n_dims)` embedding as ONE 2-D Zarr member.

    Downcast to `float32`: an embedding is coordinates for a scatter plot, and float64
    would double the bytes on the wire for precision no pixel can show. Returns
    `(structure, meta)`.

    `axis`, `name` and `kind` are REQUIRED and have no defaults. All three are producer
    declarations, and all three used to be defaulted HERE — `axis` to a single-cell axis
    name, and `name`/`kind` both to a contributed datatype id no framework file may name
    (INV-5). `name` is the Zarr member the values land in (so it is part of the artifact's
    decode contract, not a label), and `kind` is the display classification the caller's
    own vocabulary owns — `KIND_CATEGORICAL` / `KIND_CONTINUOUS` here are for a COLUMN, and
    neither describes coordinates.

    `aligned_to` — the `key_sequence_digest` of the row space these coordinates are
    positions FOR (ITEM-15). An embedding is the case that makes the declaration
    load-bearing rather than tidy: its whole job is to be painted, so "may these values be
    painted on these points" is asked of it every time a section offers it, and
    `structure.axis` answers only "on something carrying that label". Optional, and absent means
    absent (see `write_metadata_column`).

    `membership` says WHICH of that axis's rows these coordinates are (ITEM-1/4), which is
    the question an embedding raises most sharply: a coordinate set computed over a selected
    population is exactly the artifact whose `aligned_to` matches the parent's while its
    rows are a subset of it. Same shape as `write_metadata_column`'s.
    """
    axis = _declared(axis, "axis", "write_embedding")
    name = _declared(name, "name", "write_embedding")
    kind = _declared(kind, "kind", "write_embedding")
    mat = np.asarray(arr)
    if hasattr(mat, "todense") or getattr(mat, "ndim", 2) != 2:
        raise ValueError(f"{name!r}: an embedding is a dense 2-D array")
    mat = np.ascontiguousarray(mat, dtype=np.float32)
    n_rows, n_dims = int(mat.shape[0]), int(mat.shape[1])
    with cyto_zarr.Table(outputs_dir / rel_dir, axis=axis, n=n_rows,
                         aligned_to=aligned_to, membership=membership) as t:
        t.numeric(name, mat, dtype="float32", inner_chunk=EMBEDDING_INNER_CHUNK)
        structure = t.close()
    meta = {"name": name, "kind": kind, "axis": axis,
            "n": n_rows, "n_dims": n_dims}
    if method is not None:
        meta["method"] = method
    return structure, meta
