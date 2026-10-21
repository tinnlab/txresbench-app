-- #41 (admin-settings-coverage) — promote the hardcoded billing operational knobs onto the
-- existing `billing_settings` singleton so an admin can VIEW + CHANGE them without a code
-- release. These were bare `const`s with no admin surface:
--   overage_cents_per_core_hour  ← quota.rs   OVERAGE_CENTS_PER_CORE_HOUR   (10.0)
--   overage_cents_per_gb_month   ← quota.rs   OVERAGE_CENTS_PER_GB_MONTH    (5.0)
--   webhook_event_retention_days ← rollup.rs  WEBHOOK_EVENT_RETENTION_DAYS  (90)
--   webhook_signature_tolerance_secs ← webhook.rs SIGNATURE_TOLERANCE_SECS (300)
-- Plus `updated_by` — the audit column stamped from the acting admin on every PUT (#41 INV-4;
-- the established `*_by` audit idiom, e.g. accounts.admin_suspended_by).
--
-- Defaults EXACTLY equal the compiled constants so a deployment that never PUTs is
-- byte-identical to today (read-at-use falls back to the same numbers on any DB error).
-- Bounds are enforced twice — a DB CHECK here AND the Rust `validate()` (a typed 422 before
-- the write) — mirroring the existing `billing_settings_grace_bounds` idiom.
--
-- As with 202608260006 this is a plain .sql applied in BOTH builds (a migration cannot be
-- cfg-gated); only the billing ROUTE/handler + read-at-use code is `#[cfg(feature="saas")]`,
-- so a desktop build simply never reads these columns.

ALTER TABLE public.billing_settings
    ADD COLUMN IF NOT EXISTS overage_cents_per_core_hour      double precision NOT NULL DEFAULT 10.0,
    ADD COLUMN IF NOT EXISTS overage_cents_per_gb_month       double precision NOT NULL DEFAULT 5.0,
    ADD COLUMN IF NOT EXISTS webhook_event_retention_days     bigint           NOT NULL DEFAULT 90,
    ADD COLUMN IF NOT EXISTS webhook_signature_tolerance_secs bigint           NOT NULL DEFAULT 300,
    ADD COLUMN IF NOT EXISTS updated_by                       uuid;

ALTER TABLE public.billing_settings
    -- overage rate must be STRICTLY POSITIVE: a rate of 0 would zero the spend-cap
    -- projection and silently disable a paid account's bill-shock guard (FIX_ROUND-1).
    DROP CONSTRAINT IF EXISTS billing_settings_overage_core_bounds,
    ADD  CONSTRAINT billing_settings_overage_core_bounds
         CHECK (overage_cents_per_core_hour > 0.0 AND overage_cents_per_core_hour <= 1000000.0),
    DROP CONSTRAINT IF EXISTS billing_settings_overage_gb_bounds,
    ADD  CONSTRAINT billing_settings_overage_gb_bounds
         CHECK (overage_cents_per_gb_month > 0.0 AND overage_cents_per_gb_month <= 1000000.0),
    DROP CONSTRAINT IF EXISTS billing_settings_retention_bounds,
    ADD  CONSTRAINT billing_settings_retention_bounds
         CHECK (webhook_event_retention_days BETWEEN 1 AND 3650),
    -- tolerance capped at 900 s (well above Stripe's 300 s default, well below a wide replay
    -- window; replay is additionally deduped by billing_webhook_events) — FIX_ROUND-1.
    DROP CONSTRAINT IF EXISTS billing_settings_tolerance_bounds,
    ADD  CONSTRAINT billing_settings_tolerance_bounds
         CHECK (webhook_signature_tolerance_secs BETWEEN 30 AND 900);
