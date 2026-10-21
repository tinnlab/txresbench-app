//! #141 — the SEAT allowance policy: the plan-derived member limit and its refusal.
//!
//! This is the POLICY half of the seat check. The COUNTING half, and the call sites that
//! bind it, live in [`crate::modules::account::seat`] — because `account_members` is the
//! `account` module's table and because the count must ride the mutation's own
//! transaction connection. Splitting it this way keeps the number code-defined in the
//! catalog (INV-1) while leaving the account module free of any billing import in its
//! non-saas build.
//!
//! # Why this is not `check_quota`
//!
//! B4's [`check_quota`](super::quota::check_quota) is built for METERED consumption: it
//! reads `usage_rollup`, projects an overage COST in cents, compares it against a spend
//! cap and a credit balance, and answers with a three-arm verdict one of whose arms is
//! "allow, and bill the overage". None of that applies to a seat:
//!
//! * `usage_rollup` has no headcount dimension — the count is a live `SELECT count(*)`.
//! * There is no seat overage price, so there is nothing to project a cost from, and the
//!   `AllowMeteredOverage` arm is unreachable by construction.
//! * `check_quota` takes a `&PgPool`. A seat check on a pooled connection would run on a
//!   DIFFERENT connection from the INSERT it guards, which is exactly the check-then-act
//!   race #142 established the `min(observed, live)`-after-the-lock pattern against and
//!   which #145's `enforce_invitation_mint_budget` had to be moved inside a transaction to
//!   fix. So the reader here takes `&mut PgConnection`.
//!
//! Forcing seats through `QuotaAsk` would therefore mean a fake unit, a zero rate and
//! three dead arms. A small, honest, separate decision function is the alternative, and it
//! mirrors `quota.rs`'s own pure-`decide` + thin-reader split exactly.
//!
//! # `overage` / `hard_cap` do not apply
//!
//! Those two fields describe what happens past a USAGE allowance. A seat allowance is a
//! hard count on EVERY plan — a `pro` account is not billed for a 51st member, it is
//! refused. This is deliberate and is why [`decide_seat`] never reads them.

use axum::http::StatusCode;
use sqlx::PgConnection;
use uuid::Uuid;
use ziee_core::AppError;

use super::catalog;

/// Refusal code for an add that would take an account past its plan's seat allowance.
///
/// A named `pub const` so tests and clients bind BY NAME, never by status: 422 is already
/// emitted on this very route by `LAST_OWNER` and `PERSONAL_ACCOUNT_NOT_MANAGEABLE`, so
/// the status alone does not identify this refusal. Mirrors
/// `account::repository::PERSONAL_ACCOUNT_NOT_MANAGEABLE` and
/// `account::invitation_limits::INVITATION_RATE_LIMITED`.
pub const SEAT_LIMIT_REACHED: &str = "SEAT_LIMIT_REACHED";

/// Everything [`decide_seat`] needs, resolved. Separated from the reader so the truth table
/// is oracle-testable with no database — the same split as
/// [`QuotaInputs`](super::quota::QuotaInputs)/[`decide`](super::quota::decide).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatInputs {
    /// The account's `accounts.plan_id`.
    pub plan_id: String,
    /// The plan's seat allowance, or `None` when `plan_id` names no catalog tier.
    ///
    /// `None` is NOT "unlimited" — see [`decide_seat`]'s unknown-plan arm (#141 DEC-9).
    pub member_allowance: Option<i64>,
    /// The #39 admin comp/premium override (`account_quota_override.premium`). Lifts the
    /// seat limit outright (#141 DEC-4), for the same reason and at the same point in the
    /// decision as it lifts a usage allowance in [`decide`](super::quota::decide).
    pub premium: bool,
    /// The account's CURRENT MEMBER count — always members, never anything else. Read
    /// inside the caller's transaction and after the account-row lock; this is the value
    /// whose freshness the whole design rests on.
    ///
    /// It is reported verbatim as `details.current` on a refusal, so it MUST mean the same
    /// thing on every path — the same number `GET /api/billing/quota` reports as
    /// `members_used` for that account at that moment (FIX_ROUND-1, F3).
    pub current_members: i64,
}

/// The seat verdict. Two arms, not three: there is no metered-overage arm for a seat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeatVerdict {
    /// One more member fits.
    Allow,
    /// The account's `plan_id` names no catalog tier — fail CLOSED, but as its OWN outcome.
    ///
    /// Kept separate from [`Self::Refuse`] (FIX_ROUND-3, R3-3) because it is a different
    /// problem with a different remedy. Folded together, it produced a refusal that actively
    /// misdirected the reader — "using 3 of its 0 included seats on plan `bogus` — upgrade
    /// the plan" names an upgrade as the fix when the account's plan is the fix — and it made
    /// an operator-config error indistinguishable, by code, from a tenant hitting its limit.
    UnknownPlan { plan_id: String, current: i64 },
    /// The account is at (or above) its allowance — refuse, carrying the numbers the
    /// client needs to render an upgrade path.
    Refuse {
        plan_id: String,
        limit: i64,
        /// The MEMBER count — the same quantity `members_used` reports.
        current: i64,
    },
}

/// The PURE seat decision. Side-effect-free, no database — so the truth table is
/// oracle-testable (TEST-3).
///
/// 1. `premium` (#39) → `Allow` outright — the admin comp, consulted FIRST and before the
///    limit is even looked at, matching where `decide` consults it (#141 DEC-4).
/// 2. An unknown plan → `UnknownPlan`. **Fail CLOSED**, not open (#141 DEC-9):
///    `build_quota_state` already treats an unknown plan as allowance-0/hard-cap, so
///    failing open here would put two different answers to one question in one module.
///    `accounts.plan_id` is `NOT NULL DEFAULT 'free'` and the admin plan-override route
///    validates against the catalog, so this is not tenant-reachable; it is an operator
///    config error (a retired tier, an unmapped webhook price, a direct DB write) and it
///    is recoverable by fixing the plan or by the `premium` comp above. It is its OWN
///    verdict so the refusal can say THAT rather than mislabel it as a seat limit.
/// 3. `current_members + 1 <= allowance` → `Allow`; else `Refuse`.
///
/// **There is no invitation term, and there was one (FIX_ROUND-4, R4-6).** A `pending`
/// field survived the withdrawal of the advisory mint check as a parameter nothing ever
/// set: its only caller passed a literal `0`, its message branch was unreachable, its only
/// test pinned a branch production could not reach, and the generated spec promised clients
/// a key documented as "always 0 today". A field the wire advertises and no code path can
/// produce is worse than no field — it invites a client to branch on a value that never
/// varies. Removed. If a hold-aware check ever returns, it comes back with its producer.
///
/// **The boundary is `current < allowance`.** An allowance of N admits the Nth member and
/// refuses the (N+1)th. TEST-3 asserts N-1/N/N+1 so an off-by-one in either direction
/// fails rather than being absorbed.
///
/// **NO EVICTION — read this before "fixing" the `>` case.** An account can legitimately
/// sit ABOVE its allowance: a limit was introduced (this item), or lowered, or a `premium`
/// comp was cleared. This function REFUSES THE NEXT ADD and never removes anybody; there
/// is deliberately no code path here or in `account::seat` that deletes a membership. The
/// limit gates NEW memberships only. Turning this into an eviction would silently revoke
/// tenant-wide access from existing members, which no operator asked for.
pub fn decide_seat(i: &SeatInputs) -> SeatVerdict {
    if i.premium {
        return SeatVerdict::Allow;
    }
    let Some(limit) = i.member_allowance else {
        return SeatVerdict::UnknownPlan {
            plan_id: i.plan_id.clone(),
            current: i.current_members,
        };
    };
    if i.current_members < limit {
        return SeatVerdict::Allow;
    }
    SeatVerdict::Refuse {
        plan_id: i.plan_id.clone(),
        limit,
        current: i.current_members,
    }
}

/// Turn a [`SeatVerdict`] into the caller's outcome: `Allow` → `Ok(())`, `Refuse` →
/// **422** `SEAT_LIMIT_REACHED` carrying `plan_id`/`limit`/`current` in `details`.
///
/// 422 (not 402/403): the request is well-formed and the caller is authorized — the
/// account's state makes it unprocessable. That is the same class as `LAST_OWNER` and
/// `PERSONAL_ACCOUNT_NOT_MANAGEABLE`, this module's two existing membership-integrity
/// refusals, and it is what issue #141 specifies.
///
/// The three numbers are structured `details`, not prose, so #149 can render a concrete
/// upgrade path ("7 of 5 seats used on plan `free`") without parsing a message. `details`
/// is serialized onto the wire by `ziee_core::error`'s `IntoResponse`.
pub fn map_seat_verdict(verdict: SeatVerdict) -> Result<(), AppError> {
    match verdict {
        SeatVerdict::Allow => Ok(()),
        SeatVerdict::UnknownPlan { plan_id, current } => {
            // An operator-config error, not a tenant condition — logged as well as returned,
            // because an account frozen for membership is a support incident and the only
            // other record of it would be the client's response body (R3-5).
            tracing::error!(
                %plan_id,
                "seat check: the account's plan_id names no catalog tier — membership adds \
                 are REFUSED (fail-closed) until the plan is corrected or the account is \
                 comped"
            );
            Err(AppError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                crate::modules::account::seat::SEAT_PLAN_UNKNOWN,
                format!(
                    "this account's plan `{plan_id}` is not in the plan catalog, so its seat \
                     allowance cannot be determined and members cannot be added. This is a \
                     configuration problem, not a plan limit: set the account to a catalog \
                     plan (or apply the admin comp override) rather than upgrading."
                ),
            )
            .with_details(serde_json::json!({
                "plan_id": plan_id,
                "current": current,
            })))
        }
        SeatVerdict::Refuse {
            plan_id,
            limit,
            current,
        } => {
            Err(AppError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                SEAT_LIMIT_REACHED,
                format!(
                    "this account is using {current} of its {limit} included seats on plan \
                     `{plan_id}` — upgrade the plan to add more members. (Platform \
                     staff: this limit binds the admin surface too by design; the operator \
                     override is the audited per-account comp flag, not a bypass — #141 \
                     DEC-10.)"
                ),
            )
            .with_details(serde_json::json!({
                "plan_id": plan_id,
                "limit": limit,
                // ALWAYS the member count — the same quantity `members_used` reports
                // (FIX_ROUND-1, F3).
                "current": current,
            })))
        }
    }
}

/// Resolve [`SeatInputs`] **on the caller's own connection** and decide.
///
/// `current_members` is supplied by the caller (`account::seat`) rather than taken here,
/// because `account_members` is the account module's table. It is counted on this same
/// connection, so it is as fresh as this read.
///
/// **`pub(crate)`, deliberately narrowed (FIX_ROUND-1, F9.)** The count is a parameter, so a
/// caller that passed a stale or fabricated number would defeat INV-6 silently. Keeping this
/// crate-private means the reachable caller is exactly ONE — `account::seat::
/// enforce_member_seat` — which a reader can enumerate; a `pub` seam here would be an
/// unbounded set. (It said "the two in `account::seat`" until the advisory mint check was
/// withdrawn: FIX_ROUND-5, R5-5.) The alternative
/// — counting inside this function — was rejected because it would put `account`-owned
/// tables in the `billing` module's SQL.
///
/// **`&mut PgConnection`, never `&PgPool` — this is the whole TOCTOU argument.** The two
/// reads below must observe the same snapshot as the INSERT they guard, and the caller has
/// already taken `lock_account_row` on this connection, which serializes every membership
/// mutation on this account. A pooled read would run on a different connection and outside
/// that lock.
///
/// **A read error PROPAGATES; it does not fail open (#141 DEC-9).** This deliberately
/// differs from `jobs::quota`'s DEC-1 fail-open, and the difference is structural, not a
/// preference: `jobs::quota` reads on a pool, so a transient blip is independent of the
/// job being created. This reads on the caller's transaction — if it errors, that
/// transaction is already failed, so swallowing the error would let execution reach the
/// INSERT and fail there with a `25P02` from the wrong statement, aborting the caller's
/// whole unit of work. Propagating keeps the property that this guard's refusals leave the
/// caller's transaction usable.
///
/// **`accounts.admin_suspended` is deliberately NOT read here — #235, #141 DEC-6.** See
/// `account::seat`, which carries the full argument and marks the insertion point.
pub(crate) async fn enforce_on(
    conn: &mut PgConnection,
    account_id: Uuid,
    current_members: i64,
) -> Result<(), AppError> {
    // The plan key. `accounts.plan_id` is NOT NULL DEFAULT 'free', so a resolvable account
    // always has one; a missing ROW means the account does not exist, which the caller's
    // `lock_account_row` has already refused with 404 — so `None` here is unreachable in
    // practice and is treated as an unknown plan (fail closed) rather than as unlimited.
    // A missing ROW means the account does not exist. `lock_account_row` has already
    // refused that with 404 and holds the row for the rest of the transaction, so this is
    // unreachable — but it is answered as 404 rather than collapsed into `plan_id = ""`
    // (FIX_ROUND-1, F11). The first version used `unwrap_or_default()`, which would have
    // put an empty `plan_id` and a nonsense "0 included seats" message on the wire for a
    // state that is not a seat problem at all.
    let plan_id = sqlx::query_scalar!(r#"SELECT plan_id FROM accounts WHERE id = $1"#, account_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)?
        .ok_or_else(|| AppError::not_found("Account"))?;

    // The #39 comp. Absent row ⇒ `false`, matching `billing::repository::quota_override`'s
    // `unwrap_or_default` — so every account that has never been comped is byte-unaffected.
    let premium = sqlx::query_scalar!(
        r#"SELECT premium FROM account_quota_override WHERE account_id = $1"#,
        account_id,
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(AppError::database_error)?
    .unwrap_or(false);

    map_seat_verdict(decide_seat(&SeatInputs {
        member_allowance: catalog::allowance_of(&plan_id).map(|a| a.member_allowance),
        plan_id,
        premium,
        current_members,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(plan: &str, allowance: Option<i64>, current: i64, premium: bool) -> SeatInputs {
        SeatInputs {
            plan_id: plan.to_string(),
            member_allowance: allowance,
            premium,
            current_members: current,
        }
    }

    // TEST-3 [acceptance, INV-6] [covers: ITEM-3, ITEM-11]: the pure truth table, no DB.
    #[test]
    fn decide_seat_truth_table_and_boundary() {
        // The boundary, asserted at N-1 / N / N+1 so an off-by-one in EITHER direction
        // fails rather than being absorbed by a one-sided assertion.
        let n = 5;
        assert_eq!(
            decide_seat(&inputs("free", Some(n), n - 1, false)),
            SeatVerdict::Allow,
            "allowance N admits the Nth member (current = N-1)"
        );
        assert_eq!(
            decide_seat(&inputs("free", Some(n), n, false)),
            SeatVerdict::Refuse {
                plan_id: "free".into(),
                limit: n,
                current: n,
            },
            "allowance N refuses the (N+1)th member (current = N)"
        );

        // NO EVICTION: an account already ABOVE the limit is refused a NEW add and is
        // otherwise untouched — this function has no arm that removes anybody.
        assert_eq!(
            decide_seat(&inputs("free", Some(n), n + 3, false)),
            SeatVerdict::Refuse {
                plan_id: "free".into(),
                limit: n,
                current: n + 3,
            },
            "already over the limit: refuse the next add, evict nobody"
        );

        // Unknown plan → fail CLOSED (DEC-9), not unlimited.
        assert_eq!(
            decide_seat(&inputs("no-such-plan", None, 0, false)),
            SeatVerdict::UnknownPlan {
                plan_id: "no-such-plan".into(),
                current: 0,
            },
            "an unknown plan refuses rather than admitting an unbounded account — and does \
             so as its OWN verdict, so the refusal can name the real remedy (FIX_ROUND-3)"
        );

        // ITEM-11 / DEC-4: `premium` comps seats — at the limit, above it, and even on an
        // unknown plan (it is consulted first).
        for (allowance, current) in [(Some(n), n), (Some(n), n + 10), (None, 999)] {
            assert_eq!(
                decide_seat(&inputs("free", allowance, current, true)),
                SeatVerdict::Allow,
                "premium comps the seat limit (allowance {allowance:?}, current {current})"
            );
        }
    }

    // NOTE (FIX_ROUND-1, F6): a unit test here called
    // `allowances_come_from_the_catalog_not_from_this_module` was DELETED rather than
    // repaired. It fed `plan("free").member_allowance` into `decide_seat` and asserted the
    // same number came back — but `decide_seat` takes the allowance as an INPUT and echoes
    // it, so the assertion held for any implementation and for any catalog value. Its own
    // doc claimed "if this module ever hardcoded a limit, one of these two would disagree
    // with the catalog", which was false: the only catalog wiring is `allowance_of` inside
    // `enforce_on`, which that test never called.
    //
    // The claim IS proven, one layer up and against a real database: TEST-6 fills an account
    // to `catalog::plan("free").member_allowance` and asserts the refusal's `details.limit`
    // equals that same catalog value, through the real HTTP route. A hardcoded limit in
    // `enforce_on` turns THAT red. A tautology that cannot fail is worse than no test,
    // because it reads as coverage.

    // FIX_ROUND-4 R4-6: the unit test `pending_is_charged_against_the_limit_but_reported_
    // separately` was DELETED with the field it tested. It was honest and non-tautological,
    // but it was the only test of a branch no production path could reach, and keeping it
    // was what kept an unreachable message branch and an unproducible wire key alive. The
    // rule it enforced — `current` always means the MEMBER count — survives in TEST-4 below
    // and in `map_seat_verdict`'s own doc.

    // TEST-4 [acceptance, INV-2] [covers: ITEM-3]: the refusal VALUE — status, code, and the
    // numbers, asserted through the SERIALIZED body so a `details` field that never reaches
    // the wire fails (mirrors ziee-core's own
    // `with_details_attaches_and_serializes_details`).
    //
    // FIX_ROUND-2 R2-6: this label had drifted onto the test ABOVE, which serializes nothing
    // and asserts no status or code. An acceptance id pointing at the wrong assertion is a
    // false certification, so it is moved back onto the test that does what it describes.
    #[test]
    fn seat_refusal_carries_plan_limit_and_current_on_the_wire() {
        assert!(map_seat_verdict(SeatVerdict::Allow).is_ok());

        let err = map_seat_verdict(SeatVerdict::Refuse {
            plan_id: "pro".into(),
            limit: 50,
            current: 50,
        })
        .expect_err("refuse → err");

        assert_eq!(err.status_code(), 422);
        assert_eq!(err.error_code(), SEAT_LIMIT_REACHED);

        let body = serde_json::to_value(&err).expect("AppError serializes");
        assert_eq!(body["details"]["plan_id"], "pro");
        assert_eq!(body["details"]["limit"], 50);
        assert_eq!(body["details"]["current"], 50);

        // The numbers must come from the VERDICT, not be re-derived: a refusal built with
        // one account's numbers must not report another's.
        let other = map_seat_verdict(SeatVerdict::Refuse {
            plan_id: "free".into(),
            limit: 5,
            current: 7,
        })
        .expect_err("refuse → err");
        let other_body = serde_json::to_value(&other).expect("AppError serializes");
        assert_eq!(other_body["details"]["plan_id"], "free");
        assert_eq!(other_body["details"]["limit"], 5);
        assert_eq!(other_body["details"]["current"], 7);
        assert!(
            other_body["details"].get("pending").is_none(),
            "no `pending` key: the field was removed with the mint check that produced it \
             (FIX_ROUND-4, R4-6), so the wire must not advertise it"
        );

        // FIX_ROUND-3 R3-3: an unknown plan is a DIFFERENT refusal with a DIFFERENT code, so
        // a client (and an operator reading a log) can tell "you are at your limit, upgrade"
        // from "this account's plan is not a real plan, fix the config".
        let unknown = map_seat_verdict(SeatVerdict::UnknownPlan {
            plan_id: "retired-tier".into(),
            current: 3,
        })
        .expect_err("unknown plan → err");
        assert_eq!(unknown.status_code(), 422);
        assert_ne!(
            unknown.error_code(),
            SEAT_LIMIT_REACHED,
            "an operator config error must not be reported as a tenant hitting its seat limit"
        );
        assert_eq!(
            unknown.error_code(),
            crate::modules::account::seat::SEAT_PLAN_UNKNOWN
        );
        let ub = serde_json::to_value(&unknown).expect("serializes");
        assert_eq!(ub["details"]["plan_id"], "retired-tier");
        assert_eq!(ub["details"]["current"], 3);
    }
}
