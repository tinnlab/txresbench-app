# dev-desktop — TxResBench's desktop shell under a virtual display

The qa-hardening node's ITEM-5 harness: run the Tauri desktop binary the way a
clinician's double-click does, on a headless developer box, and see + capture
it from a browser.

| file | what it is |
|---|---|
| `run.sh` | Xvfb (`:99` 1440x900x24) → a WM if one exists (none on this box) → the desktop binary against a THROWAWAY data dir + the dev-registry settings → x11vnc (localhost only) → websockify/noVNC (`0.0.0.0:6080`) → readiness (server log line + `/api/health` + noVNC) → prints the URL |
| `stop.sh` | stops exactly the processes `run.sh` started (PID files, session-group TERM→KILL, never `pkill -f`), verifies nothing is left |
| `screenshot.sh` | captures the virtual screen to a PNG through the noVNC canvas (headless chromium); exits non-zero on a blank screen |
| `novnc-shot.mjs` | the capture itself (playwright against the RFB canvas — the canvas IS the framebuffer) |

## Quick start

```sh
# one-time
# 1. build the UI bundle (embedded into the binary at compile time)
CAP_CPUS=2 TMPDIR_CAP=/data/pbya/txresbench-app-work/tmp-qa-hardening \
  /data/share/pbya/sigtrans/ops/cap.sh npm run build --workspace=@cytoanalyst/ui
# 2. build the desktop binary (PRODUCTION shape — embeds the dist)
TMPDIR_CAP=/data/pbya/txresbench-app-work/tmp-qa-hardening \
CAP_CPUS=2 CARGO_TARGET_DIR=/data/pbya/txresbench-app-work/target/qa-hardening \
  /data/share/pbya/sigtrans/ops/cap.sh \
  cargo build -p cytoanalyst-desktop --features tauri/custom-protocol

# run / look / capture / stop
scripts/dev-desktop/run.sh                 # prints http://127.0.0.1:6080/vnc.html
scripts/dev-desktop/screenshot.sh          # PNG into $TXR_DESKTOP_STATE/shots/
scripts/dev-desktop/stop.sh
```

## What it starts

| process | how |
|---|---|
| Xvfb | `:99`, 1440x900x24, `-ac -nolisten tcp` (own session, pid file) |
| window manager | detected from a host list; none exists on this box (the window maps without server-side decorations) |
| `cytoanalyst-desktop` | through `dbus-run-session` with `HOME` + `CYTO_APP_DATA_DIR` pointing INSIDE the throwaway state dir (the user's `~/.txresbench` is never touched), `CYTO_TXR_METHOD_ENV_REGISTRY` + `CYTO_TXR_ENV_MANIFEST` set when the ITEM-2 dev manifest exists, and the `oras` dev shim staged at `<data>/bin/oras` so real runs can fetch method environments; writes `logs/app.log` |
| x11vnc | `-localhost` only (`:5900`), no password, `-forever -shared` |
| websockify | `--web /usr/share/novnc` on `0.0.0.0:6080` → `localhost:5900` |

State (pids, logs, the throwaway `data/`+`home/`, shots): `/data/pbya/txresbench-app-work/dev-desktop`
(`TXR_DESKTOP_STATE` to override; the harness refuses to wipe a state dir that
does not carry its marker file). Every process is launched through
`ops/cap.sh` with `CAP_CPUS=2` (the default; never raise it) and `TMPDIR` under
app-work.

## The binary shape — why `--features tauri/custom-protocol`

The plan says "plain `cargo build`". A plain `cargo build` of the desktop crate
is a **dev-mode** binary (Tauri's `custom-protocol` feature is what the CLI
manages): it would load `http://localhost:5173` — a URL nobody in this harness
starts, and possibly one a sibling worktree's dev server owns. Building with
`--features tauri/custom-protocol` keeps "plain cargo build, no installer
bundling, no tauri CLI" while making the binary the production shape: the UI
is embedded from `src-app/ui/dist` at compile time (the dist must exist —
`npm run build` first) and the window needs no dev server. Recorded as a
drift entry (impl-wins; PLAN amended).

## Knobs (all env, all optional)

`TXR_DESKTOP_STATE` · `TXR_DESKTOP_DISPLAY` (99) · `TXR_DESKTOP_VNC_PORT`
(5900) · `TXR_DESKTOP_NOVNC_PORT` (6080) · `TXR_DESKTOP_NOVNC_BIND` (0.0.0.0 —
the plan's value; x11vnc itself stays localhost-only) ·
`TXR_DESKTOP_BIN` · `TXR_REGISTRY_HOST` · `TXR_ENV_MANIFEST` ·
`TXR_DESKTOP_APP_TIMEOUT` (180 s) · `CAP_CPUS` (2).

## What TEST-QA-5 proves

`run.sh` brings the app window up on the virtual display (screenshot is
non-blank; `xwininfo`/`xdpyinfo` show the 1200x800 window titled
`TxResBench`), the embedded server's `/api/health` answers, noVNC answers on
`:6080`, and `stop.sh` leaves no process behind (pid files gone, the display
is gone, the ports are silent). Every claim is checked by
`scripts/dev-desktop/verify.sh`-style manual steps in the item report; nothing
else in the repo is touched.

## Desktop-only checks to drive while it runs

window size + title (`xwininfo -root -tree`), data directory (state dir only),
startup readiness (log + health; the boot-failure window surface), external
links (opener plugin → `xdg-open` when the UI opens one — not exercised by the
default screen), file pickers / drag-drop (native dialogs need a WM/X focus —
recorded honestly in the item report), shutdown (`stop.sh`; the app also
exits cleanly on display teardown).
