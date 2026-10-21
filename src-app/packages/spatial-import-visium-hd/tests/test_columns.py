#!/usr/bin/env python3
# ruff: noqa
"""TEST-23 — the per-bin columns, asserted against THE BYTES THAT LANDED.

The importer emits seven 1-D columns on the `cells` axis, and this file proves the four
claims that make them usable rather than merely present:

* `in_tissue` is a CATEGORICAL with a declared `["false","true"]` legend — a filterable,
  colour-by-able flag rather than a number whose encoding a user has to guess;
* `array_row` / `array_col` are `int32` and hold the vendor's own lattice indices AFTER the
  barcode join;
* `spatial_x` / `spatial_y` are BIT-IDENTICAL `float32` to the two columns of the 2-D
  coordinates member (#183 Option A);
* the coordinates artifact's `meta.component_columns` names exactly those two.

## Why every comparison is PER BARCODE and never positional

The fixture's filtered matrix is written in the REVERSE of the positions table's order
(`make_fixture.write_matrix_h5`: "Reversed, so 'the matrix's order' and 'the positions
table's order' are visibly different and a positional join cannot pass by coincidence").
A positional comparison here would agree with an importer that zipped the two tables — an
import that is wrong in every row and errors in none — so the parquet is indexed by barcode
and the emitted rows are addressed through the emitted `axis/barcode.zarr`.

## Why the values are read BACK and not taken off the writer's return

A producer that returns a correct declaration and writes something else is exactly the
failure a read-back test exists to catch, so every VALUE assertion below goes through
`HF.read_member` / `HF.read_values` — `_lib`'s own reader, over the store on disk.

The one claim that CANNOT be read back is the legend. `cyto_columns.write_metadata_column`
stores a bool column as a plain bool array and says so outright — "the legend is a display
fact, not a storage one, so it rides on `meta` … this `levels` is the ONLY copy" — so there
is no `attributes.cyto.levels` to read. It is therefore asserted against `manifest.json` AS
WRITTEN BY THE SHIPPED WRITER (`module.write_manifest`), which is the document the server
actually consumes, rather than against the in-memory `entries` list alone.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    """One real import of the committed fixture, plus the manifest the shipped writer emits.

    Module-scoped because the run is the expensive part and every test here reads the SAME
    emitted bytes — which is also the honest arrangement: these are four claims about one
    set of artifacts, not four independent imports that happen to agree.
    """
    out = tmp_path_factory.mktemp("hd-columns")
    module, entries = HF.run_over(HF.FIXTURE, out)
    module.write_manifest(out, entries)
    manifest = json.loads((Path(out) / "manifest.json").read_text(encoding="utf-8"))
    return {"out": out, "entries": entries, "module": module, "manifest": manifest}


def _manifest_entry(imported, output_id):
    """One entry out of the WRITTEN `manifest.json` — the bytes the server reads."""
    hits = [e for e in imported["manifest"]["outputs"] if e["id"] == output_id]
    assert len(hits) == 1, (
        f"`manifest.json` carries {len(hits)} entries with id {output_id!r}; the server "
        "resolves an artifact by that id, so anything but exactly one is unresolvable"
    )
    return hits[0]


def _positions_by_barcode(bin_um):
    """The fixture's parquet as `{barcode: row dict}`, read INDEPENDENTLY of the importer.

    Through `pyarrow` directly and not through `module.read_positions`: an expectation built
    with the reader under test would compare that reader with itself.
    """
    import pyarrow.parquet as pq

    path = (HF.FIXTURE / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial"
            / "tissue_positions.parquet")
    table = pq.read_table(path).to_pydict()
    return {
        barcode: {name: table[name][i] for name in table}
        for i, barcode in enumerate(table["barcode"])
    }


def _emitted_barcodes(imported):
    """The emitted `cells` axis keys, read back out of `axis/barcode.zarr`."""
    return [str(b) for b in HF.read_values(imported["out"], "axis/barcode.zarr")]


# ── in_tissue: a flag with a legend, not a number ───────────────────────────────────


def test_TEST_23_in_tissue_is_a_CATEGORICAL_with_a_declared_false_true_legend(imported):
    """TEST-23 — the legend is what makes `in_tissue` a FLAG rather than a bare 0/1 array.

    Without `kind: categorical` and the two-item legend, the client offers this column as a
    numeric to colour a continuous ramp by, and a user filtering "in tissue" has to know that
    the vendor writes 1 for yes. Both facts are read out of the WRITTEN `manifest.json`,
    which is the document the server consumes.

    The declaration is then checked against the STORED VALUES: a legend of `["false","true"]`
    over a column that landed as anything but a two-valued boolean would be a declaration
    about data that is not there.
    """
    entry = _manifest_entry(imported, "metadata-column:in_tissue")
    meta = entry["meta"]

    assert meta["kind"] == "categorical", (
        f"`in_tissue` is declared {meta['kind']!r}, so the client will offer a tissue-call "
        "flag as a continuous numeric and a user cannot filter on it by name"
    )
    assert meta["levels"] == ["false", "true"], (
        f"the declared legend is {meta.get('levels')!r}; a reader has no other channel for "
        "it — `cyto_columns` stores a bool column as a plain bool array with no "
        "`attributes.cyto.levels` to fall back on"
    )

    values = HF.read_member(imported["out"], "metadata/in_tissue.zarr", "values")
    assert values.dtype == np.dtype(bool), (
        f"the stored `in_tissue` values are {values.dtype}, which a two-item false/true "
        "legend does not describe"
    )
    assert set(np.unique(values)) <= {True, False}


def test_TEST_23_in_tissue_carries_the_VENDORS_call_for_the_matrixs_own_bins(imported):
    """TEST-23 — the legend is only worth having if the values under it are the vendor's.

    Compared per barcode against the parquet's own `in_tissue`. The interesting half is the
    CONTROL at the end: the filtered matrix holds only in-tissue squares, so this column is
    uniformly `True` — which means an importer that emitted a constant `True` array would
    pass the equality. The control asserts that the parquet DOES carry both calls, so the
    uniformity is a fact about the filtered matrix and not about a column that forgot to read
    anything.
    """
    module = imported["module"]
    by_barcode = _positions_by_barcode(module.DEFAULT_BIN_UM)
    values = HF.read_member(imported["out"], "metadata/in_tissue.zarr", "values")
    barcodes = _emitted_barcodes(imported)

    assert len(barcodes) == len(values)
    for i, barcode in enumerate(barcodes):
        expected = bool(by_barcode[barcode]["in_tissue"])
        assert bool(values[i]) == expected, (
            f"bin {barcode!r} is emitted as in_tissue={bool(values[i])} where the vendor's "
            f"own positions table says {expected}"
        )

    calls = {bool(row["in_tissue"]) for row in by_barcode.values()}
    assert calls == {True, False}, (
        "the fixture's positions table carries only one tissue call, so this comparison "
        "cannot distinguish a column that read the vendor's value from one that emitted a "
        "constant"
    )


# ── array_row / array_col: int32, and joined ────────────────────────────────────────


@pytest.mark.parametrize("name", ["array_row", "array_col"])
def test_TEST_23_the_lattice_indices_are_int32_and_match_the_parquet_PER_BARCODE(imported, name):
    """TEST-23 — the vendor's own lattice indices, at the width they were declared at.

    `int32` matters on its own: `cyto_columns` keeps integers "at the SOURCE width", and a
    column silently widened to `int64` or floated to `1.0`/`2.0` is a different artifact from
    the one the manifest declares. It is asserted on the STORED array's dtype, not on the
    structure the writer returned.

    The join is the other half. `array_row` is a small integer and the lattice is 10 x 16 at
    the default bin, so a positionally-zipped column is still full of plausible values in the
    right range — nothing about the emitted array looks wrong. Only a per-barcode comparison
    can see it, which is why the fixture's matrix order is deliberately the reverse of the
    parquet's.
    """
    module = imported["module"]
    by_barcode = _positions_by_barcode(module.DEFAULT_BIN_UM)
    values = HF.read_member(imported["out"], f"metadata/{name}.zarr", "values")
    barcodes = _emitted_barcodes(imported)

    assert values.dtype == np.dtype(np.int32), (
        f"`{name}` landed as {values.dtype}; the vendor writes it int32 and this importer "
        "declares it int32, so any other width is an artifact that does not match its own "
        "manifest entry"
    )
    assert _manifest_entry(imported, f"metadata-column:{name}")["meta"]["dtype"] == "int32"

    assert len(barcodes) == len(values)
    for i, barcode in enumerate(barcodes):
        assert int(values[i]) == int(by_barcode[barcode][name]), (
            f"bin {barcode!r} is emitted with {name}={int(values[i])} where the parquet's row "
            f"for that barcode says {int(by_barcode[barcode][name])} — the columns were "
            "attached to the matrix's rows positionally rather than through the barcode join"
        )


def test_TEST_23_a_POSITIONAL_read_of_the_lattice_indices_would_be_a_DIFFERENT_column(imported):
    """TEST-23 — the control the join assertion above depends on.

    `make_fixture` reverses the matrix's barcode order on purpose. If a later fixture edit
    dropped that reversal, the per-barcode comparison above would pass for a positionally
    zipped importer and the join would be untested while looking tested. So the positional
    column is CONSTRUCTED here and asserted to differ from the emitted one.
    """
    module = imported["module"]
    import pyarrow.parquet as pq

    path = (HF.FIXTURE / "binned_outputs" / f"square_{module.DEFAULT_BIN_UM:03d}um" / "spatial"
            / "tissue_positions.parquet")
    table = pq.read_table(path).to_pydict()
    emitted = HF.read_member(imported["out"], "metadata/array_row.zarr", "values")
    positional = np.asarray(table["array_row"][:len(emitted)], dtype=np.int32)

    assert not np.array_equal(emitted, positional), (
        "the emitted `array_row` column equals the parquet's FIRST N rows in file order, so "
        "this fixture cannot distinguish a barcode join from a positional zip — the matrix's "
        "barcode order must stay different from the positions table's (see "
        "`make_fixture.write_matrix_h5`)"
    )


# ── spatial_x / spatial_y: the 1-D mirrors of the 2-D member (#183 Option A) ────────


def test_TEST_23_the_component_columns_are_BIT_IDENTICAL_float32_to_the_2D_member(imported):
    """TEST-23 — `spatial_x`/`spatial_y` are the SAME numbers as the coordinates member.

    Bit-identical rather than close, and the reason is behavioural: after a filter, the
    client draws the tissue map from these 1-D siblings, while an unfiltered view draws it
    from the 2-D member. A tolerance here would admit a `float64` sibling that rounds
    differently, and the same bin would then land in two different places depending on which
    artifact happened to be read.

    `dtype` is asserted separately from the values, because `np.array_equal` is true across
    dtypes: a `float64` column holding exactly the float32 values would satisfy the equality
    and still be the wrong artifact.
    """
    module = imported["module"]
    coords = HF.read_member(imported["out"], "spatial/coordinates.zarr", "coordinates")
    assert coords.dtype == np.dtype(np.float32)
    assert coords.shape[1] == 2

    for column, index in ((module.COMPONENT_X, 0), (module.COMPONENT_Y, 1)):
        values = HF.read_member(imported["out"], f"metadata/{column}.zarr", "values")
        assert values.dtype == np.dtype(np.float32), (
            f"`{column}` landed as {values.dtype} where the 2-D member is float32; the same "
            "bin would then be drawn at two slightly different places depending on whether a "
            "view was filtered"
        )
        assert np.array_equal(values, coords[:, index]), (
            f"`{column}` is not bit-identical to column {index} of the coordinates member"
        )

    # …and the two are not each OTHER, which is what a transpose in the siblings alone would
    # look like. On this non-square lattice that is a real distinction.
    xs = HF.read_member(imported["out"], f"metadata/{module.COMPONENT_X}.zarr", "values")
    ys = HF.read_member(imported["out"], f"metadata/{module.COMPONENT_Y}.zarr", "values")
    assert not np.array_equal(xs, ys), (
        "`spatial_x` and `spatial_y` hold the same values, so this fixture cannot tell a "
        "correct pair from a transposed one"
    )


def test_TEST_23_the_coordinates_artifact_DECLARES_exactly_those_two_component_columns(imported):
    """TEST-23 — the declaration is the address the client resolves the siblings by.

    Asserted as an EQUALITY against the two module constants, not as a containment: an extra
    name in the list is an address that resolves to nothing, and a missing one leaves the
    Coordinates picker offering a tissue map it cannot draw after a filter.

    Read out of the WRITTEN `manifest.json`, and then each declared name is resolved against
    the artifacts that actually landed — because a declaration nothing checks is exactly how
    an artifact becomes offered-but-blank.
    """
    module = imported["module"]
    entry = _manifest_entry(imported, "spatial-coordinates")
    declared = entry["meta"]["component_columns"]

    assert declared == [module.COMPONENT_X, module.COMPONENT_Y], (
        f"the coordinates artifact declares {declared!r} as its 1-D component columns, which "
        f"is not exactly [{module.COMPONENT_X!r}, {module.COMPONENT_Y!r}]"
    )
    emitted = {e["id"] for e in imported["manifest"]["outputs"]}
    n_rows = len(_emitted_barcodes(imported))
    for name in declared:
        assert f"metadata-column:{name}" in emitted, (
            f"the coordinates artifact names {name!r} as a component column but no such "
            "column was emitted — the declaration resolves to nothing"
        )
        values = HF.read_member(imported["out"], f"metadata/{name}.zarr", "values")
        assert len(values) == n_rows, (
            f"`{name}` has {len(values)} rows against the axis's {n_rows}"
        )
