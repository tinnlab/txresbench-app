#!/usr/bin/env python3
# ruff: noqa
"""annotation-integrate — the I/O CONTRACT suite (the half that was missing).

## Why this file exists

`_helpers/tests/test_integrate.py` covers `annotation_integrate.integrate()` — the PURE
core, whose signature is `(axis_keys: list, table_rows, axis_name)`. That shape is exactly
why artifact-model ITEM-26 broke this processor with every gate green: the core takes the
axis keys as an already-decoded Python list, so it cannot see the FORMAT they arrive in.
ITEM-26 moved a dataset's axis index from a single-file `metadata/{id}.json` to a Zarr
STORE DIRECTORY `metadata/{id}.zarr` and migrated this processor's OUTPUT side only. The
input side kept doing `Path(path).read_text()`, which on a directory raises
`IsADirectoryError` — not in the `(ValueError, TypeError)` the loader caught — so the live
integrate job (`dataset::process.rs` → `annotation-integrate/annotation_integrate.py`)
failed on every run, and no suite in the tree could observe it.

So this suite asserts the things the pure core structurally cannot:

  * `load_axis_index` decodes a REAL Zarr axis index — written here by the branch's OWN
    writer, `cyto_columns.write_metadata_column(..., holds_axis_keys=True)`, the same call
    `anndata-import/compute/h5ad_import.py` emits `<axis>_index` through. A hand-rolled
    `zarr.json` fixture would only pin this suite's guess at the format; going through the
    writer means the format is whatever the producer actually writes.
  * `resolve_slot` finds that store directory, under BOTH names the coordinator can stage
    it as, and never returns the sandbox's own derived `inputs.json`/`params.json`.
  * the REAL `main()` end-to-end over a genuine `/inputs` tree (annotation CSV + Zarr axis
    index + `inputs.json` + `params.json`, mirroring `build_integrate_inputs`), asserting
    the VALUES of the emitted columns read back off disk — "it did not throw" would pass
    on an empty result, which is precisely how a 0-match degraded alignment used to look
    like success.
  * the retired single-file-JSON form raises a NAMED error instead of silently yielding
    garbage keys (the old loader's `text.splitlines()` fallback over a store's gzipped
    shard bytes).

Style mirrors `cell-filter/tests/test_cell_filter.py`: explicit `sys.path` wiring for the
globally-staged helpers (so the suite runs standalone as well as under the `packages/`
rootdir conftest), a synthetic-but-REAL run directory, and reads back through the `_lib`
reference reader rather than a second decoder.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# The globally-staged helper packages (`sandbox/processors/mod.rs::PY_HELPER_FILES`):
# `_lib` holds the Zarr writer/reader, `_helpers` the align + colsummary engines. The
# entry itself lives one level up.
_HERE = Path(__file__).resolve().parent
_PROCESSORS = _HERE.parent.parent
for _p in (_PROCESSORS / "_lib", _PROCESSORS / "_helpers", _HERE.parent):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import cyto_columns  # noqa: E402  (the BRANCH'S OWN writer — the format's producer)
import cyto_zarr_read  # noqa: E402  (the `_lib` reference reader)
import annotation_integrate as ai  # noqa: E402


# ─────────────────────────────── fixtures (real bytes, real writer) ───────────

#: The two subpaths the axis index can be staged under. `dataset::process::
#: build_integrate_inputs` declares `sandbox_subpath: format!("{axis}_index.zarr")`, so a
#: live run stages `cells_index.zarr`. It declared `…_index.json` until 2026-07-29 — a
#: Zarr STORE DIRECTORY wearing a single-file JSON name — and that spelling is KEPT here
#: deliberately, not as a leftover:
#:
#:   * it is what made the Rust rename a safe, independent change rather than a flag day
#:     needing both sides to land together;
#:   * pinning a test set to today's production spelling is the exact shape of the bug
#:     this suite exists for — ITEM-26 moved a writer and its reader stayed put. A suite
#:     that tracks one spelling cannot tell a rename from a regression.
#:
#: The extension is not the format in either direction: `load_axis_index` decides by
#: READING the store. Both names must resolve and both must decode, so every path-shaped
#: test runs over both.
STAGED_NAMES = ("cells_index.json", "cells_index.zarr")

BARCODES = ["AAACCTGAGAAACCAT-1", "AAACCTGAGAAAGTGG-1", "AAACCTGAGAACAATC-1"]


def write_axis_index(inputs_dir, subpath, keys=BARCODES, axis="cells", name=None):
    """Stage a REAL axis-index artifact through the branch's own writer.

    `holds_axis_keys=True` is the producer declaration that makes the writer record
    `structure.key` (WHICH member holds the ordered keys) + `structure.key_sequence_digest`
    — i.e. exactly what `h5ad_import` passes for `<axis>_index`, and what the loader now
    reads instead of assuming a member name.
    """
    import pandas as pd

    inputs_dir = Path(inputs_dir)
    inputs_dir.mkdir(parents=True, exist_ok=True)
    structure, meta = cyto_columns.write_metadata_column(
        inputs_dir, subpath, name or f"{axis}_index", pd.Series(keys),
        axis=axis, holds_axis_keys=True)
    return inputs_dir / subpath, structure, meta


#: The subpath a LIVE run stages the axis index at today, so the tests that are not
#: path-parametrized exercise the production spelling. The other member of
#: `STAGED_NAMES` is covered by the parametrized ones.
PRODUCTION_SUBPATH = "cells_index.zarr"


def write_run_dir(root, *, axis_subpath=PRODUCTION_SUBPATH, table_rows=None,
                  axis_keys=BARCODES, axis="cells", params=None, with_inputs_json=True):
    """A minimal but GENUINE integrate run directory → (inputs, outputs).

    Mirrors what `dataset::process::build_integrate_inputs` + `sandbox::inputs::
    materialize_inputs` actually put on disk: the annotation table at slot `annotation`,
    the axis index at slot `axis_index`, and the two DERIVED files (`inputs.json` +
    `params.json`) the sandbox binds read-only alongside them.
    """
    root = Path(root)
    inputs, outputs = root / "inputs", root / "outputs"
    inputs.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)

    rows = table_rows if table_rows is not None else [
        # Keyed by the BARE barcode: a correct run must normalize away the `-1` lane
        # suffix (DEC-18) to match the axis index above.
        {"barcode": k.split("-")[0], "cell_type": t, "score": s}
        for k, t, s in zip(axis_keys, ["T", "B", "NK"], [1.5, 2.5, 3.5])
    ]
    header = list(rows[0].keys())
    table = "\n".join([",".join(header)] + [
        ",".join(str(r[h]) for h in header) for r in rows])
    (inputs / "donor_meta.csv").write_text(table + "\n")

    write_axis_index(inputs, axis_subpath, keys=axis_keys, axis=axis)

    if with_inputs_json:
        (inputs / "inputs.json").write_text(json.dumps({"inputs": [
            {"slot": "annotation", "kind": "dataset-file",
             "sandbox_path": "/inputs/donor_meta.csv"},
            {"slot": "axis_index", "kind": "artifact",
             "sandbox_path": f"/inputs/{axis_subpath}"},
        ]}))
    bag = {"axis": axis, "seed": 0}
    bag.update(params or {})
    (inputs / "params.json").write_text(json.dumps(bag))
    return inputs, outputs


def run_main(inputs, outputs):
    """Execute the REAL entry over a run dir, restoring the env afterwards."""
    saved = {k: os.environ.get(k) for k in ("CYTO_INPUTS_DIR", "CYTO_OUTPUTS_DIR")}
    os.environ["CYTO_INPUTS_DIR"] = str(inputs)
    os.environ["CYTO_OUTPUTS_DIR"] = str(outputs)
    try:
        ai.main()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return json.loads((Path(outputs) / "manifest.json").read_text())["outputs"]


# ─────────────────────────────── load_axis_index ──────────────────────────────

@pytest.mark.parametrize("subpath", STAGED_NAMES)
def test_load_axis_index_decodes_the_real_zarr_store_the_writer_emits(subpath):
    """THE regression test for the ITEM-26 input-side break.

    Before the fix this raised `IsADirectoryError` from `Path(path).read_text()` — a
    directory is not text — and the entry's handler catches only `(ValueError, TypeError)`,
    so the live integrate job died with an opaque failure. Asserted on the VALUES: the
    keys must come back in AXIS ORDER, byte-identical to what the writer stored.
    """
    with tempfile.TemporaryDirectory() as td:
        path, structure, _ = write_axis_index(Path(td) / "inputs", subpath)

        assert path.is_dir(), (
            "the staged axis index is a Zarr STORE DIRECTORY — if this is a file the "
            "fixture is not exercising the format that broke")
        # The producer really did declare the two INV-3 facts the loader now reads.
        assert structure["key"] == "values" and structure["axis"] == "cells"
        assert structure["key_sequence_digest"], "the writer declared a key digest"

        keys, axis = ai.load_axis_index(path)

    assert keys == BARCODES, "the ordered axis keys, decoded off the real store"
    assert axis == "cells"


def test_load_axis_index_takes_the_axis_from_structure_not_from_the_label():
    """INV-3: an artifact's NAME is a label; its axis is what the producer DECLARED.

    The loader used to derive the axis by stripping `_index` off the artifact's `name`
    field, so an index whose label did not end in `_index` (or whose label named a
    different axis than the artifact) tagged every emitted column with the wrong axis.
    Here the store declares `axis="genes"` while carrying a label that says nothing —
    the declaration must win.
    """
    genes = ["ENSG00000141510", "ENSG00000012048"]
    with tempfile.TemporaryDirectory() as td:
        path, structure, _ = write_axis_index(
            Path(td) / "inputs", "some_label.json", keys=genes, axis="genes",
            name="not_an_index_name")
        assert structure["axis"] == "genes"
        keys, axis = ai.load_axis_index(path)

    assert keys == genes
    assert axis == "genes", (
        "the axis came from `structure.axis`; a name-derived axis would have said "
        "'not_an_index_name'")


def test_load_axis_index_stringifies_a_numeric_key_member():
    """An axis keyed by integers (sample ids, positional labels) decodes through the
    numeric member path — a numpy array — and must still hand `align` `str` keys, since
    the annotation table's own key column arrives as text from a CSV."""
    with tempfile.TemporaryDirectory() as td:
        import pandas as pd

        inputs = Path(td) / "inputs"
        inputs.mkdir(parents=True)
        cyto_columns.write_metadata_column(
            inputs, "samples_index.zarr", "samples_index",
            pd.Series([11, 22, 33], dtype="int64"), axis="samples",
            holds_axis_keys=True)
        keys, axis = ai.load_axis_index(inputs / "samples_index.zarr")

    assert keys == ["11", "22", "33"], "numeric keys arrive as strings, not numpy scalars"
    assert axis == "samples"


def test_load_axis_index_refuses_the_retired_single_file_json_form():
    """The pre-ITEM-26 form is deliberately UNREADABLE, and loudly so.

    Nothing in the tree writes it any more (`h5ad_import` is the only `<axis>_index`
    emitter and it writes Zarr) and migration `202608040001_artifact_model` does
    `DELETE FROM public.artifacts`, so no stored JSON index can be staged either. The
    decision is therefore "no compat path" — but it has to FAIL, not fall through: the
    old loader's `text.splitlines()` tail turned any non-JSON body into a plausible list
    of keys, i.e. a 0-match alignment reported as a clean run.
    """
    with tempfile.TemporaryDirectory() as td:
        legacy = Path(td) / "cells_index.json"
        legacy.write_text(json.dumps(
            {"name": "cells_index", "kind": "categorical", "values": BARCODES}))

        with pytest.raises(ValueError) as excinfo:
            ai.load_axis_index(legacy)

    msg = str(excinfo.value)
    assert "Zarr store" in msg, f"the error names the expected form; got {msg!r}"
    assert "cells_index.json" in msg, "the error names what it was handed"


def test_load_axis_index_never_invents_keys_from_opaque_bytes():
    """Handed a store's SHARD bytes as a single file, the loader refuses BY DESIGN.

    Asserted on the loader's OWN message, not merely on `ValueError`: `UnicodeDecodeError`
    is a `ValueError` subclass, so the retired `read_text()` path would have satisfied a
    bare `pytest.raises(ValueError)` by accident. The distinction that matters is a NAMED
    refusal ("not a Zarr store directory") versus a decode accident that, one byte
    differently, becomes a list of invented keys.
    """
    with tempfile.TemporaryDirectory() as td:
        store, _, _ = write_axis_index(Path(td) / "inputs", "cells_index.zarr")
        shard = next(p for p in store.rglob("*") if p.is_file() and p.parent.name == "c")
        opaque = Path(td) / "cells_index.json"
        opaque.write_bytes(shard.read_bytes())

        with pytest.raises(ValueError) as excinfo:
            ai.load_axis_index(opaque)

    assert "not a Zarr store directory" in str(excinfo.value)
    assert not isinstance(excinfo.value, UnicodeDecodeError), (
        "this must be the loader's deliberate refusal, not a text-decode accident")


# ─────────────────────────────── resolve_slot ─────────────────────────────────

@pytest.mark.parametrize("subpath", STAGED_NAMES)
def test_resolve_slot_finds_the_store_by_slot_and_by_glob(subpath):
    """Both resolution paths reach the store DIRECTORY.

    The slot path is what a real run takes (`inputs.json` IS bound into the sandbox —
    `sandbox::inputs::DERIVED_INPUT_FILES`); the glob is the harness fallback. The glob
    patterns asserted here are `main()`'s own, so a pattern set that stopped matching the
    live `.json`-named directory — or that never matched a future `.zarr`-named one —
    fails here.
    """
    patterns = ("*_index.zarr", "*index*.zarr", "*_index.json", "*index*.json")
    with tempfile.TemporaryDirectory() as td:
        inputs, _ = write_run_dir(Path(td), axis_subpath=subpath)

        slots = ai.load_inputs_index(inputs)
        by_slot = ai.resolve_slot(slots, inputs, prefer=("axis_index", "index", "axis"),
                                  patterns=patterns)
        assert by_slot == inputs / subpath and by_slot.is_dir()

        by_glob = ai.resolve_slot({}, inputs, prefer=("axis_index",), patterns=patterns)
        assert by_glob == inputs / subpath, "the glob fallback finds the same store"


def test_resolve_slot_glob_never_returns_the_sandboxes_own_derived_files():
    """`inputs.json` / `params.json` are written by the sandbox, never declared as an
    input. A bare `*.json` pattern used to be able to return one of them, and both parse
    as JSON — so the loader would have been handed the run's own wiring as data. With no
    index present the answer must be None, not `inputs.json`.
    """
    with tempfile.TemporaryDirectory() as td:
        inputs = Path(td) / "inputs"
        inputs.mkdir(parents=True)
        (inputs / "inputs.json").write_text(json.dumps({"inputs": []}))
        (inputs / "params.json").write_text(json.dumps({"seed": 0}))

        for patterns in (("*.json",), ("*_index.zarr", "*index*.zarr",
                                       "*_index.json", "*index*.json")):
            assert ai.resolve_slot({}, inputs, prefer=("axis_index",),
                                   patterns=patterns) is None, patterns


# ─────────────────────────────── main() end-to-end ────────────────────────────

@pytest.mark.parametrize("subpath", STAGED_NAMES)
def test_main_integrates_over_a_real_zarr_axis_index(subpath):
    """The production path, end to end: the entry point `dataset::process.rs` invokes,
    over the run directory the sandbox actually stages, asserting the emitted columns'
    VALUES read back off disk through the reference reader.

    This is the test that would have caught ITEM-26: it is the only one in the tree that
    touches both the input FORMAT and the output FORMAT in one run.
    """
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = write_run_dir(Path(td), axis_subpath=subpath)
        entries = run_main(inputs, outputs)

        by_id = {e["id"]: e for e in entries}
        # #80: every run also emits a hidden `run-environment` record — the resolved
        # version of each library this package DECLARES — which the server lifts into the
        # run's provenance row. It is a provenance carrier, not a produced result, so this
        # assertion (which is about what the analysis PRODUCES) excludes it by id; its own
        # contract is tested in `_lib/test_deps.py`.
        assert "run-environment" in by_id, (
            "the run must emit its environment record — a result published with nothing "
            "saying which library versions produced it is the state #80 removes"
        )
        produced = {k: v for k, v in by_id.items() if k != "run-environment"}
        assert set(produced) == {"metadata-column:cell_type", "metadata-column:score",
                                 "integration_summary"}, sorted(produced)

        # Every aligned column is a Zarr artifact tagged with the axis, and its values are
        # in AXIS order (the table above is in axis order, so the join is identity here
        # after the DEC-18 barcode-suffix normalization).
        for out_id, expected in (("metadata-column:cell_type", ["T", "B", "NK"]),
                                 ("metadata-column:score", [1.5, 2.5, 3.5])):
            entry = by_id[out_id]
            assert entry["axis"] == "cells"
            assert entry["structure"]["encoding"] == "zarr_v3"
            store = outputs / entry["path"]
            assert store.is_dir(), f"{out_id} is a Zarr store directory"
            got = cyto_zarr_read.read_column(store)
            got = got.tolist() if hasattr(got, "tolist") else list(got)
            assert got == expected, out_id

        summary = by_id["integration_summary"]["meta"]

    # The alignment genuinely matched — not an all-NA "success".
    assert summary["matched"] == len(BARCODES)
    assert summary["missing"] == 0 and summary["extra"] == 0
    assert summary["total"] == len(BARCODES)
    assert summary["degraded"] is False and summary["status"] == "integrated"
    assert summary["axis"] == "cells" and summary["key_column"] == "barcode"
    # The keys only match AFTER normalization — proof the axis keys reaching `align`
    # really are the store's `-1`-suffixed barcodes and not something re-derived.
    assert summary["matched_before_normalize"] == 0


def test_main_derives_the_axis_from_the_artifact_when_params_omits_it():
    """`params.axis` normally wins (the coordinator always sets it). With it absent, the
    axis comes from the ARTIFACT'S OWN `structure.axis` — not from its label, and not from
    a hardcoded single-cell default in an axis-agnostic processor."""
    genes = ["ENSG00000141510", "ENSG00000012048"]
    rows = [{"gene": g, "pathway": p} for g, p in zip(genes, ["p53", "BRCA"])]
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = write_run_dir(
            Path(td), axis_subpath="genes_index.zarr", axis="genes",
            axis_keys=genes, table_rows=rows)
        # Strip `axis` from params.json so the artifact's declaration is the only source.
        (inputs / "params.json").write_text(json.dumps({"seed": 0}))
        entries = run_main(inputs, outputs)

    by_id = {e["id"]: e for e in entries}
    assert by_id["metadata-column:pathway"]["axis"] == "genes"
    assert by_id["integration_summary"]["meta"]["axis"] == "genes"


def test_main_REFUSES_when_no_column_aligns_rather_than_reporting_a_degraded_run():
    """A table sharing no keys with the axis, with NO key column named, must FAIL the job.

    This used to be a "degraded" success: exit 0, a full manifest, one all-NA
    `metadata-column` per table column, and an `integration_summary` carrying
    `degraded: true`. Nothing reads that flag — `DatasetIntegrationSink` copies the
    summary into `dataset_files` verbatim, the per-file status is derived from the JOB's
    outcome, and `ui/src/modules/datasets/lib/supporting.ts::coverage` narrows the summary
    to `{matched, missing, extra, error}`, dropping `degraded`/`status`. So the end state
    was a green "Integrated" tag over permanently-empty columns that are now permanent
    dataset artifacts. With no key column aligning to a single entity there is no join
    key, so the only honest outcome is a failed job.
    """
    rows = [{"other_id": "X1", "label": "a"}, {"other_id": "X2", "label": "b"},
            {"other_id": "X3", "label": "c"}]
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = write_run_dir(Path(td), table_rows=rows)
        with pytest.raises(SystemExit) as exc:
            run_main(inputs, outputs)
        assert exc.value.code == 1
        # No manifest ⇒ the coordinator ingests nothing; no all-NA columns are created.
        assert not (outputs / "manifest.json").exists()


def test_main_reports_a_degraded_alignment_when_the_key_column_is_EXPLICIT():
    """The `degraded` path stays reachable, and keeps its meaning, for the case it is
    actually right for: the caller NAMED the join column and it matches nothing. That is
    an honest all-NA answer to a question the caller asked, not an inference over zero
    evidence — so the run completes and the signal rides the `integration_summary`
    artifact where the coordinator reads it."""
    rows = [{"other_id": "X1", "label": "a"}, {"other_id": "X2", "label": "b"},
            {"other_id": "X3", "label": "c"}]
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = write_run_dir(Path(td), table_rows=rows,
                                        params={"key_column": "other_id"})
        entries = run_main(inputs, outputs)

    summary = {e["id"]: e for e in entries}["integration_summary"]["meta"]
    assert summary["key_column"] == "other_id"
    assert summary["matched"] == 0
    assert summary["degraded"] is True and summary["status"] == "degraded"
    assert any("DEGRADED" in w for w in summary["warnings"])


def test_main_exits_2_when_the_axis_index_is_absent():
    """Both inputs are required; a missing axis index is a clean exit-2, never a
    traceback-shaped failure with no reason."""
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = write_run_dir(Path(td))
        # Remove the store + its slot entry, leaving only the annotation table.
        import shutil

        shutil.rmtree(inputs / PRODUCTION_SUBPATH)
        (inputs / "inputs.json").write_text(json.dumps({"inputs": [
            {"slot": "annotation", "kind": "dataset-file",
             "sandbox_path": "/inputs/donor_meta.csv"}]}))

        with pytest.raises(SystemExit) as excinfo:
            run_main(inputs, outputs)

    assert excinfo.value.code == 2
