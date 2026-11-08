#!/usr/bin/env bash
# stop.sh — ITEM-5 (node qa-hardening): stop exactly the processes run.sh
# started, from the PID files it wrote. Never `pkill -f`: each daemon was
# started inside its OWN session (setsid) and its session leader's PID was
# recorded, so this script kills by recorded session (TERM, then KILL after a
# grace) and verifies nothing is left.
#
# Usage:
#   scripts/dev-desktop/stop.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="${TXR_DESKTOP_STATE:-/data/pbya/txresbench-app-work/dev-desktop}"
DISPLAY_NUM="${TXR_DESKTOP_DISPLAY:-99}"

[ -d "$STATE_DIR/pids" ] || { echo "stop.sh: no dev-desktop state at $STATE_DIR (nothing to stop)"; exit 0; }

# kill_session NAME GRACE_SECS — TERM the recorded session (the recorded pid
# is the setsid session leader, so its pgid == its pid), wait, then KILL the
# same session; forget the pid file either way.
kill_session() {
  local name="$1" grace="$2"
  local pidfile="$STATE_DIR/pids/$name.pid"
  [ -f "$pidfile" ] || return 0
  local pid
  pid="$(cat "$pidfile")"
  local shown=stopped
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    local i
    for ((i = 1; i <= grace; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      [ "$i" = "$grace" ] || sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then shown=LEFT; else shown=killed; fi
    fi
  fi
  rm -f "$pidfile"
  echo "stop.sh: $name (pid $pid) $shown"
}

# Order matters: the app first (it holds the X connection + the embedded
# server), then the WM, then the network daemons, then Xvfb.
kill_session vnc 5
kill_session app 10
kill_session wm 5
kill_session novnc 5
kill_session xvfb 5

NOVNC_PORT="$(sed -n 's/^novnc_port=//p' "$STATE_DIR/current" 2>/dev/null || true)"
[ -n "$NOVNC_PORT" ] || NOVNC_PORT="${TXR_DESKTOP_NOVNC_PORT:-6080}"
rm -f "$STATE_DIR/current"

# --- verify: nothing we started is left --------------------------------------
LEFT=0
for f in "$STATE_DIR"/pids/*.pid; do
  [ -e "$f" ] || continue
  echo "stop.sh: pid file left behind: $f" >&2
  LEFT=1
done

if [ -f "$STATE_DIR/logs/novnc.log" ] && curl -fsS -o /dev/null --max-time 2 \
      "http://127.0.0.1:$NOVNC_PORT/vnc.html"; then
  echo "stop.sh: noVNC still answers on :$NOVNC_PORT" >&2
  LEFT=1
fi

# The display must be gone — with it, the whole virtual desktop is down.
if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
  echo "stop.sh: display :$DISPLAY_NUM is still up (started outside this harness?)" >&2
  LEFT=1
fi

if [ "$LEFT" = 1 ]; then
  exit 1
fi
echo "stop.sh: nothing left running"
