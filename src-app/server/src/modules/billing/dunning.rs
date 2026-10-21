//! B3 dunning / billing-state machine (ITEM-5 / ITEM-6 — **PROV-B3-1**).
//!
//! The PURE core of the reconciliation boundary: given a Stripe lifecycle event, derive the
//! TARGET billing-state (`subscription_status` / `plan_id` / `grace_until`) — never an
//! increment, so a redelivered event is a no-op (INV-3). No DB and no clock live here (the
//! `grace_until` deadline is applied by `repository::apply_transition` from the configured
//! grace window), which is what makes the table directly unit-testable (TEST-8).
//!
//! It also exposes the DERIVED effective state B4's quota reads (`is_suspended` /
//! `billing_state`) — B3 SETS the state, B4 ENFORCES it at the consumption points (design
//! §4/§5). The whole `billing` module is `#[cfg(feature = "saas")]` at its parent
//! declaration, so every symbol here compiles out of desktop (INV-5).
//!
//! Lifecycle mapping (design §5, verified against the Stripe subscription-lifecycle doc):
//!   checkout.session.completed  → active, grace cleared
//!   invoice.paid                → active, grace cleared
//!   invoice.payment_failed      → past_due, grace = now()+window (account still works)
//!   customer.subscription.updated → mirror Subscription.status; `unpaid`/`incomplete_expired`
//!                                   → suspend path (free), per DEC-4
//!   customer.subscription.deleted → canceled, plan_id='free' — **NO row deletion** (INV-1)

/// The Stripe lifecycle event reduced to what the state machine needs (DEC-9 — a thin view,
/// not a full async-stripe `Event`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BillingEvent {
    /// `checkout.session.completed` — the subscription is now active; `plan` from the
    /// checkout's price if resolvable, else left unchanged.
    CheckoutCompleted { plan: Option<String> },
    /// `customer.subscription.updated` (and `.created`) — mirror `Subscription.status` and
    /// re-derive the plan from the subscription's base price.
    SubscriptionUpdated {
        status: String,
        plan: Option<String>,
    },
    /// `customer.subscription.deleted` — terminal cancel; revert to free. NEVER deletes data.
    SubscriptionDeleted,
    /// `invoice.paid` — clears any dunning grace, back to active.
    InvoicePaid,
    /// `invoice.payment_failed` — enter the dunning grace window (past_due).
    InvoicePaymentFailed,
}

/// What a transition does to `accounts.plan_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanChange {
    /// Leave the current plan unchanged.
    Keep,
    /// Set the plan to a specific catalog id (e.g. `"pro"`).
    Set(String),
    /// Revert to the free tier (`'free'`) — a terminal-cancel / suspend transition.
    Free,
}

/// What a transition does to `accounts.grace_until`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraceAction {
    /// Leave the current `grace_until` unchanged.
    Keep,
    /// Clear it (`NULL`) — the account is current again.
    Clear,
    /// Set it to `now() + grace_window` (applied by the repository from settings).
    SetFromNow,
}

/// The pure result of a transition: the target `subscription_status` (mirrors Stripe's
/// vocabulary) + the plan + the grace action. Applied to the DB by
/// `repository::apply_transition`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    pub status: String,
    pub plan: PlanChange,
    pub grace: GraceAction,
}

/// The derived EFFECTIVE billing state B4's quota reads (PROV-B3-1). Distinct from the raw
/// `subscription_status` string: it collapses the terminal/revoked statuses into `Suspended`,
/// the single flag the enforcement point gates new consumption on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BillingState {
    /// Paid + current — full plan allowance.
    Active,
    /// A payment failed but the account is within its dunning grace window — still works.
    PastDue,
    /// Terminal-cancel / retries-exhausted → reverted to free; new consumption is gated
    /// (B4). Data is RETAINED (INV-1) — "suspended" never means deleted.
    Suspended,
}

/// Stripe statuses meaning "retries exhausted → revoke access" (DEC-4). `unpaid` is the
/// Dashboard-alternative terminal to `deleted`; `incomplete_expired` is an initial-checkout
/// that never paid.
fn is_terminal_unpaid(status: &str) -> bool {
    matches!(status, "unpaid" | "incomplete_expired")
}

/// Normalize a Stripe `Subscription.status` into the value stored in
/// `accounts.subscription_status`. `trialing` counts as active; the terminal-unpaid statuses
/// are handled by the caller (mapped to `canceled` on the suspend path); everything else is
/// mirrored verbatim (`active` / `past_due` / `canceled` / `paused` / `incomplete`).
fn mirror_status(status: &str) -> String {
    match status {
        "trialing" => "active".to_string(),
        other => other.to_string(),
    }
}

/// The pure transition table (**PROV-B3-1**). Each arm derives the TARGET state from the
/// event alone (never reads-then-increments), so a duplicate delivery changes nothing even if
/// the dedupe row were lost (INV-3). No DB, no clock.
pub fn next_state(event: &BillingEvent) -> Transition {
    match event {
        BillingEvent::CheckoutCompleted { plan } => Transition {
            status: "active".to_string(),
            plan: plan
                .clone()
                .map(PlanChange::Set)
                .unwrap_or(PlanChange::Keep),
            grace: GraceAction::Clear,
        },
        BillingEvent::SubscriptionUpdated { status, plan } => {
            if is_terminal_unpaid(status) {
                // Retries exhausted → suspend path: revert to free (DEC-4). We store
                // `canceled` (the effective terminal), which `is_suspended` gates on.
                Transition {
                    status: "canceled".to_string(),
                    plan: PlanChange::Free,
                    grace: GraceAction::Keep,
                }
            } else {
                // A return to `active` clears grace; any other non-terminal status leaves the
                // grace deadline as-is (it was set by the preceding payment_failed).
                let grace = if status == "active" || status == "trialing" {
                    GraceAction::Clear
                } else {
                    GraceAction::Keep
                };
                let mirrored = mirror_status(status);
                // A cancel can arrive as `subscription.updated{status:"canceled"}` (not only as
                // `subscription.deleted`); revert the plan to free just like the deleted arm so
                // the stored `plan_id` never stays stale at a paid tier (INV-1).
                let plan = if mirrored == "canceled" {
                    PlanChange::Free
                } else {
                    plan.clone()
                        .map(PlanChange::Set)
                        .unwrap_or(PlanChange::Keep)
                };
                Transition {
                    status: mirrored,
                    plan,
                    grace,
                }
            }
        }
        BillingEvent::SubscriptionDeleted => Transition {
            status: "canceled".to_string(),
            plan: PlanChange::Free,
            grace: GraceAction::Keep,
        },
        BillingEvent::InvoicePaid => Transition {
            status: "active".to_string(),
            plan: PlanChange::Keep,
            grace: GraceAction::Clear,
        },
        BillingEvent::InvoicePaymentFailed => Transition {
            status: "past_due".to_string(),
            plan: PlanChange::Keep,
            grace: GraceAction::SetFromNow,
        },
    }
}

/// The derived effective billing state for a stored `subscription_status` (PROV-B3-1). B4's
/// quota reads THIS, not the raw string. `canceled`/`unpaid` collapse to `Suspended`.
pub fn billing_state(subscription_status: &str) -> BillingState {
    match subscription_status {
        "past_due" => BillingState::PastDue,
        "canceled" | "unpaid" | "incomplete_expired" => BillingState::Suspended,
        _ => BillingState::Active,
    }
}

/// Whether the account is SUSPENDED (new consumption gated by B4). True for the terminal
/// statuses only — NEVER implies data deletion (INV-1). A `past_due` account inside its grace
/// window is NOT suspended (it still works, design §5).
pub fn is_suspended(subscription_status: &str) -> bool {
    matches!(billing_state(subscription_status), BillingState::Suspended)
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-8 [covers ITEM-5, ITEM-6] [pins PROV-B3-1]: the pure transition table + the
    // derived effective state — every design-§5 arm, no DB.
    #[test]
    fn payment_failed_enters_grace_past_due() {
        let t = next_state(&BillingEvent::InvoicePaymentFailed);
        assert_eq!(t.status, "past_due");
        assert_eq!(
            t.plan,
            PlanChange::Keep,
            "a failed payment does not change the plan"
        );
        assert_eq!(t.grace, GraceAction::SetFromNow, "grace deadline is set");
    }

    #[test]
    fn invoice_paid_clears_grace_active() {
        let t = next_state(&BillingEvent::InvoicePaid);
        assert_eq!(t.status, "active");
        assert_eq!(t.grace, GraceAction::Clear);
    }

    #[test]
    fn subscription_deleted_reverts_to_free_canceled() {
        let t = next_state(&BillingEvent::SubscriptionDeleted);
        assert_eq!(t.status, "canceled");
        assert_eq!(t.plan, PlanChange::Free, "cancel reverts to the free tier");
        // The DELETED arm carries NO row deletion — it is purely a state revert (INV-1).
    }

    #[test]
    fn checkout_completed_activates_with_plan() {
        let t = next_state(&BillingEvent::CheckoutCompleted {
            plan: Some("pro".to_string()),
        });
        assert_eq!(t.status, "active");
        assert_eq!(t.plan, PlanChange::Set("pro".to_string()));
        assert_eq!(t.grace, GraceAction::Clear);
    }

    #[test]
    fn subscription_updated_mirrors_status_and_rederives_plan() {
        let t = next_state(&BillingEvent::SubscriptionUpdated {
            status: "active".to_string(),
            plan: Some("pro".to_string()),
        });
        assert_eq!(t.status, "active");
        assert_eq!(t.plan, PlanChange::Set("pro".to_string()));
        assert_eq!(
            t.grace,
            GraceAction::Clear,
            "returning to active clears grace"
        );

        // past_due via updated keeps the grace the payment_failed set.
        let pd = next_state(&BillingEvent::SubscriptionUpdated {
            status: "past_due".to_string(),
            plan: None,
        });
        assert_eq!(pd.status, "past_due");
        assert_eq!(pd.grace, GraceAction::Keep);
    }

    #[test]
    fn updated_unpaid_maps_to_suspend_path() {
        // DEC-4: `unpaid` (retries exhausted) → free/canceled suspend path even via `updated`.
        for s in ["unpaid", "incomplete_expired"] {
            let t = next_state(&BillingEvent::SubscriptionUpdated {
                status: s.to_string(),
                plan: Some("pro".to_string()),
            });
            assert_eq!(t.status, "canceled", "{s} maps to the terminal state");
            assert_eq!(t.plan, PlanChange::Free, "{s} reverts to free");
        }
    }

    #[test]
    fn updated_canceled_reverts_plan_to_free() {
        // A cancel arriving as `subscription.updated{status:"canceled"}` (not `.deleted`) must
        // still revert the plan to free, so `plan_id` never stays stale at a paid tier (INV-1).
        let t = next_state(&BillingEvent::SubscriptionUpdated {
            status: "canceled".to_string(),
            plan: Some("pro".to_string()),
        });
        assert_eq!(t.status, "canceled");
        assert_eq!(
            t.plan,
            PlanChange::Free,
            "a cancel via `updated` reverts the plan to free, like the deleted arm"
        );
    }

    #[test]
    fn effective_state_and_is_suspended() {
        assert_eq!(billing_state("active"), BillingState::Active);
        assert_eq!(billing_state("past_due"), BillingState::PastDue);
        assert_eq!(billing_state("canceled"), BillingState::Suspended);
        assert_eq!(billing_state("unpaid"), BillingState::Suspended);

        assert!(!is_suspended("active"));
        assert!(
            !is_suspended("past_due"),
            "past_due is NOT suspended (grace, §5)"
        );
        assert!(
            is_suspended("canceled"),
            "canceled is the suspended terminal"
        );
        assert!(is_suspended("unpaid"));
    }
}
