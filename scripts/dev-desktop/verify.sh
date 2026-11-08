#!/usr/bin/env bash
# verify.sh — ITEM-5 (node qa-hardening): TEST-QA-5's assertions against a
# running dev-desktop instance. Exit 0 only when every check passes.
#
#   1. the virtual display is up at the configured size/depth
#   2. a window titled `TxResBench` exists, ~1200x800 (window size + title —
#      xwininfo's WM_NAME, the same title Tauri set in desktop_window_config)
#   3. the embedded server's /api/health answers on the address the app logged
#   4. noVNC answers on :NOVNC_PORT
#   5. screenshot.sh produces a NON-BLANK PNG of the virtual screen
#
# Usage:
#   scripts/dev-desktop/verify.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="${TXR_DESKTOP_STATE:-/data/pbya/txresbench-app-work/dev-desktop}"
DISPLAY_NUM="${TXR_DESKTOP_DISPLAY:-99}"
NOVNC_PORT="${TXR_DESKTOP_NOVNC_PORT:-6080}"
OUT="$STATE_DIR/shots/verify-$(date +%Y%m%d-%H%M%S).png"

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*" >&2; exit 1; }

[ -f "$STATE_DIR/pids/app.pid" ] && kill -0 "$(cat "$STATE_DIR/pids/app.pid")" 2>/dev/null \
  || fail "no running dev-desktop instance (start it with run.sh)"

# 1. display
xdpyinfo -display ":$DISPLAY_NUM" >"$STATE_DIR/logs/verify-xdpyinfo.txt" 2>&1 \
  || fail "xdpyinfo: display :$DISPLAY_NUM not reachable"
DIMS="$(xdpyinfo -display ":$DISPLAY_NUM" | awk '/dimensions:/{d=$2} /depth of root window:/{p=$5} END{print d" "p}')"
[ "$DIMS" = "1440x900 24" ] || fail "unexpected display dimensions/depth: '$DIMS' (want 1440x900 24)"
pass "virtual display :$DISPLAY_NUM is 1440x900x24"

# 2. the app window (title + inner size, xwininfo reads the X property the
#    Tauri window set — no WM on this box, so there are no decorations to
#    subtract and the X geometry IS the window)
xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1
WINTREE="$(xwininfo -display ":$DISPLAY_NUM" -root -tree 2>/dev/null || true)"
if ! printf '%s\n' "$WINTREE" | grep -q '"TxResBench"'; then
  printf '%s\n' "$WINTREE" | head -20
  fail "no window titled TxResBench on :$DISPLAY_NUM"
fi
GEO="$(printf '%s\n' "$WINTREE" | grep '"TxResBench"' | head -1 | sed -n 's/.*"TxResBench".*: ([^)]*)  *\([0-9]*x[0-9]*+[0-9]*+[0-9]*\).*/\1/p')"
case "$GEO" in
  1200x800*|1201x800*|1200x801*|1201x801*) : ;;
  *) fail "window TxResBench has an unexpected geometry: '$GEO' (want ~1200x800)" ;;
esac
pass "window TxResBench is on the display (geometry $GEO)"

# 3. embedded server health (the address the app logged)
APP_ADDR="$(sed -n 's/^app=//p' "$STATE_DIR/current" 2>/dev/null || true)"
[ -n "$APP_ADDR" ] || fail "no app address in $STATE_DIR/current (run.sh did not finish its readiness poll?)"
curl -fsS -o /dev/null "http://$APP_ADDR/api/health" || fail "health endpoint http://$APP_ADDR/api/health did not answer"
pass "embedded server http://$APP_ADDR/api/health answers"

# 4. noVNC
curl -fsS -o /dev/null "http://127.0.0.1:$NOVNC_PORT/vnc.html" || fail "noVNC did not answer on :$NOVNC_PORT"
pass "noVNC answers on :$NOVNC_PORT"

# 5. screenshot (non-blank, proven by novnc-shot.mjs's pixel statistics;
#    the window title check is #2 — OCR is not available on this box)
"$REPO/scripts/dev-desktop/screenshot.sh" "$OUT" >/dev/null
[ -s "$OUT" ] || fail "screenshot is empty: $OUT"
pass "screenshot non-blank: $OUT"

echo
echo "TEST-QA-5: all checks passed"
