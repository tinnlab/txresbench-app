#!/usr/bin/env bash
# Fails when the shipped application's source gains an outbound network host
# outside scripts/network-allowlist.txt, or when a telemetry / crash-reporting
# crate or package appears in a lockfile.
#
# The host scan covers the source of the default (non-SaaS) desktop build only:
# the server and desktop crates, the SDK crates they link, the UI and its
# workspace libraries, and the Tauri config. Test files, fixtures, generated
# code, the `saas`-gated modules (billing, workstore, infra UI) and dev scripts
# are out of scope; scripts/, docs/ and the git history are not scanned. Hosts
# found only inside `#[cfg(test)]` blocks or in comments are ignored.
#
# The scan roots are derived from the tree (see `derived_roots` below): a new SDK crate or
# per-OS Tauri config is scanned without editing this file.
#
# The guard also fails on an allowlist entry that matches no literal in the scan roots, so
# the list cannot keep hosts nothing uses. An entry that is intentionally not spelled with
# a scheme in the source (a registry name handed to a tool) is named on a `# scheme-less: host ...`
# comment line; only named entries may match nothing.
#
# Usage:
#   scripts/check-network-allowlist.sh
#   scripts/check-network-allowlist.sh --verbose
#   TXR_NETWORK_ALLOWLIST=... scripts/check-network-allowlist.sh
#
# Options (used by the test):
#   --allowlist=FILE   allowlist file (default scripts/network-allowlist.txt)
#   --roots=D1[,D2..]  source roots to scan (default: the shipped set, derived)
#   --locks=F1[,F2..]  lockfiles to scan for telemetry (default: the repo locks)
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ALLOWLIST="$REPO/scripts/network-allowlist.txt"
# Scan roots. The fixed part names the app's own source trees. Everything else is DERIVED
# from the tree, never typed, so a new crate or a new per-OS config is covered without
# editing this guard: every `sdk/crates/*/src`, every `build.rs` of the server, the desktop
# crate and the SDK crates, and every Tauri config of the desktop crate (the base
# `tauri.conf.json`, the per-OS `tauri.<os>.conf.json` that Tauri merges over it, and the
# capability files).
ROOTS=(
  "$REPO/src-app/server/src"
  "$REPO/src-app/desktop/tauri/src"
  "$REPO/src-app/ui/src"
  "$REPO/sdk/desktop/harness/src"
  "$REPO/sdk/packages/framework/src"
  "$REPO/sdk/packages/kit/src"
  "$REPO/sdk/packages/shell/src"
)
derived_roots() {
  local f
  for f in "$REPO"/sdk/crates/*/src; do
    [ -d "$f" ] && echo "$f"
  done
  for f in "$REPO"/src-app/server/build.rs "$REPO"/src-app/desktop/tauri/build.rs \
           "$REPO"/sdk/crates/*/build.rs \
           "$REPO"/src-app/desktop/tauri/tauri*.conf.json \
           "$REPO"/src-app/desktop/tauri/capabilities/*.json; do
    [ -f "$f" ] && echo "$f"
  done
}
while IFS= read -r r; do ROOTS+=("$r"); done < <(derived_roots)
LOCKS=(
  "$REPO/Cargo.lock"
  "$REPO/sdk/Cargo.lock"
  "$REPO/package-lock.json"
  "$REPO/sdk/package-lock.json"
)
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --allowlist=*) ALLOWLIST="${1#--allowlist=}" ;;
    --roots=*) IFS=',' read -r -a ROOTS <<< "${1#--roots=}" ;;
    --locks=*) IFS=',' read -r -a LOCKS <<< "${1#--locks=}" ;;
    --verbose) VERBOSE=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$ALLOWLIST" ]; then
  echo "check-network-allowlist: allowlist not found: $ALLOWLIST" >&2
  exit 2
fi
for root in "${ROOTS[@]}"; do
  [ -f "$root" ] || [ -d "$root" ] || { echo "check-network-allowlist: root not found: $root" >&2; exit 2; }
done

# 1. Telemetry / crash-reporting packages and crates in the lockfiles.
for lock in "${LOCKS[@]}"; do
  if [ ! -f "$lock" ]; then
    echo "check-network-allowlist: lockfile not found: $lock" >&2
    exit 2
  fi
done
export REPO TXR_NETWORK_ROOT_LOCKS="$(IFS=,; echo "${LOCKS[*]}")"
python3 <<'PYEOF' || exit $?
import json
import os
import re
import sys

# Names of telemetry / crash-reporting dependencies. A package is flagged by
# its declared NAME, never by a substring of its registry path, so ordinary
# dependencies such as `@turf/line-segment` or `overlayscrollbars` cannot trip
# it. OpenTelemetry exporters/SDKs count; the tracer API alone does not.
TELEMETRY = re.compile(
    r"^(sentry|@sentry/|posthog|@segment/|segment-|mixpanel|@amplitude/|amplitude-|"
    r"datadog|@datadog/|honeycomb|@honeycombio/|bugsnag|@bugsnag/|@rollbar/|rollbar-|"
    r"telemetry|@opentelemetry/exporter|@opentelemetry/sdk)"
)

found = []
for lock in os.environ["TXR_NETWORK_ROOT_LOCKS"].split(","):
    if not lock:
        continue
    text = open(lock, encoding="utf-8", errors="replace").read()
    if lock.endswith("Cargo.lock"):
        names = re.findall(r'^name = "([^"]+)"', text, re.M)
    else:
        names = re.findall(r'^\s{2,}"node_modules/([^"]+)":', text, re.M)
    for name in names:
        if TELEMETRY.match(name):
            found.append(f"{os.path.basename(lock)}: {name}")

if found:
    for line in found:
        print(f"check-network-allowlist: telemetry or crash-reporting dependency: {line}", file=sys.stderr)
    sys.exit(1)
PYEOF

# 2. Outbound hosts as http(s)/ws(s) literals in shipped non-test source.
export REPO ALLOWLIST VERBOSE
export TXR_NETWORK_ROOTS="$(IFS=,; echo "${ROOTS[*]}")"
python3 <<'PYEOF' || exit $?
import os
import re
import sys

repo = os.environ["REPO"]
allowlist_path = os.environ["ALLOWLIST"]
roots = [r for r in os.environ.get("TXR_NETWORK_ROOTS", "").split(",") if r]
verbose = os.environ.get("VERBOSE") == "1"

allowed = set()
scheme_less = set()
for line in open(allowlist_path, encoding="utf-8"):
    body, _, comment = line.partition("#")
    body = body.strip()
    if body:
        allowed.add(body.lower())
    # A comment line `# scheme-less: host host ...` names hosts that are used by a tool and
    # never spelled with a scheme in the source. Entry lines stay the bare host, because other
    # readers (tests, probes) match whole lines.
    m = re.match(r"\s*scheme-less:\s*(.+)$", comment)
    if not body and m:
        scheme_less.update(h.lower() for h in m.group(1).split())

always = {
    "127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "127.0.0.99",
}
skip_dir = re.compile(r"(^|/)(tests?|__fixtures__|fixtures|scripts?|openapi|gen|dist|workstore|billing|infra)(/|$)")
skip_file = re.compile(r"\.(test|spec)\.[a-z]+$")
url_re = re.compile(r"(https?|wss?)://([A-Za-z0-9._\\\-]+|\[[0-9a-f:]+\])(?::([0-9]+))?")
cfgtest = re.compile(r"#\s*\[cfg\(test\)\]")


def is_example(host):
    if host in ("example.com", "example.net", "example.org"):
        return True
    for suffix in (".example", ".invalid", ".test", ".example.com",
                   ".example.net", ".example.org", ".local"):
        if host.endswith(suffix):
            return True
    return False


def clean(path):
    ext = path.endswith((".rs", ".ts", ".tsx", ".js", ".mjs"))
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    out = []
    in_block = False
    tests = False
    for line in lines:
        if in_block:
            if "*/" in line:
                line = line.split("*/", 1)[1]
                in_block = False
            else:
                continue
        if line.strip().startswith("///") or line.strip().startswith("//!"):
            line = ""
        elif "//" in line and ext:
            guard = line.replace("://", "\x00PROT\x00")
            line = guard.split("//", 1)[0].replace("\x00PROT\x00", "://")
        if "/*" in line:
            before, rest = line.split("/*", 1)
            line = before
            in_block = True
            pending = rest.split("*/", 1)
            if len(pending) == 2:
                line = line + pending[1]
                in_block = False
        if not tests and cfgtest.search(line):
            tests = True
            continue
        if tests:
            if line in ("}", "}\r"):
                tests = False
            continue
        out.append(line)
    return "\n".join(out)


hosts = {}
locations = {}
for root in roots:
    root = root.rstrip("/")
    if os.path.isdir(root):
        for dp, dn, fn in os.walk(root):
            if skip_dir.search(dp):
                continue
            for f in fn:
                if skip_file.search(f):
                    continue
                if not f.endswith((".rs", ".ts", ".tsx", ".js", ".mjs", ".html", ".json")):
                    continue
                path = os.path.join(dp, f)
                for i, line in enumerate(clean(path).split("\n"), 1):
                    for m in url_re.finditer(line):
                        host = m.group(2).lower().replace("\\.", ".")
                        if host.startswith("["):
                            continue
                        hosts.setdefault(host, 0)
                        hosts[host] += 1
                        locations.setdefault(host, f"{os.path.relpath(path, repo)}:{i}")
    elif os.path.isfile(root):
        path = root
        for i, line in enumerate(clean(path).split("\n"), 1):
            for m in url_re.finditer(line):
                host = m.group(2).lower().replace("\\.", ".")
                if host.startswith("["):
                    continue
                hosts.setdefault(host, 0)
                hosts[host] += 1
                locations.setdefault(host, f"{os.path.relpath(path, repo)}:{i}")

bad = []
for host in sorted(hosts):
    if host in allowed or host in always or is_example(host):
        if verbose:
            print(f"  ok   {host}  {locations[host]}")
        continue
    bad.append(host)
    print(f"  NEW  {host}  {locations[host]}", file=sys.stderr)

stale = sorted(h for h in allowed if h not in hosts and h not in scheme_less)
for host in stale:
    print(f"  STALE  {host}  matches no literal in the scan roots (delete it, or name it on a `# scheme-less:` line)", file=sys.stderr)

if bad:
    print("check-network-allowlist: outbound host(s) outside the allowlist in shipped source", file=sys.stderr)
if stale:
    print("check-network-allowlist: allowlist entr(ies) that match nothing in the scan roots", file=sys.stderr)
if bad or stale:
    sys.exit(1)
print("check-network-allowlist: no outbound hosts outside the allowlist; no telemetry dependencies")
PYEOF
