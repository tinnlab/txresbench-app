#!/usr/bin/env bash
# run-demo — demo-mode ITEM-8: launch the TxResBench server in DEMO mode.
#
# The web-service demo of TxResBench runs the SAME txresbench binary the
# desktop app embeds, with the demo switch on (`--demo`): one shared pool of
# recorded runs and models, example data only, every route outside the
# allowlist answering 403 DEMO_MODE. This script is the deployment front door:
# it writes the server config (bind address/port, the demo block with the
# limits and the bundle path) into the data directory, checks the recorded
# bundle is there for the loader, and execs the server (capped through
# ops/cap.sh when CAP_SH is set — the node's build/run rule).
#
# RUN
# ---
#     scripts/demo/run-demo.sh --data-dir /var/lib/txresbench-demo \
#         --bundle /var/lib/txresbench-demo/demo-bundle \
#         --download-url https://github.com/tinnlab/txresbench-app/releases
#
#     scripts/demo/run-demo.sh --host 0.0.0.0 --port 3100 --data-dir "$PWD/demo-data"
#
# Every knob has a default listed below; the generated config (jwt secret,
# limits, replay speed) lives in <data-dir>/server/demo.yaml — KEEP IT, the
# jwt secret is the deployment's. See docs/demo-mode.md for the full
# configuration reference and the systemd sample (scripts/demo/systemd/).
#
# Environment:
#   TXR_APP_DATA_DIR   the data directory when --data-dir is absent
#   TXR_DEMO_BUNDLE    the bundle directory when --bundle is absent
#   CAP_SH             the sigtrans ops/cap.sh wrapper (default: the dev
#                      host's /data/share/pbya/sigtrans/ops/cap.sh when it
#                      exists; empty to run uncapped)
#   CAP_CPUS           interpreted but never above 4 (the node's rule)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

HOST="${TXR_DEMO_HOST:-}"
PORT="${TXR_DEMO_PORT:-}"
DATA_DIR=""
BUNDLE_DIR=""
BINARY=""
DOWNLOAD_URL=""
HISTORY_LIMIT=""
MODEL_LIMIT=""
MAX_BYTES=""
REPLAY_SPEED=""
JWT_SECRET=""

usage() {
    cat <<'EOF'
run-demo.sh — launch the TxResBench server in demo mode

  --host ADDR          bind address (default 127.0.0.1)
  --port PORT          bind port (default 3100; 0 = ephemeral, printed at boot)
  --data-dir DIR       the app data dir (default $TXR_APP_DATA_DIR; required)
  --bundle DIR         the recorded demo bundle (default $TXR_DEMO_BUNDLE or
                       <data-dir>/demo-bundle — the server's own default)
  --download-url URL   the desktop download page (GET /api/app/mode.download_url)
  --history-limit N    shared-pool run limit (default 50)
  --model-limit N      shared-pool model limit (default 50)
  --max-bytes N        request body cap in bytes (default 8 MiB)
  --replay-speed N     recorded-seconds/replay divisor (default 10)
  --jwt-secret S       jwt secret (generated + persisted when absent)
  --binary PATH        the txresbench binary (default $CARGO_TARGET_DIR/debug/
                       txresbench or <repo>/target/debug/txresbench)
  --no-cap             launch without the ops/cap.sh wrapper
  -h | --help          this help
EOF
}

fail() { echo "run-demo: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --data-dir) DATA_DIR="$2"; shift 2 ;;
        --bundle) BUNDLE_DIR="$2"; shift 2 ;;
        --download-url) DOWNLOAD_URL="$2"; shift 2 ;;
        --history-limit) HISTORY_LIMIT="$2"; shift 2 ;;
        --model-limit) MODEL_LIMIT="$2"; shift 2 ;;
        --max-bytes) MAX_BYTES="$2"; shift 2 ;;
        --replay-speed) REPLAY_SPEED="$2"; shift 2 ;;
        --jwt-secret) JWT_SECRET="$2"; shift 2 ;;
        --binary) BINARY="$2"; shift 2 ;;
        --no-cap) CAP_SH="" ;;
        -h | --help) usage; exit 0 ;;
        *) usage; exit 2 ;;
    esac
done

DATA_DIR="${DATA_DIR:-${TXR_APP_DATA_DIR:-}}"
[ -n "$DATA_DIR" ] || { usage; exit 2; }

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3100}"
HISTORY_LIMIT="${HISTORY_LIMIT:-50}"
MODEL_LIMIT="${MODEL_LIMIT:-50}"
MAX_BYTES="${MAX_BYTES:-$((8 * 1024 * 1024))}"
REPLAY_SPEED="${REPLAY_SPEED:-10}"

# The bundle: the flag, else the env, else the server's own default inside
# the data dir. The loader refuses to boot on a missing/invalid bundle — this
# pre-check only makes the failure direction obvious (and fail-fast) before
# the server starts.
BUNDLE_DIR="${BUNDLE_DIR:-${TXR_DEMO_BUNDLE:-$DATA_DIR/demo-bundle}}"
[ -n "$BUNDLE_DIR" ] || fail "--bundle is required"
[ -d "$BUNDLE_DIR" ] || fail "the demo bundle $BUNDLE_DIR does not exist — record it first: python3 scripts/demo/record-demo-bundle.py --out \"$BUNDLE_DIR\""
if ! python3 - "$BUNDLE_DIR" <<'PY'
import json, sys
bundle = sys.argv[1]
try:
    with open(f"{bundle}/manifest.json", encoding="utf-8") as fh:
        manifest = json.load(fh)
except FileNotFoundError:
    sys.exit(f"no manifest.json in {bundle}")
except ValueError as exc:
    sys.exit(f"manifest.json in {bundle} is not JSON: {exc}")
if manifest.get("format") != "txresbench-demo-bundle" or manifest.get("version") != 1:
    sys.exit(f"manifest.json in {bundle} is not a version-1 txresbench-demo-bundle")
PY
then
    fail "the demo bundle is not a usable version-1 bundle (see above)"
fi

# The binary: the flag, else CARGO_TARGET_DIR, else the repo target dir.
if [ -z "$BINARY" ]; then
    for cand in "${CARGO_TARGET_DIR:-}" "$ROOT/target"; do
        [ -n "$cand" ] || continue
        p="$cand/debug/txresbench"
        if [ -x "$p" ]; then BINARY="$p"; break; fi
    done
fi
[ -n "$BINARY" ] && [ -x "$BINARY" ] || fail "no txresbench binary found (--binary PATH, or build: cargo build -p txresbench)"

# The jwt secret: the flag, else generated once and persisted next to the
# config (the deployment's own secret; keep the file).
SECRET_FILE="$DATA_DIR/server/jwt.secret"
if [ -z "$JWT_SECRET" ] && [ -r "$SECRET_FILE" ]; then
    JWT_SECRET="$(cat "$SECRET_FILE")"
fi
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET="$(openssl rand -base64 48 2>/dev/null | tr -d '\n')"
    [ -n "$JWT_SECRET" ] || fail "openssl failed to generate a jwt secret (pass --jwt-secret)"
    mkdir -p "$DATA_DIR/server"
    umask 077
    printf '%s\n' "$JWT_SECRET" > "$SECRET_FILE"
    echo "run-demo: generated a jwt secret at $SECRET_FILE (keep it; rotation invalidates live tokens)"
fi

mkdir -p "$DATA_DIR/server" "$DATA_DIR/tmp"
CONFIG_FILE="$DATA_DIR/server/demo.yaml"
cat > "$CONFIG_FILE" <<YAML
# Generated by scripts/demo/run-demo.sh — the demo service configuration.
# This file IS the deployment's: the jwt secret below rotates only by
# regenerating the file (live tokens and the demo DB survive; old tokens die).
server:
  host: "$HOST"
  port: $PORT
  api_prefix: "/api"
  # The reverse proxy in front of the demo (scripts/demo/nginx/) sets the
  # X-Forwarded-* headers and terminates TLS; this is what makes the server
  # trust them (rate-limit keys + the generated URLs are correct behind it).
  trust_forwarded_headers: true
  # rate_limit: left at the demo defaults (50/s, burst 500) — the demo always
  # configures the framework limiter; set the block here to tune it.

logging:
  level: "info"
  format: "pretty"

jwt:
  secret: "$JWT_SECRET"
  issuer: "txresbench"
  audience: "txresbench-api"
  access_token_expiry_hours: 24
  refresh_token_expiry_days: 30

# The app's own SQLite store lives in the data dir (one file, no server).
database:
  path: "$DATA_DIR/txresbench.db"

demo:
  enabled: true
  download_url: "$DOWNLOAD_URL"
  history_limit: $HISTORY_LIMIT
  model_limit: $MODEL_LIMIT
  max_bytes: $MAX_BYTES
  replay_speed: $REPLAY_SPEED
  notice: "demo_banner"
  bundle_path: "$BUNDLE_DIR"
YAML
chmod 600 "$CONFIG_FILE"

# The cap: CAP_SH set (or the dev host's ops/cap.sh present) → capped with
# CAP_CPUS never above 4 (the node's rule); --no-cap or an absent wrapper
# runs uncapped (a deployment host without the sigtrans ops).
if [ "${CAP_SH+x}" != "x" ] && [ -x /data/share/pbya/sigtrans/ops/cap.sh ]; then
    CAP_SH=/data/share/pbya/sigtrans/ops/cap.sh
fi
CAP_CPUS="${CAP_CPUS:-4}"
if [ -n "${CAP_SH:-}" ] && [ -x "$CAP_SH" ]; then
    if [ "$CAP_CPUS" -gt 4 ]; then
        echo "run-demo: CAP_CPUS=$CAP_CPUS clamped to 4 (the node's rule)" >&2
        CAP_CPUS=4
    fi
    : "${TMPDIR_CAP:=$DATA_DIR/tmp}"
    mkdir -p "$TMPDIR_CAP"
    export CAP_CPUS TMPDIR_CAP
    LAUNCH=("$CAP_SH")
else
    LAUNCH=()
fi

export TXR_APP_DATA_DIR="$DATA_DIR"
export TXR_DEMO_BUNDLE="$BUNDLE_DIR"
echo "run-demo: TxResBench demo on $HOST:$PORT (data $DATA_DIR, bundle $BUNDLE_DIR)"
exec "${LAUNCH[@]}" "$BINARY" --config-file "$CONFIG_FILE" --demo
