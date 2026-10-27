-- account module — the ADMIN-SET suspension flag (#37, Admin Console
-- epic) — SQLite dialect port (ITEM-10, sqlite-store) of
-- `src/modules/account/migrations/202608280011_account_admin_suspend.sql`.
--
-- Today "suspended" is purely DERIVED from `subscription_status`
-- (`dunning::is_suspended` — canceled/unpaid/incomplete_expired); there is
-- NO admin-set "disable this account" control. This adds a SECOND,
-- independent suspension source an admin toggles directly (abuse / an
-- operator hold / non-Stripe non-payment), OR-ed with the derived billing
-- suspension by `check_quota`
-- (`suspended = is_suspended(subscription_status) OR admin_suspended`,
-- DEC-3). NOT saas-gated: the column exists in BOTH builds with its safe
-- default (`false`); a desktop build carries it inert. No permission grant
-- is needed — `admin::accounts` is held by administrators via `*`.
--
-- SQLite port notes (ITEM-10, DEC-8): boolean -> INTEGER 0/1 (`admin_suspended
-- INTEGER NOT NULL DEFAULT 0`), `timestamptz` -> TEXT RFC3339 UTC (the two
-- audit columns are nullable text with no default, exactly the Postgres
-- shape), uuid -> BLOB (the audit actor `admin_suspended_by`), `text` ->
-- TEXT. One `ADD COLUMN` per column (the ITEM-8 convention — SQLite has no
-- multi-column ADD; the Postgres single-ALTER form becomes four).
--
-- Prefix 202608280011: one above the current server migration max
-- (202608280010 = #39 billing_credits), so it sorts last and cannot collide
-- (BASE.md ordering constraint; `… | cut -d_ -f1 | sort | uniq -d` stays
-- empty).

ALTER TABLE accounts ADD COLUMN admin_suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN admin_suspended_at TEXT;
ALTER TABLE accounts ADD COLUMN admin_suspended_by BLOB;
ALTER TABLE accounts ADD COLUMN admin_suspend_reason TEXT;
