#!/usr/bin/env bash
#
# check-processor-seed-versions.sh — the guard against the PROCESSOR EXTRACT-CACHE TRAP
# (R3-34). Mirrors the style of `check-kinds-zero-core.sh` / `check-no-legacy-wire.sh`.
#
# ## The trap
# `src-app/packages/` is embedded into the server binary as a SEED (`include_dir!` in
# `server/src/modules/extensions/embedded.rs`) and extracted to
# `<data_root>/processors/<pkg>/…` on first run. Reconciliation USED to be keyed ONLY on
# `manifest.yaml`'s `version`, so a package whose `compute/` kernel or `ui/` view_spec
# changed WITHOUT a bump was INVISIBLE to an already-provisioned deployment: it kept
# executing the OLD extracted kernel while the freshly-built frontend shipped the NEW
# `ui` yaml — a divergence that only ever appears in production, because a fresh dev box
# has no stale extraction and so can never reproduce it.
#
# ## THIS SCRIPT IS NO LONGER THE CORRECTNESS BOUNDARY — read this before relying on it
# `embedded.rs` now records a SHA-256 of every embedded file in `.seed-manifest.json`
# and re-asserts, surgically, any file whose embedded bytes changed since the recorded
# extraction — at the same version, with nobody bumping anything. Content changes reach
# a provisioned host because the check is DERIVED from the bytes.
#
# That was made the primary mechanism because this script structurally cannot be one.
# Two independent reasons:
#
#   1. It compares base..head. A package that did not exist at the merge base has no
#      earlier version to require movement from, so it is skipped (see the `continue`
#      below) — and that is not a bug that can be fixed here: the introducing diff IS
#      the whole package. `_lib`, the conformance gate every processor's output is judged
#      against, is exactly such a package: born on this branch, 678 lines changed in one
#      later round, still `0.1.0`. Nothing base-relative was ever going to catch that.
#   2. It cannot see a change that happens BETWEEN two builds of the same commit range on
#      one developer's shared `<data_root>/processors` dir.
#
# So treat a green run here as VERSION HYGIENE (a released package's version moves when
# its contents do, so operators and logs can tell two builds apart), never as evidence
# that a provisioned host will pick a change up. The runtime property is pinned by
# `embedded.rs`'s `a_content_change_at_the_same_version_is_re_asserted_but_an_identical_one_is_not`
# and `the_real_lib_conformance_gate_reaches_a_provisioned_host_without_a_version_bump`.
# If either is ever deleted, this script's exemptions become load-bearing again.
#
# ## The gate
# For every seed package that EXISTED AT THE BASE, if any file under it changed since the
# base ref, its `manifest.yaml` `version` MUST have changed too (and must not go
# backwards). Git holds the previous state, so this is non-circular — unlike a hash
# recorded inside the manifest, which the same edit could simply update.
#
# ## Usage
#   scripts/check-processor-seed-versions.sh                 # merge-base(origin/main,HEAD)..working tree
#   scripts/check-processor-seed-versions.sh <base-ref>       # explicit base
#   scripts/check-processor-seed-versions.sh <base-ref> <head-ref>   # pin both (CI)
#   BASE_REF=upstream/main scripts/check-processor-seed-versions.sh
#
# Exit 0 = clean. 1 = a package changed with no version bump (printed). 2 = usage/setup.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

PROCESSORS_DIR="src-app/packages"
[ -d "$PROCESSORS_DIR" ] || { echo "no $PROCESSORS_DIR here" >&2; exit 2; }

BASE_INPUT="${1:-${BASE_REF:-origin/main}}"
HEAD_REF="${2:-}"   # empty = compare against the WORKING TREE (catches uncommitted edits)

if ! git rev-parse --verify --quiet "$BASE_INPUT^{commit}" >/dev/null; then
  echo "check-processor-seed-versions: base ref '$BASE_INPUT' not found." >&2
  echo "  Pass one explicitly (e.g. the branch's merge-base) or set BASE_REF=." >&2
  exit 2
fi

# Compare against the MERGE BASE, not the base tip: an unrelated bump landing on main
# must not make this branch look like it bumped (and vice versa).
BASE="$(git merge-base "$BASE_INPUT" "${HEAD_REF:-HEAD}")" || exit 2

# `version:` at the top level of a package manifest (the seed reconciliation key).
# Deliberately anchored at column 0 so a nested `version:` under `contributes:` can't match.
read_version() { # <file-content-on-stdin>
  sed -n 's/^version:[[:space:]]*["'\'']\{0,1\}\([^"'\''[:space:]]*\).*/\1/p' | head -n1
}

fail=0
checked=0
exempt=0

# ITEM-37 — FAIL CLOSED on a collapsed scan set. The `[ -d "$PROCESSORS_DIR" ]` check
# above only proves the DIRECTORY exists; if the per-package `manifest.yaml` layout is
# renamed the glob matches nothing, every loop body is skipped, and the script prints
# "clean (0 seed package(s) checked)" at exit 0 — a PASS having verified nothing. The
# floor is a committed constant.
MIN_PACKAGES=5
n_manifests=0
for _m in "$PROCESSORS_DIR"/*/manifest.yaml; do
  [ -e "$_m" ] && n_manifests=$((n_manifests + 1))
done
if [ "$n_manifests" -lt "$MIN_PACKAGES" ]; then
  echo "FAIL: found $n_manifests seed package manifest(s) under $PROCESSORS_DIR, below the"
  echo "      floor of $MIN_PACKAGES. The hard-coded '<pkg>/manifest.yaml' layout no longer"
  echo "      resolves, so this guard was about to PASS having checked nothing. Re-point it,"
  echo "      or lower MIN_PACKAGES deliberately."
  exit 1
fi

for manifest in "$PROCESSORS_DIR"/*/manifest.yaml; do
  [ -e "$manifest" ] || continue
  pkg_dir="$(dirname "$manifest")"
  pkg="$(basename "$pkg_dir")"

  # A package that did not exist at the base is NEW: there is no earlier version for a
  # bump to move away from, so this gate has nothing to assert about it — not now and not
  # after any amount of rework, because the comparison is base-relative by construction.
  # Reported rather than silently skipped, so the exemption is visible in the output
  # instead of being a `continue` a reader has to notice. The runtime digest in
  # `embedded.rs` is what actually covers these packages; see the header.
  if ! git cat-file -e "$BASE:$manifest" 2>/dev/null; then
    echo "new   $pkg — introduced on this branch; version-bump rule N/A (covered at runtime"
    echo "      by the embedded-file digest in embedded.rs, not by this gate)."
    exempt=$((exempt + 1))
    continue
  fi
  checked=$((checked + 1))

  # Did anything in the package change? (`git diff <base> -- <dir>` with no head ref
  # compares the base to the WORKING TREE, so uncommitted edits are caught too.)
  if [ -n "$HEAD_REF" ]; then
    git diff --quiet "$BASE" "$HEAD_REF" -- "$pkg_dir" && continue
  else
    git diff --quiet "$BASE" -- "$pkg_dir" && continue
  fi

  old_version="$(git show "$BASE:$manifest" | read_version)"
  if [ -n "$HEAD_REF" ]; then
    new_version="$(git show "$HEAD_REF:$manifest" | read_version)"
  else
    new_version="$(read_version < "$manifest")"
  fi

  if [ -z "$new_version" ]; then
    echo "FAIL  $pkg — no top-level \`version:\` in $manifest (the seed reconciliation key)."
    fail=1
    continue
  fi

  if [ "$old_version" = "$new_version" ]; then
    echo "FAIL  $pkg — content changed but \`version\` stayed $new_version."
    echo "      Changed files:"
    if [ -n "$HEAD_REF" ]; then
      git diff --name-only "$BASE" "$HEAD_REF" -- "$pkg_dir" | sed 's/^/        /'
    else
      git diff --name-only "$BASE" -- "$pkg_dir" | sed 's/^/        /'
    fi
    echo "      An already-provisioned deployment SKIPS re-extraction at an unchanged"
    echo "      version, so it would keep running the OLD $pkg. Bump \`version:\` in"
    echo "      $manifest (patch for a fix, minor for behavior)."
    fail=1
    continue
  fi

  # Not strictly required by reconcile (`seed_version_wins` only overwrites when the
  # embedded version is NEWER), which is exactly why a DOWNGRADE is a silent no-op.
  lowest="$(printf '%s\n%s\n' "$old_version" "$new_version" | sort -V | head -n1)"
  if [ "$lowest" = "$new_version" ]; then
    echo "FAIL  $pkg — \`version\` went BACKWARDS ($old_version -> $new_version)."
    echo "      seed-version-wins only overwrites when the embedded version is NEWER,"
    echo "      so a downgrade leaves every provisioned deployment on the old package."
    fail=1
    continue
  fi

  echo "ok    $pkg — changed, version $old_version -> $new_version"
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "check-processor-seed-versions: FAILED (base $BASE)." >&2
  exit 1
fi

echo "check-processor-seed-versions: clean ($checked seed package(s) checked against $BASE;"
echo "  $exempt branch-born package(s) exempt — version hygiene only, NOT a guarantee that a"
echo "  provisioned host picks changes up; that is embedded.rs's per-file digest)."
exit 0
