#!/bin/sh
# build-macos-vm-runtime.sh: build the runtime the macOS method VM needs and pack it into ONE archive that the
# Mac app ships (src-app/desktop/tauri/resources/sandbox-vm-runtime/), so a user installs nothing else.
#
#   bin/txresbench-sandbox-vm-launcher   the launcher (sdk crate), linked to OUR libkrun, ad-hoc signed with
#                                        the hypervisor entitlement
#   lib/libkrun.1.dylib                  libkrun built from source WITHOUT GPU support (BLK only), so it needs
#                                        nothing but macOS's Hypervisor.framework
#   lib/libkrunfw.5.dylib                the guest Linux kernel (libkrunfw's prebuilt kernel bundle, compiled
#                                        here). GPL-2.0 + LGPL-2.1: see THIRD-PARTY-NOTICES.md and MANIFEST
#   share/guest-root/                    Alpine + bubblewrap + the guest agent (build-macos-vm-guest-root.sh)
#   MANIFEST                             versions, source URLs + sha256s, and the sha256 of every file
#
# Usage:  sh scripts/build-macos-vm-runtime.sh [<work-dir>]
#   <work-dir> holds downloads and intermediate builds (default: $CARGO_TARGET_DIR or ./target, then
#   /vm-runtime-build). Needs: macOS on Apple Silicon, Xcode command line tools (clang, install_name_tool,
#   codesign), Rust (cargo + rust-lld), make, curl, Docker (for the guest root). Downloads at build time:
#   the two pinned source archives below and, inside libkrun's own Makefile, a minimal Debian sysroot used to
#   cross-compile libkrun's guest init.
# Output: src-app/desktop/tauri/resources/sandbox-vm-runtime/sandbox-vm-runtime.tar (+ .sha256), replaced
#   only after every step succeeded. The app checks the .sha256 before it unpacks the archive.
set -eu

die() { echo "build-macos-vm-runtime: $*" >&2; exit 1; }
log() { echo "build-macos-vm-runtime: $*" >&2; }

# ── pinned sources (each release at least two weeks old when pinned, 2026-11-13) ──────────────────────────
LIBKRUN_VERSION=1.19.7
LIBKRUN_URL=https://github.com/containers/libkrun/archive/refs/tags/v$LIBKRUN_VERSION.tar.gz
LIBKRUN_SHA256=d4541fcd959ad43fb073bff61bc91b645ea6413a10b8319e9b61664a6102d20c
LIBKRUNFW_VERSION=5.6.2
LIBKRUNFW_URL=https://github.com/containers/libkrunfw/releases/download/v$LIBKRUNFW_VERSION/libkrunfw-prebuilt-aarch64.tgz
LIBKRUNFW_SHA256=adef6739cc3bda2a1b57f04c08ccbfdf206a6c831d76b32de1beddc0e7984e86
# The corresponding source of the GPL kernel inside libkrunfw (kernel version, patches and config).
LIBKRUNFW_SOURCE=https://github.com/containers/libkrunfw/releases/tag/v$LIBKRUNFW_VERSION

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "needs macOS on Apple Silicon"
for t in cargo clang make curl shasum install_name_tool codesign otool tar docker; do
  command -v $t >/dev/null 2>&1 || die "missing tool: $t"
done
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${1:-${CARGO_TARGET_DIR:-$ROOT/target}/vm-runtime-build}
OUTDIR=$ROOT/src-app/desktop/tauri/resources/sandbox-vm-runtime
mkdir -p "$WORK/dl" "$WORK/bin"
STAGE=$WORK/stage
rm -rf "$STAGE"; mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/share"

fetch() { # <url> <sha256> <file>
  f=$WORK/dl/$3
  if [ ! -f "$f" ] || [ "$(shasum -a 256 "$f" | cut -c1-64)" != "$2" ]; then
    log "downloading $1"; curl -fsSL -o "$f.tmp" "$1" && mv "$f.tmp" "$f"
  fi
  [ "$(shasum -a 256 "$f" | cut -c1-64)" = "$2" ] || die "sha256 mismatch for $1"
}

# libkrun's display/input crates generate bindings with bindgen, which loads libclang: use Apple's.
if [ -z "${LIBCLANG_PATH:-}" ]; then
  for d in "$(xcode-select -p 2>/dev/null)/Toolchains/XcodeDefault.xctoolchain/usr/lib" \
           /Library/Developer/CommandLineTools/usr/lib; do
    [ -f "$d/libclang.dylib" ] && { LIBCLANG_PATH=$d; break; }
  done
fi
[ -n "${LIBCLANG_PATH:-}" ] || die "libclang.dylib not found (install Xcode or the command line tools)"
export LIBCLANG_PATH

# libkrun's macOS build cross-compiles its guest init with clang -fuse-ld=lld: give it Rust's bundled lld.
RUST_LLD=$(ls "$(rustc --print sysroot)"/lib/rustlib/*/bin/rust-lld 2>/dev/null | head -1)
[ -n "$RUST_LLD" ] || die "rust-lld not found in the Rust toolchain"
printf '#!/bin/sh\nexec "%s" -flavor gnu "$@"\n' "$RUST_LLD" > "$WORK/bin/ld.lld"; chmod +x "$WORK/bin/ld.lld"

# ── libkrun, no GPU ─────────────────────────────────────────────────────────────────────────────────────────
fetch "$LIBKRUN_URL" "$LIBKRUN_SHA256" libkrun-$LIBKRUN_VERSION.tar.gz
rm -rf "$WORK/libkrun"; mkdir -p "$WORK/libkrun"
tar -xzf "$WORK/dl/libkrun-$LIBKRUN_VERSION.tar.gz" -C "$WORK/libkrun" --strip-components 1
log "building libkrun $LIBKRUN_VERSION (BLK=1, no GPU, no NET)"
# bindgen's build helpers load @rpath/libclang.dylib at run time and look in the target's deps dir (a
# DYLD_* variable would not survive /usr/bin/make, which macOS protects): link Apple's libclang there.
mkdir -p "$WORK/libkrun/target/release/deps"
ln -sf "$LIBCLANG_PATH/libclang.dylib" "$WORK/libkrun/target/release/deps/libclang.dylib"
(cd "$WORK/libkrun" && PATH="$WORK/bin:$PATH" CARGO_TARGET_DIR="$WORK/libkrun/target" make BLK=1 >&2) \
  || die "libkrun build failed"
cp "$WORK/libkrun/target/release/libkrun.$LIBKRUN_VERSION.dylib" "$STAGE/lib/libkrun.1.dylib"
install_name_tool -id @rpath/libkrun.1.dylib "$STAGE/lib/libkrun.1.dylib"

# ── libkrunfw: the guest kernel ─────────────────────────────────────────────────────────────────────────────
fetch "$LIBKRUNFW_URL" "$LIBKRUNFW_SHA256" libkrunfw-$LIBKRUNFW_VERSION-prebuilt-aarch64.tgz
rm -rf "$WORK/libkrunfw"; mkdir -p "$WORK/libkrunfw"
tar -xzf "$WORK/dl/libkrunfw-$LIBKRUNFW_VERSION-prebuilt-aarch64.tgz" -C "$WORK/libkrunfw" --strip-components 1
log "building libkrunfw $LIBKRUNFW_VERSION"
(cd "$WORK/libkrunfw" && make >&2) || die "libkrunfw build failed"
FW=$(ls "$WORK"/libkrunfw/libkrunfw.5*.dylib 2>/dev/null | head -1)
[ -n "$FW" ] || die "libkrunfw build produced no dylib"
cp "$FW" "$STAGE/lib/libkrunfw.5.dylib"
install_name_tool -id @rpath/libkrunfw.5.dylib "$STAGE/lib/libkrunfw.5.dylib"

# ── the launcher, linked to our libkrun ─────────────────────────────────────────────────────────────────────
log "building the launcher"
# The linker wants libkrun.dylib; the launcher then records the library's own id, @rpath/libkrun.1.dylib.
rm -rf "$WORK/linklib"; mkdir -p "$WORK/linklib"
ln -s "$STAGE/lib/libkrun.1.dylib" "$WORK/linklib/libkrun.dylib"
(cd "$ROOT/sdk" && TXR_LIBKRUN_LIB_DIR="$WORK/linklib" CARGO_TARGET_DIR="$WORK/launcher-target" \
  cargo build --release --locked -p sandbox-vm-launcher >&2) || die "launcher build failed"
cp "$WORK/launcher-target/release/txresbench-sandbox-vm-launcher" "$STAGE/bin/"

# Every load path must stay inside the runtime (no Homebrew, no build dirs).
for f in "$STAGE"/bin/* "$STAGE"/lib/*; do
  if otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/|@rpath/)'; then
    die "$f loads a library from outside the runtime (above)"
  fi
done

# ── ad-hoc signatures (install_name_tool invalidated the dylibs'; the launcher needs the hypervisor) ────────
codesign --force -s - "$STAGE"/lib/*.dylib
codesign --force -s - --entitlements "$ROOT/sdk/crates/sandbox-vm-launcher/entitlements.plist" \
  "$STAGE/bin/txresbench-sandbox-vm-launcher"

# ── guest root ──────────────────────────────────────────────────────────────────────────────────────────────
sh "$ROOT/scripts/build-macos-vm-guest-root.sh" "$STAGE/share/guest-root" || die "guest root build failed"

# Every Alpine package in the guest root must be named in THIRD-PARTY-NOTICES.md (scripts/third-party.py
# ALPINE_PACKAGES), so the notices cannot fall behind what the app ships.
APKDB=$STAGE/share/guest-root/lib/apk/db/installed
[ -f "$APKDB" ] || die "the guest root has no apk database ($APKDB)"
NOTICE=$(awk '/^## macOS method-VM runtime/{f=1;next} /^## /{f=0} f' "$ROOT/THIRD-PARTY-NOTICES.md")
[ -n "$NOTICE" ] || die "THIRD-PARTY-NOTICES.md has no macOS method-VM runtime section"
unlisted=$(awk '/^P:/{print substr($0,3)}' "$APKDB" | while read -r pkg; do
  printf '%s\n' "$NOTICE" | grep -qE "(^|[ (,])$pkg([,) ]|$)" || echo "$pkg"
done)
[ -z "$unlisted" ] || die "guest-root packages missing from THIRD-PARTY-NOTICES.md (add them to ALPINE_PACKAGES in scripts/third-party.py): $unlisted"

# ── manifest + archive ──────────────────────────────────────────────────────────────────────────────────────
{
  echo "txresbench macOS method-VM runtime"
  echo "libkrun $LIBKRUN_VERSION  source $LIBKRUN_URL  sha256 $LIBKRUN_SHA256  (built with BLK=1; Apache-2.0)"
  echo "libkrunfw $LIBKRUNFW_VERSION  prebuilt $LIBKRUNFW_URL  sha256 $LIBKRUNFW_SHA256  (GPL-2.0-only AND LGPL-2.1-only; source: $LIBKRUNFW_SOURCE)"
  echo "guest protocol $(cat "$STAGE/share/guest-root/etc/txresbench-agent-protocol")"
  echo "guest root: Alpine packages (name version licence; sources https://gitlab.alpinelinux.org/alpine/aports):"
  awk '/^P:/{p=substr($0,3)} /^V:/{v=substr($0,3)} /^L:/{print "  " p " " v " " substr($0,3)}' "$APKDB"
  echo "files:"
  (cd "$STAGE" && find bin lib -type f | sort | xargs shasum -a 256)
} > "$STAGE/MANIFEST"
mkdir -p "$OUTDIR"
tar -cf "$WORK/sandbox-vm-runtime.tar" -C "$STAGE" .
shasum -a 256 "$WORK/sandbox-vm-runtime.tar" | cut -c1-64 > "$WORK/sandbox-vm-runtime.tar.sha256"
mv "$WORK/sandbox-vm-runtime.tar" "$OUTDIR/sandbox-vm-runtime.tar"
mv "$WORK/sandbox-vm-runtime.tar.sha256" "$OUTDIR/sandbox-vm-runtime.tar.sha256"
log "done: $OUTDIR/sandbox-vm-runtime.tar ($(du -h "$OUTDIR/sandbox-vm-runtime.tar" | cut -f1), sha256 $(cat "$OUTDIR/sandbox-vm-runtime.tar.sha256"))"
