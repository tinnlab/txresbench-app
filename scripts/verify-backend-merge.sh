#!/usr/bin/env bash
#
# verify-backend-merge.sh — a TXRESBENCH-LOCAL backend merge gate.
#
# The shared agent-kit `merge-gate.mjs` cannot fully validate a txr backend merge:
# it stages the merge with `git worktree add --detach` but NEVER inits the `sdk`
# submodule, so the staged tree has an EMPTY `sdk/` and every txr crate (which
# path-depends on `sdk/crates/*`) fails to build — C1 (cargo) + C3 (openapi-regen)
# die on the missing path-deps. `merge-gate.mjs` is symlinked from the agent-kit
# submodule (shared infra — not ours to edit); see AGENT_KIT_MERGE_GATE_GAP.md for
# the proposed upstream fix. Until then, THIS script is the real gate: it scripts
# the exact manual steps used to verify P8 (stage → merge → INIT sdk → seed config →
# clean cargo check → openapi-regen → generated-parity → .lifecycle strip).
#
# Usage:
#   scripts/verify-backend-merge.sh <branch> [--base <ref>] [--keep] [--skip-heavy]
#     <branch>       the feature branch to validate a merge of (required)
#     --base <ref>   base to merge onto (default: origin/main)
#     --keep         keep the staging worktree (else removed on exit)
#     --skip-heavy   skip C1 (cargo) + C3 (regen) — fast structural checks only
#
# Exit 0 = the merge onto <base> is backend-clean; non-zero = a gate FAILED.
set -u

# ---- args -----------------------------------------------------------------
BRANCH=""
BASE="origin/main"
KEEP=0
SKIP_HEAVY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --skip-heavy) SKIP_HEAVY=1; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$BRANCH" ]; then BRANCH="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi; shift ;;
  esac
done
[ -n "$BRANCH" ] || { echo "usage: $0 <branch> [--base <ref>] [--keep] [--skip-heavy]" >&2; exit 2; }

# ---- locate the repo ------------------------------------------------------
REPO="$(git rev-parse --show-toplevel)" || { echo "not in a git repo" >&2; exit 2; }
CARGO_DIR="src-app/server"
CARGO_PKG="txresbench"
GENERATED="src-app/ui/openapi/openapi.json src-app/ui/src/api-client/types.ts"

FAILS=0
step() { printf '  %-6s %-16s %s\n' "$1" "$2" "$3"; }
pass() { step "PASS" "$1" "$2"; }
fail() { step "FAIL" "$1" "$2"; FAILS=$((FAILS+1)); }
skip() { step "SKIP" "$1" "$2"; }

echo "== verify-backend-merge: $BRANCH onto $BASE (repo $REPO) =="

git -C "$REPO" fetch origin --quiet 2>/dev/null || true

# ---- staging worktree -----------------------------------------------------
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/txr-merge-gate-XXXXXX")"
cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "-- staging kept at $STAGING"
  else
    git -C "$REPO" worktree remove --force "$STAGING" >/dev/null 2>&1 \
      || rm -rf "$STAGING" 2>/dev/null || true
    git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! git -C "$REPO" worktree add --detach "$STAGING" "$BASE" >/dev/null 2>&1; then
  fail "STAGING" "worktree-add" "could not create staging worktree at $STAGING onto $BASE"
  exit 1
fi

# ---- MERGE ----------------------------------------------------------------
if git -C "$STAGING" merge --no-ff --no-edit "$BRANCH" >/dev/null 2>&1; then
  pass "MERGE" "staging-merge" "merged $BRANCH onto $BASE"
else
  CONFLICTS="$(git -C "$STAGING" diff --name-only --diff-filter=U | tr '\n' ' ')"
  git -C "$STAGING" merge --abort >/dev/null 2>&1 || true
  fail "MERGE" "staging-merge" "CONFLICTS merging $BRANCH onto $BASE: ${CONFLICTS:-<merge failed>}"
  echo "== RESULT: FAIL ($FAILS) — resolve conflicts, then re-run =="
  exit 1
fi

# ---- P2 merge-completeness (every branch file present in the merge) -------
MB="$(git -C "$REPO" merge-base "$BASE" "$BRANCH" 2>/dev/null)"
if [ -n "$MB" ]; then
  DROPPED=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -e "$STAGING/$f" ] || DROPPED="$DROPPED $f"
  done <<EOF
$(git -C "$REPO" diff --name-only --diff-filter=ACMR "$MB..$BRANCH")
EOF
  if [ -n "$DROPPED" ]; then fail "P2" "completeness" "branch files missing from merge:$DROPPED"
  else pass "P2" "completeness" "all branch files present in the merge"; fi
else
  skip "P2" "completeness" "no merge-base for $BASE..$BRANCH"
fi

# ---- C5 lifecycle-strip ---------------------------------------------------
if [ -d "$STAGING/.lifecycle" ]; then
  git -C "$STAGING" rm -r --quiet .lifecycle >/dev/null 2>&1 || true
fi
if [ -d "$STAGING/.lifecycle" ]; then fail "C5" "lifecycle-strip" ".lifecycle/ still present after strip"
else pass "C5" "lifecycle-strip" ".lifecycle/ stripped from the merge"; fi

# ---- THE FIX: init the sdk submodule in staging (merge-gate.mjs omits this) -
if git -C "$STAGING" submodule update --init sdk >/dev/null 2>&1 && [ -f "$STAGING/sdk/crates/txresbench-framework/Cargo.toml" ]; then
  pass "SUBMOD" "sdk-init" "sdk submodule checked out in staging (the merge-gate.mjs gap this script fills)"
else
  fail "SUBMOD" "sdk-init" "could not init the sdk submodule in staging — cargo/regen cannot build"
  echo "== RESULT: FAIL ($FAILS) =="
  exit 1
fi

if [ "$SKIP_HEAVY" = "1" ]; then
  skip "C1" "clean-build" "--skip-heavy"
  skip "C3" "regen-parity" "--skip-heavy"
  echo "== RESULT: $( [ "$FAILS" = 0 ] && echo PASS || echo "FAIL ($FAILS)" ) (structural only) =="
  [ "$FAILS" = 0 ]; exit $?
fi

# ---- seed the gitignored config/dev.yaml (openapi-regen reads CONFIG_FILE) --
CFG="$STAGING/$CARGO_DIR/config"
if [ ! -f "$CFG/dev.yaml" ] && [ -f "$CFG/dev.example.yaml" ]; then
  sed "s#CHANGE_ME_run_openssl_rand_base64_48#$(openssl rand -base64 48 2>/dev/null | tr -d '\n' || echo devsecret$(date +%s))#" \
    "$CFG/dev.example.yaml" > "$CFG/dev.yaml" 2>/dev/null \
    || cp "$CFG/dev.example.yaml" "$CFG/dev.yaml"
fi

# ---- C1 clean build from the merged tree (src-app/server) ------------------
( cd "$STAGING/$CARGO_DIR" && cargo clean -p "$CARGO_PKG" >/dev/null 2>&1 )
C1LOG="$STAGING/.c1.log"
if ( cd "$STAGING/$CARGO_DIR" && cargo check -p "$CARGO_PKG" ) >"$C1LOG" 2>&1; then
  pass "C1" "clean-build" "cargo check -p $CARGO_PKG clean from the merged tree"
else
  fail "C1" "clean-build" "cargo check -p $CARGO_PKG FAILED from a clean merged tree. Tail:"
  tail -n 15 "$C1LOG" | sed 's/^/      /'
fi

# ---- C3 regen-parity: regen from the merged backend, assert no drift -------
C3LOG="$STAGING/.c3.log"
if ( cd "$STAGING" && just openapi-regen ) >"$C3LOG" 2>&1; then
  DIFF="$(git -C "$STAGING" diff --stat -- $GENERATED | tr -d ' ' )"
  if [ -n "$DIFF" ]; then
    fail "C3" "regen-parity" "committed generated files do NOT match a fresh regen of the merged backend:"
    git -C "$STAGING" diff --stat -- $GENERATED | sed 's/^/      /'
  else
    pass "C3" "regen-parity" "generated openapi + types.ts match the merged backend"
  fi
else
  fail "C3" "regen-parity" "just openapi-regen FAILED (exit). Tail:"
  tail -n 12 "$C3LOG" | sed 's/^/      /'
fi

# ---- result ---------------------------------------------------------------
if [ "$FAILS" = 0 ]; then
  echo "== RESULT: PASS — the merge of $BRANCH onto $BASE is backend-clean =="
  exit 0
else
  echo "== RESULT: FAIL ($FAILS gate(s)) =="
  exit 1
fi
