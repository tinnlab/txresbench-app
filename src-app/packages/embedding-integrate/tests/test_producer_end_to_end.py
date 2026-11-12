#!/usr/bin/env python3
# ruff: noqa
"""TEST-26 (the leg that was owed) — the REAL PRODUCER writes a REAL alignment.

## Why this file exists, and why the existing coverage did not discharge it

`_lib/test_conformance_alignment.py` proves the WRITER works: a fixture calls
`txr_zarr.Table.aux`, the real conformance gate conforms the result, and both refusal
directions fire. That is necessary and it is not sufficient, and the distinction is the one
this feature has already paid for once: **a fixture proves the writer works; only a real run
proves the PRODUCER calls it correctly.** The prior round's defect survived precisely because
each side's unit fixture agreed with itself.

So this suite runs `compute/embedding_integrate.py` **as a subprocess**, exactly as the
sandbox runner invokes it — `TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR`, `/inputs/inputs.json`,
`/inputs/params.json` in, `/outputs/manifest.json` out — over source artifacts written by
the real `txr_zarr.Table`. Nothing here imports the producer's functions and calls them
directly: that would be a third fixture agreeing with itself.

The emitted alignment is then conformed by the REAL framework gate, and every vector is
resolved off disk and checked against what the engine says it should be.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import conformance
import txr_columns
import txr_zarr as cz
import txr_zarr_read

HERE = Path(__file__).resolve().parent
PRODUCER = HERE.parent / "compute" / "embedding_integrate.py"
PACKAGES = HERE.parents[1]


# ── staging a run, the way the sandbox runner stages one ─────────────────────────


def sanitize_path_component(raw):
    """A verbatim port of `spec.rs::sanitize_path_component`.

    Ported rather than approximated because this is what makes the fixture's mount names
    the RUNNER's mount names. The previous fixture named each mount after its dataset, and
    that single coincidence let the producer read the wrong channel for four audit rounds
    with everything green.
    """
    out = "".join(c if (c.isascii() and (c.isalnum() or c in "._-")) else "_"
                  for c in raw.strip())
    out = out.lstrip(".")[:100]
    return "input" if not out or set(out) == {"."} else out


def derive_mount_name(slot):
    """`spec.rs::derive_artifact_mount_name` for a `zarr_v3` artifact."""
    return f"{sanitize_path_component(slot)}.zarr"


def unique_mount_name(name, used):
    """A verbatim port of `inputs.rs::unique_mount_name` (split on the FIRST dot)."""
    candidate = name
    if candidate in used:
        stem, dot, ext = candidate.partition(".")
        ext = f".{ext}" if dot else ""
        n = 1
        while f"{stem}_{n}{ext}" in used:
            n += 1
        candidate = f"{stem}_{n}{ext}"
    used.add(candidate)
    return candidate


def write_column_artifact(dest, name, series, *, axis, holds_axis_keys=False, aligned_to=None):
    """ONE `metadata-column` artifact, through the REAL ingest writer.

    `txr_columns.write_metadata_column` — not a hand-rolled `cz.Table` — because the shape
    this fixture has to be faithful to is the one INGEST emits, and that is the function
    that emits it. Measured against the live catalog: a real `metadata-column` store has one
    member, always called `values`, and carries the column's display name NOWHERE. A fixture
    that wrote a member called `symbol` would be testing a store the server never produces,
    which is the exact defect the `entities.zarr`/`rows.zarr` shape was.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    structure, _meta = txr_columns.write_metadata_column(
        dest.parent, dest.name, name, pd.Series(series), axis=axis,
        holds_axis_keys=holds_axis_keys, aligned_to=aligned_to)
    return structure


# A CATEGORICAL's levels must be stored SORTED, not in first-appearance order, and that
# property is load-bearing rather than incidental.
#
# `declared_levels` exists because stored codes index the DECLARED order while observation
# gives first-appearance order. A fixture declaring `dict.fromkeys(celltypes)` made the two
# coincide, so the entire mechanism was observationally identical to having none: removing
# `declared_levels=` from the producer left the suite green.
#
# It now comes from `pd.Series(..., dtype="category")`, whose categories pandas sorts — so
# the property is the REAL writer's rather than a fixture's contrivance. It is also no
# longer merely assumed: `test_the_fixture_stores_levels_OUT_OF_observation_order` asserts
# the fixture exhibits it, separately from any assertion about the producer handling it.


def mount_for(inputs, slot, occurrence=0):
    """The staged directory bound at `slot`, READ OUT OF `inputs.json`.

    Never a reconstructed name. A test that spells `datasets_1.zarr` by hand is asserting
    against its own guess at the runner's derivation, and it goes silently stale the moment
    the derivation or the slot set changes — which is precisely what happened to every such
    site in this file when the shape moved to one artifact per column. `inputs.json` is the
    RECORD of where the run's inputs were bound, so ask it.
    """
    index = json.loads((inputs / "inputs.json").read_text())
    bound = [e for e in index["inputs"] if e["slot"] == slot]
    assert bound, f"no binding at slot {slot!r}; slots are {sorted({e['slot'] for e in index['inputs']})}"
    return inputs / Path(bound[occurrence]["sandbox_path"]).name


def stage_run(tmp_path, *, params, sources, slot_for=None, hashes_for=None):
    """`(inputs_dir, outputs_dir)` wired the way `sandbox/inputs.rs` ACTUALLY wires them.

    Three things this gets right, each of which was a defect the previous fixture hid:

    1. **The real wire.** `{slot, kind, content_hash, sandbox_path}` (`InputsJsonEntry`,
       `inputs.rs:63-69`). There is no `dataset_id` field.
    2. **Mount names the RUNNER would derive.** `derive_mount_name` + `unique_mount_name`
       are ported verbatim from `spec.rs`/`inputs.rs`, so a mount is a sanitized SLOT plus
       an ordinal and is deliberately unrelated to the dataset id. The old fixture named
       each mount after its dataset, which made `dataset_id == basename(sandbox_path)` and
       left a consumer reading the mount name INDISTINGUISHABLE from one reading the
       relayed id — the coincidence that let the producer read the wrong channel for four
       audit rounds with everything green.
    3. **ONE ARTIFACT PER COLUMN.** The old fixture staged each mount as a directory
       holding `entities.zarr` + `rows.zarr`, a shape no real artifact can present: ingest
       emits one `metadata-column` per column, and the runner stages one artifact per mount
       (`unique_mount_name` exists to keep them distinct). Every assertion built on it was
       green against a fixture the server cannot produce.

    The grid's coordinates ride the SLOT NAMES (`entity:<i>:<col>`, `level:<i>:<col>`);
    `rows` is one ordinary slot with one binding per dataset, in order. Identity arrives
    through `params.dataset_ids`, cross-checked by `params.dataset_content_hashes` against
    the `rows` bindings.

    `slot_for` / `hashes_for` are the hooks the NEGATIVE CONTROLS use to stage a
    deliberately-wrong arrangement without a second staging function that could drift from
    this one.
    """
    inputs = tmp_path / "inputs"
    outputs = tmp_path / "outputs"
    inputs.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)

    index = {"inputs": []}
    used = set()
    dataset_ids, hashes = [], {}

    def bind(slot, writer, content_hash):
        """Stage ONE artifact at `slot`, exactly as the runner would."""
        mount = unique_mount_name(derive_mount_name(slot), used)
        writer(inputs / mount)
        index["inputs"].append({
            "slot": slot,
            "kind": "artifact",
            "content_hash": content_hash,
            "sandbox_path": f"/inputs/{mount}",
        })

    for position, (dataset_id, spec) in enumerate(sources):
        dataset_ids.append(dataset_id)
        entity_keys = spec["entity_keys"]
        row_keys = spec["row_keys"]
        # The two axes' digests, taken the way ingest takes them, so the entity columns can
        # declare `aligned_to` and the row index can declare `key_sequence_digest`.
        entity_digest = txr_columns.axis_key_digest(pd.Series(entity_keys))
        slot = (slot_for or (lambda kind, i, col: None))

        # ── the ENTITY grid: `entity:<i>:<column>` ────────────────────────────────
        #
        # `symbol` CARRIES the entity axis's keys, so it declares them; `ensembl_id` is an
        # ordinary column aligned to them. That asymmetry is deliberate and real — it is
        # exactly what ingest emits for an axis index vs a var column — and it is what
        # exercises BOTH branches of `declared_axis_digest`.
        bind(slot("entity", position, "symbol") or f"entity:{position}:symbol",
             lambda d, k=entity_keys: write_column_artifact(
                 d, "symbol", k, axis="entities", holds_axis_keys=True),
             f"sha256:{dataset_id}-symbol")
        # `None` means the source does not CARRY this column — which is how a fixture makes
        # `symbol` the only shared candidate, and therefore how `candidates` becomes shorter
        # than `sources`.
        if spec["ensembl"] is not None:
            bind(slot("entity", position, "ensembl_id") or f"entity:{position}:ensembl_id",
                 lambda d, e=spec["ensembl"], a=entity_digest: write_column_artifact(
                     d, "ensembl_id", e, axis="entities", aligned_to=a),
                 f"sha256:{dataset_id}-ensembl")

        # ── the ROW axis: the literal `rows` slot, one binding per dataset, IN ORDER ──
        rows_hash = f"sha256:{dataset_id}-rows"
        bind("rows",
             lambda d, r=row_keys: write_column_artifact(
                 d, "barcode", r, axis="rows", holds_axis_keys=True),
             rows_hash)
        hashes[dataset_id] = rows_hash

        # ── the LEVEL grid: `level:<i>:<column>` ─────────────────────────────────
        if spec.get("celltypes") is not None:
            row_digest = txr_columns.axis_key_digest(pd.Series(row_keys))
            bind(slot("level", position, "celltype") or f"level:{position}:celltype",
                 lambda d, c=spec["celltypes"], a=row_digest: write_column_artifact(
                     d, "celltype", pd.Series(c, dtype="category"), axis="rows",
                     aligned_to=a),
                 f"sha256:{dataset_id}-celltype")

    (inputs / "inputs.json").write_text(json.dumps(index, indent=2))
    payload = {"dataset_ids": dataset_ids,
               "dataset_content_hashes": hashes if hashes_for is None else hashes_for(hashes),
               **params}
    (inputs / "params.json").write_text(json.dumps(payload, indent=2))
    return inputs, outputs


def _globally_staged_modules():
    source = (
        PACKAGES.parent / "server" / "src" / "modules" / "sandbox" / "processors" / "mod.rs"
    ).read_text()
    table = source.split("pub const PY_HELPER_FILES", 1)[1].split("];", 1)[0]
    found = re.findall(
        r'\(\s*"([A-Za-z0-9_]+\.py)"\s*,\s*([A-Z_]+)\s*,\s*"([^"]+)"\s*,?\s*\)',
        table,
    )
    assert len(found) >= 7, (
        f"only {len(found)} staged helper(s) parsed out of PY_HELPER_FILES — the table has "
        "more than that, so this parse is short and the staged /code is incomplete"
    )
    return found


_RESERVED_DIRS = {"RESERVED_HELPER_PACKAGE": "_helpers", "RESERVED_LIB_PACKAGE": "_lib"}


def stage_code_dir(tmp_path, entry, *, helpers=()):
    """Assemble `/code` THE WAY THE RUNNER DOES — a flat directory of named files.

    Replaces putting package roots on `PYTHONPATH`, which made every module importable
    (including `conformance.py`, which DEC-8 forbids inside a processor) and could not turn
    red on a real staging failure.
    """
    code = tmp_path / "code"
    code.mkdir(parents=True, exist_ok=True)
    shutil.copy(entry, code / entry.name)
    for staged_name, package_const, rel in _globally_staged_modules():
        shutil.copy(PACKAGES / _RESERVED_DIRS[package_const] / rel, code / staged_name)
    for rel in helpers:
        shutil.copy(entry.parent.parent / rel, code / Path(rel).name)
    return code


def run_producer(inputs, outputs, *, expect_ok=True):
    """Invoke the producer AS A SUBPROCESS, from a faithfully staged `/code`.

    `PYTHONPATH` is CLEARED: the process resolves imports exactly as it will in the sandbox,
    from the staged directory alone.
    """
    code = stage_code_dir(Path(inputs).parent, PRODUCER)
    env = dict(os.environ)
    env["TXR_INPUTS_DIR"] = str(inputs)
    env["TXR_OUTPUTS_DIR"] = str(outputs)
    env["PYTHONPATH"] = ""
    proc = subprocess.run(
        [sys.executable, str(code / PRODUCER.name)], cwd=str(code),
        env=env, capture_output=True, text=True,
    )
    if expect_ok:
        assert proc.returncode == 0, (
            f"the producer failed (exit {proc.returncode}).\nSTDOUT:\n{proc.stdout}\n"
            f"STDERR:\n{proc.stderr}"
        )
    return proc


TWO_SOURCES = [
    ("ds-a", {
        "entity_keys": ["A", "B", "C", "A_ONLY"],
        "ensembl": ["E1", "E2", "E3", "E9"],
        "row_keys": ["a-0", "a-1", "a-2"],
        "celltypes": ["T", "B", "T"],
    }),
    ("ds-b", {
        "entity_keys": ["B_ONLY", "C", "B", "A"],
        "ensembl": ["E8", "E3", "E2", "E1"],
        "row_keys": ["b-0", "b-1"],
        "celltypes": ["B", "NK"],
    }),
]


@pytest.fixture
def produced(tmp_path):
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol"},
        sources=TWO_SOURCES,
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    return outputs, manifest


def entry_for(manifest, datatype):
    return next(e for e in manifest["outputs"] if e["datatype"] == datatype)


# ── the end-to-end proof ─────────────────────────────────────────────────────────


def test_a_real_run_emits_an_alignment_the_real_gate_CONFORMS(produced):
    """The leg that was owed. Real producer -> real bytes -> real framework gate."""
    outputs, manifest = produced
    entry = entry_for(manifest, "dataset-alignment")
    root = outputs / entry["path"]
    assert root.is_dir(), entry

    violations = conformance.conform_artifact(
        root, txr_zarr_read.structure(root), full=True, meta=entry.get("meta")
    )
    assert violations == [], (
        "the producer emitted an artifact its own framework gate refuses — which is exactly "
        f"the defect ITEM-12 exists to prevent, now reached through a real run: {violations}"
    )


def test_the_declared_structure_matches_what_the_gate_reads_off_disk(produced):
    """The manifest's `structure` and the store's stamp are two copies of one declaration;
    a producer that computed them separately is how they drift."""
    outputs, manifest = produced
    entry = entry_for(manifest, "dataset-alignment")
    root = outputs / entry["path"]
    assert entry["structure"] == txr_zarr_read.structure(root)


def test_every_aux_vector_RESOLVES_off_disk_with_the_declared_extent(produced):
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    structure = txr_zarr_read.structure(root)
    extents = structure["extents"]
    # No `alignment_rows` extent since D18 — the per-output-row vectors are gone and the row
    # count (3 from ds-a + 2 from ds-b) is reconstructed from the segment ranges, not stored.
    assert "alignment_rows" not in extents, extents
    assert extents["segments"] == 2, extents
    assert extents["sources"] == 2, extents
    assert extents["unified_entities"] == 3, extents  # A, B, C — the INTERSECTION

    for member in structure["aux"]:
        values = txr_zarr_read.read_array(root, member["path"])
        for axis_i, extent_name in enumerate(member["extent"]):
            assert values.shape[axis_i] == extents[extent_name], (member, values.shape)


def test_the_entity_axis_is_the_INTERSECTION_in_a_REAL_run(produced):
    """INV-2, reached through the producer rather than through the engine's own test."""
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    keys = txr_zarr_read.read_strings(root, "unified_key")
    assert keys == ["A", "B", "C"], keys
    assert "A_ONLY" not in keys and "B_ONLY" not in keys


def test_the_entity_index_addresses_the_RIGHT_entity_in_each_SOURCE_STORE(produced, tmp_path):
    """Resolved all the way back through the source artifacts on disk — so a vector of
    plausible-but-wrong indices cannot pass."""
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    keys = txr_zarr_read.read_strings(root, "unified_key")
    index = txr_zarr_read.read_array(root, "entity_index")

    source_symbols = [
        txr_zarr_read.read_strings(mount_for(tmp_path / "inputs", f"entity:{i}:symbol"),
                                    "values")
        for i, _ in enumerate(TWO_SOURCES)
    ]
    for row, entity in enumerate(keys):
        for src, symbols in enumerate(source_symbols):
            assert symbols[int(index[row][src])] == entity, (entity, src, index[row][src])


def test_the_segments_tile_the_output_in_DECLARED_order(produced):
    """Since D18 there is NO per-output-row vector — the segment table alone tiles the
    output, and each row reconstructs to its `(source, row-within-source)` by a range
    search (segment containing `i`; row = `i - start`)."""
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    order = txr_zarr_read.read_array(root, "segment_order")
    start = txr_zarr_read.read_array(root, "segment_start")
    end = txr_zarr_read.read_array(root, "segment_end")
    dataset = txr_zarr_read.read_array(root, "segment_dataset")

    by_declared = sorted(range(len(order)), key=lambda i: int(order[i]))
    cursor = 0
    for i in by_declared:
        assert int(start[i]) == cursor, (i, start[i], cursor)
        cursor = int(end[i])
    assert cursor == 5  # total output rows: ds-a's 3 + ds-b's 2

    # ds-a is declared first, so output rows 0..2 are its three rows, in its own order.
    # Reconstructed from the segment table: the declared-first segment starts at row 0 and
    # names source 0, so output row i (0..2) is (source 0, row i - 0).
    first = by_declared[0]
    assert int(dataset[first]) == 0
    assert int(start[first]) == 0 and int(end[first]) == 3
    for i in range(3):
        assert int(start[first]) <= i < int(end[first])   # row i falls in the first segment
        assert i - int(start[first]) == i                 # row-within-source == i


def test_a_REVERSED_declaration_reverses_the_row_layout_through_a_REAL_run(tmp_path):
    """INV-6 end-to-end — and this test exists because its absence was MEASURED.

    A negative control that made the producer emit segments in ARRAY order instead of
    sorting on `declared_order` **passed the whole suite**. The reason is the trap the
    array-sort was designed to expose, sprung on my own fixture: `ds-a` is declared first
    AND sorts first alphabetically, so the two orders coincided and every assertion was
    accidentally right.

    So this run declares the sources in the order that makes them DISAGREE. `ds-b` is
    declared first and `ds-a` sorts first, so a producer that iterated the serialised array
    would lay ds-a's rows out first and be caught here.
    """
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol"},
        sources=list(reversed(TWO_SOURCES)),   # ds-b declared FIRST
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]

    order = txr_zarr_read.read_array(root, "segment_order")
    dataset = txr_zarr_read.read_array(root, "segment_dataset")
    start = txr_zarr_read.read_array(root, "segment_start")
    end = txr_zarr_read.read_array(root, "segment_end")

    first = min(range(len(order)), key=lambda i: int(order[i]))
    assert int(start[first]) == 0, "the DECLARED-first segment must start at row 0"
    assert int(dataset[first]) == 0, (
        "declared_order 0 is the first DECLARED source, which is ds-b in this run"
    )
    # ds-b has 2 rows, so the first two output rows belong to the declared-first segment
    # and the last three to the declared-second — reconstructed from the segment ranges
    # (D18), since there is no per-output-row vector to read.
    def declared_of(i):
        seg = next(s for s in range(len(order))
                   if int(start[s]) <= i < int(end[s]))
        return int(order[seg])
    assert [declared_of(i) for i in range(2)] == [0, 0]
    assert [declared_of(i) for i in range(2, 5)] == [1, 1, 1]

    # THE ASSERTION THIS TEST IS FOR: the stored array is NOT in declared order, so a reader
    # that iterates it gets the segments backwards and its `start_row` sequence runs
    # 3,0 instead of 0,3. A producer that normalised the array into declared order would
    # make every such reader accidentally correct — which is precisely the defect this test
    # caught in the producer's first draft.
    array_order = [int(o) for o in order]
    assert array_order != sorted(array_order), (
        f"segment_order is ascending across the stored array ({array_order}), so the "
        "producer normalised it into declared order and a reader ignoring the field would "
        "still be right — INV-6 is untestable in that state"
    )
    assert [int(s) for s in start] != sorted(int(s) for s in start), (
        f"start_row is monotonic across the stored array ({[int(s) for s in start]}) — "
        "iterating the array happens to give the right ranges"
    )


def test_the_key_sequence_digests_MATCH_the_source_stores_on_disk(produced, tmp_path):
    """ITEM-9 end-to-end: the digest the producer recorded equals the one recomputed from
    the SOURCE artifact's own stored key bytes — not from anything the producer kept."""
    outputs, manifest = produced
    meta = entry_for(manifest, "dataset-alignment")["meta"]
    for _i, (record, (dataset_id, _spec)) in enumerate(zip(meta["sources"], TWO_SOURCES)):
        mount = mount_for(tmp_path / "inputs", "rows", _i)
        # THE IDENTITY ASSERTION: the recorded id is the RELAYED dataset id, and it is not
        # the mount name. `meta.sources[].dataset_id` is the only record of a virtual
        # dataset's link to its sources, so a detach-refusal resolves THIS value against the
        # datasets table — a mount name resolves nothing in production.
        assert record["dataset_id"] == dataset_id, record
        assert record["dataset_id"] != mount.name, (
            f"the recorded id {record['dataset_id']!r} is the MOUNT name — the producer is "
            "reading identity off the directory again"
        )
        stored = txr_zarr_read.read_strings(mount, "values")
        assert record["key_sequence_digest"] == cz.key_sequence_digest(stored), dataset_id


def test_the_level_lookups_round_trip_every_source_level(produced):
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    structure = txr_zarr_read.structure(root)
    lookups = [m for m in structure["aux"] if m["role"] == "alignment_level_lookup"]
    assert len(lookups) == 2, [m["path"] for m in lookups]  # one per source, one column
    for member in lookups:
        codes = txr_zarr_read.read_array(root, member["path"])
        # `strict` unions, so nothing is dropped and no -1 appears.
        assert (codes >= 0).all(), (member["path"], codes)


def test_the_coverage_sidecar_is_a_SEPARATE_hidden_intermediate_artifact(produced):
    """ITEM-15: exactly one home, and it is not the alignment's own meta."""
    outputs, manifest = produced
    side = entry_for(manifest, "data/opaque")
    assert side["role"] == "intermediate" and side["hidden"] is True, side
    payload = json.loads((outputs / side["path"]).read_text())
    assert payload["kind"] == "alignment_summary"
    assert payload["n_entities"] == 3 and payload["n_rows"] == 5

    alignment_meta = entry_for(manifest, "dataset-alignment")["meta"]
    for key in ("dropped_levels", "coverage", "entities_dropped_conflicting"):
        assert key not in alignment_meta, f"{key!r} is spelled in TWO places"


def test_the_alignment_row_is_stamped_hidden_with_the_artifact_role(produced):
    """DEC-11's intent, stamped at EMIT because the datatype has no such fields."""
    _outputs, manifest = produced
    entry = entry_for(manifest, "dataset-alignment")
    assert entry["role"] == "artifact"
    assert entry["hidden"] is True
    assert entry["axis"] == "unified_entities", (
        "the emitted axis must equal the one the datatype declares, and it must carry no "
        "domain noun — the producer aligns whichever entity axis the user chose"
    )


def test_authority_mode_drops_a_level_and_records_it_ONLY_on_the_sidecar(tmp_path):
    """A second real run, through the same subprocess path, exercising the other mode."""
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol",
                "mode": "authority", "authority": "ds-a"},
        sources=TWO_SOURCES,
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    assert conformance.conform_artifact(
        root, txr_zarr_read.structure(root), full=True
    ) == []

    side = json.loads(
        (outputs / entry_for(manifest, "data/opaque")["path"]).read_text()
    )
    # ds-a's vocabulary is [T, B]; ds-b's NK is outside it and is dropped.
    assert side["dropped_levels"] == {"celltype": {"ds-b": ["NK"]}}, side["dropped_levels"]

    # THE STORED ENCODING OF THE DROP (C4) — a DECLARED absence level, never `-1`.
    #
    # This block asserted `(codes < 0).any()`. That encoding is retired: `-1` is pandas'
    # IN-MEMORY missing code, and storing it is what `txr_columns` refuses ("rather than
    # storing an out-of-range code"). The read side rejects a negative code with a 400 for
    # the ENTIRE column, so `authority` — the only mode that drops — emitted conforming
    # artifacts it could never serve.
    attrs = json.loads((root / "zarr.json").read_text())["attributes"]["txr_alignment"]
    label = attrs["missing_levels"]["celltype"]
    assert label, attrs["missing_levels"]
    vocab = attrs["unified_levels"]["celltype"]
    absent_code = vocab.index(label)
    # The label is APPENDED, so it can never shadow one of the authority's real levels.
    assert absent_code == len(vocab) - 1, (vocab, label)
    # ds-a's DECLARED order (pandas sorts categories), not observation order.
    assert vocab[:absent_code] == ["B", "T"], vocab

    structure = txr_zarr_read.structure(root)
    dropped_seen = False
    for member in structure["aux"]:
        if member["role"] != "alignment_level_lookup":
            continue
        codes = txr_zarr_read.read_array(root, member["path"])
        assert not (codes < 0).any(), (
            f"{member['path']} stores a negative code {codes.tolist()} — the serve path "
            "refuses that with a 400 for the whole column")
        assert (codes < len(vocab)).all(), (member["path"], codes.tolist(), vocab)
        if (codes == absent_code).any():
            dropped_seen = True
    assert dropped_seen, (
        "authority dropped a level per the sidecar, but no stored lookup maps any source "
        "code to the declared absence level — the two records disagree"
    )


# ── the refusals, through a REAL run ─────────────────────────────────────────────


def test_a_run_with_no_key_is_REFUSED(tmp_path):
    inputs, outputs = stage_run(tmp_path, params={}, sources=TWO_SOURCES)
    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0
    assert "declares no `key`" in proc.stderr, proc.stderr
    assert not (outputs / "manifest.json").exists(), (
        "a refused run still wrote a manifest — a half-emitted result is worse than none"
    )


def test_a_run_over_sources_that_share_NOTHING_is_REFUSED(tmp_path):
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol"},
        sources=[
            ("ds-a", {"entity_keys": ["A"], "ensembl": ["E1"],
                      "row_keys": ["a-0"], "celltypes": ["T"]}),
            ("ds-b", {"entity_keys": ["Z"], "ensembl": ["E9"],
                      "row_keys": ["b-0"], "celltypes": ["B"]}),
        ],
    )
    proc = run_producer(inputs, outputs, expect_ok=False)
    assert "share no 'symbol' value in common" in proc.stderr, proc.stderr


def test_a_run_with_a_DUPLICATED_key_is_REFUSED_naming_the_source(tmp_path):
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol"},
        sources=[
            ("ds-a", {"entity_keys": ["A", "B"], "ensembl": ["E1", "E2"],
                      "row_keys": ["a-0"], "celltypes": ["T"]}),
            ("ds-b", {"entity_keys": ["A", "A", "B"], "ensembl": ["E1", "E5", "E2"],
                      "row_keys": ["b-0"], "celltypes": ["B"]}),
        ],
    )
    proc = run_producer(inputs, outputs, expect_ok=False)
    assert "ds-b" in proc.stderr and "duplicate key" in proc.stderr, proc.stderr


# ═══════════════════════════════════════════════════════════════════════════════
# The join-quality PREFLIGHT (ITEM-1 / DEC-20) — stage 3's ITEM-34 depends on it
# ═══════════════════════════════════════════════════════════════════════════════

PREFLIGHT = HERE.parent / "compute" / "join_quality_preflight.py"


def run_preflight(inputs, outputs, *, expect_ok=True):
    # The preflight DECLARES its sibling via `run.helpers`, so the staged `/code` carries
    # it by name — the same resolution the runner performs.
    code = stage_code_dir(Path(inputs).parent, PREFLIGHT,
                          helpers=["compute/embedding_integrate.py"])
    env = dict(os.environ)
    env["TXR_INPUTS_DIR"] = str(inputs)
    env["TXR_OUTPUTS_DIR"] = str(outputs)
    env["PYTHONPATH"] = ""
    proc = subprocess.run(
        [sys.executable, str(code / PREFLIGHT.name)], cwd=str(code),
        env=env, capture_output=True, text=True,
    )
    if expect_ok:
        assert proc.returncode == 0, (
            f"the preflight failed (exit {proc.returncode}).\nSTDOUT:\n{proc.stdout}\n"
            f"STDERR:\n{proc.stderr}"
        )
    return proc


def test_the_preflight_emits_joinable_PER_CANDIDATE_KEY(tmp_path):
    """The field stage 3's picker may not skip.

    The fixture is built so the BEST-MATCHING key is the UNJOINABLE one: `ensembl_id` is
    blank in two of ds-b's rows, which `align` refuses as `duplicate key ''`. A picker that
    ranked on `matched` alone would put an unusable key at the top of the list.
    """
    inputs, outputs = stage_run(
        tmp_path,
        params={},
        sources=[
            ("ds-a", {"entity_keys": ["A", "B", "C"], "ensembl": ["E1", "E2", "E3"],
                      "row_keys": ["a-0"], "celltypes": ["T"]}),
            ("ds-b", {"entity_keys": ["A", "B", "C"], "ensembl": ["E1", "", ""],
                      "row_keys": ["b-0"], "celltypes": ["T"]}),
        ],
    )
    run_preflight(inputs, outputs)
    payload = json.loads((outputs / "join_quality.json").read_text())
    assert payload["kind"] == "join_quality"

    rows = {c["key"]: c for c in payload["candidates"]}
    assert set(rows) == {"symbol", "ensembl_id"}, sorted(rows)
    for row in rows.values():
        for field in ("matched", "conflicting", "duplicated", "missing", "joinable"):
            assert field in row, (row["key"], sorted(row))

    assert rows["ensembl_id"]["joinable"] is False, rows["ensembl_id"]
    assert rows["ensembl_id"]["missing"] == 2, rows["ensembl_id"]
    assert rows["symbol"]["joinable"] is True, rows["symbol"]


def test_an_UNJOINABLE_key_can_never_head_the_list_however_well_it_matches():
    """The ordering encodes the refusal, so a renderer cannot forget it.

    Tested against `rank_candidates` directly rather than through a fixture, and that is a
    deliberate choice with a reason: a REAL input in which an unjoinable key out-matches a
    joinable one is close to unreachable, because both things that make a key unjoinable — a
    duplicate, or two blanks — also remove it from `matched`, so the two counts move
    together. A previous version of this test tried to contrive one, failed, and papered
    over the gap with `assert ... or True`, a literal tautology.

    The rule still has to hold for inputs no fixture can reach, so it is asserted where it
    can be: over candidate rows that state the hard case outright.
    """
    # The preflight lives in `compute/`, which is not on the suite's path (the sandbox
    # stages it into `/code`; the tests drive it as a subprocess). Load it by path for this
    # one unit-level assertion rather than widening the suite's import surface.
    import importlib.util

    # The module imports its sibling at module scope, exactly as it does in `/code`, so the
    # compute dir has to be resolvable for the load — plus `_helpers` for `alignment`.
    for extra in (str(PREFLIGHT.parent), str(PACKAGES / "_helpers"), str(PACKAGES / "_lib")):
        if extra not in sys.path:
            sys.path.insert(0, extra)
    spec = importlib.util.spec_from_file_location("join_quality_preflight", PREFLIGHT)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("join_quality_preflight", module)
    spec.loader.exec_module(module)
    rank_candidates = module.rank_candidates

    ranked = rank_candidates([
        {"key": "symbol", "matched": 18204, "joinable": False},
        {"key": "ensembl_id", "matched": 12, "joinable": True},
    ])
    assert [c["key"] for c in ranked] == ["ensembl_id", "symbol"], ranked
    assert ranked[0]["joinable"] is True

    # …and among EQUALLY joinable keys, `matched` decides — so `joinable` is a tiebreak
    # ahead of it, not a replacement for it.
    ranked = rank_candidates([
        {"key": "aaa", "matched": 5, "joinable": True},
        {"key": "zzz", "matched": 90, "joinable": True},
    ])
    assert [c["key"] for c in ranked] == ["zzz", "aaa"], ranked

    # …and among equally joinable, equally matching keys the order is total and stable.
    ranked = rank_candidates([
        {"key": "b", "matched": 5, "joinable": True},
        {"key": "a", "matched": 5, "joinable": True},
    ])
    assert [c["key"] for c in ranked] == ["a", "b"], ranked


def test_the_preflight_ORDERING_holds_end_to_end(tmp_path):
    """The same rule through a real run, on the case a fixture CAN reach: an unjoinable key
    that matches as well as the joinable one still cannot head the list."""
    inputs, outputs = stage_run(
        tmp_path,
        params={},
        sources=[
            ("ds-a", {"entity_keys": ["A", "B", "C"], "ensembl": ["E1", "E2", "E3"],
                      "row_keys": ["a-0"], "celltypes": ["T"]}),
            ("ds-b", {"entity_keys": ["A", "B", "C", "A"], "ensembl": ["E1", "E2", "E3", "E9"],
                      "row_keys": ["b-0"], "celltypes": ["T"]}),
        ],
    )
    run_preflight(inputs, outputs)
    candidates = json.loads((outputs / "join_quality.json").read_text())["candidates"]
    rows = {c["key"]: c for c in candidates}
    assert rows["symbol"]["joinable"] is False, rows["symbol"]
    assert rows["ensembl_id"]["joinable"] is True, rows["ensembl_id"]
    assert candidates[0]["key"] == "ensembl_id", [
        (c["key"], c["matched"], c["joinable"]) for c in candidates
    ]


def test_the_preflight_reads_ONLY_the_entity_table_never_the_row_table(tmp_path):
    """INV-11 as an executable claim: deleting each source's row table does not stop it.

    A preflight that touched the row table would scale with the CELL count — the dimension
    that is actually large — and could not run on every key change.
    """
    inputs, outputs = stage_run(
        tmp_path, params={}, sources=TWO_SOURCES,
    )
    import shutil

    for i, _ in enumerate(TWO_SOURCES):
        # Both halves the preflight must not open: the row axis AND the level column.
        shutil.rmtree(mount_for(inputs, "rows", i))
        shutil.rmtree(mount_for(inputs, f"level:{i}:celltype"))
    run_preflight(inputs, outputs)
    payload = json.loads((outputs / "join_quality.json").read_text())
    assert [c["key"] for c in payload["candidates"]], payload


def test_the_preflight_is_CHEAP_at_realistic_cardinality(tmp_path):
    """The cost, MEASURED — because "cheap enough to run on every key change" is a claim
    that belongs in a number, not in a docstring.

    20,000 entities x 2 identifier columns x 2 sources: a realistic gene axis. The ceiling
    is deliberately loose (it is a subprocess spawn plus a Python decode on a shared box,
    and a tight bound would be a flake generator), but it is far below the threshold at
    which a per-keystroke measurement stops being viable.
    """
    import time

    n = 20_000
    sources = [
        ("ds-a", {"entity_keys": [f"SYM{i}" for i in range(n)],
                  "ensembl": [f"ENSG{i}" for i in range(n)],
                  "row_keys": ["a-0"], "celltypes": ["T"]}),
        ("ds-b", {"entity_keys": [f"SYM{i}" for i in range(n)],
                  "ensembl": [f"ENSG{i}" for i in range(n)],
                  "row_keys": ["b-0"], "celltypes": ["T"]}),
    ]
    inputs, outputs = stage_run(tmp_path, params={}, sources=sources)
    started = time.monotonic()
    run_preflight(inputs, outputs)
    elapsed = time.monotonic() - started

    payload = json.loads((outputs / "join_quality.json").read_text())
    rows = {c["key"]: c for c in payload["candidates"]}
    assert rows["symbol"]["matched"] == n, rows["symbol"]
    assert elapsed < 20.0, (
        f"the preflight took {elapsed:.1f}s for {n} entities x 2 sources — at that cost it "
        "cannot run on every key change, and the automatic-measurement decision (DEC-20) "
        "needs revisiting with this number"
    )
    print(f"\n[preflight] {n} entities x 2 columns x 2 sources: {elapsed:.2f}s")


def test_the_preflight_refuses_a_run_with_no_bindings_at_all(tmp_path):
    inputs = tmp_path / "inputs"
    outputs = tmp_path / "outputs"
    inputs.mkdir(parents=True)
    outputs.mkdir(parents=True)
    (inputs / "inputs.json").write_text(json.dumps({"inputs": []}))
    (inputs / "params.json").write_text("{}")
    proc = run_preflight(inputs, outputs, expect_ok=False)
    assert "params.dataset_ids is empty" in proc.stderr, proc.stderr


def test_a_slot_under_NO_DECLARED_FAMILY_is_refused_not_silently_ignored(tmp_path):
    """The prefix spellings are pinned BEHAVIOURALLY, not by reading the source.

    ## Why this replaced a source-text assertion

    The test that stood here asserted `'"datasets"' in path.read_text()` — a guard over
    PROSE. `BASE.md` §H7 records this repo retiring that shape twice, including one instance
    written in the same round as the lesson: a literal in a docstring satisfies it, and the
    slot name changing in the actual call satisfies it too, as long as the old spelling
    survives somewhere in the file. It could not have caught this very rework — `"datasets"`
    still appears in the source, in the comments explaining why the slot is gone.

    What it was reaching for is real: a slot the VIEW binds must be one the compute
    resolves, or the run silently ignores an input the user chose. That is assertable by
    RUNNING it. `entities:0:symbol` is the plausible typo for `entity:0:symbol` — a family
    that does not exist — and the run must FAIL naming the missing binding rather than
    succeeding over whatever else happened to be bound.
    """
    inputs, outputs = stage_run(
        tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES,
        # ONE source's entity columns land under a family the compute does not declare.
        slot_for=lambda kind, i, col: (
            f"entities:{i}:{col}" if kind == "entity" and i == 0 else None
        ),
    )
    proc = run_producer(inputs, outputs, expect_ok=False)
    assert "'entity:'" in proc.stderr and "[0]" in proc.stderr, proc.stderr


def test_the_declared_slot_families_are_the_ones_the_run_actually_HONOURS(tmp_path):
    """The positive control for the test above — and the reason it is a pair.

    A refusal test alone cannot distinguish "the compute rejects an unknown family" from
    "the compute rejects everything". This stages the SAME grid under the correct spellings
    and requires the run to succeed, so the two together pin the prefix rather than pinning
    "it fails".
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    slots = {e["slot"] for e in json.loads((inputs / "inputs.json").read_text())["inputs"]}
    assert {"entity:0:symbol", "entity:1:symbol", "rows", "level:0:celltype"} <= slots, slots
    run_producer(inputs, outputs)
    assert (outputs / "manifest.json").exists()


# ═══════════════════════════════════════════════════════════════════════════════
# The CONFLICT fixture — ITEM-3's substance, through a REAL run
# ═══════════════════════════════════════════════════════════════════════════════
#
# Every fixture above gives both datasets the SAME ensembl_id for every shared symbol, so
# no pair ever CONFLICTS — and `strict`'s drop and `authority`'s relabel, the two behaviours
# the whole feature is about, never executed through a real run. A blind audit proved it by
# mutation: making `strict` stop dropping, and making `authority` take its label from the
# wrong source, each left the entire end-to-end suite green.
#
# That is the failure this suite's own header names — "a fixture proves the writer works;
# only a real run proves the PRODUCER calls it correctly" — reached from the other side: the
# run was real, and the fixture could not tell the two modes apart.

CONFLICTING_SOURCES = [
    ("ds-a", {
        "entity_keys": ["A", "B", "C"],
        "ensembl": ["E1", "E2", "E3"],
        "row_keys": ["a-0", "a-1"],
        "celltypes": ["T", "B"],
    }),
    # `C` carries a DIFFERENT ensembl id here, so (symbol=C) is a conflicting pair.
    ("ds-b", {
        "entity_keys": ["A", "B", "C"],
        "ensembl": ["E1", "E2", "E7"],
        "row_keys": ["b-0", "b-1", "b-2"],
        "celltypes": ["B", "NK", "T"],
    }),
]


def produce(tmp_path, **params):
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol", **params},
        sources=CONFLICTING_SOURCES,
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    return outputs, manifest


def test_STRICT_drops_the_conflicting_entity_through_a_real_run(tmp_path):
    """ITEM-3, end to end. `strict` is the default, so this is the default path."""
    outputs, manifest = produce(tmp_path)
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    keys = txr_zarr_read.read_strings(root, "unified_key")
    assert keys == ["A", "B"], f"strict must DROP the conflicting entity C; got {keys}"

    side = json.loads((outputs / entry_for(manifest, "data/opaque")["path"]).read_text())
    assert side["entities_dropped_conflicting"] == ["C"], side
    assert conformance.conform_artifact(
        root, txr_zarr_read.structure(root), full=True
    ) == []


def test_AUTHORITY_keeps_the_conflicting_entity_and_labels_it_from_the_NAMED_dataset(tmp_path):
    """The other half, and the label is what makes it a real assertion: keeping the pair is
    only half of what `authority` means, and an implementation that kept it while taking the
    first-arriving annotation would pass a keep-only test."""
    outputs, manifest = produce(tmp_path, mode="authority", authority="ds-b")
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    keys = txr_zarr_read.read_strings(root, "unified_key")
    assert keys == ["A", "B", "C"], f"authority must KEEP C; got {keys}"

    meta = entry_for(manifest, "dataset-alignment")["meta"]
    assert meta["mode"] == "authority" and meta["authority"] == "ds-b", meta

    # THE LABEL — which is what `authority` actually means, and what was unobservable.
    # ds-b is the authority, so C's unified ensembl_id must be ds-b's E7, not ds-a's E3.
    unified = txr_zarr_read.read_strings(root, "unified_ensembl_id")
    assert dict(zip(keys, unified))["C"] == "E7", dict(zip(keys, unified))

    # …and naming the OTHER dataset selects the OTHER annotation. Without this the
    # assertion above is satisfied by any implementation that keeps the pair, including one
    # that takes whichever value arrived first.
    outputs2, manifest2 = produce(tmp_path / "b", mode="authority", authority="ds-a")
    root2 = outputs2 / entry_for(manifest2, "dataset-alignment")["path"]
    assert entry_for(manifest2, "dataset-alignment")["meta"]["authority"] == "ds-a"
    keys2 = txr_zarr_read.read_strings(root2, "unified_key")
    unified2 = txr_zarr_read.read_strings(root2, "unified_ensembl_id")
    assert dict(zip(keys2, unified2))["C"] == "E3", dict(zip(keys2, unified2))


def test_the_entity_evidence_VECTOR_records_which_entity_disagreed(tmp_path):
    """T3: the ITEM-11 vector was checked for SHAPE only, so hardcoding it to
    "everything agreed" was observationally identical. Its CONTENTS are asserted here, and
    the fixture makes exactly one entity disagree so an all-ones constant cannot pass."""
    outputs, manifest = produce(tmp_path, mode="authority", authority="ds-b")
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    keys = txr_zarr_read.read_strings(root, "unified_key")
    agreed = txr_zarr_read.read_array(root, "entity_secondaries_agreed").tolist()

    assert len(agreed) == len(keys) == 3, (keys, agreed)
    by_entity = dict(zip(keys, agreed))
    assert by_entity == {"A": 1, "B": 1, "C": 0}, by_entity
    assert 0 in agreed, "an all-agreed vector cannot be distinguished from a constant"


def test_the_artifact_meta_carries_the_ITEM_10_evidence_record(tmp_path):
    """T4: four evidence fields were never asserted PRESENT on the emitted artifact, so each
    could be blanked at the emit site while the unit tests — which assert what
    `alignment_metadata()` RETURNS — stayed green. Each side agreeing with itself is exactly
    what this suite exists to close."""
    outputs, manifest = produce(tmp_path, normalize=["trim"])
    meta = entry_for(manifest, "dataset-alignment")["meta"]

    assert meta["join_key"] == "symbol", meta
    assert meta["mode"] == "strict" and meta["authority"] is None, meta
    assert meta["normalize"] == ["trim"], meta
    # The counts AS MEASURED — 1 conflicting, taken before the mode resolved anything. A
    # recomputation from the resolved state would read 0, since strict dropped it.
    assert meta["join_quality"]["conflicting"] == 1, meta["join_quality"]
    assert meta["join_quality"]["key"] == "symbol", meta["join_quality"]
    # ITEM-14 / INV-15: both sources' declared orders, recorded and asserted by nobody.
    orders = meta["source_declared_orders"]["celltype"]
    assert set(orders) == {"ds-a", "ds-b"}, orders
    assert all(isinstance(v, list) and v for v in orders.values()), orders
    assert meta["n_entities_dropped"] == 1, meta


def test_segment_dataset_is_asserted_for_EVERY_segment_not_just_the_first(tmp_path):
    """T5: both read sites asserted `dataset[first] == 0` in fixtures where 0 was right by
    accident, so the constant 0 was indistinguishable from a correct vector. Declared in
    REVERSE so the two segments' source indices differ from their array positions."""
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol"},
        sources=list(reversed(CONFLICTING_SOURCES)),
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]

    order = txr_zarr_read.read_array(root, "segment_order").tolist()
    dataset = txr_zarr_read.read_array(root, "segment_dataset").tolist()
    start = txr_zarr_read.read_array(root, "segment_start").tolist()

    # EVERY segment, resolved through declared_order — not just the first.
    by_declared = {int(order[i]): (int(dataset[i]), int(start[i])) for i in range(len(order))}
    assert by_declared == {0: (0, 0), 1: (1, 3)}, (
        f"declared_order -> (source_index, start_row) is wrong; got {by_declared}. "
        "ds-b is declared first here and has 3 rows, so segment 1 starts at row 3."
    )
    assert sorted(dataset) == [0, 1], (
        f"source_index must be a permutation of the source range, not a constant: {dataset}"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# CROSS-SEAM — the preflight's real bytes, in the shape that breaks a zipping decoder
# ═══════════════════════════════════════════════════════════════════════════════
#
# A consumer decoded this artifact by treating every ARRAY-valued key as a column, zipping
# them to `max(len)` and padding with nulls. Two consequences, both invisible in a fixture
# whose lengths happen to match:
#
#   * `sources` and `candidates` are independent lists. When `sources` OUTNUMBERS
#     `candidates` — two datasets sharing one candidate key, an ordinary case — the
#     candidates table comes back with NULL ROWS.
#   * `kind` is a STRING, so a decoder that only collects array-valued keys drops the field
#     that says which artifact this is.
#
# Neither side's tests could see it: every test on both sides builds its own fixture, so
# each half speaks the dialect of the code reading it. This test exists to make the
# PRODUCER's actual bytes available at the seam, and to pin the asymmetry that a
# length-matched fixture would hide — the same trap as the segment-ordering fixture, one
# seam over.


def test_the_preflight_emits_MORE_sources_than_candidates_and_keeps_kind(tmp_path):
    """The cross-seam fixture. Asserts the SHAPE PROPERTIES a consumer decodes against.

    It deliberately does NOT assert how any consumer parses this — that would be this side
    guessing at the other's dialect, which is the failure it is here to prevent. What it
    pins is the producer's half of the contract: `kind` is present and scalar, and the two
    lists are independently sized with `sources` strictly longer.
    """
    inputs, outputs = stage_run(
        tmp_path,
        params={},
        sources=[
            ("ds-a", {"entity_keys": ["A", "B", "C"], "ensembl": ["E1", "E2", "E3"],
                      "row_keys": ["a-0"], "celltypes": ["T"]}),
            # NOTE the asymmetry is built by the SOURCES, not by the params: ds-b carries no
            # `ensembl_id`, so `symbol` is the only SHARED column and there is exactly one
            # candidate against two sources.
            ("ds-b", {"entity_keys": ["A", "B", "C"], "ensembl": None,
                      "row_keys": ["b-0"], "celltypes": ["T"]}),
        ],
    )
    run_preflight(inputs, outputs)
    raw = (outputs / "join_quality.json").read_text()
    payload = json.loads(raw)

    assert payload["kind"] == "join_quality", (
        "`kind` identifies which artifact this is; a decoder that collects only "
        "array-valued keys drops it, so its presence is part of the contract"
    )
    assert not isinstance(payload["kind"], list), "`kind` is a SCALAR, not a column"

    n_sources, n_candidates = len(payload["sources"]), len(payload["candidates"])
    assert n_sources == 2 and n_candidates == 1, (n_sources, n_candidates)
    assert n_sources > n_candidates, (
        "the fixture must make `sources` OUTNUMBER `candidates` — with equal lengths a "
        "decoder that zips every array-valued key into one table produces the right answer "
        "by accident and this test proves nothing"
    )
    # The lists are INDEPENDENT: no positional relationship exists between a source and a
    # candidate, so nothing downstream may pair them by index.
    assert payload["candidates"][0]["key"] == "symbol", payload["candidates"]
    assert set(payload["sources"]) == {"ds-a", "ds-b"}, payload["sources"]


def test_a_consumer_zipping_the_arrays_would_see_NULL_ROWS(tmp_path):
    """The failure made executable, so the asymmetry cannot be 'simplified' out of the
    fixture above without this going red.

    This models the broken decode — zip every array-valued key to `max(len)`, pad with
    null — and asserts it produces a null-padded candidate. It is not asserting that any
    consumer still does this; it is pinning that the producer's shape REACHES that decoder,
    which is what makes the fixture worth keeping.
    """
    inputs, outputs = stage_run(
        tmp_path,
        params={},
        sources=[
            ("ds-a", {"entity_keys": ["A", "B"], "ensembl": ["E1", "E2"],
                      "row_keys": ["a-0"], "celltypes": ["T"]}),
            ("ds-b", {"entity_keys": ["A", "B"], "ensembl": None,
                      "row_keys": ["b-0"], "celltypes": ["T"]}),
        ],
    )
    run_preflight(inputs, outputs)
    payload = json.loads((outputs / "join_quality.json").read_text())

    array_keys = {k: v for k, v in payload.items() if isinstance(v, list)}
    assert set(array_keys) == {"sources", "normalize", "candidates"}, sorted(array_keys)
    width = max(len(v) for v in array_keys.values())
    zipped = {k: list(v) + [None] * (width - len(v)) for k, v in array_keys.items()}

    assert width == len(payload["sources"]) == 2, width
    assert zipped["candidates"][-1] is None, (
        "the zipping decode does not produce a null row on this fixture, so the fixture no "
        f"longer exercises the case it exists for: {zipped}"
    )
    assert "kind" not in zipped, "…and the scalar `kind` is dropped entirely by that decode"


# ═══════════════════════════════════════════════════════════════════════════════
# The DATATYPE DECLARATION must match what the producer actually writes
# ═══════════════════════════════════════════════════════════════════════════════


def _declared_alignment_datatype():
    import yaml

    manifest = yaml.safe_load(
        (PACKAGES / "single-cell-types" / "manifest.yaml").read_text()
    )
    return next(
        t for t in manifest["contributes"]["datatypes"] if t["id"] == "dataset-alignment"
    )


def test_the_dataset_alignment_DECLARATION_matches_a_freshly_emitted_artifact(produced):
    """The declaration is a READ-side contract; the artifact is the truth.

    It drifted because it was written from the PLAN rather than from an artifact: it
    declared a `segments` columnar table the producer never writes, and omitted five member
    classes it does. Both consumers had already built against what is emitted, so the
    declaration was the only wrong party — and nothing compared the two, so nothing said so.

    This compares ROLES and EXTENTS against a real run rather than counting members, because
    a count agrees for the wrong reasons: swap one member class for another and the total is
    unchanged. It is the actual fix; the declaration edit is the symptom.
    """
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    structure = txr_zarr_read.structure(root)
    datatype = _declared_alignment_datatype()

    emitted_roles = {m["role"] for m in structure["aux"]}
    declared_roles = {a["name"] for a in datatype["arrays"]}
    assert declared_roles == emitted_roles, (
        "the datatype's `arrays[]` and the producer's aux roles disagree.\n"
        f"  declared but NOT emitted (phantom): {sorted(declared_roles - emitted_roles)}\n"
        f"  emitted but NOT declared (missing): {sorted(emitted_roles - declared_roles)}"
    )

    # Every axis an array binds must be one the datatype declares — a dim naming an
    # undeclared axis is a read contract pointing at nothing.
    declared_axes = {a["name"] for a in datatype["axes"]}
    for array in datatype["arrays"]:
        for dim in array["dims"]:
            axis = dim.get("axis")
            if axis is not None:
                assert axis in declared_axes, (array["name"], axis, sorted(declared_axes))

    # …and every FIXED extent the producer emits (the ones that are not per-member, which a
    # datatype cannot enumerate) is a declared axis.
    fixed_extents = {
        e for e in structure["extents"] if not e.startswith("levels_")
    }
    assert fixed_extents <= declared_axes, (
        f"the producer emits extent(s) {sorted(fixed_extents - declared_axes)} that the "
        f"datatype declares no axis for; it declares {sorted(declared_axes)}"
    )


def test_the_declaration_binds_each_role_to_the_DIMENSIONALITY_the_producer_writes(produced):
    """Roles matching by name is not enough: a 1-D role declared 2-D (or bound to the wrong
    axis) is a contract a reader cannot satisfy."""
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    structure = txr_zarr_read.structure(root)
    by_role = {}
    for member in structure["aux"]:
        by_role.setdefault(member["role"], member["extent"])

    for array in _declared_alignment_datatype()["arrays"]:
        emitted_extent = by_role.get(array["name"])
        assert emitted_extent is not None, array["name"]
        declared_dims = [d.get("axis") for d in array["dims"]]
        assert len(declared_dims) == len(emitted_extent), (
            f"role {array['name']!r}: declared {len(declared_dims)} dim(s) "
            f"{declared_dims}, producer writes {len(emitted_extent)} {emitted_extent}"
        )
        # A per-member extent (a level lookup) is not an axis the datatype can name, so it
        # is declared as an anonymous dim; a FIXED extent must name its axis exactly.
        for declared_axis, emitted_name in zip(declared_dims, emitted_extent):
            if emitted_name.startswith("levels_"):
                assert declared_axis is None, (
                    f"role {array['name']!r} binds a per-member extent to axis "
                    f"{declared_axis!r}; it varies per source and is anonymous"
                )
            else:
                assert declared_axis == emitted_name, (
                    f"role {array['name']!r}: declared axis {declared_axis!r} but the "
                    f"producer writes extent {emitted_name!r}"
                )


def test_at_least_one_producer_FIXTURE_declares_levels_out_of_OBSERVATION_order():
    """The declared-levels mechanism is only tested if some fixture makes the two differ.

    `declared_levels` exists because stored categorical codes index the DECLARED order while
    observation gives first-appearance order. Every producer fixture used to declare
    `dict.fromkeys(celltypes)` — first-appearance — so the two coincided everywhere and the
    whole mechanism was observationally identical to having none: removing `declared_levels=`
    from the producer left the suite green.

    The order now comes from `pd.Series(..., dtype="category")` — pandas sorts categories —
    so it is the REAL writer's behaviour rather than a fixture's contrivance. This asserts
    the CONSEQUENCE rather than the spelling: at least one fixture in the module must produce
    a declared order that differs from its observation order, or the path is untested again
    and no per-fixture rule would notice.
    """
    fixtures = [spec["celltypes"] for _id, spec in TWO_SOURCES + CONFLICTING_SOURCES]
    differing = [
        cells for cells in fixtures
        if sorted(set(cells)) != list(dict.fromkeys(cells))
    ]
    assert differing, (
        "no producer fixture declares its levels out of observation order, so the "
        f"declared-levels path is not exercised end to end. Fixtures: {fixtures}"
    )


def test_the_fixture_STORES_levels_out_of_observation_order_on_disk(tmp_path):
    """The same property, asked of the BYTES rather than of the fixture's input data.

    The test above reasons about the `celltypes` lists. That is one step removed from what
    matters: the property has to hold in what the WRITER stored, because the producer reads
    `attributes.txr.levels` off the member, not the list a test declared. Since the sort now
    comes from pandas rather than from an explicit `sorted()` in the fixture, "the writer
    still does this" is exactly the kind of assumption that goes stale silently.

    So this stages a real run and reads the stored level set back out of the staged store.
    """
    inputs, _outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    differing = []
    for i, (dataset_id, spec) in enumerate(TWO_SOURCES):
        stamped = txr_zarr_read.read_meta(
            mount_for(inputs, f"level:{i}:celltype"), "values")
        stored = list(stamped["attributes"]["txr"]["levels"])
        observed = list(dict.fromkeys(spec["celltypes"]))
        assert sorted(stored) == sorted(set(spec["celltypes"])), (dataset_id, stored)
        if stored != observed:
            differing.append((dataset_id, stored, observed))
    assert differing, (
        "every staged source STORED its levels in observation order, so the producer's "
        "declared-code-space branch is not exercised by any of them — whatever the fixture's "
        "input lists happen to say"
    )


def test_the_level_lookups_are_indexed_by_each_source_STORED_code_space(produced, tmp_path):
    """The end-to-end proof that the producer honours each source's DECLARED level order.

    Stored codes are positions into the member's own `attributes.txr.levels`. If the
    producer inferred the code space from observed labels instead, the lookup would be a
    permutation and every fused value of that source silently relabelled.

    The unified vocabulary is not emitted (a known open finding), so this cannot assert
    "code 2 means B" directly. It asserts the invariant that does not need it: **the same
    level, in two different sources, must map to the same unified code.** Under an
    observation-order code space the two sources' orders differ, so the same level resolves
    to two different unified codes and this goes red.
    """
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    structure = txr_zarr_read.structure(root)

    lookups = {}
    for member in structure["aux"]:
        if member["role"] != "alignment_level_lookup":
            continue
        source_index = int(member["path"].rsplit("__", 1)[1])
        lookups[source_index] = txr_zarr_read.read_array(root, member["path"]).tolist()
    assert len(lookups) == 2, sorted(lookups)

    # Each source's STORED level list, off its own member stamp — the code space itself.
    unified_of_level = {}
    for source_index, (dataset_id, _spec) in enumerate(TWO_SOURCES):
        stamp = txr_zarr_read.read_meta(
            mount_for(tmp_path / "inputs", f"level:{source_index}:celltype"), "values"
        )
        stored_levels = stamp["attributes"]["txr"]["levels"]
        assert stored_levels == sorted(stored_levels), (
            f"{dataset_id} must store levels out of observation order for this to test "
            f"anything; got {stored_levels}"
        )
        for code, level in enumerate(stored_levels):
            unified = lookups[source_index][code]
            if unified < 0:
                continue
            previous = unified_of_level.setdefault(level, unified)
            assert previous == unified, (
                f"level {level!r} maps to unified code {previous} in one source and "
                f"{unified} in another — the lookups are indexed by different code spaces, "
                "so one source's fused values are relabelled"
            )
    # …and the fixture must actually SHARE a level across sources, or nothing is compared.
    shared = [lvl for lvl in unified_of_level if sum(
        1 for _i, (_d, spec) in enumerate(TWO_SOURCES) if lvl in spec["celltypes"]
    ) > 1]
    assert shared, f"no level is shared between sources; nothing cross-checked: {unified_of_level}"


def test_the_reference_EMITTER_runs_and_its_default_fixture_DISAGREES_on_order(tmp_path):
    """The cross-seam emitter is EXECUTED here, not merely shipped.

    It was referenced by no test, no ini path and no CI, so it could break or drift in
    silence — and it had: its docstring promised that array order and `declared_order`
    disagree while its default produced `segment_order=[0,1]`, ascending. A consumer pinning
    against that artifact could iterate the segment array, be WRONG about which dataset a
    row came from, and pass. A reader shipped exactly that defect and it survived review
    because its own fixture had the same coincidence.

    So this asserts the property the tool exists to provide, on the artifact it actually
    emits, through a real subprocess run.
    """
    tool = PACKAGES / "embedding-integrate" / "tools" / "emit_reference_alignment.py"
    out = tmp_path / "ref"
    proc = subprocess.run(
        [sys.executable, str(tool), str(out)], capture_output=True, text=True
    )
    assert proc.returncode == 0, f"{proc.stdout}\n{proc.stderr}"

    root = out / "outputs" / "alignment.zarr"
    order = txr_zarr_read.read_array(root, "segment_order").tolist()
    start = txr_zarr_read.read_array(root, "segment_start").tolist()
    assert order != sorted(order), (
        f"the reference artifact's segment_order={order} is ascending across the array, so "
        "array order and declared_order agree and a consumer that ignores declared_order "
        "passes against it — the trap this fixture exists to expose"
    )
    assert start != sorted(start), (
        f"the reference artifact's segment_start={start} is monotonic across the array, so "
        "iterating it happens to give the right row ranges"
    )
    # …and it is a REAL artifact: the framework gate conforms it.
    assert conformance.conform_artifact(
        root, txr_zarr_read.structure(root), full=True
    ) == []


# ═══════════════════════════════════════════════════════════════════════════════
# The UNIFIED LEVEL VOCABULARY — what a unified code MEANS
# ═══════════════════════════════════════════════════════════════════════════════


def _unified_levels(root):
    attributes = txr_zarr_read.read_meta(root).get("attributes") or {}
    return (attributes.get("txr_alignment") or {}).get("unified_levels")


def test_the_unified_VOCABULARY_travels_with_the_artifact(produced):
    """Without it a fused categorical is uninterpretable — and a browser renders integers.

    The client reads a categorical's labels from `attributes.txr.levels`. A gathered column
    has no stored member to read them from, so the vocabulary has to come from the
    alignment. It was being computed and discarded, which made every `alignment_level_lookup`
    a mapping into a list that existed nowhere.

    Asserted by CONTENT: every unified code a lookup emits resolves to the label that
    source's stored code actually denotes.
    """
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    vocabulary = _unified_levels(root)
    assert isinstance(vocabulary, dict) and "celltype" in vocabulary, vocabulary
    levels = vocabulary["celltype"]
    assert levels and all(isinstance(v, str) for v in levels), levels
    # The fixture's two sources carry T/B and B/NK — the union, by content.
    assert set(levels) == {"T", "B", "NK"}, levels


def test_every_lookup_code_RESOLVES_to_the_label_its_source_code_denotes(produced, tmp_path):
    """End-to-end round trip: source stored code -> unified code -> unified label, checked
    against the label that source's own stamp gives that code."""
    outputs, manifest = produced
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    levels = _unified_levels(root)["celltype"]
    structure = txr_zarr_read.structure(root)

    checked = 0
    for member in structure["aux"]:
        if member["role"] != "alignment_level_lookup":
            continue
        source_index = int(member["path"].rsplit("__", 1)[1])
        dataset_id = TWO_SOURCES[source_index][0]
        stamp = txr_zarr_read.read_meta(
            mount_for(tmp_path / "inputs", f"level:{source_index}:celltype"), "values"
        )
        stored_levels = stamp["attributes"]["txr"]["levels"]
        codes = txr_zarr_read.read_array(root, member["path"]).tolist()
        assert len(codes) == len(stored_levels), (member["path"], codes, stored_levels)
        for stored_code, label in enumerate(stored_levels):
            unified = codes[stored_code]
            if unified < 0:
                continue
            assert levels[unified] == label, (
                f"{dataset_id} stored code {stored_code} is {label!r}, but unified code "
                f"{unified} is {levels[unified]!r} — the vocabulary and the lookup disagree"
            )
            checked += 1
    assert checked >= 3, f"only {checked} code(s) round-tripped; the fixture proves little"


def test_the_vocabulary_SURVIVES_above_the_manifest_truncation_threshold(tmp_path):
    """A digest is not a vocabulary.

    `alignment_meta` digests `source_declared_orders` above 64 levels because the manifest
    row has a hard 1 MiB cap. The UNIFIED vocabulary must not share that fate: it is the
    only thing that can label a fused column, and a high-cardinality categorical is exactly
    where labels matter most. It rides the group attributes — with the bytes, uncapped — so
    this asserts the labels survive verbatim at a cardinality where the row-side evidence
    has already been reduced to a digest.
    """
    n_levels = 90
    cells_a = [f"ct{i:03d}" for i in range(n_levels)]
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol"},
        sources=[
            ("ds-a", {"entity_keys": ["A", "B"], "ensembl": ["E1", "E2"],
                      "row_keys": [f"a-{i}" for i in range(n_levels)],
                      "celltypes": cells_a}),
            ("ds-b", {"entity_keys": ["A", "B"], "ensembl": ["E1", "E2"],
                      "row_keys": ["b-0"], "celltypes": ["ct000"]}),
        ],
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]

    levels = _unified_levels(root)["celltype"]
    assert len(levels) == n_levels, len(levels)
    assert set(levels) == set(cells_a), "labels were lost or altered at high cardinality"

    # …and the row-side evidence IS digested at this cardinality, which is the contrast:
    # the same fact reduced on the row, preserved in the store.
    meta = entry_for(manifest, "dataset-alignment")["meta"]
    order_evidence = meta["source_declared_orders"]["celltype"]["ds-a"]
    assert isinstance(order_evidence, dict) and order_evidence.get("truncated") is True, (
        f"the fixture is below the truncation threshold, so this proves no contrast: "
        f"{order_evidence}"
    )
    assert conformance.conform_artifact(
        root, txr_zarr_read.structure(root), full=True
    ) == []


def test_a_BOUND_but_MISSING_dataset_mount_is_REFUSED_not_silently_dropped(tmp_path):
    """R3C7 — a silent wrong answer whose symptom is a BIGGER result, not a smaller one.

    The retired loader filtered bound paths through `.exists()` and nothing compared the
    survivors against the number of bindings. So a run where one of N mounts is absent
    produced a valid, conforming alignment over N-1 sources: `n_sources`, the segment table,
    the recorded join-quality counts and the entity intersection all describe a join the
    user did not ask for.

    It is worse than a normal dropped input because the entity axis is an INTERSECTION —
    losing a source ENLARGES the result. Nothing looks truncated, no count looks short, and
    the only visible effect is that the answer covers more genes than it should.
    """
    inputs, outputs = stage_run(
        tmp_path, params={"key": "symbol"},
        sources=TWO_SOURCES,
    )
    # Remove one MOUNT while leaving its binding in inputs.json — exactly what a failed
    # stage looks like from inside the sandbox.
    import shutil

    shutil.rmtree(mount_for(inputs, "entity:1:symbol"))
    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0, (
        "the producer completed over the surviving source(s) — an alignment the user did "
        "not ask for, with an intersection LARGER than the one they requested"
    )
    # The refusal names the SLOT, which is what identifies the missing cell of the grid.
    # (The dataset id is not on the wire; the slot's index is what maps to it.)
    assert "entity:1:symbol" in proc.stderr, proc.stderr
    assert not (outputs / "manifest.json").exists(), (
        "a refused run still wrote a manifest"
    )


def test_the_ABSENCE_code_is_reachable_from_a_REFERENCE_artifact_under_either_authority(tmp_path):
    """`DROPPED_LEVEL_CODE` (-1) is a contract value TWO stages implement — so a reference
    artifact must be able to carry it, under either choice of authority.

    It could not. The reference fixture gave ds-a a strict SUBSET of ds-b's levels, so
    naming ds-b as the authority dropped nothing and the emitted lookups contained no `-1`.
    A consumer could only exercise its own absence branch by calling the remap directly with
    the contract's value — guarding the call rather than the installation.

    The measured answer to "should a producer ever emit it?" is YES: `authority` genuinely
    drops any level outside the named dataset's vocabulary. It was unreachable because of
    the FIXTURE, not the mode. The sources are now mutually exclusive, so whichever is named
    the other loses something.
    """
    tool = PACKAGES / "embedding-integrate" / "tools" / "emit_reference_alignment.py"
    for authority in ("ds-a", "ds-b"):
        out = tmp_path / authority
        proc = subprocess.run(
            [sys.executable, str(tool), str(out), "--mode", "authority",
             "--authority", authority],
            capture_output=True, text=True,
        )
        assert proc.returncode == 0, f"{authority}: {proc.stdout}\n{proc.stderr}"
        root = out / "outputs" / "alignment.zarr"
        structure = txr_zarr_read.structure(root)
        # SINCE C4 the absence code is the DECLARED absence level's index, not `-1`. The
        # test kept its purpose — the reference artifact must EXERCISE the absence path —
        # and changed what that path is encoded as.
        attrs = json.loads((root / "zarr.json").read_text())["attributes"]["txr_alignment"]
        missing = {c: lv for c, lv in attrs["missing_levels"].items() if lv is not None}
        assert missing, (
            f"--authority {authority} declares no missing level, so nothing was dropped and "
            "a consumer cannot exercise the absence path against this artifact")
        absent = {attrs["unified_levels"][c].index(lv) for c, lv in missing.items()}
        codes = [
            code
            for member in structure["aux"]
            if member["role"] == "alignment_level_lookup"
            for code in txr_zarr_read.read_array(root, member["path"]).tolist()
        ]
        assert absent & set(codes), (
            f"--authority {authority} declares {missing} but no stored lookup maps a source "
            "code to it — the absence path is unreachable from this artifact")
        assert not [c for c in codes if c < 0], (
            f"--authority {authority} stored a NEGATIVE code; the serve path refuses that "
            "with a 400 for the entire column")
        # …and the artifact is real, not merely shaped right.
        assert conformance.conform_artifact(root, structure, full=True) == []


def test_strict_mode_emits_NO_absence_code(tmp_path):
    """The negative control for the above: `strict` UNIONS, so every source code maps and
    absence must NOT occur. Without this, 'emit -1 everywhere' would satisfy the test."""
    tool = PACKAGES / "embedding-integrate" / "tools" / "emit_reference_alignment.py"
    out = tmp_path / "strict"
    proc = subprocess.run([sys.executable, str(tool), str(out)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    root = out / "outputs" / "alignment.zarr"
    negatives = [
        code
        for member in txr_zarr_read.structure(root)["aux"]
        if member["role"] == "alignment_level_lookup"
        for code in txr_zarr_read.read_array(root, member["path"]).tolist()
        if code < 0
    ]
    assert not negatives, f"strict unions, so nothing is dropped; got {negatives}"


def test_a_MIS_ORDERED_id_relay_is_REFUSED_by_the_content_hash_cross_check(tmp_path):
    """The defence that makes a positional relay safe.

    Identity is relayed by BINDING ORDER, because that is the one alignment the runner
    guarantees — `unique_mount_name`'s own docstring warns that an identity-keyed mount
    scheme "would produce distinct-but-misaligned mounts". A positional relay is therefore
    right, and silently wrong if it is mis-ordered: every source would be attributed to the
    wrong dataset, with correct counts and a clean report.

    `content_hash` is on the wire per binding, so the relay is cross-checked against it.
    This reverses the ids while leaving the hashes in place — exactly what a mis-ordered
    relay looks like — and requires a refusal that NAMES the binding.
    """
    inputs, outputs = stage_run(
        tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES
    )
    params = json.loads((inputs / "params.json").read_text())
    params["dataset_ids"] = list(reversed(params["dataset_ids"]))
    (inputs / "params.json").write_text(json.dumps(params))

    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0, "a mis-ordered relay produced an alignment"
    assert "mis-ordered" in proc.stderr, proc.stderr
    assert not (outputs / "manifest.json").exists()


# R3T2's fixture: a CONFLICT (so `authority` has something to do) AND entity orders that
# DISAGREE between the sources (so the emitted order can discriminate). `CONFLICTING_SOURCES`
# gives both datasets `[A, B, C]`, which is why every existing authority test is blind to
# ordering: source-0 order, authority order, and sorted order are all the same list there.
AUTHORITY_ORDER_SOURCES = [
    ("ds-a", {
        # NEITHER source is in sorted order. Source 0 being sorted is not good enough:
        # measured, a producer that SORTS the unified axis then passes the source-0
        # assertion, because sorted == source-0 order whenever source 0 happens to be
        # sorted. Only the reversed-declaration test caught it. Both do now.
        "entity_keys": ["B", "A", "C"],
        "ensembl": ["E2", "E1", "E3"],
        "row_keys": ["a-0", "a-1"],
        "celltypes": ["T", "B"],
    }),
    ("ds-b", {
        # A DIFFERENT permutation, also unsorted, and `C` still carries a different ensembl
        # id — so this fixture discriminates on order while keeping the conflict.
        "entity_keys": ["C", "A", "B"],
        "ensembl": ["E7", "E1", "E2"],
        "row_keys": ["b-0", "b-1", "b-2"],
        "celltypes": ["B", "NK", "T"],
    }),
]


def test_the_FIXTURE_for_authority_ordering_has_DISAGREEING_source_orders():
    """The property R3T2's tests depend on, asserted apart from them.

    If the two sources' entity orders coincided, "the unified order is source 0's" would be
    indistinguishable from "it is the authority's" and from "it is sorted" — and the tests
    below would pass against all three. That is precisely the state `CONFLICTING_SOURCES`
    was in, and why the ordering contract went unpinned for three rounds.
    """
    a, b = [spec["entity_keys"] for _id, spec in AUTHORITY_ORDER_SOURCES]
    assert a != b, (a, b)
    assert sorted(a) == sorted(b), ("the two must be permutations of one entity set", a, b)
    # BOTH must be unsorted, not just one. A sorted SOURCE 0 makes "the unified order is
    # source 0's" and "the producer sorted it" indistinguishable in the forward test —
    # measured, by mutating the engine to `sorted(features)` and watching that test stay
    # green while only the reversed-declaration one went red.
    assert a != sorted(a), ("source 0 is in sorted order — 'source-0 order' and 'sorted "
                           "order' cannot be told apart in the forward test", a)
    assert b != sorted(b), ("source 1 is in sorted order — the reversed-declaration test "
                            "then cannot tell them apart either", b)


@pytest.mark.parametrize("authority", ["ds-a", "ds-b"])
def test_the_unified_entity_ORDER_follows_SOURCE_0_not_the_AUTHORITY(tmp_path, authority):
    """R3T2 — `authority` selects whose ANNOTATION labels an entity, never the axis ORDER.

    Measured in the engine: `resolve_features` emits *"the first source's own order,
    filtered — so the axis is a deterministic function of the inputs rather than of set
    iteration"*. The mode does not enter into it.

    That is a contract worth pinning precisely BECAUSE it reads like a bug: a reader who
    knows `authority` means "ds-b's annotation wins" can reasonably assume ds-b's order wins
    too, and "fix" it. Parametrized over both authorities so the assertion is that the order
    is INVARIANT under the choice — a single-authority test would leave "it happens to equal
    the authority's order" alive whenever the authority IS source 0.
    """
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol", "mode": "authority", "authority": authority},
        sources=AUTHORITY_ORDER_SOURCES,
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    emitted = txr_zarr_read.read_strings(root, "unified_key")

    source_0_order = [k for k in AUTHORITY_ORDER_SOURCES[0][1]["entity_keys"] if k in emitted]
    source_1_order = [k for k in AUTHORITY_ORDER_SOURCES[1][1]["entity_keys"] if k in emitted]
    assert emitted == source_0_order, (
        f"under authority={authority} the unified entity axis came out {emitted}, not "
        f"source 0's order {source_0_order}"
    )
    assert emitted != source_1_order, (
        "source 0 and source 1 agree on order in this fixture, so the assertion above "
        "cannot discriminate"
    )
    # …and the ANNOTATION still follows the authority — the thing the mode DOES control,
    # asserted alongside so a change that swapped the two is caught by one of the pair.
    labels = txr_zarr_read.read_strings(root, "unified_ensembl_id")
    assert labels[emitted.index("C")] == ("E3" if authority == "ds-a" else "E7"), labels


def test_the_unified_order_TRACKS_source_0_rather_than_being_constant(tmp_path):
    """The other half of the pin: reversing the DECLARATION reverses the emitted order.

    Without this, "the order equals ds-a's order" is satisfied just as well by a producer
    that sorts, or one that hardcodes a list. Declaring ds-b first must move the axis to
    ds-b's order — which is what makes the previous test a statement about source 0 rather
    than about ds-a.
    """
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol", "mode": "authority", "authority": "ds-a"},
        sources=list(reversed(AUTHORITY_ORDER_SOURCES)),   # ds-b declared FIRST
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    emitted = txr_zarr_read.read_strings(root, "unified_key")

    now_source_0 = [k for k in AUTHORITY_ORDER_SOURCES[1][1]["entity_keys"] if k in emitted]
    assert emitted == now_source_0, (
        f"declaring ds-b first did not move the unified axis to its order: {emitted} vs "
        f"{now_source_0}. The order is not tracking source 0 — it is constant or sorted"
    )


@pytest.mark.parametrize("values,kind", [
    (["b", "a", "b"], "string"),
    ([1.5, 2.5, 3.5], "numeric"),
    ([True, False, True], "numeric"),
])
def test_a_NON_CATEGORICAL_level_binding_is_REFUSED_not_fabricated(tmp_path, values, kind):
    """R3C3 — fusing a column with no declared level set invented one, twice over.

    A categorical member stamps `kind: categorical` + `levels`, and the producer indexes its
    lookups by that DECLARED code space. A string / numeric member stamps neither, so the
    engine fell back to OBSERVATION order and fabricated a level set — and then recorded
    that fabrication in `source_declared_orders`, ITEM-14's evidence record, whose entire
    purpose is preserving what each source DECLARED.

    Both failures were silent, and the second is the worse one: a reader inspecting the
    alignment to see what order a source declared would be shown first-appearance order of
    whatever values happened to occur, presented as a declaration. INV-15 is exactly this
    line — record what was observed, do not assert what was not — so there is no honest
    fallback and the run refuses.

    Parametrized over all three non-categorical stampings the writer can produce, measured:
    a plain string → `string`; int/float/bool → `numeric`.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    # Replace ds-a's fused column with a non-categorical of the same length.
    mount = mount_for(inputs, "level:0:celltype")
    shutil.rmtree(mount)
    write_column_artifact(mount, "celltype", values, axis="rows")
    stamped = txr_zarr_read.read_meta(mount, "values")["attributes"]["txr"]
    # THE FIXTURE PROPERTY, asserted before the behaviour that depends on it: this member
    # really is the kind the test claims, and really carries no declared level set.
    assert stamped.get("kind") == kind, stamped
    assert "levels" not in stamped, stamped

    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0, (
        "the producer fused a column with no declared level set — it invented one from "
        "observation order and recorded the invention as declared evidence"
    )
    assert "level:0:celltype" in proc.stderr, proc.stderr
    if kind == "string":
        # A STRING column is refused for a different reason than a numeric one, and the
        # message must say which: its values are its own labels, so the data is fine and
        # the fix is at import. Conflating the two sent a user chasing the wrong fix.
        assert "at IMPORT" in proc.stderr and "not a problem with your data" in proc.stderr, \
            proc.stderr
    else:
        assert kind in proc.stderr, proc.stderr
    assert not (outputs / "manifest.json").exists()


def test_a_CATEGORICAL_level_binding_is_the_positive_control(tmp_path):
    """…and the refusal must not swallow the case it exists to protect.

    Without this, "refuses a non-categorical" is indistinguishable from "refuses every
    `level:` binding", which would disable level fusion entirely while looking like a fix.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    stamped = txr_zarr_read.read_meta(
        mount_for(inputs, "level:0:celltype"), "values")["attributes"]["txr"]
    assert stamped.get("kind") == "categorical" and "levels" in stamped, stamped
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    lookups = [m for m in txr_zarr_read.structure(root)["aux"]
               if m["role"] == "alignment_level_lookup"]
    assert len(lookups) == len(TWO_SOURCES), [m["path"] for m in lookups]


def test_no_analysis_here_is_LAUNCHABLE_without_a_form(tmp_path):
    """R3C6 — a user could launch an analysis that presents them nothing.

    `embedding.join-quality` has no `ui:` and never will: it is read BY the integration form
    through `job.result`, not opened by a person. Without `launchable: false` it appeared in
    the launcher as an ordinary entry, so launching it produced a run whose output the user
    had no surface to read.

    The assertion is the INVARIANT, not the line — *every* analysis in this manifest that
    declares no `ui:` must declare `launchable: false*. A per-analysis assertion would go
    stale the moment a third one is added, which is how this defect arrived: the second
    analysis was written by copying the first, and the first's `launchable: false` was
    already there for an unrelated reason.

    (The two are `false` for different reasons and only one is temporary — `embedding.
    integrate`'s comes out when stage 3's form lands, `join-quality`'s never does. This test
    keeps holding across that change, because it keys on `ui:` rather than on the id.)
    """
    import yaml

    manifest = yaml.safe_load(
        (PACKAGES / "embedding-integrate" / "manifest.yaml").read_text())
    analyses = manifest["contributes"]["analyses"]
    assert len(analyses) >= 2, f"only {len(analyses)} analyses — the fixture shrank"
    formless = [a for a in analyses if not a.get("ui")]
    assert formless, "every analysis declares a `ui:` — this test no longer discriminates"
    offenders = [a["id"] for a in formless if a.get("launchable") is not False]
    assert not offenders, (
        f"{offenders} declare no `ui:` but are launcher-visible — a user can launch them and "
        "be shown nothing. Add `launchable: false`, which keeps the analysis registered "
        "while removing it from the launcher"
    )


def test_two_slots_that_SANITIZE_ALIKE_still_read_their_OWN_values(tmp_path):
    """A column name containing `:` collides on the derived mount name. Measure, don't copy.

    `sanitize_path_component` maps every non-`[A-Za-z0-9._-]` char to `_`, so the slots
    `entity:0:g:1` and `entity:0:g_1` both derive `entity_0_g_1.zarr`. `cell-filter` refuses
    exactly this case, on resolved-mount equality, saying *"the later stage overwrote the
    earlier, so both columns would read the same values"*.

    **That refusal is no longer reachable, and this was measured rather than assumed.**
    Driving the real `derive_artifact_mount_name` + `unique_mount_name` shows the second
    binding is staged as `entity_0_g_1_1.zarr` — the runner disambiguates, so nothing is
    overwritten. Copying cell-filter's guard here would have added a test that cannot fail.

    So this asserts the property that DOES hold and that this compute depends on: each
    binding resolves the mount recorded for ITS OWN slot in `inputs.json`, and two
    alike-sanitizing slots therefore read different values. If the runner ever stopped
    disambiguating, this goes red with a wrong VALUE rather than a passing tautology.
    """
    sources = [
        ("ds-a", {"entity_keys": ["A", "B"], "ensembl": None,
                  "row_keys": ["a-0"], "celltypes": None}),
        ("ds-b", {"entity_keys": ["A", "B"], "ensembl": None,
                  "row_keys": ["b-0"], "celltypes": None}),
    ]
    # `key` must be bound for every dataset, so the colliding pair is an EXTRA column on
    # ds-a: `g:1` (values distinct from `g_1`) alongside it.
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=sources)
    used = {Path(e["sandbox_path"]).name
            for e in json.loads((inputs / "inputs.json").read_text())["inputs"]}
    for slot, values in (("entity:0:g:1", ["X", "Y"]), ("entity:0:g_1", ["P", "Q"])):
        mount = unique_mount_name(derive_mount_name(slot), used)
        write_column_artifact(inputs / mount, slot, values, axis="entities")
        index = json.loads((inputs / "inputs.json").read_text())
        index["inputs"].append({"slot": slot, "kind": "artifact",
                                "content_hash": f"sha256:{slot}",
                                "sandbox_path": f"/inputs/{mount}"})
        (inputs / "inputs.json").write_text(json.dumps(index, indent=2))

    a, b = mount_for(inputs, "entity:0:g:1"), mount_for(inputs, "entity:0:g_1")
    assert a != b, f"the two alike-sanitizing slots share one mount ({a}) — the runner "\
                   "stopped disambiguating, and the later binding now overwrites the earlier"
    assert txr_zarr_read.read_strings(a, "values") == ["X", "Y"]
    assert txr_zarr_read.read_strings(b, "values") == ["P", "Q"]
    # …and the run still succeeds, reading each cell of the grid from its own slot.
    run_producer(inputs, outputs)
    assert (outputs / "manifest.json").exists()


def test_the_REFERENCE_artifacts_carry_NO_domain_vocabulary(tmp_path):
    """The emitted reference fixture must satisfy CORE's domain-freedom rule, not ours.

    `embedding-integrate` is a single-cell package and is entitled to domain vocabulary in
    its own tree — every other fixture in this file uses it. The reference artifacts are the
    exception, because they do not STAY in this tree: they are consumed by core's
    `zarrReader` parity tests and land under `ui/src/core/workstore/__fixtures__/`, where
    `lint-no-domain-in-builtin` scans them. A consumer cannot fix a leak there by editing —
    regenerating restores whatever the emitter writes — so it has to be caught HERE.

    The token list is READ OUT OF THE GUARD, not copied. A copied list is a second source of
    truth that goes stale silently, and the failure mode is the worst kind: this test stays
    green while the guard it claims to anticipate goes red in someone else's workspace.
    """
    guard = (PACKAGES.parent / "ui" / "scripts" / "lint-no-domain-in-builtin.mjs")
    if not guard.exists():                      # pragma: no cover - guard relocated
        pytest.skip(f"the domain guard is not at {guard}")
    block = re.search(r"const DOMAIN_NOUNS = \[(.*?)\]", guard.read_text(), re.S)
    assert block, "could not read DOMAIN_NOUNS out of the guard — the reader has drifted"
    nouns = re.findall(r"'([^']+)'", block.group(1))
    # VACUITY GUARD: an empty scrape would approve every token in the tree.
    assert len(nouns) > 20, f"only {len(nouns)} domain nouns scraped: {nouns}"

    out = tmp_path / "ref"
    proc = subprocess.run(
        [sys.executable, str(PACKAGES / "embedding-integrate" / "tools"
                             / "emit_reference_alignment.py"), str(out)],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr

    # Every byte a consumer commits: the manifest AND every `zarr.json` in the store.
    scanned, leaks = 0, {}
    for path in [out / "outputs" / "manifest.json",
                 *sorted((out / "outputs" / "alignment.zarr").rglob("zarr.json"))]:
        scanned += 1
        text = path.read_text().lower()
        hits = sorted({n for n in nouns if re.search(rf"(?<![a-z]){re.escape(n)}(?![a-z])",
                                                     text)})
        if hits:
            leaks[str(path.relative_to(out))] = hits
    assert scanned > 3, f"only {scanned} reference files scanned — the fixture shrank"
    assert not leaks, (
        f"the reference fixture carries domain vocabulary that core's guard will flag: "
        f"{leaks}. Rename it in `tools/emit_reference_alignment.py` — a consumer cannot fix "
        "this by editing the fixture, because regenerating restores it."
    )


def test_the_FIXTURE_gives_the_two_datasets_DIFFERENT_row_hashes(tmp_path):
    """The fixture property the mis-ordering test depends on, asserted SEPARATELY.

    `test_a_MIS_ORDERED_id_relay_is_REFUSED…` reverses `dataset_ids` and requires a refusal.
    That assertion is only about the CODE if the two `rows` bindings carry DIFFERENT content
    hashes — if they happened to be equal, reversing the ids would still match at every
    position and the test would be passing on the fixture's coincidence rather than on the
    cross-check. Four such coincidences have already been found on this branch (segment
    order, declared levels, authority vocabulary, mount-name vs dataset id), so the property
    is asserted rather than assumed, and asserted apart from the behaviour it enables.

    It also pins the referent that MOVED in the slot rework: the cross-check used to compare
    against the single per-dataset artifact's hash, and there is no longer such an artifact.
    It now compares against the `rows` binding, so THAT is the hash which must discriminate.
    """
    inputs, _outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    index = json.loads((inputs / "inputs.json").read_text())
    rows = [e["content_hash"] for e in index["inputs"] if e["slot"] == "rows"]
    assert len(rows) == len(TWO_SOURCES), rows
    assert len(set(rows)) == len(rows), (
        f"the fixture gives two datasets the SAME `rows` content_hash ({rows}) — reversing "
        "the id relay would then still match at every position, so the mis-ordering test "
        "would be asserting a coincidence rather than the cross-check"
    )
    params = json.loads((inputs / "params.json").read_text())
    assert sorted(params["dataset_content_hashes"].values()) == sorted(rows), params


def test_the_relay_and_the_hashes_AGREEING_is_the_positive_control(tmp_path):
    """…and the cross-check must not refuse a correctly-ordered relay."""
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    ids = [s["dataset_id"] for s in entry_for(manifest, "dataset-alignment")["meta"]["sources"]]
    assert ids == [d for d, _ in TWO_SOURCES], ids


def test_authority_is_keyed_on_the_SAME_value_the_relay_carries(tmp_path):
    """A user picks `authority` by dataset; the alignment records sources by dataset id.
    They must be the same value, or the pipeline refuses a choice the form offered.

    Before this, `authority` was compared against the MOUNT-NAME list, so an id a user could
    actually pick could never match and the run failed inside the sandbox minutes later.
    """
    inputs, outputs = stage_run(
        tmp_path,
        params={"key": "symbol",
                "mode": "authority", "authority": "ds-b"},
        sources=CONFLICTING_SOURCES,
    )
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    meta = entry_for(manifest, "dataset-alignment")["meta"]
    assert meta["authority"] == "ds-b", meta
    assert "ds-b" in [s["dataset_id"] for s in meta["sources"]], meta["sources"]
    assert not any(
        s["dataset_id"].startswith("datasets") for s in meta["sources"]
    ), f"a mount name reached meta.sources: {meta['sources']}"


# ── S9 — the `/inputs` remainder is CONTAINED ────────────────────────────────────


@pytest.mark.parametrize("sandbox_path,why", [
    ("/inputs/../escape.zarr", "a traversal component"),
    ("/inputs/nested/dir.zarr", "a multi-component remainder"),
])
def test_a_binding_whose_path_ESCAPES_the_inputs_root_is_REFUSED(tmp_path, sandbox_path, why):
    """S9 — the remainder was joined onto `inputs_dir` verbatim.

    `inputs.json` is server-written, so this is defence-in-depth rather than a reachable
    exploit. It is worth closing because the trust chain is longer than it looks: the
    runner's `validate_subpath` guards the name it DERIVES, while this loader reads the name
    it RECORDED, and those coincide only while nobody introduces a path this compute did not
    stage.

    The slot rework also made it load-bearing in a way the original finding could not have
    known: this loader's output now keys the whole dataset x column grid, so a binding that
    resolved somewhere unexpected would be read as a cell of it.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)

    # THE TARGET MUST EXIST, and this is the whole difficulty of testing containment.
    #
    # My first version pointed at a path that did not exist. The run still failed — but at
    # `require_mount`'s `.exists()` check, naming the same slot — so the test passed with the
    # containment check DELETED. Measured: disabling both halves left it green. A refusal
    # that happens for a different reason is not evidence for the reason you are asserting.
    #
    # So the escape target is a REAL store. With containment removed the producer reads it
    # as a cell of the grid and the run proceeds; the only thing that can refuse it now is
    # the check under test.
    target = (inputs / sandbox_path[len("/inputs/"):])
    target.parent.mkdir(parents=True, exist_ok=True)
    write_column_artifact(target, "evil", ["A", "B", "C", "A_ONLY"], axis="entities")
    assert target.exists(), target

    index = json.loads((inputs / "inputs.json").read_text())
    index["inputs"].append({"slot": "entity:0:evil", "kind": "artifact",
                            "content_hash": "sha256:x", "sandbox_path": sandbox_path})
    (inputs / "inputs.json").write_text(json.dumps(index, indent=2))
    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0, f"{why} was resolved rather than refused"
    assert "entity:0:evil" in proc.stderr, proc.stderr
    # …and specifically for CONTAINMENT, not because the mount was missing.
    assert "not present under /inputs" not in proc.stderr, (
        "the run refused because the mount was absent, not because the path escaped — the "
        "fixture is not exercising the containment check", proc.stderr)
    assert not (outputs / "manifest.json").exists()


def test_an_ORDINARY_binding_path_is_the_positive_control(tmp_path):
    """…and the containment check must not refuse the paths the runner actually writes."""
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    paths = [e["sandbox_path"]
             for e in json.loads((inputs / "inputs.json").read_text())["inputs"]]
    assert all(p.startswith("/inputs/") and "/" not in p[len("/inputs/"):] for p in paths), paths
    run_producer(inputs, outputs)
    assert (outputs / "manifest.json").exists()


def test_the_THREE_SOURCE_reference_fixture_has_a_NON_INVOLUTIVE_permutation(tmp_path):
    """Stage 2's request, measured — and the request as posed was not constructible.

    They asked for a fixture where `meta.sources` order and `params.dataset_ids` order
    DISAGREE. Measured: those are **one channel, not two.** `load_grid` builds the sources
    list by enumerating the relayed ids, `alignment_metadata` projects `meta.sources` from
    that same list, and `build_segments` takes both `source_index` and `declared_order` from
    `enumerate(sources)` with one segment per source. All four are the same permutation by
    construction, so a fixture asserting they differ would assert a fiction.

    What IS a real degeneracy in the same family: with TWO sources the segment permutation
    is `[1, 0]`, **its own inverse**. A consumer that inverts the segment→source mapping is
    wrong and passes against every two-source fixture. Three sources is the smallest
    arrangement that separates the two readings.

    This asserts the fixture EXHIBITS that property — separately from any assertion that a
    consumer handles it, which is the half stage 1 can enforce alone.
    """
    out = tmp_path / "ref3"
    proc = subprocess.run(
        [sys.executable,
         str(PACKAGES / "embedding-integrate" / "tools" / "emit_reference_alignment.py"),
         str(out), "--three-sources"],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr

    root = out / "outputs" / "alignment.zarr"
    perm = [int(x) for x in txr_zarr_read.read_array(root, "segment_dataset").tolist()]
    assert len(perm) >= 3, f"two sources cannot express this property; got {perm}"
    assert sorted(perm) == list(range(len(perm))), perm
    inverse = [perm.index(i) for i in range(len(perm))]
    assert perm != inverse, (
        f"the segment permutation {perm} is its own inverse, so a consumer that inverts the "
        "segment->source mapping passes against this fixture"
    )
    # …and the ARRAY order still disagrees with the declared order (the exit-2 property),
    # so the new fixture does not quietly lose what the other three protect.
    assert txr_zarr_read.read_array(root, "segment_start").tolist() != sorted(
        txr_zarr_read.read_array(root, "segment_start").tolist()
    ), "segment_start is ascending across the array — array order and declared order agree"


def test_meta_sources_and_dataset_ids_are_ONE_channel_by_construction(tmp_path):
    """The measurement behind the test above, pinned so the claim is not just prose.

    If a future change ever made these two genuinely independent, this goes red — and at
    that point a fixture making them disagree becomes both constructible and necessary.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    meta = entry_for(manifest, "dataset-alignment")["meta"]
    params = json.loads((inputs / "params.json").read_text())
    assert [s["dataset_id"] for s in meta["sources"]] == params["dataset_ids"], (
        "meta.sources and params.dataset_ids have diverged — they were one permutation by "
        "construction, so this is a real second channel now and needs a disagreeing fixture"
    )


# ── D8 — the ENTITY axis gets a digest, so the docstring's claim becomes true ─────


def test_the_alignment_records_an_ENTITY_axis_digest_per_source(tmp_path):
    """D8 — `SourceTable`'s docstring said the digest made entity-order failure detectable.

    It did not. `key_sequence_digest` digests the ROW axis, because the ROW vector indexes
    into rows. **Nothing digested the entity axis at all**, so the failure the docstring
    named as detectable was the one with no detector — a claim the code contradicted, which
    is the shape that has been the false premise twice on this branch.

    The fix is to make the claim TRUE rather than to delete it, because the gap was real:
    `entity_index` is positional into each source's entity columns, so a source whose entity
    order changed under the alignment returns the right NUMBER of the WRONG entities. That
    is ITEM-9's failure on the other axis, and it was unanchored.

    The digest is the one the SOURCE ARTIFACT declares (`key_sequence_digest` when the
    column carries the axis's keys, else `aligned_to`) — never recomputed here, because a
    producer holding one column does not hold the axis's key sequence and a digest invented
    from what it happens to have would agree with nothing.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    records = entry_for(manifest, "dataset-alignment")["meta"]["sources"]

    for record in records:
        assert "entity_axis_digest" in record, (
            "the key is absent, so a reader cannot tell 'not checkable' from 'not recorded'",
            record)
        assert record["entity_axis_digest"], record

    # THE FIXTURE MUST DISAGREE, or this asserts a coincidence. The two datasets' entity
    # orders differ (ds-a: A,B,C,A_ONLY; ds-b: B_ONLY,C,B,A), so their axes are genuinely
    # different row spaces and the two digests MUST differ. Equal digests here would mean
    # the producer is recording one source's axis for both.
    digests = [r["entity_axis_digest"] for r in records]
    assert len(set(digests)) == len(digests), (
        f"both sources recorded the same entity_axis_digest {digests} — either the fixture's "
        "entity orders coincide (so this test proves nothing) or the producer is attributing "
        "one source's axis to the other")

    # …and it is a DIFFERENT number from the row digest. They are two axes; a producer that
    # recorded the row digest under both names would satisfy every assertion above.
    for record in records:
        assert record["entity_axis_digest"] != record["key_sequence_digest"], record


def test_an_UNDECLARED_entity_axis_reads_as_CANNOT_BE_CHECKED_not_as_matching(tmp_path):
    """`None`, explicitly — the same rule ITEM-9 applies to the row digest.

    Load-bearing rather than pedantic: `aligned_to` landed on 2026-08-13, and measured on
    the live catalog **0 of 78** metadata-columns ingested before that date carry one. So
    the common case for existing data is exactly this one, and it must read as "unknown"
    rather than silently as agreement.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    # Strip the declaration from ds-a's entity columns, as a pre-2026-08-13 artifact has it.
    for column in ("symbol", "ensembl_id"):
        store = mount_for(inputs, f"entity:0:{column}")
        node = json.loads((store / "zarr.json").read_text())
        txr = node["attributes"]["txr"]
        txr.pop("aligned_to", None)
        txr.pop("key_sequence_digest", None)
        (store / "zarr.json").write_text(json.dumps(node, indent=2))

    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    records = entry_for(manifest, "dataset-alignment")["meta"]["sources"]
    assert records[0]["entity_axis_digest"] is None, records[0]
    # …and the OTHER source, which still declares one, is unaffected — absence is per-source
    # rather than a switch that turns the whole record off.
    assert records[1]["entity_axis_digest"], records[1]


# ── H5 / H6 — the two channels the READER parses, pinned on the producer side ─────
#
# Both were found by mutating the producer and watching this suite stay green, and both
# are silent-wrong-DATA rather than crashes. They share a shape: the producer emits a
# value the Rust reader consumes POSITIONALLY or LITERALLY, and every fixture here made
# the wrong answer indistinguishable from the right one.


def test_meta_sources_is_in_DECLARED_order_not_sorted(tmp_path):
    """H5 — `meta.sources[]` ORDER selects the dataset, and nothing pinned it.

    The Rust reader zips this list positionally in three places, so element `i` IS source
    `i`. Emitting it sorted by `dataset_id` instead of in declared order makes `resolve_row`
    gather one dataset's rows from another's artifact: right count, clean console.

    **`verify_leaf_digest` cannot catch it**, and that is the subtle part: the digest and the
    dataset id travel in the SAME record, so a permutation moves them together and every
    check stays self-consistent. The only thing that can catch it is an assertion about the
    ORDER itself.

    THE FIXTURE MUST DECLARE NON-ALPHABETICALLY or the test proves nothing — sorted order and
    declared order coincide for `[ds-a, ds-b]`, which is what every existing fixture used and
    why a `sorted()` mutation left 216/216 green.
    """
    declared = list(reversed(TWO_SOURCES))          # ds-b FIRST — deliberately not sorted
    ids = [d for d, _ in declared]
    assert ids != sorted(ids), (
        "the fixture declares its sources alphabetically, so declared order and sorted order "
        "coincide and this assertion cannot discriminate", ids)

    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=declared)
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    meta = entry_for(manifest, "dataset-alignment")["meta"]
    emitted = [s["dataset_id"] for s in meta["sources"]]

    assert emitted == ids, (
        f"meta.sources came out {emitted}, not the DECLARED order {ids}. A reader zipping "
        "this list positionally would attribute one dataset's rows to another")
    assert emitted != sorted(emitted), (
        "meta.sources is in sorted order — indistinguishable from a producer that sorts")

    # The segment table indexes INTO this list, so the two must agree about which source is
    # which. Asserted here because a fix that reordered one and not the other would satisfy
    # the assertion above while breaking the thing it protects.
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    seg_dataset = txr_zarr_read.read_array(root, "segment_dataset").tolist()
    seg_order = txr_zarr_read.read_array(root, "segment_order").tolist()
    for source_index, declared_order in zip(seg_dataset, seg_order):
        assert emitted[int(source_index)] == ids[int(declared_order)], (
            emitted, ids, seg_dataset, seg_order)


def test_the_LEVEL_LOOKUP_member_names_carry_column_and_source_index_verbatim(tmp_path):
    """H6 — the `levels__<column>__<index>` literal is the SOLE channel for that pair.

    The Rust reader parses this member NAME to learn which (column, source) a lookup belongs
    to. Renaming the prefix to `lvl__` leaves this suite green — the conformance gate is
    prefix-agnostic and every other test addresses lookups by ROLE — and the reader then
    creates **no fused columns at all**: the virtual dataset ships with only its key column,
    the categorical the user asked to unify silently absent. No crash, no refusal, no log.

    So the literal is asserted as a literal, spelled out rather than rebuilt from the same
    f-string the producer uses — a test that composed the name the same way would rename
    itself alongside the producer and stay green.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    root = outputs / entry_for(manifest, "dataset-alignment")["path"]
    structure = txr_zarr_read.structure(root)

    lookups = {m["path"] for m in structure["aux"] if m["role"] == "alignment_level_lookup"}
    # SPELLED OUT. `celltype` is the fixture's fused column; one lookup per source.
    assert lookups == {"levels__celltype__0", "levels__celltype__1"}, (
        f"the level-lookup member names are {sorted(lookups)}. The reader parses this exact "
        "literal to recover (column, source_index); any other spelling makes it find no "
        "fused columns and ship a virtual dataset with the requested column silently absent")

    # …and the bytes are reachable under those exact names, so the assertion is about the
    # emitted store rather than about the declaration alone.
    for name in sorted(lookups):
        assert (root / name / "zarr.json").exists(), name


@pytest.mark.parametrize("n_sources,carriers", [(2, 1), (3, 2)])
def test_a_level_column_NOT_carried_by_every_source_is_REFUSED_today(tmp_path,
                                                                     n_sources, carriers):
    """H4 — pins the CURRENT behaviour, which the producer's comment used to contradict.

    The comment claimed *"the engine's `strict` union handles"* a column present in only one
    source. It does not: `build_vectors` raises, naming the source that lacks it. I wrote
    that claim during the slot rework without verifying it.

    **This test pins the refusal, it does not endorse it.** The refusal is loud and safe, but
    it disagrees with the form, which offers any column carried by >=2 of the chosen
    datasets — so with >=3 datasets the form says `ready` and the job dies in the sandbox.
    The resolution is the same mechanism C4 needs (a declared missing level, so a source that
    does not carry the column maps entirely to it); until that lands the UI threshold must be
    "carried by ALL selected datasets", because **the form must never be more permissive than
    the compute**.

    When the mechanism lands this test inverts — deliberately, and the docstring is what
    tells the next author that the red is expected rather than a regression.
    """
    letters = "abcdefghij"
    sources = [
        (f"ds-{letters[i]}", {
            "entity_keys": ["A", "B", "C"],
            "ensembl": ["E1", "E2", "E3"],
            "row_keys": [f"{letters[i]}-0", f"{letters[i]}-1"],
            # Only the first `carriers` datasets carry the fused column.
            "celltypes": ["T", "B"] if i < carriers else None,
        })
        for i in range(n_sources)
    ]
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=sources)
    # FIXTURE PROPERTY: some sources bind the column and at least one does not.
    slots = {e["slot"] for e in json.loads((inputs / "inputs.json").read_text())["inputs"]}
    bound = {s for s in slots if s.startswith("level:")}
    assert len(bound) == carriers and carriers < n_sources, (bound, carriers, n_sources)

    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0, (
        "the producer fused a column that not every source carries — if this now SUCCEEDS, "
        "the C4/H4 missing-level mechanism has landed and this test should be inverted")
    missing = f"ds-{letters[n_sources - 1]}"
    assert missing in proc.stderr and "is not carried by source" in proc.stderr, proc.stderr


# ── M5 / M6 — three guards and a record, each deletable with the suite green ──────


def test_source_declared_orders_records_the_ORDER_THE_SOURCE_STORED(tmp_path):
    """M5 — the record whose stated purpose is *"record what was observed"* could record an
    invention: replacing the emitted orders with `reversed(...)` left the suite green.

    ITEM-14/INV-15 is the whole point of this field — a fused column claims no order, so the
    per-source declared orders are the ONLY surviving evidence of what each source actually
    said. Evidence nobody checks is not evidence.

    Asserted against the STORE, not against the fixture's input lists: the claim is that the
    alignment recorded what the source's bytes declare.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    run_producer(inputs, outputs)
    manifest = json.loads((outputs / "manifest.json").read_text())
    recorded = entry_for(manifest, "dataset-alignment")["meta"]["source_declared_orders"]
    assert "celltype" in recorded, recorded

    for i, (dataset_id, _spec) in enumerate(TWO_SOURCES):
        stored = list(txr_zarr_read.read_meta(
            mount_for(inputs, f"level:{i}:celltype"), "values"
        )["attributes"]["txr"]["levels"])
        assert recorded["celltype"][dataset_id] == stored, (
            f"{dataset_id}: recorded {recorded['celltype'][dataset_id]} but the source store "
            f"declares {stored} — the evidence record is describing something else")
        # AND the fixture must make order matter: a palindromic level set would satisfy the
        # assertion under `reversed()` too.
        assert stored != list(reversed(stored)), (dataset_id, stored)


def test_a_source_whose_DECLARATION_and_BYTES_disagree_is_REFUSED(tmp_path):
    """M6 — ITEM-9's ask-the-referent guard, which had never been observed firing.

    `check_declared_key_digest` recomputes the row-axis digest from the bytes it just decoded
    and refuses a mismatch. Stubbing it to `return` left the suite green, so the guard was
    installed and unexercised — the guards-the-call-not-the-installation shape.

    The corruption is applied to the STORED DECLARATION rather than to the bytes, because
    that is the direction that survives: an artifact whose `key_sequence_digest` no longer
    describes its own keys is exactly what a re-ingested-under-the-same-id source looks like,
    and a positional row vector over it addresses the wrong rows with every count agreeing.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    store = mount_for(inputs, "rows", 0)
    node = json.loads((store / "zarr.json").read_text())
    real = node["attributes"]["txr"]["key_sequence_digest"]
    node["attributes"]["txr"]["key_sequence_digest"] = "sha256:" + "0" * 64
    (store / "zarr.json").write_text(json.dumps(node, indent=2))
    assert real != "sha256:" + "0" * 64

    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0, "a source whose declaration and bytes disagree was aligned"
    assert "parted company" in proc.stderr, proc.stderr
    assert not (outputs / "manifest.json").exists()


def test_entity_columns_declaring_DIFFERENT_row_spaces_are_REFUSED(tmp_path):
    """M6b — the within-dataset `aligned_to` cross-check, neutralised with the suite green.

    Every entity column bound for one dataset is aligned to that dataset's entity axis, so a
    column bound under the WRONG dataset index declares a different row space. This is the
    only check on the entity half of the grid, and nothing exercised it.
    """
    inputs, outputs = stage_run(tmp_path, params={"key": "symbol"}, sources=TWO_SOURCES)
    # Give ds-a's `ensembl_id` binding ds-b's entity-axis digest — a column bound under the
    # wrong dataset index looks exactly like this from inside the sandbox.
    victim = mount_for(inputs, "entity:0:ensembl_id")
    other = mount_for(inputs, "entity:1:symbol")
    other_digest = json.loads((other / "zarr.json").read_text()
                              )["attributes"]["txr"]["key_sequence_digest"]
    node = json.loads((victim / "zarr.json").read_text())
    assert node["attributes"]["txr"].get("aligned_to") != other_digest
    node["attributes"]["txr"]["aligned_to"] = other_digest
    (victim / "zarr.json").write_text(json.dumps(node, indent=2))

    proc = run_producer(inputs, outputs, expect_ok=False)
    assert proc.returncode != 0, "columns declaring different row spaces were aligned anyway"
    assert "different row spaces" in proc.stderr, proc.stderr
