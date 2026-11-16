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
# The BASES scenario (the published-base path) runs in the same registry:
#   a. a real oras (scripts/fetch-oras.mjs, pinned sha256) — the scenario is
#      skipped with a printed reason when none can be staged
#      (TXR_ACCEPT_REAL_ORAS_DIR may name a dir that already holds `oras`);
#   b. publish.py --stage-fixture: the fixture base packed by the generator's
#      own pack + a second fixture layer, in the generator's build-dir format;
#   c. the generator writes the manifest (with its `bases` list) and the
#      guard checks it with the regen-parity leg;
#   d. the REAL publisher, --registry <the loopback>: a layer before its base
#      is refused; the base, then the same base again (a no-op), then the
#      layer are published;
#   e. the Rust child's bases scenario: the app downloads + verifies the
#      published base against the bases record's squashfs_sha256 and runs.
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

# ── the bases scenario ─────────────────────────────────────────────────────────
GEN_PY="$REPO_ROOT/scripts/generate-method-env-images.py"
PUBLISHER="$REPO_ROOT/scripts/publish-method-env-images.sh"
BASES_STAGE="$OUT/bases-stage"
BASES_MANIFEST="$OUT/method-env-images.bases.json"
BASES_APP_DATA="$OUT/app-data-bases"
BASES_WORK="$OUT/work-bases"
REAL_ORAS_DIR="${TXR_ACCEPT_REAL_ORAS_DIR:-$OUT/oras-real}"
mkdir -p "$REAL_ORAS_DIR" "$BASES_APP_DATA" "$BASES_WORK"
if [ ! -x "$REAL_ORAS_DIR/oras" ]; then
  if node "$REPO_ROOT/scripts/fetch-oras.mjs" --out-dir "$REAL_ORAS_DIR/fetched"; then
    fetched=$(ls "$REAL_ORAS_DIR"/fetched/oras-* 2>/dev/null | head -1 || true)
    [ -z "$fetched" ] || ln -sf "$fetched" "$REAL_ORAS_DIR/oras"
  fi
fi
BASES_ENV=""
if [ -x "$REAL_ORAS_DIR/oras" ]; then
  echo "bases scenario: oras $("$REAL_ORAS_DIR/oras" version 2>/dev/null | head -1)"
  python3 "$PUBLISH_PY" --stage-fixture "$BASES_STAGE"
  python3 "$GEN_PY" --fixture "$BASES_STAGE" --methods-dir "$BASES_STAGE/methods" \
    --manifest "$BASES_MANIFEST" --full
  bash "$REPO_ROOT/scripts/check-method-env-images.sh" --manifest "$BASES_MANIFEST" \
    --staging-dir "$BASES_STAGE" --methods-dir "$BASES_STAGE/methods" --require-parity
  pub() {
    PATH="$REAL_ORAS_DIR:$PATH" bash "$PUBLISHER" --registry "$REGISTRY" --arch amd64 \
      --manifest "$BASES_MANIFEST" --staging-dir "$BASES_STAGE" \
      --methods-dir "$BASES_STAGE/methods" "$@"
  }
  if pub --env txr-dev-fixture-b >"$OUT/publish-layer-first.log" 2>&1; then
    echo "FAIL: the layer was published before its base (see $OUT/publish-layer-first.log)" >&2
    exit 1
  fi
  grep -q "publish the base first" "$OUT/publish-layer-first.log" || {
    echo "FAIL: the layer-before-base refusal did not name the cause:" >&2
    cat "$OUT/publish-layer-first.log" >&2
    exit 1
  }
  pub --base base-py
  pub --base base-py | grep -q "identical bytes" || {
    echo "FAIL: republishing the same base was not a no-op" >&2; exit 1; }
  pub --env txr-dev-fixture-b
  BASES_ENV=1
else
  echo "bases scenario SKIPPED: no real oras (scripts/fetch-oras.mjs could not stage one;"
  echo "set TXR_ACCEPT_REAL_ORAS_DIR to a dir holding oras >= 1.2)"
fi

echo "acceptance: cargo test --test integration_tests :: sandbox::dev_registry_test"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/data/pbya/txresbench-app-work/target/qa-hardening}" \
TXR_ACCEPT_REGISTRY="$REGISTRY" \
TXR_ACCEPT_MANIFEST="$MANIFEST" \
TXR_ACCEPT_ORAS_DIR="$ORAS_DIR" \
TXR_ACCEPT_DATA_DIR="$APP_DATA" \
TXR_ACCEPT_WORK="$WORK" \
TXR_ACCEPT_BASES_MANIFEST="${BASES_ENV:+$BASES_MANIFEST}" \
TXR_ACCEPT_REAL_ORAS_DIR="${BASES_ENV:+$REAL_ORAS_DIR}" \
TXR_ACCEPT_BASES_DATA_DIR="${BASES_ENV:+$BASES_APP_DATA}" \
TXR_ACCEPT_BASES_WORK="${BASES_ENV:+$BASES_WORK}" \
cargo test --test integration_tests -- sandbox::dev_registry_test --nocapture

RC=$?
kill "$REGISTRY_PID" 2>/dev/null || true
wait "$REGISTRY_PID" 2>/dev/null || true
rm -f "$OUT/registry.pid"
exit $RC
