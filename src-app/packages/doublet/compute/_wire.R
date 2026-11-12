#!/usr/bin/env Rscript
# _wire.R — the R side of this app's artifact wire format (#195 / E7, epic #169).
#
# ── WHY THIS FILE EXISTS, AND WHAT IT IS NOT ────────────────────────────────────────
# `doublet.scdblfinder` runs under `runtime: rscript`. An R entry receives its own
# package's declared `run.helpers` and NOTHING ELSE — `stages_app_helpers(Rscript)` is
# `false` in `sandbox/processors/mod.rs`, and the app's cross-cutting helper table
# (`PY_HELPER_FILES`: `txr_zarr.py`, `txr_csc.py`, `txr_columns.py`, …) is a table of
# PYTHON modules. So this analysis reads its input artifact and writes its output
# artifacts itself. That is E7/DEC-3, decided at epic-plan time:
#
#     "The R entry is SELF-CONTAINED and reads the artifact directly … it reads the CSC
#      artifact and `params.json` itself, and writes `/outputs` + `manifest.json`
#      itself — which the out-of-process conformance gate then validates unchanged."
#
# THIS IS NOT A PORT OF `_lib`. It is a package helper covering exactly the THREE shapes
# this one analysis moves:
#
#     read   a `single-cell/expression` CSC store   (int64 indptr, uint32 indices, float32 data)
#     write  a 1-D float64 `metadata-column`
#     write  a 1-D categorical `metadata-column`    (uint8 codes + a declared level set)
#
# It implements no string columns, no embeddings, no 2-D members, no auxiliary members,
# no memberships and no key artifacts, and it says so rather than looking general:
# `tests/test_scdblfinder_wire.py` pins that boundary, so a later analysis that needs a
# fourth shape has to add it deliberately instead of discovering the gap in a sandbox.
#
# ── THE FORMAT IS A CROSS-LANGUAGE CONTRACT, NOT A CHOICE ───────────────────────────
# `_lib/txr_zarr.py`'s own header says it: "`attributes.txr.{kind, levels, n, layout}`
# and the `offsets`/`values` member names are read verbatim by the browser's
# zero-dependency reader … renaming one here breaks a consumer in another language that
# this module has no compile-time link to." This file is now that other language. Every
# constant below is READ OFF that module, and the round-trip is proven by decoding what
# R wrote with the PYTHON reader (`_lib/txr_zarr_read.read_column`) rather than by
# reading the spec twice.
#
# THREE CONSUMERS have to agree with what this writes, and only one of them is lenient:
#   * the Rust server never parses a zarr byte — it checks that `structure` names a
#     non-empty `encoding` and that `layout` equals the datatype's declared string;
#   * the browser reader accepts BOTH a sharded and a plain array;
#   * `_lib/conformance.py`, which runs OUT OF PROCESS after ingest as its own python
#     job over the emitted bytes, accepts ONLY the sharded form. It requires
#     `inner_chunk`/`chunks_per_shard`/`shards` on every member row, then refuses
#     `codecs[0].name != "sharding_indexed"` by name, then decodes every shard. There
#     is no off switch and a violation flips the artifact to `failed`.
# So sharding is MANDATORY here, and it is mandatory because of the gate — not because
# a column of 2,806 values needs it.
#
# ── WHAT IS DELIBERATELY *NOT* MIRRORED: the byte-shuffle ───────────────────────────
# The python writer puts `numcodecs.shuffle` in front of gzip for any element wider than
# one byte. This file does NOT, and that is legal rather than lazy: every consumer keys
# off the DECLARED codec chain, never off the bytes (`conformance.py` reads
# `shuffled = any(c["name"] == "numcodecs.shuffle" …)`; the browser's `splitCodecChain`
# does the same), so `[bytes(little), gzip]` is a complete and honest declaration. It is
# omitted because a byte transpose in R is a materialized `t(matrix(...))` over the whole
# payload for a compression gain this analysis does not need. The READ path DOES
# implement the inverse, because the python writer that produced our input used it.
#
# ── R's `memCompress(type="gzip")` IS NOT GZIP, AND THAT IS THE TRAP ────────────────
# Measured inside this image: `memCompress(raw, type = "gzip")` emits a **zlib**
# (RFC-1950) stream — first bytes `78 9c` — not the RFC-1952 gzip container
# `gzip.decompress` and `DecompressionStream('gzip')` require (`1f 8b`). Handing that to
# the gate condemns every chunk as `'member "values" does not decode: BadGzipFile'`,
# from inside a sandbox, naming nothing useful. `gzip_bytes()` below rewraps: strip
# zlib's 2-byte header and 4-byte adler32, prepend the fixed 10-byte gzip header, append
# `crc32(raw)` and `len(raw)` as little-endian u32. The header is the SAME fixed one
# `txr_zarr.gzip_bytes` hand-builds (MTIME 0, XFL 0, OS 255) and for the same reason:
# a header byte that moves changes every artifact's `content_hash` for identical data.
#
# ── R's 32-BIT SIGNED INTEGER IS THE OTHER TRAP ─────────────────────────────────────
# R has no unsigned type and no 64-bit integer. Three places bite:
#   * `crc32c`'s polynomial `0x82F63B78` overflows `.Machine$integer.max`, and the naive
#     `bitwXor(bitwShiftR(c, 1), 0x82F63B78L)` port silently yields `NA`. Everything
#     below therefore carries u32 values as DOUBLES and XORs them 16 bits at a time,
#     which is exact for every value in range.
#   * a `uint32` member (`indices`) read with `readBin(..., size = 4)` comes back SIGNED;
#     `u32()` corrects it.
#   * an `int64` member (`indptr`) and the shard index's u64 offsets cannot be read at
#     all by `readBin` at size 8 as integers, so they are read as two u32 halves and
#     recombined as a double — exact below 2^53, which every offset and every `indptr`
#     entry this app can produce is, by several orders of magnitude.
#
# Nothing here defaults anything (INV-2 of `txr_columns`): a caller names its `axis`,
# its levels and its dtype, or it gets an error.

# ── u32 arithmetic, carried in doubles ──────────────────────────────────────────────

#' Bitwise XOR of two u32 values held as doubles. R's `bitwXor` takes signed 32-bit
#' integers, so anything at or above 2^31 has to be split; 16 bits at a time is always
#' in range and needs no sign reasoning.
u32_xor <- function(a, b) {
  bitwXor(a %/% 65536, b %/% 65536) * 65536 + bitwXor(a %% 65536, b %% 65536)
}

#' A little-endian u32 vector, read as two UNSIGNED 2-byte halves.
#'
#' NOT `u32(readBin(..., size = 4))`. `readBin` at size 4 returns R's `NA_integer_` for the
#' bit pattern `0x80000000`, because R reserves `INT_MIN` as NA — so that value decoded to
#' `NA` and `u32()` never saw a number to correct. Measured: `[0, 1, 2^31, 2^32, 2^33]`
#' came back `0 1 NA 4294967296 8589934592` — every value EXCEPT 2^31 was right, which is
#' the worst shape a bug can have. A 2-byte read cannot reach the sign bit, so this is
#' exact for every u32, and the recombined int64 is exact below 2^53 as the header claims.
read_u32_le <- function(bytes) {
  # LENGTH FIRST. `integer(0)[c(TRUE, FALSE)]` is `NA`, not `integer(0)` — R recycles the
  # logical index past the end of the vector — so an empty buffer returned a length-1 `NA`
  # and a 6-byte buffer silently returned 2 values. Both are unreachable from today's call
  # sites (every one is a non-empty exact multiple of 4), and that is exactly the argument
  # this file already declined to accept for the `n = 0` shard bug: `_wire.R` is a package
  # helper and a latent trap for its next caller is still a trap.
  n <- length(bytes)
  if (n == 0L) return(numeric(0))
  if (n %% 4L != 0L) {
    stop(sprintf("_wire.R: read_u32_le needs a whole number of 4-byte words (got %d bytes).",
                 n), call. = FALSE)
  }
  halves <- readBin(bytes, "integer", n = n %/% 2L, size = 2L,
                    endian = "little", signed = FALSE)
  halves[c(TRUE, FALSE)] + halves[c(FALSE, TRUE)] * 65536
}

#' A signed 32-bit integer as read by `readBin`, reinterpreted as unsigned.
u32 <- function(x) ifelse(x < 0, x + 4294967296, x)

#' A u32 held as a double, as the signed 32-bit integer `writeBin` will emit unchanged.
as_i32 <- function(x) as.integer(ifelse(x >= 2147483648, x - 4294967296, x))

# ── crc32c (Castagnoli), the shard index's trailer codec ────────────────────────────
#
# Ported from `_lib/txr_zarr.py::crc32c` and its table, and CHECKED against it: the
# same 1,000 random bytes, `crc32c("abc") == 0x364b3fb7` and `crc32c("") == 0`.
# `digest` gives sha256 and crc32 but not crc32c — crc32c is the Castagnoli polynomial,
# a different function, and using crc32 here would produce a shard the reader rejects.
CRC32C_POLY <- 2197175160  # 0x82F63B78, reflected

.crc32c_table <- local({
  tbl <- numeric(256)
  for (i in 0:255) {
    v <- i
    for (k in 1:8) v <- if (v %% 2 == 1) u32_xor(v %/% 2, CRC32C_POLY) else v %/% 2
    tbl[i + 1L] <- v
  }
  tbl
})

crc32c <- function(buf) {
  crc <- 4294967295
  for (b in as.integer(buf)) {
    crc <- u32_xor(crc %/% 256, .crc32c_table[u32_xor(crc, b) %% 256 + 1L])
  }
  u32_xor(crc, 4294967295)
}

# ── codecs ──────────────────────────────────────────────────────────────────────────

GZIP_LEVEL <- 5L
INNER_CHUNK <- 4096L
SHARD_CAP_CHUNKS <- 4096L
ZARR_FORMAT <- 3L
#' The v3 sentinel for an index slot holding no chunk: (2^64-1, 2^64-1).
SHARD_INDEX_EMPTY <- 4294967295  # per 32-bit half

#' A DETERMINISTIC RFC-1952 gzip stream, byte-compatible with `txr_zarr.gzip_bytes`.
#' See the header note: R's own gzip type is zlib-framed and is rewrapped here.
gzip_bytes <- function(payload) {
  z <- memCompress(payload, type = "gzip")
  # zlib framing is a 2-byte header and a 4-byte adler32 trailer around raw DEFLATE.
  deflate <- z[3:(length(z) - 4L)]
  crc_hex <- digest::digest(payload, algo = "crc32", serialize = FALSE)
  crc <- strtoi(substring(crc_hex, c(1L, 3L, 5L, 7L), c(2L, 4L, 6L, 8L)), 16L)
  c(
    as.raw(c(0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff)),
    deflate,
    as.raw(rev(crc)),                      # crc32 of the UNCOMPRESSED bytes, little-endian
    u32_raw(length(payload))
  )
}

#' A u32 as 4 little-endian bytes.
u32_raw <- function(v) {
  as.raw(c(v %% 256, (v %/% 256) %% 256, (v %/% 65536) %% 256, (v %/% 16777216) %% 256))
}

#' The inverse of `numcodecs.shuffle` — a byte transpose. Only the READ path needs it;
#' see the header for why the write path declares no shuffle.
unshuffle <- function(v, itemsize) {
  if (itemsize == 1L) return(v)
  count <- length(v) %/% itemsize
  as.raw(t(matrix(as.integer(v), nrow = count, ncol = itemsize)))
}

#' Inner chunks per shard for `n` elements — `txr_zarr.shard_chunks`, verbatim.
shard_chunks <- function(n, inner_chunk = INNER_CHUNK, cap = SHARD_CAP_CHUNKS) {
  max(1L, min(as.integer(ceiling(n / inner_chunk)), as.integer(cap)))
}

# ── JSON ────────────────────────────────────────────────────────────────────────────

#' Write one metadata document. `auto_unbox` because R has no scalar type and the schema
#' does; `digits = NA` so a double is written at full precision rather than rounded to
#' the print default, which would silently corrupt a stored value.
write_json_file <- function(path, obj) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  # `na = "null"` because the default writes the STRING "NA" for a missing double, and a
  # consumer reading `threshold` as a number then gets `"NA"`. Measured in a real emitted
  # report before this was set. `digits = NA` asks for R's full 15-significant-digit
  # representation — not bit-exact round-tripping, which R's JSON writer does not offer.
  writeLines(jsonlite::toJSON(obj, auto_unbox = TRUE, digits = NA, pretty = TRUE,
                              na = "null", null = "null"), path)
}

read_json_file <- function(path) {
  jsonlite::fromJSON(path, simplifyVector = FALSE)
}

# ── digests the conformance gate RECOMPUTES ─────────────────────────────────────────
#
# `key_sequence_digest` and `vocab_declaration` are recomputed by `conformance.py` off
# the levels stamped into the member node, and compared to what we put in the manifest
# row. A disagreement marks the artifact failed, so these two are ported EXACTLY rather
# than approximately, and a test compares them to the python functions' own output.

#' `txr_zarr.key_sequence_digest` for string keys: for each value, its utf-8 byte
#' length as a little-endian u64, then the bytes; then `0xff` and the count as u64.
key_sequence_digest <- function(values) {
  parts <- list()
  for (v in values) {
    b <- charToRaw(enc2utf8(as.character(v)))
    parts[[length(parts) + 1L]] <- c(u64_raw(length(b)), b)
  }
  parts[[length(parts) + 1L]] <- c(as.raw(0xff), u64_raw(length(values)))
  digest::digest(do.call(c, parts), algo = "sha256", serialize = FALSE)
}

#' A u64 as 8 little-endian bytes (exact below 2^53, which every length here is).
u64_raw <- function(v) c(u32_raw(v %% 4294967296), u32_raw(v %/% 4294967296))

#' `txr_zarr.normalise_levels` — NFC-normalize, drop the declared missing level, and
#' lowercase a two-element set that is exactly {false, true} in some casing.
normalise_levels <- function(levels, missing_level = NULL) {
  out <- vapply(levels, function(x) {
    v <- as.character(x)
    Encoding(v) <- "UTF-8"
    intToUtf8(utf8ToInt(v), multiple = FALSE)  # R strings are already NFC for our inputs
  }, character(1), USE.NAMES = FALSE)
  if (!is.null(missing_level)) out <- out[out != as.character(missing_level)]
  if (length(out) == 2L && setequal(tolower(out), c("false", "true"))) out <- tolower(out)
  out
}

#' `txr_zarr.vocab_declaration` — the order-INDEPENDENT vocabulary digest and its
#' sketch. Both, or NEITHER: `conformance.py` refuses exactly one of the pair.
VOCAB_SKETCH_HASH_BYTES <- 8L
MAX_VOCAB_SKETCH_BYTES <- 65536L

vocab_declaration <- function(levels, missing_level = NULL) {
  normalised <- normalise_levels(levels, missing_level)
  shorts <- vapply(normalised, function(u) {
    b <- charToRaw(enc2utf8(u))
    full <- digest::digest(c(u64_raw(length(b)), b), algo = "sha256",
                           serialize = FALSE, raw = TRUE)
    paste(sprintf("%02x", as.integer(full[seq_len(VOCAB_SKETCH_HASH_BYTES)])), collapse = "")
  }, character(1), USE.NAMES = FALSE)
  shorts <- sort(shorts)
  blob <- if (length(shorts)) {
    as.raw(strtoi(unlist(lapply(shorts, function(h)
      substring(h, seq(1, nchar(h), 2), seq(2, nchar(h), 2)))), 16L))
  } else {
    raw(0)
  }
  sketch <- jsonlite::base64_enc(blob)
  if (nchar(sketch) > MAX_VOCAB_SKETCH_BYTES) return(list())
  list(
    vocab_digest = digest::digest(c(blob, as.raw(0xff), u64_raw(length(shorts))),
                                  algo = "sha256", serialize = FALSE),
    vocab_sketch = sketch
  )
}

# ── the array writer ────────────────────────────────────────────────────────────────

#' Write ONE 1-D member array as a Zarr v3 sharded store, and return its `structure`
#' fragment. Mirrors `txr_zarr.ArrayWriter`: a chunk is ALWAYS `inner_chunk` elements
#' (a short tail is padded with `fill_value`, and `shape` is what bounds a reader), a
#' shard is `[chunks…][index][crc32c]` with `index_location: "end"`, and a partial
#' shard's unused index slots stay at the EMPTY sentinel.
#'
#' `encode` turns a numeric vector into the packed little-endian bytes of one chunk.
write_member_array <- function(root, name, values, dtype, itemsize, encode,
                               fill_value, dimension_names, attributes,
                               inner_chunk = INNER_CHUNK) {
  n <- length(values)
  cps <- shard_chunks(n, inner_chunk)
  shard_rows <- inner_chunk * cps
  adir <- file.path(root, name)
  dir.create(file.path(adir, "c"), recursive = TRUE, showWarnings = FALSE)

  n_shards <- max(1L, as.integer(ceiling(n / shard_rows)))
  stored <- 0
  written_shards <- 0L
  for (s in seq_len(n_shards) - 1L) {
    body <- raw(0)
    index <- rep(SHARD_INDEX_EMPTY, cps * 4L)  # (off_lo, off_hi, nb_lo, nb_hi) per slot
    any_chunk <- FALSE
    for (k in seq_len(cps) - 1L) {
      lo <- s * shard_rows + k * inner_chunk
      if (lo >= n) break
      hi <- min(lo + inner_chunk, n)
      block <- values[(lo + 1L):hi]
      if (length(block) < inner_chunk) {
        block <- c(block, rep(fill_value, inner_chunk - length(block)))
      }
      enc <- gzip_bytes(encode(block))
      off <- length(body)
      index[k * 4L + 1L] <- off %% 4294967296
      index[k * 4L + 2L] <- off %/% 4294967296
      index[k * 4L + 3L] <- length(enc) %% 4294967296
      index[k * 4L + 4L] <- length(enc) %/% 4294967296
      body <- c(body, enc)
      any_chunk <- TRUE
    }
    # A zero-length array writes NO shard and reports `shards: 0` — python's
    # `ArrayWriter.close()` flushes nothing when no chunk was placed, and the conformance
    # gate condemns the difference twice (a declared shard the grid does not hold, and a
    # `c/0` entry no cell of the chunk grid names). Reachable only from a future caller —
    # this entry refuses a matrix below 30 cells long before here — but `_wire.R` is a
    # package helper and a hard artifact-`failed` is not something to leave for them.
    if (!any_chunk) break
    idx_raw <- writeBin(as_i32(index), raw(), size = 4L, endian = "little")
    body <- c(body, idx_raw, u32_raw(crc32c(idx_raw)))
    con <- file(file.path(adir, "c", as.character(s)), "wb")
    writeBin(body, con)
    close(con)
    stored <- stored + length(body)
    written_shards <- written_shards + 1L
  }

  write_json_file(file.path(adir, "zarr.json"), list(
    zarr_format = ZARR_FORMAT,
    node_type = "array",
    shape = I(as.integer(n)),
    data_type = dtype,
    chunk_grid = list(name = "regular",
                      configuration = list(chunk_shape = I(as.integer(shard_rows)))),
    chunk_key_encoding = list(name = "default", configuration = list(separator = "/")),
    fill_value = fill_value,
    codecs = list(list(
      name = "sharding_indexed",
      configuration = list(
        chunk_shape = I(as.integer(inner_chunk)),
        # NO `numcodecs.shuffle` — see the header. Every consumer keys off this list.
        codecs = list(
          list(name = "bytes", configuration = list(endian = "little")),
          list(name = "gzip", configuration = list(level = GZIP_LEVEL))
        ),
        index_codecs = list(
          list(name = "bytes", configuration = list(endian = "little")),
          list(name = "crc32c")
        ),
        index_location = "end"
      )
    )),
    attributes = list(txr = attributes),
    dimension_names = I(as.character(dimension_names))
  ))

  list(path = name, kind = if (identical(attributes$kind, "categorical")) "categorical" else "numeric",
       dtype = dtype, shape = I(as.integer(n)),
       inner_chunk = as.integer(inner_chunk), chunks_per_shard = as.integer(cps),
       shards = as.integer(written_shards), stored_bytes = as.integer(stored))
}

#' The artifact ROOT group node. Its `attributes.txr` must equal the manifest entry's
#' `structure` — `conformance.py` compares them with `==` and reports
#' "the declaration stamped into the group's zarr.json differs from the returned
#' `structure`" otherwise. So both come from the SAME R list, never from two builders.
write_group_node <- function(root, structure) {
  write_json_file(file.path(root, "zarr.json"), list(
    zarr_format = ZARR_FORMAT, node_type = "group",
    attributes = list(txr = structure)
  ))
}

# ── the two column shapes this analysis writes ──────────────────────────────────────

#' A continuous float64 `metadata-column`. `NA`/`NaN` are written as IEEE NaN, which is
#' what a "this cell was not scored" position means and what the python lane writes.
write_numeric_column <- function(outputs_dir, rel_dir, name, values, axis,
                                 aligned_to = NULL) {
  root <- file.path(outputs_dir, rel_dir)
  v <- as.double(values)
  member <- write_member_array(
    root, "values", v, dtype = "float64", itemsize = 8L,
    encode = function(b) writeBin(as.double(b), raw(), size = 8L, endian = "little"),
    fill_value = 0, dimension_names = axis,
    attributes = list(kind = "numeric", name = "values")
  )
  member$name <- "values"
  member$axis <- axis
  structure_ <- list(encoding = "zarr_v3", kind = "table", axis = axis,
                     n = as.integer(length(v)), columns = list(member), arrays = list())
  if (!is.null(aligned_to)) structure_$aligned_to <- aligned_to
  write_group_node(root, structure_)
  meta <- list(name = name, dtype = "float64", n = as.integer(length(v)), axis = axis,
               kind = "continuous", stored_dtype = "float64",
               n_missing = as.integer(sum(is.na(v))))
  list(structure = structure_, meta = meta)
}

#' A categorical `metadata-column`: uint8 codes plus the DECLARED level set.
#'
#' The code WIDTH comes from the declaration, never from the observed codes — that is
#' `txr_zarr`'s DEC-6, and the reason is that observed-width selection silently
#' re-encodes when a level goes unused, changing the bytes and therefore the artifact's
#' `content_hash` for identical meaning. This analysis declares at most three levels, so
#' `uint8` is always correct; anything wider is a refusal rather than a silent widening,
#' because a `uint16` path nothing here exercises would be untested code in a sandbox.
#'
#' `codes` are 0-based, matching the level vector's order.
write_categorical_column <- function(outputs_dir, rel_dir, name, codes, levels, axis,
                                     ordered = FALSE, aligned_to = NULL) {
  if (length(levels) < 1L || length(levels) > 255L) {
    stop(sprintf(paste0("_wire.R: a categorical column needs between 1 and 255 declared ",
                        "levels (got %d). This helper implements the uint8 code width ",
                        "only; a wider column needs a uint16 path, which nothing in this ",
                        "package exercises and which is therefore not written here."),
                 length(levels)), call. = FALSE)
  }
  if (any(is.na(codes)) || any(codes < 0) || any(codes >= length(levels))) {
    stop("_wire.R: a categorical code is outside the declared level set. A value outside ",
         "the declaration is an error, not a silently-added level.", call. = FALSE)
  }
  root <- file.path(outputs_dir, rel_dir)
  lv <- as.character(levels)
  member <- write_member_array(
    root, "values", as.double(codes), dtype = "uint8", itemsize = 1L,
    encode = function(b) as.raw(as.integer(b)),
    fill_value = 0L, dimension_names = axis,
    attributes = list(kind = "categorical", name = "values",
                      levels = I(lv), ordered = ordered)
  )
  member$name <- "values"
  member$axis <- axis
  member$levels_digest <- key_sequence_digest(lv)
  member$n_levels <- length(lv)
  member$ordered <- ordered
  vocab <- vocab_declaration(lv)
  if (length(vocab)) {
    member$vocab_digest <- vocab$vocab_digest
    member$vocab_sketch <- vocab$vocab_sketch
  }
  structure_ <- list(encoding = "zarr_v3", kind = "table", axis = axis,
                     n = as.integer(length(codes)), columns = list(member),
                     arrays = list())
  if (!is.null(aligned_to)) structure_$aligned_to <- aligned_to
  write_group_node(root, structure_)
  meta <- list(name = name, dtype = "category", n = as.integer(length(codes)), axis = axis,
               kind = "categorical", n_levels = length(lv), ordered = ordered)
  list(structure = structure_, meta = meta)
}

#' The `structure` for an output whose bytes are NOT Zarr — this analysis' JSON report.
#' It still has to be DECLARED: "there is nothing to decode, the media type is the whole
#' story" is a statement the producer makes, not an absence the server interprets.
opaque_structure <- function(media_type) {
  list(encoding = "opaque", media_type = media_type)
}

# ── the outputs manifest ────────────────────────────────────────────────────────────

DT_METADATA_COLUMN <- c("metadata-column", "chunked-1d")
DT_REPORT_QC <- c("report/qc", "opaque")

#' One `OutputEntry`. Every field `sandbox::outputs::OutputEntry` requires is named
#' explicitly: `role`, `structure` and `meta` carry NO serde default, so an omitted one
#' fails at ingest rather than being assumed.
output_entry <- function(id, datatype_layout, path, role, structure, meta) {
  list(id = id, datatype = datatype_layout[1], path = path, layout = datatype_layout[2],
       role = role, structure = structure, meta = meta)
}

#' The canonical `OutputsManifest`. Written LAST and only after every artifact exists, so
#' a crash mid-run leaves NO manifest rather than a manifest naming bytes that are not
#' there — the host reads a missing manifest on exit 0 as a typed contract violation.
write_outputs_manifest <- function(outputs_dir, entries) {
  write_json_file(file.path(outputs_dir, "manifest.json"), list(outputs = entries))
}

# ── the input side ──────────────────────────────────────────────────────────────────

#' `/inputs/inputs.json` as a slot -> sandbox path map.
#'
#' Resolved BY SLOT, never by filename: the mount name is derived from the slot and a
#' suffix, and a compute that resolved by filename would pass its own test fixtures and
#' fail on a real run. (The python lane's `_shared.load_inputs_index` does the same.)
read_inputs_index <- function(inputs_dir) {
  path <- file.path(inputs_dir, "inputs.json")
  if (!file.exists(path)) return(list())
  doc <- read_json_file(path)
  out <- list()
  for (e in doc$inputs) {
    sandbox_path <- e$sandbox_path
    # The host writes an ABSOLUTE `/inputs/<mount>`; off-sandbox harnesses point
    # TXR_INPUTS_DIR elsewhere, so the mount NAME is what is portable.
    out[[e$slot]] <- file.path(inputs_dir, basename(sandbox_path))
  }
  out
}

#' `/inputs/params.json`. The host merges `seed` in LAST and never null, so on a real run
#' the file always exists and always carries one.
read_params <- function(inputs_dir) {
  path <- file.path(inputs_dir, "params.json")
  if (!file.exists(path)) return(list())
  read_json_file(path)
}

#' One member array of a Zarr v3 store, decoded. Dispatches on the DECLARED codec chain,
#' never on the file layout — guessing from the bytes is what this reader exists not to
#' do. `as` selects how the packed little-endian bytes are reinterpreted.
#' `as` is a DEFAULT, not an override: the member's own `data_type` wins whenever it names
#' a width this reader knows. That order matters and it is the fix for a real defect —
#' `txr_zarr.code_dtype` writes `uint16` codes as soon as a categorical declares more than
#' 256 levels, and a caller that asked for `uint8` used to get every code TRUNCATED TO ITS
#' LOW BYTE with the right shape and no error. Two demonstrated consequences, both silent:
#' two sample levels 256 apart merged into ONE population (so artificial doublets crossed a
#' capture boundary, which is exactly what the per-sample rule exists to prevent), and a
#' `key_sequence_digest` computed over the wrong labels, i.e. an `aligned_to` naming a row
#' space the values do not belong to. The conformance gate cannot catch either: the shapes
#' are right and it has no access to the key artifact.
#'
#' A declared width this reader does NOT implement is a refusal, never a silent guess.
read_member_array <- function(root, name, as = c("double", "int32", "uint32", "int64",
                                                 "float32", "uint8", "uint16")) {
  as <- match.arg(as)
  meta <- read_json_file(file.path(root, name, "zarr.json"))
  declared <- meta$data_type
  known <- c(float64 = "double", float32 = "float32", int64 = "int64", int32 = "int32",
             uint32 = "uint32", uint8 = "uint8", uint16 = "uint16")
  if (!is.null(declared)) {
    if (!(declared %in% names(known))) {
      stop(sprintf(paste0("_wire.R: member `%s` declares data_type `%s`, which this reader ",
                          "does not implement. Refusing rather than reinterpreting its bytes ",
                          "as %s."), name, declared, as), call. = FALSE)
    }
    as <- unname(known[[declared]])
  }
  shape <- as.numeric(unlist(meta$shape))
  n <- shape[1]
  itemsize <- switch(as, double = 8L, int64 = 8L, int32 = 4L, uint32 = 4L,
                     float32 = 4L, uint16 = 2L, uint8 = 1L)
  sharded <- identical(meta$codecs[[1]]$name, "sharding_indexed")
  reinterpret <- function(bytes) {
    switch(as,
      double = readBin(bytes, "double", n = length(bytes) %/% 8L, size = 8L, endian = "little"),
      float32 = readBin(bytes, "double", n = length(bytes) %/% 4L, size = 4L, endian = "little"),
      int32 = readBin(bytes, "integer", n = length(bytes) %/% 4L, size = 4L, endian = "little"),
      uint32 = read_u32_le(bytes),
      # No `readBin` width reads a 64-bit integer, so both halves are read as u32 and
      # recombined as a double — exact below 2^53.
      int64 = {
        # Guarded for the same reason `read_u32_le` is, 45 lines up: `halves[c(FALSE, TRUE)]`
        # recycles to `NA` when `halves` has one element, so a 4-byte buffer would silently
        # yield `NA` rather than an error. Unreachable today (every int64 caller passes a
        # multiple of 8) — and "unreachable today" is exactly the argument this file already
        # declined to accept for the `n = 0` shard bug.
        if (length(bytes) %% 8L != 0L) {
          stop(sprintf(paste0("_wire.R: an int64 member needs a whole number of 8-byte ",
                              "words (got %d bytes)."), length(bytes)), call. = FALSE)
        }
        halves <- read_u32_le(bytes)
        halves[c(TRUE, FALSE)] + halves[c(FALSE, TRUE)] * 4294967296
      },
      # R has no unsigned read at any width, but a 2-byte read is SIGNED over a range
      # that cannot reach the sign bit for a code set of at most 65535 levels — and the
      # correction is applied anyway rather than reasoned about.
      uint16 = {
        v <- readBin(bytes, "integer", n = length(bytes) %/% 2L, size = 2L,
                     endian = "little", signed = FALSE)
        as.numeric(v)
      },
      uint8 = as.numeric(bytes)
    )
  }
  out <- numeric(n)
  if (!sharded) {
    chunk_rows <- as.numeric(unlist(meta$chunk_grid$configuration$chunk_shape))[1]
    for (g in seq_len(ceiling(n / chunk_rows)) - 1L) {
      body <- readBin(file.path(root, name, "c", as.character(g)), "raw",
                      n = file.size(file.path(root, name, "c", as.character(g))))
      block <- reinterpret(body)
      lo <- g * chunk_rows
      hi <- min(lo + chunk_rows, n)
      out[(lo + 1):hi] <- block[seq_len(hi - lo)]
    }
    return(out)
  }
  cfg <- meta$codecs[[1]]$configuration
  inner_rows <- as.numeric(unlist(cfg$chunk_shape))[1]
  shard_rows <- as.numeric(unlist(meta$chunk_grid$configuration$chunk_shape))[1]
  per_shard <- shard_rows %/% inner_rows
  shuffled <- any(vapply(cfg$codecs, function(c) identical(c$name, "numcodecs.shuffle"),
                         logical(1)))
  for (s in seq_len(ceiling(n / shard_rows)) - 1L) {
    f <- file.path(root, name, "c", as.character(s))
    body <- readBin(f, "raw", n = file.size(f))
    idx_start <- length(body) - per_shard * 16 - 4
    idx <- read_u32_le(body[(idx_start + 1):(length(body) - 4)])
    for (k in seq_len(per_shard) - 1L) {
      off <- idx[k * 4L + 1L] + idx[k * 4L + 2L] * 4294967296
      nb <- idx[k * 4L + 3L] + idx[k * 4L + 4L] * 4294967296
      # (2^64-1, 2^64-1) marks a slot holding no chunk.
      if (idx[k * 4L + 1L] == SHARD_INDEX_EMPTY && idx[k * 4L + 2L] == SHARD_INDEX_EMPTY) next
      lo <- s * shard_rows + k * inner_rows
      if (lo >= n) next
      plain <- memDecompress(body[(off + 1):(off + nb)], type = "gzip")
      if (shuffled) plain <- unshuffle(plain, itemsize)
      block <- reinterpret(plain)
      hi <- min(lo + inner_rows, n)
      out[(lo + 1):hi] <- block[seq_len(hi - lo)]
    }
  }
  out
}

#' A `single-cell/expression` CSC store as a `Matrix::dgCMatrix`.
#'
#' The store is CSC over the GENES axis (`axes: ["cells", "genes"]`), so `indptr` cuts by
#' gene and `indices` holds CELL ids — which is exactly `dgCMatrix`'s `@p`/`@i` with
#' cells as rows. The matrix is returned CELLS x GENES, the orientation every consumer in
#' this package works in; `scDblFinder` wants GENES x CELLS and the entry transposes
#' once, explicitly, rather than this reader guessing an orientation.
read_csc_matrix <- function(root) {
  group <- read_json_file(file.path(root, "zarr.json"))
  st <- group$attributes$txr
  shape <- as.numeric(unlist(st$shape))
  indptr <- read_member_array(root, "indptr", as = "int64")
  indices <- read_member_array(root, "indices", as = "uint32")
  data <- read_member_array(root, "data", as = "float32")
  m <- new("dgCMatrix",
           i = as.integer(indices),
           p = as.integer(indptr),
           x = as.double(data),
           Dim = c(as.integer(shape[1]), as.integer(shape[2])))
  m
}

#' The declared `structure` of an input artifact, read from its own group node — the
#' shape/axes a caller must check BEFORE decoding megabytes.
read_store_structure <- function(root) {
  read_json_file(file.path(root, "zarr.json"))$attributes$txr
}
