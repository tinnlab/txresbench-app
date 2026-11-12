#!/usr/bin/env python3
# ruff: noqa
r"""An EMPTY `/matrix` is a REFUSAL, and it fires BEFORE the first writer (#470).

`run_import` reads the 10x `/matrix` group and hands it straight to
`txr_csc.H5CsrSource` and then `txr_csc.write_csc_zarr` — the FIRST WRITER, which
creates `outputs/expression.zarr`. #470 adds one refusal to the matrix's own internal
consistency block, inside the `with h5py.File(...) as h5:` context, immediately BEFORE
`txr_csc.H5CsrSource(...)` — strictly before the first writer:

  * **The `n_barcodes == 0` refusal** (already present, the OTHER end of the ladder). The
    matrix carries no barcodes at all — the documented "empty" case, a capture area with
    no tissue detected. It is refused at the barcode-join section, before any member of
    the CSC triple is handed to the writer.
  * **The `nnz == 0` with `n_barcodes > 0` refusal (the #470 shape).** `/matrix/data` and
    `/matrix/indices` are both empty while the matrix declares barcodes and features.
    Every internal-consistency check passes VACUOUSLY on this shape — `len(indptr) ==
    n_barcodes + 1`, monotonic, `indptr[0] == 0`, `indptr[-1] == nnz` (0 == 0),
    `len(indices) == nnz` (0 == 0), and the id-range scan is skipped because `if nnz:` is
    False — so pre-#470 it imported at rc 0 with a complete `expression.zarr` holding
    nnz=0, reported as SUCCESS. The reason is the same one that carries the
    `n_barcodes == 0` refusal: an empty matrix imports at exit 0 and is reported as
    SUCCESS, and there is no outcome reported to the operator as anything other than
    SUCCESS — the process exits 0 and emits the identical `progress("done", 100, ...)`
    line whether the matrix is empty or full, and the report's `image_warnings` / note
    fields are PASSIVE (they change nothing about the exit code or stderr and are only
    visible to someone who opens the report artifact) — and the claim is SCOPED PER SHAPE
    (#613): for the zero-barcode shape the emptiness IS visible in the stream and the
    report (with the empty-matrix refusals set aside it streams `progress: matrix|35|0
    bins x N genes` and `progress: coordinates|60|0 bin positions` and its report states `n_bins: 0` /
    `n_bins_in_tissue: 0`), while for the `nnz == 0` shape the streamed progress and the
    report are byte-identical to a real import, so there the operator-visible signal does
    not distinguish it from a real one — the operator is told
    the import SUCCEEDED and downstream analysis runs on nothing. This one reason carries
    BOTH refusals. As an aside, the emptiness has two possible causes — a damaged or
    truncated file, or a genuine run in which no read yielded a usable UMI (tissue
    detected, library or sequencing failed) — and the refusal message names
    `metrics_summary.csv`'s "Number of Bins Under Tissue" and `raw_feature_bc_matrix.h5`
    so an operator can tell them apart, and names the bin because HD is multi-bin. It is
    refused where `nnz` is proven, after the two length checks and the `indptr` content
    checks. The neighbouring shape — `nnz > 0` but every `/matrix/data` value equal to 0 —
    is refused too (#533), by the blockwise all-zero scan that sits immediately after this
    refusal and before the first writer, and is covered by TEST-82/83/84 in this file.
    #548 extends that scan from "every value exactly 0" to "NO usable stored value"
    (usable = finite and non-zero): a matrix whose every stored value is NaN or Inf is
    refused too, with its OWN message (corrupt-file diagnosis), covered by TEST-84/85
    here, while a matrix that merely CONTAINS some NaN/Inf among real counts still
    imports (TEST-86, the over-refusal guard).

The invariants under test are this package's own numbers
(`docs/design/vendor-text-encodability-refusal.md` §6.5):

  INV-8 — the refusal fires BEFORE any artifact byte is written, so a refused import leaves
          no store, no partial store and nothing for a later reader to find.
  INV-9 — a bundle this importer cannot carry is REFUSED BY NAME (`VisiumImportError`),
          never a traceback and never an exit-1.

The committed fixture is MEASURED, not re-derived: `/matrix/shape` is int32 [40, 52]
(n_features=40, n_barcodes=52), `/matrix/data` is int32 (627,), `/matrix/indices` is
int64 (627,), and `/matrix/indptr` is int64 (53,) with indptr[0]=0 and indptr[-1]=627.
The tests derive `n_barcodes` and `n_features` from the fixture's own `/matrix/shape`
rather than hardcoding them, so a fixture change cannot silently invalidate them.

Damage is always done to a COPY of the committed fixture; the fixture itself is never
modified.

Which test pins what: TEST-72 is the acceptance test in THIS file that fails if the #470
refusal is deleted; the `matrix-no-stored-values` and `matrix-no-stored-values-16um` rows in
`hd_hostile_bundles.REFUSALS` (exercised by `test_refusals.py` and `test_zero_partial_store.py`)
also guard it. TEST-73 is a regression guard on the PRE-EXISTING
`n_barcodes == 0` refusal. TEST-74 and TEST-75 are CONTROLS that pass whether or not the
new refusal exists (TEST-74 stops a validator that refuses EVERYTHING from passing; TEST-75
stops the empty-matrix refusal from being over-broad). TEST-82 is the acceptance test for
the #533 all-zero refusal (the sibling's #474 decision ported into HD); TEST-83 is its
some-zeros control; TEST-84 is the #548 all-NaN REFUSAL — the boundary the #533 text
declared out of scope is now claimed by this importer too, with TEST-85 (all-Inf)
beside it and TEST-86 as its some-NaN positive control: the boundary is ALL stored
values unusable, so a matrix that merely CONTAINS some NaN/Inf still imports. A
declared control is fine; an undeclared one reads like a guard.
"""
import json
import sys
from pathlib import Path

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import hd_hostile_bundles as HB  # noqa: E402

MATRIX = "filtered_feature_bc_matrix.h5"
BIN_DIR = "binned_outputs/square_008um"

#: The prefix `main()` puts on every refusal it prints.
_REFUSAL_PREFIX = b"spatial.import-visium-hd: "

#: The marker sentence of the #470 refusal — the empty-matrix refusal.
_EMPTY_MATRIX_MARKER = b"`/matrix/data` and `/matrix/indices` are both empty"

#: #503(2)'s false-as-stated phrasing, assembled from two literals so THIS file
#: never carries the contiguous phrase that TEST-111 forbids in every `.py`/`.yaml`
#: under the package except its own (at runtime the bytes are exactly that
#: phrasing, so the absence assertion below is still a verbatim pin).
_503_WARNING_PHRASING = b"succeeded with a " + b"warning"


def _staged(tmp_path, bundle):
    """Mount one bundle as the `bundle` slot and return its `/inputs` dir."""
    inputs = tmp_path / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    staged = inputs / Path(bundle).name
    staged.symlink_to(Path(bundle).resolve(), target_is_directory=True)
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": "bundle", "kind": "dataset",
                    "sandbox_path": f"/inputs/{staged.name}"}]
    }), encoding="utf-8")
    return inputs


def _fixture_shape():
    """The committed fixture's real `/matrix/shape`, read from the file — never hardcoded."""
    with h5py.File(HF.FIXTURE / BIN_DIR / MATRIX, "r") as handle:
        shape = handle["matrix"]["shape"][:]
    return int(shape[0]), int(shape[1])


def _assert_refused_empty(result, out, *, marker):
    """The four legs every #470 refusal test must assert (INV-8 and INV-9), plus the wording.

    1. `returncode == 2` — a NAMED refusal, never 0 and never 1 (INV-9).
    2. no `Traceback` on stderr — INV-9's prohibited outcome.
    3. the outputs tree is EMPTY — no store, no partial store, no manifest, nothing for a
       later reader to find (INV-8).
    4. the refusal carries `main()`'s `spatial.import-visium-hd:` prefix and the exact
       sentence that says what is wrong, so the test pins the real wording rather than any
       refusal at all.
    """
    assert result.returncode == 2, (
        f"expected a NAMED refusal (rc=2), got rc={result.returncode}; "
        f"stderr tail: {result.stderr[-2000:]!r}"
    )
    assert b"Traceback" not in result.stderr, (
        f"a traceback, not a named refusal (INV-9): {result.stderr[-2000:]!r}"
    )
    left = HF.output_paths(out)
    assert left == [], (
        f"a refused import left {len(left)} path(s) behind (INV-8): {left[:12]}"
    )
    assert _REFUSAL_PREFIX in result.stderr, (
        f"the refusal must carry main()'s prefix: {result.stderr[-2000:]!r}"
    )
    assert marker in result.stderr, (
        f"the refusal must say the real thing ({marker!r}): {result.stderr[-2000:]!r}"
    )


# ── the two refusals ───────────────────────────────────────────────────────────────────


def test_TEST_72_the_470_bundle_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-72 [acceptance, INV-8 + INV-9] — the #470 bundle: `/matrix/data` and
    `/matrix/indices` both truncated to length 0, `/matrix/indptr` = `n_barcodes + 1`
    zeros, `/matrix/shape` and `/matrix/barcodes` UNCHANGED.

    Every one of the internal-consistency checks passes VACUOUSLY on this shape: all three
    members are present, are datasets, are 1-D, are integer-typed; `len(indptr) ==
    n_barcodes + 1` is `53 == 53`; monotonic; `indptr[0] == 0`; `indptr[-1] == nnz` is
    `0 == 0`; `len(indices) == nnz` is `0 == 0`; and the `indices` range scan has nothing
    to scan. MEASURED pre-fix through the shipped entrypoint:

        rc=0  paths=118  import SUCCEEDED (17 outputs, nnz=0 written)

    The import SUCCEEDED: a manifest was written, 118 paths landed, and the store held
    nnz=0 — the operator told it SUCCEEDED and downstream analysis ran on an empty matrix.
    Post-fix the refusal names the emptiness, states the declared counts and the bin, and
    points at `metrics_summary.csv` and the raw matrix so an operator can tell a damaged
    file from a real but empty run.
    """
    bundle = HB.a_matrix_with_no_stored_values(tmp_path / "t470-empty-nnz")
    n_features, n_barcodes = _fixture_shape()
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    _assert_refused_empty(result, out, marker=_EMPTY_MATRIX_MARKER)
    assert b"Number of Bins Under Tissue" in result.stderr, (
        "the refusal must point at `metrics_summary.csv`'s HD field \"Number of Bins "
        "Under Tissue\" (the non-HD Visium field is \"Number of Spots Under Tissue\" and "
        "must NOT be used), so an operator can tell a damaged file from a real but empty "
        f"run: {result.stderr[-2000:]!r}"
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
    assert f"{HF.load_compute().DEFAULT_BIN_UM} um bin".encode() in result.stderr, (
        "the refusal must name the bin, because HD is multi-bin and the operator needs to "
        "know which bin was empty. Derived from the module's own `DEFAULT_BIN_UM` rather "
        "than a hardcoded 8, so a product-default change cannot make this fail while the "
        f"refusal names the bin correctly: {result.stderr[-2000:]!r}"
    )


def test_TEST_73_a_zero_barcodes_bundle_is_STILL_refused_before_the_first_writer(tmp_path):
    r"""TEST-73 [acceptance, INV-8 + INV-9] — the zero-barcodes bundle: `/matrix/barcodes`
    length 0, with `/matrix/shape` and `/matrix/indptr` made consistent.

    This is the OTHER end of the ladder — the documented "empty" case, a capture area with
    no tissue detected — and it was already refused before the first writer (the refusal at
    the barcode-join section of `run_import`). This test is the REGRESSION GUARD on that
    refusal: the #470 fix must not have moved or weakened it, and the two empty shapes
    must both refuse with zero paths on disk. (Note: this fixture ALSO has `nnz == 0` by
    construction, so this test accidentally pins "`nnz == 0` fires after the barcode-join
    refusal" — a DIFFERENT ordering question from #504's, which is "`nnz == 0` fires after
    the two length checks"; TEST-76 pins that one.)

    RE-POINTED BY #488, AND RE-POINTED AGAIN BY #613. The refusal's stated reason was
    RETRACTED as false by #488: the old sentence's distinguishability-and-empty-dataset
    claim is wrong for HD — an empty dataset is distinguishable once it exists, and the
    report carries the square and bin counts. The TRUE reason is scoped to the OUTCOME
    SIGNAL: an empty import exits 0 and is reported as SUCCESS, and there is no outcome
    REPORTED TO THE OPERATOR as anything other than SUCCESS — the process exits 0 and
    emits the same closing `progress("done", 100, ...)` line as a full import, and the
    report's `image_warnings` / note fields are PASSIVE. #613 sharpens the scope PER
    SHAPE with this shape's own measurement: with the empty-matrix refusals set aside the
    same import streams `progress: matrix|35|0 bins x N genes` and `progress:
    coordinates|60|0 bin positions` and its report states `n_bins: 0` /
    `n_bins_in_tissue: 0`, so the
    emptiness IS visible in the stream and the report — the surviving claim is only that
    no non-SUCCESS outcome exists. The assertions below pin that wording on the
    emitted stderr — a revert of the message to the retracted sentence drops all three
    substrings and turns this test RED. TEST-111 is the package-wide absence scan that
    forbids the retracted fragments AND the #613 class (the no-warning-outcome phrasing
    and the unscoped "nothing in the signal ... distinguishes" absolute) — its own file
    is the only place the forbidden fragments may appear verbatim — the manifest's
    hyphenated/ellipsised naming (no-'succeeded-with-a-warning'-outcome, "nothing in the
    signal ... distinguishes") is an explicit allowance, not a verbatim quote, and the
    TEST-111 Known ceiling records it. The standing
    controls this build still relies on, unchanged by #488, are re-cited here: TEST-74
    (the unmutated fixture still imports at rc 0 — the negative control that stops a
    validator refusing everything), TEST-75 (a small but non-zero nnz still imports —
    the over-refusal control for the empty-matrix refusal) and TEST-86 (real counts plus
    a few NaN still import — the #548 boundary control). The other standing guards this
    re-point must not break, re-verified green in this node's phase-8 battery: TEST-8
    (zero paths over every `HB.REFUSALS` row), TEST-9 (each refusal line is one ASCII
    line, bounded, ending in a sentence), TEST-26 (package registered), TEST-27 (the
    0.17.0 bump carries its changelog entry), TEST-28 (collected via `pytest.ini`),
    TEST-29 (every cited `#NNN` recorded in `tests/issue_states.json`) and TEST-31 (the
    import is byte-identical under an ASCII locale).
    """
    bundle = HB.a_matrix_with_no_barcodes(tmp_path / "t470-zero-barcodes")
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    _assert_refused_empty(result, out, marker=b"carries no barcodes at all")
    assert b"Check that Space Ranger detected tissue on this run" in result.stderr, (
        "the refusal must point the operator at the real-but-empty case, mirroring the "
        f"sibling importer's wording: {result.stderr[-2000:]!r}"
    )
    assert b"imports at exit 0 and is reported as SUCCESS" in result.stderr, (
        "the refusal must state the TRUE reason (#488): the empty import exits 0 and is "
        "reported as SUCCESS, so no signal the operator sees changes — the retracted "
        "reason the repair replaced would fail this pin: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"there is no outcome REPORTED TO THE OPERATOR as anything other than SUCCESS" in result.stderr, (
        "the refusal must scope the reason to the outcome signal, the thing the operator "
        "actually sees — the only outcome reported to the operator is SUCCESS, and for "
        "this shape the emptiness IS visible in the stream and the report (0 bins x N "
        f"genes, n_bins: 0): {result.stderr[-2000:]!r}"
    )
    assert b"Refusing rather than shipping an empty matrix as a successful import" in result.stderr, (
        "the refusal must ADD the sibling importer's closing sentence, as #488 specifies "
        f"(the 'Refusing rather than …' ending is part of the repair): "
        f"{result.stderr[-2000:]!r}"
    )


# ── the two controls ───────────────────────────────────────────────────────────────────


def test_TEST_74_the_unmutated_fixture_still_imports(tmp_path):
    r"""TEST-74 [acceptance, INV-8 + INV-9] — THE NEGATIVE CONTROL, the unmutated fixture.

    Every refusal assertion above would pass on a validator that refuses EVERYTHING. This
    is the test that stops that: the committed, unmutated bundle must still import — rc 0,
    a manifest written — and the store must still be correct: nnz 627 with
    len(indices) == len(data) == 627 and indptr[-1] == 627. Without this leg the whole
    file could be satisfied by a validator that refuses everything.
    """
    bundle = HF.staged_tree(tmp_path / "t470-good")
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["outputs"], manifest

    with h5py.File(HF.FIXTURE / BIN_DIR / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    assert nnz > 0, (
        "the committed fixture's matrix is EMPTY (nnz == 0), which would make this "
        "negative control VACUOUS: a validator that refuses everything would pass it "
        "with `0 == 0`. The fixture must carry stored values for TEST-74 to prove "
        "anything."
    )
    data = HF.read_member(out, "expression.zarr", "data")
    indices = HF.read_member(out, "expression.zarr", "indices")
    indptr = HF.read_member(out, "expression.zarr", "indptr")
    assert len(data) == nnz, len(data)
    assert len(indices) == len(data) == nnz, (len(indices), len(data))
    assert int(indptr[0]) == 0, int(indptr[0])
    assert int(indptr[-1]) == nnz, int(indptr[-1])


def test_TEST_75_a_small_but_nonzero_nnz_is_NOT_refused_as_empty(tmp_path):
    r"""TEST-75 [acceptance, INV-8 + INV-9] — the not-over-refused control: a bundle with a
    SMALL but NON-ZERO `nnz`.

    `/matrix/data` and `/matrix/indices` are truncated to ONE stored value and
    `/matrix/indptr` is repaired so the matrix stays internally consistent:
    `indptr = [0, 1, 1, ..., 1]` (length `n_barcodes + 1`, non-decreasing,
    `indptr[-1] == 1 == len(indices)`). `nnz == 1`, so the #470 refusal must NOT fire —
    this is what stops the empty-matrix refusal from being an over-broad refusal that
    rejects any matrix with FEW stored values.

    THE CONTROL PROVES ITS OWN MUTATION: the mutated file is re-opened and `/matrix/data`
    and `/matrix/indices` are asserted to be length 1 with `indptr` the repaired vector,
    so a mutation that silently failed cannot make this test pass vacuously. And the
    positive outcome is asserted, not only the absence of the refusal: a one-stored-value
    matrix is internally consistent, so the bundle imports at rc 0 (MEASURED through the
    shipped entrypoint) and the store holds exactly one stored value — the empty-matrix
    marker must be absent from stderr.
    """
    bundle = HF.staged_tree(tmp_path / "t470-small-nnz")
    path = bundle / BIN_DIR / MATRIX
    _n_features, n_barcodes = _fixture_shape()
    repaired_indptr = np.array([0] + [1] * n_barcodes, dtype=np.int64)
    with h5py.File(path, "r+") as handle:
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
    with h5py.File(path, "r") as handle:
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
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    # THE POSITIVE OUTCOME: a one-stored-value matrix is internally consistent, so it must
    # import at rc 0 — not be refused. (MEASURED through the shipped entrypoint.)
    assert result.returncode == 0, (
        f"a one-stored-value matrix must import at rc 0, got rc={result.returncode}; "
        f"stderr tail: {result.stderr[-2000:]!r}"
    )
    data = HF.read_member(out, "expression.zarr", "data")
    indices = HF.read_member(out, "expression.zarr", "indices")
    indptr = HF.read_member(out, "expression.zarr", "indptr")
    assert len(data) == 1, len(data)
    assert len(indices) == 1, len(indices)
    assert int(indptr[0]) == 0, int(indptr[0])
    assert int(indptr[-1]) == 1, int(indptr[-1])
    assert _EMPTY_MATRIX_MARKER not in result.stderr, (
        "a matrix with a small but NON-ZERO nnz must not hit the empty-matrix refusal: "
        f"{result.stderr[-2000:]!r}"
    )


def test_TEST_76_an_indptr_ENDING_AT_5_with_empty_data_is_refused_as_a_LENGTH_disagreement(tmp_path):
    r"""TEST-76 [acceptance, INV-8 + INV-9] — #504: `nnz == 0` but `indptr[-1] == 5`.

    The #470 emptiness refusal sits AFTER the two length checks, and its own comment
    states the premise: "after the two length checks above, nnz is trustworthy". This
    bundle is the shape that proves the position matters: `/matrix/data` and
    `/matrix/indices` are both empty (`nnz == 0`) while `/matrix/indptr` ends at 5, so
    the `indptr[-1] != nnz` check fires FIRST and must name the indptr/data disagreement
    — NOT the generic emptiness marker. If the #470 refusal were hoisted above the two
    length checks, the generic emptiness message would fire instead and this test would
    go red. (TEST-73 pins a DIFFERENT ordering question — `nnz == 0` vs. the barcode-join
    refusal — because its `a_matrix_with_no_barcodes` fixture also has `nnz == 0` by
    construction; this test pins `nnz == 0` vs. the two length checks.)
    """
    bundle = HB.a_matrix_with_no_stored_values_but_indptr_ENDING_AT_5(
        tmp_path / "t504-indptr-5")
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    _assert_refused_empty(
        result, out,
        marker=b"`/matrix/indptr` ends at 5 but `/matrix/data` holds 0 value(s)",
    )
    assert _EMPTY_MATRIX_MARKER not in result.stderr, (
        "the generic emptiness message fired instead of the indptr/data disagreement — "
        "the #470 refusal must sit AFTER the two length checks (#504): "
        f"{result.stderr[-2000:]!r}"
    )


# ── #533: the all-zero `data` refusal and its controls ────────────────────────────────


def test_TEST_82_an_all_zero_data_matrix_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-82 [acceptance, INV-8 + INV-9] — the #533 shape: `nnz > 0` but every
    `/matrix/data` value is exactly 0.

    `/matrix/data` is set to all zeros IN PLACE (same length 627, same int32 dtype),
    so the matrix stays internally consistent: `len(data) == len(indices) == 627`,
    `indptr[-1] == 627`, every `indices` value in range. Every pre-#533 check passes —
    the members are present, 1-D, numeric-typed, the lengths agree, `indptr` is valid,
    `nnz == 627 > 0`, and the `indices` range scan is clean. MEASURED pre-fix through
    the shipped entrypoint:

        rc=0  paths=120  SILENT ALL-ZERO IMPORT

    The import SUCCEEDED: a manifest was written, 120 paths landed, and the store held
    nnz=627 with every value 0 — the operator told it SUCCEEDED and downstream analysis
    ran on a matrix whose every stored value is 0. Post-fix the refusal names the
    all-zero condition, states the stored-value count and the declared counts, names
    the bin, and points at `metrics_summary.csv` and the raw matrix so an operator can
    tell a damaged file from a real but empty run.

    The #613 fix round adds two wording pins to this test. The message's corrected
    outcome-signal claim — "there is no outcome REPORTED TO THE OPERATOR as anything
    other than SUCCESS", scoped to this shape — is asserted on the emitted stderr, and
    the old no-`'succeeded-with-a-warning'`-outcome phrasing it replaced (#503(2)) is
    asserted ABSENT from the shipped stderr (TEST-111 is the package-wide absence
    sweep; these two pins are what make THIS refusal's stderr agree with it).
    """
    bundle = HF.staged_tree(tmp_path / "t533-all-zero-data")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / BIN_DIR / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        data[:] = 0
        del m["data"]
        m.create_dataset("data", data=data)
    # THE MUTATION TOOK EFFECT — re-open and prove every stored value is 0, so a
    # silently failed mutation cannot make this test pass vacuously.
    with h5py.File(bundle / BIN_DIR / MATRIX, "r") as handle:
        assert len(handle["matrix"]["data"]) == len(data), len(handle["matrix"]["data"])
        assert not bool(np.any(handle["matrix"]["data"][:])), (
            "the all-zero mutation did not land"
        )
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    _assert_refused_empty(result, out, marker=b"every one of them exactly 0")
    assert b"Number of Bins Under Tissue" in result.stderr, (
        "the refusal must point at `metrics_summary.csv`'s HD field \"Number of Bins "
        "Under Tissue\" (the non-HD Visium field is \"Number of Spots Under Tissue\" and "
        "must NOT be used), so an operator can tell a damaged file from a real but empty "
        f"run: {result.stderr[-2000:]!r}"
    )
    assert b"Number of Spots Under Tissue" not in result.stderr, (
        "the refusal must use the HD vocabulary (\"Number of Bins Under Tissue\"), never "
        "the non-HD Visium field \"Number of Spots Under Tissue\" -- the negative pins the "
        "HD-vocabulary boundary, so a regression that emitted the wrong field alongside "
        f"the right one cannot pass: {result.stderr[-2000:]!r}"
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
    with h5py.File(HF.FIXTURE / BIN_DIR / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    assert f"{nnz} stored value(s)".encode() in result.stderr, (
        "the refusal must state the stored-value count (nnz), so the operator sees how "
        "many values were all zero rather than only the declared counts -- the docstring "
        f"promises the count is stated: {result.stderr[-2000:]!r}"
    )
    assert f"{HF.load_compute().DEFAULT_BIN_UM} um bin".encode() in result.stderr, (
        "the refusal must name the bin, because HD is multi-bin and the operator needs to "
        "know which bin was empty. Derived from the module's own `DEFAULT_BIN_UM` rather "
        "than a hardcoded 8, so a product-default change cannot make this fail while the "
        f"refusal names the bin correctly: {result.stderr[-2000:]!r}"
    )
    assert b"there is no outcome REPORTED TO THE OPERATOR as anything other than SUCCESS" in result.stderr, (
        "#613 pins the CORRECTED claim on the shipped stderr: the all-zero message must "
        "state the outcome-signal wording scoped to this shape -- the old "
        "no-`'succeeded-with-a-warning'`-outcome phrasing (#503(2)) the message replaced "
        f"would fail this pin: {result.stderr[-2000:]!r}"
    )
    assert _503_WARNING_PHRASING not in result.stderr, (
        "the no-`'succeeded-with-a-warning'`-outcome phrasing must be ABSENT from the "
        f"shipped stderr (#613): {result.stderr[-2000:]!r}"
    )


def test_TEST_83_a_matrix_with_some_stored_zeros_still_imports(tmp_path):
    r"""TEST-83 [acceptance, INV-8 + INV-9] — the not-over-refused control for #533: a
    matrix with `nnz > 0`, SOME stored zeros and SOME non-zeros still imports at rc 0.

    Sparse formats legitimately permit explicitly stored zeros, so "some stored zeros
    among non-zeros" is unremarkable and must NOT fire the all-zero refusal. The first
    100 stored values are set to 0 in place (the rest stay non-zero), so the matrix
    stays internally consistent. MEASURED through the shipped entrypoint: rc 0, a
    manifest written, and the store holds the same nnz with non-zero values surviving.
    """
    bundle = HF.staged_tree(tmp_path / "t533-some-zeros")
    with h5py.File(bundle / BIN_DIR / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert bool(np.any(data)), (
            "the fixture must have non-zero values for this control to mean anything"
        )
        data[:100] = 0
        assert bool(np.any(data)), "the control must still have non-zero values"
        del m["data"]
        m.create_dataset("data", data=data)
    # THE MUTATION TOOK EFFECT — re-open and prove the first 100 values are 0 while
    # non-zero values remain, so a silently failed mutation cannot make this control
    # pass without having tested anything.
    with h5py.File(bundle / BIN_DIR / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(data), len(mutated)
        assert not bool(np.any(mutated[:100])), "the some-zeros mutation did not land"
        assert bool(np.any(mutated)), "the control must still have non-zero values"
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    assert result.returncode == 0, (
        f"a matrix with some stored zeros and some non-zeros must import at rc 0, got "
        f"rc={result.returncode}; stderr tail: {result.stderr[-2000:]!r}"
    )
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    with h5py.File(HF.FIXTURE / BIN_DIR / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    data = HF.read_member(out, "expression.zarr", "data")
    assert len(data) == nnz, len(data)
    assert bool(np.any(data)), "the store must still hold the non-zero values"
    assert b"every one of them exactly 0" not in result.stderr, (
        "a matrix with some stored zeros and some non-zeros must not hit the all-zero "
        f"refusal: {result.stderr[-2000:]!r}"
    )


def test_TEST_84_an_all_NaN_data_matrix_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-84 [acceptance, INV-8 + INV-9] — the #548 shape, NaN: `nnz > 0` but every
    `/matrix/data` value is NaN, and the matrix is REFUSED before the first writer.

    `np.any(blk)` treats NaN as truthy (NaN != 0), so the #533 all-zero check never fired
    on this shape: the matrix (dtype kind `f`, which passes the `"iufb"` gate) imported at
    rc 0 with unusable "counts" — the boundary the 0.10.0 entry declared deliberately out
    of scope (#548). The #548 scan predicate is "usable = FINITE AND NON-ZERO", so an
    all-NaN `/matrix/data` is now refused BEFORE the first writer (rc 2, zero output
    paths), and the message is the NON-FINITE diagnosis, which states BOTH readings
    honestly: a corrupt or mis-written file, or a
    genuine run whose reads produced no usable UMI and whose matrix was then damaged or
    truncated — and the two cannot be told apart from this file alone. The all-zero
    diagnosis's marker, `every one of them exactly 0`, is still absent here, so the two
    messages remain DISTINGUISHED, and this test's own old claim ("still imports at rc 0")
    is retired with it. MEASURED post-fix through the shipped entrypoint: rc 2, zero
    output paths.
    """
    bundle = HF.staged_tree(tmp_path / "t548-all-nan")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / BIN_DIR / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        nan_data = np.full(len(data), np.nan, dtype=np.float32)
        del m["data"]
        m.create_dataset("data", data=nan_data)
    # THE MUTATION TOOK EFFECT — re-open and prove every stored value is NaN, so a
    # silently failed mutation cannot make this test pass vacuously.
    with h5py.File(bundle / BIN_DIR / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(data), len(mutated)
        assert bool(np.isnan(mutated).all()), "the all-NaN mutation did not land"
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    _assert_refused_empty(result, out, marker=b"every one of them non-finite")
    # TEST-2 (#638): the corrected non-finite sentence — the inferred reading is on the
    # EMITTED stderr, and the old vendor-settled phrase is gone (never "well-formed 10x
    # Space Ranger"), the same shape as the sibling's corrected sentence.
    assert b"a matrix of real read counts stores" in result.stderr, (
        "the #638-corrected non-finite refusal must state the inferred reading (\"a "
        f"matrix of real read counts stores\"), never the vendor-wide settled fact: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"well-formed" not in result.stderr, (
        f"the non-finite refusal must not name the vendor's format as well-formed (#638): "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"a well-formed 10x Space Ranger matrix" not in result.stderr, (
        "the non-finite refusal must not state the vendor-wide settled fact — scoped to "
        f"the PHRASE (#638): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them exactly 0" not in result.stderr, (
        "the all-zero refusal must NOT fire on an all-NaN matrix — the two diagnoses are "
        f"distinguished (#548): {result.stderr[-2000:]!r}"
    )
    # TEST-2 (#643): the assert-message prose for the marker-absence assertion names
    # BOTH readings of the non-finite refusal (a corrupt or mis-written file, or a
    # genuine run whose reads produced no usable UMI and whose matrix was then
    # damaged or truncated) instead of the stale
    # single-reading clause; the all-zero failed-run-language prohibition is kept.
    assert b"Number of Bins Under Tissue" not in result.stderr, (
        "the non-finite refusal states BOTH readings — a corrupt or mis-written file, or "
        "a genuine run whose reads produced no usable UMI "
        "and whose matrix was then damaged or truncated — and must NOT use the "
        "all-zero diagnosis's failed-run language (metrics_summary / Number of Bins Under "
        f"Tissue): {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    with h5py.File(HF.FIXTURE / BIN_DIR / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    assert f"{nnz} stored value(s)".encode() in result.stderr, (
        "the refusal must state the stored-value count (nnz), so the operator sees how "
        f"many values were non-finite rather than only the declared counts: {result.stderr[-2000:]!r}"
    )
    assert f"{HF.load_compute().DEFAULT_BIN_UM} um bin".encode() in result.stderr, (
        "the refusal must name the bin, because HD is multi-bin and the operator needs to "
        "know which bin was non-finite. Derived from the module's own `DEFAULT_BIN_UM` "
        "rather than a hardcoded 8, so a product-default change cannot make this fail "
        f"while the refusal names the bin correctly: {result.stderr[-2000:]!r}"
    )


def test_TEST_85_an_all_Inf_data_matrix_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-85 [acceptance, INV-8 + INV-9] — the #548 shape, Inf: `nnz > 0` but every
    `/matrix/data` value is +Infinity.

    Inf is the other non-finite spelling of the same no-usable-value boundary: `np.any`
    treated it as truthy too, so an all-Inf matrix imported at rc 0 with unusable counts.
    Post-fix it is refused with the SAME non-finite diagnosis and marker as all-NaN (it is
    not a different defect), and the all-zero marker stays absent — the two diagnoses are
    distinguished, not collapsed into one sentence. MEASURED post-fix: rc 2, zero output
    paths.
    """
    bundle = HF.staged_tree(tmp_path / "t548-all-inf")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / BIN_DIR / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        inf_data = np.full(len(data), np.inf, dtype=np.float32)
        del m["data"]
        m.create_dataset("data", data=inf_data)
    # THE MUTATION TOOK EFFECT — re-open and prove every stored value is Inf, so a
    # silently failed mutation cannot make this test pass vacuously.
    with h5py.File(bundle / BIN_DIR / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(data), len(mutated)
        assert bool(np.isinf(mutated).all()), "the all-Inf mutation did not land"
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    _assert_refused_empty(result, out, marker=b"every one of them non-finite")
    # TEST-3 (#638): the corrected non-finite sentence — same three byte-asserts as the
    # all-NaN row: the inferred reading present, the old vendor-settled phrase absent.
    assert b"a matrix of real read counts stores" in result.stderr, (
        "the #638-corrected non-finite refusal must state the inferred reading (\"a "
        f"matrix of real read counts stores\"), never the vendor-wide settled fact: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"well-formed" not in result.stderr, (
        f"the non-finite refusal must not name the vendor's format as well-formed (#638): "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"a well-formed 10x Space Ranger matrix" not in result.stderr, (
        "the non-finite refusal must not state the vendor-wide settled fact — scoped to "
        f"the PHRASE (#638): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them exactly 0" not in result.stderr, (
        "the all-zero refusal must NOT fire on an all-Inf matrix — the two diagnoses are "
        f"distinguished (#548): {result.stderr[-2000:]!r}"
    )
    # TEST-3 (#643): the assert-message prose for the marker-absence assertion names
    # BOTH readings of the non-finite refusal (a corrupt or mis-written file, or a
    # genuine run whose reads produced no usable UMI and whose matrix was then
    # damaged or truncated) instead of the stale
    # single-reading clause; the all-zero failed-run-language prohibition is kept.
    assert b"Number of Bins Under Tissue" not in result.stderr, (
        "the non-finite refusal states BOTH readings — a corrupt or mis-written file, or "
        "a genuine run whose reads produced no usable UMI "
        "and whose matrix was then damaged or truncated — and must NOT use the "
        "all-zero diagnosis's failed-run language (metrics_summary / Number of Bins Under "
        f"Tissue): {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )


def test_TEST_86_a_matrix_with_some_NaN_among_real_counts_still_imports(tmp_path):
    r"""TEST-86 [acceptance, INV-8 + INV-9] — THE OVER-REFUSAL GUARD for #548: a matrix
    with real counts plus a FEW NaN values still imports at rc 0.

    The boundary is ALL stored values unusable, mirroring #533's "every one of them
    exactly 0" — a matrix that merely CONTAINS some NaN is not a corrupt file, and
    refusing it would reject real vendor data with occasional sanitised/dropped values.
    The fixture's counts are widened to float32 (the dtype nothing here may assume),
    exactly 3 of the 627 stored values are forced to NaN, and the rest are UNCHANGED.
    MEASURED through the shipped entrypoint: rc 0, a manifest written, the store still
    holds the non-zero values, and NEITHER marker is on stderr.
    """
    bundle = HF.staged_tree(tmp_path / "t548-some-nan")
    with h5py.File(bundle / BIN_DIR / MATRIX, "r+") as handle:
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
    with h5py.File(bundle / BIN_DIR / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(as_float), len(mutated)
        assert bool(np.isnan(mutated[:3]).all()), "the NaN mutation did not land at positions 0..2"
        assert not bool(np.isnan(mutated[3:]).any()), "the mutation leaked beyond the 3 values"
        assert np.array_equal(mutated[3:], original[3:]), (
            "the non-NaN values were altered by the mutation"
        )
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    assert result.returncode == 0, (
        f"a matrix with real counts plus a few NaN values must import at rc 0, got "
        f"rc={result.returncode}; stderr tail: {result.stderr[-2000:]!r}"
    )
    assert (out / "manifest.json").is_file(), "a legitimate import must write the manifest"
    with h5py.File(HF.FIXTURE / BIN_DIR / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    data = HF.read_member(out, "expression.zarr", "data")
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


def test_TEST_87_a_matrix_that_is_a_mix_of_zeros_and_NaN_is_refused_before_the_first_writer(tmp_path):
    r"""TEST-87 [acceptance, INV-8 + INV-9] — the #548 MIXED shape: `nnz > 0` but every
    `/matrix/data` value is either exactly 0 or NaN, with NO finite non-zero value.

    This is the shape the pure diagnoses do NOT name truthfully: the all-zero message's
    "every one of them exactly 0" is FALSE for the NaN values, and the non-finite message's
    "every one of them non-finite" is FALSE for the zeros — so the refused matrix gets its
    OWN third diagnosis ("not one of them a usable count"), which states BOTH readings
    honestly (a corrupt/mis-written FILE, OR a run that found no usable UMI and was then
    damaged or truncated) and takes the operator-signal stance. MEASURED post-fix through
    the shipped entrypoint: rc 2, zero output paths.

    The #613 fix round adds two wording pins to this test. The message's corrected
    outcome-signal claim — "there is no outcome REPORTED TO THE OPERATOR as anything
    other than SUCCESS", scoped to this shape — is asserted on the emitted stderr, and
    the old no-`'succeeded-with-a-warning'`-outcome phrasing it replaced (#503(2)) is
    asserted ABSENT from the shipped stderr (TEST-111 is the package-wide absence
    sweep; these two pins make the MIXED refusal's stderr agree with it, not just the
    all-zero and zero-barcode refusals).
    """
    bundle = HF.staged_tree(tmp_path / "t548-mixed-zero-nan")
    n_features, n_barcodes = _fixture_shape()
    with h5py.File(bundle / BIN_DIR / MATRIX, "r+") as handle:
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
    with h5py.File(bundle / BIN_DIR / MATRIX, "r") as handle:
        mutated = handle["matrix"]["data"][:]
        assert len(mutated) == len(data), len(mutated)
        assert bool(np.isnan(mutated[:3]).all()), "the NaN half of the mix did not land"
        assert bool(np.all(mutated[3:] == 0)), "the zero half of the mix did not land"
    inputs = _staged(tmp_path, bundle)
    out = tmp_path / "out"
    result = HF.run_entry_bytes(inputs, out)

    _assert_refused_empty(result, out, marker=b"not one of them a usable count")
    # TEST-1 (#641): the corrected MIXED head — the inferred reading is on the EMITTED
    # stderr, the old vendor-settled claim is gone (never "well-formed 10x Space Ranger"),
    # and the BOTH-readings certainty is kept — the same shape as the sibling's (and this
    # test file's OWN #638 pins on the non-finite message).
    assert b"a matrix of real read counts produces" in result.stderr, (
        "the #641-corrected MIXED refusal must state the inferred reading (\"a matrix "
        f"of real read counts produces\"), never the vendor-wide settled fact: "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"well-formed" not in result.stderr, (
        f"the MIXED refusal must not name the vendor's format as well-formed (#641): "
        f"{result.stderr[-2000:]!r}"
    )
    assert b"a well-formed 10x Space Ranger matrix" not in result.stderr, (
        "the MIXED refusal must not state the vendor-wide settled fact — scoped to "
        f"the PHRASE (#641): {result.stderr[-2000:]!r}"
    )
    assert b"the two cannot be told apart from this file alone" in result.stderr, (
        "the #641-corrected MIXED refusal must keep the BOTH-readings certainty "
        f"(#641): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them exactly 0" not in result.stderr, (
        "the all-zero refusal must NOT fire on a mixed matrix — neither pure diagnosis "
        f"names it (#548): {result.stderr[-2000:]!r}"
    )
    assert b"every one of them non-finite" not in result.stderr, (
        "the non-finite refusal must NOT fire on a mixed matrix — neither pure diagnosis "
        f"names it (#548): {result.stderr[-2000:]!r}"
    )
    assert b"Number of Bins Under Tissue" not in result.stderr, (
        "the mixed refusal must not borrow the all-zero diagnosis's failed-run language "
        f"(metrics_summary / Number of Bins Under Tissue): {result.stderr[-2000:]!r}"
    )
    assert f"{n_barcodes} barcode(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_barcodes), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    assert f"{n_features} feature(s)".encode() in result.stderr, (
        "the refusal must state the count that IS declared (n_features), so the operator "
        f"sees the shape that makes this matrix impossible: {result.stderr[-2000:]!r}"
    )
    with h5py.File(HF.FIXTURE / BIN_DIR / MATRIX, "r") as handle:
        nnz = len(handle["matrix"]["data"])
    assert f"{nnz} stored value(s)".encode() in result.stderr, (
        "the refusal must state the stored-value count (nnz), so the operator sees how "
        f"many values were in the mix: {result.stderr[-2000:]!r}"
    )
    assert f"{HF.load_compute().DEFAULT_BIN_UM} um bin".encode() in result.stderr, (
        "the refusal must name the bin, because HD is multi-bin and the operator needs to "
        "know which bin held the mix. Derived from the module's own `DEFAULT_BIN_UM` "
        "rather than a hardcoded 8, so a product-default change cannot make this fail "
        f"while the refusal names the bin correctly: {result.stderr[-2000:]!r}"
    )
    assert b"there is no outcome REPORTED TO THE OPERATOR as anything other than SUCCESS" in result.stderr, (
        "#613 pins the CORRECTED claim on the shipped stderr: the mixed message must "
        "state the outcome-signal wording scoped to this shape -- the old "
        "no-`'succeeded-with-a-warning'`-outcome phrasing (#503(2)) the message replaced "
        f"would fail this pin: {result.stderr[-2000:]!r}"
    )
    assert _503_WARNING_PHRASING not in result.stderr, (
        "the no-`'succeeded-with-a-warning'`-outcome phrasing must be ABSENT from the "
        f"shipped stderr (#613): {result.stderr[-2000:]!r}"
    )
