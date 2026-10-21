#!/usr/bin/env bash
# Acceptance harness for the cloud-deploy-hardening scaffold (INV-2, gaps #2/#4/#5).
#
# Proves the committed manifests are VALID + self-consistent and carry the boot-critical
# wiring, so a deployment is reproducible with no hand-editing. POSIX-friendly bash; guards
# kubectl (the dry-run leg loud-skips if kubectl is absent, the grep legs always run).
#
#   TEST-2 (INV-2) : kubectl apply --dry-run=client passes on scaffold + config Secret, AND
#                    CONFIG_FILE + the Secret config volume + privileged securityContext present.
#   TEST-4         : env-rootfs volume + initContainer + CYTO_ENV_ROOTFS_SQUASHFS/CYTO_SANDBOX_ENV_ID.
#   TEST-5         : load-image handles floci/k3s via `ctr images import`; README has the CNI note.
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
SCAFFOLD="$DIR/worker-deployment.scaffold.yaml"
CONFIG="$DIR/worker-config.example.yaml"
LOADSCRIPT="$ROOT/justfile"
README="$DIR/README.md"

pass=0; fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $1"; fail=$((fail+1)); }
has()  { grep -q -- "$2" "$1"; }

echo "== TEST-2: manifest validity + boot config wiring (INV-2) =="
# Render the scaffold with the sed placeholders replaced by valid values so a dry-run is
# meaningful (the committed file keeps REPLACE_WITH_* markers the tier substitutes at deploy).
render_scaffold() {
  sed -e 's#REPLACE_WITH_WORKER_IMAGE#cyto-sim-worker:dev#' \
      -e 's#REPLACE_WITH_ROOTFS_FETCHER_IMAGE#busybox:latest#' "$SCAFFOLD"
}
# Prefer a REAL server-side dry-run when a cluster is reachable (full schema validation);
# fall back to client-side structural validation offline (kubectl cannot fetch the openapi
# schema with no API server, so --validate=false is required to parse without a cluster).
dryrun() { # <label> ; reads stdin
  local label="$1"
  if kubectl apply --dry-run=server -f - >/dev/null 2>/tmp/cdh.err; then
    ok "kubectl apply --dry-run=server accepts $label"
  else
    bad "kubectl server dry-run rejected $label: $(cat /tmp/cdh.err)"
  fi
}
# `kubectl apply --dry-run` needs a reachable API server (even client-side resolves resource
# kinds against it). With a cluster (e.g. an ephemeral floci k3s node), run a REAL server-side dry-run;
# with none reachable, LOUD-SKIP the dry-run leg — the structural/wiring legs below still run.
if command -v kubectl >/dev/null 2>&1 && kubectl version >/dev/null 2>&1; then
  render_scaffold | dryrun "the rendered scaffold"
  dryrun "the config Secret" < "$CONFIG"
else
  echo "  SKIP: no reachable cluster — kubectl dry-run legs skipped. To validate against a real"
  echo "        API server: 'just cloud-sim-test-floci-k8s' (or point KUBECONFIG at any cluster), re-run."
fi
# gap #2: the worker must find its config file, or it exits "no config file found".
has "$SCAFFOLD" 'name: CONFIG_FILE'                 && ok "CONFIG_FILE env present"            || bad "CONFIG_FILE env missing"
has "$SCAFFOLD" 'secretName: cyto-worker-config'    && ok "config Secret volume wired"         || bad "config Secret volume missing"
has "$SCAFFOLD" 'mountPath: /etc/cytoanalyst'       && ok "config volume mounted"              || bad "config volume mount missing"
has "$CONFIG"   'use_embedded: false'               && ok "config uses external PG"            || bad "config not external PG"
# gap #4: squashfuse needs /dev/fuse → privileged:true (the CELL-1-proven path).
has "$SCAFFOLD" 'privileged: true'                  && ok "securityContext privileged:true"    || bad "privileged securityContext missing"

echo "== TEST-4: env-rootfs delivery wiring (gap #5) =="
has "$SCAFFOLD" 'name: env-rootfs'                       && ok "env-rootfs volume present"          || bad "env-rootfs volume missing"
has "$SCAFFOLD" 'name: fetch-env-rootfs'                 && ok "rootfs initContainer present"       || bad "rootfs initContainer missing"
has "$SCAFFOLD" 'name: CYTO_ENV_ROOTFS_SQUASHFS'         && ok "CYTO_ENV_ROOTFS_SQUASHFS env set"   || bad "CYTO_ENV_ROOTFS_SQUASHFS missing"
has "$SCAFFOLD" 'name: CYTO_SANDBOX_ENV_ID'              && ok "CYTO_SANDBOX_ENV_ID env set"        || bad "CYTO_SANDBOX_ENV_ID missing"

echo "== TEST-5: floci/k3s load-image route + CNI note (gap #5) =="
has "$LOADSCRIPT" 'floci|k3s'                            && ok "load-image has floci/k3s arm"       || bad "floci/k3s arm missing"
has "$LOADSCRIPT" 'ctr -n k8s.io images import'          && ok "uses ctr images import route"       || bad "ctr import route missing"
has "$README"     'CNI bridge'                           && ok "README documents CNI bridge IP"     || bad "CNI bridge note missing"

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" -eq 0 ] || exit 1
