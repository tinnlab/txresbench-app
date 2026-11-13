#!/usr/bin/env bash
# check-dead-refs.sh: no tracked file may mention a unit the strip-single-cell
# node removed. Fails when a tracked file (outside the bookkeeping/dev-tooling
# trees and the guards that exist to record the removals) mentions a removed
# PATH or CRATE.
#
# The removed units are exactly the ones this node deleted (map §1-§12 + the
# owner verdicts): the processor-package tree and its docs/guards/recipes, the
# env recipe tree + pins, the coercion corpus, the dock/viz libs (workspaces +
# their npm closure), the seven platform server modules + their tests +
# migrations, the platform UI modules + core dirs, the removed SDK crates, the
# removed workflows and the platform docs. The token table below is the
# deliberate, committed record of that list: a unit is re-added only by editing
# this table together with the unit, and a future removal extends it.
#
# SCOPE — the plan's words are "a removed path or crate". The tokens below are
# therefore path forms (with their directory) and crate/package names. A BARE
# guard/recipe basename in history prose (e.g. "check-py" in a floor ledger) is
# not a path and is not scanned: the removal history belongs to the node's own
# records, and this guard exists to catch unresolved functional references, not
# to police an index of what has gone.
#
# What is NOT scanned (recorded exclusions — each is its unit's owner decision,
# not a per-file allowlist):
#   - `.lifecycle/`, `dev/`          worker bookkeeping (the node's own records)
#   - `agent-kit/`, `.claude/`       kept whole by owner verdict (the skills use
#                                    the platform's names as generic examples)
#   - `scripts/rename/*`, `sdk/RENAME-MAP.md`, `sdk/CONTRIBUTING-UPSTREAM.md`,
#     `src-app/ui/scripts/check-rename-mechanical.mjs` + its test
#                                    the rename tooling's SUBJECT is the old
#                                    names; it exists to record them
#   - this file itself               it is the token table
# THIRD-PARTY-NOTICES.md is NOT skipped: it is regenerated from the pruned
# lockfiles, so a removed package name in it would be a live lockfile reference.
# If a kept product file needs to mention a removed unit, the file must go into
# the skip list above with its reason — a bare mention is a dead reference.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

pat='src-app/packages|src-app/env-rootfs|src-app/testdata|src-app/libs|docs/analysis-workbench|docs/research/|docs/design/|docs/DATA_STORAGE_REDESIGN|docs/sdk-lazification-measurements|docs/runbooks/env-image-republish|src-app/server/src/modules/(datatype|dataset|drafts|extensions|project|provenance|workstore)/|src-app/server/tests/(dataset|datatype|drafts|project|provenance|workstore|extensions|analysis|geneset|model_coverage|tiledb_serve)|src-app/ui/src/modules/(workbench|datasets|project|provenance|workstore|datatypes|visualization|processors|sandbox|jobs|dataset)/|src-app/ui/src/core/(datatypes|provenance|workstore)/|src-app/ui/src/core/passwordPolicy\.ts|sandbox/processors|src-app/ui/scripts/(lint-layer-boundary|lint-positional-declaration|capture-surface-baseline|tag-narrowing|viz-|resolve-viz-port|resolve-visual-port|e2e-inventory)|src-app/ui/playwright\.(viz|visual)\.config\.ts|src-app/ui/tests/(viz-e2e|visual)|src-app/ui/\.viz-smoke\.mjs|scripts/(publish-env-rootfs|fetch-env-rootfs|build-env-rootfs-local|verify-r-rootfs-local|env-lock-of|dev-sandbox-bootstrap|e2e-processors-preflight|check-env-loop|check-recipe-pins|check-package-suites|check-processor-seed-versions|check-manifest-version-claims|check-kinds-zero-core|check-derived-vocabulary|check-viz-producer-magnitudes|check-design-citations|check-no-legacy-wire|coercion-parity|stripe-sign|floci-gcp-gcs-compat-proxy|lib/zero-core-surface)\.|txresbench-sandbox([^a-z0-9_-]|$)|sandbox-guest-agent([^a-z0-9_-]|$)|sandbox-vm-launcher([^a-z0-9_-]|$)|sandbox-vm-protocol([^a-z0-9_-]|$)|txresbench-hardware([^a-z0-9_-]|$)|txresbench-onboarding([^a-z0-9_-]|$)|txresbench-seed([^a-z0-9_-]|$)|txresbench-server-update([^a-z0-9_-]|$)|skeleton-server([^a-z0-9_-]|$)|@txresbench/dock|@txresbench/viz|@deck\.gl|@luma\.gl|@hms-dbmi/viv|@vivjs|@observablehq/plot|env-images\.yml|saas-matrix\.yml|env-pins\.generated'

skip=(
  ':!.lifecycle/*'
  ':!dev/*'
  ':!agent-kit/*'
  ':!.claude/*'
  ':!scripts/rename/*'
  ':!sdk/RENAME-MAP.md'
  ':!sdk/CONTRIBUTING-UPSTREAM.md'
  ':!src-app/ui/scripts/check-rename-mechanical.mjs'
  ':!src-app/ui/scripts/check-rename-mechanical.test.mjs'
  ':!scripts/check-dead-refs.sh'
)
bad=$(git grep -IilE "$pat" -- . "${skip[@]}" || true)
if [ -n "$bad" ]; then
  echo "check-dead-refs: removed path/crate mentioned in:" >&2
  printf '%s\n' "$bad" | head -40 >&2
  echo "  (a removed path/crate crept back — reword it, or add the file to the" >&2
  echo "   skip list with its reason, never a bare mention)" >&2
  exit 1
fi
echo "check-dead-refs: ok"
