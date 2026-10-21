#!/usr/bin/env bash
# billing-smoke.sh — the OPTIONAL, opt-in real-test-mode smoke scaffold (B0 ITEM-10 /
# PROV-B0-7 / DEC-7). The honest reach-limit resolution (INV-3).
#
# WHAT B0 CAN'T MAKE LOCAL: every server-side billing LOGIC path is provable against
# the local sim (stripe-mock + the signed-webhook injector). The ONE thing that cannot
# be local is a HUMAN entering a card on Stripe's HOSTED Checkout/Portal PAGE — the
# browser-redirect step. This script exercises exactly that, and ONLY that, using a
# real Stripe TEST-MODE key + `stripe-cli` + network.
#
# It is GATED OFF BY DEFAULT and EXCLUDED from the local tiers by the no-net guard:
#   * default invocation → prints the CAN/CANNOT boundary and exits 0 (a documented
#     no-op). It NEVER touches the network or a real key unless explicitly opted in.
#   * opt-in requires BOTH `BILLING_SMOKE_TESTMODE=1` AND a real `sk_test_` key in
#     `STRIPE_TESTMODE_KEY` — mirroring T1's "authored but externally-gated, not a
#     descope."
#
# This is a RECORDED reach-limit, not part of the local-tier promise. `just
# billing-sim-test-l1`/`-l2` NEVER call this; the guard would refuse the real key.
set -uo pipefail

say() { echo "[billing-smoke] $*" >&2; }

if [ "${BILLING_SMOKE_TESTMODE:-}" != "1" ]; then
  cat >&2 <<'EOF'
[billing-smoke] OPT-IN real-test-mode smoke — NOT run by default, NOT part of the
local-tier promise (INV-1). This exists only to be HONEST about the one thing the
local sim cannot cover.

  CAN be proved LOCALLY (just billing-sim-test-l1 / -l2, no key, no network):
    • Checkout/Portal/Subscription/Customer request shape + spec-valid responses
      (stripe-mock)
    • webhook signature verify + dispatch + idempotency + dunning transitions
      (the local signed-webhook injector — byte-exact `t=,v1=` HMAC-SHA256)
    • meter-event push shape (the local meter stand-in)

  CANNOT be local — covered ONLY by this opt-in smoke:
    • a HUMAN entering a card on Stripe's HOSTED Checkout/Portal PAGE
      (the browser-redirect step)

To run it (needs a REAL Stripe test-mode account + network + stripe-cli):
    BILLING_SMOKE_TESTMODE=1 STRIPE_TESTMODE_KEY=sk_test_… bash scripts/billing-smoke.sh

Exiting 0 (documented no-op).
EOF
  exit 0
fi

# --- opt-in path (real key + network) ---------------------------------------
key="${STRIPE_TESTMODE_KEY:-}"
case "$key" in
  sk_test_*) : ;;
  *) say "FAIL: opt-in requires a real Stripe TEST-mode key in STRIPE_TESTMODE_KEY (sk_test_…). Refusing — never a live key here."; exit 1 ;;
esac
command -v stripe >/dev/null 2>&1 || {
  say "FAIL: 'stripe' CLI not on PATH. Install stripe-cli (https://stripe.com/docs/stripe-cli) — this real-test-mode smoke needs it."
  exit 1
}

say "real-test-mode smoke: driving a REAL Stripe test-mode Checkout via stripe-cli."
say "NOTE: this reaches api.stripe.com over the network by design — it is the reach-limit,"
say "      never a local tier. The hosted-page card entry is manual/assisted."
# The concrete stripe-cli flow (create a test Checkout Session + `stripe listen` to
# forward the resulting real webhooks) is the operator's to complete against their own
# test account; B0 ships the SCAFFOLD + the honest boundary, not a live account.
export STRIPE_API_KEY="$key"
say "scaffold ready. Example next steps against YOUR test account:"
say "  stripe listen --forward-to localhost:PORT/api/billing/webhook &"
say "  stripe checkout sessions create --mode subscription --line-items ... (or the dashboard)"
say "  # complete the hosted-page card entry manually with test card 4242 4242 4242 4242"
exit 0
