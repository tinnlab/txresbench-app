#!/usr/bin/env bash
#
# check-no-study-domain-literals.sh — the study→project rename completeness guard.
#
# Asserts ZERO surviving `study`/`Study`/`studies`/`Studies`/`STUDY` DOMAIN literals
# in the product source, and ZERO surviving `study_extension`/`study-extension`
# path/identifier references (the 4-way extension-registry lockstep). A residual
# means the rename missed a spot.
#
# SCOPE: `src-app/**` product source (Rust + TS + SQL + JSON catalogs). EXCLUDED
# (the preserved allowlist — see .claude/... DEC-3):
#   - the git submodules `sdk/` + `agent-kit/` (shared framework; NOT under src-app,
#     so not scanned — the SDK owns its OWN generic `study_share_invite` example);
#   - the MECHANICALLY-GENERATED api-client (`api-client/types.ts`, `openapi/openapi.json`),
#     which regenerate deterministically from reviewed Rust source and carry the SDK's
#     preserved doc-comment example verbatim (an `study_share_invite` example on the
#     shared `NotificationDto` — sourced in `sdk/crates/txresbench-notification`, not txr);
#   - build/dep dirs (`target/`, `node_modules/`);
#   - the TxResBench module family `src-app/ui/src/modules/txr*` — `txrshell`, `txrlist`,
#     `txrintake`, and any future `txr`-prefixed module (the GRAPH.md / DEC-17 recorded
#     scope, a conservative default): the TxResBench app's board spec names screen B
#     "Your study" and the intake flow's own vocabulary IS `study` (`/study` route,
#     `mode: 'study'`, the B screen copy), so those literals are that product's
#     legitimate UI words, NOT residuals of the txresbench study→project rename this
#     guard enforces (two different products/domains). The exclude is the txr
#     module-family prefix ONLY — never any other path; the rename-purpose stays
#     intact everywhere else in `src-app/**` — a surviving `study` domain literal
#     outside the txr modules is still a FAIL (the re-pin of `guard-hashes.txt` in
#     the same commit is the deliberate-change path, `check-guard-integrity.sh --update`).
#
# Exit 0 = clean. Non-zero = surviving literals (printed).
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

RE='stud(y|ies)'
# grep -n output is `path:line:content`, so match the path portion (extension + ':').
EXCLUDE='(/node_modules/|/target/|/api-client/types\.ts:|/openapi/openapi\.json:|/src-app/ui/src/modules/txr)'

fail=0

# Scan GIT-TRACKED product source only (not the raw filesystem) — so gitignored
# dev artifacts (RUNTIME_FINDINGS.jsonl, caches) + a worktree path that happens to
# contain "study" (e.g. study-to-project-wt/) never produce a false positive.
FILES="$(git ls-files -- 'src-app/**' | grep -vE "$EXCLUDE")"

# ITEM-37 — FAIL CLOSED on a collapsed scan set. `src-app/**` is hard-coded: run this
# from a tree where that path does not exist (or where `git ls-files` returns nothing)
# and every `grep` below sees EMPTY input, finds no hits, and the guard prints PASS
# having scanned ZERO files. That fail-open shape produced four live incidents this
# round. The floor is a COMMITTED constant, so shrinking coverage needs an explicit,
# reviewable edit here. The strip node removed ~530 tracked files from src-app/
# (processor packages, env recipes, the dock/viz libs, the platform docs and
# suites), so the scan set measured 2026-11-12 is 869 files — the floor is set
# deliberately below the measurement (800); a further collapse below that point
# fails closed exactly as the sentinel is meant to.
MIN_FILES=800
n_files="$(printf '%s\n' "$FILES" | grep -c .)"
if [ "$n_files" -lt "$MIN_FILES" ]; then
  echo "FAIL: the src-app/ product-source scan set resolved to $n_files file(s), below the"
  echo "      floor of $MIN_FILES. The hard-coded 'src-app/**' pathspec no longer resolves"
  echo "      (moved/renamed, or this is not the repo root), so this guard was about to PASS"
  echo "      having scanned almost nothing. Re-point it, or lower MIN_FILES deliberately."
  exit 1
fi

hits="$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -IiEn "$RE" 2>/dev/null | grep -vE "$EXCLUDE")"
if [ -n "$hits" ]; then
  echo "FAIL: surviving study/Study/studies domain literals in src-app/ product source:"
  echo "$hits" | head -50
  fail=1
else
  echo "PASS: 0 surviving study domain literals in src-app/ product source."
fi

ext="$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -IEn "study[_-]extension" 2>/dev/null | grep -vE "$EXCLUDE")"
if [ -n "$ext" ]; then
  echo "FAIL: surviving study_extension / study-extension references (extension-registry lockstep):"
  echo "$ext" | head -30
  fail=1
else
  echo "PASS: 0 surviving study_extension / study-extension references."
fi

exit $fail
