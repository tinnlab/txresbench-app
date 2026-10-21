#!/usr/bin/env bash
# cloud-sim-guard.sh — the DE-INV-13 / INV-1 "no cloud credentials" preflight.
#
# T1 seam PROV-T1-5. Every cloud-sim test tier calls this FIRST. It FAILS
# (non-zero) the moment a REAL cloud credential or a REAL (non-loopback) cloud
# endpoint is present in the environment, so the "runs on AWS/GCP without a
# credential" portability claim is continuously *verified* rather than trusted —
# and every downstream tier (T2 object-store, T3 worker e2e, T4 KEDA scaling)
# inherits the guarantee without re-implementing the check.
#
# It is deliberately NARROW + LOUD: it names the exact variable that tripped it,
# so a false trip is self-diagnosing. Loopback endpoints (the sim's own
# S3_ENDPOINT / STORAGE_EMULATOR_HOST) are ALLOWED — that is the whole point.
#
# Usage:
#   bash scripts/cloud-sim-guard.sh              # guard the current env (exit!=0 on a real cred)
#   bash scripts/cloud-sim-guard.sh --selftest   # prove it PASSES clean + FAILS on a planted cred (TEST-5)
set -uo pipefail

FAIL=0
note() { echo "[cloud-sim-guard] $*" >&2; }
trip() { note "REFUSE: $*"; FAIL=1; }

# A URL/host is loopback-only iff its HOST is localhost, ::1, or an address in
# 127.0.0.0/8. Parsed strictly — a naive `127.*` glob + no userinfo strip let a
# REAL host masquerade as loopback and defeated the guard's whole purpose
# (`http://127.0.0.1@s3.amazonaws.com`, `http://127.0.0.1.evil.com`). We strip
# scheme, PATH, and USERINFO, then require the host to be an exact loopback name
# or a full-octet 127.0.0.0/8 IPv4 — never a mere prefix.
is_loopback() {
  local v="${1:-}"
  v="${v#*://}"        # strip scheme
  v="${v%%/*}"         # strip path (and everything after the first '/')
  v="${v##*@}"         # strip userinfo up to and INCLUDING the last '@' (the fix)
  local host="$v"
  case "$host" in
    '['*']'*) host="${host#\[}"; host="${host%%\]*}" ;;   # [ipv6]:port → ipv6
    *)        host="${host%%:*}" ;;                         # host:port → host
  esac
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  case "$host" in
    localhost|::1) return 0 ;;
  esac
  # strict IPv4 loopback 127.0.0.0/8 — the WHOLE host must be four numeric octets.
  [[ "$host" =~ ^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] && return 0
  return 1
}

guard_env() {
  FAIL=0
  # 1. A named AWS profile / SSO profile means real, resolvable creds on disk.
  [ -n "${AWS_PROFILE:-}" ] && trip "AWS_PROFILE is set ('${AWS_PROFILE}') — a named profile resolves real cloud credentials."
  # 2. IRSA / AssumeRole-with-web-identity (the k8s-on-AWS credential path).
  [ -n "${AWS_ROLE_ARN:-}" ] && trip "AWS_ROLE_ARN is set — an IAM role would provide real cloud credentials."
  [ -n "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && trip "AWS_WEB_IDENTITY_TOKEN_FILE is set — web-identity federation yields real credentials."
  # 2b. AWS temporary-session credentials (STS) present in the env.
  [ -n "${AWS_SESSION_TOKEN:-}" ] && trip "AWS_SESSION_TOKEN is set — real temporary STS credentials are present."
  # 3. GCP application-default credentials — env pointer OR the default ADC path.
  [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && trip "GOOGLE_APPLICATION_CREDENTIALS is set ('${GOOGLE_APPLICATION_CREDENTIALS}') — a real GCP service-account key."
  [ -f "${HOME:-/nonexistent}/.config/gcloud/application_default_credentials.json" ] && trip "gcloud application-default credentials exist at ~/.config/gcloud/ — a real GCP identity."
  # 4. A real-looking AWS access key id (AKIA…/ASIA… are the real prefixes;
  #    the sim's dummy key is 'cyto-sim').
  case "${AWS_ACCESS_KEY_ID:-}" in
    AKIA*|ASIA*) trip "AWS_ACCESS_KEY_ID looks like a real AWS key ('${AWS_ACCESS_KEY_ID:0:4}…')." ;;
  esac
  # 4b. On-disk AWS credentials — the SDK resolves the default profile with NO env
  #     var set, so an env-only guard would miss it. A pointer env var to a cred
  #     file trips; a default ~/.aws/credentials trips only if it holds a REAL
  #     (AKIA/ASIA) key, so a box carrying only non-AWS cloud config is not tripped.
  for var in AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE AWS_WEB_IDENTITY_TOKEN_FILE; do
    f="${!var:-}"; [ -n "$f" ] && [ -f "$f" ] && trip "$var points at an existing credentials file ('$f') — real AWS credentials on disk."
  done
  if [ -f "${HOME:-/nonexistent}/.aws/credentials" ] && grep -qE '(AKIA|ASIA)[A-Z0-9]{8,}' "${HOME}/.aws/credentials" 2>/dev/null; then
    trip "~/.aws/credentials contains a real AWS access key — the SDK would use the default profile."
  fi
  # 5. A cloud ENDPOINT override that is NOT loopback (a real S3/GCS/STS host).
  #    Includes ALL AWS_ENDPOINT_URL_* service overrides, not a fixed few.
  local endpoint_vars="S3_ENDPOINT AWS_ENDPOINT AWS_ENDPOINT_URL STORAGE_EMULATOR_HOST"
  while IFS='=' read -r name _; do
    case "$name" in AWS_ENDPOINT_URL_*) endpoint_vars="$endpoint_vars $name" ;; esac
  done < <(env 2>/dev/null)
  for var in $endpoint_vars; do
    val="${!var:-}"
    [ -z "$val" ] && continue
    if ! is_loopback "$val"; then
      trip "$var='$val' is NOT a loopback endpoint — the sim substrate is loopback-only; a real cloud host is refused."
    fi
  done
  # 6. An ATTACHED cloud identity via instance metadata. Require an actual
  #    metadata 200 (curl -f), not mere reachability — a bare `curl` (no -f)
  #    returns 0 on a 400/404 from any link-local responder, false-tripping the
  #    guard on its own target platform. AWS IMDSv2 token PUT + GCP metadata GET
  #    each 200 only on a real EC2/GCE host.
  if command -v curl >/dev/null 2>&1; then
    if curl -sf --connect-timeout 1 --max-time 1 -o /dev/null -X PUT \
         -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
         "http://169.254.169.254/latest/api/token" 2>/dev/null; then
      trip "AWS instance-metadata (IMDSv2) responded — this host has an attached EC2 identity."
    elif curl -sf --connect-timeout 1 --max-time 1 -o /dev/null \
         -H 'Metadata-Flavor: Google' \
         "http://169.254.169.254/computeMetadata/v1/instance/id" 2>/dev/null; then
      trip "GCP instance-metadata responded — this host has an attached GCE identity."
    fi
  fi
  return "$FAIL"
}

if [ "${1:-}" = "--selftest" ]; then
  rc=0
  # Positive control: a clean loopback sim env must PASS.
  ( unset AWS_PROFILE AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE GOOGLE_APPLICATION_CREDENTIALS
    export AWS_ACCESS_KEY_ID=cyto-sim AWS_SECRET_ACCESS_KEY=cyto-sim-secret
    export S3_ENDPOINT=http://127.0.0.1:9000 STORAGE_EMULATOR_HOST=http://127.0.0.1:4443
    guard_env ) \
    && note "selftest[+] clean loopback env PASSES (positive control)" \
    || { note "selftest[+] FAILED: a clean loopback env was wrongly refused"; rc=1; }

  # Negative control (TEST-5): a planted REAL cloud endpoint must FAIL.
  ( export S3_ENDPOINT=https://s3.us-east-1.amazonaws.com; guard_env ) \
    && { note "selftest[-] FAILED: a real S3 endpoint was NOT refused"; rc=1; } \
    || note "selftest[-] planted real S3_ENDPOINT is correctly REFUSED (negative control)"

  # Negative control — the LOOPBACK-MASQUERADE class (userinfo + prefix tricks)
  # that a naive `127.*` glob let through. Each must be REFUSED.
  for u in "http://127.0.0.1@s3.amazonaws.com/b" "http://127.0.0.1.evil.com" "http://127.evil.com" "http://localhost.evil.com"; do
    ( export S3_ENDPOINT="$u"; guard_env ) \
      && { note "selftest[-] FAILED: loopback-masquerade '$u' was NOT refused"; rc=1; } \
      || note "selftest[-] loopback-masquerade '$u' correctly REFUSED"
  done
  # Positive control — genuine loopback forms (incl. ipv6 + port) must PASS.
  for u in "http://127.0.0.1:9000" "http://localhost:9000" "http://[::1]:4443" "http://127.5.5.5"; do
    ( unset AWS_PROFILE AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE GOOGLE_APPLICATION_CREDENTIALS
      export AWS_ACCESS_KEY_ID=cyto-sim S3_ENDPOINT="$u"; guard_env ) \
      && note "selftest[+] genuine loopback '$u' correctly PASSES" \
      || { note "selftest[+] FAILED: genuine loopback '$u' was wrongly refused"; rc=1; }
  done

  # Negative control #2: a planted GCP credential file must FAIL.
  ( export GOOGLE_APPLICATION_CREDENTIALS=/tmp/fake-sa-key.json; guard_env ) \
    && { note "selftest[-] FAILED: GOOGLE_APPLICATION_CREDENTIALS was NOT refused"; rc=1; } \
    || note "selftest[-] planted GOOGLE_APPLICATION_CREDENTIALS is correctly REFUSED (negative control)"

  # Negative control #3: a planted real-looking AWS key must FAIL.
  ( export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE; guard_env ) \
    && { note "selftest[-] FAILED: an AKIA… access key was NOT refused"; rc=1; } \
    || note "selftest[-] planted AKIA… AWS_ACCESS_KEY_ID is correctly REFUSED (negative control)"

  [ "$rc" -eq 0 ] && note "SELFTEST PASS" || note "SELFTEST FAIL"
  exit "$rc"
fi

guard_env
rc=$?
[ "$rc" -eq 0 ] && note "OK — no real cloud credential or non-loopback endpoint present."
exit "$rc"
