#!/usr/bin/env bash
#
# check-no-legacy-wire.sh — the INV-1 / no-legacy-wire static grep-guard
# (universal-tiledb-serving Slice 6; TEST-2/6/24). The comprehensive sweep (backend +
# frontend) mirroring `check-kinds-zero-core.sh`; its `--lib`-runnable Rust twin is
# `workstore::no_legacy_wire::{serve_core_is_domain_free, no_legacy_wire_in_production}`.
#
# Two invariants:
#   • INV-1 (TEST-2 + TEST-6): the serve DECISION surface names NO domain/datatype/kind
#     literal — it resolves a member PATH and a byte RANGE, and nothing else. Forbidden:
#     `single-cell/`, `geneset/collection`, `graph/attributed`, `de/result` (all
#     slash-compound → substring-safe) plus the three bare domain nouns the Rust twin
#     also denies (`embedding`/`trajectory`/`expression`).
#   • TEST-24 (no-legacy-wire): every RETIRED read wire is GONE from PRODUCTION code —
#     no `encode_sparse_column`/`encode_dense_f32`/`csc_column_slice` on a serve path, no
#     `de_page`/`slice_artifact` handler, no `SparseColumn` selector, no
#     `x-workstore-dtype`/`x-workstore-shape` header (backend), no `decodeSparseColumn`/
#     `sliceColumn` decoder (frontend) — and, since artifact-model ITEM-12, no
#     Selection→Arrow `GET /read` vocabulary either.
#
# ── WHAT ITEM-12/ITEM-13 CHANGED HERE (a REPAIR, not a relaxation) ──────────────────
# This guard used to resolve its serve-core scan set from `serve_core.rs` plus a RECURSIVE
# glob over `modules/tiledb_serve/`, behind a bare `READER_MIN=4` count floor. ITEM-12
# deleted `serve_core.rs` (the Selection→Arrow serve core, its Selection grammar and the
# tier routing) and ITEM-13 deleted the whole `tiledb_serve` module, so the glob resolved
# to ZERO files and the floor fired — correctly: an emptied scan set is a broken guard,
# not a clean tree.
#
# The scan sets are therefore RE-POINTED at the surviving surface, in lockstep with the
# already-repaired Rust twin (`workstore/no_legacy_wire.rs`, `serve_domain_files()` /
# `wire_surface_files()`):
#   • the serve DECISION is now `routes.rs` (which URL reaches the byte plane) plus
#     `range.rs` (which bytes come back). Between them they are the whole "what do we
#     serve" decision, which is exactly the property `serve_core.rs` was scanned for.
#   • the retired-token list GROWS by the whole `/read` vocabulary, so the Selection→Arrow
#     wire cannot come back one helper at a time.
# Net: strictly more tokens denied over a surface that is structurally smaller. Nothing
# was dropped to make a deletion compile.
#
# And the count floors are replaced by NAMED-FILE assertions (`assert_all_present`, the
# same fix the Rust twin took). A `files.len() >= N` floor passes for any N files —
# including N of the WRONG files — and it rots on every legitimate deletion without ever
# saying WHICH path went missing. Naming them makes the failure self-diagnosing and makes
# a re-point a reviewable one-line diff.
#
# Un-gameable: each file is filtered to PRODUCTION lines (comments + `#[cfg(test)]` blocks
# stripped) and `*.test.ts`/`*.spec.ts` are excluded — a token can only pass by genuinely
# not being in production code. (The `legacy_oracle.rs` test-only oracle used to be
# excluded by name; ITEM-12 deleted it along with the serve arm it was an oracle for, so
# the exclusion is gone rather than carried as dead configuration.)
#
# Exit 0 = clean. Non-zero = a legacy/domain token leaked into production (printed).
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

# Filter a source file to its production lines: drop `//` (line/inline/doc) comments and
# skip whole `#[cfg(test)]` `{…}` blocks (brace-tracked). Works for Rust; for TS the
# cfg(test) logic is inert (test files are excluded by name) and only `//` is stripped.
filter_production() {
  perl -ne '
    BEGIN { our $pending=0; our $depth=0; our $intest=0; }
    my $line = $_;
    $line =~ s{//.*$}{};              # strip // comment (keeps code before it)
    if ($intest) {
      $depth += ($line =~ tr/{//);
      $depth -= ($line =~ tr/}//);
      $intest = 0 if $depth <= 0;
      next;
    }
    if ($pending) {
      my $o = ($line =~ tr/{//); my $c = ($line =~ tr/}//);
      if ($o > 0) { $pending=0; $depth=$o-$c; $intest=1 if $depth>0; }
      next;
    }
    if ($line =~ /#\[cfg\((all\()?test/) { $pending=1; next; }
    print $line;
  ' "$1"
}

fail=0

# THE ANTI-VACUITY BACKSTOP. Every scanned path is hard-coded, so a rename or a deletion
# would otherwise leave this guard reading fewer files — or none — and still printing
# PASS. This replaces the two bare count floors (`READER_MIN=4`, the frontend `< 10`):
# a count cannot say WHICH path went missing, and it silently tolerates the scan set
# being swapped for the wrong files of the right cardinality.
#
# A path that is genuinely gone must be REMOVED from the array above, in the same commit
# as the deletion — which puts the shrinking coverage in the diff, next to the reason.
assert_all_present() { # <label> <files...>
  local label="$1"; shift
  local missing=()
  local f
  for f in "$@"; do
    [ -f "$f" ] || missing+=("$f")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "FAIL [$label]: a guarded path no longer exists, so this guard was about to scan"
    echo "      less than it claims. Re-point it, or drop the path from the scan set"
    echo "      DELIBERATELY (as ITEM-12/ITEM-13 did when they deleted the serve core and"
    echo "      the native array reader):"
    printf '    %s\n' "${missing[@]}"
    fail=1
  fi
}

report() { # <label> <file> <needle-regex> <files...>
  local label="$1"; shift
  local regex="$1"; shift
  for f in "$@"; do
    [ -f "$f" ] || continue
    local hits
    hits="$(filter_production "$f" | grep -nE "$regex" 2>/dev/null || true)"
    if [ -n "$hits" ]; then
      echo "FAIL [$label] $f:"
      echo "$hits" | sed 's/^/    /'
      fail=1
    fi
  done
}

# ── serve-decision surface (INV-1 domain-free) ──
# `data_api.rs` stays EXCLUDED from the DOMAIN half, for the unchanged reason: it carries
# the `#[cfg(debug_assertions)]` e2e-seed layer, which legitimately names datatypes to
# build fixtures, and a seed is not a serve decision. (It IS scanned by the retired-wire
# half below, which carries no such exemption.)
#
# `embedding`/`trajectory`/`expression` are bare DOMAIN nouns INV-1's prose also forbids
# on this surface. They are long enough not to over-match (unlike a bare `de`/`matrix`,
# which are substrings of `index`/`decode`/`format`) and are verified absent from both
# files today, so denying them CATCHES a future bare-domain leak the slash-compound-only
# list would miss. Kept byte-identical to the Rust twin's `domain_literals`.
#
# DECLARED, because this guard HUNTS for these terms and therefore has to spell them (#304).
# `check-derived-vocabulary.sh` blanks the lines between these two markers and scans every
# other line of this file like any other build file — the exemption is one declared block,
# not the whole file, and it is honoured only because this file is PINNED in
# `scripts/guard-hashes.txt`. Adding a line to the block that is not the hunted vocabulary
# is the relaxation `docs/design/derived-guards.md` §5 refuses.
# cyto:guard-vocabulary
DOMAIN_REGEX='single-cell/|geneset/collection|graph/attributed|de/result|embedding|trajectory|expression'
# cyto:end-guard-vocabulary
# The serve DECISION path, post-ITEM-12/13. `serve_core.rs` (the Selection→Arrow core,
# `resolve_backend`, the tier fallback) and the generic `tiledb_serve` reader were the
# scan targets because they were where a decode DECISION lived. Both are DELETED, so the
# decision they made does not exist to be domain-tainted; the class of regression this
# names now lands in the route table + the byte-range parser instead.
SERVE_DECISION=(
  src-app/server/src/modules/workstore/routes.rs
  src-app/server/src/modules/workstore/range.rs
)
assert_all_present "INV-1 domain-free serve decision" "${SERVE_DECISION[@]}"
report "INV-1 domain-free serve decision" "$DOMAIN_REGEX" "${SERVE_DECISION[@]}"

# ── backend wire surface (TEST-24 no-legacy-wire) ──
# Two generations of retired wire, kept byte-identical to the Rust twin's `legacy_tokens`:
#   (1) the typed-binary generation, retired in S5b. `encode_sparse_column` /
#       `csc_column_slice` no longer exist at all (ITEM-12 deleted `legacy_oracle.rs`
#       with the serve arm it was an oracle for), so these are pure tripwires now.
#   (2) the Selection→Arrow generation, retired by ITEM-12. `/read` was what the S5b
#       comment called "the sole Tier-2 wire"; it is itself a retired wire now, and its
#       whole vocabulary is denied so it cannot return one helper at a time. `arrow::` /
#       `arrow_ipc` are spelled WITH their path separator on purpose — a bare `arrow` is
#       a substring of `narrow`, and a guard that fires on an English word gets disabled
#       by the next person who trips it. Their mechanical twin is
#       `scripts/check-no-format-crates.sh`, which denies the crate at the dependency-graph
#       level; these catch a re-import in the files where it would matter first.
LEGACY_REGEX='encode_sparse_column|encode_dense_f32|csc_column_slice|de_page|slice_artifact|SparseColumn|x-workstore-dtype|x-workstore-shape|typed_binary'
LEGACY_REGEX="$LEGACY_REGEX"'|serve_artifact_read|serve_selection|ReadSelection|DimSelection|ipc_stream_chunks|RecordBatch|arrow::|arrow_ipc|Tier2LayoutSlice'
# `serve_core.rs` + `artifact/coo.rs` left this list because ITEM-12 DELETED them, and the
# `tiledb_serve` reader because ITEM-13 did; `range.rs` and `ingest.rs` join as the
# surviving byte-serve implementation and the surviving write half.
BE_WIRE=(
  src-app/server/src/modules/workstore/data_api.rs
  src-app/server/src/modules/workstore/routes.rs
  src-app/server/src/modules/workstore/range.rs
  src-app/server/src/modules/workstore/config.rs
  src-app/server/src/modules/workstore/ingest.rs
  src-app/server/src/modules/workstore/artifact/mod.rs
  src-app/server/src/modules/datatype/convert.rs
)
assert_all_present "no-legacy-wire (backend)" "${BE_WIRE[@]}"
report "no-legacy-wire (backend)" "$LEGACY_REGEX" "${BE_WIRE[@]}"

# ── frontend data plane (TEST-24 no-legacy-wire), *.test.ts excluded ──
# The workbench data/run surfaces were re-homed by the core/extensions layering:
#   workbench/host/*.ts   → workbench/core/host/*.ts  (host wiring that stayed core-owned)
#                         + workbench/extensions/data/*.ts   (the data plane)
#                         + workbench/extensions/jobs/*.ts   (the jobs plane)
#   workbench/result/*.tsx → workbench/extensions/jobs/*.tsx      (the RUN views)
#                          + workbench/extensions/provenance/*.tsx (the lineage views)
#                          + workbench/core/render/*.tsx          (the generic fallback)
FE_REGEX='decodeSparseColumn|sliceColumn|x-workstore-dtype|x-workstore-shape'
FE_FILES=()
while IFS= read -r f; do
  case "$f" in *.test.ts|*.test.tsx|*.spec.ts) continue;; esac
  FE_FILES+=("$f")
done < <(git ls-files --cached --others --exclude-standard -- \
  'src-app/ui/src/core/workstore/*.ts' \
  'src-app/ui/src/modules/workbench/core/host/*.ts' \
  'src-app/ui/src/modules/workbench/core/render/*.tsx' \
  'src-app/ui/src/modules/workbench/core/runtime/viewData.ts' \
  'src-app/ui/src/modules/workbench/extensions/data/*.ts' \
  'src-app/ui/src/modules/workbench/extensions/jobs/*.ts' \
  'src-app/ui/src/modules/workbench/extensions/jobs/*.tsx' \
  'src-app/ui/src/modules/workbench/extensions/provenance/*.tsx' | sort -u)
# Fail CLOSED on a collapsed scan set — but by NAME, not by count. The old `< 10` floor
# could not say WHICH glob stopped resolving, and it would have kept passing while five
# of the eight globs silently emptied. These five are one load-bearing witness per
# distinct glob root: if a walk stops reaching its witness, the failure names the root.
# (Deliberately NOT `arrowClient.ts`/`zarrReader.ts`: the reader files under
# `core/workstore/` are the ones actively being replaced by ITEM-23/24/29, so pinning one
# would make this guard hostage to that churn. The barrel is the stable identity there.)
FE_WITNESSES=(
  src-app/ui/src/core/workstore/index.ts
  src-app/ui/src/modules/workbench/core/runtime/viewData.ts
  src-app/ui/src/modules/workbench/extensions/data/workbenchDataSource.ts
  src-app/ui/src/modules/workbench/extensions/jobs/jobsHost.ts
  src-app/ui/src/modules/workbench/extensions/provenance/LineagePane.tsx
)
assert_all_present "no-legacy-wire (frontend)" "${FE_WITNESSES[@]}"
for w in "${FE_WITNESSES[@]}"; do
  # A witness that does not exist was already reported by `assert_all_present` above;
  # re-reporting it here as "exists on disk but the globs missed it" would be false.
  [ -f "$w" ] || continue
  case " ${FE_FILES[*]} " in
    *" $w "*) ;;
    *)
      echo "FAIL: no-legacy-wire (frontend): the witness \"$w\" exists on disk but the globs"
      echo "      above did NOT resolve to it, so that glob root is no longer being walked."
      fail=1
      ;;
  esac
done
report "no-legacy-wire (frontend)" "$FE_REGEX" "${FE_FILES[@]}"

if [ "$fail" -eq 0 ]; then
  echo "PASS: 0 domain literals on the serve decision path (INV-1) + 0 retired legacy-wire"
  echo "      tokens in production backend/frontend code (TEST-2/6/24)."
  echo "      Scanned: ${#SERVE_DECISION[@]} serve-decision + ${#BE_WIRE[@]} backend-wire + ${#FE_FILES[@]} frontend file(s),"
  echo "      every named path asserted present. GET /artifacts/{id}/data[/{*member}] is the"
  echo "      ONLY read surface: it serves opaque byte ranges and the client decodes."
fi
exit $fail
