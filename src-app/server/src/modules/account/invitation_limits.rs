//! #145 — the invitation TTL and the create/resend rate ceilings.
//!
//! # Why a struct of constants and not an admin-configurable settings row
//!
//! The project's standing rule is that an operational tunable defaults to
//! admin-configurable (the `mcp_settings` / `sandbox_settings` / `job_settings`
//! singleton pattern). These are deliberately NOT, for the rule's own stated carve-out —
//! *"a security boundary that must not be operator-weakened"* — and the reasoning is
//! recorded here rather than in a stripped process artifact:
//!
//! 1. Under A3 DEC-12 (#140) an invitation redeems into a **tenant-wide grant**. An
//!    operator-raisable [`Self::TTL`] is an operator-raisable window in which a leaked
//!    link is live; an operator-raisable create ceiling is precisely the spam relay #143
//!    warns about ("an unrated create endpoint is a spam relay that sends from *your*
//!    domain with *your* branding"). `mcp_settings`' own migration states the same
//!    principle for the same reason: a safety guard is bounded and never admin-raisable
//!    unbounded.
//! 2. The `account` module has no settings table, no `account` settings permission keys
//!    and no admin card, and #149 owns the account admin surface. Standing up that whole
//!    stack here would ship an admin card nobody has reviewed, attached to an item whose
//!    frontend does not yet exist.
//!
//! **The choice is structured so it can be reversed cheaply**, which is the other half of
//! the rule. This is a `Limits`-style struct with a [`Self::defaults`] constructor, not
//! inline magic numbers: promoting it is one more per-module settings migration following
//! `mcp_settings` verbatim, whose "defaults exactly equal the compiled constants"
//! invariant already has its mirror right here.
//!
//! # How the ceilings are enforced
//!
//! There is **no reusable per-principal rate limiter in this tree**, and that was verified
//! rather than assumed. The only per-time limiter is `tower_governor`, applied whole-router
//! and keyed on PEER IP (`txresbench-framework::app_builder::apply_rate_limit_layer`) — and this
//! app passes `None` as its absent-default, so on desktop there is no request limiter at
//! all. The only DB-backed counter is `txresbench-auth`'s single-purpose
//! `bump_pending_link_attempts`.
//!
//! So one is built here, and it counts **mint records** — one row in
//! `account_invitation_mints` per token brought into existence, by a create or by a resend,
//! with no exemptions. (An exemption for the first resend of each invitation was tried and
//! reverted: it was a per-ROW credit, so it could be banked across windows.)
//! `AccountRepository::enforce_invitation_mint_budget` carries the full argument for that
//! shape, including the two designs that came before it and failed: counting invitation
//! rows by `created_at` left `resend` exempt, and charging a cumulative per-row counter was
//! both evadable by two alternating actors and a re-armable tenant-wide lockout. A per-row
//! counter cannot represent two windows, and a monotone counter cannot decay.
//!
//! # The accounting asymmetry, stated rather than hidden (#145 DEC-8)
//!
//! Two of create's four cases are server-side NO-OPs (the address is already a member;
//! a live invitation already exists). They mint nothing, so they record nothing, so
//! budget consumption is observable and correlates with those two cases.
//!
//! That leaks nothing **to this caller**: the route sits at `AccountScope<RoleAdmin>`, and
//! an account Admin can already read `GET /api/accounts/{id}/members` — whose
//! `AccountMember` DTO carries `email` — and `GET …/invitations` for their own account.
//! Both facts are therefore directly available to them by authorized means. The
//! distinction enumeration-safety genuinely protects is *is this address a registered
//! user of the platform at all*, i.e. case (i) versus case (ii) — and **both of those mint
//! a token and record it identically**, so the limiter cannot separate them.
//!
//! **This reasoning has a trigger, and it is written down because it expires.** If a
//! future item lowers the invitation floor below `admin`, or removes `email` from the
//! member DTO, the premise ("the caller can already read both facts") is false and this
//! must become an attempts counter incremented on every call regardless of outcome.

use chrono::Duration;

/// Refusal code for a create/resend refused by the ceilings below.
///
/// Named so tests and clients bind to it BY NAME. 429 is otherwise emitted in this tree
/// by unrelated concurrency caps (`jobs::admission::pool_full`, the SSE registry), so the
/// status alone does not identify this refusal.
pub const INVITATION_RATE_LIMITED: &str = "INVITATION_RATE_LIMITED";

/// The invitation TTL and the create/resend ceilings.
///
/// Every field is read through [`Self::defaults`]; nothing in the module writes a bare
/// number. Both an ACTOR window and an ACCOUNT window are enforced, because they stop
/// different attacks: the actor window stops one compromised admin, the account window
/// stops a set of colluding or compromised admins of one tenant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvitationLimits {
    /// How long a freshly minted invitation stays redeemable.
    ///
    /// 7 days, matching GitHub. `membership-rescope.md` §13.2 is candid that this is "a
    /// first-guess default, not a considered one" — it is recorded as such rather than
    /// dressed up as derived from a requirement.
    pub ttl: Duration,
    /// Max TOKEN MINTS one ACTOR may perform in one hour, across all accounts.
    ///
    /// # The unit is MINTS, and the number is deliberately NOT adjusted for that
    ///
    /// Because create returns no link (INV-8) and the token is hashed at rest (DEC-1),
    /// DEC-2's flow is create → resend → copy, so one *usable* invitation costs TWO mints.
    /// The reachable rate of usable invitations is therefore about **half** this number —
    /// roughly ten per hour per actor. That is stated plainly rather than compensated for,
    /// and the history of trying to compensate is why:
    ///
    /// * **Attempt 1 — exempt the first resend.** Reverted. The exemption was a credit on
    ///   the invitation ROW, not on a window, so it could be earned in one window and spent
    ///   in another; a blind audit drove 30 fresh tokens through the real routes in one hour
    ///   with the ledger recording ZERO in-window mints. Recorded at
    ///   `AccountRepository::resend_invitation`.
    /// * **Attempt 2 — double the numbers.** Also reverted, and the reason is the sharper
    ///   one. The doubling was argued entirely from the cost of a *usable* invitation — but
    ///   that cost is paid only by someone who wants the link. **The threat this file
    ///   exists for is a flood of CREATES to distinct recipients, and a create costs exactly
    ///   one mint and (once #143 lands) sends exactly one message.** So doubling the shared
    ///   ceiling doubled the distinct-recipient outbound rate, which is precisely the bound
    ///   being defended. A blind security angle put it plainly: "400 mints/day is about two
    ///   hundred people" was false on that path — it is four hundred people.
    ///
    /// **If ~10 usable invitations per hour proves too tight for onboarding, the fix is
    /// SEPARATE budgets for create and resend, not a bigger shared one.** A shared counter
    /// cannot distinguish "one admin collecting ten links" from "one admin mailing forty
    /// strangers", and every attempt to make it do so by arithmetic has been a weakening.
    pub per_actor_per_hour: i64,
    /// Max token mints one ACCOUNT may accumulate in one hour, across all actors.
    pub per_account_per_hour: i64,
    /// Max token mints one ACTOR may perform in 24 hours, across all accounts.
    ///
    /// A daily window as well as an hourly one, because an hourly-only ceiling is
    /// trivially defeated by pacing: 20/hour is 480/day.
    pub per_actor_per_day: i64,
    /// Max token mints one ACCOUNT may accumulate in 24 hours.
    pub per_account_per_day: i64,
}

impl InvitationLimits {
    /// The compiled defaults. If these are ever promoted to a settings row, that
    /// migration's column defaults must equal these exactly (the `mcp_settings` INV-1).
    pub fn defaults() -> Self {
        Self {
            ttl: Duration::days(7),
            // In MINTS. The binding constraint is the number of DISTINCT RECIPIENTS a
            // create-flood can reach, because a create is one mint and (post-#143) one
            // message: 20/hour and 100/day for one ACTOR is a person onboarding a team;
            // ten times that is a mailing list. (An earlier version of this sentence said
            // "200/day per actor" — 200 is the ACCOUNT daily ceiling three lines below, and
            // quoting it here overstated the actor's own bound by 2×. Exactly the
            // prose-vs-constant class this comment exists to prevent.) See the field docs
            // for why these are NOT
            // adjusted upward to compensate for DEC-2's two-mints-per-usable-invitation
            // flow — that adjustment was tried and it doubled exactly the bound being
            // defended.
            per_actor_per_hour: 20,
            per_account_per_hour: 50,
            per_actor_per_day: 100,
            per_account_per_day: 200,
        }
    }
}

impl Default for InvitationLimits {
    fn default() -> Self {
        Self::defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-14 companion [covers: ITEM-11, ITEM-16] — the ceilings are internally
    // coherent. A daily ceiling BELOW the hourly one is unreachable-by-construction and
    // would make the hourly window dead code; an hourly ceiling at or above the daily one
    // makes the daily window dead code. Either is a silent mis-tuning that no behavioural
    // test would catch, because both still refuse *something*.
    #[test]
    fn limits_are_internally_coherent() {
        let l = InvitationLimits::defaults();
        // The TTL is pinned to its VALUE, not merely to being positive. Seven days is
        // asserted by the migration's header, this module's doc and the OpenAPI text, and
        // nothing else in the tree binds it — so a silent change here would leave three
        // documents lying. (`membership-rescope.md` §13.2 is candid that 7 days is a
        // first-guess default matching GitHub, not a derived requirement; that is a reason
        // to make changing it deliberate, not a reason to leave it unpinned.)
        assert_eq!(
            l.ttl,
            Duration::days(7),
            "the invitation TTL is 7 days — change it here and the migration header, the \
             module doc and the OpenAPI description all become false"
        );
        // ABSOLUTE values, not just orderings. A blind design-conformance angle pointed out
        // that this test asserted only ordering, so restoring `per_actor_per_hour: 40` —
        // this branch's headline revert, made because doubling the shared ceiling doubles
        // the distinct-recipient outbound rate — left the whole suite green. The integration
        // tests read `defaults()` symbolically (correctly: they must not hard-code the
        // numbers), which means nothing else in the tree binds the values at all.
        //
        // Changing any of these four should be a deliberate act with the argument in the
        // field docs re-read, not a silent edit. That is what these assertions cost, and it
        // is the whole benefit.
        assert_eq!(l.per_actor_per_hour, 20, "see the field doc before changing this");
        assert_eq!(l.per_account_per_hour, 50, "see the field doc before changing this");
        assert_eq!(l.per_actor_per_day, 100, "see the field doc before changing this");
        assert_eq!(l.per_account_per_day, 200, "see the field doc before changing this");

        assert!(
            l.per_actor_per_hour < l.per_actor_per_day,
            "the daily actor ceiling must be strictly above the hourly one, or one of \
             the two windows can never fire"
        );
        assert!(
            l.per_account_per_hour < l.per_account_per_day,
            "likewise for the account ceilings"
        );
        assert!(
            l.per_actor_per_hour <= l.per_account_per_hour
                && l.per_actor_per_day <= l.per_account_per_day,
            "an ACTOR may never be allowed more than the ACCOUNT they are minting into — \
             otherwise the account window is unreachable for a single-admin account, \
             which is the common case"
        );
    }
}
