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
# Usage:
#   scripts/check-network-allowlist.sh
#   scripts/check-network-allowlist.sh --verbose
#   CYTO_NETWORK_ALLOWLIST=... scripts/check-network-allowlist.sh
#
# Options (used by the test):
#   --allowlist=FILE   allowlist file (default scripts/network-allowlist.txt)
#   --roots=D1[,D2..]  source roots to scan (default: the shipped set)
#   --locks=F1[,F2..]  lockfiles to scan for telemetry (default: the repo locks)
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ALLOWLIST="$REPO/scripts/network-allowlist.txt"
ROOTS=(
  "$REPO/src-app/server/src"
  "$REPO/src-app/desktop/tauri/src"
  "$REPO/src-app/ui/src"
  "$REPO/src-app/libs/dock/src"
  "$REPO/src-app/libs/viz/src"
  "$REPO/sdk/crates/ziee-core/src"
  "$REPO/sdk/crates/ziee-framework/src"
  "$REPO/sdk/crates/ziee-file/src"
  "$REPO/sdk/crates/ziee-health/src"
  "$REPO/sdk/crates/ziee-identity/src"
  "$REPO/sdk/crates/ziee-notification/src"
  "$REPO/sdk/crates/ziee-control-mcp/src"
  "$REPO/sdk/crates/ziee-auth/src"
  "$REPO/sdk/crates/ziee-build-support/src"
  "$REPO/sdk/crates/sandbox-seccomp/src"
  "$REPO/sdk/desktop/harness/src"
  "$REPO/sdk/packages/framework/src"
  "$REPO/sdk/packages/kit/src"
  "$REPO/sdk/packages/shell/src"
  "$REPO/src-app/desktop/tauri/tauri.conf.json"
  "$REPO/src-app/desktop/tauri/capabilities/default.json"
)
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
export REPO CYTO_NETWORK_ROOT_LOCKS="$(IFS=,; echo "${LOCKS[*]}")"
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
for lock in os.environ["CYTO_NETWORK_ROOT_LOCKS"].split(","):
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
export CYTO_NETWORK_ROOTS="$(IFS=,; echo "${ROOTS[*]}")"
python3 <<'PYEOF' || exit $?
import os
import re
import sys

repo = os.environ["REPO"]
allowlist_path = os.environ["ALLOWLIST"]
roots = [r for r in os.environ.get("CYTO_NETWORK_ROOTS", "").split(",") if r]
verbose = os.environ.get("VERBOSE") == "1"

allowed = set()
for line in open(allowlist_path, encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if line:
        allowed.add(line.lower())

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

if bad:
    print("check-network-allowlist: outbound host(s) outside the allowlist in shipped source", file=sys.stderr)
    sys.exit(1)
print("check-network-allowlist: no outbound hosts outside the allowlist; no telemetry dependencies")
PYEOF
