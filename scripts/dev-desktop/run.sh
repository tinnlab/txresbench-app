#!/usr/bin/env bash
# run.sh — ITEM-5 (node qa-hardening): the TxResBench desktop shell under a
# virtual display, streamed to a browser over noVNC.
#
# Starts, in order: Xvfb (:99, 1440x900x24), a minimal window manager if one
# exists on the host (none on this box — a WM-less Xvfb still maps the window,
# just without server-side decorations), the Tauri desktop binary against a
# throwaway data dir + the dev-registry settings, x11vnc (localhost only) and
# websockify serving noVNC from /usr/share/novnc. Every process is launched
# through ops/cap.sh (CAP_CPUS=2) inside its OWN session (setsid) and its
# PID (= session leader) is recorded as a pid file, so stop.sh kills exactly
# the processes this script started — never `pkill -f`.
#
# The desktop binary is the PRODUCTION-shaped one: built with
# `--features tauri/custom-protocol`, so the web UI is embedded from
# src-app/ui/dist at compile time and the window needs no dev server
# (see README.md; without the feature a plain cargo build is a dev-mode
# binary that would load http://localhost:5173, which may belong to a
# sibling worktree).
#
# Usage:
#   scripts/dev-desktop/run.sh            # start everything, print the URL
#   TXR_DESKTOP_BIN=/path/to/binary scripts/dev-desktop/run.sh
#   TXR_DESKTOP_DISPLAY=98 TXR_DESKTOP_NOVNC_PORT=6081 scripts/dev-desktop/run.sh
#
# Stops with: scripts/dev-desktop/stop.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CAP=/data/share/pbya/sigtrans/ops/cap.sh
SHUTDOWN_ON_FAIL=0

# --- configuration (every knob has an env override) -------------------------
STATE_DIR="${TXR_DESKTOP_STATE:-/data/pbya/txresbench-app-work/dev-desktop}"
DISPLAY_NUM="${TXR_DESKTOP_DISPLAY:-99}"
VNC_PORT="${TXR_DESKTOP_VNC_PORT:-5900}"
NOVNC_PORT="${TXR_DESKTOP_NOVNC_PORT:-6080}"
NOVNC_BIND="${TXR_DESKTOP_NOVNC_BIND:-0.0.0.0}"
NOVNC_WEB="${TXR_DESKTOP_NOVNC_WEB:-/usr/share/novnc}"
CAP_CPUS="${CAP_CPUS:-2}"
# The dev-registry settings the app's debug build reads (ITEM-2 seams).
REGISTRY_HOST="${TXR_REGISTRY_HOST:-127.0.0.1:5055}"
ENV_MANIFEST="${TXR_ENV_MANIFEST:-/data/pbya/txresbench-app-work/qa-build-real/method-env-images.dev.json}"
BIN="${TXR_DESKTOP_BIN:-}"
[ -n "$BIN" ] || BIN="${CARGO_TARGET_DIR:-/data/pbya/txresbench-app-work/target/qa-hardening}/debug/txresbench-desktop"
[ -e "$BIN" ] || BIN="$REPO/src-app/desktop/tauri/target/debug/txresbench-desktop"
[ -e "$BIN" ] || BIN="$REPO/src-app/desktop/tauri/target/debug/txresbench-desktop"

APP_READY_TIMEOUT="${TXR_DESKTOP_APP_TIMEOUT:-180}"
TMPDIR_CAP="${TMPDIR_CAP:-/data/pbya/txresbench-app-work/tmp-qa-hardening}"
mkdir -p "$TMPDIR_CAP"

# --- helpers -----------------------------------------------------------------
warn() { echo "run.sh: $*" >&2; }
fail() { echo "run.sh: $*" >&2; exit 1; }

cleanup_on_abort() {
  if [ "$SHUTDOWN_ON_FAIL" = "1" ] && [ -f "$STATE_DIR/pids/app.pid" ]; then
    echo "run.sh: aborting — stopping the processes this script started" >&2
    TXR_DESKTOP_STATE="$STATE_DIR" "$REPO/scripts/dev-desktop/stop.sh" || true
  fi
}
trap cleanup_on_abort EXIT

for tool in Xvfb x11vnc websockify xdpyinfo curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"
done
[ -d "$NOVNC_WEB" ] || fail "noVNC web root not found: $NOVNC_WEB"
[ -x "$BIN" ] || fail "desktop binary not found: $BIN (build: cargo build -p txresbench-desktop --features tauri/custom-protocol; env TXR_DESKTOP_BIN to override)"
[ -x "$CAP" ] || fail "ops/cap.sh not found: $CAP"
[ "$NOVNC_BIND" = "127.0.0.1" ] || [ "$NOVNC_BIND" = "localhost" ] || \
  warn "noVNC bound to $NOVNC_BIND (the plan's 0.0.0.0; x11vnc itself stays localhost-only)"

# A running instance owns the state dir; refuse to stack a second one.
if [ -f "$STATE_DIR/pids/app.pid" ] && kill -0 "$(cat "$STATE_DIR/pids/app.pid" 2>/dev/null)" 2>/dev/null; then
  fail "a desktop instance is already running (pid $(cat "$STATE_DIR/pids/app.pid")); stop it first (stop.sh)"
fi

# Throwaway data dir: never touches the user's ~/.txresbench. The wipe is
# guarded by the harness marker so a mistyped TXR_DESKTOP_STATE cannot erase
# anything that is not ours.
mkdir -p "$STATE_DIR"
MARKER=".txr-dev-desktop"
if [ -e "$STATE_DIR/$MARKER" ] && [ ! -f "$STATE_DIR/$MARKER" ]; then
  fail "$STATE_DIR exists but is not a txr-dev-desktop state dir (the marker is not a file)"
fi
printf 'ITEM-5 dev-desktop harness state dir: %s\n' "$STATE_DIR" >"$STATE_DIR/$MARKER"

for d in pids logs shots data home; do mkdir -p "$STATE_DIR/$d"; done
rm -rf "$STATE_DIR/data" "$STATE_DIR/home"
mkdir -p "$STATE_DIR/data" "$STATE_DIR/data/bin" "$STATE_DIR/home"
: >"$STATE_DIR/current"

# Stage the oras shim the app's method-env fetch shells out to (tool_bin
# prefers <app_data>/bin over PATH, method_env.rs). Without it a real run
# answers ENV_UNREADY "oras is not installed" — the ITEM-3 finding.
cp "$REPO/scripts/dev-registry/oras_dev.py" "$STATE_DIR/data/bin/oras"
chmod 755 "$STATE_DIR/data/bin/oras"

# --- helpers: record + kill by session (never pkill -f) ----------------------
start_one() {
  # start_one NAME LOGFILE CMD... — starts CMD via cap.sh inside its OWN
  # session (setsid). `setsid` forks when its caller is a process-group leader
  # (the backgrounded subshell is), so the REAL session leader's pid is written
  # by the `sh -c` wrapper into the pid file before it execs CMD — the pid
  # file therefore always names the group leader and stop.sh can kill the
  # whole session (daemon + WebKit/bwrap children) with one group signal.
  local name="$1" log="$2"; shift 2
  local pidfile="$STATE_DIR/pids/$name.pid"
  rm -f "$pidfile"
  ( TMPDIR_CAP="$TMPDIR_CAP"; CAP_CPUS="$CAP_CPUS" "$CAP" \
      setsid sh -c 'echo $$ >"$1"; shift; exec "$@"' _ "$pidfile" "$@" ) >"$log" 2>&1 &
  local i
  for ((i = 1; i <= 15; i++)); do
    [ -s "$pidfile" ] && break
    sleep 1
  done
  [ -s "$pidfile" ] || fail "$name never wrote its pid; log: $log"
  local pid
  pid="$(cat "$pidfile")"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    fail "$name (pid $pid) died on start; log: $log"
  fi
}

pid_of() { cat "$STATE_DIR/pids/$1.pid" 2>/dev/null || true; }

# --- Xvfb --------------------------------------------------------------------
if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
  fail "display :$DISPLAY_NUM is already in use (another X server?); choose TXR_DESKTOP_DISPLAY"
fi
SHUTDOWN_ON_FAIL=1
start_one xvfb "$STATE_DIR/logs/xvfb.log" \
  Xvfb ":$DISPLAY_NUM" -screen 0 1440x900x24 -ac -nolisten tcp
for _ in $(seq 1 30); do
  xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1 && break
  sleep 1
done
xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1 || fail "Xvfb :$DISPLAY_NUM never became ready; log: $STATE_DIR/logs/xvfb.log"

# --- window manager (a WM exists on some hosts; none on this box) ------------
WM=""
for candidate in openbox fluxbox twm metacity xfwm4 mutter marco icewm jwm fvwm kwin_x11; do
  if command -v "$candidate" >/dev/null 2>&1; then WM="$candidate"; break; fi
done
if [ -n "$WM" ]; then
  start_one wm "$STATE_DIR/logs/wm.log" "$WM"
  warn "window manager: $WM"
else
  warn "no window manager found on this host — the app window gets no server-side decorations (decoration is a WM job); the window still maps and renders"
fi

# --- the desktop binary ------------------------------------------------------
REG=""
if [ -f "$ENV_MANIFEST" ]; then
  REG="TXR_METHOD_ENV_REGISTRY=$REGISTRY_HOST TXR_ENV_MANIFEST=$ENV_MANIFEST"
  warn "dev-registry settings: registry=$REGISTRY_HOST manifest=$ENV_MANIFEST"
else
  warn "dev environment manifest not found ($ENV_MANIFEST) — starting WITHOUT the dev-registry seams; method-env fetches would use the compiled ghcr.io host (and fail offline)"
fi
start_one app "$STATE_DIR/logs/app.log" \
  env DISPLAY=":$DISPLAY_NUM" \
      HOME="$STATE_DIR/home" \
      TXR_APP_DATA_DIR="$STATE_DIR/data" \
      $REG \
      dbus-run-session -- "$BIN"

# --- x11vnc (localhost only) + websockify/noVNC ------------------------------
start_one vnc "$STATE_DIR/logs/vnc.log" \
  x11vnc -display ":$DISPLAY_NUM" -localhost \
         -rfbport "$VNC_PORT" -forever -shared -nopw -norc
start_one novnc "$STATE_DIR/logs/novnc.log" \
  websockify --web "$NOVNC_WEB" --heartbeat 30 \
             "$NOVNC_BIND:$NOVNC_PORT" "localhost:$VNC_PORT"

# --- readiness ---------------------------------------------------------------
APP_ADDR=""
for _ in $(seq 1 "$APP_READY_TIMEOUT"); do
  APP_ADDR="$(sed -n 's/.*embedded server ready on \([0-9.]*:[0-9]*\).*/\1/p' "$STATE_DIR/logs/app.log" | tail -1)"
  [ -n "$APP_ADDR" ] && break
  kill -0 "$(pid_of app)" 2>/dev/null || fail "the desktop app exited; log: $STATE_DIR/logs/app.log"
  sleep 1
done
[ -n "$APP_ADDR" ] || fail "no 'embedded server ready' line within ${APP_READY_TIMEOUT}s; log: $STATE_DIR/logs/app.log"
APP_PORT="${APP_ADDR##*:}"
HEALTH=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://$APP_ADDR/api/health"; then HEALTH=ok; break; fi
  sleep 1
done
[ "$HEALTH" = ok ] || fail "health endpoint http://$APP_ADDR/api/health did not answer"

for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$NOVNC_PORT/vnc.html"; then break; fi
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$NOVNC_PORT/vnc.html" || fail "noVNC on :$NOVNC_PORT did not answer"

# --- summary -----------------------------------------------------------------
SHUTDOWN_ON_FAIL=0
{
  echo "app=$APP_ADDR"
  echo "vnc_port=$VNC_PORT"
  echo "novnc_port=$NOVNC_PORT"
  echo "started_epoch=$(date +%s)"
  echo "display=:$DISPLAY_NUM"
} >"$STATE_DIR/current"

echo
echo "TxResBench desktop is up:"
echo "  window title      TxResBench (1200x800 inner; WM decorations: $([ -n "$WM" ] && echo "$WM" || echo none))"
echo "  virtual display   :$DISPLAY_NUM (1440x900x24)"
echo "  embedded server   http://$APP_ADDR  (health ok, port $APP_PORT)"
echo "  app data dir      $STATE_DIR/data (throwaway; HOME=$STATE_DIR/home)"
echo "  vnc               localhost:$VNC_PORT (x11vnc, localhost only)"
echo "  noVNC             http://127.0.0.1:$NOVNC_PORT/vnc.html"
echo "  screenshot        scripts/dev-desktop/screenshot.sh"
echo "  stop              scripts/dev-desktop/stop.sh"
