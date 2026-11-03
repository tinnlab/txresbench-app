#!/usr/bin/env bash
# txr-sandbox-preflight.sh — check the host requirements of the TxResBench
# method sandbox WITHOUT changing anything. The non-destructive counterpart of
# `scripts/dev-sandbox-bootstrap.sh` (which FIXES two of these on a dev box):
# this one is the checklist the installer and the operator run (DEC-16), for
# the STACKED mode — one trimmed per-language base rootfs + one per-method
# layer per run, mounted by bwrap + squashfuse (see the `modules::sandbox`
# module doc, "Host requirements").
#
# Checks — the same list as `dev-sandbox-bootstrap.sh` plus `oras`, the one
# extra tool the txr env-FETCH path needs (PROV-SS-4 / CONS-SS-3):
#   1. host tools: bwrap, squashfuse, fusermount3 (bwrap/squashfuse are the
#      sandbox core; fusermount3 is how the squashfuse mount reaches bwrap)
#      and oras — resolved <app_data>/bin/oras FIRST, then PATH, exactly like
#      the server's `tool_bin` resolution (the installer places it at
#      `<app_data>/bin`, PROV-SS-4)
#   2. `user_allow_other` in /etc/fuse.conf — the rootfs is squashfuse-mounted
#      with `-o allow_other` and bwrap's uid-1001 process must be able to reach
#      it; `allow_other` from a NON-root mounter requires this flag (the
#      recommended posture; without it the mount silently never appears)
#   3. unprivileged-userns sysctls — ADVISORY: the 4th check is the proof, and
#      a sysctl that does not exist (older kernel / non-bare-metal) is not
#      itself a blocker
#   4. a fresh `/proc` in a NEW PID namespace (`unshare -Urpf --mount-proc`),
#      with any masked `/proc` over-mount named when the probe fails — the
#      sandbox REFUSES a no-PID-ns fallback (host /proc secret-exfil vector)
#
# Every missing/blocked item prints its EXACT remediation; the script exits
# non-zero when any REQUIRED item is missing or blocked, 0 when the host is
# ready. It runs only `unshare`/`sysctl`/`command -v` reads — no sudo, no
# config change, safe to run at any time.
#
# The server's own boot line is `sandbox: stack = { … }` (the same facts
# `GET /api/sandbox/envs`' `stack` section reports); this script is the
# human-facing checklist with the one-line fix per item.
set -u

# D01: the app-data dir is `~/.txresbench`; CYTO_APP_DATA_DIR overrides it,
# which is the same precedence the server's `data_root()` uses.
APP_DATA="${CYTO_APP_DATA_DIR:-$HOME/.txresbench}"

FAIL=0

printf '== TxResBench method-sandbox preflight ==\n'
printf 'app data dir: %s  (oras lookup: %s/bin/oras, then PATH)\n\n' "$APP_DATA" "$APP_DATA"

# ---------------------------------------------------------------------------
# 1. host tools
# ---------------------------------------------------------------------------
printf '[1/4] host tools (bwrap, squashfuse, fusermount3, oras)\n'

tool_ok() {
  local name="$1" found
  found="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$found" ]; then
    printf '  [ok]   %-14s %s\n' "$name" "$found"
    return 0
  fi
  printf '  [MISS] %-14s %s\n' "$name" "$2"
  FAIL=1
  return 1
}

tool_ok bwrap 'install bubblewrap (e.g. sudo apt install bubblewrap)'
tool_ok squashfuse 'install squashfuse (e.g. sudo apt install squashfuse)'
tool_ok fusermount3 'install fuse3 (e.g. sudo apt install fuse3)'

# oras: <app_data>/bin first, then PATH — the `tool_bin` resolution the server
# uses, so this check reports exactly what `tool_bins.oras` will report.
ORAS=""
if [ -x "$APP_DATA/bin/oras" ]; then
  ORAS="$APP_DATA/bin/oras"
else
  ORAS="$(command -v oras 2>/dev/null || true)"
fi
if [ -n "$ORAS" ]; then
  printf '  [ok]   %-14s %s\n' 'oras' "$ORAS"
else
  printf '  [MISS] %-14s %s\n' 'oras' "install oras (its release install script or your package manager), or place the binary at $APP_DATA/bin/oras"
  printf '         (env DOWNLOADS need it; a staged/air-gapped or already-cached environment still runs)\n'
  FAIL=1
fi
printf '\n'

# ---------------------------------------------------------------------------
# 2. /etc/fuse.conf
# ---------------------------------------------------------------------------
printf '[2/4] fuse: user_allow_other in /etc/fuse.conf\n'
FUSE_LINE=""
if [ -r /etc/fuse.conf ]; then
  while IFS= read -r line; do
    stripped="${line#"${line%%[![:space:]]*}"}"
    case "$stripped" in
      user_allow_other*) FUSE_LINE="$line" ;;
    esac
  done < /etc/fuse.conf
fi
if [ -n "$FUSE_LINE" ]; then
  printf '  [ok]   user_allow_other  enabled: %s\n' "$FUSE_LINE"
else
  printf '  [MISS] user_allow_other  enable it in /etc/fuse.conf: echo '\''user_allow_other'\'' | sudo tee -a /etc/fuse.conf\n'
  printf '         (install fuse3 first if the file is absent; needed by a NON-root mounter of `-o allow_other`)\n'
  FAIL=1
fi
printf '\n'

# ---------------------------------------------------------------------------
# 3. unprivileged userns sysctls (advisory — check 4 is the proof)
# ---------------------------------------------------------------------------
printf '[3/4] unprivileged userns sysctls (advisory; the /proc probe below is the proof)\n'
sysctl_warn() {
  local key="$1" want="$2" cur
  cur="$(sysctl -n "$key" 2>/dev/null || true)"
  if [ "$cur" = "$want" ]; then
    printf '  [ok]   %-44s %s\n' "$key" "$cur"
  elif [ -z "$cur" ]; then
    printf '  [note] %-44s unknown (sysctl unreadable/absent — not a blocker on a container host)\n' "$key"
  else
    printf '  [warn] %-44s %s (want %s) — sudo sysctl -w %s=%s (persist in /etc/sysctl.d/)\n' "$key" "$cur" "$want" "$key" "$want"
  fi
}
sysctl_warn kernel.unprivileged_userns_clone 1
sysctl_warn kernel.apparmor_restrict_unprivileged_userns 0
printf '\n'

# ---------------------------------------------------------------------------
# 4. fresh /proc in a new PID namespace (the sandbox refuses without it)
# ---------------------------------------------------------------------------
printf '[4/4] userns: fresh /proc in a new PID namespace\n'
if command -v unshare >/dev/null 2>&1; then
  if unshare -Urpf --mount-proc true 2>/dev/null; then
    printf '  [ok]   fresh /proc       unshare -Urpf --mount-proc succeeded\n'
  else
    printf '  [BLOCK] fresh /proc      a fresh /proc cannot be mounted in a new PID namespace\n'
    printf '         bare-metal host: enable unprivileged userns (sysctls above)\n'
    printf '         container: relaunch with --security-opt systempaths=unconfined (or otherwise leave /proc unmasked)\n'
    while read -r _ _ _ _ mnt _; do
      case "$mnt" in
        /proc/*) printf '           masked over-mount: %s\n' "$mnt" ;;
      esac
    done < /proc/self/mountinfo 2>/dev/null
    FAIL=1
  fi
else
  printf '  [note] fresh /proc       unshare not found (install util-linux) — probe not run\n'
fi
printf '\n'

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
if [ "$FAIL" -ne 0 ]; then
  printf 'preflight: FAILED — one or more required items above need attention (each MISS/BLOCK line shows its fix).\n'
  exit 1
fi
printf 'preflight: OK — the TxResBench method sandbox can stack on this host.\n'
exit 0
