#!/usr/bin/env python3
# ruff: noqa
"""The importer, driven for real over TWO real bundles, asserted by READING THE BYTES BACK.

Every assertion here is against what LANDED in the store, never against the writer's own
return value — a producer that returns a correct declaration and writes something else is
exactly the failure a read-back test exists to catch.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

import cyto_zarr_read as CZR  # noqa: E402


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    out = tmp_path_factory.mktemp("xenium-prime")
    module, entries = XF.run_over(XF.PRIME, out)
    return {"out": out, "entries": entries, "module": module, "bundle": XF.PRIME}


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    out = tmp_path_factory.mktemp("xenium-protein")
    module, entries = XF.run_over(XF.PROTEIN, out)
    return {"out": out, "entries": entries, "module": module, "bundle": XF.PROTEIN}


# ── the fixtures are what they claim to be ───────────────────────────────────────────


def test_the_committed_fixtures_are_real_vendor_data_and_disagree_with_each_other():
    """TEST-11 — the substrate every other test in this package rests on.

    Asserted, never assumed. A fixture that quietly changed would disarm the tests built on
    it while every one of them stayed green — and the WHOLE POINT of committing two is that
    they disagree on every axis this importer branches on. A pair that silently converged
    would let a Visium-shaped assumption survive again.
    """
    prime_exp = XF.experiment(XF.PRIME)
    protein_exp = XF.experiment(XF.PROTEIN)
    assert prime_exp["analysis_sw_version"] == XF.PRIME_XOA
    assert protein_exp["analysis_sw_version"] == XF.PROTEIN_XOA
    assert prime_exp["analysis_sw_version"] != protein_exp["analysis_sw_version"], (
        "the two fixtures must be different XOA major versions — the segmentation, the "
        "image layout and the feature classes all changed between them"
    )

    # DEC-7's evidence, asserted rather than remembered: BOTH bundles write the SAME
    # placeholder library id, which is why the coordinate space cannot be derived from it.
    import h5py
    lib = {}
    for name, bundle in (("prime", XF.PRIME), ("protein", XF.PROTEIN)):
        with h5py.File(bundle / "cell_feature_matrix.h5", "r") as f:
            raw = f.attrs["library_ids"]
            lib[name] = (raw[0].decode() if hasattr(raw, "__len__") and not isinstance(raw, (str, bytes))
                         else raw.decode() if isinstance(raw, bytes) else str(raw))
    assert lib["prime"] == lib["protein"] == XF.PLACEHOLDER_LIBRARY_ID, (
        "the two bundles must share the placeholder library id — that collision is the "
        "measurement DEC-7 rests on, and if the vendor ever writes real ids here the "
        "coordinate-space fallback ordering should be revisited"
    )
    assert prime_exp["roi_uuid"] != protein_exp["roi_uuid"], (
        "and their roi_uuids must DIFFER, or the identifier chosen instead of library_ids "
        "would collide the same way"
    )

    # Both state the same pixel size, and that is the referent TEST-17 exercises.
    assert prime_exp["pixel_size"] == protein_exp["pixel_size"] == XF.PIXEL_SIZE_UM

    # One method vs three, in one run — DEC-12's evidence.
    _, prime_rows = XF.cells_table(XF.PRIME)
    _, protein_rows = XF.cells_table(XF.PROTEIN)
    header, _ = XF.cells_table(XF.PRIME)
    seg = header.index("segmentation_method")
    assert len({r[seg] for r in prime_rows}) == 1
    assert len({r[seg] for r in protein_rows}) == 3, (
        "the protein fixture must carry a MIXED segmentation — it is the only evidence "
        "that `measured_entity.segmentation.method` (a single string) is narrower than "
        "the platform"
    )


def test_neither_fixture_carries_a_z_centroid_column():
    """TEST-11 — the fixture-side half of DEC-13.

    If a future XOA started writing a z centroid, the importer's silence about z would stop
    being "absence is absence" and start being a dropped measurement. This is the tripwire.
    """
    for bundle in (XF.PRIME, XF.PROTEIN):
        header, _ = XF.cells_table(bundle)
        assert not [c for c in header if c.lower() in ("z", "z_centroid", "z_location")], (
            f"{bundle.name} now carries a z column {header} — the importer emits none, and "
            "that decision was made because the vendor states none. Re-open DEC-13."
        )


# ── the coordinates themselves ───────────────────────────────────────────────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_coordinates_are_bit_exact_to_the_vendors_own_cells_table(case, prime, protein):
    """TEST-11 — BIT-exact, not close.

    `np.array_equal`, never `allclose`. The importer parses the vendor's decimal text to
    float32 and writes it; anything but exact equality means a transform was applied that
    nothing declared. This is the Xenium counterpart of #154's bit-exactness result, and it
    is what makes DEC-3 (`cells.csv.gz` instead of `cells.parquet`) a free choice rather
    than a precision trade: the CSV carries 17 significant digits.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    arr = CZR.read_array(ctx["out"] / "spatial/coordinates.zarr", "coordinates")
    ids = XF.matrix_cell_ids(ctx["bundle"])
    xs, ys = XF.expected_xy(ctx["bundle"], ids)
    assert arr.dtype == np.float32
    assert arr.shape == (len(ids), 2)
    assert np.array_equal(arr[:, 0], xs), "column 0 must be x_centroid, bit for bit"
    assert np.array_equal(arr[:, 1], ys), "column 1 must be y_centroid, bit for bit"


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_axis_order_is_x_then_y_and_is_read_by_name(case, prime, protein):
    """TEST-11 — the trap Visium has and Xenium does not, asserted anyway.

    §7.3 rule 5 calls the (row, col) -> (x, y) transpose "the single most likely bug in the
    whole importer". Xenium's `cells.csv.gz` is already (x, y) AND this importer reads the
    columns BY NAME, so the trap is closed by construction. Asserted here on a NON-SQUARE
    extent, because a square one passes a transposed read silently.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    arr = CZR.read_array(ctx["out"] / "spatial/coordinates.zarr", "coordinates")
    x_span = float(arr[:, 0].max() - arr[:, 0].min())
    y_span = float(arr[:, 1].max() - arr[:, 1].min())
    assert x_span > 0 and y_span > 0
    assert x_span / y_span > 1.5 or y_span / x_span > 1.5, (
        f"this fixture's cell extent must be NON-SQUARE (x {x_span:.1f} um, y {y_span:.1f} "
        "um) or a transposed (x, y) would pass silently"
    )
    ids = XF.matrix_cell_ids(ctx["bundle"])
    xs, ys = XF.expected_xy(ctx["bundle"], ids)
    assert not np.array_equal(arr[:, 0], ys), (
        "columns 0 and 1 must not be swapped — this is the falsifier, and it only bites on "
        "a non-square fixture"
    )


# ── the join ─────────────────────────────────────────────────────────────────────────


def test_positions_are_joined_by_cell_id_not_zipped(tmp_path):
    """TEST-12 — a REVERSED cells table still yields each cell its own centroid.

    `cells.csv.gz` and the matrix happen to agree on order in both real bundles. A
    positional zip would therefore PASS on every fixture in this repo and be one vendor
    release away from putting every cell's transcripts at another cell's position — which
    is not an error, it is a picture of the tissue with the values shuffled. So the fixture
    is rewritten in REVERSE order and the same import must produce the identical artifact.
    """
    import gzip
    import shutil

    bundle = tmp_path / "reversed"
    shutil.copytree(XF.PRIME, bundle)
    header, rows = XF.cells_table(XF.PRIME)
    with gzip.open(bundle / "cells.csv.gz", "wt", newline="") as fh:
        fh.write(",".join(header) + "\n")
        for row in reversed(rows):
            fh.write(",".join(row) + "\n")

    out = tmp_path / "out"
    XF.run_over(bundle, out)
    arr = CZR.read_array(out / "spatial/coordinates.zarr", "coordinates")
    ids = XF.matrix_cell_ids(XF.PRIME)
    xs, ys = XF.expected_xy(XF.PRIME, ids)
    assert np.array_equal(arr[:, 0], xs) and np.array_equal(arr[:, 1], ys), (
        "reversing the cells table must change nothing — the importer joins on cell_id"
    )


def test_a_cell_with_no_row_in_the_cells_table_refuses_the_import(tmp_path):
    """TEST-12 — absence is absence, and it REFUSES rather than defaults.

    Writing a placeholder coordinate would put those cells somewhere real-looking on the
    tissue, which is worse than not importing at all.
    """
    import gzip
    import shutil

    bundle = tmp_path / "short"
    shutil.copytree(XF.PRIME, bundle)
    header, rows = XF.cells_table(XF.PRIME)
    with gzip.open(bundle / "cells.csv.gz", "wt", newline="") as fh:
        fh.write(",".join(header) + "\n")
        for row in rows[:-1]:          # drop ONE cell the matrix still contains
            fh.write(",".join(row) + "\n")

    module = XF.load_compute()
    with pytest.raises(module.XeniumImportError) as exc:
        module.run_import(bundle, tmp_path / "out")
    assert "no row in" in str(exc.value)
    assert "1 of the" in str(exc.value), "the refusal must name HOW MANY cells are missing"


def test_a_duplicated_cell_id_refuses_rather_than_choosing(tmp_path):
    """TEST-12 — a cell has one position and choosing between two would be a guess."""
    import gzip
    import shutil

    bundle = tmp_path / "dup"
    shutil.copytree(XF.PRIME, bundle)
    header, rows = XF.cells_table(XF.PRIME)
    with gzip.open(bundle / "cells.csv.gz", "wt", newline="") as fh:
        fh.write(",".join(header) + "\n")
        for row in rows + [rows[0]]:
            fh.write(",".join(row) + "\n")

    module = XF.load_compute()
    with pytest.raises(module.XeniumImportError) as exc:
        module.run_import(bundle, tmp_path / "out")
    assert "more than once" in str(exc.value)
