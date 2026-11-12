#!/usr/bin/env python3
# ruff: noqa
r"""The `/matrix` CSC triple's INTERNAL CONSISTENCY is validated BEFORE the first writer (#349).

`run_import` reads the 10x `/matrix` group and hands it straight to `txr_csc.H5CsrSource`
and then `txr_csc.write_csc_zarr` — the FIRST WRITER, which creates
`outputs/expression.zarr`. The content and shape of `/matrix/data`, `/matrix/indices` and
`/matrix/indptr` were never validated; they were first touched INSIDE the writer, i.e. AFTER
artifact bytes already existed on disk. #349 adds `refuse_malformed_counts(group,
n_barcodes, n_features)` and calls it inside `run_import`, inside the
`with h5py.File(...) as h5:` block, immediately BEFORE `txr_csc.H5CsrSource(...)` — strictly
BEFORE the first writer.

This file is the regression battery for that function. Every row below was MEASURED on this
exact tree BEFORE the fix, through the SHIPPED entrypoint — `visium_fixtures.run_entry_bytes`,
which runs `compute/import_visium.py` as a subprocess over the `TXR_INPUTS_DIR` /
`TXR_OUTPUTS_DIR` seam with stdout/stderr captured as BYTES. The measured pre-fix outcome is
quoted in each test's docstring; a test that merely restated the code would not be a
regression test.

The invariants under test are this package's own numbers
(`docs/design/vendor-text-encodability-refusal.md` §6.5):

  INV-1 — a bundle this importer cannot carry is REFUSED BY NAME (`VisiumImportError`),
          never a traceback and never an exit-1.
  INV-2 — the refusal fires BEFORE any artifact byte is written, so a refused import leaves
          no store, no partial store and nothing for a later reader to find.

The committed fixture is MEASURED, not re-derived: `/matrix/shape` is int32 [150, 120]
(n_features=150, n_barcodes=120), `/matrix/data` is int32 (17677,), `/matrix/indices` is
int64 (17677,) with min=0 max=149, and `/matrix/indptr` is int64 (121,) with indptr[0]=0 and
indptr[-1]=17677. The importer re-reads this CSC store AS CSR of shape (n_barcodes,
n_features) = (120, 150), so len(indptr) must be n_barcodes+1 = 121, indptr[-1] must equal
len(indices) == len(data) == 17677, and every indices value must be < n_features = 150.

Damage is always done to a COPY of the committed fixture; the fixture itself is never
modified.
"""
import json
import shutil
import sys
from pathlib import Path

import h5py
import numpy as np

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


def _assert_refused(result, out, member, *, marker, member_path=None):
    """The four legs every refusal test must assert (INV-1 and INV-2), plus the wording.

    1. `returncode == 2` — a NAMED refusal, never 0 and never 1 (INV-1).
    2. no `Traceback` on stderr — INV-1's prohibited outcome.
    3. the outputs tree is EMPTY — no store, no partial store, no manifest, nothing for a
       later reader to find (INV-2).
    4. the refusal NAMES the offending member — by the BACKTICKED PATH the messages
       actually use (`` `/matrix/data` `` etc.), never a bare `b"data"`, which every
       refusal's shared "as flat datasets;" sentence would satisfy even when the refusal
       names the WRONG member — and carries `main()`'s `spatial.import-visium:` prefix,
       plus the exact sentence that says what is wrong, so the test pins the real wording
       rather than any refusal at all.

    `member_path` overrides the backticked spelling for the refusals that quote the path
    through `_quoted_for_refusal` (the structural walk's, which render it as
    `'/matrix/...'` — single-quoted, the way `ascii()` spells it).
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
    if member_path is None:
        member_path = b"`/matrix/" + member + b"`"
    assert member_path in result.stderr, (
        f"the refusal must NAME the offending member {member_path!r}: {result.stderr[-2000:]!r}"
    )
    assert _REFUSAL_PREFIX in result.stderr, (
        f"the refusal must carry main()'s prefix: {result.stderr[-2000:]!r}"
    )
    assert marker in result.stderr, (
        f"the refusal must say the real thing ({marker!r}): {result.stderr[-2000:]!r}"
    )


# ── M1 .. M12: the twelve measured pre-fix rows ────────────────────────────────────────


def test_TEST_43_a_truncated_indices_is_refused_not_silently_imported(tmp_path):
    r"""TEST-43 [acceptance INV-1] — M1: `/matrix/indices` truncated to its first 100 values.

    `indptr[-1]` still says 17677 while `indices` now holds 100 entries, so the two halves of
    one stored value disagree in length. MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The import SUCCEEDED: a manifest was written, 119 paths landed, and the store held
    nnz=100 with every index 0 — 99.4% of the counts lost and the operator told it
    SUCCEEDED. That is why this row is P1: the failure mode is not a crash, it is a WRONG
    matrix that looks like a success.

    Post-fix the refusal names both halves: `.../matrix/data holds 17677 value(s) but
    /matrix/indices holds 100 feature id(s). They are the two halves of one stored value and
    their counts are the same number by definition; ...`
    """
    bundle = _copy(tmp_path, "m1-truncated-indices")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        first100 = m["indices"][:100]
        del m["indices"]
        m.create_dataset("indices", data=first100)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"holds 17677 value(s) but")
    assert b"`/matrix/indices` holds 100 feature id(s)" in result.stderr, (
        "M1 is the P1 row: the refusal must name BOTH halves — `/matrix/data` holds 17677 "
        "value(s) but `/matrix/indices` holds 100 feature id(s) — because a pre-fix run "
        "exited 0 with a corrupted matrix (manifest written, 119 paths, store nnz=100 "
        "with every index 0 — 99.4% of the counts lost and the operator told it "
        "SUCCEEDED)."
    )


def test_TEST_44_a_lying_indptr_is_refused_not_silently_imported(tmp_path):
    r"""TEST-44 [acceptance INV-1] — M2: `/matrix/indptr` = 121 entries all `999999999`.

    The length is right (121 = n_barcodes + 1) but the offsets are all lies. MEASURED pre-fix
    through the shipped entrypoint:

        rc=1  paths=5
        RuntimeError: transpose scatter did not fill the band exactly
        (_lib/txr_csc.py:626)

    A raw traceback and a PARTIAL STORE — the operator is told nothing about the bundle. This
    row is P1 alongside M1: the pre-fix run did not merely crash, it left five artifact paths
    on disk and exited 1, which is INV-1's prohibited outcome.

    Post-fix the refusal names the member: `.../matrix/indptr starts at 999999999 rather than
    0. A CSC offset array starts at 0; one that does not describes no matrix. ...`
    """
    bundle = _copy(tmp_path, "m2-lying-indptr")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["indptr"]
        m.create_dataset("indptr", data=np.full(N_BARCODES + 1, 999999999, dtype=np.int64))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indptr", marker=b"starts at 999999999 rather than 0")
    assert result.returncode != 0, (
        "M2 is the P1 row: a pre-fix run exited 1 with a raw traceback and 5 partial paths "
        "instead of a named refusal."
    )


def test_TEST_45_a_group_where_data_should_be_is_refused(tmp_path):
    r"""TEST-45 [acceptance INV-1] — M3: `/matrix/data` is a GROUP, not a dataset.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=5
        TypeError: Accessing a group is done with bytes or str, not <class 'slice'>
        (_lib/txr_csc.py:212)

    A raw traceback out of h5py and a PARTIAL STORE. Post-fix the refusal names the member:
    `.../matrix/data is not a dataset ('Group'). A 10x feature-barcode matrix stores its
    non-zero values, feature ids and column offsets as flat datasets; anything else is not a
    matrix this importer can read. ...`
    """
    bundle = _copy(tmp_path, "m3-data-is-a-group")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["data"]
        m.create_group("data")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"data", marker=b"is not a dataset")


def test_TEST_46_a_scalar_where_data_should_be_is_refused(tmp_path):
    r"""TEST-46 [acceptance INV-1] — M4: `/matrix/data` is a SCALAR dataset.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=5
        ValueError: Illegal slicing argument for scalar dataspace
        (_lib/txr_csc.py:212)

    A raw traceback and a PARTIAL STORE. Post-fix the refusal names the member:
    `.../matrix/data is not a one-dimensional dataset ('()'). A 10x feature-barcode matrix
    stores its non-zero values, feature ids and column offsets as flat datasets; anything
    else is not a matrix this importer can read. ...`
    """
    bundle = _copy(tmp_path, "m4-data-is-a-scalar")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["data"]
        m.create_dataset("data", data=np.int32(7))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"data", marker=b"is not a one-dimensional dataset")


def test_TEST_47_a_2d_data_member_is_refused(tmp_path):
    r"""TEST-47 [acceptance INV-1] — M5: `/matrix/data` is 2-D, shape (100, 3).

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=5
        IndexError: index 142 is out of bounds for axis 0 with size 100
        (_lib/txr_csc.py:619)

    A raw traceback and a PARTIAL STORE. Post-fix the refusal names the member:
    `.../matrix/data is 2-dimensional (shape '(100, 3)'). A 10x feature-barcode matrix stores
    its non-zero values, feature ids and column offsets as flat datasets; anything else is
    not a matrix this importer can read. ...`
    """
    bundle = _copy(tmp_path, "m5-data-is-2d")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["data"]
        m.create_dataset("data", data=np.zeros((100, 3), dtype=np.int32))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"data", marker=b"is 2-dimensional")


def test_TEST_48_a_truncated_data_member_is_refused(tmp_path):
    r"""TEST-48 [acceptance INV-1] — M6: `/matrix/data` truncated to its first 100 values.

    The mirror of M1: `indices` still holds 17677 ids while `data` now holds 100 values.
    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=5
        IndexError: index 142 is out of bounds for axis 0 with size 100
        (_lib/txr_csc.py:619)

    A raw traceback and a PARTIAL STORE. Post-fix the refusal names both halves:
    `.../matrix/data holds 100 value(s) but /matrix/indices holds 17677 feature id(s). They
    are the two halves of one stored value and their counts are the same number by
    definition; ...`
    """
    bundle = _copy(tmp_path, "m6-truncated-data")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        first100 = m["data"][:100]
        del m["data"]
        m.create_dataset("data", data=first100)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"data", marker=b"holds 100 value(s) but")


def test_TEST_49_a_decreasing_indptr_is_refused(tmp_path):
    r"""TEST-49 [acceptance INV-1] — M7: `/matrix/indptr` len 121 but `indptr[60] = -5`.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=5
        ValueError: repeats may not contain negative values.
        (_lib/txr_csc.py:213)

    A raw traceback and a PARTIAL STORE. Post-fix the refusal names the member and the exact
    position: `.../matrix/indptr decreases at position 59 (8678 -> -5). A CSC offset array
    never decreases; one that does describes no matrix. ...`
    """
    bundle = _copy(tmp_path, "m7-decreasing-indptr")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        indptr = m["indptr"][:].copy()
        indptr[60] = -5
        del m["indptr"]
        m.create_dataset("indptr", data=indptr)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indptr", marker=b"decreases at position")


def test_TEST_50_indices_out_of_range_are_refused(tmp_path):
    r"""TEST-50 [acceptance INV-1] — M8: `/matrix/indices` = 17677 entries all `99999`.

    Every feature id names a feature this file does not declare. MEASURED pre-fix through the
    shipped entrypoint:

        rc=1  paths=0
        ValueError: operands could not be broadcast together with shapes (150,) (100000,) (150,)
        (_lib/txr_csc.py:199)

    A raw traceback (no partial store this time, but still INV-1's prohibited outcome).
    Post-fix the refusal names the member, the value and the position:
    `.../matrix/indices holds feature id 99999 at position 0, but this file declares only 150
    feature(s) (ids 0..149). ...`
    """
    bundle = _copy(tmp_path, "m8-indices-out-of-range")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["indices"]
        m.create_dataset("indices", data=np.full(NNZ, 99999, dtype=np.int64))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"holds feature id 99999 at position 0")


def test_TEST_51_a_group_where_indices_should_be_is_refused(tmp_path):
    r"""TEST-51 [acceptance INV-1] — M9: `/matrix/indices` is a GROUP, not a dataset.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        TypeError: Accessing a group is done with bytes or str, not <class 'slice'>
        (_lib/txr_csc.py:198)

    A raw traceback out of h5py. Post-fix the refusal names the member:
    `.../matrix/indices is not a dataset ('Group'). A 10x feature-barcode matrix stores its
    non-zero values, feature ids and column offsets as flat datasets; anything else is not a
    matrix this importer can read. ...`
    """
    bundle = _copy(tmp_path, "m9-indices-is-a-group")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["indices"]
        m.create_group("indices")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"is not a dataset")


def test_TEST_52_a_scalar_where_indices_should_be_is_refused(tmp_path):
    r"""TEST-52 [acceptance INV-1] — M10: `/matrix/indices` is a SCALAR dataset.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        ValueError: Illegal slicing argument for scalar dataspace
        (_lib/txr_csc.py:198)

    A raw traceback. Post-fix the refusal names the member:
    `.../matrix/indices is not a one-dimensional dataset ('()'). A 10x feature-barcode matrix
    stores its non-zero values, feature ids and column offsets as flat datasets; anything
    else is not a matrix this importer can read. ...`
    """
    bundle = _copy(tmp_path, "m10-indices-is-a-scalar")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["indices"]
        m.create_dataset("indices", data=np.int64(3))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"is not a one-dimensional dataset")


def test_TEST_53_a_shifted_indptr_is_refused(tmp_path):
    r"""TEST-53 [acceptance INV-1] — M11: `/matrix/indptr` = the real indptr + 5.

    `indptr[0]=5`, `indptr[-1]=17682`, len 121 — every offset is off by five. MEASURED pre-fix
    through the shipped entrypoint:

        rc=1  paths=5
        RuntimeError: transpose scatter did not fill the band exactly
        (_lib/txr_csc.py:626)

    A raw traceback and a PARTIAL STORE. Post-fix the refusal names the member:
    `.../matrix/indptr starts at 5 rather than 0. A CSC offset array starts at 0; one that
    does not describes no matrix. ...`
    """
    bundle = _copy(tmp_path, "m11-shifted-indptr")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        shifted = m["indptr"][:] + 5
        del m["indptr"]
        m.create_dataset("indptr", data=shifted)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indptr", marker=b"starts at 5 rather than 0")


def test_TEST_54_an_indices_value_equal_to_n_features_is_refused(tmp_path):
    r"""TEST-54 [acceptance INV-1] — M12: `/matrix/indices` valid except the LAST value = 150.

    `150 == n_features`, so the last feature id names the feature one past the file's own
    declared range. MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        ValueError: operands could not be broadcast together with shapes (150,) (151,) (150,)
        (_lib/txr_csc.py:199)

    A raw traceback. Post-fix the refusal names the member, the value and the position:
    `.../matrix/indices holds feature id 150 at position 17676, but this file declares only
    150 feature(s) (ids 0..149). ...`
    """
    bundle = _copy(tmp_path, "m12-indices-equal-n-features")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        indices = m["indices"][:].copy()
        indices[-1] = N_FEATURES
        del m["indices"]
        m.create_dataset("indices", data=indices)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"holds feature id 150 at position 17676")


# ── M13, M14: the two added beyond the twelve ─────────────────────────────────────────


def test_TEST_55_a_deleted_indptr_is_refused(tmp_path):
    r"""TEST-55 [acceptance INV-1] — M13: `/matrix/indptr` DELETED entirely.

    MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=0
        KeyError: "Unable to synchronously open object (object 'indptr' doesn't exist)"

    A raw traceback out of h5py. Post-fix the refusal names the member:
    `filtered_feature_bc_matrix.h5 has no /matrix/indptr. A 10x feature-barcode matrix stores
    its non-zero values, feature ids and column offsets as flat datasets under /matrix; a
    matrix missing one of them cannot be imported. ...`
    """
    bundle = _copy(tmp_path, "m13-indptr-deleted")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/indptr"]
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indptr", marker=b"has no `/matrix/indptr`")


def test_TEST_56_an_indptr_one_short_is_refused(tmp_path):
    r"""TEST-56 [acceptance INV-1] — M14: `/matrix/indptr` length 120 (one short of 121).

    Otherwise a valid prefix of the real offsets. MEASURED pre-fix through the shipped
    entrypoint:

        rc=1  paths=0
        ValueError: CSR indptr has 120 entries for 120 rows
        (_lib/txr_csc.py:184)

    This is the case that escaped as a bare `ValueError` from `_lib/txr_csc.py:184` — shared
    framework, not this package's to change. Post-fix the refusal names the member and states
    the arithmetic: `.../matrix/indptr has 120 entries; a CSC matrix over 120 barcodes has
    exactly 121.`
    """
    bundle = _copy(tmp_path, "m14-indptr-one-short")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        prefix = m["indptr"][:N_BARCODES]
        del m["indptr"]
        m.create_dataset("indptr", data=prefix)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indptr", marker=b"has 120 entries; a CSC matrix over 120 barcodes has exactly 121")


# ── M15: the negative control ─────────────────────────────────────────────────────────


def test_TEST_57_the_unmutated_fixture_still_imports(tmp_path):
    r"""TEST-57 [acceptance INV-1/INV-2] — M15: THE NEGATIVE CONTROL, the unmutated fixture.

    Every refusal assertion above would pass on a validator that refuses EVERYTHING. This is
    the test that stops that: the committed, unmutated bundle must still import — rc 0, a
    manifest written — and the store must still be correct: nnz 17677 with
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


# ── E1 .. E4: the escapes a blind review found beyond M1..M15 ─────────────────────────


def test_TEST_58_a_virtual_indices_dataset_is_refused_not_silently_imported(tmp_path):
    r"""TEST-58 [acceptance INV-1] — E1: `/matrix/indices` is a VIRTUAL dataset over a
    MISSING source file.

    Built as `h5py.VirtualLayout` + `h5py.VirtualSource` whose source FILE DOES NOT EXIST,
    shape (17677,) dtype int64. h5py then returns the FILL VALUE (0) for every element, and
    the dataset is a genuine 1-D integer `h5py.Dataset` of the right length, so it passed
    every pre-fix check. MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=119  SILENT CORRUPTION

    The import SUCCEEDED: a manifest was written and the store held
    `indptr=[0, 17677, 17677, ...]` — every count attributed to feature 0. A silent wrong
    answer, the same P1 class as TEST-43. Post-fix the refusal names the member:
    `.../matrix/indices is a VIRTUAL dataset. A 10x feature-barcode matrix stores its
    non-zero values, feature ids and column offsets INLINE; ...`
    """
    bundle = _copy(tmp_path, "e1-virtual-indices")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["indices"]
        layout = h5py.VirtualLayout(shape=(NNZ,), dtype=np.int64)
        src = h5py.VirtualSource("does-not-exist.h5", "whatever",
                                 shape=(NNZ,), dtype=np.int64)
        layout[:] = src
        m.create_virtual_dataset("indices", layout, fillvalue=0)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"is a VIRTUAL dataset",
                    member_path=b"'/matrix/indices'")
    assert b"files outside the bundle's matrix file" in result.stderr, (
        "E1 is the P1 row: the refusal must say WHY the virtual dataset is refused — its "
        "values depend on files outside the bundle's matrix file — because a pre-fix run "
        "exited 0 with a corrupted matrix (manifest written, store indptr=[0, 17677, "
        "17677, ...] — every count attributed to feature 0, and the operator told it "
        "SUCCEEDED). The scope is the MATRIX FILE (the #508 prose scoping): the matrix "
        "walk's refusal must not claim to cover the whole bundle's members."
    )


def test_TEST_59_a_string_dtype_data_member_is_refused(tmp_path):
    r"""TEST-59 [acceptance INV-1] — E2: `/matrix/data` has dtype `|S1` (a byte string).

    Length 17677, otherwise correct. MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=5
        ValueError: could not convert string to float
        (_lib/txr_csc.py:619)

    A raw traceback and a PARTIAL STORE. Post-fix the refusal names the member:
    `.../matrix/data is not stored as a number (type name '|S1'). A 10x feature-barcode
    matrix stores its non-zero values as numbers; ...`
    """
    bundle = _copy(tmp_path, "e2-string-data")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["data"]
        m.create_dataset("data", data=np.zeros(NNZ, dtype="S1"))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"data", marker=b"is not stored as a number")


def test_TEST_60_an_external_link_indices_member_is_refused(tmp_path):
    r"""TEST-60 [acceptance INV-1] — E3: `/matrix/indices` is an EXTERNAL LINK to a
    nonexistent file.

    `h5py.ExternalLink("does-not-exist.h5", "/whatever")`. MEASURED pre-fix through the
    shipped entrypoint:

        rc=1  paths=0
        KeyError: "Unable to synchronously open object (can't open file)"

    A raw traceback out of h5py — INV-1 violated. Post-fix the structural walk refuses
    the link BY NAME before resolving it: `...'/matrix/indices' is an ExternalLink. A 10x
    feature-barcode matrix stores every value INLINE in its own file; a link to another
    file cannot be imported — the importer cannot know what it will read. ...`
    """
    bundle = _copy(tmp_path, "e3-external-link-indices")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["indices"]
        m["indices"] = h5py.ExternalLink("does-not-exist.h5", "/whatever")
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"is an ExternalLink",
                    member_path=b"'/matrix/indices'")


def test_TEST_61_a_compound_data_dtype_with_a_huge_non_ascii_field_name_is_refused_safely(tmp_path):
    r"""TEST-61 [acceptance INV-1] — E4: `/matrix/data` is a multi-field COMPOUND dtype
    whose FIRST FIELD NAME is 20,000 non-ASCII characters (`"テ" * 20000`), length 17677.

    This is #336's class (`_quoted_for_refusal` is the one funnel any vendor byte may enter
    a message through) reached by a NEW route: the compound dtype's field name is vendor
    text that used to reach stderr through the traceback, not through any refusal. MEASURED
    pre-fix through the shipped entrypoint:

        rc=1  paths=5
        ValueError: could not convert string to float
        (_lib/txr_csc.py:619)
        ... 61,124 bytes of raw non-ASCII on stderr ...

    A raw traceback, a PARTIAL STORE, and 61,124 bytes of raw non-ASCII on stderr — a
    #336-class message-safety violation on top of INV-1/INV-2. Post-fix the refusal names
    the member: `.../matrix/data is not stored as a number (type name ...). ...` — the
    dtype is quoted through `_quoted_for_refusal`, so the message is ASCII and bounded.
    """
    bundle = _copy(tmp_path, "e4-compound-data")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["data"]
        dt = np.dtype([("テ" * 20000, "i4")])
        m.create_dataset("data", shape=(NNZ,), dtype=dt)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"data", marker=b"is not stored as a number")
    # The message is SAFE TO LOG: bounded, pure ASCII, and the vendor's 20,000-character
    # field name does not appear raw anywhere on stderr.
    assert len(result.stderr) < 10000, (
        f"the refusal must be bounded (it was 61,124 bytes pre-fix): {len(result.stderr)}"
    )
    result.stderr.decode("ascii")  # raises if any byte is non-ASCII
    assert "テテテ".encode("utf-8") not in result.stderr, (
        "the vendor's non-ASCII field name must not appear raw on stderr"
    )


# ── F1, F2, F3a: the three checks a senior review found uncovered ────────────────────


def test_TEST_62_an_indptr_that_under_declares_its_last_offset_is_refused(tmp_path):
    r"""TEST-62 [acceptance INV-1] — F2: `/matrix/indptr` valid in every other way —
    length 121, `indptr[0] == 0`, non-decreasing — but with `indptr[-1]` set to
    `len(indices) - 1` (17676), while `/matrix/data` and `/matrix/indices` are BOTH left
    at their full length of 17677.

    This is a THIRD silent-corruption class, distinct from the truncated-`indices` one
    (TEST-43, which fails EARLIER at `len(data) != len(indices)`): here `data` and
    `indices` agree with each other, and only `indptr[-1]` under-declares. `_lib`'s
    `H5CsrSource.nnz` is `int(self._indptr[-1])` (`_lib/txr_csc.py:190`) and
    `column_counts` reads `ind[0:nnz]`, so the store lands silently TRUNCATED at rc 0 —
    MEASURED pre-fix through the shipped entrypoint:

        rc=0  SILENT CORRUPTION: a SHORT store (nnz=17676), the last column's counts
        lost, and the operator told it SUCCEEDED

    Post-fix the refusal names the member and the arithmetic:
    `.../matrix/indptr ends at 17676 but `/matrix/indices` holds 17677 feature id(s). The
    last CSC offset IS the count of stored values; ...`
    """
    bundle = _copy(tmp_path, "f2-indptr-under-declares")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        indptr = m["indptr"][:].copy()
        indptr[-1] = NNZ - 1
        del m["indptr"]
        m.create_dataset("indptr", data=indptr)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indptr", marker=b"ends at 17676 but")


def test_TEST_63_an_indptr_that_wraps_under_np_diff_is_refused(tmp_path):
    r"""TEST-63 [acceptance INV-1] — F1: `/matrix/indptr` = 121 int64 entries

        [0, 2**62, -2**63, -2**62, 0, 17677, 17677, ..., 17677]

    built EXPLICITLY as `np.array([...], dtype=np.int64)` so the wrap is real. This is the
    bundle that defeats the NAIVE `np.diff` spelling of the non-decreasing check: NumPy
    int64 subtraction WRAPS SILENTLY, so `p[2] - p[1]` = `-2**63 - 2**62` wraps to
    `+2**62` and `(np.diff(indptr) < 0).any()` is unconditionally False — the guard passes
    everything. MEASURED pre-fix through the shipped entrypoint:

        rc=1  paths=5
        MemoryError
        (_lib/txr_csc.py)

    A raw traceback and a FIVE-PATH PARTIAL STORE — INV-1 and INV-2 both broken. The
    element-wise spelling (`indptr[1:] < indptr[:-1]`) sees `p[2] < p[1]` directly and
    refuses. Post-fix the refusal names the member and the exact position:
    `.../matrix/indptr decreases at position 1 (4611686018427387904 ->
    -9223372036854775808). ...`
    """
    bundle = _copy(tmp_path, "f1-overflow-indptr")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        indptr = np.array(
            [0, 2**62, -2**63, -2**62, 0] + [NNZ] * (N_BARCODES - 4),
            dtype=np.int64,
        )
        del m["indptr"]
        m.create_dataset("indptr", data=indptr)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indptr", marker=b"decreases at position 1")


def test_TEST_64_an_indices_dataset_with_external_raw_storage_is_refused(tmp_path):
    r"""TEST-64 [acceptance INV-1] — F3a: `/matrix/indices` is a dataset with HDF5
    EXTERNAL RAW STORAGE (`create_dataset(..., external=[("missing.bin", 0, 141416)])`).

    The values come from a file OUTSIDE this bundle, and `ds.is_virtual` is **False** for
    external storage — so the VIRTUAL-dataset check alone (TEST-58) does not see it; only
    the `.external` check does. MEASURED post-fix through the shipped entrypoint:

        rc=2  paths=0  (510 bytes of stderr)

    Post-fix the refusal names the member and the storage kind:
    `.../matrix/indices is a dataset with EXTERNAL raw storage. A 10x feature-barcode
    matrix stores its non-zero values, feature ids and column offsets INLINE; ...`
    """
    bundle = _copy(tmp_path, "f3a-external-storage-indices")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["indices"]
        # 141416 = NNZ * 8 bytes of int64 — the external file's declared extent.
        m.create_dataset(
            "indices", shape=(NNZ,), dtype=np.int64,
            external=[("missing.bin", 0, NNZ * 8)],
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"indices", marker=b"is a dataset with EXTERNAL raw storage",
                    member_path=b"'/matrix/indices'")


def test_TEST_65_a_data_member_with_undecodable_bytes_is_refused(tmp_path):
    r"""TEST-65 [acceptance INV-1] — F3b: `/matrix/data` whose METADATA is valid — 1-D,
    length 17677, int32 — but whose BYTES cannot be decoded: a fletcher32 checksum failure.

    This is the class the `data[0:1]` probe guards: a `/matrix/data` that passes every
    metadata check above (presence, kind, 1-D, right length, numeric dtype) but whose raw
    bytes raise `OSError` when read — an unavailable compression filter, a truncated chunk,
    a failed fletcher32 checksum. Without the probe that `OSError` fires INSIDE
    `txr_csc.write_csc_zarr`, i.e. AFTER the first writer has created
    `outputs/expression.zarr` — a raw traceback at exit 1 and a partial store, INV-1 and
    INV-2 both broken.

    The bundle is built by re-creating `/matrix/data` with the SAME values, dtype and
    length, but CHUNKED and with `fletcher32=True`, then corrupting the raw bytes of chunk 0
    in place (its file offset located via `ds.id.get_chunk_info(0)` before closing). The
    metadata is untouched — the dataset is still a genuine 1-D int32 of length 17677 — so
    only the byte-level read can fail, and it does: h5py raises
    `OSError: Can't synchronously read data (filter returned failure during read)`, which
    the guarded region turns into the named refusal.

    WHY THIS TEST EXISTS — MEASURED: a mutation ladder that DELETED the entire guarded
    region (the wrapped reads of `/matrix/indptr` and of each `/matrix/indices` block plus
    the one-element `data[0:1]` probe) left all 22 tests green. The check had ZERO coverage;
    a check no test can see is a check the next person deletes as dead code. This test is
    the coverage that ladder found missing.
    """
    bundle = _copy(tmp_path, "f3b-undecodable-data")
    h5 = bundle / MATRIX
    with h5py.File(h5, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        del m["data"]
        ds = m.create_dataset("data", data=data, chunks=(len(data),), fletcher32=True)
        ci = ds.id.get_chunk_info(0)
        offset, size = int(ci.byte_offset), int(ci.size)
    with open(h5, "r+b") as fh:
        fh.seek(offset)
        raw = bytearray(fh.read(size))
        for i in range(min(8, len(raw))):
            raw[i] ^= 0xFF
        fh.seek(offset)
        fh.write(bytes(raw))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused(result, out, b"data", marker=b"cannot be read")
    # The h5py error text is vendor-adjacent and must come through the
    # `_quoted_for_refusal` funnel bounded, exactly as TEST-61's compound-dtype field name
    # must.
    assert len(result.stderr) < 10000, (
        f"the refusal must be bounded: {len(result.stderr)} bytes"
    )


# ── F3c, F3d: #505 — the full decodability scan and its control ─────────────────────


def test_TEST_116_a_data_member_with_undecodable_bytes_in_a_LATER_chunk_is_refused(tmp_path):
    r"""TEST-116 [acceptance INV-1/INV-2] — F3c: `/matrix/data` whose METADATA is valid
    but whose BYTES cannot be decoded in a LATER chunk (chunk 5, not chunk 0).

    The one-element `data[0:1]` probe only reads chunk 0, so a corrupt LATER chunk
    escaped it and died inside `txr_csc.write_csc_zarr` — MEASURED pre-fix through the
    shipped entrypoint:

        rc=1  paths=5
        OSError: Can't synchronously read data (filter returned failure during read)

    A raw traceback and a PARTIAL STORE — INV-1 and INV-2 both broken. Post-fix the full
    blockwise decodability scan reads EVERY block of `/matrix/data`, so the corrupt
    chunk 5 is caught before the first writer and refused by name, with nothing on disk.

    WHY THIS TEST RUNS WITH `TXR_TRANSPOSE_READ_NNZ=10` — the #474 all-zero scan and
    the #505 decodability scan share the SAME block size (`txr_csc.READ_NNZ`). At the
    default 4,000,000 the fixture's 17,677 stored values fit in ONE block, so the #474
    scan's own guarded read pulls the WHOLE dataset and happens to hit the corrupted
    chunk 5 — masking whether the #505 scan is present at all (MEASURED: reverting ONLY
    the #505 scan back to `data[0:1]` left this test GREEN at the default block size).
    Patching `READ_NNZ` small (10) splits the difference: the #474 scan's block shrinks
    to 10 and short-circuits on the FIRST non-zero value (the fixture's first ten stored
    values are all non-zero), so it never reaches chunk 5; the #505 scan is a FULL scan
    regardless of block size, so it still walks every block and reaches the corrupted
    chunk. With the patch in effect, reverting the #505 scan alone REDDENS this test —
    the two mechanisms are isolated. The patch is delivered through the subprocess
    environment (`TXR_TRANSPOSE_READ_NNZ`), because `run_entry_bytes` runs the SHIPPED
    ENTRYPOINT as a subprocess and a `monkeypatch` on the test process's `txr_csc`
    module would not reach it.

    The bundle is built like TEST-65's, but CHUNKED at 1000 values (so there are 18
    chunks) and with chunk 5's raw bytes corrupted in place (its file offset located via
    `ds.id.get_chunk_info(5)` before closing). The metadata is untouched — the dataset
    is still a genuine 1-D int32 of length 17677 — so only the byte-level read of chunk
    5 can fail.
    """
    bundle = _copy(tmp_path, "f3c-undecodable-data-later-chunk")
    h5 = bundle / MATRIX
    with h5py.File(h5, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        del m["data"]
        ds = m.create_dataset("data", data=data, chunks=(1000,), fletcher32=True)
        assert ds.id.get_num_chunks() > 5, (
            f"expected more than 5 chunks, got {ds.id.get_num_chunks()}"
        )
        ci = ds.id.get_chunk_info(5)
        offset, size = int(ci.byte_offset), int(ci.size)
    with open(h5, "r+b") as fh:
        fh.seek(offset)
        raw = bytearray(fh.read(size))
        for i in range(min(8, len(raw))):
            raw[i] ^= 0xFF
        fh.seek(offset)
        fh.write(bytes(raw))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out, env={"TXR_TRANSPOSE_READ_NNZ": "10"})

    _assert_refused(result, out, b"data", marker=b"cannot be read")
    assert len(result.stderr) < 10000, (
        f"the refusal must be bounded: {len(result.stderr)} bytes"
    )


def test_TEST_117_a_chunked_fletcher32_data_member_still_imports(tmp_path):
    r"""TEST-117 [acceptance INV-1/INV-2] — F3d: THE POSITIVE CONTROL for #505.

    The same chunking and fletcher32 as TEST-116, with NO corruption: `/matrix/data`
    re-created chunked at 1000 values with `fletcher32=True`. This is what stops the
    full decodability scan from being an over-broad refusal that rejects any chunked or
    checksummed matrix — the chunking and the checksum are legitimate HDF5, and the
    bundle must still import at rc 0 with the store intact.
    """
    bundle = _copy(tmp_path, "f3d-chunked-fletcher32-data")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        del m["data"]
        m.create_dataset("data", data=data, chunks=(1000,), fletcher32=True)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    assert result.returncode == 0, (
        f"a chunked fletcher32 `/matrix/data` must import at rc 0, got rc={result.returncode}; "
        f"stderr tail: {result.stderr[-2000:]!r}"
    )
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    data = VF.read_member(out, "expression.zarr", "data")
    assert len(data) == NNZ, len(data)
