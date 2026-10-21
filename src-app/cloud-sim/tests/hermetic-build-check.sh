#!/usr/bin/env bash
# Acceptance harness for the hermetic worker-image build (INV-1 / gap #1).
#
#   default (wiring) mode : assert worker.Dockerfile stands up its OWN build-time Postgres and
#                           provisions it BEFORE `cargo build --features saas` — the thing the
#                           frozen SDK build scripts require and cannot be told to skip. Fast.
#   --full                : additionally run the REAL `docker build` from a clean checkout with
#                           the documented command and assert it SUCCEEDS with no external DB.
#                           Heavy (rust+saas image build); run when you can afford it.
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
DOCKERFILE="$DIR/worker.Dockerfile"
MODE="${1:-wiring}"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }
has() { grep -q -- "$2" "$1"; }

echo "== TEST-1: hermetic build wiring (INV-1) =="
has "$DOCKERFILE" 'initdb'                                   && ok "builder stands up its own Postgres (initdb)"   || bad "no in-builder initdb"
has "$DOCKERFILE" 'pg_ctl -D /pgbuild'                       && ok "starts the build-time Postgres"                || bad "no pg_ctl start"
has "$DOCKERFILE" 'p 54321'                                  && ok "on the committed build-cluster port 54321"     || bad "not on :54321"
# Ordering: the DB must start BEFORE cargo build (else every build.rs panics on connect).
if awk '/pg_ctl -D \/pgbuild -w -o/{s=NR} /cargo build --release -p cytoanalyst/{if(s&&NR>s){print "ok"; exit}}' "$DOCKERFILE" | grep -q ok; then
  ok "Postgres start precedes cargo build"
else
  bad "cargo build not ordered after the Postgres start"
fi
has "$DOCKERFILE" 'features saas'                            && ok "builds the saas feature"                       || bad "saas feature not built"
# No SQLX_OFFLINE *build directive* (it would be a false hermetic path — the SDK build scripts
# ignore it and connect anyway). A prose mention in a comment is fine; an ENV/export is not.
if grep -Eq '^\s*(ENV\s+)?SQLX_OFFLINE\s*=|export\s+SQLX_OFFLINE' "$DOCKERFILE"; then
  bad "SQLX_OFFLINE set as a build directive (misleading — SDK build.rs ignore it)"
else
  ok "no misleading SQLX_OFFLINE build directive"
fi

if [ "$MODE" = "--full" ] || [ "$MODE" = "full" ]; then
  echo "== TEST-1 (--full): real docker build from a clean checkout =="
  command -v docker >/dev/null 2>&1 || { bad "docker not on PATH"; echo "== $pass passed, $fail failed =="; exit 1; }
  TAG="cyto-sim-worker:hermetic-check-$$"
  if docker build -f "$DOCKERFILE" -t "$TAG" "$ROOT"; then
    ok "docker build succeeded hermetically (no external DB)"
    docker rmi "$TAG" >/dev/null 2>&1 || true
  else
    bad "docker build FAILED"
  fi
fi

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" -eq 0 ] || exit 1
