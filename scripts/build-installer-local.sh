#!/usr/bin/env bash
# Builds the Linux desktop installer on this machine, the same way the
# release workflow's Linux job does (Tauri CLI, same bundles).
#
# The bundled pretrained-model step runs first: it reads the frozen
# data/pretrained-catalogue/bundled-models.json, fetches each entry from the
# model host (build time only — the shipped app never dials the model host),
# verifies sha256 + size, and stages the set under
# src-app/desktop/tauri/resources/pretrained-bundled/ (gitignored, embedded by
# bundle.resources). An absent manifest is the valid no-models state: the step
# exits 0 staging nothing.
#
# Usage:
#   scripts/build-installer-local.sh                     # stage models, build deb + appimage
#   scripts/build-installer-local.sh --skip-models       # build, no model fetch
#   scripts/build-installer-local.sh --dry-run           # check the prerequisites and
#                                                       # print the commands, build nothing
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$REPO/src-app/desktop/tauri"
DRY_RUN=0
SKIP_MODELS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
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
EOF
  if [ "$SKIP_MODELS" = "1" ]; then
    cat <<'EOF'
  cd <repo>/src-app/desktop/tauri
  npx --yes @tauri-apps/cli@2 build --bundles deb,appimage

The AppImage bundling downloads linuxdeploy/etc. on first build; the deb step
also runs the embedded-server build (the tauri crate compiles the server via
its path dependency). Artifacts land in:
  src-app/desktop/tauri/target/release/bundle/deb/
  src-app/desktop/tauri/target/release/bundle/appimage/
EOF
  else
    cat <<'EOF'
  node scripts/installer/bundle-pretrained-models.mjs \
    --manifest data/pretrained-catalogue/bundled-models.json \
    --out src-app/desktop/tauri/resources/pretrained-bundled
  cd <repo>/src-app/desktop/tauri
  npx --yes @tauri-apps/cli@2 build --bundles deb,appimage

The bundled-model step fetches the frozen manifest's model assets from the
model host (build time only) and verifies sha256 + size before staging; an
absent manifest is the valid no-models state and stages nothing. The AppImage
bundling downloads linuxdeploy/etc. on first build; the deb step also runs the
embedded-server build (the tauri crate compiles the server via its path
dependency). Artifacts land in:
  src-app/desktop/tauri/target/release/bundle/deb/
  src-app/desktop/tauri/target/release/bundle/appimage/
EOF
  fi
  exit 0
fi

[ -d "$REPO/node_modules" ] || (cd "$REPO" && npm ci --no-audit --no-fund)

if [ "$SKIP_MODELS" = "1" ]; then
  echo "build-installer-local: skipping bundled-model staging (--skip-models)" >&2
else
  node "$REPO/scripts/installer/bundle-pretrained-models.mjs" \
    --manifest "$REPO/data/pretrained-catalogue/bundled-models.json" \
    --out "$TAURI_DIR/resources/pretrained-bundled"
fi

# The bundle resource must exist for tauri build even when the manifest was
# absent (the staging step exits 0 staging nothing in that state).
mkdir -p "$TAURI_DIR/resources/pretrained-bundled"

cd "$TAURI_DIR"
npx --yes @tauri-apps/cli@2 build --bundles deb,appimage
