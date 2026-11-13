# guest-root-common.sh: shared by the two scripts that build a Linux guest root for the method runner,
# scripts/build-macos-vm-guest-root.sh (the macOS VM, aarch64) and scripts/build-wsl-rootfs.sh (the
# Windows WSL distro, x86_64 or aarch64). Source it; it defines functions and the pinned build images,
# and runs nothing.
#
#   guest_arch_ok <arch>                 is <arch> one of x86_64, aarch64
#   guest_platform <arch>                the Docker platform (linux/amd64, linux/arm64)
#   guest_alpine_image <arch>            the pinned Alpine image for <arch>
#   guest_rust_image <arch>              the pinned Rust (Alpine) image for <arch>
#   guest_protocol_range <repo-root>     sets GUEST_PROTOCOL_MIN and GUEST_PROTOCOL_MAX from the protocol crate
#   guest_build_agent <repo-root> <arch> <out-dir>
#                                        builds the guest agent as a static musl binary for <arch>
#
# The build images are pinned by the digest of each platform's own manifest. They are the linux/amd64 and
# linux/arm64 entries of the multi-arch indexes
#   alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
#   rust:1.90-alpine3.20@sha256:ef86f37c2819ebd1ecb1dbd7efda70c693cb013232688aa136a5a2f1e3b65e55
# (pinning the per-platform manifest, not the index, lets one Docker image store hold both platforms).
# The apk package versions are not pinned: they come from the Alpine 3.20 repository at build time, and
# each build records the versions it got.

guest_arch_ok() {
  case "$1" in x86_64|aarch64) return 0 ;; *) return 1 ;; esac
}

guest_platform() {
  case "$1" in
    x86_64) echo linux/amd64 ;;
    aarch64) echo linux/arm64 ;;
    *) return 1 ;;
  esac
}

guest_alpine_image() {
  case "$1" in
    x86_64) echo alpine:3.20@sha256:c64c687cbea9300178b30c95835354e34c4e4febc4badfe27102879de0483b5e ;;
    aarch64) echo alpine:3.20@sha256:45e09956dc667c5eff3583c9d94830261fb1ca0be10a0a7db36266edf5de9e1d ;;
    *) return 1 ;;
  esac
}

guest_rust_image() {
  case "$1" in
    x86_64) echo rust:1.90-alpine3.20@sha256:a97b713ba0b992d4855de682705a1671a9f1bdbf56c63106e3b450732ffd31ab ;;
    aarch64) echo rust:1.90-alpine3.20@sha256:44cacafd135db6161d33d79b5e65fbb9375c7bb80c242d07e7c09d112981113f ;;
    *) return 1 ;;
  esac
}

# The protocol versions the agent serves, read from their one declaration.
guest_protocol_range() {
  _src="$1/sdk/crates/sandbox-vm-protocol/src/lib.rs"
  GUEST_PROTOCOL_MAX=$(sed -n 's/^pub const PROTOCOL_VERSION: u32 = \([0-9][0-9]*\);$/\1/p' "$_src")
  GUEST_PROTOCOL_MIN=$(sed -n 's/^pub const PROTOCOL_VERSION_MIN: u32 = \([0-9][0-9]*\);$/\1/p' "$_src")
  [ -n "$GUEST_PROTOCOL_MAX" ] && [ -n "$GUEST_PROTOCOL_MIN" ] || {
    echo "cannot read PROTOCOL_VERSION(_MIN) from $_src" >&2
    return 1
  }
}

# Build sdk/crates/sandbox-guest-agent for <arch> (static musl, libseccomp linked in) into <out-dir>:
#   <out-dir>/txresbench-sandbox-agent   the binary
#   <out-dir>/agent-build.txt            the toolchain and the linked Alpine package versions, one
#                                        "name version" per line
#
# TXR_GUEST_AGENT_CARGO_CACHE=<prefix> keeps the cargo registry and target dir in the Docker volumes
# <prefix>-registry and <prefix>-target between builds (for tests; the caller removes them). They are
# mounted at the paths a build without them uses, so the binary does not depend on the cache.
guest_build_agent() {
  _root=$1 _arch=$2 _out=$3
  guest_arch_ok "$_arch" || { echo "guest_build_agent: unknown arch $_arch" >&2; return 1; }
  [ -d "$_out" ] || { echo "guest_build_agent: $_out is not a directory" >&2; return 1; }
  _triple=$_arch-unknown-linux-musl
  _rustflags_var=CARGO_TARGET_$(echo "$_triple" | tr 'a-z-' 'A-Z_')_RUSTFLAGS
  set -- --rm --platform "$(guest_platform "$_arch")" -v "$_root:/work:ro" -v "$_out:/out" -w /work/sdk \
    -e CARGO_TARGET_DIR=/tmp/cargo-target \
    -e "$_rustflags_var=-C target-feature=+crt-static" \
    -e LIBSECCOMP_LINK_TYPE=static -e LIBSECCOMP_LIB_PATH=/usr/lib \
    -e "GUEST_TRIPLE=$_triple"
  if [ -n "${TXR_GUEST_AGENT_CARGO_CACHE:-}" ]; then
    set -- "$@" -v "$TXR_GUEST_AGENT_CARGO_CACHE-registry:/usr/local/cargo/registry" \
      -v "$TXR_GUEST_AGENT_CARGO_CACHE-target:/tmp/cargo-target"
  fi
  docker run "$@" "$(guest_rust_image "$_arch")" sh -c '
    set -e
    apk add -q libseccomp-dev libseccomp-static musl-dev build-base pkgconf >/dev/null
    cargo build --release --locked --target "$GUEST_TRIPLE" -p sandbox-guest-agent 1>&2
    cp /tmp/cargo-target/$GUEST_TRIPLE/release/txresbench-sandbox-agent /out/txresbench-sandbox-agent
    { rustc -V | cut -d" " -f1-2
      for p in libseccomp-static musl-dev; do
        echo "$p $(apk info -e -v "$p" | sed "s/^$p-//")"
      done; } > /out/agent-build.txt' >&2 || return 1
  [ -s "$_out/txresbench-sandbox-agent" ] || { echo "guest_build_agent: the build produced no binary" >&2; return 1; }
}
