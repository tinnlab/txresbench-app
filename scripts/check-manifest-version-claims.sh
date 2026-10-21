#!/usr/bin/env bash
#
# check-manifest-version-claims.sh — the guard against the MANIFEST VERSION COLLISION
# (#300). Sibling of `check-processor-seed-versions.sh`; NOT a replacement for it.
#
# ── THE DEFECT, AND WHY THE OTHER GUARD STRUCTURALLY CANNOT SEE IT ──────────────
# `check-processor-seed-versions.sh` asks:
#
#     "did THIS branch move `version:` relative to ITS OWN merge base?"
#
# Two branches editing the same package both answer YES, independently and truthfully,
# while claiming the SAME number. Neither is wrong on its own terms; they are wrong
# TOGETHER, and a base-relative question can never observe a second branch. Four
# consecutive branches collided on exactly this line, and every one of them was caught
# only by a staging merge against a main that had already moved (#300).
#
# The defect is not the mechanism. It is the REFERENCE. So this guard changes the
# reference and keeps the mechanism:
#
#     REFERENCE A   `origin/main` AS IT IS NOW (the tip, never the merge base).
#                   The merge base is a snapshot of main taken when the branch started;
#                   it is by construction blind to everything that landed since, which
#                   is the entire population of versions a claim can collide with.
#     REFERENCE B   every OTHER live ref that has not merged yet.
#                   A already caught the collision — but only at the moment the other
#                   branch LANDED, i.e. at the same staging merge that catches it today.
#                   B is what removes the surprise: it sees the other claim while both
#                   branches are still in flight, which is what #300 asked for.
#
# ── THE THREE THINGS IT ASSERTS ─────────────────────────────────────────────────
# For every seed package this branch CHANGED (unchanged packages make no claim, so
# nothing is asserted about them):
#
#   A  TAKEN      the claimed version must be strictly ABOVE the version on
#                 `origin/main` right now. Equal = somebody already shipped your
#                 number; below = main moved past you while you were out.
#   B  CONTESTED  no other unmerged ref may state the same version for the same
#                 package. Both claims are legal against their own bases; only one
#                 can land.
#   C  STALE-BASE the version on `origin/main` must be the SAME version that was
#                 there at your merge base. If main moved the package while you were
#                 out, your number may still be free — but the JUDGEMENT behind it was
#                 made against a base that no longer exists. #300 records the concrete
#                 damage: a changelog entry reading "X arrived on main while this
#                 branch was out, and this is a bump relative to it" became FALSE when
#                 the branch landed two versions higher, and a --theirs/--ours
#                 resolution would have shipped the false sentence. Patch-vs-minor is
#                 the same problem: it is a decision about a base, and the base moved.
#
#                 C is SELF-CLEARING by the correct action and by no other: merge or
#                 rebase onto current main and the merge base becomes the tip.
#
#                 A STALE-BASE RED IS A POLICY OUTCOME, NOT A BUG. The number is free and
#                 uncontested; the branch reddens purely because main moved the package
#                 while it was out. That is deliberate — it is what caught #243's false
#                 changelog sentence — and it is stricter than "detect collisions", so it
#                 WILL redden branches that did nothing wrong. If you hit it, do not report
#                 it as a false positive: merge or rebase onto current main (the verdict is
#                 self-clearing by exactly that action) and re-read the changelog prose
#                 against the new base before you push.
#
# ── WHAT THIS GUARD DELIBERATELY DOES NOT DO ────────────────────────────────────
# It does NOT resolve anything. It does not pick a number, it does not merge prose,
# and it does not decide patch-vs-minor. #300 is explicit that resolving the changelog
# "needs judgement a merge tool cannot supply", and a guard that guessed would launder
# exactly the false sentence above into main under a green gate. It DETECTS, it NAMES
# every competing claim, it prints the lowest free number as ARITHMETIC rather than as
# advice, and it says which sentences a human has to re-read.
#
# ── THE LIMIT, STATED RATHER THAN DISCOVERED ────────────────────────────────────
# REFERENCE B is only as complete as the refs this clone has. On a box that has fetched
# nothing but `main`, `n_refs` is 0 and B asserts nothing — the summary SAYS SO, with the
# count, every run. That is deliberate and it is not a fail-open: A and C are unaffected
# and still hold in full, and refusing on a narrow clone would make this guard unrunnable
# in exactly the environments that need A most. `git fetch` is what widens B.
#
# What NO reference here can see is a claim that has never been pushed and exists only on
# somebody else's disk. Nothing short of a registry can, and #300 does not ask for one.
#
# ── NO DOMAIN VOCABULARY LIVES HERE ─────────────────────────────────────────────
# The package set is DERIVED from `src-app/packages/*/manifest.yaml`. This file names
# no package, no datatype id and no kind — a new one costs zero edits here, which is
# the invariant two previous `scripts/*` additions broke (#303, #324).
#
# ── USAGE ───────────────────────────────────────────────────────────────────────
#   scripts/check-manifest-version-claims.sh                     # origin/main .. working tree
#   scripts/check-manifest-version-claims.sh <main-ref>           # explicit main
#   scripts/check-manifest-version-claims.sh <main-ref> <head-ref># pin both (CI, tests)
#   MAIN_REF=upstream/main scripts/check-manifest-version-claims.sh
#
# Exit 0 = every claim is free and current. 1 = a collision or a stale base (printed).
# 2 = usage/setup (missing ref, collapsed package glob).
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

PACKAGES_DIR="src-app/packages"
[ -d "$PACKAGES_DIR" ] || { echo "no $PACKAGES_DIR here" >&2; exit 2; }

MAIN_INPUT="${1:-${MAIN_REF:-origin/main}}"
HEAD_REF="${2:-}"   # empty = the WORKING TREE, so an uncommitted claim is still a claim

if ! git rev-parse --verify --quiet "$MAIN_INPUT^{commit}" >/dev/null; then
  echo "check-manifest-version-claims: main ref '$MAIN_INPUT' not found." >&2
  echo "  This guard compares against main AS IT IS NOW; without that ref it has no" >&2
  echo "  reference at all and refuses rather than reporting a green it cannot support." >&2
  exit 2
fi
MAIN_TIP="$(git rev-parse --verify "$MAIN_INPUT^{commit}")" || exit 2
MERGE_BASE="$(git merge-base "$MAIN_INPUT" "${HEAD_REF:-HEAD}")" || exit 2

# ── the collapsed-glob floor (the ITEM-37 shape) ────────────────────────────────
# `[ -d ]` above proves only that the DIRECTORY exists. If the per-package layout is
# renamed the glob matches nothing, every loop body is skipped, and this prints a PASS
# having verified nothing at all.
MIN_PACKAGES=5
# The scan set. With a pinned HEAD_REF the WORKING TREE is not the branch under test
# (CI checks out main and passes `main feature`), so an on-disk glob would miss a
# package added on the branch or deleted on main — the exact shape a brand-new
# package ships as. Enumerate from the refs instead: HEAD_REF's tree unioned with main's tree,
# so a package present on either side is scanned. Without HEAD_REF the working tree IS
# the branch, and the on-disk glob is the right (and only) enumeration.
if [ -n "$HEAD_REF" ]; then
  scan_manifests="$( {
    git ls-tree -r --name-only "$HEAD_REF" -- "$PACKAGES_DIR" | grep -E "^$PACKAGES_DIR/[^/]+/manifest\\.yaml$"
    git ls-tree -r --name-only "$MAIN_TIP" -- "$PACKAGES_DIR" | grep -E "^$PACKAGES_DIR/[^/]+/manifest\\.yaml$"
  } | sort -u )"
else
  scan_manifests="$(for _m in "$PACKAGES_DIR"/*/manifest.yaml; do [ -e "$_m" ] && printf '%s\n' "$_m"; done)"
fi
n_manifests="$(printf '%s\n' "$scan_manifests" | sed '/^$/d' | wc -l | tr -d ' ')"
# The union above can satisfy the floor on MAIN's side alone while HEAD_REF's own tree
# holds nothing — every union manifest then hits the `git cat-file -e "$HEAD_REF:..."`
# skip below and this guard prints "clean" having examined zero packages (the ITEM-37
# shape, reachable in the CI mode). The number of packages this guard can actually
# examine is at most what HEAD_REF's tree holds, so floor HEAD_REF's OWN count too.
if [ -n "$HEAD_REF" ]; then
  n_head="$(git ls-tree -r --name-only "$HEAD_REF" -- "$PACKAGES_DIR" | grep -cE "^$PACKAGES_DIR/[^/]+/manifest\.yaml$")"
  [ "$n_head" -lt "$n_manifests" ] && n_manifests="$n_head"
fi
if [ "$n_manifests" -lt "$MIN_PACKAGES" ]; then
  echo "FAIL: found $n_manifests package manifest(s) under $PACKAGES_DIR, below the floor"
  echo "      of $MIN_PACKAGES. The '<pkg>/manifest.yaml' layout no longer resolves, so this"
  echo "      guard was about to PASS having checked nothing. Re-point it, or lower"
  echo "      MIN_PACKAGES deliberately."
  exit 1
fi

# `version:` at column 0 only — the seed reconciliation key. A nested `version:` under
# some other block is a different field and must not match.
read_version() { # <manifest text on stdin>
  sed -n 's/^version:[[:space:]]*["'\'']\{0,1\}\([^"'\''[:space:]]*\).*/\1/p' | head -n1
}

version_at() { # <rev> <path>  -> version, or empty when the file is absent there
  git show "$1:$2" 2>/dev/null | read_version
}

# -1 = $1 below $2, 0 = equal, 1 = $1 above $2. `sort -V` so 0.10.0 outranks 0.9.0.
ver_cmp() {
  if [ "$1" = "$2" ]; then echo 0; return; fi
  if [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]; then echo -1; else echo 1; fi
}

# The LOWEST number that is arithmetically free above every claim seen. Deliberately the
# next PATCH and nothing cleverer: a minor bump is a statement about behaviour and this
# guard has no way to know whether one is owed. Printed as the floor, never as the answer.
next_free() {
  case "$1" in
    *.*.*)
      local maj min pat
      maj="${1%%.*}"; pat="${1##*.}"; min="${1#*.}"; min="${min%%.*}"
      case "$maj$min$pat" in
        *[!0-9]*) echo "(above $1 — non-numeric, pick by hand)"; return ;;
      esac
      echo "$maj.$min.$((pat + 1))"
      ;;
    *) echo "(above $1 — not a three-part version, pick by hand)" ;;
  esac
}

# ── REFERENCE B's ref set ───────────────────────────────────────────────────────
# Every local and remote head that has NOT merged into main yet. `--no-merged` does the
# ancestry test in one call, which is what keeps this affordable against a few hundred
# refs. Symbolic `*/HEAD` entries are dropped (they alias a branch already in the list),
# and so is anything pointing at the same commit as the head under test.
#
# SELF IS EXCLUDED BY FULL REFNAME, NOT ONLY BY COMMIT, and that is not a nicety — it was a
# live false positive, found by running this guard against the branch that is in flight today.
# A branch's own `refs/remotes/origin/<branch>` sits at a DIFFERENT commit the moment there
# is one unpushed commit (or one unfetched push), so an object-identity test alone reports
# the branch as CONTESTING ITSELF: same package, same version, "another unmerged branch".
# A guard whose first real failure is the reader's own reflection is a guard the reader
# switches off, so the branch's OWN ref and its OWN remote-tracking ref are excluded too.
# TEST-4f is the control.
#
# The exclusion is deliberately NARROWER than the short branch name, and the trade-off is
# resolved in favour of not missing a real claimant. The old code dropped EVERY ref whose
# short name matched the branch's — which silently skipped a genuinely different branch
# with the same name on another remote (`refs/remotes/upstream/<branch>`), and a divergent
# force-pushed `origin/<branch>` that this branch does not track. Both are real collisions
# this guard exists to name, so the match is now on the FULL refname: `refs/heads/<branch>`
# plus the ONE remote ref the branch TRACKS (`%(upstream)`). The residual cost is
# stated rather than hidden: a branch that DOES track `origin/<branch>` cannot tell "my own
# remote-tracking ref, one push behind" from "my own remote-tracking ref, force-pushed by
# someone else" — both are the same ref at a different commit, and the tracking relationship
# is the only honest signal there is. Everything that merely shares the short name is a
# claimant again.
#
# DEDUPED BY COMMIT, not by name. A branch that exists both locally and on the remote is
# ONE claimant; listing it twice makes the failure look like two branches disagree with
# you when only one does, and a report a reader has to discount is a report they stop
# reading.
#
# CAPPED, and the cap REFUSES rather than truncates. A silently shortened ref set is a
# scan that can miss the very claimant this guard exists to name, while still printing a
# count that looks thorough — so passing the cap is exit 2 (raise it, in a committed
# line) and never a green over a partial scan.
LIVE_REFS_CAP=400
live_refs() {
  git for-each-ref --no-merged="$MAIN_INPUT" \
      --format='%(refname) %(objectname) %(symref)' \
      refs/heads refs/remotes 2>/dev/null |
  awk -v head="$HEAD_OID" -v self="$SELF_REF" -v upstream="$SELF_UPSTREAM" '
    NF >= 2 && $3 == "" && $2 != head {
      if (self != "" && $1 == self) next
      if (upstream != "" && $1 == upstream) next
      print $2, $1
    }' |
  sort -k1,1 -k2,2 |
  awk '!seen[$1]++ { print $2, $1 }'
}
HEAD_OID="$(git rev-parse --verify "${HEAD_REF:-HEAD}^{commit}" 2>/dev/null || echo '')"
# The branch under test, as a FULL refname. Empty on a detached HEAD, where only the commit
# test applies — which is correct: a detached HEAD has no branch to be confused with.
if [ -n "$HEAD_REF" ]; then
  case "$HEAD_REF" in
    refs/*) SELF_REF="$HEAD_REF" ;;
    *)      SELF_REF="refs/heads/$HEAD_REF" ;;
  esac
else
  SELF_REF="$(git symbolic-ref --quiet HEAD 2>/dev/null || echo '')"
fi
# The branch's OWN remote-tracking ref, as a full refname — the ONE ref it TRACKS, not every
# ref that shares its short name (see the trade-off above). Empty when the branch has no
# upstream (detached HEAD, or a local-only branch), in which case only the commit-OID and
# own-ref exclusions apply.
SELF_UPSTREAM=""
if [ -n "$SELF_REF" ]; then
  SELF_UPSTREAM="$(git for-each-ref --format='%(upstream)' "$SELF_REF" 2>/dev/null)"
fi
REFS="$(live_refs)"
n_refs=0
[ -n "$REFS" ] && n_refs="$(printf '%s\n' "$REFS" | wc -l | tr -d ' ')"
if [ "$n_refs" -gt "$LIVE_REFS_CAP" ]; then
  echo "check-manifest-version-claims: $n_refs unmerged refs exceeds LIVE_REFS_CAP=$LIVE_REFS_CAP." >&2
  echo "  Refusing to scan a truncated ref set: the claimant this guard exists to name" >&2
  echo "  could be the one dropped. Raise the cap in this script, deliberately." >&2
  exit 2
fi

fail=0
claimed_pkgs=0
quiet_pkgs=0

while IFS= read -r manifest; do
  [ -n "$manifest" ] || continue
  pkg_dir="$(dirname "$manifest")"
  pkg="$(basename "$pkg_dir")"

  # A package present on main but absent on this branch (the branch deleted it) makes no
  # version claim — nothing to assert. Only reachable in HEAD_REF mode, where the scan
  # set is the union of both trees.
  if [ -n "$HEAD_REF" ] && ! git cat-file -e "$HEAD_REF:$manifest" 2>/dev/null; then
    continue
  fi

  # Did this branch touch the package at all? No diff = no claim = nothing to assert.
  if [ -n "$HEAD_REF" ]; then
    git diff --quiet "$MERGE_BASE" "$HEAD_REF" -- "$pkg_dir" && { quiet_pkgs=$((quiet_pkgs + 1)); continue; }
  else
    git diff --quiet "$MERGE_BASE" -- "$pkg_dir" && { quiet_pkgs=$((quiet_pkgs + 1)); continue; }
  fi
  claimed_pkgs=$((claimed_pkgs + 1))

  # A package that did not exist at the merge base is NEW on this branch. Reported
  # explicitly (mirroring check-processor-seed-versions.sh) so the case is VISIBLE
  # rather than a silent `continue` — but unlike the sibling, the claim is still
  # checked: a new package states a version, and that version can collide.
  if ! git cat-file -e "$MERGE_BASE:$manifest" 2>/dev/null; then
    echo "new   $pkg — introduced on this branch; no base version to bump from, but the claim"
    echo "      is still checked against main and every unmerged ref below."
  fi

  if [ -n "$HEAD_REF" ]; then
    claimed="$(version_at "$HEAD_REF" "$manifest")"
  else
    claimed="$(read_version < "$manifest")"
  fi
  main_now="$(version_at "$MAIN_TIP" "$manifest")"
  base_ver="$(version_at "$MERGE_BASE" "$manifest")"

  if [ -z "$claimed" ]; then
    # `check-processor-seed-versions.sh` owns this failure; repeating its diagnosis here
    # would be a second voice on one defect. Say what is missing and move on.
    echo "FAIL  $pkg — no top-level \`version:\` in $manifest, so there is no claim to check."
    fail=1
    continue
  fi

  # ── REFERENCE B — who else is standing on this number right now ───────────────
  # A ref CLAIMS a version when its manifest states one ABOVE main's current value; that
  # is the only thing a not-yet-merged branch can be asserting. Equal to YOUR number is the
  # collision. Everything at or below main is a branch that is simply behind, and there are
  # many — so this filter, not a report, is what keeps the output readable.
  #
  # PERFORMANCE BOUND: this loop calls `git show` once per (unmerged ref x claimed
  # package) — up to LIVE_REFS_CAP=400 refs times the claimed packages, each a fresh
  # subprocess. Fine on this tree, but a single `git cat-file --batch` pass over the
  # refs' manifest blobs would collapse it to one process. Left as-is on purpose;
  # restructure only if the ref set grows.
  #
  # Does HEAD_OID already carry the claim under test? The descendant-skip below is
  # sound exactly when it does: a descendant of HEAD_OID then INHERITED the claim
  # rather than making a competing one. In HEAD_REF mode `claimed` is read from
  # HEAD_OID's own tree, so this is trivially true; in working-tree mode it is the
  # discriminator between "a stacked branch inherited my committed claim" and "a
  # rival branched off the same tip and committed the same version independently".
  # One `git show` per claimed package, off the per-ref hot loop.
  head_commit_ver=""
  [ -n "$HEAD_OID" ] && head_commit_ver="$(version_at "$HEAD_OID" "$manifest")"
  contested=''
  claimants=''
  ceiling="$claimed"
  [ -n "$main_now" ] && [ "$(ver_cmp "$ceiling" "$main_now")" = "-1" ] && ceiling="$main_now"
  while read -r rn roid; do
    [ -n "${rn:-}" ] || continue
    # A STACKED BRANCH IS NOT A RIVAL. feat-b containing feat-a's commit is the SAME
    # lineage, and one claim on one lineage is not a collision — in either direction.
    # A rival that is an ancestor of HEAD is already inside this branch (its claim IS
    # this branch's claim); a rival that is a descendant of HEAD inherits this branch's
    # claim rather than making a competing one. Without this, a stacked pair reddens
    # itself as CONTESTED with actively wrong advice ("bump to 0.6.1") — the same
    # self-reflection the header argues a reader switches off, one hop away.
    if [ -n "$HEAD_OID" ]; then
      # ANCESTOR direction: sound in BOTH modes. A rival inside HEAD's history is this
      # branch, whatever the subject is — its claim IS this branch's claim.
      git merge-base --is-ancestor "$roid" "$HEAD_OID" 2>/dev/null && continue
      # DESCENDANT direction: sound exactly when HEAD_OID already CONTAINS the claim
      # under test. "A descendant of HEAD_OID inherits my claim" requires HEAD_OID to
      # carry that version — true when the claim is committed (HEAD_OID's tree holds
      # it), FALSE in working-tree mode when the claim exists only in the working
      # tree, where HEAD_OID is the last COMMIT and the working tree's claim is not
      # in it. There a descendant may have branched off the same tip and committed
      # the SAME version independently — a real collision this skip would silence.
      # Gate it on containment, not on the mode.
      if [ "$head_commit_ver" = "$claimed" ]; then
        git merge-base --is-ancestor "$HEAD_OID" "$roid" 2>/dev/null && continue
      fi
    fi
    rver="$(version_at "$roid" "$manifest")"
    [ -n "$rver" ] || continue
    # A ref BELOW main's current value is not claiming anything — it is simply behind, and
    # most of them are. Measured on this tree while writing the guard: every (unmerged-ref
    # x package) pair whose version differs from main's numbers 1058 today, and even at
    # LIVE_REFS_CAP=400 refs x 24 packages the ceiling is ~9,600 — reporting every one of
    # them would drown the two real claims. A report a reader discounts is a report they
    # stop reading.
    if [ -n "$main_now" ] && [ "$(ver_cmp "$rver" "$main_now")" != "1" ]; then continue; fi
    [ "$(ver_cmp "$rver" "$ceiling")" = "1" ] && ceiling="$rver"
    # Reported by BRANCH, not by ref. A branch that exists locally AND on the remote is one
    # claimant; two lines saying the same thing read as two branches disagreeing with you,
    # and the identical lines collapse in the `sort -u` below. When the two genuinely differ
    # they carry different versions, so they survive as the two distinct claims they are.
    short="${rn#refs/heads/}"
    case "$rn" in
      refs/remotes/*) short="${rn#refs/remotes/}"; short="${short#*/}" ;;
    esac
    if [ "$rver" = "$claimed" ]; then
      contested="${contested}        ${short}  (claims $rver)
"
      claimants="${claimants}        ${short}  claims $rver   <-- THE SAME NUMBER AS YOU
"
    else
      claimants="${claimants}        ${short}  claims $rver
"
    fi
  done <<EOF
$REFS
EOF

  floor="$(next_free "$ceiling")"

  verdict=''
  # NO BUMP AT ALL is a different defect with a different owner. `check-processor-seed-versions.sh`
  # is the leg in front of this one and it says exactly what to do about it; repeating the
  # diagnosis here would put two voices on one failure and send the reader to the wrong repair
  # (this guard would say "TAKEN", which is true and useless — the number is not the problem).
  if [ -n "$base_ver" ] && [ "$claimed" = "$base_ver" ]; then
    echo "skip  $pkg — changed but \`version\` did not move from $base_ver, so no NEW claim is"
    echo "      made. That is check-processor-seed-versions.sh's failure, not this one's."
    continue
  fi
  if [ -n "$main_now" ]; then
    case "$(ver_cmp "$claimed" "$main_now")" in
      0)  verdict="TAKEN — \`$MAIN_INPUT\` is ALREADY at $claimed." ;;
      -1) verdict="BEHIND — \`$MAIN_INPUT\` moved past you to $main_now while this branch was out." ;;
    esac
  fi
  if [ -z "$verdict" ] && [ -n "$contested" ]; then
    verdict="CONTESTED — another unmerged branch states this exact version."
  fi
  if [ -z "$verdict" ] && [ -n "$main_now" ] && [ -n "$base_ver" ] && [ "$base_ver" != "$main_now" ]; then
    verdict="STALE BASE — the number is free, but it was chosen against $base_ver and main is now at $main_now."
  fi

  if [ -z "$verdict" ]; then
    echo "ok    $pkg — claims $claimed; free above \`$MAIN_INPUT\`'s $main_now, uncontested across $n_refs live ref(s)."
    # Not a failure — nobody has YOUR number. Printed anyway, because "who else is in this
    # package right now" is the thing a person needs before choosing patch-vs-minor, and it is
    # the thing nothing in this repo could tell them until now.
    if [ -n "$claimants" ]; then
      echo "      note: other unmerged branch(es) are also in this package —"
      printf '%s' "$claimants" | sort -u
      echo "      Their claims do not collide with yours, but whichever lands second will have to"
      echo "      re-read its own changelog prose against a base that has moved."
    fi
    continue
  fi

  fail=1
  echo "FAIL  $pkg — $verdict"
  echo "        this branch claims : $claimed   ($manifest)"
  echo "        main tip NOW       : ${main_now:-<package absent on main>}   (\`$MAIN_INPUT\` $MAIN_TIP)"
  echo "        at your merge base : ${base_ver:-<package absent at the merge base>}   ($MERGE_BASE)"
  if [ -n "$claimants" ]; then
    echo "        in flight elsewhere:"
    printf '%s' "$claimants" | sort -u
  else
    echo "        in flight elsewhere: no other unmerged ref claims this package (of $n_refs scanned)"
  fi
  echo "        lowest free number : $floor   (arithmetic, NOT a recommendation — see 2.)"
  echo "      TO RESOLVE — two steps, and only the first is mechanical:"
  echo "        1. Set \`version:\` above every claim listed above. $floor is the floor. A"
  echo "           MINOR bump instead is a statement about behaviour, and it has to be"
  echo "           re-decided against main AS IT IS NOW, not against the base you started"
  echo "           from. This guard cannot make that call and does not try to."
  echo "        2. RE-READ the manifest's changelog/notes prose before you push. An entry"
  echo "           written against ${base_ver:-your old base} can assert a relationship to a base that no"
  echo "           longer exists — \"N arrived on main while this branch was out\" becomes"
  echo "           FALSE the moment the branch lands somewhere else. Fixing the number and"
  echo "           leaving the sentence ships a manifest whose own history is wrong, and a"
  echo "           --theirs/--ours resolution does exactly that. No tool can decide what"
  echo "           the sentence should say instead. #300."
done <<EOF
$scan_manifests
EOF

echo
if [ "$fail" -ne 0 ]; then
  echo "check-manifest-version-claims: FAILED." >&2
  echo "  reference: \`$MAIN_INPUT\` tip $MAIN_TIP (NOT the merge base $MERGE_BASE)," >&2
  echo "  plus $n_refs unmerged ref(s). $claimed_pkgs package(s) claimed a version." >&2
  exit 1
fi

echo "check-manifest-version-claims: clean."
echo "  reference: \`$MAIN_INPUT\` tip $MAIN_TIP — main AS IT IS NOW, never the merge base"
echo "  $MERGE_BASE, which cannot see anything that landed after this branch started."
echo "  $claimed_pkgs package(s) claimed a version, $quiet_pkgs unchanged (no claim made),"
echo "  cross-checked against $n_refs unmerged ref(s)."
if [ "$n_refs" -eq 0 ]; then
  echo "  NOTE: the in-flight half of this check DID NOT RUN — this clone has 0 unmerged"
  echo "  refs, so REFERENCE B scanned nothing. A and C above still hold in full; only the"
  echo "  cross-branch collision scan is absent. Widen it with \`git fetch\` — this guard"
  echo "  never fetches, because a guard must not mutate the repo."
fi
exit 0
