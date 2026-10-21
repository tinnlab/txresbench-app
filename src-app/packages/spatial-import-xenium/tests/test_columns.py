#!/usr/bin/env python3
# ruff: noqa
"""The per-cell and per-gene columns, read back and compared to the vendor's own text.

Two things are being proven here and they are easy to conflate:

* the **axis-key artifacts ARE the row space**, not a description of it — their stored bytes
  must digest to the very `aligned_to` stamped on every other artifact of that axis. A
  mismatch makes every alignment on the dataset silently wrong, and the conformance gate
  would then fail rows one by one with nothing saying why;
* the **vendor's own per-cell measurements survive the join**, in the MATRIX's cell order.
  The columns are re-derived here from the raw `cells.csv.gz` text rather than from
  anything this package ships, so a shared bug in the importer's reader cannot make both
  sides agree.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

import cyto_zarr_read as CZR  # noqa: E402


def _imported(tmp_path_factory, bundle, slug):
    out = tmp_path_factory.mktemp(slug)
    module, entries = XF.run_over(bundle, out)
    return {"out": out, "entries": entries, "module": module, "bundle": bundle,
            "report": json.loads((out / "xenium-import-report.json").read_text())}


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PRIME, "columns-prime")


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PROTEIN, "columns-protein")


def _column_entry(entries, name):
    return XF.entry(entries, f"metadata-column:{name}")


def _vendor_rows_in_matrix_order(bundle):
    """`(header, rows)` from `cells.csv.gz`, reordered to the MATRIX's cell order.

    The reordering is the whole point: the importer JOINS on `cell_id`, and a test that
    compared against the CSV's own order would pass for a positional zip too.
    """
    header, rows = XF.cells_table(bundle)
    id_index = header.index("cell_id")
    by_id = {r[id_index]: r for r in rows}
    ordered = [by_id[c] for c in XF.matrix_cell_ids(bundle)]
    return header, ordered


# ── the axis-key artifacts ARE the row space ─────────────────────────────────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_cell_key_artifact_digests_to_the_aligned_to_everything_else_carries(
    case, prime, protein
):
    """TEST-24 — the self-check that stops a silently-wrong alignment.

    `cell_id` carries `holds_axis_keys`, so the writer emits `key` +
    `key_sequence_digest` from the bytes it actually wrote. Every other artifact on the
    cells axis was stamped with a digest computed BEFORE the write. If the two disagree the
    dataset is internally inconsistent in a way no consumer can see, so the importer refuses
    the run — and this asserts the agreement rather than the refusal, because the refusal
    only fires on a broken write.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    key_entry = _column_entry(ctx["entries"], "cell_id")
    assert key_entry["axis"] == "cells"
    assert key_entry["meta"]["is_axis_index"] is True
    digest = key_entry["structure"]["key_sequence_digest"]
    assert digest

    coords = XF.entry(ctx["entries"], "spatial-coordinates")
    assert coords["structure"]["aligned_to"] == digest, (
        "the coordinates artifact is stamped with a different cells digest than the cell "
        "key artifact's own bytes produce"
    )
    for e in ctx["entries"]:
        if e["datatype"] == "single-cell/counts":
            assert e["meta"]["aligned_to"] == digest

    # …and the stored VALUES are the matrix's cell ids, in order.
    stored = list(CZR.read_column(str(ctx["out"] / key_entry["path"])))
    assert stored == XF.matrix_cell_ids(ctx["bundle"])


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_gene_key_artifact_digests_to_the_primary_matrixs_genes_digest(
    case, prime, protein
):
    """TEST-24 — the same self-check on the genes axis.

    The genes axis is the one that is NOT shared across the emitted stores (each feature
    class is its own key sequence), so the key artifact belongs to the PRIMARY store and
    must agree with it specifically.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    key_entry = _column_entry(ctx["entries"], "gene_id")
    assert key_entry["axis"] == "genes"
    assert key_entry["meta"]["is_axis_index"] is True
    digest = key_entry["structure"]["key_sequence_digest"]

    primary = XF.entry(ctx["entries"], "expression")
    assert primary["meta"]["genes_key_sequence_digest"] == digest, (
        "the gene key artifact and the primary matrix disagree about the genes axis"
    )
    assert ctx["report"]["feature_classes"]["Gene Expression"][
        "genes_key_sequence_digest"] == digest


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_gene_axis_carries_symbol_and_feature_type(case, prime, protein):
    """TEST-24 — the two gene-axis descriptors, aligned rather than assumed.

    `gene_symbol` is what a human reads; `feature_type` is the only per-feature record of
    which vendor class a gene came from once the stores are split. Both must carry
    `aligned_to` (they are not the key), and both must be the same length as the primary
    store's gene axis.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    n_genes = XF.entry(ctx["entries"], "expression")["structure"]["shape"][1]
    gene_digest = _column_entry(ctx["entries"], "gene_id")[
        "structure"]["key_sequence_digest"]

    for name in ("gene_symbol", "feature_type"):
        e = _column_entry(ctx["entries"], name)
        assert e["axis"] == "genes"
        assert e["structure"]["aligned_to"] == gene_digest, (
            f"{name} is not stamped with the genes digest"
        )
        assert "key_sequence_digest" not in e["structure"], (
            f"{name} must not claim to BE the axis key"
        )
        values = list(CZR.read_column(str(ctx["out"] / e["path"])))
        assert len(values) == n_genes

    # `feature_type` on the primary store's genes is uniformly the primary class — this is
    # what makes the split legible from the columns alone.
    types = set(CZR.read_column(str(ctx["out"] / "axis/feature_type.zarr")))
    assert types == {"Gene Expression"}


# ── the vendor's per-cell measurements survive the join, value for value ─────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_every_vendor_per_cell_column_round_trips_value_exact(case, prime, protein):
    """TEST-24 — the vendor's own numbers, re-derived from the raw text.

    The expected values are parsed from `cells.csv.gz` HERE, with the cast the importer
    declares in `VENDOR_CELL_COLUMNS`, and reordered into the matrix's cell order. That
    reordering is what makes the comparison meaningful: a positional read would pass
    against the CSV's own order on both real bundles, because they happen to agree.

    Value-exact, not close. These are the vendor's measurements and the importer applies no
    transform to them, so anything but equality means one was applied and not declared.

    `equal_nan=True`, and that is a claim about the data rather than a loosening. The
    protein bundle really writes `NaN` for two cells' `nucleus_area` — the vendor's own way
    of saying a cell has no segmented nucleus — and `NaN != NaN`, so a plain comparison
    fails on values that round-tripped perfectly. The NON-loosening half is asserted
    separately below: those NaNs must still BE NaN in the store, not zero-filled.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    module = ctx["module"]
    header, ordered = _vendor_rows_in_matrix_order(ctx["bundle"])

    checked = 0
    for name, cast in module.VENDOR_CELL_COLUMNS:
        if name not in header:
            continue
        index = header.index(name)
        expected = [cast(row[index]) for row in ordered]
        e = _column_entry(ctx["entries"], name)
        assert e["axis"] == "cells"
        stored = np.asarray(CZR.read_column(str(ctx["out"] / e["path"])))
        assert len(stored) == len(expected), f"{name}: length differs"
        assert np.array_equal(stored.astype(np.float64),
                              np.asarray(expected, dtype=np.float64),
                              equal_nan=True), (
            f"{name}: a value differs from the vendor's own cells.csv.gz"
        )
        checked += 1

    assert checked == len(module.VENDOR_CELL_COLUMNS), (
        f"only {checked} of {len(module.VENDOR_CELL_COLUMNS)} declared vendor columns were "
        "found in this fixture's header — a column silently missing from the fixture would "
        "shrink this test without failing it"
    )


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_per_cell_segmentation_method_is_kept_verbatim(case, prime, protein):
    """TEST-24 — the row-level truth DEC-12's single `method` string cannot hold.

    `measured_entity.segmentation.method` is one string per RUN. The protein fixture really
    carries three methods across its cells, so without this column a mixed run would be
    labelled and not analysable. Compared verbatim against the vendor's text, including its
    `µ`.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    header, ordered = _vendor_rows_in_matrix_order(ctx["bundle"])
    index = header.index("segmentation_method")
    expected = [row[index] for row in ordered]

    e = _column_entry(ctx["entries"], "segmentation_method")
    assert e["axis"] == "cells"
    stored = list(CZR.read_column(str(ctx["out"] / e["path"])))
    assert stored == expected

    # And the run-level declaration is derived from exactly this column's distinct values.
    declared = ctx["report"]["measured_entity"]["segmentation"]["params"]["methods"]
    assert declared == sorted(set(expected))


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_platform_and_measurement_unit_are_present_for_a_future_disclosure(
    case, prime, protein
):
    """TEST-24 — §9 point 3's dispatch handle.

    The design files the scientific-disclosure problem as a separate item but says the
    importer "should stamp a `platform` / `measurement_unit` metadata-column so a future
    disclosure has something to DISPATCH ON". This item owes the column; it does not owe
    the disclosure.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    n_cells = XF.entry(ctx["entries"], "expression")["structure"]["shape"][0]

    platform = list(CZR.read_column(str(ctx["out"] / "metadata/platform.zarr")))
    unit = list(CZR.read_column(str(ctx["out"] / "metadata/measurement_unit.zarr")))
    assert platform == ["xenium"] * n_cells
    assert unit == ["cell"] * n_cells, (
        "a Xenium row IS a segmented cell (§6.1); this column is what a disclosure layer "
        "reads to know that, without re-deriving it from the platform"
    )


# ── #183 Option A: the siblings a filter can gather ─────────────────────────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_component_columns_are_bit_equal_to_the_two_dimensional_member(
    case, prime, protein
):
    """TEST-24 — #183 Option A, and the reason it is not decorative.

    A filter virtual dataset re-mints `structure` and gathers strictly 1-D, so the 2-D
    coordinates member loses its second dimension and points at a member that does not
    exist. The two ordinary 1-D siblings survive that path, and `meta.component_columns` is
    the ONLY channel the declaration itself survives in (`meta` is copied verbatim by the
    gather; `structure` is not).

    Bit-equal, not close: they are the same numbers stored twice, and a float32/float64
    round trip between them would make a filtered tissue map draw fractionally off the
    unfiltered one with nothing saying so.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    module = ctx["module"]
    coords_entry = XF.entry(ctx["entries"], "spatial-coordinates")
    member = CZR.read_array(str(ctx["out"] / "spatial/coordinates.zarr"), "coordinates")

    declared = coords_entry["meta"]["component_columns"]
    assert declared == [module.COMPONENT_X, module.COMPONENT_Y], (
        "the declaration must name the two sibling columns, in (x, y) order"
    )

    for axis, name in enumerate(declared):
        e = _column_entry(ctx["entries"], name)
        assert e["axis"] == "cells"
        stored = CZR.read_array(str(ctx["out"] / e["path"]), "values")
        assert stored.dtype == np.float32, (
            f"{name} is {stored.dtype}; float32 is what makes it bit-identical to the "
            "member column it mirrors"
        )
        assert np.array_equal(stored, member[:, axis]), (
            f"{name} is not bit-equal to column {axis} of the coordinates member"
        )


def test_a_vendor_NaN_survives_as_NaN_rather_than_being_zero_filled(protein):
    """TEST-24 — absence is absence, in a column the vendor left empty.

    Measured, not hypothetical: the protein bundle writes `NaN` for `nucleus_area` on TWO
    of its 358 cells — that is 10x saying those cells have no segmented nucleus. A zero
    would be a real area of zero and a reader could not tell the two apart, which is the
    same fabrication rule the importer applies to z and to protein.

    This is also the control on `equal_nan=True` in the round-trip test above: with the
    NaNs zero-filled that comparison would still pass, and only this assertion would fail.
    """
    header, ordered = _vendor_rows_in_matrix_order(XF.PROTEIN)
    index = header.index("nucleus_area")
    expected_nan = [i for i, row in enumerate(ordered)
                    if row[index].strip().lower() == "nan"]
    assert len(expected_nan) == 2, (
        f"the fixture must really carry NaN nucleus areas (found {len(expected_nan)}); "
        "without them this assertion is vacuous"
    )

    e = _column_entry(protein["entries"], "nucleus_area")
    stored = np.asarray(CZR.read_column(str(protein["out"] / e["path"])))
    assert stored.dtype == np.float64, (
        "an integer or float32 store would not be able to carry NaN at all"
    )
    assert [int(i) for i in np.nonzero(np.isnan(stored))[0]] == expected_nan, (
        "the vendor's NaNs must survive at exactly the cells that carry them"
    )
    assert e["meta"].get("n_missing") == 2, (
        "and the column must DECLARE how many values are missing, so a consumer does not "
        "have to scan for them"
    )
