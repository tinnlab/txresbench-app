#!/usr/bin/env python3
# ruff: noqa
"""TEST-36/37 — the streaming CSR→CSC transpose that replaced the SOMA buffer (ITEM-27).

`h5ad_import` used to obtain its CSC gene-expression projection by writing a whole
TileDB-SOMA store and streaming the trio back OUT of it: SOMA was a transpose BUFFER,
and it cost 86 % of the import. `cyto_csc` replaces it with a banded, out-of-core
counting sort that writes Zarr directly.

Two claims, and they pull in opposite directions, which is why both are tested:

  * **TEST-36 — it is EXACTLY right.** `scipy`'s `tocsc` is the ORACLE. Not "close",
    not "same values in some order": `indptr`, `indices` and `data` must come out
    byte-identical, because the previous implementation was byte-identical to the old
    in-memory `write_expression_csc` and a consumer reading a gene column by byte range
    cannot tolerate a permutation. The fixture carries the four cases where a transpose
    goes wrong quietly — duplicate coordinates, an all-zero row, an all-zero column,
    and a 1×1 matrix.

  * **TEST-37 — it is BOUNDED.** `scipy.tocsc` would satisfy TEST-36 perfectly, in four
    lines, and is exactly the "simplification" DEC-11 rejected: it materializes the
    whole matrix, and the converter's stated contract (`h5ad_import.py`, the streaming
    ingest note) is that it NEVER does. So peak RSS is measured, on a matrix many times
    the declared cap, with `scipy.tocsc` run through the SAME harness as a negative
    control — if the substitution were made, the control and the subject would agree and
    the assertion would fail.

The oracle is scipy; the implementation is not. That distinction is the whole point of
this file.
"""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest
import scipy.sparse as sp

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
import cyto_csc  # noqa: E402

LIB = str(Path(__file__).resolve().parents[2] / "_lib")


# ── fixtures ─────────────────────────────────────────────────────────────────────


def h5_csr(path, M, key="X"):
    """Write `M` as an h5ad-style CSR group — the exact shape `h5ad_import` reads."""
    import h5py

    with h5py.File(path, "w") as f:
        g = f.create_group(key)
        g.attrs["encoding-type"] = "csr_matrix"
        g.attrs["shape"] = np.asarray(M.shape, dtype="int64")
        g.create_dataset("data", data=np.asarray(M.data, dtype="float32"))
        g.create_dataset("indices", data=np.asarray(M.indices, dtype="int32"))
        g.create_dataset("indptr", data=np.asarray(M.indptr, dtype="int64"))
    return path


def awkward_matrix():
    """The fixture TEST-36 names: DUPLICATE COORDINATES, an ALL-ZERO ROW, an ALL-ZERO
    COLUMN — plus, for good measure, a row that touches every column and a column
    touched by every row.

    `sum_duplicates()` is not decoration. A COO built with repeated `(row, col)` pairs
    converts to a CSR that carries BOTH entries, which is a NON-CANONICAL matrix: scipy
    itself does not promise a stable rendering of one, so comparing against it would be
    comparing two undefined behaviours. Summing them first makes the duplicate case a
    real matrix whose values CAME from duplicates — interesting instead of malformed.
    """
    rows = [0, 0, 0, 2, 2, 3, 3, 3, 3, 4, 5, 5, 6]
    cols = [1, 1, 4, 0, 4, 0, 1, 2, 4, 4, 1, 1, 0]
    #        ^^^^ duplicate (0,1)                     ^^^^^^ duplicate (5,1)
    vals = [1.0, 2.5, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0]
    # row 1 has no entries at all (all-zero row); column 3 is never named (all-zero col).
    M = sp.coo_matrix((vals, (rows, cols)), shape=(7, 5), dtype=np.float32).tocsr()
    M.sum_duplicates()
    M.sort_indices()
    return M


CASES = {
    "awkward": awkward_matrix,
    "single-element": lambda: sp.csr_matrix(
        ([42.0], ([0], [0])), shape=(1, 1), dtype=np.float32
    ),
    "single-element-off-origin": lambda: sp.coo_matrix(
        ([7.0], ([3], [2])), shape=(5, 4), dtype=np.float32
    ).tocsr(),
    "entirely-empty": lambda: sp.csr_matrix((6, 4), dtype=np.float32),
    "one-dense-row": lambda: sp.csr_matrix(
        np.array([[0, 0, 0], [1, 2, 3], [0, 0, 0]], dtype=np.float32)
    ),
    "one-dense-column": lambda: sp.csr_matrix(
        np.array([[0, 5, 0], [0, 6, 0], [0, 7, 0]], dtype=np.float32)
    ),
}


def oracle(M):
    """scipy is the ORACLE, in exactly the dtypes the CSC store declares."""
    csc = M.tocsc()
    return (
        csc.indptr.astype(np.int64),
        csc.indices.astype(np.uint32),
        csc.data.astype(np.float32),
    )


# ═══════════════════════════ TEST-36 — scipy is the oracle ═══════════════════════


@pytest.mark.parametrize("case", sorted(CASES))
@pytest.mark.parametrize("nnz_cap", [10**9, 3, 1])
def test_transpose_is_byte_identical_to_scipy_tocsc(tmp_path, case, nnz_cap):
    """The whole correctness anchor: same three arrays, byte for byte, at every band
    size — including `nnz_cap=1`, which forces a separate pass per output column and so
    exercises the banding rather than accidentally running the one-band path."""
    M = CASES[case]()
    want_ptr, want_ind, want_dat = oracle(M)

    out = tmp_path / case
    structure = cyto_csc.write_csc_zarr(
        cyto_csc.ArraySource(M), out, nnz_cap=nnz_cap, read_nnz=2,
        axes=("cells", "genes"),
    )
    got_ptr, got_ind, got_dat = cyto_csc.read_csc(out)

    assert got_ptr.dtype == np.int64 and got_ind.dtype == np.uint32
    assert got_dat.dtype == np.float32
    assert got_ptr.tobytes() == want_ptr.tobytes(), "indptr differs from scipy.tocsc"
    assert got_ind.tobytes() == want_ind.tobytes(), "indices differ from scipy.tocsc"
    assert got_dat.tobytes() == want_dat.tobytes(), "data differ from scipy.tocsc"
    assert structure["nnz"] == int(M.nnz)
    assert structure["shape"] == [int(M.shape[0]), int(M.shape[1])]


@pytest.mark.parametrize("case", sorted(CASES))
def test_transpose_from_an_h5_csr_group_matches_scipy(tmp_path, case):
    """The PRODUCTION source: the same claim, read straight off an h5ad-style CSR group
    through h5py rather than from a resident scipy object."""
    M = CASES[case]()
    want_ptr, want_ind, want_dat = oracle(M)
    import h5py

    h5_csr(tmp_path / "m.h5", M)
    out = tmp_path / "out"
    with h5py.File(tmp_path / "m.h5", "r") as f:
        cyto_csc.write_csc_zarr(cyto_csc.source_for_h5(f["X"]), out, nnz_cap=4, read_nnz=3)
    got_ptr, got_ind, got_dat = cyto_csc.read_csc(out)
    assert got_ptr.tobytes() == want_ptr.tobytes()
    assert got_ind.tobytes() == want_ind.tobytes()
    assert got_dat.tobytes() == want_dat.tobytes()


@pytest.mark.parametrize("encoding", ["csr", "csc", "dense"])
def test_every_h5ad_x_encoding_transposes_to_the_same_csc(tmp_path, encoding):
    """An `.h5ad` may hold X as CSR, CSC or a dense block. All three must land on the
    same CSC — the orientation is read from the store, never guessed, because guessing
    it wrong transposes the science silently."""
    import h5py

    M = awkward_matrix()
    want_ptr, want_ind, want_dat = oracle(M)
    path = tmp_path / "m.h5"
    with h5py.File(path, "w") as f:
        if encoding == "dense":
            f.create_dataset("X", data=np.asarray(M.todense(), dtype="float32"))
        else:
            S = M if encoding == "csr" else M.tocsc()
            g = f.create_group("X")
            g.attrs["encoding-type"] = f"{encoding}_matrix"
            g.attrs["shape"] = np.asarray(M.shape, dtype="int64")
            g.create_dataset("data", data=np.asarray(S.data, dtype="float32"))
            g.create_dataset("indices", data=np.asarray(S.indices, dtype="int32"))
            g.create_dataset("indptr", data=np.asarray(S.indptr, dtype="int64"))
    out = tmp_path / "out"
    with h5py.File(path, "r") as f:
        cyto_csc.write_csc_zarr(cyto_csc.source_for_h5(f["X"]), out, nnz_cap=3, read_nnz=2)
    got_ptr, got_ind, got_dat = cyto_csc.read_csc(out)
    assert got_ptr.tobytes() == want_ptr.tobytes()
    assert got_ind.tobytes() == want_ind.tobytes()
    assert got_dat.tobytes() == want_dat.tobytes()


def test_a_non_canonical_csc_source_is_repaired_not_passed_through(tmp_path):
    """A CSC store whose row indices are NOT ascending inside a column is legal on disk
    and illegal on the wire — a byte-range reader assumes sorted rows. The source
    detects and repairs it rather than inheriting the disorder."""
    import h5py

    M = awkward_matrix()
    S = M.tocsc()
    scrambled = S.copy()
    for c in range(S.shape[1]):
        lo, hi = S.indptr[c], S.indptr[c + 1]
        if hi - lo > 1:
            scrambled.indices[lo:hi] = S.indices[lo:hi][::-1]
            scrambled.data[lo:hi] = S.data[lo:hi][::-1]
    path = tmp_path / "m.h5"
    with h5py.File(path, "w") as f:
        g = f.create_group("X")
        g.attrs["encoding-type"] = "csc_matrix"
        g.attrs["shape"] = np.asarray(M.shape, dtype="int64")
        g.create_dataset("data", data=np.asarray(scrambled.data, dtype="float32"))
        g.create_dataset("indices", data=np.asarray(scrambled.indices, dtype="int32"))
        g.create_dataset("indptr", data=np.asarray(scrambled.indptr, dtype="int64"))
    out = tmp_path / "out"
    with h5py.File(path, "r") as f:
        cyto_csc.write_csc_zarr(cyto_csc.source_for_h5(f["X"]), out, nnz_cap=10**9, read_nnz=4)
    want_ptr, want_ind, want_dat = oracle(M)
    got_ptr, got_ind, got_dat = cyto_csc.read_csc(out)
    assert got_ptr.tobytes() == want_ptr.tobytes()
    assert got_ind.tobytes() == want_ind.tobytes()
    assert got_dat.tobytes() == want_dat.tobytes()


def test_a_column_selection_reindexes_and_still_matches_scipy(tmp_path):
    """The per-modality split: `columns=[…]` selects AND re-orders, so output column `j`
    is input column `columns[j]`. Compared against scipy's own fancy-indexed CSC."""
    rng = np.random.default_rng(19)
    M = sp.random(120, 23, density=0.15, format="csr", random_state=4, dtype=np.float32)
    M.sum_duplicates()
    M.sort_indices()
    cols = [9, 0, 22, 4, 4, 17]   # out of order, and one column selected TWICE
    want = M.tocsc()[:, cols].tocsc()

    out = tmp_path / "sel"
    st = cyto_csc.write_csc_zarr(
        cyto_csc.ArraySource(M), out, columns=cols, nnz_cap=7, read_nnz=11
    )
    got_ptr, got_ind, got_dat = cyto_csc.read_csc(out)
    assert got_ptr.tobytes() == want.indptr.astype(np.int64).tobytes()
    assert got_ind.tobytes() == want.indices.astype(np.uint32).tobytes()
    assert got_dat.tobytes() == want.data.astype(np.float32).tobytes()
    assert st["shape"] == [120, len(cols)]


def test_the_band_size_never_changes_the_bytes(tmp_path):
    """`nnz_cap` is a MEMORY dial, not a format one. Every band size must produce the
    same store, byte for byte — otherwise tuning an ops knob would re-mint every
    artifact's `content_hash`."""
    M = sp.random(90, 31, density=0.2, format="csr", random_state=6, dtype=np.float32)
    M.sum_duplicates()
    M.sort_indices()

    def tree(root):
        return {str(p.relative_to(root)): p.read_bytes()
                for p in sorted(Path(root).rglob("*")) if p.is_file()}

    ref = None
    for cap, read in [(10**9, 10**9), (1, 1), (37, 5), (500, 128)]:
        out = tmp_path / f"c{cap}-{read}"
        cyto_csc.write_csc_zarr(cyto_csc.ArraySource(M), out, nnz_cap=cap, read_nnz=read)
        got = tree(out)
        if ref is None:
            ref = got
        else:
            assert got == ref, f"nnz_cap={cap}/read_nnz={read} changed the stored bytes"


def test_the_structure_declares_what_a_reader_needs(tmp_path):
    """`structure` is the producer's decode contract (ITEM-5/INV-2) and is ALSO stamped
    into the group's own `zarr.json`, so the two can never disagree."""
    M = awkward_matrix()
    out = tmp_path / "s"
    st = cyto_csc.write_csc_zarr(cyto_csc.ArraySource(M), out, axes=("cells", "genes"))
    assert st["encoding"] == "zarr_v3" and st["kind"] == "sparse_csc"
    assert st["axes"] == ["cells", "genes"]
    assert st["indptr"]["dtype"] == "int64" and st["indptr"]["shape"] == [M.shape[1] + 1]
    assert st["indices"]["dtype"] == "uint32" and st["indices"]["shape"] == [int(M.nnz)]
    assert st["data"]["dtype"] == "float32" and st["data"]["shape"] == [int(M.nnz)]
    stamped = json.loads((out / "zarr.json").read_text())
    assert stamped["node_type"] == "group"
    assert stamped["attributes"]["cyto"] == st


# ═════════════════ TEST-37 — bounded peak RSS (the anti-`tocsc` gate) ════════════
#
# Peak RSS is measured in a CHILD process. `VmHWM` is a high-water mark that never
# falls, so a delta taken inside the test process would read ~0 whenever an earlier test
# had already pushed the mark up — i.e. it would PASS by accident, which is the one
# outcome a memory gate must not have.

#: The fixture is this many times the declared band cap, so the transpose is forced
#: through many bands rather than accidentally running the single-band path.
RSS_NNZ = 24_000_000
RSS_ROWS = 240_000
RSS_PER_ROW = 100
RSS_COLS = 4_000
RSS_CAP = 2_000_000          # 12 bands
#: Growth over a child that has merely imported the stack and opened the file. Set with
#: headroom over the measured figure, and BELOW what materializing this matrix costs —
#: the negative control proves the gap is real rather than asserted.
RSS_BOUND_MB = 320


CHILD_PREAMBLE = """
import sys, os, json
sys.path.insert(0, {lib!r})
def vmhwm_mb():
    for line in open("/proc/self/status"):
        if line.startswith("VmHWM:"):
            return int(line.split()[1]) / 1024.0
    return -1.0
import numpy, h5py
"""


def _run_child(body, lib=LIB):
    """Run `body` in a fresh interpreter; it must print one JSON line."""
    src = textwrap.dedent(CHILD_PREAMBLE.format(lib=lib)) + textwrap.dedent(body)
    proc = subprocess.run(
        [sys.executable, "-c", src], capture_output=True, text=True, timeout=1800
    )
    assert proc.returncode == 0, f"child failed:\n{proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def big_h5(tmp_path_factory):
    """A CSR matrix far larger than the band cap, written once for the whole module.

    Built by hand rather than via `scipy.random` so generating the fixture does not
    itself allocate several copies of it.
    """
    import h5py

    path = tmp_path_factory.mktemp("rss") / "big.h5"
    rng = np.random.default_rng(0)
    indptr = (np.arange(RSS_ROWS + 1, dtype=np.int64) * RSS_PER_ROW)
    with h5py.File(path, "w") as f:
        g = f.create_group("X")
        g.attrs["encoding-type"] = "csr_matrix"
        g.attrs["shape"] = np.asarray([RSS_ROWS, RSS_COLS], dtype="int64")
        g.create_dataset("indptr", data=indptr)
        d_ind = g.create_dataset("indices", shape=(RSS_NNZ,), dtype="int32")
        d_dat = g.create_dataset("data", shape=(RSS_NNZ,), dtype="float32")
        step = 20_000  # rows per generated block — the fixture is streamed too
        for r in range(0, RSS_ROWS, step):
            r1 = min(r + step, RSS_ROWS)
            blk = rng.integers(0, RSS_COLS, size=(r1 - r, RSS_PER_ROW)).astype(np.int32)
            blk.sort(axis=1)
            d_ind[r * RSS_PER_ROW : r1 * RSS_PER_ROW] = blk.ravel()
            d_dat[r * RSS_PER_ROW : r1 * RSS_PER_ROW] = rng.integers(
                1, 100, size=(r1 - r) * RSS_PER_ROW
            ).astype(np.float32)
    return path


def test_peak_rss_stays_bounded_far_past_the_cap(big_h5, tmp_path):
    """TEST-37 — the property DEC-11 refused to trade away.

    Transposing a matrix ~12× the declared band cap must not grow the process by
    anything like the matrix. Reported as a DELTA over a child that only imported the
    stack, so the interpreter and numpy are not being charged to the transpose.
    """
    out = tmp_path / "big-out"
    result = _run_child(f"""
        base = vmhwm_mb()
        import cyto_csc
        with h5py.File({str(big_h5)!r}, "r") as f:
            src = cyto_csc.source_for_h5(f["X"])
            st = cyto_csc.write_csc_zarr(src, {str(out)!r},
                                         nnz_cap={RSS_CAP}, read_nnz={RSS_CAP})
        print(json.dumps({{"base": base, "peak": vmhwm_mb(), "nnz": st["nnz"]}}))
    """)
    assert result["nnz"] == RSS_NNZ
    grew = result["peak"] - result["base"]
    assert grew < RSS_BOUND_MB, (
        f"the transpose grew the process by {grew:.0f} MB for a {RSS_NNZ:,}-value matrix "
        f"(cap {RSS_CAP:,}). Bounded means bounded: this is what fails if the banded "
        f"counting sort is 'simplified' into a whole-matrix materialization."
    )
    # Pinned so the number is visible in the log rather than only in the failure text.
    print(f"transpose peak growth: {grew:.0f} MB (bound {RSS_BOUND_MB} MB)")


def test_the_rejected_scipy_substitution_would_blow_the_same_bound(big_h5):
    """The NEGATIVE CONTROL, without which the bound above proves nothing.

    `scipy.tocsc` is the four-line implementation DEC-11 rejected. It passes TEST-36
    perfectly. Run through the same harness on the same matrix it exceeds the bound the
    streaming transpose stays under — so the gate discriminates between the two
    implementations rather than merely being satisfiable.
    """
    result = _run_child(f"""
        base = vmhwm_mb()
        import scipy.sparse as sp
        with h5py.File({str(big_h5)!r}, "r") as f:
            g = f["X"]
            M = sp.csr_matrix(
                (g["data"][:], g["indices"][:], g["indptr"][:]),
                shape=tuple(int(x) for x in g.attrs["shape"]),
            )
        csc = M.tocsc()
        print(json.dumps({{"base": base, "peak": vmhwm_mb(), "nnz": int(csc.nnz)}}))
    """)
    grew = result["peak"] - result["base"]
    print(f"scipy.tocsc peak growth: {grew:.0f} MB (bound {RSS_BOUND_MB} MB)")
    assert grew > RSS_BOUND_MB, (
        f"the negative control only grew {grew:.0f} MB, under the {RSS_BOUND_MB} MB bound "
        "the streaming transpose is held to — so this gate no longer distinguishes the "
        "two implementations and the fixture must grow."
    )


def test_peak_rss_does_not_track_the_matrix_size(big_h5, tmp_path):
    """Bounded means FLAT, not merely small: transposing a QUARTER of the columns
    (a quarter of the values) must not cost meaningfully less than the whole thing.
    A materializing implementation's cost would fall with the matrix; a banded one's
    does not, because the band is the same size either way."""
    quarter = list(range(RSS_COLS // 4))
    small = _run_child(f"""
        base = vmhwm_mb()
        import cyto_csc
        with h5py.File({str(big_h5)!r}, "r") as f:
            src = cyto_csc.source_for_h5(f["X"])
            st = cyto_csc.write_csc_zarr(src, {str(tmp_path / "quarter")!r},
                                         columns=list(range({RSS_COLS} // 4)),
                                         nnz_cap={RSS_CAP}, read_nnz={RSS_CAP})
        print(json.dumps({{"base": base, "peak": vmhwm_mb(), "nnz": st["nnz"]}}))
    """)
    assert small["nnz"] < RSS_NNZ // 3, "the quarter selection really is much smaller"
    grew = small["peak"] - small["base"]
    assert grew < RSS_BOUND_MB, f"quarter-selection grew {grew:.0f} MB"
    print(f"quarter-column transpose peak growth: {grew:.0f} MB")
