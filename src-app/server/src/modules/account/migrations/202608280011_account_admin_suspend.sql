-- account module — the ADMIN-SET suspension flag (#37, Admin Console epic).
--
-- Today "suspended" is purely DERIVED from `subscription_status`
-- (`dunning::is_suspended` — canceled/unpaid/incomplete_expired); there is NO
-- admin-set "disable this account" control. This adds a SECOND, independent
-- suspension source an admin toggles directly (abuse / an operator hold / non-Stripe
-- non-payment), OR-ed with the derived billing suspension by `check_quota`
-- (`suspended = is_suspended(subscription_status) OR admin_suspended`, DEC-3).
--
-- NOT saas-gated: the `accounts` table rides desktop and the migration tree is
-- scanned by build.rs regardless of the `saas` cargo feature, so the column exists
-- in BOTH builds with its safe default (`false`). The admin MUTATION route is
-- admin-gated (`admin::accounts`, in the non-saas `admin` module); a desktop build
-- carries the column inert (no quota check ever runs there). No permission grant is
-- needed — `admin::accounts` is held by administrators via `*`/`is_admin` (DEC-8).
--
-- Prefix 202608280011: one above the current server migration max
-- (202608280010 = #39 billing_credits), so it sorts last and cannot collide
-- (BASE.md ordering constraint; `… | cut -d_ -f1 | sort | uniq -d` stays empty).

ALTER TABLE public.accounts
    -- the admin-set suspension flag (DEC-1). `false` by default → every existing
    -- account is unaffected until an admin explicitly suspends it.
    ADD COLUMN admin_suspended boolean NOT NULL DEFAULT false,
    -- audit: when the current admin-suspension was applied (NULL when not suspended).
    ADD COLUMN admin_suspended_at timestamptz,
    -- audit: the admin (user id) who applied it (NULL when not suspended). A plain
    -- audit column, no cross-module FK (the accounts table does not own the users
    -- table; the id comes from the authenticated admin), mirroring credit_grants.granted_by.
    ADD COLUMN admin_suspended_by uuid,
    -- audit: the admin's optional human reason for the hold (NULL when not suspended
    -- or none given). Cleared on reactivate (DEC-17).
    ADD COLUMN admin_suspend_reason text;
