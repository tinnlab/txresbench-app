//! #146 — invitation ACCEPT: the authenticate-only redeemer extractor and the PURE
//! decision half of token redemption.
//!
//! `POST /api/account-invitations/accept { token }`. The transactional half — the five
//! ordered steps — lives in `AccountRepository::accept_invitation`; everything here is
//! either an extractor or a pure function, for the reason `member_scope.rs` splits the
//! same way: the rules that matter are unit-testable directly, and a pure twin of a rule
//! enforced elsewhere is the only way to test the RULE rather than its transcription.
//!
//! # Why this route is authenticated but NOT account-scoped
//!
//! The redeemer is **by definition not yet a member**, so [`AccountScope`] cannot gate
//! them — it 404s a non-member by design, which is exactly what an invitee is. The TOKEN
//! is the capability. `routes.rs` reserved this path and said so before this item existed.
//!
//! It also carries **no permission** (#146 DEC-1). Gating it on `account::read` or on
//! `account::members::manage` would reintroduce #232's failure in a worse form: an
//! operator turning self-service OFF would strand every holder of a live token OUTSIDE
//! the account, with no route in at all — whereas #232's victims were at least already
//! inside. The two-factor model of `member_scope.rs` does not apply here because factor
//! (b), the account role, is precisely what the caller does not yet have.
//!
//! # RATE LIMITING — deliberately NOT built here, and why (#146 DEC-10, #249)
//!
//! Recorded in the PRODUCT tree rather than in a lifecycle artifact, for the reason
//! `routes.rs`'s "#145 OBLIGATIONS CARRIED FORWARD" block gives: `.lifecycle/` is stripped at
//! merge, and that is exactly how an obligation gets lost.
//!
//! Research §4.5 asks for one: *"Accept is a token endpoint: per-IP and per-user rate limits,
//! or the 256-bit token is the only thing between an attacker and a membership."*
//!
//! **Per-IP is PARTLY covered, deployment-level:** `apply_rate_limit_layer` (tower-governor)
//! wraps the whole API router, so this route inherits it wherever `server.rate_limit` is
//! configured. Three caveats, stated because the first version of this note gave only two and
//! a round-4 security angle supplied the third (FIX_ROUND-4, S4-3): it is `None` by default on
//! the desktop/embedded path; an operator can disable it outright; and its key extractor is
//! `PeerIpKeyExtractor`, i.e. the SOCKET peer — so behind a reverse proxy every caller shares
//! one bucket and per-IP throttling of this route is effectively per-DEPLOYMENT, which is
//! either useless or a self-inflicted denial of service. Do not read "per-IP is covered" as
//! more than "a global request ceiling exists where one is configured".
//!
//! **Per-USER is NOT built.** The threat is token GRINDING, and the token is 256 bits from
//! `OsRng` looked up by SHA-256 — the search space is not reachable by online guessing, so a
//! per-user budget is defence in depth rather than the control. Building one needs an attempt
//! counter table (a migration) and a new security-relevant mechanism, which is a reviewable
//! item of its own rather than a rider on redemption; #146's acceptance checklist deliberately
//! does not carry it. **Filed as #249.** Whoever builds it must make the refusal
//! indistinguishable in the same way the redemption refusals are — a "you are rate limited"
//! that arrives only after a valid-SHAPED token would tell a grinder they were close, which is
//! the oracle INV-9 closes.
//!
//! [`AccountScope`]: super::member_scope::AccountScope

use std::sync::Arc;

use aide::OperationIo;
use axum::extract::FromRequestParts;
use axum::http::{request::Parts, StatusCode};
use uuid::Uuid;

use txresbench_auth::auth::DefaultIdentityResolver;
use txresbench_core::AppError;
use txresbench_framework::permissions::IdentityResolver;

use super::invitation_token::normalize_email;
use super::models::AccountRole;
use super::repository::{ActorCeiling, ROLE_ABOVE_ACTOR};

/// The ONE refusal every invalid-token case answers with (#146 INV-9).
///
/// Named so tests and clients bind BY NAME: 404 is produced by three different causes on
/// this module's surface (`INVALID_INVITATION`, `Account`, `Invitation`), so the status
/// alone does not identify the refusal.
pub const INVALID_INVITATION: &str = "INVALID_INVITATION";

/// The single fixed message. A `const` and not an inline literal per branch, for the same
/// structural reason `INVITATION_SENT_STATUS` is one: INV-9 requires the body to be
/// byte-identical across five different causes, and the only way to make that true by
/// construction rather than by care is to have exactly one place it can come from.
const INVALID_INVITATION_MESSAGE: &str =
    "that invitation link is not valid. It may have expired, been withdrawn, already been \
     used, or been sent to a different address.";

/// **THE** generic redemption refusal — wrong token / expired / already accepted / revoked
/// / email mismatch, all five (#146 INV-9, research §4.5 step 1: *"Any miss → one generic
/// `404 INVALID_INVITATION`, byte-identical for wrong / expired / already-used / revoked.
/// Never distinguish them; the difference is exactly what a token grinder wants."*).
///
/// # Why one constructor and not five call sites returning the same literal
///
/// Five literals are five chances to drift, and the drift is invisible: a distinguishing
/// word added to one of them still returns 404, still passes any test that compares status
/// codes, and hands a token grinder the oracle the whole design exists to close. With one
/// constructor the property is structural — there is nothing to keep in step.
///
/// # Why the body really is byte-stable
///
/// `AppError::new` attaches **no** `details`. Only `database_error` / `internal_error`
/// embed a `trace_id`, and neither is reachable from a redemption miss. So the serialized
/// body is a function of the status, the code and this message alone, all three constant.
/// TEST-3 asserts that in-process; TEST-4 asserts it over the wire, on RAW response text.
///
/// # It deliberately says nothing true only sometimes
///
/// The message enumerates FOUR possible causes and commits to none, including the one that
/// is not a token problem at all (the address does not match). A message that named the
/// actual cause would be friendlier and would be the oracle.
pub fn invalid_invitation() -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        INVALID_INVITATION,
        INVALID_INVITATION_MESSAGE,
    )
}

/// Collapse an ABSENT-account refusal into the generic one — and let everything else through
/// UNCHANGED (#146; FIX_ROUND-1 R1-1, made unit-testable in FIX_ROUND-2 R2-10).
///
/// `AccountRepository::lock_account_row` answers a missing `accounts` row with
/// `404 Account`. Reached from the accept path that means the invitation is gone too
/// (`account_invitations.account_id` is `ON DELETE CASCADE`), which IS a token miss from the
/// caller's side — so returning a differently-shaped 404 there would be an INV-9 leak on a
/// path a caller can reach by racing an account deletion.
///
/// **What it must NOT do is swallow the rest.** The first version was
/// `map_err(|_| invalid_invitation())`, which discarded the error VALUE: a `database_error`
/// (a 500 carrying the `trace_id` an operator alerts on) and a deadlock-victim abort both
/// became "that invitation link is not valid", telling a legitimate invitee their valid token
/// was permanently dead and destroying the only diagnostic. Three blind angles reported it.
///
/// It is a FUNCTION rather than an inline closure so the discrimination is unit-testable:
/// the 404 arm is unreachable in production (the CASCADE closes it) and the 500 arm needs a
/// database fault to provoke, so neither half can be driven through the route. A round-2
/// audit observed that reverting the fix left the whole suite green; this is what makes that
/// revert go red.
pub fn collapse_absent_account(err: AppError) -> AppError {
    if err.status_code() == StatusCode::NOT_FOUND.as_u16() {
        invalid_invitation()
    } else {
        err
    }
}

/// Does the redeeming user's stored address bind to the invitation's? (#146 step 2,
/// research §4.5 step 2.)
///
/// Both sides go through #145's [`normalize_email`] — the READ-side rule (`lower(trim(…))`
/// and nothing else), NOT `validate_invitation_email`. That choice is load-bearing and is
/// argued at length on `normalize_email` itself: `POST /api/auth/register` stores an
/// address as free text, so `users.email` can hold shapes the WRITE rule refuses
/// (`bob@localhost`, a single-label domain). Validating here would 400 an invitee on their
/// OWN address and they could never redeem anything.
///
/// The invitation side is already normalized at write time, so re-normalizing it is a
/// no-op that costs one allocation and removes a dependency on that remaining true.
///
/// # RESIDUAL RISK — this is containment, not proof of identity (#143)
///
/// **Emails are never verified for password registration in this codebase.**
/// `users.email_verified` exists (`txresbench-auth`'s `202607140050_auth_schema.sql`) and is set
/// by OAuth provisioning, but there is no verification flow for a password signup, and
/// `users_email_key` is a **case-sensitive** UNIQUE index — so two distinct principals can
/// differ only by case and both satisfy this binding.
///
/// **And it is defeated OUTRIGHT by a case-variant registration — #251** (FIX_ROUND-1, R1-6,
/// found by a blind security audit). Because `users_email_key` is case-SENSITIVE and
/// registration is open and unverified, an attacker holding a leaked link for
/// `bob@corp.com` can register `BOB@corp.com` as a fresh principal and satisfy this binding.
/// That is a stronger statement than "emails are unverified" and it is stated separately so
/// nobody reads the paragraph above as though the control merely had a soft edge.
///
/// Every in-item remedy was worse and each was tried on paper: refusing when two rows
/// normalize alike fails closed and hands the attacker a denial of service against the real
/// invitee; requiring `email_verified` makes every password-registered invitee unable to
/// redeem; binding on a user id is not expressible, since the invitee may have no account
/// yet — which is the whole signup-then-accept case. The fix is a case-insensitive uniqueness
/// rule on `users.email`, which lives in the pinned `txresbench-auth` submodule. **#251.**
///
/// What this control therefore *is*: containment against a leaked invite link reaching the
/// wrong **logged-in tab** — the realistic accident, where someone forwards a link and the
/// recipient is already signed in as themselves. What it is **not**: evidence that the
/// redeemer controls that mailbox. Nothing downstream may treat a redeemed invitation as
/// proof of email ownership. **#143 owns the verification gap and #251 the case-variant
/// bypass**; consulting `email_verified` here was considered and refused (#146 DEC-8)
/// because it would make every password-registered invitee unable to redeem, i.e. it would
/// break the primary signup-then-accept flow this item exists to support.
pub fn emails_bind(user_email: &str, invitation_email: &str) -> Result<bool, AppError> {
    Ok(normalize_email(user_email)? == normalize_email(invitation_email)?)
}

/// What the accept transaction found when it re-read the inviter, **now** (#146 step 3).
///
/// Three variants and not `Option<AccountRole>`, because the three are genuinely different
/// facts and the third one is a trap. `models.rs` warns about it in terms:
/// `account_invitations.invited_by` is **nullable** — `create_invitation` maps
/// `ActorCeiling::PlatformStaff` to a NULL inviter — and *"an author told this state cannot
/// exist will unwrap it or silently fold it into 'the inviter lost standing'."* Folding it
/// is what this enum makes impossible: the caller must name which of the three it observed,
/// and each gets its own refusal message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviterStanding {
    /// `invited_by IS NULL` — the row records no inviter at all.
    ///
    /// Not reachable through any shipped route today (`create_invitation`'s only caller
    /// passes `ActorCeiling::SelfService`), but reachable through the repository API, and
    /// it is what a future staff-minted invitation would look like.
    NoRecordedInviter,
    /// The recorded inviter is no longer a member of this account.
    NotAMember,
    /// The recorded inviter is still a member, at this LIVE role — re-read inside the
    /// accept transaction, never taken from the invitation row or from anything cached at
    /// mint time.
    ///
    /// It carries the inviter's `user_id` as well as their role so that
    /// [`refuse_unless_inviter_still_entitled`] can MINT the [`ActorCeiling`] itself. That
    /// is the same argument [`ActorCeiling::audit_actor`] makes: a function that grades an
    /// authority and then leaves its caller to assemble the value representing that
    /// authority admits "graded one thing, passed another". Here the graded value IS the
    /// returned value, so the two cannot disagree — and the caller needs no `unwrap` to
    /// recover an id the `Ok` arm structurally guarantees.
    Member { user_id: Uuid, role: AccountRole },
}

/// What the refusal's server-side record carries: the arm that fired, and the inviter it is
/// about (FIX_ROUND-4, TQ4-5).
///
/// A separate, pure function so the compensating control is TESTABLE. Collapsing the four
/// refusals into one body (FIX_ROUND-2, R2-1) was justified by "the arm identity is not lost,
/// it is logged" — and a round-4 audit pointed out that claim was asserted nowhere, which is
/// the same "protected by a comment" shape this item has now corrected three times. This
/// makes the CONTENT of that record a value a unit test can read, without needing to capture a
/// `tracing` subscriber.
///
/// `inviter` is `None` for the two standings that name no principal — there is genuinely
/// nobody to attribute, and writing a placeholder would be worse than writing nothing.
pub fn refusal_log_fields(
    standing: InviterStanding,
    arm: &'static str,
) -> (&'static str, Option<Uuid>) {
    match standing {
        InviterStanding::Member { user_id, .. } => (arm, Some(user_id)),
        InviterStanding::NoRecordedInviter | InviterStanding::NotAMember => (arm, None),
    }
}

/// **The TOCTOU rule** (#146 INV-6, research §4.5 step 3, verbatim): *"Re-read
/// `membership_role(account_id, invited_by)` now and refuse if the inviter no longer
/// satisfies `Admin` or no longer outranks `invitation.role`. Without this, an Owner issues
/// an owner-invite, is demoted to Member, and the invitee still becomes an Owner days
/// later. This is the invitation bug people ship."*
///
/// The pure twin of the live re-read in `AccountRepository::accept_invitation`, which is
/// where the `SELECT` lives. The two must be kept in step; that function's doc names this
/// one so a reader of either finds the other.
///
/// # The comparison is `>=`, on both halves
///
/// "satisfies `Admin`" is `role.allows(Admin)`, and "outranks `invitation.role`" is
/// `role >= invitation.role` — an Owner may confer `owner`, an Admin may confer `admin`.
/// That is the same strictness `refuse_if_above_ceiling` uses (`>` refuses, so equal is
/// allowed) and it is what makes an Owner able to invite a co-Owner at all.
///
/// # Why a 403 and not the generic 404
///
/// #146: *"distinguishable from the token-miss 404 is fine here — the caller already proved
/// they hold a valid token, so there is nothing left to enumerate."* The code is
/// `ROLE_ABOVE_ACTOR`, the same one R-1 uses, because it is the same rule: a role may not be
/// conferred by someone who does not hold it.
///
/// # `NoRecordedInviter` fails CLOSED, deliberately
///
/// An invitation with no recorded inviter has **no authority to re-verify**, and this
/// item's entire premise is that the grant's authority must be live at redemption. Letting
/// it through would mean the one case that cannot be checked is the one case that is not
/// checked. It is also the only outcome the audit ledger can express honestly: the `joined`
/// row's actor is derived from the ceiling (`ActorCeiling::audit_actor`), and there is no
/// actor here to derive one from.
pub fn refuse_unless_inviter_still_entitled(
    standing: InviterStanding,
    invited_role: AccountRole,
) -> Result<ActorCeiling, AppError> {
    // ONE body for all four refusing arms (FIX_ROUND-2, R2-1), and the reason is the same
    // structural one that makes `invalid_invitation` a single constructor.
    //
    // FIX_ROUND-1 removed the interpolated role ("their role is now `member`") and a
    // round-2 blind security angle showed that did not close the disclosure, only obscure
    // it: the four bodies were in BIJECTION with the inviter's live standing. Given
    // `member < admin < owner`, the "no permission" arm fires iff the live role is exactly
    // `member`; the "above what its sender can grant" arm fires iff it is exactly `admin`
    // AND named `invited_role` in the same breath; "no longer a member" says removed; and a
    // 201 says `live >= invited_role`. A caller who is NOT a member of that account could
    // read a named third party's exact current role off the response text — including
    // org-chart churn, by anyone ever invited.
    //
    // The four messages already ended with the same advice, so collapsing them costs the
    // reader nothing actionable. The arm identity is not lost: it is LOGGED, server-side,
    // together with the inviter it is about, where an operator can see it and a token holder
    // cannot. `tests::toctou_refusals_are_one_constant_body` pins the
    // constancy, which is a stronger and more checkable property than the distinguishability
    // it replaced.
    const REFUSAL: &str = "this invitation can no longer be honoured \u{2014} the authority that issued it no longer holds it. Ask someone who manages that account to send you a new one.";
    // The arm identity and the inviter it is about are LOGGED (FIX_ROUND-3, C3-5). The
    // response says only that the invitation cannot be honoured; the server-side record says
    // WHICH of the four reasons and WHO the inviter was, which is what an operator answering
    // "why can nobody redeem my invitations" needs. It carries no account or invitation id —
    // this function is pure and holds neither; the caller's own error path logs at the
    // request level.
    let refuse = |arm: &'static str| {
        let (arm, inviter) = refusal_log_fields(standing, arm);
        tracing::info!(
            arm,
            ?inviter,
            invited_role = invited_role.as_str(),
            "invitation accept refused: the inviter no longer has the standing to confer this role"
        );
        Err(AppError::forbidden(ROLE_ABOVE_ACTOR, REFUSAL))
    };
    match standing {
        InviterStanding::NoRecordedInviter => refuse("no_recorded_inviter"),
        InviterStanding::NotAMember => refuse("inviter_not_a_member"),
        InviterStanding::Member { role: live, .. } if !live.allows(AccountRole::Admin) => {
            refuse("inviter_below_admin_floor")
        }
        InviterStanding::Member { role: live, .. } if live < invited_role => {
            refuse("inviter_no_longer_outranks_invited_role")
        }
        // The inviter still holds the authority the invitation needs, so the membership
        // INSERT is graded against THEM — `add_member_in_tx` re-reads this same role live on
        // this same transaction (`resolve_ceiling`'s `min(observed, live)` of a value read
        // moments ago, which cannot disagree) and derives the audit actor from it, so the
        // `joined` ledger row names the inviter: "who granted whom what" (research §8).
        InviterStanding::Member { user_id, role } => Ok(ActorCeiling::SelfService {
            actor_user_id: user_id,
            observed_role: role,
        }),
    }
}

/// The authenticated caller of a route that is **authenticated but not account-scoped**
/// (#146 DEC-1).
///
/// Authenticates through the SAME app-installed `Arc<DefaultIdentityResolver>` that
/// `RequirePermissions`, `ActiveAccount` and `AccountScope` use, and stops there: 401 if
/// authentication fails, 500 if the resolver is not installed (a server wiring bug, never
/// the caller's fault). **No capability is checked** — see the module doc.
///
/// It yields the user id ONLY. The caller's email is deliberately NOT carried here: the
/// binding reads `users.email` inside the accept transaction (#146 DEC-9), for the reason
/// `resolve_ceiling` re-reads the role — a value resolved before the transaction opened is
/// a snapshot, and the design says *"the authenticated user's `users.email`"*.
///
/// `#[aide(input)]` so it is transparent to the OpenAPI schema — it is a request-context
/// extractor, not a body, and INV-18 requires the operation to declare no parameter that
/// could carry the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, OperationIo)]
#[aide(input)]
pub struct InvitationRedeemer {
    pub user_id: Uuid,
}

impl FromRequestParts<()> for InvitationRedeemer {
    type Rejection = (StatusCode, AppError);

    fn from_request_parts(
        parts: &mut Parts,
        _state: &(),
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            let resolver = parts
                .extensions
                .get::<Arc<DefaultIdentityResolver>>()
                .cloned()
                .ok_or_else(|| {
                    AppError::internal_error("Identity resolver not configured").to_api_error()
                })?;
            let user = resolver.authenticate(parts).await?;
            Ok(InvitationRedeemer { user_id: user.id })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The design's stated order, hardcoded — deliberately NOT `AccountRole`'s `Ord`.
    ///
    /// Same discipline as `repository.rs`'s `role_ceiling_truth_table`: an expectation
    /// computed from the implementation's own comparison operator moves in lockstep with it
    /// and can only ever catch a typo. Re-deriving the rank here means an INVERTED or
    /// reordered `Ord` derive on `AccountRole` turns cells red instead of passing silently
    /// through both sides of the comparison.
    fn rank(r: AccountRole) -> u8 {
        match r {
            AccountRole::Member => 0,
            AccountRole::Admin => 1,
            AccountRole::Owner => 2,
        }
    }

    const ROLES: [AccountRole; 3] = [
        AccountRole::Member,
        AccountRole::Admin,
        AccountRole::Owner,
    ];

    /// One stable synthetic inviter id — the grader never dereferences it, and a
    /// distinctive constant is greppable if it ever shows up somewhere it should not.
    const INVITER: Uuid = Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0146);

    fn member(role: AccountRole) -> InviterStanding {
        InviterStanding::Member {
            user_id: INVITER,
            role,
        }
    }

    // TEST-1 [covers: ITEM-3, ITEM-7] — the TOCTOU truth table over the PURE grader, all
    // 15 cells: {NoRecordedInviter, NotAMember, Member(member), Member(admin),
    // Member(owner)} x {member, admin, owner} invited role.
    //
    // The expectation is re-derived from the design's WORDS — "refuse if the inviter no
    // longer satisfies Admin or no longer outranks invitation.role" — over the independent
    // `rank` above, plus the two non-member standings which fail closed.
    #[test]
    fn toctou_truth_table() {
        let standings = {
            let mut v = vec![
                InviterStanding::NoRecordedInviter,
                InviterStanding::NotAMember,
            ];
            v.extend(ROLES.map(|role| InviterStanding::Member {
                user_id: INVITER,
                role,
            }));
            v
        };

        let mut refused = 0usize;
        let mut allowed = 0usize;
        let mut cells = 0usize;
        for standing in standings {
            for invited in ROLES {
                cells += 1;
                // The rule, from the design's words, over an independent rank.
                let want_refusal = match standing {
                    InviterStanding::NoRecordedInviter | InviterStanding::NotAMember => true,
                    InviterStanding::Member { role: live, .. } => {
                        rank(live) < rank(AccountRole::Admin) || rank(live) < rank(invited)
                    }
                };
                let got = refuse_unless_inviter_still_entitled(standing, invited);
                assert_eq!(
                    got.is_err(),
                    want_refusal,
                    "standing={standing:?} invited={invited:?}"
                );
                match got {
                    Err(e) => {
                        assert_eq!(e.status_code(), 403, "the TOCTOU refusal is a 403");
                        assert_eq!(
                            e.error_code(),
                            ROLE_ABOVE_ACTOR,
                            "…and carries ROLE_ABOVE_ACTOR by name, not merely a status"
                        );
                        refused += 1;
                    }
                    Ok(ceiling) => {
                        // The returned ceiling must BE the graded standing — same actor,
                        // same role — and must never be the PlatformStaff bypass.
                        match (ceiling, standing) {
                            (
                                ActorCeiling::SelfService {
                                    actor_user_id,
                                    observed_role,
                                },
                                InviterStanding::Member { user_id, role },
                            ) => {
                                assert_eq!(actor_user_id, user_id, "the ceiling names the inviter");
                                assert_eq!(
                                    observed_role, role,
                                    "…at the role that was graded, so the membership INSERT \
                                     is graded against the same authority this function checked"
                                );
                            }
                            other => panic!("unexpected ceiling/standing pair: {other:?}"),
                        }
                        allowed += 1;
                    }
                }
            }
        }
        assert_eq!(cells, 15, "5 standings x 3 invited roles");
        // Both arms populated — a grader stuck at "always Ok" or "always Err" would
        // otherwise satisfy a loop that only compares against itself.
        assert!(refused > 0 && allowed > 0, "{refused} refused / {allowed} allowed");
    }

    // TEST-1 (cont.) — the four refusing arms are ONE CONSTANT BODY (FIX_ROUND-2, R2-1).
    //
    // This test used to assert the OPPOSITE — that the messages were distinguishable, on the
    // reasoning that a specific message is kinder. A blind security angle showed the four
    // bodies were in bijection with the inviter's live standing, so a caller who is not a
    // member of the account could read a named third party's exact current role off the
    // response. The kinder message was a disclosure; the constancy is the invariant.
    #[test]
    fn toctou_refusals_are_one_constant_body() {
        let body = |s: InviterStanding, r: AccountRole| {
            let e = refuse_unless_inviter_still_entitled(s, r).unwrap_err();
            assert_eq!(e.status_code(), 403);
            assert_eq!(e.error_code(), ROLE_ABOVE_ACTOR);
            serde_json::to_string(&e).expect("serialize")
        };
        let arms = [
            body(InviterStanding::NoRecordedInviter, AccountRole::Member),
            body(InviterStanding::NotAMember, AccountRole::Member),
            body(member(AccountRole::Member), AccountRole::Member),
            body(member(AccountRole::Admin), AccountRole::Owner),
            // …and the same two arms reached with DIFFERENT invited roles, so the body cannot
            // vary with the caller's own invitation either.
            body(InviterStanding::NotAMember, AccountRole::Owner),
            body(member(AccountRole::Member), AccountRole::Owner),
        ];
        for (i, a) in arms.iter().enumerate().skip(1) {
            assert_eq!(
                a, &arms[0],
                "arm {i} differs from arm 0 — the four refusing arms are in bijection with \
                 the inviter's live standing, so ANY difference hands a non-member a read on \
                 a third party's current role"
            );
        }
        // And the one body names no role at all.
        for role in ["`member`", "`admin`", "`owner`", "member", "admin", "owner"] {
            assert!(
                !arms[0].contains(role),
                "the refusal must name no account role ({role}): {}",
                arms[0]
            );
        }
    }

    // TEST-1 (cont.) — the compensating control for the collapsed body is REAL: the
    // server-side record names which arm fired and which inviter it was about (FIX_ROUND-4,
    // TQ4-5). Without this the "the arm identity is not lost, it is logged" justification was
    // itself unasserted.
    #[test]
    fn the_refusal_record_names_the_arm_and_the_inviter() {
        assert_eq!(
            refusal_log_fields(member(AccountRole::Member), "inviter_below_admin_floor"),
            ("inviter_below_admin_floor", Some(INVITER)),
            "a Member standing must be attributable — this is what an operator answering \
             'why can nobody redeem my invitations' reads"
        );
        assert_eq!(
            refusal_log_fields(InviterStanding::NotAMember, "inviter_not_a_member"),
            ("inviter_not_a_member", None),
            "a removed inviter names no principal, and a placeholder would be worse than \
             nothing"
        );
        assert_eq!(
            refusal_log_fields(InviterStanding::NoRecordedInviter, "no_recorded_inviter"),
            ("no_recorded_inviter", None)
        );
        // …and the four arm names the production path uses are all distinct, so the record
        // really does distinguish the four cases the RESPONSE deliberately does not.
        let arms = [
            "no_recorded_inviter",
            "inviter_not_a_member",
            "inviter_below_admin_floor",
            "inviter_no_longer_outranks_invited_role",
        ];
        let src = {
            let whole = include_str!("accept.rs");
            &whole[..whole.find("#[cfg(test)]").expect("test module")]
        };
        for arm in arms {
            assert!(
                src.contains(arm),
                "the production path must actually emit the `{arm}` record — an arm name that \
                 exists only in this test distinguishes nothing"
            );
        }
        let mut sorted = arms;
        sorted.sort_unstable();
        let mut deduped = sorted.to_vec();
        deduped.dedup();
        assert_eq!(deduped.len(), arms.len(), "the four arm names must be distinct");
    }

    // TEST-1 (cont.) — the BOUNDARY, by name. `>=` on both halves, so an Owner may confer
    // `owner` and an Admin may confer `admin`; one rank lower on either half refuses.
    #[test]
    fn toctou_boundary_is_inclusive_on_both_halves() {
        assert!(
            refuse_unless_inviter_still_entitled(member(AccountRole::Owner), AccountRole::Owner)
                .is_ok(),
            "an Owner may still confer `owner` — R-4's two-step transfer depends on it"
        );
        assert!(
            refuse_unless_inviter_still_entitled(member(AccountRole::Admin), AccountRole::Admin)
                .is_ok(),
            "an Admin may still confer `admin`"
        );
        assert!(
            refuse_unless_inviter_still_entitled(member(AccountRole::Admin), AccountRole::Owner)
                .is_err(),
            "…but not `owner` — THE bug this item exists to close"
        );
        assert!(
            refuse_unless_inviter_still_entitled(member(AccountRole::Member), AccountRole::Member)
                .is_err(),
            "a demoted inviter fails the Admin floor even for the LOWEST role — the floor \
             and the outranking test are two independent halves, and dropping the floor \
             would let a bare member's stale invitation still create members"
        );
    }

    // TEST-2 [covers: ITEM-3, ITEM-6] — the email binding is `normalize_email` on BOTH
    // sides, and it is the READ-side (permissive) rule.
    #[test]
    fn email_binding_is_normalized_on_both_sides() {
        for (user, invited) in [
            ("alice@example.com", "alice@example.com"),
            ("ALICE@Example.COM", "alice@example.com"),
            ("  alice@example.com  ", "alice@example.com"),
            ("\tAlice@Example.com\r\n", "alice@example.com"),
            // The invitation side is already normalized at write time; binding must not
            // depend on that staying true.
            ("alice@example.com", "  ALICE@EXAMPLE.COM "),
        ] {
            assert!(
                emails_bind(user, invited).expect("bind"),
                "{user:?} must bind to {invited:?}"
            );
        }

        // The READ-side rule accepts what registration stored, even where the WRITE-side
        // validator would refuse it. Without this an invitee registered at such an address
        // could never redeem ANY invitation (FIX_ROUND-2 of #145 made the same correction).
        assert!(
            emails_bind("bob@localhost", "bob@localhost").expect("bind"),
            "an address the write-side validator refuses must still bind for its owner"
        );

        for (user, invited) in [
            ("alice@example.com", "bob@example.com"),
            ("alice@example.com", "alice@example.org"),
            ("alice@example.com", "alice+tag@example.com"),
            // No provider-specific canonicalization: dots in the local part are NOT
            // equivalent. Deliberate (see `normalize_email`) — an email is not an identity
            // here, and canonicalizing harder would only make the overclaim more convincing.
            ("al.ice@example.com", "alice@example.com"),
        ] {
            assert!(
                !emails_bind(user, invited).expect("bind"),
                "{user:?} must NOT bind to {invited:?}"
            );
        }

        // A blank on either side is a 400 from `normalize_email`, never a silent "binds".
        assert!(emails_bind("", "a@b.com").is_err());
        assert!(emails_bind("a@b.com", "   ").is_err());
    }

    // TEST-3 [covers: ITEM-3, ITEM-5] — the byte identity of the generic refusal, in
    // process. TEST-4 proves the same thing over the wire on raw response text; this one
    // proves it cannot vary at the SOURCE, which is the property that makes the wire test
    // meaningful rather than lucky.
    #[test]
    fn invalid_invitation_is_one_byte_stable_404() {
        let a = invalid_invitation();
        assert_eq!(a.status_code(), 404);
        assert_eq!(a.error_code(), INVALID_INVITATION);

        // `AppError` serializes its status, code, message and details — a strict superset
        // of what `IntoResponse` puts on the wire (`ApiError { error, error_code, details }`),
        // so identity here implies identity there, and a difference here would be a
        // difference there.
        let body_of = |e: AppError| serde_json::to_string(&e).expect("serialize");
        let first = body_of(invalid_invitation());
        let second = body_of(invalid_invitation());
        assert_eq!(
            first, second,
            "two independent constructions must serialize to identical bytes"
        );
        // No `details`, therefore no `trace_id` — the one field that WOULD vary per call.
        // `database_error`/`internal_error` attach one; this must not be built from either.
        assert!(
            !first.contains("trace_id"),
            "the generic refusal must carry no per-call field: {first}"
        );
        // And it names none of the five causes it stands for.
        let lowered = first.to_lowercase();
        for leak in ["revoked", "accepted", "mismatch", "not found for", "email address is"] {
            assert!(
                !lowered.contains(leak),
                "the generic refusal must not hint at WHICH cause fired ({leak}): {first}"
            );
        }
    }

    // TEST-3 (cont.) [covers: ITEM-5] — the absent-account collapse discriminates
    // (FIX_ROUND-2, R2-10). Both of its arms are unreachable through the route — the 404 arm
    // is closed by `ON DELETE CASCADE`, the 500 arm needs a database fault — so this is the
    // only place the rule can be exercised at all.
    #[test]
    fn collapse_absent_account_takes_only_the_404() {
        // The one arm that IS collapsed: an absent account is a token miss.
        let collapsed = collapse_absent_account(AppError::not_found("Account"));
        assert_eq!(collapsed.status_code(), 404);
        assert_eq!(collapsed.error_code(), INVALID_INVITATION);
        assert_eq!(
            serde_json::to_string(&collapsed).expect("serialize"),
            serde_json::to_string(&invalid_invitation()).expect("serialize"),
            "…and it is byte-identical to every other miss (INV-9)"
        );

        // Everything else passes through UNCHANGED — value and all.
        for original in [
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                "connection reset",
            )
            .with_details(serde_json::json!({ "trace_id": "abc-123" })),
            AppError::forbidden(ROLE_ABOVE_ACTOR, "nope"),
            AppError::conflict("Membership"),
        ] {
            let before = serde_json::to_string(&original).expect("serialize");
            let after = serde_json::to_string(&collapse_absent_account(original)).expect("serialize");
            assert_eq!(
                before, after,
                "a non-404 must survive VERBATIM — flattening a 500 into the generic 404 \
                 tells a legitimate invitee their valid token is dead and destroys the \
                 trace_id an operator alerts on"
            );
        }
    }

    // TEST-19 [covers: ITEM-16] — the email-binding residual risk is recorded in a code
    // comment naming #143, and the accept path does not claim the binding proves identity.
    //
    // The #146 acceptance checklist's last box, pinned rather than trusted: the comment is
    // the ONLY place a future reader learns that a redeemed invitation is not evidence the
    // redeemer controls that mailbox, and a comment nothing checks is a comment that gets
    // deleted in a tidy-up.
    #[test]
    fn email_binding_residual_risk_is_recorded_in_source_naming_143() {
        // The PRODUCTION half only. `include_str!` pulls in this `#[cfg(test)]` module too,
        // so three of the four assertions below were satisfied by their own failure messages
        // and survived deletion of the doc block they exist to pin (FIX_ROUND-1, R1-5, found
        // by a blind tests-quality audit). Truncating at the test module restores the claim:
        // what is asserted is that the SHIPPED comment says it.
        let whole = include_str!("accept.rs");
        let cut = whole
            .find("#[cfg(test)]")
            .expect("this file has a test module, and this test reads only what precedes it");
        let src = &whole[..cut];
        assert!(
            !src.contains("email_binding_residual_risk_is_recorded_in_source_naming_143"),
            "the truncation must exclude this test itself, or the assertions below are \
             self-satisfying again"
        );
        assert!(
            src.contains("#143"),
            "the residual risk must name the issue that owns closing it (#143)"
        );
        assert!(
            src.contains("containment, not proof of identity")
                || src.contains("containment against"),
            "the residual risk must say what the control IS (containment), not only that a \
             risk exists"
        );
        assert!(
            src.contains("email_verified"),
            "…and must state the concrete reason: there is no verification flow, and \
             `email_verified` is set only by OAuth provisioning"
        );
        assert!(
            src.contains("#251"),
            "…and must name the CASE-VARIANT bypass separately (#251): `users_email_key` is \
             case-sensitive and registration is open, so a leaked link can be redeemed by a \
             freshly registered case variant of the invited address. That is a stronger \
             statement than 'emails are unverified' and must not be folded into it"
        );
        // The overclaim this test exists to keep out.
        assert!(
            !src.contains("proves the redeemer owns"),
            "the accept path must never claim the binding proves identity"
        );
    }
}
