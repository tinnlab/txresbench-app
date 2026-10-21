#!/usr/bin/env python3
# ruff: noqa
"""cyto_csc — an OUT-OF-CORE row-major → CSC transpose that writes Zarr (ITEM-27).

The problem this exists to solve, stated exactly: a sparse matrix arrives ROW-major
(CSR, or a dense/COO stream), and every column-oriented consumer wants it COLUMN-major
(CSC). The transpose is a permutation of the whole matrix, so the obvious
implementation — `scipy.sparse.csr_matrix.tocsc()` — materializes a second full copy
of the stored values and their indices. On the measured 150k × 32k / 219.7M-nnz case
that is ~1.8 GB of output plus ~1.8 GB of input, and it grows without bound with the
dataset.

The converter that calls this states, in its own docstring, that it "NEVER holds the
whole matrix in RAM". Before this module it kept that promise by writing a TileDB-SOMA
store and streaming the CSC back out of it in column blocks — SOMA was a transpose
BUFFER, not an output, and it cost 73 s (86 %) of a 85 s import for work that is a
counting sort. This module is that counting sort, done directly, with a declared
memory bound instead of an intermediate store.

## The algorithm — a BANDED counting sort

A counting sort is the right shape and everyone reaches for it: count each column's
entries, exclusive-prefix-sum the counts into `indptr`, then scatter every entry to
`indptr[col] + rank`. Two properties make it exact rather than approximate:

  * **the scatter is stable**, so entries land in arrival order; and
  * the input is walked in ROW order,

so each output column's row indices come out ASCENDING **for free** — no per-column
sort, and byte-identical to what `scipy.tocsc` produces. (`scipy`'s `csr_tocsc` is the
same counting sort; that is why it can be used as the ORACLE in TEST-36 without being
used as the implementation.)

The catch is that a single-pass scatter writes to the WHOLE output, so it needs the
whole output resident — the very thing being avoided. So the output columns are cut
into **bands** of at most `nnz_cap` stored values, and one band is materialized at a
time: for band *b*, walk the input, keep the entries whose column falls in the band,
scatter them into the band's buffer, then hand the band to the streaming Zarr writer
(`cyto_zarr.ArrayWriter`, ITEM-28) and drop it. Resident bytes are bounded by the CAP,
not by the matrix, at every dataset size.

**The cost is the tradeoff, and it is explicit**: the input is walked
`ceil(nnz / nnz_cap)` times. `nnz_cap` is therefore a straight memory-for-passes dial —
the default is sized so that essentially every real dataset is ONE pass, and a matrix
several times the cap pays a proportional number of cheap sequential re-reads rather
than an unbounded allocation. Sources may honour the band's column range
(`col_range=`) to skip work; the CSC and dense readers do, which makes their extra
passes nearly free.

The rejected alternative was a one-pass spill: bucket every entry into a per-band temp
file, then read each bucket once. It is strictly fewer input reads, at the cost of an
extra full-size copy on disk, N open writers, and a cleanup obligation on every failure
path. Multi-pass has no new failure mode and no new disk footprint, and the pass count
is one for the datasets that exist today.

## Measured — 40k cells × 20k genes, 39.0M stored values, one host, subprocess `VmHWM`

    tiledbsoma.io.from_h5ad + stream_csc_from_soma   14.82 s      1.76 GB   (what this replaces)
    this module, nnz_cap 64M  (1 band)                9.50 s      0.72 GB
    this module, nnz_cap 16M  (3 bands)               9.32 s      0.54 GB
    this module, nnz_cap  4M  (10 bands)             12.47 s      0.32 GB

Two things worth reading off that table. First, extra bands are CHEAP — ten passes cost
31 % more wall clock than one, so the memory dial is not a performance cliff. Second,
the remaining wall clock is now ENCODE, not transpose: of the 9.50 s, the counting pass
is 0.24 s and the scatter is 3.64 s, and the balance is gzip over 312 MB of output that
the SOMA path used to write uncompressed. The transpose itself stopped being the
bottleneck; compressing the artifact became it.

## What it writes

ONE Zarr v3 group holding the CSC trio as three sharded members::

    <out>/zarr.json      group; `attributes.cyto` IS the returned `structure`
    <out>/indptr/…       int64   [n_cols + 1]
    <out>/indices/…      uint32  [nnz]        row ids, ascending within a column
    <out>/data/…         float32 [nnz]

Geometry is DECLARED (DEC-5), never inferred: `indices`/`data` use the standard 4096
inner chunk (so a consumer gathering one column overfetches at most a chunk) inside
shards whose size is DERIVED from the member's own length and capped (ITEM-35), because
a shard is a FILE and a column-scale array under a fixed small count would emit tens of
thousands of them for one artifact; a reader still byte-ranges INSIDE a shard via its
index, so a bigger shard costs a reader nothing.

The three members are what a consumer addresses: `structure.kind == "sparse_csc"` names
the layout and `structure.indptr` / `.indices` / `.data` each carry the member fragment
(path, dtype, shape, geometry) the reader opens. There is no second, non-Zarr spelling
of a CSC — "everything is Zarr" (§0.3) admits exactly one.

`float32` for `data` matches what the previous raw-binary CSC emitted, so this is not a
new lossy step — but it IS a cast, so the caller is expected to record the source dtype
in the artifact's `meta` rather than let it disappear.

numpy + stdlib at module scope, exactly like `cyto_zarr`/`cyto_columns`; `h5py` is
imported lazily and only inside the HDF5 sources, so importing this module costs the
same floor the rest of `_lib` holds to (DEC-7).
"""
import os

import numpy as np

import cyto_zarr

#: Stored values a single output BAND may hold. The whole memory bound of the transpose:
#: a band costs `nnz_cap * (4 + 4)` bytes of buffer, so the default is ~512 MB — chosen so
#: a realistic single-cell matrix (≲64M stored values) transposes in ONE pass while
#: staying well under the ~1.8 GB the SOMA path it replaces peaked at. Raise it to trade
#: RAM for passes, lower it to trade passes for RAM. Env-overridable for ops tuning.
NNZ_CAP = int(os.environ.get("CYTO_TRANSPOSE_NNZ_CAP", str(64_000_000)))
#: Stored values read from the SOURCE per step. Separate from the band cap because the
#: read buffers carry row + column + value (~12 bytes a piece) and are alive at the same
#: time as the band, so sizing them off the band cap would double the real ceiling.
READ_NNZ = int(os.environ.get("CYTO_TRANSPOSE_READ_NNZ", str(4_000_000)))

#: Declared INNER-chunk geometry (DEC-5). 4096 keeps a one-column gather's overfetch to
#: a chunk. The SHARD count is not a constant here: it is derived per member from that
#: member's own length by `cyto_zarr.shard_chunks` (ITEM-35) — `indices`/`data` from the
#: nnz the counting pass produced, `indptr` from `n_cols + 1`. The two lengths differ by
#: orders of magnitude, so one shared constant is wrong for at least one of them.
VALUE_INNER_CHUNK = 4096
INDPTR_INNER_CHUNK = 4096

INDPTR_DTYPE = "int64"
INDICES_DTYPE = "uint32"
DATA_DTYPE = "float32"


# ── sources ──────────────────────────────────────────────────────────────────────
#
# A source is anything that can answer two questions: how many stored values does each
# COLUMN hold, and what are the entries, IN ROW ORDER. The second is the load-bearing
# one — row order is what makes each output column's rows ascend without a sort.


class _Source:
    """The source protocol. `shape` is `(n_rows, n_cols)`.

    `column_counts()` → an `int64[n_cols]` histogram.

    `iter_entries(read_nnz, col_range=None)` → yields `(rows, cols, values)` blocks in
    ROW-MAJOR order. `col_range` is an `(lo, hi)` HINT: a source may return only the
    entries in that column span (the transpose filters anyway, so honouring it is an
    optimisation, never a correctness requirement).
    """

    shape = (0, 0)

    def column_counts(self):
        raise NotImplementedError

    def iter_entries(self, read_nnz=READ_NNZ, col_range=None):
        raise NotImplementedError


def _row_blocks(indptr, n_rows, read_nnz):
    """Split rows into blocks of ≈`read_nnz` stored values. A single row larger than the
    budget still forms a block of its own — a row is the atom here."""
    r = 0
    while r < n_rows:
        r1 = int(np.searchsorted(indptr, indptr[r] + read_nnz, side="right")) - 1
        if r1 <= r:
            r1 = r + 1
        r1 = min(r1, n_rows)
        yield r, r1, int(indptr[r]), int(indptr[r1])
        r = r1


class H5CsrSource(_Source):
    """An h5ad-style CSR group (`data` / `indices` / `indptr`, `shape` attribute).

    Nothing is loaded but `indptr` (one int64 per row); values and column ids are read
    in `read_nnz` slices straight off the dataset, which is what keeps the whole
    pipeline bounded by a block rather than by the matrix.
    """

    def __init__(self, group, shape=None):
        self._g = group
        if shape is None:
            shape = tuple(int(x) for x in group.attrs["shape"])
        self.shape = (int(shape[0]), int(shape[1]))
        self._indptr = np.asarray(group["indptr"][:], dtype=np.int64)
        if self._indptr.shape[0] != self.shape[0] + 1:
            raise ValueError(
                f"CSR indptr has {self._indptr.shape[0]} entries for {self.shape[0]} rows"
            )

    @property
    def nnz(self):
        return int(self._indptr[-1])

    def column_counts(self):
        counts = np.zeros(self.shape[1], dtype=np.int64)
        ind = self._g["indices"]
        total = self.nnz
        step = max(1, READ_NNZ)
        for lo in range(0, total, step):
            blk = np.asarray(ind[lo : min(lo + step, total)], dtype=np.intp)
            counts += np.bincount(blk, minlength=self.shape[1])
        return counts

    def iter_entries(self, read_nnz=READ_NNZ, col_range=None):
        # `col_range` is ignored: a CSR's entries for a column band are one span PER ROW,
        # so there is no contiguous range to seek to. The band filter in the transpose is
        # what selects them, and reading the block sequentially is faster than issuing a
        # slice per row.
        data, ind, indptr = self._g["data"], self._g["indices"], self._indptr
        for r0, r1, lo, hi in _row_blocks(indptr, self.shape[0], read_nnz):
            if hi <= lo:
                continue
            cols = np.asarray(ind[lo:hi], dtype=np.int32)
            vals = np.asarray(data[lo:hi])
            rows = np.repeat(
                np.arange(r0, r1, dtype=np.int32), np.diff(indptr[r0 : r1 + 1])
            )
            yield rows, cols, vals


class H5CscSource(_Source):
    """An h5ad-style CSC group — `indptr` indexes COLUMNS and `indices` holds row ids.

    Already column-major, so the "transpose" is a re-emission; it still runs through the
    same banded scatter (one code path, one set of proofs) but honours `col_range`, so a
    band reads only its own columns and the extra passes cost nothing.
    """

    def __init__(self, group, shape=None):
        self._g = group
        if shape is None:
            shape = tuple(int(x) for x in group.attrs["shape"])
        self.shape = (int(shape[0]), int(shape[1]))
        self._indptr = np.asarray(group["indptr"][:], dtype=np.int64)
        if self._indptr.shape[0] != self.shape[1] + 1:
            raise ValueError(
                f"CSC indptr has {self._indptr.shape[0]} entries for {self.shape[1]} columns"
            )

    @property
    def nnz(self):
        return int(self._indptr[-1])

    def column_counts(self):
        return np.diff(self._indptr).astype(np.int64)

    def iter_entries(self, read_nnz=READ_NNZ, col_range=None):
        data, ind, indptr = self._g["data"], self._g["indices"], self._indptr
        c_lo, c_hi = (0, self.shape[1]) if col_range is None else col_range
        c = int(c_lo)
        c_hi = int(c_hi)
        while c < c_hi:
            c1 = int(np.searchsorted(indptr, indptr[c] + read_nnz, side="right")) - 1
            if c1 <= c:
                c1 = c + 1
            c1 = min(c1, c_hi)
            lo, hi = int(indptr[c]), int(indptr[c1])
            if hi > lo:
                rows = np.asarray(ind[lo:hi], dtype=np.int32)
                vals = np.asarray(data[lo:hi])
                cols = np.repeat(
                    np.arange(c, c1, dtype=np.int32), np.diff(indptr[c : c1 + 1])
                )
                # The scatter is stable, so the output inherits this block's within-column
                # ordering. Canonical CSC is already row-sorted; a non-canonical store
                # would silently produce unsorted output, so check (cheap) and repair
                # (rare) rather than assume.
                if rows.size > 1:
                    d = np.diff(rows.astype(np.int64))
                    same_col = np.diff(cols) == 0
                    if bool(((d < 0) & same_col).any()):
                        order = np.lexsort((rows, cols))
                        rows, cols, vals = rows[order], cols[order], vals[order]
                yield rows, cols, vals
            c = c1


class H5DenseSource(_Source):
    """A dense 2-D HDF5 dataset. Nonzeros are found per row block, so the entries come
    out row-major like every other source; `col_range` narrows the read."""

    def __init__(self, dset, shape=None):
        self._d = dset
        shape = tuple(int(x) for x in (dset.shape if shape is None else shape))
        if len(shape) != 2:
            raise ValueError(f"a dense matrix source needs a 2-D dataset, got {shape}")
        self.shape = shape

    def column_counts(self):
        counts = np.zeros(self.shape[1], dtype=np.int64)
        for r0, r1 in _dense_row_blocks(self.shape, READ_NNZ):
            blk = np.asarray(self._d[r0:r1])
            counts += np.count_nonzero(blk, axis=0).astype(np.int64)
        return counts

    def iter_entries(self, read_nnz=READ_NNZ, col_range=None):
        c_lo, c_hi = (0, self.shape[1]) if col_range is None else col_range
        for r0, r1 in _dense_row_blocks(self.shape, read_nnz):
            blk = np.asarray(self._d[r0:r1, int(c_lo) : int(c_hi)])
            rr, cc = np.nonzero(blk)
            if rr.size == 0:
                continue
            yield (
                (rr + r0).astype(np.int32),
                (cc + int(c_lo)).astype(np.int32),
                blk[rr, cc],
            )


def _dense_row_blocks(shape, budget):
    per_row = max(1, int(shape[1]))
    rows = max(1, int(budget) // per_row)
    for r0 in range(0, int(shape[0]), rows):
        yield r0, min(r0 + rows, int(shape[0]))


class ArraySource(_Source):
    """An IN-MEMORY scipy sparse / numpy dense matrix.

    For inputs that are already resident — fixtures, tests, and small matrices a caller
    holds anyway. It does NOT make the transpose in-core: the band buffers and the Zarr
    writer stay bounded exactly as they are for an HDF5 source. It just cannot IMPROVE
    on an input that was already whole in RAM, so production paths should hand over an
    HDF5 source instead.
    """

    def __init__(self, mat):
        self._m = mat
        self.shape = (int(mat.shape[0]), int(mat.shape[1]))

    def _csr_parts(self):
        m = self._m
        if hasattr(m, "indptr") and hasattr(m, "indices") and getattr(m, "format", "") == "csr":
            return np.asarray(m.indptr, dtype=np.int64), m.indices, m.data
        return None

    def column_counts(self):
        counts = np.zeros(self.shape[1], dtype=np.int64)
        for _rows, cols, _vals in self.iter_entries():
            counts += np.bincount(np.asarray(cols, dtype=np.intp), minlength=self.shape[1])
        return counts

    def iter_entries(self, read_nnz=READ_NNZ, col_range=None):
        parts = self._csr_parts()
        if parts is not None:
            indptr, indices, data = parts
            for r0, r1, lo, hi in _row_blocks(indptr, self.shape[0], read_nnz):
                if hi <= lo:
                    continue
                yield (
                    np.repeat(np.arange(r0, r1, dtype=np.int32), np.diff(indptr[r0 : r1 + 1])),
                    np.asarray(indices[lo:hi], dtype=np.int32),
                    np.asarray(data[lo:hi]),
                )
            return
        dense = np.asarray(self._m.todense() if hasattr(self._m, "todense") else self._m)
        for r0, r1 in _dense_row_blocks(self.shape, read_nnz):
            blk = dense[r0:r1]
            rr, cc = np.nonzero(blk)
            if rr.size == 0:
                continue
            yield (rr + r0).astype(np.int32), cc.astype(np.int32), blk[rr, cc]


# ── resolving an h5ad matrix node ────────────────────────────────────────────────
#
# Neither the ORIENTATION nor the SHAPE of a sparse group has a single spelling. Two
# eras are in the wild and `anndata` opens both without complaint:
#
#   * **modern** (`anndata` >= 0.7) — `encoding-type` in {`csr_matrix`, `csc_matrix`}
#     and `shape` = `[rows, cols]`.
#   * **h5sparse-era** (`anndata` < 0.7, and anything the `h5sparse` package wrote) —
#     `h5sparse_format` in {`csr`, `csc`} and `h5sparse_shape`. No `encoding-type`, no
#     `shape`. Not an exotic corner: the canonical `pbmc3k_raw.h5ad` is one of these.
#   * **hand-written** — neither attribute, only `data`/`indices`/`indptr`.
#
# This function used to read the MODERN spelling only, and that single gap produced
# three separate wrong answers, all of them silent or bare:
#
#   1. an h5sparse-era group died on `attrs["shape"]` with a bare `KeyError: 'shape'`,
#      naming nothing;
#   2. a group that DECLARED `h5sparse_format = 'csc'` was not seen to have declared
#      anything, fell into the undeclared branch, and — when square — was read as CSR
#      and handed back TRANSPOSED. The file answered the question and the reader
#      ignored the answer, which is why reading both spellings is not symmetry for its
#      own sake: reading only one MANUFACTURES an ambiguity that is not in the file;
#   3. a genuinely undeclared SQUARE group hit `n == rows + 1` and `n == cols + 1` at
#      once, and the first-match `if`/`if` took CSR unconditionally — every square CSC
#      store transposed, exit 0, no warning.
#
# So orientation and shape are each resolved from whatever the group actually carries,
# and where the file does not answer, this REFUSES rather than guesses. Two rules bound
# how hard it tries. An undeclared ORIENTATION is recovered from the `indptr` length
# only where that length can tell the two apart — on a NON-SQUARE matrix, where
# `rows + 1` and `cols + 1` are different numbers. On a square store they are the same
# number and the file carries no other signal (the two attribute spellings above are
# the only ones that exist; the member datasets and parent groups carry no orientation;
# `anndata`'s own `_get_group_format` raises rather than infer; and structurally a CSC
# store IS a valid CSR store when square, since `indices` is bounded by `shape[1]`
# under CSR and `shape[0]` under CSC — the same number). An undeclared SHAPE is not
# recovered at all, because the only available inference, `max(indices) + 1`, silently
# drops every trailing all-zero column.
#
# A square SYMMETRIC store is refused too, even though either reading returns the same
# values: establishing symmetry means reading the whole matrix, which is exactly the
# bound this module exists to keep.
#
# `anndata-import`'s `h5ad_import.source_for_h5_matrix` used to carry a second copy of
# these helpers and of the sparse branch below, because the version of `source_for_h5`
# it was written against read the modern spelling alone. It no longer does, so that copy
# is gone and the name there is now an alias for this function — one resolver, one place
# to fix. Keep it that way: a second copy of a refusal whose job is to stop a silent
# transpose does not double the safety, it just gives the two copies somewhere to drift
# apart. The dependency still runs one way only (`_lib` is staged into the sandbox
# `/code` dir and cannot import a processor), which is why the resolver lives HERE.

#: Attributes that may name a sparse group's ORIENTATION, newest spelling first.
SPARSE_FORMAT_ATTRS = ("encoding-type", "h5sparse_format")
#: Attributes that may declare a sparse group's SHAPE, newest spelling first.
SPARSE_SHAPE_ATTRS = ("shape", "h5sparse_shape")
#: The three members every sparse encoding stores, whatever it calls itself.
SPARSE_MEMBERS = ("data", "indices", "indptr")


def h5_attr_text(node, name):
    """One h5 attribute as `str`, or `None` when absent.

    Older writers store a string attribute as fixed-length bytes, and sometimes as a
    0-d or 1-element ARRAY of them, which h5py hands back as `bytes`/`np.bytes_`/
    `np.ndarray` rather than `str` — comparing that to `"csr"` is silently always
    false, i.e. exactly the "the file declared it and the reader did not see it" miss
    this whole block exists to stop making."""
    if name not in node.attrs:
        return None
    v = node.attrs[name]
    if isinstance(v, np.ndarray):
        if v.size != 1:
            return None
        v = v.reshape(-1)[0]
    if isinstance(v, (bytes, np.bytes_)):
        v = bytes(v).decode("utf-8", "replace")
    return str(v)


def h5_sparse_format(node):
    """`"csr"` / `"csc"` / `None` — the DECLARED orientation of a sparse group.

    `encoding-type='csr_matrix'` and `h5sparse_format='csr'` name the same thing; both
    normalize to the bare orientation. `None` means the group declares no orientation
    at all (it is dense, not a matrix, or hand-written)."""
    for name in SPARSE_FORMAT_ATTRS:
        raw = h5_attr_text(node, name)
        if not raw:
            continue
        fmt = raw.strip().lower()
        if fmt.endswith("_matrix"):
            fmt = fmt[: -len("_matrix")]
        if fmt in ("csr", "csc"):
            return fmt
    return None


def h5_matrix_shape(node):
    """`(rows, cols)` of an h5ad matrix node, or `None` when the file declares none.

    A dense dataset carries its own shape; a sparse group declares it in `shape`
    (modern) or `h5sparse_shape` (h5sparse-era)."""
    import h5py

    if isinstance(node, h5py.Dataset):
        dims = tuple(int(x) for x in node.shape)
        return dims if len(dims) == 2 else None
    for name in SPARSE_SHAPE_ATTRS:
        if name not in node.attrs:
            continue
        dims = np.asarray(node.attrs[name]).reshape(-1)
        if dims.size == 2:
            return (int(dims[0]), int(dims[1]))
    return None


def source_for_h5(node):
    """Pick the right source for an h5ad matrix node: a CSR/CSC group by its declared
    orientation, else a dense dataset. Fail-LOUD on anything else, and on anything
    ambiguous — guessing the orientation of a matrix silently transposes the science,
    and nothing downstream can tell. See the block comment above for the format
    versions this reads and for what is deliberately not inferred."""
    import h5py

    if isinstance(node, h5py.Dataset):
        return H5DenseSource(node)

    fmt = h5_sparse_format(node)
    missing = [m for m in SPARSE_MEMBERS if m not in node]
    if fmt is None and missing:
        # Not sparse-SHAPED and not declaring itself sparse: this is the engine's
        # canonical "that is not a matrix" rejection, and callers key off its text.
        enc = h5_attr_text(node, SPARSE_FORMAT_ATTRS[0])
        if enc is None:
            enc = h5_attr_text(node, SPARSE_FORMAT_ATTRS[1])
        raise ValueError(f"unsupported h5ad matrix encoding {enc!r} at {node.name}")

    declared = sorted(str(k) for k in node.attrs.keys())
    if missing:
        raise ValueError(
            f"h5ad sparse matrix {node.name!r} declares itself {fmt!r} but is missing "
            f"{', '.join(missing)}: a sparse group stores "
            f"{', '.join(SPARSE_MEMBERS)}. Found members {sorted(node.keys())}."
        )

    shape = h5_matrix_shape(node)
    if shape is None:
        raise ValueError(
            f"h5ad sparse matrix {node.name!r} (format "
            f"{fmt if fmt is not None else 'undeclared'}) declares no shape: looked for "
            f"{' / '.join(SPARSE_SHAPE_ATTRS)}, found attributes {declared}. The matrix "
            "width is not in the file, and inferring it from the largest stored index "
            "would drop every trailing all-zero column."
        )

    n_indptr = int(node["indptr"].shape[0])
    if fmt is None:
        # Orientation undeclared (hand-written store): the indptr length is the only
        # signal the file carries, and it DISCRIMINATES only where the two candidate
        # lengths differ. On a square matrix `rows + 1` and `cols + 1` are the same
        # number, so both tests pass at once and a first-match branch would read every
        # square CSC store as CSR and hand back its transpose. Square is not exotic —
        # an adjacency, connectivity or correlation matrix is one — so the ambiguous
        # case is REFUSED, in the same terms the missing-shape case above uses.
        is_csr = n_indptr == shape[0] + 1
        is_csc = n_indptr == shape[1] + 1
        if is_csr and is_csc:
            raise ValueError(
                f"h5ad sparse matrix {node.name!r} declares no orientation "
                f"({' / '.join(SPARSE_FORMAT_ATTRS)}) and is square {shape}, so its "
                f"indptr cannot supply one: {n_indptr} entries is both "
                f"{shape[0] + 1} rows+1 (CSR) and {shape[1] + 1} cols+1 (CSC). "
                f"Found attributes {declared}. Reading it as either orientation would "
                "silently deliver the transpose of the stored matrix; declare "
                f"{SPARSE_FORMAT_ATTRS[0]} = 'csr_matrix'/'csc_matrix' (or "
                f"{SPARSE_FORMAT_ATTRS[1]} = 'csr'/'csc') on the group."
            )
        if is_csr:
            fmt = "csr"
        elif is_csc:
            fmt = "csc"
        else:
            raise ValueError(
                f"h5ad sparse matrix {node.name!r} declares neither an orientation "
                f"({' / '.join(SPARSE_FORMAT_ATTRS)}) nor an indptr consistent with "
                f"its shape {shape}: indptr has {n_indptr} entries, which matches "
                f"neither {shape[0] + 1} rows+1 (CSR) nor {shape[1] + 1} cols+1 (CSC)."
            )

    # A DECLARED orientation is trusted, and the source constructor cross-checks it
    # against the indptr length — a `csr` group carrying a column-length indptr fails
    # there rather than being quietly re-read as the other orientation here.
    return (H5CsrSource if fmt == "csr" else H5CscSource)(node, shape=shape)


# ── the transpose ────────────────────────────────────────────────────────────────


def column_bands(indptr, nnz_cap):
    """Cut the output columns into maximal runs holding ≤ `nnz_cap` stored values.

    A column whose own count exceeds the cap forms a band by itself — one column is the
    atom, so the true bound is `max(nnz_cap, largest column)`. For an expression matrix
    that ceiling is the number of ROWS, which is why the property holds in practice and
    not just on paper.
    """
    n = int(indptr.shape[0]) - 1
    b0 = 0
    while b0 < n:
        b1 = int(np.searchsorted(indptr, indptr[b0] + int(nnz_cap), side="right")) - 1
        if b1 <= b0:
            b1 = b0 + 1
        b1 = min(b1, n)
        yield b0, b1
        b0 = b1


def _scatter_band(source, sel, indptr, b0, b1, lut, read_nnz, data_dtype):
    """Materialize output columns `[b0, b1)` — the counting sort's scatter, banded.

    Returns `(indices, values)` for the band, in final CSC order.
    """
    nb = b1 - b0
    base = int(indptr[b0])
    band_nnz = int(indptr[b1]) - base
    out_ind = np.empty(band_nnz, dtype=np.uint32)
    out_val = np.empty(band_nnz, dtype=np.dtype(data_dtype))
    cursor = (indptr[b0:b1] - base).astype(np.int64)

    band_cols = sel[b0:b1]
    lut[band_cols] = np.arange(nb, dtype=np.int64)
    col_range = (int(band_cols.min()), int(band_cols.max()) + 1) if nb else None
    try:
        for rows, cols, vals in source.iter_entries(read_nnz, col_range=col_range):
            oc = lut[np.asarray(cols, dtype=np.intp)]
            keep = oc >= 0
            if not bool(keep.all()):
                oc = oc[keep]
                if oc.size == 0:
                    continue
                rows = rows[keep]
                vals = vals[keep]
            elif oc.size == 0:
                continue
            # Stable by column: entries keep their arrival (row) order inside a column,
            # which is what makes the output's row indices ascend without a sort.
            order = np.argsort(oc, kind="stable")
            oc = oc[order]
            cnt = np.bincount(oc, minlength=nb)
            grp_start = np.zeros(nb, dtype=np.int64)
            np.cumsum(cnt[:-1], out=grp_start[1:])
            pos = np.repeat(cursor, cnt) + (
                np.arange(oc.size, dtype=np.int64) - np.repeat(grp_start, cnt)
            )
            out_ind[pos] = np.asarray(rows, dtype=np.uint32)[order]
            out_val[pos] = np.asarray(vals, dtype=np.dtype(data_dtype))[order]
            cursor += cnt
    finally:
        lut[band_cols] = -1  # leave the lookup clean for the next band

    expected = (indptr[b0 + 1 : b1 + 1] - base).astype(np.int64)
    if not np.array_equal(cursor, expected):
        raise RuntimeError(
            "transpose scatter did not fill the band exactly — the counting pass and the "
            "scatter pass disagree about the matrix (did the source change under us?)"
        )
    return out_ind, out_val


#: The `structure` keys this writer OWNS. `structure_extra` may not name any of them:
#: they are the decode contract the bytes were written against, and a caller that could
#: overwrite one would be re-declaring the layout of bytes it did not write — the exact
#: producer-declares-its-own-shallower-check shape the conformance gate exists to refuse.
_WRITER_OWNED_STRUCTURE_KEYS = frozenset(
    {"encoding", "kind", "axes", "shape", "nnz", "indptr", "indices", "data"}
)


def write_csc_zarr(source, out_dir, *, columns=None, counts=None, nnz_cap=None,
                   read_nnz=None, data_dtype=DATA_DTYPE, axes=("rows", "columns"),
                   attributes=None, structure_extra=None):
    """Transpose `source` (row-major) into a CSC Zarr store at `out_dir`.

    `columns` optionally SELECTS and RE-INDEXES the output columns — output column `j`
    is input column `columns[j]` — which is how one matrix is split into per-modality
    projections without a second read of the whole thing.

    `counts` lets a caller that already ran `source.column_counts()` (e.g. because it is
    writing several column subsets of one matrix) skip the counting pass.

    `structure_extra` merges caller-named keys into the returned `structure` — and
    therefore into the group stamp, since both come from the SAME dict. It exists because
    a `structure` key is the only producer declaration that travels with the BYTES: the
    manifest row's `meta` is a catalog column, and a sandboxed consumer holding nothing but
    a staged store reads `<store>/zarr.json` → `attributes.cyto`. A caller with a fact
    about its artifact that a downstream job must read therefore has to put it here.
    Domain-free by construction: this writer never names one of these keys, it only
    carries them.

    The keys are constrained in ONE direction — [`_WRITER_OWNED_STRUCTURE_KEYS`] is
    refused, so the decode contract cannot be rewritten by a caller. Merging happens
    BEFORE the stamp for the same reason it is a single dict: two copies written from two
    places is precisely the drift `conformance._conform_group_attributes` fails on.

    Returns the producer-declared `structure`, which is also stamped into the group's
    `zarr.json` — so a client handed nothing but the store URL learns the layout from
    the first request it was going to make anyway.
    """
    from pathlib import Path

    out_dir = Path(out_dir)
    # Checked BEFORE a byte is written: the whole transpose is an out-of-core streaming
    # pass, so discovering a bad argument at the end would mean paying for the write and
    # then leaving a half-declared store behind on the way out.
    clashes = sorted(set(structure_extra or ()) & _WRITER_OWNED_STRUCTURE_KEYS)
    if clashes:
        raise ValueError(
            f"structure_extra may not redeclare the writer-owned key(s) {clashes} — "
            "they are the decode contract these bytes were written against"
        )
    nnz_cap = NNZ_CAP if nnz_cap is None else int(nnz_cap)
    read_nnz = READ_NNZ if read_nnz is None else int(read_nnz)
    if nnz_cap < 1 or read_nnz < 1:
        raise ValueError("nnz_cap and read_nnz must be positive")
    n_rows, n_cols_in = source.shape
    if n_rows > np.iinfo(np.uint32).max:
        raise ValueError(f"{n_rows} rows exceeds what a uint32 row index can address")

    # ── pass 1: count ────────────────────────────────────────────────────────────
    counts = source.column_counts() if counts is None else np.asarray(counts, dtype=np.int64)
    if int(counts.shape[0]) != n_cols_in:
        raise ValueError(
            f"column counts have {counts.shape[0]} entries for {n_cols_in} input columns"
        )
    sel = (np.arange(n_cols_in, dtype=np.int64) if columns is None
           else np.asarray(columns, dtype=np.int64))
    if sel.size and (int(sel.min()) < 0 or int(sel.max()) >= n_cols_in):
        raise ValueError("a selected column is outside the source's column range")
    n_cols = int(sel.shape[0])
    indptr = np.zeros(n_cols + 1, dtype=np.int64)
    np.cumsum(counts[sel], out=indptr[1:])
    nnz = int(indptr[-1])

    # ── pass 2..N: one band at a time ────────────────────────────────────────────
    #
    # `expected_n=nnz` is the ITEM-35 geometry hint. The counting pass has ALREADY run,
    # so nnz is exact here rather than a guess — but it still has to be handed over as a
    # hint because an `ArrayWriter` seals shards as bands arrive and cannot look at a
    # length that does not exist yet.
    w_ind = cyto_zarr.ArrayWriter(
        out_dir, "indices", dtype=INDICES_DTYPE, inner_chunk=VALUE_INNER_CHUNK,
        expected_n=nnz, dimension_names=["nnz"],
        attributes={"cyto": {"kind": "numeric", "name": "indices", "role": "indices"}},
    )
    w_dat = cyto_zarr.ArrayWriter(
        out_dir, "data", dtype=data_dtype, inner_chunk=VALUE_INNER_CHUNK,
        expected_n=nnz, dimension_names=["nnz"],
        attributes={"cyto": {"kind": "numeric", "name": "data", "role": "data"}},
    )
    lut = np.full(n_cols_in, -1, dtype=np.int64)
    n_bands = 0
    for b0, b1 in column_bands(indptr, nnz_cap):
        band_ind, band_val = _scatter_band(
            source, sel, indptr, b0, b1, lut, read_nnz, data_dtype
        )
        w_ind.append(band_ind)
        w_dat.append(band_val)
        del band_ind, band_val
        n_bands += 1
    e_ind = w_ind.close()
    e_dat = w_dat.close()
    e_ptr = cyto_zarr.write_array(
        out_dir, "indptr", indptr, inner_chunk=INDPTR_INNER_CHUNK,
        dimension_names=["columns+1"],
        attributes={"cyto": {"kind": "numeric", "name": "indptr", "role": "indptr"}},
    )

    structure = {
        "encoding": "zarr_v3",
        "kind": "sparse_csc",
        "axes": [str(a) for a in axes],
        "shape": [int(n_rows), n_cols],
        "nnz": nnz,
        "indptr": e_ptr,
        "indices": e_ind,
        "data": e_dat,
    }
    if structure_extra:
        structure.update(structure_extra)
    attrs = dict(attributes or {})
    attrs["cyto"] = structure
    cyto_zarr.write_group(out_dir, attrs)
    return structure


# ── reading it back (producer-side only) ─────────────────────────────────────────


def read_csc(root):
    """Read a CSC store back as `(indptr, indices, data)`.

    The mirror of `cyto_zarr_read`: NOT part of the serving path (the server never opens
    a byte, and the browser has its own zero-dependency reader) — it is here so a
    downstream processor, or a test asserting what a processor emitted, does not
    re-derive the container by hand.
    """
    import cyto_zarr_read

    return (
        cyto_zarr_read.read_array(root, "indptr"),
        cyto_zarr_read.read_array(root, "indices"),
        cyto_zarr_read.read_array(root, "data"),
    )
