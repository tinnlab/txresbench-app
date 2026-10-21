-- billing module — the ADMIN PLAN-OVERRIDE marker (#38, Admin Console epic).
--
-- Today `accounts.plan_id` is written ONLY by the Stripe webhook path
-- (`process_webhook` → `apply_transition`); an admin cannot comp an account onto a
-- paid tier without a real Stripe subscription, and any direct write would be
-- clobbered by the next `customer.subscription.updated` webhook. This adds a
-- manual-override MARKER so an admin `PUT …/plan` write SURVIVES later webhooks
-- until explicitly cleared (DEC-6/DEC-7 — the reconciliation crux).
--
-- Reconciliation policy (DEC-6): while `plan_manually_set = true`, the webhook state
-- machine STILL updates `subscription_status`/`grace_until` (the Stripe lifecycle is
-- still tracked — a real cancel still derives a billing suspension via `is_suspended`)
-- but does NOT overwrite `plan_id`. `apply_transition` reads this marker inside its
-- existing `SELECT … FOR UPDATE` row lock (zero extra query, zero race). `DELETE …/plan`
-- clears the marker and hands plan control back to Stripe.
--
-- BILLING-owned ALTER, mirroring 202608260003_billing_accounts_columns (the billing
-- epic owns the `accounts` billing-state columns). Like those, the COLUMNS exist in
-- BOTH builds (the migration tree is scanned regardless of the `saas` feature) with a
-- safe default (`plan_manually_set=false` → every existing account is byte-inert; a
-- desktop build carries the columns and never runs a webhook). Only the plan-override
-- ROUTE (billing/admin.rs) is `#[cfg(feature = "saas")]`.
--
-- Prefix 202608280012: above 202608280011 (the #37 account_admin_suspend) so it sorts
-- last and cannot collide (BASE.md; `… | cut -d_ -f1 | sort | uniq -d` stays empty).

ALTER TABLE public.accounts
    -- the manual-override marker (DEC-2). `false` by default → `apply_transition`'s
    -- plan-write path is byte-identical for every existing account.
    ADD COLUMN plan_manually_set boolean NOT NULL DEFAULT false,
    -- audit: when the current override was applied (NULL when not overridden).
    ADD COLUMN plan_override_at timestamptz,
    -- audit: the admin (user id) who applied it (NULL when not overridden). Plain audit
    -- column, no cross-module FK (mirrors credit_grants.granted_by).
    ADD COLUMN plan_override_by uuid;
