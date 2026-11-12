# Admin credits / comp / premium ledger + allowance override (B-Credits)

Design note for GitHub issue **#39** (TxResBench Admin Console epic, Tier-2). Extends the
verdict engine of `docs/design/metering-billing-quota.md` §4.2/§4.3 (the `check_quota`
admission gate) with an **admin-granted override layer** that sits ABOVE the plan-derived
verdict. Net-new concept: the existing billing epic has NO notion of per-account credits or a
comp/premium override — allowance derives ONLY from `catalog::allowance_of(plan_id)`.

## Problem

An operator needs to be able to "give an account credits / premium if the admin wants" —
i.e. let a specific account keep running past its plan quota (a free-tier account a partner
should get for free; a paid account whose overage the operator is comping) WITHOUT editing the
code-defined plan catalog (a COGS boundary that must stay out of an operator's reach, §4.1) and
WITHOUT flipping the account's `plan_id` (which would change its Stripe subscription).

## Model (the chosen one — see DECISIONS DEC-1)

Two independent, admin-controlled mechanisms, both consulted by `check_quota` BEFORE it returns
the plan-derived verdict:

1. **A credit ledger (`credit_grants`)** — an append-only ledger of positive grants denominated
   in **integer cents of overage-admission budget**. The account's **effective credit balance**
   = the SUM of every grant that is NOT revoked and NOT expired. The engine treats the balance as
   an overage budget: when an ask would go over the plan allowance, the projected overage COST (in
   cents — the same `projected_overage_cost_cents` projection the spend-cap path already uses)
   is compared against the available budget. A grant is never hard-deleted; a revoke stamps
   `revoked_at` (a marker row-update, the append-only auditable record survives).

2. **A per-account override (`account_quota_override`)** — a singleton `premium boolean` an admin
   flips to comp an account to **unlimited** plan allowance. When `premium` is set, an
   over-allowance ask is **Allowed** outright (no credit math). One row per account (like
   `account_spend_cap`).

**Credits are in CENTS, not allowance units.** Cents compose directly with the existing spend-cap
(cents) path — a grant raises the effective cap — and one grant can cover mixed compute+storage
overage because both resources project to cents. Credits/premium affect the **ADMISSION VERDICT
only** (they stop the account being quota-BLOCKED); they do NOT alter the Stripe invoice — the
engine owns admission, Stripe owns pricing (§3.1/§4.1), exactly as `check_quota` already documents.

## Engine composition (the byte-preserving extension of §4.2 `decide`)

`decide` gains two inputs — `premium: bool`, `credit_balance_cents: i64` — consulted only on the
**over-allowance** branch, so the under-allowance / suspended paths are untouched:

1. `suspended` → `BlockOverQuota` (FIRST, unchanged). **Premium does NOT bypass suspension** — a
   payment-failure terminal state is a separate concern; an admin comps quota, not a delinquent
   subscription (DEC-4).
2. `used + ask ≤ allowance` → `Allow` (unchanged).
3. over allowance + `premium` → `Allow` (the comp override).
4. over allowance + `hard_cap` (Free): projected overage cost ≤ `credit_balance_cents` → `Allow`
   (credits comp the free-tier usage); else → `BlockOverQuota` (unchanged when balance = 0, since
   any positive over-allowance ask projects a cost > 0).
5. over allowance + `overage` (Paid): the effective cap becomes `spend_cap + credit_balance_cents`
   — projected cost > `cap + balance` → `BlockOverQuota`; else → `AllowMeteredOverage`. With no
   cap set, credits are irrelevant (already metering). Unchanged when balance = 0.
6. over allowance + neither policy → `BlockOverQuota` (fail closed, unchanged).

**Regression guarantee:** with `premium = false` AND `credit_balance_cents = 0` (the default for
every account with no grant/override), every branch reduces to the pre-existing `decide`, so the
free-hard-block / paid-meter / paid-cap-block / suspended paths are byte-for-byte preserved.

## Invariants (lifted for the lifecycle)

- **INV-1** — An admin credit grant CHANGES a subsequent `check_quota` verdict for that account: a
  free-tier or paid-cap `BlockOverQuota` becomes `Allow`/`AllowMeteredOverage` once a sufficient
  grant exists; with NO grant the SAME ask still Blocks (the negative control).
- **INV-2** — A revoked grant, and an expired grant, do NOT count toward the balance — the verdict
  reverts to the plan-derived one.
- **INV-3** — A `premium` comp override → the account is NOT quota-blocked on an over-allowance ask
  (returns Allow), independent of `plan_id`.
- **INV-4** — The ledger is append-only + auditable: every grant records `granted_by`, `reason`,
  `created_at`; a revoke stamps `revoked_at`/`revoked_by` and NEVER hard-deletes the row.
- **INV-5** — Existing quota behavior is UNCHANGED when no grant/override exists (the free / paid /
  spend-cap / suspended paths still return their §4.2 verdicts).
- **INV-6** — Every credit/premium admin route is gated on `is_admin || billing::admin` (via the
  `AdminBillingScope` extractor); a non-admin gets 401/403. The whole surface is `saas`-gated and
  compiled OUT of the desktop/default binary.
- **INV-7** — A grant applies EXACTLY ONCE per its amount: the balance is the sum of distinct grant
  rows; a check consuming budget does not decrement or double-count (the engine is a pure reader —
  it never writes the ledger), and the balance can never underflow (grants are CHECK > 0; the SUM
  of non-negative grants is ≥ 0).
