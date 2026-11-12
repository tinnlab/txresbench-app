#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 — NO PARTIAL STORE SURVIVES A REFUSAL. Asserted on the FILESYSTEM.

**INV-8**, lifted verbatim from `docs/design/vendor-text-encodability-refusal.md` §6.5
INV-2:

> The refusal fires BEFORE any artifact byte is written, so a refused import leaves no
> store, no partial store and nothing for a later reader to find.

…and taken at the GENERAL form that same design records as OPEN rather than delivered
(§6.7, and §6.9's amendment):

> **every refusal a bundle can trigger should be reachable before the first writer call**,
> which today is true of the two boundaries this design guards and of no others.

This importer delivers the general form whole. The measured gap on the Visium side is its
BARCODE JOIN, which runs after `write_csc_zarr` and leaves 51 paths behind on every join
refusal; here the join runs inside the `h5py` context and ABOVE the first writer, because it
needs only the `barcodes` dataset. So the sweep below covers every refusal in the table,
including that one.

## Why the assertion is `rglob`, and not `pytest.raises`

A refusal that raised the right exception class and left a half-written `expression.zarr`
behind is still a partial store, and no assertion about the exception can see it. The only
way to see it is to LOOK — so every case asserts `output_paths(out) == []`, and the
subprocess arm additionally asserts `rc == 2`, which is the outcome a job actually gets.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import hd_hostile_bundles as HB  # noqa: E402

IDS = [row[0] for row in HB.REFUSALS]


@pytest.mark.parametrize("case", HB.REFUSALS, ids=IDS)
def test_TEST_8_every_refusal_leaves_ZERO_paths_on_disk(case, tmp_path):
    """TEST-8 [acceptance, INV-8] — the whole table, measured on the filesystem.

    In-process, through the shipped `run_import`, so the assertion is about the function that
    writes rather than about a wrapper: `main()` could in principle clean up after itself,
    and a test that only ever saw `main()` would not be able to tell "nothing was written"
    from "something was written and removed". The difference matters because the sandbox does
    NOT clean up — a job that dies mid-write leaves what it wrote.
    """
    case_id, build, requested, what = case
    module = HF.load_compute()
    bundle = build(tmp_path / case_id)
    out = tmp_path / "out"
    out.mkdir()

    with pytest.raises(module.VisiumImportError):
        module.run_import(bundle, out, requested_bin=requested)

    left = HF.output_paths(out)
    assert left == [], (
        f"the {case_id!r} refusal ({what}) left {len(left)} path(s) under /outputs: "
        f"{left[:12]}. INV-8's promise is that a refused import leaves NO store and no "
        "partial store — a reader that later finds `expression.zarr` there cannot tell it "
        "from a complete one."
    )


@pytest.mark.parametrize("case", HB.REFUSALS, ids=IDS)
def test_TEST_8_every_refusal_leaves_ZERO_paths_through_the_ENTRYPOINT(case, tmp_path):
    """TEST-8 [acceptance, INV-8] — the same table through `main()`, which is what a job runs.

    Two things this arm proves that the in-process one cannot: that `main()` really does
    catch `VisiumImportError` and exit 2 (a refusal that escaped would be rc=1 and a
    traceback), and that nothing between `run_import` returning and the process exiting
    writes anything — `write_manifest` in particular must not run on the refusal path, or
    every refused import would leave a `manifest.json` describing no outputs.
    """
    case_id, build, requested, what = case
    bundle = build(tmp_path / case_id)

    # The bundle is mounted as ONE staged directory — the `bundle`-slot shape `main()` takes
    # when a dataset is not spread across twelve inputs. The FLAT multi-file layout has its
    # own coverage in `test_locate_bins.py` and in the end-to-end suite; what is under test
    # here is the WRITE path, which is the same code either way, and several of these
    # bundles are deliberately not twelve-member trees at all.
    inputs_dir = tmp_path / "inputs"
    inputs_dir.mkdir()
    staged = inputs_dir / Path(bundle).name
    staged.symlink_to(Path(bundle).resolve(), target_is_directory=True)
    (inputs_dir / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": "bundle", "kind": "dataset",
                    "sandbox_path": f"/inputs/{staged.name}"}]
    }), encoding="utf-8")

    out = tmp_path / "out"
    params = {} if requested is None else {"bin_um": requested}
    result = HF.run_entry(inputs_dir, out, params=params)

    assert result.returncode == 2, (
        f"the {case_id!r} refusal exited {result.returncode}, not 2 — a refusal that escapes "
        f"`main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]}"
    )
    left = HF.output_paths(out)
    assert left == [], (
        f"the {case_id!r} refusal ({what}) left {len(left)} path(s) under /outputs through "
        f"the entrypoint: {left[:12]}"
    )


def test_TEST_8_the_positive_control_a_GOOD_bundle_really_does_write(tmp_path):
    """TEST-8 [acceptance, INV-8] — without this, every assertion above passes vacuously.

    "The outputs tree is empty" is satisfied by an importer that writes nothing ever, by a
    harness pointed at the wrong directory, and by a `run_entry` whose `TXR_OUTPUTS_DIR`
    never reached the child. So the same driver, over the same fixture, must produce a full
    artifact set — and it must produce it in the directory this suite is looking at.

    This is the same control an ungated-UI e2e needs and for the same reason: "absent" and
    "never rendered" are indistinguishable without it.
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    out = tmp_path / "out"
    result = HF.run_entry(inputs, out)
    assert result.returncode == 0, result.stderr[-3000:]

    left = HF.output_paths(out)
    assert left, "the control run wrote NOTHING, so the empty-tree assertions above prove nothing"
    assert "manifest.json" in left
    assert any(p.startswith("expression.zarr") for p in left)
    assert any(p.startswith("spatial") for p in left)


def test_TEST_8_the_BARCODE_JOIN_refusal_is_the_one_that_moved(tmp_path):
    """TEST-8 [acceptance, INV-8] — the case that makes this stronger than the sibling's.

    `spatial-import-visium` performs the barcode join AFTER `write_csc_zarr`, so every join
    refusal there leaves 51 paths on disk, and `vendor-text-encodability-refusal.md` §6.5's
    INV-2 scopes itself around exactly that ("Other, correctly-named refusals still fire
    after the first writer: MEASURED, every `tissue_positions.csv` refusal leaves 51 paths").

    Here the join runs above the writer, so it leaves zero. Called out as its own test rather
    than left inside the sweep because it is the one row of the table that is a DESIGN
    difference and not a shared inheritance — if a later refactor moved `write_csc_zarr` back
    above the join, the sweep would go red with no indication of which promise broke.
    """
    module = HF.load_compute()
    bundle = HB.a_positions_file_missing_a_matrix_barcode(tmp_path / "join")
    out = tmp_path / "out"
    out.mkdir()

    with pytest.raises(module.VisiumImportError) as exc:
        module.run_import(bundle, out)
    assert "have no row in" in str(exc.value), (
        "this case no longer reaches the barcode-join refusal, so it is testing something "
        "else and the claim above is unproven"
    )
    assert HF.output_paths(out) == [], (
        "the barcode-join refusal left paths behind — that is the sibling's measured 51-path "
        "gap, reintroduced here"
    )
