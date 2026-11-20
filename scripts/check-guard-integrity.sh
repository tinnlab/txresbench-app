#!/usr/bin/env bash
#
# check-guard-integrity.sh — guard the guards (artifact-model ITEM-22).
#
# ── WHY ─────────────────────────────────────────────────────────────────────────
# Every other guard in this directory asserts something about the code. Nothing
# asserted anything about THEM. The cheapest way past any of them has always been to
# edit the guard: widen an exclusion, drop a term, lower a floor, or `exit 0` early.
# That edit is a one-line diff in a file nobody reads, and every gate stays green.
#
# So each guard's exact bytes are pinned in a COMMITTED manifest
# (`scripts/guard-hashes.txt`). A guard can still be changed — it must be, guards
# evolve — but only through `--update`, which rewrites the manifest and therefore
# puts the weakening in the diff, next to the change that needed it. The property is
# not "guards are immutable"; it is "a guard cannot be weakened SILENTLY".
#
# ── THREE CHECKS, ALL DEFAULT-DENY ──────────────────────────────────────────────
#   1. every manifest entry still exists and still hashes the same
#        → catches: weakening an existing guard, deleting one
#   2. every guard-shaped file on disk appears in the manifest
#        → catches: adding a guard nobody pinned, and the rename dodge (copy the
#          guard to a new name, gut the copy, point the runner at it)
#   3. the manifest lists at least MIN_GUARDS entries
#        → catches: emptying the manifest instead of the guards
# This script pins ITSELF (check 2 requires it), so gutting the verifier is exactly as
# visible as gutting anything it verifies.
#
# ── SCOPE ───────────────────────────────────────────────────────────────────────
# The `GUARD_GLOBS` array below is the scope: repo-root `scripts/check-*.sh` and
# `scripts/check-*.mjs` (the committed architectural-invariant guards, in whatever language
# they are written: a guard whose whole job is to fail a build is worth nothing if it can be
# gutted in a diff nobody reads), `scripts/lib/*`, and the UI-side and gallery guards that
# `just check` relies on. The frontend's `src-app/ui/scripts/lint-no-domain-in-builtin.mjs`
# is deliberately NOT pinned here: it is ratcheted per (file, token) by its committed
# `domain-baseline.json`, which already makes weakening it a visible diff. Widening this scope
# is a `GUARD_GLOBS` edit, which `--update` then makes reviewable like everything else.
#
# `scripts/install-guard-hooks.sh` is also OUT, deliberately. It installs a per-clone
# git hook, and a git hook is bypassable by design (`git push --no-verify`), so pinning
# the installer would imply a property the hook layer does not have. The load-bearing
# invocation of these guards is `just check-invariants`, not the hook.
#
# ── USAGE ───────────────────────────────────────────────────────────────────────
#   scripts/check-guard-integrity.sh            # verify (the hook + `just` path)
#   scripts/check-guard-integrity.sh --update   # re-pin after a DELIBERATE guard edit
#
# Exit 0 = every guard matches its pin. 1 = drift (printed). 2 = tooling/repo broken.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

MANIFEST='scripts/guard-hashes.txt'
# `scripts/lib/*` is guard LOGIC even though it is not named `check-*`: it holds the shared
# helpers and the declarations (for example `zero-core-surface.txt`) that decide what a guard
# scans, and an unpinned one would let a surface be narrowed in a diff with no pin next to it.
# The line is what a file DOES, not what it is called.
#
# `scripts/lib/*` is a `git ls-files` PATHSPEC, where `*` also crosses `/`: a future
# subdirectory of `scripts/lib/` has its contents treated as guards. That fails CLOSED (a
# noisy FAIL, never a silent pass), so it is a maintenance note, not a hole.
# The UI-side and gallery guards join the set. `just check` relies on every one of them, and
# `action-coverage.mjs` had already lost nine tenths of its scope in a diff nobody read (its
# allowlist named deleted files) while no pin moved. They are listed by name where the name
# does not say "check-" or "lint-": `collect-actions`, `action-refs-lint`, `action-coverage`
# and `guard-floors.test` are guard logic by what they DO. The one deliberate exception is
# `lint-no-domain-in-builtin.mjs` (the `:(exclude)` pathspec below), ratcheted by its
# committed `domain-baseline.json`, as the paragraph above says.
GUARD_GLOBS=(
  'scripts/check-*.sh' 'scripts/check-*.mjs' 'scripts/lib/*'
  'src-app/ui/scripts/check-*.mjs'
  'src-app/ui/scripts/lint-*.mjs'
  ':(exclude)src-app/ui/scripts/lint-no-domain-in-builtin.mjs'
  'src-app/ui/scripts/collect-actions.mjs'
  'src-app/ui/scripts/action-refs-lint.mjs'
  'src-app/ui/scripts/action-coverage.mjs'
  'src-app/ui/scripts/guard-floors.test.mjs'
  'sdk/packages/gallery/scripts/check-*.mjs'
)

# MIN_GUARDS is the number of pinned guards, EXACTLY (check 3 below fails on a manifest
# shorter than it, and on one longer). A manifest shorter than the real set is a gutted
# manifest; a floor left below the count is slack a pin can later vanish into, because
# dropping a pin AND its file makes checks 1 and 2 silent too. So when the guard set grows
# or shrinks, this number moves in the same diff, next to the pins:
#   scripts/check-guard-integrity.sh --update && grep -c '^[0-9a-f]\{64\}' scripts/guard-hashes.txt
# and put that count here. Do NOT lower it to fit a red.
#   36  the 19 repo-root and lib guards plus the 17 UI-side and gallery guards (the widening
#       of GUARD_GLOBS above).
MIN_GUARDS=36

MODE='verify'
case "${1:-}" in
  --update) MODE='update' ;;
  '') ;;
  *) echo "usage: $0 [--update]" >&2; exit 2 ;;
esac

# GNU coreutils vs macOS/BSD. No third binary is acceptable here — a guard that only
# runs on one OS is not running on the machine that skipped it.
if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "FAIL(2): neither \`sha256sum\` nor \`shasum\` is available; guard bytes cannot be pinned."
  exit 2
fi

# The guard-shaped files that exist RIGHT NOW. `--cached --others --exclude-standard`
# so a guard created but not yet staged is still seen (the `--cached`-only fail-open
# this repo has hit four times), while ignored build output never is.
present_guards() {
  git ls-files --cached --others --exclude-standard -- "${GUARD_GLOBS[@]}" 2>/dev/null | sort -u
}

if [ "$MODE" = 'update' ]; then
  {
    echo "# guard-hashes.txt — the COMMITTED pins for every guard in GUARD_GLOBS (see"
    echo "# scripts/check-guard-integrity.sh): scripts/check-*, scripts/lib/*, and the UI-side"
    echo "# and gallery guards."
    echo "#"
    echo "# Regenerate with:  scripts/check-guard-integrity.sh --update"
    echo "# A line changing here is a guard changing. That is the whole point: read it."
    echo "#"
    echo "# <sha256>  <path>"
  } > "$MANIFEST"
  n=0
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    printf '%s  %s\n' "$(hash_of "$g")" "$g" >> "$MANIFEST"
    n=$((n + 1))
  done <<EOF
$(present_guards)
EOF
  echo "updated $MANIFEST with $n guard(s). COMMIT IT — an unstaged re-pin hides the change it was meant to show."
  exit 0
fi

if [ ! -f "$MANIFEST" ]; then
  echo "FAIL: $MANIFEST is missing, so no guard is pinned to anything."
  echo "      Create it deliberately: scripts/check-guard-integrity.sh --update"
  exit 1
fi

fail=0
n_pinned=0
pinned_paths=''

# ── check 1 — every pin still holds ─────────────────────────────────────────────
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  want="${line%% *}"
  path="${line##* }"
  [ -n "$want" ] && [ -n "$path" ] || continue
  n_pinned=$((n_pinned + 1))
  pinned_paths="${pinned_paths}${path}
"
  if [ ! -f "$path" ]; then
    echo "FAIL: pinned guard is GONE: $path"
    echo "      A guard was deleted. If that was deliberate, re-pin (--update) so the"
    echo "      deletion appears in the diff instead of only in the absence of a failure."
    fail=1
    continue
  fi
  got="$(hash_of "$path")"
  if [ "$got" != "$want" ]; then
    echo "FAIL: guard MODIFIED without re-pinning: $path"
    echo "        pinned:  $want"
    echo "        on disk: $got"
    echo "      What changed (working tree vs the last commit that touched it):"
    git --no-pager diff -- "$path" 2>/dev/null | sed 's/^/        /' | head -40
    fail=1
  fi
done < "$MANIFEST"

# ── check 3 — the manifest itself was not emptied ───────────────────────────────
if [ "$n_pinned" -lt "$MIN_GUARDS" ]; then
  echo "FAIL: $MANIFEST pins only $n_pinned guard(s), below the floor of $MIN_GUARDS."
  echo "      Emptying the manifest is the same dodge as emptying the guards."
  fail=1
fi

# ...and EXACTLY, not merely at least (#316). A floor allowed to sit BELOW the count is slack,
# and slack is how this number reached 20 against a manifest of 24 — twice, by omission rather
# than by edit, because nothing ever asked. `--update` does not touch it, so the equality is
# what makes growing the guard set cost one visible line HERE, next to the pins it protects.
# A blind round pointed out that #316 was raising this by hand while arguing four files away
# that a floor must be raised with the set it guards; this is that argument applied here.
# ...and the count must be of DISTINCT paths. `n_pinned` counts LINES, so deleting a real guard
# and duplicating another manifest line kept the total at 26 with every gate green — a blind
# round did exactly that, and `--update` would then have normalised the duplicate away so nobody
# found it later. A floor over a multiset is not a floor over a set.
dupe_paths="$(awk '!/^#/ && NF == 2 {print $2}' "$MANIFEST" | sort | uniq -d)"
if [ -n "$dupe_paths" ]; then
  echo "FAIL: $MANIFEST lists the same path more than once:"
  echo "$dupe_paths" | sed 's/^/        /'
  echo "      A repeated line inflates the pinned COUNT without pinning another guard, so the"
  echo "      floor below stops being a floor. Delete the duplicate."
  fail=1
fi

if [ "$n_pinned" -gt "$MIN_GUARDS" ]; then
  echo "FAIL: $MANIFEST pins $n_pinned guard(s) but MIN_GUARDS is $MIN_GUARDS."
  echo "      The guard set grew and its floor did not. RAISE MIN_GUARDS to $n_pinned in this"
  echo "      script, in the same diff that adds the guard — a floor below the count is slack a"
  echo "      pin can later vanish into. Do NOT lower the count to fit the floor."
  fail=1
fi

# ── check 2 — no guard-shaped file escapes the manifest ─────────────────────────
while IFS= read -r g; do
  [ -n "$g" ] || continue
  case "
$pinned_paths" in
    *"
$g
"*) ;;
    *)
      echo "FAIL: UNPINNED guard on disk: $g"
      echo "      Every scripts/check-*.sh must be pinned, or the rename dodge works:"
      echo "      copy a guard, gut the copy, point the runner at it, ship it green."
      echo "      Pin it: scripts/check-guard-integrity.sh --update"
      fail=1
      ;;
  esac
done <<EOF
$(present_guards)
EOF

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "A guard changed. If the change is CORRECT, re-pin it in the same commit:"
  echo "    scripts/check-guard-integrity.sh --update && git add $MANIFEST"
  exit 1
fi

echo "PASS: all $n_pinned pinned guard(s) match their committed hashes (floor $MIN_GUARDS)."
exit 0
