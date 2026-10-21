#!/usr/bin/env python3
# ruff: noqa
"""#163 — the vendor-parquet reader. TEST-6 [covers: ITEM-4].

## The thing real data taught this file

The SAME vendor types `cell_id` DIFFERENTLY in two real Xenium bundles: `binary` in one
(`b"aaaaaahk-1"`) and `int32` in another (`1`). A reader that assumes either one is wrong
on the other, and the failure is not subtle — every id becomes an orphan and the whole
import refuses. #162 never met this because it reads `cells.csv.gz`, where everything is
text.

The nastier half is `binary`: the obvious `str(v)` gives `"b'aaaaaahk-1'"`, which is a
plausible-looking string that matches nothing. That is why this module owns the conversion
instead of going through `pandas.read_parquet`, and why the assertion below is on the exact
string rather than on "it did not crash".

## Where the vendor-authored parquet comes from

`VENDOR_PARQUETS` are real 10x `cells.parquet` files, `created_by fastparquet-python 1.0.0`.
They are NOT committed (6 MB and 3.5 MB); the tests that use them SKIP with a stated reason
when they are absent, which keeps this file honest on a machine that does not have them
rather than silently proving less. Everything else here runs on the committed fixtures.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

#: Real vendor-AUTHORED parquet, the only such files reachable from this box. Not committed.
_CCC = Path("/data/pbya/ccc/spatial-ccc-review/benchmark/scratch/data/tmp")
VENDOR_PARQUETS = {
    "binary": _CCC / "human-lung-cancer" / "unpacked" / "cells.parquet",
    "int32": _CCC / "10x-xenium-human-breast-cancer-preview" / "unpacked" / "outs" / "cells.parquet",
}


@pytest.fixture(scope="module")
def BD():
    return XF.load_boundaries_module()


@pytest.mark.parametrize("arm", sorted(VENDOR_PARQUETS))
def test_a_real_vendor_authored_parquet_normalises_to_the_matrix_id_form(BD, arm):
    """TEST-6 — the reader's dtype handling, against parquet the VENDOR wrote.

    This is the leg that narrows the fixture gap: no vendor-authored
    `cell_boundaries.parquet` exists on this box, so the boundaries fixtures carry real
    VALUES in a container written here. Pointing the same `normalise_ids` at a real
    vendor-WRITTEN parquet proves the dtype handling against vendor bytes even though the
    boundaries container is not one.
    """
    import pyarrow.parquet as pq

    path = VENDOR_PARQUETS[arm]
    if not path.is_file():
        pytest.skip(
            f"the real vendor bundle is not on this machine ({path}). This leg proves the "
            "reader against VENDOR-AUTHORED parquet; without the file it would prove "
            "nothing, so it skips rather than passing."
        )
    file = pq.ParquetFile(str(path))
    assert "fastparquet" in (file.metadata.created_by or ""), (
        f"{path} was not written by the vendor's own writer ({file.metadata.created_by!r})"
        " — the point of this leg is the writer, so a re-encoded file would not serve"
    )
    column = file.read(columns=["cell_id"]).column("cell_id")
    assert str(column.type) == arm, f"expected a {arm} cell_id, got {column.type}"

    ids = BD.normalise_ids(column)
    assert all(isinstance(v, str) for v in ids[:100])
    assert not any(v.startswith("b'") for v in ids[:1000]), (
        "an id rendered as `b'…'` — `str(bytes)` was used where a decode was needed. Every "
        "id would become an orphan and the import would refuse the whole bundle."
    )
    if arm == "int32":
        assert ids[0] == "1", f"an integer id rendered as {ids[0]!r}, not '1'"
    else:
        assert ids[0].isascii() and "-" in ids[0], f"unexpected string id {ids[0]!r}"


def test_both_committed_boundary_fixtures_read_and_carry_the_vendors_own_values(BD):
    """TEST-6 — the two committed arms, values compared to the vendor's own decimal text."""
    for fixture in (XF.REAL_LUNG_BOUNDARIES, XF.REAL_BREAST_BOUNDARIES):
        rings, order = XF.expected_rings(fixture)
        enc = BD.read_boundaries(fixture, order)
        flat = [(cid, x, y) for cid in order for x, y in rings[cid]]
        assert enc["entity"].shape[0] == len(flat), (
            f"{fixture.name}: {enc['entity'].shape[0]} rows vs {len(flat)}"
        )
        assert enc["stats"]["n_vertices_not_written"] == 0
        # The vendor's own order is preserved WITHIN each cell, and the cells come out in
        # axis order — so for a fixture written in axis order the flat sequence must match.
        want_x = np.asarray([np.float32(x) for _, x, _ in flat], dtype=np.float32)
        want_y = np.asarray([np.float32(y) for _, _, y in flat], dtype=np.float32)
        assert np.array_equal(enc["x"], want_x) and np.array_equal(enc["y"], want_y), (
            f"{fixture.name}: the decoded vertices are not the vendor's own values"
        )


def test_a_missing_column_refuses_by_name(BD, tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq

    bad = tmp_path / "no_y.parquet"
    pq.write_table(pa.table({"cell_id": pa.array([b"a"], type=pa.binary()),
                             "vertex_x": pa.array([1.0])}), bad)
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(bad, ["a"])
    assert "vertex_y" in str(exc.value)


def test_a_file_that_is_not_parquet_refuses_by_name(BD, tmp_path):
    bad = tmp_path / "cell_boundaries.parquet"
    bad.write_bytes(b"cell_id,vertex_x,vertex_y\na,1,2\n")
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(bad, ["a"])
    assert "not a readable parquet file" in str(exc.value)


def test_an_unrenderable_id_dtype_refuses_rather_than_being_coerced(BD, tmp_path):
    """A float id is a rendering this importer has not seen, so it must not invent one."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    bad = tmp_path / "float_ids.parquet"
    pq.write_table(pa.table({"cell_id": pa.array([1.5, 2.5], type=pa.float64()),
                             "vertex_x": pa.array([1.0, 2.0]),
                             "vertex_y": pa.array([3.0, 4.0])}), bad)
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(bad, ["a"])
    assert "no rendering for" in str(exc.value)


def test_a_non_finite_coordinate_refuses(BD, tmp_path):
    """A NaN is not a position, and a polygon placed at one lands somewhere real-looking."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    bad = tmp_path / "nan.parquet"
    pq.write_table(pa.table({"cell_id": pa.array([b"a", b"a"], type=pa.binary()),
                             "vertex_x": pa.array([1.0, float("nan")]),
                             "vertex_y": pa.array([3.0, 4.0])}), bad)
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(bad, ["a"])
    assert "not finite" in str(exc.value)


def test_non_utf8_bytes_in_cell_id_refuse_as_OUR_error_not_a_decode_traceback(BD, tmp_path):
    """TEST-28 [covers: ITEM-4]. A bare `UnicodeDecodeError` is a traceback where a named refusal belongs.

    The entry catches `BoundariesError` and records a skip; anything else escapes `main()`.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    bad = tmp_path / "latin1.parquet"
    pq.write_table(pa.table({"cell_id": pa.array([b"\xff\xfe"], type=pa.binary()),
                             "vertex_x": pa.array([1.0]),
                             "vertex_y": pa.array([2.0])}), bad)
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(bad, ["a"])
    assert "not UTF-8" in str(exc.value)
