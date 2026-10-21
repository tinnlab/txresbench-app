#!/usr/bin/env python3
# ruff: noqa
"""TEST-7/8/9 — the `cyto_zarr` Zarr v3 sharded writer (ITEM-1..4).

The reader used here is written **independently of the writer**: it parses the shard
container by hand, checks the index with a bit-by-bit crc32c (the writer's is
table-driven), and inflates with stdlib `gzip.decompress` (the writer hand-builds its
gzip container). A round-trip that shares an encode/decode implementation proves only
self-consistency; this one proves the BYTES are what the format says they are — which
is the same claim the browser's zero-dependency reader has to hold up.
"""
import gzip
import json
from pathlib import Path

import numpy as np
import pytest

import cyto_zarr as cz

EMPTY = (1 << 64) - 1


# ── an independent reference reader ──────────────────────────────────────────────

def ref_crc32c(data):
    """crc32c computed BIT by bit — deliberately not the writer's table-driven one, so
    a wrong table would not agree with itself and pass."""
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 if crc & 1 else 0)
    return crc ^ 0xFFFFFFFF


def ref_unshuffle(buf, itemsize):
    if itemsize == 1:
        return bytes(buf)
    return np.frombuffer(buf, dtype=np.uint8).reshape(itemsize, -1).T.tobytes()


def read_meta(root, name):
    return json.loads((Path(root) / name / "zarr.json").read_text())


def parse_shard(body, chunks_per_shard):
    """Split a shard file into `(index_pairs, chunk_bytes_by_slot)` the way the v3
    sharding codec says to: the index is the LAST `chunks_per_shard*16 + 4` bytes,
    crc32c-suffixed, and each entry is `(offset, nbytes)` from the shard's start."""
    idx_len = chunks_per_shard * 16
    idx_bytes = body[len(body) - idx_len - 4 : len(body) - 4]
    stored_crc = int.from_bytes(body[-4:], "little")
    assert stored_crc == ref_crc32c(idx_bytes), "shard index crc32c mismatch"
    index = np.frombuffer(idx_bytes, dtype="<u8").reshape(chunks_per_shard, 2)
    chunks = {}
    for k, (off, nb) in enumerate(index):
        if int(off) == EMPTY and int(nb) == EMPTY:
            continue
        chunks[k] = bytes(body[int(off) : int(off) + int(nb)])
    return index, chunks


def read_array(root, name):
    """Decode a whole member array back to numpy, straight from the bytes."""
    meta = read_meta(root, name)
    assert meta["zarr_format"] == 3 and meta["node_type"] == "array"
    shard_cfg = meta["codecs"][0]
    assert shard_cfg["name"] == "sharding_indexed"
    cfg = shard_cfg["configuration"]
    assert cfg["index_location"] == "end"
    assert [c["name"] for c in cfg["index_codecs"]] == ["bytes", "crc32c"]

    dtype = np.dtype(meta["data_type"]).newbyteorder("<")
    inner = cfg["chunk_shape"]
    shard = meta["chunk_grid"]["configuration"]["chunk_shape"]
    shape = meta["shape"]
    inner_rows, shard_rows = inner[0], shard[0]
    cps = shard_rows // inner_rows
    width = shape[1] if len(shape) == 2 else None
    elems = inner_rows * (width or 1)

    names = [c["name"] for c in cfg["codecs"]]
    assert names[0] == "bytes" and names[-1] == "gzip"
    shuffled = "numcodecs.shuffle" in names
    assert shuffled == (dtype.itemsize > 1), "shuffle is declared iff it does anything"

    out = np.full(tuple(shape), meta["fill_value"], dtype=dtype)
    n_shards = (shape[0] + shard_rows - 1) // shard_rows
    for s in range(n_shards):
        key = f"{s}" if width is None else f"{s}/0"
        body = (Path(root) / name / "c" / key).read_bytes()
        _index, chunks = parse_shard(body, cps)
        for k, raw in chunks.items():
            plain = gzip.decompress(raw)
            if shuffled:
                plain = ref_unshuffle(plain, dtype.itemsize)
            block = np.frombuffer(plain, dtype=dtype)
            assert block.size == elems, "a chunk always holds chunk_shape elements"
            if width is not None:
                block = block.reshape(inner_rows, width)
            lo = s * shard_rows + k * inner_rows
            hi = min(lo + inner_rows, shape[0])
            if lo >= shape[0]:
                continue
            out[lo:hi] = block[: hi - lo]
    return out


def read_string(root, name):
    """Decode the SPLIT arrow layout the browser reader expects: an `offsets` member
    and a `values` member under one group."""
    group = json.loads((Path(root) / name / "zarr.json").read_text())
    assert group["node_type"] == "group"
    assert group["attributes"]["cyto"]["layout"] == "split"
    offsets = read_array(root, f"{name}/offsets")
    payload = read_array(root, f"{name}/values").tobytes()
    return [payload[int(offsets[i]) : int(offsets[i + 1])].decode("utf-8")
            for i in range(len(offsets) - 1)]


def read_chunk_raw(root, name, shard, slot):
    """One inner chunk, decoded but NOT trimmed to the array's shape — this is how the
    fill_value padding of a tail chunk becomes observable."""
    meta = read_meta(root, name)
    cfg = meta["codecs"][0]["configuration"]
    dtype = np.dtype(meta["data_type"]).newbyteorder("<")
    cps = meta["chunk_grid"]["configuration"]["chunk_shape"][0] // cfg["chunk_shape"][0]
    body = (Path(root) / name / "c" / str(shard)).read_bytes()
    _index, chunks = parse_shard(body, cps)
    plain = gzip.decompress(chunks[slot])
    if dtype.itemsize > 1:
        plain = ref_unshuffle(plain, dtype.itemsize)
    return np.frombuffer(plain, dtype=dtype)


# ═══════════════════════════════ TEST-7 — ITEM-1 ═════════════════════════════════

def test_sharded_array_round_trips_byte_exactly(tmp_path):
    """A written sharded v3 array decodes back to the exact values that went in."""
    rng = np.random.default_rng(7)
    values = rng.normal(size=10_000).astype(np.float32)
    with cz.Table(tmp_path / "obs.zarr", axis="cells", n=10_000) as t:
        t.numeric("score", values, dtype="float32")
    got = read_array(tmp_path / "obs.zarr", "score")
    assert got.dtype == np.dtype("<f4")
    np.testing.assert_array_equal(got, values)


def test_round_trip_spans_many_shards_and_dtypes(tmp_path):
    """Multi-shard geometry and every supported dtype, not just the happy float32."""
    n = 1000
    cases = {
        "i8": (np.arange(n, dtype=np.int8), "int8"),
        "u16": (np.arange(n, dtype=np.uint16) * 37, "uint16"),
        "i32": ((np.arange(n) - 500).astype(np.int32), "int32"),
        "i64": ((np.arange(n) * 10**12).astype(np.int64), "int64"),
        "f64": (np.linspace(-1e9, 1e9, n), "float64"),
        "flag": ((np.arange(n) % 3 == 0), "bool"),
    }
    with cz.Table(tmp_path / "t.zarr", axis="rows", n=n) as t:
        for name, (vals, dt) in cases.items():
            # inner_chunk 64 × 4 per shard ⇒ shard = 256 rows ⇒ 4 shards for n=1000.
            entry = t.numeric(name, vals, dtype=dt, inner_chunk=64, chunks_per_shard=4)
            assert entry["shards"] == 4
    for name, (vals, _dt) in cases.items():
        np.testing.assert_array_equal(read_array(tmp_path / "t.zarr", name), vals)


def test_shard_index_offsets_lengths_and_crc_match_a_recomputed_reference(tmp_path):
    """The index is exactly what the sharding codec says: dense from offset 0, each
    entry's length equal to the bytes actually stored, unused slots EMPTY, and a
    crc32c over the index bytes.

    The EMPTY slots are reached through an EXPLICIT `chunks_per_shard=8` override, because
    the derived geometry (ITEM-35) deliberately leaves none — an unwritten slot is
    16 bytes of `ffffffffffffffff` padding for a chunk that does not exist, which is the
    waste ITEM-35 removes. The override is the case where padding is legitimate: a caller
    that asked for a fixed grid gets the fixed grid.
    """
    n = 10_000
    values = np.arange(n, dtype=np.float32)
    with cz.Table(tmp_path / "a.zarr", axis="rows", n=n) as t:
        entry = t.numeric("x", values, dtype="float32", chunks_per_shard=8)
    per_shard = entry["chunks_per_shard"]
    assert per_shard == 8, "the explicit override is what is stored"
    root = tmp_path / "a.zarr"
    body = (root / "x" / "c" / "0").read_bytes()
    index, chunks = parse_shard(body, per_shard)

    n_used = (n + cz.INNER_CHUNK - 1) // cz.INNER_CHUNK
    assert n_used == 3 and sorted(chunks) == [0, 1, 2]
    # Slots past the end of the data are EMPTY, not zero-length.
    for k in range(n_used, per_shard):
        assert tuple(int(v) for v in index[k]) == (EMPTY, EMPTY)
    # Offsets are cumulative over the preceding lengths and start at 0…
    cursor = 0
    for k in range(n_used):
        off, nb = int(index[k][0]), int(index[k][1])
        assert off == cursor, f"chunk {k} offset {off} != recomputed {cursor}"
        assert nb == len(chunks[k])
        cursor += nb
    # …and the payload ends exactly where the index begins.
    assert cursor == len(body) - (per_shard * 16 + 4)
    # The stored checksum is a crc32c of the index bytes (parse_shard asserts it with
    # the bitwise reference); assert the writer's table-driven one agrees too.
    idx_bytes = body[cursor : len(body) - 4]
    assert cz.crc32c(idx_bytes) == ref_crc32c(idx_bytes)
    assert int.from_bytes(body[-4:], "little") == ref_crc32c(idx_bytes)


def test_tail_chunk_shorter_than_inner_chunk_pads_to_fill_value(tmp_path):
    """A chunk ALWAYS holds `chunk_shape` elements; the last one is padded with
    `fill_value` and the array's `shape` is what bounds a reader."""
    n = 10_000  # 2 full 4096 chunks + a 1808-element tail
    values = np.full(n, 3.5, dtype=np.float32)
    with cz.Table(tmp_path / "p.zarr", axis="cells", n=n) as t:
        t.numeric("x", values, dtype="float32")
    root = tmp_path / "p.zarr"
    assert read_meta(root, "x")["fill_value"] == 0.0

    tail = read_chunk_raw(root, "x", shard=0, slot=2)
    assert tail.size == cz.INNER_CHUNK, "the tail chunk is stored full-size"
    real = n - 2 * cz.INNER_CHUNK
    np.testing.assert_array_equal(tail[:real], 3.5)
    np.testing.assert_array_equal(tail[real:], 0.0)  # ← padded with fill_value
    # …and the padding is invisible through the array's declared shape.
    assert read_array(root, "x").shape == (n,)


def test_the_same_input_produces_byte_identical_output(tmp_path):
    """Artifacts are immutable and content-addressed, so an unchanged column must not
    mint a new `content_hash`. Two independent writes must agree byte for byte —
    including the gzip container, whose MTIME would otherwise move every run."""
    rng = np.random.default_rng(11)
    values = rng.normal(size=5_000).astype(np.float64)
    labels = ["a", "b", "c"] * 1666 + ["a", "b"]

    def build(root):
        with cz.Table(root, axis="cells", n=5_000) as t:
            t.numeric("v", values, dtype="float64")
            t.categorical("g", values=labels, levels=["a", "b", "c", "d"])
            t.string("s", [f"cell-{i}" for i in range(5_000)])

    build(tmp_path / "one.zarr")
    build(tmp_path / "two.zarr")
    a = sorted(p.relative_to(tmp_path / "one.zarr") for p in (tmp_path / "one.zarr").rglob("*") if p.is_file())
    b = sorted(p.relative_to(tmp_path / "two.zarr") for p in (tmp_path / "two.zarr").rglob("*") if p.is_file())
    assert a == b and a, "both writes produced the same file set"
    for rel in a:
        assert (tmp_path / "one.zarr" / rel).read_bytes() == (tmp_path / "two.zarr" / rel).read_bytes(), rel


def test_a_two_dimensional_embedding_writes_one_chunk_and_round_trips(tmp_path):
    """DEC-5: a small artifact read whole declares a chunk big enough to be ONE chunk.
    A 2-D member chunks along rows only, so a chunk carries the full width."""
    rng = np.random.default_rng(3)
    mat = rng.normal(size=(500, 2)).astype(np.float32)
    with cz.Table(tmp_path / "umap.zarr", axis="cells", n=500) as t:
        entry = t.numeric("umap", mat, dtype="float32", inner_chunk=500, chunks_per_shard=1)
    assert entry["shape"] == [500, 2] and entry["shards"] == 1
    assert read_meta(tmp_path / "umap.zarr", "umap")["dimension_names"] == ["cells", None]
    _index, chunks = parse_shard((tmp_path / "umap.zarr" / "umap" / "c" / "0" / "0").read_bytes(), 1)
    assert list(chunks) == [0], "exactly one inner chunk"
    np.testing.assert_array_equal(read_array(tmp_path / "umap.zarr", "umap"), mat)


def test_a_table_is_one_directory_with_n_members_sharing_an_axis(tmp_path):
    """ITEM-4: *n* arrays over one axis are members of ONE artifact directory, and the
    group's `zarr.json` carries the structure that says how to decode each."""
    root = tmp_path / "obs.zarr"
    with cz.Table(root, axis="cells", n=4) as t:
        t.numeric("total", [1, 2, 3, 4], dtype="int32")
        t.categorical("cluster", values=["a", "b", "a", "b"], levels=["a", "b"])
        t.string("barcode", ["AA", "CC", "GG", "TT"])
        structure = t.close()

    group = json.loads((root / "zarr.json").read_text())
    assert group["node_type"] == "group"
    assert group["attributes"]["cyto"] == structure
    assert structure["axis"] == "cells" and structure["n"] == 4
    assert [c["name"] for c in structure["columns"]] == ["total", "cluster", "barcode"]
    assert [c["kind"] for c in structure["columns"]] == ["numeric", "categorical", "string"]
    # Every declared path resolves inside the ONE directory (one merkle identity).
    for col in structure["columns"]:
        for rel in ([col["offsets"], col["values"]] if col["kind"] == "string" else [col["path"]]):
            assert (root / rel / "zarr.json").exists(), rel


def test_a_length_that_disagrees_with_the_axis_is_an_error(tmp_path):
    with cz.Table(tmp_path / "x.zarr", axis="cells", n=4) as t:
        with pytest.raises(ValueError, match="declares 4"):
            t.numeric("bad", [1, 2, 3], dtype="int32")
        with pytest.raises(ValueError, match="duplicate member"):
            t.numeric("ok", [1, 2, 3, 4], dtype="int32")
            t.numeric("ok", [1, 2, 3, 4], dtype="int32")


def test_an_empty_axis_writes_a_readable_store(tmp_path):
    root = tmp_path / "e.zarr"
    with cz.Table(root, axis="cells", n=0) as t:
        t.numeric("v", np.array([], dtype=np.float32), dtype="float32")
    assert read_meta(root, "v")["shape"] == [0]
    assert not list((root / "v" / "c").iterdir()), "no data ⇒ no shards"
    assert read_array(root, "v").shape == (0,)


# ═══════════════════════════════ TEST-8 — ITEM-2 ═════════════════════════════════

def test_code_width_comes_from_the_declared_category_count(tmp_path):
    """DEC-6: ≤ 256 declared levels ⇒ `uint8`, above ⇒ `uint16` — decided from the
    DECLARATION, at the boundary, before a single value is looked at."""
    assert cz.code_dtype(["a"]) == np.dtype("uint8")
    assert cz.code_dtype([str(i) for i in range(256)]) == np.dtype("uint8")
    assert cz.code_dtype([str(i) for i in range(257)]) == np.dtype("uint16")
    assert cz.code_dtype([str(i) for i in range(65_536)]) == np.dtype("uint16")
    with pytest.raises(ValueError, match="exceeds"):
        cz.code_dtype([str(i) for i in range(65_537)])

    for count, want in ((256, "uint8"), (257, "uint16")):
        root = tmp_path / f"c{count}.zarr"
        cats = [f"L{i}" for i in range(count)]
        with cz.Table(root, axis="cells", n=3) as t:
            t.categorical("k", values=["L0", "L1", "L2"], levels=cats)
        assert read_meta(root, "k")["data_type"] == want


def test_the_width_ignores_the_observed_data(tmp_path):
    """The trap DEC-6 exists to close: identical MEANING must give identical BYTES.
    The same three observed values, declared against a wide set, must NOT collapse to
    `uint8` just because the data happens to fit."""
    wide = [f"L{i}" for i in range(400)]
    with cz.Table(tmp_path / "w.zarr", axis="cells", n=3) as t:
        t.categorical("k", values=["L0", "L1", "L2"], levels=wide)
    assert read_meta(tmp_path / "w.zarr", "k")["data_type"] == "uint16"

    # Same observed values, a narrow declaration ⇒ uint8. Different bytes, and that
    # difference is DECLARED rather than discovered.
    narrow = ["L0", "L1", "L2"]
    with cz.Table(tmp_path / "n.zarr", axis="cells", n=3) as t:
        t.categorical("k", values=narrow, levels=narrow)
    assert read_meta(tmp_path / "n.zarr", "k")["data_type"] == "uint8"


def test_the_category_set_lands_in_zarr_json_attributes(tmp_path):
    root = tmp_path / "a.zarr"
    cats = ["ctrl", "treated", "washout"]
    with cz.Table(root, axis="cells", n=3) as t:
        entry = t.categorical("arm", values=["ctrl", "treated", "ctrl"],
                              levels=cats, ordered=True)
    attrs = read_meta(root, "arm")["attributes"]["cyto"]
    assert attrs["kind"] == "categorical"
    # `levels` is the key the browser reader looks for — a cross-language contract.
    assert attrs["levels"] == cats
    assert attrs["ordered"] is True
    # The row/manifest fragment declares the set by DIGEST + count; the list itself is the
    # stamp asserted just above, which is the cross-language contract.
    assert entry["levels_digest"] == cz.key_sequence_digest(cats)
    assert entry["n_levels"] == len(cats) and entry["dtype"] == "uint8"


def test_a_declared_but_unused_category_survives_the_round_trip(tmp_path):
    """The thing a bare array of codes cannot hold: a category nobody observed. Losing
    it would silently drop a legend entry (and an empty group from an analysis)."""
    root = tmp_path / "u.zarr"
    cats = ["ctrl", "treated", "washout", "excluded"]
    observed = ["ctrl", "treated", "ctrl", "treated"]
    with cz.Table(root, axis="cells", n=4) as t:
        t.categorical("arm", values=observed, levels=cats)

    attrs = read_meta(root, "arm")["attributes"]["cyto"]
    assert attrs["levels"] == cats, "the DECLARED set round-trips, not the observed one"
    assert "washout" in attrs["levels"] and "excluded" in attrs["levels"]
    codes = read_array(root, "arm")
    assert [attrs["levels"][c] for c in codes] == observed
    assert set(codes.tolist()) == {0, 1}, "no observed value maps to the unused levels"


def test_categorical_accepts_codes_or_labels_and_refuses_the_undeclared(tmp_path):
    cats = ["a", "b", "c"]
    root = tmp_path / "k.zarr"
    with cz.Table(root, axis="cells", n=4) as t:
        t.categorical("by_label", values=["a", "c", "b", "a"], levels=cats)
        t.categorical("by_code", codes=[0, 2, 1, 0], levels=cats)
        t.categorical("with_missing", values=["a", None, "b", "a"],
                      levels=cats, missing="c")
    np.testing.assert_array_equal(read_array(root, "by_label"), read_array(root, "by_code"))
    np.testing.assert_array_equal(read_array(root, "with_missing"), [0, 2, 1, 0])

    with cz.Table(tmp_path / "bad.zarr", axis="rows", n=2) as t:
        with pytest.raises(ValueError, match="not in the declared level set"):
            t.categorical("x", values=["a", "zzz"], levels=cats)
        with pytest.raises(ValueError, match="no `missing=` level"):
            t.categorical("y", values=["a", None], levels=cats)
        with pytest.raises(ValueError, match="pandas writes -1"):
            # pandas encodes NaN as -1; storing it would wrap to a real category.
            t.categorical("z", codes=[0, -1], levels=cats)
        with pytest.raises(ValueError, match="exactly one of"):
            t.categorical("w", values=["a", "b"], codes=[0, 1], levels=cats)


# ═══════════════════════════════ TEST-9 — ITEM-3 ═════════════════════════════════

def test_arrow_layout_strings_round_trip(tmp_path):
    """`u32` offsets + concatenated UTF-8, offsets shuffled + gzipped, data gzipped."""
    root = tmp_path / "s.zarr"
    values = ["AAACCTGAGAAACCAT-1", "AAACCTGAGAAACCGC-1", "AAACCTGAGAAAGTGG-1"]
    with cz.Table(root, axis="cells", n=3) as t:
        entry = t.string("barcode", values)
    assert entry["kind"] == "string" and entry["dtype"] == "utf8"
    assert entry["offsets"] == "barcode/offsets" and entry["values"] == "barcode/values"

    off_meta = read_meta(root, "barcode/offsets")
    dat_meta = read_meta(root, "barcode/values")
    assert off_meta["data_type"] == "uint32" and off_meta["shape"] == [4]  # n + 1
    assert dat_meta["data_type"] == "uint8"
    # The 4-byte offsets are shuffled; the 1-byte payload is not (it would be a no-op).
    assert "numcodecs.shuffle" in [c["name"] for c in off_meta["codecs"][0]["configuration"]["codecs"]]
    assert "numcodecs.shuffle" not in [c["name"] for c in dat_meta["codecs"][0]["configuration"]["codecs"]]

    np.testing.assert_array_equal(read_array(root, "barcode/offsets"),
                                  np.cumsum([0] + [len(v) for v in values]))
    assert read_string(root, "barcode") == values


def test_strings_round_trip_empty_values_and_non_ascii(tmp_path):
    """Empty strings need no sentinel (a zero-length span) and multi-byte UTF-8 must
    not be measured in characters."""
    root = tmp_path / "u.zarr"
    values = ["", "naïve CD4⁺ T", "", "细胞 #7", "😀 emoji", "plain", ""]
    with cz.Table(root, axis="cells", n=len(values)) as t:
        t.string("label", values)
    offsets = read_array(root, "label/offsets")
    assert list(offsets) == list(np.cumsum([0] + [len(v.encode("utf-8")) for v in values]))
    assert offsets[0] == 0 and offsets[1] == 0, "a leading empty string is a 0-length span"
    assert read_string(root, "label") == values


def test_a_zero_length_string_array(tmp_path):
    """No values at all: one offset (`[0]`), an empty payload, and nothing to decode."""
    root = tmp_path / "z.zarr"
    with cz.Table(root, axis="cells", n=0) as t:
        entry = t.string("label", [])
    assert entry["shape"] == [0] and entry["n_bytes"] == 0
    assert read_meta(root, "label/offsets")["shape"] == [1]
    assert read_meta(root, "label/values")["shape"] == [0]
    assert list(read_array(root, "label/offsets")) == [0]
    assert read_string(root, "label") == []


def test_a_missing_string_is_an_error_unless_declared(tmp_path):
    with cz.Table(tmp_path / "m.zarr", axis="cells", n=2) as t:
        with pytest.raises(ValueError, match="no `missing=` string"):
            t.string("a", ["x", None])
        t.string("b", ["x", None], missing="")
    assert read_string(tmp_path / "m.zarr", "b") == ["x", ""]


def test_a_string_column_spans_shards(tmp_path):
    """The payload chunks 16× coarser than a typed column, so exercise both members
    across a real multi-shard geometry rather than the single-chunk happy path."""
    root = tmp_path / "big.zarr"
    values = [f"cell-{i:06d}-é" for i in range(20_000)]
    with cz.Table(root, axis="cells", n=20_000) as t:
        entry = t.string("barcode", values, inner_chunk=4096, chunks_per_shard=2,
                         data_inner_chunk=65_536)
    assert entry["n_bytes"] == sum(len(v.encode("utf-8")) for v in values)
    assert read_string(root, "barcode") == values


# ── the codec primitives, checked directly ───────────────────────────────────────

def test_byte_shuffle_is_a_transpose_and_gzip_is_a_real_gzip_stream():
    a = np.arange(12, dtype="<u4")
    shuffled = cz.byte_shuffle(a.tobytes(), 4)
    assert ref_unshuffle(shuffled, 4) == a.tobytes()
    assert cz.byte_shuffle(b"abc", 1) == b"abc", "a 1-byte shuffle is the identity"

    blob = cz.gzip_bytes(b"hello " * 500)
    assert blob[:3] == b"\x1f\x8b\x08", "an RFC-1952 gzip stream, not raw deflate"
    assert blob[4:8] == b"\x00\x00\x00\x00", "MTIME is zeroed for determinism"
    assert gzip.decompress(blob) == b"hello " * 500
    assert cz.gzip_bytes(b"x" * 100) == cz.gzip_bytes(b"x" * 100)


# ═══════════════════ TEST-35 — ITEM-28, the incremental shard writer ══════════════
#
# `ArrayWriter` exists so ITEM-27's CSR→CSC transpose can emit an array it never holds
# (`indices`/`data` are, by construction, the size of the matrix). The claim under test
# is not "it round-trips" — it is that the BYTES do not depend on how the caller chose
# to slice its appends. Under content addressing a one-byte disagreement mints a second
# `content_hash` for identical meaning, i.e. two artifacts where the model says one.
#
# `write_array` is the one-append front end to the same class, so the encoder cannot
# drift; what these tests actually exercise is the chunk-boundary buffering, which is
# where a real bug would live and which the shared implementation does NOT make free.


def tree(root):
    """Every file under `root` as `{relative path: bytes}` — the whole artifact, not a
    sampled subset, because `zarr.json` and the shard index are as much of the identity
    as the payload is."""
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(Path(root).rglob("*")) if p.is_file()
    }


def write_incrementally(root, name, arr, blocks, **geometry):
    """Feed `arr` through `ArrayWriter` in the given block sizes (cycled)."""
    w = cz.ArrayWriter(root, name, dtype=arr.dtype,
                       width=(int(arr.shape[1]) if arr.ndim == 2 else None), **geometry)
    i, k = 0, 0
    while i < len(arr):
        step = blocks[k % len(blocks)]
        w.append(arr[i : i + step])
        i += step
        k += 1
    return w.close()


# Block patterns that all carry the same values but land on wildly different chunk
# boundaries: one shot, one row at a time, a prime that never divides the geometry, and
# a step LARGER than a whole shard (so one append spans several chunks and a flush).
APPEND_PATTERNS = {
    "one-shot": [10**9],
    "single-rows": [1],
    "prime-7": [7],
    "prime-13": [13],
    "ragged": [1, 5, 2, 9, 1, 40],
    "bigger-than-a-shard": [1000],
}
# A zero-length append is exercised separately (`test_a_zero_length_append_is_a_no_op`)
# — it cannot be a cycled block size here because a 0 step would never advance.


@pytest.mark.parametrize("pattern", sorted(APPEND_PATTERNS))
def test_incremental_output_is_byte_identical_to_write_array(tmp_path, pattern):
    """TEST-35 — the heart of it: same values, any append pattern, SAME BYTES.

    The geometry is chosen so the array ends on a TAIL SHARD SHORTER than
    `chunks_per_shard` (147 rows over 4-row chunks, 8 chunks a shard → 4 full shards
    plus a 5th holding 4 chunks and a 3-row padded tail), which is the case a naive
    incremental writer gets wrong: it is the only one where the shard index must carry
    EMPTY slots the batch writer never had to think about.
    """
    blocks = APPEND_PATTERNS[pattern]
    rng = np.random.default_rng(11)
    arr = rng.integers(0, 2**31, 147).astype("int64")
    geometry = dict(inner_chunk=4, chunks_per_shard=8)

    batch = tmp_path / "batch"
    incr = tmp_path / "incr"
    e_batch = cz.write_array(batch, "m", arr, **geometry)
    e_incr = write_incrementally(incr, "m", arr, blocks, **geometry)

    assert tree(batch) == tree(incr), (
        f"append pattern {pattern!r} changed the bytes — same data, two content hashes"
    )
    assert e_batch == e_incr, "the returned `structure` fragment must match too"
    # ...and the shared bytes are genuinely the format, not two copies of one bug.
    np.testing.assert_array_equal(read_array(incr, "m"), arr)


def test_a_zero_length_append_is_a_no_op(tmp_path):
    """An empty block must not seal a chunk, bump the length, or perturb the bytes —
    a streaming producer hands over empty blocks all the time (a gene with no counts)."""
    arr = np.arange(37, dtype="float32")
    geometry = dict(inner_chunk=4, chunks_per_shard=3)
    batch = tmp_path / "batch"
    incr = tmp_path / "incr"
    cz.write_array(batch, "m", arr, **geometry)

    w = cz.ArrayWriter(incr, "m", dtype="float32", **geometry)
    w.append(np.zeros(0, dtype="float32"))
    for i in range(0, 37, 5):
        w.append(np.zeros(0, dtype="float32"))
        w.append(arr[i : i + 5])
    w.append(np.zeros(0, dtype="float32"))
    w.close()
    assert tree(batch) == tree(incr)


@pytest.mark.parametrize(
    "n,inner_chunk,chunks_per_shard",
    [
        (0, 4, 8),        # nothing at all — no shard files, still a readable zarr.json
        (1, 4, 8),        # one row: one padded chunk, 7 EMPTY slots
        (32, 4, 8),       # exactly ONE full shard, no tail
        (33, 4, 8),       # one full shard + a shard holding a single padded chunk
        (31, 4, 8),       # a tail shard SHORTER than chunks_per_shard (7 chunks + pad)
        (4096 * 3 + 5, 4096, 8),  # the production geometry, tail included
    ],
)
def test_incremental_matches_the_batch_writer_across_shard_boundaries(
    tmp_path, n, inner_chunk, chunks_per_shard
):
    """Every boundary the two writers could disagree on: empty, sub-chunk, exact shard,
    one-past-a-shard, and a short tail shard."""
    rng = np.random.default_rng(n + 1)
    arr = rng.random(n).astype("float32")
    geometry = dict(inner_chunk=inner_chunk, chunks_per_shard=chunks_per_shard)
    batch = tmp_path / "batch"
    incr = tmp_path / "incr"
    cz.write_array(batch, "m", arr, **geometry)
    write_incrementally(incr, "m", arr, [3, 17, 1], **geometry)
    assert tree(batch) == tree(incr), f"n={n} diverged"
    np.testing.assert_array_equal(read_array(incr, "m"), arr)


def test_the_incremental_tail_shard_pads_and_leaves_the_rest_empty(tmp_path):
    """Read the tail shard with the INDEPENDENT parser: the short chunk is padded to
    `fill_value`, the unused slots are the `2**64-1` sentinel, and the crc32c over the
    index is the one the format specifies."""
    arr = np.arange(19, dtype="uint32")
    root = tmp_path / "a"
    write_incrementally(root, "m", arr, [4, 1, 6], inner_chunk=4, chunks_per_shard=3)
    # 19 rows / (4*3) → shard 0 full (3 chunks), shard 1 holds chunks for rows 12-15,
    # 16-18(+pad) and ONE empty slot.
    body = (root / "m" / "c" / "1").read_bytes()
    index, chunks = parse_shard(body, 3)   # asserts the crc32c itself
    assert sorted(chunks) == [0, 1], "the tail shard stores exactly two chunks"
    assert int(index[2][0]) == EMPTY and int(index[2][1]) == EMPTY, "unused slot is EMPTY"
    tail = read_chunk_raw(root, "m", 1, 1)
    np.testing.assert_array_equal(tail, [16, 17, 18, 0]), "the short tail pads with fill_value"
    np.testing.assert_array_equal(read_array(root, "m"), arr)


def test_incremental_two_dimensional_blocks_match_the_batch_writer(tmp_path):
    """A 2-D member (an embedding) chunks on ROWS only, so a streaming producer appends
    row blocks; the width is declared, not inferred from the first block."""
    rng = np.random.default_rng(3)
    arr = rng.normal(size=(53, 3)).astype("float32")
    geometry = dict(inner_chunk=8, chunks_per_shard=2)
    batch = tmp_path / "batch"
    incr = tmp_path / "incr"
    cz.write_array(batch, "m", arr, dimension_names=["cells", None], **geometry)
    w = cz.ArrayWriter(incr, "m", dtype="float32", width=3,
                       dimension_names=["cells", None], **geometry)
    for i in range(0, 53, 7):
        w.append(arr[i : i + 7])
    w.close()
    assert tree(batch) == tree(incr)
    np.testing.assert_array_equal(read_array(incr, "m"), arr)


def test_incremental_carries_attributes_and_dimension_names_identically(tmp_path):
    """`zarr.json` is part of the merkle identity, so the attributes/dimension_names a
    caller declares must land byte-for-byte where the batch writer put them —
    `shape` is the ONLY thing the streaming writer learns late."""
    arr = np.arange(9, dtype="int32")
    attrs = {"cyto": {"kind": "numeric", "name": "m", "levels": ["a", "b"]}}
    batch = tmp_path / "batch"
    incr = tmp_path / "incr"
    cz.write_array(batch, "m", arr, inner_chunk=4, chunks_per_shard=2,
                   dimension_names=["cells"], attributes=attrs)
    w = cz.ArrayWriter(incr, "m", dtype="int32", inner_chunk=4, chunks_per_shard=2,
                       dimension_names=["cells"], attributes=attrs)
    w.append(arr)
    w.close()
    assert (batch / "m" / "zarr.json").read_bytes() == (incr / "m" / "zarr.json").read_bytes()
    assert tree(batch) == tree(incr)


def test_a_wrong_width_or_rank_block_is_an_error_not_a_reshape(tmp_path):
    """INV-2 — a block that disagrees with the declared geometry is a bug in the
    producer; silently ravelling it would corrupt every downstream offset."""
    w = cz.ArrayWriter(tmp_path / "a", "m", dtype="float32", width=3,
                       inner_chunk=4, chunks_per_shard=2)
    with pytest.raises(ValueError, match="width 3"):
        w.append(np.zeros((2, 4), dtype="float32"))
    with pytest.raises(ValueError, match="width 3"):
        w.append(np.zeros(6, dtype="float32"))
    w2 = cz.ArrayWriter(tmp_path / "b", "m", dtype="float32", inner_chunk=4)
    with pytest.raises(ValueError, match="1-D"):
        w2.append(np.zeros((2, 2), dtype="float32"))


def test_appending_after_close_is_an_error(tmp_path):
    w = cz.ArrayWriter(tmp_path / "a", "m", dtype="float32", inner_chunk=4)
    w.append(np.arange(4, dtype="float32"))
    w.close()
    with pytest.raises(RuntimeError):
        w.append(np.arange(4, dtype="float32"))
    with pytest.raises(RuntimeError):
        w.close()


def test_the_incremental_writer_holds_only_one_shard(tmp_path):
    """The whole point of ITEM-28: resident bytes are bounded by the SHARD, not by the
    array. Probe the writer's own buffers after feeding it far more than a shard."""
    geometry = dict(inner_chunk=16, chunks_per_shard=4)   # 64 rows a shard
    w = cz.ArrayWriter(tmp_path / "a", "m", dtype="float64", **geometry)
    for _ in range(50):
        w.append(np.arange(64, dtype="float64"))          # 3200 rows in total
    # 50 shards' worth went in; at most one shard's encoded body and one pending
    # sub-chunk may still be held.
    assert w._pending_n < 16, "no more than one inner chunk is ever pending"
    assert len(w._body) <= 4 * (16 * 8 + 64), "at most one shard's encoded chunks resident"
    entry = w.close()
    assert entry["shape"] == [3200] and entry["shards"] == 50


# ═══════════════════════ TEST-47 — ITEM-35: geometry follows the array ═══════════
#
# `chunks_per_shard` sizes the shard index UNCONDITIONALLY: the trailer is
# `chunks_per_shard * 16` bytes and every slot a shard does not fill is written as the
# EMPTY sentinel. So a CONSTANT is wrong at both ends of the scale, in opposite
# directions, and only ONE of the two failures is visible from the decoded values:
#
#   constant 8      a 10M column becomes 306 shard FILES. Correct bytes; a file count
#                   that rsync, S3, backup, GC walks and the job-input hardlink tree all
#                   pay for per object.
#   constant 4096   a 100K column gets a 64 KB index in front of 14 KB of data. Also
#                   correct bytes — 82% of the file is `ffffffffffffffff` padding for
#                   chunks that do not exist.
#
# Counting EMPTY SLOTS is what discriminates the second case, which is why these assert
# on the index and not only on the shard count. Everything below drives the PRODUCTION
# entry point (`Table.numeric`, the call a processor makes), because that is where the
# regression would live: `write_array` deriving correctly while `Table` passes a constant
# past it is exactly the shape of the bug this replaces.


def _shard_files(root, member):
    return sorted(p for p in (Path(root) / member / "c").rglob("*") if p.is_file())


def _empty_slots(root, member, per_shard):
    """EMPTY index slots across every shard of a member — the padding count."""
    empty = 0
    for path in _shard_files(root, member):
        index, _chunks = parse_shard(path.read_bytes(), per_shard)
        empty += sum(1 for pair in index if tuple(int(v) for v in pair) == (EMPTY, EMPTY))
    return empty


@pytest.mark.parametrize("n", [1_000, 100_000, 1_000_000, 10_000_000])
def test_a_realistic_column_writes_one_shard_with_no_empty_slots(tmp_path, n):
    """Through `Table.numeric` — the production call — across four orders of magnitude."""
    root = tmp_path / "t.zarr"
    with cz.Table(root, axis="rows", n=n) as t:
        entry = t.numeric("x", np.arange(n, dtype=np.float32), dtype="float32")

    assert entry["inner_chunk"] == cz.INNER_CHUNK, (
        "a bigger shard must NOT coarsen random access — the inner chunk is what a "
        "one-value gather overfetches, and it is unchanged at every size"
    )
    assert entry["shards"] == 1, f"n={n} wrote {entry['shards']} shard files"
    assert len(_shard_files(root, "x")) == 1
    used = -(-n // cz.INNER_CHUNK)
    assert entry["chunks_per_shard"] == used, "the grid is exactly as big as the data"
    assert _empty_slots(root, "x", entry["chunks_per_shard"]) == 0, (
        "the shard index carries padding for chunks that do not exist"
    )
    # And the bytes are still right — geometry is a packaging decision, not a data one.
    got = read_array(root, "x")
    assert got.shape == (n,) and float(got[0]) == 0.0 and float(got[-1]) == float(n - 1)


def test_the_previous_constant_is_what_produced_306_files(tmp_path):
    """The negative control, and the measurement the item is justified by.

    Without this, "one shard" reads as a fact about Zarr rather than as a change: the same
    column under the retired constant-8 default writes 306 files for the same bytes.
    """
    n = 10_000_000
    root = tmp_path / "old.zarr"
    with cz.Table(root, axis="rows", n=n) as t:
        entry = t.numeric("x", np.zeros(n, dtype=np.float32), dtype="float32",
                          chunks_per_shard=cz.CHUNKS_PER_SHARD)
    assert entry["shards"] == 306
    assert len(_shard_files(root, "x")) == 306


def test_an_array_past_the_cap_splits_at_the_cap(tmp_path):
    """Beyond `SHARD_CAP_CHUNKS` the count stops growing and the array splits.

    Driven at a small inner chunk so the cap is REACHED with bytes actually written
    (`inner_chunk=1` ⇒ one chunk per element), rather than asserted only on arithmetic.
    """
    n = cz.SHARD_CAP_CHUNKS + 500
    root = tmp_path / "big.zarr"
    with cz.Table(root, axis="rows", n=n) as t:
        entry = t.numeric("x", np.arange(n, dtype=np.uint8), dtype="uint8", inner_chunk=1)
    assert entry["chunks_per_shard"] == cz.SHARD_CAP_CHUNKS
    assert entry["shards"] == 2 and len(_shard_files(root, "x")) == 2
    np.testing.assert_array_equal(read_array(root, "x"), np.arange(n, dtype=np.uint8))


def test_the_cap_holds_the_index_at_a_fraction_of_the_payload_at_scale(tmp_path):
    """The arithmetic at the sizes a test cannot write: 219.7M values → 14 shards.

    `shard_chunks` is a pure function of two DECLARED numbers (`n`, `inner_chunk`), so the
    scale that matters is checkable without materializing 1.8 GB.
    """
    inner = cz.INNER_CHUNK
    per_shard = cz.shard_chunks(219_700_000, inner)
    assert per_shard == cz.SHARD_CAP_CHUNKS
    chunks = -(-219_700_000 // inner)
    assert -(-chunks // per_shard) == 14
    # The index is `chunks_per_shard * 16` bytes against `inner_chunk * itemsize` per
    # chunk of payload — ~0.24% at 4 bytes an element, from 100K elements to 219M.
    for n in (100_000, 219_700_000):
        cps = cz.shard_chunks(n, inner)
        index_bytes = cps * 16
        payload_bytes = min(n, cps * inner) * 4
        assert index_bytes / payload_bytes < 0.005, f"index overhead at n={n}"


def test_an_arraywriter_hint_changes_the_file_count_and_nothing_else(tmp_path):
    """`ArrayWriter` seals shards as blocks arrive, so it cannot derive `n` — it takes
    `expected_n` as a HINT. A WRONG hint must cost a suboptimal file count and never
    correctness, which is the property that lets a streaming producer guess."""
    n = 40_000
    arr = np.arange(n, dtype=np.int32)

    right = tmp_path / "right"
    w = cz.ArrayWriter(right, "m", dtype="int32", inner_chunk=cz.INNER_CHUNK, expected_n=n)
    w.append(arr)
    good = w.close()

    wrong = tmp_path / "wrong"
    w2 = cz.ArrayWriter(wrong, "m", dtype="int32", inner_chunk=cz.INNER_CHUNK,
                        expected_n=10)  # off by 4000×
    w2.append(arr)
    bad = w2.close()

    assert good["shards"] == 1 and bad["shards"] == 10, "only the file count moved"
    np.testing.assert_array_equal(read_array(right, "m"), arr)
    np.testing.assert_array_equal(read_array(wrong, "m"), arr)

    # Neither hint nor derivation when neither is given: the conservative floor.
    w3 = cz.ArrayWriter(tmp_path / "floor", "m", dtype="int32", inner_chunk=cz.INNER_CHUNK)
    w3.append(arr)
    assert w3.close()["chunks_per_shard"] == cz.CHUNKS_PER_SHARD


# ── the membership index BODY (ITEM-3) ──────────────────────────────────────────


def test_the_membership_index_body_is_an_ascending_uint32_member(tmp_path):
    """TEST-3 — the gather list, and the authority above the inline budget.

    Three properties, each of which a plausible-looking implementation loses on its own:
    the values are STRICTLY ASCENDING (a set stored as a sequence is walked in one pass
    by anything intersecting it), the stored width is `uint32` (numpy would pick int64 and
    double the bytes for an index that cannot exceed ~4.3e9), and the length equals the
    declared `n_members` (the declaration and the bytes are two statements about one set,
    and a consumer trusting the first while reading the second is off by the difference).
    """
    keys = [f"c{i}" for i in range(50)]
    digest = cz.key_sequence_digest(keys)
    positions = [0, 3, 4, 17, 49]

    with cz.Table(tmp_path / "t.zarr", axis="rows", n=len(positions),
                  membership={"axis": "rows", "aligned_to": digest,
                              "derived_from": keys, "members": positions}) as t:
        t.numeric("values", np.arange(len(positions), dtype="float32"), dtype="float32")
    structure = json.loads((tmp_path / "t.zarr" / "zarr.json").read_text())
    structure = structure["attributes"]["cyto"]

    entry = structure["memberships"][0]
    assert entry["n_members"] == len(positions)
    body = read_array(tmp_path / "t.zarr", entry["members"])
    assert body.dtype == np.dtype("uint32"), "an index body is uint32, not numpy's int64"
    np.testing.assert_array_equal(body, np.asarray(positions, dtype="uint32"))
    assert len(body) == entry["n_members"], "the declaration and the bytes are one set"
    assert list(body) == sorted(set(int(v) for v in body)), "strictly ascending"

    # It is NOT a column of this table. Its length is the member count and its values are
    # positions into a DIFFERENT sequence, so declaring it in `columns` would offer the
    # row numbers in the column picker and would put it under the per-row length check.
    assert [c["name"] for c in structure["columns"]] == ["values"]

    # nc: an unsorted or duplicate-bearing list is refused at declaration time — the
    # encoder walks the positions once and a non-positive gap is the refusal.
    for bad in ([3, 1], [1, 1]):
        with pytest.raises(ValueError, match="ASCENDING"):
            cz.Table(tmp_path / f"bad-{bad[0]}-{bad[1]}.zarr", axis="rows", n=2,
                     membership={"axis": "rows", "aligned_to": digest,
                                 "derived_from": keys, "members": bad})
    # nc: a length disagreeing with the table's own row count is refused too — a table's
    # rows ARE its members, so the two counts are one count stated twice.
    with pytest.raises(ValueError, match="rows"):
        cz.Table(tmp_path / "short.zarr", axis="rows", n=9,
                 membership={"axis": "rows", "aligned_to": digest,
                             "derived_from": keys, "members": positions})
