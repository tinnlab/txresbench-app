#!/usr/bin/env python3
# ruff: noqa
"""`cyto_csc.source_for_h5` — resolving an h5ad matrix node's ORIENTATION and SHAPE.

This file exists because the resolver silently returned the TRANSPOSE of the stored
matrix, on a real input shape, with exit 0 and no warning. Three distinct routes led
there, and each gets its own oracle here:

  1. **a square store with NO declared orientation.** The indptr length was the
     discriminator, and the comment claimed it "is exact". It is exact only for a
     NON-SQUARE matrix: when rows == cols, `n == rows + 1` and `n == cols + 1` are the
     same test, both pass, and a first-match branch took CSR for every CSC store.
  2. **a store that DID declare `h5sparse_format = 'csc'`.** The resolver read the
     modern `encoding-type` spelling only, saw nothing, fell into the undeclared
     branch above, and transposed a file that had ANSWERED the question. This is the
     reason the fix reads both spellings rather than only refusing the ambiguous case:
     reading one spelling MANUFACTURES an ambiguity that is not in the file.
  3. **an h5sparse-era store** (`h5sparse_format` + `h5sparse_shape`, no `shape`) died
     on `attrs["shape"]` with a bare `KeyError: 'shape'`, naming neither the node nor
     what it wanted.

The assertions are on VALUES, read back through the real write/read path and compared
against `scipy`'s own `tocsc()`, because "it did not raise" and "it picked a class" are
both satisfied by the transposing implementation. Where the file genuinely cannot be
resolved the test asserts the REFUSAL and its terms — a resolver that guesses is worse
than one that stops, and a message that does not name the node cannot be acted on.

`h5py` and `scipy` are imported unguarded rather than through `importorskip`: a skip
here reports green while covering nothing, and `source_for_h5` cannot be exercised at
all without them.
"""
from __future__ import annotations

import numpy as np
import pytest
import h5py
import scipy.sparse as sp

import cyto_csc


# ───────────────────────────────── fixtures ──────────────────────────────────
#
# SQUARE is deliberately ASYMMETRIC: its transpose is a different matrix of the SAME
# shape, so a wrong orientation is invisible in the geometry and visible only in the
# values. A symmetric fixture here would pass against the bug.
#
# Square is not an exotic input for this engine. `cyto_csc` is domain-agnostic — an
# adjacency / k-NN connectivity matrix (`obsp`/`varp`) and a gene-gene correlation
# matrix are both square, so "an expression matrix is never square" is not an argument
# this resolver is allowed to make.
SQUARE = np.array(
    [
        [0.0, 0.0, 0.0, 9.0],
        [0.0, 0.0, 0.0, 0.0],
        [0.0, 4.0, 0.0, 0.0],
        [7.0, 0.0, 0.0, 0.0],
    ],
    dtype=np.float32,
)

# NON-SQUARE, and 2x5 so that rows+1 (3) and cols+1 (6) are far apart — the indptr
# length really does discriminate here, which is what keeps the refusal narrow.
WIDE = np.array(
    [
        [0.0, 1.0, 0.0, 0.0, 2.0],
        [3.0, 0.0, 0.0, 0.0, 0.0],
    ],
    dtype=np.float32,
)

#: attribute spellings, by era. "modern" and "h5sparse" DECLARE an orientation;
#: "bare" declares only a shape, which is the branch the indptr discriminator owns.
SPELLINGS = {
    "modern": ("encoding-type", "{fmt}_matrix", "shape"),
    "h5sparse": ("h5sparse_format", "{fmt}", "h5sparse_shape"),
}


def write_group(path, dense, *, orientation, spelling=None, shape_attr=True):
    """Write `dense` into `/X` as a sparse group, in one historical spelling.

    `orientation` is what is actually STORED. `spelling=None` writes no orientation
    attribute at all (the hand-written store). `shape_attr=False` writes no shape
    either, which is the wholly-undeclared group.
    """
    S = sp.csr_matrix(dense) if orientation == "csr" else sp.csc_matrix(dense)
    with h5py.File(path, "w") as f:
        g = f.create_group("X")
        shape_name = "shape"
        if spelling is not None:
            attr, value, shape_name = SPELLINGS[spelling]
            g.attrs[attr] = value.format(fmt=orientation)
        if shape_attr:
            g.attrs[shape_name] = np.asarray(dense.shape, dtype="int64")
        g.create_dataset("data", data=np.asarray(S.data, dtype="float32"))
        g.create_dataset("indices", data=np.asarray(S.indices, dtype="int32"))
        g.create_dataset("indptr", data=np.asarray(S.indptr, dtype="int64"))
    return path


def roundtrip(path, out, expect_shape):
    """Resolve `/X` and run it through the REAL transpose + read path, returning the
    matrix densely. Asserting on this rather than on the source class is the point:
    the transposing implementation also returned a perfectly valid source object.

    `expect_shape` is passed in rather than inferred from the output, because the only
    available inference — `max(indices) + 1` — drops a trailing all-zero row, which is
    the very inference this module refuses to make. Reconstructing at the declared
    shape also means a resolver that returned the transpose of a NON-square matrix
    raises here rather than quietly comparing unequal-shaped arrays.
    """
    with h5py.File(path, "r") as f:
        src = cyto_csc.source_for_h5(f["X"])
        picked = type(src).__name__
        cyto_csc.write_csc_zarr(src, out, nnz_cap=3, read_nnz=2)
    indptr, indices, data = cyto_csc.read_csc(out)
    assert int(indptr.shape[0]) - 1 == expect_shape[1], (
        f"the output has {int(indptr.shape[0]) - 1} columns, not the declared "
        f"{expect_shape[1]} — the matrix came back transposed"
    )
    return sp.csc_matrix((data, indices, indptr), shape=expect_shape).toarray(), picked


def oracle(dense):
    """`scipy`'s own CSC of the same matrix — the independent implementation."""
    return sp.csc_matrix(dense).toarray()


# ─────────────────────── 1. the oracle: square + undeclared ───────────────────


@pytest.mark.parametrize("stored", ["csr", "csc"])
def test_a_square_undeclared_store_is_refused_not_transposed(tmp_path, stored):
    """THE ORACLE. A square sparse group that declares no orientation cannot be
    resolved, and must say so instead of picking one.

    `stored` is parametrized so the outcome depends on what the file DECLARES, not on
    what it happens to hold — under the first-match bug the `csr` case returned the
    right answer by luck and the `csc` case returned the transpose, and a test written
    against only one of them proves nothing about the discriminator.
    """
    path = write_group(tmp_path / f"sq_{stored}.h5", SQUARE, orientation=stored)

    # The undeclared branch is genuinely REACHED: no orientation is declared, and the
    # shape IS, so this gets past the missing-shape guard rather than failing earlier
    # for an unrelated reason. Without this the test below could pass on the wrong
    # error entirely.
    with h5py.File(path, "r") as f:
        assert cyto_csc.h5_sparse_format(f["X"]) is None
        assert cyto_csc.h5_matrix_shape(f["X"]) == SQUARE.shape
        assert SQUARE.shape[0] == SQUARE.shape[1], "the fixture must be square"

        with pytest.raises(ValueError) as excinfo:
            cyto_csc.source_for_h5(f["X"])

    message = str(excinfo.value)
    assert "/X" in message, f"the failing node is not named: {message}"
    assert "square" in message, message
    assert "encoding-type" in message and "h5sparse_format" in message, (
        "the refusal must name BOTH attribute spellings that would resolve it, or the "
        f"caller cannot act on it: {message}"
    )
    assert "transpose" in message, (
        f"the refusal must say what reading it anyway would cost: {message}"
    )


def test_the_refusal_is_narrow_a_square_store_is_not_refused_on_principle(tmp_path):
    """NEGATIVE CONTROL on the refusal itself. Refusing every square store, or every
    undeclared store, would also make the oracle above pass — and would break real
    files. The two controls below pin the refusal to the INTERSECTION."""
    declared = write_group(
        tmp_path / "sq_declared.h5", SQUARE, orientation="csc", spelling="modern"
    )
    with h5py.File(declared, "r") as f:
        assert cyto_csc.source_for_h5(f["X"]) is not None  # square, but declared

    undeclared_wide = write_group(tmp_path / "wide_bare.h5", WIDE, orientation="csr")
    with h5py.File(undeclared_wide, "r") as f:
        assert cyto_csc.source_for_h5(f["X"]) is not None  # undeclared, but not square


# ───────────────── 2. negative control: square DECLARED, both ways ────────────


@pytest.mark.parametrize("spelling", ["modern", "h5sparse"])
@pytest.mark.parametrize("stored", ["csr", "csc"])
def test_a_square_declared_store_resolves_exactly_in_both_orientations(
    tmp_path, stored, spelling
):
    """A square store that DOES declare its orientation must still convert, in both
    orientations and both spellings, to values identical to `scipy`'s own `tocsc()`.

    This is the control that a "just refuse square" fix fails. The `h5sparse` half is
    also the regression guard for defect 2: that spelling was not read at all, so a
    file declaring `h5sparse_format='csc'` was transposed despite having answered.
    """
    path = write_group(
        tmp_path / f"sq_{spelling}_{stored}.h5",
        SQUARE,
        orientation=stored,
        spelling=spelling,
    )
    got, picked = roundtrip(path, tmp_path / f"out_{spelling}_{stored}", SQUARE.shape)

    assert picked == ("H5CsrSource" if stored == "csr" else "H5CscSource"), (
        f"the declared orientation was not honoured: a {stored!r} group under the "
        f"{spelling!r} spelling resolved to {picked}"
    )
    np.testing.assert_array_equal(
        got,
        oracle(SQUARE),
        err_msg=(
            f"a square {stored!r} store in the {spelling!r} spelling did not round-trip "
            f"to the stored matrix. Got the TRANSPOSE: {np.array_equal(got, SQUARE.T)}"
        ),
    )


# ────────────── 3. negative control: non-square undeclared still works ────────


@pytest.mark.parametrize("stored", ["csr", "csc"])
def test_a_non_square_undeclared_store_is_still_recovered_exactly(tmp_path, stored):
    """The other half of the narrowing. Where the indptr length genuinely does
    discriminate — a non-square matrix, where rows+1 and cols+1 differ — the
    orientation is still recovered, and the values still match `scipy`.

    Refusing every undeclared store would be an equally wrong fix: it would break the
    hand-written stores this branch exists to read.
    """
    path = write_group(tmp_path / f"wide_{stored}.h5", WIDE, orientation=stored)
    got, picked = roundtrip(path, tmp_path / f"out_wide_{stored}", WIDE.shape)

    assert picked == ("H5CsrSource" if stored == "csr" else "H5CscSource"), (
        f"a non-square undeclared {stored!r} store resolved to {picked}"
    )
    np.testing.assert_array_equal(
        got,
        oracle(WIDE),
        err_msg=f"a non-square undeclared {stored!r} store did not recover exactly",
    )


# ───────────────────────── 4. the shape contract ─────────────────────────────


def test_the_h5sparse_era_shape_spelling_is_read_not_a_bare_keyerror(tmp_path):
    """Defect 3. `h5sparse_shape` is the only shape a pre-0.7 file carries — the
    canonical `pbmc3k_raw.h5ad` is one — and reading `attrs["shape"]` unguarded turned
    that into `KeyError: 'shape'` mid-convert, naming neither the node nor the want."""
    path = write_group(
        tmp_path / "era.h5", WIDE, orientation="csr", spelling="h5sparse"
    )
    with h5py.File(path, "r") as f:
        assert "shape" not in f["X"].attrs, "the fixture must use the OLD spelling only"
        assert cyto_csc.h5_matrix_shape(f["X"]) == WIDE.shape

    got, _ = roundtrip(path, tmp_path / "out_era", WIDE.shape)
    np.testing.assert_array_equal(got, oracle(WIDE))


def test_a_group_declaring_no_shape_at_all_fails_loud_naming_both_spellings(tmp_path):
    """The malformed case the defensive read must NOT paper over: no shape in ANY
    spelling. The matrix width is simply not in the file, and the only available
    inference — `max(indices) + 1` — silently drops every trailing all-zero column.
    Must raise a NAMED error rather than a bare `KeyError`."""
    path = write_group(
        tmp_path / "noshape.h5", WIDE, orientation="csr", shape_attr=False
    )
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError) as excinfo:
            cyto_csc.source_for_h5(f["X"])
    message = str(excinfo.value)
    assert "/X" in message, f"the failing node is not named: {message}"
    assert "shape" in message and "h5sparse_shape" in message, message
    assert "declares no shape" in message, message


def test_an_undeclared_indptr_matching_neither_axis_fails_loud(tmp_path):
    """No orientation attribute AND an indptr matching neither rows+1 nor cols+1: the
    discriminator has no answer at all, so it must say so rather than pick one."""
    path = write_group(tmp_path / "bad_indptr.h5", WIDE, orientation="csr")
    # WIDE is 2x5, so rows+1 == 3 and cols+1 == 6. A 4-entry indptr matches neither,
    # which is the only way to reach the final `else` without tripping an earlier guard.
    with h5py.File(path, "a") as f:
        del f["X"]["indptr"]
        f["X"].create_dataset("indptr", data=np.array([0, 1, 2, 4], dtype="int64"))
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError, match="neither an orientation"):
            cyto_csc.source_for_h5(f["X"])


# ───────────────── 5. the rejections the engine already owned ────────────────


def test_a_non_matrix_group_still_gets_the_canonical_unsupported_error(tmp_path):
    """A group that is not sparse-SHAPED and declares no orientation is still rejected
    in the engine's original terms. `anndata-import` delegates exactly this case back
    here and matches on the text, so the message is a contract, not a detail."""
    path = tmp_path / "not_a_matrix.h5"
    with h5py.File(path, "w") as f:
        g = f.create_group("X")
        g.attrs["encoding-type"] = "dataframe"
        g.create_dataset("index", data=np.arange(4))
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError, match="unsupported h5ad matrix encoding"):
            cyto_csc.source_for_h5(f["X"])


def test_a_declared_group_missing_its_members_fails_loud(tmp_path):
    """A group that calls itself sparse but does not carry the three members is
    corrupt. It used to die on `group["indptr"]` with a bare h5py `KeyError`."""
    path = tmp_path / "no_members.h5"
    with h5py.File(path, "w") as f:
        g = f.create_group("X")
        g.attrs["encoding-type"] = "csr_matrix"
        g.attrs["shape"] = np.asarray([2, 5], dtype="int64")
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError) as excinfo:
            cyto_csc.source_for_h5(f["X"])
    message = str(excinfo.value)
    assert "/X" in message and "missing" in message, message


def test_a_declared_orientation_contradicting_its_indptr_is_not_silently_reread(
    tmp_path,
):
    """A file whose declared orientation contradicts its own indptr is CORRUPT, and
    must NOT be quietly re-interpreted as the other orientation — that is a transposed
    matrix delivered as science, which is the whole failure class this file guards."""
    path = write_group(
        tmp_path / "inconsistent.h5", WIDE, orientation="csr", spelling="modern"
    )
    with h5py.File(path, "a") as f:
        del f["X"]["indptr"]
        f["X"].create_dataset(
            "indptr", data=np.asarray(sp.csc_matrix(WIDE).indptr, dtype="int64")
        )
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError, match="CSR indptr"):
            cyto_csc.source_for_h5(f["X"])


def test_a_dense_dataset_is_still_resolved_by_its_own_shape(tmp_path):
    """The dense case carries its geometry in the dataset itself and must be untouched
    by the attribute plumbing above."""
    path = tmp_path / "dense.h5"
    with h5py.File(path, "w") as f:
        f.create_dataset("X", data=np.asarray(WIDE, dtype="float32"))
    got, picked = roundtrip(path, tmp_path / "out_dense", WIDE.shape)
    assert picked == "H5DenseSource"
    np.testing.assert_array_equal(got, oracle(WIDE))
