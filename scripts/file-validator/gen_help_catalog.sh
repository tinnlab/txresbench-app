#!/usr/bin/env bash
# Regenerate the Help page's problem-code catalogue (qa-fixes2 ITEM-3).
#
# The catalogue is the file validator's declaration tables (`RULES` +
# `APP_RULES`) rendered to the committed JSON the Help page imports:
# `src-app/ui/src/modules/txrhelp/validator-catalog.json`. The drift pin is a
# SERVER test (`file_validator::catalog::catalog_roundtrip_and_committed_copy`)
# that byte-compares that file with a fresh render, so the only writer is this
# script, and a validator declaration change fails the server test until the
# file is regenerated and committed here.
#
# Usage (from the repo root; every process through ops/cap.sh, CAP_CPUS=2):
#   bash scripts/file-validator/gen_help_catalog.sh
#
# The test below intentionally runs ONLY the catalogue test (the regen writes
# the file on first run, then the same invocation's non-regenerated assertion
# is skipped by the env-var branch) — the crate's other suites are the
# developer's own next call.
set -euo pipefail

export TXRESBENCH_CATALOG_REGEN=1
export CAP_CPUS="${CAP_CPUS:-2}"
exec /data/share/pbya/sigtrans/ops/cap.sh cargo test -p cytoanalyst --lib \
  -- file_validator::catalog::catalog_roundtrip_and_committed_copy
