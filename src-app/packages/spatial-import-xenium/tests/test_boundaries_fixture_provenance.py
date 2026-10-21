#!/usr/bin/env python3
# ruff: noqa
"""#163 — the fixtures ARE what they claim. TEST-17 [covers: ITEM-14].

A fixture's provenance claim is the one claim nothing else in a suite can check. If
`real-lung.parquet` quietly became synthetic, every design-invariant test above would stay
green while proving something much weaker — that this parser reads its own writer, which is
exactly the evidence standard this epic rejects.

Two things are asserted:

  1. **the parquet and its sidecar agree**, byte-compared. Stated precisely, because the
     first wording claimed this proved "the values are the vendor's" and it does not: the
     builder writes both files in one function from one read, so a regeneration moves them
     together. What this leg catches is a post-hoc edit of exactly one of the two. The
     INDEPENDENT check is the third test below, which re-reads the real vendor
     `cell_boundaries.csv.gz` when it is on the machine and SKIPS with a reason when it is
     not — that is the only form of this claim that can be checked here, and pretending
     otherwise is what a blind angle called out;
  2. **the fixture set contains the structural cases real data cannot express** — the #75
     blindness check, asserted rather than believed. Real Xenium is 6..13 vertices with
     99.98% at 13; if the committed set collapsed to that band, the ragged path would stop
     being exercised and nothing else would notice.
"""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


def test_every_committed_fixtures_values_are_the_vendors_own_decimal_text():
    """TEST-17 — the provenance claim, checked."""
    import pyarrow.parquet as pq

    for fixture in (XF.REAL_LUNG_BOUNDARIES, XF.REAL_BREAST_BOUNDARIES,
                    XF.PRIME_STAGED_BOUNDARIES):
        rings, order = XF.expected_rings(fixture)
        table = pq.read_table(str(fixture))
        xs = table.column("vertex_x").to_pylist()
        ys = table.column("vertex_y").to_pylist()
        flat = [(x, y) for cid in order for x, y in rings[cid]]
        assert len(xs) == len(flat), f"{fixture.name}: row count differs from the sidecar"
        for i, (want_x, want_y) in enumerate(flat):
            assert xs[i] == float(want_x) and ys[i] == float(want_y), (
                f"{fixture.name} row {i}: parquet holds ({xs[i]}, {ys[i]}) where the "
                f"vendor's own text says ({want_x}, {want_y}) — this fixture is no longer "
                "carrying vendor values and every claim resting on it is weaker than stated"
            )


def test_the_fixture_set_SPANS_THE_VENDORS_OWN_RANGE_rather_than_one_shape():
    """TEST-17 — the #75 anti-vacuity check, named for what it actually asserts.

    Its previous name claimed the fixtures "express what real data cannot"; they do not, and
    cannot — the cases real data cannot express (a one-vertex ring, a zero-vertex cell, an
    unclosed ring, non-contiguous runs) are CONSTRUCTED in `test_boundaries_ragged_edges.py`
    and are deliberately in no committed fixture. What the committed set must do is span the
    vendor's own 6..13 band instead of collapsing onto the 99.98% case, which is the shape
    that made the end-to-end arm blind.
    """
    lengths = {}
    # THE STAGED FIXTURE IS IN THIS LOOP NOW, and its absence was the defect. It is the ONLY
    # fixture that goes through the real importer, and the first cut's builder selected its
    # donors with a `<= 13` filter that was a NO-OP (13 is the real maximum) — so the whole
    # end-to-end arm ran on 23 cells of exactly 13 vertices each: #75's blind-by-construction
    # failure, reproduced inside the branch written to avoid it, and found by a blind audit
    # because this test deliberately looked away from the one fixture that mattered.
    for fixture in (XF.REAL_LUNG_BOUNDARIES, XF.REAL_BREAST_BOUNDARIES,
                    XF.PRIME_STAGED_BOUNDARIES):
        rings, order = XF.expected_rings(fixture)
        lengths[fixture.name] = sorted({len(rings[c]) for c in order})
    for name, ls in lengths.items():
        assert len(ls) >= 5, (
            f"{name} holds only {ls} distinct vertex counts — real Xenium is 99.98% "
            "13-vertex cells, so a fixture sampled uniformly reproduces #75's blindness. "
            "The build script takes the RAREST lengths first; that is what this asserts."
        )
        assert min(ls) <= 8, (
            f"{name}'s shortest polygon has {min(ls)} vertices; the short rings are the "
            "ragged path's whole subject"
        )
        assert max(ls) == 13, (
            f"{name} tops out at {max(ls)} vertices; 13 is the vendor's own most common "
            "shape and a fixture that never reaches it exercises only the rare end"
        )


def test_the_provenance_manifest_matches_the_committed_bytes():
    """A manifest nobody checks is a comment. This one is checked."""
    import pyarrow.parquet as pq

    manifest = json.loads((XF.BOUNDARY_FIXTURES / "PROVENANCE.json").read_text())
    for name, claim in manifest.items():
        path = XF.BOUNDARY_FIXTURES / name
        assert path.is_file(), f"{name} is claimed but not committed"
        file = pq.ParquetFile(str(path))
        assert file.metadata.num_rows == claim["vertices"], (
            f"{name}: {file.metadata.num_rows} rows, PROVENANCE.json claims "
            f"{claim['vertices']}"
        )
        got = str(file.schema_arrow.field("cell_id").type)
        assert got == claim["cell_id_type"], (
            f"{name}: cell_id is {got}, PROVENANCE.json claims {claim['cell_id_type']}"
        )
    assert {c["cell_id_type"] for c in manifest.values()} >= {"binary", "int32"}, (
        "the committed set no longer covers BOTH vendor id renderings — the contrast is "
        "the whole reason the second fixture exists"
    )


def test_the_committed_fixtures_match_the_REAL_VENDOR_FILE_when_it_is_present():
    """TEST-27 [covers: ITEM-14]. The independent leg — the only one that can catch a fixture becoming synthetic.

    The sidecar is written by the same function, in the same pass, as the parquet, so the
    two agreeing proves they were not edited apart, not that either is the vendor's. Re-read
    the actual `cell_boundaries.csv.gz` and compare. SKIPS with a stated reason where the
    multi-gigabyte bundle is not on the machine, because a check without its subject is
    worse than none.
    """
    import csv
    import gzip

    # OVERRIDABLE. Hard-coded absolute paths make this leg inert everywhere except the one
    # machine the fixtures were built on, and the only check that can catch a fixture
    # becoming synthetic should be runnable wherever the bundles are. The defaults are that
    # machine's paths; `XENIUM_REAL_BUNDLES` (a `:`-separated list of bundle roots) points it
    # anywhere else, and the skip message says so.
    override = os.environ.get("XENIUM_REAL_BUNDLES")
    if override:
        roots = [Path(r) for r in override.split(":") if r]
        sources = {}
        for name, root in zip(("real-lung.parquet", "real-breast.parquet"), roots):
            sources[name] = root / "cell_boundaries.csv.gz"
    else:
        _CCC = Path("/data/pbya/ccc/spatial-ccc-review/benchmark/scratch/data/tmp")
        sources = {
            "real-lung.parquet": _CCC / "human-lung-cancer/unpacked/cell_boundaries.csv.gz",
            "real-breast.parquet": (_CCC / "10x-xenium-human-breast-cancer-preview/unpacked"
                                    "/outs/cell_boundaries.csv.gz"),
        }
    checked = 0
    for name, source in sources.items():
        if not source.is_file():
            continue
        vendor = {}
        with gzip.open(source, "rt") as fh:
            reader = csv.reader(fh)
            next(reader)
            for cid, x, y in reader:
                vendor.setdefault(cid, []).append((x, y))
        rings, order = XF.expected_rings(XF.BOUNDARY_FIXTURES / name)
        for cid in order:
            assert cid in vendor, f"{name}: cell {cid!r} is not in the vendor's own file"
            assert rings[cid] == vendor[cid], (
                f"{name}: cell {cid!r} does not carry the vendor's own vertices — this "
                "fixture has stopped being real data and every claim resting on it is "
                "weaker than stated"
            )
        checked += 1
    if checked == 0:
        pytest.skip(
            "neither real vendor bundle is on this machine, so the fixtures' provenance "
            f"cannot be checked against its source ({sorted(str(s) for s in sources.values())})"
            ". Skipping rather than passing: the sidecar comparison above proves the two "
            "committed files agree, not that either is the vendor's."
        )


def test_the_build_script_states_the_gap_it_cannot_close():
    """The honest-limits claim, kept in the tree rather than only in a report."""
    source = (XF.BOUNDARY_FIXTURES / "build_boundaries_fixtures.py").read_text()
    assert "No vendor-AUTHORED `cell_boundaries.parquet` exists" in source, (
        "the fixture builder no longer states that its container is not vendor-written — "
        "the one limitation a reader of these fixtures most needs to know"
    )


def test_the_two_shipped_bundle_fixtures_are_still_boundary_free():
    """The absent-file path stays exercised by the WHOLE existing suite, on every run."""
    for bundle in (XF.PRIME, XF.PROTEIN):
        assert not list(bundle.rglob("cell_boundaries.*")), (
            f"{bundle.name} gained a boundaries file. Its absence is what makes every "
            "pre-existing test in this package a regression check on the no-boundaries "
            "path, for free."
        )
