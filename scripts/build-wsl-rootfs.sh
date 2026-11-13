#!/bin/sh
# build-wsl-rootfs.sh: build the root file system of the Windows app's own WSL 2 distro ("TxResBench") as
# the plain (uncompressed) tar that `wsl --import` takes on every WSL version, plus its MANIFEST.json.
# The Windows app ships both (src-app/desktop/tauri/resources/wsl-runtime/, added by tauri.windows.conf.json),
# imports the tar on first use and runs each method in the distro through the guest agent:
#   wsl.exe -d TxResBench -u root --exec /usr/bin/txresbench-sandbox-agent --stdio ...
#
# The root holds:
#   Alpine 3.20: busybox, bubblewrap (/usr/bin/bwrap), squashfuse and fuse3, and their libraries
#   /usr/bin/txresbench-sandbox-agent  the guest agent (sdk/crates/sandbox-guest-agent), static musl
#   /sandbox-rootfs /sandbox-layer /host-mounts /workspace   empty mount points for the agent
#   /etc/wsl.conf                      Windows interop off, no Windows PATH, drives automounted, no
#                                      systemd, default user root (written below)
#   /etc/txresbench-agent-protocol     "MIN MAX": the protocol versions the agent serves (as in the macOS
#                                      guest root)
#   /etc/txresbench-wsl-version        the build id
# No device nodes (WSL mounts its own /dev), and no setuid or setgid file: everything in the distro runs
# as root, so the bits are cleared.
#
# The build id is "<MIN>-<MAX>-<16 hex>": the hex starts the sha256 of the uncompressed, canonical archive
# of the root without the version file (entries sorted by name, fixed mtime, numeric owners). The same
# root gives the same id and any change to a path, type, mode, owner or content gives a new one, which is
# how the app knows to re-import the distro.
#
# MANIFEST.json:
#   {"version": <build id>, "arch": "x86_64"|"aarch64", "sha256": <of the .tar>, "protocol": [MIN, MAX],
#    "packages": [{"name", "version", "license"}, ...]  every Alpine package in the root, from its apk database,
#    "build": {...}}                                     the images, toolchain and source commit used
# The build fails if a package in the root is not listed, with the same licence, in the "WSL runtime"
# section of THIRD-PARTY-NOTICES.md (scripts/third-party.py WSL_ALPINE_PACKAGES).
#
# Usage:  sh scripts/build-wsl-rootfs.sh <x86_64|aarch64> [--out-dir <dir>] [--work-dir <dir>] [--notices <file>]
#   --out-dir   where txresbench-wsl.tar and MANIFEST.json go (default:
#               src-app/desktop/tauri/resources/wsl-runtime). Both are replaced only after every step
#               succeeded.
#   --work-dir  intermediate files (default: ${CARGO_TARGET_DIR:-<repo>/target}/wsl-rootfs-build); this
#               run's subdirectory is removed at the end.
#   --notices   the notices file to check the packages against (default: THIRD-PARTY-NOTICES.md).
# Needs Docker able to run containers for the target platform (linux/amd64 or linux/arm64; Docker Desktop
# emulates the one that is not native). Downloads at build time: the pinned images
# (scripts/guest-root-common.sh), Alpine 3.20 packages (signed; checked against the image's keys) and the
# agent's crates (sdk/Cargo.lock, --locked). Every archive entry gets the mtime SOURCE_DATE_EPOCH (default
# 1767225600, 2026-01-01 UTC), so the same inputs give the same tarball bytes.
set -eu

die() { echo "build-wsl-rootfs: $*" >&2; exit 1; }
log() { echo "build-wsl-rootfs: $*" >&2; }
usage() {
  echo "usage: sh scripts/build-wsl-rootfs.sh <x86_64|aarch64> [--out-dir <dir>] [--work-dir <dir>] [--notices <file>]" >&2
  exit 2
}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/scripts/guest-root-common.sh"

[ $# -ge 1 ] || usage
ARCH=$1; shift
guest_arch_ok "$ARCH" || { echo "build-wsl-rootfs: unknown arch '$ARCH'" >&2; usage; }
OUT=$ROOT/src-app/desktop/tauri/resources/wsl-runtime
WORK=${CARGO_TARGET_DIR:-$ROOT/target}/wsl-rootfs-build
NOTICES=$ROOT/THIRD-PARTY-NOTICES.md
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) [ $# -ge 2 ] || usage; OUT=$2; shift 2 ;;
    --work-dir) [ $# -ge 2 ] || usage; WORK=$2; shift 2 ;;
    --notices) [ $# -ge 2 ] || usage; NOTICES=$2; shift 2 ;;
    *) echo "build-wsl-rootfs: unknown option '$1'" >&2; usage ;;
  esac
done
EPOCH=${SOURCE_DATE_EPOCH:-1767225600}
case "$EPOCH" in ''|*[!0-9]*) die "SOURCE_DATE_EPOCH must be a number of seconds" ;; esac

# The packages asked for; apk adds their dependencies.
PACKAGES="alpine-baselayout alpine-keys busybox musl bubblewrap squashfuse fuse3"
NOTICE_HEADING="## WSL runtime (Windows builds only)"
TARBALL=txresbench-wsl.tar

guest_protocol_range "$ROOT" || die "cannot read the agent protocol versions"
PMIN=$GUEST_PROTOCOL_MIN PMAX=$GUEST_PROTOCOL_MAX
PLATFORM=$(guest_platform "$ARCH")
ALPINE_IMAGE=$(guest_alpine_image "$ARCH")
RUST_IMAGE=$(guest_rust_image "$ARCH")

# The notices' package lines ("  - name, name — licence") are checked before any build step, so a
# missing section fails at once; they are kept in the run directory for step 2.
[ -f "$NOTICES" ] || die "no notices file at $NOTICES"
notice_lines() { awk -v h="$NOTICE_HEADING" '$0 == h {f = 1; next} /^## / {f = 0} f && /^  - /' "$NOTICES"; }
[ -n "$(notice_lines)" ] || die "$NOTICES has no package list under \"$NOTICE_HEADING\""

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

mkdir -p "$OUT" "$WORK" || die "cannot create $OUT or $WORK"
OUT=$(cd "$OUT" && pwd)
WORK=$(cd "$WORK" && pwd)
RUN=$(mktemp -d "$WORK/run-$ARCH.XXXXXX") || die "cannot create a directory in $WORK"
trap 'rm -rf "$RUN"' EXIT
trap 'exit 130' INT TERM
notice_lines > "$RUN/notice-lines"

# ── 1. the Alpine userland ─────────────────────────────────────────────────────────────────────────────
# The new root starts with the image's own signing keys, so every package, alpine-keys included, is
# verified against them. /dev is emptied: WSL mounts its own.
log "assembling the Alpine userland ($ARCH, $ALPINE_IMAGE)"
docker run --rm --platform "$PLATFORM" -v "$RUN:/w" -e "PACKAGES=$PACKAGES" "$ALPINE_IMAGE" sh -c '
  set -e
  mkdir -p /r/etc/apk/keys
  cp /etc/apk/repositories /r/etc/apk/
  cp /etc/apk/keys/* /r/etc/apk/keys/
  apk --root /r --initdb --no-cache add $PACKAGES >/dev/null
  find /r/dev -mindepth 1 -delete
  tar -C /r -cf /w/userland.tar .
  cp /r/lib/apk/db/installed /w/installed' >&2 || die "assembling the Alpine userland failed"
[ -s "$RUN/installed" ] || die "the userland has no apk database"

# ── 2. every package must be in the notices, with its licence ──────────────────────────────────────────
# A notices line names one or more packages ("a, b, c — licence"); a package is covered when a line
# names it and gives the licence its apk database records.
missing=$(awk '
  FNR == NR {
    s = substr($0, 5); k = index(s, " — ")
    if (k == 0) next
    lic = substr(s, k + length(" — ")); names = substr(s, 1, k - 1)
    gsub(/[(),]/, " ", names); m = split(names, N, " ")
    for (j = 1; j <= m; j++) covered[N[j] "\t" lic] = 1
    next
  }
  /^P:/ {p = substr($0, 3)} /^L:/ {l = substr($0, 3)}
  /^$/ && p != "" {if (!((p "\t" l) in covered)) print p " (" l ")"; p = ""}
  END {if (p != "" && !((p "\t" l) in covered)) print p " (" l ")"}' "$RUN/notice-lines" "$RUN/installed") \
  || die "cannot check the packages against $NOTICES"
[ -z "$missing" ] || die "packages missing from \"$NOTICE_HEADING\" in $NOTICES (add them to WSL_ALPINE_PACKAGES in scripts/third-party.py and regenerate): $(printf '%s\n' "$missing" | paste -sd ';' - | sed 's/;/; /g')"

# ── 3. the guest agent ─────────────────────────────────────────────────────────────────────────────────
log "building the guest agent (static $ARCH-musl, $RUST_IMAGE)"
mkdir "$RUN/agent"
guest_build_agent "$ROOT" "$ARCH" "$RUN/agent" || die "the guest agent build failed"

cat > "$RUN/wsl.conf" <<'EOF'
# The TxResBench WSL distro (scripts/build-wsl-rootfs.sh). The app runs its methods here as root, through
# the guest agent; nothing else uses this distro.

[interop]
# The distro cannot start Windows programs, and Windows' PATH is not added to its PATH.
enabled=false
appendWindowsPath=false

[automount]
# Windows drives are mounted at /mnt/<drive>: the app passes the method images and inputs by those paths.
enabled=true

[boot]
systemd=false

[user]
default=root
EOF

if SOURCE_COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null); then
  [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] || SOURCE_COMMIT="$SOURCE_COMMIT+dirty"
else
  SOURCE_COMMIT=unknown
fi

# ── 4. the root, the archive and the manifest ──────────────────────────────────────────────────────────
# Runs in a throwaway container of the target platform, as root, so owners and modes are kept. GNU tar is
# added to that container only (busybox tar cannot sort entries or fix their mtimes); it is not part of the
# root.
cat > "$RUN/assemble.sh" <<'EOF'
set -eu
fail() { echo "build-wsl-rootfs: $*" >&2; exit 1; }
apk add -q --no-cache tar >/dev/null
mkdir /r
tar -C /r -xpf /w/userland.tar
install -m 0755 /w/agent/txresbench-sandbox-agent /r/usr/bin/txresbench-sandbox-agent
install -m 0644 /w/wsl.conf /r/etc/wsl.conf
printf '%s %s\n' "$PMIN" "$PMAX" > /r/etc/txresbench-agent-protocol
chmod 0644 /r/etc/txresbench-agent-protocol
for d in sandbox-rootfs sandbox-layer host-mounts workspace; do mkdir -m 0755 "/r/$d"; done

find /r \( -perm -4000 -o -perm -2000 \) -type f | while read -r f; do
  echo "build-wsl-rootfs: clearing setuid/setgid on ${f#/r}" >&2
  chmod ug-s "$f"
done
[ -z "$(find /r \( -perm -4000 -o -perm -2000 \))" ] || fail "setuid/setgid entries remain"
[ -z "$(find /r/dev -mindepth 1)" ] || fail "/dev is not empty"
for f in bin/busybox bin/sh usr/bin/bwrap usr/bin/squashfuse usr/bin/fusermount3 \
         usr/bin/txresbench-sandbox-agent; do
  [ -e "/r/$f" ] || fail "the root has no /$f"
done
case "$ARCH" in x86_64) machine='3e 00' ;; aarch64) machine='b7 00' ;; esac
for f in usr/bin/txresbench-sandbox-agent usr/bin/bwrap bin/busybox; do
  [ "$(od -An -tx1 -j18 -N2 "/r/$f" | xargs)" = "$machine" ] || fail "/$f is not an $ARCH binary"
done

# The canonical archive: entries sorted by name, one mtime, numeric owners, no extended attributes.
ls -A /r | LC_ALL=C sort > /tmp/top
pack() {
  tar --format=gnu --sort=name --mtime="@$EPOCH" --numeric-owner --no-acls --no-xattrs --no-selinux \
    -C /r -cf - -T /tmp/top
}
id="$PMIN-$PMAX-$(pack | sha256sum | cut -c1-16)"
printf '%s\n' "$id" > /r/etc/txresbench-wsl-version
chmod 0644 /r/etc/txresbench-wsl-version
pack > /w/txresbench-wsl.tar
sha=$(sha256sum /w/txresbench-wsl.tar | cut -c1-64)

# MANIFEST.json. Every value is a plain string from the apk database or this build; q() escapes
# backslashes and quotes all the same. The values are read first, so a failing read stops the build.
q() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
repos=$(grep -v '^#' /r/etc/apk/repositories | sed '/^$/d')
[ -n "$repos" ]
agent_sha=$(sha256sum /r/usr/bin/txresbench-sandbox-agent | cut -c1-64)
tar_v=$(tar --version | head -n 1)
[ -s /w/agent/agent-build.txt ]
list() { sep=; while read -r item; do printf '%s%s' "$sep" "$(q "$item")"; sep=', '; done; }
{
  printf '{\n'
  printf '  "version": %s,\n' "$(q "$id")"
  printf '  "arch": %s,\n' "$(q "$ARCH")"
  printf '  "sha256": %s,\n' "$(q "$sha")"
  printf '  "protocol": [%s, %s],\n' "$PMIN" "$PMAX"
  printf '  "packages": [\n'
  awk '/^P:/ {p = substr($0, 3)} /^V:/ {v = substr($0, 3)} /^L:/ {l = substr($0, 3)}
       /^$/ && p != "" {print p "\t" v "\t" l; p = ""}
       END {if (p != "") print p "\t" v "\t" l}' /r/lib/apk/db/installed \
    | LC_ALL=C sort | {
      first=1
      while IFS='	' read -r name version licence; do
        [ "$first" = 1 ] || printf ',\n'
        first=0
        printf '    {"name": %s, "version": %s, "license": %s}' "$(q "$name")" "$(q "$version")" "$(q "$licence")"
      done
      printf '\n'
    }
  printf '  ],\n'
  printf '  "build": {\n'
  printf '    "alpine_image": %s,\n' "$(q "$ALPINE_IMAGE")"
  printf '    "alpine_repositories": [%s],\n' "$(printf '%s\n' "$repos" | list)"
  printf '    "rust_image": %s,\n' "$(q "$RUST_IMAGE")"
  printf '    "agent_toolchain": [%s],\n' "$(list < /w/agent/agent-build.txt)"
  printf '    "agent_sha256": %s,\n' "$(q "$agent_sha")"
  printf '    "archiver": %s,\n' "$(q "$tar_v")"
  printf '    "source_commit": %s\n' "$(q "$SOURCE_COMMIT")"
  printf '  }\n'
  printf '}\n'
} > /w/MANIFEST.json
printf '%s %s\n' "$id" "$sha" > /w/result
EOF
log "assembling the root and the archive"
docker run --rm --platform "$PLATFORM" -v "$RUN:/w" \
  -e "ARCH=$ARCH" -e "PMIN=$PMIN" -e "PMAX=$PMAX" -e "EPOCH=$EPOCH" \
  -e "ALPINE_IMAGE=$ALPINE_IMAGE" -e "RUST_IMAGE=$RUST_IMAGE" -e "SOURCE_COMMIT=$SOURCE_COMMIT" \
  "$ALPINE_IMAGE" sh /w/assemble.sh >&2 || die "assembling the root failed"

[ -s "$RUN/$TARBALL" ] && [ -s "$RUN/MANIFEST.json" ] && [ -s "$RUN/result" ] || die "the archive step wrote no output"
read -r ID SHA < "$RUN/result"
if command -v sha256sum >/dev/null 2>&1; then HOST_SHA=$(sha256sum "$RUN/$TARBALL"); else HOST_SHA=$(shasum -a 256 "$RUN/$TARBALL"); fi
[ "$(echo "$HOST_SHA" | cut -c1-64)" = "$SHA" ] || die "the archive's sha256 does not match what the container computed"

# Last: replace the outputs. A tarball whose MANIFEST does not match it (an interrupted move) fails the
# app's sha256 check, so the pair can never be taken for valid by mistake.
mv "$RUN/$TARBALL" "$OUT/$TARBALL"
mv "$RUN/MANIFEST.json" "$OUT/MANIFEST.json"
log "done: $OUT/$TARBALL ($(du -h "$OUT/$TARBALL" | cut -f1), version $ID, sha256 $SHA)"
