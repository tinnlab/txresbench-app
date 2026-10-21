-- billing_credits — #39 (billing epic Tier-2) — the admin-granted OVERRIDE layer the
-- `check_quota` verdict engine consults BEFORE the plan-derived verdict: an append-only
-- credit ledger + a per-account comp/premium override.
--
-- Model (DECISIONS DEC-1): credits are integer CENTS of overage-admission budget (the same
-- currency the spend-cap projection uses), so a grant raises a paid account's effective cap and
-- gives a free (hard-capped) account an overage budget; `premium` comps an account to unlimited
-- allowance. They affect the ADMISSION verdict only — never the Stripe invoice (DEC-2), keeping
-- B4's reader-only boundary intact (the engine only SELECTs these tables).
--
-- Like B1/B2/B4's billing tables, the migration tree is scanned by build.rs regardless of the
-- `saas` build capability, so BOTH tables exist in BOTH builds (empty + inert on desktop, where
-- no quota check ever runs; INV-6 gates the MODULE code, not the schema). Keyed on account_id
-- (INV-4 of B4), FK `accounts.id` ON DELETE CASCADE — a deleted account takes its grants +
-- override with it.
--
-- Prefix 202608280010: above the current server migration max (202608260007 = B4's
-- billing_quota; 202608260006 is B3's billing_settings) and distinct from the only other
-- 20260828 migration (workstore's 202608280001), so it sorts last and cannot collide
-- (BASE.md ordering constraint).

-- == the append-only credit ledger (#39, DEC-1/DEC-6) ==========================
-- One row per admin grant. NEVER hard-deleted or amount-mutated: a revoke stamps `revoked_at`
-- (+ `revoked_by`) as a marker so the audit trail (who/what/when/why) survives (INV-4). The
-- effective balance the engine reads = SUM(amount_cents) over rows that are NOT revoked and NOT
-- expired. `amount_cents > 0` (DEC-7) so the SUM of non-negative grants can never underflow.
CREATE TABLE credit_grants (
    -- surrogate id (app never relies on insertion order; the ledger sorts by created_at).
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    -- the tenant this credit belongs to (INV-4). FK cascade: grants die with the account.
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- the grant amount, in integer CENTS of overage-admission budget (DEC-1). Strictly positive
    -- (DEC-7 underflow guard) — a zero/negative grant is a footgun the request-validate + this
    -- CHECK both refuse.
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    -- the admin's human reason for the comp (audit, INV-4). Required + non-empty: the handler
    -- validates it, and this CHECK backs it so no non-handler insert can land a blank-reason row
    -- that would undermine the ledger's auditability (defense-in-depth).
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    -- the admin (user id) who granted it (audit, INV-4). A plain audit column, no cross-module FK
    -- (the credit ledger does not own the users table; the id comes from the authenticated admin).
    granted_by uuid NOT NULL,
    -- when the grant stops counting toward the balance; NULL = never expires (DEC-1).
    expires_at timestamptz,
    -- the revoke marker: NULL = active; non-NULL = revoked at this instant (append-only, DEC-6).
    revoked_at timestamptz,
    -- the admin (user id) who revoked it (audit); NULL until revoked.
    revoked_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The balance read + ledger list both filter/sort by account; index it.
CREATE INDEX idx_credit_grants_account ON credit_grants (account_id, created_at DESC);

-- == the per-account comp / premium override (#39, DEC-1) ======================
-- A singleton per account (like account_spend_cap). `premium = true` comps the account to
-- UNLIMITED plan allowance — an over-allowance ask is Allowed outright (INV-3), independent of
-- plan_id and BEFORE the credit math. Does NOT bypass suspension (DEC-4). Absent a row (or
-- premium = false) the override is inert and the plan-derived verdict stands (INV-5).
CREATE TABLE account_quota_override (
    -- the tenant (INV-4). PK + FK cascade: one override row per account.
    account_id uuid NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    -- the comp/premium flag (unlimited allowance) an admin sets (DEC-1).
    premium boolean NOT NULL DEFAULT false,
    -- the admin's reason for the comp (audit); NULL when never set with one.
    reason text,
    -- the admin (user id) who last set it (audit); NULL until set.
    set_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
);
