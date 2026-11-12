#!/usr/bin/env python3
# ruff: noqa
"""txr_zarr_read — a minimal reference READER for what `txr_zarr` writes.

Not part of the serving path: the server never opens a byte (INV-1) and the browser has
its own zero-dependency reader. This exists for the two producer-side jobs that legitimately
need to read the store back — a processor that consumes another processor's output, and a
test suite asserting what a processor emitted — so neither has to re-derive the shard
container by hand.

numpy + stdlib only, same floor as the writer.

Deliberately NOT used by `test_zarr_writer.py`: those tests carry their own decoder so the
format round-trip is proved against an INDEPENDENT implementation rather than the writer
agreeing with itself.
"""
import gzip
import json
from pathlib import Path

import numpy as np

EMPTY = (1 << 64) - 1


def unshuffle(buf, itemsize):
    """The inverse of `txr_zarr.byte_shuffle` — regroup bytes by element."""
    if itemsize == 1:
        return bytes(buf)
    return np.frombuffer(buf, dtype=np.uint8).reshape(itemsize, -1).T.tobytes()


def read_meta(root, name=None):
    """The `zarr.json` of the store root, or of a member when `name` is given."""
    p = Path(root) if name is None else Path(root) / name
    return json.loads((p / "zarr.json").read_text())


def structure(root):
    """The producer-declared `structure`, as stamped into the group's attributes."""
    return read_meta(root)["attributes"]["txr"]


def read_plain_array(root, name, meta):
    """Decode an UNSHARDED, UNCOMPRESSED array — `codecs: [bytes]`, one chunk per key.

    `txr_zarr` never writes this shape; the SERVER does. A gathered (virtual) column has no
    blob, so the coordinator materialises it into an ordinary zarr store before staging it as
    a sandbox input, and re-encoding each chunk into the writer's shuffle+gzip+shard container
    would burn CPU for no benefit — codecs are declared per array, so a reader that follows
    the declaration reads both.

    Without this branch `read_array` reached for `codecs[0].configuration.chunk_shape`, which
    a `bytes` codec does not have, and every processor consuming a gathered input died with
    `KeyError: 'chunk_shape'` — measured, not reasoned.
    """
    dtype = np.dtype(meta["data_type"]).newbyteorder("<")
    shape = meta["shape"]
    chunk_rows = meta["chunk_grid"]["configuration"]["chunk_shape"][0]
    width = shape[1] if len(shape) == 2 else None
    out = np.full(tuple(shape), meta["fill_value"], dtype=dtype)
    n_chunks = (shape[0] + chunk_rows - 1) // chunk_rows
    for g in range(n_chunks):
        key = f"{g}" if width is None else f"{g}/0"
        body = (Path(root) / name / "c" / key).read_bytes()
        block = np.frombuffer(body, dtype=dtype)
        if width is not None:
            block = block.reshape(-1, width)
        lo = g * chunk_rows
        hi = min(lo + chunk_rows, shape[0])
        out[lo:hi] = block[: hi - lo]
    return out


def read_array(root, name):
    """Decode a whole member array to numpy."""
    meta = read_meta(root, name)
    # Dispatch on the DECLARED codec chain, never on the file layout: an array that declares
    # no sharding container has its chunks stored plainly, and guessing from the bytes is what
    # this reader exists not to do.
    if meta["codecs"][0]["name"] != "sharding_indexed":
        return read_plain_array(root, name, meta)
    cfg = meta["codecs"][0]["configuration"]
    dtype = np.dtype(meta["data_type"]).newbyteorder("<")
    shape = meta["shape"]
    inner_rows = cfg["chunk_shape"][0]
    shard_rows = meta["chunk_grid"]["configuration"]["chunk_shape"][0]
    per_shard = shard_rows // inner_rows
    width = shape[1] if len(shape) == 2 else None
    shuffled = any(c["name"] == "numcodecs.shuffle" for c in cfg["codecs"])

    out = np.full(tuple(shape), meta["fill_value"], dtype=dtype)
    n_shards = (shape[0] + shard_rows - 1) // shard_rows
    for s in range(n_shards):
        key = f"{s}" if width is None else f"{s}/0"
        body = (Path(root) / name / "c" / key).read_bytes()
        idx_bytes = body[len(body) - per_shard * 16 - 4 : len(body) - 4]
        index = np.frombuffer(idx_bytes, dtype="<u8").reshape(per_shard, 2)
        for k, (off, nb) in enumerate(index):
            if int(off) == EMPTY:
                continue
            plain = gzip.decompress(bytes(body[int(off) : int(off) + int(nb)]))
            if shuffled:
                plain = unshuffle(plain, dtype.itemsize)
            block = np.frombuffer(plain, dtype=dtype)
            if width is not None:
                block = block.reshape(inner_rows, width)
            lo = s * shard_rows + k * inner_rows
            if lo >= shape[0]:
                continue
            hi = min(lo + inner_rows, shape[0])
            out[lo:hi] = block[: hi - lo]
    return out


def read_strings(root, name):
    """Decode a SPLIT arrow-layout string member back to a list of `str`."""
    offsets = read_array(root, f"{name}/offsets")
    payload = read_array(root, f"{name}/values").tobytes()
    return [payload[int(offsets[i]) : int(offsets[i + 1])].decode("utf-8")
            for i in range(len(offsets) - 1)]


def read_column(root, member="values"):
    """A `txr_columns` column artifact as plain Python values.

    Returns the labels for a categorical (codes resolved through the declared level
    set), the strings for a string column, and a numpy array otherwise — i.e. what the
    column MEANS, which is what a caller asserting on a processor's output wants.
    """
    meta = read_meta(root, member)
    kind = meta.get("attributes", {}).get("txr", {}).get("kind")
    if kind == "string" or (Path(root) / member / "offsets").exists():
        return read_strings(root, member)
    values = read_array(root, member)
    if kind == "categorical":
        levels = meta["attributes"]["txr"]["levels"]
        return [levels[int(c)] for c in values]
    return values
