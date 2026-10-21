# Admin settings coverage — expose the hardcoded billing knobs (design)

**Source of intent:** GitHub issue [#41](https://github.com/ziee-ai/cytoanalyst/issues/41)
("Backend: admin settings coverage + expose hardcoded catalog/rate knobs") — a
remainder item of the Admin Console epic (#30/#42, `docs/design/admin-console-shell.md`).
The epic promises an admin can "view, update, list, change all settings of everything";
tiers 0-3 delivered account/billing/credit/flag control (#37/#38/#39/#40). This item fills
the specific gap issue #41 names: **billing operational knobs baked into source constants
that today have no admin read/write surface.**

## Problem (from #41, verbatim scope)

> PARTIAL — admin GET/PUT settings exist for jobs/sandbox/provenance/billing (global
> singletons) but NOT for account/user/workstore/project/dataset/mcp/extensions/rootfs.
> Hardcoded-should-be-settable: plan catalog + allowances (`catalog.rs:54`), overage rates
> (`quota.rs:52`), only `grace_period_days` is editable.

The billing module already owns the `billing_settings` singleton (currently only
`grace_period_days`, gated `billing::manage`). Several billing policy knobs sit next to it
as bare `const`s with no admin surface:

| Knob | Source constant | Controls |
|---|---|---|
| Overage projection rate (compute) | `quota.rs:52` `OVERAGE_CENTS_PER_CORE_HOUR = 10.0` | cents/core-hour used to project a paid account's overage cost against its spend cap |
| Overage projection rate (storage) | `quota.rs:54` `OVERAGE_CENTS_PER_GB_MONTH = 5.0` | cents/GB-month for the same spend-cap projection |
| Webhook event retention | `rollup.rs:53` `WEBHOOK_EVENT_RETENTION_DAYS = 90` | how long processed Stripe webhook dedupe rows are kept before pruning |
| Webhook signature tolerance | `webhook.rs:37` `SIGNATURE_TOLERANCE_SECS = 300` | clock-skew window accepted on a Stripe webhook signature |
| Plan CATALOG allowances + policy | `catalog.rs:58` `static CATALOG` | per-tier compute/storage allowance + hard-cap-vs-overage policy every account inherits |

## The distinction this design draws (the crux)

The knobs above are NOT all the same KIND of value, and #41 must not flatten them:

- **The overage projection rates, webhook retention, and signature tolerance are
  operational tunables** — an operator may legitimately need to change them without a code
  release (a retention-policy change, a stricter/looser webhook skew window, a corrected
  projection rate). Per the feature-lifecycle *configurable-settings rule* these default to
  **admin-configurable** via the singleton-settings pattern.

- **The plan catalog's allowances and hard-cap-vs-overage policy are a COGS boundary,
  deliberately kept out of an operator's reach.** This is a prior, recorded decision, stated
  in `modules/billing/catalog.rs` itself and lifted here VERBATIM as the governing invariant:

  > Design §4.1: the plan SET (and its allowance POLICY — hard-cap vs overage) is
  > **code-defined** and versioned here, auditable and out of an operator's reach
  > (DEC-2/DEC-9 — a COGS boundary must not be silently weakened).

  #41 therefore exposes the catalog to an admin **read-only** (so the epic's "view all
  settings" holds) and does **not** add a mutation path for it. Making the catalog
  admin-editable would silently weaken the COGS wall the free-tier hard-cap enforces — the
  exact failure `catalog.rs` guards against. (Numbers still change the way they always have:
  a versioned code edit. Per-account *overrides* already exist via #38.)

## Non-negotiables (lifted as PLAN invariants)

- **INV-1 (COGS boundary — verbatim, catalog.rs):** the plan SET and its allowance POLICY
  (hard-cap vs overage) is code-defined and versioned, auditable and **out of an operator's
  reach** (a COGS boundary must not be silently weakened). #41 exposes the catalog to an
  admin **read-only** and adds NO endpoint that mutates a catalog allowance or policy.

- **INV-2 (operational tunables are admin-configurable, read-at-use):** the overage
  projection rates, webhook event-retention window, and webhook signature tolerance become
  admin read/write via the `billing_settings` singleton, **read at the moment of use** (each
  consumer re-reads the row) with a safe fallback to the compiled default on a DB error so
  the hot path never breaks, bounds-validated on write. A change persists across restart
  (it lives in the row, not the process).

- **INV-3 (reuse existing authz; introduce NO new permission):** the settings read/write and
  the catalog read reuse the **existing** `billing::manage` permission (the gate already on
  `billing_settings`). No new permission is minted here — the admin UI cards and their
  restricted-user (A10) frontend proof belong to a later FE issue. A caller lacking
  `billing::manage` (and not `is_admin`) is refused with a 403 on every one of these routes.

- **INV-4 (audit trail on mutation):** every write to `billing_settings` records who made it
  — an `updated_by` column stamped from the acting admin's authenticated user id (the
  established per-table `*_by` audit idiom; no central audit-log service exists).

## Deliberately deferred (documented remainder, NOT this item)

The per-module settings gaps in `account/user/workstore/project/dataset/mcp/extensions/rootfs`
(e.g. workstore GC + ingest/body caps, sandbox per-class resource defaults, rootfs cache
retention, mcp session/pairing caps) each need either a new settings table or a new
per-module `settings::{read,manage}` permission. A new user-facing permission obligates a
frontend restricted-user (A10) proof, which #41 explicitly defers to a later FE issue.
Batching them here would sprawl this item and force frontend work out of scope. They are
inventoried in `PLAN.md` and left as a follow-up.

## saas-gating

The whole `billing` module is `#[cfg(feature = "saas")]` (`modules/mod.rs:19`). All settings
handlers, the catalog read endpoint, and the read-at-use call sites are therefore saas-only
and never compile into a desktop/OSS build. The migration adds columns to `billing_settings`
in both builds (a migration cannot be cfg-gated) — desktop simply never reads them.
