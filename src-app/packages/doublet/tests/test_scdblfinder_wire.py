#!/usr/bin/env python3
# ruff: noqa
"""TEST-W [acceptance] [invariant: INV-1] [covers: #195/E7] — `_wire.R` IS THIS APP'S WIRE FORMAT.

`compute/_wire.R` is a SECOND implementation of a format whose first implementation is
`_lib/txr_zarr.py`, in a language with no compile-time link to it, staged into a sandbox
that has neither the python module nor a way to import it. Nothing in the build catches a
disagreement: R writes bytes, the run exits 0, the manifest is well-formed, and the
disagreement surfaces days later as `member "values" does not decode` from the
out-of-process conformance gate — or, worse, as numbers that decode fine and are wrong.

── THE ONE RULE THIS FILE FOLLOWS ──────────────────────────────────────────────────────
Every claim is a ROUND TRIP through the PYTHON reference, never a re-reading of the spec.
`_wire.R`'s header says it ported `crc32c`, `key_sequence_digest`, `vocab_declaration`,
`normalise_levels`, the gzip container and the sharded array container "EXACTLY". A test
that re-derived the same constants in python would agree with the comment rather than with
`txr_zarr`, and would pass while both were wrong together. So:

  * R drives its own function, python drives `txr_zarr`'s, and the two OUTPUTS are
    compared — no hard-coded expected value on either side except the one published
    known-answer (`crc32c("abc") == 0x364b3fb7`), which is there to catch the case where
    both implementations are the same wrong function;
  * columns R wrote are decoded by `txr_zarr_read.read_column`, the reference reader the
    rest of this suite uses on the python lane's output;
  * a CSC store python wrote is decoded by R, which is the direction that exercises the
    un-shuffle and the int64 `indptr`, neither of which the write path touches;
  * the bytes are then handed to `conformance.conform_manifest(..., full=True)` — the
    SAME gate that runs out of process after ingest and flips a non-conforming artifact
    to `failed`.

── WHY THE GZIP TEST IS NOT PARANOIA ───────────────────────────────────────────────────
`_wire.R`'s header documents a measured trap: R's `memCompress(type = "gzip")` emits a
RFC-1950 *zlib* stream (`78 9c`), not the RFC-1952 gzip container (`1f 8b`) that
`gzip.decompress` and `DecompressionStream('gzip')` require. `gzip_bytes()` rewraps it by
hand. `test_the_gzip_container_is_rfc_1952_not_zlib` drives BOTH — the raw
`memCompress` output to prove the trap is real on this image rather than folklore, and
`gzip_bytes` to prove the rewrap is correct — because a rewrap that silently regressed to
the zlib framing would leave every chunk undecodable by every consumer at once.

── WHAT THIS FILE DOES NOT COVER, AND SAYS SO ──────────────────────────────────────────
`shard_chunks` caps at 4,096 inner chunks of 4,096 elements, so a column below ~16.7M
values is ONE shard. Every column this analysis writes is far below that, so the
multi-SHARD path is not exercised here and this file does not pretend it is; what IS
exercised is the multi-CHUNK path (n > 4096), the tail padding and the multi-slot shard
index, which are the parts a single-chunk fixture would leave dark. Likewise the int64
`indptr` values in the CSC fixture all fit in the low 32 bits: what the read proves is the
two-half recombination and the signed→unsigned correction, not arithmetic above 2^32.
"""
import gzip
import json
import math
from pathlib import Path

import numpy as np
import pytest

import conformance
import txr_csc
import txr_zarr
import txr_zarr_read

from doublet_fixtures import WIRE_R, run_in_r_sandbox, write_csc_store


# ── driving `_wire.R` itself ────────────────────────────────────────────────────────
#
# The R side is executed INSIDE the analysis image, because that is the only place the
# functions under test ever run: `digest`, `jsonlite` and `Matrix` are the image's, and a
# host R (if there even is one) would be testing a different build of the same source.
#
# The driver is written per test rather than shared, and it always SOURCES the shipped
# `_wire.R` by absolute path — never a copy. A copy is the one thing that would let this
# file go green over a file that is not the one staged into `/code`.
_PRELUDE = """\
args <- commandArgs(trailingOnly = TRUE)
WIRE <- args[[1]]
WORK <- args[[2]]
# `_wire.R` names `digest::` and `jsonlite::` explicitly but reaches for `dgCMatrix` as a
# BARE S4 class, so `Matrix` must be attached before it is sourced — which is exactly what
# `scdblfinder.R` does at the top of the file, in that order. Attaching it here rather than
# adding a `library()` to the helper keeps the harness a mirror of the entry rather than a
# repair of it.
suppressPackageStartupMessages(library(Matrix))
source(WIRE)

#' The driver's own emitter. `_wire.R` has `write_json_file`, but a test that reported its
#' findings through the very helper it is testing could not distinguish "the value is right"
#' from "the reporter is broken in a way that cancels out".
emit <- function(obj) writeLines(
  jsonlite::toJSON(obj, auto_unbox = TRUE, digits = NA, null = "null", force = TRUE),
  file.path(WORK, "out.json"))

hex_to_raw <- function(h) {
  if (!nzchar(h)) return(raw(0))
  as.raw(strtoi(substring(h, seq(1L, nchar(h), 2L), seq(2L, nchar(h), 2L)), 16L))
}
"""


def _r_driver(work: Path, body: str, *, expect_ok: bool = True, timeout: int = 900):
    """Run `body` inside the image with the SHIPPED `_wire.R` sourced; return its JSON.

    Returns `(parsed_or_None, proc)` so a test can assert on a NON-zero exit too — a
    refusal that `_wire.R` is supposed to raise is a result, not a harness failure.
    """
    work.mkdir(parents=True, exist_ok=True)
    script = work / "driver.R"
    script.write_text(_PRELUDE + body)
    out = work / "out.json"
    if out.exists():
        out.unlink()
    proc = run_in_r_sandbox(
        f"Rscript --vanilla {script} {WIRE_R} {work}",
        binds=[str(work), str(WIRE_R.parent)],
        timeout=timeout,
    )
    if expect_ok:
        assert proc.returncode == 0, (
            f"the R driver exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
    parsed = json.loads(out.read_text()) if out.exists() else None
    return parsed, proc


def _r_number(x: float) -> str:
    """A python float as a literal R's `as.numeric` parses back to the SAME double.

    `repr` round-trips exactly for a finite double and R's parser is correctly rounded, so
    this is a lossless channel; the three non-finite spellings are named because `repr`
    gives `nan`/`inf`, which R does not accept.
    """
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Inf" if x > 0 else "-Inf"
    return repr(float(x))


# ── crc32c: the shard index's trailer codec ─────────────────────────────────────────
#
# `_wire.R` had to port this by hand: `digest` offers crc32, and crc32 is a DIFFERENT
# polynomial — a shard whose trailer carries crc32 is rejected by every reader that
# actually checks it. The port also has to survive R's lack of an unsigned 32-bit type
# (the reflected polynomial 0x82F63B78 overflows `.Machine$integer.max`, and the naive
# `bitwXor` port yields NA silently).
_CRC_CASES = [
    "",                       # the empty message — crc32c("") == 0, the identity case
    "abc",                    # the published known answer, 0x364b3fb7
    "123456789",              # the check value every CRC catalogue lists
    "a" * 4096,               # one whole inner chunk's worth of one repeated byte
]


def test_wire_r_crc32c_equals_txr_zarr_crc32c(tmp_path):
    """TEST-1 — DELETE THIS and a shard index trailer computed with the wrong polynomial — or one
    silently NA'd by R's signed-integer overflow — ships undetected, and every consumer
    that verifies the trailer refuses every shard this analysis writes.

    Driven over four fixed strings AND 24 pseudo-random buffers whose contents python
    chooses, so the R side cannot be right by having memorised a case."""
    rng = np.random.default_rng(20250904)
    cases = [s.encode("utf-8") for s in _CRC_CASES]
    cases += [bytes(rng.integers(0, 256, size=int(n), dtype=np.uint8))
              for n in rng.integers(1, 300, size=24)]
    (tmp_path / "cases.json").write_text(json.dumps([c.hex() for c in cases]))

    got, _ = _r_driver(tmp_path, """
cases <- jsonlite::fromJSON(file.path(WORK, "cases.json"), simplifyVector = TRUE)
emit(vapply(cases, function(h) format(crc32c(hex_to_raw(h)), scientific = FALSE),
            character(1), USE.NAMES = FALSE))
""")
    assert len(got) == len(cases)

    # The known answer FIRST, on both sides. Without it, an R port and a python port of the
    # same *wrong* function agree with each other perfectly and this test is vacuous.
    assert txr_zarr.crc32c(b"abc") == 0x364B3FB7
    assert txr_zarr.crc32c(b"") == 0

    for buf, r_value in zip(cases, got):
        assert int(r_value) == txr_zarr.crc32c(buf), (
            f"crc32c disagrees on {len(buf)} byte(s) ({buf[:16].hex()}…): "
            f"R said {r_value}, txr_zarr said {txr_zarr.crc32c(buf)}")


# ── the gzip container ──────────────────────────────────────────────────────────────
def test_the_gzip_container_is_rfc_1952_not_zlib(tmp_path):
    """TEST-2 — DELETE THIS and `gzip_bytes` may regress to R's own `memCompress(type="gzip")`,
    whose output is a zlib stream. Nothing on the R side would notice — `memDecompress`
    reads either framing — but `gzip.decompress`, `DecompressionStream('gzip')` and
    `conformance.py`'s shard decoder all refuse it, so EVERY chunk of EVERY column this
    analysis writes becomes undecodable at once, reported from inside a sandbox as
    `BadGzipFile` with nothing naming the cause.

    Both halves are asserted: that the trap is REAL on this image (the raw `memCompress`
    output really does start `78 9c`), and that `gzip_bytes` really rewraps it. Without the
    first half this test could pass on an R build where `memCompress` already emitted gzip,
    and would then be proving nothing about the rewrap.
    """
    payloads = {
        "counts": np.arange(4096, dtype="<f8").tobytes(),      # one full inner chunk
        "text": ("singlet,doublet,not_evaluated\n" * 200).encode("utf-8"),
        "empty": b"",
        "incompressible": bytes(np.random.default_rng(7).integers(
            0, 256, size=5000, dtype=np.uint8)),
    }
    for name, blob in payloads.items():
        (tmp_path / f"{name}.bin").write_bytes(blob)

    got, _ = _r_driver(tmp_path, """
names_ <- c("counts", "text", "empty", "incompressible")
res <- list()
for (nm in names_) {
  p <- file.path(WORK, paste0(nm, ".bin"))
  payload <- readBin(p, "raw", n = file.size(p))
  g <- gzip_bytes(payload)
  writeBin(g, file.path(WORK, paste0(nm, ".gz")))
  # R's OWN gzip type, kept for the comparison — this is the thing `gzip_bytes` exists
  # to correct, and the test asserts it really is mis-framed rather than assuming it.
  z <- memCompress(payload, type = "gzip")
  res[[nm]] <- list(gzip_magic = paste(sprintf("%02x", as.integer(g[1:2])), collapse = ""),
                    memcompress_magic = paste(sprintf("%02x", as.integer(z[1:2])), collapse = ""))
}
emit(res)
""")

    for name, blob in payloads.items():
        assert got[name]["memcompress_magic"] == "789c", (
            "R's `memCompress(type=\"gzip\")` no longer emits a zlib stream on this image; "
            "re-read `_wire.R`'s header note, which is written against the measured "
            f"behaviour (got {got[name]['memcompress_magic']})")
        assert got[name]["gzip_magic"] == "1f8b", (
            f"`gzip_bytes` emitted magic {got[name]['gzip_magic']} for {name!r}; the gate "
            "and the browser both require the RFC-1952 container")
        stream = (tmp_path / f"{name}.gz").read_bytes()
        assert stream[:2] == b"\x1f\x8b"
        # THE ROUND TRIP: the stdlib reader, which is what `conformance.py` uses.
        assert gzip.decompress(stream) == blob, f"{name} did not survive the round trip"
        # …and the fixed header `txr_zarr.gzip_bytes` hand-builds, byte for byte, because a
        # header byte that moves changes every artifact's `content_hash` for identical data.
        assert stream[:10] == txr_zarr.gzip_bytes(blob)[:10]


# ── the two digests the conformance gate RECOMPUTES ─────────────────────────────────
#
# `conformance._conform_levels_digest` / `_conform_vocab_declaration` recompute these off
# the levels stamped into the member node and compare them to the manifest row. A
# disagreement is a violation, and a violation flips the artifact to `failed` — so a drift
# here is not cosmetic, it is the artifact never becoming usable.
_LEVEL_SETS = {
    "the two calls this analysis writes": ["singlet", "doublet"],
    "…plus the third state": ["singlet", "doublet", "not_evaluated"],
    "one level": ["only"],
    # `normalise_levels` LOWERCASES a two-element set that is exactly {false, true} in some
    # casing, and does it over the WHOLE set rather than per level. Both spellings must
    # therefore land on the same vocab_digest, and neither may be case-folded elsewhere.
    "a boolean vocabulary, title case": ["False", "True"],
    "a boolean vocabulary, lower case": ["false", "true"],
    "not a boolean vocabulary": ["False", "True", "Maybe"],
    # NFC-composed throughout: `_wire.R` does not implement NFC composition (R strings
    # arrive composed for every level this app writes) and says so, so a DECOMPOSED input
    # would be a known and declared divergence rather than a defect this test can pin.
    "unicode": ["café", "日本語", "Ωμέγα", "naïve"],
    "levels a naive concatenation would confuse": ["ab", "c"],
    "…and its partner": ["a", "bc"],
}


def test_key_sequence_digest_and_vocab_declaration_agree_with_txr_zarr(tmp_path):
    """TEST-3 — DELETE THIS and the R lane can stamp a `levels_digest`/`vocab_digest` the gate
    recomputes differently, which marks the call column `failed` after a run that exited 0
    — the exact "green job, unusable artifact" shape TEST-10 exists for.

    The `{false,true}` pair is here because `normalise_levels` folds it and nothing else:
    a port that folded per level, or folded nothing, or case-folded generally, agrees with
    python on every OTHER set in this table.
    """
    sets = list(_LEVEL_SETS.values())
    (tmp_path / "levels.json").write_text(json.dumps(sets, ensure_ascii=False))

    got, _ = _r_driver(tmp_path, """
sets <- jsonlite::fromJSON(file.path(WORK, "levels.json"), simplifyVector = FALSE)
res <- lapply(sets, function(s) {
  lv <- vapply(s, as.character, character(1), USE.NAMES = FALSE)
  v <- vocab_declaration(lv)
  list(normalised = I(normalise_levels(lv)),
       levels_digest = key_sequence_digest(lv),
       vocab_digest = if (length(v)) v$vocab_digest else NULL,
       vocab_sketch = if (length(v)) v$vocab_sketch else NULL)
})
emit(res)
""")

    for (label, levels), row in zip(_LEVEL_SETS.items(), got):
        assert row["normalised"] == txr_zarr.normalise_levels(levels), label
        assert row["levels_digest"] == txr_zarr.key_sequence_digest(levels), label
        want = txr_zarr.vocab_declaration(levels)
        assert row["vocab_digest"] == want["vocab_digest"], label
        assert row["vocab_sketch"] == want["vocab_sketch"], label

    # ORDER SENSITIVITY, on the R side, from R's own numbers: `key_sequence_digest` is over
    # a SEQUENCE and must separate ["ab","c"] from ["a","bc"] (the re-splitting attack the
    # length prefix exists for), while `vocab_digest` is over a SET and must not separate
    # the two boolean spellings.
    by_label = dict(zip(_LEVEL_SETS, got))
    assert (by_label["levels a naive concatenation would confuse"]["levels_digest"]
            != by_label["…and its partner"]["levels_digest"])
    assert (by_label["a boolean vocabulary, title case"]["vocab_digest"]
            == by_label["a boolean vocabulary, lower case"]["vocab_digest"])


# ── the columns R writes, decoded by the python reference reader ────────────────────
#
# ONE driver writes both columns and the manifest, and four tests read them: the write is
# the expensive part (an image start plus a real sharded encode), and every assertion below
# is about the SAME bytes, which is also what the conformance test needs — a gate run over
# artifacts a different driver produced would not be a gate run over these.

#: Deliberately > `INNER_CHUNK` (4096). At n <= 4096 a column is one chunk in one shard,
#: the tail padding never runs, and the shard index has exactly one occupied slot — so a
#: writer that mis-computed the second slot's offset, or that forgot to pad the short final
#: chunk to `inner_chunk` elements, would pass. 9,000 gives three chunks with a SHORT last
#: one (9000 = 2*4096 + 808).
_N_NUMERIC = 9000
#: Two chunks with a short tail, over three levels, for the same reason.
_N_CATEGORICAL = 5000
_CALL_LEVELS = ["singlet", "doublet", "not_evaluated"]


def _numeric_values() -> np.ndarray:
    """The float64 payload, including the NaN positions a "not scored" cell carries.

    Values that are NOT round decimals on purpose: a writer that lost precision by routing
    through a decimal string would still agree on 0.5 and 1.0.
    """
    v = np.arange(_N_NUMERIC, dtype=np.float64) / 3.0 - 1234.5
    v[::97] = np.nan                       # the "this cell was not scored" positions
    v[7] = 0.0
    v[11] = -0.0
    v[13] = 1.7976931348623157e308         # the largest finite double
    v[17] = 5e-324                         # the smallest subnormal
    v[19] = float("inf")
    v[23] = float("-inf")
    return v


@pytest.fixture(scope="module")
def written(tmp_path_factory):
    """One R run that writes a numeric column, a categorical column and the manifest.

    Module-scoped because the four tests below are assertions about ONE set of emitted
    bytes — most importantly the conformance test, which must gate exactly the artifacts
    the round-trip tests decoded, not a fresh set that happened to be written the same way.
    """
    work = tmp_path_factory.mktemp("wire_written")
    values = _numeric_values()
    (work / "values.json").write_text(
        "[" + ",".join(f'"{_r_number(float(x))}"' for x in values) + "]")

    structures, _ = _r_driver(work, f"""
outputs <- file.path(WORK, "outputs")
dir.create(outputs, recursive = TRUE, showWarnings = FALSE)

vals <- as.numeric(unlist(jsonlite::fromJSON(file.path(WORK, "values.json"),
                                             simplifyVector = TRUE)))
stopifnot(length(vals) == {_N_NUMERIC})
num <- write_numeric_column(outputs, file.path("metadata", "doublet_score.zarr"),
                            "doublet_score", vals, axis = "cells")

# Codes chosen by an arithmetic the python side recomputes independently, so the labels
# read back are checked against a rule rather than against a list R also produced.
codes <- (seq_len({_N_CATEGORICAL}) - 1L) %% 3L
lv <- c({", ".join(f'"{x}"' for x in _CALL_LEVELS)})
cat_ <- write_categorical_column(outputs, file.path("metadata", "doublet_call.zarr"),
                                 "doublet_call", codes, lv, axis = "cells")

entries <- list(
  output_entry("metadata-column:doublet_score", DT_METADATA_COLUMN,
               file.path("metadata", "doublet_score.zarr"), "artifact",
               num$structure, num$meta),
  output_entry("metadata-column:doublet_call", DT_METADATA_COLUMN,
               file.path("metadata", "doublet_call.zarr"), "artifact",
               cat_$structure, cat_$meta))
write_outputs_manifest(outputs, entries)
emit(list(numeric = num$structure, categorical = cat_$structure))
""")
    return work / "outputs", structures, values


def test_a_numeric_column_r_wrote_reads_back_bit_for_bit(written):
    """TEST-4 — DELETE THIS and the sharded container `_wire.R` hand-rolls is never decoded by
    anything but itself: a wrong chunk offset, a missing tail pad, an index slot written in
    the wrong order or a NaN turned into `fill_value` all produce a store that R can read
    back and no one else can — or that everyone reads back WRONG, silently.

    `array_equal(..., equal_nan=True)` is not enough on its own here, because it would
    forgive a writer that emitted NaN everywhere; the NaN MASK is compared separately, so
    the "not scored" positions have to be exactly the ones written.
    """
    outputs, structures, values = written
    root = outputs / "metadata" / "doublet_score.zarr"

    got = txr_zarr_read.read_column(root)
    assert isinstance(got, np.ndarray) and got.dtype == np.float64
    assert got.shape == (_N_NUMERIC,)
    assert np.array_equal(np.isnan(got), np.isnan(values)), (
        "the NaN positions moved: "
        f"{int(np.isnan(got).sum())} read back vs {int(np.isnan(values).sum())} written")
    assert np.array_equal(got, values, equal_nan=True), (
        "a value changed in the round trip at "
        f"{np.flatnonzero(~((got == values) | (np.isnan(got) & np.isnan(values))))[:8]}")

    # The container really is the multi-chunk one this test claims to exercise. Read off
    # the node R wrote rather than assumed, so a change in `shard_chunks` is visible here.
    meta = txr_zarr_read.read_meta(root, "values")
    cfg = meta["codecs"][0]["configuration"]
    assert meta["codecs"][0]["name"] == "sharding_indexed"
    assert cfg["chunk_shape"] == [txr_zarr.INNER_CHUNK]
    per_shard = meta["chunk_grid"]["configuration"]["chunk_shape"][0] // cfg["chunk_shape"][0]
    assert per_shard == txr_zarr.shard_chunks(_N_NUMERIC, txr_zarr.INNER_CHUNK) == 3, (
        "the fixture no longer spans more than one inner chunk, so the tail-padding and "
        "multi-slot index paths are untested")
    assert structures["numeric"]["columns"][0]["inner_chunk"] == txr_zarr.INNER_CHUNK
    assert structures["numeric"]["columns"][0]["chunks_per_shard"] == 3


def test_a_categorical_column_r_wrote_reads_back_as_labels(written):
    """TEST-5 — DELETE THIS and the call column can read back as raw uint8 codes, or as the wrong
    labels, in every consumer: `read_column` resolves codes through the STAMPED level set,
    so a store whose `attributes.txr.levels` is missing or reordered is "a different type
    carrying different values" rather than a missing nicety.

    The declaration on the manifest row is checked with it, because `conformance.py`
    recomputes `levels_digest` and the `vocab_*` pair off the stamp and compares them to the
    row — and refuses EXACTLY ONE of `vocab_digest`/`vocab_sketch` being present.
    """
    outputs, structures, _ = written
    root = outputs / "metadata" / "doublet_call.zarr"

    labels = txr_zarr_read.read_column(root)
    assert labels == [_CALL_LEVELS[i % 3] for i in range(_N_CATEGORICAL)]

    node = txr_zarr_read.read_meta(root, "values")
    assert node["data_type"] == "uint8"
    stamp = node["attributes"]["txr"]
    assert stamp["kind"] == "categorical"
    assert stamp["levels"] == _CALL_LEVELS
    assert stamp["ordered"] is False

    row = structures["categorical"]["columns"][0]
    for key in ("levels_digest", "n_levels", "ordered", "vocab_digest", "vocab_sketch"):
        assert key in row, (key, sorted(row))
    assert row["n_levels"] == 3
    assert row["ordered"] is False
    # The row's declarations must be the ones the gate will recompute off the stamp.
    assert row["levels_digest"] == txr_zarr.key_sequence_digest(_CALL_LEVELS)
    want = txr_zarr.vocab_declaration(_CALL_LEVELS)
    assert row["vocab_digest"] == want["vocab_digest"]
    assert row["vocab_sketch"] == want["vocab_sketch"]
    # …and the group stamp equals the row's structure, which is what
    # `_conform_group_attributes` compares with `==`.
    assert txr_zarr_read.structure(root) == structures["categorical"]


def test_the_conformance_gate_accepts_what_r_wrote(written):
    """TEST-6 — DELETE THIS and the only thing standing between a malformed R-written store and a
    `failed` artifact is a reader written by the same hand that wrote the bytes.

    This is the OUT-OF-PROCESS gate: it re-derives the chunk grid from the declaration,
    refuses `codecs[0].name != "sharding_indexed"` by name, decodes every shard, and
    recompares every stamped key against the manifest row. `full=True` is the strict pass
    the verification job runs.

    The `examined` half is not decoration. `violations == []` and "the gate read nothing"
    are the same value, and a green verdict over zero bytes is a shape this repository has
    measured and shipped before — so each artifact's tally must show real bytes read and at
    least one shard walked.
    """
    outputs, _structures, _values = written
    manifest = json.loads((outputs / "manifest.json").read_text())
    assert [e["id"] for e in manifest["outputs"]] == [
        "metadata-column:doublet_score", "metadata-column:doublet_call"]

    report = conformance.conform_manifest(outputs, manifest, full=True)
    assert list(report) == [], [v for _labels, v in report]

    assert set(report.examined) == {"metadata-column:doublet_score",
                                    "metadata-column:doublet_call"}
    for label, tally in report.examined.items():
        assert tally["shards"] >= 1, (label, tally)
        assert tally["read_bytes"] > 0, (label, tally)
        assert tally["chunks"] >= 1, (label, tally)
        assert tally["decoded_bytes"] > 0, (label, tally)
    # The numeric column is 9,000 float64s; decoding it must yield the padded chunk bytes,
    # never fewer than the declared values. A gate that decoded one chunk of three would
    # satisfy the `> 0` above.
    assert (report.examined["metadata-column:doublet_score"]["decoded_bytes"]
            == 3 * txr_zarr.INNER_CHUNK * 8)


# ── the direction that proves the READ path ─────────────────────────────────────────
def test_r_reads_a_python_written_csc_store_exactly(tmp_path):
    """TEST-7 — DELETE THIS and the analysis can silently read the WRONG MATRIX.

    This is the only direction that exercises three things the write path never touches:
    `numcodecs.shuffle`'s inverse (the python writer shuffles every element wider than one
    byte; `_wire.R` declares no shuffle on write and so would never notice a broken
    `unshuffle`), the SIGNED→unsigned correction on the `uint32` `indices` member, and the
    two-halves recombination of the `int64` `indptr`. A broken un-shuffle does not crash —
    it yields plausible counts in the wrong places, which scores every cell against a
    fiction and reports a clean run.

    Sized so `indices`/`data` span four inner chunks (nnz > 3 * 4096), because a
    single-chunk store leaves the per-chunk offset arithmetic untested. Honest limit: every
    `indptr` value here fits in 32 bits, so what is proven is the recombination and the
    signedness, not arithmetic above 2^32.
    """
    rng = np.random.default_rng(11)
    dense = rng.integers(0, 3, size=(200, 100)).astype(np.float32)
    dense[:, 0] = rng.integers(1, 9, size=200)      # no empty column
    store = tmp_path / "matrix"
    structure = write_csc_store(store, dense)
    want_indptr, want_indices, want_data = txr_csc.read_csc(store)
    assert int(want_indptr[-1]) > 3 * txr_csc.VALUE_INNER_CHUNK, (
        "the fixture stopped spanning several inner chunks; the offset arithmetic this "
        f"test exists for is no longer exercised (nnz={int(want_indptr[-1])})")
    # …and the store really is shuffled, or the un-shuffle path is not on trial.
    node = txr_zarr_read.read_meta(store, "indices")
    assert any(c["name"] == "numcodecs.shuffle"
               for c in node["codecs"][0]["configuration"]["codecs"])

    got, _ = _r_driver(tmp_path, """
root <- file.path(WORK, "matrix")
st <- read_store_structure(root)
m <- read_csc_matrix(root)
emit(list(
  declared_kind = st$kind,
  declared_axes = I(as.character(unlist(st$axes))),
  dim = I(as.integer(dim(m))),
  nnz = length(m@x),
  indptr = I(as.numeric(m@p)),
  indices = I(as.numeric(m@i)),
  data = I(as.numeric(m@x)),
  col_sums = I(as.numeric(Matrix::colSums(m))),
  row_sums = I(as.numeric(Matrix::rowSums(m)))))
""")

    assert got["declared_kind"] == "sparse_csc"
    assert got["declared_axes"] == ["cells", "genes"]
    assert got["dim"] == list(structure["shape"]) == [200, 100]
    assert got["nnz"] == structure["nnz"] == int(want_indptr[-1])

    # EXACTLY, element by element, against the python reference reader's own decode.
    assert np.array_equal(np.asarray(got["indptr"], dtype=np.int64), want_indptr)
    assert np.array_equal(np.asarray(got["indices"], dtype=np.int64), want_indices)
    assert np.array_equal(np.asarray(got["data"], dtype=np.float64),
                          want_data.astype(np.float64))
    # …and the ORIENTATION: the store is CSC over genes, and `read_csc_matrix` promises
    # CELLS x GENES. Integer counts, so the sums are exact and a transposed read cannot
    # coincide (200 != 100 rows anyway, but the per-column sums pin the assignment).
    assert np.array_equal(np.asarray(got["col_sums"]), dense.sum(axis=0))
    assert np.array_equal(np.asarray(got["row_sums"]), dense.sum(axis=1))


# ── THE STATED BOUNDARY ─────────────────────────────────────────────────────────────
#
# `_wire.R`'s header claims exactly three shapes and NO string columns, embeddings, 2-D
# members, auxiliary members, memberships or key artifacts. A claim of that form is only
# worth writing down if it is enforced: the failure it prevents is a later analysis
# reaching for a fourth shape, finding a helper that half-works, and discovering the gap in
# a sandbox. The tests below drive the refusals rather than reading the header.

def test_more_than_255_levels_is_a_named_refusal_not_a_silent_widening(tmp_path):
    """TEST-8 — DELETE THIS and `write_categorical_column` may grow an observed-width or a silently
    widened `uint16` path that nothing exercises — and the store it writes would declare
    `uint8` codes over a level set no uint8 can address, so every consumer would resolve
    the wrong labels for codes above 255.

    The refusal must NAME the width, because the whole point of a named refusal is that the
    reader learns which limit they hit. It must also leave NOTHING on disk: a helper that
    wrote the array and then complained would leave a half-store the manifest never
    mentions.
    """
    got, proc = _r_driver(tmp_path, """
levels_256 <- sprintf("lv%03d", seq_len(256L) - 1L)
levels_0 <- character(0)
attempt <- function(rel, codes, lv) {
  tryCatch({
    write_categorical_column(file.path(WORK, "out"), rel, "x", codes, lv, axis = "cells")
    "NO ERROR — the refusal did not happen"
  }, error = function(e) conditionMessage(e))
}
emit(list(
  too_many = attempt("too_many.zarr", c(0L, 1L, 255L), levels_256),
  none = attempt("none.zarr", integer(0), levels_0),
  # A code outside the DECLARED set is the other half of the same rule: a level is never
  # silently added to satisfy a code.
  code_out_of_range = attempt("oob.zarr", c(0L, 1L, 2L), c("singlet", "doublet")),
  # …and a legal 255-level column is still accepted, so the boundary is a boundary and not
  # a blanket refusal.
  at_the_limit = attempt("ok.zarr", c(0L, 254L), sprintf("lv%03d", seq_len(255L) - 1L)),
  wrote = I(sort(list.dirs(file.path(WORK, "out"), full.names = FALSE, recursive = FALSE)))))
""")

    assert "NO ERROR" not in got["too_many"], got["too_many"]
    assert "uint8" in got["too_many"], (
        "the >255-level refusal does not name the uint8 code width it is enforcing:\n"
        + got["too_many"])
    assert "255" in got["too_many"] and "256" in got["too_many"], got["too_many"]
    assert "NO ERROR" not in got["none"], got["none"]
    assert "NO ERROR" not in got["code_out_of_range"], got["code_out_of_range"]
    assert "not a silently-added level" in got["code_out_of_range"], got["code_out_of_range"]
    assert got["at_the_limit"] == "NO ERROR — the refusal did not happen", got["at_the_limit"]

    # NOTHING was written for any refused call; only the legal one produced a store.
    assert got["wrote"] == ["ok.zarr"], got["wrote"]
    assert not (tmp_path / "out" / "too_many.zarr").exists()


def test_the_helper_does_not_implement_the_shapes_its_header_disclaims(tmp_path):
    """TEST-9 — DELETE THIS and `_wire.R` can quietly acquire a half-shape — a string writer that
    emits no `offsets` member, a "2-D" member that flattens — while its header still says
    it implements three. The header would then be a lie that reads like documentation.

    This is deliberately NOT a grep. The file is SOURCED into a fresh environment and the
    resulting binding table is the evidence: what exists is what will be callable from a
    sandbox. Two behavioural probes go with it, because absence of a name is not by itself
    absence of a capability:

      * a 2-D member cannot be expressed — handed a matrix, `write_member_array` writes a
        1-D array of `length(values)` and declares a 1-D `shape`, so a caller that expected
        a 2-D embedding would get a flattened one rather than an error. That is a real
        limit, and pinning it is what forces a deliberate 2-D path rather than a discovery;
      * `read_member_array` refuses an unknown reinterpretation by name (`match.arg`), so
        there is no "string" or "arrow" arm hiding behind a default.
    """
    got, _ = _r_driver(tmp_path, """
e <- new.env()
sys.source(WIRE, envir = e)
objs <- sort(ls(e, all.names = FALSE))

# A 2-D probe: hand `write_member_array` a matrix and read back what it DECLARED.
m <- matrix(as.double(1:12), nrow = 3L)
root2d <- file.path(WORK, "twod")
frag <- e$write_member_array(root2d, "values", m, dtype = "float64", itemsize = 8L,
  encode = function(b) writeBin(as.double(b), raw(), size = 8L, endian = "little"),
  fill_value = 0, dimension_names = "cells",
  attributes = list(kind = "numeric", name = "values"))
node <- jsonlite::fromJSON(file.path(root2d, "values", "zarr.json"), simplifyVector = FALSE)

# `read_member_array`'s `as=` is a closed set; anything else is an error from `match.arg`.
bad_as <- tryCatch({
  e$read_member_array(root2d, "values", as = "string"); "NO ERROR"
}, error = function(err) conditionMessage(err))

emit(list(objects = I(objs),
          twod_shape = I(as.integer(unlist(node$shape))),
          twod_declared_len = frag$shape,
          bad_as = bad_as))
""")

    objects = set(got["objects"])
    # The THREE shapes, and their supporting machinery — the complete callable surface.
    assert objects == {
        "CRC32C_POLY", "DT_METADATA_COLUMN", "DT_REPORT_QC", "GZIP_LEVEL", "INNER_CHUNK",
        "MAX_VOCAB_SKETCH_BYTES", "SHARD_CAP_CHUNKS", "SHARD_INDEX_EMPTY",
        "VOCAB_SKETCH_HASH_BYTES", "ZARR_FORMAT",
        "as_i32", "crc32c", "gzip_bytes", "key_sequence_digest", "normalise_levels",
        # `read_u32_le` was added when a blind audit showed the previous
        # `u32(readBin(..., size = 4))` decoded exactly 0x80000000 as `NA` — R reserves
        # INT_MIN as NA, so that one value in the u32 range silently vanished while every
        # other value was right. This EXACT set is the point of the assertion: a new name
        # is a deliberate edit here, which is how the boundary claim in the header stays a
        # claim about the shipped file rather than about an older one.
        "read_u32_le",
        "opaque_structure", "output_entry", "read_csc_matrix", "read_inputs_index",
        "read_json_file", "read_member_array", "read_params", "read_store_structure",
        "shard_chunks", "u32", "u32_raw", "u32_xor", "u64_raw", "unshuffle",
        "vocab_declaration", "write_categorical_column", "write_group_node",
        "write_json_file", "write_member_array", "write_numeric_column",
        "write_outputs_manifest",
    }, sorted(objects)
    # The disclaimed shapes have no entry point AT ALL — not a stub, not a half-writer.
    for missing in ("write_string_column", "write_embedding", "write_aux",
                    "write_membership", "write_key_artifact", "arrow_encode",
                    "encode_member_set", "write_table", "read_strings"):
        assert missing not in objects, (
            f"`{missing}` now exists in `_wire.R`; its header still claims the helper "
            "implements three shapes and no string columns, embeddings, 2-D members, "
            "memberships or key artifacts")

    # The 2-D limit, measured: 12 elements, a 1-D `shape`, no `[3, 4]` anywhere.
    assert got["twod_shape"] == [12]
    assert got["twod_declared_len"] == [12]
    # …and there is no hidden string/arrow read arm.
    assert got["bad_as"] != "NO ERROR"
    assert "arg" in got["bad_as"].lower(), got["bad_as"]
