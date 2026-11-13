#!/bin/sh
# test-guest-agent-linux.sh: run the guest agent's tests on Linux, in Docker.
#
# The agent (sdk/crates/sandbox-guest-agent) is Linux-only, and its WSL mode needs
# root, mount namespaces, loop devices and FUSE, so its tests run in a privileged
# container on the same pinned Rust image the guest roots are built with:
#   1. the unit tests of the agent, the protocol, the launcher and the seccomp crate,
#      plus the agent's integration tests that need no root;
#   2. the agent's WSL-mode end-to-end tests (tests/wsl_stdio.rs, #[ignore]d in normal
#      runs): a busybox base squashfs and a layer, the agent started with --stdio and
#      driven over a pipe with the protocol crate, a real bwrap run, the kernel
#      squashfs path and the squashfuse fallback, and nothing left mounted;
#   3. a release build of the static agent, as the guest roots build it.
#
# Usage:  sh sdk/scripts/test-guest-agent-linux.sh [arm64|amd64]     (default: arm64)
#   Build output and the cargo registry live in the Docker volume
#   ${TXR_AGENT_TEST_VOLUME:-txr-guest-agent-test}; `docker volume rm` it when done.
#   On an Apple Silicon Mac, amd64 runs under emulation (slow).
set -eu

die() { echo "test-guest-agent-linux: $*" >&2; exit 1; }

ARCH=${1:-arm64}
case "$ARCH" in
  arm64) TRIPLE=aarch64-unknown-linux-musl ;;
  amd64) TRIPLE=x86_64-unknown-linux-musl ;;
  *) die "unknown arch $ARCH (arm64 or amd64)" ;;
esac
SDK=$(cd "$(dirname "$0")/.." && pwd)
VOLUME=${TXR_AGENT_TEST_VOLUME:-txr-guest-agent-test}
# The guest roots' build image (scripts/build-macos-vm-guest-root.sh), pinned by digest.
RUST_IMAGE=rust:1.90-alpine3.20@sha256:ef86f37c2819ebd1ecb1dbd7efda70c693cb013232688aa136a5a2f1e3b65e55
TEST_IMAGE=txr-guest-agent-test:$ARCH

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

echo "test-guest-agent-linux: preparing $TEST_IMAGE" >&2
docker build -q --platform "linux/$ARCH" -t "$TEST_IMAGE" - >/dev/null <<EOF || die "building $TEST_IMAGE failed"
FROM $RUST_IMAGE
RUN apk add --no-cache libseccomp-dev libseccomp-static musl-dev build-base pkgconf \
      bubblewrap squashfs-tools squashfuse fuse3 util-linux busybox-static
EOF

# --privileged: mount namespaces, loop devices and /dev/fuse for the e2e tests.
docker run --rm --privileged --platform "linux/$ARCH" \
  -v "$SDK:/work/sdk:ro" -v "$VOLUME:/build" -w /work/sdk \
  -e CARGO_HOME=/build/cargo-home -e "CARGO_TARGET_DIR=/build/target-$ARCH" \
  -e LIBSECCOMP_LINK_TYPE=static -e LIBSECCOMP_LIB_PATH=/usr/lib \
  -e "TRIPLE=$TRIPLE" \
  "$TEST_IMAGE" sh -c '
    set -e
    echo "== unit tests (agent, protocol, launcher, seccomp)" >&2
    cargo test --locked -p sandbox-guest-agent -p sandbox-vm-protocol -p sandbox-vm-launcher -p sandbox-seccomp
    echo "== WSL-mode end-to-end tests (root, one at a time)" >&2
    cargo test --locked -p sandbox-guest-agent --test wsl_stdio -- --ignored --test-threads=1
    echo "== release build of the static agent ($TRIPLE)" >&2
    flags="CARGO_TARGET_$(echo "$TRIPLE" | tr a-z- A-Z_)_RUSTFLAGS"
    env "$flags=-C target-feature=+crt-static" \
      cargo build --release --locked --target "$TRIPLE" -p sandbox-guest-agent
    bin="$CARGO_TARGET_DIR/$TRIPLE/release/txresbench-sandbox-agent"
    if readelf -l "$bin" | grep -q INTERP; then echo "the agent is not static" >&2; exit 1; fi
    echo "static agent: $bin ($(wc -c < "$bin") bytes)" >&2
    "$bin" --pipe-selftest < "$bin" | cmp - "$bin"
    echo "test-guest-agent-linux: all passed ($TRIPLE)" >&2
  '
