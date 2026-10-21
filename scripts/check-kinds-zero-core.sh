#!/usr/bin/env bash
#
# check-kinds-zero-core.sh — the un-gameable "a new KIND is DATA, not core code" guard
# (universal-tiledb-serving Slice 4, INV-2). Mirrors `check-no-study-domain-literals.sh`
# + processor-separability's `lint-no-domain-in-builtin.mjs`.
#
# The whole thesis of this lifecycle is that the 3 kinds SOMA cannot hold — geneset,
# graph, DE — are DECLARED DATA manifests served by the EXISTING byte plane with ZERO
# new core Rust. If adding a kind required a core-file edit, the design has failed.
# This asserts ZERO reference to the 3 kind ids anywhere in the APP-CORE production
# surface: the workstore byte/serve layer (`data_api`/`routes`/`range`/`ingest`), the
# catalog rows and object store beneath it, and the datatype lattice it gates on. (It
# used to say "the serve core … the generic tiledb_serve reader"; both were deleted by
# artifact-model ITEM-12/ITEM-13 — see the CORE_FILES block below.) A kind id in any of
# those files means the serve/decode path learned a domain kind — a regression. Kind ids
# legitimately appear in the DATA manifest (`packages/open-kinds/manifest.yaml`), the
# golden fixture, and the TESTS (which seed fixtures) — those are NOT in the scanned
# app-core set, by construction.
#
# The ids are all SLASH-COMPOUND, so they match as raw substrings with no false
# positives (a bare `graph`/`de` would over-match; `graph/attributed` never occurs
# generically).
#
# Exit 0 = clean. Non-zero = a kind id leaked into app-core (printed).
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

# The 3 zero-core kind ids (DATA in packages/open-kinds/manifest.yaml).
#
# DECLARED, because this guard HUNTS for these ids and therefore has to spell them (#304).
# `check-derived-vocabulary.sh` blanks the lines between these two markers and scans every
# other line of this file like any other build file — the exemption is one declared block,
# not the whole file, and it is honoured only because this file is PINNED in
# `scripts/guard-hashes.txt`. Widening the block to cover anything that is not the hunted
# vocabulary is the relaxation `docs/design/derived-guards.md` §5 refuses.
# cyto:guard-vocabulary
KINDS='geneset/collection|graph/attributed|de/result'
# cyto:end-guard-vocabulary

# ── WHAT ITEM-12/ITEM-13 CHANGED HERE (a REPAIR, not a relaxation) ──────────────────
# This list used to name `workstore/serve_core.rs` and the whole `modules/tiledb_serve/`
# reader directory. artifact-model ITEM-12 DELETED the serve core (the Selection→Arrow
# `GET /read` surface, its Selection grammar and the tier routing) and ITEM-13 deleted
# the native array reader with its Cargo feature. The scan set collapsed from 11 files to
# 6 and the floor fired — correctly: an emptied scan set is a broken guard, not a clean
# tree.
#
# The property has NOT moved off the codebase, so the guard does not shrink to match. A
# "kind" could only ever leak into core by being named on the path that decides how to
# serve or how to type an artifact; with the decode DECISION gone, that path is the byte
# plane (`data_api`/`routes`/`range`), the catalog rows it reads (`catalog/*`,
# `artifact/mod`, `ingest`, `object_store/*`) and the datatype lattice it consults
# (`datatype/*`). All of those are named below, and the set is now BIGGER than the one
# the deletions broke: 14 named files against the 11 that used to resolve.
#
# `datatype/types.rs` is deliberately ABSENT: it carries a `"extends": "graph/attributed"`
# fixture inside a `#[cfg(test)]` JSON literal, and this guard greps raw bytes (no comment
# or cfg(test) stripping, unlike its `no_legacy_wire` sibling). Including it would make
# the guard fire on a TEST fixture, which is the one thing its header promises it will
# not do. Adding comment-stripping here would be a change to the guard's semantics, not
# to its scope — a separate, deliberate decision.
#
# `datatype/layout.rs` was named here until ITEM-14 deleted it (the tier/selector-map
# resolver). Its line was removed in the same commit as the file, exactly as this guard
# intended — a one-line diff, no floor lowered. That is the whole point of naming paths
# instead of counting them.
#
# The APP-CORE production surface a new kind must NOT touch. Test dirs and the DATA
# manifest are deliberately EXCLUDED (a test may name ids; the manifest IS the data) — so
# the guard cannot be gamed by hiding a dispatch in a test.
CORE_FILES=(
  # workstore — the byte plane, the rows that describe it, and the ingest that writes them
  'src-app/server/src/modules/workstore/data_api.rs'
  'src-app/server/src/modules/workstore/routes.rs'
  'src-app/server/src/modules/workstore/range.rs'
  'src-app/server/src/modules/workstore/ingest.rs'
  'src-app/server/src/modules/workstore/artifact/mod.rs'
  'src-app/server/src/modules/workstore/catalog/repository.rs'
  'src-app/server/src/modules/workstore/catalog/models.rs'
  'src-app/server/src/modules/workstore/object_store/mod.rs'
  'src-app/server/src/modules/workstore/object_store/local_fs.rs'
  # datatype — the is-a lattice the serve layer gates analyses on
  'src-app/server/src/modules/datatype/builtin.rs'
  'src-app/server/src/modules/datatype/registry.rs'
  'src-app/server/src/modules/datatype/validate.rs'
  'src-app/server/src/modules/datatype/convert.rs'
)

fail=0
# THE ANTI-VACUITY BACKSTOP, BY NAME. This replaces `MIN_FILES=8`: a count cannot say
# WHICH hard-coded path stopped resolving, it passes for any 8 files including 8 of the
# wrong ones, and it rots on every legitimate deletion. Naming them makes the failure
# self-diagnosing and a re-point a reviewable one-line diff.
MISSING=()
for f in "${CORE_FILES[@]}"; do
  [ -f "$f" ] || MISSING+=("$f")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "FAIL: a guarded app-core path no longer exists, so this guard was about to PASS"
  echo "      having scanned less than it claims. Re-point it, or drop it from CORE_FILES"
  echo "      DELIBERATELY, in the same commit as the deletion:"
  printf '    %s\n' "${MISSING[@]}"
  exit 1
fi

# Cross-check the named set against git, so a path that exists on disk but is IGNORED
# (build output, a stray copy) cannot masquerade as scanned source. `--others
# --exclude-standard` keeps a created-but-not-yet-staged file visible — `--cached` alone
# returns NOTHING for a working-tree rename, the fail-open this repo has hit repeatedly.
TRACKED="$(git ls-files --cached --others --exclude-standard -- "${CORE_FILES[@]}" | grep -E '\.rs$' | sort -u)"
for f in "${CORE_FILES[@]}"; do
  case "
$TRACKED" in
    *"
$f"*) ;;
    *)
      echo "FAIL: \"$f\" exists on disk but git does not resolve it as tracked-or-new source"
      echo "      (is it gitignored?). A scanned path must be real repo source."
      exit 1
      ;;
  esac
done
FILES="$TRACKED"
n_files="$(printf '%s\n' "$FILES" | grep -c .)"

hits="$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -IEn "$KINDS" 2>/dev/null)"
if [ -n "$hits" ]; then
  echo "FAIL: a zero-core kind id leaked into the app-core serve/datatype/workstore surface:"
  echo "$hits" | head -50
  echo ""
  echo "A new kind must be DATA (packages/open-kinds/manifest.yaml) — the serve core"
  echo "routes on LAYOUT, never a domain KIND. Remove the reference."
  fail=1
else
  echo "PASS: 0 zero-core kind ids in the app-core serve/datatype/workstore surface (INV-2)."
  echo "      scanned $n_files app-core file(s), every one asserted present BY NAME."
fi

exit $fail
