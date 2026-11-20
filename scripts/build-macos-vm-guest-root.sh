#!/bin/sh
# build-macos-vm-guest-root.sh: assemble the guest root the macOS method VM boots.
#
# The VM (src-app/server/src/modules/sandbox/mac_vm_run.rs) boots libkrun with this
# directory as its root: an Alpine userland with bubblewrap, the static guest agent
# (sdk/crates/sandbox-guest-agent) at /usr/bin/txresbench-sandbox-agent, the mount
# points the agent and the run seam use, and /etc/txresbench-agent-protocol, which
# holds the protocol versions the agent serves ("MIN MAX"). The server's boot probe
# (`probe_host`) refuses a guest root without that marker or whose range does not cover
# what the app needs, so a guest root built for an older agent is never booted. The
# marker is written last, only after every other step succeeded.
#
# Usage:  sh scripts/build-macos-vm-guest-root.sh <out-dir>
#   Builds into a temporary sibling of <out-dir>, then swaps it into place. An existing
#   <out-dir> is replaced only if it is itself a guest root (it has the agent binary);
#   any other existing path is refused.
#   Point a debug build of the app at the result with TXR_SANDBOX_GUEST_ROOT=<out-dir> (a release
#   build reads only the runtime it ships).
#
# Needs Docker able to run linux/arm64 containers (Docker Desktop on Apple Silicon).
# The pinned build images and the agent build are shared with scripts/build-wsl-rootfs.sh
# (scripts/guest-root-common.sh).
set -eu

die() { echo "build-macos-vm-guest-root: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: sh scripts/build-macos-vm-guest-root.sh <out-dir>"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/scripts/guest-root-common.sh"
OUT_PARENT=$(cd "$(dirname "$1")" 2>/dev/null && pwd) || die "the parent of $1 does not exist"
OUT="$OUT_PARENT/$(basename "$1")"
AGENT_REL=usr/bin/txresbench-sandbox-agent
MARKER_REL=etc/txresbench-agent-protocol

if [ -e "$OUT" ] && [ ! -f "$OUT/$AGENT_REL" ]; then
  die "$OUT exists and is not a guest root (no /$AGENT_REL); refusing to replace it"
fi

# The protocol versions the agent serves, read from their one declaration.
guest_protocol_range "$ROOT" || die "cannot read the agent protocol versions"
VERSION=$GUEST_PROTOCOL_MAX
MIN_VERSION=$GUEST_PROTOCOL_MIN

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

# The Alpine image, pinned by digest (guest-root-common.sh). The apk package versions are
# not pinned: they come from the Alpine 3.20 repository at build time.
ALPINE_IMAGE=$(guest_alpine_image aarch64)

STAGE="$OUT.building.$$"
cleanup() { rm -rf "$STAGE" "$STAGE.agent"; }
trap cleanup EXIT INT TERM
mkdir "$STAGE"

echo "build-macos-vm-guest-root: building the guest agent (static aarch64-musl)" >&2
mkdir "$STAGE.agent"
guest_build_agent "$ROOT" aarch64 "$STAGE.agent" || die "the guest agent build failed"

echo "build-macos-vm-guest-root: assembling the Alpine userland" >&2
# Device nodes are left out: the guest kernel provides /dev, and they cannot be
# created on the Mac without root.
# The new root starts with the image's own signing keys, so every package,
# alpine-keys included, is verified against them.
docker run --rm --platform linux/arm64 "$ALPINE_IMAGE" sh -c '
  set -e
  mkdir -p /root-stage/etc/apk/keys
  cp /etc/apk/repositories /root-stage/etc/apk/
  cp /etc/apk/keys/* /root-stage/etc/apk/keys/
  apk --root /root-stage --initdb --no-cache add alpine-keys alpine-baselayout busybox musl libseccomp bubblewrap util-linux >/dev/null
  cd /root-stage
  tar -cf - --exclude=./dev/console --exclude=./dev/null --exclude=./dev/zero \
    --exclude=./dev/urandom --exclude=./dev/random --exclude=./dev/full --exclude=./dev/tty .' \
  | tar -xf - -C "$STAGE" || die "assembling the Alpine userland failed"

# Mount points: the guest root is read-only in the VM, so each must exist.
#   proc, sys/fs/cgroup, dev, tmp, run: the agent's own mounts
#   sandbox-rootfs, sandbox-layer:      the method's base and layer disks (/dev/vda, /dev/vdb)
#   workspace, host-mounts:             virtio-fs shares from the host
for d in proc sys/fs/cgroup dev tmp run sandbox-rootfs sandbox-layer workspace host-mounts; do
  mkdir -p "$STAGE/$d"
done
# Identity files bwrap binds over the sandbox's /etc/passwd and /etc/group.
echo "sandboxuser:x:1001:1001:Sandbox User:/home/sandboxuser:/bin/bash" > "$STAGE/etc/txresbench-sandbox-passwd"
echo "sandboxuser:x:1001:" > "$STAGE/etc/txresbench-sandbox-group"
: > "$STAGE/etc/txresbench-sandbox-empty"
install -m 0755 "$STAGE.agent/txresbench-sandbox-agent" "$STAGE/$AGENT_REL"

for f in usr/bin/bwrap "$AGENT_REL" bin/busybox; do
  [ -f "$STAGE/$f" ] || die "the assembled guest root has no /$f"
done

# Last: the marker that tells the server this guest root is complete and which
# protocol versions its agent serves.
printf '%s %s\n' "$MIN_VERSION" "$VERSION" > "$STAGE/$MARKER_REL"

if [ -e "$OUT" ]; then
  mv "$OUT" "$OUT.old.$$"
  mv "$STAGE" "$OUT"
  rm -rf "$OUT.old.$$"
else
  mv "$STAGE" "$OUT"
fi
echo "build-macos-vm-guest-root: done: $OUT (agent protocol $MIN_VERSION..$VERSION)" >&2
