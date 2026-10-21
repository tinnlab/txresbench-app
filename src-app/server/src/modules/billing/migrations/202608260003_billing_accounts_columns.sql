-- billing module (B2) — the account↔Stripe billing-state columns (design §3.5).
--
-- BILLING-OWNED ALTER (DEC-8 / GRAPH cross-epic): the `stripe_customer_id` link +
-- the billing-state columns B3 (webhooks) writes are added HERE, by the billing
-- epic, sequenced AFTER the accounts baseline (202608040012_account_baseline.sql).
-- PROV-accounts-1 explicitly names this ALTER as billing-owned, so this is NOT an
-- accounts-epic deliverable.
--
-- Ordering: prefix 202608260001 sorts ABOVE every server migration in use
-- (highest was 202608240003), so `accounts` already exists when this applies.
--
-- INV-5 (billing surfaces compile out of desktop, the MODEL does not): these
-- COLUMNS exist in BOTH the saas and the desktop/default build — the migration
-- tree is scanned by build.rs regardless of the `saas` cargo feature, so a desktop
-- deployment carries the columns with their safe defaults (`plan_id='free'`,
-- `subscription_status='active'`) and simply never creates a Stripe Customer. Only
-- the billing MODULE code (routes / Stripe client) is `#[cfg(feature = "saas")]`.

-- == the account↔Stripe billing-state columns (§3.5) =====================
--
-- `stripe_customer_id` — the 1:1 account↔Customer link (BQ-INV-9). UNIQUE, so the
--   reverse `account_by_customer(customer_id)` lookup B3's webhook path needs is
--   exact, and a concurrent double-checkout cannot store two different ids for one
--   account. NULL until the account's first checkout creates a Customer.
-- `plan_id`             — the account's current plan (PROV-B2-2 catalog key B4 reads).
--   `'free'` by default; flipped by B3's `checkout.session.completed` webhook, never
--   by the checkout endpoint (INV-2).
-- `subscription_status` — the Stripe subscription lifecycle state B3 writes on
--   subscription/invoice webhooks (`active` / `past_due` / `canceled` / …).
-- `grace_until`         — the dunning grace deadline B3 sets on `invoice.payment_failed`.
ALTER TABLE public.accounts
    ADD COLUMN stripe_customer_id text,
    ADD COLUMN plan_id text NOT NULL DEFAULT 'free',
    ADD COLUMN subscription_status text NOT NULL DEFAULT 'active',
    ADD COLUMN grace_until timestamptz;

-- The 1:1 link + the exact reverse lookup (BQ-INV-9). Partial so the many NULLs
-- (free accounts that never checked out) are unconstrained; the one-customer-per-
-- account uniqueness is enforced by the DATABASE, not just the CAS in the writer.
CREATE UNIQUE INDEX uq_accounts_stripe_customer_id
    ON public.accounts (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

-- == permission grant ====================================================
--
-- Grant `billing::read` + `billing::manage` to the default Users group (mirrors the
-- accounts baseline's `account::read` grant). A user acts within an account context
-- (the `X-Account-Id` ActiveAccount extractor), so a member of an account holds the
-- capability; account-scope (cross-account → 404) is enforced separately by the
-- extractor, not by RBAC. Administrators already hold both via the `*` wildcard.
-- Idempotent. The grant is unconditional (harmless on desktop, where no billing
-- route exists to exercise it).
UPDATE public.groups
SET permissions = array_append(permissions, 'billing::read')
WHERE name = 'Users'
  AND NOT ('billing::read' = ANY (permissions));

UPDATE public.groups
SET permissions = array_append(permissions, 'billing::manage')
WHERE name = 'Users'
  AND NOT ('billing::manage' = ANY (permissions));
