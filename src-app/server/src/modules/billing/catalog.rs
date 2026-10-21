//! The plan / price catalog + the plan-derived allowance lookup (ITEM-7 —
//! **PROV-B2-2**, bound by B4).
//!
//! Design §4.1: the plan SET (and its allowance POLICY — hard-cap vs overage) is
//! **code-defined** and versioned here, auditable and out of an operator's reach
//! (DEC-2/DEC-9 — a COGS boundary must not be silently weakened). Only the
//! environment-specific **Stripe price ids** vary per Stripe account/mode, so they
//! come from env (each plan names its env var + a dev-default placeholder the local
//! stripe-mock accepts). This fixes the SHAPE, not the numbers (the tier count +
//! prices + allowances are owner-calls, §10 Q1-Q5).
//!
//! #141 adds `member_allowance` — the SEAT allowance — on the same terms. Its numbers
//! are placeholders in exactly the sense above: issue #141 says "numbers are an owner
//! call; this item fixes the shape" (#141 DEC-8). They are non-degenerate on purpose
//! (positive, and `pro > free`) so the field genuinely discriminates tiers and the
//! enforcement it drives is actually exercised. `free` is 10 rather than a tighter number
//! for one measured reason: #145's `inv5_an_admin_cannot_invite_at_owner` builds a SIX
//! member fixture, so any free allowance at or below 6 makes an unrelated suite's fixture
//! collide with a billing limit. Nothing downstream hardcodes them —
//! `limits_of`, `account::seat` and every test derive from `plan(id).member_allowance`,
//! so re-pricing is one line in `CATALOG`.
//!
//! B4 binds `plan(plan_id)` / [`allowance_of`]: its plan-derived per-account limits
//! + hard-block-vs-overage policy come from THIS lookup, keyed on `accounts.plan_id`.

/// A billing plan/tier. `base_price_env` / `metered_price_envs` name the env vars
/// carrying the Stripe **price ids** for this plan (env-sourced, DEC-2); each has a
/// `_default` dev placeholder the local stripe-mock accepts so tests need no env.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// The plan id — the value stored in `accounts.plan_id` (B4's lookup key).
    pub id: &'static str,
    /// Env var holding the Stripe base (flat) subscription price id for this plan.
    pub base_price_env: &'static str,
    /// The dev-default base price id (used when `base_price_env` is unset — a dummy
    /// the local stripe-mock accepts; a real deployment sets the env var).
    pub base_price_default: &'static str,
    /// Env vars holding the Stripe **metered** (usage-based) price ids — one per
    /// metered resource (compute / storage). Empty for a plan with no metered line.
    pub metered_price_envs: &'static [&'static str],
    /// Dev-default metered price ids, positionally paired with `metered_price_envs`.
    pub metered_price_defaults: &'static [&'static str],
    /// Included compute allowance (compute-seconds) before overage/hard-cap applies.
    pub compute_allowance: i64,
    /// Included storage allowance (GB-months) before overage/hard-cap applies.
    pub storage_allowance: i64,
    /// Included SEAT allowance — the maximum number of `account_members` rows an account
    /// on this plan may hold (#141, research §5).
    ///
    /// Unlike the two allowances above this one is not metered: there is no seat overage
    /// and no seat spend-cap, because a seat is not consumption. It is a HARD count,
    /// enforced transactionally at the moment a membership row is created
    /// (`account::seat`), on every plan regardless of `overage`/`hard_cap` — those two
    /// fields describe what happens past a *usage* allowance and say nothing about seats.
    ///
    /// Code-defined and versioned like every other allowance (INV-1: the catalog is not
    /// operator-editable). A seat limit is both a COGS boundary — more members means more
    /// concurrent jobs against ONE compute allowance — and a revenue boundary, so it must
    /// not be silently weakened. The per-account exception is the existing #39
    /// `account_quota_override.premium` comp, which lifts it (#141 DEC-4).
    pub member_allowance: i64,
    /// `true` → usage BEYOND the allowance is billed as metered overage; `false` →
    /// no overage is billed (paired with `hard_cap` to hard-block instead).
    pub overage: bool,
    /// `true` → usage is HARD-CAPPED at the allowance (B4 blocks over-quota); `false`
    /// → not hard-capped (paired with `overage` to meter beyond the allowance).
    pub hard_cap: bool,
}

/// The plan-derived limits B4 reads (a projection of [`Plan`] without the Stripe
/// price ids — B4 needs the POLICY, not the billing identifiers).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Allowance {
    pub compute_allowance: i64,
    pub storage_allowance: i64,
    /// The plan's seat allowance (#141) — see [`Plan::member_allowance`].
    pub member_allowance: i64,
    pub overage: bool,
    pub hard_cap: bool,
}

// The code-defined catalog (§4.1). SHAPE, not final numbers — the allowances +
// price-env names are the versioned policy; a real deployment sets the price-id env
// vars. `free` is hard-capped with NO overage; `pro` meters overage (not hard-
// capped). This is the §4.3 shape B4's hard-block-vs-overage policy binds.
static CATALOG: &[Plan] = &[
    Plan {
        id: "free",
        base_price_env: "STRIPE_PRICE_FREE_BASE",
        base_price_default: "price_free_base",
        metered_price_envs: &[],
        metered_price_defaults: &[],
        compute_allowance: 3_600,
        storage_allowance: 5,
        member_allowance: 10,
        overage: false,
        hard_cap: true,
    },
    Plan {
        id: "pro",
        base_price_env: "STRIPE_PRICE_PRO_BASE",
        base_price_default: "price_pro_base",
        metered_price_envs: &["STRIPE_PRICE_PRO_COMPUTE", "STRIPE_PRICE_PRO_STORAGE"],
        metered_price_defaults: &["price_pro_compute_metered", "price_pro_storage_metered"],
        compute_allowance: 360_000,
        storage_allowance: 100,
        member_allowance: 50,
        overage: true,
        hard_cap: false,
    },
];

/// The whole catalog (all tiers).
pub fn catalog() -> &'static [Plan] {
    CATALOG
}

/// A read-only wire view of one catalog plan for the admin `GET /api/billing/catalog` (#41,
/// ITEM-5). It exposes the plan id + allowances + hard-cap/overage POLICY — the
/// operator-relevant view — and DELIBERATELY OMITS the Stripe price ids (env-sourced
/// deployment config, DEC-6). The catalog is code-defined and NOT editable (INV-1): this is a
/// VIEW, there is no corresponding PUT.
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
pub struct PlanCatalogEntry {
    /// The plan id (the value stored in `accounts.plan_id`).
    pub id: String,
    /// Included compute allowance (compute-seconds) before overage/hard-cap applies.
    pub compute_allowance: i64,
    /// Included storage allowance (GB-months) before overage/hard-cap applies.
    pub storage_allowance: i64,
    /// Included seat allowance — the maximum number of members an account on this plan may
    /// hold (#141). A hard count, not metered: `overage`/`hard_cap` describe usage, not seats.
    pub member_allowance: i64,
    /// `true` → usage beyond the allowance meters as overage.
    pub overage: bool,
    /// `true` → usage is hard-capped at the allowance (the COGS wall).
    pub hard_cap: bool,
}

/// The code-defined catalog as a read-only wire view (#41 ITEM-5). Derived from `CATALOG`;
/// there is no mutation path — the plan set + allowance policy stay code-defined (INV-1).
pub fn catalog_view() -> Vec<PlanCatalogEntry> {
    CATALOG
        .iter()
        .map(|p| PlanCatalogEntry {
            id: p.id.to_string(),
            compute_allowance: p.compute_allowance,
            storage_allowance: p.storage_allowance,
            member_allowance: p.member_allowance,
            overage: p.overage,
            hard_cap: p.hard_cap,
        })
        .collect()
}

/// The plan for `plan_id`, or `None` if it names no tier (B4 keys this on
/// `accounts.plan_id`).
pub fn plan(plan_id: &str) -> Option<&'static Plan> {
    CATALOG.iter().find(|p| p.id == plan_id)
}

/// The plan id whose BASE Stripe price matches `price_id`, or `None` if no plan carries it
/// (B3's webhook re-derives `accounts.plan_id` from a subscription's price — ITEM-5). Reverse
/// of [`Plan::base_price_id`]; keyed on the SAME env-or-default resolution so a real
/// deployment's env price ids and the dev-default placeholders both map.
pub fn plan_id_for_price(price_id: &str) -> Option<&'static str> {
    CATALOG
        .iter()
        .find(|p| p.base_price_id() == price_id)
        .map(|p| p.id)
}

/// The plan-derived allowance/policy for `plan_id` — **PROV-B2-2**, the lookup B4
/// binds for its per-account limits.
pub fn allowance_of(plan_id: &str) -> Option<Allowance> {
    plan(plan_id).map(|p| Allowance {
        compute_allowance: p.compute_allowance,
        storage_allowance: p.storage_allowance,
        member_allowance: p.member_allowance,
        overage: p.overage,
        hard_cap: p.hard_cap,
    })
}

impl Plan {
    /// The Stripe base price id for this plan: the `base_price_env` env value if set
    /// (a real deployment), else the dev-default placeholder (the local mock accepts
    /// it). Reading env here is a per-lookup read of an OPERATOR-configured id, not a
    /// test seam — it is honored in release too (real deployments set it).
    pub fn base_price_id(&self) -> String {
        std::env::var(self.base_price_env)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| self.base_price_default.to_string())
    }

    /// The Stripe metered price ids for this plan (env value per entry, else the
    /// positionally-paired dev-default).
    pub fn metered_price_ids(&self) -> Vec<String> {
        self.metered_price_envs
            .iter()
            .enumerate()
            .map(|(i, env)| {
                std::env::var(env)
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or_else(|| {
                        self.metered_price_defaults
                            .get(i)
                            .copied()
                            .unwrap_or("price_metered")
                            .to_string()
                    })
            })
            .collect()
    }

    /// The base price id, preferring an admin-configured override (#60) keyed by this
    /// plan's `base_price_env` name in the `billing_integration.price_ids` map, else the
    /// existing env/default resolution ([`base_price_id`]). Only the Stripe price
    /// IDENTIFIER is overridable — the allowances/hard-cap-vs-overage POLICY stays
    /// code-defined (settings-coverage INV-1, the COGS boundary).
    pub fn base_price_id_with(&self, overrides: &serde_json::Value) -> String {
        override_str(overrides, self.base_price_env).unwrap_or_else(|| self.base_price_id())
    }

    /// The metered price ids, each preferring an admin-configured override (#60) keyed
    /// by the corresponding `metered_price_envs` name, else the env/default.
    pub fn metered_price_ids_with(&self, overrides: &serde_json::Value) -> Vec<String> {
        let defaults = self.metered_price_ids();
        self.metered_price_envs
            .iter()
            .enumerate()
            .map(|(i, env)| {
                override_str(overrides, env).unwrap_or_else(|| defaults[i].clone())
            })
            .collect()
    }
}

/// A non-empty string override for `key` in the price-ID map, or `None`.
fn override_str(overrides: &serde_json::Value, key: &str) -> Option<String> {
    overrides
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-5 [covers: ITEM-7] [pins: PROV-B2-2]: the catalog yields a plan per tier
    // with base + metered price ids + allowances; `free` is hard-cap/no-overage,
    // `pro` is overage/not-hard-capped (§4.3 shape); `allowance_of` is B4's lookup.
    #[test]
    fn catalog_shapes_free_and_pro() {
        assert!(catalog().len() >= 2, "at least free + pro tiers");

        let free = plan("free").expect("free plan exists");
        assert!(
            free.hard_cap && !free.overage,
            "free is hard-capped, no overage"
        );
        assert!(
            free.metered_price_envs.is_empty(),
            "free has no metered line"
        );

        let pro = plan("pro").expect("pro plan exists");
        assert!(
            pro.overage && !pro.hard_cap,
            "pro meters overage, not hard-capped"
        );
        assert_eq!(
            pro.metered_price_envs.len(),
            pro.metered_price_defaults.len(),
            "every metered env has a positional default"
        );

        assert!(plan("does-not-exist").is_none());
    }

    #[test]
    fn allowance_lookup_is_the_b4_contract() {
        let a = allowance_of("pro").expect("pro allowance");
        assert_eq!(a.compute_allowance, plan("pro").unwrap().compute_allowance);
        assert!(a.overage && !a.hard_cap);
        assert!(allowance_of("nope").is_none());
    }

    // TEST-1 [acceptance, INV-4] [covers: ITEM-1] (#141): `member_allowance` is on `Plan`,
    // on `Allowance` and on `PlanCatalogEntry`, code-defined in `CATALOG`, and PROJECTED
    // (never re-derived) by both `allowance_of` and `catalog_view`.
    #[test]
    fn member_allowance_is_code_defined_and_projected_unchanged() {
        // Every shipped tier carries a POSITIVE allowance. A tier with 0 (or a negative)
        // would be an account that cannot hold even its own owner.
        for p in catalog() {
            assert!(
                p.member_allowance > 0,
                "plan `{}` needs a positive seat allowance, got {}",
                p.id,
                p.member_allowance
            );
        }

        // The field DISCRIMINATES tiers. A placeholder that was the same everywhere (or
        // i64::MAX) would make every enforcement test downstream vacuous.
        let free = plan("free").expect("free");
        let pro = plan("pro").expect("pro");
        assert!(
            pro.member_allowance > free.member_allowance,
            "a paid tier includes more seats than the free tier ({} vs {})",
            pro.member_allowance,
            free.member_allowance
        );

        // Both projections carry the CATALOG's value, compared field-by-field against
        // `plan(id)` — so a hardcoded constant in either projection fails here rather than
        // silently disagreeing with the enforcement.
        for p in catalog() {
            assert_eq!(
                allowance_of(p.id).expect("allowance").member_allowance,
                p.member_allowance,
                "allowance_of projects plan `{}`'s seat allowance unchanged",
                p.id
            );
        }
        for view in catalog_view() {
            let p = plan(&view.id).expect("catalog_view only yields real plans");
            assert_eq!(
                view.member_allowance, p.member_allowance,
                "catalog_view projects plan `{}`'s seat allowance unchanged",
                p.id
            );
        }

        // An unknown plan still has NO allowance — `None`, which the seat check reads as
        // "fail closed", never as "unlimited" (#141 DEC-9).
        assert!(allowance_of("does-not-exist").is_none());
    }

    #[test]
    fn price_ids_default_without_env_and_are_nonempty() {
        // No env set → dev-default placeholders (the local mock accepts them).
        let free = plan("free").unwrap();
        assert!(!free.base_price_id().is_empty());
        let pro = plan("pro").unwrap();
        assert_eq!(
            pro.metered_price_ids().len(),
            2,
            "compute + storage metered ids"
        );
        assert!(pro.metered_price_ids().iter().all(|p| !p.is_empty()));
    }
}

#[cfg(test)]
mod price_override_tests {
    use super::*;

    // TEST-9 [covers: ITEM-6]: a DB price-id override wins over the env/default for the
    // Stripe price IDENTIFIER, while the plan's allowances/policy (the COGS boundary)
    // are untouched by the override path.
    #[test]
    fn override_wins_for_price_id_only() {
        let pro = plan("pro").expect("pro plan");
        let empty = serde_json::json!({});
        // No override ⇒ env/default (the pre-#60 value).
        assert_eq!(pro.base_price_id_with(&empty), pro.base_price_id());

        // An override keyed by the plan's base_price_env replaces ONLY the identifier.
        let ov = serde_json::json!({ pro.base_price_env: "price_admin_override_123" });
        assert_eq!(pro.base_price_id_with(&ov), "price_admin_override_123");

        // Allowances/policy are read from the code catalog, never the override map.
        let a = allowance_of("pro").expect("pro allowance");
        assert_eq!(a.hard_cap, pro.hard_cap);
        assert_eq!(a.overage, pro.overage);

        // A blank override falls back to the env/default (never an empty price id).
        let blank = serde_json::json!({ pro.base_price_env: "  " });
        assert_eq!(pro.base_price_id_with(&blank), pro.base_price_id());
    }
}
