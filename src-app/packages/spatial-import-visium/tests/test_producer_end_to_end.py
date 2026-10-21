#!/usr/bin/env python3
# ruff: noqa
"""The importer, driven for real over a real bundle, asserted by READING THE BYTES BACK.

Every assertion here is against what LANDED in the store, never against the writer's own
return value — a producer that returns a correct declaration and writes something else is
exactly the failure a read-back test exists to catch.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from packaging.version import InvalidVersion, Version

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


# ── the package-version FLOOR (#273) ─────────────────────────────────────────────────
#
# `docs/design/derived-guards.md` §1 names the failure class this replaces: a guard that
# ENUMERATES an instance instead of deriving the relation it means. #222 wrote
# `assert doc["version"] == "0.6.0"` here. That reads as "the version moved", but what it
# checks is "the version is the exact string #222 left behind" — and the two stop agreeing
# the moment the guard's own subject behaves correctly.
#
# It made the package UNTOUCHABLE, and the contradiction is exact rather than theoretical:
#
#   * `scripts/check-processor-seed-versions.sh` REQUIRES a bump whenever any file whatever
#     under this package changes — `tests/` included, since it diffs the whole package dir
#     (an already-provisioned host skips re-extraction at an unchanged version, so it keeps
#     executing the old kernel).
#   * That equality REQUIRED the version to stay 0.6.0.
#
# At 0.7.0 the gate passed and this test failed; at 0.6.0 the reverse. No branch could
# touch this package at all. #273 filed it; #227 hit it.
#
# The repair is the one §5 prescribes — "The property is real; only its *scope* is wrong.
# If a guard is wrong, fix its DERIVATION" — and NOT the one §5 refuses ("Deleting the
# assertion"). So the relation is asserted as a FLOOR, which §2/§4 name as the correct
# companion to a derived check: "adding … only moves the real number up, so it needs no
# edit; removing one fails."
#
# ── WHERE THE FLOOR SITS, AND WHY NOT ONE LOWER ──────────────────────────────────────
#
# 0.6.0 is the version #222's corrected micron scale SHIPPED AT, so `>= 0.6.0` is exactly
# "this build contains the fix". A blind audit killed the first cut of this guard, which
# floored at the PRE-#222 0.5.0 (`> 0.5.0`): that admits the whole 0.5.1 … 0.5.x band, every
# member of which predates the fix — demonstrated, not argued, by putting the real manifest
# at 0.5.9 and watching the entire suite go green, `test_the_micron_fix_ships_…` included.
# Both values are equally frozen in git and both need no future edit, so nothing selected
# the weaker one; `derived-guards.md` §5 names that mistake "Lowering a floor to fit".
#
# This is NOT the literal it replaces wearing different clothes. `0.6.0` as an EQUALITY was
# a value every later change was REQUIRED to move, which is what guaranteed the deadlock.
# `0.6.0` as a FLOOR is a value no later change may move BELOW, which every correct bump
# satisfies for free. The trap was `==`, not the number.
#
# Provenance, checked rather than assumed: `git show 62d740aa^:…/manifest.yaml` declares
# 0.5.0 and `62d740aa` ("the Visium micron scale was 15.6% low", #222) declares 0.6.0.
MICRON_FIX_PACKAGE_VERSION = Version("0.6.0")

#: The manifest's own `id` and the analysis it contributes. `_manifest_at_version` asserts
#: BOTH, because a proof that reads a STUB instead of the shipped manifest is a proof about
#: nothing — a blind audit replaced the file read with `text = "version: 9.9.9\n"` and every
#: test here stayed green. Two keys rather than one, at two nesting depths, so a stub has to
#: reproduce the document's STRUCTURE to survive and not merely one string.
PACKAGE_ID = "spatial-import-visium"
PACKAGE_ANALYSIS_ID = "spatial.import-visium"


def package_version_includes_micron_fix(text):
    """THE SHIPPED GUARD. True iff the declared version is at or above the #222 fix version.

    Ordering is `packaging.version.Version`, which is what the three sibling floors in this
    tree already use (`test_package_registration.py`, `test_registration_qc.py`, and
    xenium's) and what `sort -V` in `check-processor-seed-versions.sh` approximates. A
    hand-rolled three-part parser was tried and rejected: it refused `1.0.0-rc1` and
    `1.0.0+build`, which `sort -V` orders happily — i.e. it re-created #273's trap in
    miniature for a pre-release bump — and it accepted non-ASCII digits that `str.isdigit`
    admits. A raw STRING comparison is wrong in the other direction: `"0.10.0" > "0.9.0"` is
    False lexicographically, so this package's tenth minor would read as a rollback.

    `Version` is imported outright rather than through `pytest.importorskip` (as the three
    siblings do). `packaging>=22` is a hard requirement of pytest itself, so it cannot be
    absent where this suite runs, and an `importorskip` would turn a genuinely broken
    environment into a SILENT SKIP — which `derived-guards.md` §3 refuses: "A skip is a
    **skip**, never a pass."

    Both the in-situ assertion (TEST-3) and every proof below call THIS function, so the
    proofs exercise the guard that actually ships rather than a restatement of it.
    """
    return Version(str(text)) >= MICRON_FIX_PACKAGE_VERSION


def assert_package_version_includes_micron_fix(text):
    """The guard AS THE SUITE RAISES IT — one definition, so TEST-2 proves the real refusal.

    Written as a function rather than inline in step 4 for exactly one reason: a
    `pytest.raises` that re-types the message it expects is asserting against a copy, and
    the copy stops matching the shipped one the first time somebody edits the shipped one.
    """
    assert package_version_includes_micron_fix(text), (
        "a package whose emitted numbers changed must bump its version — "
        "`scripts/check-processor-seed-versions.sh` enforces it, and a provisioned host "
        f"otherwise keeps executing the pre-#222 kernel. The manifest declares {text!r}, "
        f"which is below the {MICRON_FIX_PACKAGE_VERSION} that #222's corrected micron "
        "scale shipped at"
    )


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    """One real import of the real fixture, shared by the suite (it is not cheap)."""
    out = tmp_path_factory.mktemp("visium-outputs")
    module, entries = VF.run_over(VF.FIXTURE, out)
    return {"out": out, "entries": entries, "module": module}


# ── TEST-11: the fixture is what it claims to be ─────────────────────────────────────


def test_the_committed_fixture_is_real_vendor_data_and_is_non_square():
    """TEST-11 — the substrate every other test in this file rests on.

    Asserted, never assumed. A fixture that quietly became square would disarm TEST-2
    (and, per the epic, every transpose and affine test in the whole Visium arm) while
    every one of those tests stayed green.
    """
    import h5py

    with h5py.File(VF.FIXTURE / "filtered_feature_bc_matrix.h5", "r") as f:
        attrs = {k: v for k, v in f.attrs.items()}
    version = attrs["software_version"]
    version = version.decode() if isinstance(version, bytes) else str(version)
    assert version == VF.FIXTURE_SPACE_RANGER, (
        "the fixture must be a real Space Ranger bundle — its root attributes are also "
        "the provenance source TEST-8 asserts on"
    )

    # Measured over the MATRIX's barcodes — the rows that actually become coordinates.
    # The positions file additionally lists out-of-tissue spots scattered over the whole
    # capture area, whose span is square-ish and says nothing about what gets imported.
    xs, ys = VF.expected_xy()
    x_span, y_span = max(xs) - min(xs), max(ys) - min(ys)
    assert x_span / y_span > 1.5 or y_span / x_span > 1.5, (
        f"the fixture must be NON-SQUARE (x-span {x_span}, y-span {y_span}); a square "
        "one passes a transposed (x, y) silently, which the design names as the single "
        "most likely bug in the whole importer"
    )

    barcodes = set(VF.matrix_barcodes())
    listed = {r["barcode"] for r in VF.positions_table()}
    assert listed - barcodes, (
        "the fixture's tissue_positions.csv must list spots the FILTERED matrix does not "
        "contain — that is what a real bundle looks like, and it is why the importer must "
        "JOIN rather than zip. A positions file restricted to the matrix's barcodes would "
        "let a positional read pass"
    )


# ── TEST-1 / TEST-2: the coordinates themselves ──────────────────────────────────────


def test_coordinates_are_full_resolution_pixels_with_an_identity_transform(imported):
    """TEST-1 [acceptance] [invariant: INV-1] — full-res pixels, always.

    The design's promise is not "some consistent pixel space"; it is THE FULL-RESOLUTION
    frame, so that a second image (CytAssist, a post-hoc H&E) can place itself into it.
    The falsifier is the hires scale factor: if the importer had applied it, every value
    would be 0.2x the vendor's own number here.
    """
    out, entries = imported["out"], imported["entries"]
    entry = VF.entry_by_id(entries, "spatial-coordinates")
    values = VF.read_member(out, "spatial/coordinates.zarr", "coordinates")
    xs, ys = VF.expected_xy()

    assert np.array_equal(values[:, 0], np.asarray(xs, dtype=np.float32))
    assert np.array_equal(values[:, 1], np.asarray(ys, dtype=np.float32))

    scalef = VF.scalefactors()["tissue_hires_scalef"]
    scaled = np.asarray(xs, dtype=np.float32) * np.float32(scalef)
    assert not np.allclose(values[:, 0], scaled), (
        "the stored x values equal the vendor's x times tissue_hires_scalef — the "
        "coordinates were written in the HIRES frame, which bakes in a choice of image "
        "and makes a second image unplaceable (INV-1)"
    )
    assert entry["meta"]["unit"] == "pixel"
    assert entry["meta"]["to_space"] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0], (
        "the coordinates ARE the space, so they map into it by the identity affine; each "
        "image declares its own affine INTO this frame, which is the direction that "
        "composes"
    )


def test_the_axis_order_is_transposed_to_x_y(imported):
    """TEST-2 [acceptance] [invariant: INV-2] — the named trap.

    `tissue_positions.csv` writes `pxl_row_*` (y) BEFORE `pxl_col_*` (x). The expectation
    is built in `visium_fixtures.expected_xy` straight from the CSV, in the opposite
    direction from the importer's own read, so agreeing is evidence rather than a
    tautology. The final assertion is the one that matters: on this NON-SQUARE fixture a
    transposed importer produces values that do NOT match, and would on a square one.
    """
    out = imported["out"]
    values = VF.read_member(out, "spatial/coordinates.zarr", "coordinates")
    xs, ys = VF.expected_xy()
    x_col, y_col = values[:, 0], values[:, 1]

    assert np.array_equal(x_col, np.asarray(xs, dtype=np.float32))
    assert np.array_equal(y_col, np.asarray(ys, dtype=np.float32))
    assert not np.array_equal(x_col, np.asarray(ys, dtype=np.float32)), (
        "column 0 holds the CSV's pxl_row_in_fullres — the importer did NOT transpose"
    )
    x_span = float(x_col.max() - x_col.min())
    y_span = float(y_col.max() - y_col.min())
    assert abs(x_span - y_span) > 100, (
        f"the two spans ({x_span}, {y_span}) are too close for this test to discriminate "
        "a transpose — the fixture has stopped being non-square"
    )


def test_the_positions_are_joined_to_the_matrix_barcode_order(imported):
    """The join, not a zip.

    `tissue_positions.csv` holds every spot on the slide; the filtered matrix holds the
    in-tissue subset in ITS OWN order. A positional read would attach the wrong spot to
    the wrong barcode for every row — which is not an error, it is a picture of the
    tissue with the values shuffled.
    """
    out = imported["out"]
    barcodes = list(VF.read_column(out, "axis/barcode.zarr"))
    assert barcodes == VF.matrix_barcodes()
    assert len(VF.positions_table()) > len(barcodes), (
        "the fixture no longer exercises the join — its positions file has as few rows "
        "as the matrix has barcodes"
    )
    values = VF.read_member(out, "spatial/coordinates.zarr", "coordinates")
    by_barcode = {r["barcode"]: r for r in VF.positions_table()}
    for i in (0, len(barcodes) // 2, len(barcodes) - 1):
        row = by_barcode[barcodes[i]]
        assert float(values[i, 0]) == pytest.approx(float(row["pxl_col_in_fullres"]))
        assert float(values[i, 1]) == pytest.approx(float(row["pxl_row_in_fullres"]))


# ── TEST-7: the expression matrix is ordinary ────────────────────────────────────────


def test_the_expression_matrix_is_resolved_by_the_shipped_selectors(imported):
    """TEST-7 [acceptance] [invariant: INV-7] — nothing needs to know it is spatial.

    Written against the SHIPPED narrowings, read out of the OTHER packages' manifests at
    test time, rather than against a hand-written expectation of them: if this branch had
    quietly needed a selector edit somewhere to make a Visium matrix analysable, an
    expectation written here would have been edited to match and the test would still be
    green.
    """
    yaml = pytest.importorskip("yaml")
    entry = VF.entry_by_id(imported["entries"], "expression")
    assert entry["datatype"] == "single-cell/counts"
    assert entry["structure"]["kind"] == "sparse_csc"
    assert entry["structure"]["axes"] == ["cells", "genes"]

    packages = VF.PKG.parent
    selectors = []
    for manifest in sorted(packages.glob("*/manifest.yaml")):
        doc = yaml.safe_load(manifest.read_text()) or {}
        for analysis in (doc.get("contributes", {}) or {}).get("analyses", []) or []:
            for slot in analysis.get("appliesTo", []) or []:
                if slot.get("subtypes_of") == "single-cell/expression":
                    selectors.append((doc["id"], analysis["id"], slot))
    assert selectors, (
        "no shipped analysis narrows on `subtypes_of: single-cell/expression` any more — "
        "INV-7's claim that a Visium matrix is runnable by the existing chain cannot be "
        "checked against a chain that no longer exists"
    )
    # `single-cell/counts` extends `single-cell/expression` in `single-cell-types`, and it
    # is excluded by NONE of those selectors' `excludes` lists.
    counts_doc = yaml.safe_load((packages / "single-cell-types" / "manifest.yaml").read_text())
    kinds = {d["id"]: d for d in counts_doc["contributes"]["datatypes"]}
    assert kinds["single-cell/counts"]["extends"] == "single-cell/expression"
    for pkg, analysis, slot in selectors:
        excludes = set(slot.get("excludes") or [])
        assert "single-cell/counts" not in excludes and "single-cell/expression" not in excludes, (
            f"{pkg}/{analysis} excludes the very type this importer emits"
        )


# ── TEST-8: the vendor pipeline ──────────────────────────────────────────────────────


def test_the_vendor_pipeline_is_recorded_into_the_existing_channels(imported):
    """TEST-8 [acceptance] [invariant: INV-8] — a processing step we did not run.

    Also asserts the NEGATIVE half of the design's instruction ("do not invent a second
    provenance channel"): the only outputs carrying provenance are the artifact `meta`,
    the report, and `cyto_deps`' run-environment record. A new file or a new output id
    would be the second channel.
    """
    out, entries = imported["out"], imported["entries"]
    coords = VF.entry_by_id(entries, "spatial-coordinates")
    prov = coords["meta"]["provenance"]
    assert prov["pipeline"] == VF.FIXTURE_SPACE_RANGER
    assert prov["chemistry"] == "Visium V1 Slide"
    assert prov["library_id"] == VF.FIXTURE_LIBRARY_ID

    # …and the OTHER half of the claim: the fields lifted from `metrics_summary.csv`. The
    # test used to assert only the three that come off the h5 root attributes, so deleting
    # the entire metrics-lifting block left the suite green while half of INV-8's evidence
    # silently stopped being recorded.
    metrics = dict(zip(*[
        [c.strip() for c in row] for row in
        __import__("csv").reader((VF.FIXTURE / "metrics_summary.csv").open(newline=""))
    ][:2]))
    assert prov["sample_id"] == metrics["Sample ID"], (
        "the sample id was not lifted out of metrics_summary.csv"
    )
    assert "metrics_summary_unreadable" not in prov

    report = json.loads((Path(out) / "visium-import-report.json").read_text())
    assert report["provenance"] == prov
    assert report["library_versions"], "the run-environment record is empty"

    ids = {e["id"] for e in entries}
    # The emitted SET is enumerated once, in `test_absence_is_absence.EXPECTED_OUTPUTS`, and
    # asserted there. A second hardcoded copy here read as an independent check and was not —
    # it could only drift from the real one. What this test owns is the CONTENT of the
    # provenance, above; the set is somebody else's assertion.


# ── TEST-18 / TEST-19: the per-spot columns and the Option A siblings ────────────────


def test_every_per_spot_column_exists_and_is_aligned(imported):
    """TEST-18 — the columns, on the cells axis, each declaring WHICH row space."""
    out, entries = imported["out"], imported["entries"]
    key_structure = VF.entry_by_id(entries, "metadata-column:barcode")["structure"]
    digest = key_structure["key_sequence_digest"]
    n = len(VF.matrix_barcodes())

    for name in ("in_tissue", "array_row", "array_col", "platform", "measurement_unit",
                 "spatial_x", "spatial_y"):
        entry = VF.entry_by_id(entries, f"metadata-column:{name}")
        assert entry["datatype"] == "metadata-column"
        assert entry["structure"]["axis"] == "cells"
        assert entry["structure"]["aligned_to"] == digest, (
            f"{name} declares no row space (or the wrong one); `axis` says WHICH LABEL "
            "and only `aligned_to` identifies"
        )
        assert entry["meta"]["name"] == name
        values = VF.read_values(out, f"metadata/{name}.zarr")
        assert len(values) == n

    # …AND THE COORDINATES ARTIFACT ITSELF, which is the one whose alignment matters most
    # and the one this loop used to skip. Mis-stamping it with the GENES digest passed the
    # whole suite: the columns were all checked and the artifact the epic is about was not.
    coords = VF.entry_by_id(entries, "spatial-coordinates")
    assert coords["structure"]["aligned_to"] == digest, (
        "the tissue map declares the wrong row space. Nothing downstream can see this: "
        "every artifact on this dataset would carry a consistent-looking `aligned_to` that "
        "points at the gene axis, and the conformance gate would fail rows one by one with "
        "nothing saying why"
    )
    assert coords["structure"]["axis"] == "cells"
    assert coords["meta"]["platform"] == "visium"

    positions = {r["barcode"]: r for r in VF.positions_table()}
    barcodes = VF.matrix_barcodes()
    assert list(VF.read_values(out, "metadata/array_row.zarr")) == [
        int(positions[b]["array_row"]) for b in barcodes
    ]
    assert list(VF.read_values(out, "metadata/array_col.zarr")) == [
        int(positions[b]["array_col"]) for b in barcodes
    ]
    assert [bool(v) for v in VF.read_values(out, "metadata/in_tissue.zarr")] == [
        int(positions[b]["in_tissue"]) != 0 for b in barcodes
    ]

    # The two DISPATCH columns' VALUES. These exist "so a future scientific-disclosure layer
    # has something to dispatch on"; a dispatch key whose value is never asserted is a
    # dispatch on nothing, and the loop above checked only their LENGTH — three lines from
    # where the grid indices get a real check.
    assert set(VF.read_values(out, "metadata/platform.zarr")) == {"visium"}
    assert set(VF.read_values(out, "metadata/measurement_unit.zarr")) == {"spot"}, (
        "the measurement unit is derived from the declared entity kind, so this also fails "
        "if a Visium row is ever declared a cell or a bead"
    )


def test_the_option_a_siblings_mirror_the_two_dimensional_member_exactly(imported):
    """TEST-19 — the siblings cannot silently disagree with the member they mirror.

    This is what makes the #183 settlement safe to build on: the filtered view draws from
    `spatial_x`/`spatial_y` while the unfiltered one draws from the 2-D member, so the two
    representations MUST be the same numbers. Bit-identical, not approximately equal —
    both are written as float32 from the same array, so anything less would mean one of
    them went through a conversion the other did not.
    """
    out, entries = imported["out"], imported["entries"]
    member = VF.read_member(out, "spatial/coordinates.zarr", "coordinates")
    xs = VF.read_values(out, "metadata/spatial_x.zarr")
    ys = VF.read_values(out, "metadata/spatial_y.zarr")

    assert xs.dtype == np.float32 and ys.dtype == np.float32
    assert np.array_equal(xs, member[:, 0])
    assert np.array_equal(ys, member[:, 1])

    declared = VF.entry_by_id(entries, "spatial-coordinates")["meta"]["component_columns"]
    assert declared == ["spatial_x", "spatial_y"], (
        "the declaration is the ADDRESS the client resolves the two columns by, in x-then-y "
        "order; reversing it would draw the tissue transposed on a filtered dataset only"
    )
    for name in declared:
        entry = VF.entry_by_id(entries, f"metadata-column:{name}")
        assert entry["meta"]["name"] == name, (
            "a declared component column must be findable by the producer-declared "
            "`meta.name` the client joins on (DEC-8)"
        )
    assert len({e["meta"]["name"] for e in entries
                if e["datatype"] == "metadata-column"
                and e["meta"]["name"] in declared}) == 2, (
        "the two component names must be UNIQUE among this dataset's columns — the "
        "client's resolution fails closed on a count other than 1, so a duplicate would "
        "silently leave the filtered tissue map blank"
    )


def test_the_image_artifact_count_is_one_per_present_vendor_image(tmp_path):
    """#155's **TEST-18** [covers: ITEM-1, ITEM-5] — the fan-out stays STRUCTURAL.

    Adding an image path is exactly where a per-tile or per-level fan-out could creep in:
    a pyramid is several rasters, and emitting one artifact PER LEVEL would look correct
    on a small fixture and blow through `MAX_OUTPUTS` on a real one. The checkable
    statement is that the count tracks the number of vendor image FILES and nothing else —
    not the pixel count, not the number of pyramid levels.

    Driven over three bundles that differ in exactly that respect.

    (`TEST-18` is a per-feature id; this is #155's.)
    """
    import tifffile

    cases = {
        "two": (VF.make_imaged(tmp_path / "two-src", with_lowres=True), 2),
        "one": (VF.make_imaged(tmp_path / "one-src", with_lowres=False), 1),
        "none": (VF.make_imaged(tmp_path / "none-src", with_lowres=False,
                                drop_hires_scalef=True), 0),
    }
    for name, (bundle, expected) in cases.items():
        _module, entries = VF.run_over(bundle, tmp_path / f"{name}-out")
        images = [e for e in entries if e["datatype"] == "spatial/image"]
        assert len(images) == expected, (
            f"{name}: expected {expected} image artifact(s), got "
            f"{[e['id'] for e in images]}"
        )

    # …and the multi-level case really did build several levels INSIDE one file, which is
    # what makes "one artifact per image" a statement about fan-out rather than a
    # coincidence of a fixture too small to pyramid.
    _module, entries = VF.run_over(cases["two"][0], tmp_path / "levels-out")
    hires = VF.entry_by_id(entries, "spatial-image-hires")
    with tifffile.TiffFile(tmp_path / "levels-out" / hires["path"]) as tf:
        assert len(tf.series[0].levels) > 1


# ═════════════════════════════════════════════════════════════════════════════════════
# #222 — FIX FORWARD ONLY. The shape of the import is unchanged; only a number moved.
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_micron_fix_ships_no_migration_no_backfill_and_no_affected_flag(imported):
    """TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-1, ITEM-8] — #222's ruling.

    ## The invariant

    "Correct the importer; existing artifacts are left as-is — not re-imported, not flagged."
    A 15.4% correction (1 - 55/65) is exactly the change that tempts a producer into helpfulness: a
    re-import path, a backfill, an `affected: true` on every artifact so a consumer can tell.
    The owner ruled all three out, and the accepted consequence is recorded on #222 — two
    datasets in one workspace imported either side of this fix disagree by that amount.

    ## Why this is asserted behaviourally rather than by reading the diff

    A diff-grep would pass on a branch that ships the flag in a file the grep did not think
    of. What the invariant actually promises is about the IMPORT'S OUTPUT: the same artifacts,
    the same shape, no new remediation channel. So this reads the emitted manifest and report
    and asserts exactly that, TWO ways: a structural key-set pin (any new key anywhere in an
    entry's `meta`, or at the report's top level, goes red REGARDLESS of what it is called)
    and a word blacklist over the serialized blobs (which catches a remediation VALUE, not
    just a key). The key-set pin is the load-bearing half — a blind audit demonstrated that
    the blacklist alone passes a flag named around it.

    Scope, stated honestly: it inspects the two files THIS importer emits as its record —
    `manifest.json` and `visium-import-report.json`. A remediation surface added somewhere
    else entirely (a new artifact, a server-side field) is outside what this assertion sees.
    """
    import re as _re

    out, entries, module = imported["out"], imported["entries"], imported["module"]
    module.write_manifest(out, entries)
    manifest = json.loads((out / "manifest.json").read_text())

    # 1. The SET of artifacts is unchanged by the fix — nothing added, nothing renamed.
    ids = {e["id"] for e in manifest["outputs"]}
    assert ids == {
        "expression",
        "metadata-column:barcode",
        "metadata-column:gene_id",
        "metadata-column:gene_symbol",
        "spatial-coordinates",
        "metadata-column:in_tissue",
        "metadata-column:array_row",
        "metadata-column:array_col",
        "metadata-column:platform",
        "metadata-column:measurement_unit",
        "metadata-column:spatial_x",
        "metadata-column:spatial_y",
        "spatial-image-hires",
        "visium-import-report",
        "visium-import-summary",
        "run-environment",
    }, "the #222 fix changed WHICH artifacts an import emits; it must change only a number"

    # 2. THE STRUCTURAL PIN — no NEW KEY, whatever it is called. This is the load-bearing
    #    half: a word blacklist alone passes a flag named around it (a blind audit injected
    #    `pre_222_datasets_are_stale_by_15_6_percent` and the blacklist let it through). A
    #    key-set pin does not care what the flag is called.
    report = json.loads((out / "visium-import-report.json").read_text())
    # `assay` / `slide_design` (#257): TWO KEYS DECLARED HERE ON PURPOSE, which is this pin
    # working rather than being worked around. #257 keys the scale numerator on the SLIDE
    # DESIGN (10x documents `spot_diameter_fullres` as varying with it, 60-70 um) and detects
    # the ASSAY separately so the report can name it — a CytAssist bundle used to import with
    # nothing anywhere saying it was one.
    #
    # Neither is a remediation surface, and the difference is not a matter of naming. What
    # this assertion forbids is a channel that tells a consumer some PAST import is affected
    # and needs redoing. These two describe THIS import — which circle its numerator measured
    # and which assay produced the bundle — in exactly the class `microns_per_pixel_source`
    # and `coordinate_space_source` already occupy in the set above. The property that
    # separates the two classes is UNCONDITIONALITY, and it is asserted below rather than
    # argued here: a remediation flag exists only for the datasets it flags, so a key present
    # on EVERY import, with a value drawn from a closed vocabulary, is not one.
    assert set(report) == {
        "analysis", "assay", "component_columns", "coordinate_space",
        "coordinate_space_source", "diagnostics_omitted", "image_warnings", "images",
        "images_not_emitted", "kind", "library_versions", "measured_entity",
        "measured_entity_label", "microns_per_pixel", "microns_per_pixel_source", "n_genes",
        "n_positions_in_bundle", "n_spots", "n_spots_in_tissue", "positions_file",
        "provenance", "registration_qc", "scalefactors", "slide_design",
    }, "the import report gained or lost a top-level key; #222 moves a VALUE, not the shape"

    meta_keys = set()

    def _walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                meta_keys.add(k)
                _walk(v)
        elif isinstance(node, list):
            for v in node:
                _walk(v)

    for entry in manifest["outputs"]:
        _walk(entry.get("meta") or {})
    # `overlay_note` (#243): this key is emitted by `import_visium` whenever an overlay was
    # actually DRAWN, and it has been in the shipped compute since #156 — see
    # `import_visium.py`'s `**({"overlay_note": ...} if overlays else {})`. It was absent from
    # this pin only because it was UNREACHABLE from the committed fixture: every spot mapped
    # outside the 200x200 image, so no overlay was ever drawn and the key never appeared.
    #
    # #243 replaced that image with 10x's own 2000x2000 emission, the spots now land on it,
    # the overlay is drawn, and the key appears. So this is a key becoming REACHABLE, not a
    # manifest contract change: #243 edits no file under `compute/`. It is emphatically not
    # a flag announcing that older imports are affected, which is what this assertion exists
    # to forbid.
    assert meta_keys == {
        "applied_resolution_um", "axis", "chemistry", "codec", "component_columns",
        "coordinate_space", "coordinate_space_source", "diagnostics_embedded",
        "display_derivative", "downsample_factor", "downsampled", "dtype", "emitted_extent",
        "extent", "height", "index", "is_axis_index", "is_display_derivative", "kind",
        "levels", "library_id", "lossless", "measured_entity", "measured_entity_label",
        "microns_per_pixel", "microns_per_pixel_source", "n", "n_cells", "n_dims", "n_genes",
        "n_missing", "n_spots", "name", "original_extent", "original_resolution_um",
        "original_source", "overlay_embedded", "overlay_note", "partial", "pipeline",
        "platform", "positioning", "provenance", "registration_qc", "registration_qc_verdict",
        "resolution_cap_um", "resolution_um", "role", "sample_id", "section",
        # #257, same three keys and the same reasoning as the report pin above: they ride on
        # the report ENTRY's `meta` beside the existing `registration_qc_verdict`, because a
        # reader who sees a scale verdict in the one channel this app shows a human must not
        # have to open the JSON to learn which assay and which slide design produced it.
        "assay", "slide_design", "slide_design_matched_by",
        "source",
        "spot_diameter_fullres", "stored_dtype", "to_space", "unit", "width",
        "writer_version",
    }, (
        "an artifact's `meta` gained or lost a key. If that key announces that older imports "
        "are affected / need re-importing, #222's fix-forward-only ruling forbids it; if it "
        "is an unrelated addition, it is a manifest contract change and belongs in its own "
        "change with its own version bump"
    )

    # 3. …and the word blacklist as defence in depth, because a remediation surface can also
    #    be a VALUE under an existing key rather than a new key of its own.
    forbidden = _re.compile(
        r"affected|re[-_ ]?import|backfill|needs[-_ ]?migration|remediat|rescale[-_ ]?existing"
        r"|stale",
        _re.I,
    )
    for blob, where in ((json.dumps(manifest), "manifest.json"),
                        (json.dumps(report), "visium-import-report.json")):
        hit = forbidden.search(blob)
        assert hit is None, (
            f"{where} carries a remediation surface ({hit.group(0)!r}) — #222 ruled the fix "
            "forward-only: existing artifacts are left as-is, not re-imported and not flagged"
        )

    # 3b. THE NEW TOOTH (#257). Widening a key-set pin is the moment its real question —
    #     "is this a remediation channel?" — stops being asked by the machine, so it is asked
    #     here instead, and asked in the one way that discriminates.
    #
    #     A remediation flag is CONDITIONAL by construction: it exists for the datasets it
    #     flags and is absent otherwise. So the two keys admitted above must be present on
    #     EVERY import, with values from a closed vocabulary, and must DIFFER between two
    #     bundles of different kinds — a key that carried the same constant everywhere would
    #     be an announcement, not a description. This drives a SECOND, structurally different
    #     bundle (real CytAssist, 11 mm slide) rather than re-reading the one above: an
    #     "it is always present" claim that only ever looks at one input is not evidence.
    import tempfile as _tempfile

    control_out = Path(_tempfile.mkdtemp())
    control_entries = module.run_import(VF.CYTASSIST_V5_11MM, control_out)
    module.write_manifest(control_out, control_entries)
    control = json.loads((control_out / "visium-import-report.json").read_text())

    assert set(control) == set(report), (
        "the two bundles do not produce the same report SHAPE, so at least one of these keys "
        "is conditional on something about the input — which is what a remediation flag is"
    )
    assert control["assay"]["assay"] != report["assay"]["assay"], (
        "`assay` reads the same on a CytAssist bundle and a direct-placement one, so it is a "
        "constant wearing the clothes of a classification"
    )
    assert control["slide_design"]["id"] != report["slide_design"]["id"]
    assert {report["assay"]["assay"], control["assay"]["assay"]} == {
        "visium-cytassist", "visium-direct-placement"
    }, "the assay vocabulary is not closed; a free-form value could carry anything"
    for blob in (json.dumps(control),):
        hit = forbidden.search(blob)
        assert hit is None, (
            f"the CytAssist control report carries a remediation surface ({hit.group(0)!r})"
        )

    # 4. TEST-3 — the package's own version DID move, which is the only thing an operator
    #    gets to tell two builds apart by (the seed reconciliation keys on it). #222 refused
    #    a re-import, a backfill and an `affected` flag, so this IS the whole signal.
    #
    #    Asserted as the FLOOR `>= MICRON_FIX_PACKAGE_VERSION`, never as equality to
    #    whatever the current version happens to be — see that constant's note, and #273. Two
    #    guards that meet here assert DIFFERENT things and neither subsumes the other:
    #    `check-processor-seed-versions.sh` is BASE-RELATIVE ("did this branch's own change
    #    to this package come with a bump?") and says nothing on a branch that leaves the
    #    package alone; this is ABSOLUTE ("is the shipped version past the one #222 moved
    #    away from?") and holds on every branch, including one that never touches it.
    import yaml

    doc = yaml.safe_load((VF.PKG / "manifest.yaml").read_text())
    assert_package_version_includes_micron_fix(doc["version"])

    # 5. And the number that DID move, moved: the space's scale is the rendered-circle one.
    coords = VF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert coords["microns_per_pixel"] == pytest.approx(
        module.VISIUM_RENDERED_SPOT_DIAMETER_UM
        / float(VF.scalefactors()["spot_diameter_fullres"])
    )
    assert coords["measured_entity"]["resolution_um"] == 55.0


# ── TEST-1 / TEST-2 / TEST-4: the version guard itself, proven on BOTH sides (#273) ──
#
# The guard that #273 replaced could not be proven on both sides — that was the defect.
# `== "0.6.0"` passes at exactly one version and fails at every other, including every
# CORRECT one, so "it still bites" and "it does not re-trap" were the same question with
# opposite answers. A floor separates them, and the separation is what these assert.
#
# They drive the REAL `manifest.yaml` — read from disk and identity-checked, not a stub —
# with only its declared `version:` substituted, through the SAME
# `package_version_includes_micron_fix` the in-situ assertion above calls. A proof written
# against a restatement of the guard, or against a stand-in for its subject, proves nothing.


def _substitute_version(text, version):
    """Replace the manifest's COLUMN-0 `version:` line. Pure, so the anchoring is testable.

    Anchored at column 0 exactly like `read_version()` in
    `scripts/check-processor-seed-versions.sh` — *"so a nested `version:` under
    `contributes:` can't match"*. The pattern deliberately swallows the whole line rather
    than only a bare token: that script's own `sed` ends in `.*`, so `version: 0.7.0  # note`
    is a form it reads correctly, and a narrower pattern here would REFUSE a manifest the
    shipped gate accepts — #273's failure shape, one level down.

    `count` is deliberately NOT capped at 1: `subn` must be able to report multiplicity, or
    the `n == 1` check below could only ever mean "no match" while its message says
    "no SINGLE match" — and `yaml.safe_load` resolves duplicate keys last-wins while
    `read_version()` takes the first, so two column-0 lines is a genuine divergence to
    refuse rather than to silently pick a side on.
    """
    import re as _re

    swapped, n = _re.subn(r"(?m)^version:.*$", f"version: {version}", text)
    assert n == 1, (
        f"expected exactly ONE column-0 `version:` line in the manifest text, found {n}; "
        "the seed reconciliation key has moved or been duplicated, and this proof would be "
        "reading the wrong field"
    )
    return swapped


def _manifest_at_version(version):
    """The REAL shipped manifest, its `version:` replaced, parsed the way step 4 parses it.

    The `id` assertions are the anti-stub control. Without them these proofs pass against
    any two-line file that happens to carry a `version:` key: a blind audit replaced the
    file read with `text = "version: 9.9.9\\n"` and all of them stayed green, which made
    them proofs about the predicate wearing the clothes of proofs about the package.
    """
    import yaml

    text = (VF.PKG / "manifest.yaml").read_text()
    _assert_is_the_shipped_manifest(yaml.safe_load(text))
    doc = yaml.safe_load(_substitute_version(text, version))
    _assert_is_the_shipped_manifest(doc)
    return doc


def _assert_is_the_shipped_manifest(doc):
    """The anti-stub control — see `PACKAGE_ID` / `PACKAGE_ANALYSIS_ID`."""
    assert doc["id"] == PACKAGE_ID, (
        f"the document read here is not {PACKAGE_ID}'s manifest; every assertion resting on "
        "it would be about some other file"
    )
    assert [a["id"] for a in doc["contributes"]["analyses"]] == [PACKAGE_ANALYSIS_ID], (
        f"the document read here does not contribute {PACKAGE_ANALYSIS_ID}; it carries the "
        "package id but not the package's structure, so it is not the shipped manifest"
    )


def test_the_version_guard_admits_every_forward_bump_without_an_edit():
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-1] — the derivation, not the instance.

    `derived-guards.md` INV-1: *"A guard derives the set it ranges over from the declaration
    that defines that set; it never enumerates instances of it."*

    Read here as: the guard's verdict on a CORRECTLY-bumped package must not depend on which
    bump it is. The literal it replaced enumerated one instance (`"0.6.0"`) and so answered
    NO to every later one — including 0.7.0, the very bump
    `scripts/check-processor-seed-versions.sh` compels on any branch that touches this
    package. Flipping the invariant off (going back to an equality pin) turns this red at
    every version but one, which is what makes it a real test of the invariant rather than
    of the code.

    `0.10.0` is the case a STRING comparison gets wrong (`"0.10.0" > "0.9.0"` is False
    lexicographically) and `1.0.0-rc1` / `1.0.0+build` are the cases a naive three-part
    parser refuses outright — both are forward bumps `sort -V` accepts, so a guard that
    refuses either has re-created #273's trap in a narrower band.
    """
    for version in ("0.6.0", "0.6.1", "0.7.0", "0.10.0", "1.0.0", "1.0.0-rc1",
                    "1.0.0+build.5", "12.3.4"):
        doc = _manifest_at_version(version)
        assert str(doc["version"]) == version, "the substitution did not take"
        assert package_version_includes_micron_fix(doc["version"]), (
            f"the guard refuses {version}, a correct forward bump. It has re-acquired "
            "#273's trap: the next branch to touch this package cannot satisfy both it and "
            "`scripts/check-processor-seed-versions.sh`"
        )


def test_the_version_guard_still_refuses_anything_below_the_micron_fix():
    """TEST-2 [acceptance] [invariant: INV-4] [covers: ITEM-2] — widened in scope, not relaxed.

    `derived-guards.md` INV-4: *"A guard is never relaxed to make a branch pass: an exemption
    not bound to the change it exists for is refused, and a self-limiting guard still fails
    loudly on the branch where its premise does hold."*

    A guard that passes at every version is a DELETED guard wearing an assertion's clothes,
    and swapping an equality for an inequality is exactly the edit that could have done that
    silently. So the refusing side is asserted too, and asserted through the enclosing
    `assert`, so what is proven is that the TEST goes red and names the value — not merely
    that a helper returned False.

    `0.5.9` is here because it is where the first cut of this guard was caught: floored at
    the pre-#222 0.5.0, the whole 0.5.x band passed while predating the micron fix entirely.
    §5 calls that "Lowering a floor to fit"; it is a regression this case now pins shut.
    """
    for version in ("0.5.9", "0.5.1", "0.5.0", "0.4.9", "0.1.0", "0.0.1"):
        doc = _manifest_at_version(version)
        assert not package_version_includes_micron_fix(doc["version"]), (
            f"the guard admits {version}, which is below the version #222's corrected micron "
            "scale shipped at. A provisioned host would keep executing the pre-#222 kernel "
            "and nothing here would say so"
        )

    # The refusal EXACTLY as step 4 raises it — same function, so this cannot drift from
    # the shipped message — naming the offending value and the floor it failed.
    doc = _manifest_at_version("0.5.9")
    with pytest.raises(AssertionError, match=r"'0\.5\.9'.*below the 0\.6\.0"):
        assert_package_version_includes_micron_fix(doc["version"])

    # A version nothing can order is a REFUSAL, not a silent pass.
    with pytest.raises(InvalidVersion):
        package_version_includes_micron_fix("not-a-version")

    # The column-0 anchor, asserted rather than only asserted ABOUT. A nested `version:`
    # (the shape `contributes:` carries) must not be what gets moved — the substitution
    # rewrites the top-level line and leaves the indented one exactly as it was.
    nested = "id: x\nversion: 0.6.0\ncontributes:\n  thing:\n    version: 9.9.9\n"
    swapped = _substitute_version(nested, "0.7.0")
    assert "\nversion: 0.7.0\n" in swapped and "    version: 9.9.9\n" in swapped, swapped


def test_the_shipped_manifest_declares_a_version_that_carries_the_micron_fix():
    """TEST-4 [covers: ITEM-1, ITEM-3] — the LIVE declared version, with no fixture in front of it.

    TEST-3 asserts the same thing in situ, but from inside
    `test_the_micron_fix_ships_no_migration_no_backfill_and_no_affected_flag`, which sits
    behind the module-scoped `imported` fixture — a real, not-cheap import of the real
    bundle. A blind audit made the point: if that fixture ever errors, TEST-1 and TEST-2
    stay green and report "the version guard is proven" while the SHIPPED version goes
    unchecked by anything. This is the same claim with nothing in front of it.
    """
    import yaml

    doc = yaml.safe_load((VF.PKG / "manifest.yaml").read_text())
    _assert_is_the_shipped_manifest(doc)
    assert_package_version_includes_micron_fix(doc["version"])
