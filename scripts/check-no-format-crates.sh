#!/usr/bin/env bash
#
# check-no-format-crates.sh — the mechanical proof of INV-1 (artifact-model ITEM-20).
#
# ── THE INVARIANT, AS AMENDED 2026-08-17 (DEC-23) ───────────────────────────────
# INV-1: "The server stores and serves. It does not interpret. It confines, caps,
# hashes, stores, records and serves bytes. It NEVER OPENS A BYTE FOR MEANING —
# with ONE named exception: the GATHER may decode the exact codec chain the writer
# emits (`sharding_indexed` + `gzip` + `numcodecs.shuffle`), in ONE module, to
# produce a virtual dataset's bytes."
#
# The exception was not a preference. A serve-time gather was measured to be
# impossible without decoding, on the producer's own bytes:
#   * the shard index addresses CHUNKS (one 16-byte entry per 4096 elements), and the
#     chunk payload is a DEFLATE stream with no positional index — so NO byte RANGE of
#     a stored file is a row;
#   * `numcodecs.shuffle` strides an element's bytes by the chunk's element count, so
#     even a fully inflated chunk needs a per-chunk transposition before a row is
#     contiguous (element 1 of a 4096-element int64 chunk: bytes 1, 4097, 8193, …);
#   * the one escape — re-serving a source chunk verbatim — is closed by the row axis's
#     own shape: it is a CONCATENATION of per-source segments, so an output chunk
#     spanning a boundary draws from two different source arrays.
# Rejected, with reasons, in `.lifecycle/virtual-dataset-alignment/DECISIONS.md` DEC-23:
# handing the vectors to the server as control-plane metadata (fixes the metadata half,
# leaves the mechanism dead); gathering in the browser (works for viewing, cannot work
# for processors — sandbox inputs are staged by HARDLINKING pooled blobs and a gathered
# artifact has none).
#
# So this guard did not get deleted, and it did not get widened to "the server may
# decode". It got NARROWED: the crate denylist below is unchanged, and a second check
# now scopes every decompressor in the server's own source to ONE file.
#
# Prose cannot hold that. A future agent asked to "just decode the first chunk
# server-side" adds one crate and the invariant is gone with every other gate green.
# So the invariant is asserted where it is impossible to satisfy accidentally: the
# server's RESOLVED DEPENDENCY GRAPH must contain no crate that can parse a
# scientific array/table format at all. You cannot decode what you cannot link.
#
# This is a DEFAULT-DENY list of crate FAMILIES, not of exact crate names — but the reach
# of a family root is EXACTLY `^<family>[0-9]*([-_].*)?$`, and stating that reach honestly
# is the difference between a guard and a claim about one:
#
#   CAUGHT BY THE ROOT, list unedited — a suffix that starts with a digit, `-` or `_`.
#     `arrow` denies `arrow-ipc`, `arrow-array`, `arrow-flight`, … AND the numbered rewrite
#     `arrow2`; `parquet` denies `parquet2`; `hdf5` denies `hdf5-sys`. Adding one of these
#     trips the guard with nobody touching `DENY_FAMILIES`.
#   NOT CAUGHT BY ANY ROOT — a BARE-LETTER suffix (`zarrs`, `npyz`, `h5ad`, `tiledbsoma`,
#     `htslib`) or a PREFIX (`libduckdb`, `cfitsio`). Those seven are caught ONLY because
#     each is listed BY NAME below, next to the root it reads like a variant of. Removing
#     any one of them from the list makes that crate linkable with every gate still green
#     — verified by removing each in turn and re-matching.
#
# Widening the anchor to swallow a bare letter is what buys that back, and the price is
# `orc` denying `orchestrator` — so the explicit entries are the deliberate cost of not
# over-matching, NOT an oversight to be tidied away into the root.
#
# ── WHAT IS *NOT* DENIED, AND WHY (the boundary is deliberate) ──────────────────
# INV-1 is about ARTIFACT bytes — the array/table payload a processor produced. It is
# NOT a ban on serialization in general, so these stay legal and are deliberately
# absent from the list:
#   * `serde_json` / `serde_yaml` / `toml` — the CONTROL PLANE. `structure` and `meta`
#     are producer-DECLARED JSONB the server reads as configuration, never as payload.
#   * `flate2` / `zstd` / `brotli` / `zip` — transport + archive compression. Moving
#     compressed bytes is not interpreting them.
#   * `sha2` / `blake3` / `crc32c` — hashing IS in INV-1's own list of things the server does.
#   * `png` / `image` — pixel assets served as opaque blobs.
#
# The compression line above is the one that needs stating carefully, because this branch's
# writer stamps a codec CHAIN into every array's `zarr.json`: `sharding_indexed` over the
# inner chain `[ bytes, numcodecs.shuffle, gzip ]` plus `index_codecs [ bytes, crc32c ]`
# (`cyto_zarr._array_meta` + `_codec_chain`; the shuffle is omitted for 1-byte dtypes,
# where it is the identity).
# `flate2` decodes that chain's gzip member and is nonetheless LEGAL — it is a general
# byte-stream codec that half the ecosystem pulls in transitively, and decompressing a
# transport frame is not reading an array. The line is drawn at PURPOSE, not at membership
# in the chain: a crate whose reason to exist is decoding SCIENTIFIC ARRAY codecs is denied,
# because linking it is the whole of "the server can now open an artifact chunk". That is why
# `blosc`, `zfp`, `bitshuffle` and — since 2026-07-30 — `numcodecs` are on the list while
# `flate2`/`zstd` are not. `numcodecs` is the Rust implementation of the numcodecs registry,
# i.e. of `numcodecs.shuffle` BY NAME: it is the single crate that most precisely turns this
# guard from a claim into a proof, and it was missing.
# If that boundary ever needs to move, move it HERE, in one reviewable diff — which is
# the point of writing it down rather than leaving it to each reader's judgement.
#
# ── TWO INDEPENDENT READS ───────────────────────────────────────────────────────
#   1. `cargo metadata --filter-platform <host>` — the authoritative resolved graph,
#      as the design specifies. Requires a working cargo; if cargo fails this guard
#      exits NON-ZERO (2), never 0. A guard that passes because its tool is missing is
#      not a guard.
#   2. the committed root `Cargo.lock` — every resolved package across the workspace,
#      including targets `--filter-platform` hides. Zero tooling required.
# Hits from both are reported. A crate has to be absent from BOTH to pass.
#
# ── SEAM ────────────────────────────────────────────────────────────────────────
# `CYTO_DEPGUARD_EXTRA_DENY="foo bar"` ADDS families to the list. It can only ever make
# the guard STRICTER — there is deliberately no way to remove one — and exists so a
# test can prove the matcher actually matches (a guard that reports PASS because its
# regex never fires is the failure mode this seam rules out).
#
# Exit 0 = clean. 1 = a format-parsing crate is linkable (printed). 2 = tooling broken.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

SERVER_MANIFEST='src-app/server/Cargo.toml'
LOCKFILE='Cargo.lock'

# ── the denied families ─────────────────────────────────────────────────────────
# Matched anchored as  ^<family>[0-9]*([-_].*)?$  so `orc` denies `orc` / `orc2` /
# `orc-rust` but not `orchestrator`, and `h5` does not sweep `h5unrelatedword`. It DOES
# sweep `h5-unrelated-word`: a `-`/`_` continuation is a legal family suffix by
# construction, and every published `h5-*` crate is an HDF5 binding, so that reach is
# wanted. (This line named `h5-unrelated-word` as something the anchor rejects until
# 2026-07-30; it never did. Re-measured against 20 names before this rewording.)
#
# The `[0-9]*` is load-bearing, not cosmetic. Rust format crates are routinely
# published as a NUMBERED REWRITE of an existing crate under the same name --
# `arrow2` and `parquet2` are the successors of `arrow` and `parquet`. Until
# 2026-07-30 the anchor was `([-_].*)?$`, so a digit was not a legal continuation
# and BOTH of them sailed through: the header above cited `parquet2` as an example
# of a crate the guard catches without anyone editing the list, and that was simply
# untrue (`zarrs`, its other example, is caught only because it is listed by name —
# the header now states which crates each mechanism actually reaches).
# A guard whose own documentation names a crate it does not catch is worse than one
# that admits the gap.
DENY_FAMILIES='
arrow parquet zarr zarrs hdf5 h5 netcdf cdf tiledb tiledbsoma soma
avro orc feather ipc-file npy npyz ndarray-npy matio fitsio cfitsio
lance polars datafusion duckdb libduckdb deltalake iceberg vortex
calamine xlsxwriter xlsx csv anndata h5ad mudata blosc zfp numcodecs bitshuffle
nifti dicom bam htslib noodles bcf hts
'
# `numcodecs` + `bitshuffle` joined the codec/compressor line on 2026-07-30. Both are new
# family ROOTS, not by-name exceptions — no existing root is a prefix of either — so the
# "those seven" count above is unchanged, and each reaches its own `-`/`_`/digit variants:
# `numcodecs` denies `numcodecs-zstd` / `numcodecs-blosc` / `numcodecs-zfp` / `numcodecs2`,
# `bitshuffle` denies `bitshuffle-sys`. `blosc`/`zfp` were already here; `bitshuffle` is the
# third member of that same array-filter family and was the same-shaped omission next to it.
#
# Surveyed at the same time and deliberately NOT added, so the next reader does not re-derive
# it: `n5` (the N5 array format — a Zarr sibling, real Rust crate) and `ome-zarr-metadata`
# (`ome`-prefixed, so no root reaches it — the `libduckdb`/`cfitsio` shape). Both are genuine
# format-reader families and both are absent from the graph today; they are FORMAT families
# rather than codec/compressor ones, so adding them is its own reviewable decision rather
# than a tidy-up folded into this one.
# Anything the caller adds (ADD-only; see the SEAM note above).
DENY_FAMILIES="$DENY_FAMILIES ${CYTO_DEPGUARD_EXTRA_DENY:-}"

# A resolved graph smaller than this is a BROKEN READ, not a clean one.
MIN_PACKAGES_METADATA=300   # measured 2026-07-28: 602 distinct crate names
MIN_PACKAGES_LOCK=400       # measured 2026-07-28: 838 [[package]] entries

TMP="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMP"' EXIT

# ── read 1 — cargo metadata (authoritative) ─────────────────────────────────────
if ! command -v cargo >/dev/null 2>&1; then
  echo "FAIL(2): cargo is not on PATH, so the resolved dependency graph cannot be read."
  echo "         This guard refuses to report PASS on an unread graph."
  exit 2
fi
if ! command -v rustc >/dev/null 2>&1; then
  echo "FAIL(2): rustc is not on PATH; cannot resolve the host target triple."
  exit 2
fi
HOST="$(rustc -vV | awk '/^host:/ {print $2}')"
if [ -z "$HOST" ]; then
  echo "FAIL(2): could not parse the host triple out of \`rustc -vV\`."
  exit 2
fi

if ! cargo metadata --format-version 1 --filter-platform "$HOST" \
      --manifest-path "$SERVER_MANIFEST" > "$TMP/metadata.json" 2> "$TMP/metadata.err"; then
  echo "FAIL(2): \`cargo metadata\` failed, so the resolved graph is unknown:"
  sed 's/^/         /' "$TMP/metadata.err" | head -20
  exit 2
fi

# Package ids look like `registry+https://…#arrow-ipc@59.0.0` or
# `path+file:///…#cytoanalyst@0.0.0`. Take the fragment, drop the version. Pure
# grep/sed on purpose: a gate that needs `jq` installed is a gate that silently
# does not run on the machine that lacks it.
tr ',' '\n' < "$TMP/metadata.json" |
  grep -oE '"id":"[^"]*"' |
  sed -E 's/.*#//; s/"$//; s/@[^@]*$//' |
  sort -u > "$TMP/from-metadata.txt"

# ── read 2 — the committed lockfile (independent, tool-free) ────────────────────
if [ ! -f "$LOCKFILE" ]; then
  echo "FAIL(2): $LOCKFILE is missing; the second, independent read is unavailable."
  exit 2
fi
grep -E '^name = "' "$LOCKFILE" | sed -E 's/^name = "//; s/"$//' | sort -u > "$TMP/from-lock.txt"

n_meta="$(grep -c . "$TMP/from-metadata.txt" || true)"
n_lock="$(grep -c . "$TMP/from-lock.txt" || true)"

if [ "$n_meta" -lt "$MIN_PACKAGES_METADATA" ]; then
  echo "FAIL: \`cargo metadata\` yielded $n_meta crate name(s), below the floor of $MIN_PACKAGES_METADATA."
  echo "      That is a broken read, not a small dependency graph — this guard was about to"
  echo "      report PASS having inspected almost nothing."
  exit 1
fi
if [ "$n_lock" -lt "$MIN_PACKAGES_LOCK" ]; then
  echo "FAIL: $LOCKFILE yielded $n_lock package(s), below the floor of $MIN_PACKAGES_LOCK."
  echo "      That is a broken read, not a small dependency graph."
  exit 1
fi

# ── match ───────────────────────────────────────────────────────────────────────
# One anchored alternation over the family roots.
FAMILIES="$(printf '%s' "$DENY_FAMILIES" | tr -s ' \n' '\n\n' | grep . | sort -u)"
PATTERN="^($(printf '%s\n' "$FAMILIES" | paste -sd'|' -))[0-9]*([-_].*)?$"

# The family that denied a crate, resolved by testing each root rather than guessing at
# the first separator (`ndarray-npy` is denied by `ndarray-npy`, not by `ndarray`).
#
# It applies the SAME anchor `PATTERN` uses, per root, so attribution can never disagree
# with the verdict. It used to be a `case` list of `<fam>` / `<fam>-*` / `<fam>_*`, which
# had no arm for the `[0-9]*` continuation — so `arrow2` and `parquet2`, the two crates
# that continuation exists for, were correctly FAILED and then reported as
# `(denied family: ?)`, pointing the reader at no entry to go read.
denying_family() {
  local crate="$1" fam
  while IFS= read -r fam; do
    if [[ "$crate" =~ ^"$fam"[0-9]*([-_].*)?$ ]]; then printf '%s' "$fam"; return; fi
  done <<EOF
$FAMILIES
EOF
  printf '%s' '?'
}

report() { # <label> <file>
  local crate
  while IFS= read -r crate; do
    [ -n "$crate" ] || continue
    printf '  %-15s %-22s (denied family: %s)\n' "$1" "$crate" "$(denying_family "$crate")"
  done <<EOF
$(grep -E "$PATTERN" "$2" | sort -u)
EOF
}

hits_meta="$(grep -cE "$PATTERN" "$TMP/from-metadata.txt" || true)"
hits_lock="$(grep -cE "$PATTERN" "$TMP/from-lock.txt" || true)"

if [ "$hits_meta" -gt 0 ] || [ "$hits_lock" -gt 0 ]; then
  echo "FAIL: a FORMAT-PARSING crate is linkable into the server (INV-1 violated)."
  echo ""
  echo "  <source>       <crate>          <the family that denied it>"
  report 'cargo-metadata' "$TMP/from-metadata.txt"
  report 'Cargo.lock'     "$TMP/from-lock.txt"
  echo ""
  echo "INV-1: the server confines, caps, hashes, stores, records and SERVES bytes — it"
  echo "never opens one for meaning. Every artifact semantic is DECLARED by the producing"
  echo "processor in \`structure\`/\`meta\`; decoding happens in the processor (writing) and"
  echo "in the browser (reading), never in Rust."
  echo ""
  echo "  - serving array bytes?   \`GET /artifacts/{id}/data/{*member}\` is a byte range."
  echo "  - need a shape/dtype?    read the producer's \`structure\`, do not sniff the bytes."
  echo "  - genuinely a new need?  that is an invariant change: amend the design and this"
  echo "                           list in ONE reviewable diff, do not add the crate."
  echo ""
  echo "This guard was RED for one bounded stretch — while ITEM-12 (delete serve_core + the"
  echo "Arrow serve wire) and ITEM-13 (delete tiledb_serve) were outstanding and \`arrow\` /"
  echo "\`arrow-ipc\` were still direct dependencies. Both landed; both deps are gone; the"
  echo "guard has been GREEN since. So this is NOT that expected red, and it is not somebody"
  echo "else's unfinished item: something you can see above became linkable just now."
  exit 1
fi

# ── the DECODE SCOPE check (INV-1 as amended) ───────────────────────────────────
#
# The crate graph alone cannot enforce the amendment, and saying so is the point: the
# chain's three codecs need `flate2` (a general byte-stream codec this guard has always
# called LEGAL), plus a shard index that is `u64` pairs and an un-shuffle that is index
# arithmetic — neither of which needs a crate at all. So "no denied crate is linkable"
# would stay green while every module in the server grew a decoder.
#
# What bounds the allowance is therefore WHERE a decompressor may appear. Exactly one
# file is allowed to hold one, and everything else in the server's source is refused.
#
# Sized to the decision, not to the crate: this is not "the server may decode", it is
# "the gather may decode the chain the writer emits". The codec ALLOWLIST — three names,
# and a by-name refusal for anything else — lives in that module and is asserted by its
# own unit tests; this check only enforces that the module is the sole holder.
DECODE_SCOPE_ALLOWED='src-app/server/src/modules/workstore/gather_decode.rs'
# Entry points that constitute decoding a stored payload. `sha2`/`crc32c` are absent on
# purpose: hashing and integrity-checking are in INV-1's own list of things the server
# DOES, and neither yields a plaintext byte.
# Every decompressor that is LINKABLE today, not merely the one currently used.
#
# The first version of this list named `flate2` and its decoder types. That bounded a
# NARROWER rule than the amendment states: `miniz_oxide`, `zstd` and `brotli` are already in
# `Cargo.lock` and pass both halves of the crate guard (they are general byte-stream codecs,
# deliberately legal), so a decoder written against any of them would have satisfied every
# check while sitting anywhere in the tree. `libflate`, `zune-inflate`, `lz4` and `snap` are
# not in the graph today and are here so that adding one does not also require remembering
# to add it here.
#
# The rule the owner amended is "the GATHER may decode, and nothing else may" — so what is
# scoped is the ACT, and the marker set has to reach every crate that can perform it.
DECODE_MARKERS='flate2|miniz_oxide|libflate|zune_inflate|zune-inflate|lz4|snap::|GzDecoder|ZlibDecoder|DeflateDecoder|MultiGzDecoder|DecompressorOxide|inflate_into|decompress_to_vec|zstd::|zstd_safe|brotli::|BrotliDecompress|Decompressor'

scan_decode_scope() { # <root-to-scan> <label>
  local root="$1" label="$2" hits=0
  # EVERY Rust source that can be linked into the server, not one directory. The amendment
  # says the gather may decode and NOTHING ELSE may; scanning only `server/src` bounded that
  # to one crate, so a decoder in a sibling workspace crate — which links into the same
  # binary — passed. `tests/` is deliberately out of scope: INV-1 is about what the SERVER
  # does, and the suite's own reader (`tests/common/zarr.rs`) is the sanctioned way a test
  # says what a processor emitted.
  local trees=()
  for d in "$root"/src-app/*/src; do [ -d "$d" ] && trees+=("$d"); done
  if [ ${#trees[@]} -eq 0 ]; then
    echo "  decode scope ($label): no Rust source trees under $root/src-app/*/src — skipped."
    return 0
  fi
  local offenders
  offenders="$(grep -rlE --include='*.rs' "$DECODE_MARKERS" "${trees[@]}" 2>/dev/null |
                 sed "s#^$root/##" |
                 grep -vxF "$DECODE_SCOPE_ALLOWED" || true)"
  if [ -n "$offenders" ]; then
    echo "FAIL: a DECODER appears outside the gather module (INV-1 as amended)."
    echo ""
    printf '  %s\n' $offenders
    echo ""
    echo "INV-1 allows the GATHER to decode the writer's chain — in"
    echo "  $DECODE_SCOPE_ALLOWED"
    echo "and nowhere else. The exception exists because a virtual dataset's bytes cannot"
    echo "be produced without it (see the header); it is not a general licence to open"
    echo "artifact bytes, and every other module still stores, serves and never interprets."
    echo ""
    echo "  - need a shape/dtype?    read the producer's \`structure\`, do not sniff the bytes."
    echo "  - decompressing a TRANSPORT frame (an upload, an archive)? that is not this —"
    echo "                           but put it behind a named helper rather than here."
    echo "  - genuinely a new need?  that is an invariant change: amend the design, this"
    echo "                           header and this list in ONE reviewable diff."
    return 1
  fi
  hits="$(grep -rlE --include='*.rs' "$DECODE_MARKERS" "${trees[@]}" 2>/dev/null | wc -l | tr -d ' ')"
  echo "  decode scope ($label): OK — $hits file(s) hold a decoder, all within"
  echo "      $DECODE_SCOPE_ALLOWED"
  return 0
}

# The REAL tree is always scanned, so pointing the seam elsewhere can never hide a live
# violation; the seam ADDS a tree (the same add-only shape as CYTO_DEPGUARD_EXTRA_DENY).
scope_fail=0
scan_decode_scope "$PWD" 'repo' || scope_fail=1
if [ -n "${CYTO_DEPGUARD_SCAN_ROOT:-}" ]; then
  scan_decode_scope "$CYTO_DEPGUARD_SCAN_ROOT" 'seam' || scope_fail=1
fi
[ "$scope_fail" -eq 0 ] || exit 1

echo "PASS: 0 format-parsing crates in the server dependency graph (INV-1)."
echo "      cargo metadata: $n_meta crate(s) (floor $MIN_PACKAGES_METADATA), host $HOST;"
echo "      $LOCKFILE: $n_lock package(s) (floor $MIN_PACKAGES_LOCK)."
exit 0
