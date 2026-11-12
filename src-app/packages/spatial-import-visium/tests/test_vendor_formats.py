#!/usr/bin/env python3
# ruff: noqa
"""Reading the VENDOR's files — both spellings — and the production entrypoint.

Two gaps this file closes, each found by mutating the importer and watching the rest of the
suite stay green:

* **`read_positions`' header detection had no test at all.** Deleting the rule — so a
  HEADERED file is read positionally — left every other test passing, while the parse takes
  the literal header row as a spot. The headerless Space Ranger <= 1.x spelling, which is
  the whole reason that function is forty lines long, was exercised by nothing.
* **`main()` was exercised by nothing.** Every other test calls `run_import()` directly, so
  the actual production entrypoint — the `TXR_INPUTS_DIR`/`TXR_OUTPUTS_DIR` seam,
  `load_inputs_index`, `write_manifest`, `txr_deps.augment`, the refusal exit code, and the
  `/outputs/manifest.json` the SERVER actually reads — was never run.
"""
import csv
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


# ── the two vendor spellings ─────────────────────────────────────────────────────────


def _rewrite_positions(bundle, *, headerless=False, rename_to=None):
    """Re-spell the fixture's positions file as an older Space Ranger would have written it."""
    src = bundle / "spatial" / "tissue_positions.csv"
    rows = list(csv.reader(src.open(newline="")))
    dest = bundle / "spatial" / (rename_to or src.name)
    body = rows[1:] if headerless else rows
    with dest.open("w", newline="") as fh:
        csv.writer(fh).writerows(body)
    if dest != src:
        src.unlink()
    return dest


def test_a_headerless_positions_list_is_read_positionally(tmp_path):
    """Space Ranger <= 1.x wrote `tissue_positions_list.csv` with NO header.

    Its meaning is ENTIRELY positional, so this is the branch where a wrong column order is
    unrecoverable — and it was the one with no coverage. Asserted on the VALUES, against the
    same independently-parsed expectation the headered case uses: both spellings must produce
    identical coordinates, because they are the same data.
    """
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    _rewrite_positions(bundle, headerless=True, rename_to="tissue_positions_list.csv")

    entries = module.run_import(bundle, tmp_path / "out")
    values = VF.read_member(tmp_path / "out", "spatial/coordinates.zarr", "coordinates")
    xs, ys = VF.expected_xy()
    import numpy as np

    assert np.array_equal(values[:, 0], np.asarray(xs, dtype=np.float32))
    assert np.array_equal(values[:, 1], np.asarray(ys, dtype=np.float32))
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())
    assert report["positions_file"] == "tissue_positions_list.csv"
    assert report["n_positions_in_bundle"] == len(VF.positions_table())


def test_the_header_is_detected_BY_CONTENT_not_by_filename(tmp_path):
    """A HEADERED file under the OLD name must still be read as headered.

    This is the mutation that survived: with the detection removed, a headered file is read
    positionally and its header ROW is parsed as a spot — `barcode` becomes a barcode. An
    uploader may rename a file, so keying the decision on the name would be a coin flip.
    """
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    _rewrite_positions(bundle, headerless=False, rename_to="tissue_positions_list.csv")

    parsed = module.read_positions(bundle / "spatial" / "tissue_positions_list.csv")
    assert "barcode" not in parsed["barcode"], (
        "the header ROW was parsed as a spot — the detection is keyed on the filename, not "
        "on the content"
    )
    assert len(parsed["barcode"]) == len(VF.positions_table())
    # …and the whole import still lands the right numbers.
    module.run_import(bundle, tmp_path / "out")
    values = VF.read_member(tmp_path / "out", "spatial/coordinates.zarr", "coordinates")
    import numpy as np

    xs, _ys = VF.expected_xy()
    assert np.array_equal(values[:, 0], np.asarray(xs, dtype=np.float32))


def test_a_headerless_file_under_the_NEW_name_is_still_read_positionally(tmp_path):
    """The other half of the same rule, so it is pinned in BOTH directions."""
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    _rewrite_positions(bundle, headerless=True)  # keeps `tissue_positions.csv`
    parsed = module.read_positions(bundle / "spatial" / "tissue_positions.csv")
    assert len(parsed["barcode"]) == len(VF.positions_table())
    assert parsed["barcode"][0] == VF.positions_table()[0]["barcode"]


def test_a_short_row_is_refused_rather_than_shifting_every_column(tmp_path):
    """A row with fewer fields than the table declares would shift every column after it."""
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    path = bundle / "spatial" / "tissue_positions.csv"
    rows = list(csv.reader(path.open(newline="")))
    rows[3] = rows[3][:4]
    with path.open("w", newline="") as fh:
        csv.writer(fh).writerows(rows)
    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(path)
    assert "fewer than" in str(exc.value)


def test_a_positions_file_missing_a_column_is_refused_by_name(tmp_path):
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    path = bundle / "spatial" / "tissue_positions.csv"
    rows = list(csv.reader(path.open(newline="")))
    keep = [i for i, c in enumerate(rows[0]) if c.strip() != "pxl_col_in_fullres"]
    with path.open("w", newline="") as fh:
        csv.writer(fh).writerows([[r[i] for i in keep] for r in rows])
    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(path)
    assert "pxl_col_in_fullres" in str(exc.value)


def test_a_barcode_listed_twice_is_refused(tmp_path):
    """A spot has ONE position; choosing between two would be a guess."""
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    path = bundle / "spatial" / "tissue_positions.csv"
    rows = list(csv.reader(path.open(newline="")))
    rows.append(list(rows[1]))
    with path.open("w", newline="") as fh:
        csv.writer(fh).writerows(rows)
    with pytest.raises(module.VisiumImportError) as exc:
        module.run_import(bundle, tmp_path / "out")
    assert "more than once" in str(exc.value)


# ── the production entrypoint ────────────────────────────────────────────────────────


def _run_entry(bundle, outputs, *, slot="bundle"):
    """The shipped entrypoint as a subprocess — now ONE spelling, in `visium_fixtures`.

    The body moved to `VF.run_entry` at #330 (DEC-8), unchanged, because a second suite
    (`test_hostile_vendor_text.py`) drives the same seam for the refusal path and the locale.
    Kept as a named local so this module's call sites and their assertions are untouched.
    """
    return VF.run_entry(bundle, outputs, slot=slot)


def test_the_entrypoint_writes_the_manifest_the_server_reads(tmp_path):
    """`main()` end to end — the document the server actually consumes.

    Everything else in this suite calls `run_import()`. That leaves the entry's own half —
    resolving the slot out of `inputs.json`, `write_manifest`, and `txr_deps.augment`'s
    run-environment record — exercised by nothing, which is how a compute can be green in
    its tests and unrunnable in a job.
    """
    outputs = tmp_path / "outputs"
    result = _run_entry(VF.FIXTURE, outputs)
    assert result.returncode == 0, result.stderr[-3000:]

    manifest = json.loads((outputs / "manifest.json").read_text())
    ids = [e["id"] for e in manifest["outputs"]]
    assert len(ids) == len(set(ids)), f"duplicate output id in the manifest: {ids}"
    for entry in manifest["outputs"]:
        # artifact-model ITEM-5/6: both declarations are named at every entry, with no
        # default on either side of the wire.
        assert set(entry) >= {"id", "datatype", "path", "layout", "role", "structure",
                              "meta"}
        assert (outputs / entry["path"]).exists(), f"{entry['id']} declares a missing path"

    # #80 — the run-environment record is APPENDED by `write_manifest`, so it exists only on
    # this path. Its absence is exactly what a `run_import`-only test cannot see.
    env_entries = [e for e in manifest["outputs"]
                   if "environment" in e["id"] or "environment" in str(e.get("path", ""))]
    assert env_entries, (
        f"no run-environment record in the manifest — `txr_deps.augment` did not run. "
        f"ids: {ids}"
    )
    assert "progress:" in result.stderr, "the entry emitted no progress frames"


def test_the_entrypoint_REFUSES_an_incomplete_bundle_with_a_nonzero_exit(tmp_path):
    """A refusal must reach the RUNNER, not just the log.

    `main()` catches the importer's own error and exits 2. If it exited 0 the job would be
    recorded as a success that produced nothing — the failure mode a refusal exists to
    prevent.
    """
    bundle = VF.make_variant(tmp_path)
    (bundle / "filtered_feature_bc_matrix.h5").unlink()
    outputs = tmp_path / "outputs"
    result = _run_entry(bundle, outputs)
    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    assert "filtered feature-barcode matrix" in result.stderr
    assert not (outputs / "manifest.json").exists(), (
        "a refused run wrote a manifest — a partial import is worse than none"
    )
