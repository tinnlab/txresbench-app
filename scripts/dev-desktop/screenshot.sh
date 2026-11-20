#!/usr/bin/env bash
# screenshot.sh — ITEM-5 (node qa-hardening): capture the virtual X display
# (the Xvfb screen run.sh started) to a PNG.
#
# There is no `import`/`xwd`/`ffmpeg`/`scrot` on this box; the host tool that
# exists is the repo's playwright chromium, so the capture goes through the
# noVNC page websockify serves: headless chromium loads
# http://127.0.0.1:6080/vnc.html, connects through websockify to the
# localhost-only x11vnc, and screenshots the RFB canvas — the canvas is the
# live framebuffer, so the PNG shows the real desktop, not a page re-render
# (see novnc-shot.mjs). The script exits non-zero when the screen is blank.
#
# Usage:
#   scripts/dev-desktop/screenshot.sh                    # -> $STATE_DIR/shots/desktop-<ts>.png
#   scripts/dev-desktop/screenshot.sh /path/out.png      # explicit output path
#   TXR_DESKTOP_NOVNC_PORT=6081 scripts/dev-desktop/screenshot.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# Must match run.sh's default: the work root is env-overridable.
WORK_DIR="${TXR_WORK_DIR:-$HOME/.cache/txresbench-dev}"
STATE_DIR="${TXR_DESKTOP_STATE:-$WORK_DIR/dev-desktop}"
NOVNC_PORT="${TXR_DESKTOP_NOVNC_PORT:-6080}"
OUT="${1:-$STATE_DIR/shots/desktop-$(date +%Y%m%d-%H%M%S).png}"

fail() { echo "screenshot.sh: $*" >&2; exit 1; }

[ -f "$STATE_DIR/pids/app.pid" ] && kill -0 "$(cat "$STATE_DIR/pids/app.pid")" 2>/dev/null \
  || fail "no running dev-desktop instance (start it with run.sh)"
command -v node >/dev/null 2>&1 || fail "node not found"
[ -d "$REPO/node_modules/playwright" ] || fail "playwright not installed in the repo node_modules"
curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$NOVNC_PORT/vnc.html" \
  || fail "noVNC is not answering on :$NOVNC_PORT (is run.sh's websockify up?)"

mkdir -p "$(dirname "$OUT")"
TMPDIR_CAP="${TMPDIR_CAP:-$WORK_DIR/tmp-qa-hardening}"
mkdir -p "$TMPDIR_CAP" || true

# The browser is capped like everything else on this box (the dev-desktop
# harness runs through CAP_SH); the node process does the HTTP + capture.
CAP_SH="${CAP_SH:-}"
if [ -n "$CAP_SH" ] && [ ! -x "$CAP_SH" ]; then
  fail "CAP_SH=$CAP_SH is not an executable cap wrapper (empty = uncapped)"
fi
if [ -n "$CAP_SH" ]; then
  TMPDIR_CAP="$TMPDIR_CAP" CAP_CPUS="${CAP_CPUS:-2}" "$CAP_SH" \
    node "$REPO/scripts/dev-desktop/novnc-shot.mjs" \
    --out "$OUT" --url "http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=1" --timeout 90
else
  TMPDIR_CAP="$TMPDIR_CAP" \
    node "$REPO/scripts/dev-desktop/novnc-shot.mjs" \
    --out "$OUT" --url "http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=1" --timeout 90
fi
echo "screenshot.sh: $OUT"
