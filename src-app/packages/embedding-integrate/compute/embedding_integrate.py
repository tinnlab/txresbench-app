#!/usr/bin/env python3
# ruff: noqa
"""embedding-integrate — the alignment PRODUCER (virtual-dataset-alignment, stage 1).

Given several datasets and a user-chosen join key, emit ONE `dataset-alignment` artifact
holding the three vectors a fused column is read THROUGH, plus a hidden coverage sidecar.

**This script implements no predicate of its own (INV-4).** Every decision — which entities
survive, what the modes do, which levels map where, what the digests are — comes from
`_helpers/alignment.py`, the engine this package's tests exercise directly. What lives here
is I/O: read `/inputs`, call the engine, write `/outputs`. If you find yourself adding a
rule here, it belongs in the engine, where the reader has no second copy to diverge from.

## The run contract

Mirrors `annotation_integrate.py`: read `/inputs/<slot>` + `inputs.json` + `params.json`;
write `/outputs/<file>` + `/outputs/manifest.json`. `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`
override the roots for the off-sandbox harness.

## Inputs — a dataset × column GRID, carried by the SLOT NAMES

Real ingest emits **one artifact per column** (`metadata-column`), and such a store cannot
carry its own column name: its member is always the constant `values`, and the display name
lives in the catalog row's `meta`, which is never staged into a sandbox. Nor does a mount
name identify anything — `derive_artifact_mount_name` is a pure function of the SLOT plus
the encoding, ordinal-disambiguated. So **neither coordinate of the grid is recoverable from
the wire or from the bytes**, and both must be declared.

They are declared in the SLOT NAME, as a slot FAMILY — the shape `cell-filter` already
ships (`COLUMN_SLOT_PREFIX = "column:"`), for the identical reason:

* `entity:<dataset_index>:<column_name>` — one ENTITY-axis identifier column. The join key
  is one of these; every other one bound for a dataset is a SECONDARY identifier whose
  disagreement makes a pair conflicting (ITEM-3). Join quality needs ≥2 per dataset to
  detect a conflict at all.
* `level:<dataset_index>:<column_name>` — an obs categorical whose levels are to be fused.
  Optional, 0..M per dataset.

`<dataset_index>` indexes `params.dataset_ids`; the remainder after the FIRST `:` is the
column name verbatim, so a column name containing `:` is safe.

Plus ONE ordinary slot, because it is one artifact per dataset rather than a grid:

* `rows` (`multiple: true`) — each dataset's ROW-axis (obs) index artifact, the ordered row
  keys ITEM-9 digests, aligned with `params.dataset_ids` by BINDING ORDER.

**Why the two shapes, and why that is not inconsistency.** A positional relay is only unsafe
over a RAGGED dimension. The entity grid is ragged — one dataset may contribute two
identifier columns and another three — so a flat list would need a relayed partition, and a
relay saying `[1,4]` where the truth is `[2,3]` partitions wrongly and attributes one
dataset's column to another while every count agrees: the silent-wrong-answer class this
feature has already paid for twice (a mount name read as an identity; a mis-ordered id
relay). The row axis is exactly one per dataset, so binding order carries it unambiguously —
the alignment the runner does guarantee, and the relay `qc` already uses for
`params.matrix_modalities`. That one positional dimension is then MANDATORILY verified
against `params.dataset_content_hashes` (`cross_check_relay`), so no unchecked channel is
left in the input shape.

The entity axis and the row axis stay SEPARATE bindings because they are separate AXES, and
conflating them is a real defect this feature already paid for: an obs column read as an
entity-axis identifier becomes a secondary identifier of the join, and `strict` then drops
every entity the two datasets annotate differently — silently, with a plausible smaller
result.

**Params** (`/inputs/params.json`): `key` (required — a COLUMN NAME that must be bound as
`entity:<i>:<key>` for every `i`), `dataset_ids` (positional, the grid's dataset dimension),
`dataset_content_hashes` (REQUIRED map: dataset id → that dataset's `rows` binding's hash),
`mode` (`strict` default), `authority`, `normalize`.

There is **no `level_columns` param**: the set of fused columns IS the bound `level:` slots.
A params key naming information the binding already carries is the second channel that falls
out of step with the mounts — which is the whole reason the names ride the slot.

## Outputs

1. `alignment.zarr` — datatype `dataset-alignment`, role `artifact`, **hidden**. The entity
   keys are the table's own key member; the three vectors ride the `aux` channel (ITEM-12),
   because their lengths are the output row count, the segment count and the source count —
   none of which is the table's `n`.
2. `alignment_summary.json` — `data/opaque`, role `intermediate`, **hidden**. The coverage
   record, in exactly one place (ITEM-15).

`role`/`hidden` are stamped HERE, on the emitted artifact row, and not on the datatype:
`DatatypeContribution` has no such fields and is `deny_unknown_fields` (see the DEC-11
correction in the lifecycle DECISIONS).
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

import alignment as engine
import cyto_deps
import cyto_columns
import cyto_zarr
import cyto_zarr_read

#: The alignment table's own axis. DOMAIN-FREE on purpose, and it must equal the axis the
#: `dataset-alignment` datatype declares: this producer aligns whichever entity axis the
#: user chose — cells, genes, variants, samples — and the engine "never knows which".
ALIGNMENT_AXIS = "unified_entities"

#: The stored absence sentinel is the ENGINE's (`alignment.DROPPED_LEVEL_CODE`), not this
#: module's. It was defined here, which made this script the second source of truth for an
#: ITEM-5 fact it is not allowed to decide — see `engine.stored_lookup_codes` (D6).

#: The ENTITY-axis identifier columns, one binding per (dataset, column) cell of the grid.
#: A `metadata-column` Zarr store declares a member called `values` and NEVER the column's
#: display name (that lives in the catalog row's `meta` and is not staged), and a mount name
#: is a sanitized SLOT plus an ordinal — so both grid coordinates arrive with the BINDING.
#: Same construct and same reason as `cell-filter`'s `COLUMN_SLOT_PREFIX`.
ENTITY_SLOT_PREFIX = "entity:"

#: The obs categoricals to fuse. 0..M per dataset; the bound set IS the selection, so there
#: is no `params.level_columns` to fall out of step with it.
LEVEL_SLOT_PREFIX = "level:"

#: The ROW-axis index artifacts — the ordered row keys ITEM-9 digests. ONE per dataset, so
#: this is a LITERAL slot bound `multiple: true` and read POSITIONALLY, not a family.
#:
#: The difference from the two families above is the whole reason both shapes are here, and
#: it is not a style choice. A positional relay is only unsafe over a RAGGED dimension: the
#: entity grid is ragged (one dataset may contribute two identifier columns and another
#: three), so a relayed partition of `[1,4]` where the truth is `[2,3]` mis-partitions while
#: every count agrees. The row axis is exactly one per dataset — not ragged — so binding
#: ORDER carries it unambiguously, which is the alignment the runner does guarantee and the
#: same relay `qc` uses for `params.matrix_modalities`.
#:
#: And unlike a ragged partition, this one is VERIFIED rather than trusted:
#: `cross_check_relay` is MANDATORY on this path (see `load_grid`), so binding `i` must
#: actually be the artifact `params.dataset_content_hashes[dataset_ids[i]]` names.
ROWS_SLOT = "rows"

#: The constant member a single-column `metadata-column` store writes its values under
#: (`cyto_columns.write_metadata_column` → `t.string("values", …)` / `key="values"`).
#: Measured on the live catalog: every emitted `structure.columns[0].name` is this.
COLUMN_MEMBER = "values"


# ─────────────────────────────── I/O idioms (mirrors annotation_integrate) ─────

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


def load_slot_entries(inputs_dir):
    """slot → the `inputs.json` ENTRIES bound to it, in wire order.

    The whole entry, not just a path: the real wire is
    `{slot, kind, content_hash, sandbox_path}` (`InputsJsonEntry`, `inputs.rs:63-69`), and
    `content_hash` is a genuine per-artifact identity that the previous loader threw away
    along with everything else that was not the path.

    Resolving by SLOT and never by glob is `cell-filter`'s rule and it is right here too:
    `inputs.json` maps slot → path and is the whole contract. Every slot is kept, including
    ones this compute does not recognise — `collect_grid` selects the families it wants, and
    the refusals name the full declared slot list so an unbound or mistyped family is
    diagnosable from the error rather than invisible.
    """
    index = read_json(inputs_dir / "inputs.json", {"inputs": []})
    slots = {}
    for entry in index.get("inputs", []):
        slot = entry.get("slot")
        sandbox_path = entry.get("sandbox_path", "") or ""
        sub = (
            sandbox_path[len("/inputs/"):]
            if sandbox_path.startswith("/inputs/")
            else Path(sandbox_path).name
        )
        if not slot or not sub:
            continue
        # S9 — CONTAINMENT. The remainder was taken verbatim and joined onto `inputs_dir`,
        # so a `sandbox_path` of `/inputs/../secrets` resolved OUTSIDE the mount root.
        #
        # Defence-in-depth: `inputs.json` is server-written, and `validate_subpath` already
        # guards the name the runner derives. It is kept because the trust chain is longer
        # than it looks — the runner's guard is over the name it DERIVES, while this reads
        # the name it RECORDED, and those are the same string only for as long as nobody
        # introduces a path this compute did not stage. Refusing costs one comparison.
        #
        # It also refuses a MULTI-component remainder: every mount this compute reads is a
        # single directory directly under `/inputs`, so a nested path is a shape the runner
        # does not produce and this loader has no business inventing a meaning for.
        #
        # THE TWO CHECKS BELOW ARE REDUNDANT, and that is deliberate rather than sloppy —
        # but the redundancy is MEASURED, not assumed, because it changes what a control
        # proves. Disabling EITHER one alone leaves the escape tests green (the other
        # catches both cases); disabling BOTH turns them red. So the control for this pair
        # is "both disabled", and no test here should be read as pinning one of them
        # individually. The first gives the precise diagnosis (which shape rule was broken);
        # the second is the semantic backstop that does not depend on enumerating shapes.
        resolved = (inputs_dir / sub).resolve()
        if ".." in Path(sub).parts or Path(sub).is_absolute() or len(Path(sub).parts) != 1:
            raise engine.AlignmentError(
                f"the binding at slot {slot!r} declares sandbox_path {sandbox_path!r}, whose "
                f"/inputs remainder {sub!r} is not a single directory name directly under "
                "/inputs. Refusing rather than resolving a path this run did not stage"
            )
        if resolved.parent != inputs_dir.resolve():
            raise engine.AlignmentError(
                f"the binding at slot {slot!r} resolves to {resolved}, which is outside the "
                f"inputs root {inputs_dir.resolve()}"
            )
        slots.setdefault(str(slot), []).append({**entry, "path": inputs_dir / sub})
    return slots


def parse_grid_slot(slot, prefix):
    """`(dataset_index, remainder)` for a slot in `prefix`'s family, else `None`.

    ONE split, at a KNOWN position: `rest.split(":", 1)`. The index is `[0-9]+`, so the first
    `:` after the prefix is unambiguous and **the column name may itself contain `:`** —
    obs/var names are arbitrary strings and a greedy or right-hand split would corrupt them.
    A non-numeric index is refused by the caller, never guessed at: this is a bounded parse
    of a composed slot NAME, not the "parse a composed id" shape, and the difference is that
    every field here has a declared grammar the writer of the slot controls.

    The remainder is returned verbatim, including empty — `entity:0:` is a real mistake and
    the caller names it rather than silently reading it as a column called "".
    """
    if not slot.startswith(prefix):
        return None
    rest = slot[len(prefix):]
    index, _, remainder = rest.partition(":")
    return index, remainder


def _dataset_index(raw, slot, n_datasets):
    """The validated dataset coordinate of `slot`. Refuses; never guesses."""
    if not raw.isdigit():
        raise engine.AlignmentError(
            f"slot {slot!r} does not name a dataset index — the segment before the first "
            f"':' after the prefix is {raw!r}, which is not a non-negative integer. The "
            "dataset coordinate indexes params.dataset_ids and is the only thing that ties "
            "a bound column to a dataset, so a slot that does not carry one is refused "
            "rather than attributed to a guess"
        )
    index = int(raw)
    if index >= n_datasets:
        raise engine.AlignmentError(
            f"slot {slot!r} names dataset index {index}, but params.dataset_ids relays "
            f"{n_datasets} dataset(s) (valid indices 0..{n_datasets - 1}). Either the relay "
            "is short or the binding names a dataset this run was not given"
        )
    return index


def collect_grid(slots, prefix, n_datasets):
    """The bound cells of one slot family, as `{dataset_index: {column_name: entry}}`.

    Refuses a duplicate cell rather than letting the later binding win: two bindings claiming
    one (dataset, column) means the launcher believes something this compute cannot represent,
    and picking one of them silently answers a question nobody asked.
    """
    out = {}
    for slot, entries in sorted(slots.items()):
        parsed = parse_grid_slot(slot, prefix)
        if parsed is None:
            continue
        raw_index, column = parsed
        index = _dataset_index(raw_index, slot, n_datasets)
        for entry in entries:
            if not column:
                raise engine.AlignmentError(
                    f"slot {slot!r} names no column — the text after the dataset index is "
                    "the column name, and a metadata-column store cannot supply one of its "
                    "own (its member is always 'values')"
                )
            cells = out.setdefault(index, {})
            if column in cells:
                raise engine.AlignmentError(
                    f"two bindings claim column {column!r} for dataset index {index} "
                    f"(slot {slot!r}) — refusing rather than picking one of them"
                )
            cells[column] = entry
    return out


def declared_axis_digest(structure):
    """The row space a single-column store declares it belongs to, or `None`.

    `key_sequence_digest` when the store CARRIES the axis's keys, `aligned_to` when it is an
    ordinary column aligned to them. `None` is a real, distinct state meaning **"cannot be
    checked"** and must never read as "matches" — the same rule ITEM-9 applies to a source
    digest, and it is load-bearing here: `aligned_to` landed on 2026-08-13 (`a2a39c32`), so
    every artifact ingested before that date carries none. Measured on the live catalog:
    0 of 78 metadata-columns had one.
    """
    for field in ("key_sequence_digest", "aligned_to"):
        value = structure.get(field)
        if value:
            return str(value)
    return None


def read_single_column(root, slot):
    """`(values, declared_levels, axis_digest, member_kind)` for one `metadata-column` store.

    The member is the constant `COLUMN_MEMBER` — measured, not assumed: every emitted
    `structure.columns[0].name` on the live catalog is `values`, and
    `cyto_columns.write_metadata_column` writes exactly that one member.

    Read through `cyto_zarr_read`, the producer-side reader, so this decodes what the writer
    wrote rather than re-deriving the container by hand.
    """
    structure = cyto_zarr_read.structure(root)
    members = {m.get("name") or m.get("path") for m in (structure.get("columns") or [])}
    if COLUMN_MEMBER not in members:
        raise engine.AlignmentError(
            f"the artifact bound at slot {slot!r} declares members {sorted(members)} and no "
            f"{COLUMN_MEMBER!r} — a single-column `metadata-column` store writes its values "
            "under that constant member, so this is not one. Bind the column artifact, not "
            "the store it came from"
        )
    values = cyto_zarr_read.read_column(root, COLUMN_MEMBER)
    values = values.tolist() if hasattr(values, "tolist") else list(values)

    # THE STORED CODE SPACE, taken from the member's own stamp — NOT inferred from the
    # labels just decoded.
    #
    # `read_column` resolves codes to labels and drops the level list, so inferring the level
    # set from the observed labels gives FIRST-APPEARANCE order. The codes on disk are
    # positions in the DECLARED order (pandas' is sorted, not first-appearance), so whenever
    # the two differ every emitted `code -> unified code` entry is a permutation of the truth
    # and every fused value is silently relabelled. A level that is declared but never
    # observed is also missing entirely, so a valid stored code indexes past the end.
    #
    # `.get("levels")` WITHOUT an `or []` fallback, deliberately: `None` means "not
    # declared" (the engine's observation-order branch) and `[]` means "declared empty",
    # which the engine refuses when the column actually carries values. Collapsing the two
    # made a member with no stamp read as declaring emptiness, mapping every one of that
    # source's rows to NA while the coverage record reported nothing dropped.
    stamped = cyto_zarr_read.read_meta(root, COLUMN_MEMBER)
    cyto = (stamped.get("attributes", {}) or {}).get("cyto", {}) or {}
    declared = cyto.get("levels")
    return (
        values,
        None if declared is None else list(declared),
        declared_axis_digest(structure),
        cyto.get("kind"),
    )


def load_grid(inputs_dir, params, *, with_rows, with_levels):
    """The dataset × column grid, validated. `[GridSource, …]` in dataset-index order.

    Shared by BOTH entry points so the producer and the join-quality preflight cannot drift
    about what a binding means. The preflight passes `with_rows=False` / `with_levels=False`:
    join quality is a function of the small entity columns alone (INV-11), and reading the
    row axis would multiply its cost by the cell count.

    ## Why the dataset ids are still RELAYED, and still cross-checked

    `derive_artifact_mount_name(slot, structure)` is a pure function of the SLOT and the
    store encoding; `unique_mount_name` then disambiguates POSITIONALLY. A mount carries a
    slot and an ordinal — never a dataset identity. So `params.dataset_ids` relays the ids,
    and the SLOT carries which of them each binding belongs to.

    That relay is silently wrong if it is MIS-ORDERED: `entity:0:*` would be attributed to
    whatever `dataset_ids[0]` says. `params.dataset_content_hashes` is the cross-check, and
    it is keyed BY DATASET ID against the `rows` binding's on-the-wire `content_hash` — the
    one canonical per-dataset artifact now that there is no single artifact per dataset.

    **It must not be two PARALLEL relayed lists.** Reversing the ids while the hashes stay
    put leaves every (wire hash, params hash) pair still matching, because both sides of that
    comparison are relayed and neither is tied to a dataset. Measured — the first version of
    this check passed a reversed relay.

    ## Why `rows` is a literal slot and the other two are families

    `rows` is exactly ONE artifact per dataset, so binding ORDER carries the dataset
    coordinate unambiguously and the shipped convention applies (`qc` relays
    `matrix_modalities` the same way). The entity and level dimensions are RAGGED, and a
    positional partition over a ragged dimension mis-attributes silently — which is the
    whole reason those two carry their coordinates in the slot NAME instead.

    Keeping `rows` literal is also what lets `appliesTo` name a real, required,
    compute-resolved slot: every shipped `appliesTo` selector carries one (measured across
    all seven analyses in the tree), and the view↔compute gate's arm A requires it. A
    family-only analysis would have none, and would be the first.
    """
    slots = load_slot_entries(inputs_dir)
    dataset_ids = validated_dataset_ids(params, slots)
    n = len(dataset_ids)

    entities = collect_grid(slots, ENTITY_SLOT_PREFIX, n)
    levels = collect_grid(slots, LEVEL_SLOT_PREFIX, n) if with_levels else {}
    # POSITIONAL, in wire order — `load_slot_entries` preserves it, and `render_inputs_json`
    # is documented as "deterministic — slot order preserved".
    rows = [e for e in slots.get(ROWS_SLOT, [])] if with_rows else []

    missing_entities = [i for i in range(n) if not entities.get(i)]
    if missing_entities:
        raise engine.AlignmentError(
            f"dataset index/indices {missing_entities} have no {ENTITY_SLOT_PREFIX!r} "
            f"binding. `/inputs/inputs.json` declares slot(s) {sorted(slots) or '[]'}; every "
            "source must contribute at least the join key column, and refusing beats "
            "aligning over the sources that happen to be present — the entity axis is an "
            "INTERSECTION, so a missing source makes the result LARGER and every count would "
            "describe a join nobody requested"
        )
    if with_rows and len(rows) != n:
        raise engine.AlignmentError(
            f"the {ROWS_SLOT!r} slot has {len(rows)} binding(s) for {n} relayed dataset(s). "
            "It is ONE row-axis index per dataset, aligned by binding order — without a "
            "complete set a source's row keys cannot be digested, and a positional row "
            "vector over unidentifiable rows is exactly the failure ITEM-9 exists to catch"
        )

    if with_rows:
        cross_check_relay(params, dataset_ids, rows)

    sources = []
    for index, dataset_id in enumerate(dataset_ids):
        columns, digests = {}, {}
        for column, entry in sorted(entities[index].items()):
            slot_name = f"{ENTITY_SLOT_PREFIX}{index}:{column}"
            values, _levels, digest, _kind = read_single_column(
                require_mount(entry, slot_name), slot_name)
            columns[column] = values
            digests[slot_name] = digest
        # THE WITHIN-DATASET CROSS-CHECK, and the one thing `aligned_to` is genuinely good
        # for. Every entity column of one dataset is aligned to that dataset's entity axis,
        # so a column bound under the WRONG dataset index declares a different row space and
        # is caught here. It cannot be the GROUPING channel (two datasets against one
        # reference share a digest, and pre-2026-08-13 artifacts have none) — but as a check
        # over an already-declared grouping it costs nothing and degrades honestly.
        declared = {s: d for s, d in digests.items() if d is not None}
        # The one agreed value, or `None` when nothing declared one. This is what the
        # alignment records as the ENTITY axis's identity (D8) — the entity vector's anchor,
        # the counterpart of ITEM-9's row digest. `None` stays `None`: "cannot be checked"
        # is a real state and must never be filled in with a guess.
        entity_axis_digest = next(iter(set(declared.values())), None)
        if len(set(declared.values())) > 1:
            raise engine.AlignmentError(
                f"the columns bound for dataset index {index} ({dataset_id!r}) declare "
                f"different row spaces: {declared}. They are supposed to be one dataset's "
                "entity axis, so at least one of them is bound under the wrong dataset index"
            )

        row_keys = None
        if with_rows:
            slot_name = f"{ROWS_SLOT}[{index}]"
            root = require_mount(rows[index], slot_name)
            row_keys, _levels, _digest, _kind = read_single_column(root, slot_name)
            check_declared_key_digest(cyto_zarr_read.structure(root), row_keys, slot_name)

        row_columns, declared_levels = {}, {}
        for column, entry in sorted(levels.get(index, {}).items()):
            slot_name = f"{LEVEL_SLOT_PREFIX}{index}:{column}"
            values, stored_levels, _digest, kind = read_single_column(
                require_mount(entry, slot_name), slot_name)
            # R3C3 — REFUSE a non-categorical column rather than fabricating a level set.
            #
            # `read_column` resolves a categorical's codes through its DECLARED level set;
            # a string/numeric member has no such set, so the engine fell back to
            # OBSERVATION order and invented one. Two things went wrong at once and both
            # were silent: the emitted `code -> unified code` lookup was a vector over
            # values nobody declared as levels, and `source_declared_orders` — ITEM-14's
            # evidence record, whose entire purpose is preserving what each source DECLARED
            # — recorded first-appearance order as though it were a declaration.
            #
            # That is the precise thing ITEM-14/INV-15 forbid: record what was observed, do
            # not assert what was not. There is no honest fallback here, so it refuses.
            # Measured: only a genuine pandas categorical stamps `kind: categorical` +
            # `levels`; a plain string stamps `string`, and int/float/bool stamp `numeric`.
            if kind != "categorical":
                # The two non-categorical kinds fail for DIFFERENT reasons, and conflating
                # them sent a user chasing the wrong fix.
                #
                # `numeric` — fusing is meaningless; there is no vocabulary to unify.
                #
                # `string` — the refusal is a LIMITATION, not a judgement about the data.
                # A string column is self-describing (its values ARE its labels), so it
                # needs no code space and the R3C3 reasoning above does not apply to it.
                # It is refused because the READ side cannot serve it as a fused column:
                # measured, `gather_exec.rs:328,396` sets `is_split` from
                # `declared_dtype == "utf8"` and SKIPS the remap for such a column, while
                # `remapped_columns()` is derived from the emitted lookups — so a fused
                # string column would either be remapped as if it were codes, or (with no
                # lookup) never gathered at all and silently absent.
                #
                # This matters far beyond its severity: whether a user's `cell_type` fuses
                # is a coin flip on how their `.h5ad` happened to store it. The real fix is
                # upstream — object-dtype label columns should be stored as categoricals at
                # import — and the message says so, because that is the action that works.
                if kind == "string":
                    raise engine.AlignmentError(
                        f"the column bound at slot {slot_name!r} is stored as arrow STRINGS "
                        "(kind 'string'), not as a coded categorical. Its values are its "
                        "own labels, so there is no vocabulary to unify — but the read side "
                        "serves a fused column by remapping CODES, and a string column has "
                        "none, so it cannot be served as one. This is a limitation of the "
                        "fusion path, not a problem with your data. The fix is at IMPORT: "
                        "a label column should be stored as a categorical (pandas "
                        "`astype('category')`) rather than as object dtype"
                    )
                raise engine.AlignmentError(
                    f"the column bound at slot {slot_name!r} is stored as {kind!r}, not a "
                    "categorical, so it declares no level set. Fusing it would invent one "
                    "from the order its values happen to appear in, and record that "
                    "invention in `source_declared_orders` as if the source had declared "
                    "it. Bind a categorical column, or store this one as one"
                )
            row_columns[column] = values
            if stored_levels is not None:
                declared_levels[column] = stored_levels

        sources.append(engine.SourceTable(
            dataset_id, columns,
            row_keys=row_keys,
            row_columns=row_columns,
            declared_levels=declared_levels,
            entity_axis_digest=entity_axis_digest,
        ))
    return sources


def require_mount(entry, slot_name):
    """The staged path for a binding, or a refusal naming the SLOT.

    A binding whose mount is absent means a staging step failed. Refusing beats aligning over
    the survivors for the reason in `load_grid`: the entity axis is an intersection, so a
    dropped source makes the result LARGER while every count still agrees with itself.
    """
    path = Path(entry["path"])
    if not path.exists():
        raise engine.AlignmentError(
            f"the input bound at slot {slot_name!r} is not present under /inputs (mount "
            f"{path.name!r}). Refusing rather than aligning over the bindings that did stage"
        )
    return path


def check_declared_key_digest(structure, row_keys, slot_name):
    """Ask the REFERENT, not the citation: recompute the digest from the bytes just read.

    A row-axis index artifact declares `key_sequence_digest` over its ordered keys. This
    recomputes it from the values decoded out of the same store and refuses a disagreement —
    so a store whose declaration and contents have parted company is caught HERE, rather than
    becoming a positional row vector that returns the right NUMBER of the WRONG rows with
    every count agreeing (ITEM-9's whole failure mode).

    An artifact that declares no digest is NOT refused: absent is "cannot be checked", never
    "matches", and an ordinary obs column legitimately declares none.
    """
    declared = structure.get("key_sequence_digest")
    if not declared:
        return
    actual = cyto_zarr.key_sequence_digest([str(k) for k in row_keys])
    if str(declared) != actual:
        raise engine.AlignmentError(
            f"the artifact bound at slot {slot_name!r} declares key_sequence_digest "
            f"{str(declared)[:12]}… but its stored keys digest to {actual[:12]}… — the "
            "declaration and the bytes have parted company, so a positional row vector over "
            "them would address the wrong rows"
        )


def validated_dataset_ids(params, slots):
    """The relayed dataset ids, or a refusal. The grid's dataset dimension."""
    dataset_ids = [str(d) for d in (params.get("dataset_ids") or [])]
    if not dataset_ids:
        raise engine.AlignmentError(
            "params.dataset_ids is empty — it is the grid's dataset dimension, and every "
            f"binding names its dataset by INDEX into it. `/inputs/inputs.json` declares "
            f"slot(s) {sorted(slots) or '[]'}; without the relay no binding can be "
            "attributed to a dataset, and a virtual dataset's link to its sources is the "
            "only thing a detach-refusal can resolve"
        )
    if any(not d.strip() for d in dataset_ids):
        raise engine.AlignmentError(
            f"params.dataset_ids contains an empty id ({dataset_ids}) — every source must "
            "carry a real dataset identity"
        )
    if len(set(dataset_ids)) != len(dataset_ids):
        raise engine.AlignmentError(
            f"params.dataset_ids repeats an id ({dataset_ids}) — two indices claiming one "
            "dataset would make the segment table address one dataset under two indices"
        )
    return dataset_ids


def cross_check_relay(params, dataset_ids, rows):
    """Refuse a MIS-ORDERED id relay, by name. **MANDATORY on the producer path.**

    Keyed BY DATASET ID against the `rows` binding's wire `content_hash`, so the comparison
    is between the artifact the wire actually staged at position `i` and the artifact the
    params say `dataset_ids[i]` is. Two PARALLEL relayed lists could not do this: both sides
    would be relayed, so a mis-ordered relay would still agree with itself.

    ## Why it is REQUIRED here and was merely optional before

    `rows` is the ONE dimension this compute reads positionally, so its binding order is the
    only unverified channel left in the input shape. An optional check over the sole
    unverified channel is not a check — it is a check a caller can omit precisely when it
    would have fired. Making it mandatory converts the last positional assumption into a
    verified one, which is what earns `rows` the right to stay a literal ordered slot while
    the ragged dimensions carry their coordinates in the slot name.

    A per-dataset hash that is absent from the map is still refused, for the same reason: a
    partially-supplied map would leave exactly the unchecked positions a mis-ordering needs.
    """
    hashes = params.get("dataset_content_hashes")
    if not isinstance(hashes, dict) or not hashes:
        raise engine.AlignmentError(
            "params.dataset_content_hashes is required and must be a MAP of dataset id -> "
            f"the content hash of that dataset's {ROWS_SLOT!r} binding. The row axis is the "
            "one input this compute reads by BINDING ORDER, so this map is what ties that "
            "order to a dataset identity; without it a mis-ordered relay would attribute one "
            "dataset's rows to another with every count still agreeing. (A positional LIST "
            "cannot do this job: both sides would be relayed, so a mis-ordered relay would "
            "still agree with itself.)"
        )
    for index, dataset_id in enumerate(dataset_ids):
        actual = rows[index].get("content_hash")
        expected = hashes.get(dataset_id)
        if expected is None:
            raise engine.AlignmentError(
                f"params.dataset_content_hashes has no entry for {dataset_id!r} "
                f"(it has {sorted(hashes)}). Every relayed dataset needs one — a partial map "
                "leaves exactly the unchecked positions a mis-ordering needs"
            )
        if actual is None:
            raise engine.AlignmentError(
                f"the {ROWS_SLOT!r} binding at position {index} carries no content_hash on "
                "the wire, so the relay cannot be checked at that position. Refusing rather "
                "than treating an uncheckable position as a matching one"
            )
        if str(actual) != str(expected):
            raise engine.AlignmentError(
                f"dataset index {index} is {dataset_id!r} according to params.dataset_ids, "
                f"but the row axis staged at {ROWS_SLOT!r}[{index}] has content_hash "
                f"{actual!r} while {dataset_id!r} is {expected!r}. The ids are relayed and "
                "the row bindings are aligned by ORDER, so this means the relay is "
                "mis-ordered — refusing rather than attributing one dataset's rows to another"
            )


# ─────────────────────────────── writing the alignment ─────────────────────────

def write_alignment(out_dir, sources, vectors, metadata):
    """Emit the alignment artifact. Returns `(relative path, structure)`.

    The entity keys are the table's OWN key member, so the artifact declares its identity the
    way every other key artifact does (`key` + `key_sequence_digest`, both recomputed from
    the stored bytes by the framework gate). The three vectors ride `aux`, whose extents are
    what bound them — see `cyto_zarr.Table.aux`.
    """
    root = out_dir / "alignment.zarr"
    n_entities = len(vectors["entities"])
    n_sources = len(sources)
    # ── DO NOT re-sort this into declared order. ─────────────────────────────────
    #
    # The engine deliberately serialises the segment array in a NON-semantic order (sorted
    # by dataset id), so that `start_row` is non-monotonic across the array and a consumer
    # that iterates instead of sorting on `declared_order` is visibly wrong rather than
    # accidentally right (INV-6). Sorting here would normalise that away and hand every
    # reader an array that happens to be in the right order — which is exactly the state in
    # which stage 2's TEST-6 becomes a tautology and the omission surfaces only when
    # something unrelated reorders the array.
    #
    # This line WAS `sorted(..., key=declared_order)`, and the negative control that caught
    # it is the one that "passed": emitting array order changed nothing, because the fixture
    # happened to declare its sources in alphabetical order too.
    #
    # The four segment members below all iterate THIS list, so they stay positionally
    # consistent with each other — they are one table split across four arrays.
    segments = list(vectors["segments"])

    # ── THE UNIFIED VOCABULARY, emitted with the BYTES ───────────────────────────
    #
    # `resolve_levels` computes the unified level list that every `alignment_level_lookup`
    # code indexes into — and it was being thrown away. Nothing in the artifact, its row
    # `meta` or the sidecar said what unified code 3 MEANS, so the lookups were
    # uninterpretable: the only reconstruction path was a reader re-implementing the
    # union/authority rule, which is the second copy this engine exists to avoid.
    #
    # It is a USER-VISIBLE defect, not a producer-internal gap. The browser reads a
    # categorical's labels from `attributes.cyto.levels`; with no vocabulary to serve, a
    # fused cell-type column renders `0, 1, 2` instead of `B, T, NK`.
    #
    # It rides the GROUP ATTRIBUTES rather than `structure`, and that placement is the
    # point: `Table.close()` stamps `attributes` into the store's own `zarr.json` beside
    # `cyto`, while `structure` also rides the manifest entry into the artifact row — which
    # is capped by `MAX_MANIFEST_BYTES`. A full vocabulary on the row is the 450 KB member
    # entry that cap already forced into a digest once. So the labels live where a
    # categorical member's own levels live: in the store, with the bytes, uncapped and
    # therefore RECOVERABLE AT ANY CARDINALITY. A digest is not a vocabulary, and a column
    # is unlabelable exactly where labels matter most if the high-cardinality path drops it.
    unified_levels = {
        column: list(lookup["levels"])
        for column, lookup in sorted(vectors["level_lookups"].items())
    }
    # THE DECLARED ABSENCE LABEL PER COLUMN (C4), `None` where nothing was dropped.
    #
    # Emitted beside the vocabulary and not derivable from it: a consumer must not have to
    # guess which entry is the invented one. Two consumers need it — a renderer that wants
    # to style absence differently from a real category, and any vocabulary comparison,
    # which must EXCLUDE it or two identical vocabularies disagree whenever one run happened
    # to drop something. That is the M7 lesson (`missing_level=` feeding `vocab_digest`)
    # applied one layer up, to the UNIFIED vocabulary.
    missing_levels = {
        column: lookup.get("missing_level")
        for column, lookup in sorted(vectors["level_lookups"].items())
    }
    with cyto_zarr.Table(
        root, axis=ALIGNMENT_AXIS, n=n_entities, key="unified_key",
        attributes={"cyto_alignment": {"unified_levels": unified_levels,
                                       "missing_levels": missing_levels}},
    ) as table:
        table.string("unified_key", [str(e) for e in vectors["entities"]])

        # The resolved annotation per unified entity, one member per secondary identifier.
        # Ordinary columns on the table's OWN axis (length n), not aux — they are one value
        # per entity, which is exactly what `n` means here.
        #
        # This is where `authority` becomes OBSERVABLE. Without it the mode's defining
        # claim — whose annotation identifies the unified entity — reached no artifact, so
        # selecting the wrong source's annotation was undetectable downstream.
        for column, values in sorted(vectors.get("entity_labels", {}).items()):
            table.string(
                f"unified_{column}",
                ["" if v is None else str(v) for v in values],
                meta={"resolved_from": metadata["mode"], "authority": metadata["authority"]},
            )

        table.aux(
            "segment_dataset",
            np.asarray([s["declared_order"] for s in segments], dtype=np.int32),
            dtype="int32", role="alignment_segment_dataset", extent=["segments"],
        )
        table.aux(
            "segment_start",
            np.asarray([s["start_row"] for s in segments], dtype=np.int64),
            dtype="int64", role="alignment_segment_start", extent=["segments"],
        )
        table.aux(
            "segment_end",
            np.asarray([s["end_row"] for s in segments], dtype=np.int64),
            dtype="int64", role="alignment_segment_end", extent=["segments"],
        )
        # Emitted in the SAME array order as the three siblings above — which is the
        # engine's order (by dataset id), NOT declared order. All four iterate one list, so
        # they agree row-for-row; `declared_order` is the FIELD a reader sorts on, and it is
        # deliberately not the array's own order (see the block above).
        table.aux(
            "segment_order",
            np.asarray([s["declared_order"] for s in segments], dtype=np.int32),
            dtype="int32", role="alignment_segment_order", extent=["segments"],
        )
        table.aux(
            "entity_index",
            np.asarray(vectors["entity_index"], dtype=np.int64).reshape(n_entities, n_sources),
            dtype="int64", role="alignment_entity_index",
            extent=[ALIGNMENT_AXIS, "sources"],
        )
        table.aux(
            "entity_secondaries_agreed",
            np.asarray(
                [1 if e["secondaries_agreed"] else 0 for e in metadata["entity_evidence"]],
                dtype=np.int8,
            ),
            dtype="int8", role="alignment_entity_evidence", extent=[ALIGNMENT_AXIS],
        )

        for column, lookup in sorted(vectors["level_lookups"].items()):
            for source_index, source in enumerate(sources):
                # THE ENGINE SERIALISES IT — this script decides nothing (INV-4).
                #
                # This was an inline comprehension with its own `-1`, so the module whose
                # header says it "implements no predicate of its own" owned the ITEM-5
                # absence encoding while the engine defined the in-memory one. Two
                # spellings of one fact, in two files, with nothing comparing them — and
                # the engine's own `apply_level_lookup` had NO production caller, so the
                # tested spelling was not the stored one (D6).
                ordered = engine.stored_lookup_codes(
                    lookup["lookups"][source_index],
                    lookup["source_levels"][source_index],
                )
                table.aux(
                    f"levels__{column}__{source_index}",
                    np.asarray(ordered, dtype=np.int32),
                    dtype="int32", role="alignment_level_lookup",
                    # Member-NAMED extent: each source's level set has its own length, so a
                    # shared name would be a length rule two members could not both satisfy.
                    extent=[f"levels_{column}_{source_index}"],
                )
        structure = table.close()
    return "alignment.zarr", structure


#: How many disagreeing entities the artifact row NAMES before it stops naming them and
#: reports a count instead. The per-entity answer is already a VECTOR in the artifact
#: (`entity_secondaries_agreed`), so this list is a convenience for the common small case,
#: not the record — truncating it loses nothing that is not on disk.
MAX_NAMED_DISAGREEING = 50

#: Above this many levels a source's declared order is recorded as a DIGEST + count rather
#: than verbatim. Mirrors what the categorical member row already does: it declares its
#: level set by `levels_digest` + `n_levels` after one inline list made a member entry
#: 450 KB and blew `MAX_MANIFEST_BYTES`.
MAX_INLINE_LEVELS = 64


def _order_evidence(levels):
    """One source's declared order, bounded.

    Verbatim while it is small enough to read, and a digest + count above that. The digest
    is `key_sequence_digest`, which is ORDER-SENSITIVE — so it still distinguishes two
    sources that declared the same levels in different orders, which is the entire fact
    ITEM-14 exists to preserve. A set hash here would record that they agree.
    """
    levels = [str(v) for v in levels]
    if len(levels) <= MAX_INLINE_LEVELS:
        return levels
    return {
        "n_levels": len(levels),
        "order_digest": cyto_zarr.key_sequence_digest(levels),
        "truncated": True,
    }


def alignment_meta(vectors, metadata):
    """The artifact row's `meta` — BOUNDED, because a manifest entry is not a data channel.

    `outputs.rs`'s `MAX_MANIFEST_BYTES` is 1 MiB and exceeding it is a HARD run failure, so
    an unbounded field here means a legitimate run does all its work, writes the artifact,
    and then dies at manifest emit. Two fields in an earlier draft of this function were
    exactly that, and neither was obvious:

    * `entities_with_disagreeing_secondaries` — empty under `strict` (conflicts are
      dropped), but under `authority` conflicting entities are KEPT, so every one of them
      landed here. `join_quality`'s own worked example is 1,204 conflicting of 18,204, so it
      scales with the entity axis rather than being "few by construction" as the docstring
      claimed. Now capped at `MAX_NAMED_DISAGREEING` with a total alongside; the complete
      per-entity answer is the `entity_secondaries_agreed` VECTOR in the artifact.
    * `source_declared_orders` — full verbatim level vocabularies, which is the inline level
      list the cited 450 KB precedent replaced with a digest. Now bounded by
      `_order_evidence`.
    """
    disagreeing = [
        {"entity": e["entity"], "disagreeing_columns": e["disagreeing_columns"]}
        for e in metadata["entity_evidence"]
        if not e["secondaries_agreed"]
    ]
    return {
        "mode": metadata["mode"],
        "authority": metadata["authority"],
        "join_key": metadata["join_key"],
        "normalize": metadata["normalize"],
        "join_quality": metadata["join_quality"],
        "sources": metadata["sources"],
        "source_declared_orders": {
            column: {dataset_id: _order_evidence(levels) for dataset_id, levels in per.items()}
            for column, per in metadata["source_declared_orders"].items()
        },
        "n_entities": len(vectors["entities"]),
        "n_rows": vectors["n_rows"],
        "n_entities_dropped": len(vectors.get("dropped_entities", ())),
        "n_entities_with_disagreeing_secondaries": len(disagreeing),
        "entities_with_disagreeing_secondaries": disagreeing[:MAX_NAMED_DISAGREEING],
        "entities_with_disagreeing_secondaries_truncated":
            len(disagreeing) > MAX_NAMED_DISAGREEING,
    }


def output_entry(id, datatype, layout, path, role, *, structure, meta=None, hidden=False,
                 label=None, axis=None):
    entry = {"id": id, "datatype": datatype, "path": path, "layout": layout, "role": role,
             "structure": structure, "meta": meta}
    if label is not None:
        entry["label"] = label
    if axis is not None:
        entry["axis"] = axis
    if hidden:
        entry["hidden"] = True
    return entry


#: The `(datatype, layout)` this package emits its run-environment record as (#80).
#: Declared here because the package knows its own output type; the shared recorder
#: in `_lib` is app-core and may not name a contributed domain's vocabulary.
DT_RUN_ENVIRONMENT = ("report/qc", "opaque")


def main():
    inputs_dir, out_dir = io_dirs()
    params = read_json(inputs_dir / "params.json", {})

    key = params.get("key")
    if not key:
        raise engine.AlignmentError(
            "params.json declares no `key` — the join key is the user's claim about which "
            "identifier means the same thing in both datasets, and it is not inferable "
            "(INV-1: the claim is made when the analysis is run, never guessed later)"
        )
    normalize = list(params.get("normalize") or [])
    mode = params.get("mode")
    authority = params.get("authority")

    sources = load_grid(inputs_dir, params, with_rows=True, with_levels=True)

    # THE FUSED COLUMNS ARE THE BOUND `level:` SLOTS — derived, never relayed.
    #
    # This was `params.level_columns`, and the params key is gone: a second channel naming
    # what the bindings already carry is exactly the thing that falls out of step with the
    # mounts. A column named in params but not bound was silently skipped (the old loader's
    # `if c in row_columns` filter), and a column bound but not named was silently ignored —
    # two ways to produce a fusion the user did not ask for, neither of them visible.
    #
    # THE UNION OF BOUND COLUMNS — and read the next paragraph before changing it.
    #
    # **This line's previous comment claimed "the engine's `strict` union handles" a column
    # carried by only one source. IT DOES NOT** — `build_vectors` RAISES when a level column
    # is missing from any source (`alignment.py:886-895`). I wrote that claim during the slot
    # rework and never verified it; it is the third docstring-contradicting-code instance on
    # this surface and the first that is mine from this round (H4).
    #
    # The union is still the right SET to hand the engine, because the alternative —
    # intersecting here — would silently drop a column the user explicitly bound, which is
    # the failure the params->slots move exists to remove. So the union stays and the ENGINE
    # decides; what changed is that the comment no longer claims to know how it decides.
    #
    # WHAT THE ENGINE ACTUALLY DOES TODAY: refuses, naming the source that lacks the column.
    # That is LOUD and safe, but it disagrees with the form, which offers any column carried
    # by >=2 of the chosen datasets — so with >=3 datasets the form reports `ready` and the
    # job dies in the sandbox. **The form must never be more permissive than the compute.**
    # Until the C4/H4 mechanism lands (a declared missing level — see the engine's
    # `resolve_levels`), the UI threshold must be "carried by ALL selected datasets".
    level_columns = sorted({c for s in sources for c in s.row_columns})

    # ── the engine does every decision; this script does none of them ────────────
    report = engine.join_quality(sources, keys=[key], normalize=normalize)
    vectors = engine.build_vectors(
        sources, key, mode=mode, authority=authority, normalize=normalize,
        level_columns=level_columns,
    )
    metadata = engine.alignment_metadata(
        sources, key, vectors, join_quality_report=report,
        source_orders={
            column: {
                s.dataset_id: lookup["source_levels"][i]
                for i, s in enumerate(sources)
            }
            for column, lookup in vectors["level_lookups"].items()
        },
        normalize=normalize,
    )
    sidecar = engine.coverage_sidecar(sources, vectors, metadata)

    rel, structure = write_alignment(out_dir, sources, vectors, metadata)
    summary_rel = "alignment_summary.json"
    (out_dir / summary_rel).write_text(json.dumps(sidecar, indent=2, default=str))

    entries = [
        output_entry(
            "dataset-alignment", "dataset-alignment", "chunked-dense", rel, "artifact",
            structure=structure, meta=alignment_meta(vectors, metadata),
            hidden=True, axis=ALIGNMENT_AXIS,
            label=f"Alignment ({metadata['join_key']}, {metadata['mode']})",
        ),
        output_entry(
            "alignment-summary", "data/opaque", "opaque", summary_rel, "intermediate",
            structure=cyto_columns.opaque("application/json"),
            meta=None, hidden=True,
        ),
    ]
    # #80 — append this run's ENVIRONMENT RECORD (the resolved version of every library
    # this entry declares) before the manifest is written, and refuse the run if the
    # environment does not satisfy the declaration. On the one path every successful run
    # takes, so recording is structural rather than remembered.
    # The datatype is THIS package's, passed in: `cyto_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    cyto_deps.augment(out_dir, entries, DT_RUN_ENVIRONMENT)
    (out_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
