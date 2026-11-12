# Admin suspend/disable account + plan/tier override (no Stripe round-trip)

Design note for GitHub issues **#37** (admin suspend/disable an account) and **#38** (admin
change plan / tier override), TxResBench Admin Console epic. Both are admin billing/account
WRITE controls that share files (the `accounts` billing columns, the admin scopes, the
`check_quota` gate, the webhook state machine), so they are planned + built together.

Extends `docs/design/metering-billing-quota.md` (the B3 dunning state machine + the B4
`check_quota` admission gate) and mirrors the override-layer pattern of
`docs/design/admin-credits-override.md` (#39): an admin-controlled mechanism that sits ABOVE
the Stripe-webhook-driven billing state, WITHOUT editing the code-defined plan catalog and
WITHOUT a Stripe round-trip.

## Problem

Today an account's **suspension** is purely DERIVED from `subscription_status`
(`dunning::is_suspended` — `canceled`/`unpaid`/`incomplete_expired`); there is NO admin-set
"disable this account" flag. And an account's **plan** (`accounts.plan_id`) is written ONLY by
the Stripe webhook path (`process_webhook` → `apply_transition`); an admin cannot comp an
account onto `pro` without a real Stripe subscription, and any direct write would be silently
clobbered by the next `customer.subscription.updated` webhook.

An operator needs two admin write controls:

1. **Suspend / disable an account** independent of its billing status (abuse, non-payment
   outside Stripe, an operator hold) — and later reactivate it.
2. **Change an account's plan / tier directly** (comp a partner onto a paid tier; move an
   account between tiers) with NO Stripe round-trip — and have that override SURVIVE later
   Stripe webhooks until an admin explicitly releases it.

## Model

### #37 — admin suspend (an ADDITIONAL, independent suspension flag)

A new **`accounts.admin_suspended boolean`** column (+ audit columns `admin_suspended_at` /
`admin_suspended_by` / `admin_suspend_reason`). It is a SECOND, independent suspension source
that is **OR-ed** with the derived billing suspension:

```
suspended = dunning::is_suspended(subscription_status)   // billing/derived (unchanged)
            || accounts.admin_suspended                  // admin-set (new)
```

The admin-suspend flag is set/cleared ONLY by the admin route; the Stripe webhook path never
touches it, and `is_suspended` (the derived billing suspension) keeps working exactly as
before. The two are genuinely independent: reactivating an admin-suspend does NOT clear a real
billing suspension, and clearing a billing suspension (a paid invoice) does NOT lift an admin
suspend.

**Enforcement point — `check_quota` (the existing suspension gate).** The current suspension
gate is B4's `check_quota`, called at compute `create_job` (`jobs::quota::enforce_compute_quota`)
and workstore ingest (`workstore::ingest`). `check_quota`'s pure `decide` already refuses a
`suspended` account FIRST — before the plan allowance math AND before the #39 premium/credit
override (a delinquent subscription is not comp-able). By folding `admin_suspended` into that
same `suspended` input, an admin suspend:

- Blocks BOTH compute (job-create → 402) and storage (ingest → 507), the same two gates a
  billing suspension blocks — no new gate is invented (issue #37: "quota is the current
  suspension gate; extend there").
- Takes **precedence over credits and premium** by construction: `decide` returns
  `BlockOverQuota` on `suspended` before it ever consults `premium` or `credit_balance_cents`.
  An admin suspend is therefore NOT overridable by a credit grant or a premium comp — the
  correct policy (an operator hold must not be defeated by the account's own budget).

The pure `decide` is UNCHANGED (it already takes `suspended: bool`); only the `check_quota`
wrapper OR-s in the new column. With `admin_suspended = false` (every existing account) the
verdict is byte-identical to today.

### #38 — admin plan override + webhook reconciliation (the correctness crux)

`PUT /api/admin/accounts/{id}/plan` writes `accounts.plan_id` DIRECTLY (validated against the
code-defined `catalog`) with NO Stripe call, and sets a **manual-override marker**
`accounts.plan_manually_set boolean` (+ audit `plan_override_at` / `plan_override_by`).

**Reconciliation policy (the crux).** While `plan_manually_set = true`:

- The Stripe webhook state machine (`apply_transition`) STILL updates `subscription_status`
  and `grace_until` (the account's Stripe lifecycle is still tracked — a real cancel/past-due
  still registers, and a real billing suspension still derives via `is_suspended`).
- The webhook does **NOT** overwrite `plan_id` — the admin override WINS. `apply_transition`
  reads `plan_manually_set` inside its existing `SELECT … FOR UPDATE` row lock (zero extra
  query, zero race: the row is already locked for the transition), and when the marker is set
  it keeps the current `plan_id` regardless of what the transition would have set.

The override is released ONLY explicitly, by `DELETE /api/admin/accounts/{id}/plan`, which
clears `plan_manually_set` (hands plan control back to Stripe; the next webhook reconciles
`plan_id`). This is the symmetric clear path — an admin comp WINS UNTIL EXPLICITLY CLEARED.

With `plan_manually_set = false` (every existing account) `apply_transition` is byte-identical
to today.

The plan route is `saas`-gated (it lives in the `billing` module behind `billing::admin` +
the §16 Stripe kill-switch); the `accounts` columns exist in BOTH builds (the migration tree
is scanned regardless of the `saas` feature), so desktop carries the columns inert.

## Invariants (lifted into PLAN.md `## Invariants`, pinned by `[acceptance]` tests)

- **INV-1** — Admin suspends account → its `check_quota` Blocks (job/usage denied); reactivate
  → unblocks.
- **INV-2** — An admin-suspend is NOT overridden by a credit grant or premium (suspend
  precedence / ordering).
- **INV-3** — Admin sets plan → `plan_id` changes immediately (no Stripe); the account's
  allowance reflects the new plan.
- **INV-4** — A webhook arriving after an admin override does NOT clobber the admin-set
  `plan_id` (the reconciliation crux) — but still updates `subscription_status`.
- **INV-5** — Non-admin → 401/403 on the suspend + plan routes.
- **INV-6** — Existing dunning/derived-suspension + the #39 credit paths are UNCHANGED when no
  admin-suspend/override is set (regression / byte-preservation).
- **INV-7** — saas-gated where billing (the plan route); the account status column exists in
  both builds but the admin mutation is admin-gated.

## Gating & placement

- **#37 suspend/reactivate/status** live in the (NOT saas-gated) `admin` module, gated by the
  existing `admin::accounts` permission via `AdminAccountScope` — its permission description
  already reads "List, read, and **suspend** any account". No new permission, no new migration
  grant. The routes appear in the default OpenAPI spec (regen required).
- **#38 plan PUT/DELETE** live in the `saas`-gated `billing` module (`billing/admin.rs`), gated
  by `billing::admin` via `AdminBillingScope`, behind the §16 kill-switch — mirroring the #39
  credits/premium write surface exactly. They do NOT appear in the default OpenAPI spec.

No new permission is introduced (both reuse existing admin keys), so the A10 restricted-user
frontend gate does not apply; the frontend surfaces (#44 accounts-suspend, #45 subscription-plan)
are built by separate agents against these routes.
