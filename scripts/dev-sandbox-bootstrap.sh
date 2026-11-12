#!/usr/bin/env bash
# dev-sandbox-bootstrap.sh — make the TxResBench analysis sandbox runnable on a
# local dev box. Idempotent; safe to re-run. Applies the two HOST properties the
# server cannot set itself (see `modules::sandbox` doc "Host requirements"):
#
#   2. user_allow_other in /etc/fuse.conf   (squashfuse -o allow_other for non-root)
#   3. an unmasked /proc                     (so the sandbox can mount its own /proc
#                                             in a fresh PID namespace)
#
# The code fixes (runner panic, data/opaque datatype, 64 GiB address-space default)
# ship in the binary/migrations — this script only covers the host side.
#
# NOTE: #3 (the /proc unmask) is a runtime change that RESETS if the container is
# recreated. The durable answer for a containerized dev/prod host is to launch the
# container with `--security-opt systempaths=unconfined` (or otherwise not mask
# /proc); this script is the in-place fallback when you can't change how the
# container was started. On a bare-metal host, #3 is usually a no-op.
set -euo pipefail

log() { printf '  %s\n' "$*"; }

echo "== TxResBench dev sandbox bootstrap =="

# --- 1. packages (informational check only; install is distro-specific) ---
missing=()
for bin in bwrap squashfuse fusermount3; do command -v "$bin" >/dev/null 2>&1 || missing+=("$bin"); done
if [ "${#missing[@]}" -gt 0 ]; then
  log "MISSING host tools: ${missing[*]} — install e.g.: sudo apt install bubblewrap squashfuse fuse3"
else
  log "host tools present: bubblewrap, squashfuse, fuse3"
fi

# --- 2. user_allow_other in /etc/fuse.conf ---
if grep -qE '^[[:space:]]*user_allow_other' /etc/fuse.conf 2>/dev/null; then
  log "/etc/fuse.conf: user_allow_other already enabled"
else
  log "/etc/fuse.conf: enabling user_allow_other (sudo)"
  if grep -qE '^[[:space:]]*#user_allow_other' /etc/fuse.conf 2>/dev/null; then
    sudo sed -i 's/^[[:space:]]*#user_allow_other/user_allow_other/' /etc/fuse.conf
  else
    echo 'user_allow_other' | sudo tee -a /etc/fuse.conf >/dev/null
  fi
fi

# --- 3. unprivileged-userns sysctls (bare host) ---
for kv in kernel.apparmor_restrict_unprivileged_userns=0 kernel.unprivileged_userns_clone=1; do
  key=${kv%=*}; want=${kv#*=}
  cur=$(sysctl -n "$key" 2>/dev/null || echo "")
  if [ -n "$cur" ] && [ "$cur" != "$want" ]; then
    log "sysctl $key: $cur -> $want (sudo)"; sudo sysctl -w "$kv" >/dev/null || true
  fi
done

# --- 3b. verify a fresh /proc mount actually works; if not, hunt a masked over-mount ---
if unshare -Urpf --mount-proc true 2>/dev/null; then
  log "PID-ns + fresh /proc: OK"
else
  log "PID-ns + fresh /proc: BLOCKED (likely a masked /proc over-mount)"
  masks=$(awk '$5 ~ /^\/proc\// {print $5}' /proc/self/mountinfo 2>/dev/null || true)
  if [ -n "$masks" ]; then
    log "  masked /proc submounts detected:"; printf '    %s\n' $masks
    for m in $masks; do log "  unmounting $m (sudo)"; sudo umount "$m" 2>/dev/null || log "    (could not unmount $m)"; done
    if unshare -Urpf --mount-proc true 2>/dev/null; then
      log "  fixed: fresh /proc now mounts. (Reverts if the container is recreated —"
      log "         prefer launching the container with --security-opt systempaths=unconfined.)"
    else
      log "  STILL blocked — this host cannot mount a fresh /proc unprivileged."
      log "  Re-launch the container with: --security-opt systempaths=unconfined"
    fi
  else
    log "  no masked /proc submount found — check CONFIG_USER_NS / container caps."
  fi
fi

echo "== done =="
