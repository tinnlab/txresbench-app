# CytoAnalyst local billing-sim (B0)

The **local Stripe test substrate** every downstream billing item (B1–B4) is built and
tested against — the billing analogue of the compute epic's `cloud-sim` (T1). It makes
"billing is provable locally with **NO real Stripe** and **NO network**" (INV-1) a
continuously-verified fact, not a claim.

Realizes the billing design (`docs/design/metering-billing-quota.md`, kept on the
unmerged design branch per the "research branches stay unmerged" rule) — **§3** (Stripe
integration: Checkout/Portal/Billing Meters), **§3.4** (webhooks: signature-verified over
the RAW body, idempotent on `event.id`), **§5** (dunning), and **§12** (the OSS survey:
ADOPT Stripe Billing Meters; BUILD the local machinery, don't operate a second service).

## What it stands up

`just billing-sim-up` runs **`stripe/stripe-mock`** — Stripe's official mock, generated
from their OpenAPI spec — on loopback (HTTP `:12111` / HTTPS `:12112`), **no key, no
network**. It returns spec-valid `Customer` / `Product` / `Price` / `Subscription` /
`Checkout Session` / `Billing Portal Session` / `meter_events` responses.

```bash
just billing-sim-up        # up (idempotent); writes + prints the env contract
just billing-sim-down      # down (idempotent; verifies no container survived)
just billing-sim-test-l1   # guard → up → Stripe contract smoke → down   (per-commit)
just billing-sim-test-l2   # guard → up → the Rust full-flow tier → down  (pre-release)
```

## The env contract (PROV-B0-4)

`billing-sim-up` writes `src-app/billing-sim/.billing-sim.env` (gitignored):

```bash
set -a; source src-app/billing-sim/.billing-sim.env; set +a
```

| var | value | meaning |
|---|---|---|
| `STRIPE_API_BASE` | `http://127.0.0.1:12111` | the mock base URL (loopback) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_b0_local_test_secret` | the local test secret the injector signs with + B3 verifies against |
| `STRIPE_SECRET_KEY` | `sk_test_local` | a DUMMY key — the guard allows exactly this, refuses every other `sk_`/`rk_` |

These are **fixed test constants** (DEC-10), never admin-configurable rows. B2/B3 READ
them but honor the loopback override only under `#[cfg(debug_assertions)]` (a debug-only
test seam, DEC-6) — a release binary talks to real Stripe and ignores a loopback redirect.
The `STRIPE_WEBHOOK_SECRET` value MUST equal `DEFAULT_TEST_WHSEC` in
`tests/common/stripe_sim.rs` (the Rust injector) and the dummy key MUST equal `DUMMY_KEY`
in `scripts/billing-sim-guard.sh`.

## The signed-webhook injector (PROV-B0-2 — the correctness core)

stripe-mock is **stateless and emits no webhooks**, so B0 BUILDS the webhook path.
`src-app/server/tests/common/stripe_sim.rs` (TEST-ONLY — never in the server/desktop
binary) constructs a Stripe-shaped event and signs it with the local `whsec_` using
Stripe's **real** scheme:

```
Stripe-Signature: t=<unix-ts>,v1=<hex HMAC-SHA256("{ts}.{raw_body}", key=whsec)>
```

- `make_event(event_type, object_json) -> (Bytes, String)` — build + sign an event.
- `sign_event(raw_body, whsec, ts) -> String` — the header for arbitrary bytes.
- `verify_signature(raw_body, sig_header, whsec, tolerance, now)` — the reference
  verifier (parses `t` + all `v1`, one-sided 300s freshness window, constant-time compare).

The bytes are **client-library-agnostic**: they verify under async-stripe's
`Webhook::construct_event` or any spec-compliant verifier B3 chooses. Byte-exactness is
anchored by a **known-answer vector computed by OpenSSL** (`openssl dgst -sha256 -hmac`),
asserted in the module's `#[cfg(test)]` self-tests and re-checked by the Node shim
`scripts/stripe-sign.mjs --selftest` (an independent OpenSSL implementation). A tampered /
unsigned / wrong-secret / stale body is rejected (the negative controls that make it mean
something).

Shell tiers sign via the Node shim:
```bash
printf '%s' "$BODY" | node scripts/stripe-sign.mjs sign --secret "$STRIPE_WEBHOOK_SECRET" --ts 1700000000
```

## The meter-events stand-in (PROV-B0-3)

`stripe_sim::meter_capture()` is a loopback axum router accepting
`POST /v1/billing/meter_events`, returning a spec-valid ack and RECORDING each call so a
test can assert the reporter pushed the right `{event_name, stripe_customer_id, value,
identifier}`. It asserts the **SEND shape**, not Stripe's async aggregation/invoicing
(unreachable locally by design; the v2 `meter_event_stream` is live-mode-only — DEC-9).
The async meter-*error* events are injectable as signed webhooks via the injector.

## The test tiers (PROV-B0-5)

- **Level-1** (`billing-sim-test-l1`, per-commit, fail-closed): guard → up → a Stripe
  contract smoke (Customer create+retrieve, Price list, Checkout Session, Portal Session,
  meter_events ack) → down. Mock-only, no key, no network.
- **Level-2** (`billing-sim-test-l2`, pre-release, full-flow-local): guard → up → the Rust
  `billing::l2_full_flow_local` test: `checkout.sessions.create` against the mock → inject
  a locally-signed `checkout.session.completed` → the **placeholder consumer** verifies +
  dispatches → `invoice.payment_failed` (grace) + `customer.subscription.deleted`
  (suspend-not-delete, §5 dunning) → a meter push. Run under `CYTO_TEST_NO_SKIP=1` so the
  env-gate self-skip becomes a hard failure. **B2/B3 replace the placeholder consumer with
  the real `/api/billing/webhook` handler in this same harness** (DEC-8).

## The no-real-key / no-network guard (PROV-B0-6)

`scripts/billing-sim-guard.sh` runs FIRST in every tier, on the AMBIENT env. It FAILS the
tier if a real Stripe key (`sk_live_`/`rk_`/a non-dummy `sk_test_`), a non-loopback
`STRIPE_API_BASE`, or an `api.stripe.com` endpoint override is present — with the same
loopback-masquerade defenses (userinfo/prefix tricks) as `cloud-sim-guard.sh`. Prove it:
`bash scripts/billing-sim-guard.sh --selftest`. It also carries `--diff-scope`, the
executable INV-4 proof that B0's diff touches no server/desktop runtime source.

## The honest CAN / CANNOT boundary (PROV-B0-7)

**CAN** be proved LOCALLY: every server-side billing LOGIC path — Session/Subscription/
Customer request shape + spec-valid responses; webhook verify + dispatch + idempotency +
dunning transitions; meter-event push shape.

**CANNOT** be local:
- a **human entering a card on Stripe's hosted Checkout/Portal page** (the browser
  redirect) — covered ONLY by the opt-in `just billing-smoke-testmode` (a real `sk_test_`
  key + network, gated off by default, excluded from the local tiers by the guard — DEC-7);
- **stateful create→retrieve round-trips** — stripe-mock is stateless, so tests assert
  request shape + drive results via injected webhooks, never by reading a created object back;
- Stripe's **async usage aggregation / invoice progression** (the v2 meter stream, meter
  roll-up).

This is the T1-style honest "real-service-only gaps" record — a documented reach-limit,
not a descope.
