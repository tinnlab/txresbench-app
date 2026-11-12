#!/usr/bin/env python3
# ruff: noqa
"""TEST-4 — `measured_entity`, and the RESOLUTION GROUP two bins of one run form.

**INV-4**, lifted verbatim from `docs/design/spatial-storage-layout.md` §15.1
(ON `main` — restored by #315 (`b34d4371`), reconciled against what shipped; every
quotation below was re-verified against that merged text):

> **What breaks is identity**: all three declared bindings are identical across those bins
> (same `coordinate_space`, same run, and `aligned_to` is a digest nobody can read), so a
> user distinguishes 8 µm from 16 µm **by row count** […] Stamp it in `meta` at write time
> […] Artifacts sharing a run and differing only in `measured_entity` form a **resolution
> group**.

§15.1's motivating case IS this bundle — it names Visium HD's `square_002um` (11,222,500
rows), `square_008um` (702,244) and `square_016um` (175,561) as the reason the field exists
— and it says the identity is "**unrecoverable from the bytes once artifacts exist**". That
is why this test imports the SAME fixture TWICE rather than checking one import's fields: a
single import cannot show that two bins are distinguishable, which is the whole promise.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402

#: The two bins compared. 8 and 16 rather than 2 and 8 because they are the two a user
#: realistically chooses between, and because their row counts differ by 4x — enough that a
#: reader really could tell them apart by counting, which is the fallback §15.1 calls
#: unacceptable and which this field replaces.
PAIR = (8, 16)


def _import(tmp_path, bin_um):
    out = tmp_path / f"out{bin_um}"
    module, entries = HF.run_over(HF.FIXTURE, out, requested_bin=bin_um)
    report = json.loads((out / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    return module, entries, report, out


def test_TEST_4_the_entity_is_a_BIN_at_the_bundles_OWN_bin_size(tmp_path):
    """TEST-4 [acceptance, INV-4] — what one row IS, stamped from the bundle rather than a constant.

    `kind="bin"` (already in `spatial_declarations.MEASURED_ENTITY_KINDS`) is the honest
    answer for a capture grid: an HD square is neither a Visium spot nor a segmented cell,
    and `kind="cell"` would be a scientific error the constructor also refuses (it requires a
    `segmentation` block for `cell`).

    `resolution_um` is asserted to equal the value read out of THAT BIN'S OWN
    `scalefactors_json.json`, not the parameter that was requested — an importer that
    recorded the request would pass a weaker assertion while stamping a bundle whose vendor
    disagrees with what the user asked for.
    """
    for bin_um in MF.BINS:
        module, entries, report, out = _import(tmp_path, bin_um)
        vendor = json.loads(
            (HF.FIXTURE / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" /
             "scalefactors_json.json").read_text(encoding="utf-8"))
        entity = report["measured_entity"]
        assert entity["kind"] == "bin"
        assert entity["platform"] == "visium-hd"
        assert entity["resolution_um"] == vendor["bin_size_um"]
        assert "segmentation" not in entity


def test_TEST_4_two_bins_of_ONE_run_differ_ONLY_in_measured_entity(tmp_path):
    """TEST-4 [acceptance, INV-4] — the RESOLUTION GROUP, asserted as the design defines it.

    "Artifacts sharing a run and differing only in `measured_entity` form a resolution
    group." So the two imports must AGREE on the coordinate space, its source, the section
    and the platform — the fields that say "same run" — and DISAGREE on `measured_entity`
    alone.

    Both halves matter and neither alone is the invariant. Agreeing on everything would make
    them indistinguishable (the defect §15.1 exists to fix); disagreeing on the space would
    make them two unrelated frames, so an image emitted by one import would be unplaceable
    against the other's bins — which is exactly why `coordinate_space_id` deliberately does
    NOT put the bin in the space id.
    """
    a_module, a_entries, a_report, a_out = _import(tmp_path, PAIR[0])
    b_module, b_entries, b_report, b_out = _import(tmp_path, PAIR[1])

    # SAME RUN.
    assert a_report["coordinate_space"] == b_report["coordinate_space"]
    assert a_report["coordinate_space_source"] == b_report["coordinate_space_source"]
    a_coords = HF.entry_by_id(a_entries, "spatial-coordinates")["meta"]
    b_coords = HF.entry_by_id(b_entries, "spatial-coordinates")["meta"]
    assert a_coords["section"] == b_coords["section"]
    assert a_coords["platform"] == b_coords["platform"] == "visium-hd"

    # DIFFERENT ENTITY — and that is the ONLY declared difference.
    assert a_report["measured_entity"] != b_report["measured_entity"]
    assert a_report["measured_entity"]["resolution_um"] == float(PAIR[0])
    assert b_report["measured_entity"]["resolution_um"] == float(PAIR[1])
    assert a_coords["measured_entity_label"] != b_coords["measured_entity_label"]


def test_TEST_4_the_two_bins_are_told_apart_WITHOUT_counting_rows(tmp_path):
    """TEST-4 [acceptance, INV-4] — the promise stated as the design states it.

    §15.1's complaint is precise: "a user distinguishes 8 µm from 16 µm **by row count**".
    So the assertion is that the LABEL — a string a human reads — already distinguishes them,
    and that it does so with the bin size in it. A test that only compared the two
    `resolution_um` numbers would pass for an importer that stamped a field nothing renders.
    """
    a_module, a_entries, a_report, _ = _import(tmp_path, PAIR[0])
    b_module, b_entries, b_report, _ = _import(tmp_path, PAIR[1])

    a_label = a_report["measured_entity_label"]
    b_label = b_report["measured_entity_label"]
    assert a_label != b_label
    assert str(PAIR[0]) in a_label and str(PAIR[1]) in b_label
    # …and the row counts really would have been the only other way, which is what makes the
    # complaint above concrete rather than rhetorical.
    assert a_report["n_bins"] != b_report["n_bins"]


def test_TEST_4_the_COUNTS_artifact_carries_the_entity_too(tmp_path):
    """TEST-4 [acceptance, INV-4] — not only the tissue map.

    §15.1's motivating case is "a set of sibling MATRICES that differ only in what one row
    is", and the counts store is the artifact every existing analysis actually consumes. An
    importer that stamped the identity only on `spatial/coordinates` would leave the matrix
    saying nothing about whether a row is an 8 µm square or a 16 µm one — recoverable from
    nothing afterwards, which is the property that makes this unrecoverable rather than
    merely missing.
    """
    for bin_um in PAIR:
        module, entries, report, out = _import(tmp_path, bin_um)
        counts = HF.entry_by_id(entries, "expression")["meta"]
        assert counts["measured_entity"]["kind"] == "bin"
        assert counts["measured_entity"]["resolution_um"] == float(bin_um)
        assert counts["measured_entity_label"] == report["measured_entity_label"]
        assert counts["bin_um"] == bin_um


def test_TEST_4_the_entity_reaches_a_SANDBOXED_consumer(tmp_path):
    """TEST-4 [acceptance, INV-4] — "stamp it in `meta` at write time", and #211's correction.

    `meta` never crosses into the sandbox; the store's own bytes do. So a declaration that
    lived only in the manifest row would be unreadable by the analyses that need it most.
    This asserts the entity is in the store's MIRRORED `attributes.txr.txr_spatial`, which
    is the copy a sandboxed reader gets through
    `spatial_declarations.require_spatial_declarations`.
    """
    module, entries, report, out = _import(tmp_path, PAIR[0])
    declared = HF.store_declarations(out, "spatial/coordinates.zarr")
    assert declared["measured_entity"]["kind"] == "bin"
    assert declared["measured_entity"]["resolution_um"] == float(PAIR[0])
    assert declared["measured_entity"]["platform"] == "visium-hd"


def test_TEST_4_the_per_bin_columns_carry_the_platform_and_the_unit(tmp_path):
    """TEST-4 — the dispatch columns the epic's INV-7 owes.

    A `platform` / `measurement_unit` column so a future scientific-disclosure layer has
    something to DISPATCH ON. This item owes the columns; it does not owe the disclosure.
    """
    module, entries, report, out = _import(tmp_path, PAIR[0])
    platform = HF.read_values(out, "metadata/platform.zarr")
    unit = HF.read_values(out, "metadata/measurement_unit.zarr")
    assert set(str(v) for v in platform) == {"visium-hd"}
    assert set(str(v) for v in unit) == {"bin"}
    assert len(platform) == report["n_bins"]
