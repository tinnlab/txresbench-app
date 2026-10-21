#!/usr/bin/env bash
# check-substrate-retired.sh — the acceptance guard for INV-1 (TEST-6/TEST-7).
#
# The cloud-sim substrate is standardized on floci (S3 + EKS-k3s) + floci-gcp
# (GCS + GKE-k3s) ONLY. This guard fails if any LIVE reference to the RETIRED
# substrate (fake-gcs-server / MinIO / kind / k3d) remains in the tracked tree,
# and if the justfile is missing the floci-gcp recipes or still exposes the
# retired ones.
#
# A historical mention is allowed IF its line carries the `RETIRED-SUBSTRATE`
# marker — that is how a "we used to use X, here's why we don't" note is kept
# without counting as a live reference. Everything else must be gone.
#
# Scope: the product tree only — excludes target/, node_modules/, .git/, the
# `sdk` submodule, and `.lifecycle/` (process artifacts, stripped at merge).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

fail=0

# Unambiguous retired-substrate tokens (NOT the bare word "kind" — that is a
# legitimate k8s manifest field and English word; only substrate-specific forms).
TOKENS='fake-gcs|fake_gcs|fsouza|minio|kind-config|cloud-sim-kind|kind (create|delete|get|load|export|version)|k3d'
#
# SCOPE: the CLOUD-SIM TEST SUBSTRATE surface + the product native-GCS/S3
# OBJECT-STORE SEAM this substrate exercises (workstore object_store) — the
# docker-compose, the scripts, the justfile recipes, the tests whose env contract
# the substrate feeds, AND the `S3Store`/config code the repointed contract drives
# (so a stale `fake-gcs`/`minio` comment in the seam this feature owns is caught).
# Deliberately OUT of scope: product ARCHITECTURE docs (docs/** legitimately name
# MinIO/S3/GCS as supported ObjectStore backends — a product capability, not the
# retired test substrate); other epics' substrates (src-app/billing-sim/**); and a
# `.disabled` CI workflow. The guard script + the proxy/floci scripts' own tagged
# historical notes are excluded/skipped.
mapfile -t files < <(git ls-files \
  'src-app/cloud-sim/**' \
  'scripts/cloud-sim*.sh' \
  'scripts/check-kinds-zero-core.sh' \
  'justfile' \
  'src-app/server/tests/**' \
  'src-app/server/src/modules/workstore/object_store/**' \
  'src-app/server/src/modules/workstore/config.rs' \
  ':!:scripts/check-substrate-retired.sh' 2>/dev/null)

hits=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  # A file that DECLARES itself a retirement stub in its header (first 8 lines
  # contain "RETIRED-SUBSTRATE (historical stub)") is wholly historical — skip it.
  if head -n 8 "$f" 2>/dev/null | grep -q 'RETIRED-SUBSTRATE (historical stub)'; then
    continue
  fi
  # Otherwise grep each matching line; drop lines tagged RETIRED-SUBSTRATE (historical notes).
  while IFS= read -r line; do
    case "$line" in *RETIRED-SUBSTRATE*) continue;; esac
    echo "LIVE retired-substrate ref: $f: $line"
    hits=$((hits + 1))
  done < <(grep -inE "$TOKENS" "$f" 2>/dev/null)
done
if [ "$hits" -ne 0 ]; then
  echo "FAIL: $hits live reference(s) to the retired substrate remain (tag historical notes with RETIRED-SUBSTRATE, or repoint at floci/floci-gcp)."
  fail=1
else
  echo "OK: no live fake-gcs/MinIO/kind/k3d references (INV-1)."
fi

# justfile recipe surface (TEST-7): the floci-gcp recipes exist; the retired ones are gone.
need_recipe() { grep -qE "^$1:" justfile || { echo "FAIL: justfile missing recipe '$1'"; fail=1; }; }
gone_recipe() { grep -qE "^$1:" justfile && { echo "FAIL: justfile still exposes retired recipe '$1'"; fail=1; }; }
need_recipe 'cloud-sim-floci-gcp-up'
need_recipe 'cloud-sim-floci-gcp-down'
need_recipe 'cloud-sim-test-floci-gcs'
gone_recipe 'cloud-sim-up'
gone_recipe 'cloud-sim-down'
gone_recipe 'cloud-sim-kind-up'
gone_recipe 'cloud-sim-test-l1'
gone_recipe 'cloud-sim-test-l2'

[ "$fail" -eq 0 ] && echo "check-substrate-retired: PASS" || echo "check-substrate-retired: FAIL"
exit "$fail"
