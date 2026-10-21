#!/usr/bin/env python3
"""Generate the CROSS-LANGUAGE Zarr v3 fixtures `zarrReader.test.ts` reads (TEST-27/28).

WHY THESE FIXTURES EXIST
------------------------
A reader tested against its own encoder proves nothing — it certifies whatever the
reader happens to do. A shuffle applied in the wrong direction on both sides, or a
misread offset convention, round-trips perfectly and stays invisible.

So the bytes here are written by **the real producer**: `src-app/packages/_lib`'s
`cyto_zarr` (ITEM-1..4, DEC-4/5/6/7), the module a processor actually emits artifacts
with. Not a reimplementation of it, not a sketch of it — the shipping writer, imported
and called. The TS reader then has to agree with bytes it did not produce, written by
the code that will produce them in production, in another language, with no shared
compile-time link. `cyto_zarr`'s own docstring names
`ui/src/core/workstore/zarrReader.ts` as the consumer of its on-disk vocabulary; this
file is what makes that claim checkable instead of aspirational.

The EXPECTED VALUES (`zarr/expected.json`) are computed here too, from the numpy inputs,
so the thing under test never gets to define what "correct" means.

SOME FIXTURES ARE NOT FROM THE REAL WRITER, AND SAY SO
------------------------------------------------------
The reader supports shapes `cyto_zarr` does not currently emit, all of which it must
keep handling:

  * `i32_plain`  — an UNSHARDED array (one file per chunk, no shard index). Plain v3;
                   `cyto_zarr` always sharded. A reader that only handles shards would
                   fail on any array written by another Zarr writer.
  * the four EXOTIC dtypes (`f16_*`, `c64`, `c128`, `r24`) — `float16`, `complex64`,
                   `complex128` and raw-bits `r<N>` are Zarr v3 CORE data types, so any
                   store the reader is pointed at may contain them, but `cyto_zarr`'s
                   dtype allowlist is deliberately the numeric set a processor emits.
                   They are written here rather than by widening that allowlist, because
                   the writer's job is what a processor produces and the reader's job is
                   what the SPEC allows (ITEM-31).

Those are written by the small local helpers at the bottom, which reuse `cyto_zarr`'s
OWN `encode_chunk` so even they are not a second codec implementation — only a second
file layout.

Run:  python3 generate_zarr_fixtures.py               → rewrites the committed tree
      python3 generate_zarr_fixtures.py --out DIR    → writes elsewhere (the drift gate)
Deps: numpy + stdlib, plus `src-app/packages/_lib` on the path (resolved below).

DETERMINISM IS A CHECKED PROPERTY, NOT A CLAIM
----------------------------------------------
"byte-identical on re-run" is what makes the committed bytes evidence rather than a
snapshot of whatever the writer happened to do the day someone ran this. It went FALSE
once already: `cyto_zarr.Table.string()` began stamping a `values_digest` and the two
string-bearing nodes (`table/zarr.json`, `str_large/zarr.json`) drifted from the writer
with nothing noticing, so the reader's "written by the real producer" contract test was
resting on a stale artefact. `fixtureDrift.test.ts` now regenerates into a temp dir on
every run and byte-compares the whole tree, so the claim is enforced instead of asserted.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def _out_dir() -> Path:
    """Where to write. Defaults to the committed tree; `--out <dir>` writes elsewhere.

    The override exists for the DRIFT GATE (`fixtureDrift.test.ts`), which regenerates
    into a temp dir and byte-compares against what is committed. Pointing it at the
    committed tree instead would let the check "pass" by silently REPAIRING the drift it
    is supposed to report, which is the one thing a golden-parity check must not do.
    """
    argv = sys.argv[1:]
    if "--out" not in argv:
        return HERE / "zarr"
    i = argv.index("--out")
    if i + 1 >= len(argv):
        raise SystemExit("--out needs a directory")
    return Path(argv[i + 1]).resolve()


OUT = _out_dir()
# …/src-app/ui/src/core/workstore/__fixtures__ → …/src-app/packages/_lib
LIB = HERE.parents[4] / "packages" / "_lib"
if not (LIB / "cyto_zarr.py").exists():  # pragma: no cover - a tree-layout guard
    raise SystemExit(f"cannot find the real writer at {LIB}")
sys.path.insert(0, str(LIB))

import cyto_csc  # noqa: E402  — the path insert above has to come first
from cyto_zarr import (  # noqa: E402
    ZARR_FORMAT,
    Table,
    byte_shuffle,
    crc32c,
    encode_chunk,
    gzip_bytes,
    write_array,
)


# ── the layouts / dtypes the real writer does not emit ───────────────────────────
def write_unsharded(
    name: str,
    arr: np.ndarray,
    *,
    chunk: int,
    data_type: str | None = None,
    fill_value=0,
    attributes: dict | None = None,
) -> None:
    """A plain (unsharded) v3 array: `c/0`, `c/1`, … with no shard index. Uses
    `cyto_zarr.encode_chunk` for the bytes — only the FILE layout differs.

    `data_type` overrides the numpy dtype NAME for the dtypes whose numpy spelling is
    not the Zarr v3 spelling: `r<N>` raw bits are `V<N/8>` in numpy (`void24`), which is
    a numpy-side detail, not a wire one. Everything else — `float16`, `complex64`,
    `complex128` — is spelled identically in both, so the override stays unused there and
    the fixture's declaration cannot silently drift from numpy's.
    """
    itemsize = int(arr.dtype.itemsize)
    adir = OUT / name
    (adir / "c").mkdir(parents=True, exist_ok=True)
    n = int(arr.size)
    (adir / "zarr.json").write_text(
        json.dumps(
            {
                "zarr_format": ZARR_FORMAT,
                "node_type": "array",
                "shape": [n],
                "data_type": data_type or arr.dtype.name,
                "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [chunk]}},
                "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
                "fill_value": fill_value,
                "codecs": [
                    {"name": "bytes", "configuration": {"endian": "little"}},
                    {"name": "numcodecs.shuffle", "configuration": {"elementsize": itemsize}},
                    {"name": "gzip", "configuration": {"level": 5}},
                ],
                "attributes": dict(attributes or {}),
            },
            indent=2,
        )
    )
    for k in range((n + chunk - 1) // chunk):
        block = arr[k * chunk : (k + 1) * chunk]
        if block.size < chunk:  # a chunk is ALWAYS chunk_shape elements
            block = np.concatenate([block, np.zeros(chunk - block.size, dtype=arr.dtype)])
        raw = np.ascontiguousarray(block).tobytes()
        (adir / "c" / str(k)).write_bytes(encode_chunk(raw, itemsize))


def jsonable(v: float) -> float | str:
    """A float in a form `JSON.parse` accepts. Python's `json` emits bare `NaN`/`Infinity`,
    which is not JSON and which `JSON.parse` rejects, so the non-finite values — the ones
    a naive float16 widening gets WRONG — are spelled as strings and re-read on the TS
    side. `-0.0` survives as a number and stays distinguishable from `0.0` under
    `Object.is`, which is the assertion that catches a sign-dropping widening."""
    if np.isnan(v):
        return "NaN"
    if np.isposinf(v):
        return "Infinity"
    if np.isneginf(v):
        return "-Infinity"
    return float(v)


# A `write_single_buffer_strings` helper used to live here, emitting a `str_arrow` fixture
# for the SINGLE-BUFFER arrow layout (`[u32 offsets × (n+1)][concatenated UTF-8]` in one
# array). Both are gone with the reader's decoder for that layout: `cyto_zarr.Table.string`
# writes the SPLIT form and stamps `layout: "split"`, and `conformance.py` reads
# `<path>/offsets` + `<path>/values` unconditionally — so a single-buffer member fails the
# framework gate before any reader reaches it, and the fixture was feeding a decoder
# nothing could call. Re-add both together if a producer ever emits the shape.


# ── the fixtures ─────────────────────────────────────────────────────────────────
def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    expected: dict = {}

    # 1. float32, SHARDED across 3 shards, with a PARTIAL tail chunk and trailing EMPTY
    #    index slots — the three shard-index cases in one array. 64 × 8 = 512 per shard;
    #    n = 1100 → the last shard holds 1 full chunk + 1 padded chunk + 6 EMPTY.
    n = 1100
    f32 = (np.arange(n, dtype=np.float32) * 0.5 - 3.25).astype(np.float32)
    f32[7] = np.float32(-0.0)
    f32[9] = np.float32(1e-8)
    write_array(OUT, "f32_sharded", f32, inner_chunk=64, chunks_per_shard=8)
    expected["f32_sharded"] = {
        "dtype": "float32",
        "length": n,
        "innerChunk": 64,
        "chunksPerShard": 8,
        "at": {
            str(i): float(f32[i])
            for i in [0, 1, 63, 64, 65, 511, 512, 513, 1023, 1024, 1098, 1099]
        },
        "sum": float(np.sum(f32.astype(np.float64))),
        "slice_60_70": [float(v) for v in f32[60:70]],  # straddles an inner-chunk edge
        "slice_508_516": [float(v) for v in f32[508:516]],  # straddles the SHARD edge
        "slice_1090_1100": [float(v) for v in f32[1090:1100]],  # the padded tail chunk
    }

    # 2. float64 — elementsize 8 shuffle.
    f64 = np.arange(300, dtype=np.float64) / 7.0 - 11.5
    write_array(OUT, "f64_sharded", f64, inner_chunk=32, chunks_per_shard=4)
    expected["f64_sharded"] = {
        "dtype": "float64",
        "length": 300,
        "at": {str(i): float(f64[i]) for i in [0, 31, 32, 127, 128, 299]},
        "sum": float(np.sum(f64)),
    }

    # 3. int16 — elementsize 2, negative values. Sign bits live in the HIGH byte, so a
    #    transpose applied in the wrong direction shows up as wrong signs, not as
    #    subtly-wrong magnitudes.
    i16 = ((np.arange(200, dtype=np.int32) * 337) % 65536 - 32768).astype(np.int16)
    write_array(OUT, "i16_sharded", i16, inner_chunk=16, chunks_per_shard=4)
    expected["i16_sharded"] = {"dtype": "int16", "length": 200, "values": [int(v) for v in i16]}

    # 4. uint8 — elementsize 1, so the writer OMITS the shuffle codec. The reader must
    #    cope with a 2-codec chain, not assume 3.
    u8 = (np.arange(150, dtype=np.uint32) * 37 % 251).astype(np.uint8)
    write_array(OUT, "u8_noshuffle", u8, inner_chunk=64, chunks_per_shard=2)
    expected["u8_noshuffle"] = {"dtype": "uint8", "length": 150, "values": [int(v) for v in u8]}

    # 5. 2-D ROW-CHUNKED float32 (n × 2 coordinate pairs). Chunking splits dim 0 only, so
    #    a flat C-order element range is still contiguous — the one rank-N shape the
    #    reader supports. Note the chunk keys become `c/<s>/0`, not `c/<s>`.
    grid = (np.arange(48 * 2, dtype=np.float32) * 0.25).reshape(48, 2)
    write_array(OUT, "f32_rowchunk_2d", grid, inner_chunk=16, chunks_per_shard=2)
    expected["f32_rowchunk_2d"] = {
        "dtype": "float32",
        "shape": [48, 2],
        "length": 96,
        "flat": [float(v) for v in grid.reshape(-1)],
    }

    # 6. A real TABLE artifact — *n* arrays sharing one axis under ONE directory, built
    #    through `cyto_zarr.Table`, i.e. the exact call a processor makes (ITEM-4).
    #    This is the fixture that matters most: everything above exercises the byte
    #    layer, this exercises the artifact shape the client will actually open.
    rows = 500
    levels8 = ["group-A", "group-B", "café ☕", "", "NEVER-OBSERVED"]
    codes8 = ((np.arange(rows) * 7) % 4).astype(np.int64)  # never reaches level 4
    levels16 = [f"lvl-{i:04d}" for i in range(300)]  # > 256 ⇒ uint16 codes (DEC-6)
    codes16 = ((np.arange(rows) * 61) % 300).astype(np.int64)
    # The awkward strings go at the head; the rest are plain so the column is realistic.
    head = ["ROW-000123-a", "naïve", "日本語テスト", "", "emoji ☕🛰", "ROW-000123-a", "tab\tand\nnewline"]
    strings = head + [f"id-{i:05d}" for i in range(rows - len(head))]
    values = (np.arange(rows, dtype=np.float32) * 0.5 - 3.25).astype(np.float32)

    with Table(OUT / "table", axis="rows", n=rows) as table:
        table.numeric("f32col", values, dtype="float32", inner_chunk=64, chunks_per_shard=2)
        table.categorical("cat8", levels=levels8, codes=codes8, inner_chunk=64, chunks_per_shard=2)
        table.categorical("cat16", levels=levels16, codes=codes16, inner_chunk=128, chunks_per_shard=2)
        table.string("str", strings, inner_chunk=64, data_inner_chunk=256, chunks_per_shard=2)

    expected["table"] = {
        "n": rows,
        "f32col": {"at": {str(i): float(values[i]) for i in [0, 63, 64, 127, 128, 499]}},
        "cat8": {
            "dtype": "uint8",
            "levels": levels8,
            "codes": [int(c) for c in codes8],
            "values": [levels8[int(c)] for c in codes8],
            # DECLARED but never used — it must survive into `categories` regardless.
            "unusedLevel": "NEVER-OBSERVED",
        },
        "cat16": {
            "dtype": "uint16",
            "levelCount": len(levels16),
            "codes": [int(c) for c in codes16],
            "values": [levels16[int(c)] for c in codes16],
        },
        "str": {"n": rows, "values": strings},
    }

    # 7. UNSHARDED int32 — plain per-chunk files, no index. NOT written by `cyto_zarr`
    #    (see the module docstring); the reader must still handle it.
    i32 = (np.arange(70, dtype=np.int32) * -3 + 5).astype(np.int32)
    write_unsharded("i32_plain", i32, chunk=32)
    expected["i32_plain"] = {"dtype": "int32", "length": 70, "values": [int(v) for v in i32]}

    # ── 8-12. THE FOUR CORE DTYPES JS HAS NO NATIVE TYPE FOR (ITEM-31) ───────────
    #
    # `float16`, `complex64`, `complex128` and raw-bits `r<N>` complete the Zarr v3 core
    # set. Each needs a DECLARED JS representation, and each of those declarations is a
    # place a plausible-looking wrong answer can hide, so each gets a fixture whose
    # expected values numpy computed. Written UNSHARDED because dtype decoding and shard
    # geometry are independent axes — the six sharded fixtures above already carry the
    # geometry, and a second copy of it here would only test the fixture writer.

    # 9. float16, CURATED: every exponent regime plus the values a naive widening gets
    #    wrong. Subnormals have no implicit leading 1; ±0 must keep its sign; ±inf and
    #    NaN share exponent 0x1F and are told apart only by the fraction.
    f16 = np.array(
        [
            0.0, -0.0, 1.0, -1.0, 2.0, 0.5,
            np.float16(2.0 ** -24),          # smallest positive subnormal
            np.float16(-(2.0 ** -24)),
            np.float16(1023 * 2.0 ** -24),   # largest subnormal
            np.float16(2.0 ** -14),          # smallest positive normal
            np.float16(65504.0),             # largest finite
            np.float16(-65504.0),
            np.float16(np.inf), np.float16(-np.inf), np.float16(np.nan),
            np.float16(0.1), np.float16(-3.14159), np.float16(1e-5),
        ],
        dtype=np.float16,
    )
    write_unsharded("f16_curated", f16, chunk=8, fill_value=0.0)
    expected["f16_curated"] = {
        "dtype": "float16",
        "length": int(f16.size),
        # float16 → float32 is EXACT (every one of the 65536 patterns is representable in
        # binary32), so these are equality assertions, not tolerances.
        "values": [jsonable(v) for v in f16.astype(np.float32)],
        "negativeZeroAt": 1,
    }

    # 10. float16, EXHAUSTIVE: every bit pattern that is not a NaN, 63490 of them, so the
    #     widening is pinned across all three exponent regimes rather than at 18 sampled
    #     points. The oracle is a crc32c of numpy's own float32 bytes — a complete
    #     comparison that costs ten bytes of JSON instead of a megabyte. NaNs are excluded
    #     because a float32 NaN's PAYLOAD is not preserved by JS (`Float32Array` stores the
    #     canonical quiet NaN), so their bytes would differ for a reason that has nothing
    #     to do with correctness; `f16_curated` asserts NaN-ness directly instead.
    patterns = np.arange(65536, dtype=np.uint16)
    is_nan = ((patterns >> 10) & 0x1F == 0x1F) & ((patterns & 0x03FF) != 0)
    sweep = patterns[~is_nan].view(np.float16)
    write_unsharded("f16_sweep", sweep, chunk=4096, fill_value=0.0)
    expected["f16_sweep"] = {
        "dtype": "float16",
        "length": int(sweep.size),
        "float32Crc32c": crc32c(sweep.astype(np.float32).tobytes()),
    }

    # 11-12. complex64 / complex128 — stored INTERLEAVED (`re0, im0, re1, im1, …`), which
    #        is what the bytes are; the reader's declared representation is the
    #        deinterleaved `{re, im}` pair, because a consumer handed the interleaved
    #        buffer has to re-derive 2i/2i+1 and one that forgets reads the imaginary part
    #        as a real value with no error anywhere.
    for name, dt, size in (("c64", np.complex64, 8), ("c128", np.complex128, 16)):
        z = np.array(
            [1 + 2j, -3.5 + 0.25j, 0 - 1j, 0 + 0j, 7.75 - 8.5j, -0.0 + -0.0j, 1e6 + 1e-6j],
            dtype=dt,
        )
        write_unsharded(name, z, chunk=4, fill_value=[0.0, 0.0])
        expected[name] = {
            "dtype": z.dtype.name,
            "itemSize": size,
            "length": int(z.size),
            "re": [jsonable(v) for v in z.real],
            "im": [jsonable(v) for v in z.imag],
            # The INTERLEAVED spelling the raw read hands back, so the deinterleave step
            # is asserted as a transformation rather than assumed.
            "interleaved": [jsonable(v) for v in np.stack([z.real, z.imag], axis=1).reshape(-1)],
        }

    # 13. r24 — raw bits, 3 bytes per element. A non-power-of-2 stride on purpose: a
    #     reader that assumed 1/2/4/8 would mis-stride every element after the first, and
    #     with a power-of-2 stride that bug is invisible. `r<N>` means "N opaque bits",
    #     so the only correct decode is the bytes back, verbatim.
    raw24 = bytes((i * 37 + (i >> 3)) % 256 for i in range(64 * 3))
    r24 = np.frombuffer(raw24, dtype=np.dtype("V3"))
    write_unsharded("r24", r24, chunk=16, data_type="r24", fill_value=[0, 0, 0])
    expected["r24"] = {"dtype": "r24", "stride": 3, "length": 64, "bytes": list(raw24)}

    # 14. A LARGE split string column — the fixture ITEM-32's windowed read is measured
    #     against. It has to be big enough that "decode only the covering chunks" and
    #     "decode the whole column" differ by more than noise in the request log: 8192
    #     values over 17 offset chunks and 18 payload chunks.
    big_n = 8192
    big = [f"id-{i:06d}" for i in range(big_n)]
    with Table(OUT / "str_large", axis="rows", n=big_n) as big_table:
        big_table.string("col", big, inner_chunk=512, data_inner_chunk=4096,
                         chunks_per_shard=4)
    expected["str_large"] = {
        "n": big_n,
        "bytesPerValue": len(big[0].encode()),
        "offsetsInnerChunk": 512,
        "valuesInnerChunk": 4096,
        "chunksPerShard": 4,
        # Only the window the test reads, so the fixture cannot smuggle in the whole
        # column as its own oracle.
        "window_5000_5100": big[5000:5100],
        "at_7777": big[7777],
        "first": big[0],
        "last": big[big_n - 1],
    }

    # 16. A real CSC MATRIX artifact, written by `cyto_csc.write_csc_zarr` — the ONLY
    #     producer of a sparse artifact in the tree, and the one whose output the client's
    #     column read has to decode. This fixture is the reason the vocabulary drift that
    #     shipped could not survive: the reader is now tested against bytes the shipping
    #     WRITER produced, so a reader expecting some other spelling fails here instead of
    #     at a user's colour-by-value click.
    #
    #     Sized so the value members span MORE THAN ONE inner chunk (5000 non-zeros at the
    #     writer's 4096 inner chunk ⇒ 2 chunks in 1 shard). A single-chunk fixture would
    #     make "a column read is a RANGE, not the whole member" vacuously true — column 3
    #     below straddles the chunk boundary on purpose, which is the case that would
    #     silently return half a column if the range arithmetic were wrong.
    #
    #     Column 4 holds NOTHING. An empty column is a real case (it is what a column with
    #     no non-zeros looks like) and its read must cost one probe and no payload fetch.
    csc_rows, csc_cols = 5000, 5
    dense = np.zeros((csc_rows, csc_cols), dtype=np.float32)
    for r in range(csc_rows):
        dense[r, r % (csc_cols - 1)] = float(r + 1)
    csc_structure = cyto_csc.write_csc_zarr(
        cyto_csc.ArraySource(dense), OUT / "csc", axes=("rows", "columns")
    )
    indptr_col = np.zeros(csc_cols + 1, dtype=np.int64)
    per_column = []
    for c in range(csc_cols):
        rows = np.nonzero(dense[:, c])[0].astype(np.int64)
        vals = dense[rows, c].astype(np.float32)
        indptr_col[c + 1] = indptr_col[c] + rows.size
        per_column.append(
            {
                "col": c,
                "n": int(rows.size),
                "rowFirst": int(rows[0]) if rows.size else None,
                "rowLast": int(rows[-1]) if rows.size else None,
                "valueFirst": float(vals[0]) if vals.size else None,
                "valueLast": float(vals[-1]) if vals.size else None,
                "rowSum": int(rows.sum()),
                "valueSum": float(vals.astype(np.float64).sum()),
            }
        )
    # ONE column recorded in FULL — the one that straddles the inner-chunk boundary, so the
    # exhaustive comparison lands on the case where a wrong offset is subtle rather than
    # total. The others are pinned by count + endpoints + sums, which no plausible
    # off-by-one survives.
    straddler = max(
        range(csc_cols),
        key=lambda c: 0 if indptr_col[c + 1] == indptr_col[c]
        else (indptr_col[c] // 4096 != (indptr_col[c + 1] - 1) // 4096),
    )
    full_rows = np.nonzero(dense[:, straddler])[0].astype(np.int64)
    expected["csc"] = {
        "structure": csc_structure,
        "shape": [csc_rows, csc_cols],
        "nnz": int(indptr_col[-1]),
        "innerChunk": csc_structure["indices"]["inner_chunk"],
        "indptr": [int(v) for v in indptr_col],
        "columns": per_column,
        "emptyColumn": next((c for c in range(csc_cols) if indptr_col[c + 1] == indptr_col[c]), None),
        "fullColumn": {
            "col": int(straddler),
            "row": [int(v) for v in full_rows],
            "value": [float(v) for v in dense[full_rows, straddler]],
        },
    }

    # 15. PRIMITIVE vectors — each byte transform checked in ISOLATION against the real
    #    writer's own functions, so a failure names the STAGE instead of saying "the
    #    array is wrong". `isIdentity` is the negative control: if the shuffle ever
    #    stopped being applied, every array above would still round-trip and only this
    #    flag would notice.
    prim_raw = np.array([1.0, -2.5, 3.25, 1e6, -0.0, 7.75], dtype=np.float32).tobytes()
    shuffled = byte_shuffle(prim_raw, 4)
    gz_payload = b"the quick brown fox " * 4
    expected["_primitives"] = {
        "shuffle": {
            "elementsize": 4,
            "raw": list(prim_raw),
            "shuffled": list(shuffled),
            "isIdentity": bytes(shuffled) == prim_raw,
        },
        "gzip": {"raw": list(gz_payload), "gzipped": list(gzip_bytes(gz_payload))},
        "crc32c": [
            {"bytes": list(b), "value": crc32c(b)}
            for b in (b"", b"a", b"123456789", bytes(range(64)))
        ],
    }

    (OUT / "expected.json").write_text(json.dumps(expected, indent=1) + "\n")

    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"wrote {len(list(OUT.rglob('zarr.json')))} nodes, {total / 1024:.1f} KB → {OUT}")


if __name__ == "__main__":
    main()
