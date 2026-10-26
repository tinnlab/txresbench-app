#!/usr/bin/env bash
# Builds the Linux desktop installer on this machine, the same way the
# release workflow's Linux job does (Tauri CLI, same bundles).
#
# Usage:
#   scripts/build-installer-local.sh            # build deb + appimage
#   scripts/build-installer-local.sh --dry-run  # check the prerequisites and
#                                               # print the commands, build nothing
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$REPO/src-app/desktop/tauri"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

fail() { echo "build-installer-local: $*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "this machine is not Linux ($(uname -s)); the installer is a Linux build"

for bin in node npm cargo rustc; do
  command -v "$bin" >/dev/null 2>&1 || fail "missing prerequisite: $bin"
done

MISSING_APT=()
for pkg in libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libgtk-3-dev; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    MISSING_APT+=("$pkg")
  fi
done

if [ ${#MISSING_APT[@]} -gt 0 ]; then
  echo "build-installer-local: Linux build libraries not installed: ${MISSING_APT[*]}" >&2
  echo "  install them with: sudo apt-get install ${MISSING_APT[*]}" >&2
  [ "$DRY_RUN" = "1" ] && exit 1
  exit 1
fi

if [ ! -d "$REPO/node_modules" ]; then
  echo "build-installer-local: node_modules missing; running: npm ci" >&2
else
  echo "build-installer-local: node_modules present; skipping npm ci" >&2
fi

echo "build-installer-local: using the Tauri CLI via npx (@tauri-apps/cli@2)" >&2
echo "build-installer-local: $TAURI_DIR" >&2

if [ "$DRY_RUN" = "1" ]; then
  cat <<'EOF'
build-installer-local: dry run — prerequisites ok, would run:

  cd <repo>
  npm ci                                   # workspace install (UI build input)
  cd src-app/desktop/tauri
  npx --yes @tauri-apps/cli@2 build --bundles deb,appimage

The AppImage bundling downloads linuxdeploy/etc. on first build; the deb step
also runs the embedded-server build (the tauri crate compiles the server via
its path dependency). Artifacts land in:
  src-app/desktop/tauri/target/release/bundle/deb/
  src-app/desktop/tauri/target/release/bundle/appimage/
EOF
  exit 0
fi

[ -d "$REPO/node_modules" ] || (cd "$REPO" && npm ci --no-audit --no-fund)

cd "$TAURI_DIR"
npx --yes @tauri-apps/cli@2 build --bundles deb,appimage
