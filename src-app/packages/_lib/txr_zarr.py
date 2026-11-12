#!/usr/bin/env python3
# ruff: noqa
"""txr_zarr — the TxResBench Zarr v3 **sharded writer** (ITEM-1..4, DEC-4/5/6/7).

Everything a processor emits is Zarr. There is no Parquet, no TileDB, no SOMA and
no Arrow IPC on the wire: an artifact is ONE directory that IS a Zarr v3 store, and
the browser reads it with `DecompressionStream('gzip')`, `TextDecoder` and
typed-array views — **zero dependencies on either side**.

This module is the producer half of that contract. It is deliberately
dependency-light (**numpy + stdlib only**, DEC-7): it ships in the processor rootfs,
never in the server binary, because the server must not gain a format writer or
ITEM-20's dependency guard fails by construction.

## What gets written

    <root>/zarr.json                 the GROUP node (one artifact = one directory)
    <root>/<col>/zarr.json           a member ARRAY node
    <root>/<col>/c/0, c/1, ...       one SHARD per file

Each shard is `[encoded inner chunk][encoded inner chunk]…[index][crc32c]`. The index
is `chunks_per_shard` pairs of little-endian u64 `(offset, nbytes)`, with
`(2**64-1, 2**64-1)` marking an empty chunk, followed by the crc32c of the index
bytes — i.e. `index_location: "end"` with `index_codecs: [bytes, crc32c]`.

## Encoding — shuffle + gzip, NOT blosc (DEC-4)

Byte-shuffle then gzip measures at 97.4% of blosc's ratio while staying decodable by
`DecompressionStream('gzip')` plus a ~10-line transpose. Blosc would drag a WASM codec
back into the client. The shuffle codec is declared as the registered extension
`numcodecs.shuffle`; it is OMITTED for 1-byte element types, where it is the identity.

## Three logical kinds (ITEM-2/3/4)

  * **numeric**     — a typed array, shuffle + gzip. 1-D (a column) or 2-D (an
                      embedding: rows chunked, full width per chunk).
  * **categorical** — `uint8`/`uint16` CODES plus the DECLARED level set, published as
                      `attributes.txr.levels` on the member's `zarr.json`. The width
                      comes from `len(levels)`, **never** from the observed codes
                      (DEC-6): observed-width selection silently re-encodes when a
                      level goes unused, changing the bytes and therefore the
                      artifact's `content_hash` for identical meaning.
  * **string**      — arrow layout, SPLIT form: a `uint32` `offsets` member (shuffled +
                      gzipped) and a `uint8` `values` member holding concatenated UTF-8
                      (gzip only — a 1-byte shuffle is a no-op), under a group tagged
                      `{kind: "string", layout: "split", n}`. Splitting the two is what
                      lets the offsets take the shuffle the design's measurement is of.

A **table** (ITEM-4) is *n* of those sharing one axis, written as members of ONE
directory so they carry ONE merkle identity and cannot drift apart.

## Determinism is a correctness requirement, not a nicety

Artifacts are immutable and content-addressed: a "mutation" is a NEW artifact, so the
same input must produce the same bytes or an unchanged column mints a new
`content_hash` on every re-run. Everything here is therefore fixed rather than
sampled: the gzip container is hand-built with `mtime=0` and a fixed XFL/OS byte
(CPython's `gzip.compress` header has varied across versions), the code width comes
from the declaration, dict/JSON ordering is insertion-ordered, and no geometry is
inferred from the data. The one input outside this module's control is zlib's own
deflate output, which is stable for a pinned toolchain — the processor rootfs.

## Explicit, with no fallbacks (INV-2)

`dtype` is required. `levels` is required. A value outside the declared level set is an
error, not a silently-added level. A `None` in a categorical or string column is an
error unless the caller declares what it means via `missing=`. Absence is an error; "if
absent, assume X" is not a thing this module does.

## The on-disk vocabulary is a CROSS-LANGUAGE contract

`attributes.txr.{kind, levels, n, layout}` and the `offsets`/`values` member names are
read verbatim by the browser's zero-dependency reader
(`ui/src/core/workstore/zarrReader.ts`). They are not free-form: renaming one here
breaks a consumer in another language that this module has no compile-time link to.
"""
import base64
import hashlib
import json
import re
import struct
import unicodedata
import zlib
from pathlib import Path

import numpy as np

# ── geometry (DEC-5) ─────────────────────────────────────────────────────────────
# `inner_chunk = 4096` is the measured sweet spot for the SPARSE case: the tuning
# sweep trades index size against OVERFETCH (the real cost), and 4096 minimizes
# bytes-actually-fetched for a realistic gene-column gather.
INNER_CHUNK = 4096
# The shard CAP, in inner chunks (ITEM-35). A shard holds at most this many inner
# chunks; an array needing fewer gets exactly as many as it has.
#
# WHY A CAP AND NOT A CONSTANT. `chunks_per_shard` sizes the index UNCONDITIONALLY —
# the trailer is `chunks_per_shard * 16` bytes with unwritten slots left as the EMPTY
# sentinel — so a constant is wrong at BOTH ends of the scale, in opposite directions:
#
#   constant 8     a 10M column becomes 306 FILES. File count is what hurts when data
#                  is moved: rsync, S3 upload, backup, GC walks and the job-input
#                  hardlink tree all pay per object, and `resolve_member` decodes the
#                  whole manifest per request, so the manifest grows with it.
#   constant 4096  a 100K column gets a 64 KB index in front of 14 KB of data — 82% of
#                  the file is `ffffffffffffffff` padding for chunks that don't exist.
#
# Deriving the count from `n` and capping it keeps the index at ~0.25% of the payload
# from 100K to 219M elements, and puts any array up to ~16.8M elements in ONE file.
# This is arithmetic on values the producer already declared (`n`, `inner_chunk`), not
# inference about the data — DEC-5's "declared, never inferred" still holds, and an
# explicit `chunks_per_shard=` still overrides.
#
# THIS IS THE DEFAULT ON EVERY PRODUCTION PATH, not an opt-in. `write_array`, `Table.*`
# and `txr_columns` all reach it by leaving `chunks_per_shard` unset; `ArrayWriter`
# cannot derive it (shards seal as rows arrive, before `n` is known) so it takes
# `expected_n` and derives from that instead. A constant left in any of those defaults
# would silently reinstate the 306-files-per-10M-column behaviour this exists to remove.
SHARD_CAP_CHUNKS = 4096
# The last-resort floor: an `ArrayWriter` given NEITHER an explicit `chunks_per_shard`
# NOR an `expected_n` has nothing to derive from, so it takes the conservative small-array
# count. Every in-tree caller supplies one or the other.
CHUNKS_PER_SHARD = 8


def shard_chunks(n, inner_chunk, cap=SHARD_CAP_CHUNKS):
    """Inner chunks per shard for an array of `n` elements: as many as it needs, capped.

    `max(1, ...)` so a zero-length array still declares a valid (positive) grid.
    """
    return max(1, min(-(-int(n) // int(inner_chunk)), int(cap)))
# A `uint8` payload (concatenated UTF-8) has no element structure to overfetch, so it
# chunks 16× coarser — 4096-byte chunks would be pure per-chunk overhead.
BYTES_INNER_CHUNK = 65536
GZIP_LEVEL = 5

ZARR_FORMAT = 3
#: The sharding index's "this chunk is empty" sentinel, per the v3 sharding codec.
EMPTY = (1 << 64) - 1
#: `len(levels)` at or below this writes `uint8` codes; above it, `uint16` (DEC-6).
UINT8_MAX_LEVELS = 256
UINT16_MAX_LEVELS = 65536

_NUMERIC_DTYPES = (
    "int8", "int16", "int32", "int64",
    "uint8", "uint16", "uint32", "uint64",
    "float32", "float64", "bool",
)


# ── crc32c (Castagnoli, reflected poly 0x82F63B78) — the v3 index checksum ────────
_CRC32C_TABLE = []
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = (_c >> 1) ^ (0x82F63B78 if _c & 1 else 0)
    _CRC32C_TABLE.append(_c)


def crc32c(data, crc=0):
    """The crc32c of `data`, as the `crc32c` index codec computes it."""
    crc ^= 0xFFFFFFFF
    for b in data:
        crc = _CRC32C_TABLE[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


# ── codecs ───────────────────────────────────────────────────────────────────────

def byte_shuffle(buf, itemsize):
    """Group the bytes of a packed array by BYTE POSITION — `numcodecs.shuffle`.

    `[e0b0 e0b1 e1b0 e1b1 …]` becomes `[e0b0 e1b0 … e0b1 e1b1 …]`, which is what makes
    gzip's window see runs of near-identical high bytes. The inverse on the client is
    the same transpose the other way (~10 lines of typed-array code), which is the
    whole reason DEC-4 could drop blosc.
    """
    if itemsize == 1:
        return bytes(buf)
    a = np.frombuffer(buf, dtype=np.uint8)
    if a.size % itemsize:
        raise ValueError(f"buffer of {a.size} bytes is not a multiple of itemsize {itemsize}")
    return a.reshape(-1, itemsize).T.tobytes()


def gzip_bytes(data, level=GZIP_LEVEL):
    """A DETERMINISTIC RFC-1952 gzip stream — what `DecompressionStream('gzip')` eats.

    The container is hand-built rather than taken from `gzip.compress` because that
    function's header bytes (MTIME, XFL) have varied across CPython versions, and a
    header byte that moves would change every artifact's `content_hash` on a
    toolchain bump for byte-identical data.
    """
    co = zlib.compressobj(level, zlib.DEFLATED, -zlib.MAX_WBITS)
    body = co.compress(data) + co.flush()
    # ID1 ID2 CM FLG MTIME(=0) XFL(=0) OS(=255 "unknown"); then deflate, crc32, isize.
    return (
        b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff"
        + body
        + struct.pack("<II", zlib.crc32(data) & 0xFFFFFFFF, len(data) & 0xFFFFFFFF)
    )


def encode_chunk(raw, itemsize, level=GZIP_LEVEL):
    """One inner chunk's stored bytes: shuffle (unless 1-byte) then gzip."""
    return gzip_bytes(byte_shuffle(raw, itemsize), level)


def _codec_chain(itemsize, level=GZIP_LEVEL):
    """The inner `codecs` chain: array→bytes, then the bytes→bytes pair."""
    chain = [{"name": "bytes", "configuration": {"endian": "little"}}]
    if itemsize > 1:
        chain.append(
            {"name": "numcodecs.shuffle", "configuration": {"elementsize": int(itemsize)}}
        )
    chain.append({"name": "gzip", "configuration": {"level": int(level)}})
    return chain


# ── the array writer ─────────────────────────────────────────────────────────────

def _fill_value(dtype):
    """The v3 `fill_value` for `dtype` — what an unwritten position reads as, and what
    a tail chunk shorter than `inner_chunk` is padded WITH."""
    if dtype.kind == "b":
        return False
    if dtype.kind == "f":
        return 0.0
    return 0


def _array_meta(dtype, n, width, inner_chunk, chunks_per_shard, dimension_names,
                attributes, level):
    """The member's `zarr.json` document.

    ONE builder, shared by every entry point. `zarr.json` is part of the artifact's
    merkle identity, so a second hand-rolled copy of this dict is a byte-drift hazard:
    a key reordered in one copy mints a different `content_hash` for identical data.
    """
    shard_rows = inner_chunk * chunks_per_shard
    shape = [n] if width is None else [n, width]
    chunk_shape = [shard_rows] if width is None else [shard_rows, width]
    inner_shape = [inner_chunk] if width is None else [inner_chunk, width]
    meta = {
        "zarr_format": ZARR_FORMAT,
        "node_type": "array",
        "shape": shape,
        "data_type": dtype.name,
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": chunk_shape}},
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": _fill_value(dtype),
        "codecs": [{
            "name": "sharding_indexed",
            "configuration": {
                "chunk_shape": inner_shape,
                "codecs": _codec_chain(int(dtype.itemsize), level),
                "index_codecs": [
                    {"name": "bytes", "configuration": {"endian": "little"}},
                    {"name": "crc32c"},
                ],
                "index_location": "end",
            },
        }],
        "attributes": dict(attributes or {}),
    }
    if dimension_names is not None:
        meta["dimension_names"] = list(dimension_names)
    return meta


class ArrayWriter:
    """Write ONE sharded Zarr v3 array by APPENDING blocks — never holding it whole
    (ITEM-28).

    `write_array` takes a fully-materialized numpy array, which is fine for a column
    but impossible for a stream: the CSR→CSC transpose (ITEM-27) produces its output
    one gene block at a time and the whole thing is, by construction, the size of the
    matrix. This class is the same encoder driven incrementally::

        w = txr_zarr.ArrayWriter(root, "indices", dtype="uint32")
        for block in gene_blocks:
            w.append(block)          # blocks of ANY length, chunk-boundary-agnostic
        entry = w.close()            # → the same `structure` fragment write_array returns

    **The bytes are the contract, not the call pattern.** For the same values this
    produces the SAME `zarr.json`, the SAME shard bytes and the SAME crc32c as
    `write_array` — one append of 10,000 rows and 10,000 appends of one row are
    indistinguishable on disk. That is not a coincidence to be re-checked: `write_array`
    IS this class (it appends once and closes), so there is exactly one encoder and it
    cannot drift from itself. TEST-35 pins the property anyway, because the equality
    that matters is between *call patterns*, which the shared implementation does not
    make free — a bug in the chunk-boundary buffering would still change the bytes.

    Why byte-identity is a correctness requirement and not a nicety: an artifact is
    addressed by the hash of its bytes, so two writers that disagree by one byte mint
    two `content_hash` values for one meaning — two artifacts where the model says
    there is one.

    Memory: bounded by ONE shard (`inner_chunk * chunks_per_shard` values, encoded) plus
    at most one pending inner chunk plus the caller's own block. Nothing scales with the
    total length.

    `shape[0]` is not known until `close()`, so `zarr.json` is written LAST. Everything
    else — geometry, dtype, codecs, attributes — is declared up front (DEC-5/INV-2: the
    writer never infers geometry from the data it happens to receive).
    """

    def __init__(self, root, name, *, dtype, width=None, inner_chunk=INNER_CHUNK,
                 chunks_per_shard=None, expected_n=None, dimension_names=None,
                 attributes=None, level=GZIP_LEVEL):
        # Shards are sealed AS ROWS ARRIVE, so `chunks_per_shard` is fixed at
        # construction — it cannot be derived from `n` the way `write_array` does,
        # because `n` is not known until `close()`. `expected_n` is the caller's
        # geometry HINT: being wrong costs a suboptimal file count, never correctness
        # (an array that outgrows the hint simply seals more shards). Neither given ⇒
        # the conservative small-array default.
        if chunks_per_shard is None:
            chunks_per_shard = (shard_chunks(expected_n, inner_chunk)
                                if expected_n is not None else CHUNKS_PER_SHARD)
        if inner_chunk < 1 or chunks_per_shard < 1:
            raise ValueError(f"{name!r}: geometry must be positive")
        dtype = np.dtype(dtype)
        if dtype.name not in _NUMERIC_DTYPES:
            raise ValueError(f"{name!r}: unsupported dtype {dtype.name!r}")
        if width is not None and int(width) < 1:
            raise ValueError(f"{name!r}: a 2-D array needs at least one column")
        self.name = name
        # Force little-endian storage so a big-endian host writes the same bytes.
        self._dtype = dtype.newbyteorder("<")
        self._dtype_name = dtype.name
        self._itemsize = int(dtype.itemsize)
        self._width = None if width is None else int(width)
        self._inner_chunk = int(inner_chunk)
        self._chunks_per_shard = int(chunks_per_shard)
        self._dimension_names = dimension_names
        self._attributes = attributes
        self._level = level
        self._fill = _fill_value(dtype)
        self._pad_shape = ((self._inner_chunk,) if self._width is None
                           else (self._inner_chunk, self._width))

        self._adir = Path(root) / name
        (self._adir / "c").mkdir(parents=True, exist_ok=True)

        self._pending = []        # appended rows not yet sealed into an inner chunk
        self._pending_n = 0
        self._body = bytearray()  # the current shard's encoded chunks
        self._index = np.full((self._chunks_per_shard, 2), EMPTY, dtype="<u8")
        self._slot = 0            # next inner-chunk slot in the current shard
        self._shards = 0
        self._n = 0
        self._stored = 0
        self._closed = False

    # -- appending -------------------------------------------------------------

    def append(self, values):
        """Append rows. Any length, including zero and including more than one shard."""
        if self._closed:
            raise RuntimeError(f"{self.name!r}: this ArrayWriter is already closed")
        a = np.ascontiguousarray(values, dtype=self._dtype)
        if self._width is None:
            if a.ndim != 1:
                raise ValueError(f"{self.name!r}: expected 1-D blocks, got {a.ndim}-D")
        else:
            if a.ndim != 2 or int(a.shape[1]) != self._width:
                raise ValueError(
                    f"{self.name!r}: expected blocks of width {self._width}, got shape {a.shape}"
                )
        rows = int(a.shape[0])
        if rows == 0:
            return
        self._pending.append(a)
        self._pending_n += rows
        self._n += rows
        while self._pending_n >= self._inner_chunk:
            self._emit(self._take(self._inner_chunk))

    def _take(self, k):
        """Pop exactly `k` rows off the pending queue, concatenating only when a block
        straddles the boundary (the common case is a no-copy view)."""
        head = self._pending[0]
        if int(head.shape[0]) >= k:
            block = head[:k]
            if int(head.shape[0]) == k:
                self._pending.pop(0)
            else:
                self._pending[0] = head[k:]
            self._pending_n -= k
            return block
        parts, got = [], 0
        while got < k:
            p = self._pending.pop(0)
            take = int(p.shape[0])
            if got + take <= k:
                parts.append(p)
                got += take
            else:
                need = k - got
                parts.append(p[:need])
                self._pending.insert(0, p[need:])
                got = k
        self._pending_n -= k
        return np.concatenate(parts)

    def _emit(self, block):
        """Encode ONE inner chunk (padding a short tail) and place it in the shard."""
        rows = int(block.shape[0])
        if rows < self._inner_chunk:
            # A chunk is ALWAYS chunk_shape elements; the tail is padded with
            # `fill_value` and the array's `shape` is what bounds a reader.
            pad = np.full(self._pad_shape, self._fill, dtype=self._dtype)
            pad[:rows] = block
            block = pad
        enc = encode_chunk(np.ascontiguousarray(block).tobytes(), self._itemsize, self._level)
        self._index[self._slot] = (len(self._body), len(enc))
        self._body += enc
        self._slot += 1
        if self._slot == self._chunks_per_shard:
            self._flush_shard()

    def _flush_shard(self):
        """Seal the current shard: `[chunks…][index][crc32c]`, index_location=end."""
        idx = self._index.tobytes()
        body = self._body
        body += idx
        body += crc32c(idx).to_bytes(4, "little")
        key = f"{self._shards}" if self._width is None else f"{self._shards}/0"
        dest = self._adir / "c" / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(bytes(body))
        self._stored += len(body)
        self._shards += 1
        self._body = bytearray()
        self._index[:] = EMPTY
        self._slot = 0

    # -- finish ----------------------------------------------------------------

    def close(self):
        """Flush the tail chunk + partial shard, write `zarr.json`, return the
        member's `structure` fragment."""
        if self._closed:
            raise RuntimeError(f"{self.name!r}: this ArrayWriter is already closed")
        if self._pending_n:
            self._emit(self._take(self._pending_n))
        if self._slot:
            self._flush_shard()
        _write_json(
            self._adir / "zarr.json",
            _array_meta(np.dtype(self._dtype_name), self._n, self._width,
                        self._inner_chunk, self._chunks_per_shard,
                        self._dimension_names, self._attributes, self._level),
        )
        self._closed = True
        return {
            "path": self.name,
            "kind": "numeric",
            "dtype": self._dtype_name,
            "shape": [self._n] if self._width is None else [self._n, self._width],
            "inner_chunk": self._inner_chunk,
            "chunks_per_shard": self._chunks_per_shard,
            "shards": self._shards,
            "stored_bytes": int(self._stored),
        }

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None and not self._closed:
            self.close()
        return False


def write_array(root, name, arr, *, inner_chunk=INNER_CHUNK,
                chunks_per_shard=None, dimension_names=None,
                attributes=None, level=GZIP_LEVEL):
    """Write ONE numpy array as a sharded Zarr v3 array under `<root>/<name>`.

    `arr` is 1-D (a column) or 2-D (rows × cols, e.g. an embedding). A 2-D array is
    chunked along the ROWS only — each chunk carries the full width — so the shard
    index is the same flat sequence a 1-D array produces and a consumer that wants one
    row fetches exactly one chunk.

    `inner_chunk`/`chunks_per_shard` are the DECLARED geometry (DEC-5); pass an
    `inner_chunk` ≥ `len(arr)` to write a single chunk for a small read-whole array.

    This is the whole-array FRONT END to `ArrayWriter` — one append, one close — so the
    batch and streaming paths are the same encoder by construction rather than by
    parallel maintenance (ITEM-28 / TEST-35).

    Returns the member's `structure` fragment.
    """
    if arr.ndim not in (1, 2):
        raise ValueError(f"{name!r}: write_array takes 1-D or 2-D arrays, got {arr.ndim}-D")
    # `n` is known here, so the geometry follows the array unless the caller declared it.
    if chunks_per_shard is None:
        chunks_per_shard = shard_chunks(arr.shape[0], inner_chunk)
    if inner_chunk < 1 or chunks_per_shard < 1:
        raise ValueError(f"{name!r}: geometry must be positive")
    dtype = arr.dtype
    if dtype.name not in _NUMERIC_DTYPES:
        raise ValueError(f"{name!r}: unsupported dtype {dtype.name!r}")
    width = int(arr.shape[1]) if arr.ndim == 2 else None
    if width is not None and width < 1:
        raise ValueError(f"{name!r}: a 2-D array needs at least one column")
    w = ArrayWriter(root, name, dtype=dtype, width=width, inner_chunk=inner_chunk,
                    chunks_per_shard=chunks_per_shard, dimension_names=dimension_names,
                    attributes=attributes, level=level)
    w.append(arr)
    return w.close()


def _write_json(path, obj):
    """One JSON writer so every metadata document is byte-stable (fixed separators,
    insertion order preserved, no trailing whitespace drift)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=False))


def write_group(path, attributes=None):
    """Write a Zarr v3 GROUP node — the artifact root, and the parent of a string
    column's two members."""
    _write_json(Path(path) / "zarr.json",
                {"zarr_format": ZARR_FORMAT, "node_type": "group",
                 "attributes": dict(attributes or {})})


# ── categorical (ITEM-2) ─────────────────────────────────────────────────────────

def code_dtype(levels):
    """The code width for a DECLARED level set (DEC-6).

    Taken from `len(levels)` and nothing else. Deriving it from the observed codes would
    make an unused level change the stored bytes — and therefore the artifact's
    `content_hash` — for a column that means exactly the same thing.
    """
    n = len(levels)
    if n <= UINT8_MAX_LEVELS:
        return np.dtype("uint8")
    if n <= UINT16_MAX_LEVELS:
        return np.dtype("uint16")
    raise ValueError(
        f"{n} levels exceeds the {UINT16_MAX_LEVELS} a uint16 code can address; "
        "a set this large is a string column, not a categorical"
    )


def codes_from_labels(values, levels, missing=None):
    """Map labels onto their index in the DECLARED `levels`.

    A label outside the declared set is an error — the declaration is the contract, so
    a stray value means the declaration is wrong, not that the set should grow.
    `missing` names the level a `None`/NaN stands for; without it a missing value is an
    error too (INV-2 — absence is an error).
    """
    index = {c: i for i, c in enumerate(levels)}
    if len(index) != len(levels):
        raise ValueError("the declared levels contain duplicates")
    if missing is not None and missing not in index:
        raise ValueError(f"missing={missing!r} is not one of the declared levels")
    out = np.empty(len(values), dtype=np.int64)
    for i, v in enumerate(values):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            if missing is None:
                raise ValueError(
                    f"value {i} is missing and no `missing=` level was declared"
                )
            out[i] = index[missing]
            continue
        try:
            out[i] = index[v]
        except KeyError:
            raise ValueError(
                f"value {i} is {v!r}, which is not in the declared level set"
            ) from None
    return out


# ── string (ITEM-3) ──────────────────────────────────────────────────────────────

def stored_strings(values, missing=None):
    """The exact `str` sequence a string member STORES, after the writer's own coercion.

    Split out of [`arrow_encode`] because two callers need the SAME coercion: the encoder
    that writes the bytes, and the key digest that has to describe what those bytes will
    say. A second copy of the `None`→`missing` / `str(v)` rule would drift, and a key
    digest taken over the PRE-coercion values would disagree with the stored member for
    reasons that are not a misalignment.
    """
    out = []
    for i, v in enumerate(values):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            if missing is None:
                raise ValueError(
                    f"value {i} is missing and no `missing=` string was declared"
                )
            v = missing
        out.append(str(v))
    return out


def arrow_encode(values, missing=None):
    """Pack strings into the arrow layout: `(uint32 offsets[n+1], uint8 utf8 values)`.

    `offsets[i]..offsets[i+1]` bounds value `i`, so an empty string is a zero-length
    span and needs no sentinel. As with categoricals, a `None` is an error unless the
    caller declares `missing=` — the writer never invents a value.
    """
    strings = stored_strings(values, missing=missing)
    offsets = np.empty(len(strings) + 1, dtype=np.uint32)
    offsets[0] = 0
    buf = bytearray()
    for i, s in enumerate(strings):
        buf += s.encode("utf-8")
        if len(buf) > 0xFFFFFFFF:
            raise ValueError("string column exceeds the 4 GiB a uint32 offset can address")
        offsets[i + 1] = len(buf)
    return offsets, np.frombuffer(bytes(buf), dtype=np.uint8)


# ── the axis key digest (ITEM-19 / INV-3) ────────────────────────────────────────
#
# WHY THIS PRIMITIVE LIVES IN THE WRITER, NOT IN THE GATE.
#
# INV-3 says an axis IS its key artifact and its identity is that artifact's
# `content_hash`. A producer cannot emit that: the merkle root is computed by INGEST,
# over bytes the producer has only just finished writing, so "declare your
# `content_hash`" is not a thing any writer can do. What a producer CAN declare is what
# makes its bytes identifiable as an axis — the ORDERED KEY SEQUENCE those bytes carry.
# That is this digest, and it is the producer's half of INV-3:
#
#   producer  →  `key` (WHICH member holds the keys) + `key_sequence_digest` (WHAT that
#                member's ordered keys are), both computable from what it is writing.
#   ingest    →  `content_hash`, the identity the server keys on.
#
# The digest is a DECLARATION, so it is checked rather than trusted: the framework-owned
# gate (`_lib/conformance.py`, which runs OUTSIDE the processor over the bytes that
# actually landed — DEC-8) RECOMPUTES it from the stored member and refuses a mismatch.
# That is what makes the declaration worth anything, and it is why the digest computed
# here is taken over the values the writer is ABOUT TO STORE (its intent) rather than
# read back from the file it just wrote: an intent digested from the same file the gate
# reads would agree with the gate no matter what the encoder did to the values on the
# way out, which is precisely the failure a digest exists to catch.
#
# `conformance.py` imports these two functions rather than carrying its own copy — the
# comparison it makes is only meaningful if both sides digest the same way. The import
# runs in that direction ONLY (the gate may import the writer; a staged module importing
# the gate would put the gate inside the process it judges, which DEC-8 rules out and
# `test_conformance.py::test_the_gate_is_not_reachable_from_the_processors_own_process`
# fails on).


def key_sequence_digest(values):
    """A sha256 over an ORDERED key sequence.

    Each key is length-prefixed before hashing so the digest cannot be fooled by
    re-splitting: `["ab", "c"]` and `["a", "bc"]` concatenate to the same bytes and MUST
    NOT digest the same. Integer keys hash as their canonical little-endian int64 so an
    `int32` and an `int64` column holding the same ids agree.

    Order sensitivity is the whole property. Two arrays holding the same keys in a
    different order describe DIFFERENT alignments — row 3 means a different entity in
    each — and a digest that could not tell them apart would certify the exact failure it
    exists to catch.
    """
    h = hashlib.sha256()
    n = 0
    for value in values:
        raw = _key_bytes(value)
        h.update(len(raw).to_bytes(8, "little"))
        h.update(raw)
        n += 1
    h.update(b"\xff" + n.to_bytes(8, "little"))
    return h.hexdigest()


#: The `vocab_sketch` budget (ITEM-51). A producer-side constant, so two producers on two
#: deployments make the same declaration about the same vocabulary.
#:
#: Above it the sketch is ABSENT — never truncated — and `vocab_digest` goes with it (see
#: `vocab_declaration`). A truncated sketch would answer SUBSET wrongly while looking
#: exactly like a right answer.
MAX_VOCAB_SKETCH_BYTES = 64 * 1024

#: Bytes of each level's SHORT hash in the sketch. 8 is the width at which a collision
#: between two of ~6k levels is ~2^-40 — far below the rate at which a producer writes a
#: vocabulary at all — while keeping the sketch inside the budget above for the level counts
#: a real column has.
VOCAB_SKETCH_HASH_BYTES = 8


def normalise_levels(levels, *, missing_level=None):
    """The vocabulary a digest is taken over — the PRODUCER's declared levels, canonicalised.

    Three rules, and each one is a mismatch that would otherwise be reported as honest:

    1. **Unicode NFC.** Two producers can write the same character decomposed differently.
       Encoding-stable is a requirement here, not a nicety.
    2. **Booleans canonicalise to this writer's own lowercase pair** (``"false"``/``"true"``).
       The divergence is already in this codebase: a bool column's declared levels are
       lowercase (`txr_columns.write_metadata_column`'s bool branch) while a pandas
       CATEGORICAL of booleans stringifies to ``"True"``/``"False"``. The same logical
       vocabulary, two spellings — and left alone they would digest differently and suppress
       a correct offer.
    3. **The synthesized MISSING level is EXCLUDED.** `write_metadata_column` invents a level
       for pandas' ``-1`` code and records it as ``meta.missing_level``. It is an encoding
       artifact of THAT dataset's missingness, not part of the vocabulary — including it
       would make two genuinely identical vocabularies disagree whenever one dataset happened
       to have missing values, which is the false mismatch this digest exists to remove.

    No case folding and no trimming beyond rule 2: ``"A"`` and ``"a"`` are different levels,
    and asserting otherwise silently merges columns that mean different things.

    `ordered` is deliberately NOT an input: it is a property of the SEQUENCE, and this is a
    SET. Under **DEC-E** that is the end of the matter rather than the start of one — an
    `ordered` categorical fuses by UNIONING its level set exactly like an unordered one, so
    there is no ordered-specific arm here and none is wanted. (The superseded rule, that
    either side declaring `ordered` made the pair undecidable, was withdrawn: nothing
    downstream consumes the sequence — colouring and value-allow-list filtering do not — and
    legend order belongs to viz core. Each source's declared order is recorded on the
    alignment as evidence instead.)
    """
    out = []
    for level in levels:
        text = unicodedata.normalize("NFC", str(level))
        if missing_level is not None and text == unicodedata.normalize("NFC", str(missing_level)):
            continue
        out.append(text)
    # Rule 2 — decided over the WHOLE set, because "is this a boolean vocabulary" is not a
    # per-level question: a categorical whose single observed level is `True` is not a
    # boolean vocabulary, it is a one-level vocabulary that happens to spell its level that
    # way, and folding it would merge it with an unrelated column named the same.
    if {t.lower() for t in out} == {"false", "true"} and len(out) == 2:
        out = [t.lower() for t in out]
    return out


def vocab_declaration(levels, *, missing_level=None):
    """`{vocab_digest, vocab_sketch}` for a level set — BOTH, or NEITHER (ITEM-51).

    ## What each answers, and why one field could not

    `vocab_digest` is an ORDER-INDEPENDENT SET HASH: hash each normalised level on its own,
    SORT the per-level hashes, hash the concatenation. Sorting rather than XOR-combining
    keeps it a real hash rather than a commutative combiner, and it is order-independent by
    construction. The digest itself is 32 bytes regardless of cardinality, so two producers
    that wrote the same vocabulary agree exactly whether it has 3 levels or 3,000.

    ## The RANGE this actually covers — it is not "any cardinality"

    The predecessor's prose claimed 32 bytes "at ANY cardinality, whether it has 3 levels or
    300,000". **That claim is false here, and it is false because of the both-or-neither rule
    below**: above `MAX_VOCAB_SKETCH_BYTES` the sketch does not fit, and the digest is dropped
    WITH it. Measured on this implementation the pair is present up to and including
    **6,144 levels** and absent from 6,145 (8 bytes/level, base64'd, against a 64 KiB budget).

    So the honest range is `50 < n <= 6144` — the band where `meta.categories` (capped at 50
    entries AND 1024 bytes) cannot answer but the sketch still fits. That is a real and useful
    band, and it is most obs columns. It is NOT the tail: a 35,477-level `gene_symbol` gets no
    pair at all, and its offer is `undecidable` — which is exactly the case DEC-19 answers by
    offering the pair marked unverified rather than hiding it. Do not read this declaration as
    solving high cardinality; it solves the middle, and the undecidable arm carries the rest.

    A set hash answers EQUALITY and cannot answer SUBSET, because subset needs the elements.
    So `vocab_sketch` carries them: the same sorted per-level short hashes, concatenated and
    base64'd, emitted whenever they fit `MAX_VOCAB_SKETCH_BYTES`. Above that it is absent and
    the consumer's subset arm degrades to `undecidable` — never to a guess.

    ## Why this exists at all — and what it is NOT for

    `meta.categories` provably cannot answer: it is capped at 50 entries AND 1024 bytes
    (`_helpers/colsummary.py`), and a count does not bound bytes. Subset decidability is
    what `authority` mode's level-drop needs (INV-11: the offer decision must be answerable
    from the CATALOG, and the resolver deciding what to list must not fetch a body).

    **This is an OFFER FILTER, never a compatibility INFERENCE.** It decides what the form
    LISTS; the user still declares the fusion (INV-1). Its predecessor on the abandoned
    `dimension-membership` round was built to infer compatibility at view time, and that use
    is superseded — do not reintroduce it.

    ## THE CONSISTENCY RULE — both, or neither, and never one

    A sketch can go stale relative to the levels it summarises, so it may never be read as a
    partial answer. Both fields are produced HERE, in one pass, from ONE normalised level
    list: there is no path through this function that returns one without the other. When the
    sketch does not fit, the DIGEST IS DROPPED TOO.

    That last clause is the part worth stating, because dropping only the sketch is the
    obvious alternative and it is wrong: a tree carrying a digest with no sketch is a state
    this design does not produce, so encountering one means something rewrote one of them,
    which means neither can be trusted. The consumer's rule is therefore "exactly one present
    ⇒ undecidable", and that rule is only sound if the writer genuinely cannot emit one
    alone. `_conform_vocab_declaration` is the gate-side half.
    """
    normalised = normalise_levels(levels, missing_level=missing_level)
    shorts = sorted(
        hashlib.sha256(_length_prefixed_level(level)).digest()[:VOCAB_SKETCH_HASH_BYTES]
        for level in normalised
    )
    sketch = base64.b64encode(b"".join(shorts)).decode("ascii")
    if len(sketch) > MAX_VOCAB_SKETCH_BYTES:
        return {}
    h = hashlib.sha256()
    for short in shorts:
        h.update(short)
    # The COUNT, terminated, for the same reason `key_sequence_digest` terminates: without it
    # the concatenation of two sorted hash lists is ambiguous at the join.
    h.update(b"\xff" + len(shorts).to_bytes(8, "little"))
    return {"vocab_digest": h.hexdigest(), "vocab_sketch": sketch}


def _length_prefixed_level(level):
    """One level's bytes, length-prefixed — so `["ab", "c"]` and `["a", "bc"]` cannot hash
    the same. The same defence `key_sequence_digest` applies, for the same reason."""
    raw = level.encode("utf-8")
    return len(raw).to_bytes(8, "little") + raw


def _declared_digest(value):
    """A caller-supplied `key_sequence_digest`, checked for SHAPE at the writer (ITEM-15).

    The gate checks whether the digest is the RIGHT one; this checks that it is a digest at
    all. Without it, `aligned_to=obs_names` — passing the key sequence where the digest goes,
    the obvious slip — would stamp `"Index([…])"` into the artifact row as an alignment
    declaration, and the only thing that would ever notice is a picker silently offering
    nothing.
    """
    if not isinstance(value, str) or not _HEX64.fullmatch(value):
        raise ValueError(
            f"aligned_to={value!r} is not a key_sequence_digest — pass the DIGEST the axis's "
            "key artifact declared (`structure['key_sequence_digest']`), not the keys "
            "themselves and not a label"
        )
    return value


_HEX64 = re.compile(r"[0-9a-f]{64}")


def _key_bytes(value):
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, (bool, np.bool_)):
        return int(value).to_bytes(8, "little", signed=True)
    if isinstance(value, (int, np.integer)):
        return int(value).to_bytes(8, "little", signed=True)
    raise TypeError(
        f"a key is a string or an integer, not {type(value).__name__} — a float key has "
        "no canonical spelling and would digest differently for equal values"
    )


# ── membership: WHICH members of an axis these rows are (ITEM-1/3/5) ─────────────
#
# `aligned_to` says WHICH axis a table's rows rest on. It does not say WHICH ROWS OF IT
# they are, and for every artifact that is not the whole axis that is the question a
# consumer is actually asking: a population of 6,000 selected out of 1,000,000 declares
# the same `aligned_to` as the parent, so on the declarations alone the two are
# indistinguishable and a consumer painting one onto the other is off by the difference,
# silently.
#
# A membership closes that: per entity axis the artifact touches, `{axis, aligned_to,
# kind, n_members}` — WHICH axis (by identity, not by label) and WHICH of its rows. It is
# an ARRAY because an artifact integrating two datasets rests on two axes at once and
# neither one of them is "the" one.
#
# The member SET itself is stored twice, deliberately, split by use:
#   * inline as `bitmap` — a bounded, base64 blob on the DECLARATION, so a consumer can
#     answer "how much of this coordinate does that column describe" from the catalog
#     alone, with no body read at all.
#   * as an index BODY — an ordinary `uint32` member holding the positions in ascending
#     order. This is the gather list, and it is the authority: the inline copy is present
#     only when it fits the budget below, the body always is.
# The two are written from ONE position list in one call, so they cannot disagree.

#: The per-entry budget for the INLINE member set (DEC-3). A FIXED constant, not an
#: admin setting, for two reasons that are both about what a declaration MEANS: it is
#: enforced inside a producer running in a sandbox with `env_clear` and no database, so
#: there is no settings row to read; and the value must be IDENTICAL for every producer
#: or two artifacts' declarations stop being comparable, which is the one thing the whole
#: membership model rests on. A per-deployment budget would make the same artifact
#: declare different things in different deployments.
#:
#: 64 KiB per ENTRY, under the run-level `MAX_MANIFEST_BYTES = 1 MiB` ceiling that
#: `sandbox/outputs.rs` already enforces (and FAILS the run past). That ceiling bounds the
#: WHOLE run's manifest rather than one entry, so this is the conservative division: a run
#: emitting a dozen subset artifacts stays well inside it, and a run that does not is
#: refused loudly by the existing check rather than silently truncated here.
#:
#: Above the budget the `bitmap` is ABSENT — never truncated. A truncated member set is a
#: wrong answer that looks like a right one; an absent one is a state a consumer renders
#: ("undecidable") rather than a number it invents.
MAX_MEMBERSHIP_BITMAP_BYTES = 64 * 1024


def encode_member_set(positions):
    """A strictly-ascending list of member positions → the inline `bitmap` blob.

    Base64 over a DELTA-VARINT (LEB128) encoding: each position is stored as its gap from
    the previous one, and each gap as a base-128 varint. Ascending order makes every gap
    positive, and a contiguous run — the common shape of a selected population — costs one
    byte per member.

    ## Why not a roaring bitmap

    The plan named one, and roaring is the right answer when a dependency is available. It
    is not here, in either of the two places this blob has to be understood: `txr_zarr` is
    numpy + stdlib by construction (DEC-7 — it is vendored into every processor's sandbox),
    and the browser consumer that reads this field has no roaring either. So "roaring"
    means hand-writing a compressed-container format TWICE and keeping the two byte-exact —
    the hand-rolled-parser class this repo has already paid for twice, for a blob whose
    size is capped at 64 KiB anyway.

    Delta-varint buys what the budget actually needs and nothing else: it is ~40 lines on
    each side, it is round-trip tested against the positions themselves rather than against
    a golden blob, and on the shape that matters (a contiguous or near-contiguous selection)
    it is within a byte per member of what roaring would store. Where it is genuinely worse
    — a maximally scattered set over a huge axis — the entry exceeds the budget and the
    `bitmap` is absent, which is a state the model already has and already renders.
    """
    out = bytearray()
    previous = -1
    for value in positions:
        position = int(value)
        if position < 0:
            raise ValueError(f"a member position is an index, not {position}")
        if position <= previous:
            raise ValueError(
                f"member positions must be STRICTLY ASCENDING — {position} follows "
                f"{previous}. A set is not an order, but the STORED sequence is, and a "
                "consumer intersecting two member sets walks them in one pass"
            )
        gap = position - previous
        previous = position
        while gap >= 0x80:
            out.append((gap & 0x7F) | 0x80)
            gap >>= 7
        out.append(gap)
    return base64.b64encode(bytes(out)).decode("ascii")


def decode_member_set(blob):
    """The inverse of [`encode_member_set`] — the exact member positions, ascending.

    Present so the round trip is testable from the writer's own side, and so the
    conformance gate can compare the inline copy against the stored body without
    re-implementing the encoding (two implementations of one format is the drift this
    module's whole header argues against).
    """
    raw = base64.b64decode(blob, validate=True)
    out = []
    previous = -1
    gap = 0
    shift = 0
    started = False
    for byte in raw:
        started = True
        gap |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
            continue
        previous += gap
        out.append(previous)
        gap = 0
        shift = 0
        started = False
    if started:
        raise ValueError("truncated member set — the last varint has no terminating byte")
    return out


def _membership_entries(membership, table_axis, table_n):
    """Normalise the producer's `membership=` into `structure.memberships` (ITEM-1/4/5).

    Each input entry is a dict:

      * `aligned_to`  — REQUIRED. The axis's identity, as its key artifact's
        `key_sequence_digest`. A label decides nothing; only this identifies.
      * `derived_from` — REQUIRED. The axis key artifact this membership was selected out
        of: either its `structure` dict (the ordinary case — the producer has it, having
        just written or read it) or its ordered key sequence. Its digest is recomputed
        here and must EQUAL `aligned_to`.
      * `members` — the member POSITIONS into that axis, ascending; `None` (or omitted)
        declares the whole axis, `kind: full`.
      * `axis` — the axis LABEL. Optional only when this is the sole entry, in which case
        it is the table's own declared axis: that is reading the producer's adjacent
        statement, not inventing one. With two memberships neither label is derivable and
        both must be named.
      * `member` — the Zarr member the index body lands in. Optional (default `members`)
        only when this is the sole entry; with two, the writer will not invent two names.

    ## Why `derived_from` is required, and why the two are compared

    `aligned_to` alone is a claim, and the claim this one makes is the expensive kind: a
    membership carrying positions selected out of axis X while declaring axis Y gathers
    the right COUNT of the wrong rows, paints a complete and plausible picture, and errs
    by however far the two axes' orders differ. Nothing downstream can detect it — both
    declarations are well-formed and the bytes are all present.

    So the writer refuses to take the claim on its own: it is given the thing the
    positions were selected out of and checks that the two are one axis. It is the same
    shape as the importer's existing assertion of its computed digest against what the
    writer stored, and the same shape as `close()`'s refusal of a table that declares both
    a key member and a DIFFERENT `aligned_to` — a producer's two statements about one
    thing must agree, and the disagreement is decidable here without opening a byte.
    """
    if membership is None:
        return []
    entries = [membership] if isinstance(membership, dict) else list(membership)
    if not entries:
        return []
    sole = len(entries) == 1
    out = []
    seen_members = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise TypeError(
                f"a membership is a dict of declarations, not {type(entry).__name__}"
            )
        aligned_to = _declared_digest(entry.get("aligned_to"))
        axis = entry.get("axis", table_axis if sole else None)
        if not isinstance(axis, str) or not axis.strip():
            raise ValueError(
                "a membership names the axis it is ON — with two memberships neither "
                "label is derivable from the table's single `axis`, so both must be named"
            )
        derived_digest, axis_n = _axis_evidence(entry.get("derived_from"))
        if derived_digest != aligned_to:
            raise ValueError(
                f"this membership declares aligned_to={aligned_to[:12]}… while the axis it "
                f"was derived from digests to {derived_digest[:12]}… — the positions were "
                "selected out of one axis and are being declared against another, which "
                "gathers the right NUMBER of the wrong rows and cannot be detected "
                "downstream (every declaration is well-formed and every byte is present)"
            )
        positions = entry.get("members")
        member_name = entry.get("member", "members" if sole else None)
        if positions is None:
            if axis_n is None:
                raise ValueError(
                    f"the {axis!r} membership declares the WHOLE axis (kind=full) but the "
                    "axis it was derived from does not state its length, so `n_members` "
                    "would have to be guessed"
                )
            record = {"axis": axis, "aligned_to": aligned_to, "kind": "full",
                      "n_members": int(axis_n)}
        else:
            positions = [int(p) for p in positions]
            if axis_n is not None and positions and positions[-1] >= int(axis_n):
                raise ValueError(
                    f"the {axis!r} membership names position {positions[-1]} of an axis "
                    f"holding {int(axis_n)} entries"
                )
            # Encoding is the ascending/duplicate check: it walks the positions in one
            # pass and refuses a gap that is not positive, so the inline copy and the body
            # are validated by the same rule rather than by two.
            blob = encode_member_set(positions)
            if not isinstance(member_name, str) or not member_name.strip():
                raise ValueError(
                    "a membership's index body needs a member name — with two "
                    "memberships the writer will not invent two"
                )
            if member_name in seen_members:
                raise ValueError(f"two memberships both write their index body to "
                                 f"{member_name!r}")
            seen_members.add(member_name)
            record = {"axis": axis, "aligned_to": aligned_to, "kind": "subset",
                      "n_members": len(positions), "members": member_name}
            # ITEM-5: inline ONLY within the budget, and ABSENT rather than truncated
            # above it. The body written beside it is the authority either way.
            if len(blob) <= MAX_MEMBERSHIP_BITMAP_BYTES:
                record["bitmap"] = blob
            record["_positions"] = positions
        out.append(record)
    total = sum(int(r["n_members"]) for r in out)
    if total != int(table_n):
        raise ValueError(
            f"this table declares {int(table_n)} rows while its membership(s) name "
            f"{total} — a table's rows ARE its members, in the order its memberships are "
            "declared (one segment per axis), so the two counts are the same count stated "
            "twice"
        )
    return out


def _axis_evidence(derived_from):
    """`(digest, length)` for the axis key artifact a membership was selected out of.

    Accepts the artifact's `structure` dict — the ordinary case, since a producer
    computing a membership has just written or read the axis — or the ordered key
    sequence itself, which is digested here with the same function the key artifact's own
    writer used.
    """
    if isinstance(derived_from, dict):
        digest = derived_from.get("key_sequence_digest")
        if not isinstance(digest, str):
            raise ValueError(
                "`derived_from` is an axis key artifact's `structure`, and this one "
                "declares no `key_sequence_digest` — an artifact that is not keyed is not "
                "an axis and a membership cannot be selected out of it"
            )
        n = derived_from.get("n")
        return digest, None if n is None else int(n)
    if derived_from is None:
        raise ValueError(
            "a membership must name what it was DERIVED FROM — pass the axis key "
            "artifact's `structure` (or its ordered key sequence). Without it "
            "`aligned_to` is an unchecked claim, and the failure it hides is silent"
        )
    keys = list(derived_from)
    return key_sequence_digest(keys), len(keys)


# ── the artifact writer (ITEM-4) ─────────────────────────────────────────────────

class Table:
    """One artifact directory = *n* Zarr arrays sharing ONE axis (ITEM-4).

    The members live under a single directory so they carry ONE merkle identity: a
    composite result cannot half-update, and a consumer addresses a member by PATH
    rather than by juggling *n* artifact ids.

    Typical use from a processor::

        t = txr_zarr.Table(outputs_dir / "obs.zarr", axis="rows", n=n_rows)
        t.numeric("total", counts, dtype="float32")
        t.categorical("group", codes=cat.codes, levels=list(cat.categories))
        t.string("label", labels)
        structure = t.close()      # → the artifact row's producer-declared `structure`

    `close()` returns the `structure` document verbatim: the producer declares how to
    decode its own bytes and the server stores that declaration without interpreting it.

    Passing `key=<member>` DECLARES which member holds the axis's keys, and makes this
    table a KEY ARTIFACT in INV-3's sense. Two declarations come out of it, both of them
    things only the producer knows:

      * `structure.key` — WHICH member holds them. Not derivable from bytes.
      * `structure.key_sequence_digest` — WHAT that member's ordered keys are, digested
        from the values the writer is about to store (see the section comment on
        [`key_sequence_digest`] for why this is the producer's half of INV-3, and why it
        is taken over the values going IN rather than read back out).

    Neither is trusted. The framework-owned conformance suite (`_lib/conformance.py`)
    RECOMPUTES the digest from the stored bytes, outside this process, and refuses the
    artifact when the declaration and the bytes describe different key sequences.

    Passing `aligned_to=<digest>` is the SAME declaration made from the other side
    (ITEM-15). A table with no key member of its own — a metric column, an embedding —
    carries only `structure.axis`, which is a LABEL, and a label does not identify: three
    datasets' row axes all carry the same label, so a consumer reading the catalog
    cannot tell whether these values may be painted on those points. `aligned_to` names
    the ordered key sequence this table's rows line up with, by its
    [`key_sequence_digest`] — the axis's identity rather than its name.
    """

    def __init__(self, root, *, axis, n, key=None, aligned_to=None, membership=None,
                 attributes=None):
        self.root = Path(root)
        self.axis = str(axis)
        self.n = int(n)
        # The member holding this axis's KEYS, when the producer has one (ITEM-19). Which
        # member that is cannot be derived from bytes — it is a fact only the producer
        # knows — so it is stated here and recorded in the `structure`; the conformance
        # suite then digests those keys FROM DISK to check that artifacts claiming this
        # axis are aligned in the same order. Optional: an artifact whose axis is
        # positional has no key member, and inventing one would be the inference INV-2
        # forbids.
        self.key = None if key is None else str(key)
        # Set by whichever member writer turns out to BE `self.key` — over the values it
        # stores, in the form a reader gets them back (labels for a categorical, the
        # coerced `str`s for a string column, the coerced array for a numeric one), so the
        # declaration and the gate's recomputation are comparable.
        self._key_digest = None
        # WHICH ordered key sequence this table's rows are aligned to (ITEM-15), as that
        # sequence's `key_sequence_digest`. A DIGEST rather than the keys themselves, for
        # two reasons that both come from the one place the value is authored: the caller
        # takes it off the axis's own key artifact — the `structure.key_sequence_digest`
        # this same writer emitted — so the two declarations are the same bytes by
        # construction. Re-digesting a key SEQUENCE here would digest whatever the caller
        # handed over, which is not necessarily what the key member STORED (`_as_strings`
        # coerces), and a silently different digest on every column is the failure this
        # declaration exists to catch.
        #
        # It is not trusted either: `conformance.py` recomputes the axis's digest from the
        # key member's stored bytes and refuses an artifact that claims an axis the run's
        # own key artifact does not digest to.
        self._aligned_to = None if aligned_to is None else _declared_digest(aligned_to)
        # WHICH MEMBERS of each axis these rows are (ITEM-1). Normalised — and REFUSED —
        # here rather than at `close()`, so a producer that got the declaration wrong
        # learns it before it has spent the run writing bytes against it.
        self._memberships = _membership_entries(membership, self.axis, self.n)
        self._attributes = dict(attributes or {})
        self._columns = []
        self._arrays = []
        # Members whose length is NOT `n` (ITEM-12). See [`Table.aux`] for why they cannot
        # ride in `columns`/`arrays`, and `_extents` for what bounds them instead.
        self._aux = []
        # extent name → the integer length every aux dimension claiming that name must have.
        # ONE declaration per extent, first-writer-wins, and a later disagreement is a hard
        # error at the writer: two aux members that both claim `output_rows` and store
        # different lengths describe two different alignments, and the whole point of a named
        # extent is that the second one cannot quietly redefine the first.
        self._extents = {}
        self._names = set()
        self._closed = False
        self.root.mkdir(parents=True, exist_ok=True)

    # -- internals -------------------------------------------------------------

    #: Member names this writer refuses outright. `zarr.json` is the GROUP node — writing a
    #: member there overwrites the store's own metadata; `c` is the chunk directory.
    _RESERVED_MEMBER_NAMES = ("c", "zarr.json")

    def _claim(self, name):
        """Reserve a member name, or refuse it. Every member writer goes through here.

        A member name becomes a PATH under the store root (`<root>/<name>/zarr.json`), so it
        must be a single safe path component. The checks are: not after `close()`, not a
        duplicate, non-empty, no path separator, **not a traversal component**, and not
        reserved.

        `..` was the gap (S7). `"/" in name` does not catch it — `..` contains no separator —
        so `Table.aux("..", …)` resolved to the store's PARENT and wrote outside the root.
        `.` is refused for the same reason: it resolves to the group node's own directory.
        Backslash is refused because a name is also a path component on Windows.

        Not reachable from this producer's literal names (they are constants or carry a
        `unified_`/`levels__` prefix), which is why it is low severity — but this is the
        writer EVERY producer in the tree shares, and a member name is the one part of a
        store path that can come from user-supplied column data.
        """
        if self._closed:
            raise RuntimeError("this Table is already closed")
        if name in self._names:
            raise ValueError(f"duplicate member name {name!r}")
        if (
            not name
            or "/" in name
            or "\\" in name
            or name in (".", "..")
            or name in self._RESERVED_MEMBER_NAMES
        ):
            raise ValueError(
                f"invalid member name {name!r} — a member name is one path component under "
                "the store root, so it may not be empty, contain a separator, be a "
                f"traversal component ('.'/'..'), or be reserved {self._RESERVED_MEMBER_NAMES}"
            )
        self._names.add(name)

    def _check_len(self, name, got):
        if got != self.n:
            raise ValueError(
                f"{name!r} has {got} values but the {self.axis!r} axis declares {self.n}"
            )

    def _record(self, entry):
        (self._arrays if len(entry["shape"]) > 1 else self._columns).append(entry)
        return entry

    def _is_key(self, name):
        return self.key is not None and name == self.key

    def _declare_keys(self, name, values):
        """If `name` is the DECLARED key member, digest the values it stores (ITEM-19).

        Called by each member writer with the values in the form a reader gets them back,
        so `structure.key_sequence_digest` describes the same sequence the gate will
        recompute off disk. A member that is not the key digests nothing — the cost is
        paid only by the one member that carries the axis.
        """
        if self.key is None or name != self.key:
            return
        self._key_digest = key_sequence_digest(values)

    # -- the three kinds -------------------------------------------------------

    def numeric(self, name, values, *, dtype, inner_chunk=INNER_CHUNK,
                chunks_per_shard=None, meta=None, **kw):
        """A numeric column (1-D) or array (2-D, e.g. an embedding).

        `dtype` is REQUIRED even when `values` is already a numpy array: the same
        logical column arriving as `int64` from one code path and `int32` from another
        would otherwise store different bytes for the same meaning, minting a new
        `content_hash` on an unchanged column.

        `chunks_per_shard` unset ⇒ DERIVED from the array's own length (ITEM-35); pass a
        number to override. It is not a constant here for the reason the module header
        gives: a constant is wrong at both ends of the scale.
        """
        self._claim(name)
        arr = np.asarray(values, dtype=np.dtype(dtype))
        self._check_len(name, int(arr.shape[0]))
        if self._is_key(name):
            if arr.ndim != 1:
                raise ValueError(
                    f"{name!r}: a key member is 1-D — an axis's keys are a sequence, "
                    "not a matrix"
                )
            self._declare_keys(name, arr.tolist())
        dims = [self.axis] if arr.ndim == 1 else [self.axis, None]
        entry = write_array(self.root, name, arr, inner_chunk=inner_chunk,
                            chunks_per_shard=chunks_per_shard, dimension_names=dims,
                            attributes={"txr": _member_meta("numeric", name, meta)}, **kw)
        entry["name"] = name
        entry["axis"] = self.axis
        if meta is not None:
            entry["meta"] = meta
        return self._record(entry)

    def categorical(self, name, *, levels, values=None, codes=None, ordered=False,
                    missing=None, missing_level=None, inner_chunk=INNER_CHUNK,
                    chunks_per_shard=None, meta=None, **kw):
        """`uint8`/`uint16` codes plus the DECLARED level set (ITEM-2, DEC-6).

        Pass EITHER `values` (labels, mapped through `levels`) or `codes` (already the
        indices — what `pandas.Categorical.codes` gives you). The code width comes from
        `len(levels)`, so a level that is declared but never used still round-trips and
        still produces the same bytes.

        The level set lands at `attributes.txr.levels`, which is the key the browser
        reader looks for; it returns the pair to its callers as `{codes, categories}`.
        """
        self._claim(name)
        levels = [str(c) for c in levels]
        if (values is None) == (codes is None):
            raise ValueError(f"{name!r}: pass exactly one of `values=` or `codes=`")
        if values is not None:
            raw = codes_from_labels(list(values), levels, missing=missing)
        else:
            raw = np.asarray(codes, dtype=np.int64)
            if raw.ndim != 1:
                raise ValueError(f"{name!r}: codes must be 1-D")
            if raw.size and (raw.min() < 0 or raw.max() >= len(levels)):
                # pandas uses -1 for NaN; that is a real value the caller must map, so
                # surface it rather than storing an out-of-range code.
                raise ValueError(
                    f"{name!r}: codes outside 0..{len(levels) - 1} "
                    "(pandas writes -1 for missing — map it to a declared level first)"
                )
        self._check_len(name, int(raw.shape[0]))
        # The keys of a categorical member are its LABELS, which is what a reader gets
        # back (`txr_zarr_read.read_column` resolves codes through the level set). A
        # digest over the raw codes would be an identity for the encoding, not for the
        # axis: the same barcodes re-declared with a reordered level set would digest
        # differently for an unchanged key sequence.
        if self._is_key(name):
            self._declare_keys(name, [levels[int(c)] for c in raw])
        dt = code_dtype(levels)
        attrs = _member_meta("categorical", name, meta)
        attrs["levels"] = levels
        attrs["ordered"] = bool(ordered)
        entry = write_array(self.root, name, raw.astype(dt, copy=False),
                            inner_chunk=inner_chunk, chunks_per_shard=chunks_per_shard,
                            dimension_names=[self.axis], attributes={"txr": attrs}, **kw)
        # The DIGEST of the level set, not the set. This fragment rides the artifact
        # row / manifest, which is metadata and is size-capped
        # (`outputs.rs::MAX_MANIFEST_BYTES`, 1 MiB, a hard run failure past it).
        #
        # It is still the other side of the conformance gate's drift check —
        # `_conform_levels_digest` recomputes this from the stamped
        # `attributes.txr.levels` written five lines up, so the oracle that corrupts
        # ONLY the member's `zarr.json` is still caught. What changed is the SIZE of
        # the evidence, not the detection: the two copies are written from one
        # `levels` local in one call, so they cannot disagree at write time; the only
        # divergence either form can see is post-hoc mutation of the store or the
        # row, and a mismatch is a mismatch whether the witness is 35,477 strings or
        # 64 bytes.
        #
        # The size mattered. Inlining the set made a `gene_symbol` member's row entry
        # 450 KB to describe a 9 KB array — 87% of a real import's whole manifest,
        # which blew the cap and failed the run. `values_digest` on a string member is
        # the same pattern, and `key_sequence_digest` is the same function, so this is
        # the shape the format already uses for "declare what the bytes must be".
        entry.update({"name": name, "axis": self.axis, "kind": "categorical",
                      "levels_digest": key_sequence_digest(levels),
                      "n_levels": len(levels), "ordered": bool(ordered)})
        # ITEM-51 — the ORDER-INDEPENDENT pair, alongside the order-SENSITIVE
        # `levels_digest` above. They answer different questions and neither replaces the
        # other: `levels_digest` pins the exact declared sequence the codes index into (a
        # reordered set silently relabels every value), while `vocab_digest`/`vocab_sketch`
        # answer "do these two columns mean the same thing" — a question about SETS, which
        # an ordered digest cannot answer, since two producers writing one vocabulary in two
        # orders would disagree under it and be offered separately forever.
        #
        # This is the ONE place it is emitted, which is what keeps ITEM-51 small: every
        # categorical in this tree funnels through here (`txr_columns.write_metadata_column`
        # calls it, and the packages emitting categoricals all go through THAT), so no
        # emitting package changes at all.
        entry.update(vocab_declaration(levels, missing_level=missing_level))
        if missing_level is not None:
            # DECLARED on the row, not merely applied here, so the conformance gate can
            # RECOMPUTE the pair from the member's own stamped `attributes.txr.levels` and
            # refuse a disagreement. Without it these fields would be the only thing in this
            # row nothing checks — the free opt-out the gate's key tables exist to prevent —
            # because the excluded level is not derivable from the stamp.
            entry["missing_level"] = str(missing_level)
        if meta is not None:
            entry["meta"] = meta
        return self._record(entry)

    def string(self, name, values, *, missing=None, inner_chunk=INNER_CHUNK,
               data_inner_chunk=BYTES_INNER_CHUNK, chunks_per_shard=None,
               meta=None, **kw):
        """Arrow-layout strings, SPLIT form (ITEM-3): a `uint32` `offsets` member and a
        `uint8` `values` member holding the concatenated UTF-8, under a group at
        `<name>` tagged `{kind: "string", layout: "split", n}`.

        Split rather than one concatenated buffer because that is the form the design's
        "shuffled offsets + gzip" measurement is of — and because a consumer that wants
        one string fetches the offsets without dragging the payload along.

        `chunks_per_shard` unset ⇒ each of the two members derives its own count from its
        OWN length (ITEM-35). That matters here more than anywhere else: the offsets are
        `n + 1` elements at `inner_chunk` and the payload is `n_bytes` at
        `data_inner_chunk`, two lengths that differ by the mean string width, so one
        shared count is wrong for at least one of them by construction.

        ## `values_digest` — REQUIRED, and why only this kind of member has one
        THE BYTES OF A SPLIT STRING MEMBER DO NOT DETERMINE ITS VALUES. A numeric or
        categorical member is fixed-width: `(dtype, shape, bytes)` pins every value, so
        there is nothing left for a producer to declare. Here the offsets are a SECOND,
        independent degree of freedom over the same payload — `[0,2,3]` and `[0,1,3]` over
        `abc` are both perfectly well-formed and mean `["ab","c"]` and `["a","bc"]` — and a
        boundary-preserving re-split therefore changes every value while satisfying every
        byte-level check there is (start-0, monotonic, ends-at-payload-length, decodes as
        UTF-8). That was a real hole: the framework gate returned `[]` for it.

        So the value sequence is DECLARED — digested from the coerced strings this member is
        about to store, exactly as `key_sequence_digest` is for a key member — and the
        framework gate RECOMPUTES it from the offsets+payload that landed and refuses a
        disagreement. It is emitted for EVERY string member, not only a `key=` one: the
        digest was already reachable through `key`, but at most one member per artifact can
        be the key, which left every other string column unchecked.
        """
        self._claim(name)
        values = list(values)
        self._check_len(name, len(values))
        offsets, payload = arrow_encode(values, missing=missing)
        # …over the COERCED strings (`stored_strings`), which is what the member holds
        # and therefore what the gate will recompute; digesting the pre-coercion values
        # would disagree with the bytes wherever a `missing=` substitution happened.
        stored = stored_strings(values, missing=missing)
        if self._is_key(name):
            self._declare_keys(name, stored)
        attrs = _member_meta("string", name, meta)
        attrs["layout"] = "split"
        attrs["n"] = self.n
        write_group(self.root / name, {"txr": attrs})
        off = write_array(self.root, f"{name}/offsets", offsets, inner_chunk=inner_chunk,
                          chunks_per_shard=chunks_per_shard,
                          dimension_names=[f"{self.axis}+1"], **kw)
        val = write_array(self.root, f"{name}/values", payload, inner_chunk=data_inner_chunk,
                          chunks_per_shard=chunks_per_shard,
                          dimension_names=["utf8_bytes"], **kw)
        entry = {
            "name": name, "path": name, "kind": "string", "layout": "split",
            "axis": self.axis, "shape": [self.n], "dtype": "utf8",
            "offsets": off["path"], "values": val["path"],
            "n_bytes": int(payload.shape[0]),
            "stored_bytes": int(off["stored_bytes"] + val["stored_bytes"]),
            # The producer's declaration of WHAT the offsets split the payload into (see
            # the docstring). Taken over the values going IN, on the far side of the
            # encoder from where the gate recomputes it — a digest read back out of the
            # file the gate reads would agree with the gate no matter what the encoder did.
            "values_digest": key_sequence_digest(stored),
        }
        if meta is not None:
            entry["meta"] = meta
        return self._record(entry)

    # -- members whose length is NOT the axis's ---------------------------------

    def aux(self, name, values, *, dtype, role, extent, inner_chunk=INNER_CHUNK,
            chunks_per_shard=None, meta=None, **kw):
        """A numeric member whose length is deliberately NOT `n` (ITEM-12).

        ## Why this channel has to exist at all

        Every other member writer calls [`Table._check_len`], so `Table` cannot express an
        extra array at all: a member whose length is neither the axis's `n` nor a function
        of it raises before a byte is written. That is the right default — a column shorter
        than its axis is a producer bug in almost every case — but it makes a whole CLASS of
        artifact unwritable, and the alignment artifact is that class. Its vectors are a row
        vector (one entry per OUTPUT row), a segment table (one entry per source range) and
        a feature vector (unified features × sources): three lengths, none of them `n`, all
        of them belonging to one artifact.

        Writing them anyway, undeclared, is not an option and this is the part worth being
        explicit about: `conformance._conform_node_coverage` compares stored nodes against
        the declaration **in both directions**, so an undeclared stored node is refused —
        *"a member left out of `columns`/`arrays` keeps its bytes and loses every check in
        this suite, which is the cheapest opt-out there is. Declare it, or do not write
        it"*. Declaring them among `columns` instead is refused from the other side, by
        `_conform_member`, for the wrong length. Both refusals are correct; between them
        they leave exactly no way to store such a member, which is why the channel is added
        here rather than worked around at the producer.

        ## `extent` — the length rule, named once

        `extent` is a list of extent NAMES, one per dimension (`["output_rows"]` for a 1-D
        member, `["unified_features", "sources"]` for a 2-D one). The name is what makes the
        check worth anything: `structure.extents` records each name's integer length exactly
        once, so two members that both claim `output_rows` are checked against ONE
        declaration and cannot disagree, and the gate recomputes both from the stored bytes.
        A member simply declaring "I am 12,000 long" would agree with itself no matter what
        it wrote — the self-consistent declaration this suite exists to refuse.

        ## `role` — and why the WRITER has no opinion about it

        `role` says what the member IS (`alignment_segment_dataset`, …). This writer only
        requires that one be present; it never enumerates them, exactly as
        `txr_csc.write_csc_zarr`'s `structure_extra` carries caller-named keys it does not
        interpret. The enumeration lives in the framework-owned gate
        (`conformance._AUX_ROLES`), which REFUSES a role it has no opinion about — so a new
        role is added with the check it enables rather than silently inheriting none. Domain
        vocabulary in the writer would put the producer in charge of how hard the gate looks
        at it, which is the shape `conformance.py` has retired three times over.
        """
        self._claim(name)
        arr = np.asarray(values, dtype=np.dtype(dtype))
        if self._is_key(name):
            # A key member IS the axis, so its length is `n` by definition and it belongs in
            # `columns`. Allowing it here would let a producer declare an axis whose keys are
            # a different length from the axis — a contradiction inside one producer's own
            # two statements, and cheaper to refuse than to explain downstream.
            raise ValueError(
                f"{name!r}: the declared key member carries the axis's own keys, so it is "
                f"{self.n} long by definition — write it with `numeric`/`string`, not `aux`"
            )
        if not isinstance(role, str) or not role:
            raise ValueError(f"{name!r}: an aux member must declare a non-empty `role`")
        if isinstance(extent, str) or not isinstance(extent, (list, tuple)):
            raise ValueError(
                f"{name!r}: `extent` is a list of extent names, one per dimension "
                f"(got {extent!r}) — a 1-D member passes a one-element list"
            )
        extent = [str(e) for e in extent]
        if len(extent) != arr.ndim:
            raise ValueError(
                f"{name!r}: declares {len(extent)} extent name(s) {extent} for a "
                f"{arr.ndim}-D array — one name per dimension"
            )
        for axis_i, extent_name in enumerate(extent):
            got = int(arr.shape[axis_i])
            prior = self._extents.get(extent_name)
            if prior is not None and prior != got:
                raise ValueError(
                    f"{name!r}: dimension {axis_i} is {got} long but extent "
                    f"{extent_name!r} was already declared {prior} by an earlier member — "
                    "one extent name is one length, or the name means nothing"
                )
            self._extents[extent_name] = got
        entry = write_array(self.root, name, arr, inner_chunk=inner_chunk,
                            chunks_per_shard=chunks_per_shard, dimension_names=list(extent),
                            attributes={"txr": _member_meta("numeric", name, meta)}, **kw)
        entry["name"] = name
        entry["role"] = role
        entry["extent"] = extent
        if meta is not None:
            entry["meta"] = meta
        self._aux.append(entry)
        return entry

    # -- finish ----------------------------------------------------------------

    def close(self):
        """Write the group node and return the producer-declared `structure`.

        The SAME document is stamped into the group's `zarr.json` `attributes` under
        `txr`, so a client handed nothing but the store URL learns how to decode every
        member from the first request it was going to make anyway. It is not a second
        source of truth: the returned dict is what rides the manifest entry into the
        artifact row, and both come from this one object.
        """
        if self._closed:
            raise RuntimeError("this Table is already closed")
        structure = {
            "encoding": "zarr_v3",
            "kind": "table",
            "axis": self.axis,
            "n": self.n,
            "columns": self._columns,
            "arrays": self._arrays,
        }
        if self._aux:
            # Emitted only when non-empty, so an artifact that uses none of this is
            # byte-identical to what it was before the channel existed — the `extents` map
            # is derived from the aux members themselves, so the two keys travel together
            # and an `extents` entry no member claims cannot arise here (the gate refuses
            # one anyway, because a hand-built structure can still express it).
            structure["aux"] = self._aux
            structure["extents"] = dict(self._extents)
        if self.key is not None:
            if self.key not in self._names:
                raise ValueError(
                    f"key={self.key!r} is not a member of this table "
                    f"({', '.join(sorted(self._names)) or 'none written'})"
                )
            # The producer's half of INV-3 (ITEM-19): WHICH member carries the axis's
            # keys, and WHAT that ordered key sequence is. `content_hash` — the identity
            # the server keys on — is minted by ingest over the bytes below, so this is
            # as close to "declare your identity" as a writer can get. Both are checked
            # against the stored bytes by the framework-owned gate, never trusted.
            structure["key"] = self.key
            if self._key_digest is None:
                # Unreachable via the three member writers (each digests when it IS the
                # key, and `close` has already proved the key is one of them) — but a
                # silently absent digest would be a key artifact with no declared
                # identity, i.e. the exact hole this closes, so it fails loudly instead.
                raise RuntimeError(
                    f"key={self.key!r} was written without a key-sequence digest"
                )
            structure["key_sequence_digest"] = self._key_digest
        if self._aligned_to is not None:
            if self._key_digest is not None and self._key_digest != self._aligned_to:
                # A key artifact IS its axis, so it is aligned to itself. Declaring a
                # DIFFERENT axis is a contradiction inside one producer's own two
                # statements, and it is refused here rather than passed on: the gate
                # would catch it too, but this one is decidable without opening a single
                # byte and the message can name both digests.
                raise ValueError(
                    f"this table declares key member {self.key!r} digesting to "
                    f"{self._key_digest[:12]}… while also declaring aligned_to="
                    f"{self._aligned_to[:12]}… — an artifact that CARRIES an axis's keys is "
                    "aligned to that axis, so the two declarations cannot disagree"
                )
            structure["aligned_to"] = self._aligned_to
        if self._memberships:
            # ITEM-3 — the index BODY, one ordinary `uint32` member per subset membership,
            # holding the member positions in ascending order.
            #
            # It is written HERE rather than through `numeric()` for one reason that is
            # structural rather than tidy: every member `numeric()` writes is a COLUMN of
            # this table and is length-checked against `n`, and an index body is neither.
            # Its length is the member COUNT, its values are positions into a DIFFERENT
            # sequence (the axis), and offering it in the column picker would offer the
            # row numbers as a thing to colour by. So it is declared where it belongs —
            # on the membership entry that owns it — and `columns` keeps meaning "one
            # value per row of this table".
            #
            # `uint32` bounds the axis at ~4.3e9 entries, which is four orders of
            # magnitude past anything this format has seen, and halves the bytes against
            # the int64 numpy would otherwise pick.
            entries = []
            for record in self._memberships:
                record = dict(record)
                positions = record.pop("_positions", None)
                if positions is not None:
                    name = record["members"]
                    self._claim(name)
                    arr = np.asarray(positions, dtype=np.uint32)
                    body = write_array(
                        self.root, name, arr,
                        # The index body is read WHOLE by a gather (it IS the gather
                        # list), so it is declared as one chunk rather than paged.
                        inner_chunk=max(1, int(arr.shape[0])),
                        dimension_names=[None],
                        attributes={"txr": _member_meta("membership_index", name, None)},
                    )
                    record["path"] = body["path"]
                entries.append(record)
            structure["memberships"] = entries
        attrs = dict(self._attributes)
        attrs["txr"] = structure
        write_group(self.root, attrs)
        self._closed = True
        return structure

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None and not self._closed:
            self.close()
        return False


def _member_meta(kind, name, meta):
    out = {"kind": kind, "name": name}
    if meta is not None:
        out["meta"] = meta
    return out


def write_table(root, columns, *, axis, n, key=None, attributes=None):
    """Convenience: build a whole `Table` from a list of column specs.

    Each spec is a dict `{"name", "kind", …}` carrying the same keyword arguments the
    matching `Table` method takes. Handy for a processor that already has its columns
    described as data; a processor writing columns as it computes them should use
    `Table` directly so it never holds them all at once.
    """
    with Table(root, axis=axis, n=n, key=key, attributes=attributes) as t:
        for spec in columns:
            spec = dict(spec)
            kind = spec.pop("kind")
            name = spec.pop("name")
            if kind == "numeric":
                t.numeric(name, spec.pop("values"), **spec)
            elif kind == "categorical":
                t.categorical(name, **spec)
            elif kind == "string":
                t.string(name, spec.pop("values"), **spec)
            else:
                raise ValueError(f"{name!r}: unknown column kind {kind!r}")
        return t.close()
