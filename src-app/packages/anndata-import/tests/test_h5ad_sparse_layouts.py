#!/usr/bin/env python3
"""The h5ad SPARSE-MATRIX LAYOUT the converter has to read — every spelling of it.

WHY THIS FILE EXISTS
--------------------
An h5ad sparse matrix group has been written more than one way over the format's
life, and the converter's streaming transpose knew only the newest one:

    modern (anndata >= 0.7)   attrs: encoding-type = 'csr_matrix' | 'csc_matrix'
                                     encoding-version, shape = [rows, cols]
    h5sparse-era (< 0.7)      attrs: h5sparse_format = 'csr' | 'csc'
                                     h5sparse_shape  = [rows, cols]
    hand-written              neither; only data / indices / indptr

`txr_csc.source_for_h5` once resolved a node by the modern spelling alone (even its
no-`encoding-type` fallback read `attrs["shape"]` unguarded), so an h5sparse-era `/X`
died with a bare `KeyError: 'shape'` in the middle of the convert step. That is not an
exotic corner: `pbmc3k_raw.h5ad` — the canonical scanpy tutorial input, and the app
suite's own conversion fixture — is one of these files, and `anndata` opens it without
complaint. The whole real-file import path was therefore dead for the oldest and most
widely circulated shape of the format the processor is named after.

`2a15e681` fixed that in the engine, which reads EITHER spelling for orientation and
for shape. `h5ad_import.source_for_h5_matrix` is now an alias for it rather than a
second implementation, so every case below asserts the ONE resolver — through the name
the converter actually calls, which is what keeps this file a test of the production
path and not of a wrapper.

WHAT IS ASSERTED
----------------
Every case reads VALUES back and compares them against `scipy`'s own transpose of
the same stored arrays — shape, nnz, and named elements — because "did not raise"
is exactly the assertion that let this ship. The fixtures are a handful of cells
wide, so this whole file runs without the 5.8 MB pbmc3k download or a sandbox.

Three properties get their own fixtures because they are the ones a plausible-looking
"fix" breaks:

  * a TRAILING ALL-ZERO gene. It is the reason the shape is read from an attribute
    and never inferred from `max(indices) + 1`: the naive inference returns a matrix
    3 columns wide where the file says 5, and nothing downstream can tell.
  * a SQUARE matrix with NO declared orientation. `rows + 1` and `columns + 1` are the
    same number there, so the indptr length answers "yes" to both questions and a
    first-match `if/elif` reads every CSC store as CSR and hands back its transpose,
    exit 0, no warning. The first version of this file asserted the square case only
    in its DECLARED spelling, so it never reached the discriminator at all — a test
    that could not fail on the bug it sat next to. Both branches are covered now, and
    the values are compared against `scipy`'s own `tocsc()`.
  * a NEGATIVE CONTROL on both sides — the modern layout still converts byte-for-byte,
    a square store that DOES declare its orientation still converts in both
    orientations, a non-square undeclared store is still recovered exactly, and a
    group that genuinely does not declare its geometry FAILS, loudly, naming what was
    looked for, rather than being coerced into a guess.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
sp = pytest.importorskip("scipy.sparse")
h5py = pytest.importorskip("h5py")
ad = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_COMPUTE = _PKG / "compute"
_HELPERS_DIR = _PKG.parent / "_helpers"
_LIB_DIR = _PKG.parent / "_lib"
SCRIPT = _COMPUTE / "h5ad_import.py"

for _p in (str(_COMPUTE), str(_LIB_DIR), str(_HELPERS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import txr_csc  # noqa: E402  — the `_lib` transpose engine + CSC reader
import h5ad_import as imp  # noqa: E402  — the converter, imported for its resolvers


# ───────────────────────────── the fixture matrix ─────────────────────────────
#
# 4 cells x 5 genes. Row 2 is an empty CELL and columns 3-4 are trailing EMPTY GENES
# — both are real in single-cell data and both are invisible to any geometry inferred
# from the stored indices (`max(indices) + 1` == 3, not 5).
DENSE = np.array(
    [
        [0.0, 3.0, 0.0, 0.0, 0.0],
        [5.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, 0.0],
        [1.0, 0.0, 2.0, 0.0, 0.0],
    ],
    dtype=np.float32,
)
N_CELLS, N_GENES = DENSE.shape          # 4, 5
NNZ = int(np.count_nonzero(DENSE))      # 4
#: (cell, gene, value) — named elements, asserted individually after read-back.
KNOWN = ((0, 1, 3.0), (1, 0, 5.0), (3, 0, 1.0), (3, 2, 2.0))
CELLS = [f"CELL{i}" for i in range(N_CELLS)]
GENES = [f"GENE{j}" for j in range(N_GENES)]


# ───────────────────────────── the SQUARE fixture ─────────────────────────────
#
# 4 x 4, and deliberately ASYMMETRIC — its transpose is a different matrix of the
# SAME shape, so a wrong orientation is invisible in the geometry and visible only in
# the values. Square is where the indptr length stops discriminating: `rows + 1` and
# `columns + 1` are both 5, so both tests pass at once.
#
# Square is not an exotic input. An adjacency matrix (`obsp`/`varp` connectivities, a
# k-NN graph) and a gene-gene correlation matrix are both square, and INV-5 keeps this
# core domain-agnostic, so "an expression matrix is never square" is not an argument
# this reader is allowed to make.
SQUARE = np.array(
    [
        [0.0, 0.0, 0.0, 9.0],
        [0.0, 0.0, 0.0, 0.0],
        [0.0, 4.0, 0.0, 0.0],
        [7.0, 0.0, 0.0, 0.0],
    ],
    dtype=np.float32,
)
N_SQ = SQUARE.shape[0]                      # 4 — and SQUARE.shape[1] is 4 too
SQ_CELLS = [f"CELL{i}" for i in range(N_SQ)]
SQ_GENES = [f"GENE{j}" for j in range(N_SQ)]


def _write_sparse_group(parent, name, matrix, *, spelling, orientation):
    """Write `matrix` as an h5ad sparse group under `parent`, in one of the format's
    historical spellings. `spelling` ∈ {"modern", "h5sparse", "bare"}; "bare" writes
    the three members and NO geometry attributes at all."""
    m = matrix.tocsr() if orientation == "csr" else matrix.tocsc()
    g = parent.create_group(name)
    g.create_dataset("data", data=m.data.astype(np.float32))
    g.create_dataset("indices", data=m.indices.astype(np.int32))
    g.create_dataset("indptr", data=m.indptr.astype(np.int32))
    if spelling == "modern":
        g.attrs["encoding-type"] = f"{orientation}_matrix"
        g.attrs["encoding-version"] = "0.1.0"
        g.attrs["shape"] = np.asarray(matrix.shape, dtype="int64")
    elif spelling == "h5sparse":
        # Fixed-length BYTES, which is what the writers of this era actually stored
        # (and what h5py hands back as `np.bytes_`, never as `str`).
        g.attrs["h5sparse_format"] = np.bytes_(orientation)
        g.attrs["h5sparse_shape"] = np.asarray(matrix.shape, dtype="int64")
    elif spelling != "bare":
        raise AssertionError(f"unknown spelling {spelling!r}")
    return g


def _write_h5ad(path, matrix, *, spelling, orientation="csr", cells=None, genes=None):
    """A complete, `anndata`-readable `.h5ad` whose `/X` uses the given spelling.

    `cells`/`genes` default to the 4x5 fixture's names; the SQUARE fixture passes its
    own so the annotation frames match its geometry.

    For the h5sparse-era spelling the ANNOTATION frames are written in that era's
    layout too — a compound-dtype recarray with an `index` field, exactly as
    `pbmc3k_raw.h5ad` carries them — so the file under test is the whole historical
    shape and not a modern file with one attribute renamed.
    """
    cells = CELLS if cells is None else list(cells)
    genes = GENES if genes is None else list(genes)
    with h5py.File(path, "w") as f:
        g_x = _write_sparse_group(
            f, "X", matrix, spelling=spelling, orientation=orientation
        )
        if spelling == "bare":
            # "bare" writes no geometry at all; a file the converter can OPEN still has
            # to declare its shape, which is the half nothing can recover. The
            # ORIENTATION stays undeclared — that is the branch under test.
            g_x.attrs["shape"] = np.asarray(matrix.shape, dtype="int64")
        if spelling == "h5sparse":
            obs = np.array([(c.encode(),) for c in cells], dtype=[("index", "S16")])
            var = np.array(
                [(g.encode(), f"ENSG{j:05d}".encode()) for j, g in enumerate(genes)],
                dtype=[("index", "S19"), ("gene_ids", "S15")],
            )
            f.create_dataset("obs", data=obs)
            f.create_dataset("var", data=var)
        else:
            for key, names, extra in (
                ("obs", cells, None),
                ("var", genes, [f"ENSG{j:05d}" for j in range(len(genes))]),
            ):
                grp = f.create_group(key)
                grp.attrs["encoding-type"] = "dataframe"
                grp.attrs["encoding-version"] = "0.2.0"
                grp.attrs["_index"] = "index"
                grp.attrs["column-order"] = np.array(
                    ["gene_ids"] if extra else [], dtype=object
                ).astype(h5py.special_dtype(vlen=str))
                idx = grp.create_dataset("index", data=np.array(names, dtype="S32"))
                idx.attrs["encoding-type"] = "string-array"
                idx.attrs["encoding-version"] = "0.2.0"
                if extra:
                    col = grp.create_dataset("gene_ids", data=np.array(extra, dtype="S32"))
                    col.attrs["encoding-type"] = "string-array"
                    col.attrs["encoding-version"] = "0.2.0"
    return path


def _read_back_source(source):
    """A `txr_csc` source, materialized into a `scipy` CSC via the source protocol
    the transpose itself consumes (`shape` + `iter_entries`) — so what is asserted is
    what the transpose would read, not a second decode of the same file."""
    rows, cols, vals = [], [], []
    for r, c, v in source.iter_entries(read_nnz=3):
        rows.append(np.asarray(r))
        cols.append(np.asarray(c))
        vals.append(np.asarray(v))
    if not rows:
        return sp.csc_matrix(source.shape, dtype=np.float32)
    return sp.csc_matrix(
        (np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))),
        shape=source.shape,
    )


def _assert_is_the_fixture(matrix, what):
    """Shape, nnz and every named element — the value assertions, in one place."""
    assert matrix.shape == (N_CELLS, N_GENES), (
        f"{what}: shape {matrix.shape} != {(N_CELLS, N_GENES)}. A shape inferred from the "
        "stored indices instead of read from the file loses the trailing empty genes."
    )
    assert int(matrix.nnz) == NNZ, f"{what}: nnz {matrix.nnz} != {NNZ}"
    dense = np.asarray(matrix.todense())
    for r, c, v in KNOWN:
        assert dense[r, c] == pytest.approx(v), f"{what}: [{r},{c}] == {dense[r, c]}, want {v}"
    np.testing.assert_allclose(dense, DENSE, err_msg=f"{what}: values differ from the fixture")


def _assert_matches_scipy(matrix, source_dense, what):
    """Shape, nnz and every named element against `scipy`'s OWN `tocsc()` of the same
    values — an oracle computed by a library that is not the code under test.

    A transposed read of a SQUARE matrix passes every geometry assertion there is, so
    the element-level comparison is the only one that can catch it; the named elements
    are asserted individually so a failure says WHICH element moved, not just that two
    arrays differ."""
    oracle = sp.csr_matrix(source_dense).tocsc()
    assert matrix.shape == oracle.shape, f"{what}: shape {matrix.shape} != {oracle.shape}"
    assert int(matrix.nnz) == int(oracle.nnz), f"{what}: nnz {matrix.nnz} != {oracle.nnz}"
    dense = np.asarray(matrix.todense())
    want = np.asarray(oracle.todense())
    for r, c in zip(*np.nonzero(want)):
        # The mirrored element is only addressable when the matrix is square; naming it
        # is what turns "arrays differ" into "this came back transposed".
        mirror = (
            f" — [{c},{r}] holds {dense[c, r]}, which is what a transposed read returns"
            if dense.shape[0] == dense.shape[1]
            else ""
        )
        assert dense[r, c] == pytest.approx(float(want[r, c])), (
            f"{what}: [{r},{c}] == {dense[r, c]}, want {want[r, c]}{mirror}"
        )
    np.testing.assert_allclose(
        dense, want, err_msg=f"{what}: values differ from scipy's own tocsc()"
    )


# ────────────────────── the resolvers, per format spelling ────────────────────

@pytest.mark.parametrize("orientation", ["csr", "csc"])
@pytest.mark.parametrize("spelling", ["modern", "h5sparse", "bare"])
def test_every_sparse_spelling_resolves_to_the_same_matrix(tmp_path, spelling, orientation):
    """THE REGRESSION. Each historical spelling of the same matrix must produce the
    same source and read back the same VALUES — the h5sparse-era pair being the one
    that raised `KeyError: 'shape'` before the geometry was resolved defensively."""
    path = tmp_path / f"{spelling}_{orientation}.h5"
    with h5py.File(path, "w") as f:
        _write_sparse_group(
            f, "X", sp.csr_matrix(DENSE),
            spelling=spelling,
            orientation=orientation,
        )
        if spelling == "bare":
            # A hand-written store declares no orientation; it must still declare a
            # SHAPE, since that is the half nothing can recover. This fixture is 4x5,
            # so `rows + 1` (5) and `columns + 1` (6) are different numbers and the
            # indptr length discriminates exactly — which is true HERE and false on a
            # square store (see the square tests below).
            f["X"].attrs["shape"] = np.asarray([N_CELLS, N_GENES], dtype="int64")

    with h5py.File(path, "r") as f:
        source = imp.source_for_h5_matrix(f["X"])
        assert source.shape == (N_CELLS, N_GENES)
        assert int(source.nnz) == NNZ
        np.testing.assert_array_equal(
            np.asarray(source.column_counts()),
            np.count_nonzero(DENSE, axis=0),
            err_msg="per-column histogram (the transpose's indptr) is wrong",
        )
        _assert_is_the_fixture(_read_back_source(source), f"{spelling}/{orientation}")


def test_the_h5sparse_orientation_attribute_is_read_as_bytes(tmp_path):
    """The era's writers stored `h5sparse_format` as fixed-length BYTES. Comparing
    that to `"csr"` without decoding is silently always false — which would send a
    perfectly well-declared CSR group down the undeclared-orientation path, where a
    square matrix is now refused outright and a non-square one is re-derived from the
    indptr rather than read from the file."""
    path = tmp_path / "bytes_attr.h5"
    with h5py.File(path, "w") as f:
        _write_sparse_group(f, "X", sp.csr_matrix(DENSE), spelling="h5sparse", orientation="csr")
        assert isinstance(f["X"].attrs["h5sparse_format"], (bytes, np.bytes_))
    with h5py.File(path, "r") as f:
        assert imp.h5_sparse_format(f["X"]) == "csr"
        assert imp.h5_attr_text(f["X"], "h5sparse_format") == "csr"
        assert imp.h5_matrix_shape(f["X"]) == (N_CELLS, N_GENES)


def test_a_square_matrix_honours_the_declared_orientation(tmp_path):
    """On a SQUARE matrix the indptr length cannot discriminate CSR from CSC, so a
    reader that ignored the declared orientation would transpose the science and
    every shape assertion would still pass. Asserted with an asymmetric matrix whose
    transpose is a different matrix of the same shape.

    ITS BLIND SPOT, named because this is the test that sat next to the defect and
    could not fail on it: it writes the DECLARED spelling, so `h5_sparse_format`
    answers before the indptr is ever consulted and the undeclared branch — the one
    that actually mis-read a square store — is never entered. The square tests below
    reach that branch."""
    m = np.zeros((4, 4), dtype=np.float32)
    m[0, 3] = 9.0
    m[2, 1] = 4.0
    path = tmp_path / "square.h5"
    with h5py.File(path, "w") as f:
        _write_sparse_group(f, "X", sp.csr_matrix(m), spelling="h5sparse", orientation="csr")
    with h5py.File(path, "r") as f:
        got = np.asarray(_read_back_source(imp.source_for_h5_matrix(f["X"])).todense())
    np.testing.assert_allclose(got, m)
    assert got[0, 3] == 9.0 and got[3, 0] == 0.0, "the matrix came back transposed"


# ────────── SQUARE — where the indptr length stops discriminating ─────────────
#
# `n_indptr == rows + 1` and `n_indptr == cols + 1` are the SAME test on a square
# matrix. A first-match `if/elif` therefore answered "CSR" to every square store,
# whatever it actually held, and a CSC one came back transposed with exit 0 and no
# warning. These four tests are the class: the ambiguous case must be refused, and the
# three cases that ARE determined must still resolve to the byte-exact matrix.

def _write_square_store(path, orientation, *, spelling="bare"):
    """The SQUARE fixture as a lone `/X` sparse group. `spelling="bare"` leaves the
    orientation undeclared (and declares only the shape) — that is the branch under
    test; the declared spellings are the negative controls."""
    with h5py.File(path, "w") as f:
        g = _write_sparse_group(
            f, "X", sp.csr_matrix(SQUARE), spelling=spelling, orientation=orientation
        )
        if spelling == "bare":
            g.attrs["shape"] = np.asarray(SQUARE.shape, dtype="int64")
    return path


@pytest.mark.parametrize("orientation", ["csc", "csr"])
def test_a_square_undeclared_store_is_refused_not_transposed(tmp_path, orientation):
    """THE ORACLE, as a test. A square CSC store with no declared orientation used to
    resolve to `H5CsrSource` and read back `SQUARE.T` — every geometry assertion
    green, the values silently mirrored. There is nothing else in the file to consult
    (the two attribute spellings are the only orientation signals h5ad/h5sparse ever
    wrote; the member datasets carry no attributes and the parent groups declare
    `anndata`/`dict`), so the only correct answer is to refuse and say why.

    The CSR case is parametrized in on purpose: the outcome must depend on what the
    FILE declares, not on which orientation happens to be stored — a reader that
    "gets CSR right" here is just the same coin-flip landing heads."""
    path = _write_square_store(tmp_path / f"square_bare_{orientation}.h5", orientation)
    with h5py.File(path, "r") as f:
        node = f["X"]
        # The undeclared branch is genuinely REACHED, and both candidate lengths match
        # — assert that, or this test could pass for the wrong reason.
        assert imp.h5_sparse_format(node) is None, "the fixture accidentally declares one"
        assert imp.h5_matrix_shape(node) == (N_SQ, N_SQ)
        assert int(node["indptr"].shape[0]) == N_SQ + 1 == SQUARE.shape[1] + 1
        with pytest.raises(ValueError) as excinfo:
            imp.source_for_h5_matrix(node)
    message = str(excinfo.value)
    assert "declares no orientation" in message, message
    assert "square" in message, f"the message does not name WHY it is ambiguous: {message}"
    # Names what it looked for and what it found — the same contract the shape path has.
    assert "encoding-type" in message and "h5sparse_format" in message, message
    assert "/X" in message, f"the failing node is not named: {message}"


@pytest.mark.parametrize("orientation", ["csr", "csc"])
@pytest.mark.parametrize("spelling", ["modern", "h5sparse"])
def test_a_square_declared_store_round_trips_against_scipy(tmp_path, spelling, orientation):
    """NEGATIVE CONTROL. Refusing the ambiguous case must not cost the determined one:
    a square store that DOES declare its orientation still converts, in BOTH
    orientations and both spellings, to exactly `scipy`'s own `tocsc()` of the same
    values — shape, nnz and every named element."""
    path = _write_square_store(
        tmp_path / f"square_{spelling}_{orientation}.h5", orientation, spelling=spelling
    )
    with h5py.File(path, "r") as f:
        node = f["X"]
        assert imp.h5_sparse_format(node) == orientation
        source = imp.source_for_h5_matrix(node)
        assert type(source).__name__ == (
            "H5CsrSource" if orientation == "csr" else "H5CscSource"
        ), "the declared orientation was not honoured"
        np.testing.assert_array_equal(
            np.asarray(source.column_counts()),
            np.count_nonzero(SQUARE, axis=0),
            err_msg="per-column histogram (the transpose's indptr) is wrong",
        )
        _assert_matches_scipy(
            _read_back_source(source), SQUARE, f"square {spelling}/{orientation}"
        )


@pytest.mark.parametrize("orientation", ["csr", "csc"])
def test_a_non_square_undeclared_store_still_recovers_exactly(tmp_path, orientation):
    """NEGATIVE CONTROL on the other side. Where the two candidate indptr lengths
    DIFFER the discriminator is still exact and must still be used — refusing every
    undeclared store would be an equally wrong "fix", and it would break the
    hand-written layout this reader exists to open. Asserted against `scipy`'s own
    `tocsc()`, and on the resolved source CLASS, so a lucky value match cannot pass
    for a correct orientation."""
    path = tmp_path / f"wide_bare_{orientation}.h5"
    with h5py.File(path, "w") as f:
        g = _write_sparse_group(
            f, "X", sp.csr_matrix(DENSE), spelling="bare", orientation=orientation
        )
        g.attrs["shape"] = np.asarray(DENSE.shape, dtype="int64")
    assert N_CELLS != N_GENES, "this fixture only tests anything while it is non-square"
    with h5py.File(path, "r") as f:
        node = f["X"]
        assert imp.h5_sparse_format(node) is None
        source = imp.source_for_h5_matrix(node)
        assert type(source).__name__ == (
            "H5CsrSource" if orientation == "csr" else "H5CscSource"
        ), "the indptr length did not recover the stored orientation"
        _assert_matches_scipy(
            _read_back_source(source), DENSE, f"non-square bare/{orientation}"
        )


def test_an_undeclared_shape_is_reported_as_absent_not_as_zero(tmp_path):
    """`h5_matrix_shape` answers `None` when the file declares no shape. It used to
    be spelled `attrs.get("shape", (0, 0))` at the one call site — a shape a caller
    can compute a density from, and never a shape any real matrix has."""
    path = tmp_path / "noshape.h5"
    with h5py.File(path, "w") as f:
        _write_sparse_group(f, "X", sp.csr_matrix(DENSE), spelling="bare", orientation="csr")
    with h5py.File(path, "r") as f:
        assert imp.h5_matrix_shape(f["X"]) is None
        assert imp.h5_sparse_format(f["X"]) is None
        # The streaming scanner reports the same absence rather than (0, 0).
        _data, nnz, shape = imp._h5_matrix_data(f, "X")
        assert shape is None and int(nnz) == NNZ


def test_a_dense_x_still_resolves_through_the_engine(tmp_path):
    """A dense `/X` is a DATASET, not a group — it carries its own shape and must keep
    going straight to the engine's dense source."""
    path = tmp_path / "dense.h5"
    with h5py.File(path, "w") as f:
        f.create_dataset("X", data=DENSE)
    with h5py.File(path, "r") as f:
        source = imp.source_for_h5_matrix(f["X"])
        assert source.shape == (N_CELLS, N_GENES)
        assert imp.h5_matrix_shape(f["X"]) == (N_CELLS, N_GENES)
        _assert_is_the_fixture(_read_back_source(source), "dense")


# ───────────────────── negative controls — malformed must FAIL ────────────────

def test_a_declared_format_with_no_shape_fails_loud(tmp_path):
    """The malformed case the defensive read must NOT paper over: an orientation is
    declared but no shape is, in any spelling. The width of the matrix is simply not
    in the file; inferring it from the largest stored index would silently return a
    4x3 matrix where the data is 4x5. Must raise, and must name what it looked for."""
    path = tmp_path / "fmt_noshape.h5"
    with h5py.File(path, "w") as f:
        g = _write_sparse_group(f, "X", sp.csr_matrix(DENSE), spelling="h5sparse", orientation="csr")
        del g.attrs["h5sparse_shape"]
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError) as excinfo:
            imp.source_for_h5_matrix(f["X"])
    message = str(excinfo.value)
    assert "shape" in message and "h5sparse_shape" in message, message
    assert "/X" in message, f"the failing node is not named: {message}"


def test_a_group_declaring_no_geometry_at_all_fails_loud(tmp_path):
    """Neither orientation nor shape: unreadable, and it must say so in the same
    terms. This is the case that used to reach `txr_csc`'s unguarded `attrs["shape"]`
    and come back as a bare `KeyError: 'shape'` — the very defect under repair. It is
    asserted here, on the engine's own resolution, precisely so that the guard cannot
    regress now that nothing intercepts the group first."""
    path = tmp_path / "bare_nogeom.h5"
    with h5py.File(path, "w") as f:
        _write_sparse_group(f, "X", sp.csr_matrix(DENSE), spelling="bare", orientation="csr")
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError) as excinfo:
            imp.source_for_h5_matrix(f["X"])
    message = str(excinfo.value)
    assert "declares no shape" in message and "undeclared" in message, message
    assert "/X" in message, f"the failing node is not named: {message}"


def test_a_non_matrix_group_still_gets_the_engines_unsupported_error(tmp_path):
    """A group that is not sparse-SHAPED at all (no `data`/`indices`/`indptr`) is
    still the engine's to reject — the defensive read added a path for sparse
    geometry, it did not take over deciding what counts as a matrix."""
    path = tmp_path / "not_a_matrix.h5"
    with h5py.File(path, "w") as f:
        g = f.create_group("X")
        g.attrs["encoding-type"] = "dataframe"
        g.create_dataset("index", data=np.arange(4))
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError, match="unsupported h5ad matrix encoding"):
            imp.source_for_h5_matrix(f["X"])


def test_an_indptr_inconsistent_with_the_declared_shape_fails_loud(tmp_path):
    """A file whose declared orientation contradicts its own indptr is CORRUPT. It
    must not be silently re-interpreted as the other orientation — that is a
    transposed matrix delivered as science."""
    path = tmp_path / "inconsistent.h5"
    with h5py.File(path, "w") as f:
        g = _write_sparse_group(f, "X", sp.csr_matrix(DENSE), spelling="h5sparse", orientation="csr")
        # CSR indptr for a 4-row matrix has 5 entries; claim it is 5 columns wide and
        # 4 tall while storing a CSC-shaped indptr instead.
        del g["indptr"]
        g.create_dataset("indptr", data=sp.csc_matrix(DENSE).indptr.astype(np.int32))
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError, match="CSR indptr"):
            imp.source_for_h5_matrix(f["X"])


def test_an_undeclared_orientation_matching_neither_axis_fails_loud(tmp_path):
    """No orientation attribute AND an indptr matching neither rows+1 nor columns+1:
    the discriminator has no answer, so it must say so instead of picking one."""
    path = tmp_path / "bad_indptr.h5"
    with h5py.File(path, "w") as f:
        g = _write_sparse_group(f, "X", sp.csr_matrix(DENSE), spelling="bare", orientation="csr")
        g.attrs["shape"] = np.asarray([N_CELLS, N_GENES], dtype="int64")
        del g["indptr"]
        g.create_dataset("indptr", data=np.array([0, 1, 4], dtype=np.int32))
    with h5py.File(path, "r") as f:
        with pytest.raises(ValueError, match="neither an orientation"):
            imp.source_for_h5_matrix(f["X"])


# ──────────────────── end to end, through the REAL converter ──────────────────

def _invoke_converter(inputs_dir: Path, outputs_dir: Path):
    """Drive the real entry script off-sandbox over a populated inputs dir (the
    `TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR` seam), asserting a clean exit. Mirrors
    `test_convert._invoke_converter`; kept local because each suite in this package
    owns its own harness."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_HELPERS_DIR), str(_LIB_DIR), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    env["TXR_INPUTS_DIR"] = str(inputs_dir)
    env["TXR_OUTPUTS_DIR"] = str(outputs_dir)
    env.pop("TXR_PROGRESS_FIFO", None)
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True
    )
    assert proc.returncode == 0, (
        f"converter exited {proc.returncode}\n--- stdout ---\n{proc.stdout}"
        f"\n--- stderr ---\n{proc.stderr}"
    )
    return json.loads((outputs_dir / "manifest.json").read_text())


def _invoke_converter_failing(inputs_dir: Path, outputs_dir: Path):
    """The same real entry script, for the inputs it must REFUSE: asserts a NON-zero
    exit and hands back the process so the message can be asserted. A converter that
    "succeeds" on an unreadable file is the failure mode under test, so the assertion
    is on the exit code and not merely on the absence of an artifact."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_HELPERS_DIR), str(_LIB_DIR), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    env["TXR_INPUTS_DIR"] = str(inputs_dir)
    env["TXR_OUTPUTS_DIR"] = str(outputs_dir)
    env.pop("TXR_PROGRESS_FIFO", None)
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True
    )
    assert proc.returncode != 0, (
        "the converter exited 0 on a file whose orientation is not in it — this is the "
        f"silent-transpose path\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    )
    return proc


def _run_on(tmp_path, name, spelling, orientation="csr"):
    base = tmp_path / name
    inputs_dir, outputs_dir = base / "inputs", base / "outputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    _write_h5ad(
        inputs_dir / "data.h5ad", sp.csr_matrix(DENSE),
        spelling=spelling, orientation=orientation,
    )
    return _invoke_converter(inputs_dir, outputs_dir), outputs_dir


def _run_square(tmp_path, name, spelling, orientation):
    """The SQUARE fixture as a complete upload-shaped `.h5ad`, run through the real
    entry script. Returns `(inputs_dir, outputs_dir)`; the caller decides whether the
    run is supposed to succeed."""
    base = tmp_path / name
    inputs_dir, outputs_dir = base / "inputs", base / "outputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    _write_h5ad(
        inputs_dir / "data.h5ad", sp.csr_matrix(SQUARE),
        spelling=spelling, orientation=orientation, cells=SQ_CELLS, genes=SQ_GENES,
    )
    return inputs_dir, outputs_dir


def _read_expression(outputs_dir: Path, n_rows: int):
    indptr, indices, data = txr_csc.read_csc(outputs_dir / "expression")
    return sp.csc_matrix(
        (data, indices.astype(np.int64), indptr), shape=(n_rows, len(indptr) - 1)
    )


@pytest.mark.parametrize("orientation", ["csr", "csc"])
def test_an_h5sparse_era_file_converts_end_to_end(tmp_path, orientation):
    """The whole path, on the layout that failed: upload-shaped `.h5ad` in, the real
    entry script, the CSC Zarr artifact out, values read back off the bytes a client
    would read."""
    manifest, outputs_dir = _run_on(tmp_path, f"legacy_{orientation}", "h5sparse", orientation)
    ids = {o["id"] for o in manifest["outputs"]}
    assert "expression" in ids, f"no expression artifact produced: {sorted(ids)}"
    # Both axes still get their key artifact — what the app suite asserts at the catalog.
    assert {"cells_index", "genes_index"} <= ids, sorted(ids)
    _assert_is_the_fixture(_read_expression(outputs_dir, N_CELLS), f"h5sparse/{orientation} e2e")


def test_the_modern_layout_still_converts_identically(tmp_path):
    """NEGATIVE CONTROL for the fix: the spelling that already worked must produce
    exactly the same artifact, byte for byte, as the legacy one — the defensive read
    added a path, it did not reroute the existing one."""
    _, modern_dir = _run_on(tmp_path, "modern", "modern")
    _, legacy_dir = _run_on(tmp_path, "legacy", "h5sparse")
    modern = _read_expression(modern_dir, N_CELLS)
    _assert_is_the_fixture(modern, "modern e2e")
    legacy = _read_expression(legacy_dir, N_CELLS)
    np.testing.assert_array_equal(modern.indptr, legacy.indptr)
    np.testing.assert_array_equal(modern.indices, legacy.indices)
    np.testing.assert_array_equal(modern.data, legacy.data)


def test_the_converted_matrix_matches_scipys_own_transpose(tmp_path):
    """The oracle. `scipy.csr_matrix.tocsc()` is the same counting sort done in RAM,
    so the streamed transpose of a legacy-layout file must equal it exactly — not
    approximately, and not only in the elements this file happens to name."""
    _, outputs_dir = _run_on(tmp_path, "oracle", "h5sparse")
    got = _read_expression(outputs_dir, N_CELLS)
    oracle = sp.csr_matrix(DENSE).tocsc()
    np.testing.assert_array_equal(got.indptr, oracle.indptr)
    np.testing.assert_array_equal(got.indices, oracle.indices)
    np.testing.assert_array_equal(got.data.astype(np.float32), oracle.data.astype(np.float32))


@pytest.mark.parametrize("orientation", ["csc", "csr"])
def test_a_square_undeclared_x_is_refused_by_the_converter(tmp_path, orientation):
    """THE PRODUCTION PATH. `source_for_h5_matrix` is reached from exactly one place
    in anger — the convert step — and that is where the transposed matrix was being
    delivered: `anndata` opens a bare `/X` without complaint, the read + detect steps
    reported a clean 4x4, and the CSC store was written out mirrored with exit 0.

    The run must now FAIL, and the operator-visible stream must carry the reason (the
    `convert|failed` milestone the job surface renders), not just a traceback."""
    inputs_dir, outputs_dir = _run_square(
        tmp_path, f"sq_bare_{orientation}", "bare", orientation
    )
    proc = _invoke_converter_failing(inputs_dir, outputs_dir)
    stream = proc.stderr + proc.stdout
    assert "declares no orientation" in stream, stream[-2000:]
    assert "square" in stream, stream[-2000:]
    assert "milestone|convert|failed" in stream, (
        f"the failure was not reported on the progress stream:\n{stream[-2000:]}"
    )
    # And no expression artifact was left behind for a client to read as science.
    assert not (outputs_dir / "expression").exists(), sorted(
        p.name for p in outputs_dir.iterdir()
    )


@pytest.mark.parametrize("orientation", ["csr", "csc"])
def test_a_square_declared_x_still_converts_through_the_converter(tmp_path, orientation):
    """NEGATIVE CONTROL at the same layer: a square `/X` that DOES declare its
    orientation still runs the whole path and writes the byte-exact matrix, in both
    orientations — the refusal is scoped to the ambiguous case, not to square inputs."""
    inputs_dir, outputs_dir = _run_square(
        tmp_path, f"sq_modern_{orientation}", "modern", orientation
    )
    manifest = _invoke_converter(inputs_dir, outputs_dir)
    ids = {o["id"] for o in manifest["outputs"]}
    assert "expression" in ids, f"no expression artifact produced: {sorted(ids)}"
    _assert_matches_scipy(
        _read_expression(outputs_dir, N_SQ), SQUARE, f"square modern/{orientation} e2e"
    )
