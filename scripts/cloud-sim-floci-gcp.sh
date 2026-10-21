#!/usr/bin/env bash
# cloud-sim-floci-gcp.sh — the floci-gcp cloud-sim substrate (GCP half of the
# epic compute-storage substrate). The GCP twin of scripts/cloud-sim-floci.sh.
#
# floci-gcp (https://github.com/floci-io/floci-gcp — a Quarkus-native GCP Local
# Emulator, single port 4588) is THE native-GCS + GKE half of the standardized
# cloud-sim, alongside floci (AWS: S3 + EKS→k3s). ONE tool backs BOTH GCP legs:
#
#   * GCS — the native Google Cloud Storage JSON+XML API on :4588 (real object
#           store, dummy creds). Backs the T2 ObjectStore contract
#           (`s3_contract_test.rs`, native-GCS legs) UNCHANGED — it reads the SAME
#           STORAGE_EMULATOR_HOST / CYTO_WORKSTORE_S3_BUCKET contract. Unlike the
#           RETIRED fake-gcs-server, floci-gcp implements the GCS **write** path  # RETIRED-SUBSTRATE
#           (resumable/JSON media + XML single PUT), so the native-GCS WRITE
#           contract now RUNS against a local emulator (fake-gcs could not). RETIRED-SUBSTRATE
#   * GKE — `container.googleapis.com/v1 create-cluster` spins up a REAL k3s node
#           (Docker-backed, rancher/k3s), yielding a real kubeconfig for the T3
#           KubernetesBackend — the GCP compute k8s, twin of floci's EKS→k3s.
#
# It is credential-free (dummy ADC/project, loopback-only :4588) and runs the
# no-cloud-credentials guard (cloud-sim-guard.sh) FIRST in every test tier,
# exactly like the floci (AWS) substrate — so a green run is a real portability
# proof (INV-2).
#
# Subcommands:
#   up            start the floci-gcp container, pre-create the canonical GCS
#                 bucket, write the env contract. Idempotent.
#   down          stop+remove the floci-gcp container AND any GKE k3s sibling
#                 containers it spawned; remove the env + kubeconfig files. Idempotent.
#   env           print the env contract (also written to the env file by `up`)
#   bucket        (re)create the canonical GCS bucket, idempotently
#   smoke         GCS reachability/contract smoke (JSON-API write+read on :4588)
#   gke-up        create the GKE cluster (container.googleapis.com/v1), provision
#                 the k3s token-webhook workaround, wait node Ready, write kubeconfig
#   gke-down      delete the GKE cluster (removes the k3s sibling container)
#   contract-gcs  the ACCEPTANCE tier: guard -> up -> run the native-GCS ObjectStore
#                 contract legs (`s3_contract_test.rs`, saas) against floci-gcp GCS,
#                 incl. the WRITE leg fake-gcs blocked -> down  (RETIRED-SUBSTRATE)
#   contract-k8s  guard -> up -> gke-up -> run the KubernetesBackend contract test
#                 against floci-gcp's GKE k3s -> gke-down -> down
#   test          fail-closed tier: guard -> up -> GCS smoke -> down (fast, no cargo)
#
# Mirrors cloud-sim-floci.sh (env contract PROV-T1-4, guard-first PROV-T1-5).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CYTO_FLOCI_GCP_ENV_FILE:-$ROOT/src-app/cloud-sim/.floci-gcp-sim.env}"
GUARD="$ROOT/scripts/cloud-sim-guard.sh"

# --- the canonical endpoint-override env contract (PROV-T1-4, floci-gcp flavour) ---
# Pinned by DIGEST (not the mutable :latest tag): this container is granted the host
# docker socket for the GKE tier, so a repointed tag would be a supply-chain path to
# host root. Override with CYTO_FLOCI_GCP_IMAGE to bump the pin deliberately.
FLOCI_GCP_IMAGE="${CYTO_FLOCI_GCP_IMAGE:-floci/floci-gcp@sha256:9f1a020fdd5ac8b6ca568b60e793a9a0e88b8df400ae6bd68283ec5208788180}"
FLOCI_GCP_NAME="${CYTO_FLOCI_GCP_NAME:-cyto-floci-gcp}"
FLOCI_GCP_PORT="${CYTO_FLOCI_GCP_PORT:-4588}"
GCS_UPSTREAM="http://127.0.0.1:${FLOCI_GCP_PORT}"
# The GCS metadata-header compatibility shim (DEC-8): floci-gcp 0.7.0 omits the
# ETag/Last-Modified HTTP response headers object_store 0.13.2 requires, so the
# product's native-GCS client cannot read floci-gcp responses directly. The shim
# forwards to :4588 and surfaces those (workstore-unused) headers. STORAGE_EMULATOR_HOST
# points at the shim; set CYTO_FLOCI_GCP_COMPAT_PORT=0 to bypass it (point straight
# at :4588 — correct once a floci-gcp release emits standard GCS metadata headers).
COMPAT_PORT="${CYTO_FLOCI_GCP_COMPAT_PORT:-4599}"
# Which address the shim LISTENS on. Loopback by default (DE-INV-13: nothing on the LAN).
# A CROSS-PROVIDER cell — a worker pod on the *other* emulator's k3s reading this GCS half —
# reaches the shim over the docker bridge, so it must bind 0.0.0.0 there:
# CYTO_FLOCI_GCP_COMPAT_BIND=0.0.0.0. Resolved here (not left to the proxy's own default) so
# the value SURVIVES the restart `gke-up` performs, which otherwise silently re-binds loopback.
COMPAT_BIND="${CYTO_FLOCI_GCP_COMPAT_BIND:-127.0.0.1}"
if [ "$COMPAT_PORT" = "0" ]; then GCS_ENDPOINT="$GCS_UPSTREAM"; else GCS_ENDPOINT="http://127.0.0.1:${COMPAT_PORT}"; fi
COMPAT_PIDFILE="${CYTO_FLOCI_GCP_COMPAT_PIDFILE:-$ROOT/src-app/cloud-sim/.floci-gcp-compat.pid}"
COMPAT_SCRIPT="$ROOT/scripts/floci-gcp-gcs-compat-proxy.py"
GCP_PROJECT="${GOOGLE_CLOUD_PROJECT:-floci-local}"
BUCKET="${CYTO_WORKSTORE_S3_BUCKET:-cyto-worklab}"
# GKE
GKE_CLUSTER="${CYTO_FLOCI_GKE_CLUSTER:-cyto-floci-gcp}"
GKE_LOCATION="${CYTO_FLOCI_GKE_LOCATION:-us-central1}"
KUBECONFIG_FILE="${KUBECONFIG:-$ROOT/src-app/cloud-sim/.floci-gcp-kube-config}"

say() { echo "[floci-gcp-sim] $*" >&2; }
die() { echo "[floci-gcp-sim] FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not on PATH${2:+ — $2}"; }

# curl helper: emit only the HTTP status code (path-style GCS JSON API).
gcs_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

wait_gcs() {
  local i
  for i in $(seq 1 60); do
    # The GCS JSON API root answers 200/40x once the emulator is up (check upstream).
    if curl -fsS --max-time 2 -o /dev/null "$GCS_UPSTREAM/storage/v1/b?project=$GCP_PROJECT" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# --- the GCS metadata-header compatibility shim (DEC-8) ----------------------
start_compat() {
  [ "$COMPAT_PORT" = "0" ] && return 0
  need python3 "the floci-gcp GCS compat shim needs python3 (stdlib only)"
  # already running?
  if [ -f "$COMPAT_PIDFILE" ] && kill -0 "$(cat "$COMPAT_PIDFILE" 2>/dev/null)" 2>/dev/null; then
    say "gcs compat shim already running (pid $(cat "$COMPAT_PIDFILE"))"; return 0
  fi
  FLOCI_GCP_UPSTREAM="$GCS_UPSTREAM" CYTO_FLOCI_GCP_COMPAT_PORT="$COMPAT_PORT" \
    CYTO_FLOCI_GCP_COMPAT_BIND="$COMPAT_BIND" \
    CYTO_FLOCI_GCP_COMPAT_DEBUG="${CYTO_FLOCI_GCP_COMPAT_DEBUG:-}" \
    nohup python3 "$COMPAT_SCRIPT" >"${CYTO_FLOCI_GCP_COMPAT_LOG:-/dev/null}" 2>&1 &
  echo $! > "$COMPAT_PIDFILE"
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 -o /dev/null "$GCS_ENDPOINT/storage/v1/b?project=$GCP_PROJECT" 2>/dev/null; then
      say "gcs compat shim up on :$COMPAT_PORT (injects ETag/Last-Modified → object_store)"; return 0
    fi
    sleep 0.5
  done
  die "gcs compat shim did not become ready on :$COMPAT_PORT"
}

stop_compat() {
  [ -f "$COMPAT_PIDFILE" ] || return 0
  local pid; pid="$(cat "$COMPAT_PIDFILE" 2>/dev/null)"
  # Only signal a PID that is actually alive (symmetry with start_compat's kill -0
  # guard) so a stale/recycled PID is never signalled. Leave the pidfile in place if
  # the kill did not take, so cmd_down's VERIFY can still see the survivor.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    kill -0 "$pid" 2>/dev/null && return 0   # still alive ⇒ keep pidfile for VERIFY
  fi
  rm -f "$COMPAT_PIDFILE" 2>/dev/null || true
}

create_bucket() {
  # 200 on GET => exists (no-op); else POST create via the GCS JSON API.
  if [ "$(gcs_code "$GCS_ENDPOINT/storage/v1/b/$BUCKET")" = "200" ]; then
    say "gcs: bucket '$BUCKET' already present (idempotent no-op)"; return 0
  fi
  local code
  code="$(gcs_code -X POST "$GCS_ENDPOINT/storage/v1/b?project=$GCP_PROJECT" \
    -H 'Content-Type: application/json' -d "{\"name\":\"$BUCKET\"}")"
  case "$code" in
    200|409) say "gcs: bucket '$BUCKET' ready (http $code)" ;;
    *) die "gcs: bucket create returned http $code" ;;
  esac
}

write_env_file() {
  cat > "$ENV_FILE" <<EOF
# GENERATED by scripts/cloud-sim-floci-gcp.sh — the floci-gcp endpoint-override env
# contract (PROV-T1-4, GCP half). Source it to point a native-GCS ObjectStore /
# GKE compute backend at the local floci-gcp substrate:
#   set -a; source src-app/cloud-sim/.floci-gcp-sim.env; set +a
# Loopback-only + dummy project/creds — no cloud account (DE-INV-13 / INV-2).
# floci-gcp implements native GCS reads AND the single-blob write path, so the
# native-GCS legs of s3_contract_test.rs RUN here (fake-gcs could not). RETIRED-SUBSTRATE
#
# BACKEND SELECTION (verified by the GCS+GKE analysis-cell spike, #67): the product's
# runtime store selector (\`workstore::config::backend_from_env\`) treats the CLOUD store
# as an S3-family OPT-IN — \`CYTO_WORKSTORE_BACKEND=s3\` turns the cloud object_store ON,
# and the PROVIDER within it is chosen by \`CYTO_WORKSTORE_CLOUD\` (\`gcs\` ⇒ native GCS).
# \`CYTO_WORKSTORE_BACKEND=gcs\` maps to LOCAL-FS (see \`backend_from_env\`: only "s3" opts
# in), so a real \`cytoanalyst worker\` sourcing this env would silently run on local-fs,
# never touching GCS. The native-GCS contract test builds \`CloudProvider::Gcs\` directly
# and so was unaffected, which is why this stale value survived. Emit what the WORKER
# actually reads: backend=s3 + cloud=gcs.
export CYTO_WORKSTORE_BACKEND=s3
export CYTO_WORKSTORE_CLOUD=gcs
export STORAGE_EMULATOR_HOST=$GCS_ENDPOINT
export GOOGLE_CLOUD_PROJECT=$GCP_PROJECT
export CYTO_WORKSTORE_S3_BUCKET=$BUCKET
export CYTO_COMPUTE_BACKEND=kubernetes
export KUBECONFIG=$KUBECONFIG_FILE
EOF
  say "wrote env contract → $ENV_FILE"
}

print_env() {
  # backend=s3 + cloud=gcs — the vars the product's runtime store selector reads
  # (backend_from_env treats the cloud store as an s3-family opt-in; provider = gcs).
  cat <<EOF
CYTO_WORKSTORE_BACKEND=s3
CYTO_WORKSTORE_CLOUD=gcs
STORAGE_EMULATOR_HOST=$GCS_ENDPOINT
GOOGLE_CLOUD_PROJECT=$GCP_PROJECT
CYTO_WORKSTORE_S3_BUCKET=$BUCKET
CYTO_COMPUTE_BACKEND=kubernetes
KUBECONFIG=$KUBECONFIG_FILE
EOF
}

cmd_up() {
  need docker; need curl
  if docker ps --filter "name=^/${FLOCI_GCP_NAME}$" --format '{{.Names}}' 2>/dev/null | grep -qx "$FLOCI_GCP_NAME"; then
    say "floci-gcp container '$FLOCI_GCP_NAME' already running (idempotent)"
  else
    docker rm -f "$FLOCI_GCP_NAME" >/dev/null 2>&1 || true
    say "starting floci-gcp on :$FLOCI_GCP_PORT …"
    # LEAST-PRIVILEGE: the host docker socket (needed only so the GKE tier can spawn
    # k3s sibling containers) is mounted ONLY when a GKE tier asked for it
    # (CYTO_FLOCI_GCP_GKE=1). Storage-only tiers (contract-gcs / test / plain up) get
    # NO socket — a mounted docker.sock is host-root-equivalent.
    local sock=""
    [ -n "${CYTO_FLOCI_GCP_GKE:-}" ] && sock="-v /var/run/docker.sock:/var/run/docker.sock"
    # Bind to LOOPBACK only — the "loopback-only :4588" (DE-INV-13) property must be
    # enforced by the publish, not just asserted; 0.0.0.0 would expose it on the LAN.
    # shellcheck disable=SC2086
    docker run -d --name "$FLOCI_GCP_NAME" -p "127.0.0.1:${FLOCI_GCP_PORT}:4588" \
      $sock "$FLOCI_GCP_IMAGE" >/dev/null 2>&1 \
      || die "docker run floci-gcp failed"
  fi
  say "waiting for GCS ($GCS_UPSTREAM) …"; wait_gcs || { docker logs --tail 30 "$FLOCI_GCP_NAME" >&2 2>&1; die "floci-gcp did not become ready"; }
  start_compat
  create_bucket
  write_env_file
  say "UP. floci-gcp substrate ready. Source the env: 'set -a; source $ENV_FILE; set +a'"
}

# The k3s sibling container floci-gcp spawns for a GKE cluster.
gke_container() { echo "floci-gcp-gke-${GCP_PROJECT}-${GKE_CLUSTER}"; }

# Remove any GKE k3s sibling containers floci-gcp spawned.
remove_gke_siblings() {
  local c
  for c in $(docker ps -aq --filter "name=floci-gcp-gke-" 2>/dev/null); do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
}

cmd_down() {
  need docker
  if docker ps --filter "name=^/${FLOCI_GCP_NAME}$" -q 2>/dev/null | grep -q .; then
    cmd_gke_down >/dev/null 2>&1 || true
  fi
  stop_compat
  docker rm -f "$FLOCI_GCP_NAME" >/dev/null 2>&1 || true
  remove_gke_siblings
  rm -f "$ENV_FILE" "$KUBECONFIG_FILE" 2>/dev/null || true
  # VERIFY — never print DOWN over a survivor (container, GKE sibling, OR compat shim).
  local compat_alive=""
  if [ -f "$COMPAT_PIDFILE" ] && kill -0 "$(cat "$COMPAT_PIDFILE" 2>/dev/null)" 2>/dev/null; then
    compat_alive=1
  fi
  if docker ps -aq --filter "name=^/${FLOCI_GCP_NAME}$" 2>/dev/null | grep -q . \
     || docker ps -aq --filter "name=floci-gcp-gke-" 2>/dev/null | grep -q . \
     || [ -n "$compat_alive" ]; then
    say "WARN: floci-gcp SURVIVED teardown — 'docker rm -f $FLOCI_GCP_NAME', remove floci-gcp-gke-*, and kill the compat shim ($COMPAT_PIDFILE) by hand."
    return 1
  fi
  say "DOWN. floci-gcp substrate removed."
  return 0
}

cmd_smoke() {
  need curl
  # Write + read a real object through the native GCS JSON media-upload API — the
  # write path fake-gcs could not serve. Uses %2F so the '/' is a slash-bearing name. RETIRED-SUBSTRATE
  # Compute the timestamp ONCE so the written name and the read/delete key can never
  # diverge across a second boundary (a spurious body-mismatch flake otherwise).
  local ts="$$-$(date +%s)"
  local name="probe/${ts}.txt"
  local enc="probe%2F${ts}.txt"
  local body="cyto-floci-gcp-gcs-probe"
  [ "$(gcs_code -X POST "$GCS_ENDPOINT/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$name" \
      -H 'Content-Type: text/plain' --data-binary "$body")" = "200" ] \
    || die "gcs smoke: media WRITE failed"
  local got; got="$(curl -fsS --max-time 5 "$GCS_ENDPOINT/storage/v1/b/$BUCKET/o/$enc?alt=media" 2>/dev/null)"
  curl -s -o /dev/null -X DELETE "$GCS_ENDPOINT/storage/v1/b/$BUCKET/o/$enc" >/dev/null 2>&1 || true
  [ "$got" = "$body" ] || die "gcs smoke: GET body mismatch ('$got')"
  say "gcs smoke: media WRITE/GET OK on floci-gcp GCS (:$FLOCI_GCP_PORT)"
}

# --- GKE -> real k3s (the GCP compute substrate; twin of floci EKS→k3s) -------
# floci-gcp-substrate TEST-2: gke-up creates the GKE cluster, provisions the
# token-webhook workaround, waits the k3s node Ready, and writes a host kubeconfig.
cmd_gke_up() {
  need curl; need docker
  need kubectl "install kubectl — https://kubernetes.io/docs/tasks/tools/"
  # The GKE tier needs the emulator container to hold the host docker socket (to spawn
  # the k3s sibling). Ensure it: a storage-only `up` started it WITHOUT the socket, so
  # (re)create with CYTO_FLOCI_GCP_GKE=1 if the running container lacks it.
  export CYTO_FLOCI_GCP_GKE=1
  if docker ps --filter "name=^/${FLOCI_GCP_NAME}$" -q 2>/dev/null | grep -q .; then
    if ! docker inspect "$FLOCI_GCP_NAME" --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | grep -q 'docker.sock'; then
      say "gke: restarting floci-gcp WITH the docker socket (needed to spawn k3s) …"
      stop_compat; docker rm -f "$FLOCI_GCP_NAME" >/dev/null 2>&1 || true
      cmd_up
    fi
  else
    cmd_up
  fi
  # The GKE control plane lives on the emulator itself (:4588), not the GCS compat shim.
  local api="$GCS_UPSTREAM/container/v1/projects/$GCP_PROJECT/locations/$GKE_LOCATION"
  local st
  st="$(curl -fsS --max-time 5 "$api/clusters/$GKE_CLUSTER" 2>/dev/null | grep -o '"status":"[A-Z]*"' | head -1)"
  if [ -z "$st" ]; then
    say "gke: create-cluster '$GKE_CLUSTER' (spins a real k3s node; can take ~30-60s) …"
    # The emulator's create-cluster is SYNCHRONOUS — it blocks until the k3s sibling is
    # started (~30s here). A short client timeout is the create-cluster flake; give it room.
    curl -fsS --max-time 120 -X POST "$api/clusters" -H 'Content-Type: application/json' \
      -d "{\"cluster\":{\"name\":\"$GKE_CLUSTER\",\"initialNodeCount\":1}}" >/dev/null 2>&1 \
      || die "gke: create-cluster failed"
  else
    say "gke: cluster '$GKE_CLUSTER' already present ($st) (idempotent)"
  fi

  # floci-gcp 0.7.0 workaround (DEC-4): the emulator configures the k3s apiserver
  # with --authentication-token-webhook-config-file=/etc/gke-token-webhook.yaml but
  # does NOT provision that file into the sibling container, so the apiserver exits 1
  # on boot (cluster status ERROR). Provision a minimal token-webhook kubeconfig and
  # (re)start the container so the node reaches Ready.
  local c; c="$(gke_container)"
  local i
  for i in $(seq 1 30); do
    docker inspect "$c" >/dev/null 2>&1 && break
    sleep 1
  done
  docker inspect "$c" >/dev/null 2>&1 || die "gke: k3s sibling container '$c' was not spawned by the emulator"

  local emu_ip; emu_ip="$(docker inspect "$FLOCI_GCP_NAME" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null)"
  local webhook; webhook="$(mktemp)"
  cat > "$webhook" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: floci-gke-webhook
  cluster:
    server: http://${emu_ip:-172.18.0.2}:${FLOCI_GCP_PORT}/iam/webhook/authenticate
users:
- name: apiserver
  user: {}
current-context: webhook
contexts:
- name: webhook
  context:
    cluster: floci-gke-webhook
    user: apiserver
EOF
  docker cp "$webhook" "$c:/etc/gke-token-webhook.yaml" >/dev/null 2>&1 || die "gke: could not provision token-webhook file"
  rm -f "$webhook"
  # (Re)start the k3s node if it is not running.
  if [ "$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null)" != "running" ]; then
    docker start "$c" >/dev/null 2>&1 || die "gke: could not start the k3s node container"
  fi

  # Wait for the node to be Ready (in-container kubectl).
  say "gke: waiting for the k3s node to become Ready …"
  local ready=""
  for i in $(seq 1 60); do
    if docker exec "$c" kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready'; then ready=1; break; fi
    sleep 3
  done
  [ -n "$ready" ] || { docker logs --tail 25 "$c" >&2 2>&1; die "gke: k3s node did not reach Ready"; }

  # Extract a HOST-usable kubeconfig: k3s.yaml points at 127.0.0.1:6443 (in-container);
  # rewrite the server to the container IP so host kubectl can reach the apiserver.
  local ip; ip="$(docker inspect "$c" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null)"
  docker exec "$c" cat /etc/rancher/k3s/k3s.yaml > "$KUBECONFIG_FILE" 2>/dev/null \
    || die "gke: could not read the k3s kubeconfig"
  # portable in-place sed (works on GNU + BSD): write to a temp then move.
  sed "s#https://127.0.0.1:6443#https://$ip:6443#" "$KUBECONFIG_FILE" > "$KUBECONFIG_FILE.tmp" \
    && mv "$KUBECONFIG_FILE.tmp" "$KUBECONFIG_FILE"
  KUBECONFIG="$KUBECONFIG_FILE" kubectl get nodes >/dev/null 2>&1 || die "gke: k3s node not reachable via host kubectl"
  say "gke: k3s cluster Ready, kubeconfig → $KUBECONFIG_FILE"
}

cmd_gke_down() {
  need docker
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 10 -X DELETE \
      "$GCS_ENDPOINT/container/v1/projects/$GCP_PROJECT/locations/$GKE_LOCATION/clusters/$GKE_CLUSTER" \
      >/dev/null 2>&1 || true
  fi
  remove_gke_siblings
  rm -f "$KUBECONFIG_FILE" 2>/dev/null || true
  say "gke: cluster '$GKE_CLUSTER' deleted (k3s sibling removed)"
}

run_guard() {
  # INV-2: the no-cloud-credentials guard runs FIRST in every test tier.
  echo "[floci-gcp-sim] guard: refusing any real cloud credential/endpoint (INV-2)" >&2
  bash "$GUARD" || die "no-cloud-credentials guard REFUSED the env — a real cloud cred/endpoint is present (INV-2)"
}

# --- the native-GCS ObjectStore contract ACCEPTANCE tier --------------------
cmd_contract_gcs() {
  need docker; need curl; need cargo
  run_guard
  trap 'cmd_down' EXIT
  trap 'trap - EXIT INT TERM; cmd_down; exit 130' INT TERM
  cmd_up
  # The native-GCS ObjectStore contract legs (read + single-blob WRITE) against
  # floci-gcp GCS. With STORAGE_EMULATOR_HOST set, the native-GCS legs RUN.
  say "running the native-GCS ObjectStore contract (s3_contract_test.rs, saas) against floci-gcp …"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  local rc=0
  ( cd "$ROOT" && cargo test -p cytoanalyst --features saas --test integration_tests \
      -- workstore::s3_contract --test-threads=1 ) || rc=1
  trap - INT TERM EXIT
  cmd_down || rc=1
  if [ "$rc" -eq 0 ]; then echo "[floci-gcp-sim] contract-gcs PASS"; else echo "[floci-gcp-sim] contract-gcs FAIL"; fi
  return "$rc"
}

# --- the KubernetesBackend contract tier (GKE -> k3s) -----------------------
cmd_contract_k8s() {
  need docker; need curl; need cargo; need kubectl
  run_guard
  # GKE tier ⇒ the emulator needs the host docker socket from first boot (least-privilege).
  export CYTO_FLOCI_GCP_GKE=1
  trap 'cmd_down' EXIT
  trap 'trap - EXIT INT TERM; cmd_down; exit 130' INT TERM
  cmd_up
  cmd_gke_up
  say "running the KubernetesBackend contract test against floci-gcp's GKE k3s …"
  set -a; . "$ENV_FILE"; set +a
  export KUBECONFIG="$KUBECONFIG_FILE"
  export CYTO_WORKER_IMAGE="${CYTO_WORKER_IMAGE:-busybox:latest}"
  local rc=0
  ( cd "$ROOT" && cargo test -p cytoanalyst --features saas --test integration_tests \
      sandbox::kubernetes_backend -- --test-threads=1 ) || rc=1
  trap - INT TERM EXIT
  cmd_down || rc=1
  if [ "$rc" -eq 0 ]; then echo "[floci-gcp-sim] contract-k8s PASS"; else echo "[floci-gcp-sim] contract-k8s FAIL"; fi
  return "$rc"
}

smoke_env() { grep -q "CYTO_WORKSTORE_S3_BUCKET=$BUCKET" "$ENV_FILE" 2>/dev/null || die "CYTO_WORKSTORE_S3_BUCKET not exported in $ENV_FILE"; }

cmd_test() {
  # The fast fail-closed tier — guard → up → GCS smoke → idempotent re-up →
  # verify-teardown, sweeping every floci-gcp container.
  need docker; need curl
  run_guard
  local rc=0
  trap 'cmd_down' EXIT
  trap 'trap - EXIT INT TERM; cmd_down; exit 130' INT TERM
  cmd_up
  smoke_env
  echo "[floci-gcp-sim] --- GCS reachability/contract smoke ---"
  cmd_smoke || rc=1
  echo "[floci-gcp-sim] idempotency: re-running up on a live stack …"
  cmd_up || rc=1
  trap - INT TERM EXIT
  cmd_down || { echo "[floci-gcp-sim] FAIL: teardown left containers"; rc=1; }
  if [ "$rc" -eq 0 ]; then echo "[floci-gcp-sim] test PASS"; else echo "[floci-gcp-sim] test FAIL"; fi
  return "$rc"
}

case "${1:-}" in
  up)           cmd_up ;;
  down)         cmd_down ;;
  env)          print_env ;;
  bucket)       need curl; create_bucket ;;
  smoke)        cmd_smoke ;;
  gke-up)       cmd_gke_up ;;
  gke-down)     cmd_gke_down ;;
  contract-gcs) cmd_contract_gcs ;;
  contract-k8s) cmd_contract_k8s ;;
  test)         cmd_test ;;
  *) echo "usage: cloud-sim-floci-gcp.sh {up|down|env|bucket|smoke|gke-up|gke-down|contract-gcs|contract-k8s|test}" >&2; exit 2 ;;
esac
