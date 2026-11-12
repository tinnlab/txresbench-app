#!/usr/bin/env python3
# ruff: noqa
"""alignment — the multi-dataset alignment engine (stage 1: ITEM-1 … ITEM-15).

Given several datasets' small KEY/ANNOTATION columns, this module answers two questions and
then builds the thing that answers them permanently:

1. **Which join key should the user pick?** [`join_quality`] measures, per candidate key,
   how many features MATCH across every source, how many match but carry DISAGREEING
   secondary identifiers, and how many are DUPLICATED inside a single source (ITEM-1).
2. **What did the join actually include?** The alignment artifact records the answer as
   VECTORS rather than as rules — see the module the producer writes with.

## Why measurement and refusal are different functions

[`join_quality`] **counts** duplicates; building an alignment on a duplicated key
**refuses**. That split is deliberate and it is the whole reason ITEM-1 exists: a user
choosing between `symbol` and `ensembl_id` has to be able to SEE that `symbol` is duplicated
12 times, and a measurement that raised could never report the number it was asked for. So
the report is total, and the refusal happens where the claim is actually made.

## Where the refusal comes from, and why not from here

The duplicate refusal is NOT implemented in this module (INV-4). `_helpers/align.py::align`
already hard-fails on a duplicate raw key *and* on a normalisation collision — two distinct
faults with two distinct messages — and every source passes through it as the TABLE, so the
refusal is one implementation with one definition of "duplicate". A second copy here would
be a predicate that can diverge from the one doing the work, which is the class of bug this
feature's *"Python is the sole author; Rust is a pure consumer"* invariant exists to avoid,
one language further in.

The COUNT is computed here — a count is a report, not a check — but over `align`'s own
canonicalisation (`_as_key` / `_apply_normalize`, imported rather than reimplemented), so
"duplicate" means exactly one thing in the number and in the refusal. Counting with a
different notion of key equality than the refusal uses is how a report reads `0 duplicated`
for a key that then hard-fails, and it is the reason those two private helpers are imported
rather than approximated.

## INV-11 — this is a CATALOG-answerable computation

Every entry point here takes plain Python lists of the SMALL key columns. Nothing in this
module opens a body, fetches a chunk, or knows what an artifact is. That is the constraint
the product tree already imposed on the per-row "read it now" affordance it refused
(`packages/single-cell-viz/ui/colour-by.yaml:23-25`): this is a per-analysis computation
over a chosen set of datasets, run once, not a per-row read.
"""
from __future__ import annotations

from align import AlignmentError, _apply_normalize, _as_key, align

# THE MISSING-LEVEL LABEL RULE, imported rather than copied (C4).
#
# `txr_columns` already owns the tree's answer to "what does a missing categorical value
# hold": *"give it a real, declared level rather than dropping it or storing an out-of-range
# code"*. This module needs the SAME rule for the UNIFIED vocabulary, applied to a different
# level set — so it must be the same function, not a second implementation of it.
#
# Two copies of a collision rule is the failure mode worth avoiding here: if they ever
# diverged, a source's own "NA" and the unified "NA" could resolve differently and a real
# level could be shadowed. It is `_`-private and this is the only cross-package use; that is
# a smaller cost than the divergence, and both files are staged into the same `/code` bundle
# so the import is free at runtime.
from txr_columns import _missing_level as missing_level_label

# No `__all__`. It was added out of habit, was already missing `alignment_metadata`,
# `coverage_sidecar` and `definition_content_hash` — the producer's own primary calls — on
# its first commit, and no other module in `_helpers/` or `_lib/` declares one. A second,
# hand-maintained statement of what is public is exactly the drift this module's own prose
# argues against; the module's public surface is what it defines and documents.


class SourceTable:
    """One source dataset's small key/annotation columns, as plain Python.

    `columns` maps a column name to a list of values, all of the same length — the ENTITY
    axis of that dataset, in ITS OWN order. Order matters and is preserved: the alignment's
    entity vector records a per-source COLUMN INDEX, so a source whose entity order changed
    under it would produce a vector that reads the right NUMBER of the WRONG entities —
    ITEM-9's failure mode, on the other axis, and just as silent.

    **Two digests, for two axes, and D8 was the gap between them.** This docstring used to
    say `key_sequence_digest` made the entity-order failure detectable. It does not:
    `row_keys` digests the ROW axis, because the ROW vector is what indexes into rows.
    Nothing digested the entity axis at all, so the failure the docstring named as
    detectable was the one with no detector — a claim the code contradicted, which is this
    branch's most expensive documentation shape.

    * `row_keys` → `key_sequence_digest` (ITEM-9). The row vector's anchor.
    * `entity_axis_digest` → the entity axis's own identity. The entity vector's anchor.

    `entity_axis_digest` is the digest the SOURCE ARTIFACT declares for the row space its
    entity columns belong to (`structure.key_sequence_digest` when the column carries the
    axis's keys, else `structure.aligned_to`). It is not recomputed here: a producer reading
    one column of a metadata column artifact does not hold the axis's whole key sequence,
    and inventing a digest from the values it happens to have would be a different number
    that agrees with nothing.

    **`None` means "cannot be checked" and must never read as "matches"** — the same rule
    ITEM-9 applies to the row digest, and it is load-bearing: `aligned_to` landed on
    2026-08-13, so every artifact ingested before that date declares none.
    """

    __slots__ = ("dataset_id", "name", "columns", "row_keys", "row_columns",
                 "declared_levels", "entity_axis_digest")

    def __init__(self, dataset_id, columns, *, name=None, row_keys=None, row_columns=None,
                 declared_levels=None, entity_axis_digest=None):
        self.dataset_id = str(dataset_id)
        self.name = str(name) if name is not None else self.dataset_id
        # The source's ROW-axis key sequence, ORDERED — the cell barcodes, not the join key.
        # ITEM-9 digests THIS, because the row vector indexes into the row axis: a source
        # whose rows were reordered returns the right NUMBER of the WRONG rows.
        #
        # `None` is a real and distinct state meaning **"cannot be checked"**, and it must
        # never be read as "matches" (INV-5). It is kept as `None` rather than defaulted to
        # an empty list precisely so the two cannot be confused: an empty list is a source
        # with no rows, which is a different claim from a source whose rows we cannot
        # identify.
        self.row_keys = None if row_keys is None else list(row_keys)
        # The ENTITY axis's declared identity — see the class docstring. `None` is a real,
        # distinct state ("cannot be checked"), never "matches".
        self.entity_axis_digest = (
            None if entity_axis_digest is None else str(entity_axis_digest)
        )
        if not isinstance(columns, dict) or not columns:
            raise AlignmentError(
                f"source {self.dataset_id!r} declares no columns — a source with nothing to "
                "join on cannot contribute to an alignment"
            )
        lengths = {name_: len(values) for name_, values in columns.items()}
        if len(set(lengths.values())) != 1:
            raise AlignmentError(
                f"source {self.dataset_id!r} has columns of differing lengths {lengths} — "
                "they are supposed to be one axis's columns, so a difference means at least "
                "one of them is a different axis"
            )
        self.columns = {str(k): list(v) for k, v in columns.items()}
        # ROW-AXIS (obs) columns — e.g. `celltype`. **A DIFFERENT AXIS from `columns`**, and
        # keeping them apart is not tidiness: `columns` are the ENTITY-axis identifiers the
        # join runs over, and every one of them that is not the chosen key is treated as a
        # SECONDARY IDENTIFIER whose disagreement makes a pair conflicting (ITEM-3). A
        # per-cell `celltype` put in there would be read as a claim about gene identity, and
        # under `strict` two datasets whose cells are annotated differently would drop their
        # entire shared entity set as "conflicting" — measured, and it is how this parameter
        # came to exist.
        #
        # These are the columns whose LEVELS get fused (ITEM-4) and whose dropped levels take
        # the ITEM-5 `NA`. DEC-A draws exactly this line: that `NA` is a level absence on the
        # OBS axis, and is explicitly NOT the feature axis, where INV-12 makes absence
        # unreachable.
        self.row_columns = {str(k): list(v) for k, v in (row_columns or {}).items()}
        # The STORED code space for a categorical row column: `{column: [level, …]}` in the
        # source's own declared order, which is what its codes index into.
        #
        # Supplied rather than inferred, because inferring it from the observed labels gives
        # FIRST-APPEARANCE order while the stored codes are positions in the DECLARED order
        # (pandas' is sorted). When the two differ, every emitted `code -> unified code`
        # entry is a permutation and every fused value is silently relabelled — and a level
        # that is declared but never observed is missing entirely, so a valid stored code
        # indexes past the end of the lookup.
        #
        # Absent for a caller that has no declaration to give (a plain in-memory fixture);
        # `level_sets_for` then falls back to observation order and says so.
        self.declared_levels = {
            str(k): list(v) for k, v in (declared_levels or {}).items()
        }
        for column, values in self.row_columns.items():
            if self.row_keys is not None and len(values) != len(self.row_keys):
                raise AlignmentError(
                    f"source {self.dataset_id!r} row column {column!r} has {len(values)} "
                    f"values for {len(self.row_keys)} rows — a row column is one value per "
                    "ROW, and a mismatch means it belongs to a different axis"
                )

    @property
    def n(self):
        """The ENTITY-axis length — how many entries the join columns have."""
        return len(next(iter(self.columns.values())))

    @property
    def n_rows(self):
        """The ROW-axis length. `None` when the row keys were not supplied — the same
        "cannot be checked" state `row_keys` carries, propagated rather than guessed."""
        return None if self.row_keys is None else len(self.row_keys)

    def level_set_for(self, column):
        """The code space for `column` — its DECLARED levels when the source has them.

        Falls back to first-appearance order of the observed labels ONLY when no declaration
        was supplied, which is the in-memory-fixture case. A real artifact always carries
        one, and using it is what keeps an emitted lookup indexed by the source's own codes.

        `""` is excluded either way: `_as_key` maps None/NaN to it, and admitting it would
        make absence an ordinary level with a real unified code — the outcome ITEM-5 rejects
        ("an empty string is a level that reads as a real value"). A row whose level is
        absent takes the `None` lookup and becomes the full-axis `NA` instead.
        """
        observed = [
            level
            for level in dict.fromkeys(_as_key(v) for v in self.row_columns[column])
            if level != _ABSENT_KEY
        ]
        declared = self.declared_levels.get(column)
        if declared is not None:
            # VERBATIM — every position preserved, nothing filtered and nothing deduped.
            #
            # The stored codes are positions into THIS list, so removing or merging an entry
            # shifts every later code and silently relabels the column. `""` is a legal
            # level (`Table.categorical` stringifies its levels) and two entries can
            # canonicalise to one value; both must keep their slots. Absence is resolved
            # where it belongs — in the UNIFIED vocabulary, which excludes `""` so such a
            # code maps to `None` and becomes the ITEM-5 `NA`.
            levels = [_as_key(v) for v in declared]
            if not any(level != _ABSENT_KEY for level in levels) and any(
                _as_key(v) != _ABSENT_KEY for v in self.row_columns[column]
            ):
                raise AlignmentError(
                    f"source {self.dataset_id!r} declares a level set for row column "
                    f"{column!r} with no usable level ({levels}) while that column carries "
                    "real values — the declaration contradicts the data. Every row of this "
                    "source would map to NA while the coverage record reported nothing "
                    "dropped, which is a wrong column with a clean report"
                )
            return levels
        if declared is None:
            # No declaration was supplied — the in-memory-fixture case. Observation order,
            # and this branch must stay REACHABLE: a caller that collapses "absent" to "[]"
            # makes it dead code and takes the refusal below with it.
            return observed



    def rows(self):
        """The source as `list[dict]` — the form `align.align` takes as its table."""
        names = list(self.columns)
        return [
            {name_: self.columns[name_][i] for name_ in names} for i in range(self.n)
        ]

    def __repr__(self):
        return f"SourceTable({self.dataset_id!r}, n={self.n}, columns={list(self.columns)})"


def _normalised(values, steps):
    """One source column canonicalised exactly as `align` will canonicalise it.

    Imported, not reimplemented: see the module docstring. A local copy that drifted would
    make this module's counts describe a join nobody performs.
    """
    if steps:
        return [_apply_normalize(v, steps) for v in values]
    return [_as_key(v) for v in values]


#: `align._as_key` maps `None`/NaN to this. It is ABSENCE, and absence is not a key —
#: see [`_duplicate_keys`] for the one place that distinction is load-bearing.
_ABSENT_KEY = ""


def _duplicate_keys(keys):
    """The set of key values occurring more than once — **`""` excluded**.

    The exclusion is a real decision, and it was made by MEASURING `align` rather than by
    reading its docstring: two rows whose key is `None` both canonicalise to `""`, and
    `align.align` refuses them with *"duplicate key '' … each axis entity must map to at
    most one row"*. So a key column with two blanks genuinely cannot be joined on.

    Reporting that under `duplicated` would be the wrong label for the right refusal: the
    user's problem is *"10 of my genes have no ensembl id"*, not *"one gene appears twice"*,
    and the two are fixed differently. So absence is counted as [`missing`] and the
    resulting unjoinability is reported as `joinable: False`, which is a PREDICTION of the
    refusal rather than a second, differently-worded copy of it.

    That keeps the promise the module docstring makes — the report never says a key is fine
    where the refusal will fire — without pretending two faults are one.
    """
    seen = set()
    dups = set()
    for k in keys:
        if k == _ABSENT_KEY:
            continue
        if k in seen:
            dups.add(k)
        else:
            seen.add(k)
    return dups


def candidate_keys(sources):
    """The columns every source carries — the only ones that could BE a join key.

    A column one source lacks cannot join anything, and offering it would produce a
    candidate whose `matched` is necessarily 0. Sorted, so the offer order is stable across
    runs rather than a property of dict insertion.
    """
    if not sources:
        return []
    shared = set(sources[0].columns)
    for source in sources[1:]:
        shared &= set(source.columns)
    return sorted(shared)


def join_quality(sources, *, keys=None, normalize=None):
    """ITEM-1 — per candidate key, `matched` / `conflicting` / `duplicated`.

    ```
    ensembl_id   17,900 matched   0 conflicting      0 duplicated
    symbol       18,204 matched   1,204 conflicting  12 duplicated
    gene_id      17,850 matched   0 conflicting      0 duplicated
    ```

    The three counts are **disjoint**, and that is what makes the row readable:

    * **`duplicated`** — key values occurring more than once inside at least ONE source.
      Such a key makes the join many-to-one, silently changing what a "gene" means, so it
      is excluded from the other two counts and is what `refuse_duplicate_keys` refuses.
    * **`conflicting`** — keys present in EVERY source whose other shared identifiers
      disagree between sources. Under `strict` these are dropped; under `authority` they
      are kept and one dataset's annotation names them. Either way the user should see the
      number BEFORE choosing, which is why it is here and not discovered afterwards.
    * **`matched`** — keys present in every source with no such disagreement. Counting a
      conflicting key here instead would fold the entire question this measurement exists
      to expose into a number that looks better.

    `matched + conflicting` is therefore the size of the intersection this key can reach,
    and `matched` alone is what `strict` will keep.

    Two further counts the design's three-column example does not have, both added because
    `align`'s real behaviour was measured rather than assumed:

    * **`missing`** — rows whose key is absent (`None`/NaN → `""`). `align` refuses TWO of
      them as *"duplicate key ''"*, so a key column with two blanks cannot be joined on at
      all. Counted separately from `duplicated` because the two are fixed differently.
    * **`joinable`** — the report's PREDICTION of whether `refuse_duplicate_keys` will
      accept this key. False when anything is duplicated or when any source has ≥2 blanks.
      Without it the table could show `0 duplicated` beside a key that hard-fails.

    Args:
      sources:    `list[SourceTable]`, two or more.
      keys:       candidate key columns; default = every column all sources share.
      normalize:  an `align` normalize pipeline, applied to BOTH sides for matching only.

    Returns::

        {"sources": [dataset_id, …],
         "normalize": [...],
         "candidates": [{"key", "matched", "conflicting", "duplicated", "missing",
                         "joinable": bool,
                         "duplicated_per_source": {dataset_id: n},
                         "missing_per_source": {dataset_id: n},
                         "conflicting_columns": {column: n},
                         "present_per_source": {dataset_id: n}}, …]}

    `missing`, `missing_per_source` and `joinable` were absent from this block (D12) while
    the prose above described all three and the code emitted them — so the one part of the
    docstring a consumer reads as the CONTRACT was the part that under-stated it. `joinable`
    is the worst omission of the three: it is the field a key picker may not skip, because
    the highest-`matched` candidate can still be unjoinable.

    Enumerated from a REAL call rather than from the prose, which is how the gap is closed
    for good: `test_the_documented_RETURNS_SHAPE_matches_a_real_call` re-derives the key set
    at test time and fails if the two ever part company again.

    Never raises on a bad key — a measurement that refused could not report the number it
    was asked for (see the module docstring).
    """
    sources = list(sources)
    if len(sources) < 2:
        raise AlignmentError(
            f"join quality needs at least two sources to measure a join, got {len(sources)}"
        )
    ids = [s.dataset_id for s in sources]
    if len(set(ids)) != len(ids):
        raise AlignmentError(
            f"the same dataset appears twice in the source list {ids} — an alignment's "
            "sources are distinct datasets, and a repeat would make the segment table "
            "address one dataset under two indices"
        )
    steps = list(normalize or [])
    wanted = list(keys) if keys is not None else candidate_keys(sources)

    candidates = []
    for key in wanted:
        if any(key not in s.columns for s in sources):
            # Reported, not skipped: silently dropping a candidate the caller named is how
            # a key vanishes from the offer with no explanation.
            candidates.append({
                "key": key,
                "matched": 0,
                "conflicting": 0,
                "duplicated": 0,
                "duplicated_per_source": {},
                "conflicting_columns": {},
                "present_per_source": {},
                "missing": 0,
                "missing_per_source": {},
                "joinable": False,
                "unavailable_in": [s.dataset_id for s in sources if key not in s.columns],
            })
            continue

        per_source_keys = [_normalised(s.columns[key], steps) for s in sources]
        dups_per_source = [_duplicate_keys(ks) for ks in per_source_keys]
        duplicated_any = set().union(*dups_per_source) if dups_per_source else set()
        missing_per_source = [ks.count(_ABSENT_KEY) for ks in per_source_keys]
        # The report's PREDICTION of what `refuse_duplicate_keys` will do, made from the
        # same canonicalisation the refusal uses. Either fault makes the join many-to-one,
        # and a user comparing candidate keys needs to know which rows are unusable BEFORE
        # picking one — that is the whole reason ITEM-1 runs before the choice.
        joinable = not duplicated_any and all(m < 2 for m in missing_per_source)

        # The intersection, EXCLUDING anything duplicated anywhere: a duplicated key has no
        # single row to match, so calling it "matched" would be a claim about a join that
        # `refuse_duplicate_keys` will not let happen.
        # `_ABSENT_KEY` discarded here as well as from `shared` below: a source with blank
        # key values was reported as carrying one more distinct key than it does, so the
        # number a user reads beside `matched` overstated its joinable cardinality.
        present = [
            (set(ks) - duplicated_any) - {_ABSENT_KEY} for ks in per_source_keys
        ]
        shared = set.intersection(*present) if present else set()
        shared.discard("")  # `_as_key` maps None/NaN to "": absence, never a key

        # Which OTHER shared columns are secondary identifiers for this candidate.
        secondaries = [c for c in candidate_keys(sources) if c != key]
        lookups = [
            {k: i for i, k in enumerate(ks) if k not in duplicated_any}
            for ks in per_source_keys
        ]
        conflicting = 0
        conflicting_columns = {}
        for k in shared:
            disagreeing = []
            for column in secondaries:
                values = []
                for src_i, source in enumerate(sources):
                    row = lookups[src_i].get(k)
                    if row is None:
                        continue
                    value = _as_key(source.columns[column][row])
                    if value != "":
                        values.append(value)
                if len(set(values)) > 1:
                    disagreeing.append(column)
            if disagreeing:
                conflicting += 1
                for column in disagreeing:
                    conflicting_columns[column] = conflicting_columns.get(column, 0) + 1

        candidates.append({
            "key": key,
            "matched": len(shared) - conflicting,
            "conflicting": conflicting,
            "duplicated": len(duplicated_any),
            "duplicated_per_source": {
                s.dataset_id: len(d)
                for s, d in zip(sources, dups_per_source)
                if d
            },
            "conflicting_columns": dict(sorted(conflicting_columns.items())),
            "present_per_source": {
                s.dataset_id: len(p) for s, p in zip(sources, present)
            },
            "missing": sum(missing_per_source),
            "missing_per_source": {
                s.dataset_id: m
                for s, m in zip(sources, missing_per_source)
                if m
            },
            "joinable": joinable,
        })

    return {"sources": ids, "normalize": steps, "candidates": candidates}


def refuse_duplicate_keys(sources, key, *, normalize=None):
    """ITEM-2 — hard-fail if `key` is duplicated within ANY source.

    The refusal is `align.align`'s, not this module's (INV-4). Every source is passed
    through it **as the TABLE**, which is the side `align` guards: it raises `AlignmentError`
    on a duplicate raw key and, separately, on a normalisation collision (two distinct raw
    keys canonicalising to one). Both faults keep `align`'s own message, so an author reads
    the same sentence whichever path found it.

    Passing each source against its OWN keys as the axis is what makes the coverage total.
    `align` guards the table side only, so joining sources pairwise in one direction would
    leave the first source's duplicates unrefused — the source most likely to be the one the
    user is looking at.

    Returns the per-source coverage reports `align` produced, so a caller that wants the
    normalisation before/after numbers does not run the join twice.
    """
    steps = list(normalize or [])
    reports = []
    for source in sources:
        if key not in source.columns:
            raise AlignmentError(
                f"source {source.dataset_id!r} has no column {key!r} — it cannot join on a "
                f"key it does not carry (it has {sorted(source.columns)})"
            )
        try:
            reports.append(
                align(source.rows(), key, list(source.columns[key]), normalize=steps)
            )
        except AlignmentError as exc:
            # Re-raised naming the SOURCE. `align` knows the key and the colliding values
            # but not which dataset it was handed, and "duplicate key 'TP53'" across five
            # datasets is a message that does not say where to look.
            raise AlignmentError(
                f"dataset {source.dataset_id!r} cannot join on {key!r}: {exc}"
            ) from exc
    return reports


# ═══════════════════════════════════════════════════════════════════════════════
# ITEM-3 / ITEM-4 / ITEM-5 — the two conflict modes
# ═══════════════════════════════════════════════════════════════════════════════

#: The user makes NO claim beyond what was observed. On the FEATURE axis that means
#: dropping a pair whose secondary identifiers disagree (asserting they are one gene is
#: exactly the claim `strict` declines to make). On categorical LEVELS it means UNIONING the
#: level sets (a union asserts nothing — both vocabularies simply coexist).
STRICT = "strict"

#: The user names one dataset and its annotation BECOMES the unified feature's identity. On
#: the FEATURE axis nothing is dropped — the disagreeing pair is kept and the named dataset
#: labels it. On LEVELS the named dataset's vocabulary is taken as complete, so levels
#: outside it are dropped.
AUTHORITY = "authority"

#: ONE concept for the user to learn, not two. The same two names govern the feature axis
#: and the level case, and there is deliberately no third name for the level case: a mode
#: vocabulary that grew a special case would make the user learn the axis distinction in
#: order to predict what their own choice does.
MODES = (STRICT, AUTHORITY)

#: `strict` is the DEFAULT, so choosing `authority` is a deliberate act rather than the path
#: of least resistance. That asymmetry is the point: `authority` makes a claim about biology
#: on the user's behalf, and a claim nobody chose to make is the failure INV-1 is about.
DEFAULT_MODE = STRICT


def _resolve_mode(sources, mode, authority):
    """Validate a (mode, authority) pair and return `(mode, authority_index_or_None)`.

    Shared by the feature axis and the level case, because the mode vocabulary is shared —
    two validators would be two places for a third mode name to appear (ITEM-4).

    Every refusal here is a case where silently proceeding would leave the user believing
    they chose something they did not:

    * an unknown mode name — a typo that fell back to the default would apply `strict`
      while the caller believes they asked for `authority`;
    * `authority` with no dataset named — there is nothing to be the authority;
    * `authority` naming a dataset that is not a source — the named dataset's annotation
      cannot label anything, so the run would silently behave as `strict`;
    * `strict` WITH a dataset named — an ignored parameter, and the user who supplied it
      believes their choice took effect.
    """
    mode = DEFAULT_MODE if mode is None else str(mode)
    if mode not in MODES:
        raise AlignmentError(
            f"unknown conflict mode {mode!r}; known: {list(MODES)}. There is deliberately no "
            "third mode for the level case — the same two govern both axes"
        )
    ids = [s.dataset_id for s in sources]
    if mode == STRICT:
        if authority is not None:
            raise AlignmentError(
                f"mode {STRICT!r} names no authority dataset, but {authority!r} was supplied "
                f"— under {STRICT!r} nothing is asserted, so an authority would be silently "
                "ignored and the caller would believe their choice took effect"
            )
        return mode, None
    if authority is None:
        raise AlignmentError(
            f"mode {AUTHORITY!r} requires the dataset whose annotation becomes the unified "
            f"feature's identity; none was named (sources: {ids})"
        )
    authority = str(authority)
    if authority not in ids:
        raise AlignmentError(
            f"authority dataset {authority!r} is not one of this alignment's sources {ids} — "
            "its annotation cannot label a feature it does not carry"
        )
    return mode, ids.index(authority)


def resolve_features(sources, key, *, mode=None, authority=None, normalize=None):
    """ITEM-3 — which unified features the two modes keep, on the FEATURE axis.

    * **`strict`** (the default) — a feature whose secondary identifiers disagree between
      sources is DROPPED. Smaller intersection, no claim made.
    * **`authority`** — **nothing is dropped, and both datasets still contribute rows.**
      The named dataset's annotation becomes the unified feature's identity.

    > `authority` selects whose **annotation** labels the unified feature. It does NOT mean
    > "use that dataset's data" — expression values still come from both datasets. Nothing
    > in this function or its output encodes the latter, and nothing downstream may read it
    > that way.

    Returns::

        {"mode", "authority", "key", "features": [unified key, …],
         "conflicting": [key, …], "dropped": [key, …], "labels": {key: {column: value}}}

    `features` is the ORDER the unified feature axis is emitted in — the first source's own
    order, filtered — so the axis is a deterministic function of the inputs rather than of
    set iteration. `labels` carries, per kept feature, the annotation values that WON: under
    `strict` they are the agreed values; under `authority` they are the authority dataset's.
    """
    sources = list(sources)
    mode, authority_index = _resolve_mode(sources, mode, authority)
    steps = list(normalize or [])
    quality = join_quality(sources, keys=[key], normalize=steps)
    row = quality["candidates"][0]
    if not row.get("joinable", False):
        # The prediction `join_quality` made, enforced. Going through `refuse_duplicate_keys`
        # rather than raising on the flag keeps ONE refusal (INV-4) and gives align's own
        # message for whichever of the two faults it actually is.
        refuse_duplicate_keys(sources, key, normalize=steps)

    per_source_keys = [_normalised(s.columns[key], steps) for s in sources]
    dups = set().union(*[_duplicate_keys(ks) for ks in per_source_keys])
    lookups = [
        {k: i for i, k in enumerate(ks) if k not in dups and k != _ABSENT_KEY}
        for ks in per_source_keys
    ]
    shared = set(lookups[0])
    for lookup in lookups[1:]:
        shared &= set(lookup)

    secondaries = [c for c in candidate_keys(sources) if c != key]
    features, conflicting, dropped, labels = [], [], [], {}
    # The FIRST source's own order, so the unified axis is reproducible. Set iteration order
    # would make the same inputs emit a different feature vector between runs, and a row
    # vector is positional — a reordered axis is a different artifact wearing the same name.
    for k in per_source_keys[0]:
        if k not in shared or k in labels or k in dropped:
            continue
        disagrees = False
        agreed = {}
        for column in secondaries:
            values = []
            for src_i, source in enumerate(sources):
                value = _as_key(source.columns[column][lookups[src_i][k]])
                if value != "":
                    values.append(value)
            if len(set(values)) > 1:
                disagrees = True
            if values:
                agreed[column] = values[0]
        if disagrees:
            conflicting.append(k)
            if mode == STRICT:
                dropped.append(k)
                continue
        if mode == AUTHORITY:
            agreed = {
                column: _as_key(sources[authority_index].columns[column][
                    lookups[authority_index][k]
                ])
                for column in secondaries
            }
        features.append(k)
        labels[k] = agreed

    return {
        "mode": mode,
        "authority": None if authority_index is None else sources[authority_index].dataset_id,
        "key": key,
        "features": features,
        "conflicting": conflicting,
        "dropped": dropped,
        "labels": labels,
    }


def resolve_levels(sources, level_sets, *, mode=None, authority=None):
    """ITEM-4 — the SAME two modes applied to categorical LEVELS.

    * **`strict`** — UNION the level sets. A union asserts nothing: both vocabularies
      coexist, which is what "make no claim" means for a vocabulary.
    * **`authority`** — take the named dataset's vocabulary and DROP levels outside it. That
      is the claim: the named dataset's vocabulary is the complete one.

    ## The asymmetry, spelled out because it reads like a contradiction

    On the feature axis `strict` DROPS and `authority` KEEPS; here `strict` KEEPS everything
    and `authority` DROPS. Both follow from one rule and it is worth stating in one line:
    **`strict` never asserts an identity nobody observed; `authority` lets one dataset's
    annotation be the assertion.** Merging two disagreeing gene annotations is an assertion,
    so `strict` declines it. Unioning two vocabularies is not, so `strict` allows it. Taking
    one dataset's vocabulary as complete IS an assertion, so only `authority` does it.

    `ordered` never appears here, and its absence is deliberate (ITEM-14 / INV-15): an
    ordered categorical unions by exactly this code path, with no branch to write.

    Returns::

        {"mode", "authority", "levels": [unified level, …],
         "lookups": [{source code: unified code | None}, …],
         "dropped": {dataset_id: [level, …]}}

    A `None` in a lookup is a level this mode dropped; [`apply_level_lookup`] turns it into
    the `NA` of ITEM-5 rather than into an omitted row.
    """
    sources = list(sources)
    level_sets = [list(levels) for levels in level_sets]
    if len(level_sets) != len(sources):
        raise AlignmentError(
            f"got {len(level_sets)} level set(s) for {len(sources)} source(s) — one per "
            "source, in the same order, or the lookups address the wrong dataset"
        )
    mode, authority_index = _resolve_mode(sources, mode, authority)

    if mode == AUTHORITY:
        unified = [
            level
            for level in dict.fromkeys(level_sets[authority_index])
            if level != _ABSENT_KEY
        ]
    else:
        # First-seen order across the sources in their DECLARED order. Deterministic, and it
        # preserves each source's own sequence as far as a union can — but it is NOT an
        # asserted order: INV-15 says the fused column claims none, and nothing downstream
        # may read this sequence as one.
        unified = [
            level
            for level in dict.fromkeys(
                level for levels in level_sets for level in levels
            )
            if level != _ABSENT_KEY
        ]

    index = {level: i for i, level in enumerate(unified)}
    lookups, dropped = [], {}
    for source, levels in zip(sources, level_sets):
        lookup = {}
        missing = []
        for code, level in enumerate(levels):
            unified_code = index.get(level)
            lookup[code] = unified_code
            # An ABSENT level resolving to `None` is absence, not a level this mode dropped
            # — recording it as dropped would put a phantom in the coverage record.
            if unified_code is None and level != _ABSENT_KEY:
                missing.append(level)
        lookups.append(lookup)
        if missing:
            dropped[source.dataset_id] = missing

    # ── THE DECLARED MISSING LEVEL (C4) — never an out-of-range code ────────────────
    #
    # A source code with no unified code is one of two absences, and they are DIFFERENT
    # facts that need the SAME value:
    #
    #   * a level this mode DROPPED (`authority` only) — recorded in `dropped` above;
    #   * a level that is `_ABSENT_KEY` in the source — absence, deliberately not recorded
    #     as dropped.
    #
    # Both leave a row needing a value, and the answer is NOT a sentinel. `txr_columns`
    # settled this for the whole tree — *"give it a real, declared level rather than
    # dropping it or storing an out-of-range code"* — and the `-1` this function used to
    # imply is exactly the out-of-range code that idiom refuses.
    #
    # **ITEM-5's intent was right and its encoding was wrong.** It reached for
    # `_helpers/align.py`'s full-axis `NA`, which is an in-memory Python `None`, and
    # translated it to storage as `-1` instead of through the idiom it cited. The
    # consequence was measured on the read side: `remap_codes` refuses a negative code with
    # a 400 for the ENTIRE column, so `authority` — the only mode that drops — emitted a
    # conforming artifact that could never be served.
    #
    # The level is appended ONLY when something actually needs it, mirroring
    # `write_metadata_column`, which invents one only when pandas wrote a `-1`. A run that
    # drops nothing has a vocabulary byte-identical to before this change.
    needs_missing = any(code is None for lookup in lookups for code in lookup.values())
    missing_level = None
    if needs_missing:
        missing_level = missing_level_label(unified)
        unified = unified + [missing_level]
        absent_code = len(unified) - 1
        for lookup in lookups:
            for source_code, unified_code in list(lookup.items()):
                if unified_code is None:
                    lookup[source_code] = absent_code

    return {
        "mode": mode,
        "authority": None if authority_index is None else sources[authority_index].dataset_id,
        "levels": unified,
        "lookups": lookups,
        "dropped": dropped,
        # The label that MEANS absence in `levels`, or `None` when nothing was dropped.
        # Declared rather than derivable: a consumer must not have to guess which entry is
        # the invented one, and `vocab_digest` must EXCLUDE it or two identical vocabularies
        # disagree whenever one run happened to drop something (the M7 lesson, one layer up).
        "missing_level": missing_level,
    }


def apply_level_lookup(codes, lookup):
    """ITEM-5 — a FULL-AXIS column with `NA` where this mode dropped the row's level.

    Every candidate answer to "what does a row carrying a dropped level hold?" is a
    DIFFERENT column: an empty string is a level that reads as a real value, a synthetic
    `"other"` invents a category the data never had, and omitting the row changes the axis
    length so the column no longer aligns with anything.

    So this adopts the tree's existing idiom rather than inventing a third spelling:
    `_helpers/align.py` emits a full-axis column with `NA` (Python `None`) where an axis
    entity has no matching row, and this is the same `None`, in the same position, for the
    same reason. The output length ALWAYS equals `len(codes)`.

    **Note the axis distinction (DEC-A).** This `NA` is a LEVEL absence, on the obs axis. It
    is not the feature axis, where INV-12 makes absence unreachable — a dropped gene has no
    column to read, so there is no gene-axis `NA` and this must not be generalised onto one.
    """
    out = [None if code is None else lookup.get(int(code)) for code in codes]
    if len(out) != len(codes):  # pragma: no cover - defensive; a length change is the bug
        raise AlignmentError("the level lookup changed the column's length")
    return out


#: **RETIRED AS AN EMITTED VALUE (C4). Kept as the READ-SIDE contract's name for it.**
#:
#: This module no longer emits it: `resolve_levels` appends a DECLARED missing level and
#: maps every source code to a real index, so a lookup vector contains only in-range codes.
#: The constant survives because the read side still refuses a negative code — correctly —
#: and that guard is now unreachable by construction rather than deleted. A guard the other
#: side keeps standing, made impossible to trigger, is strictly better than one inverted.
#:
#: The original comment below is preserved because its reasoning is where the mistake was:
#: `-1` is pandas' own missing code IN MEMORY, and translating that to STORAGE is exactly
#: what `txr_columns` refuses (*"rather than storing an out-of-range code"*).
#:
#: The STORED spelling of "this mode dropped that level", in an emitted level-lookup vector.
#:
#: In memory a dropped level is `None` (see [`apply_level_lookup`] — the ITEM-5 `NA`, the
#: same `None` `_helpers/align.py` uses). A Zarr int32 array cannot hold `None`, so the
#: writer needs a sentinel, and `-1` is pandas' own missing-categorical code — the tree's
#: existing spelling rather than a fourth one.
#:
#: **It lives HERE because the producer may not own it (D6/INV-4).** It sat in
#: `embedding_integrate.py`, which meant the module whose docstring says it *"implements no
#: predicate of its own"* was in fact deciding the absence encoding, while this file defined
#: the in-memory one — two sources of truth for a single ITEM-5 fact, in two files, with
#: nothing comparing them. Worse, `apply_level_lookup` had **no production caller**, so the
#: spelling this engine's tests exercised was not the spelling that reached disk: the tests
#: could have agreed with themselves forever while the artifact carried something else.
#:
#: **DEC-A, and do not generalise it.** This is a LEVEL absence on the OBS axis. It is not
#: the entity axis, where the INTERSECTION makes absence unreachable and no sentinel exists.
DROPPED_LEVEL_CODE = -1


def stored_lookup_codes(lookup, source_levels):
    """One source's level lookup as the INT VECTOR that is written to disk (ITEM-8).

    `[unified code | DROPPED_LEVEL_CODE, …]`, indexed by the source's OWN stored code — so
    position `c` answers "what does this source's code `c` become in the unified
    vocabulary?", and a level this mode dropped is [`DROPPED_LEVEL_CODE`].

    This is the serialisation half of [`apply_level_lookup`], and it exists so the producer
    has nothing left to decide (INV-4). The producer previously built this vector itself,
    inline, with its own `-1` constant — which is how the emitted encoding came to be a
    second source of truth for the one this module defines.

    Length is `len(source_levels)`, ALWAYS: the vector is indexed by stored code, so a level
    that is declared but never observed still occupies its position. Dropping it would make
    a valid stored code index past the end of the vector.
    """
    out = []
    for code in range(len(source_levels)):
        unified_code = lookup.get(code)
        if unified_code is None:
            # UNREACHABLE BY CONSTRUCTION since C4 — `resolve_levels` now maps every source
            # code to a real index, appending a declared missing level when it has to. A
            # `None` here would mean that invariant broke, and emitting `-1` instead would
            # ship an artifact the read side refuses with a 400 for the whole column. Refuse
            # at EMIT time rather than shipping unservable bytes.
            raise AlignmentError(
                f"source code {code} ({source_levels[code]!r}) has no unified code. Since "
                "the missing-level mechanism (C4) every code maps, so this means "
                "`resolve_levels` returned a lookup with a hole — refusing rather than "
                "writing an out-of-range sentinel the serve path cannot read"
            )
        out.append(int(unified_code))
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# ITEM-6 / ITEM-7 / ITEM-8 / ITEM-9 — the three vectors, and the source digests
# ═══════════════════════════════════════════════════════════════════════════════

def build_vectors(sources, key, *, mode=None, authority=None, normalize=None,
                  level_columns=None):
    """The alignment's three vectors + the per-source key digests.

    ## The two axes move in OPPOSITE directions, and that is the design

    * the **ROW** axis is a CONCATENATION — every source contributes all of its rows, which
      is what ITEM-3's *"both datasets still contribute rows"* means;
    * the **ENTITY** axis is an INTERSECTION — an entity present in one source only has no
      entry at all (ITEM-7 / INV-2).

    Reading those the same way is the mistake this docstring exists to prevent: unioning the
    entity axis would force a gene present in one dataset to render as missing, and rendering
    it as zero is the fabricated-zero trap this project already refused on the gene axis.
    Intersecting the ROW axis would silently discard cells.

    ## The row layout is RECONSTRUCTED, not stored (D18)

    Output row `i` reconstructs to `(source, row-within-source)` from the SEGMENT TABLE
    alone: rows are laid out in DECLARED order, so the segment whose `[start_row, end_row)`
    contains `i` names the source (its `declared_order`), and the row within that source is
    `i - start_row`. The per-output-row `row_source` / `row_segment` vectors that used to
    carry this were pure redundancy — every value is derivable from the segments by a range
    search — so they are no longer emitted. The per-source `key_sequence_digest` still guards
    the positional addressing.

    Returns::

        {"segments":     [{dataset_id, declared_order, start_row, end_row}, …],
         "entities":     [unified key, …],           # the INTERSECTION, in source-0 order
         "entity_index": [[per-source column index, …], …],   # entities × sources
         "level_lookups": {column: {"levels": [...], "lookups": [...], "dropped": {...}}},
         "source_digests": [digest | None, …],
         "n_rows": int, "mode": …, "authority": …, "key": …}
    """
    sources = list(sources)
    resolved = resolve_features(
        sources, key, mode=mode, authority=authority, normalize=normalize
    )
    entities = resolved["features"]
    if not entities:
        # The empty-intersection REFUSAL, following `anndata-import`'s `align_barcodes`
        # precedent (:263-266). An alignment over zero shared entities is not a small
        # alignment — it is a dataset with no readable columns, and emitting it would defer
        # the failure to a reader that can only report "no data" without saying why.
        raise AlignmentError(
            f"the sources share no {key!r} value in common, so there is nothing to align — "
            f"an alignment over an empty intersection has no readable column. Sources: "
            f"{[s.dataset_id for s in sources]}"
        )

    steps = list(normalize or [])
    per_source_keys = [_normalised(s.columns[key], steps) for s in sources]
    dups = set().union(*[_duplicate_keys(ks) for ks in per_source_keys])
    lookups = [
        {k: i for i, k in enumerate(ks) if k not in dups and k != _ABSENT_KEY}
        for ks in per_source_keys
    ]

    # ── ITEM-7: the entity vector ────────────────────────────────────────────────
    #
    # TOTAL by construction: every row has an index for every source, because `entities` is
    # the intersection. There is deliberately no sentinel and no `None` here — if one could
    # appear, absence would be representable on this axis, and INV-12's promise that "every
    # zero the reader emits is a real measured zero" would need a sentinel encoding to hold.
    entity_index = [[lookups[i][k] for i in range(len(sources))] for k in entities]

    # ── ITEM-6: the segment table ────────────────────────────────────────────────
    #
    # `declared_order` is the producer's own index into the sources it was handed. The
    # segment ARRAY is then emitted in a different order on purpose (see `_emit_segments`),
    # so a consumer that iterates the array instead of sorting on the field is visibly
    # wrong rather than accidentally right. Output row `i` reconstructs to its
    # `(source, row-within-source)` from this table by a range search (D18) — there is no
    # per-row vector to store.
    segments, n_rows = _emit_segments(sources)

    # ── ITEM-8: the level lookups ────────────────────────────────────────────────
    level_lookups = {}
    for column in list(level_columns or ()):
        level_sets = []
        for source in sources:
            if column not in source.row_columns:
                raise AlignmentError(
                    f"level column {column!r} is not carried by source "
                    f"{source.dataset_id!r} (it has {sorted(source.row_columns)}). Level "
                    "columns are ROW-axis (obs) columns — an entity-axis column named here "
                    "would be a level set over the wrong axis"
                )
            # The source's DECLARED level set, in its own order: first appearance, which is
            # the order a categorical's `levels` list already has.
            level_sets.append(source.level_set_for(column))
        level_lookups[column] = resolve_levels(
            sources, level_sets, mode=mode, authority=authority
        )
        level_lookups[column]["source_levels"] = level_sets

    return {
        "key": key,
        "mode": resolved["mode"],
        "authority": resolved["authority"],
        "segments": segments,
        "n_rows": n_rows,
        "entities": entities,
        # The resolved ANNOTATION per unified entity — `{column: [value per entity]}`, in
        # `entities` order. Under `strict` these are the values both sources agreed on;
        # under `authority` they are the named dataset's.
        #
        # Carried here because `authority`'s DEFINING behaviour is which annotation
        # identifies the unified entity, and until this existed the resolver computed that
        # and threw it away: `resolve_features` returned `labels` and NOTHING consumed it,
        # so the two modes differed only in which entities survived. A blind audit proved
        # it — taking the label from the wrong source left every test green, end to end,
        # because the label reached no artifact.
        "entity_labels": {
            column: [resolved["labels"][k].get(column) for k in entities]
            for column in sorted({c for lab in resolved["labels"].values() for c in lab})
        },
        # What the mode REMOVED. Carried on the vectors because the coverage sidecar needs
        # it and cannot derive it: `entity_evidence` covers the entities that SURVIVED, so
        # deriving "dropped" from it returns the empty set in exactly the mode that drops.
        "dropped_entities": list(resolved["dropped"]),
        "entity_index": entity_index,
        "level_lookups": level_lookups,
        "source_digests": source_key_digests(sources),
    }


#: The order the segment ARRAY is serialised in — deliberately NOT the semantic order.
#:
#: A consumer must read `declared_order` and SORT on it; the containing array's order is "a
#: caller's convention rather than a guarantee", which is as true of a Rust reader as of a
#: TypeScript one (INV-6). If the array happened to be in semantic order, a consumer that
#: ignored the field would be accidentally right, every test would pass, and the omission
#: would surface only once some unrelated change reordered the array. So the array is sorted
#: by `dataset_id` — a stable, meaningless-to-the-semantics key — and the two orders differ
#: for any input whose declaration order is not alphabetical.
_SEGMENT_ARRAY_SORT_KEY = "dataset_id"


def _emit_segments(sources):
    """`(segments, n_rows)` — ITEM-6.

    Rows are laid out in DECLARED order (the producer's list order); the segment array is
    then re-sorted for serialisation, so `start_row` is NOT monotonic across the array. That
    non-monotonicity is intentional and load-bearing: it is what makes a consumer that
    iterates the array instead of sorting on `declared_order` produce visibly wrong ranges.

    Each segment is `{dataset_id, declared_order, start_row, end_row}` — a
    declared-order-contiguous output range. There is NO per-output-row vector (D18): output
    row `i` reconstructs to `(source, row-within-source)` from this table by finding the
    segment whose `[start_row, end_row)` contains `i` — source is that segment's
    `declared_order`, and row-within-source is `i - start_row`. The old `source_index` field
    is gone too: it always equalled `declared_order` because rows are laid out in declared
    order. `n_rows` (the total output row count, the final cursor) is returned alongside.
    """
    segments = []
    cursor = 0
    for declared_order, source in enumerate(sources):
        n_rows = source.n_rows
        if n_rows is None:
            raise AlignmentError(
                f"source {source.dataset_id!r} supplied no `row_keys`, so its row count is "
                "unknown and the segment table cannot be built. A positional row layout over "
                "a source whose rows cannot be identified is the exact failure ITEM-9's "
                "digest exists to catch — it is refused here rather than emitted uncheckable"
            )
        segments.append({
            "dataset_id": source.dataset_id,
            # The producer's index into the sources it was handed — the DECLARATION. This is
            # also which source's bytes this segment's rows come from, because rows are laid
            # out in declared order; the read side reconstructs a row's source from it.
            "declared_order": declared_order,
            "start_row": cursor,
            "end_row": cursor + n_rows,
        })
        cursor += n_rows
    segments.sort(key=lambda s: s[_SEGMENT_ARRAY_SORT_KEY])
    return segments, cursor


def source_key_digests(sources):
    """ITEM-9 — one `key_sequence_digest` per source, or `None` where it cannot be taken.

    ## Why this is the most expensive thing in the feature to get wrong

    Nothing observable distinguishes its failure from correct output. The row vector is
    POSITIONAL into the sources, so a source whose key sequence has changed returns the
    right NUMBER of the WRONG rows: every count agrees, every length assertion passes, the
    console is clean, and the picture is simply of different cells.

    ## Why the digest and not the content hash

    A producer cannot name a `content_hash` — ingest mints it after the fact, over bytes the
    producer has not finished writing. The ordered key sequence is the only identity a
    declaration can carry, which is why it, and not the hash, pins the sources.

    ## Why `txr_zarr.key_sequence_digest` and not a set hash

    It is ORDER-SENSITIVE, and that is the entire property. Two arrays holding the same keys
    in a different order describe DIFFERENT alignments — row 3 means a different entity in
    each — so an order-independent set hash (which this same module also offers, as
    `vocab_declaration`'s `vocab_digest`) would certify exactly the failure the digest exists
    to catch. The two live side by side in `txr_zarr`, so picking the wrong one is a real
    and easy mistake.

    `None` means **"cannot be checked"** and must never read as "matches" (INV-5).
    """
    import txr_zarr

    return [
        None if source.row_keys is None else txr_zarr.key_sequence_digest(source.row_keys)
        for source in sources
    ]


# ═══════════════════════════════════════════════════════════════════════════════
# ITEM-10 / ITEM-11 / ITEM-13 / ITEM-14 / ITEM-15 — the evidence record
# ═══════════════════════════════════════════════════════════════════════════════

def alignment_metadata(sources, key, vectors, *, join_quality_report,
                       source_orders=None, normalize=None):
    """ITEM-10 / ITEM-11 / ITEM-14 — the record that makes a later read INTERPRETABLE.

    ## Why the mode has to be recorded

    Without it a reader cannot tell an ASSERTED identity from an OBSERVED one. Under
    `strict` a unified entity's annotation is one both sources agreed on; under `authority`
    it is one dataset's, and the other's may have disagreed. The values look identical.

    ## Why the join-quality counts are recorded AS MEASURED

    They are taken at analysis time, over the sources as they were, BEFORE the mode resolved
    anything. Recomputing them afterwards from the post-resolution state would report
    `conflicting: 0` for every `strict` alignment — the conflicts were dropped, so they are
    not there to count — which is precisely the number a reader wants and the one that would
    be lost. So the report is passed in, not derived here.

    ## Why per-entity evidence (ITEM-11)

    This is what stops the silent misreading. Under `authority`, someone later reads a
    unified entity's `ensembl_id` and takes it as true for BOTH datasets' rows — which
    authority mode does not assert. Recording, per entity, which sources contributed, which
    key matched, and **whether the secondary identifiers agreed**, makes that inspectable
    instead of lost.

    ## ITEM-14 — the per-source declared orders

    Recorded, and asserted by nobody. `ordered` categoricals UNION exactly like unordered
    ones (INV-15) and the fused column claims no order — but each source's declared order is
    kept here so a future ordinal analysis finds the evidence rather than losing it. Same
    principle as the per-entity evidence: **record what was observed; do not assert what was
    not.**
    """
    sources = list(sources)
    quality_rows = {c["key"]: c for c in join_quality_report["candidates"]}
    if key not in quality_rows:
        raise AlignmentError(
            f"the join-quality report does not cover the chosen key {key!r} (it covers "
            f"{sorted(quality_rows)}) — the recorded counts must be the ones MEASURED for "
            "this key, never a recomputation"
        )

    steps = list(normalize or [])
    per_source_keys = [_normalised(s.columns[key], steps) for s in sources]
    dups = set().union(*[_duplicate_keys(ks) for ks in per_source_keys])
    lookups = [
        {k: i for i, k in enumerate(ks) if k not in dups and k != _ABSENT_KEY}
        for ks in per_source_keys
    ]
    secondaries = [c for c in candidate_keys(sources) if c != key]

    entity_evidence = []
    for entity in vectors["entities"]:
        agreed = True
        disagreeing = []
        for column in secondaries:
            values = []
            for src_i, source in enumerate(sources):
                value = _as_key(source.columns[column][lookups[src_i][entity]])
                if value != "":
                    values.append(value)
            if len(set(values)) > 1:
                agreed = False
                disagreeing.append(column)
        entity_evidence.append({
            "entity": entity,
            # WHICH sources contributed it. Always all of them today (the entity axis is an
            # intersection), and recorded explicitly rather than implied by that fact — a
            # reader should not have to know the intersection rule to interpret the record.
            "source_indices": list(range(len(sources))),
            "matched_on": key,
            # The flag the whole item exists for.
            "secondaries_agreed": agreed,
            "disagreeing_columns": disagreeing,
        })

    return {
        "mode": vectors["mode"],
        # `None` under `strict`, and that is a real distinction: `strict` names no authority
        # because it asserts nothing.
        "authority": vectors["authority"],
        "join_key": key,
        "normalize": steps,
        # AS MEASURED, at analysis time, before the mode resolved anything.
        "join_quality": quality_rows[key],
        "sources": [
            {
                "dataset_id": s.dataset_id,
                # The ROW axis's digest (ITEM-9) — the row vector's anchor.
                "key_sequence_digest": d,
                # The ENTITY axis's digest (D8) — the entity vector's anchor. Recorded even
                # when absent, as an explicit null, so a reader can tell "this source's
                # entity order cannot be checked" from "this key is missing from the record".
                "entity_axis_digest": s.entity_axis_digest,
                "n_rows": s.n_rows,
            }
            for s, d in zip(sources, vectors["source_digests"])
        ],
        "entity_evidence": entity_evidence,
        # ITEM-14 / INV-15. Keyed by column, then by dataset — evidence ABOUT the alignment,
        # which is where a reader already looks for the mode and the per-entity record
        # (DEC-12). Never on the fused column, and never on the sidecar: one evidence record
        # split across two artifacts is two places to look and one place to forget.
        "source_declared_orders": dict(source_orders or {}),
    }


def coverage_sidecar(sources, vectors, metadata, *, dropped_entities=None):
    """ITEM-15 — the coverage record, on a SEPARATE artifact.

    `annotation-integrate` puts coverage on a hidden `integration_summary` artifact
    (`data/opaque`, role `intermediate`) whose meta carries `matched` / `missing` / `extra` /
    `total` / … and whose per-column `meta` is the colsummary descriptor plus `stored`,
    nothing more. That shape exists AND has a backend consumer; a per-column
    `meta.coverage` key does not exist anywhere in the tree.

    **Exactly one place.** The caller must not also write a coverage figure onto a fused
    column's `meta` — two spellings of one fact is the outcome the design explicitly forbids,
    and the one that goes stale is the one nobody is looking at.
    """
    dropped_levels = {
        column: lookup["dropped"]
        for column, lookup in vectors["level_lookups"].items()
        if lookup["dropped"]
    }
    return {
        "kind": "alignment_summary",
        "join_key": metadata["join_key"],
        "mode": metadata["mode"],
        "authority": metadata["authority"],
        "n_sources": len(sources),
        "n_rows": vectors["n_rows"],
        "n_entities": len(vectors["entities"]),
        # The measured counts, again AS MEASURED — the same object the metadata carries, so
        # the two cannot disagree.
        "join_quality": metadata["join_quality"],
        # Which levels `authority` dropped, per column per dataset. THE coverage figure for
        # the level case, and it lives here and nowhere else.
        "dropped_levels": dropped_levels,
        # THE ENTITIES THAT WERE ACTUALLY DROPPED — supplied by the caller from
        # `resolve_features()["dropped"]`, NOT derived from `entity_evidence`.
        #
        # Deriving it from the evidence was exactly inverted, and it is worth stating why
        # so it cannot be "simplified" back: `entity_evidence` is built over the entities
        # that SURVIVED, so under `strict` — the default, and the only mode that drops —
        # a dropped entity has no evidence row and the list was ALWAYS empty; under
        # `authority`, where nothing is dropped, it listed the kept-but-conflicting ones.
        # The one artifact recording what the join excluded reported the opposite of the
        # truth in both modes, which for a scientific integration is a silent
        # data-provenance corruption of the exact fact it exists to preserve.
        "entities_dropped_conflicting": list(
            vectors.get("dropped_entities", ()) if dropped_entities is None
            else dropped_entities
        ),
        # Kept SEPARATE, because it is a different question: under `authority` these
        # entities are IN the alignment but their sources disagreed about identity.
        "entities_kept_with_disagreeing_secondaries": [
            e["entity"] for e in metadata["entity_evidence"] if not e["secondaries_agreed"]
        ],
    }


def definition_content_hash(alignment_id, source_ids, column_selector):
    """ITEM-13 — the ABSTRACT half's identity: a hash of the DEFINITION, not of bytes.

    The alignment artifact is REAL — small, content-hashed over its own bytes by ingest,
    immutable. A FUSED COLUMN is not: it is a Postgres row read THROUGH that alignment, and
    it has no bytes of its own to hash. Its identity is therefore its recipe — the alignment
    it reads through, the sources, and which column — and that is what this hashes.

    Stability across re-emission is the property that matters, because it is what makes an
    `immutable` cache header on a fused column's response TRUE. Hashing gathered bytes
    instead would mint a new hash for every identical re-emission and quietly invalidate
    every cached read.

    Order-independence on `source_ids` is deliberate: the same definition supplied with its
    sources listed differently is the SAME definition. Segment ORDER is carried by the
    alignment's `declared_order` (ITEM-6), not by this list, so sorting here cannot lose it.
    """
    import hashlib

    if not alignment_id or not column_selector:
        raise AlignmentError(
            "a fused column's definition needs both an alignment id and a column selector — "
            "without either, the hash would not identify the thing it names"
        )
    # Materialised ONCE. The sorted() below and the trailing count both read this, and
    # reading the parameter twice meant a generator was exhausted by the first pass and
    # stamped a count of 0 — so the same definition hashed differently depending only on
    # the container type the caller happened to use, defeating the stability the
    # `immutable` cache header rests on.
    source_ids = [str(s) for s in source_ids]
    h = hashlib.sha256()
    for part in (str(alignment_id), str(column_selector)):
        raw = part.encode("utf-8")
        h.update(len(raw).to_bytes(8, "little"))
        h.update(raw)
    for source_id in sorted(source_ids):
        raw = source_id.encode("utf-8")
        h.update(len(raw).to_bytes(8, "little"))
        h.update(raw)
    h.update(b"\xff" + len(source_ids).to_bytes(8, "little"))
    return h.hexdigest()
