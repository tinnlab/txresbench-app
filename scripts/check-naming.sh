#!/usr/bin/env bash
# check-naming.sh: this repository is one app, TxResBench. Fails when a tracked text file or path still carries the name of the
# SDK or of the predecessor app. Allowed: licence and notice files, the rename tool, the rename map and the contribution guide.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pat='ziee|cytoanalyst|CYTO_|(^|[^A-Za-z0-9])[Cc]yto([_-]|[^A-Za-z0-9]|$)'
# `scripts/check-naming.sh` skips its own file: the predecessor-name PATTERN is spelled in it.
skip=(':!LICENSE*' ':!**/LICENSE*' ':!**/NOTICE*' ':!THIRD-PARTY-NOTICES.md' ':!scripts/rename/*' ':!data/method-catalogue/*' ':!sdk/RENAME-MAP.md' ':!sdk/CONTRIBUTING-UPSTREAM.md' ':!.lifecycle/*' ':!scripts/check-naming.sh')
bad=$(git grep -IilE "$pat" -- . "${skip[@]}" || true)
paths=$(git ls-files -- . "${skip[@]}" | grep -iE 'ziee|cytoanalyst|(^|[/_.-])cyto([_./-]|$)' || true)
if [ -n "$bad$paths" ]; then echo "check-naming: predecessor names found:" >&2; printf '%s\n%s\n' "$bad" "$paths" | sed '/^$/d' | head -40 >&2; exit 1; fi
echo "check-naming: ok"
