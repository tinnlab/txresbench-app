#!/usr/bin/env python3
# ruff: noqa
r"""An EMPTY `/matrix` is a REFUSAL, and it fires BEFORE the first writer (#445).

`run_import` reads the 10x `/matrix` group and hands it straight to `cyto_csc.H5CsrSource`
and then `cyto_csc.write_csc_zarr` — the FIRST WRITER, which creates
`outputs/expression.zarr`. #445 adds two refusals to `refuse_malformed_counts`, which is
called inside `run_import`, inside the `with h5py.File(...) as h5:` block, immediately
BEFORE `cyto_csc.H5CsrSource(...)` — strictly before the first writer:

  * **Refusal A — `n_barcodes == 0`.** The matrix carries no barcodes at all. This is the
    documented "empty" case — a capture area with no tissue detected, a blank capture, a
    failed capture, or a Loupe manual alignment selecting nothing — and it is the case the
    sibling importer (`spatial-import-visium-hd`) already refuses before its first writer.
    It is refused at the TOP of `refuse_malformed_counts`, before any member is read.
  * **Refusal B — `nnz == 0` with `n_barcodes > 0` (the #445 shape).** `/matrix/data` and
    `/matrix/indices` are both empty while the matrix declares barcodes and features. The
    reason is the same one that carries Refusal A — the canonical sentence
    `REASON_NO_USABLE_COUNTS` in the compute module, which both refusal messages interpolate
    verbatim: an import of such a matrix is reported as SUCCESS at exit 0, `main()` has
    exactly two DESIGNED outcomes (refuse `sys.exit(2)`, or succeed — an uncaught exception
    exits 1 with a raw traceback, INV-1's PROHIBITED outcome), and there is no outcome
    REPORTED TO THE OPERATOR as anything other than SUCCESS — the process exits 0 and
    emits the same closing `progress("done", 100, ...)` line whether the matrix is empty
    or full (MEASURED — `progress: done|100|16 outputs` is the identical closing line in
    every measured case, all of them on this node's committed fixture; the count in that
    line is `len(entries)` — one entry per emitted artifact, including one per emitted
    vendor image — so it is bundle-dependent, and what is identical for every measured
    shape is that the SUCCESS path emits that line at the end), and the report's
    `image_warnings`/`images_not_emitted` lists,
    `registration_qc` block, `scale_note` field and every output entry's `meta` are
    PASSIVE channels that change nothing about the exit code or stderr — so the operator
    is told the import SUCCEEDED and downstream analysis runs on nothing: a plausible
    wrong answer rather than an error. Whether the emptiness is visible mid-stream is
    per-shape and is stated per-shape: for the zero-barcodes shape the streamed
    `progress:` lines (`matrix|15|0 spots ...`, `coordinates|65|0 spot positions`), the
    report's `n_spots` and the manifest's `structure.nnz` DO show it (MEASURED with the
    refusals set aside), while for the `nnz == 0` shape the streamed progress lines and
    the report are byte-identical to a real import (the manifest's expression entry
    differs in its machine-readable structure record (the stored-value count, the
    shapes and the byte counts), which no note field restates). This one
    reason carries BOTH refusals.
    `tests/test_retracted_reason_absent.py` asserts this docstring, the manifest
    changelog, the comment copies and the emitted stderr all agree with that constant.
    As an aside, the emptiness has
    two possible causes — a damaged or truncated file, or a genuine run in which no read
    yielded a usable UMI (tissue detected, library or sequencing failed) — and the refusal
    message names `metrics_summary.csv`'s "Number of Spots Under Tissue" and
    `raw_feature_bc_matrix.h5` so an operator can tell them apart. It is refused where
    `nnz` is proven, after the two length checks and the `indptr` content checks.

The invariants under test are this package's own numbers
(`docs/design/vendor-text-encodability-refusal.md` §6.5):

  INV-1 — a bundle this importer cannot carry is REFUSED BY NAME (`VisiumImportError`),
          never a traceback and never an exit-1.
  INV-2 — the refusal fires BEFORE any artifact byte is written, so a refused import leaves
          no store, no partial store and nothing for a later reader to find.

The committed fixture is MEASURED, not re-derived: `/matrix/shape` is int32 [150, 120]
(n_features=150, n_barcodes=120), `/matrix/data` is int32 (17677,), `/matrix/indices` is
int64 (17677,), and `/matrix/indptr` is int64 (121,) with indptr[0]=0 and indptr[-1]=17677.
The tests derive `n_barcodes` from the fixture's own `/matrix/shape` rather than hardcoding
120, so a fixture change cannot silently invalidate them.

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

#: The prefix `main()` puts on every refusal it prints.
_REFUSAL_PREFIX = b"spatial.import-visium: "

#: The marker sentence of Refusal B (the #445 shape) — the empty-matrix refusal.
_EMPTY_MATRIX_MARKER = b"`/matrix/data` and `/matrix/indices` are both empty"


def _copy(tmp_path, name):
    dest = Path(tmp_path) / name
    shutil.copytree(VF.FIXTURE, dest)
    return dest


def _fixture_shape():
    """The committed fixture's real `/matrix/shape`, read from the file — never hardcoded."""
    with h5py.File(VF.FIXTURE / MATRIX, "r") as handle:
        shape = handle["matrix"]["shape"][:]
    return int(shape[0]), int(shape[1])


def _assert_refused_empty(result, out, *, marker):
    """The four legs every #445 refusal test must assert (INV-1 and INV-2), plus the wording.

    1. `returncode == 2` — a NAMED refusal, never 0 and never 1 (INV-1).
    2. no `Traceback` on stderr — INV-1's prohibited outcome.
    3. the outputs tree is EMPTY — no store, no partial store, no manifest, nothing for a
       later reader to find (INV-2).
    4. the refusal carries `main()`'s `spatial.import-visium:` prefix and the exact
       sentence that says what is wrong, so the test pins the real wording rather than any
       refusal at all.
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
    assert _REFUSAL_PREFIX in result.stderr, (
        f"the refusal must carry main()'s prefix: {result.stderr[-2000:]!r}"
    )
    assert marker in result.stderr, (
        f"the refusal must say the real thing ({marker!r}): {result.stderr[-2000:]!r}"
    )


# ── the two refusals ───────────────────────────────────────────────────────────────────


def test_TEST_77_the_445_bundle_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-77 [acceptance INV-1/INV-2] — the #445 bundle: `/matrix/data` and
    `/matrix/indices` both truncated to length 0, `/matrix/indptr` = `n_barcodes + 1`
    zeros, `/matrix/shape` unchanged.

    Every one of `refuse_malformed_counts`'s pre-#445 checks passes VACUOUSLY: all three
    members are present, are datasets, are 1-D, are integer/numeric-typed;
    `len(data) == len(indices)` is `0 == 0`; `len(indptr) == n_barcodes + 1` is
    `121 == 121`; `indptr[0] == 0` and non-decreasing hold throughout;
    `indptr[-1] == len(indices)` is `0 == 0`; and the `indices` range scan has nothing to
    scan. MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=117  expression.zarr present with nnz=0

    The import SUCCEEDED: a manifest was written, 117 paths landed, and the store held
    nnz=0 — the operator told it SUCCEEDED and downstream analysis ran on an empty matrix.
    Post-fix the refusal names the emptiness, states the declared counts, and points at
    `metrics_summary.csv` and the raw matrix so an operator can tell a damaged file from a
    real but empty run.
    """
    bundle = _copy(tmp_path, "t445-empty-nnz")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["data"]
        m.create_dataset("data", data=np.array([], dtype=np.int32))
        del m["indices"]
        m.create_dataset("indices", data=np.array([], dtype=np.int64))
        del m["indptr"]
        m.create_dataset("indptr", data=np.zeros(n_barcodes + 1, dtype=np.int64))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused_empty(result, out, marker=_EMPTY_MATRIX_MARKER)
    assert b"metrics_summary.csv" in result.stderr, (
        "the refusal must point at `metrics_summary.csv` so an operator can tell a "
        f"damaged file from a real but empty run: {result.stderr[-2000:]!r}"
    )
    assert b"raw_feature_bc_matrix.h5" in result.stderr, (
        "the refusal must name the raw matrix so an operator can tell a damaged file "
        f"from a real but empty run: {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this empty matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this empty matrix impossible: {result.stderr[-2000:]!r}"
    )


def test_TEST_78_a_zero_barcodes_bundle_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-78 [acceptance INV-1/INV-2] — the zero-barcodes bundle: `/matrix/barcodes`
    length 0, with `/matrix/shape` and `/matrix/indptr` made consistent.

    This is the documented "empty" case — a capture area with no tissue detected — and it
    is the case the sibling importer (`spatial-import-visium-hd`) already refuses before
    its first writer. MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=107  SILENT EMPTY IMPORT

    The import SUCCEEDED: 107 paths landed and the store held nnz=0 — the operator told it
    SUCCEEDED and a tissue map with nothing on it. (The importer's only empty-barcodes
    refusal lives in `unverified_space_id`, reached AFTER the first writer — and with an
    identifying `library_ids` present it is not even reached.) Post-fix the refusal fires
    BEFORE the first writer, so the outputs tree is EMPTY.

    THE ZERO-PATHS ASSERTION IS THE WHOLE POINT OF THIS TEST: it is what pins the ordering
    fix, and it is the assertion that fails on today's code.
    """
    bundle = _copy(tmp_path, "t445-zero-barcodes")
    n_features, _n_barcodes = _fixture_shape()
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        del m["barcodes"]
        m.create_dataset("barcodes", data=np.array([], dtype="S18"))
        del m["shape"]
        m.create_dataset("shape", data=np.array([n_features, 0], dtype=np.int32))
        del m["data"]
        m.create_dataset("data", data=np.array([], dtype=np.int32))
        del m["indices"]
        m.create_dataset("indices", data=np.array([], dtype=np.int64))
        del m["indptr"]
        m.create_dataset("indptr", data=np.array([0], dtype=np.int64))
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused_empty(result, out, marker=b"carries no barcodes at all")
    assert b"Check that Space Ranger detected tissue on this run" in result.stderr, (
        "the refusal must point the operator at the real-but-empty case, mirroring the "
        f"sibling importer's wording: {result.stderr[-2000:]!r}"
    )


# ── the two controls ───────────────────────────────────────────────────────────────────


def test_TEST_79_the_unmutated_fixture_still_imports(tmp_path):
    r"""TEST-79 [acceptance INV-1/INV-2] — THE NEGATIVE CONTROL, the unmutated fixture.

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

    with h5py.File(VF.FIXTURE / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    data = VF.read_member(out, "expression.zarr", "data")
    indices = VF.read_member(out, "expression.zarr", "indices")
    indptr = VF.read_member(out, "expression.zarr", "indptr")
    assert len(data) == nnz == 17677, len(data)
    assert len(indices) == len(data) == 17677, (len(indices), len(data))
    assert int(indptr[0]) == 0, int(indptr[0])
    assert int(indptr[-1]) == nnz == 17677, int(indptr[-1])


def test_TEST_80_a_small_but_nonzero_nnz_is_not_refused_as_empty(tmp_path):
    r"""TEST-80 [acceptance INV-1/INV-2] — the not-over-refused control: a bundle with a
    SMALL but NON-ZERO `nnz`.

    `/matrix/data` and `/matrix/indices` are truncated to ONE stored value and
    `/matrix/indptr` is repaired so the matrix stays internally consistent:
    `indptr = [0, 1, 1, ..., 1]` (length `n_barcodes + 1`, non-decreasing,
    `indptr[-1] == 1 == len(indices)`). `nnz == 1`, so Refusal B must NOT fire — this is
    what stops the empty-matrix refusal from being an over-broad refusal that rejects any
    matrix with FEW stored values. (The #349 verification round specifically tested that
    the validation was free of over-broad refusal; a `float32` `/matrix/data` still
    imports at rc 0 and must continue to.)

    THE CONTROL PROVES ITS OWN MUTATION: the mutated file is re-opened and `/matrix/data`
    and `/matrix/indices` are asserted to be length 1 with `indptr` the repaired vector,
    so a mutation that silently failed cannot make this test pass vacuously. And the
    positive outcome is asserted, not only the absence of the refusal: a one-stored-value
    matrix is internally consistent, so the bundle imports at rc 0 (MEASURED through the
    shipped entrypoint) and the store holds exactly one stored value — the empty-matrix
    marker must be absent from stderr.
    """
    bundle = _copy(tmp_path, "t445-small-nnz")
    _n_features, n_barcodes = _fixture_shape()
    repaired_indptr = np.array([0] + [1] * n_barcodes, dtype=np.int64)
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        first_data = m["data"][:1]
        first_indices = m["indices"][:1]
        del m["data"]
        m.create_dataset("data", data=first_data)
        del m["indices"]
        m.create_dataset("indices", data=first_indices)
        del m["indptr"]
        m.create_dataset("indptr", data=repaired_indptr)
    # THE MUTATION TOOK EFFECT — re-open the mutated file and prove it, so a silently
    # failed mutation cannot make this control pass without having tested anything.
    with h5py.File(bundle / MATRIX, "r") as handle:
        m = handle["matrix"]
        assert len(m["data"]) == 1, len(m["data"])
        assert len(m["indices"]) == 1, len(m["indices"])
        indptr = m["indptr"][:]
        assert len(indptr) == n_barcodes + 1, len(indptr)
        assert int(indptr[0]) == 0, int(indptr[0])
        assert int(indptr[-1]) == 1, int(indptr[-1])
        assert bool(np.array_equal(indptr, repaired_indptr)), (
            "the repaired indptr did not land in the mutated file"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    # THE POSITIVE OUTCOME: a one-stored-value matrix is internally consistent, so it must
    # import at rc 0 — not be refused. (MEASURED through the shipped entrypoint.)
    assert result.returncode == 0, (
        f"a one-stored-value matrix must import at rc 0, got rc={result.returncode}; "
        f"stderr tail: {result.stderr[-2000:]!r}"
    )
    data = VF.read_member(out, "expression.zarr", "data")
    indices = VF.read_member(out, "expression.zarr", "indices")
    indptr = VF.read_member(out, "expression.zarr", "indptr")
    assert len(data) == 1, len(data)
    assert len(indices) == 1, len(indices)
    assert int(indptr[0]) == 0, int(indptr[0])
    assert int(indptr[-1]) == 1, int(indptr[-1])
    assert _EMPTY_MATRIX_MARKER not in result.stderr, (
        "a matrix with a small but NON-ZERO nnz must not hit the empty-matrix refusal: "
        f"{result.stderr[-2000:]!r}"
    )


# ── #474: the all-zero `data` refusal and its control ────────────────────────────────


def test_TEST_114_an_all_zero_data_matrix_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-114 [acceptance INV-1/INV-2] — the #474 shape: `nnz > 0` but every
    `/matrix/data` value is exactly 0.

    `/matrix/data` is set to all zeros IN PLACE (same length 17677, same int32 dtype),
    so the matrix stays internally consistent: `len(data) == len(indices) == 17677`,
    `indptr[-1] == 17677`, every `indices` value in range. Every pre-#474 check passes —
    the members are present, 1-D, numeric-typed, the lengths agree, `indptr` is valid,
    `nnz == 17677 > 0`, and the `indices` range scan is clean. MEASURED pre-fix through
    the shipped entrypoint:

        rc=0  paths=117  SILENT ALL-ZERO IMPORT

    The import SUCCEEDED: a manifest was written, 117 paths landed, and the store held
    nnz=17677 with every value 0 — the operator told it SUCCEEDED and downstream
    analysis ran on a matrix whose every stored value is 0. Post-fix the refusal names
    the all-zero condition, states the stored-value count and the declared counts, and
    points at `metrics_summary.csv` and the raw matrix so an operator can tell a damaged
    file from a real but empty run.
    """
    bundle = _copy(tmp_path, "t474-all-zero-data")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        data[:] = 0
        del m["data"]
        m.create_dataset("data", data=data)
    # THE MUTATION TOOK EFFECT — re-open and prove every stored value is 0, so a
    # silently failed mutation cannot make this test pass vacuously.
    with h5py.File(bundle / MATRIX, "r") as handle:
        assert len(handle["matrix"]["data"]) == len(data), len(handle["matrix"]["data"])
        assert not bool(np.any(handle["matrix"]["data"][:])), (
            "the all-zero mutation did not land"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused_empty(result, out, marker=b"every one of them exactly 0")
    assert b"metrics_summary.csv" in result.stderr, (
        "the refusal must point at `metrics_summary.csv` so an operator can tell a "
        f"damaged file from a real but empty run: {result.stderr[-2000:]!r}"
    )
    assert b"raw_feature_bc_matrix.h5" in result.stderr, (
        "the refusal must name the raw matrix so an operator can tell a damaged file "
        f"from a real but empty run: {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this all-zero matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this all-zero matrix impossible: {result.stderr[-2000:]!r}"
    )


def test_TEST_115_a_matrix_with_some_stored_zeros_still_imports(tmp_path):
    r"""TEST-115 [acceptance INV-1/INV-2] — the not-over-refused control for #474: a
    matrix with `nnz > 0`, SOME stored zeros and SOME non-zeros still imports at rc 0.

    Sparse formats legitimately permit explicitly stored zeros, so "some stored zeros
    among non-zeros" is unremarkable and must NOT fire the all-zero refusal. The first
    100 stored values are set to 0 in place (the rest stay non-zero), so the matrix
    stays internally consistent. MEASURED through the shipped entrypoint: rc 0, a
    manifest written, and the store holds the same nnz with the non-zero values intact.
    """
    bundle = _copy(tmp_path, "t474-some-zeros")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert bool(np.any(data)), (
            "the fixture must have non-zero values for this control to mean anything"
        )
        data[:100] = 0
        assert bool(np.any(data)), "the control must still have non-zero values"
        del m["data"]
        m.create_dataset("data", data=data)
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    assert result.returncode == 0, (
        f"a matrix with some stored zeros and some non-zeros must import at rc 0, got "
        f"rc={result.returncode}; stderr tail: {result.stderr[-2000:]!r}"
    )
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    data = VF.read_member(out, "expression.zarr", "data")
    assert len(data) == 17677, len(data)
    assert bool(np.any(data)), "the store must still hold the non-zero values"
    assert b"every one of them exactly 0" not in result.stderr, (
        "a matrix with some stored zeros and some non-zeros must not hit the all-zero "
        f"refusal: {result.stderr[-2000:]!r}"
    )


# ── #548: the all-non-finite `data` refusals and their over-refusal control ────────────


def test_TEST_127_an_all_NaN_data_matrix_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-127 [acceptance, INV-1 + INV-4] — the #548 shape, NaN: `nnz > 0` but every
    `/matrix/data` value is NaN.

    `np.any(blk)` treats NaN as truthy (NaN != 0), so the #474 all-zero check never fired
    on this shape: the matrix (dtype kind `f`, which passes the `"iufb"` gate) imported at
    rc 0 with unusable "counts". The #548 scan predicate is "usable = FINITE AND
    NON-ZERO", so an all-NaN `/matrix/data` is now refused BEFORE the first writer, and
    the message is the NON-FINITE diagnosis — and it names both readings honestly,
    exactly as the all-zero message does (a corrupt or mis-written file, OR a genuine
    run whose reads produced no usable UMI and whose matrix was then damaged or
    truncated). What separates the two no-usable-value messages (the non-finite one
    and the all-zero one) is not the readings — both name both — but the tell-apart
    pointer: the ALL-ZERO message additionally
    names the operator-visible way to tell them apart (`metrics_summary.csv` /
    `raw_feature_bc_matrix.h5`) while the non-finite one deliberately does not (pinned
    by this test's own assertions below). MEASURED post-fix through the shipped
    entrypoint: rc 2, zero output paths.
    """
    bundle = _copy(tmp_path, "t548-all-nan")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        nan_data = np.full(len(data), np.nan, dtype=np.float32)
        del m["data"]
        m.create_dataset("data", data=nan_data)
    # THE MUTATION TOOK EFFECT — re-open and prove every stored value is NaN, so a
    # silently failed mutation cannot make this test pass vacuously.
    with h5py.File(bundle / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(data), len(mutated)
        assert bool(np.isnan(mutated).all()), "the all-NaN mutation did not land"
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused_empty(result, out, marker=b"every one of them non-finite")
    # TEST-127 (#615): the corrected sentence/certainty — the vendor fact is the block's
    # OWN INFERRED reading (no vendor-wide claim), and BOTH readings are possible and
    # cannot be told apart from this file alone. Pinned from the EMITTED stderr.
    assert b"a matrix of real read counts stores" in result.stderr, (
        "the corrected non-finite refusal must state the inferred READING (\"a matrix of "
        f"real read counts stores\"), never the vendor-wide settled fact: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"the two cannot be told apart from this file alone" in result.stderr, (
        "the corrected non-finite refusal must align its certainty with the mixed "
        f"message's (BOTH readings possible): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them exactly 0" not in result.stderr, (
        "the all-zero refusal must NOT fire on an all-NaN matrix — the two diagnoses are "
        f"distinguished (#548): {result.stderr[-2000:]!r}"
    )
    assert b"metrics_summary.csv" not in result.stderr, (
        "the non-finite message must not name the all-zero diagnosis's tell-apart "
        "pointer (`metrics_summary.csv`) — both messages name both readings, so this "
        "pointer is what keeps the two diagnoses distinguishable in the operator-"
        f"facing text: {result.stderr[-2000:]!r}"
    )
    assert f"{len(data)} stored value(s)".encode() in result.stderr, (
        "the refusal must state the stored-value count (nnz), so the operator sees how "
        f"many values were non-finite: {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )


def test_TEST_128_an_all_Inf_data_matrix_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-128 [acceptance, INV-1 + INV-4] — the #548 shape, Inf: `nnz > 0` but every
    `/matrix/data` value is +Infinity.

    Inf is the other non-finite spelling of the same no-usable-value boundary: `np.any`
    treated it as truthy too, so an all-Inf matrix imported at rc 0 with unusable counts.
    Post-fix it is refused with the SAME non-finite diagnosis and marker as all-NaN (it is
    not a different defect), and the all-zero marker stays absent — the two diagnoses are
    distinguished, not collapsed into one sentence. MEASURED post-fix: rc 2, zero output
    paths.
    """
    bundle = _copy(tmp_path, "t548-all-inf")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        inf_data = np.full(len(data), np.inf, dtype=np.float32)
        del m["data"]
        m.create_dataset("data", data=inf_data)
    # THE MUTATION TOOK EFFECT — re-open and prove every stored value is Inf, so a
    # silently failed mutation cannot make this test pass vacuously.
    with h5py.File(bundle / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(data), len(mutated)
        assert bool(np.isinf(mutated).all()), "the all-Inf mutation did not land"
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused_empty(result, out, marker=b"every one of them non-finite")
    # TEST-128 (#615): one-line presence check — the corrected both-readings certainty is
    # on the emitted stderr here too (same corrected sentence as all-NaN).
    assert b"the two cannot be told apart from this file alone" in result.stderr, (
        "the all-Inf refusal must carry the corrected #615 certainty (both readings "
        f"possible): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them exactly 0" not in result.stderr, (
        "the all-zero refusal must NOT fire on an all-Inf matrix — the two diagnoses are "
        f"distinguished (#548): {result.stderr[-2000:]!r}"
    )
    assert b"metrics_summary.csv" not in result.stderr, (
        "the non-finite message must not name the all-zero diagnosis's tell-apart "
        "pointer (`metrics_summary.csv`) — both messages name both readings, so this "
        "pointer is what keeps the two diagnoses distinguishable in the operator-"
        f"facing text: {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )


def test_TEST_129_a_matrix_with_some_NaN_among_real_counts_still_imports(tmp_path):
    r"""TEST-129 [acceptance, INV-2] — THE OVER-REFUSAL GUARD for #548: a matrix with
    real counts plus a FEW NaN values still imports at rc 0.

    The boundary is ALL stored values unusable, mirroring #474's "every one of them
    exactly 0" — a matrix that merely CONTAINS some NaN is not a corrupt file, and
    refusing it would reject real vendor data with occasional sanitised/dropped values.
    The fixture's counts are widened to float32 (the dtype nothing here may assume),
    exactly 3 of the 17677 stored values are forced to NaN, and the rest are UNCHANGED.
    MEASURED through the shipped entrypoint: rc 0, a manifest written, the store still
    holds the non-zero values, and NEITHER marker is on stderr.
    """
    bundle = _copy(tmp_path, "t548-some-nan")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        assert bool(np.any(data)), (
            "the fixture must have non-zero values for this control to mean anything"
        )
        as_float = data.astype(np.float32)
        original = as_float.copy()
        as_float[:3] = np.nan
        assert bool(np.any(as_float[3:])), "the control must still have non-zero values"
        del m["data"]
        m.create_dataset("data", data=as_float)
    # THE MUTATION TOOK EFFECT — re-open and prove exactly the first 3 values are NaN and
    # every other value is byte-equal to the fixture's cast, so a silently failed mutation
    # cannot make this control pass vacuously.
    with h5py.File(bundle / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(as_float), len(mutated)
        assert bool(np.isnan(mutated[:3]).all()), "the NaN mutation did not land at positions 0..2"
        assert not bool(np.isnan(mutated[3:]).any()), "the mutation leaked beyond the 3 values"
        assert np.array_equal(mutated[3:], original[3:]), (
            "the non-NaN values were altered by the mutation"
        )
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    assert result.returncode == 0, (
        f"a matrix with real counts plus a few NaN values must import at rc 0, got "
        f"rc={result.returncode}; stderr tail: {result.stderr[-2000:]!r}"
    )
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    with h5py.File(VF.FIXTURE / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    data = VF.read_member(out, "expression.zarr", "data")
    assert len(data) == nnz, len(data)
    assert bool(np.any(np.isfinite(data) & (data != 0))), (
        "the store must still hold the non-zero values"
    )
    assert b"every one of them exactly 0" not in result.stderr, (
        "a matrix with some NaN among real counts must not hit the all-zero refusal: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"every one of them non-finite" not in result.stderr, (
        "a matrix with some NaN among real counts must not hit the non-finite refusal "
        f"(the boundary is ALL stored values unusable): {result.stderr[-2000:]!r}"
    )


def test_TEST_130_a_matrix_that_is_a_mix_of_zeros_and_NaN_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-130 [acceptance, INV-1 + INV-4] — the #548 MIXED shape: `nnz > 0` but every
    `/matrix/data` value is either exactly 0 or NaN, with NO finite non-zero value.

    This is the shape the pure diagnoses do NOT name truthfully: the all-zero message's
    "every one of them exactly 0" is FALSE for the NaN values, and the non-finite message's
    "every one of them non-finite" is FALSE for the zeros — so the refused matrix gets its
    OWN third diagnosis ("not one of them a usable count"), which states BOTH readings
    honestly (a corrupt/mis-written FILE, OR a run that found no usable UMI and was then
    damaged or truncated) and takes the operator-signal stance. MEASURED post-fix through
    the shipped entrypoint: rc 2, zero output paths.
    """
    bundle = _copy(tmp_path, "t548-mixed-zero-nan")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        mixed = np.zeros(len(data), dtype=np.float32)
        mixed[:3] = np.nan
        del m["data"]
        m.create_dataset("data", data=mixed)
    # THE MUTATION TOOK EFFECT — re-open and prove exactly the first 3 values are NaN and
    # every other value is exactly 0.0, so a silently failed mutation cannot make this test
    # pass vacuously.
    with h5py.File(bundle / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(data), len(mutated)
        assert bool(np.isnan(mutated[:3]).all()), "the NaN half of the mix did not land"
        assert bool(np.all(mutated[3:] == 0)), "the zero half of the mix did not land"
    out = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, out)

    _assert_refused_empty(result, out, marker=b"not one of them a usable count")
    # TEST-1 (#638): the corrected mixed-message head — the vendor fact is gone from the
    # EMITTED stderr (never names the vendor), the block's inferred reading is stated,
    # and the both-readings certainty is present. Scoped to stderr only: the manifest
    # changelog legitimately quotes the old form in the 0.23.0 entry's correction record.
    assert b"a matrix of real read counts produces" in result.stderr, (
        "the #638-corrected mixed refusal must state the inferred reading (\"a matrix "
        f"of real read counts produces\"), never the vendor-wide settled fact: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"well-formed" not in result.stderr, (
        f"the mixed refusal must not name the vendor's format as well-formed (#638): "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"a well-formed 10x Space Ranger matrix" not in result.stderr, (
        "the mixed refusal must not state the vendor-wide settled fact — scoped to the "
        "PHRASE (the run's own `progress: read|5|reading the Space Ranger bundle` line "
        f"legitimately names the vendor): {result.stderr[-2000:]!r}"
    )
    assert b"the two cannot be told apart from this file alone" in result.stderr, (
        "the mixed refusal must keep the BOTH-readings certainty (the two readings "
        f"cannot be told apart from this file alone): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them exactly 0" not in result.stderr, (
        "the all-zero refusal must NOT fire on a mixed matrix — neither pure diagnosis "
        f"names it (#548): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them non-finite" not in result.stderr, (
        "the non-finite refusal must NOT fire on a mixed matrix — neither pure diagnosis "
        f"names it (#548): {result.stderr[-2000:]!r}"
    )
    assert b"metrics_summary.csv" not in result.stderr, (
        "the mixed refusal must not borrow the all-zero diagnosis's cleanup pointers "
        f"verbatim: {result.stderr[-2000:]!r}"
    )
    assert f"{len(data)} stored value(s)".encode() in result.stderr, (
        "the refusal must state the stored-value count (nnz), so the operator sees how "
        f"many values were in the mix: {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
