#!/usr/bin/env python3
# ruff: noqa
"""THE REFUSAL TABLE — every bundle this importer must refuse, built once and used twice.

`test_zero_partial_store.py` (INV-8) and `test_refusals.py` (INV-9) ask two different
questions of the SAME set of bundles: does the refusal leave anything on disk, and does it
say something a human can act on. Building the bundles in one place is what makes the two
answers about the same inputs — two copies of a builder is two tables that drift, and the
drift is invisible because each suite stays green against its own.

## Why the table is a TABLE and not a pile of test functions

INV-8's promise is universal — "every refusal a bundle can trigger should be reachable
before the first writer call" (`docs/design/vendor-text-encodability-refusal.md` §6.7). A
universal claim tested by a handful of hand-written cases is a claim about those cases. So
the refusals are enumerated as DATA, both suites sweep the whole table, and adding a refusal
to the compute without adding a row here is a gap a reader can see rather than one they have
to notice.

## The name

Package-prefixed for the reason `hd_fixtures.py` states: a non-`test_*.py` module in a
`tests/` dir is imported by BARE NAME, and `--import-mode=importlib` gives path-unique names
to `test_*.py` modules ONLY.
"""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402


def _bin_dir(root, bin_um):
    return Path(root) / "binned_outputs" / f"square_{bin_um:03d}um"


# ── the builders, one per refusable input ────────────────────────────────────────────


def not_a_bundle_at_all(tmp_path):
    """A directory with files in it that are not a Visium HD bundle."""
    root = Path(tmp_path) / "bundle"
    root.mkdir(parents=True)
    (root / "readme.txt").write_text("this is not a bundle", encoding="utf-8")
    return root


def a_standard_visium_outs(tmp_path):
    """The SIBLING'S REAL COMMITTED VENDOR BUNDLE — real Space Ranger bytes, wrong platform.

    Copied rather than pointed at, so a test cannot accidentally write into another
    package's committed fixture.
    """
    root = Path(tmp_path) / "visium-outs"
    shutil.copytree(
        HF.PACKAGES / "spatial-import-visium" / "tests" / "fixtures" / "visium-outs", root
    )
    return root


def one_bin_missing(tmp_path):
    """A `binned_outputs/` with only the 8 um bin — the container's stated assumption broken."""
    return HF.staged_tree(tmp_path, bins=(8,))


def a_bin_that_declares_the_wrong_size(tmp_path):
    """The 8 um bin's own scale file says `bin_size_um: 16`.

    What a staging reorder would look like from inside the importer, which is the failure the
    ordinal-verification exists to catch.
    """
    return HF.staged_tree(tmp_path, scalefactor_overrides={8: {"extra": {"bin_size_um": 16.0}}})


def a_positions_file_that_is_not_parquet(tmp_path):
    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet"
    path.write_bytes(b"barcode,in_tissue\nAAA-1,1\n")
    return root


def a_positions_file_missing_a_column(tmp_path):
    return HF.staged_tree(
        tmp_path, positions_kwargs={8: {"drop_columns": ("pxl_col_in_fullres",)}}
    )


def a_positions_file_with_a_duplicated_barcode(tmp_path):
    """One barcode listed twice. A square has one position; choosing between two is a guess."""
    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    duplicated = rows + [rows[0]]
    MF.write_positions_parquet(
        _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet", duplicated
    )
    return root


def a_positions_file_missing_a_matrix_barcode(tmp_path):
    """A positions table that does not cover the filtered matrix.

    Absence is absence (INV-5): a square with no position cannot be given one, and a
    placeholder coordinate would put it somewhere real-looking on the tissue.
    """
    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    # Drop the FIRST in-tissue row: the filtered matrix holds exactly the in-tissue set, so
    # this barcode is one the matrix definitely carries and the join must miss it.
    victim = next(r for r in rows if r[1] == 1)
    MF.write_positions_parquet(
        _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet",
        [r for r in rows if r is not victim],
    )
    return root


def a_positions_file_with_a_non_utf8_barcode(tmp_path):
    """A `barcode` column stored as BINARY carrying bytes that are not valid UTF-8.

    A barcode is the join key, so a loose decode would pair one bin's position with another
    bin's counts — which is why this is a refusal and not a `errors="replace"`.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    barcodes = [r[0].encode() for r in rows]
    barcodes[3] = b"\xff\xfeBAD-1"
    table = pa.table({
        "barcode": pa.array(barcodes, pa.binary()),
        "in_tissue": pa.array([int(r[1]) for r in rows], pa.int8()),
        "array_row": pa.array([r[2] for r in rows], pa.int32()),
        "array_col": pa.array([r[3] for r in rows], pa.int32()),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([float(r[5]) for r in rows], pa.float64()),
    })
    pq.write_table(table, _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet",
                   row_group_size=64)
    return root


def a_positions_column_that_is_not_a_number(tmp_path):
    """`pxl_col_in_fullres` as TEXT. Legal parquet; not a coordinate."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    table = pa.table({
        "barcode": pa.array([r[0] for r in rows], pa.string()),
        "in_tissue": pa.array([int(r[1]) for r in rows], pa.int8()),
        "array_row": pa.array([r[2] for r in rows], pa.int32()),
        "array_col": pa.array([r[3] for r in rows], pa.int32()),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([f"x{r[5]}" for r in rows], pa.string()),
    })
    pq.write_table(table, _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet",
                   row_group_size=64)
    return root


def an_h5_with_an_unencodable_root_attribute(tmp_path):
    """`library_ids` as a fixed-length `|S` attribute holding bytes that are not UTF-8.

    THE SHAPE THAT DOES NOT CRASH. A UTF-8-typed attribute comes back from h5py as lone
    surrogates and aborts a writer loudly; a `|S` one comes back as raw `bytes` and, decoded
    loosely, collapses three distinct vendor byte strings into one sample identity and one
    `coordinate_space`. The silent shape is the one a real bundle uses for `library_ids`.
    """
    import numpy as np

    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    MF.write_matrix_h5(
        _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", 8, rows,
        attrs={
            "chemistry_description": MF.CHEMISTRY,
            "filetype": "matrix",
            "library_ids": np.array([b"\xff\xfeSR"], dtype="|S8"),
            "original_gem_groups": np.array([1]),
            "software_version": MF.SOFTWARE_VERSION,
            "version": np.int64(2),
        },
    )
    return root


def an_h5_with_no_matrix_group(tmp_path):
    """A valid HDF5 file that is not a 10x feature-barcode matrix."""
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "w") as h5:
        h5.create_group("something_else")
    return root


def a_scalefactors_file_with_unencodable_text(tmp_path):
    """A scale document carrying a lone surrogate — text this platform could not write.

    Refused rather than sanitised: a replaced character in vendor text is a silently altered
    identity, and these strings become the run's `coordinate_space`.
    """
    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "spatial" / "scalefactors_json.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["vendor_note"] = "\ud800BAD"
    path.write_text(json.dumps(doc), encoding="utf-8", errors="surrogatepass")
    return root


def a_matrix_whose_shape_disagrees_with_its_barcodes(tmp_path):
    """`/matrix/shape` declares a barcode count the file does not carry."""
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        shape = h5["matrix/shape"][:]
        del h5["matrix/shape"]
        h5["matrix"].create_dataset(
            "shape", data=np.array([shape[0], int(shape[1]) + 7], dtype=np.int32))
    return root


# ── the builders FIX_ROUND-1 added, one per refusal the blind audits found missing ──


def a_matrix_that_is_not_hdf5(tmp_path):
    """`filtered_feature_bc_matrix.h5` replaced by bytes that are not HDF5.

    Truncation, a zero-byte file and a wrong format are the three shapes a damaged upload
    really produces, and `h5py.File` raises `OSError` for all three. The first cut left the
    OPEN unguarded, so each was an exit-1 traceback -- INV-9's prohibited outcome.
    """
    root = HF.staged_tree(tmp_path)
    (_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5").write_bytes(b"not hdf5 at all\n")
    return root


def a_matrix_with_no_features_group(tmp_path):
    """`/matrix` present, `/matrix/features` absent.

    `decoded_h5_strings` guards `group[name]` -- but `group["features"]` was evaluated at the
    CALL SITE, outside that guard, so this raised a raw `KeyError` from the argument list and
    never reached the helper whose whole job is to name it.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/features"]
    return root


def a_matrix_with_a_duplicated_barcode(tmp_path):
    """The MATRIX side of the duplicate question, which the first cut accepted silently.

    Two matrix columns then map onto ONE position, `axis/barcode.zarr` ships a non-unique key
    sequence, and every downstream `aligned_to` join on the cells axis is ambiguous. The
    digest self-check cannot see it: it checks that the digest matches, not that the keys are
    distinct.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        barcodes = h5["matrix/barcodes"][:]
        barcodes[1] = barcodes[0]
        h5["matrix/barcodes"][:] = barcodes
    return root


def a_matrix_with_no_barcodes(tmp_path):
    """A matrix declaring `(n_features, 0)`.

    Imports into a complete, coherent, EMPTY dataset otherwise -- the length cross-check
    passes (0 == 0) and every writer accepts an empty column -- so THIS fixture is stopped
    by the barcode-join refusal, which fires FIRST; the nnz == 0 refusal further down
    run_import would stop it too, and were neither to fire the empty import would exit 0
    and be reported as SUCCESS with no outcome reported to the operator as anything other
    than SUCCESS. The claim is scoped PER SHAPE (#613): for this zero-barcode shape the
    emptiness IS visible in the stream and the report (0 bins x N genes, `n_bins: 0`),
    so the surviving claim is only that no non-SUCCESS outcome exists -- no warning and
    no error, and the operator would still be told the import SUCCEEDED.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        n_features = int(h5["matrix/shape"][0])
        for name in ("barcodes", "data", "indices", "indptr", "shape"):
            del h5[f"matrix/{name}"]
        m = h5["matrix"]
        m.create_dataset("barcodes", data=np.array([], dtype="|S24"))
        m.create_dataset("data", data=np.array([], dtype=np.int32))
        m.create_dataset("indices", data=np.array([], dtype=np.int64))
        m.create_dataset("indptr", data=np.array([0], dtype=np.int64))
        m.create_dataset("shape", data=np.array([n_features, 0], dtype=np.int32))
    return root


def a_matrix_with_no_stored_values(tmp_path, bin_um=8):
    """A matrix declaring `(n_features, n_barcodes)` with `n_barcodes > 0` but `nnz == 0`.

    The OTHER empty shape (#470): `/matrix/data` and `/matrix/indices` are both length 0
    while `/matrix/shape` still declares the barcode count and `/matrix/barcodes` is
    intact. Every internal-consistency check passes VACUOUSLY on it -- `len(indptr) ==
    n_barcodes + 1`, monotonic, `indptr[0] == 0`, `indptr[-1] == nnz` (0 == 0),
    `len(indices) == nnz` (0 == 0), and the id-range scan is skipped because `if nnz:` is
    False -- so pre-#470 it imported at rc 0 with a complete `expression.zarr` holding
    nnz=0, reported as SUCCESS. The `shape` and `barcodes` are deliberately left UNCHANGED:
    this is the shape that distinguishes "no barcodes at all" (the sibling refusal above)
    from "barcodes but no stored values".

    `bin_um` selects WHICH bin's matrix is emptied (default 8, the importer's default bin,
    so the existing REFUSALS row keeps its behaviour). The 16 um row drives `bin_um=16`
    with `requested=16`, pinning that a NON-DEFAULT bin is refused too.

    THE CONTROL PROVES ITS OWN MUTATION: the mutated file is re-opened and the claimed
    shape is asserted -- `data` length 0, `indices` length 0, `indptr` all zeros of length
    `n_barcodes + 1`, `shape` UNCHANGED with `n_barcodes > 0` -- so a mutation that
    silently failed cannot make the refusal tests pass vacuously.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, bin_um) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        m = h5["matrix"]
        n_features = int(m["shape"][0])
        n_barcodes = int(m["shape"][1])
        for name in ("data", "indices", "indptr"):
            del h5[f"matrix/{name}"]
        m.create_dataset("data", data=np.array([], dtype=np.int32))
        m.create_dataset("indices", data=np.array([], dtype=np.int64))
        m.create_dataset("indptr", data=np.zeros(n_barcodes + 1, dtype=np.int64))
        # `shape` and `barcodes` are left UNCHANGED on purpose.
    # THE MUTATION TOOK EFFECT -- re-open the mutated file and prove it, so a silently
    # failed mutation cannot make the refusal tests pass without having tested anything.
    with h5py.File(path, "r") as handle:
        m = handle["matrix"]
        data_len = len(m["data"])
        indices_len = len(m["indices"])
        indptr = m["indptr"][:]
        shape = m["shape"][:]
        if data_len != 0 or indices_len != 0:
            raise AssertionError(
                f"the empty-matrix mutation did not land on the {bin_um} um bin: "
                f"data={data_len}, indices={indices_len} (both must be 0)"
            )
        if len(indptr) != n_barcodes + 1 or bool(np.any(indptr != 0)):
            raise AssertionError(
                f"the empty-matrix mutation did not land on the {bin_um} um bin: indptr "
                f"must be all zeros of length n_barcodes + 1 = {n_barcodes + 1}"
            )
        if n_barcodes <= 0 or int(shape[0]) != n_features or int(shape[1]) != n_barcodes:
            raise AssertionError(
                f"the empty-matrix mutation changed /matrix/shape on the {bin_um} um bin "
                f"(shape={shape.tolist()}) or the fixture declares no barcodes "
                f"(n_barcodes={n_barcodes})"
            )
    return root


def a_matrix_with_all_zero_stored_values(tmp_path, bin_um=8):
    """A matrix declaring `(n_features, n_barcodes)` with `nnz > 0` but every value exactly 0.

    The #533 shape: `/matrix/data` holds `nnz > 0` stored values and every one of them is
    exactly 0, while `/matrix/shape` still declares the barcode count and `/matrix/barcodes`
    is intact. Every internal-consistency check passes on it -- `len(indptr) ==
    n_barcodes + 1`, monotonic, `indptr[0] == 0`, `indptr[-1] == nnz`, `len(indices) ==
    nnz`, and the id-range scan is clean -- so pre-#533 it imported at rc 0 with a complete
    `expression.zarr` holding nnz all-zero values, reported as SUCCESS. The `shape` and
    `barcodes` are deliberately left UNCHANGED: this is the shape that distinguishes "no
    stored values at all" (the #470 refusal above) from "stored values but every one of
    them 0".

    `bin_um` selects WHICH bin's matrix is zeroed (default 8, the importer's default bin,
    so the existing REFUSALS row keeps its behaviour). The 16 um row drives `bin_um=16`
    with `requested=16`, pinning that a NON-DEFAULT bin is refused too.

    THE CONTROL PROVES ITS OWN MUTATION: the mutated file is re-opened and the claimed
    shape is asserted -- `data` length unchanged and > 0, every value exactly 0, `shape`
    UNCHANGED with `n_barcodes > 0` -- so a mutation that silently failed cannot make the
    refusal tests pass vacuously.

    The REFUSALS rows this builder feeds are swept by TEST-8 (zero paths on disk) and TEST-9
    (named, bounded, one-line, ASCII).
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, bin_um) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        m = h5["matrix"]
        n_features = int(m["shape"][0])
        n_barcodes = int(m["shape"][1])
        data = m["data"][:]
        if len(data) == 0:
            raise AssertionError(
                f"the fixture's {bin_um} um bin must have stored values for the all-zero "
                "mutation to mean anything"
            )
        data[:] = 0
        del m["data"]
        m.create_dataset("data", data=data)
        # `shape` and `barcodes` are left UNCHANGED on purpose.
    # THE MUTATION TOOK EFFECT -- re-open the mutated file and prove it, so a silently
    # failed mutation cannot make the refusal tests pass without having tested anything.
    with h5py.File(path, "r") as handle:
        m = handle["matrix"]
        data_len = len(m["data"])
        shape = m["shape"][:]
        if data_len == 0:
            raise AssertionError(
                f"the all-zero mutation did not land on the {bin_um} um bin: data length "
                f"is 0, but the fixture must keep its stored values"
            )
        if bool(np.any(m["data"][:])):
            raise AssertionError(
                f"the all-zero mutation did not land on the {bin_um} um bin: at least one "
                "stored value is non-zero"
            )
        if n_barcodes <= 0 or int(shape[0]) != n_features or int(shape[1]) != n_barcodes:
            raise AssertionError(
                f"the all-zero mutation changed /matrix/shape on the {bin_um} um bin "
                f"(shape={shape.tolist()}) or the fixture declares no barcodes "
                f"(n_barcodes={n_barcodes})"
            )
    return root


def a_matrix_with_all_nonfinite_stored_values(tmp_path, bin_um=8):
    """A matrix declaring `(n_features, n_barcodes)` with `nnz > 0` but every value NaN.

    The #548 shape: `/matrix/data` holds `nnz > 0` stored values and every one of them is
    NaN (the same no-usable-value boundary the all-zero shape hits, reached through a
    non-finite spelling -- `np.any` treated NaN as truthy, so the #533 all-zero check
    never fired on it and the matrix imported at rc 0 with unusable "counts"), while
    `/matrix/shape` still declares the barcode count and `/matrix/barcodes` is intact.
    Every internal-consistency check passes on it, so pre-#548 it imported at rc 0 with a
    complete `expression.zarr` holding nnz NaN values, reported as SUCCESS. NaN requires a
    float dtype, which passes the `"iufb"` dtype gate (kind `f`).

    `bin_um` selects WHICH bin's matrix is rewritten (default 8, so the existing REFUSALS
    row keeps its behaviour). The 16 um row drives `bin_um=16` with `requested=16`,
    pinning that a NON-DEFAULT bin is refused too.

    THE CONTROL PROVES ITS OWN MUTATION: the mutated file is re-opened and the claimed
    shape is asserted -- `data` length unchanged and > 0, every value NaN, `shape`
    UNCHANGED with `n_barcodes > 0` -- so a mutation that silently failed cannot make the
    refusal tests pass vacuously.

    The REFUSALS rows this builder feeds are swept by TEST-8 (zero paths on disk) and
    TEST-9 (named, bounded, one-line, ASCII).
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, bin_um) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        m = h5["matrix"]
        n_features = int(m["shape"][0])
        n_barcodes = int(m["shape"][1])
        data = m["data"][:]
        if len(data) == 0:
            raise AssertionError(
                f"the fixture's {bin_um} um bin must have stored values for the "
                "all-non-finite mutation to mean anything"
            )
        del m["data"]
        m.create_dataset("data", data=np.full(len(data), np.nan, dtype=np.float32))
        # `shape` and `barcodes` are left UNCHANGED on purpose.
    # THE MUTATION TOOK EFFECT -- re-open the mutated file and prove it, so a silently
    # failed mutation cannot make the refusal tests pass without having tested anything.
    with h5py.File(path, "r") as handle:
        m = handle["matrix"]
        data_len = len(m["data"])
        shape = m["shape"][:]
        if data_len == 0:
            raise AssertionError(
                f"the all-non-finite mutation did not land on the {bin_um} um bin: data "
                f"length is 0, but the fixture must keep its stored values"
            )
        if not bool(np.isnan(m["data"][:]).all()):
            raise AssertionError(
                f"the all-non-finite mutation did not land on the {bin_um} um bin: at "
                "least one stored value is not NaN"
            )
        if n_barcodes <= 0 or int(shape[0]) != n_features or int(shape[1]) != n_barcodes:
            raise AssertionError(
                f"the all-non-finite mutation changed /matrix/shape on the {bin_um} um "
                f"bin (shape={shape.tolist()}) or the fixture declares no barcodes "
                f"(n_barcodes={n_barcodes})"
            )
    return root


def a_matrix_with_no_stored_values_but_indptr_ENDING_AT_5(tmp_path, bin_um=8):
    """`/matrix/data` and `/matrix/indices` both length 0, but `/matrix/indptr` ends at 5.

    #504's shape: `nnz == 0` (both `data` and `indices` are empty) while `indptr[-1] ==
    5`, so the `indptr[-1] != nnz` length check fires BEFORE the #470 emptiness refusal
    can -- the refusal must name the indptr/data disagreement, not the generic emptiness.
    This pins the #470 refusal's POSITION within the matrix-consistency block: the #470
    comment's own premise is "after the two length checks above, nnz is trustworthy", and
    if the refusal were hoisted above the two length checks the generic emptiness message
    would fire instead and TEST-76 would go red.

    `bin_um` selects WHICH bin's matrix is mutated (default 8), mirroring
    `a_matrix_with_no_stored_values`.

    THE CONTROL PROVES ITS OWN MUTATION: the mutated file is re-opened and the claimed
    shape is asserted -- `data` length 0, `indices` length 0, `indptr` of length
    `n_barcodes + 1` starting at 0 and ending at 5, `shape` UNCHANGED with
    `n_barcodes > 0` -- so a mutation that silently failed cannot make the refusal test
    pass vacuously.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, bin_um) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        m = h5["matrix"]
        n_features = int(m["shape"][0])
        n_barcodes = int(m["shape"][1])
        for name in ("data", "indices", "indptr"):
            del h5[f"matrix/{name}"]
        m.create_dataset("data", data=np.array([], dtype=np.int32))
        m.create_dataset("indices", data=np.array([], dtype=np.int64))
        indptr = np.zeros(n_barcodes + 1, dtype=np.int64)
        indptr[-1] = 5
        m.create_dataset("indptr", data=indptr)
        # `shape` and `barcodes` are left UNCHANGED on purpose.
    # THE MUTATION TOOK EFFECT -- re-open the mutated file and prove it, so a silently
    # failed mutation cannot make the refusal test pass without having tested anything.
    with h5py.File(path, "r") as handle:
        m = handle["matrix"]
        data_len = len(m["data"])
        indices_len = len(m["indices"])
        indptr = m["indptr"][:]
        shape = m["shape"][:]
        if data_len != 0 or indices_len != 0:
            raise AssertionError(
                f"the indptr-ends-at-5 mutation did not land on the {bin_um} um bin: "
                f"data={data_len}, indices={indices_len} (both must be 0)"
            )
        if len(indptr) != n_barcodes + 1 or int(indptr[0]) != 0 or int(indptr[-1]) != 5:
            raise AssertionError(
                f"the indptr-ends-at-5 mutation did not land on the {bin_um} um bin: "
                f"indptr must be length n_barcodes + 1 = {n_barcodes + 1}, start at 0 and "
                f"end at 5 (got {indptr.tolist()})"
            )
        if n_barcodes <= 0 or int(shape[0]) != n_features or int(shape[1]) != n_barcodes:
            raise AssertionError(
                f"the indptr-ends-at-5 mutation changed /matrix/shape on the {bin_um} um "
                f"bin (shape={shape.tolist()}) or the fixture declares no barcodes "
                f"(n_barcodes={n_barcodes})"
            )
    return root


def a_matrix_with_a_NON_MONOTONIC_indptr(tmp_path):
    """A CSC offset array that decreases.

    Reaches `txr_csc.write_csc_zarr` unvalidated and raises out of `_lib` -- shared framework
    code whose raise is not this package's to change -- so the failure arrives as a traceback
    from inside the platform rather than as a statement about this bundle, with paths already
    on disk.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        indptr = h5["matrix/indptr"][:]
        indptr[2] = indptr[1] - 1
        h5["matrix/indptr"][:] = indptr
    return root


def a_bundle_with_NO_run_identity(tmp_path):
    """No `library_ids` on the matrix and no `metrics_summary.csv`.

    The sibling falls back to the bundle DIRECTORY NAME; in the layout a real sandbox presents
    that is always `inputs`, so every such bundle would declare the SAME `coordinate_space`
    and two unrelated runs would place themselves in one frame -- a false collision no later
    reader can detect.
    """
    import numpy as np

    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    MF.write_matrix_h5(
        _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", 8, rows,
        attrs={
            "chemistry_description": MF.CHEMISTRY,
            "filetype": "matrix",
            "original_gem_groups": np.array([1]),
            "software_version": MF.SOFTWARE_VERSION,
            "version": np.int64(2),
        },
    )
    (root / "metrics_summary.csv").unlink()
    return root


def a_positions_file_with_a_DUPLICATED_column(tmp_path):
    """A positions table carrying `pxl_row_in_fullres` twice.

    `pyarrow`'s `get_field_index` returns -1 for an ambiguous name and `RecordBatch.column(-1)`
    resolves Python-style to the LAST projected column, so the first cut exited 0 with every
    square on the diagonal -- a complete, coherent tissue map in the wrong place.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    fields = [
        pa.field("barcode", pa.string()), pa.field("in_tissue", pa.int8()),
        pa.field("array_row", pa.int32()), pa.field("array_col", pa.int32()),
        pa.field("pxl_row_in_fullres", pa.float64()),
        pa.field("pxl_col_in_fullres", pa.float64()),
        pa.field("pxl_row_in_fullres", pa.float64()),
    ]
    arrays = [
        pa.array([r[0] for r in rows], pa.string()),
        pa.array([int(r[1]) for r in rows], pa.int8()),
        pa.array([r[2] for r in rows], pa.int32()),
        pa.array([r[3] for r in rows], pa.int32()),
        pa.array([float(r[4]) for r in rows], pa.float64()),
        pa.array([float(r[5]) for r in rows], pa.float64()),
        pa.array([float(r[4]) for r in rows], pa.float64()),
    ]
    pq.write_table(pa.Table.from_arrays(arrays, schema=pa.schema(fields)),
                   _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet",
                   row_group_size=64)
    return root


def _positions_with(tmp_path, mutate, **write_kwargs):
    """A bundle whose 8 um positions table has been mutated row-wise by `mutate(rows)`."""
    root = HF.staged_tree(tmp_path)
    rows = [list(r) for r in MF.positions_rows(8)]
    mutate(rows)
    MF.write_positions_parquet(
        _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet",
        [tuple(r) for r in rows], **write_kwargs,
    )
    return root


def a_positions_coordinate_that_is_NOT_FINITE(tmp_path):
    """`inf` in a coordinate of a row the FILTERED MATRIX uses.

    A parquet column is TYPED, so unlike the sibling's CSV a vendor can legitimately write a
    float column and put `inf` in it. `float(inf)` does not raise, so the first cut wrote it
    into the tissue map; and `int(float('inf'))` raises `OverflowError`, which is neither a
    `TypeError` nor a `ValueError` and escaped `main()` entirely.
    """
    def mutate(rows):
        first = next(r for r in rows if r[1] == 1)
        first[5] = float("inf")
    return _positions_with(tmp_path, mutate)


def an_array_index_TOO_LARGE_for_int32(tmp_path):
    """`array_row` = 2**40 on a row the matrix uses.

    `np.asarray(2**40, dtype=np.int32)` raises `OverflowError` under numpy 2 -- again outside
    the first cut's `(TypeError, ValueError)` tuple, and again a shape only a typed column can
    present.

    Written at `index_dtype="int64"`, because the default `int32` column PHYSICALLY CANNOT
    hold the value: `pa.array([2**40], pa.int32())` raises `ArrowInvalid` in the builder
    itself, so the hostile bundle would fail to be created and the refusal would go untested.
    A vendor writing 64-bit lattice indices is the only shape from which this refusal is
    reachable at all, and it is a shape only a TYPED column can present -- the sibling's CSV
    has no width to disagree about.
    """
    def mutate(rows):
        first = next(r for r in rows if r[1] == 1)
        first[2] = 2 ** 40
    return _positions_with(tmp_path, mutate, index_dtype="int64")


def a_bin_ASSEMBLED_FROM_TWO_DIRECTORIES(tmp_path):
    """The 8 um bin's positions table comes from a second tree, 5,000 px away.

    Each of the four members is still unique in the tree, so suffix matching resolves them all
    -- from two different places. The first cut imported it cleanly with `bundle_layout:
    path-preserving` and the squares 5,000 px out.
    """
    import shutil

    root = HF.staged_tree(tmp_path)
    other = Path(tmp_path) / "leftover"
    other.mkdir(parents=True, exist_ok=True)
    dest = other / "square_008um" / "spatial"
    dest.mkdir(parents=True)
    rows = [(r[0], r[1], r[2], r[3], r[4] + 5000.0, r[5] + 5000.0)
            for r in MF.positions_rows(8)]
    MF.write_positions_parquet(dest / "tissue_positions.parquet", rows)
    (_bin_dir(root, 8) / "spatial" / "tissue_positions.parquet").unlink()
    shutil.move(str(other), str(Path(root) / "leftover"))
    return root


# ── the builders FIX_ROUND-2 added, from the second blind audit ─────────────────────


def a_bundle_whose_library_id_is_ONLY_WHITESPACE(tmp_path):
    """`library_ids` = `b"   "`, and no `metrics_summary.csv`.

    `coordinate_space_id` tested the identity with bare truthiness, so a blank string walked
    past the refusal that exists to stop an identity-less bundle importing, became the
    `space_id`, crossed the first writer, and died inside the VENDORED declaration contract at
    `SD.section(sample_id=...)` -- `SpatialDeclarationError`, which `main()` does not catch.
    MEASURED: exit 1 and 51 paths on disk, which is the sibling defect this module's own
    docstring cites as the thing it closed. `b""` was refused correctly at exit 2 with nothing
    on disk, so one space was the whole difference.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    import numpy as np
    for bin_um in MF.BINS:
        path = _bin_dir(root, bin_um) / "filtered_feature_bc_matrix.h5"
        with h5py.File(path, "r+") as h5:
            h5.attrs["library_ids"] = np.array([b"   "], dtype="|S4")
    (Path(root) / "metrics_summary.csv").unlink()
    return root


def a_matrix_whose_indptr_is_UNSIGNED_and_decreasing(tmp_path):
    """A non-monotonic `indptr` stored as `uint32`.

    `np.diff` inherits the array's dtype, so on an unsigned array a DECREASE wraps to a huge
    positive number and `(np.diff(indptr) < 0).any()` is unconditionally False. The signed
    builder above cannot reach this, because it writes back through
    `h5["matrix/indptr"][:] = ...`, which PRESERVES the fixture's int64. MEASURED at uint32:
    `ValueError: repeats may not contain negative values` out of `_lib/txr_csc.py`, exit 1,
    five paths on disk -- verbatim the failure the guard was written to prevent.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        indptr = h5["matrix/indptr"][:]
        indptr[5], indptr[6] = indptr[6], indptr[5]
        del h5["matrix/indptr"]
        h5["matrix"].create_dataset("indptr", data=indptr.astype(np.uint32))
    return root


def a_matrix_whose_indptr_does_NOT_END_AT_NNZ(tmp_path):
    """A monotonic `indptr` whose last entry disagrees with `len(data)`.

    `indptr[-1]` IS the stored-value count by definition. A file where the two disagree
    describes no matrix, and the writer either reads past the end of `data` or silently drops
    the final columns -- a wrong answer rather than an error.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        indptr = h5["matrix/indptr"][:]
        indptr[-1] = indptr[-1] - 1
        h5["matrix/indptr"][:] = indptr
    return root


def a_coordinate_TOO_LARGE_FOR_FLOAT32(tmp_path):
    """`pxl_col_in_fullres` = 1e39 on a row the filtered matrix uses.

    Perfectly finite as a double -- so `column()`'s finite check passes -- and `inf` as a
    single. MEASURED before the range check: exit 0 with 120 paths, an `inf` in
    `spatial/coordinates.zarr` AND in the `spatial_x` component column, the registration QC
    still `pass` (it reads the same column at float64), and the only trace a human gets is an
    image warning reading "the bins extend to inf x 640" -- which reads like a cropped image
    rather than a poisoned coordinate. Every output-path count in this file is
    STAGING-DEPENDENT: path-preserving staging (what every `HB.*` builder here uses) yields
    120 paths, the flattened staging used by TEST-56's positive control yields 119, and the
    difference is exactly `spatial-image-lowres.ome.tif`.
    """
    def mutate(rows):
        first = next(r for r in rows if r[1] == 1)
        first[5] = 1e39
    return _positions_with(tmp_path, mutate)


def a_matrix_whose_DATA_cannot_be_SIZED(tmp_path):
    """`/matrix/data` replaced by a GROUP.

    The `indptr[-1] == nnz` cross-check sized it as `group["data"].shape[0]` under a narrow
    exception tuple. A group has no `.shape`, so `AttributeError` escaped `main()` entirely --
    exit 1 with a raw traceback, which INV-9 forbids by name, at a line a fix round had just
    added. A SCALAR dataset took the other door: `shape == ()` raises `IndexError`, which WAS
    caught, so the check was silently skipped and the run died inside `_lib/txr_csc.py` with
    five paths already on disk.

    TODAY this is refused EARLIER, by the member loop's `isinstance(..., h5py.Dataset)` leg
    ("is not a dataset ('Group')"), which runs before the size cross-check this name
    describes. The builder is kept as-is -- the door it names is still closed, just by an
    earlier check.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
        h5["matrix"].create_group("data")
    return root


def a_matrix_whose_INDICES_cannot_be_SIZED(tmp_path):
    """`/matrix/indices` replaced by a GROUP.

    The round-3 guard hardened `/matrix/data` and `/matrix/indptr` and left the THIRD member
    of the same CSC triple unexamined. MEASURED: exit 1 with `TypeError: Accessing a group is
    done with bytes or str, not <class 'slice'>` raised out of `_lib/txr_csc.py`'s
    `column_counts()` -- a raw traceback from shared framework code, which INV-9 forbids by
    name. A SCALAR dataset takes the other door with `ValueError: Illegal slicing argument for
    scalar dataspace`, same file, same outcome.

    TODAY this is refused EARLIER, by the member loop's `isinstance(..., h5py.Dataset)` leg
    ("is not a dataset ('Group')"), which runs before the size cross-check this name
    describes. The builder is kept as-is -- the door it names is still closed, just by an
    earlier check.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/indices"]
        h5["matrix"].create_group("indices")
    return root


def a_matrix_whose_INDICES_ARE_TOO_SHORT(tmp_path):
    """`/matrix/indices` truncated to half its length, with `data` and `indptr` untouched.

    THE DANGEROUS DIRECTION, and the reason this is a refusal rather than a warning. h5py
    CLAMPS an out-of-range slice instead of raising, so `write_csc_zarr` reads what is there
    and silently drops every value past the truncation point. MEASURED before the length
    check: exit 0, 17 outputs, and a complete, coherent counts store holding 313 of the
    bundle's 627 non-zero values -- a plausible wrong answer rather than an error.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        indices = h5["matrix/indices"][:]
        del h5["matrix/indices"]
        h5["matrix"].create_dataset("indices", data=indices[: len(indices) // 2])
    return root


def a_matrix_with_a_FEATURE_ID_PAST_THE_END(tmp_path):
    """One `/matrix/indices` entry naming a feature row this file does not declare.

    MEASURED: `ValueError: operands could not be broadcast together with shapes (40,)
    (1000001,) (40,)` out of `np.bincount` inside `_lib/txr_csc.py::column_counts` -- exit 1,
    a raw traceback, zero paths on disk. INV-8 holds and INV-9 does not.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        h5["matrix/indices"][0] = 1_000_000
    return root


def a_matrix_with_a_NEGATIVE_FEATURE_ID(tmp_path):
    """The other end of the same range, which arrives as a DIFFERENT framework error.

    MEASURED: `ValueError: 'list' argument must have no negative elements`. Written as its own
    builder because a guard that bounds only the high end passes this verbatim, and one row
    in this table cannot prove two ends.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        indices = np.asarray(h5["matrix/indices"][:], dtype=np.int64)
        indices[0] = -1
        del h5["matrix/indices"]
        h5["matrix"].create_dataset("indices", data=indices)
    return root


def _matrix_member_as(tmp_path, member, values):
    """The 8 um matrix with ONE member of the CSC triple rewritten at a hostile dtype."""
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        current = h5[f"matrix/{member}"][:]
        del h5[f"matrix/{member}"]
        h5["matrix"].create_dataset(member, data=values(current))
    return root


def a_matrix_whose_INDPTR_IS_NOT_A_NUMBER(tmp_path):
    """`/matrix/indptr` as an `|S1` dataset -- a legal HDF5 dataset, not a CSC offset array.

    Every guard around it is written in numpy, and numpy's answer on a non-numeric array is an
    EXCEPTION rather than a False -- so the value check becomes the thing that raises.
    MEASURED: exit 1, `ValueError: invalid literal for int() with base 10: b'x'` out of the
    `indptr.astype(np.int64)` INSIDE the guard block written to prevent exactly that class.
    """
    import numpy as np
    return _matrix_member_as(tmp_path, "indptr",
                             lambda cur: np.array([b"x"] * len(cur)))


def a_matrix_whose_DATA_IS_NOT_A_NUMBER(tmp_path):
    """`/matrix/data` as an `|S1` dataset.

    The worst of the three, because the shape checks pass and nothing looks at the values
    until the writer does. MEASURED: exit 1 and FIVE PATHS ON DISK, `ValueError: could not
    convert string to float` from `_lib/txr_csc.py::_scatter_band` -- past the first writer,
    so INV-8 as well as INV-9.
    """
    import numpy as np
    return _matrix_member_as(tmp_path, "data",
                             lambda cur: np.array([b"x"] * len(cur)))


def a_matrix_whose_INDICES_ARE_NOT_A_NUMBER(tmp_path):
    """`/matrix/indices` as an `|S1` dataset.

    MEASURED: exit 1, `_UFuncNoLoopError: ufunc 'minimum' did not contain a loop with signature
    matching types (dtype('S1'), dtype('S1'))` -- raised out of the id-range scan added in this
    same round, which is the point: a bound on VALUES is not a bound on TYPES.
    """
    import numpy as np
    return _matrix_member_as(tmp_path, "indices",
                             lambda cur: np.array([b"x"] * len(cur)))


def a_matrix_whose_INDICES_ARE_FLOATS(tmp_path):
    """`/matrix/indices` at float64 -- numeric, and still not a CSC index array.

    The SILENT door, and the reason the dtype rule is `integer` rather than `numeric`:
    `_lib`'s `np.asarray(ind[...], dtype=np.intp)` TRUNCATES toward zero, so a damaged file
    imports at exit 0 with a complete counts store built from rounded feature ids. MEASURED
    before the check: rc=0, 120 paths, no warning anywhere.
    """
    import numpy as np
    return _matrix_member_as(tmp_path, "indices",
                             lambda cur: np.asarray(cur, dtype=np.float64))


def a_matrix_whose_INDPTR_IS_TWO_DIMENSIONAL(tmp_path):
    """`/matrix/indptr` reshaped to `(n+1, 1)` -- right count, wrong shape.

    The refusal FIRED before this row existed, and said the wrong thing: `ndim` and the entry
    count were folded into one message, so a `(53, 1)` array (size 53, ndim 2) read "has 53
    entries; a CSC matrix over 52 barcodes has exactly 53". Literally true and unactionable --
    INV-9 asks for a line a human can act on, not merely one line. This row pins the split.
    """
    import numpy as np
    return _matrix_member_as(tmp_path, "indptr", lambda cur: np.asarray(cur).reshape(-1, 1))


def _positions_column_as_text(tmp_path, name):
    """The 8 um positions table with ONE numeric column rewritten as TEXT.

    THE FIVE COLUMNS THE REGISTRATION QC READS, one row per column, because the QC's fallback
    to the matrix-joined sample is UNREACHABLE exactly to the extent that these five refuse.
    `_qc_column` returns `None` only for a column that cannot be read as `float64`, and it
    reads the WHOLE table at 93 % -- after every writer -- so a column it cannot read but the
    pre-writer path can would put the one-class fallback on a real bundle with no way to test
    it. Enumerating the five here is what makes "the fallback is unreachable" a measured claim
    rather than an argument.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    root = HF.staged_tree(tmp_path)
    rows = MF.positions_rows(8)
    cols = {
        "barcode": pa.array([r[0] for r in rows], pa.string()),
        "in_tissue": pa.array([int(r[1]) for r in rows], pa.int8()),
        "array_row": pa.array([int(r[2]) for r in rows], pa.int32()),
        "array_col": pa.array([int(r[3]) for r in rows], pa.int32()),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([float(r[5]) for r in rows], pa.float64()),
    }
    cols[name] = pa.array([f"x{i}" for i in range(len(rows))], pa.string())
    pq.write_table(pa.table(cols),
                   _bin_dir(root, 8) / "spatial" / "tissue_positions.parquet",
                   row_group_size=64)
    return root


def _matrix_member_as_virtual(tmp_path, member):
    """The 8 um matrix with ONE member of the CSC triple rewritten as a VIRTUAL dataset.

    A VDS whose source file does not exist: h5py gives NO signal when a VDS source is
    missing -- it silently fills with the layout's fill value. The member keeps its EXACT
    original shape and dtype, so every shape/dtype check below passes and only the
    `is_virtual` predicate can see it.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        current = h5[f"matrix/{member}"]
        shape, dtype = current.shape, current.dtype
        del h5[f"matrix/{member}"]
        layout = h5py.VirtualLayout(shape=shape, dtype=dtype)
        src = h5py.VirtualSource("does-not-exist.h5", "whatever", shape=shape, dtype=dtype)
        layout[:] = src
        h5["matrix"].create_virtual_dataset(member, layout, fillvalue=0)
    return root


def _matrix_member_as_external(tmp_path, member):
    """The 8 um matrix with ONE member of the CSC triple rewritten as EXTERNAL raw storage.

    HDF5 external raw storage over a `.bin` file that does not exist. `ds.is_virtual` is
    FALSE for this shape, so only the `.external` predicate sees it. The member keeps its
    EXACT original shape and dtype.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        current = h5[f"matrix/{member}"]
        shape, dtype = current.shape, current.dtype
        del h5[f"matrix/{member}"]
        h5["matrix"].create_dataset(
            member, shape=shape, dtype=dtype,
            external=[("missing.bin", 0, int(np.prod(shape)) * dtype.itemsize)],
        )
    return root


def a_matrix_whose_INDICES_are_a_VIRTUAL_dataset_over_a_missing_source(tmp_path):
    """`/matrix/indices` as a VIRTUAL dataset over a MISSING source file.

    h5py gives no signal when a VDS source is missing -- it silently fills. MEASURED
    pre-fix through the shipped entrypoint on the 8 um bin: rc 0, 120 output paths, and a
    store whose `indptr` is `[0, 627, 627, 627, ...]` -- EVERY count attributed to gene 0.
    `is_virtual` is True for this shape, but it is False for external storage, so the
    refusal needs both predicates.
    """
    return _matrix_member_as_virtual(tmp_path, "indices")


def a_matrix_whose_DATA_is_a_VIRTUAL_dataset_over_a_missing_source(tmp_path):
    """`/matrix/data` as a VIRTUAL dataset over a MISSING source file.

    MEASURED pre-fix through the shipped entrypoint on the 8 um bin: rc 0, 120 output
    paths, and a store whose `data` is ALL ZERO (sum 0.0) with the structure intact -- a
    silent wrong answer rather than an error.
    """
    return _matrix_member_as_virtual(tmp_path, "data")


def a_matrix_whose_INDICES_have_EXTERNAL_raw_storage(tmp_path):
    """`/matrix/indices` as EXTERNAL raw storage over a MISSING `.bin`.

    MEASURED pre-fix through the shipped entrypoint on the 8 um bin: rc 1, a raw
    `OSError` traceback from the indices range scan, and ZERO
    output paths. `ds.is_virtual` is False for external storage, so only the `.external`
    predicate sees it.
    """
    return _matrix_member_as_external(tmp_path, "indices")


def a_matrix_whose_DATA_has_EXTERNAL_raw_storage(tmp_path):
    """`/matrix/data` as EXTERNAL raw storage over a MISSING `.bin`.

    MEASURED pre-fix through the shipped entrypoint on the 8 um bin: rc 1, a raw
    `OSError` traceback out of `_lib/txr_csc.py::H5CsrSource.iter_entries` -- the
    row-block read -- and a FIVE-PATH PARTIAL STORE (`expression.zarr/data/c`,
    `expression.zarr/indices/c`, ...) -- INV-8 and INV-9 broken together. The refusal
    converts that into a named refusal with an empty outputs tree.
    """
    return _matrix_member_as_external(tmp_path, "data")


# ── the builders FIX_ROUND-1 (this round) added: the member loop's own doors. The
#    unguarded `group[member]` regressed four named refusals into raw KeyError tracebacks,
#    and an ExternalLink walked straight through the inline check.


def a_matrix_MISSING_its_data_member(tmp_path):
    """`/matrix/data` deleted from the 8 um matrix.

    MEASURED pre-fix through the shipped entrypoint: rc 1, a raw `KeyError` traceback from
    the unguarded `group[member]`, and 0 output paths. The
    pre-existing guarded reads used to catch this by name; the new member loop runs first
    and had no guard.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
    return root


def a_matrix_whose_INDICES_are_a_BROKEN_ExternalLink(tmp_path):
    """`/matrix/indices` as an ExternalLink to a file that does not exist.

    MEASURED pre-fix through the shipped entrypoint: rc 1, a raw `KeyError` traceback from
    the unguarded `group[member]` (`Unable to synchronously open object (can't open file)`),
    and 0 output paths.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/indices"]
        h5["matrix"]["indices"] = h5py.ExternalLink("does-not-exist.h5", "/matrix/indices")
    return root


def a_matrix_whose_DATA_is_a_BROKEN_SoftLink(tmp_path):
    """`/matrix/data` as a SoftLink to a path that does not exist.

    MEASURED pre-fix through the shipped entrypoint: rc 1, a raw `KeyError` traceback from
    the unguarded `group[member]` (`Unable to synchronously open object (component not
    found)`), and 0 output paths.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
        h5["matrix"]["data"] = h5py.SoftLink("/matrix/does-not-exist")
    return root


def a_matrix_whose_DATA_is_an_ExternalLink_to_an_OUTSIDE_file(tmp_path):
    """`/matrix/data` as an ExternalLink to an EXISTING file outside the bundle.

    The outside file lives in `tmp_path` (NOT inside the staged bundle tree) and holds
    all-7s data. MEASURED pre-fix through the shipped entrypoint: rc 0, 120 output paths,
    and a full store built from the outside file's values -- `group[member]` follows the
    link transparently, so the resolved dataset passed the inline check.
    """
    import os

    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-data.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        shape = src["matrix/data"].shape
        dtype = src["matrix/data"].dtype
    with h5py.File(outside, "w") as out:
        out.create_dataset("data", data=np.full(shape, 7, dtype=dtype))
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
        h5["matrix"]["data"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/data")
    return root


def a_matrix_whose_MATRIX_group_is_an_ExternalLink_to_an_OUTSIDE_file(tmp_path):
    """`/matrix` itself as an ExternalLink to an EXISTING file outside the bundle.

    The outside file is a copy of the matrix group, NOT in the bundle. MEASURED pre-fix
    through the shipped entrypoint: rc 0, 120 output paths, and a full store built from
    the outside matrix's values -- `h5["matrix"]` resolves the link transparently and the
    member loop never sees it.
    """
    import os

    import h5py

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-matrix.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        with h5py.File(outside, "w") as out:
            src.copy("matrix", out, "matrix")
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix"]
        h5["matrix"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/matrix")
    return root


def a_matrix_whose_INDPTR_is_a_GROUP(tmp_path):
    """`/matrix/indptr` replaced by a GROUP.

    The isinstance leg refuses it as "is not a dataset" -- the leg this test pins. MEASURED
    pre-fix: the Group was refused by the LATER size guard with a DIFFERENT message, so the
    isinstance leg had zero coverage (a mutation ladder proved deleting it changed nothing).
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/indptr"]
        h5["matrix"].create_group("indptr")
    return root


def a_positions_IN_TISSUE_that_is_not_a_number(tmp_path):
    return _positions_column_as_text(tmp_path, "in_tissue")


def a_positions_ARRAY_ROW_that_is_not_a_number(tmp_path):
    return _positions_column_as_text(tmp_path, "array_row")


def a_positions_ARRAY_COL_that_is_not_a_number(tmp_path):
    return _positions_column_as_text(tmp_path, "array_col")


def a_positions_PXL_ROW_that_is_not_a_number(tmp_path):
    return _positions_column_as_text(tmp_path, "pxl_row_in_fullres")


# ── the builders FIX_ROUND-2 (this round) added: the STRUCTURAL net. The member loop
#    enumerates only the CSC triple, so a SoftLink CHAIN and every non-CSC member walked
#    straight through it at rc 0 with a wrong store. Each row below is one MEASURED case.


def a_matrix_whose_DATA_is_a_SoftLink_CHAIN_to_an_OUTSIDE_file(tmp_path):
    """`/matrix/data` -> SoftLink("/matrix/zzz") -> ExternalLink(outside.h5:/data).

    The member loop's link check inspects only the member's OWN link, so a chain whose
    FIRST hop is a SoftLink and whose SECOND hop is an ExternalLink passes every leg: the
    link check sees a SoftLink (not refused), and `group["data"]` resolves the WHOLE chain
    to an ordinary inline Dataset in the outside file (isinstance True, `is_virtual`
    False, `external` empty). MEASURED pre-fix through the shipped entrypoint on the 8 um
    bin: rc 0, 120 output paths, and a store whose `data` is all 7.0 (sum 4389 = 627 x 7)
    -- the counts came from the outside file. A variant through a member the importer
    READS reached the first writer and died with a raw `ValueError` traceback at rc 1 with
    39 paths on disk -- INV-8 and INV-9 broken together.
    """
    import os

    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-data.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        shape = src["matrix/data"].shape
        dtype = src["matrix/data"].dtype
    with h5py.File(outside, "w") as out:
        out.create_dataset("data", data=np.full(shape, 7, dtype=dtype))
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
        h5["matrix"].create_group("zzz")
        h5["matrix/zzz"]["data"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/data")
        h5["matrix"]["data"] = h5py.SoftLink("/matrix/zzz/data")
    return root


def a_matrix_whose_MATRIX_group_is_a_SoftLink_CHAIN_to_an_OUTSIDE_file(tmp_path):
    """`/matrix` -> SoftLink("/matrix2") -> ExternalLink(outside.h5:/matrix).

    `h5.get("matrix", getlink=True)` catches only a DIRECT ExternalLink; a chain whose
    first hop is a SoftLink passes it, and `h5["matrix"]` resolves the whole chain to the
    outside group. MEASURED pre-fix through the shipped entrypoint on the 8 um bin: rc 0,
    120 output paths, and a full store built from the outside matrix's all-7s values --
    the ENTIRE matrix group (data / indices / indptr / barcodes / features / shape) came
    from outside the bundle.
    """
    import os

    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-matrix.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        with h5py.File(outside, "w") as out:
            src.copy("matrix", out, "matrix")
    with h5py.File(outside, "r+") as out:
        shape = out["matrix/data"].shape
        dtype = out["matrix/data"].dtype
        del out["matrix/data"]
        out["matrix"].create_dataset("data", data=np.full(shape, 7, dtype=dtype))
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix"]
        h5["matrix2"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/matrix")
        h5["matrix"] = h5py.SoftLink("/matrix2")
    return root


def a_matrix_whose_BARCODES_are_an_ExternalLink_to_an_OUTSIDE_file(tmp_path):
    """`/matrix/barcodes` as an ExternalLink to an outside file holding the bundle's own
    barcodes REVERSED.

    THE MOST IMPORTANT ROW HERE. The member loop enumerates only the CSC triple, so a
    non-CSC member as an ExternalLink walks straight through it. The outside file holds
    the bundle's OWN barcodes reversed, so the join passes (same SET) and the store's
    barcode axis ends up reversed while the counts columns stay in the bundle's original
    order -- a silently MISLABELED matrix. MEASURED pre-fix through the shipped entrypoint
    on the 8 um bin: rc 0, 120 output paths.
    """
    import os

    import h5py

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-barcodes.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        barcodes = src["matrix/barcodes"][:]
    with h5py.File(outside, "w") as out:
        out.create_dataset("barcodes", data=barcodes[::-1])
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/barcodes"]
        h5["matrix"]["barcodes"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/barcodes")
    return root


def a_matrix_whose_BARCODES_are_an_ExternalLink_to_an_OUTSIDE_file_with_a_DIFFERENT_set(tmp_path):
    """`/matrix/barcodes` as an ExternalLink to an outside file holding a DIFFERENT barcode set.

    #476's shape, deliberately NOT the "reversed" trick of the sibling builder above. The
    outside file holds the SAME NUMBER of barcodes as the bundle's own (so the length
    cross-check passes) but a DIFFERENT SET -- synthetic 16-mer strings no
    `tissue_positions.parquet` row carries. Pre-fix the barcode join fires FIRST and
    refuses with a message blaming `tissue_positions.parquet` -- a wrong diagnosis: the
    defect is that `/matrix/barcodes` is an ExternalLink, not that a position is missing.
    Post-fix the storage check runs before the join and names `/matrix/barcodes` and the
    link class. TEST-80 pins the post-fix wording.
    """
    import os

    import h5py
    import numpy as np
    import pyarrow.parquet as pq

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-barcodes-different.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        own = src["matrix/barcodes"][:]
    # 52 distinct, clearly-fake 16-mer barcodes with the vendor's `-1` suffix. The 16-mer
    # is spelled out over {A,C,G,T} from the index, so the set is deterministic and every
    # member is visibly not a `s_008um_...` spatial barcode.
    fake = np.array(
        [("".join("ACGT"[(i // 4 ** k) % 4] for k in range(16)) + "-1").encode()
         for i in range(len(own))],
        dtype=own.dtype,
    )
    # THE DISJOINTNESS IS THE POINT. If a synthetic barcode ever collided with the
    # bundle's own set or with a `tissue_positions.parquet` row, the join would pass and
    # the scenario would silently stop exercising #476 -- the "reversed" luck the issue
    # says to avoid. Asserted here so a future fixture change cannot reintroduce it.
    own_set = {b.decode() for b in own}
    fake_set = {b.decode() for b in fake}
    assert not (fake_set & own_set), (
        "the synthetic barcode set collides with the bundle's own barcodes")
    positions = pq.read_table(bin_dir / "spatial" / "tissue_positions.parquet")
    pos_set = set(positions.column("barcode").to_pylist())
    assert not (fake_set & pos_set), (
        "a synthetic barcode collides with a `tissue_positions.parquet` row -- the join "
        "would pass and the #476 scenario would silently stop being exercised")
    with h5py.File(outside, "w") as out:
        out.create_dataset("barcodes", data=fake)
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/barcodes"]
        h5["matrix"]["barcodes"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/barcodes")
    return root


def a_matrix_whose_FEATURES_ID_is_an_ExternalLink_to_an_OUTSIDE_file(tmp_path):
    """`/matrix/features/id` (a NESTED member) as an ExternalLink to an outside file.

    The member loop enumerates only the CSC triple, so a nested member under
    `/matrix/features` as an ExternalLink walks straight through it. The outside file
    holds the bundle's own feature ids, so the length cross-check passes and the import
    would otherwise succeed. MEASURED pre-fix through the shipped entrypoint on the 8 um
    bin: rc 0, 120 output paths.
    """
    import os

    import h5py

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-features.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        ids = src["matrix/features/id"][:]
    with h5py.File(outside, "w") as out:
        out.create_dataset("id", data=ids)
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/features/id"]
        h5["matrix/features"]["id"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/id")
    return root


def a_matrix_with_a_SAME_FILE_SoftLink_member(tmp_path):
    """`/matrix/data` -> SoftLink("/matrix/indices") -- a link that stays INSIDE the file.

    Issue #461's case, now REFUSED (#461/#507 fix): a same-file SoftLink resolves to a
    dataset in this bundle's own matrix file, so the structural walk's realpath test alone
    passes it, but the seven-consumed-members distinctness check
    (`_refuse_aliased_matrix_members`) now catches `/matrix/data` and `/matrix/indices`
    resolving to the SAME object and refuses before the first writer. Pre-fix this imported
    at rc 0 with a WRONG expression matrix -- the exact user-visible outcome #450 exists to
    eliminate for the outside-file class and #507 closes for this same-file class. TEST-67
    pins the refusal.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
        h5["matrix"]["data"] = h5py.SoftLink("/matrix/indices")
    return root


# ── the builders FIX_ROUND-5 (this round) added: the SAME-FILE aliasing class (#507).
#    #461's plain same-file SoftLink is only the first member of the class. The realpath
#    walk compares which FILE an object lives in, never which OBJECT a name resolves to,
#    so every alias that stays inside the bundle's own file walked straight through it at
#    rc 0 with a wrong store. Each row below is one MEASURED case on the sibling importer,
#    ported here with HD's own staging idiom.


def a_matrix_whose_FEATURES_ID_is_a_SAME_FILE_ExternalLink(tmp_path):
    """`/matrix/features/id` -> ExternalLink(own file, "/matrix/features/name").

    M1: an ExternalLink pointing BACK at the bundle's OWN file. The link resolves
    transparently to the bundle's own `features/name` dataset, so the realpath check
    passes (same file) and `axis/gene_id.zarr` would be built from feature NAMES instead
    of ids. The walk's link inspection must refuse it BY NAME before resolving it -- an
    ExternalLink is refused wherever it points, even back into this same file.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/features/id"]
        h5["matrix/features"]["id"] = h5py.ExternalLink(
            "filtered_feature_bc_matrix.h5", "/matrix/features/name")
    return root


def a_matrix_whose_FEATURES_ID_is_a_HARD_LINK_to_FEATURES_NAME(tmp_path):
    """`/matrix/features/id` = HARD LINK to `/matrix/features/name`.

    M2: a hard link is INVISIBLE to `getlink=True` -- it returns `h5py.HardLink`, exactly
    what an ordinary dataset returns -- and the object is in the same file, so the realpath
    check passes too. The alias check must resolve the seven consumed members and require
    seven DISTINCT objects: `/matrix/features/id` and `/matrix/features/name` are the SAME
    object.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/features/id"]
        h5["matrix/features"]["id"] = h5["matrix/features/name"]
    return root


def a_matrix_whose_BARCODES_are_a_SAME_FILE_ExternalLink(tmp_path):
    """`/matrix/barcodes` -> ExternalLink(own file, "/matrix/barcodes_rev").

    M3: an ExternalLink pointing BACK at the bundle's OWN file, at a `barcodes_rev`
    dataset holding the bundle's own barcodes REVERSED. The link resolves transparently to
    the bundle's own reversed barcodes, so the realpath check passes (same file) and the
    store's barcode axis would be exactly the reverse of baseline. The walk's link
    inspection must refuse it BY NAME before resolving it.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        h5["matrix/barcodes_rev"] = h5["matrix/barcodes"][:][::-1]
        del h5["matrix/barcodes"]
        h5["matrix"]["barcodes"] = h5py.ExternalLink(
            "filtered_feature_bc_matrix.h5", "/matrix/barcodes_rev")
    return root


def a_matrix_whose_DATA_is_a_HARD_LINK_to_INDICES(tmp_path):
    """`/matrix/data` = HARD LINK to `/matrix/indices`.

    M4: #461/TEST-67's own case restated as a HARD LINK instead of a SoftLink -- a
    different bypass mechanism per #507. The hard link resolves to the bundle's own
    `indices` dataset, so the realpath check passes (same file) and the store's `data`
    would hold the feature-id values, not counts. The alias check must refuse it: `/matrix/
    data` and `/matrix/indices` are the SAME object.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
        h5["matrix"]["data"] = h5["matrix/indices"]
    return root


def a_matrix_whose_DATA_is_a_SoftLink_to_a_SAME_FILE_ExternalLink(tmp_path):
    """`/matrix/data` -> SoftLink("/matrix/zz") where `/matrix/zz` is an ExternalLink back
    into the bundle's own file at `/matrix/indices`.

    M5: `data`'s OWN link is a SoftLink, so a check that inspects only the member's own
    link walks straight through, and the chain resolves to the bundle's own `indices`
    dataset -- the store's `data` would hold the feature-id values, not counts. The walk
    inspects EVERY key's link before resolving it and must refuse the chain's ExternalLink
    by name: `/matrix/zz` is an ExternalLink.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        h5["matrix"]["zz"] = h5py.ExternalLink(
            "filtered_feature_bc_matrix.h5", "/matrix/indices")
        del h5["matrix/data"]
        h5["matrix"]["data"] = h5py.SoftLink("/matrix/zz")
    return root


def a_matrix_whose_DATA_is_a_15_HOP_SAME_FILE_SoftLink_CHAIN(tmp_path):
    """`/matrix/data` as a 15-hop SAME-FILE SoftLink chain ending at `/matrix/indices`.

    M6: the chain is UNDER HDF5's 16-link traversal limit, so it resolves cleanly to the
    bundle's own `indices` dataset -- the realpath check passes (same file) and the store's
    `data` would hold the feature-id values, not counts. The alias check must refuse it:
    `/matrix/data` and `/matrix/indices` are the SAME object.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/data"]
        for i in range(1, 16):
            target = "/matrix/indices" if i == 15 else f"/matrix/z{i + 1}"
            h5[f"matrix/z{i}"] = h5py.SoftLink(target)
        h5["matrix"]["data"] = h5py.SoftLink("/matrix/z1")
    return root


def a_matrix_with_a_data_SoftLink_through_a_SIBLING_GROUP_ExternalLink_to_indices(tmp_path):
    """`/matrix/data` -> SoftLink("/other_group/bar") where `/other_group/bar` is an
    ExternalLink back into the bundle's own file at `/matrix/indices`.

    The detour leaves `/matrix` entirely: the structural walk
    (`_refuse_outside_matrix_objects`) descends only from `/matrix`'s own keys, so it never
    visits `/other_group` and its no-ExternalLink predicate cannot see this chain. But
    `_refuse_aliased_matrix_members` resolves `/matrix/data` directly via `group["data"]`,
    which follows the FULL chain -- SoftLink then ExternalLink -- transparently to the real
    `/matrix/indices` object. MEASURED: `h5py.h5o.get_info` returns the IDENTICAL
    `(fileno, addr)` for a same-file ExternalLink self-reference as for the direct object,
    so the collision is caught: `/matrix/data` and `/matrix/indices` are the SAME object.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        h5.create_group("other_group")
        h5["other_group"]["bar"] = h5py.ExternalLink(
            "filtered_feature_bc_matrix.h5", "/matrix/indices")
        del h5["matrix/data"]
        h5["matrix"]["data"] = h5py.SoftLink("/other_group/bar")
    return root


def a_matrix_with_an_EXTRA_SAME_FILE_HARD_LINK_under_a_name_not_consumed(tmp_path):
    """`/matrix/_scratch` = HARD LINK to `/matrix/shape` -- an alias the importer does NOT read.

    The positive control for the alias check: an ORDINARY extra same-file hard link under a
    name this importer does not consume is LEGITIMATE and must keep importing at rc 0. The
    alias check is scoped to the seven consumed members only, so `_scratch` aliasing
    `shape` must not refuse.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        h5["matrix"]["_scratch"] = h5["matrix/shape"]
    return root


# ── the builders FIX_ROUND-3a added: the structural walk's own crash doors. The walk
#    branches on object CLASS, and two classes it can meet were not handled: a COMMITTED
#    (named) DATATYPE has no `.keys()`, and unbounded DEPTH blew Python's recursion limit.
#    Each row below is one MEASURED case.


def a_matrix_with_a_COMMITTED_DATATYPE_under_matrix(tmp_path):
    """A committed (named) HDF5 datatype under `/matrix`.

    HDF5 has a THIRD object class inside a group besides datasets and groups: a COMMITTED
    DATATYPE, which h5py returns as `h5py.Datatype`. It has `.id`, `.file`, `.attrs` -- and
    NO `.keys()`. The walk's descent branched on `isinstance(obj, h5py.Dataset)` and
    otherwise ASSUMED a Group, so the `.keys()` call sat outside every `try`. MEASURED
    pre-fix through the shipped entrypoint on the 8 um bin, with
    `h5["matrix"]["a_committed_type"] = np.dtype("int32")`: base d010b2cdb -> rc 0, 120
    output paths, clean import; HEAD before this fix -> rc 1, 0 paths, a raw
    `AttributeError: 'Datatype' object has no attribute 'keys'` traceback -- INV-9's
    prohibited outcome. This package's posture for `/matrix` is to refuse what it does
    not understand, and Space Ranger writes no committed datatypes there.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        h5["matrix"]["a_committed_type"] = np.dtype("int32")
    return root


def a_matrix_with_DEEP_GROUP_NESTING_under_matrix(tmp_path):
    """3000 nested empty groups under `/matrix`.

    The `seen` set guards CYCLES, not DEPTH: every level is a distinct object, so nothing
    is ever in `seen` and the recursive walk descends one Python frame per level. MEASURED
    pre-fix through the shipped entrypoint on the 8 um bin: base d010b2cdb -> rc 0, 120
    output paths, clean import; HEAD before this fix -> rc 1, 0 paths, a raw
    `RecursionError: maximum recursion depth exceeded` traceback -- INV-9's prohibited
    outcome. Depth is now bounded by `MAX_MATRIX_DEPTH = 64`: a group tree deeper than
    64 levels under `/matrix` is refused by name (the boundary is exact -- 64 levels
    import, 65 refuse). The cap is NOT needed for termination or stack safety -- the walk
    is ITERATIVE now, so the stack cannot blow, and the `seen` set already bounds total
    work. What it buys is bounding the QUADRATIC PATH-STRING CONSTRUCTION: the walk
    builds `f"{path}/{key}"` per object, so a 1,000,000-deep nesting is on the order of
    10^12 character copies plus 1,000,000 `realpath` syscalls, in a guard that runs
    before the first writer, on a VENDOR-CONTROLLED file -- a real hang. The WIDE case
    (a million siblings at depth 1 is still a million `realpath` calls) is linear and is
    deliberately not capped.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        node = h5["matrix"]
        for i in range(3000):
            node = node.create_group(f"level_{i}")
    return root


# ── the builders FIX_ROUND-3a2 added: HDF5's OWN link-traversal limit escaped the
#    guarded read as a raw RuntimeError, and the walk's coverage of `/matrix/shape` is
#    pinned. Each row below is one MEASURED case.


def a_matrix_whose_DATA_is_a_DEEP_SAME_FILE_SoftLink_CHAIN(tmp_path):
    """`/matrix/data` as a DEEP SAME-FILE SoftLink CHAIN -- 51 hops to a real dataset.

    HDF5 enforces its OWN link-traversal limit and raises `RuntimeError: Special link
    traversal failed (too many links)` when a chain is too long. MEASURED pre-fix through
    the shipped entrypoint on the 8 um bin: rc 1, a raw `RuntimeError` traceback at the
    member loop's `ds = group[member]`, and 0 output paths -- INV-9 broken. The structural
    walk never even runs, because the traceback happens before it.

    This is a SAME-FILE chain, so the structural walk's realpath leg does NOT refuse it --
    every hop resolves inside this bundle's own matrix file. The refusal must come from the
    guarded read this round widened (`RuntimeError` added to the member loop's except
    tuple). That is the point of the row.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(_bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        m = h5["matrix"]
        current = m["data"][:]
        del m["data"]
        m.create_dataset("real_data", data=current)
        m["zzz_49"] = h5py.SoftLink("/matrix/real_data")
        for i in range(48, -1, -1):
            m[f"zzz_{i}"] = h5py.SoftLink(f"/matrix/zzz_{i + 1}")
        m["data"] = h5py.SoftLink("/matrix/zzz_0")
    return root


def a_matrix_whose_SHAPE_is_an_ExternalLink_to_an_OUTSIDE_file(tmp_path):
    """`/matrix/shape` as an ExternalLink to an outside file holding the SAME dimensions.

    The outside file lives in `tmp_path` (NOT inside the staged bundle tree) and holds the
    bundle's OWN shape `[40, 52]`. A ladder showed that an outside `shape` with DIFFERENT
    dims is refused by an EARLIER shape cross-check (the length cross-check against the
    barcode/feature counts), so only the SAME-dims variant actually exercises the
    structural walk on `/matrix/shape` itself -- the walk's realpath leg is what must
    refuse it, and this row pins that coverage.
    """
    import os

    import h5py

    root = HF.staged_tree(tmp_path)
    bin_dir = _bin_dir(root, 8)
    outside = Path(tmp_path) / "outside-shape.h5"
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r") as src:
        shape = src["matrix/shape"][:]
    with h5py.File(outside, "w") as out:
        out.create_dataset("shape", data=shape)
    with h5py.File(bin_dir / "filtered_feature_bc_matrix.h5", "r+") as h5:
        del h5["matrix/shape"]
        h5["matrix"]["shape"] = h5py.ExternalLink(
            os.path.relpath(outside, start=bin_dir), "/shape")
    return root


# ── the builders THIS FEATURE adds: `/matrix/features` resolving to a Dataset, not a
#    Group (#539). The structural walk passes all four spellings (same file, inline or
#    same-file link, an h5py.Dataset), and `_refuse_aliased_matrix_members` then resolves
#    the two `features/*` members through `features_group`, which crashed on the subscripts
#    below. The sibling importer closed the same boundary in `refuse_malformed_features`
#    (#451); this port names the resolved object's type instead of quoting h5py's error.


def a_matrix_whose_FEATURES_is_a_plain_INLINE_Dataset(tmp_path):
    """`/matrix/features` replaced by a plain inline `int32` Dataset.

    The #539 shape as first reported: `group["features"]` succeeds (present, readable) and
    returns a Dataset, so the two `features/*` rows join `consumed`, and
    `features_group["id"]` raises h5py's `ValueError: Field names only allowed for
    compound types` -- UNCAUGHT, because `_matrix_member_identity`'s exception tuple is
    `(OSError, TypeError, RuntimeError)`. MEASURED pre-fix through the shipped entrypoint:
    rc=1, raw ValueError traceback, 0 output paths. Post-fix the refusal names
    `/matrix/features` and says it is not a group (rc 2, 0 paths). The dtype is
    NON-compound on purpose, so the subscript raises the field-names ValueError; the
    COMPOUND-dtype spelling (which crashes on `AttributeError` instead) is the separate
    `matrix-features-compound-dtype-dataset` row. The mutation is PROVEN below by
    re-opening: `/matrix/features` is an `h5py.Dataset`.

    The row is swept by TEST-8 (zero paths on disk) and TEST-9 (named, bounded, one-line,
    ASCII) and pinned by content in TEST-88.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix/features"]
        h5["matrix"].create_dataset("features", data=np.arange(17, dtype=np.int32))
    with h5py.File(path, "r") as handle:
        obj = handle["matrix/features"]
        if not isinstance(obj, h5py.Dataset):
            raise AssertionError(
                f"the inline-Dataset mutation did not land: /matrix/features is "
                f"{type(obj).__name__}")
    return root


def a_matrix_whose_FEATURES_is_a_SAME_FILE_SoftLink_to_barcodes(tmp_path):
    """`/matrix/features` -> SoftLink("/matrix/barcodes") -- a same-file link to a Dataset.

    Reach path 2 of #539: the structural walk inspects the link (a SoftLink, not an
    ExternalLink, so it passes), resolves it (same file, an `h5py.Dataset`, so the
    realpath / virtual / external legs pass) and the alias check's `group["features"]`
    follows it to the barcodes Dataset; `features_group["id"]` then raises the SAME
    uncaught `ValueError` as the inline spelling. MEASURED pre-fix through the shipped
    entrypoint: rc=1, raw ValueError traceback, 0 output paths. Post-fix refused by name
    as "is not a group" (rc 2, 0 paths). The mutation is PROVEN below: `getlink=True`
    returns an `h5py.SoftLink`, and the resolved object is the SAME `(fileno, addr)`
    object as `/matrix/barcodes`. Swept by TEST-8/TEST-9, pinned by content in TEST-89.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix/features"]
        h5["matrix"]["features"] = h5py.SoftLink("/matrix/barcodes")
    with h5py.File(path, "r") as handle:
        m = handle["matrix"]
        link = m.get("features", getlink=True)
        resolved = m["features"]
        barcodes = m["barcodes"]
        if not isinstance(link, h5py.SoftLink):
            raise AssertionError(
                f"the SoftLink mutation did not land: link is {type(link).__name__}")
        info = h5py.h5o.get_info
        rf = info(resolved.id)
        bf = info(barcodes.id)
        if not isinstance(resolved, h5py.Dataset) or (rf.fileno, rf.addr) != (bf.fileno, bf.addr):
            raise AssertionError(
                "the SoftLink mutation did not land: /matrix/features does not resolve "
                "to /matrix/barcodes")
    return root


def a_matrix_whose_FEATURES_is_a_HARD_LINK_to_barcodes(tmp_path):
    """`/matrix/features` = HARD LINK to `/matrix/barcodes`.

    Reach path 3 of #539: a hard link is INVISIBLE to `getlink=True` (it returns
    `h5py.HardLink`, exactly what an ordinary member returns), and the object is in the
    same file -- so the structural walk passes it and the alias check's
    `group["features"]` resolves to the barcodes Dataset; `features_group["id"]` raises
    the same uncaught `ValueError`. MEASURED pre-fix through the shipped entrypoint: rc=1,
    raw ValueError traceback, 0 output paths. Post-fix refused by name (rc 2, 0 paths),
    like the #507 hard-link rows. The mutation is PROVEN below by `(fileno, addr)`
    identity with `/matrix/barcodes` -- the only way a hard link can be seen. Swept by
    TEST-8/TEST-9, pinned by content in TEST-90.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix/features"]
        h5["matrix"]["features"] = h5["matrix/barcodes"]
    with h5py.File(path, "r") as handle:
        m = handle["matrix"]
        info = h5py.h5o.get_info
        f = info(m["features"].id)
        b = info(m["barcodes"].id)
        if (f.fileno, f.addr) != (b.fileno, b.addr):
            raise AssertionError(
                "the hard-link mutation did not land: /matrix/features is not the same "
                "object as /matrix/barcodes")
    return root


def a_matrix_whose_FEATURES_is_a_COMPOUND_dtype_Dataset(tmp_path):
    """`/matrix/features` = an inline Dataset with a COMPOUND dtype (fields id/name).

    The EXTRA #539 variant that decides the fix shape: `dataset["id"]` on a compound
    dtype SUCCEEDS returning a numpy field array, so the failure moves to
    `h5py.h5o.get_info(obj.id)` where `obj` is an ndarray -- `AttributeError:
    'numpy.ndarray' object has no attribute 'id'`, also UNCAUGHT. MEASURED pre-fix through
    the shipped entrypoint: rc=1, raw AttributeError traceback, 0 output paths -- and
    MEASURED with a Variant-A-only fix (ValueError added to `_matrix_member_identity`'s
    tuple): STILL rc 1, the SAME AttributeError. Only the explicit type refusal (this
    feature's fix) closes it, which is why TEST-91 pins this spelling as the
    discrimination proof. The mutation is PROVEN below: `/matrix/features` is a Dataset
    whose `dtype.names == ("id", "name")` and whose `["id"]` subscript succeeds. Swept by
    TEST-8/TEST-9, pinned by content in TEST-91.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    dt = np.dtype([("id", "S12"), ("name", "S12")])
    with h5py.File(path, "r+") as h5:
        del h5["matrix/features"]
        h5["matrix"].create_dataset("features", data=np.zeros(9, dtype=dt))
    with h5py.File(path, "r") as handle:
        obj = handle["matrix/features"]
        if not isinstance(obj, h5py.Dataset) or obj.dtype.names != ("id", "name"):
            raise AssertionError(
                f"the compound-dtype mutation did not land: {type(obj).__name__} "
                f"{obj.dtype}")
        field = obj["id"]
        if not hasattr(field, "shape"):
            raise AssertionError(
                "the compound-dtype mutation did not land: /matrix/features['id'] is not a "
                "field array")
    return root


def a_matrix_whose_FEATURES_is_a_SAME_FILE_SoftLink_to_a_GROUP(tmp_path):
    """`/matrix/features` -> SoftLink("/matrix/extra_features") — a same-file link to a GROUP.

    The OVER-REFUSAL CONTROL for #539 (TEST-94). The new check is an
    `isinstance(features_group, h5py.Group)` on the RESOLVED object, and h5py resolves a
    SoftLink transparently — so a same-file SoftLink at `/matrix/features` that resolves to
    a legitimate features GROUP must still import at rc 0. The check could have been written
    on the LINK (refusing any SoftLink at `/matrix/features`); this bundle is exactly what
    such a link-level check would refuse, which is what makes it the over-refusal control
    for the resolved-object design. This builder is a CONTROL, deliberately NOT a
    `HB.REFUSALS` row: the importer MUST ACCEPT this bundle. The mutation is PROVEN below:
    `getlink=True` returns an `h5py.SoftLink`, and the resolved object is a Group — the
    SAME `(fileno, addr)` object as the copied `extra_features` group.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        h5.copy("matrix/features", "matrix/extra_features")
        del h5["matrix/features"]
        h5["matrix"]["features"] = h5py.SoftLink("/matrix/extra_features")
    with h5py.File(path, "r") as handle:
        m = handle["matrix"]
        link = m.get("features", getlink=True)
        resolved = m["features"]
        extra = m["extra_features"]
        if not isinstance(link, h5py.SoftLink):
            raise AssertionError(
                f"the SoftLink mutation did not land: link is {type(link).__name__}")
        if not isinstance(resolved, h5py.Group):
            raise AssertionError(
                f"the SoftLink mutation did not land: /matrix/features resolves to "
                f"{type(resolved).__name__}, not a Group")
        info = h5py.h5o.get_info
        rf = info(resolved.id)
        ef = info(extra.id)
        if (rf.fileno, rf.addr) != (ef.fileno, ef.addr) or not {"id", "name"} <= set(resolved.keys()):
            raise AssertionError(
                "the SoftLink mutation did not land: /matrix/features does not resolve to "
                "/matrix/extra_features (a group carrying id/name)")
    return root


# ── the builders THIS FEATURE adds: `/matrix` itself resolving to a Dataset, not a Group
#    (#585). The #539 fix refused the `/matrix/features` level; the SAME class one level up
#    was left open: `group = h5["matrix"]` is never type-checked, and `if member not in
#    group:` (the membership loop's first use) died on a non-Group with a raw traceback at
#    rc 1 (or, for the 1-D spelling, refused with a FALSE "has no `/matrix/data`"
#    diagnosis). The fix refuses the resolved object BY NAME immediately after the
#    assignment. The sibling importer closed this boundary in `refuse_unreadable_matrix_group`
#    (`import_visium.py:1799`, #345/#451); this is the HD half, and its message is a port.


def a_matrix_whose_MATRIX_is_a_plain_INLINE_Dataset(tmp_path):
    """`/matrix` replaced by a plain inline 2-D `float64` Dataset.

    The #585 shape as first reported: `group = h5["matrix"]` succeeds and returns a
    Dataset, and the membership loop's `if member not in group:` then falls through to
    membership-by-comparison — a 2-D Dataset is iterated row-wise, each row compared with
    `==` against the member string, and the truth test of the resulting array raises.
    MEASURED pre-fix through the shipped entrypoint: rc=1, raw `ValueError: The truth value
    of an array with more than one element is ambiguous. Use a.any() or a.all()` traceback
    at the unguarded membership test, 0 output paths. Post-fix the refusal names `/matrix` and
    says it is not a group (rc 2, 0 paths). The mutation is PROVEN below by re-opening:
    `/matrix` is an `h5py.Dataset` (and NOT a Group). The dtype is 2-D and NON-compound on
    purpose, so the membership test raises the ambiguity ValueError; the 1-D spelling
    (which does NOT raise and is instead false-diagnosed) is the separate
    `matrix-root-1d-dataset` row. Swept by TEST-8/TEST-9, pinned by content in TEST-95.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix"]
        h5.create_dataset("matrix", data=np.zeros((3, 4), dtype=np.float64))
    with h5py.File(path, "r") as handle:
        obj = handle["matrix"]
        if not isinstance(obj, h5py.Dataset) or obj.ndim != 2:
            raise AssertionError(
                f"the inline-Dataset mutation did not land: /matrix is "
                f"{type(obj).__name__} ndim={getattr(obj, 'ndim', None)}")
    return root


def a_matrix_whose_MATRIX_is_a_SAME_FILE_SoftLink_to_a_Dataset(tmp_path):
    """`/matrix` -> SoftLink("/zzz_ds") -- a same-file link to a Dataset.

    Reach path 2 of #585: the ExternalLink leg inspects the link via `getlink=True` and
    passes a SoftLink (it refuses only `h5py.ExternalLink` classes), so `group = h5["matrix"]`
    follows it to the `zzz_ds` Dataset and the membership loop crashes with the SAME
    uncaught `ValueError` as the inline spelling. MEASURED pre-fix through the shipped
    entrypoint: rc=1, raw ValueError traceback, 0 output paths. Post-fix refused by name as
    "is not a group ('Dataset')" (rc 2, 0 paths) — the resolved object's TYPE, so the
    message says what the link RESOLVED to, not merely that a link exists. The mutation is
    PROVEN below: `getlink=True` returns an `h5py.SoftLink`, and the resolved object is a
    Dataset — the SAME `(fileno, addr)` object as `/zzz_ds`. Swept by TEST-8/TEST-9,
    pinned by content in TEST-96.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        h5.create_dataset("zzz_ds", data=np.zeros((3, 4), dtype=np.float64))
        del h5["matrix"]
        h5["matrix"] = h5py.SoftLink("/zzz_ds")
    with h5py.File(path, "r") as handle:
        link = handle.get("matrix", getlink=True)
        resolved = handle["matrix"]
        target = handle["zzz_ds"]
        if not isinstance(link, h5py.SoftLink):
            raise AssertionError(
                f"the SoftLink mutation did not land: link is {type(link).__name__}")
        info = h5py.h5o.get_info
        rf = info(resolved.id)
        tf = info(target.id)
        if not isinstance(resolved, h5py.Dataset) or (rf.fileno, rf.addr) != (tf.fileno, tf.addr):
            raise AssertionError(
                "the SoftLink mutation did not land: /matrix does not resolve to /zzz_ds")
    return root


def a_matrix_whose_MATRIX_is_a_HARD_LINK_to_a_Dataset(tmp_path):
    """`/matrix` = HARD LINK to `/zzz_ds` (a Dataset).

    Reach path 3 of #585: a hard link is INVISIBLE to `getlink=True` (it returns
    `h5py.HardLink`, exactly what an ordinary member returns), and the object is in the same
    file — so the ExternalLink leg passes it and `group = h5["matrix"]` resolves to the
    `zzz_ds` Dataset; the membership loop crashes with the same uncaught `ValueError`.
    MEASURED pre-fix through the shipped entrypoint: rc=1, raw ValueError traceback,
    0 output paths. Post-fix refused by name (rc 2, 0 paths), like the #507 hard-link rows.
    The mutation is PROVEN below by `(fileno, addr)` identity with `/zzz_ds` — the only way
    a hard link can be seen. Swept by TEST-8/TEST-9, pinned by content in TEST-97.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        h5.create_dataset("zzz_ds", data=np.zeros((3, 4), dtype=np.float64))
        del h5["matrix"]
        h5["matrix"] = h5["zzz_ds"]
    with h5py.File(path, "r") as handle:
        info = h5py.h5o.get_info
        m = info(handle["matrix"].id)
        z = info(handle["zzz_ds"].id)
        if not isinstance(handle["matrix"], h5py.Dataset) or (m.fileno, m.addr) != (z.fileno, z.addr):
            raise AssertionError(
                "the hard-link mutation did not land: /matrix is not the same object as /zzz_ds")
    return root


def a_matrix_whose_MATRIX_is_a_ONE_DIMENSIONAL_Dataset(tmp_path):
    """`/matrix` replaced by a plain inline 1-D `float64` Dataset.

    The EXTRA #585 variant that decides the fix shape — the message-coherence half: a 1-D
    Dataset does NOT crash the membership test (`"data" in <1-D Dataset>` iterates the
    scalar values and returns False), so the loop takes its MISSING-member branch and
    refuses with `filtered_feature_bc_matrix.h5 has no `/matrix/data` ...` — a FALSE
    diagnosis (the member exists; it is `matrix` that is not a group) that sends the
    operator to fix the wrong object. MEASURED pre-fix through the shipped entrypoint:
    rc=2, NO traceback, 0 output paths, but the stated offence is not the real one. Post-fix
    it refuses with the SAME "is not a group" message as the other three rows (rc 2,
    0 paths) — the true diagnosis. This row is the DISCRIMINATION CANARY for the source
    type-refusal: a tuple-widening / catch-based alternative fix cannot see this spelling at
    all (nothing raises), so only the explicit `isinstance(group, h5py.Group)` refusal puts
    it on the true diagnosis. The mutation is PROVEN below: `/matrix` is an `h5py.Dataset`
    with `ndim == 1`. Swept by TEST-8/TEST-9, pinned by content in TEST-98.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix"]
        h5.create_dataset("matrix", data=np.arange(3, dtype=np.float64))
    with h5py.File(path, "r") as handle:
        obj = handle["matrix"]
        if not isinstance(obj, h5py.Dataset) or obj.ndim != 1:
            raise AssertionError(
                f"the 1-D mutation did not land: {type(obj).__name__} ndim={obj.ndim}")
    return root


def a_matrix_whose_MATRIX_is_a_SAME_FILE_SoftLink_to_a_GROUP(tmp_path):
    """`/matrix` -> SoftLink("/matrix_copy") -- a same-file link to a GROUP.

    The OVER-REFUSAL CONTROL for #585 (TEST-101). The new check is an
    `isinstance(group, h5py.Group)` on the RESOLVED object, and h5py resolves a SoftLink
    transparently — so a same-file SoftLink at `/matrix` that resolves to a legitimate
    matrix GROUP must still import at rc 0. The check could have been written on the LINK
    (refusing any SoftLink at `/matrix`); this bundle is exactly what such a link-level
    check would refuse, which is what makes it the over-refusal control for the
    resolved-object design. MEASURED 2026-09-23 through the shipped entrypoint (pycache
    purged) on both the 0.13.0 base and HEAD: rc 0 with 120 output paths through that seam —
    the exact total is runner-environment-dependent (a direct CLI run, outside the runner
    wrapper, measures 119; the difference is the wrapper's `run-environment.json`) and NO
    test asserts the count (the import succeeded before this fix too, so the control's rc 0
    is the invariant to preserve).
    This builder is a CONTROL, deliberately NOT a
    `HB.REFUSALS` row: the importer MUST ACCEPT this bundle. The mutation is PROVEN below:
    `getlink=True` returns an `h5py.SoftLink`, and the resolved object is a Group — the
    SAME `(fileno, addr)` object as the copied `matrix_copy` group.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        h5.copy("matrix", "matrix_copy")
        del h5["matrix"]
        h5["matrix"] = h5py.SoftLink("/matrix_copy")
    with h5py.File(path, "r") as handle:
        link = handle.get("matrix", getlink=True)
        resolved = handle["matrix"]
        copied = handle["matrix_copy"]
        if not isinstance(link, h5py.SoftLink):
            raise AssertionError(
                f"the SoftLink mutation did not land: link is {type(link).__name__}")
        if not isinstance(resolved, h5py.Group):
            raise AssertionError(
                f"the SoftLink mutation did not land: /matrix resolves to "
                f"{type(resolved).__name__}, not a Group")
        info = h5py.h5o.get_info
        rf = info(resolved.id)
        cf = info(copied.id)
        if (rf.fileno, rf.addr) != (cf.fileno, cf.addr) or not {"data", "indices", "indptr"} <= set(resolved.keys()):
            raise AssertionError(
                "the SoftLink mutation did not land: /matrix does not resolve to "
                "/matrix_copy (a group carrying data/indices/indptr)")
    return root


def a_matrix_whose_MATRIX_is_a_HARD_LINK_to_a_GROUP(tmp_path):
    """`/matrix` = HARD LINK to `/matrix_copy` (a GROUP).

    The SECOND OVER-REFUSAL CONTROL for #585 (TEST-102). The new check is an
    `isinstance(group, h5py.Group)` on the RESOLVED object, and h5py resolves a hard link
    transparently — so `/matrix` hard-linked to a legitimate matrix GROUP must still import
    at rc 0. TEST-101 pins the SoftLink spelling; this builder pins the HARD-LINK spelling,
    because the check could have been written on the LINK class (refusing any hard link at
    `/matrix` — invisible to `getlink=True`, exactly the #507 rows' shape) and would
    over-refuse exactly this legitimate bundle. MEASURED 2026-09-23 through the shipped
    entrypoint (pycache purged) on both the 0.13.0 base and HEAD: rc 0 with 120 output paths
    through that seam and a `manifest.json` on disk — the exact total is
    runner-environment-dependent (a direct CLI run measures 119; the difference is the
    wrapper's `run-environment.json`) and NO test asserts the count (the import succeeded
    before this fix too, so the control's rc 0 is the invariant to preserve). This
    builder is a CONTROL, deliberately NOT a `HB.REFUSALS` row: the importer MUST ACCEPT this
    bundle. The mutation is PROVEN below: `getlink=True` returns an `h5py.HardLink` (a hard
    link, exactly what an ordinary member returns), and the resolved object is a Group — the
    SAME `(fileno, addr)` object as the copied `matrix_copy` group.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        h5.copy("matrix", "matrix_copy")
        del h5["matrix"]
        h5["matrix"] = h5["matrix_copy"]
    with h5py.File(path, "r") as handle:
        link = handle.get("matrix", getlink=True)
        resolved = handle["matrix"]
        copied = handle["matrix_copy"]
        if not isinstance(link, h5py.HardLink):
            raise AssertionError(
                f"the hard-link mutation did not land: link is {type(link).__name__} "
                f"(expected h5py.HardLink)")
        if not isinstance(resolved, h5py.Group):
            raise AssertionError(
                f"the hard-link mutation did not land: /matrix resolves to "
                f"{type(resolved).__name__}, not a Group")
        info = h5py.h5o.get_info
        rf = info(resolved.id)
        cf = info(copied.id)
        if (rf.fileno, rf.addr) != (cf.fileno, cf.addr) or not {"data", "indices", "indptr"} <= set(resolved.keys()):
            raise AssertionError(
                "the hard-link mutation did not land: /matrix does not resolve to "
                "/matrix_copy (a group carrying data/indices/indptr)")
    return root


def a_matrix_whose_MATRIX_is_a_DANGLING_SAME_FILE_SoftLink(tmp_path):
    """`/matrix` -> SoftLink("/does_not_exist_anywhere") -- the #587 shape as first reported.

    The presence test `"matrix" not in h5` is `H5Lexists`, which is TRUE for a dangling
    link, and the ExternalLink leg inspects the link via `getlink=True` and passes a
    SoftLink (it refuses only `h5py.ExternalLink` classes) -- so `group = h5["matrix"]`
    is the FIRST thing that follows the link, and it raises. MEASURED pre-fix through the
    shipped entrypoint: rc=1, raw `KeyError: 'Unable to synchronously open object
    (component not found)'` traceback at the unguarded `group = h5["matrix"]`, 0 output
    paths. Post-fix refused by name as "link exists but its target cannot be read"
    (rc 2, 0 paths). The mutation is PROVEN below: `getlink=True` returns an
    `h5py.SoftLink`, `H5Lexists` is still True, and resolution raises the KeyError --
    exactly the state that escaped pre-fix. Swept by TEST-8/TEST-9, pinned by content in
    TEST-103/TEST-108.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix"]
        h5["matrix"] = h5py.SoftLink("/does_not_exist_anywhere")
    with h5py.File(path, "r") as handle:
        link = handle.get("matrix", getlink=True)
        if not isinstance(link, h5py.SoftLink):
            raise AssertionError(
                f"the dangling-SoftLink mutation did not land: link is {type(link).__name__}")
        if "matrix" not in handle:
            raise AssertionError(
                "the dangling-SoftLink mutation did not land: the name is not even present "
                "(H5Lexists is the property the presence test reads)")
        try:
            handle["matrix"]
        except KeyError:
            pass
        else:
            raise AssertionError(
                "the dangling-SoftLink mutation did not land: /matrix resolved")
    return root


def a_matrix_whose_MATRIX_is_a_SoftLink_CHAIN_ending_nowhere(tmp_path):
    """`/matrix` -> SoftLink("/hop") -> SoftLink("/does_not_exist_anywhere").

    The CHAIN spelling of #587's reach: the issue names "a link chain ending nowhere" as
    part of the same class. `getlink=True` on `/matrix` returns one `h5py.SoftLink` (it
    inspects only the member's OWN link -- the same reason the member-loop's own-link
    check was bypassable, FIX_ROUND-2), so the ExternalLink leg passes it and
    `h5["matrix"]` walks the chain to a target that does not exist. MEASURED pre-fix
    through the shipped entrypoint: rc=1, raw `KeyError: 'Unable to synchronously open
    object (component not found)'` traceback at the unguarded `group = h5["matrix"]`,
    0 output paths -- the SAME sentence as the one-hop spelling, which is why the two
    rows share ONE diagnosis and are allowed together in `SHARED_DIAGNOSIS_ALLOWED`
    (the unreadable-target class; the rows exist because they reach it through different
    reach, not because the defect differs -- the #539/#585 four-row precedents).
    Post-fix refused by name as "link exists but its target cannot be read" (rc 2,
    0 paths). The mutation is PROVEN below: both links are `h5py.SoftLink`s, the chain is
    present, and resolution raises the KeyError. Swept by TEST-8/TEST-9, pinned by
    content in TEST-104.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix"]
        h5["matrix"] = h5py.SoftLink("/hop")
        h5["hop"] = h5py.SoftLink("/does_not_exist_anywhere")
    with h5py.File(path, "r") as handle:
        link = handle.get("matrix", getlink=True)
        hop = handle.get("hop", getlink=True)
        if not isinstance(link, h5py.SoftLink) or not isinstance(hop, h5py.SoftLink):
            raise AssertionError(
                f"the chain mutation did not land: /matrix link is "
                f"{type(link).__name__}, /hop link is {type(hop).__name__}")
        try:
            handle["matrix"]
        except KeyError:
            pass
        else:
            raise AssertionError(
                "the chain mutation did not land: /matrix resolved through the chain")
    return root


def a_matrix_whose_MATRIX_is_an_ExternalLink_to_a_MISSING_file(tmp_path):
    """`/matrix` = ExternalLink("/no_such_dir/outside.h5", "/matrix") -- target file MISSING.

    The MEASURED-PIN row for the #450 ExternalLink leg: `getlink=True` inspects the link
    WITHOUT following it, so the existing ExternalLink refusal fires by name at
    "is an ExternalLink" REGARDLESS of whether the target file exists. MEASURED on the
    base (0.14.0) through the shipped entrypoint: rc=2, the existing
    "`/matrix` is an ExternalLink" sentence, 0 output paths -- the spelling was already
    claimed by the existing leg, so this row does NOT get a second message (DEC-7). The
    row exists because the #587 fix is about link TARGETS, and a fix that moved the
    ExternalLink leg or wrapped an ExternalLink into the new "cannot be read" leg would
    silently change this sentence -- TEST-105 pins it. The mutation is PROVEN below:
    `getlink=True` returns an `h5py.ExternalLink` and the name is still present
    (resolution is deliberately NOT attempted -- that is the point of the pin; the file
    does not exist). Swept by TEST-8/TEST-9, pinned by content in TEST-105.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        del h5["matrix"]
        h5["matrix"] = h5py.ExternalLink("/no_such_dir/outside.h5", "/matrix")
    with h5py.File(path, "r") as handle:
        link = handle.get("matrix", getlink=True)
        if not isinstance(link, h5py.ExternalLink):
            raise AssertionError(
                f"the ExternalLink mutation did not land: link is {type(link).__name__}")
        if "matrix" not in handle:
            raise AssertionError(
                "the ExternalLink mutation did not land: the name is not even present")
    return root


def a_matrix_whose_MATRIX_is_a_SAME_FILE_SoftLink_CHAIN_to_a_GROUP(tmp_path):
    """`/matrix` -> SoftLink("/hop") -> SoftLink("/matrix_copy") — chain to a GROUP.

    The #587 OVER-REFUSAL CONTROL for the CHAIN spelling (TEST-109). The fix is about
    LINKS, and the deepest link-over-refusal shape is a chain: each hop's OWN link is a
    SoftLink (so a link-inspection check that refuses any SoftLink would trip here), yet
    the chain RESOLVES transparently to a legitimate matrix GROUP, which is exactly the
    object a real importer must accept. TEST-101 pins the one-hop spelling of the same
    design; this builder pins the chain spelling the #587 leg is the first thing to look
    at. MEASURED post-fix through the shipped entrypoint: rc 0 with a full store (the
    import succeeded on the base too — the control's rc 0 is the invariant to preserve).
    This builder is a CONTROL, deliberately NOT a `HB.REFUSALS` row: the importer MUST
    ACCEPT this bundle. The mutation is PROVEN below: `getlink=True` returns an
    `h5py.SoftLink` for BOTH `/matrix` and `/hop`, and the chain resolves to a Group —
    the SAME `(fileno, addr)` object as the copied `matrix_copy` group.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        h5.copy("matrix", "matrix_copy")
        del h5["matrix"]
        h5["matrix"] = h5py.SoftLink("/hop")
        h5["hop"] = h5py.SoftLink("/matrix_copy")
    with h5py.File(path, "r") as handle:
        link = handle.get("matrix", getlink=True)
        hop = handle.get("hop", getlink=True)
        resolved = handle["matrix"]
        copied = handle["matrix_copy"]
        if not isinstance(link, h5py.SoftLink) or not isinstance(hop, h5py.SoftLink):
            raise AssertionError(
                f"the chain mutation did not land: /matrix link is {type(link).__name__}, "
                f"/hop link is {type(hop).__name__}")
        if not isinstance(resolved, h5py.Group):
            raise AssertionError(
                f"the chain mutation did not land: /matrix resolves to "
                f"{type(resolved).__name__}, not a Group")
        info = h5py.h5o.get_info
        rf = info(resolved.id)
        cf = info(copied.id)
        if (rf.fileno, rf.addr) != (cf.fileno, cf.addr) or not {"data", "indices", "indptr"} <= set(resolved.keys()):
            raise AssertionError(
                "the chain mutation did not land: /matrix does not resolve to "
                "/matrix_copy (a group carrying data/indices/indptr)")
    return root


def a_matrix_with_a_CORRUPT_root_attribute(tmp_path):
    """A root attribute whose VALUE cannot be materialised — a vlen string whose
    global-heap object LENGTH is overwritten (#648).

    `h5py` writes a variable-length string attribute's payload into a GLOBAL HEAP
    object: the object is an 8-byte little-endian LENGTH followed by the payload
    bytes. Overwriting that LENGTH with `2**64 - 1` leaves the file structurally
    valid — the superblock, the root object header and the `/matrix` subtree are
    untouched, so `h5py.File(...)` and `h5["matrix"]` still work — while
    `h5a.read` of that attribute runs off the end of the heap. That is exactly the
    "truncated or corrupt attribute" class #648 is about, and the reader's failure
    is h5py's own (MEASURED through the shipped entrypoint on the unguarded base:
    rc=1, raw traceback at `attrs = dict(h5.attrs)` with
    `OSError: Can't synchronously read data (ran off end of input buffer while
    decoding)`, 0 output paths). The mutation is PROVEN below: the planted
    attribute exists and reads back through real h5py before the corruption, the 8
    bytes immediately before the payload marker are asserted == `len(marker)` (so
    the scan found the right heap object and not a coincidental copy of the
    payload), and the file's bytes change. The DEFAULT 8 um bin's matrix is the
    target: the plan audit measured that corrupting the NON-default square_002um
    file leaves the default-bin import at rc 0, so the builder must hit
    square_008um — the file a no-`bin_um` run selects. Swept by TEST-8/TEST-9,
    pinned by content in TEST-110.
    """
    import h5py
    import struct

    root = HF.staged_tree(tmp_path)
    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    marker = b"ATTACKER-CONTROLLED-STRING"
    with h5py.File(path, "r+") as h5:
        assert "evil_vlen" not in h5.attrs, (
            "the fixture already carries an `evil_vlen` root attribute — the planted "
            "marker would collide with a pre-existing one")
        h5.attrs.create("evil_vlen", data=marker.decode("ascii"),
                        dtype=h5py.string_dtype())
        # The planted attribute is really there before the run: not a no-op.
        assert h5.attrs["evil_vlen"] == marker.decode("ascii"), (
            "the planted attribute does not read back as its payload — the vlen-attr "
            "mutation did not land")
    raw = bytearray(path.read_bytes())
    pos = raw.find(marker)
    assert pos != -1, "the planted attribute's payload is not in the matrix file"
    stored = struct.unpack_from("<Q", raw, pos - 8)[0]
    assert stored == len(marker), (
        f"the 8 bytes before the marker are {stored}, not the payload length "
        f"{len(marker)} — the scan found the wrong heap object")
    struct.pack_into("<Q", raw, pos - 8, 0xFFFFFFFFFFFFFFFF)
    path.write_bytes(bytes(raw))
    return root


def _corrupt_member_chunk(root, member):
    """Recreate `/matrix/<member>` as a CHUNKED fletcher32 dataset, then flip one chunk byte.

    The member's values and dtype are copied unchanged, so every metadata check that
    precedes the target read (the member loop, the size/dtype checks, the alias identity
    walk) still passes and only the CONTENT READ fails. `fletcher32` makes the corruption
    DETECTED rather than silent: h5py raises
    `OSError: Can't synchronously read data (filter returned failure during read)` -- the
    exact class #471/#648 measured for a bundle whose bytes cannot be decoded (an
    unavailable filter, a truncated chunk, a checksum failure). The mutation is PROVEN in
    four steps so it can never be a no-op: the recreated dataset reads back before the flip,
    the chunk is located by `ds.id.get_chunk_info(0)` (not by guessing an offset), the
    file's bytes change, and the raw read RE-RAISES OSError through real h5py on the same
    file.
    """
    import h5py

    path = _bin_dir(root, 8) / "filtered_feature_bc_matrix.h5"
    with h5py.File(path, "r+") as h5:
        if member not in h5["matrix"]:
            raise AssertionError(f"the fixture has no `/matrix/{member}` to corrupt")
        values = h5["matrix/" + member][:]
        del h5["matrix/" + member]
        h5.create_dataset("matrix/" + member, data=values,
                          chunks=(max(1, len(values)),), fletcher32=True)
    with h5py.File(path, "r") as h5:
        chunk = h5["matrix/" + member].id.get_chunk_info(0)
        assert chunk.size > 0, chunk
    before = path.read_bytes()
    with open(path, "r+b") as fh:
        fh.seek(chunk.byte_offset)
        fh.write(b"\xff")
    assert path.read_bytes() != before, (
        f"the chunk flip did not change `/matrix/{member}`'s file bytes -- a no-op mutation "
        "cannot prove the guard it is meant to distinguish")
    with h5py.File(path, "r") as h5:
        try:
            h5["matrix/" + member][:]
        except OSError:
            pass
        else:
            raise AssertionError(
                f"the corrupted `/matrix/{member}` chunk must raise OSError on read")
    return path


def a_matrix_with_a_CORRUPT_shape_chunk(tmp_path):
    """`/matrix/shape` whose chunk bytes are corrupt (fletcher32), 8 um bin (#650).

    The dataset's METADATA is fine (it still sizes, types and identifies as the same
    object) but its BYTES cannot be decoded, so the failure surfaces at the VALUE READ
    `np.asarray(group["shape"][:])` -- which on the unguarded base escaped `main()`'s
    `except VisiumImportError` as a raw traceback at exit 1. MEASURED through the shipped
    entrypoint on this base:

        rc=1  paths=0
        OSError: Can't synchronously read data (filter returned failure during read)

    post-fix it is a NAMED `VisiumImportError` at exit 2 with NOTHING on disk. The
    structure of the read is exactly the shape the plan's ITEM-1 guards; the raw-read
    re-proof and the entrypoint pin are TEST-113.
    """
    root = HF.staged_tree(tmp_path)
    _corrupt_member_chunk(root, "shape")
    return root


def a_matrix_with_a_CORRUPT_indptr_chunk(tmp_path):
    """`/matrix/indptr` whose chunk bytes are corrupt (fletcher32), 8 um bin (#650).

    Same class as the shape corruptor, at the `indptr = np.asarray(group["indptr"][:])`
    read. MEASURED pre-fix: rc 1, raw traceback at that line, 0 paths. Post-fix: named
    refusal at rc 2. Pinned by content in TEST-114.
    """
    root = HF.staged_tree(tmp_path)
    _corrupt_member_chunk(root, "indptr")
    return root


def a_matrix_with_a_CORRUPT_barcodes_chunk(tmp_path):
    """`/matrix/barcodes` whose chunk bytes are corrupt (fletcher32), 8 um bin (#650).

    Reaches the RAW READ inside `decoded_h5_strings` -- the read whose `except` tuple
    omitted `OSError`. MEASURED pre-fix: rc 1 with the raw traceback naming the
    `raw = group[name][:]` line, 0 paths. Post-fix the refusal says the member is PRESENT
    but its bytes cannot be read -- it must NOT claim the member is absent (the sibling's
    rule). Pinned by content in TEST-115.
    """
    root = HF.staged_tree(tmp_path)
    _corrupt_member_chunk(root, "barcodes")
    return root


def a_matrix_with_a_CORRUPT_indices_chunk(tmp_path):
    """`/matrix/indices` whose chunk bytes are corrupt (fletcher32), 8 um bin (#650).

    Reaches the BLOCK SCAN that had NO try at all -- the one guarded dataset read #648's
    audit left bare. MEASURED pre-fix through the shipped entrypoint on this base:

        rc=1  paths=0
        File ".../import_visium_hd.py", line 3510, in run_import
            blk = np.asarray(ind_ds[lo:min(lo + step, nnz)])
        OSError: Can't synchronously read data (filter returned failure during read)

    A raw traceback with ABSOLUTE source paths -- INV-1's prohibited outcome -- while the
    IDENTICAL corruption in `/matrix/data` already refused by name at rc 2 on the same
    base (the asymmetry #650 is about). Structural checks verify the member before the
    scan (size, dtype, id-range metadata), so only the block read can fail. Pinned by
    content in TEST-116.
    """
    root = HF.staged_tree(tmp_path)
    _corrupt_member_chunk(root, "indices")
    return root


def a_matrix_with_a_CORRUPT_data_chunk(tmp_path):
    """`/matrix/data` whose chunk bytes are corrupt (fletcher32), 8 um bin (#650).

    The TWIN of the indices corruptor: the SAME corruption in the guarded member. On the
    base this already refused by name at rc 2 (`except (KeyError, OSError, TypeError,
    RuntimeError)`); the row exists to prove the two block scans AGREE post-fix -- the
    same corruption class is a named refusal in both halves of the matrix, and the tuples
    are pinned equal by TEST-118. Pinned by content in TEST-117.
    """
    root = HF.staged_tree(tmp_path)
    _corrupt_member_chunk(root, "data")
    return root


#: EVERY refusal this importer can reach, as `(id, builder, requested_bin, what it proves)`.
#:
#: `requested_bin` is the `bin_um` the run asks for, so the two selection refusals sit in the
#: same sweep as the reader ones rather than in a suite of their own — INV-8 and INV-9 are
#: claims about the module, not about one function.
REFUSALS = (
    ("not-a-bundle", not_a_bundle_at_all, None,
     "a directory with no `square_NNNum` bin anywhere"),
    ("standard-visium", a_standard_visium_outs, None,
     "a REAL standard Visium `outs/` — right vendor, wrong platform"),
    ("one-bin-missing", one_bin_missing, None,
     "a partial `binned_outputs/`, which the container's stated assumption forbids"),
    ("bin-size-disagrees", a_bin_that_declares_the_wrong_size, None,
     "a bin whose own `bin_size_um` contradicts the position it was presented at"),
    ("unknown-bin", lambda tmp: HF.staged_tree(tmp), 5,
     "a `bin_um` this bundle does not carry"),
    ("non-numeric-bin", lambda tmp: HF.staged_tree(tmp), "eight",
     "a `bin_um` that is not a number at all"),
    ("positions-not-parquet", a_positions_file_that_is_not_parquet, None,
     "a positions member that is not a readable parquet file"),
    ("positions-missing-column", a_positions_file_missing_a_column, None,
     "a positions table missing a declared column"),
    ("positions-duplicate-barcode", a_positions_file_with_a_duplicated_barcode, None,
     "a barcode listed twice"),
    ("positions-missing-barcode", a_positions_file_missing_a_matrix_barcode, None,
     "a matrix barcode with no position — the join refusal"),
    ("positions-non-utf8-barcode", a_positions_file_with_a_non_utf8_barcode, None,
     "a join key that is not valid UTF-8"),
    ("positions-non-numeric-coordinate", a_positions_column_that_is_not_a_number, None,
     "a coordinate column that is not a number"),
    ("h5-unencodable-attribute", an_h5_with_an_unencodable_root_attribute, None,
     "vendor text this platform could not write, in the silent `|S` shape"),
    ("h5-no-matrix-group", an_h5_with_no_matrix_group, None,
     "an HDF5 file that is not a 10x feature-barcode matrix"),
    ("h5-shape-disagrees", a_matrix_whose_shape_disagrees_with_its_barcodes, None,
     "a declared shape the file's own datasets contradict"),
    ("scalefactors-unencodable-text", a_scalefactors_file_with_unencodable_text, None,
     "a scale document carrying a lone surrogate"),
    # ── FIX_ROUND-1: every row below was a defect two blind audits found and REPRODUCED,
    #    and every one of them was a state this table could not reach.
    ("matrix-not-hdf5", a_matrix_that_is_not_hdf5, None,
     "a matrix file that is not HDF5 at all -- the unguarded open"),
    ("matrix-no-features", a_matrix_with_no_features_group, None,
     "`/matrix/features` absent, resolved outside the helper's own guard"),
    ("matrix-duplicate-barcode", a_matrix_with_a_duplicated_barcode, None,
     "a barcode listed twice in the MATRIX, which makes the emitted axis index ambiguous"),
    ("matrix-no-barcodes", a_matrix_with_no_barcodes, None,
     "a matrix carrying no barcodes at all, which would otherwise import at rc 0, "
     "reported as SUCCESS"),
    ("matrix-no-stored-values", a_matrix_with_no_stored_values, None,
     "a matrix declaring barcodes but holding ZERO stored values, which would otherwise "
     "import at rc 0, reported as SUCCESS with a store holding no values -- the #470 shape"),
    ("matrix-no-stored-values-16um",
     lambda tmp: a_matrix_with_no_stored_values(tmp, bin_um=16), 16,
     "a NON-DEFAULT bin (16 um) declaring barcodes but holding ZERO stored values, which "
     "would otherwise import at rc 0, reported as SUCCESS -- the #470 shape at a "
     "non-default bin"),
    ("matrix-all-zero-stored-values", a_matrix_with_all_zero_stored_values, None,
     "a matrix declaring barcodes whose stored values are ALL exactly 0, which would "
     "otherwise import at rc 0, reported as SUCCESS -- the #533 shape"),
    ("matrix-all-zero-stored-values-16um",
     lambda tmp: a_matrix_with_all_zero_stored_values(tmp, bin_um=16), 16,
     "a NON-DEFAULT bin (16 um) whose stored values are ALL exactly 0 -- the #533 shape at "
     "a non-default bin"),
    ("matrix-all-nonfinite-stored-values", a_matrix_with_all_nonfinite_stored_values, None,
     "a matrix declaring barcodes whose stored values are ALL NaN (Inf is covered by "
     "TEST-85 rather than swept), which imports into a dataset with no usable counts at "
     "rc 0 -- the #548 shape (the same no-usable-value boundary as all-zero, reached "
     "through non-finite values)"),
    ("matrix-all-nonfinite-stored-values-16um",
     lambda tmp: a_matrix_with_all_nonfinite_stored_values(tmp, bin_um=16), 16,
     "a NON-DEFAULT bin (16 um) whose stored values are ALL non-finite -- the #548 shape "
     "at a non-default bin"),
    ("matrix-nonmonotonic-indptr", a_matrix_with_a_NON_MONOTONIC_indptr, None,
     "a CSC offset array that decreases, which raises out of shared framework code"),
    ("no-run-identity", a_bundle_with_NO_run_identity, None,
     "no library id and no sample id, so the coordinate frame would collide with every "
     "other such bundle"),
    ("positions-duplicate-column", a_positions_file_with_a_DUPLICATED_column, None,
     "an ambiguous column name, which silently reads the LAST column"),
    ("positions-non-finite-coordinate", a_positions_coordinate_that_is_NOT_FINITE, None,
     "`inf` in a coordinate the matrix uses"),
    ("array-index-too-large", an_array_index_TOO_LARGE_for_int32, None,
     "a lattice index no int32 can hold"),
    ("bin-from-two-directories", a_bin_ASSEMBLED_FROM_TWO_DIRECTORIES, None,
     "four unique members that are not one run"),
    # ── FIX_ROUND-2: four states the SECOND blind audit reached and reproduced, three of
    #    them past a guard this package had already written.
    ("library-id-only-whitespace", a_bundle_whose_library_id_is_ONLY_WHITESPACE, None,
     "an identity made of spaces, which walked past the identity refusal and died inside "
     "the declaration contract with 51 paths on disk"),
    ("indptr-unsigned-decreasing", a_matrix_whose_indptr_is_UNSIGNED_and_decreasing, None,
     "a decreasing CSC offset array stored unsigned, which the dtype-blind check could not "
     "see"),
    ("indptr-not-ending-at-nnz", a_matrix_whose_indptr_does_NOT_END_AT_NNZ, None,
     "a monotonic offset array that disagrees with the value count"),
    ("coordinate-too-large-for-float32", a_coordinate_TOO_LARGE_FOR_FLOAT32, None,
     "a finite double that becomes `inf` when stored as a float32 coordinate"),
    # ── FIX_ROUND-3: a door a FIX ROUND opened.
    ("matrix-data-not-sizeable", a_matrix_whose_DATA_cannot_be_SIZED, None,
     "a `/matrix/data` that cannot be sized, which escaped as a traceback from the "
     "cross-check added to prevent exactly that"),
    # ── FIX_ROUND-4: the THIRD member of the CSC triple, which the round-3 guard did not
    #    reach. Four doors, four different framework tracebacks, one of them silent.
    ("indices-not-sizeable", a_matrix_whose_INDICES_cannot_be_SIZED, None,
     "an `/matrix/indices` that cannot be sized, which arrived as a `TypeError` out of "
     "`_lib/txr_csc.py` rather than a statement about this bundle"),
    ("indices-length-disagrees", a_matrix_whose_INDICES_ARE_TOO_SHORT, None,
     "a truncated `/matrix/indices`, which h5py CLAMPS -- so the import succeeded and "
     "silently stored half the bundle's non-zero values"),
    ("indices-id-past-the-end", a_matrix_with_a_FEATURE_ID_PAST_THE_END, None,
     "a CSC feature id naming a row this file does not declare"),
    ("indices-negative-id", a_matrix_with_a_NEGATIVE_FEATURE_ID, None,
     "the LOW end of the same range, which a high-end-only bound passes verbatim"),
    # ── FIX_ROUND-4, second half: a bound on VALUES is not a bound on TYPES, and every
    #    check in this block is written in numpy -- whose answer on a non-numeric array is
    #    an exception, not a False. So the guard itself became the raising line.
    ("indptr-not-numeric", a_matrix_whose_INDPTR_IS_NOT_A_NUMBER, None,
     "a `/matrix/indptr` stored as text, which raised out of the cast inside the guard "
     "block written to prevent exactly that class"),
    ("data-not-numeric", a_matrix_whose_DATA_IS_NOT_A_NUMBER, None,
     "a `/matrix/data` stored as text, which passed every shape check and died inside the "
     "store writer with five paths already on disk"),
    ("indices-not-numeric", a_matrix_whose_INDICES_ARE_NOT_A_NUMBER, None,
     "a `/matrix/indices` stored as text, which raised out of the id-range scan added in "
     "this same round"),
    ("indices-not-integer", a_matrix_whose_INDICES_ARE_FLOATS, None,
     "a numeric `/matrix/indices` that is still not an index array -- the SILENT door, "
     "which imported at exit 0 over truncated feature ids"),
    ("indptr-two-dimensional", a_matrix_whose_INDPTR_IS_TWO_DIMENSIONAL, None,
     "a right-sized `/matrix/indptr` of the wrong shape, whose refusal used to state a "
     "contradiction rather than the defect"),
    # ── FIX_ROUND-6: the other four columns the registration QC reads. Only
    #    `pxl_col_in_fullres` was in this table, and the QC's one-class fallback is
    #    unreachable exactly to the extent that all five refuse before the first writer.
    ("positions-non-numeric-in-tissue", a_positions_IN_TISSUE_that_is_not_a_number, None,
     "an `in_tissue` column that is not a number"),
    ("positions-non-numeric-array-row", a_positions_ARRAY_ROW_that_is_not_a_number, None,
     "an `array_row` column that is not a number"),
    ("positions-non-numeric-array-col", a_positions_ARRAY_COL_that_is_not_a_number, None,
     "an `array_col` column that is not a number"),
    ("positions-non-numeric-pxl-row", a_positions_PXL_ROW_that_is_not_a_number, None,
     "a `pxl_row_in_fullres` column that is not a number"),
    # ── the CSC members must be REAL, SELF-CONTAINED, INLINE datasets. A VIRTUAL
    #    dataset or EXTERNAL raw storage makes the values depend on files outside the
    #    bundle -- h5py silently FILLS a missing VDS source (rc 0, wrong matrix) and an
    #    external `.bin` dies inside `_lib` with a traceback and a partial store.
    ("indices-virtual-missing-source",
     a_matrix_whose_INDICES_are_a_VIRTUAL_dataset_over_a_missing_source, None,
     "a `/matrix/indices` whose values live in a MISSING VDS source, which h5py silently "
     "fills -- every count attributed to gene 0 at rc 0"),
    ("data-virtual-missing-source",
     a_matrix_whose_DATA_is_a_VIRTUAL_dataset_over_a_missing_source, None,
     "a `/matrix/data` whose values live in a MISSING VDS source, which h5py silently "
     "fills -- an all-zero store at rc 0"),
    ("indices-external-missing-bin",
     a_matrix_whose_INDICES_have_EXTERNAL_raw_storage, None,
     "a `/matrix/indices` with EXTERNAL raw storage over a missing `.bin`, which "
     "`is_virtual` cannot see -- a raw `OSError` traceback at rc 1"),
    ("data-external-missing-bin",
     a_matrix_whose_DATA_has_EXTERNAL_raw_storage, None,
     "a `/matrix/data` with EXTERNAL raw storage over a missing `.bin`, which died inside "
     "`_lib` with a five-path partial store at rc 1"),
    # ── FIX_ROUND-1 (this round): the member loop's own doors. The unguarded
    #    `group[member]` regressed four named refusals into raw KeyError tracebacks at rc 1,
    #    and an ExternalLink walked straight through the inline check at rc 0.
    ("matrix-missing-data", a_matrix_MISSING_its_data_member, None,
     "a `/matrix/data` that is absent, which the unguarded member read turned into a raw "
     "KeyError traceback at rc 1"),
    ("matrix-broken-external-link", a_matrix_whose_INDICES_are_a_BROKEN_ExternalLink, None,
     "a `/matrix/indices` that is a broken ExternalLink, which escaped as a raw KeyError "
     "traceback at rc 1"),
    ("matrix-broken-soft-link", a_matrix_whose_DATA_is_a_BROKEN_SoftLink, None,
     "a `/matrix/data` that is a broken SoftLink, which escaped as a raw KeyError "
     "traceback at rc 1"),
    ("matrix-external-link-member",
     a_matrix_whose_DATA_is_an_ExternalLink_to_an_OUTSIDE_file, None,
     "a `/matrix/data` that is an ExternalLink to an EXISTING file outside the bundle, "
     "which imported at rc 0 with a full store built from outside data"),
    ("matrix-external-link-group",
     a_matrix_whose_MATRIX_group_is_an_ExternalLink_to_an_OUTSIDE_file, None,
     "a `/matrix` that is an ExternalLink to an EXISTING file outside the bundle, which "
     "imported at rc 0 with 120 output paths"),
    ("matrix-member-is-group", a_matrix_whose_INDPTR_is_a_GROUP, None,
     "a `/matrix/indptr` that is a GROUP, which the isinstance leg refuses as "
     "'is not a dataset'"),
    # ── FIX_ROUND-2 (this round): the STRUCTURAL net. The member loop enumerates only the
    #    CSC triple, so a SoftLink CHAIN and every non-CSC member walked straight through
    #    it at rc 0 with a wrong store.
    ("matrix-softlink-chain-data",
     a_matrix_whose_DATA_is_a_SoftLink_CHAIN_to_an_OUTSIDE_file, None,
     "a `/matrix/data` that is a SoftLink CHAIN to an outside file, which imported at rc 0 "
     "with a full store built from the outside file's all-7s values"),
    ("matrix-softlink-chain-group",
     a_matrix_whose_MATRIX_group_is_a_SoftLink_CHAIN_to_an_OUTSIDE_file, None,
     "a `/matrix` that is a SoftLink CHAIN to an outside matrix group, which imported at "
     "rc 0 with the ENTIRE matrix group coming from outside the bundle"),
    ("matrix-external-link-barcodes",
     a_matrix_whose_BARCODES_are_an_ExternalLink_to_an_OUTSIDE_file, None,
     "a `/matrix/barcodes` that is an ExternalLink to an outside file holding the bundle's "
     "own barcodes REVERSED -- a silently MISLABELED matrix at rc 0"),
    ("matrix-external-link-barcodes-different-set",
     a_matrix_whose_BARCODES_are_an_ExternalLink_to_an_OUTSIDE_file_with_a_DIFFERENT_set, None,
     "a `/matrix/barcodes` that is an ExternalLink to an outside file holding a DIFFERENT "
     "barcode set -- the #476 shape, which pre-fix was refused with a message blaming "
     "`tissue_positions.parquet` for a defect that is really the ExternalLink"),
    ("matrix-external-link-features-id",
     a_matrix_whose_FEATURES_ID_is_an_ExternalLink_to_an_OUTSIDE_file, None,
     "a `/matrix/features/id` that is an ExternalLink to an outside file, which imported "
     "at rc 0 with 120 output paths"),
    # ── FIX_ROUND-3a (this round): the structural walk's own crash doors. The walk
    #    branches on object CLASS, and two classes it can meet were not handled: a
    #    COMMITTED DATATYPE has no `.keys()`, and unbounded DEPTH blew the recursion limit.
    ("matrix-committed-datatype",
     a_matrix_with_a_COMMITTED_DATATYPE_under_matrix, None,
     "a COMMITTED (named) HDF5 datatype under `/matrix`, which the walk's Dataset-else-"
     "Group descent crashed on with a raw `AttributeError: 'Datatype' object has no "
     "attribute 'keys'` traceback at rc 1"),
    ("matrix-deep-group-nesting",
     a_matrix_with_DEEP_GROUP_NESTING_under_matrix, None,
     "3000 nested empty groups under `/matrix`, which blew Python's recursion limit into a "
     "raw `RecursionError` traceback at rc 1"),
    # ── FIX_ROUND-3a2 (this round): HDF5's OWN link-traversal limit escaped the guarded
    #    read as a raw RuntimeError, and the walk's coverage of `/matrix/shape` is pinned.
    ("matrix-deep-softlink-chain-data",
     a_matrix_whose_DATA_is_a_DEEP_SAME_FILE_SoftLink_CHAIN, None,
     "a `/matrix/data` that is a DEEP SAME-FILE SoftLink CHAIN, which HDF5's own link-"
     "traversal limit turned into a raw `RuntimeError` traceback at rc 1"),
    ("matrix-external-link-shape",
     a_matrix_whose_SHAPE_is_an_ExternalLink_to_an_OUTSIDE_file, None,
     "a `/matrix/shape` that is an ExternalLink to an outside file holding the SAME "
     "dimensions, which only the structural walk's realpath leg can refuse"),
    # ── FIX_ROUND-5 (this round): the SAME-FILE aliasing class (#507). The realpath walk
    #    compares which FILE an object lives in, never which OBJECT a name resolves to, so
    #    every alias that stays inside the bundle's own file imported at rc 0 with a wrong
    #    store. Two predicates close the class: no ExternalLink anywhere under `/matrix`
    #    (wherever it points), and the seven consumed members must be seven DISTINCT
    #    objects.
    ("matrix-features-id-same-file-external-link",
     a_matrix_whose_FEATURES_ID_is_a_SAME_FILE_ExternalLink, None,
     "a `/matrix/features/id` that is an ExternalLink BACK into the bundle's own file, "
     "which the realpath check passes (same file) and which imported at rc 0 on the "
     "sibling importer with gene ids holding feature NAMES"),
    ("matrix-features-id-hard-link",
     a_matrix_whose_FEATURES_ID_is_a_HARD_LINK_to_FEATURES_NAME, None,
     "a `/matrix/features/id` that is a HARD LINK to `/matrix/features/name`, which is "
     "invisible to `getlink=True` and which imported at rc 0 on the sibling importer with "
     "gene ids holding feature NAMES"),
    ("matrix-barcodes-same-file-external-link",
     a_matrix_whose_BARCODES_are_a_SAME_FILE_ExternalLink, None,
     "a `/matrix/barcodes` that is an ExternalLink BACK into the bundle's own file at a "
     "reversed copy, which imported at rc 0 on the sibling importer with the barcode axis "
     "REVERSED"),
    ("matrix-data-hard-link",
     a_matrix_whose_DATA_is_a_HARD_LINK_to_INDICES, None,
     "a `/matrix/data` that is a HARD LINK to `/matrix/indices`, which imported at rc 0 on "
     "the sibling importer with the store's `data` holding the INDICES values -- "
     "#461/TEST-67's case as a hard link"),
    ("matrix-data-softlink-to-same-file-external-link",
     a_matrix_whose_DATA_is_a_SoftLink_to_a_SAME_FILE_ExternalLink, None,
     "a `/matrix/data` that is a SoftLink to a same-file ExternalLink at `/matrix/indices`, "
     "which defeated the member's own-link check and imported at rc 0 on the sibling "
     "importer with the store's `data` holding the INDICES values"),
    ("matrix-data-15-hop-softlink-chain",
     a_matrix_whose_DATA_is_a_15_HOP_SAME_FILE_SoftLink_CHAIN, None,
     "a `/matrix/data` that is a 15-hop SAME-FILE SoftLink chain ending at `/matrix/indices`, "
     "which resolved under HDF5's 16-link limit and imported at rc 0 on the sibling "
     "importer with the store's `data` holding the INDICES values"),
    ("matrix-data-softlink-through-sibling-group-external-link",
     a_matrix_with_a_data_SoftLink_through_a_SIBLING_GROUP_ExternalLink_to_indices, None,
     "a `/matrix/data` that is a SoftLink to `/other_group/bar`, an ExternalLink back into "
     "the bundle's own file at `/matrix/indices` -- a detour outside `/matrix` that the "
     "structural walk never visits, which the alias check still catches as the SAME "
     "object"),
    # -- #539: `/matrix/features` as a Dataset (not a Group). The structural walk passes all
    #    four spellings (same file, inline or same-file link, an h5py.Dataset), and the alias
    #    check then resolves the two `features/*` members through a Dataset, which escaped as
    #    a raw ValueError/AttributeError traceback at rc 1 (MEASURED, recorded in each
    #    builder's docstring). The fix refuses the resolved object BY NAME when it is not a
    #    Group; the four rows share ONE diagnosis (`/matrix/features` is not a group) and are
    #    allowed together in SHARED_DIAGNOSIS_ALLOWED -- the #507 hard-link/SoftLink rows'
    #    precedent.
    ("matrix-features-inline-dataset", a_matrix_whose_FEATURES_is_a_plain_INLINE_Dataset, None,
     "a `/matrix/features` that is an ordinary inline Dataset, whose `['id']` subscript "
     "escaped as a raw ValueError traceback at rc 1"),
    ("matrix-features-softlink-to-dataset",
     a_matrix_whose_FEATURES_is_a_SAME_FILE_SoftLink_to_barcodes, None,
     "a `/matrix/features` that is a SAME-FILE SoftLink to the barcodes Dataset, which the "
     "structural walk passes and which escaped as the same raw ValueError at rc 1"),
    ("matrix-features-hard-link-to-dataset",
     a_matrix_whose_FEATURES_is_a_HARD_LINK_to_barcodes, None,
     "a `/matrix/features` that is a HARD LINK to the barcodes Dataset (invisible to "
     "`getlink=True`), which escaped as the same raw ValueError at rc 1"),
    ("matrix-features-compound-dtype-dataset",
     a_matrix_whose_FEATURES_is_a_COMPOUND_dtype_Dataset, None,
     "a `/matrix/features` that is a COMPOUND-dtype Dataset, whose `['id']` subscript "
     "SUCCEEDS and which escaped as a raw AttributeError at rc 1 -- the discrimination "
     "proof that only the explicit type refusal closes the class"),
    # -- #585: `/matrix` itself as a Dataset (not a Group) -- the SAME class one level up,
    #    which #539 deliberately left open (filed separately; the 0.13.0 entry and the
    #    #539 fix-round comment name the deferral). `group = h5["matrix"]` is never
    #    type-checked, so the membership loop's `if member not in group:` (the FIRST use)
    #    is what `in`-comparison dies on for a non-Group: a 2-D Dataset iterates rows and
    #    the `==` truth test raises the ambiguity ValueError (rc 1, raw traceback), and a
    #    1-D Dataset iterates scalars and returns False, so the loop refuses with the FALSE
    #    "has no `/matrix/data`" diagnosis (MEASURED, recorded in each builder's docstring).
    #    The fix refuses the resolved object BY NAME when it is not a Group; the four rows
    #    share ONE diagnosis (`/matrix` is not a group) and are allowed together in
    #    SHARED_DIAGNOSIS_ALLOWED -- the #539 rows' precedent.
    ("matrix-root-inline-dataset", a_matrix_whose_MATRIX_is_a_plain_INLINE_Dataset, None,
     "a `/matrix` that is an ordinary inline 2-D Dataset, whose resolution made the "
     "membership test escape as a raw ValueError traceback at rc 1"),
    ("matrix-root-softlink-to-dataset",
     a_matrix_whose_MATRIX_is_a_SAME_FILE_SoftLink_to_a_Dataset, None,
     "a `/matrix` that is a SAME-FILE SoftLink to a Dataset (the ExternalLink leg passes a "
     "SoftLink), which escaped as the same raw ValueError at rc 1"),
    ("matrix-root-hard-link-to-dataset",
     a_matrix_whose_MATRIX_is_a_HARD_LINK_to_a_Dataset, None,
     "a `/matrix` that is a HARD LINK to a Dataset (invisible to `getlink=True`), which "
     "escaped as the same raw ValueError at rc 1"),
    ("matrix-root-1d-dataset",
     a_matrix_whose_MATRIX_is_a_ONE_DIMENSIONAL_Dataset, None,
     "a `/matrix` that is a 1-D Dataset, which did NOT crash but was refused with the "
     "FALSE 'has no `/matrix/data`' diagnosis -- the message-coherence half of #585, and "
     "the canary that only the explicit type refusal fixes (a catch cannot see a spelling "
     "that raises nothing)"),
    # -- #587: a `/matrix` LINK whose target does not resolve -- the sibling's
    #    unreadable-target leg, tracked as open by the 0.14.0/#585 entry. `group =
    #    h5["matrix"]` sat OUTSIDE every try; the presence test `"matrix" not in h5` is
    #    `H5Lexists` (TRUE for a dangling link) and the ExternalLink leg passes a SoftLink,
    #    so a same-file dangling SoftLink (or a SoftLink CHAIN ending nowhere) escaped as a
    #    raw `KeyError: 'Unable to synchronously open object (component not found)'`
    #    traceback at rc 1 with 0 output paths (MEASURED, recorded in each builder's
    #    docstring). The fix guards the subscript -- MINIMAL try, `except
    #    VisiumImportError: raise` first (it is a `RuntimeError` subclass), then the
    #    four-type tuple, `from None`; the #585 isinstance refusal stays OUTSIDE. The two
    #    SoftLink rows share ONE diagnosis (the unreadable-target class) and are allowed
    #    together in SHARED_DIAGNOSIS_ALLOWED; the ExternalLink-to-a-MISSING-file row is a
    #    PIN (its target file is irrelevant to the diagnosis -- the refresh is the link
    #    class, measured base-identical at rc 2 with the existing sentence) and shares its
    #    diagnosis with `matrix-external-link-group` by design.
    ("matrix-root-dangling-softlink",
     a_matrix_whose_MATRIX_is_a_DANGLING_SAME_FILE_SoftLink, None,
     "a `/matrix` that is a SAME-FILE DANGLING SoftLink (link present, target missing), "
     "which escaped as a raw KeyError traceback at rc 1"),
    ("matrix-root-softlink-chain-ends-nowhere",
     a_matrix_whose_MATRIX_is_a_SoftLink_CHAIN_ending_nowhere, None,
     "a `/matrix` that is a SoftLink CHAIN ending nowhere, which escaped as the same raw "
     "KeyError traceback at rc 1"),
    ("matrix-root-external-link-missing-target",
     a_matrix_whose_MATRIX_is_an_ExternalLink_to_a_MISSING_file, None,
     "a `/matrix` that is an ExternalLink to a MISSING file, which the EXISTING ExternalLink "
     "leg already refuses BY NAME as 'is an ExternalLink' at rc 2 -- the pin (not a second "
     "message) for the spelling the #587 fix's reach touches"),
    # -- #648: the ROOT-ATTRIBUTE read — the LAST UNGUARDED ATTRIBUTE-MATERIALISATION
    #    read in the matrix block, and the one read of the file's ROOT OBJECT with no
    #    guard at all — the #345/#451/#349 analogue sweep had not reached here.
    #    RESIDUAL SAME-CLASS DOORS, pre-existing and OUT of #648's attribute-read scope
    #    (recorded in this run's LEDGER B-1 + GH comment, NOT closed here): the
    #    `/matrix/shape` and `/matrix/indptr` guards omit OSError/OverflowError and the
    #    indices data read at `np.asarray(ind_ds[...])` is bare — the same INV-1 class
    #    on DATASET reads.
    #    `dict(h5.attrs)` MATERIALISES every root
    #    attribute, and a corrupted attribute makes h5py raise while materialising —
    #    MEASURED through the shipped entrypoint on this base: rc=1, raw traceback at
    #    `attrs = dict(h5.attrs)`, `OSError: ... ran off end of input buffer while
    #    decoding`, 0 output paths. Post-fix it refuses BY NAME at rc 2 (the sibling's
    #    #471 class, ported). The factory proof lives in the builder; the raw-read
    #    re-proof and the entrypoint pin are TEST-110.
    ("matrix-corrupt-root-attribute", a_matrix_with_a_CORRUPT_root_attribute, None,
     "a root attribute whose VALUE cannot be materialised — a vlen string whose "
     "global-heap object length is corrupt, which made `dict(h5.attrs)` escape as a "
     "raw OSError traceback at rc 1 (the #471 class)"),
    # -- #650: the four guarded DATASET reads' residuals + the one unguarded scan. The
    #     #648 sweep recorded these doors verbatim in its 0.22.0 entry ("the pre-existing
    #     guards on `/matrix/shape` and `/matrix/indptr` omit OSError/OverflowError and the
    #     indices data read at `np.asarray(ind_ds[...])` is bare") and in its LEDGER B-1.
    #     This node closes them all with the same narrow-guard shape, and widens the
    #     guarded twin to the same tuple so the two block scans cannot diverge again. The
    #     classes are DISTINCT per member (each solution is the test's own re-proof
    #     through real h5py), and the row diagnoses are member-named so no
    #     SHARED_DIAGNOSIS_ALLOWED entry is needed.
    ("matrix-corrupt-shape", a_matrix_with_a_CORRUPT_shape_chunk, None,
     "a `/matrix/shape` whose chunk bytes are corrupt (fletcher32), which escaped the "
     "shape guard as a raw OSError traceback at rc 1 because the tuple omitted OSError "
     "(the #650 class)"),
    ("matrix-corrupt-indptr", a_matrix_with_a_CORRUPT_indptr_chunk, None,
     "a `/matrix/indptr` whose chunk bytes are corrupt (fletcher32), which escaped the "
     "indptr guard as a raw OSError traceback at rc 1 because the tuple omitted OSError "
     "(the #650 class)"),
    ("matrix-corrupt-barcodes", a_matrix_with_a_CORRUPT_barcodes_chunk, None,
     "a `/matrix/barcodes` whose chunk bytes are corrupt (fletcher32), which escaped the "
     "`decoded_h5_strings` read as a raw OSError traceback at rc 1 because the tuple "
     "omitted OSError (the #650 class)"),
    ("matrix-corrupt-indices", a_matrix_with_a_CORRUPT_indices_chunk, None,
     "a `/matrix/indices` whose chunk bytes are corrupt (fletcher32), which escaped the "
     "UNGUARDED indices block scan as a raw OSError traceback at rc 1 while the "
     "identical `/matrix/data` corruption refused by name at rc 2 (the #650 asymmetry)"),
    ("matrix-corrupt-data", a_matrix_with_a_CORRUPT_data_chunk, None,
     "a `/matrix/data` whose chunk bytes are corrupt (fletcher32) -- the guarded twin's "
     "same class, now widened to the same six-name fence as the indices scan (the #650 "
     "twin-agreement pin)"),
)
