#!/usr/bin/env bash
# acceptance.sh — TEST-QA-2's driver: the dev registry + the fixture publish +
# the app-side acceptance test, one command.
#
#   TMPDIR=/data/pbya/txresbench-app-work/tmp-qa-hardening \
#   CARGO_TARGET_DIR=/data/pbya/txresbench-app-work/target/qa-hardening \
#   CAP_CPUS=2 bash scripts/dev-registry/acceptance.sh
#
# What it does (every process stays inside the repo's 2-CPU cap — run it via
# ops/cap.sh):
#   1. starts scripts/dev-registry/registry.py on an ephemeral port with the
#      data dir under --out (outside the repo);
#   2. publishes the FIXTURE artifact family (tiny base + tiny fake method)
#      with scripts/dev-registry/publish.py --fixture;
#   3. prepares the oras bin dir (the dev drop-in, scripts/dev-registry/oras_dev.py);
#   4. runs the Rust acceptance (tests/sandbox/dev_registry_test.rs) against
#      the running app code: fetch -> verify -> mount -> bwrap run;
#   5. stops exactly the registry it started (PID file; never pkill -f).
#
# The full REAL publish (six real layers + both host-derived bases) is a
# separate command, because it builds ~1 GB of squashfs:
#
#   CAP_CPUS=2 ops/cap.sh python3 scripts/dev-registry/publish.py \
#       --registry 127.0.0.1:5055 --out /data/pbya/txresbench-app-work/qa-build-real
#
# and then the app (debug build) is started against it with
#   TXR_METHOD_ENV_REGISTRY=127.0.0.1:5055 \
#   TXR_ENV_MANIFEST=/data/pbya/txresbench-app-work/qa-build-real/method-env-images.dev.json
# (see scripts/dev-registry/README.md).

set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
REGISTRY_PY="$REPO_ROOT/scripts/dev-registry/registry.py"
PUBLISH_PY="$REPO_ROOT/scripts/dev-registry/publish.py"
ORAS_PY="$REPO_ROOT/scripts/dev-registry/oras_dev.py"

OUT="${TXR_ACCEPT_OUT:-/data/pbya/txresbench-app-work/qa-accept}"
DATA_DIR="$OUT/registry-data"
APP_DATA="$OUT/app-data"
WORK="$OUT/work"
ORAS_DIR="$OUT/oras-bin"
MANIFEST="$OUT/method-env-images.fixture.json"

rm -rf "$OUT"
mkdir -p "$DATA_DIR" "$ORAS_DIR" "$APP_DATA" "$WORK"

# A free loopback port (the 5300-5399 range is the app's loopback dev-web
# range; the kernel picks from the ephemeral range).
PORT="${TXR_ACCEPT_PORT:-$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)}"
PORT=$PORT python3 "$REPO_ROOT/scripts/dev-registry/registry.py" \
    --port "$PORT" --dir "$DATA_DIR" >"$OUT/registry.log" 2>&1 &
REGISTRY_PID=$!
echo $REGISTRY_PID >"$OUT/registry.pid"
trap 'kill "$(cat "$OUT/registry.pid" 2>/dev/null || true)" 2>/dev/null || true' EXIT

# The registry prints the bound port on stdout ("dev-registry: listening on ...").
sleep 1
PORT_LINE=$(grep -oE "127\.0\.0\.1:[0-9]+" "$OUT/registry.log" | head -1 || true)
REGISTRY="${PORT_LINE:-127.0.0.1:$PORT}"

echo "dev registry: $REGISTRY"
python3 "$PUBLISH_PY" --registry "$REGISTRY" --out "$OUT" --fixture --skip-real

# The oras dev drop-in is found by the app's tool_bin("<app_data>/bin" first,
# then PATH) — the acceptance child prepends ORAS_DIR to PATH.
cp "$ORAS_PY" "$ORAS_DIR/oras"
chmod +x "$ORAS_DIR/oras"

echo "acceptance: cargo test --test integration_tests :: sandbox::dev_registry_test"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/data/pbya/txresbench-app-work/target/qa-hardening}" \
TXR_ACCEPT_REGISTRY="$REGISTRY" \
TXR_ACCEPT_MANIFEST="$MANIFEST" \
TXR_ACCEPT_ORAS_DIR="$ORAS_DIR" \
TXR_ACCEPT_DATA_DIR="$APP_DATA" \
TXR_ACCEPT_WORK="$WORK" \
cargo test --test integration_tests -- sandbox::dev_registry_test --nocapture

RC=$?
kill "$REGISTRY_PID" 2>/dev/null || true
wait "$REGISTRY_PID" 2>/dev/null || true
rm -f "$OUT/registry.pid"
exit $RC
