#!/usr/bin/env python3
# ruff: noqa
r"""Every unguarded `/matrix` read becomes a NAMED refusal (#345 / #451).

`run_import` reads the 10x `/matrix` group and its surroundings — the file open, the
`/matrix` group itself, `/matrix/shape` and `/matrix/features` — and `main()` catches only
`VisiumImportError`. Every one of those reads was UNGUARDED: a malformed bundle escaped as
a raw traceback at exit 1 (INV-1's prohibited outcome), because nothing between the open
and the first writer (`cyto_csc.write_csc_zarr`, which creates `outputs/expression.zarr`)
turned the failure into a named refusal. #345 / #451 add four validators that fire
STRICTLY BEFORE that first writer, so a refused bundle leaves no store, no partial store
and nothing for a later reader to find (INV-2).

This file is the regression battery for those validators. Every row below was MEASURED on
this exact tree BEFORE the fix, through the SHIPPED entrypoint —
`visium_fixtures.run_entry_bytes`, which runs `compute/import_visium.py` as a subprocess
over the `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR` seam with stdout/stderr captured as BYTES.
The measured pre-fix outcome is quoted in each test's docstring; a test that merely
restated the code would not be a regression test.

The invariants under test are this package's own numbers
(`docs/design/vendor-text-encodability-refusal.md` §6.5):

  INV-1 — a bundle this importer cannot carry is REFUSED BY NAME (`VisiumImportError`),
          never a traceback and never an exit-1.
  INV-2 — the refusal fires BEFORE any artifact byte is written, so a refused import leaves
          no store, no partial store and nothing for a later reader to find.

The committed fixture is MEASURED, not re-derived: `/matrix/shape` is int32 [150, 120]
(n_features=150, n_barcodes=120), `/matrix/features` is a group holding `id` and `name`
datasets, and the matrix file itself is a genuine HDF5 file. Damage is always done to a
COPY of the committed fixture; the fixture itself is never modified.
"""
import json
import shutil
import struct
import sys
from pathlib import Path

import h5py
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

MATRIX = "filtered_feature_bc_matrix.h5"

#: The committed fixture's own numbers (measured, see the module docstring).
N_FEATURES = 150
N_BARCODES = 120
NNZ = 17677

#: The prefix `main()` puts on every refusal it prints.
_REFUSAL_PREFIX = b"spatial.import-visium: "


def _copy(tmp_path, name):
    dest = Path(tmp_path) / name
    shutil.copytree(VF.FIXTURE, dest)
    return dest


def _assert_refused(result, out, member_path, *, marker):
    """The four legs every refusal test must assert (INV-1 and INV-2), plus the wording.

    `member_path` is the BACKTICKED path the message actually uses (`` `/matrix/shape` ``,
    `` `/matrix` ``), so the assertion pins the real member rather than any refusal at all.

    1. `returncode == 2` — a NAMED refusal, never 0 and never 1 (INV-1).
    2. no `Traceback` on stderr — INV-1's prohibited outcome.
    3. the outputs tree is EMPTY — no store, no partial store, no manifest, nothing for a
       later reader to find (INV-2).
    4. the refusal NAMES the offending member by the BACKTICKED PATH the messages actually
       use, and carries `main()`'s `spatial.import-visium:` prefix, plus the exact sentence
       that says what is wrong, so the test pins the real wording rather than any refusal
       at all.
    """
    assert result.returncode == 2, (
        f"expected a NAMED refusal (rc=2), got rc={result.returncode}; "
        f"stderr tail: {result.stderr[-2000:]!r}"
    )
    assert b"Traceback" not in result.stderr, (
        f"a traceback, not a named refusal (INV-1): {result.stderr[-2000:]!r}"
    )
    survivors = sorted(p.relative_to(out).as_posix() for p in out.rglob("*")) if out.exists() else []
    assert survivors == [], f"a refused import left {len(survivors)} paths behind: {survivors[:12]}"
    assert not (out / "manifest.json").exists(), "a refused import must not write a manifest"
    assert list(Path(out).rglob("zarr.json")) == [], "a refused import must leave no store"
    assert member_path in result.stderr, (
        f"the refusal must NAME the offending member {member_path!r}: {result.stderr[-2000:]!r}"
    )
    assert _REFUSAL_PREFIX in result.stderr, (
        f"the refusal must carry main()'s prefix: {result.stderr[-2000:]!r}"
    )
    assert marker in result.stderr, (
        f"the refusal must say the real thing ({marker!r}): {result.stderr[-2000:]!r}"
    )


# ── B1 .. B11: the eleven measured pre-fix rows ───────────────────────────────────────


def test_TEST_66_a_deleted_shape_is_refused(tmp_path):
    r"""TEST-66 [acceptance INV-1] — B1: `/matrix/shape` DELETED entirely.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        KeyError: "Unable to synchronously open object (object 'shape' doesn't exist)"

    A raw traceback out of h5py — INV-1's prohibited outcome. Post-fix the refusal names
    the member: `filtered_feature_bc_matrix.h5 has no `/matrix/shape`. A 10x
    feature-barcode matrix declares its dimensions as a two-element integer dataset under
    `/matrix`; a matrix without one cannot be imported. ...`
    """
    bundle = _copy(tmp_path, "b1-shape-deleted")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/shape"]
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/shape`", marker=b"has no `/matrix/shape`")


def test_TEST_67_a_one_element_shape_is_refused(tmp_path):
    r"""TEST-67 [acceptance INV-1] — B2: `/matrix/shape` = `[5]` (1 element).

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        IndexError: ... (the 2-tuple unpack `n_features, n_barcodes = shape[0], shape[1]`)

    A raw traceback — INV-1's prohibited outcome. Post-fix the refusal names the member and
    states the 10x fact: `.../matrix/shape has 1 element(s); a 10x feature-barcode matrix
    declares exactly two dimensions, `[n_features, n_barcodes]`. ...`
    """
    bundle = _copy(tmp_path, "b2-shape-one-element")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["shape"]
        m.create_dataset("shape", data=np.array([5], dtype=np.int32))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/shape`", marker=b"declares exactly two dimensions")


def test_TEST_68_a_byte_string_shape_is_refused(tmp_path):
    r"""TEST-68 [acceptance INV-1] — B3: `/matrix/shape` = `[b"XX", b"YY"]`.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        ValueError: invalid literal for int() with base 10: b'XX'

    A raw traceback — INV-1's prohibited outcome. Post-fix the refusal names the member:
    `.../matrix/shape is not stored as an integer (type name '|S2'). A 10x feature-barcode
    matrix declares its dimensions as integers; ...`
    """
    bundle = _copy(tmp_path, "b3-shape-byte-strings")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["shape"]
        m.create_dataset("shape", data=np.array([b"XX", b"YY"]))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/shape`", marker=b"is not stored as an integer")


def test_TEST_69_a_2d_shape_is_refused(tmp_path):
    r"""TEST-69 [acceptance INV-1] — B4: `/matrix/shape` = `[[150, 120], [1, 1]]` (2-D).

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        TypeError: int() argument must be a string, a bytes-like object or a real number,
        not 'list'

    A raw traceback — INV-1's prohibited outcome. Post-fix the refusal names the member:
    `.../matrix/shape is 2-dimensional (shape '(2, 2)'). A 10x feature-barcode matrix
    declares its dimensions as a two-element integer dataset under `/matrix`; ...`
    """
    bundle = _copy(tmp_path, "b4-shape-2d")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["shape"]
        m.create_dataset("shape", data=np.array([[150, 120], [1, 1]], dtype=np.int32))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/shape`", marker=b"is 2-dimensional")


def test_TEST_70_a_deleted_features_group_is_refused(tmp_path):
    r"""TEST-70 [acceptance INV-1] — B5: `/matrix/features` DELETED entirely.

    `group["features"]` is subscripted AT THE CALL SITES (`decoded_h5_strings(
    group["features"], "id", ...)`), i.e. OUTSIDE `decoded_h5_strings`' own try/except.
    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        KeyError: "Unable to synchronously open object (object 'features' doesn't exist)"

    A raw traceback — INV-1's prohibited outcome. Post-fix the refusal names the member:
    `filtered_feature_bc_matrix.h5 has no `/matrix/features`. A 10x feature-barcode matrix
    carries its feature `id` and `name` datasets under a `/matrix/features` group; ...`
    """
    bundle = _copy(tmp_path, "b5-features-deleted")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/features"]
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/features`", marker=b"has no `/matrix/features`")


def test_TEST_71_a_dataset_where_the_matrix_group_belongs_is_refused(tmp_path):
    r"""TEST-71 [acceptance INV-1] — B6: `/matrix` group replaced by a DATASET `[1, 2, 3]`.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        ValueError: ... (h5py dataset.py — field-name selection on a non-compound dataset)

    A raw traceback out of h5py — INV-1's prohibited outcome. Post-fix the refusal names
    the member: `.../matrix is not a group ('Dataset'). A 10x feature-barcode matrix stores
    its counts under a `/matrix` group; anything else is not a matrix this importer can
    read. ...`
    """
    bundle = _copy(tmp_path, "b6-matrix-is-a-dataset")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix"]
        handle.create_dataset("matrix", data=np.array([1, 2, 3]))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix`", marker=b"is not a group")


def test_TEST_72_a_non_hdf5_matrix_file_is_refused(tmp_path):
    r"""TEST-72 [acceptance INV-1] — B9: the matrix file is not HDF5 at all.

    The `.h5` is replaced by a plain text file. MEASURED pre-fix through the shipped
    entrypoint:

        rc=1  paths=0
        OSError: Unable to synchronously open file (file signature not found)

    A raw traceback out of h5py — INV-1's prohibited outcome. Post-fix the refusal names
    the file: `filtered_feature_bc_matrix.h5 could not be opened as an HDF5 file (message
    ...). A 10x feature-barcode matrix is an HDF5 file; a file that cannot be opened as one
    is not a matrix this importer can carry. ...`
    """
    bundle = _copy(tmp_path, "b9-not-hdf5")
    (bundle / MATRIX).write_bytes(b"this is not an HDF5 file at all")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    # The member-path leg must pin the OPEN FAILURE specifically, not the bare filename:
    # `MATRIX_BASENAME` prefixes EVERY refusal this module emits, so the filename alone
    # would pass on any refusal. The full phrase — filename + "could not be opened as an
    # HDF5 file" — appears only in this refusal, the same way the other tests' backticked
    # member paths appear only in theirs.
    _assert_refused(
        result, out,
        b"filtered_feature_bc_matrix.h5 could not be opened as an HDF5 file",
        marker=b"could not be opened as an HDF5 file",
    )


def test_TEST_73_a_dangling_softlink_matrix_is_refused(tmp_path):
    r"""TEST-73 [acceptance INV-1] — B10: `/matrix` is a DANGLING SoftLink to
    `/nonexistent_target`.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        KeyError: "Unable to synchronously open object (component not found)"

    A raw traceback at exit 1 — INV-1's prohibited outcome. The crux is that `"matrix" in
    h5` is `H5Lexists`: the LINK exists, its TARGET does not, so the old presence test was
    skipped and the unguarded `h5["matrix"]` raised. The first assertion below pins that
    fact directly, so it outlives the fix. Post-fix the refusal names the member:
    `.../matrix link exists but its target cannot be read (message ...). A 10x
    feature-barcode matrix stores its counts under a `/matrix` group; a link whose target
    does not resolve is not a matrix this importer can carry. ...`
    """
    bundle = _copy(tmp_path, "b10-dangling-softlink")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix"]
        handle["matrix"] = h5py.SoftLink("/nonexistent_target")
    # THE CRUX, asserted directly: `H5Lexists` answers about the LINK, so a dangling
    # SoftLink still answers True to `in` — which is exactly why the old presence test
    # could not see it.
    with h5py.File(bundle / MATRIX, "r") as handle:
        assert "matrix" in handle, (
            "a dangling SoftLink must still answer True to `in` (H5Lexists) — the link "
            "exists, its target does not — or this test is not testing the crux"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix`", marker=b"link exists but its target cannot be read")


def test_TEST_74_a_scalar_shape_is_refused(tmp_path):
    r"""TEST-74 [acceptance INV-1] — B11: `/matrix/shape` is a SCALAR dataset.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        ValueError: Illegal slicing argument for scalar dataspace

    A raw traceback — INV-1's prohibited outcome. Post-fix the refusal names the member:
    `.../matrix/shape is not a one-dimensional dataset ('()'). A 10x feature-barcode matrix
    declares its dimensions as a two-element integer dataset under `/matrix`; ...`
    """
    bundle = _copy(tmp_path, "b11-shape-scalar")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["shape"]
        m.create_dataset("shape", data=np.int32(150))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/shape`", marker=b"is not a one-dimensional dataset")


# ── the negative control ─────────────────────────────────────────────────────────────


def test_TEST_75_the_unmutated_fixture_still_imports(tmp_path):
    r"""TEST-75 [acceptance INV-1/INV-2] — THE NEGATIVE CONTROL, the unmutated fixture.

    Every refusal assertion above would pass on a validator that refuses EVERYTHING. This
    is the test that stops that: the committed, unmutated bundle must still import — rc 0,
    a manifest written — and the store must still be correct: nnz 17677 with
    len(indices) == len(data) == 17677 and indptr[-1] == 17677. Without this leg the whole
    file could be satisfied by a validator that refuses everything.
    """
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(VF.FIXTURE, out)

    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["outputs"], manifest

    data = VF.read_member(out, "expression.zarr", "data")
    indices = VF.read_member(out, "expression.zarr", "indices")
    indptr = VF.read_member(out, "expression.zarr", "indptr")
    assert len(data) == NNZ == 17677, len(data)
    assert len(indices) == len(data) == 17677, (len(indices), len(data))
    assert int(indptr[0]) == 0, int(indptr[0])
    assert int(indptr[-1]) == NNZ == 17677, int(indptr[-1])
    assert int(indices.min()) >= 0 and int(indices.max()) < N_FEATURES, (
        int(indices.min()), int(indices.max())
    )


# ── the zero-dimension boundary (#445's decision, not this item's) ───────────────────


def test_TEST_76_a_zero_dimension_shape_is_not_refused_by_shape_validation(tmp_path):
    r"""TEST-76 [acceptance INV-1] — the ZERO-DIMENSION boundary: `/matrix/shape` = `[150, 0]`.

    Whether a zero-dimension / zero-count matrix is importable AT ALL is issue #445, which
    a separate dispatch decides. This test pins only that THIS item's shape validation does
    NOT refuse zero — a shape of `[150, 0]` is two non-negative integers, so it must pass
    `refuse_malformed_shape`. The import may still fail LATER for a different, named reason
    (here it does: the fixture carries 120 barcodes, so the shape-vs-counts refusal fires),
    or it may succeed — this test asserts only that the refusal message, if any, is NOT the
    shape-validation message. An over-broad refusal that rejects zero would pre-empt #445
    and would also break the negative control's sibling (a `[0, 120]` shape).
    """
    bundle = _copy(tmp_path, "zero-dim-shape")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["shape"]
        m.create_dataset("shape", data=np.array([150, 0], dtype=np.int32))
    # THE MUTATION MUST HAVE TAKEN EFFECT. This test asserts only `returncode in (0, 2)`
    # plus two NEGATIVE message assertions, so a silently-failed mutation — `shape` left at
    # `[150, 120]` — would import at rc 0 with no shape-validation message and the test
    # would pass WITHOUT having tested anything. Re-open the file and read `/matrix/shape`
    # back, deriving the feature count from the fixture's real shape (`N_FEATURES`), so a
    # no-effect mutation fails here rather than passing vacuously.
    with h5py.File(bundle / MATRIX, "r") as handle:
        shape_back = handle["matrix/shape"][:]
        assert list(shape_back) == [N_FEATURES, 0], (
            f"the zero-dimension mutation did not take effect: `/matrix/shape` reads back "
            f"as {list(shape_back)!r}, expected [{N_FEATURES}, 0]"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    assert result.returncode in (0, 2), (
        f"a zero-dimension shape must either import (rc 0) or fail later for a different, "
        f"named reason (rc 2); got rc={result.returncode}: {result.stderr[-2000:]!r}"
    )
    assert b"declares non-negative dimensions" not in result.stderr, (
        "the shape validation must NOT refuse a zero dimension — the zero case is #445's "
        f"decision, not this item's: {result.stderr[-2000:]!r}"
    )
    assert b"declares exactly two dimensions" not in result.stderr, (
        "the shape validation must NOT refuse a zero dimension — the zero case is #445's "
        f"decision, not this item's: {result.stderr[-2000:]!r}"
    )


# ── the features members' three states (#451, one level deeper) ───────────────────────


def test_TEST_81_a_dangling_softlink_features_id_is_refused(tmp_path):
    r"""TEST-81 [acceptance INV-1] — B12: `/matrix/features/id` is a DANGLING SoftLink to
    `/nonexistent_target`.

    `"id" in features` is `H5Lexists`: the LINK exists, its target does not, so the old
    presence-only check passed and the link was caught one level down inside
    `decoded_h5_strings`, which reported "has no `/matrix/features/id`" — a FALSE reason
    (the link exists, its target does not), the same defect class #451's first item removes
    one level up. Post-fix the refusal names the member and says the real thing:
    `.../matrix/features/id link exists but its target cannot be read (message ...). ...`
    """
    bundle = _copy(tmp_path, "b12-features-id-dangling-softlink")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        f = handle["matrix/features"]
        del f["id"]
        f["id"] = h5py.SoftLink("/nonexistent_target")
    # THE CRUX, asserted directly, the way TEST-73 does for `/matrix`: `H5Lexists` answers
    # about the LINK, so a dangling SoftLink still answers True to `in` — which is exactly
    # why the old presence-only check could not see it.
    with h5py.File(bundle / MATRIX, "r") as handle:
        assert "id" in handle["matrix/features"], (
            "a dangling SoftLink must still answer True to `in` (H5Lexists) — the link "
            "exists, its target does not — or this test is not testing the crux"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/features/id'",
        marker=b"link exists but its target cannot be read",
    )
    assert b"has no `/matrix/features/id`" not in result.stderr, (
        "the refusal must not claim the member is ABSENT when its link exists but its "
        f"target cannot be read: {result.stderr[-2000:]!r}"
    )


def test_TEST_82_a_group_where_features_name_belongs_is_refused(tmp_path):
    r"""TEST-82 [acceptance INV-1] — B13: `/matrix/features/name` is a GROUP, not a dataset.

    The old presence-only check passed a wrong-kind member through to `decoded_h5_strings`,
    which reported it one level down with a message about the read rather than about the
    kind. Post-fix the refusal names the member and the kind:
    `.../matrix/features/name is not a dataset ('Group'). ...`
    """
    bundle = _copy(tmp_path, "b13-features-name-is-a-group")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        f = handle["matrix/features"]
        del f["name"]
        f.create_group("name")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/features/name`", marker=b"is not a dataset")


# ── the shape element count, refused from METADATA before any read ────────────────────


def test_TEST_83_a_huge_declared_shape_is_refused_from_metadata(tmp_path):
    r"""TEST-83 [acceptance INV-1] — a `/matrix/shape` with a huge DECLARED length is
    refused from the dataset's own metadata, before any read.

    The dataset is created UNFILLED (chunked, no data written) with a declared length of
    10**7 int64 values — 80 MB if materialised. The element-count refusal must fire from
    `ds.shape[0]` alone, without that read. THIS IS THE PROPERTY PINNED: the metadata-first
    element-count check in `refuse_malformed_shape`. If the check were reverted to
    read-then-count, this test would materialise 80 MB before the same refusal fired — the
    exact unbounded read the finding is about. The refusal is by name, at rc 2, with zero
    paths: `.../matrix/shape has 10000000 element(s); a 10x feature-barcode matrix declares
    exactly two dimensions, ...`
    """
    bundle = _copy(tmp_path, "b14-shape-huge-declared")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["shape"]
        m.create_dataset("shape", shape=(10**7,), dtype=np.int64, chunks=(10**7,))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/shape`", marker=b"declares exactly two dimensions")


# ── FIX ROUND 3b: three more members of the same set (independent adversarial review) ──


def test_TEST_84_a_truncated_features_name_is_refused(tmp_path):
    r"""TEST-84 [acceptance INV-1/INV-2] — Finding A: `/matrix/features/name` truncated
    to 3 entries while `/matrix/features/id` and `/matrix/barcodes` keep their correct
    lengths.

    `gene_names` was the one string dataset the pre-writer cross-check did NOT measure
    against the declared shape. MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=39
        ValueError: this table declares 3 rows while its membership(s) name 150 — ...
          File ".../_lib/cyto_zarr.py", line 1080, in _membership_entries

    A raw traceback out of `_lib` — INV-1's prohibited outcome — and it fired AFTER
    `write_csc_zarr` and the axis stores, so 39 paths were already on disk (INV-2
    broken). Post-fix the refusal names the dataset and both numbers:
    `... declares shape [150, 120] but `/matrix/features/name` carries 3 entries while
    the matrix declares 150 features.`
    """
    bundle = _copy(tmp_path, "f3b-name-truncated")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        f = handle["matrix/features"]
        del f["name"]
        f.create_dataset("name", data=np.array([b"g0", b"g1", b"g2"], dtype="S16"))
    # THE MUTATION MUST HAVE TAKEN EFFECT: only `name` is shortened; `id` and
    # `barcodes` keep their correct lengths, so the refusal can only be about `name`.
    with h5py.File(bundle / MATRIX, "r") as handle:
        name_back = handle["matrix/features/name"][:]
        id_back = handle["matrix/features/id"][:]
        bc_back = handle["matrix/barcodes"][:]
        assert len(name_back) == 3, len(name_back)
        assert len(id_back) == N_FEATURES, len(id_back)
        assert len(bc_back) == N_BARCODES, len(bc_back)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"`/matrix/features/name`",
        marker=b"carries 3 entries while the matrix declares 150 features",
    )


def test_TEST_85_a_truncated_barcodes_is_refused(tmp_path):
    r"""TEST-85 [acceptance INV-1/INV-2] — Finding A mirror: `/matrix/barcodes`
    truncated to 3 entries while both feature datasets keep their correct length.

    The pre-writer cross-check already measured `barcodes` against `n_barcodes`; this
    pins that arm so all three string datasets are covered. Post-fix the refusal names
    the dataset and both numbers: `... declares shape [150, 120] but `/matrix/barcodes`
    carries 3 entries while the matrix declares 120 barcodes.`
    """
    bundle = _copy(tmp_path, "f3b-barcodes-truncated")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/barcodes"]
        handle.create_dataset(
            "matrix/barcodes", data=np.array([b"bc0", b"bc1", b"bc2"], dtype="S18"),
        )
    # THE MUTATION MUST HAVE TAKEN EFFECT: only `barcodes` is shortened; both feature
    # datasets keep their correct length, so the refusal can only be about `barcodes`.
    with h5py.File(bundle / MATRIX, "r") as handle:
        bc_back = handle["matrix/barcodes"][:]
        id_back = handle["matrix/features/id"][:]
        name_back = handle["matrix/features/name"][:]
        assert len(bc_back) == 3, len(bc_back)
        assert len(id_back) == N_FEATURES, len(id_back)
        assert len(name_back) == N_FEATURES, len(name_back)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"`/matrix/barcodes`",
        marker=b"carries 3 entries while the matrix declares 120 barcodes",
    )


def test_TEST_86_an_undecodable_barcodes_dataset_is_refused(tmp_path):
    r"""TEST-86 [acceptance INV-1/INV-2] — Finding B: `/matrix/barcodes` whose BYTES
    cannot be read.

    `decoded_h5_strings` guarded its `group[name][:]` read with `except KeyError` and
    `except (ValueError, TypeError)` but NOT `OSError` — the exception a dataset whose
    METADATA is fine but whose BYTES are undecodable raises (an unavailable filter, a
    truncated chunk, a fletcher32 checksum failure). MEASURED pre-fix through the
    shipped entrypoint with `/matrix/barcodes` recreated as a chunked fletcher32
    dataset whose chunk byte was then flipped:

        rc=1  paths=0
        OSError: Can't synchronously read data (filter returned failure during read)

    A raw traceback at exit 1 — INV-1's prohibited outcome. Post-fix the refusal says
    the bytes could not be read and does NOT claim the dataset is absent:
    `.../matrix/barcodes is present but its bytes cannot be read (message ...). ...`

    THIS IS THE PROPERTY PINNED: the `except OSError` arm of `decoded_h5_strings`. The
    chunk is corrupted with `ds.id.get_chunk_info(0)` so the flip lands on the exact
    chunk bytes, not on metadata or unused space. What it does NOT pin: a truncated
    chunk inside an otherwise-openable file (the file-level truncation the open guard
    catches first) — that shape is not constructible without also breaking the open.
    """
    bundle = _copy(tmp_path, "f3b-barcodes-undecodable")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/barcodes"]
        handle.create_dataset(
            "matrix/barcodes",
            data=np.array([b"bc%03d" % i for i in range(N_BARCODES)], dtype="S18"),
            chunks=(N_BARCODES,), fletcher32=True,
        )
    with h5py.File(bundle / MATRIX, "r") as handle:
        ds = handle["matrix/barcodes"]
        chunk = ds.id.get_chunk_info(0)
        assert chunk.size > 0, chunk
    # Corrupt the exact chunk bytes so the fletcher32 checksum fails on read.
    with open(bundle / MATRIX, "r+b") as fh:
        fh.seek(chunk.byte_offset)
        fh.write(b"\xff")
    # THE MUTATION MUST HAVE TAKEN EFFECT: reading the dataset now raises OSError.
    with h5py.File(bundle / MATRIX, "r") as handle:
        try:
            handle["matrix/barcodes"][:]
        except OSError:
            pass
        else:
            raise AssertionError("the corrupted chunk must raise OSError on read")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"`/matrix/barcodes`",
        marker=b"is present but its bytes cannot be read",
    )
    assert b"has no `/matrix/barcodes`" not in result.stderr, (
        "the refusal must not claim the dataset is ABSENT when its bytes cannot be "
        f"read: {result.stderr[-2000:]!r}"
    )


def test_TEST_87_a_dangling_softlink_barcodes_is_refused(tmp_path):
    r"""TEST-87 [acceptance INV-1] — Finding C: `/matrix/barcodes` is a DANGLING
    SoftLink to `/nonexistent_target`.

    `"barcodes" in group` is `H5Lexists`: the LINK exists, its target does not, so the
    old presence-only check passed and the link was caught one level down inside
    `decoded_h5_strings`, which reported "has no `/matrix/barcodes`" — a FALSE reason
    (the link exists, its target does not), the same defect class #451's first item
    removes one level up. Post-fix the refusal names the member and says the real
    thing: `.../matrix/barcodes link exists but its target cannot be read (message
    ...). ...`
    """
    bundle = _copy(tmp_path, "f3b-barcodes-dangling-softlink")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/barcodes"]
        handle["matrix/barcodes"] = h5py.SoftLink("/nonexistent_target")
    # THE CRUX, asserted directly, the way TEST-73 and TEST-81 do: `H5Lexists` answers
    # about the LINK, so a dangling SoftLink still answers True to `in` — which is
    # exactly why the old presence-only check could not see it.
    with h5py.File(bundle / MATRIX, "r") as handle:
        assert "barcodes" in handle["matrix"], (
            "a dangling SoftLink must still answer True to `in` (H5Lexists) — the link "
            "exists, its target does not — or this test is not testing the crux"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/barcodes'",
        marker=b"link exists but its target cannot be read",
    )
    assert b"has no `/matrix/barcodes`" not in result.stderr, (
        "the refusal must not claim the member is ABSENT when its link exists but its "
        f"target cannot be read: {result.stderr[-2000:]!r}"
    )


def test_TEST_88_a_virtual_barcodes_is_refused(tmp_path):
    r"""TEST-88 [acceptance INV-1/INV-2] — Finding C: `/matrix/barcodes` is a VIRTUAL
    dataset whose source file does not exist.

    A virtual `/matrix/barcodes` was refused NOWHERE and silently yielded fill-value
    bytes, letting the import proceed deep into the writer with garbage barcodes.
    MEASURED pre-fix through the shipped entrypoint: rc 2 for an UNRELATED positions
    reason, 51 paths already on disk. Post-fix the refusal names the member and the
    storage kind: `.../matrix/barcodes is a VIRTUAL dataset. A 10x feature-barcode
    matrix stores its barcodes INLINE; ...`
    """
    bundle = _copy(tmp_path, "f3b-barcodes-virtual")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/barcodes"]
        layout = h5py.VirtualLayout(shape=(N_BARCODES,), dtype="S18")
        vs = h5py.VirtualSource("/nonexistent_source.h5", "barcodes",
                                shape=(N_BARCODES,), dtype="S18")
        layout[...] = vs
        handle.create_virtual_dataset("matrix/barcodes", layout, fillvalue=b"")
    # THE MUTATION MUST HAVE TAKEN EFFECT: the member is a VIRTUAL dataset.
    with h5py.File(bundle / MATRIX, "r") as handle:
        ds = handle["matrix/barcodes"]
        assert bool(getattr(ds, "is_virtual", False)), (
            "the member must be a VIRTUAL dataset"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/barcodes'",
        marker=b"is a VIRTUAL dataset",
    )


def test_TEST_89_a_virtual_shape_is_refused(tmp_path):
    r"""TEST-89 [acceptance INV-1/INV-2] — Finding D: `/matrix/shape` is a VIRTUAL
    dataset whose source file does not exist.

    `refuse_malformed_shape`'s VIRTUAL / EXTERNAL-raw-storage arm was not pinned by any
    committed test — every virtual/external test in this package is #349's, against
    `/matrix/indices`. This pins it: the refusal names the member and the storage kind,
    `.../matrix/shape is a VIRTUAL dataset. A 10x feature-barcode matrix declares its
    dimensions INLINE; ...`, at rc 2 with zero paths and no traceback.
    """
    bundle = _copy(tmp_path, "f3b-shape-virtual")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["shape"]
        layout = h5py.VirtualLayout(shape=(2,), dtype=np.int32)
        vs = h5py.VirtualSource("/nonexistent_source.h5", "shape",
                                shape=(2,), dtype=np.int32)
        layout[...] = vs
        m.create_virtual_dataset("shape", layout, fillvalue=0)
    # THE MUTATION MUST HAVE TAKEN EFFECT: the member is a VIRTUAL dataset.
    with h5py.File(bundle / MATRIX, "r") as handle:
        ds = handle["matrix/shape"]
        assert bool(getattr(ds, "is_virtual", False)), (
            "the member must be a VIRTUAL dataset"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/shape'",
        marker=b"is a VIRTUAL dataset",
    )


# ── FIX ROUND 4b: the features members' VIRTUAL/EXTERNAL arms, disclosed and pinned ────


def test_TEST_90_a_virtual_features_id_is_refused(tmp_path):
    r"""TEST-90 [acceptance INV-1/INV-2] — `/matrix/features/id` is a VIRTUAL dataset
    whose source file does not exist.

    `refuse_malformed_features`'s VIRTUAL / EXTERNAL-raw-storage arm was not pinned by
    any committed test for the features members — TEST-88 and TEST-89 pin it for
    `/matrix/barcodes` and `/matrix/shape`. This pins the `id` half of the
    `is_virtual or external` condition: the refusal names the member and the storage
    kind, `.../matrix/features/id is a VIRTUAL dataset. A 10x feature-barcode matrix
    stores its feature `id` and `name` datasets INLINE; ...`, at rc 2 with zero paths
    and no traceback.
    """
    bundle = _copy(tmp_path, "f4b-features-id-virtual")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        f = handle["matrix/features"]
        del f["id"]
        layout = h5py.VirtualLayout(shape=(N_FEATURES,), dtype="S18")
        vs = h5py.VirtualSource("/nonexistent_source.h5", "id",
                                shape=(N_FEATURES,), dtype="S18")
        layout[...] = vs
        f.create_virtual_dataset("id", layout, fillvalue=b"")
    # THE MUTATION MUST HAVE TAKEN EFFECT: the member is a VIRTUAL dataset.
    with h5py.File(bundle / MATRIX, "r") as handle:
        ds = handle["matrix/features/id"]
        assert bool(getattr(ds, "is_virtual", False)), (
            "the member must be a VIRTUAL dataset"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/features/id'",
        marker=b"'/matrix/features/id' is a VIRTUAL dataset",
    )


def test_TEST_91_a_features_name_with_external_raw_storage_is_refused(tmp_path):
    r"""TEST-91 [acceptance INV-1/INV-2] — `/matrix/features/name` is a dataset with
    HDF5 EXTERNAL RAW STORAGE (`create_dataset(..., external=[("missing.bin", 0, ...)])`).

    `ds.is_virtual` is **False** for external storage — so the VIRTUAL-dataset check
    alone does not see it; only the `.external` check does. This pins the `name` half of
    `refuse_malformed_features`'s VIRTUAL / EXTERNAL-raw-storage arm: the refusal names
    the member and the storage kind, `.../matrix/features/name is a dataset with EXTERNAL
    raw storage. A 10x feature-barcode matrix stores its feature `id` and `name` datasets
    INLINE; ...`, at rc 2 with zero paths and no traceback.
    """
    bundle = _copy(tmp_path, "f4b-features-name-external")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        f = handle["matrix/features"]
        del f["name"]
        # 2400 = N_FEATURES * 16 bytes of S16 — the external file's declared extent.
        f.create_dataset(
            "name", shape=(N_FEATURES,), dtype="S16",
            external=[("missing.bin", 0, N_FEATURES * 16)],
        )
    # THE MUTATION MUST HAVE TAKEN EFFECT: the member has EXTERNAL raw storage.
    with h5py.File(bundle / MATRIX, "r") as handle:
        ds = handle["matrix/features/name"]
        assert getattr(ds, "external", None), (
            "the member must have EXTERNAL raw storage"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/features/name'",
        marker=b"'/matrix/features/name' is a dataset with EXTERNAL raw storage",
    )


# ── #462: the structural net — every object under `/matrix` must live INLINE ──────────
#
# `run_import` resolves `/matrix` and its members with a BARE subscript. h5py FOLLOWS an
# `h5py.ExternalLink` transparently, so a member that is an ExternalLink resolves to an
# ordinary inline `Dataset` IN ANOTHER FILE: `isinstance(..., h5py.Dataset)` is True,
# `.is_virtual` is False, `.external` is empty — every predicate below passed and the
# counts came from a file OUTSIDE the bundle. The structural walk
# (`refuse_outside_matrix_objects`) refuses any object under `/matrix` whose backing
# file is not the located matrix file, at any depth through any number of hops.
# Every row below was MEASURED pre-fix through the shipped entrypoint; the measured
# outcome is quoted in each test's docstring.


def test_TEST_92_a_data_member_that_is_an_ExternalLink_is_refused(tmp_path):
    r"""TEST-92 [acceptance INV-1/INV-2] — S1: `/matrix/data` replaced by an
    `h5py.ExternalLink` to an EXISTING outside file holding a valid same-length,
    same-dtype array of all 7s.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    `group["data"]` resolved the link transparently to an ordinary inline `Dataset` in
    the outside file, so every predicate passed and the store was built from the
    outside file's all-7s values. Post-fix the structural walk refuses the link BY
    NAME before resolving it: `...'/matrix/data' is an ExternalLink. A 10x
    feature-barcode matrix stores every value INLINE in its own file; a link to
    another file cannot be imported ...`.
    """
    bundle = _copy(tmp_path, "s1-data-external-link")
    outside = tmp_path / "outside_s1.h5"
    with h5py.File(outside, "w") as handle:
        handle.create_dataset("data", data=np.full(NNZ, 7, dtype=np.int32))
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/data"]
        handle["matrix/data"] = h5py.ExternalLink(str(outside), "/data")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/data'",
        marker=b"is an ExternalLink",
    )


def test_TEST_93_a_matrix_group_that_is_an_ExternalLink_is_refused(tmp_path):
    r"""TEST-93 [acceptance INV-1/INV-2] — S2: `/matrix` itself replaced by an
    `h5py.ExternalLink` to an EXISTING outside file holding a full valid copy of the
    matrix group.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    `h5["matrix"]` resolved the link transparently to the outside group, so every
    predicate passed and the store was built from the outside file's values. Post-fix
    the direct link-kind check on `/matrix` refuses by name:
    `...`/matrix` is an ExternalLink. ...`.
    """
    bundle = _copy(tmp_path, "s2-matrix-external-link")
    outside = tmp_path / "outside_s2.h5"
    with h5py.File(VF.FIXTURE / MATRIX, "r") as src, h5py.File(outside, "w") as handle:
        src.copy("matrix", handle, "matrix")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix"]
        handle["matrix"] = h5py.ExternalLink(str(outside), "/matrix")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"`/matrix`",
        marker=b"is an ExternalLink",
    )


def test_TEST_94_a_softlink_chain_to_an_ExternalLink_member_is_refused(tmp_path):
    r"""TEST-94 [acceptance INV-1/INV-2] — S3: a CHAIN on a member —
    `/matrix/zzz` = `ExternalLink(outside.h5, "/data")` and
    `/matrix/data` = `SoftLink("/matrix/zzz")`.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    `group.get(member, getlink=True)` inspects only the member's OWN link (a SoftLink,
    not an ExternalLink) while `group[member]` resolves the WHOLE chain — so the
    enumeration walked straight through. Post-fix the structural walk inspects EVERY
    key's link before resolving it and refuses the chain's ExternalLink by name:
    `...'/matrix/zzz' is an ExternalLink. A 10x feature-barcode matrix stores every
    value INLINE in its own file; a link to another file cannot be imported ...`.
    """
    bundle = _copy(tmp_path, "s3-softlink-chain-member")
    outside = tmp_path / "outside_s3.h5"
    with h5py.File(outside, "w") as handle:
        handle.create_dataset("data", data=np.full(NNZ, 7, dtype=np.int32))
    with h5py.File(bundle / MATRIX, "r+") as handle:
        handle["matrix/zzz"] = h5py.ExternalLink(str(outside), "/data")
        del handle["matrix/data"]
        handle["matrix/data"] = h5py.SoftLink("/matrix/zzz")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/zzz'",
        marker=b"is an ExternalLink",
    )


def test_TEST_95_a_softlink_chain_to_an_ExternalLink_group_is_refused(tmp_path):
    r"""TEST-95 [acceptance INV-1/INV-2] — S4: a CHAIN on the group —
    `/matrix2` = `ExternalLink(outside.h5, "/matrix")` and
    `/matrix` = `SoftLink("/matrix2")`.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    `h5.get("matrix", getlink=True)` inspects only `/matrix`'s OWN link (a SoftLink,
    not an ExternalLink) while `h5["matrix"]` resolves the WHOLE chain to the outside
    group. Post-fix the structural walk's top-level realpath comparison refuses by
    name: `...'/matrix' resolves to '<outside file>', not the located matrix file
    ...`.
    """
    bundle = _copy(tmp_path, "s4-softlink-chain-group")
    outside = tmp_path / "outside_s4.h5"
    with h5py.File(VF.FIXTURE / MATRIX, "r") as src, h5py.File(outside, "w") as handle:
        src.copy("matrix", handle, "matrix")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        handle["matrix2"] = h5py.ExternalLink(str(outside), "/matrix")
        del handle["matrix"]
        handle["matrix"] = h5py.SoftLink("/matrix2")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix'",
        marker=b"resolves to",
    )
    # #508 (final round): the compare names the matrix file the path resolves to —
    # "the located matrix file" (post-B3) / "this bundle's own matrix file" (base
    # wording, which the A12 self-revert restores) — so the pin asserts the framing
    # that is TRUE under both, and neither wording is pinned as the only truth.
    assert b"matrix file" in result.stderr, (
        f"the compare must name the matrix file: {result.stderr[-2000:]!r}"
    )


def test_TEST_96_a_barcodes_ExternalLink_to_reversed_barcodes_is_refused(tmp_path):
    r"""TEST-96 [acceptance INV-1/INV-2] — S5: `/matrix/barcodes` replaced by an
    `h5py.ExternalLink` to an outside file holding THE BUNDLE'S OWN barcodes REVERSED.

    THE SILENT-MISLABEL CASE: same length, same dtype, valid UTF-8 — every length
    cross-check passes and the store is mislabeled. MEASURED pre-fix through the
    shipped entrypoint:

        rc=0  paths=119  SILENT MISLABEL

    Post-fix the structural walk refuses the link BY NAME before resolving it:
    `...'/matrix/barcodes' is an ExternalLink. A 10x feature-barcode matrix stores
    every value INLINE in its own file; a link to another file cannot be imported
    ...`.
    """
    bundle = _copy(tmp_path, "s5-barcodes-external-link")
    outside = tmp_path / "outside_s5.h5"
    with h5py.File(VF.FIXTURE / MATRIX, "r") as src, h5py.File(outside, "w") as handle:
        handle.create_dataset("barcodes", data=src["matrix/barcodes"][:][::-1])
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/barcodes"]
        handle["matrix/barcodes"] = h5py.ExternalLink(str(outside), "/barcodes")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/barcodes'",
        marker=b"is an ExternalLink",
    )


def test_TEST_97_a_features_id_ExternalLink_to_reversed_ids_is_refused(tmp_path):
    r"""TEST-97 [acceptance INV-1/INV-2] — S6: `/matrix/features/id` replaced by an
    `h5py.ExternalLink` to an outside file holding the bundle's own ids REVERSED.

    A NESTED member under `/matrix/features`, which the CSC-triple enumeration cannot
    see. MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT MISLABEL

    Post-fix the structural walk refuses the link BY NAME before resolving it:
    `...'/matrix/features/id' is an ExternalLink. A 10x feature-barcode matrix stores
    every value INLINE in its own file; a link to another file cannot be imported
    ...`.
    """
    bundle = _copy(tmp_path, "s6-features-id-external-link")
    outside = tmp_path / "outside_s6.h5"
    with h5py.File(VF.FIXTURE / MATRIX, "r") as src, h5py.File(outside, "w") as handle:
        handle.create_dataset("id", data=src["matrix/features/id"][:][::-1])
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/features/id"]
        handle["matrix/features/id"] = h5py.ExternalLink(str(outside), "/id")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/features/id'",
        marker=b"is an ExternalLink",
    )


def test_TEST_98_a_shape_ExternalLink_to_the_same_dims_is_refused(tmp_path):
    r"""TEST-98 [acceptance INV-1/INV-2] — S7: `/matrix/shape` replaced by an
    `h5py.ExternalLink` to an outside file holding the SAME two dims.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The shape read back identically, so even the shape validation passed. Post-fix the
    structural walk refuses the link BY NAME before resolving it: `...'/matrix/shape'
    is an ExternalLink. A 10x feature-barcode matrix stores every value INLINE in its
    own file; a link to another file cannot be imported ...`.
    """
    bundle = _copy(tmp_path, "s7-shape-external-link")
    outside = tmp_path / "outside_s7.h5"
    with h5py.File(outside, "w") as handle:
        handle.create_dataset("shape", data=np.array([N_FEATURES, N_BARCODES], dtype=np.int32))
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/shape"]
        handle["matrix/shape"] = h5py.ExternalLink(str(outside), "/shape")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/shape'",
        marker=b"is an ExternalLink",
    )


def test_TEST_99_a_51_hop_softlink_chain_is_refused_not_a_traceback(tmp_path):
    r"""TEST-99 [acceptance INV-1/INV-2] — S8: a 51-hop SAME-FILE SoftLink chain ending
    at the real `/matrix/data` (`/matrix/data` -> SoftLink(/matrix/h1) -> ... ->
    SoftLink(real data)).

    HDF5 enforces its own link-traversal limit and raises a raw
    `RuntimeError: Special link traversal failed (too many links)`. MEASURED pre-fix
    through the shipped entrypoint:

        rc=1  paths=0  RAW TRACEBACK

    The walk's guarded child read turns that `RuntimeError` into a named refusal. The
    member named is `/matrix/data` — the first member in FORWARD key order whose
    resolution exceeds the traversal limit: the walk pushes children in REVERSE name
    order so the LIFO stack pops them in forward order, and `/matrix/data` (a 51-hop
    chain) is the first consumed member the walk resolves. MEASURED post-fix:
    `...'/matrix/data' link exists but its target cannot be read ('Special link
    traversal failed (too many links)'). ...`.
    """
    bundle = _copy(tmp_path, "s8-51-hop-chain")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        handle.move("matrix/data", "matrix/real_data")
        for i in range(50, 0, -1):
            target = "/matrix/real_data" if i == 50 else f"/matrix/h{i + 1}"
            handle[f"matrix/h{i}"] = h5py.SoftLink(target)
        handle["matrix/data"] = h5py.SoftLink("/matrix/h1")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/data'",
        marker=b"Special link traversal failed",
    )


def test_TEST_100_a_committed_datatype_under_matrix_still_imports(tmp_path):
    r"""TEST-100 [acceptance INV-1/INV-2] — S9: a committed DATATYPE under `/matrix`
    (`handle["matrix/a_committed_type"] = np.dtype("i4")`).

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    (The branch's first version refused it — `...'/matrix/a_committed_type' is neither
    a dataset nor a group ('Datatype'). ...` — on input that IMPORTED BEFORE.) A
    committed datatype holds no values and cannot reference another file's data, and
    `h5repack` and shared string-type dedup produce them, so the walk SKIPS it and the
    bundle still imports at rc 0 with a manifest written.
    """
    bundle = _copy(tmp_path, "s9-committed-datatype")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        handle["matrix/a_committed_type"] = np.dtype("i4")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a committed datatype must still import"


def test_TEST_101_3000_nested_groups_are_refused_by_depth_not_recursion(tmp_path):
    r"""TEST-101 [acceptance INV-1/INV-2] — S10: 3000 nested empty groups under
    `/matrix`.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    (A RECURSIVE walk died on this shape with a raw `RecursionError`; the shipped walk
    is ITERATIVE, so the depth cap is what fires.) Post-fix the walk refuses by name:
    `... is deeper than 64 levels under `/matrix`. ...` — the path is windowed by
    `_quoted_for_refusal`, so the assertion pins the leaf and the depth sentence.
    """
    bundle = _copy(tmp_path, "s10-3000-nested-groups")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        g = handle["matrix"]
        for i in range(3000):
            g = g.create_group(f"g{i}")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"/g64",
        marker=b"deeper than 64 levels under `/matrix`",
    )


# ── the positive controls: the walk must not refuse what it was built to allow ────────


def test_TEST_102_the_depth_boundary_64_levels_import_and_65_refuse(tmp_path):
    r"""TEST-102 [acceptance INV-1/INV-2] — P4: the exact depth boundary, both sides.

    `MAX_MATRIX_DEPTH = 64`, counting `/matrix` as depth 0: a bundle with 64 levels of
    nested groups under `/matrix` still IMPORTS (rc 0, a manifest written), and 65
    refuses (rc 2, no traceback, zero paths). The boundary is pinned on BOTH sides so
    a cap that drifts either way turns this test red.
    """
    bundle = _copy(tmp_path, "p4-64-levels")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        g = handle["matrix"]
        for i in range(64):
            g = g.create_group(f"g{i}")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a 64-level bundle must still import"

    bundle65 = _copy(tmp_path, "p4-65-levels")
    with h5py.File(bundle65 / MATRIX, "r+") as handle:
        g = handle["matrix"]
        for i in range(65):
            g = g.create_group(f"g{i}")
    out65 = tmp_path / "out" / "outputs65"
    result65 = VF.run_entry_bytes(bundle65, out65)
    _assert_refused(
        result65, out65, b"/g64",
        marker=b"deeper than 64 levels under `/matrix`",
    )


def test_TEST_103_an_ordinary_extra_inline_group_still_imports(tmp_path):
    r"""TEST-103 [acceptance INV-1/INV-2] — P5: an ORDINARY extra inline group/dataset
    under `/matrix` (an attrs-carrying subgroup and an extra inline dataset) still
    imports — the walk must not refuse benign structure.

    The walk refuses objects that resolve OUTSIDE the bundle, VIRTUAL or EXTERNAL
    datasets, and non-group/non-dataset objects. An inline subgroup and an inline
    dataset are none of those, so they must pass and the import must succeed at rc 0.
    """
    bundle = _copy(tmp_path, "p5-benign-extra")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        g = handle["matrix"].create_group("extra_group")
        g.attrs["note"] = "benign"
        g.create_dataset("extra_ds", data=np.array([1, 2, 3]))
        handle["matrix/extra_dataset"] = np.array([4, 5, 6])
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a benign extra group must still import"


def test_TEST_104_the_committed_visium_fixture_still_imports(tmp_path):
    r"""TEST-104 [acceptance INV-1/INV-2] — P1: the committed `visium-outs` fixture
    still imports at rc 0 and writes a manifest.

    TEST-75 already verifies the store's contents; this pins the walk's
    non-interference on the primary fixture through the same entrypoint.
    """
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(VF.FIXTURE, out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"


def test_TEST_105_the_committed_cytassist_v4_fixture_still_imports(tmp_path):
    r"""TEST-105 [acceptance INV-1/INV-2] — P2: the committed `cytassist-v4-outs`
    fixture still imports at rc 0.
    """
    bundle = Path(tmp_path) / "p2-cytassist-v4"
    shutil.copytree(VF.CYTASSIST_V4, bundle)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"


def test_TEST_106_the_committed_cytassist_v5_11mm_fixture_still_imports(tmp_path):
    r"""TEST-106 [acceptance INV-1/INV-2] — P3: the committed `cytassist-v5-11mm-outs`
    fixture still imports at rc 0.
    """
    bundle = Path(tmp_path) / "p3-cytassist-v5-11mm"
    shutil.copytree(VF.CYTASSIST_V5_11MM, bundle)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"


# ── M1 .. M6: the four measured silent-corruption holes and their two chain variants ──


def test_TEST_107_a_features_id_ExternalLink_back_into_its_own_file_is_refused(tmp_path):
    r"""TEST-107 [acceptance INV-1/INV-2] — M1: `/matrix/features/id` replaced by an
    `h5py.ExternalLink` pointing BACK at the bundle's OWN file
    (`ExternalLink("filtered_feature_bc_matrix.h5", "/matrix/features/name")`).

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The link resolved transparently to the bundle's own `features/name` dataset, so
    the realpath check passed (same file) and `axis/gene_id.zarr` was built from
    feature NAMES (`Cox5b`, `Rpl37a`, ...) instead of ids. Post-fix the structural
    walk refuses the link BY NAME before resolving it — an ExternalLink is refused
    wherever it points, even back into this same file: `...'/matrix/features/id' is
    an ExternalLink. ...`.
    """
    bundle = _copy(tmp_path, "m1-features-id-self-external-link")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/features/id"]
        handle["matrix/features/id"] = h5py.ExternalLink(MATRIX, "/matrix/features/name")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/features/id'",
        marker=b"is an ExternalLink",
    )


def test_TEST_108_a_features_id_hard_link_to_features_name_is_refused(tmp_path):
    r"""TEST-108 [acceptance INV-1/INV-2] — M2: `/matrix/features/id` replaced by a
    HARD LINK to `/matrix/features/name` (`handle["matrix/features/id"] =
    handle["matrix/features/name"]`).

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The hard link resolves to the bundle's own `features/name` dataset, so the
    realpath check passed (same file) and `axis/gene_id.zarr` was built from feature
    NAMES instead of ids — identical corruption to M1. Post-fix the alias check
    resolves the seven consumed members and requires seven DISTINCT objects:
    `...'/matrix/features/id' and '/matrix/features/name' are the SAME object. ...`.
    """
    bundle = _copy(tmp_path, "m2-features-id-hard-link")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/features/id"]
        handle["matrix/features/id"] = handle["matrix/features/name"]
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/features/id'",
        marker=b"are the SAME object",
    )


def test_TEST_109_a_barcodes_ExternalLink_back_into_its_own_file_is_refused(tmp_path):
    r"""TEST-109 [acceptance INV-1/INV-2] — M3: `/matrix/barcodes` replaced by an
    `h5py.ExternalLink` pointing BACK at the bundle's OWN file, at a `barcodes_rev`
    dataset holding the bundle's own barcodes REVERSED.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The link resolved transparently to the bundle's own reversed barcodes, so the
    realpath check passed (same file) and `axis/barcode.zarr` was exactly the reverse
    of baseline. Post-fix the structural walk refuses the link BY NAME before
    resolving it — an ExternalLink is refused wherever it points, even back into this
    same file: `...'/matrix/barcodes' is an ExternalLink. ...`.
    """
    bundle = _copy(tmp_path, "m3-barcodes-self-external-link")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        handle["matrix/barcodes_rev"] = handle["matrix/barcodes"][:][::-1]
        del handle["matrix/barcodes"]
        handle["matrix/barcodes"] = h5py.ExternalLink(MATRIX, "/matrix/barcodes_rev")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/barcodes'",
        marker=b"is an ExternalLink",
    )


def test_TEST_110_a_data_hard_link_to_indices_is_refused(tmp_path):
    r"""TEST-110 [acceptance INV-1/INV-2] — M4: `/matrix/data` replaced by a HARD LINK
    to `/matrix/indices` (`handle["matrix/data"] = handle["matrix/indices"]`).

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The hard link resolves to the bundle's own `indices` dataset, so the realpath
    check passed (same file) and `expression.zarr/data` held the feature-id values,
    not counts. Post-fix the alias check resolves the seven consumed members and
    requires seven DISTINCT objects: `...'/matrix/data' and '/matrix/indices' are the
    SAME object. ...`.
    """
    bundle = _copy(tmp_path, "m4-data-hard-link")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/data"]
        handle["matrix/data"] = handle["matrix/indices"]
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/data'",
        marker=b"are the SAME object",
    )


def test_TEST_111_a_softlink_data_to_a_self_ExternalLink_is_refused(tmp_path):
    r"""TEST-111 [acceptance INV-1/INV-2] — M5: `/matrix/data` replaced by
    `SoftLink("/matrix/zz")` where `/matrix/zz` is an `h5py.ExternalLink` pointing
    BACK at the bundle's OWN file (`ExternalLink("filtered_feature_bc_matrix.h5",
    "/matrix/indices")`).

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    `data`'s OWN link is a SoftLink, so the branch's counts-member `getlink=True`
    check (which inspected only `data`'s own link) walked straight through, and the
    chain resolved to the bundle's own `indices` dataset — `expression.zarr/data`
    held the feature-id values, not counts. Post-fix the structural walk inspects
    EVERY key's link before resolving it and refuses the chain's ExternalLink by
    name: `...'/matrix/zz' is an ExternalLink. ...`.
    """
    bundle = _copy(tmp_path, "m5-softlink-data-to-self-external-link")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        handle["matrix/zz"] = h5py.ExternalLink(MATRIX, "/matrix/indices")
        del handle["matrix/data"]
        handle["matrix/data"] = h5py.SoftLink("/matrix/zz")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/zz'",
        marker=b"is an ExternalLink",
    )


def test_TEST_112_a_15_hop_same_file_softlink_chain_data_to_indices_is_refused(tmp_path):
    r"""TEST-112 [acceptance INV-1/INV-2] — M6: `/matrix/data` replaced by a 15-hop
    SAME-FILE SoftLink chain ending at `/matrix/indices` (`/matrix/data` ->
    SoftLink(/matrix/z1) -> ... -> SoftLink(/matrix/indices)).

    The chain is UNDER HDF5's 16-link traversal limit, so it resolves cleanly.
    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The chain resolved to the bundle's own `indices` dataset, so the realpath check
    passed (same file) and `expression.zarr/data` held the feature-id values, not
    counts. Post-fix the alias check resolves the seven consumed members and requires
    seven DISTINCT objects: `...'/matrix/data' and '/matrix/indices' are the SAME
    object. ...`.
    """
    bundle = _copy(tmp_path, "m6-15-hop-chain")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/data"]
        for i in range(1, 16):
            target = "/matrix/indices" if i == 15 else f"/matrix/z{i + 1}"
            handle[f"matrix/z{i}"] = h5py.SoftLink(target)
        handle["matrix/data"] = h5py.SoftLink("/matrix/z1")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(
        result, out, b"'/matrix/data'",
        marker=b"are the SAME object",
    )


def test_TEST_113_a_cyclic_softlink_back_to_an_ancestor_still_imports(tmp_path):
    r"""TEST-113 [acceptance INV-1/INV-2] — P6: a CYCLIC SoftLink back to an ancestor
    (`/matrix/zzz` -> SoftLink("/matrix")) still imports at rc 0.

    The walk's `seen` set holds the HDF5 object ids already checked, so a SoftLink
    pointing back at an ANCESTOR group — `/matrix/zzz` resolving to `/matrix`
    itself — is short-circuited by `seen` instead of being walked forever and
    refused by the depth cap: a WRONG-but-terminating refusal that `seen` exists to
    turn into a correct acceptance. The bundle must still import at rc 0 with a
    manifest written.
    """
    bundle = _copy(tmp_path, "p6-cyclic-softlink")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        handle["matrix/zzz"] = h5py.SoftLink("/matrix")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a cyclic SoftLink must still import"


# ── #478: the matrix-side duplicate-barcode refusal and its control ─────────────────


def test_TEST_118_a_duplicated_matrix_barcode_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-118 [acceptance INV-1/INV-2] — the matrix-side duplicate: `/matrix/barcodes`
    lists the same decoded barcode twice.

    `barcodes[0]` is replaced with `barcodes[1]`'s value, so the length stays 120 and
    the length cross-check passes — only the duplicate is new. MEASURED pre-fix through
    the shipped entrypoint:

        rc=0  paths=117  SILENT NON-UNIQUE AXIS KEY

    The import SUCCEEDED: a manifest was written, 117 paths landed, and
    `axis/barcode.zarr` shipped a non-unique key sequence — two matrix columns mapping
    onto one spot, and every downstream `aligned_to` join on the cells axis ambiguous.
    Post-fix the refusal names the repeat count and the first repeated barcode, before
    the first writer, with nothing on disk.
    """
    bundle = _copy(tmp_path, "t478-duplicate-matrix-barcode")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        barcodes = m["barcodes"][:]
        assert len(barcodes) == N_BARCODES, len(barcodes)
        barcodes[0] = barcodes[1]
        del m["barcodes"]
        m.create_dataset("barcodes", data=barcodes)
    # THE MUTATION TOOK EFFECT — re-open and prove the duplicate landed, so a silently
    # failed mutation cannot make this test pass vacuously.
    with h5py.File(bundle / MATRIX, "r") as handle:
        bcs = [b.decode() for b in handle["matrix"]["barcodes"][:]]
        assert bcs[0] == bcs[1], "the duplicate did not land"
        assert len(set(bcs)) == N_BARCODES - 1, "expected exactly one duplicated barcode"
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    # The refusal mirrors the sibling importer's wording, which names the repeat count
    # and the first repeated barcode rather than the member path — so the four INV legs
    # are asserted directly instead of through `_assert_refused`'s member-path leg.
    assert result.returncode == 2, (
        f"expected a NAMED refusal (rc=2), got rc={result.returncode}; "
        f"stderr tail: {result.stderr[-2000:]!r}"
    )
    assert b"Traceback" not in result.stderr, (
        f"a traceback, not a named refusal (INV-1): {result.stderr[-2000:]!r}"
    )
    survivors = sorted(p.relative_to(out).as_posix() for p in out.rglob("*")) if out.exists() else []
    assert survivors == [], f"a refused import left {len(survivors)} paths behind: {survivors[:12]}"
    assert not (out / "manifest.json").exists(), "a refused import must not write a manifest"
    assert list(Path(out).rglob("zarr.json")) == [], "a refused import must leave no store"
    assert _REFUSAL_PREFIX in result.stderr, (
        f"the refusal must carry main()'s prefix: {result.stderr[-2000:]!r}"
    )
    assert b"more than once" in result.stderr, (
        f"the refusal must say the real thing: {result.stderr[-2000:]!r}"
    )
    assert b"1 barcode(s) more than once" in result.stderr, (
        f"the refusal must state the repeat count: {result.stderr[-2000:]!r}"
    )


def test_TEST_119_the_unmutated_fixture_still_imports(tmp_path):
    r"""TEST-119 [acceptance INV-1/INV-2] — THE NEGATIVE CONTROL for #478.

    Every duplicate-barcode refusal assertion would pass on a validator that refuses
    EVERYTHING. This is the test that stops that: the committed, unmutated bundle —
    whose `/matrix/barcodes` has 120 DISTINCT decoded barcodes — must still import at
    rc 0 with a manifest written.
    """
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(VF.FIXTURE, out)

    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["outputs"], manifest


# ── #506: the string dtype-kind checks and their control ────────────────────────────


def test_TEST_120_a_features_id_stored_as_an_integer_is_refused(tmp_path):
    r"""TEST-120 [acceptance INV-1/INV-2] — `/matrix/features/id` recreated as int32,
    length matching.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=117  SILENT GARBAGE

    The import SUCCEEDED: `decoded_h5_strings` `str()`-coerced the ints into
    plausible-looking gene ids ("0", "1", ...) and the whole bundle imported at rc 0
    with garbage identities. Post-fix the refusal names the member and the dtype:
    `.../matrix/features/id is not stored as a string (type name 'int32'). ...`
    """
    bundle = _copy(tmp_path, "t506-int-features-id")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        fg = handle["matrix"]["features"]
        del fg["id"]
        fg.create_dataset("id", data=np.arange(N_FEATURES, dtype=np.int32))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/features/id`", marker=b"is not stored as a string")


def test_TEST_121_a_features_name_stored_as_an_integer_is_refused(tmp_path):
    r"""TEST-121 [acceptance INV-1/INV-2] — `/matrix/features/name` recreated as int32,
    length matching.

    The mirror of TEST-120 on the OTHER feature column: `decoded_h5_strings`
    `str()`-coerced the ints into plausible-looking gene symbols and the bundle imported
    at rc 0 with garbage names. Post-fix the refusal names the member and the dtype:
    `.../matrix/features/name is not stored as a string (type name 'int32'). ...`
    """
    bundle = _copy(tmp_path, "t506-int-features-name")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        fg = handle["matrix"]["features"]
        del fg["name"]
        fg.create_dataset("name", data=np.arange(N_FEATURES, dtype=np.int32))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/features/name`", marker=b"is not stored as a string")


def test_TEST_122_a_barcodes_stored_as_an_integer_is_refused(tmp_path):
    r"""TEST-122 [acceptance INV-1/INV-2] — `/matrix/barcodes` recreated as int32,
    length matching.

    MEASURED pre-fix through the shipped entrypoint:

        rc=2  paths=51  (an unrelated positions reason, AFTER the first writer)

    The int32 barcodes sailed past the matrix validation (`decoded_h5_strings`
    `str()`-coerced them into "0", "1", ...), the store and both axis stores were
    written, and the import died at the positions join — 51 paths on disk, INV-2
    broken. Post-fix the refusal names the member and the dtype BEFORE the first
    writer, with nothing on disk:
    `.../matrix/barcodes is not stored as a string (type name 'int32'). ...`
    """
    bundle = _copy(tmp_path, "t506-int-barcodes")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["barcodes"]
        m.create_dataset("barcodes", data=np.arange(N_BARCODES, dtype=np.int32))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/barcodes`", marker=b"is not stored as a string")


def test_TEST_123_the_unmutated_fixture_still_imports(tmp_path):
    r"""TEST-123 [acceptance INV-1/INV-2] — THE NEGATIVE CONTROL for #506.

    Every string-dtype refusal assertion would pass on a validator that refuses
    EVERYTHING. This is the test that stops that: the committed, unmutated bundle —
    whose `/matrix/barcodes`, `/matrix/features/id` and `/matrix/features/name` are all
    stored as HDF5 strings — must still import at rc 0 with a manifest written.
    """
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(VF.FIXTURE, out)

    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["outputs"], manifest


def test_TEST_124_a_vlen_string_barcodes_dataset_still_imports(tmp_path):
    r"""TEST-124 [acceptance INV-1/INV-2] — the OTHER accepted string kind for #506.

    The committed fixture stores its three string members as fixed-length `|S` bytes
    (kind `"S"`); the importer's `decoded_h5_strings` ALSO decodes variable-length
    strings (kind `"O"`, where the vlen base type is str/bytes). This test pins the `O`
    half of the accepted `"SO"` set: `/matrix/barcodes` re-created as a vlen UTF-8
    string dataset must still import at rc 0 with a manifest written — the dtype-kind
    check must not be an over-broad refusal that rejects every non-`|S` spelling.
    """
    bundle = _copy(tmp_path, "t506-vlen-barcodes")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        bcs = [b.decode() for b in m["barcodes"][:]]
        del m["barcodes"]
        m.create_dataset("barcodes", data=np.array(bcs, dtype=h5py.string_dtype("utf-8")))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["outputs"], manifest


def test_TEST_125_a_features_id_stored_as_a_vlen_int_is_refused(tmp_path):
    r"""TEST-125 [acceptance INV-1/INV-2] — `/matrix/features/id` recreated as a
    VARIABLE-LENGTH INT (`h5py.vlen_dtype(np.int32)`), length matching.

    MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT GARBAGE

    The round-1 dtype check matched on numpy KIND (`kinds="SO"`), and kind `O` is ALSO
    how h5py spells every variable-length type — so a vlen-int member passed the check
    and `decoded_h5_strings` `str()`-coerced each int ARRAY into plausible-looking gene
    ids ("[0 1]", "[1 2]", ...), importing the whole bundle at rc 0 with garbage
    identities. Post-fix the check is `h5py.check_string_dtype`, which returns a truthy
    `StringInfo` for a real HDF5 string dtype (fixed-length `|S` OR vlen string) and
    `None` for a vlen-int — so the refusal names the member and the dtype BEFORE the
    first writer, with nothing on disk:
    `.../matrix/features/id is not stored as a string ('object'). ...`
    """
    bundle = _copy(tmp_path, "t506-vlen-int-features-id")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        fg = handle["matrix"]["features"]
        del fg["id"]
        ds = fg.create_dataset("id", shape=(N_FEATURES,),
                               dtype=h5py.vlen_dtype(np.int32))
        for i in range(N_FEATURES):
            ds[i] = np.array([i, i + 1], dtype=np.int32)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/features/id`", marker=b"is not stored as a string")


def test_TEST_126_a_barcodes_stored_as_a_vlen_int_is_refused(tmp_path):
    r"""TEST-126 [acceptance INV-1/INV-2] — `/matrix/barcodes` recreated as a
    VARIABLE-LENGTH INT (`h5py.vlen_dtype(np.int32)`), length matching.

    MEASURED pre-fix through the shipped entrypoint:

        rc=2  paths=51  (an unrelated positions reason, AFTER the first writer)

    The vlen-int barcodes sailed past the round-1 dtype check (kind `O` — the same kind
    a vlen string has), `decoded_h5_strings` `str()`-coerced each int ARRAY into "[0 1]",
    "[1 2]", ..., the store and both axis stores were written, and the import died at
    the positions join — 51 paths on disk, INV-2 broken. Post-fix the
    `h5py.check_string_dtype` check refuses the member and the dtype BEFORE the first
    writer, with nothing on disk:
    `.../matrix/barcodes is not stored as a string ('object'). ...`
    """
    bundle = _copy(tmp_path, "t506-vlen-int-barcodes")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["barcodes"]
        ds = m.create_dataset("barcodes", shape=(N_BARCODES,),
                              dtype=h5py.vlen_dtype(np.int32))
        for i in range(N_BARCODES):
            ds[i] = np.array([i, i + 1], dtype=np.int32)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"`/matrix/barcodes`", marker=b"is not stored as a string")


# ── B12: the LAST unguarded read escaped — the ROOT ATTRIBUTES (#471) ────────────────


#: The payload the corrupt root attribute carries. It is UNIQUE to the planted attribute, so
#: scanning the matrix file for it finds exactly the global-heap object h5py wrote for the
#: attribute's value — which is what makes the byte-level corruption below TARGETED.
_ROOT_ATTR_MARKER = b"ATTACKER-CONTROLLED-STRING"


def _plant_corrupt_root_attribute(matrix_path):
    r"""Plant a root attribute whose VALUE cannot be materialised — REAL h5py, REAL corruption.

    `h5py` writes a variable-length string attribute's payload into a GLOBAL HEAP object:
    the object is an 8-byte little-endian LENGTH followed by the payload bytes. Overwriting
    that LENGTH with `2**64 - 1` leaves the file structurally valid — the superblock, the
    root object header and the `/matrix` subtree are untouched, so `h5py.File(...)` and
    `h5["matrix"]` still work — while `h5a.read` of that attribute runs off the end of the
    heap. That is exactly the "truncated or corrupt attribute" class #471 is about, and the
    reader's failure is h5py's own (MEASURED through the shipped entrypoint on the
    unguarded base):

        OSError: Can't synchronously read data (ran off end of input buffer while decoding)

    at `import_visium.py`'s `attrs = dict(h5.attrs)` — rc 1, raw traceback, 0 paths.

    The lengths are ASSERTED before the corruption: the 8 bytes immediately before the
    marker must be `len(marker)`, which proves the scan found the right heap object and not
    a coincidental copy of the payload somewhere else in the file.
    """
    with h5py.File(matrix_path, "r+") as handle:
        assert "evil_vlen" not in handle.attrs
        handle.attrs.create(
            "evil_vlen",
            data=_ROOT_ATTR_MARKER.decode("ascii"),
            dtype=h5py.string_dtype(),
        )
        # The planted attribute is really there before the run (assertion (5): not a no-op).
        assert handle.attrs["evil_vlen"] == _ROOT_ATTR_MARKER.decode("ascii")
    raw = bytearray(matrix_path.read_bytes())
    pos = raw.find(_ROOT_ATTR_MARKER)
    assert pos != -1, "the planted attribute's payload is not in the matrix file"
    stored = struct.unpack_from("<Q", raw, pos - 8)[0]
    assert stored == len(_ROOT_ATTR_MARKER), (
        f"the 8 bytes before the marker are {stored}, not the payload length "
        f"{len(_ROOT_ATTR_MARKER)} — the scan found the wrong heap object"
    )
    struct.pack_into("<Q", raw, pos - 8, 0xFFFFFFFFFFFFFFFF)
    matrix_path.write_bytes(bytes(raw))


def _assert_unmaterialisable_attrs(matrix_path):
    r"""The RAW reader still RAISES on the planted file — the unguarded read's proven outcome.

    This is the structural half of "the mutation is real": through the actual h5py, on the
    actual corrupted file, `dict(h5.attrs)` raises the exact exception the unguarded module
    leaked as a traceback at rc 1 (measured on this base before the fix). A test that only
    asserted the fixed entrypoint's rc 2 could go green with a mutation that never raised
    and never ran.
    """
    with h5py.File(matrix_path, "r") as handle:
        with pytest.raises(OSError) as excinfo:
            dict(handle.attrs)
    # THE `"input buffer"` WORDING ASSERTION IS COUPLED TO HDF5/h5py's error wording ON
    # PURPOSE: the exception CLASS is what `pytest.raises(OSError)` pins, and the wording
    # is only cosmetically asserted so a silently-different failure cannot pass — if h5py
    # ever rewords the error, the class assertion still holds and only this line moves.
    assert "input buffer" in str(excinfo.value), str(excinfo.value)


def test_TEST_138_a_corrupt_root_attribute_is_a_named_refusal_through_the_entrypoint(tmp_path):
    r"""TEST-138 [acceptance INV-1, INV-2] — B12: `/matrix` file's ROOT ATTRIBUTES cannot be read.

    #471. The one read the #345/#451 sweep left: `attrs = dict(h5.attrs)` MATERIALISES
    every root attribute, and a corrupted attribute (here: a vlen string whose
    global-heap object length is overwritten) makes h5py raise while materialising.
    MEASURED pre-fix through the shipped entrypoint on this base:

        rc=1  paths=0
        OSError: Can't synchronously read data (ran off end of input buffer while decoding)
          import_visium.py:4624  run_import  ->  attrs = dict(h5.attrs)

    A raw traceback at exit 1 — INV-1's prohibited outcome. Post-fix the refusal names
    the member and states the 10x fact:

        filtered_feature_bc_matrix.h5's root attributes cannot be read (...). A 10x
        feature-barcode matrix carries its identity there: `library_ids`,
        `software_version`, `chemistry_description` and `filetype`. A file whose root
        attributes cannot be materialised cannot be named by this importer, and its
        coordinate frame cannot be declared. ...

    This test asserts ALL of the #471 proof: (1) the raw read raises through real h5py,
    (2) the shipped entrypoint turns it into the NAMED refusal at the refusal exit code
    2, (3) ZERO paths on disk, (4) the mutation really changed the file (byte comparison
    + planted attribute present), and (5) the 10x explanation is in the message. The
    unmutated positive control is TEST-139. This is also the test that asserts INV-2's
    ZERO-PATH content on the refused path: a refused import leaves no store.
    """
    bundle = _copy(tmp_path, "b12-corrupt-root-attribute")
    matrix = bundle / MATRIX
    before = matrix.read_bytes()
    _plant_corrupt_root_attribute(matrix)
    after = matrix.read_bytes()
    # (4) the mutation really changed the file — never a no-op. The corruption itself
    # is an IN-PLACE overwrite of 8 bytes, so the LENGTH comparison is done against the
    # h5py-written-but-UNCORRUPTED state inside the planter; here the bytes differ.
    assert before != after, "the corruption did not change the matrix file's bytes"
    # (1) the raw read still raises through real h5py (the unguarded read's own outcome).
    _assert_unmaterialisable_attrs(matrix)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    # (2) + (3): named refusal at the refusal exit code, no traceback, ZERO paths.
    _assert_refused(result, out, b"root attributes", marker=b"cannot be read")
    # (5) the message carries the 10x fact — what a feature-barcode matrix carries at root.
    assert b"library_ids" in result.stderr, (
        f"the refusal must state what a 10x feature-barcode matrix carries at its root: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"not be materialised" in result.stderr, (
        f"the refusal must explain why the unreadable attributes matter: "
        f"{result.stderr[-2000:]!r}"
    )
    # The refusal row is one line and nothing is written after it (INV-1's log shape).
    lines = [ln for ln in result.stderr.split(b"\n") if ln]
    carrying = [i for i, ln in enumerate(lines) if ln.startswith(_REFUSAL_PREFIX)]
    assert len(carrying) == 1, lines[-4:]
    assert carrying[0] == len(lines) - 1, (
        f"the refusal is not the last stderr row: {lines[-4:]}"
    )


def test_TEST_139_the_unmutated_fixture_still_imports_through_the_same_run_path(tmp_path):
    r"""TEST-139 [acceptance INV-1] — the positive control: absent is not never-ran (#471).

    The corrupted-bundle test proves the refusal; THIS proves the mutation is what the
    refusal is about. The UNMUTATED committed fixture is driven through the SAME shipped
    entrypoint (`visium_fixtures.run_entry_bytes`, the `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`
    seam) and must import at rc 0 with a real manifest — the same import that the guard
    must NOT newly refuse: an over-broad guard would refuse this valid bundle at rc 2,
    which is exactly what this positive control reddens on. The ZERO-PATH content of INV-2
    (a refused import leaves no store, no partial store and nothing for a later reader to
    find) is asserted by TEST-138; THIS test is the INV-1-side positive control — the
    VALID path is not newly refused — and it is what makes "a refused import leaves no
    store" mean anything: a suite that never runs the entrypoint satisfaces an
    empty-outputs assertion vacuously.

    MEASURED (this test): the unmutated fixture imports at rc 0 with 16 outputs; the
    mutated copy of the same fixture refuses at rc 2 with 0 paths (TEST-138).
    """
    ok_out = tmp_path / "out-ok" / "outputs"
    result = VF.run_entry_bytes(VF.FIXTURE, ok_out)
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    manifest = json.loads((ok_out / "manifest.json").read_text(encoding="utf-8"))
    ids = sorted(e["id"] for e in manifest["outputs"])
    assert ids, "a successful import must produce outputs"
    assert "single-cell/counts" in {e.get("datatype") for e in manifest["outputs"]}, ids
