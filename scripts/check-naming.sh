#!/usr/bin/env bash
# check-naming.sh: this repository is one app, TxResBench. Fails when a tracked text file or path still carries the name of the
# SDK or of the predecessor app. Allowed: licence and notice files, the rename tool, the rename map and the contribution guide,
# this script (its pattern spells the names), and migration SQL files: an applied migration is byte-frozen (sqlx stores its
# checksum in every database and refuses to start when the file changes, comments included), so a rename or wording sweep
# must skip `**/migrations/*.sql` entirely (src-app/server/src/database.rs, MERGED_MIGRATOR).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pat='ziee|cytoanalyst|CYTO_|(^|[^A-Za-z0-9])[Cc]yto([_-]|[^A-Za-z0-9]|$)'
skip=(':!LICENSE*' ':!**/LICENSE*' ':!**/NOTICE*' ':!THIRD-PARTY-NOTICES.md' ':!scripts/rename/*' ':!data/method-catalogue/*' ':!sdk/RENAME-MAP.md' ':!sdk/CONTRIBUTING-UPSTREAM.md' ':!.lifecycle/*' ':!scripts/check-naming.sh' ':!**/migrations/*.sql' ':!**/migrations-pg/*.sql')
bad=$(git grep -IilE "$pat" -- . "${skip[@]}" || true)
paths=$(git ls-files -- . "${skip[@]}" | grep -iE 'ziee|cytoanalyst|(^|[/_.-])cyto([_./-]|$)' || true)
if [ -n "$bad$paths" ]; then echo "check-naming: predecessor names found:" >&2; printf '%s\n%s\n' "$bad" "$paths" | sed '/^$/d' | head -40 >&2; exit 1; fi
echo "check-naming: ok"
