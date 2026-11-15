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
#   /etc/wsl.conf                      Windows interop off, no Windows PATH, drives automounted (no
#                                      fstab), no generated hosts or resolv.conf, no systemd, default
#                                      user nobody: the app always passes -u root (written below)
#   /etc/txresbench-agent-protocol     "MIN MAX": the protocol versions the agent serves (as in the macOS
#                                      guest root)
#   /etc/txresbench-wsl-version        the build id
# No device nodes, FIFOs or sockets (WSL mounts its own /dev), and no setuid or setgid file: everything in
# the distro runs as root, so the bits are cleared. root's password is locked ("*"), and /etc/shadow's dates
# are the build epoch's day (busybox's install stamps the build day there).
#
# The build id is "<MIN>-<MAX>-<16 hex>": the hex starts the sha256 of the uncompressed, canonical archive
# of the root without the version file (entries sorted by name, fixed mtime, numeric owners). The same
# root gives the same id and any change to a path, type, mode, owner or content gives a new one, which is
# how the app knows to re-import the distro.
#
# MANIFEST.json:
#   {"version": <build id>, "arch": "x86_64"|"aarch64", "sha256": <of the .tar>, "protocol": [MIN, MAX],
#    "packages": [{"name", "version", "license"}, ...]  every Alpine package in the root, from its apk database,
#    "build": {...}}                                     the images, toolchain and source commit used, and
#                                                        agent_cargo_cache: the test cache the agent came
#                                                        from (guest-root-common.sh), or null
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
# 1767225600, 2026-01-01 UTC) and /etc/shadow its day, so the same inputs give the same tarball bytes on
# any day.
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
# Relative directories are taken from here; an absolute path also cannot be read as an option.
case "$OUT" in /*) ;; *) OUT=$PWD/$OUT ;; esac
case "$WORK" in /*) ;; *) WORK=$PWD/$WORK ;; esac
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

# The tree the root is built from, read before the build starts.
if SOURCE_COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null); then
  [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] || SOURCE_COMMIT="$SOURCE_COMMIT+dirty"
else
  SOURCE_COMMIT=unknown
fi

mkdir -p "$OUT" "$WORK" || die "cannot create $OUT or $WORK"
OUT=$(cd "$OUT" && pwd)
WORK=$(cd "$WORK" && pwd)
RUN=$(mktemp -d "$WORK/run-$ARCH.XXXXXX") || die "cannot create a directory in $WORK"
trap 'rm -rf "$RUN"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
notice_lines > "$RUN/notice-lines"

# ── 1. the Alpine userland ─────────────────────────────────────────────────────────────────────────────
# The new root starts with the image's own signing keys, so every package, alpine-keys included, is
# verified against them. /dev is emptied: WSL mounts its own.
log "assembling the Alpine userland ($ARCH, $ALPINE_IMAGE)"
docker run --rm --init --platform "$PLATFORM" -v "$RUN:/w" -e "PACKAGES=$PACKAGES" "$ALPINE_IMAGE" sh -c '
  set -e
  mkdir -p /r/etc/apk/keys
  cp /etc/apk/repositories /r/etc/apk/
  cp /etc/apk/keys/* /r/etc/apk/keys/
  apk --root /r --initdb --no-cache add $PACKAGES >/dev/null
  find /r/dev -mindepth 1 -delete
  tar -C /r -cf /w/userland.tar .
  cp /r/lib/apk/db/installed /w/installed' >&2 || die "assembling the Alpine userland failed"
[ -s "$RUN/installed" ] || die "the userland has no apk database"

# ── 2. the notices list exactly the root's packages, each with its licence ─────────────────────────────
# A notices line names one or more packages ("a, b, c — licence"); a package is covered when a line
# names it and gives the licence its apk database records. A package the notices list but the root does
# not have fails too, so the notices never name what is not shipped.
check=$(awk '
  function done_record() {
    if (p == "") return
    if (l == "") print "M " p " (no licence recorded)"
    else if (!((p "\t" l) in covered)) print "M " p " (" l ")"
    installed[p] = 1
    p = ""; l = ""
  }
  FNR == NR {
    s = substr($0, 5); k = index(s, " — ")
    if (k == 0) next
    lic = substr(s, k + length(" — ")); m = split(substr(s, 1, k - 1), N, ", ")
    for (j = 1; j <= m; j++) { covered[N[j] "\t" lic] = 1; listed[N[j]] = 1 }
    next
  }
  /^P:/ {p = substr($0, 3)} /^L:/ {l = substr($0, 3)}
  /^$/ {done_record()}
  END {done_record(); for (n in listed) if (!(n in installed)) print "X " n}' "$RUN/notice-lines" "$RUN/installed") \
  || die "cannot check the packages against $NOTICES"
joined() { sed -n "s/^$1 //p" | LC_ALL=C sort | paste -sd ';' - | sed 's/;/; /g'; }
missing=$(printf '%s\n' "$check" | joined M)
extra=$(printf '%s\n' "$check" | joined X)
[ -z "$missing" ] || die "packages missing from \"$NOTICE_HEADING\" in $NOTICES (add them to WSL_ALPINE_PACKAGES in scripts/third-party.py and regenerate): $missing"
[ -z "$extra" ] || die "\"$NOTICE_HEADING\" in $NOTICES lists packages the root does not have (remove them from WSL_ALPINE_PACKAGES in scripts/third-party.py and regenerate): $extra"

# ── 3. the guest agent ─────────────────────────────────────────────────────────────────────────────────
log "building the guest agent (static $ARCH-musl, $RUST_IMAGE)"
mkdir "$RUN/agent"
guest_build_agent "$ROOT" "$ARCH" "$RUN/agent" "${TXR_GUEST_AGENT_CARGO_CACHE:-}" || die "the guest agent build failed"

cat > "$RUN/wsl.conf" <<'EOF'
# The TxResBench WSL distro (scripts/build-wsl-rootfs.sh). The app runs its methods here as root, through
# the guest agent; nothing else uses this distro.

[interop]
# The distro cannot start Windows programs, and Windows' PATH is not added to its PATH.
enabled=false
appendWindowsPath=false

[automount]
# Windows drives are mounted at /mnt/<drive>: the app passes the method images and inputs by those paths.
# Nothing else is mounted from /etc/fstab.
enabled=true
mountFsTab=false

[network]
# Nothing here uses the network: WSL writes no /etc/hosts or /etc/resolv.conf of its own.
generateHosts=false
generateResolvConf=false

[boot]
systemd=false

[user]
# The app always runs as root (wsl.exe -u root). Anything that enters the distro without asking for a
# user (a terminal profile, \\wsl.localhost) gets nobody, who can change nothing here.
default=nobody
EOF

# ── 4. the root, the archive and the manifest ──────────────────────────────────────────────────────────
# Runs in a throwaway container of the target platform, as root, so owners and modes are kept. GNU tar is
# added to that container only (busybox tar cannot sort entries or fix their mtimes); it is not part of the
# root.
cat > "$RUN/assemble.sh" <<'EOF'
set -eu
set -o pipefail
fail() { echo "build-wsl-rootfs: $*" >&2; exit 1; }
apk add -q --no-cache tar >/dev/null
mkdir /r
# Owners by number: the names in this container's /etc/passwd are not the root's.
tar --numeric-owner -C /r -xpf /w/userland.tar
install -m 0755 /w/agent/txresbench-sandbox-agent /r/usr/bin/txresbench-sandbox-agent
install -m 0644 /w/wsl.conf /r/etc/wsl.conf
printf '%s %s\n' "$PMIN" "$PMAX" > /r/etc/txresbench-agent-protocol
chmod 0644 /r/etc/txresbench-agent-protocol
for d in sandbox-rootfs sandbox-layer host-mounts workspace; do mkdir -m 0755 "/r/$d"; done

# busybox's install adds users with the build day as their password's last change, and Alpine leaves
# root's password empty: the dates become the epoch's day, so the root does not depend on when it was
# built, and root's password is locked ("*": no password matches it).
day=$((EPOCH / 86400))
for f in /r/etc/shadow /r/etc/shadow-; do
  [ -f "$f" ] || continue
  awk -F: -v OFS=: -v d="$day" '$3 ~ /^[0-9]+$/ {$3 = d} $1 == "root" && $2 == "" {$2 = "*"} {print}' "$f" > /tmp/shadow
  cat /tmp/shadow > "$f"   # keeps the file's owner and mode
done
grep -q '^root:[*!]' /r/etc/shadow || fail "root's password is not locked"

find /r \( -perm -4000 -o -perm -2000 \) -type f | while read -r f; do
  echo "build-wsl-rootfs: clearing setuid/setgid on ${f#/r}" >&2
  chmod ug-s "$f"
done
[ -z "$(find /r \( -perm -4000 -o -perm -2000 \))" ] || fail "setuid/setgid entries remain"
[ -z "$(find /r/dev -mindepth 1)" ] || fail "/dev is not empty"
[ -z "$(find /r ! -type f ! -type d ! -type l)" ] || fail "the root has device nodes, FIFOs or sockets"
for f in bin/busybox usr/bin/bwrap usr/bin/squashfuse usr/bin/fusermount3 usr/bin/txresbench-sandbox-agent; do
  [ -f "/r/$f" ] || fail "the root has no /$f"
done
# /bin/sh is an absolute link, which a test here would follow into this container's own busybox.
[ "$(readlink /r/bin/sh)" = /bin/busybox ] || fail "/bin/sh is not a link to /bin/busybox"
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
pack > /tmp/canonical.tar
id="$PMIN-$PMAX-$(sha256sum /tmp/canonical.tar | cut -c1-16)"
rm /tmp/canonical.tar
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
tar_v=$(tar --version | sed -n 1p)
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
       /^$/ && p != "" {print p "\t" v "\t" l; p = v = l = ""}
       END {if (p != "") print p "\t" v "\t" l}' /r/lib/apk/db/installed \
    | LC_ALL=C sort | {
      first=1
      while IFS='	' read -r name version licence; do
        [ -n "$version" ] && [ -n "$licence" ] || fail "the apk database records no version or licence for $name"
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
  if [ -n "$AGENT_CARGO_CACHE" ]; then cache=$(q "$AGENT_CARGO_CACHE"); else cache=null; fi
  printf '    "agent_cargo_cache": %s,\n' "$cache"
  printf '    "archiver": %s,\n' "$(q "$tar_v")"
  printf '    "source_commit": %s\n' "$(q "$SOURCE_COMMIT")"
  printf '  }\n'
  printf '}\n'
} > /w/MANIFEST.json
printf '%s %s\n' "$id" "$sha" > /w/result
EOF
log "assembling the root and the archive"
docker run --rm --init --platform "$PLATFORM" -v "$RUN:/w" \
  -e "ARCH=$ARCH" -e "PMIN=$PMIN" -e "PMAX=$PMAX" -e "EPOCH=$EPOCH" \
  -e "AGENT_CARGO_CACHE=${TXR_GUEST_AGENT_CARGO_CACHE:-}" \
  -e "ALPINE_IMAGE=$ALPINE_IMAGE" -e "RUST_IMAGE=$RUST_IMAGE" -e "SOURCE_COMMIT=$SOURCE_COMMIT" \
  "$ALPINE_IMAGE" sh /w/assemble.sh >&2 || die "assembling the root failed"

[ -s "$RUN/$TARBALL" ] && [ -s "$RUN/MANIFEST.json" ] && [ -s "$RUN/result" ] || die "the archive step wrote no output"
read -r ID SHA < "$RUN/result"
if command -v sha256sum >/dev/null 2>&1; then HOST_SHA=$(sha256sum "$RUN/$TARBALL"); else HOST_SHA=$(shasum -a 256 "$RUN/$TARBALL"); fi
[ "$(echo "$HOST_SHA" | cut -c1-64)" = "$SHA" ] || die "the archive's sha256 does not match what the container computed"

# Last: replace the outputs. A tarball whose MANIFEST does not match it (an interrupted move, or two runs
# into one directory) is refused before a Windows bundle is made (scripts/verify-wsl-runtime.mjs) and by
# the app's sha256 check at import, so the pair can never be taken for valid by mistake.
mv "$RUN/$TARBALL" "$OUT/$TARBALL"
mv "$RUN/MANIFEST.json" "$OUT/MANIFEST.json"
log "done: $OUT/$TARBALL ($(du -h "$OUT/$TARBALL" | cut -f1), version $ID, sha256 $SHA)"
