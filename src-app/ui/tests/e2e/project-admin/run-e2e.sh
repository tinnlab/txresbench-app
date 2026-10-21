#!/usr/bin/env bash
# Project-admin phase-8 e2e runner (CytoAnalyst in-harness recipe).
#
# CytoAnalyst's web e2e model is TWO servers: the Rust backend (external docker
# Postgres on :54321 — NOT the embedded PG, so the process-killing harness can't
# SIGKILL a PG subprocess as exit-144) + a `vite preview` proxying /api → backend.
# We pre-boot BOTH in the background with a trap-cleanup (the `&`+trap keeps the
# harness from surfacing an exit-144 from a killed child), then run Playwright
# with `reuseExistingServer` so it attaches to our servers instead of booting a
# fresh cytoanalyst_e2e (which would collide on :3155).
#
# NODE_OPTIONS=--dns-result-order=ipv4first: the backend binds 127.0.0.1 (IPv4)
# but Node v24 resolves `localhost` (the config's webServer reuse-check URL) to
# ::1 first — forcing ipv4-first makes the reuse-check hit our backend.
set -u

ROOT=/data/pbya/ziee/tmp/project-admin-wt
TMP=/data/pbya/ziee/tmp
cd "$ROOT" || exit 2

pkill -f target/debug/cytoanalyst 2>/dev/null || true
pkill -f "vite preview" 2>/dev/null || true
sleep 1

DB=cytoanalyst_e2e_admin
CFG="$TMP/project-admin-e2e.yaml"
sed "s/cytoanalyst_e2e/$DB/g" src-app/server/config/e2e.yaml > "$CFG"

echo "== resetting DB $DB =="
PGPASSWORD=password psql -h 127.0.0.1 -p 54321 -U postgres \
  -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" \
  -c "CREATE DATABASE $DB" || { echo "PSQL FAILED"; exit 2; }

echo "== building backend =="
( cd src-app/server && cargo build --bin cytoanalyst ) > "$TMP/project-admin-build-be.log" 2>&1
if [ $? -ne 0 ]; then echo "BACKEND BUILD FAILED"; tail -40 "$TMP/project-admin-build-be.log"; exit 2; fi

echo "== booting backend :3155 =="
( cd src-app/server && CONFIG_FILE="$CFG" ../../target/debug/cytoanalyst > "$TMP/project-admin-BE.log" 2>&1 ) &
BE_PID=$!

echo "== building frontend =="
( cd src-app/ui && npm run build ) > "$TMP/project-admin-build-fe.log" 2>&1
if [ $? -ne 0 ]; then echo "FRONTEND BUILD FAILED"; tail -60 "$TMP/project-admin-build-fe.log"; kill $BE_PID 2>/dev/null; exit 2; fi

echo "== booting vite preview :4173 =="
( cd src-app/ui && VITE_API_PROXY_TARGET=http://127.0.0.1:3155 \
    npx vite preview --port 4173 --strictPort --host > "$TMP/project-admin-FE.log" 2>&1 ) &
FE_PID=$!

cleanup() {
  kill $BE_PID $FE_PID 2>/dev/null || true
  pkill -f target/debug/cytoanalyst 2>/dev/null || true
  pkill -f "vite preview" 2>/dev/null || true
}
trap cleanup EXIT

echo "== waiting for backend =="
ok=0
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:3155/api/app/setup/status >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { echo "BACKEND NEVER CAME UP"; tail -40 "$TMP/project-admin-BE.log"; exit 2; }

echo "== waiting for frontend =="
ok=0
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:4173/ >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { echo "FRONTEND NEVER CAME UP"; tail -40 "$TMP/project-admin-FE.log"; exit 2; }

echo "== running project-admin e2e =="
cd src-app/ui
CI= NODE_OPTIONS=--dns-result-order=ipv4first \
  npx playwright test tests/e2e/project-admin/ --workers=1 2>&1 | tee "$TMP/project-admin-playwright.log"
RC=${PIPESTATUS[0]}
echo "== playwright exit: $RC =="
exit $RC
