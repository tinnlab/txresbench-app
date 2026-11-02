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
# Repo-root `scripts/check-*.sh` AND `scripts/check-*.mjs` — the committed
# architectural-invariant guards. The `.mjs` half was added when `check-pub-orphans.mjs`
# landed: a guard whose whole job is to fail a build is worth nothing if it can be gutted in
# a diff nobody reads, and the language it happens to be written in has no bearing on that.
# Widening also swept in the pre-existing `check-test-scope-lists.mjs` and
# `check-package-suites.mjs`, which were unpinned
# for the same accidental reason. The
# frontend's `src-app/ui/scripts/lint-no-domain-in-builtin.mjs` is deliberately NOT
# pinned here: it is under active per-(file,token) ratchet development by its own
# owner, and its committed `domain-baseline.json` already makes weakening it a visible
# diff. Widening this scope is a one-line GUARD_GLOBS edit — which `--update` will
# then make reviewable, like everything else.
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
# #196 R7 — `scripts/lib/*.sh` joins the set. It is not named `check-*`, but it is guard
# LOGIC: it holds the env-id grammar the vocabulary guard validates against and the
# behavioural image verifier the publish path gates on. Unpinned, either could be edited
# to weaken a guard without the pin diff a reviewer reads. The line is what a file DOES,
# not what it is called.
# #287 R4 — `scripts/coercion-parity*` joins the set. It is not named `check-*`, but those
# four files are the RUNNER and the three language implementations of the `check-coercion`
# gate, and they were pinned by nothing: replacing
# `coercion-parity.mjs` with `process.exit(0)` left this script reporting PASS over all 17
# pins while the gate it fronts had become a no-op. That is precisely the rename dodge check
# 2 exists to stop, arriving through a name this glob did not cover. The line above already
# says it: what a file DOES, not what it is called.
#
# Stated precisely, because the first draft of this note overclaimed "the entire body of the
# gate": it is not. `coercion-parity.mjs` spawns reader 3 through
# `src-app/ui/scripts/ts-resolve.mjs` (and the hooks it registers), which is executed by the
# gate and is covered by no glob here. That file is another area's, under its own owner, so
# it is FILED rather than pinned from this branch — the same reasoning that keeps
# `lint-no-domain-in-builtin.mjs` out of this set.
#
# `scripts/coercion-parity*` is a `git ls-files` PATHSPEC, where `*` also crosses `/`. It
# matches exactly the four intended files today; a future `scripts/coercion-parity-*/`
# directory would have its contents treated as unpinned guards. That fails CLOSED (a noisy
# FAIL, never a silent pass), so it is a maintenance note, not a hole.
# #311/#324 R1 — `scripts/lib/*.sh` becomes `scripts/lib/*`. `scripts/lib/` is the directory
# this file already declares to be guard LOGIC ("The line is what a file DOES, not what it is
# called"), and #311 put a DECLARATION in it: `zero-core-surface.txt` is the single file
# `check-derived-vocabulary.sh` and `spatial-types`' zero-core pytest both read for their scan
# surface and their exemption rule. An extension in the glob is the same enumeration #304 had
# to remove from the build surface one file over — a `.txt` that decides what a guard scans is
# guard logic by this file's own test, and an unpinned one would let the surface be narrowed in
# a diff with no pin next to it, which is the exact laundering check 1 exists to stop.
#
# THE SECOND EFFECT, stated because "more files pinned" is only half of what this does. Being
# pinned here is key 1 of the `cyto:guard-vocabulary` exemption in check-derived-vocabulary.sh,
# so this manifest doubles as that exemption's eligibility list — widening the glob makes any
# file dropped into scripts/lib/ exemption-ELIGIBLE, not merely pinned. That is bounded the same
# way everything else here is (the marker must still be declared IN the file, in a diff a human
# reads, and MIN_GUARDS moves with the set), but it is a coupling worth knowing about before the
# next widening rather than after it.
GUARD_GLOBS=('scripts/check-*.sh' 'scripts/check-*.mjs' 'scripts/lib/*' 'scripts/coercion-parity*')

# Measured 2026-09-07 (#316): 26 guards. A manifest shorter than this is a gutted manifest.
#
# The floor was left at 9 while the manifest grew from 10 to 21, which let twelve pins be
# dropped before check 3 could fire — and dropping a pin AND its file makes checks 1 and 2
# silent too, so the floor was the only thing left and it was not watching. Raised with the
# count, as it should have been each time the set grew.
#
# #316 RAISED IT AGAIN, AND THAT BRANCH ALMOST REPEATED THE OMISSION IT WAS FIXING. It added
# two guards (24 -> 26) and left this at 20, restoring six pins of slack — while its own
# `AGGREGATE_FLOORS` comment, four files away, argued that a floor is raised with the set it
# guards. A blind auditor caught it. The rule has no exception for the branch enforcing it:
# when the manifest grows, this number grows in the same diff.
# #311/#324: 26 -> 27 with `scripts/lib/zero-core-surface.txt`, in the same diff that adds it,
# which is what the paragraph above demands and what #316 had to be told twice.
# #355: 27 -> 29 with `scripts/check-design-citations.mjs` and its control suite
# `scripts/check-design-citations.test.mjs`, in the same diff that adds them. Both are matched
# by the existing `scripts/check-*.mjs` glob, so check 2 would have reported them as unpinned
# guards on the first run — which is the glob doing its job, and the reason this number moves
# here rather than being noticed later.
# #300: 29 -> 31 with `scripts/check-manifest-version-claims.sh` and its controls
# `scripts/check-manifest-version-claims.test.mjs`, in the same diff that adds both. The
# controls are pinned for the reason `check-design-citations.test.mjs` and
# `check-pub-orphans.test.mjs` are: they are the only thing that establishes the guard beside
# them still BITES, so gutting them is gutting the guard one level up.
# App branch (4001939): 31 -> 32 with `scripts/check-network-allowlist.sh` and its controls
# `scripts/check-network-allowlist.test.mjs`. Both entered the tree in that app-audit commit
# (licence/network audit) and were never pinned — the two entries this branch's ITEM-27
# re-pin adds. The pin-before-use rule applies to a guard the app SHIPS: the network
# allowlist is the contract for "only method-env + update-check network use", and an
# unpinned copy can be gutted in a diff nobody reads, exactly like any other guard.
MIN_GUARDS=32

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
    echo "# guard-hashes.txt — the COMMITTED pins for scripts/check-*, scripts/lib/* and"
    echo "# scripts/coercion-parity* (ITEM-22, widened #287 R4 and #311/#324 R1)."
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
