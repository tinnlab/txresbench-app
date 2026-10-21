//! The quota-decision layer (B4 — **PROV-B4-1** + the `limits_of` half of PROV-B4-2).
//!
//! `check_quota` is the pure, side-effect-free pre-check the **compute-T6 enforcement
//! hooks call** at `create_job` / workstore-ingest (the billing→compute REVERSE seam of
//! the epic — every other billing edge points INTO billing; here compute depends on
//! billing). It turns a plan (PROV-B2-2) + an account's running usage (PROV-B1-1) into a
//! three-arm `QuotaVerdict` (design §4.2/§4.3):
//!
//!  - **Free** tiers are `hard_cap` → over the allowance ⇒ `BlockOverQuota` (INV-1, the
//!    §1.4 COGS wall).
//!  - **Paid** tiers `overage` → over the allowance ⇒ `AllowMeteredOverage` (usage
//!    proceeds, metered via PROV-B2-3) UNTIL an OPT-IN per-account spend cap is set and
//!    the projected overage cost exceeds it, at which point it flips to `BlockOverQuota`
//!    (INV-2, the customer's own bill-shock guard).
//!  - A **suspended** account (B3's terminal billing-state, PROV-B3-1) is refused OUTRIGHT
//!    before any usage math — new consumption is gated the moment retries are exhausted
//!    (design §5; `is_suspended`).
//!
//! Reader-only (DEC-7 / BQ-INV-2): it reads `accounts` (plan_id + subscription_status),
//! B1's `usage_rollup` current-period row (NOT the raw `compute_meter`/`storage_meter` —
//! that is B1's boundary, DEC-8), and B4's `account_spend_cap`. It WRITES NOTHING, so
//! compute-T6 may call it at every admission with no ordering hazard (TEST-10 pins it).
//!
//! The decision is factored into a PURE core [`decide`] over an explicit [`QuotaInputs`]
//! matrix (no DB, no clock) so the verdict contract compute-T6 binds is unit-testable as a
//! truth table (TEST-8) — the reverse-seam acceptance test.
//!
//! `#[cfg(feature = "saas")]` (INV-5): the whole module compiles out of desktop with the
//! rest of `billing` — a desktop build never checks a quota (the T6 call sites are also
//! `saas`-gated, so both vanish together).

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use super::catalog;
use super::dunning::is_suspended;
use super::rollup::SECONDS_PER_HOUR;

/// Bytes per billed GB — decimal (10⁹), the cloud-billing convention (mirrors
/// `rollup::BYTES_PER_GB`), used to project a storage ask's `add_bytes` into the
/// GB-months unit `usage_rollup` holds.
pub const BYTES_PER_GB: f64 = 1_000_000_000.0;

/// The v1 per-unit OVERAGE prices B4 uses ONLY to project a paid account's projected
/// overage cost against its opt-in spend cap (ITEM-2). These are a coarse local stand-in
/// for the authoritative Stripe metered `Price` (the real billing arithmetic is Stripe's,
/// §3.1/§4.1) — B4 owns the ADMISSION verdict, Stripe owns the pricing. They are NOT plan
/// ALLOWANCE numbers (which stay plan-derived from B2's catalog, INV-3); they are a
/// cap-projection knob. A later increment can source the exact unit price from the plan's
/// Stripe metered price without changing the decision shape.
pub const OVERAGE_CENTS_PER_CORE_HOUR: f64 = 10.0;
/// Per-GB-month overage price (cents) for the spend-cap projection (see above).
pub const OVERAGE_CENTS_PER_GB_MONTH: f64 = 5.0;

/// Pure fallback: the `(core_hour, gb_month)` overage rates from the settings row if present,
/// else the compiled defaults. #41 ITEM-4 — factored out so the read-at-use fallback is
/// unit-testable without a DB (TEST-9).
fn resolve_overage_rates(from_row: Option<(f64, f64)>) -> (f64, f64) {
    from_row.unwrap_or((OVERAGE_CENTS_PER_CORE_HOUR, OVERAGE_CENTS_PER_GB_MONTH))
}

/// The overage projection rates B4 uses for the spend-cap projection, read AT USE from the
/// `billing_settings` singleton (#41 INV-2 — admin-configurable, not a compiled const),
/// falling back to the compiled defaults on ANY DB error so the admission hot path never
/// breaks (mirrors `job_settings::caps` fallback-on-error).
pub async fn effective_overage_rates(pool: &PgPool) -> (f64, f64) {
    let from_row = match super::repository::get_billing_settings(pool).await {
        Ok(s) => Some((s.overage_cents_per_core_hour, s.overage_cents_per_gb_month)),
        Err(e) => {
            tracing::warn!(error = ?e, "billing_settings read failed; using default overage rates");
            None
        }
    };
    resolve_overage_rates(from_row)
}

/// A pre-flight quota ASK — what a compute-T6 admission point wants to admit (design
/// §4.2 verbatim shape). `Compute` carries the estimated core-hours a job will burn;
/// `Storage` the bytes an ingest will add.
#[derive(Debug, Clone, PartialEq)]
pub enum QuotaAsk {
    /// A compute admission (a job about to run). `resource_class` mirrors the job's class
    /// (cpu / gpu — carried for the call-site's fidelity; the v1 decision compares the
    /// estimated cost against the single plan compute allowance regardless of class,
    /// since B2's catalog carries no separate gpu allowance).
    Compute {
        resource_class: String,
        est_core_hours: f64,
    },
    /// A storage admission (bytes about to be ingested).
    Storage { add_bytes: i64 },
}

/// The three-arm quota verdict compute-T6 switches on (design §4.2, DEC-2). The brief's
/// `Deny{reason}` maps to [`QuotaVerdict::BlockOverQuota`]; the third arm
/// [`QuotaVerdict::AllowMeteredOverage`] is the paid-overage path. **Do NOT collapse to a
/// binary Allow/Deny** — the admission point must distinguish "proceed free" from "proceed,
/// this meters as overage" from "refuse".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuotaVerdict {
    /// Under the allowance → proceed, no overage.
    Allow,
    /// Over the allowance on a PAID tier under any spend cap → proceed, but the excess
    /// meters as overage (reported via PROV-B2-3 by B1's report step).
    AllowMeteredOverage,
    /// Refuse: a free-tier hard-cap reached, a paid spend cap reached, a suspended account,
    /// or an unresolvable plan. `reason` is a short human/UX string (the §4.4 upgrade
    /// surface renders it).
    BlockOverQuota { reason: String },
}

/// The plan-derived resource limits `check_quota` reads — a projection of B2's catalog
/// (PROV-B2-2) into the SAME units `usage_rollup` holds (ITEM-3, part of PROV-B4-2). B4
/// defines NO allowance numbers of its own (INV-3): every number here comes from
/// `catalog::allowance_of`; the only transform is a UNIT projection (the catalog's
/// compute allowance is in compute-SECONDS, `usage_rollup` is in core-HOURS, so it is
/// divided by 3600).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuotaLimits {
    /// Compute allowance in CORE-HOURS (catalog compute-seconds ÷ 3600).
    pub compute_allowance: f64,
    /// Storage allowance in GB-MONTHS (catalog value, already in GB-months).
    pub storage_allowance: f64,
    /// SEAT allowance — the max number of members (#141). An `i64` COUNT, deliberately not
    /// an `f64` like the two above: a headcount is already in its own unit, so unlike
    /// `compute_allowance` (catalog compute-SECONDS ÷ 3600) it is projected UNCHANGED. It is
    /// carried here so the `GET /api/billing/quota` read surface renders "7 of 10 seats" from
    /// the same projection the enforcement reads; the enforcement itself lives in
    /// `account::seat` (it must run on the mutation's own transaction connection, which
    /// `check_quota`'s pooled shape cannot provide).
    pub member_allowance: i64,
    /// Paid tier meters overage beyond the allowance.
    pub overage: bool,
    /// Free tier hard-blocks at the allowance.
    pub hard_cap: bool,
}

/// The SEAT allowance the read surface reports for an account whose `plan_id` names no
/// catalog tier (#141 DEC-9): **zero**, never unlimited.
///
/// A shared const rather than a literal in `build_quota_state`, because a test has to be able
/// to read the value production actually uses. FIX_ROUND-4 "repaired" a broken assertion here
/// by declaring a local `const … = 0` and asserting it equalled 0 — a tautology a blind audit
/// disproved by changing the handler's literal to 9,999,999 and watching every lib test stay
/// green. The coherence being pinned is that the read surface promises no seats **and**
/// `billing::seat::decide_seat` grants none; a test that cannot see the first half pins
/// nothing (FIX_ROUND-5, R5-1).
pub const UNKNOWN_PLAN_MEMBER_ALLOWANCE: i64 = 0;

/// Project `plan(plan_id)` (PROV-B2-2) into the resource-keyed [`QuotaLimits`] `check_quota`
/// reads (ITEM-3 / INV-3). `None` when `plan_id` names no catalog tier. Pure — a thin
/// adapter with no storage and no numbers of its own; changing B2's catalog changes the
/// limits with no B4 edit (TEST-4).
pub fn limits_of(plan_id: &str) -> Option<QuotaLimits> {
    catalog::allowance_of(plan_id).map(|a| QuotaLimits {
        // catalog compute allowance is compute-SECONDS; usage_rollup is core-HOURS.
        compute_allowance: a.compute_allowance as f64 / SECONDS_PER_HOUR,
        storage_allowance: a.storage_allowance as f64,
        // NO transform — a seat count is already in its own unit (see the field doc).
        member_allowance: a.member_allowance,
        overage: a.overage,
        hard_cap: a.hard_cap,
    })
}

/// The projected billable OVERAGE cost, in integer cents, for `over_units` of a resource
/// beyond its allowance at `rate_cents_per_unit` (ITEM-2). `ceil` so a fractional cent
/// rounds toward the cap (the conservative, block-slightly-early direction). Clamped ≥ 0
/// (an under-allowance ask projects 0 overage cost). Pure.
pub fn projected_overage_cost_cents(over_units: f64, rate_cents_per_unit: f64) -> i64 {
    if over_units <= 0.0 || rate_cents_per_unit <= 0.0 {
        return 0;
    }
    (over_units * rate_cents_per_unit).ceil() as i64
}

/// The explicit decision matrix [`decide`] switches on — every input the verdict depends
/// on, so the pure core is a truth table with no hidden reads (TEST-8).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuotaInputs {
    /// The resource's plan allowance (same unit as `used`/`ask_amount`).
    pub allowance: f64,
    /// The account's current usage of the resource (from `usage_rollup`).
    pub used: f64,
    /// The ask's marginal amount in the resource's unit.
    pub ask_amount: f64,
    /// Plan meters overage beyond the allowance (paid).
    pub overage: bool,
    /// Plan hard-blocks at the allowance (free).
    pub hard_cap: bool,
    /// Per-unit overage price for the spend-cap projection (cents).
    pub overage_rate_cents_per_unit: f64,
    /// The account's opt-in spend cap (cents); `None` = no cap.
    pub spend_cap_cents: Option<i64>,
    /// The account is suspended — refuse outright. This is the EFFECTIVE suspension: the derived
    /// billing suspension OR the admin-set flag (#37, DEC-3). Checked FIRST (before premium/credits).
    pub suspended: bool,
    /// Whether the suspension is admin-set (#37) — used ONLY to pick the block REASON string
    /// (an operator hold vs a billing delinquency are worded differently; DEC-3 keeps them
    /// independent). Does not affect the verdict (`suspended` alone gates). `false` (the default)
    /// yields the original billing-worded reason — byte-preserved.
    pub admin_suspended: bool,
    /// The admin-set comp/premium override (#39): unlimited plan allowance. An over-allowance ask
    /// is Allowed outright when set (INV-3), BEFORE the credit math — but NOT when suspended
    /// (DEC-4). `false` (the default) leaves the plan-derived verdict unchanged (INV-5).
    pub premium: bool,
    /// The account's effective admin-granted credit balance in CENTS (#39): the sum of
    /// non-revoked, non-expired grants (INV-1/INV-7). An overage-admission budget — it raises a
    /// paid account's effective spend cap and gives a free (hard-capped) account an overage budget.
    /// `0` (the default) leaves the plan-derived verdict byte-for-byte unchanged (INV-5).
    pub credit_balance_cents: i64,
}

/// The PURE quota decision (design §4.2/§4.3). The contract compute-T6 binds — a truth
/// table over `(plan policy, used, ask, cap, suspended)`:
///
///  1. **suspended** → `BlockOverQuota` (new consumption gated, PROV-B3-1) — checked FIRST
///     (the admin comp/credit override does NOT bypass a delinquent subscription, DEC-4).
///  2. `used + ask ≤ allowance` → `Allow`.
///  3. over allowance + `premium` (#39) → `Allow` — the admin comp override, unlimited allowance
///     (INV-3), consulted BEFORE the credit math.
///  4. over allowance + `hard_cap` (Free): the admin credit balance is an overage budget — if the
///     projected overage cost ≤ `credit_balance_cents` → `Allow` (credits comp the usage, #39
///     INV-1); else → `BlockOverQuota` (INV-1 of B4). With `credit_balance_cents = 0` (the
///     default) any positive over-allowance ask projects a cost > 0, so this is the original
///     hard-block — byte-preserved.
///  5. over allowance + `overage` (Paid): the effective cap is `spend_cap + credit_balance_cents`
///     (#39 — credits raise the cap). If a cap is set AND the projected overage cost STRICTLY
///     EXCEEDS the effective cap → `BlockOverQuota` (INV-2); else → `AllowMeteredOverage`. With
///     `credit_balance_cents = 0` this is the original `cost > cap` comparison — byte-preserved.
///  6. over allowance + neither policy (a malformed plan) → `BlockOverQuota` (fail closed).
///
/// Boundary: the cap comparison is `projected_cost > effective_cap` — a cost exactly AT the cap is
/// still allowed (one cent over blocks). **Regression guarantee:** with `premium = false` AND
/// `credit_balance_cents = 0` (every account with no grant/override) this reduces EXACTLY to the
/// pre-#39 `decide` (INV-5). Side-effect-free.
pub fn decide(i: &QuotaInputs) -> QuotaVerdict {
    if i.suspended {
        // Word the refusal for the ACTUAL suspension source (#37, DEC-3): an admin/operator hold
        // is not a billing delinquency and paying nothing lifts it. `admin_suspended = false` (the
        // default, and every billing-derived suspension) keeps the original billing wording.
        let reason = if i.admin_suspended {
            "account suspended by an administrator; contact support to restore access".to_string()
        } else {
            "account suspended (billing); resolve the outstanding payment to resume".to_string()
        };
        return QuotaVerdict::BlockOverQuota { reason };
    }
    let projected = i.used + i.ask_amount;
    if projected <= i.allowance {
        return QuotaVerdict::Allow;
    }
    // Over the allowance. The admin comp/premium override (#39) lifts the block outright.
    if i.premium {
        return QuotaVerdict::Allow;
    }
    // The projected overage COST (cents) — the currency the admin credit balance is denominated in
    // (#39, DEC-1). Works for both the hard-cap (free) and overage (paid) branches.
    let over_units = projected - i.allowance;
    let cost = projected_overage_cost_cents(over_units, i.overage_rate_cents_per_unit);
    let credits = i.credit_balance_cents.max(0);
    if i.hard_cap {
        // Free: normally a hard block. The admin credit balance gives it an overage budget (#39);
        // credits ≥ the projected cost comp the usage → Allow. credits = 0 ⇒ cost > 0 ⇒ block
        // (the original §1.4 COGS wall, byte-preserved).
        if cost <= credits {
            return QuotaVerdict::Allow;
        }
        return QuotaVerdict::BlockOverQuota {
            reason: "free-tier allowance reached; upgrade to continue".to_string(),
        };
    }
    if i.overage {
        if let Some(cap) = i.spend_cap_cents {
            // #39: credits raise the effective cap. saturating_add so a huge grant can't overflow.
            let effective_cap = cap.saturating_add(credits);
            if cost > effective_cap {
                return QuotaVerdict::BlockOverQuota {
                    reason: "spend cap reached; raise or clear the cap to continue".to_string(),
                };
            }
        }
        return QuotaVerdict::AllowMeteredOverage;
    }
    // Over allowance with neither overage nor hard_cap (a malformed plan) → fail closed.
    QuotaVerdict::BlockOverQuota {
        reason: "over allowance with no overage policy".to_string(),
    }
}

/// **PROV-B4-1** — the pre-check compute-T6's admission hooks call. Reads the account's
/// plan + effective billing-state + current-period `usage_rollup` row + opt-in spend cap,
/// then returns the pure [`decide`] verdict for `ask`. Side-effect-free (DEC-7): it issues
/// only SELECTs. Errors only on a DB failure (never on "over quota" — that is a verdict,
/// not an error). An account whose `plan_id` names no catalog tier fails CLOSED
/// (`BlockOverQuota`).
///
/// **This signature is compute-T6's frozen contract** (SEAMS PROV-B4-1):
/// `check_quota(pool, account_id, QuotaAsk) -> QuotaVerdict` — pinned by the truth-table
/// contract test TEST-8 and the DB acceptance tests TEST-1/-2/-3/-6.
pub async fn check_quota(
    pool: &PgPool,
    account_id: Uuid,
    ask: QuotaAsk,
) -> Result<QuotaVerdict, AppError> {
    // 1. plan + effective billing-state (PROV-B2-2 key + PROV-B3-1 state).
    let Some((plan_id, subscription_status)) =
        super::repository::account_billing_context(pool, account_id).await?
    else {
        // No such account → fail closed (never admit for a phantom tenant).
        return Ok(QuotaVerdict::BlockOverQuota {
            reason: "no such account".to_string(),
        });
    };
    // The effective suspension is the DERIVED billing suspension OR the admin-set flag (#37,
    // DEC-3): two independent sources, OR-ed. `decide` refuses a `suspended` account FIRST —
    // before premium/credits (DEC-4) — so an admin-suspend blocks regardless of any comp. With
    // `admin_suspended = false` (every existing account) this is byte-identical to the derived
    // suspension alone (INV-6).
    let admin_suspended = super::repository::admin_suspended(pool, account_id).await?;
    let suspended = is_suspended(&subscription_status) || admin_suspended;
    let Some(limits) = limits_of(&plan_id) else {
        return Ok(QuotaVerdict::BlockOverQuota {
            reason: format!("unknown plan '{plan_id}'"),
        });
    };

    // 2. current-period usage (PROV-B1-1 rollup row; zero when none yet).
    let usage = super::repository::current_period_usage(pool, account_id).await?;
    // 3. opt-in spend cap (ITEM-2).
    let spend_cap_cents = super::repository::spend_cap(pool, account_id).await?;
    // 4. the admin-granted OVERRIDE layer (#39): the comp/premium flag + the effective credit
    //    balance. Both are pure SELECTs — `check_quota` stays a reader (BQ-INV-2). A default
    //    (not-premium, 0-balance) account leaves the verdict byte-unchanged (INV-5).
    let premium = super::repository::quota_override(pool, account_id).await?.premium;
    let credit_balance_cents = super::repository::credit_balance(pool, account_id).await?;
    // #41 (INV-2): the overage projection rates are read AT USE from billing_settings (an
    // admin-configurable knob), not the compiled const — with a safe fallback to the const.
    let (overage_rate_core, overage_rate_gb) = effective_overage_rates(pool).await;

    // 5. project the ask into the resource's unit + pick the resource's allowance/rate.
    let inputs = match &ask {
        QuotaAsk::Compute { est_core_hours, .. } => QuotaInputs {
            allowance: limits.compute_allowance,
            // Compute usage = CPU core-hours + GPU hours vs the single compute allowance.
            used: usage.compute_core_hours + usage.gpu_hours,
            ask_amount: est_core_hours.max(0.0),
            overage: limits.overage,
            hard_cap: limits.hard_cap,
            overage_rate_cents_per_unit: overage_rate_core,
            spend_cap_cents,
            suspended,
            admin_suspended,
            premium,
            credit_balance_cents,
        },
        QuotaAsk::Storage { add_bytes } => QuotaInputs {
            allowance: limits.storage_allowance,
            used: usage.storage_gb_months,
            // Conservative projection: treat the added bytes as held a full GB-month (an
            // over-estimate of the marginal period cost — the block-slightly-early
            // direction for an admission guard). Reads only the rollup, never re-sums the
            // raw storage_meter (DEC-8).
            ask_amount: (*add_bytes).max(0) as f64 / BYTES_PER_GB,
            overage: limits.overage,
            hard_cap: limits.hard_cap,
            overage_rate_cents_per_unit: overage_rate_gb,
            spend_cap_cents,
            suspended,
            admin_suspended,
            premium,
            credit_balance_cents,
        },
    };
    Ok(decide(&inputs))
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-9 [covers ITEM-4]: the read-at-use overage-rate fallback is pure and correct —
    // it returns the settings-row value when present and falls back to the compiled consts
    // when the row read failed (so the admission hot path never breaks on a DB fault).
    #[test]
    fn overage_rates_fallback() {
        assert_eq!(resolve_overage_rates(Some((7.0, 3.5))), (7.0, 3.5), "row value used");
        assert_eq!(
            resolve_overage_rates(None),
            (OVERAGE_CENTS_PER_CORE_HOUR, OVERAGE_CENTS_PER_GB_MONTH),
            "falls back to the compiled defaults on a failed row read"
        );
    }

    // TEST-8 [acceptance][INV-1, INV-2][pins PROV-B4-1]: the pure `check_quota` truth
    // table — the decision contract compute-T6 binds, with NO DB. Every arm of the §4.2
    // matrix: Free-under→Allow, Free-at→Block, Pro-under→Allow, Pro-over-no-cap→
    // AllowMeteredOverage, Pro-over-under-cap→AllowMeteredOverage, Pro-over-at-cap→
    // AllowMeteredOverage (at cap is allowed), Pro-over-over-cap→Block, suspended→Block.
    fn base() -> QuotaInputs {
        QuotaInputs {
            allowance: 1.0,
            used: 0.0,
            ask_amount: 0.0,
            overage: false,
            hard_cap: true, // free by default
            overage_rate_cents_per_unit: OVERAGE_CENTS_PER_CORE_HOUR,
            spend_cap_cents: None,
            suspended: false,
            admin_suspended: false,
            // #39: default = no admin override, no credit — the pre-#39 verdict is byte-preserved
            // (INV-5). Every existing arm test below inherits these via `..base()`/`..pro()`.
            premium: false,
            credit_balance_cents: 0,
        }
    }

    #[test]
    fn free_under_allowance_allows() {
        let i = QuotaInputs {
            used: 0.5,
            ask_amount: 0.4,
            ..base()
        };
        assert_eq!(decide(&i), QuotaVerdict::Allow);
    }

    #[test]
    fn free_at_or_over_allowance_hard_blocks() {
        // exactly at allowance with a positive ask that tips it over.
        let i = QuotaInputs {
            used: 1.0,
            ask_amount: 0.001,
            ..base()
        };
        assert!(matches!(decide(&i), QuotaVerdict::BlockOverQuota { .. }));
        // exactly landing ON the allowance is still allowed (≤).
        let on = QuotaInputs {
            used: 0.6,
            ask_amount: 0.4,
            ..base()
        };
        assert_eq!(decide(&on), QuotaVerdict::Allow);
    }

    fn pro() -> QuotaInputs {
        QuotaInputs {
            allowance: 100.0,
            overage: true,
            hard_cap: false,
            ..base()
        }
    }

    #[test]
    fn pro_under_allowance_allows() {
        let i = QuotaInputs {
            used: 50.0,
            ask_amount: 10.0,
            ..pro()
        };
        assert_eq!(decide(&i), QuotaVerdict::Allow);
    }

    #[test]
    fn pro_over_allowance_no_cap_meters_overage() {
        let i = QuotaInputs {
            used: 100.0,
            ask_amount: 5.0,
            spend_cap_cents: None,
            ..pro()
        };
        assert_eq!(decide(&i), QuotaVerdict::AllowMeteredOverage);
    }

    #[test]
    fn pro_over_allowance_under_and_at_cap_meters_at_over_cap_blocks() {
        // 5 core-hours over × 10 cents = 50 cents projected overage cost.
        let over = QuotaInputs {
            used: 100.0,
            ask_amount: 5.0,
            ..pro()
        };
        // cap ABOVE 50 → meter.
        assert_eq!(
            decide(&QuotaInputs {
                spend_cap_cents: Some(51),
                ..over
            }),
            QuotaVerdict::AllowMeteredOverage,
            "one cent under the cap → allow (boundary)"
        );
        // cap EXACTLY at 50 → still allowed (> comparison).
        assert_eq!(
            decide(&QuotaInputs {
                spend_cap_cents: Some(50),
                ..over
            }),
            QuotaVerdict::AllowMeteredOverage,
            "cost exactly at cap → allow"
        );
        // cap BELOW 50 → block (INV-2 the bill-shock wall).
        assert!(
            matches!(
                decide(&QuotaInputs {
                    spend_cap_cents: Some(49),
                    ..over
                }),
                QuotaVerdict::BlockOverQuota { .. }
            ),
            "projected overage cost exceeds the cap → block"
        );
    }

    // TEST-2 [covers: ITEM-2] (#141): `limits_of` projects `member_allowance` as an
    // IDENTITY — no unit transform. Contrasted in the same body with `compute_allowance`,
    // which IS divided by 3600, so a copy-paste that applied the same divisor to a
    // headcount fails here rather than shipping a 0-seat plan.
    #[test]
    fn limits_of_projects_member_allowance_without_a_unit_transform() {
        for p in catalog::catalog() {
            let l = limits_of(p.id).expect("every catalog tier projects");
            assert_eq!(
                l.member_allowance, p.member_allowance,
                "plan `{}`: a seat count is already in its own unit and must pass through \
                 unchanged",
                p.id
            );
            // The control: the compute allowance is NOT an identity — it is projected from
            // compute-SECONDS into core-HOURS. If someone "unified" the two projections,
            // one of these two assertions breaks.
            assert_eq!(
                l.compute_allowance,
                p.compute_allowance as f64 / SECONDS_PER_HOUR,
                "plan `{}`: compute IS transformed, seats are not",
                p.id
            );
            assert_ne!(
                l.member_allowance, 0,
                "plan `{}`: a real tier never projects a 0 seat allowance",
                p.id
            );
        }

        // The unknown-plan answer must stay COHERENT with what `build_quota_state` falls
        // back to (#141 DEC-9 / DEC-9 AMENDMENT): the read surface promises no seats AND the
        // enforcement grants none.
        //
        // This assertion has been wrong twice, and the second way is the instructive one.
        // FIX_ROUND-3 split `UnknownPlan` out of `Refuse` and left it RED — loud, and caught.
        // FIX_ROUND-4 "repaired" it by declaring a LOCAL `const … = 0` and asserting that
        // constant equalled 0 — GREEN, and pinning nothing, which a blind audit proved by
        // changing the handler's literal to 9,999,999 and watching every lib test stay green.
        // A test that re-declares the value it claims to check is not checking it.
        //
        // It now reads the SHARED const `build_quota_state` itself uses, so the two halves
        // cannot drift without failing HERE (FIX_ROUND-5, R5-1 — re-verified by that same
        // mutation, which now turns this red).
        assert!(
            limits_of("no-such-plan").is_none(),
            "no projection for an unknown plan, so the read surface uses its own fallback"
        );
        assert_eq!(
            UNKNOWN_PLAN_MEMBER_ALLOWANCE, 0,
            "an unknown plan reports ZERO seats on the read surface — never unlimited. This \
             reads the const `build_quota_state` uses, so changing the production fallback \
             fails HERE."
        );
        assert!(
            matches!(
                super::super::seat::decide_seat(&super::super::seat::SeatInputs {
                    plan_id: "no-such-plan".into(),
                    member_allowance: None,
                    premium: false,
                    current_members: 0,
                }),
                super::super::seat::SeatVerdict::UnknownPlan { .. }
            ),
            "and the ENFORCEMENT fails CLOSED, as its own verdict — so the refusal names the \
             real remedy instead of telling an operator to upgrade a plan that does not exist"
        );    }

    // TEST-1 [covers: ITEM-7] (#37, INV-2 ordering): an admin-suspend (folded into `suspended`)
    // beats BOTH a premium comp AND a large credit balance under a set spend cap — `decide`
    // refuses on `suspended` FIRST. Flipping `suspended` to false would flip the verdict (the
    // control below), so the assertion is non-tautological.
    #[test]
    fn suspended_beats_premium_and_credits() {
        let i = QuotaInputs {
            used: 1.0,
            ask_amount: 5.0,
            suspended: true,
            premium: true,
            credit_balance_cents: 1_000_000,
            spend_cap_cents: Some(1_000_000),
            ..pro()
        };
        let admin_i = QuotaInputs { admin_suspended: true, ..i };
        match decide(&admin_i) {
            QuotaVerdict::BlockOverQuota { reason } => assert!(
                reason.contains("administrator"),
                "an admin-suspend block is worded for the operator hold, not billing: {reason}"
            ),
            other => panic!("admin-suspend must Block, got {other:?}"),
        }
        assert!(
            matches!(decide(&i), QuotaVerdict::BlockOverQuota { .. }),
            "an admin-suspend is not overridden by premium or a large credit balance"
        );
        // Control: the SAME inputs with suspended=false are NOT blocked (premium comps them) —
        // proving the block above is caused by `suspended`, not by the usage/cap.
        assert_eq!(
            decide(&QuotaInputs { suspended: false, ..i }),
            QuotaVerdict::Allow,
            "without the suspend, premium allows the same over-allowance ask"
        );
    }

    // TEST-2 [covers: ITEM-7] (#37, INV-6 byte-preservation): with `suspended = false` (the
    // admin-suspend contribution off — every account with no admin hold) every §4.2 arm's verdict
    // is byte-identical to the pre-feature decision. The OR-in-check_quota adds nothing to `decide`.
    #[test]
    fn admin_suspend_off_is_byte_identical() {
        // free under → Allow
        assert_eq!(
            decide(&QuotaInputs { used: 0.5, ask_amount: 0.4, suspended: false, ..base() }),
            QuotaVerdict::Allow
        );
        // free over → Block
        assert!(matches!(
            decide(&QuotaInputs { used: 1.0, ask_amount: 0.1, suspended: false, ..base() }),
            QuotaVerdict::BlockOverQuota { .. }
        ));
        // pro over, no cap → meter
        assert_eq!(
            decide(&QuotaInputs { used: 100.0, ask_amount: 5.0, suspended: false, ..pro() }),
            QuotaVerdict::AllowMeteredOverage
        );
        // pro over, cap below cost → block
        assert!(matches!(
            decide(&QuotaInputs {
                used: 100.0, ask_amount: 5.0, spend_cap_cents: Some(49), suspended: false, ..pro()
            }),
            QuotaVerdict::BlockOverQuota { .. }
        ));
    }

    #[test]
    fn suspended_blocks_regardless_of_usage() {
        // Suspended + WELL under allowance still blocks (the first gate).
        let i = QuotaInputs {
            used: 0.0,
            ask_amount: 0.0,
            suspended: true,
            ..pro()
        };
        assert!(matches!(decide(&i), QuotaVerdict::BlockOverQuota { .. }));
    }

    #[test]
    fn limits_are_plan_derived_from_the_catalog() {
        // INV-3: limits_of is a pure projection of B2's catalog (compute seconds → hours).
        let free = limits_of("free").expect("free limits");
        assert!(free.hard_cap && !free.overage, "free is hard-capped");
        // 3600 compute-seconds ÷ 3600 = 1.0 core-hour.
        assert!((free.compute_allowance - 1.0).abs() < 1e-9);
        let pro = limits_of("pro").expect("pro limits");
        assert!(pro.overage && !pro.hard_cap, "pro meters overage");
        // 360_000 ÷ 3600 = 100 core-hours.
        assert!((pro.compute_allowance - 100.0).abs() < 1e-9);
        assert!(limits_of("does-not-exist").is_none());
    }

    #[test]
    fn overage_cost_projection_ceils_and_clamps() {
        assert_eq!(projected_overage_cost_cents(5.0, 10.0), 50);
        assert_eq!(
            projected_overage_cost_cents(0.01, 10.0),
            1,
            "ceil a fraction"
        );
        assert_eq!(
            projected_overage_cost_cents(-1.0, 10.0),
            0,
            "under allowance → 0"
        );
    }

    // TEST-8 [covers: ITEM-3] — the BYTE-PRESERVATION regression fixture (#39 / INV-5): with
    // `premium = false` AND `credit_balance_cents = 0` (the default for every account with no
    // grant/override), `decide` returns the IDENTICAL verdict on every §4.2 arm. If a later edit
    // changed the no-override path, this fails.
    #[test]
    fn no_override_no_credit_is_byte_identical_to_pre_39() {
        // free under → Allow
        assert_eq!(
            decide(&QuotaInputs {
                used: 0.5,
                ask_amount: 0.4,
                ..base()
            }),
            QuotaVerdict::Allow
        );
        // free over → Block
        assert!(matches!(
            decide(&QuotaInputs {
                used: 1.0,
                ask_amount: 0.1,
                ..base()
            }),
            QuotaVerdict::BlockOverQuota { .. }
        ));
        // pro over, no cap → meter
        assert_eq!(
            decide(&QuotaInputs {
                used: 100.0,
                ask_amount: 5.0,
                ..pro()
            }),
            QuotaVerdict::AllowMeteredOverage
        );
        // pro over, cap below cost → block
        assert!(matches!(
            decide(&QuotaInputs {
                used: 100.0,
                ask_amount: 5.0,
                spend_cap_cents: Some(49),
                ..pro()
            }),
            QuotaVerdict::BlockOverQuota { .. }
        ));
        // suspended → block
        assert!(matches!(
            decide(&QuotaInputs {
                suspended: true,
                ..pro()
            }),
            QuotaVerdict::BlockOverQuota { .. }
        ));
    }

    // TEST-9 [covers: ITEM-3] — the #39 override branches: premium → Allow; free hard_cap consults
    // the credit budget; paid effective cap = spend_cap + credits.
    #[test]
    fn premium_and_credits_change_the_over_allowance_verdict() {
        // premium comps an over-allowance FREE ask outright (INV-3).
        assert_eq!(
            decide(&QuotaInputs {
                used: 1.0,
                ask_amount: 5.0,
                premium: true,
                ..base()
            }),
            QuotaVerdict::Allow,
            "premium → Allow over allowance"
        );
        // premium does NOT bypass suspension (DEC-4).
        assert!(matches!(
            decide(&QuotaInputs {
                premium: true,
                suspended: true,
                ..base()
            }),
            QuotaVerdict::BlockOverQuota { .. }
        ));
        // FREE over allowance: 5 core-hours over × 10¢ = 50¢ projected cost.
        let free_over = QuotaInputs {
            used: 1.0,
            ask_amount: 5.0,
            ..base()
        };
        // credits ≥ cost → Allow (comped by the grant, INV-1).
        assert_eq!(
            decide(&QuotaInputs {
                credit_balance_cents: 50,
                ..free_over
            }),
            QuotaVerdict::Allow,
            "free: credits cover the cost → Allow"
        );
        // credits < cost → still Block (INV-1 partial-budget).
        assert!(
            matches!(
                decide(&QuotaInputs {
                    credit_balance_cents: 49,
                    ..free_over
                }),
                QuotaVerdict::BlockOverQuota { .. }
            ),
            "free: credits short of the cost → Block"
        );
        // PAID over cap: cost 50¢, cap 40¢ → normally block; +20¢ credits → effective cap 60¢ ≥ 50¢
        // → meter (INV-1 raises the effective cap).
        let paid_over = QuotaInputs {
            used: 100.0,
            ask_amount: 5.0,
            spend_cap_cents: Some(40),
            ..pro()
        };
        assert!(matches!(
            decide(&paid_over),
            QuotaVerdict::BlockOverQuota { .. }
        ));
        assert_eq!(
            decide(&QuotaInputs {
                credit_balance_cents: 20,
                ..paid_over
            }),
            QuotaVerdict::AllowMeteredOverage,
            "paid: credits raise the effective cap above the cost → meter"
        );
        // boundary: effective cap exactly AT cost → allowed (> comparison). cap 30 + 20 = 50 == cost.
        assert_eq!(
            decide(&QuotaInputs {
                spend_cap_cents: Some(30),
                credit_balance_cents: 20,
                ..paid_over
            }),
            QuotaVerdict::AllowMeteredOverage,
            "paid: effective cap exactly at cost → allow (boundary)"
        );
    }
}
