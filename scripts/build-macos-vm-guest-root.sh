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
#   Point the app at the result with TXR_SANDBOX_GUEST_ROOT=<out-dir>.
#
# Needs Docker able to run linux/arm64 containers (Docker Desktop on Apple Silicon).
set -eu

die() { echo "build-macos-vm-guest-root: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: sh scripts/build-macos-vm-guest-root.sh <out-dir>"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT_PARENT=$(cd "$(dirname "$1")" 2>/dev/null && pwd) || die "the parent of $1 does not exist"
OUT="$OUT_PARENT/$(basename "$1")"
AGENT_REL=usr/bin/txresbench-sandbox-agent
MARKER_REL=etc/txresbench-agent-protocol

if [ -e "$OUT" ] && [ ! -f "$OUT/$AGENT_REL" ]; then
  die "$OUT exists and is not a guest root (no /$AGENT_REL); refusing to replace it"
fi

# The protocol versions the agent serves, read from their one declaration.
PROTO_SRC="$ROOT/sdk/crates/sandbox-vm-protocol/src/lib.rs"
VERSION=$(sed -n 's/^pub const PROTOCOL_VERSION: u32 = \([0-9][0-9]*\);$/\1/p' "$PROTO_SRC")
MIN_VERSION=$(sed -n 's/^pub const PROTOCOL_VERSION_MIN: u32 = \([0-9][0-9]*\);$/\1/p' "$PROTO_SRC")
[ -n "$VERSION" ] && [ -n "$MIN_VERSION" ] || die "cannot read PROTOCOL_VERSION(_MIN) from $PROTO_SRC"

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

# Build images, pinned by digest (multi-arch index). The apk package versions are not
# pinned: they come from the Alpine 3.20 repository at build time.
RUST_IMAGE=rust:1.90-alpine3.20@sha256:ef86f37c2819ebd1ecb1dbd7efda70c693cb013232688aa136a5a2f1e3b65e55
ALPINE_IMAGE=alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

STAGE="$OUT.building.$$"
cleanup() { rm -rf "$STAGE" "$STAGE.agent"; }
trap cleanup EXIT INT TERM
mkdir "$STAGE"

echo "build-macos-vm-guest-root: building the guest agent (static aarch64-musl)" >&2
docker run --rm --platform linux/arm64 -v "$ROOT:/work:ro" -w /work/sdk \
  -e CARGO_TARGET_DIR=/tmp/cargo-target \
  -e 'CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS=-C target-feature=+crt-static' \
  -e LIBSECCOMP_LINK_TYPE=static -e LIBSECCOMP_LIB_PATH=/usr/lib \
  "$RUST_IMAGE" sh -c '
    set -e
    apk add -q libseccomp-dev libseccomp-static musl-dev build-base pkgconf >/dev/null
    cargo build --release --locked --target aarch64-unknown-linux-musl -p sandbox-guest-agent 1>&2
    cat /tmp/cargo-target/aarch64-unknown-linux-musl/release/txresbench-sandbox-agent' \
  > "$STAGE.agent" || die "the guest agent build failed"
[ -s "$STAGE.agent" ] || die "the guest agent build produced no binary"

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
install -m 0755 "$STAGE.agent" "$STAGE/$AGENT_REL"

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
