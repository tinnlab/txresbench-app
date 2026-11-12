#!/usr/bin/env bash
# check-naming.sh: this repository is one app, TxResBench. Fails when a tracked text file or path still carries the name of the
# SDK or of the predecessor app. Allowed: licence and notice files, the rename tool, the rename map and the contribution guide,
# this script (its pattern spells the names), and the applied migrations listed in `frozen` below.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pat='ziee|cytoanalyst|CYTO_|(^|[^A-Za-z0-9])[Cc]yto([_-]|[^A-Za-z0-9]|$)'
skip=(':!LICENSE*' ':!**/LICENSE*' ':!**/NOTICE*' ':!THIRD-PARTY-NOTICES.md' ':!scripts/rename/*' ':!data/method-catalogue/*' ':!sdk/RENAME-MAP.md' ':!sdk/CONTRIBUTING-UPSTREAM.md' ':!.lifecycle/*' ':!scripts/check-naming.sh')
# Applied migrations are byte-frozen: sqlx stores each one's checksum in every database and refuses to start when a file
# differs, comments included. These kept their pre-rename comments so databases created before the rename still open.
# Never edit an applied migration; add a new one instead.
frozen=(
  ':!sdk/crates/txresbench-auth/migrations/202607140050_auth_schema.sql'
  ':!sdk/crates/txresbench-notification/migrations/202607140190_notification_schema.sql'
  ':!sdk/crates/txresbench-seed/migrations/202607150000_seed_ledger.sql'
  ':!src-app/server/src/modules/account/migrations/202608040012_account_baseline.sql'
  ':!src-app/server/src/modules/account/migrations/202609040001_account_members_manage.sql'
  ':!src-app/server/src/modules/file/migrations/202608030008_file_baseline.sql'
  ':!src-app/server/src/modules/workstore/migrations/202608290090_infra_config.sql'
)
skip+=("${frozen[@]}")
bad=$(git grep -IilE "$pat" -- . "${skip[@]}" || true)
paths=$(git ls-files -- . "${skip[@]}" | grep -iE 'ziee|cytoanalyst|(^|[/_.-])cyto([_./-]|$)' || true)
if [ -n "$bad$paths" ]; then echo "check-naming: predecessor names found:" >&2; printf '%s\n%s\n' "$bad" "$paths" | sed '/^$/d' | head -40 >&2; exit 1; fi
echo "check-naming: ok"
