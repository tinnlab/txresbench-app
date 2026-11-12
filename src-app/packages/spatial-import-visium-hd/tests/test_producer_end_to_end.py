#!/usr/bin/env python3
# ruff: noqa
"""TEST-22 / TEST-25 — the importer driven for real, asserted by READING THE BYTES BACK.

Three claims live here, and each is about what a CONSUMER gets rather than about what the
importer believed it did:

* **TEST-22** — the emitted `single-cell/counts` store round-trips to the fixture's own
  matrix values; the two axis-key artifacts digest to the `aligned_to` every other artifact
  was stamped with; and the emitted ROW ORDER is the MATRIX's barcode order, not the
  parquet's.
* **TEST-25** — the manifest's declared `produces` set is EXACTLY the set of datatypes the
  run emits, in both directions, and the output COUNT is stable so a silently dropped
  artifact is red.
* **the shipped entrypoint** — `main()` driven as a SUBPROCESS over the FLAT staged layout
  a real sandbox presents, which is the only proof that its slot-ordinal reconstruction
  works. `run_import` can be perfect and the job still fail at the first line of `main()`.

## Why the expected counts are rebuilt from the `.h5` with `h5py` and not with the importer

The importer's own matrix reader would compare the reader with itself. So `_fixture_matrix`
below opens `filtered_feature_bc_matrix.h5` directly and reconstructs the vendor's CSC —
`indptr` per BARCODE holding FEATURE ids, which is 10x's own layout — while the emitted
store is CSC over `(cells, genes)`, i.e. `indptr` per GENE holding CELL ids. The two are
transposes of each other, so agreeing between them is evidence rather than a tautology.

## Why the manifest is parsed and not restated

`produces` is read out of `manifest.yaml` at test time with `yaml.safe_load`. A hand-written
expected set here would be edited to match the day the manifest changed, which is the shape
of guard `docs/design/derived-guards.md` §1 refuses — it would enumerate an instance instead
of deriving the relation. `encoding="utf-8"` is EXPLICIT on every read in this file,
manifest and JSON alike: that manifest's prose carries µ and em dashes, so a locale-default
read dies under `LC_ALL=C` and the guard goes red for a reason unrelated to what it measures
(#330/#333/#336/#339).
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402

#: What ONE import of the committed fixture emits, in the PATH-PRESERVING layout. Pinned so
#: that a silently dropped artifact is a red test rather than a quieter manifest — see
#: `test_TEST_25_the_output_COUNT_is_stable`, which also says why the flat layout's count is
#: one lower.
EXPECTED_OUTPUT_IDS = (
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
    "spatial-image-lowres",
    "visium-hd-import-report",
    "visium-hd-import-summary",
    # APPENDED BY `write_manifest`, not by `run_import`, which is why it is LAST and why this
    # enumeration is taken from the manifest rather than from the returned entries.
    # `txr_deps.augment` is called on the one path every successful run passes through, so
    # that "a compute cannot emit its outputs without also emitting the record of the
    # environment that produced them" (`_lib/txr_deps.py`). This row was ABSENT from the
    # first cut of both the module and this list — the list was written from what the code
    # already emitted, which is exactly how an omission gets ratified by its own test.
    "run-environment",
)


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    """One real import of the committed fixture, shared by the suite (it is not free)."""
    out = tmp_path_factory.mktemp("hd-e2e")
    module, entries = HF.run_over(HF.FIXTURE, out)
    # THROUGH `write_manifest`, not around it: the run-environment record is appended THERE,
    # so a fixture that read `run_import`'s return value alone would be modelling a run that
    # never happened and would be blind to the record's absence.
    module.write_manifest(out, entries)
    return {"out": out, "entries": entries, "module": module}


def _fixture_matrix(bin_um):
    """The fixture's `.h5` read with `h5py` DIRECTLY — never through the importer's reader.

    Returns `(barcodes, gene_ids, dense)` where `dense[j, f]` is the count for the j-th
    barcode IN THE FILE'S OWN ORDER and the f-th feature. The vendor stores CSC over
    (features x barcodes): one `indptr` entry per barcode, `indices` holding feature ids —
    so this walks the file's own layout rather than assuming the importer's.
    """
    import h5py

    path = (HF.FIXTURE / "binned_outputs" / f"square_{bin_um:03d}um"
            / "filtered_feature_bc_matrix.h5")
    with h5py.File(path, "r") as h5:
        group = h5["matrix"]
        n_features, n_barcodes = (int(x) for x in np.asarray(group["shape"][:]).tolist())
        barcodes = [b.decode() for b in group["barcodes"][:]]
        gene_ids = [g.decode() for g in group["features"]["id"][:]]
        indptr = np.asarray(group["indptr"][:])
        indices = np.asarray(group["indices"][:])
        data = np.asarray(group["data"][:])

    dense = np.zeros((n_barcodes, n_features), dtype=np.float64)
    for j in range(n_barcodes):
        span = slice(int(indptr[j]), int(indptr[j + 1]))
        dense[j, indices[span]] = data[span]
    return barcodes, gene_ids, dense


def _emitted_cell(out, indptr, indices, data, cell, gene):
    """One cell of the emitted CSC store: `(cell, gene)` -> value, 0.0 where not stored."""
    span = slice(int(indptr[gene]), int(indptr[gene + 1]))
    hits = np.nonzero(indices[span] == cell)[0]
    if len(hits) == 0:
        return 0.0
    assert len(hits) == 1, (
        f"the emitted store lists cell {cell} {len(hits)} times inside gene {gene}'s column; "
        "a CSC column with a duplicated index has no single value at that cell"
    )
    return float(data[span][int(hits[0])])


def _stored_txr(out, rel_dir):
    """`attributes.txr` of a written store — the declaration mirrored into its OWN bytes.

    `hd_fixtures` exposes `store_declarations` (the `txr_spatial` sub-block) and
    `member_attributes` (one member's), but not the store root's whole `txr` block, which is
    where `aligned_to` and `key_sequence_digest` live. This is that one read; it is here
    rather than in the helper because only this file needs it.
    """
    doc = json.loads((Path(out) / rel_dir / "zarr.json").read_text(encoding="utf-8"))
    return doc.get("attributes", {}).get("txr", {})


# ── TEST-22: the counts store, the digests, and the row order ───────────────────────


def test_TEST_22_the_counts_store_round_trips_to_the_FIXTURES_OWN_matrix_values(imported):
    """TEST-22 — a sampled set of (barcode, gene) cells equals the vendor's own counts.

    Sampled rather than exhaustive, and the sample is chosen so it CANNOT be satisfied by a
    degenerate store: four barcodes spread across the axis, every gene, which on this fixture
    is ~30 % non-zero. The two controls at the end assert the sample really does contain both
    a stored value and an absent one — a comparison over an all-zero sample would pass for an
    importer that emitted an empty matrix, and one over an all-non-zero sample would pass for
    an importer that never wrote a zero.

    The expectation is reconstructed from the `.h5` with `h5py`, in the VENDOR's orientation
    (CSC over features x barcodes), while the emitted store is CSC over (cells x genes). The
    two are transposes, so this asserts across a real conversion instead of restating it.
    """
    module = imported["module"]
    out = imported["out"]
    barcodes, gene_ids, dense = _fixture_matrix(module.DEFAULT_BIN_UM)

    emitted_barcodes = [str(b) for b in HF.read_values(out, "axis/barcode.zarr")]
    emitted_genes = [str(g) for g in HF.read_values(out, "axis/gene_id.zarr")]
    indptr = HF.read_member(out, "expression.zarr", "indptr")
    indices = HF.read_member(out, "expression.zarr", "indices")
    data = HF.read_member(out, "expression.zarr", "data")

    assert len(indptr) == len(emitted_genes) + 1, (
        f"the emitted store's indptr has {len(indptr)} entries for {len(emitted_genes)} "
        "genes; a CSC over (cells, genes) has one indptr entry per gene plus one"
    )

    fixture_row = {b: j for j, b in enumerate(barcodes)}
    fixture_col = {g: f for f, g in enumerate(gene_ids)}
    sample_cells = sorted({0, len(emitted_barcodes) // 3, len(emitted_barcodes) // 2,
                           len(emitted_barcodes) - 1})
    seen_stored, seen_absent = 0, 0
    for cell in sample_cells:
        for gene in range(len(emitted_genes)):
            expected = dense[fixture_row[emitted_barcodes[cell]],
                             fixture_col[emitted_genes[gene]]]
            got = _emitted_cell(out, indptr, indices, data, cell, gene)
            assert got == pytest.approx(expected), (
                f"bin {emitted_barcodes[cell]!r} x gene {emitted_genes[gene]!r} reads back as "
                f"{got} where the vendor's own `.h5` holds {expected}"
            )
            if expected:
                seen_stored += 1
            else:
                seen_absent += 1

    assert seen_stored > 0, (
        "every sampled cell is zero, so this comparison would pass for an importer that "
        "emitted an empty matrix"
    )
    assert seen_absent > 0, (
        "no sampled cell is zero, so this comparison would pass for an importer that never "
        "wrote a structural zero — the sparsity itself has to be exercised"
    )


def test_TEST_22_the_stores_declared_NNZ_is_the_vendors_own_non_zero_count(imported):
    """TEST-22 — the sampled round-trip's blind spot, closed over the WHOLE matrix.

    A sample of four barcodes says nothing about the other forty-eight. The total number of
    stored values is a single cheap number that covers all of them: an importer that dropped
    a chunk of the matrix, or that wrote explicit zeros as stored entries, moves it. Counted
    off the STORED `indices` array rather than off the structure the writer returned.
    """
    module = imported["module"]
    out = imported["out"]
    _barcodes, _gene_ids, dense = _fixture_matrix(module.DEFAULT_BIN_UM)
    indices = HF.read_member(out, "expression.zarr", "indices")
    data = HF.read_member(out, "expression.zarr", "data")

    expected_nnz = int(np.count_nonzero(dense))
    assert len(indices) == expected_nnz, (
        f"the emitted store holds {len(indices)} stored values where the vendor's matrix has "
        f"{expected_nnz} non-zero counts"
    )
    assert len(data) == expected_nnz
    assert float(data.sum()) == pytest.approx(float(dense.sum())), (
        "the emitted counts do not sum to the vendor's own total, so values were dropped, "
        "duplicated or rescaled somewhere in the transpose"
    )


def test_TEST_22_both_axis_key_artifacts_digest_to_the_aligned_to_EVERYTHING_was_stamped_with(imported):
    """TEST-22 — one wrong digest here makes every alignment on this dataset silently wrong.

    Three legs, and the first is the one a self-consistency check cannot supply:

    1. the digest is RECOMPUTED from the key values READ BACK OUT OF THE STORE, so a writer
       that stamped a digest of the series it was handed while writing different bytes is
       caught;
    2. that recomputed digest equals the `key_sequence_digest` the key artifact carries in
       its own stored attributes;
    3. every other artifact's stored `aligned_to` — on the coordinates, on each metadata
       column — is that same digest for its axis.

    The alternative failure is not an error: it is a dataset whose columns line up against
    the wrong bins, which nothing downstream can see.
    """
    import txr_columns
    import pandas as pd

    out = imported["out"]
    digests = {}
    for axis, rel in (("cells", "axis/barcode.zarr"), ("genes", "axis/gene_id.zarr")):
        keys = [str(k) for k in HF.read_values(out, rel)]
        recomputed = txr_columns.axis_key_digest(pd.Series(keys))
        stored = _stored_txr(out, rel).get("key_sequence_digest")
        assert stored == recomputed, (
            f"the {axis} key artifact declares key_sequence_digest {stored!r} but the keys it "
            f"actually stores digest to {recomputed!r} — the stamp describes a sequence that "
            "is not the one on disk"
        )
        assert _stored_txr(out, rel).get("kind") == "table"
        digests[axis] = recomputed

    assert digests["cells"] != digests["genes"], (
        "the two axes digest to the same value, so this test cannot tell a correctly stamped "
        "artifact from one stamped with the wrong axis's digest"
    )

    aligned = {}
    for entry in imported["entries"]:
        stored = _stored_txr(out, entry["path"]) if entry["path"].endswith(".zarr") else {}
        if "aligned_to" in stored:
            aligned[entry["id"]] = (entry.get("axis"), stored["aligned_to"])
    assert aligned, (
        "no emitted store carries an `aligned_to` in its own bytes; the alignment stamp is "
        "the only channel a sandboxed consumer can read it on (#211)"
    )
    for output_id, (axis, stamp) in aligned.items():
        assert axis in digests, f"{output_id} is stamped on an axis this dataset has no keys for"
        assert stamp == digests[axis], (
            f"{output_id} is stamped aligned_to {stamp!r} on the {axis} axis, where the "
            f"{axis} key artifact digests to {digests[axis]!r}"
        )


def test_TEST_22_the_emitted_ROW_ORDER_is_the_MATRIXS_barcode_order_not_the_PARQUETS(imported):
    """TEST-22 — which of the two orders the dataset is in, asserted with its control.

    The fixture makes the two differ on purpose (`make_fixture.write_matrix_h5` reverses the
    matrix's barcode list). Both halves are needed: the positive alone would pass on a
    fixture where the two orders coincided, and the negative alone would pass on an importer
    that invented a third order of its own.

    It matters because the counts store is written straight out of the `.h5`'s CSC blocks —
    its rows ARE the matrix's rows — so a coordinates artifact in the parquet's order would
    attach every bin's position to another bin's counts, with every internal check passing.
    """
    import pyarrow.parquet as pq

    module = imported["module"]
    out = imported["out"]
    matrix_barcodes, _gene_ids, _dense = _fixture_matrix(module.DEFAULT_BIN_UM)
    emitted = [str(b) for b in HF.read_values(out, "axis/barcode.zarr")]

    assert emitted == matrix_barcodes, (
        "the emitted `cells` axis is not the filtered matrix's own barcode order, so the "
        "counts rows and the coordinate rows are two different orderings of the same bins"
    )

    parquet = pq.read_table(
        HF.FIXTURE / "binned_outputs" / f"square_{module.DEFAULT_BIN_UM:03d}um" / "spatial"
        / "tissue_positions.parquet"
    ).to_pydict()
    parquet_order = [b for b in parquet["barcode"] if b in set(matrix_barcodes)]
    assert parquet_order != matrix_barcodes, (
        "the fixture's positions table lists the matrix's barcodes in the matrix's own "
        "order, so this test cannot distinguish the two orderings — `make_fixture` must keep "
        "reversing the matrix's barcode list"
    )
    assert emitted != parquet_order, (
        "the emitted axis is in the POSITIONS TABLE's order; the counts store is in the "
        "matrix's, so every bin's counts now sit against another bin's coordinates"
    )
    assert len(set(emitted)) == len(emitted), "the emitted `cells` axis repeats a barcode"


# ── TEST-25: the manifest declares exactly what the run emits ───────────────────────


def _declared_produces():
    """The `produces` list this package's `manifest.yaml` declares, parsed at test time."""
    doc = yaml.safe_load(
        (HF.PKG / "manifest.yaml").read_text(encoding="utf-8")
    )
    analyses = doc["contributes"]["analyses"]
    assert len(analyses) == 1, (
        f"this manifest declares {len(analyses)} analyses; `produces` below is read off the "
        "single one this package ships"
    )
    return analyses[0]["id"], list(analyses[0]["produces"])


def test_TEST_25_the_declared_produces_set_is_EXACTLY_what_the_run_emits(imported):
    """TEST-25 — both directions, because each has its own consequence.

    A DECLARED-BUT-ABSENT datatype is a promise the server makes to the rest of the graph
    that this analysis will not keep: a downstream analysis narrowing on it is offered a
    producer that never produces it. An EMITTED-BUT-UNDECLARED one is an artifact the build
    gate never resolved and the planner cannot reason about.

    Read off `manifest.yaml` with `yaml.safe_load` at test time rather than restated here, so
    the day somebody adds a datatype to the declaration this test asks for the artifact
    instead of agreeing with the edit.
    """
    analysis_id, declared = _declared_produces()
    module = imported["module"]

    assert analysis_id == "spatial.import-visium-hd"
    assert len(declared) == len(set(declared)), (
        f"`produces` lists a datatype twice: {declared!r}"
    )

    emitted = {e["datatype"] for e in imported["entries"]}
    missing = sorted(set(declared) - emitted)
    undeclared = sorted(emitted - set(declared))

    assert not missing, (
        f"the manifest declares {missing!r} but no run over the committed fixture emits it — "
        "a downstream analysis narrowing on that datatype would be offered this importer as a "
        "producer that never produces it"
    )
    assert not undeclared, (
        f"the run emits {undeclared!r}, which `produces` does not declare — the build gate "
        "never resolved it and the planner cannot reason about it"
    )
    # …and the declaration is not vacuously satisfied by an empty run.
    assert emitted, "the run emitted no artifacts at all"


def test_TEST_25_the_output_COUNT_and_the_output_IDS_are_stable(imported):
    """TEST-25 — a silently dropped artifact must be RED, not merely quieter.

    The `produces` check above cannot see it: `metadata-column` is emitted nine times, so
    eight of them could vanish with the declared SET unchanged. So the ids are pinned here as
    a sequence.

    Pinned as an ENUMERATION deliberately, and it is the right shape for this one property:
    the claim is not "some artifacts were emitted", it is "these, in this order". Adding an
    artifact is supposed to require a line here — that is the review the pin buys.
    """
    entries = imported["entries"]
    ids = tuple(e["id"] for e in entries)

    assert ids == EXPECTED_OUTPUT_IDS, (
        "the emitted output set has changed. Dropped: "
        f"{sorted(set(EXPECTED_OUTPUT_IDS) - set(ids))!r}; added: "
        f"{sorted(set(ids) - set(EXPECTED_OUTPUT_IDS))!r}. If this is deliberate, the "
        "enumeration above is the review gate for it"
    )
    assert len(ids) == len(set(ids)), (
        "two outputs share an id; the server resolves an artifact by id, so the second is "
        "unreachable"
    )
    # THE RUN-ENVIRONMENT RECORD IS REAL, not just enumerated. An id in a list is satisfied by
    # a row; what provenance needs is the FILE, with this run's resolved library versions in
    # it, because `provenance/recorder.rs` lifts it from disk. The first cut of this module
    # emitted neither and no test could see it.
    environment = next(e for e in entries if e["id"] == "run-environment")
    record = json.loads(
        (Path(imported["out"]) / environment["path"]).read_text(encoding="utf-8"))
    libraries = record.get("libraries") or record.get("record", {}).get("libraries")
    assert libraries, (
        f"the run-environment record carries no resolved libraries: {sorted(record)}"
    )
    for entry in entries:
        assert (Path(imported["out"]) / entry["path"]).exists(), (
            f"{entry['id']} is declared at path {entry['path']!r}, which does not exist — the "
            "manifest points at an artifact that was never written"
        )


def test_TEST_25_manifest_json_is_WRITTEN_and_PARSES(imported):
    """TEST-25 — `/outputs/manifest.json` is the whole contract with the server.

    It is written by `write_manifest` as the LAST thing in a run, and everything else on
    disk is unreachable without it. Parsed here rather than merely stat-ed: a truncated or
    non-UTF-8 document exists and is still unusable.

    `ensure_ascii` is the module's stated choice, so this also asserts the file really is
    ASCII — a vendor string that survived every guard upstream must still reach the server as
    an escape rather than as raw bytes.
    """
    path = Path(imported["out"]) / "manifest.json"
    raw = path.read_bytes()
    document = json.loads(path.read_text(encoding="utf-8"))

    assert set(document) == {"outputs"}, (
        f"`manifest.json` carries top-level keys {sorted(document)}; the server reads "
        "`{'outputs': [...]}`"
    )
    assert [e["id"] for e in document["outputs"]] == [e["id"] for e in imported["entries"]]
    for entry in document["outputs"]:
        assert {"id", "datatype", "path", "layout", "role", "structure"} <= set(entry), (
            f"the manifest entry {entry.get('id')!r} is missing a required key: {sorted(entry)}"
        )
    raw.decode("ascii")  # raises if a raw non-ASCII byte reached the server's document


# ── the SHIPPED ENTRYPOINT, over the FLAT layout a real sandbox stages ──────────────


def test_the_SHIPPED_ENTRYPOINT_runs_over_the_FLAT_staged_layout(tmp_path):
    """`main()`'s slot-ordinal reconstruction, proved the only way it can be.

    `dataset/process.rs::build_dataset_inputs` does NOT hand a multi-file dataset over as a
    tree. It writes twelve files named `{i}_{basename}` into one flat directory and binds
    them at `bundle_{i}`, so the `square_NNNum/` segment reaches the compute only as that
    integer — and `main()` is where that integer is recovered, from the SLOT NAMES in
    `inputs.json`. Nothing in an in-process `run_import` test touches that code: `run_over`
    is handed the ordinals ready-made.

    So this drives the real file as a subprocess over the real flat staging, and then asserts
    the manifest it wrote is the SAME SHAPE as an in-process run over THE SAME INPUTS —
    entry for entry, in order, on id, datatype, layout, path and role. Comparing against the
    flat in-process run rather than against the tree run is deliberate: the flat layout
    carries no `tissue_lowres_image.png` (it is not one of the twelve DECLARED members), so
    the two layouts legitimately differ by one image and a comparison across them would
    prove the wrong thing.
    """
    inputs, ordinals = HF.staged_flat(tmp_path)
    module, expected = HF.run_over(inputs, tmp_path / "in-process", slot_ordinals=ordinals)
    # THROUGH `write_manifest`, because that is what `main()` calls and it is where the
    # run-environment record is appended. Comparing `run_import`'s bare return value against a
    # subprocess's written manifest would report a one-row difference on every correct build
    # and teach the next reader to relax the comparison.
    module.write_manifest(tmp_path / "in-process", expected)

    result = HF.run_entry(inputs, tmp_path / "subprocess")
    assert result.returncode == 0, (
        f"the shipped entrypoint exited {result.returncode} over the flat layout a real "
        f"sandbox stages. stderr:\n{result.stderr}"
    )
    assert "Traceback" not in result.stderr, (
        f"the entry printed a traceback:\n{result.stderr}"
    )

    written = json.loads(
        (tmp_path / "subprocess" / "manifest.json").read_text(encoding="utf-8")
    )["outputs"]

    def shape(entries):
        return [(e["id"], e["datatype"], e["layout"], e["path"], e["role"]) for e in entries]

    assert shape(written) == shape(expected), (
        "the manifest `main()` wrote over the FLAT layout differs from the one `run_import` "
        "produces over the same inputs — the slot-ordinal reconstruction did not recover the "
        "same bundle"
    )
    for entry in written:
        assert (tmp_path / "subprocess" / entry["path"]).exists(), (
            f"{entry['id']} is declared at {entry['path']!r}, which the entry did not write"
        )


def test_the_FLAT_layout_recovers_the_SAME_BIN_and_the_same_coordinates(tmp_path):
    """The entrypoint test's other half: the same SHAPE could still be the wrong BIN.

    A manifest with identical ids, paths and datatypes would be produced by a run that
    reconstructed the ordinals wrongly and imported the 2 um or 16 um bin instead — every
    entry the same, every number different. So this compares the CONTENT: the report's bin
    and the coordinates that landed.

    Read out of the two runs' emitted bytes, and the bin is additionally checked against the
    fixture's own lattice so that "both runs agree" cannot mean "both are wrong the same way".
    """
    inputs, ordinals = HF.staged_flat(tmp_path)
    module, _entries = HF.run_over(inputs, tmp_path / "in-process", slot_ordinals=ordinals)
    result = HF.run_entry(inputs, tmp_path / "subprocess")
    assert result.returncode == 0, result.stderr

    reports = {}
    for name in ("in-process", "subprocess"):
        reports[name] = json.loads(
            (tmp_path / name / "visium-hd-import-report.json").read_text(encoding="utf-8")
        )
    assert reports["subprocess"]["bin_um"] == reports["in-process"]["bin_um"]
    assert reports["subprocess"]["bin_um"] == module.DEFAULT_BIN_UM, (
        f"the flat-staged run imported the {reports['subprocess']['bin_um']} um bin where no "
        f"parameter was given and the default is {module.DEFAULT_BIN_UM} um"
    )
    expected_rows = sum(1 for r in MF.positions_rows(module.DEFAULT_BIN_UM) if r[1] == 1)
    assert reports["subprocess"]["n_bins"] == expected_rows, (
        "the flat-staged run imported a different number of bins than the fixture's default "
        "bin has under tissue, so the staging ordinals resolved to the wrong lattice"
    )

    from_entry = HF.read_member(tmp_path / "subprocess", "spatial/coordinates.zarr",
                                "coordinates")
    from_process = HF.read_member(tmp_path / "in-process", "spatial/coordinates.zarr",
                                  "coordinates")
    assert np.array_equal(from_entry, from_process), (
        "the coordinates the shipped entrypoint wrote differ from the ones `run_import` "
        "writes over the same staged inputs"
    )


# ── TEST-41: everything this run writes is STRICT JSON ─────────────────────────────


def _strict_json(path):
    """Parse with the non-standard constants REFUSED, the way a strict reader does.

    `json.loads` accepts `NaN`/`Infinity` — they are a Python extension — so the DEFAULT
    parser cannot see this defect at all. `parse_constant` is the hook that turns them into
    an error, and it is what makes this test a test rather than a round-trip.
    """
    def refuse(constant):
        raise ValueError(f"non-strict JSON constant {constant!r}")

    return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=refuse)


def test_TEST_41_a_NON_FINITE_vendor_number_cannot_make_the_MANIFEST_unparseable(tmp_path):
    """TEST-41 — the outputs manifest is what the server reads to find every artifact.

    ## The defect

    The whole scale document is copied verbatim into the report, and `spot_diameter_fullres`
    into an artifact's `meta`. `json.loads` ACCEPTS `NaN`/`Infinity` and `json.dumps` writes
    them straight back out (`allow_nan` defaults True) — so one non-finite number, in a key
    this importer never reads, made both `visium-hd-import-report.json` (declared
    `application/json`) and `/outputs/manifest.json` unparseable by a strict reader.
    `outputs.rs::parse_manifest` uses `serde_json::from_slice`, which is strict RFC 8259, so
    a COMPLETE, CORRECT import was discarded as `OUTPUTS_MANIFEST_INVALID` after paying the
    full compute cost — with no statement anywhere about which bundle caused it.

    ## What is asserted

    The import still SUCCEEDS (INV-5: damage degrades, it does not become a total loss), both
    JSON files parse under a strict reader, and the substitution is DISCLOSED by name rather
    than performed silently — a reader must not be left believing they have the vendor's file.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    scale_path = (Path(root) / "binned_outputs" / "square_008um" / "spatial"
                  / "scalefactors_json.json")
    doc = json.loads(scale_path.read_text(encoding="utf-8"))
    doc["spot_diameter_fullres"] = float("inf")
    scale_path.write_text(json.dumps(doc), encoding="utf-8")
    assert "Infinity" in scale_path.read_text(encoding="utf-8"), (
        "the hostile input did not survive being written, so this test proves nothing")

    out = tmp_path / "out"
    entries = module.run_import(root, out)
    module.write_manifest(out, entries)

    assert HF.entry_by_id(entries, "expression") is not None, (
        "one unwritable number in an optional scale key cost the user their whole import")

    for name in ("manifest.json", "visium-hd-import-report.json"):
        try:
            _strict_json(out / name)
        except ValueError as exc:
            raise AssertionError(
                f"{name} is not strict JSON ({exc}). `outputs.rs::parse_manifest` reads the "
                f"manifest with `serde_json::from_slice`, which rejects it — so this whole "
                f"successful import would be discarded as OUTPUTS_MANIFEST_INVALID."
            ) from None

    report = json.loads((out / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    assert report.get("scalefactors_unrepresentable_numbers") == ["spot_diameter_fullres"], (
        f"the substitution is not disclosed by key: "
        f"{report.get('scalefactors_unrepresentable_numbers')!r}")
    assert "scalefactors_note" in report and "JSON cannot express" in report["scalefactors_note"]


def test_TEST_41_the_ORDINARY_bundle_writes_strict_JSON_and_no_note(imported):
    """TEST-41 — the control. Without it, "strict JSON" is satisfied by a run that always
    substitutes, and the disclosure would appear on every clean import.
    """
    out = Path(imported["out"])
    _strict_json(out / "manifest.json")
    report = json.loads((out / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    assert "scalefactors_unrepresentable_numbers" not in report, (
        "a clean bundle reports a substitution that did not happen")
    assert "scalefactors_note" not in report
    assert isinstance(report["scalefactors"]["spot_diameter_fullres"], float), (
        "the clean bundle's vendor number did not survive as a number")
