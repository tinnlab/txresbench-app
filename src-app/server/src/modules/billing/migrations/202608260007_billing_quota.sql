-- billing_quota — B4 (billing epic) — the two quota-owned tables: the opt-in
-- per-account spend cap (ITEM-2) and the fire-once usage-alert dedupe state (ITEM-4).
--
-- B4 is a downstream READER of the metering signal (BQ-INV-2 / INV-5): `check_quota`
-- reads B1's `usage_rollup` current-period row + B2's code-defined plan catalog and
-- writes NOTHING (side-effect-free, DEC-7). The ONLY rows B4 ever writes live in these
-- two tables, and only ITEM-2 (the cap PUT) / ITEM-4 (the alert loop) write them — never
-- the check itself.
--
-- INV-4 (keyed on account_id, never user_id, BQ-INV-3): both tables FK the tenant as
-- `accounts.id`. FK `ON DELETE CASCADE`: these are DERIVED per-account artifacts — when
-- the account is deleted its cap + alert state go with it (A5 resource-lifecycle). Like
-- B1/B2's billing tables the migration tree is scanned by build.rs regardless of the
-- `saas` build capability, so these tables exist in BOTH builds (empty + inert on desktop,
-- where no quota check or alert loop ever runs; INV-5 gates the MODULE code, not the schema).
--
-- Prefix 202608260007: above the current server migration max (202608260006 = B3's
-- billing_settings), so it sorts after `accounts` + B1's `usage_rollup` + B2/B3 — every
-- table these FK / read already exists when this applies. (BASE.md ordering constraint.)

-- == the opt-in per-account spend cap (§4.3, ITEM-2) ============================
-- A paid account meters overage FREELY until the customer opts into a cap; then the
-- projected overage cost is compared against it and `check_quota` flips to BlockOverQuota
-- (INV-2, the customer's own bill-shock guard). NULL `overage_cap_cents` = no cap set
-- (the opt-in default) — absent a row (or a NULL) paid tiers never hard-block on usage.
CREATE TABLE account_spend_cap (
    -- the tenant (INV-4). PK + FK: one cap row per account, cascaded on delete.
    account_id uuid NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    -- the opt-in cap on billable OVERAGE, in integer cents. NULL = no cap (§4.3 default).
    -- CHECK: a negative cap is a footgun (the handler bounds-validates ≥ 0; this backs it).
    overage_cap_cents bigint CHECK (overage_cap_cents IS NULL OR overage_cap_cents >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- == the fire-once usage-alert dedupe state (§4.3 ladder, ITEM-4) ===============
-- The alert loop records the HIGHEST ladder rung fired per (account, period, resource) so
-- each of {50, 80, 95, 100}% fires EXACTLY ONCE per period per resource — the "warn early
-- + a firm boundary" pattern (§4.3, Dodo/Kinde). `level_notified` advances MONOTONICALLY
-- (an upsert with a `level_notified < $rung` guard), so a re-run over the same usage emits
-- nothing; a new `period_start` key starts at level 0 (implicit new-period reset).
CREATE TABLE usage_alert_state (
    -- the tenant (INV-4).
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- the billing period this ladder state belongs to (the same window B1's rollup keys on).
    period_start timestamptz NOT NULL,
    -- the resource whose usage crossed a rung ('compute' | 'storage').
    resource text NOT NULL,
    -- the highest ladder percentage already notified (0 = none yet; then 50/80/95/100).
    level_notified smallint NOT NULL DEFAULT 0,
    notified_at timestamptz NOT NULL DEFAULT now(),
    -- one ladder-state row per (account, period, resource) — the fire-once dedupe key.
    CONSTRAINT pk_usage_alert_state PRIMARY KEY (account_id, period_start, resource)
);
