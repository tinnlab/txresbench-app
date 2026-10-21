#!/usr/bin/env bash
#
# install-guard-hooks.sh — wire `check-guard-integrity.sh` into this clone's pre-push
# hook (artifact-model ITEM-22). Idempotent; safe to re-run.
#
# ── WHY THIS IS AN INJECTION AND NOT A HOOK FILE ────────────────────────────────
# `agent-kit/scripts/install-agent-hooks.sh` OWNS `$(git rev-parse --git-common-dir)/hooks/pre-push`
# and writes it wholesale from a heredoc. agent-kit is a shared SUBMODULE consumed by
# several apps, so forking that heredoc to add a cytoanalyst-specific check would put a
# repo-local concern into shared infrastructure and guarantee a merge conflict later.
#
# Instead this inserts a MARKED BLOCK immediately after the shebang of whatever
# pre-push hook is already there (creating a minimal one if there is none). The block
# runs FIRST, before the lifecycle gate, and is replaced — not duplicated — on re-run.
#
#   ORDERING NOTE: if you re-run `agent-kit/scripts/install-agent-hooks.sh`, it
#   rewrites the hook and drops this block. Re-run THIS script afterwards. That is a
#   consequence of not forking the submodule and is the cheaper of the two costs.
#
# Git hooks are per-clone and never committed, so this is a setup step, not a gate. The
# gate that always runs is `just check-invariants` (see the justfile).
set -euo pipefail

TOP="$(git rev-parse --show-toplevel)"
HOOK_DIR="$(git rev-parse --git-common-dir)/hooks"
HOOK="$HOOK_DIR/pre-push"
BEGIN='# >>> cytoanalyst guard-integrity >>>'
END='# <<< cytoanalyst guard-integrity <<<'

mkdir -p "$HOOK_DIR"

if [ ! -f "$HOOK" ]; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$HOOK"
  chmod +x "$HOOK"
fi

# Drop any previous copy of the block, then re-insert after the shebang.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
awk -v b="$BEGIN" -v e="$END" '
  index($0, b) == 1 { skip = 1; next }
  index($0, e) == 1 { skip = 0; next }
  skip != 1 { print }
' "$HOOK" > "$TMP"

BLOCK="$BEGIN
# Guard the guards (ITEM-22): a guard must not be weakenable in silence. Cheap
# (sha256 over ~7 small files); no build, no network. Re-install with
# scripts/install-guard-hooks.sh after re-running agent-kit's hook installer.
if [ -x \"\$(git rev-parse --show-toplevel)/scripts/check-guard-integrity.sh\" ]; then
  \"\$(git rev-parse --show-toplevel)/scripts/check-guard-integrity.sh\" || {
    echo \"pre-push: guard integrity FAILED — a committed guard changed without being re-pinned.\" >&2
    echo \"          Deliberate? scripts/check-guard-integrity.sh --update && git add scripts/guard-hashes.txt\" >&2
    exit 1
  }
fi
$END"

{
  head -n 1 "$TMP"
  printf '%s\n' "$BLOCK"
  tail -n +2 "$TMP"
} > "$HOOK"
chmod +x "$HOOK"

echo "installed: $HOOK"
echo "  block:   $BEGIN … $END"
echo "  runs:    $TOP/scripts/check-guard-integrity.sh"
