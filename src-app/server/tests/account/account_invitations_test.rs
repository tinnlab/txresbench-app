//! #145 (epic #138) — the A9 deny suite for **account invitations**.
//!
//! | route | scope | this suite proves |
//! |---|---|---|
//! | `POST   /api/accounts/{account_id}/invitations` | `AccountScope<RoleAdmin>` | INV-8 (enumeration safety), INV-5 (role ceiling), INV-16 (no plaintext at rest), INV-RL (rate limits) |
//! | `GET    /api/accounts/{account_id}/invitations` | `AccountScope<RoleAdmin>` | nothing user-shaped in the projection |
//! | `POST   /api/accounts/{account_id}/invitations/{id}/resend` | `AccountScope<RoleAdmin>` | the copy-link channel; single-token-at-a-time |
//! | `DELETE /api/accounts/{account_id}/invitations/{id}` | `AccountScope<RoleAdmin>` | soft revoke; the row survives |
//!
//! Plus **INV-R1** at `AccountRepository::add_member`, which #145 gave a REQUIRED
//! `ActorCeiling` — the arm that was not expressible before this branch.
//!
//! # Standing rules for this suite (inherited from `member_mutations_test.rs`)
//!
//! * **Every deny arm carries its positive control in the SAME test body.** A deny test
//!   with no positive control passes just as well against a build where nothing works.
//! * **Every refusal is observed on POPULATED state**, with a DB re-query afterwards
//!   proving the other account is untouched. Two empty arms prove nothing.
//! * **Refusals are asserted by error CODE**, never by status alone — 422 is shared by
//!   `LAST_OWNER` and `PERSONAL_ACCOUNT_NOT_MANAGEABLE`, and 404 by three separate causes.
//! * **INV-8's comparison is on the RAW response TEXT**, never on a parsed
//!   `serde_json::Value`. A field-by-field or `Value`-level comparison passes the moment a
//!   later change adds a distinguishing field the assertion does not know to check, which
//!   is exactly how enumeration holes get reintroduced.

// #146 widened `add_member_in_tx` with an `invitation_id: Option<Uuid>` (DEC-4) so the
// `joined` ledger row can tie back to the invitation it was redeemed from. Every call site
// here is an ADMIN/direct add, which has no invitation — hence `None`. Mechanical: no
// assertion in this file changed.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::account::{
    invitation_token, AccountRepository, AccountRole, ActorCeiling, InvitationLimits,
    InvitationOutcome, INVITATION_RATE_LIMITED, PERSONAL_ACCOUNT_NOT_MANAGEABLE,
    ROLE_ABOVE_ACTOR,
};

use super::{
    add_member, create_user, create_user_without_projects, login, make_org_account, pool_for,
    setup_admin, USERS_GROUP_ID,
};
use crate::common::TestServer;

// ---------------------------------------------------------------------------
// helpers — request wrappers return the RAW TEXT as well as the parsed value,
// because INV-8/INV-1 compare bytes and a parse would erase exactly the
// difference they are looking for.
// ---------------------------------------------------------------------------

struct Resp {
    status: u16,
    text: String,
}

impl Resp {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
    /// The refusal code, read the way the rest of this module reads it.
    fn code(&self) -> Option<String> {
        let v = self.json();
        v.get("error_code")
            .or_else(|| v.get("code"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
    }
}

async fn post_invitation(
    server: &TestServer,
    token: &str,
    account: &str,
    email: &str,
    role: &str,
    header_account: Option<&str>,
) -> Resp {
    let mut req = server
        .client
        .post(server.api_url(&format!("/accounts/{account}/invitations")))
        .bearer_auth(token)
        .json(&json!({ "email": email, "role": role }));
    if let Some(h) = header_account {
        req = req.header("X-Account-Id", h);
    }
    let resp = req.send().await.expect("create invitation request");
    let status = resp.status().as_u16();
    Resp {
        status,
        text: resp.text().await.unwrap_or_default(),
    }
}

async fn get_invitations(
    server: &TestServer,
    token: &str,
    account: &str,
    query: &str,
    header_account: Option<&str>,
) -> Resp {
    let mut req = server
        .client
        .get(server.api_url(&format!("/accounts/{account}/invitations{query}")))
        .bearer_auth(token);
    if let Some(h) = header_account {
        req = req.header("X-Account-Id", h);
    }
    let resp = req.send().await.expect("list invitations request");
    let status = resp.status().as_u16();
    Resp {
        status,
        text: resp.text().await.unwrap_or_default(),
    }
}

async fn post_resend(server: &TestServer, token: &str, account: &str, invitation: &str) -> Resp {
    let resp = server
        .client
        .post(server.api_url(&format!(
            "/accounts/{account}/invitations/{invitation}/resend"
        )))
        .bearer_auth(token)
        .send()
        .await
        .expect("resend request");
    let status = resp.status().as_u16();
    Resp {
        status,
        text: resp.text().await.unwrap_or_default(),
    }
}

async fn delete_invitation(
    server: &TestServer,
    token: &str,
    account: &str,
    invitation: &str,
) -> Resp {
    let resp = server
        .client
        .delete(server.api_url(&format!(
            "/accounts/{account}/invitations/{invitation}"
        )))
        .bearer_auth(token)
        .send()
        .await
        .expect("revoke request");
    let status = resp.status().as_u16();
    Resp {
        status,
        text: resp.text().await.unwrap_or_default(),
    }
}

async fn get_members(server: &TestServer, token: &str, account: &str) -> Resp {
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{account}/members")))
        .bearer_auth(token)
        .send()
        .await
        .expect("list members request");
    let status = resp.status().as_u16();
    Resp {
        status,
        text: resp.text().await.unwrap_or_default(),
    }
}

// ── DB read helpers ────────────────────────────────────────────────────────

/// How many invitation rows exist for `(account, email)`, in ANY state.
async fn invitation_rows(pool: &PgPool, account: Uuid, email: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM account_invitations WHERE account_id = $1 AND email = $2",
    )
    .bind(account)
    .bind(email)
    .fetch_one(pool)
    .await
    .expect("count invitation rows")
}

/// The LIVE (pending, unrevoked, unexpired) invitation id for `(account, email)`.
async fn live_invitation(pool: &PgPool, account: Uuid, email: &str) -> Option<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM account_invitations \
         WHERE account_id = $1 AND email = $2 \
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
    )
    .bind(account)
    .bind(email)
    .fetch_optional(pool)
    .await
    .expect("read live invitation")
}

async fn member_count(pool: &PgPool, account: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM account_members WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("count members")
}

async fn role_of(pool: &PgPool, account: Uuid, user: Uuid) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(account)
    .bind(user)
    .fetch_optional(pool)
    .await
    .expect("read role")
}

async fn personal_account_id(pool: &PgPool, user_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal account exists")
}

/// Seed `n` MINT RECORDS attributed to `(account, actor)`, inside the window.
///
/// The ceiling counts rows in `account_invitation_mints` — one per token brought into
/// existence — so that is what has to be seeded to drive a window deterministically. (The
/// first version of this helper seeded `account_invitations` rows, which is what the
/// limiter read before FIX_ROUND-2 replaced a per-row counter that could neither represent
/// two windows nor decay.)
///
/// `batch` distinguishes successive calls only for readability now that nothing unique is
/// being inserted; it is kept because the log of a failing run is much easier to read when
/// the phases are labelled.
async fn seed_mints(pool: &PgPool, account: Uuid, actor: Uuid, n: i64, _batch: &str) {
    for _ in 0..n {
        sqlx::query(
            "INSERT INTO account_invitation_mints (account_id, actor_user_id, invitation_id) \
             VALUES ($1, $2, gen_random_uuid())",
        )
        .bind(account)
        .bind(actor)
        .execute(pool)
        .await
        .expect("seed mint record");
    }
}

/// Age every mint record for `account` OUT of the rate-limit windows, without sleeping.
///
/// Named for what it does to the WINDOW, not to the rows: nothing is deleted, the rows
/// simply stop being recent — which is what makes the positive control in TEST-14 a test of
/// a SLIDING WINDOW rather than of a reset button.
///
/// It ages them to 23 hours rather than out of the table entirely, deliberately: the
/// repository prunes at a 1-day horizon at every mint, so a row aged 30 days would be
/// deleted by the very next create and the arm would then be proving that DELETION works,
/// not that the window slides.
async fn age_out_mints(pool: &PgPool, account: Uuid) {
    sqlx::query(
        "UPDATE account_invitation_mints SET created_at = now() - interval '23 hours' \
         WHERE account_id = $1",
    )
    .bind(account)
    .execute(pool)
    .await
    .expect("age out mint records");
}

// ===========================================================================
// TEST-6 [acceptance] [invariant: INV-8] [covers: ITEM-4, ITEM-12, ITEM-17]
// ===========================================================================
/// **INV-8 — invite creation is enumeration-safe.**
///
/// > create for (i) an unregistered address, (ii) a registered non-member, (iii) a
/// > registered address that is **already a member**, (iv) an address with a live
/// > invitation ⇒ **identical status code and byte-identical response body** in all four.
///
/// The comparison is on the RAW TEXT, in one four-way assertion. The positive control is
/// the DB half: the four cases produce genuinely DIFFERENT persistent state, verified by
/// querying `account_invitations` directly — so the test is not passing because nothing
/// happened.
///
/// **What mutation this kills.** Case (iii) is the one implementations leave open,
/// because `409 ALREADY_A_MEMBER` reads like helpful feedback. It is an oracle: it tells
/// the caller both that the address is registered AND that it is in this account. Make
/// the handler branch on `InvitationOutcome` for its status and this test goes red on the
/// body comparison while every other test in the suite still passes.
#[tokio::test]
async fn inv8_invitation_create_is_enumeration_safe_across_all_four_cases() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "e8_owner", "e8_owner@cyto.test").await;
    let existing_member =
        create_user(&server, &admin_token, "e8_member", "e8_member@cyto.test").await;
    // Registered, but NOT a member of this org — case (ii). Created for the ADDRESS, not
    // for the id: the whole point is that `e8_outsider@cyto.test` resolves to a real user
    // while `e8_nobody@cyto.test` does not, and that the caller cannot tell which.
    let _outsider = create_user(&server, &admin_token, "e8_outsider", "e8_outsider@cyto.test").await;
    let owner_token = login(&server, "e8_owner").await;

    // POPULATED: a real org with two members.
    let org = make_org_account(&pool, "E8 Org", owner).await;
    add_member(&pool, org, existing_member, "member").await;
    assert_eq!(member_count(&pool, org).await, 2, "populated precondition");
    let org_s = org.to_string();

    // Case (iv) needs a live invitation to already exist. Create it first, then repeat it.
    let already_invited = "e8_pending@cyto.test";
    let seed = post_invitation(
        &server,
        &owner_token,
        &org_s,
        already_invited,
        "member",
        None,
    )
    .await;
    assert_eq!(seed.status, 202, "seed create: {}", seed.text);
    let seeded_id = live_invitation(&pool, org, already_invited)
        .await
        .expect("case (iv) precondition: a live invitation exists");
    // Mint a link the inviter would actually be holding, so "the existing token stands"
    // below is asserted through the ONE channel a client can observe, not only against a
    // column. (The token `create_invitation` mints is discarded unread — it exists so all
    // four create paths do the same work — so a hash comparison alone would be pinning a
    // property no caller could ever notice.)
    let seed_resend = post_resend(&server, &owner_token, &org_s, &seeded_id.to_string()).await;
    assert_eq!(seed_resend.status, 200, "{}", seed_resend.text);
    let held_link = seed_resend.json()["invite_token"]
        .as_str()
        .expect("the inviter now holds a link")
        .to_string();
    let seeded_before: (Vec<u8>, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT token_sha256, expires_at FROM account_invitations WHERE id = $1",
    )
    .bind(seeded_id)
    .fetch_one(&pool)
    .await
    .expect("read the seeded invitation AFTER the resend — this is the snapshot the \
             duplicate create below must not move");

    // ── the four cases ──
    let unregistered = "e8_nobody@cyto.test";
    let registered_non_member = "e8_outsider@cyto.test";
    let registered_member = "e8_member@cyto.test";

    let r1 = post_invitation(&server, &owner_token, &org_s, unregistered, "member", None).await;
    let r2 = post_invitation(
        &server,
        &owner_token,
        &org_s,
        registered_non_member,
        "member",
        None,
    )
    .await;
    let r3 = post_invitation(
        &server,
        &owner_token,
        &org_s,
        registered_member,
        "member",
        None,
    )
    .await;
    let r4 = post_invitation(
        &server,
        &owner_token,
        &org_s,
        already_invited,
        "member",
        None,
    )
    .await;

    // Status first, so four identical 500s cannot satisfy the body comparison below.
    assert_eq!(
        (r1.status, r2.status, r3.status, r4.status),
        (202, 202, 202, 202),
        "all four cases are 202 Accepted; bodies: {} | {} | {} | {}",
        r1.text,
        r2.text,
        r3.text,
        r4.text
    );

    // THE assertion: byte-identical raw bodies.
    assert_eq!(
        r1.text, r2.text,
        "unregistered vs registered-non-member: a difference here is an ACCOUNT-EXISTENCE \
         oracle — it tells the caller whether the address has an account on this platform"
    );
    assert_eq!(
        r1.text, r3.text,
        "unregistered vs ALREADY-A-MEMBER: a difference here tells the caller both that \
         the address is registered AND that it is in this account"
    );
    assert_eq!(
        r1.text, r4.text,
        "unregistered vs already-invited: a difference here reveals an existing invitation"
    );
    assert_eq!(
        r1.text, "{\"status\":\"sent\"}",
        "and the body is the specified one, not merely self-consistently empty"
    );

    // ── POSITIVE CONTROL: the DB state genuinely differs, so the four calls really did
    //    take four different paths and the uniform body is not uniform because nothing
    //    happened. ──
    assert_eq!(
        invitation_rows(&pool, org, unregistered).await,
        1,
        "case (i) created a row"
    );
    assert_eq!(
        invitation_rows(&pool, org, registered_non_member).await,
        1,
        "case (ii) created a row"
    );
    assert_eq!(
        invitation_rows(&pool, org, registered_member).await,
        0,
        "case (iii) is a server-side NO-OP: an existing member is not invited again"
    );
    assert_eq!(
        invitation_rows(&pool, org, already_invited).await,
        1,
        "case (iv) created no SECOND row"
    );

    // …and case (iv) left the EXISTING token alone — "idempotent, the existing token
    // stands". Re-minting here would silently break a link the inviter already sent.
    let seeded_after: (Vec<u8>, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT token_sha256, expires_at FROM account_invitations WHERE id = $1",
    )
    .bind(seeded_id)
    .fetch_one(&pool)
    .await
    .expect("re-read the seeded invitation");
    assert_eq!(
        seeded_before.0, seeded_after.0,
        "case (iv) must NOT re-mint the token — a link already handed out keeps working"
    );
    assert_eq!(
        seeded_before.1, seeded_after.1,
        "…and must not push out the expiry either"
    );
    // …and the same thing said in the only terms a client can check: the link the inviter
    // is holding STILL RESOLVES after the duplicate create. This is what "idempotent — the
    // existing token stands" actually promises to a human.
    let repo = AccountRepository::new(pool.clone());
    assert_eq!(
        repo.find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&held_link))
            .await
            .expect("lookup")
            .expect("the already-minted link still resolves after a duplicate create")
            .id,
        seeded_id,
        "re-inviting an address must not invalidate a link that has already been sent"
    );
}

// ===========================================================================
// TEST-7 [acceptance] [invariant: INV-5] [covers: ITEM-4, ITEM-10, ITEM-12, ITEM-17]
// ===========================================================================
/// **INV-5 (create half) — no invitation above the actor's role.**
///
/// > an `admin` creates `role: owner` ⇒ **403 `ROLE_ABOVE_ACTOR`** and **no row is
/// > written**. Positive control: `role: admin` from the same actor ⇒ 202 with a row.
///
/// Under DEC-12 (#140) this is not a title check: an account Owner holds project-Owner —
/// delete, transfer and share — over every project in the tenant, including ones they
/// never created. So "an Admin mints an Owner" is a grant of destructive authority over
/// the whole account by someone who does not have it.
///
/// The last arm asserts the ceiling is read **live inside the transaction**: the actor is
/// demoted between two otherwise-identical requests and the second is refused. An
/// implementation that trusted `AccountScope`'s extraction-time read passes every other
/// arm and fails this one.
#[tokio::test]
async fn inv5_an_admin_cannot_invite_at_owner() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "e5_owner", "e5_owner@cyto.test").await;
    let actor = create_user(&server, &admin_token, "e5_admin", "e5_admin@cyto.test").await;
    let owner_token = login(&server, "e5_owner").await;
    let actor_token = login(&server, "e5_admin").await;

    let org = make_org_account(&pool, "E5 Org", owner).await;
    add_member(&pool, org, actor, "admin").await;
    let org_s = org.to_string();

    // ── DENY: an admin asks for `owner` ──
    let deny = post_invitation(
        &server,
        &actor_token,
        &org_s,
        "e5_target@cyto.test",
        "owner",
        None,
    )
    .await;
    assert_eq!(deny.status, 403, "an admin may not invite an owner: {}", deny.text);
    assert_eq!(
        deny.code().as_deref(),
        Some(ROLE_ABOVE_ACTOR),
        "refusal must be ROLE_ABOVE_ACTOR by NAME, not merely a 403: {}",
        deny.text
    );
    assert_eq!(
        invitation_rows(&pool, org, "e5_target@cyto.test").await,
        0,
        "and NO row is written — a refused mutation must leave nothing behind"
    );

    // ── POSITIVE CONTROLS, same actor, same body shape ──
    let at_admin = post_invitation(
        &server,
        &actor_token,
        &org_s,
        "e5_peer@cyto.test",
        "admin",
        None,
    )
    .await;
    assert_eq!(
        at_admin.status, 202,
        "the EQUAL case must be allowed — an admin may invite an admin, or nobody can \
         onboard a peer. This is the boundary a `>=` mutation swallows: {}",
        at_admin.text
    );
    assert_eq!(invitation_rows(&pool, org, "e5_peer@cyto.test").await, 1);

    let at_member = post_invitation(
        &server,
        &actor_token,
        &org_s,
        "e5_junior@cyto.test",
        "member",
        None,
    )
    .await;
    assert_eq!(at_member.status, 202, "below own role: {}", at_member.text);
    assert_eq!(
        invitation_rows(&pool, org, "e5_junior@cyto.test").await,
        1,
        "…and it really wrote a row, like its `at_admin` sibling — a 202 with no row would \
         satisfy the status assertion while proving nothing"
    );

    // …and an OWNER may invite an owner, so the refusal above is about the ACTOR's rank
    // and not about the role `owner` being unreachable.
    let owner_invites_owner = post_invitation(
        &server,
        &owner_token,
        &org_s,
        "e5_successor@cyto.test",
        "owner",
        None,
    )
    .await;
    assert_eq!(
        owner_invites_owner.status, 202,
        "an owner may invite an owner: {}",
        owner_invites_owner.text
    );

    // ── THE LIVE HALF (FIX_ROUND-1 F9, corrected in FIX_ROUND-2) ──
    //
    // The point is that `create_invitation` re-reads the ceiling LIVE inside its own
    // transaction rather than trusting the value the extractor read. Two earlier versions
    // of this arm failed to test that, and the second failure is the instructive one:
    //
    //   * v1 demoted an admin to `member`, which `AccountScope<RoleAdmin>`'s live FLOOR
    //     refuses before the repository is ever reached — its own assertion message said so.
    //   * v2 demoted an owner to `admin` and asked for `owner` over HTTP. Better (it kills
    //     deleting the ceiling check outright, which v1 did not), but still not the live
    //     read: `AccountScope` re-reads the role on EVERY request, so by the time the
    //     handler builds its ceiling, `observed_role` is ALREADY `admin`, and
    //     `min(observed, live) == admin` either way. A mutation replacing `resolve_ceiling`
    //     with the extractor's `observed_role` left it green.
    //
    // The property is only expressible when `observed_role` and the live row DISAGREE, and
    // HTTP cannot produce that disagreement deterministically — the extractor's read and
    // the transaction's read are microseconds apart. So this arm drives the repository
    // directly with a deliberately STALE-HIGH `observed_role`, which is exactly how
    // `member_mutations_test.rs` pins the same property for `set_role`.
    let demotee = create_user(&server, &admin_token, "e5_demotee", "e5_demotee@cyto.test").await;
    add_member(&pool, org, demotee, "admin").await;
    let demotee_token = login(&server, "e5_demotee").await;

    let repo = AccountRepository::new(pool.clone());
    let stale_high = ActorCeiling::SelfService {
        actor_user_id: demotee,
        observed_role: AccountRole::Owner, // what a stale extractor read would have said
    };
    let err = repo
        .create_invitation(
            org,
            "e5_stale@cyto.test",
            AccountRole::Owner,
            stale_high,
            InvitationLimits::defaults(),
        )
        .await
        .expect_err(
            "a stale-high observed_role must NOT raise the ceiling — the live row says \
             `admin`, and min(observed, live) is what governs",
        );
    assert_eq!(err.status_code(), 403, "{err:?}");
    assert!(
        format!("{err:?}").contains(ROLE_ABOVE_ACTOR),
        "the LIVE role wins: {err:?}"
    );
    assert_eq!(
        invitation_rows(&pool, org, "e5_stale@cyto.test").await,
        0,
        "and nothing was written"
    );
    // …and the SAME stale-high ceiling is fine for a role the LIVE role can confer, so the
    // refusal is the clamp doing its job rather than the call being broken.
    let ok_at_admin = repo
        .create_invitation(
            org,
            "e5_stale_ok@cyto.test",
            AccountRole::Admin,
            stale_high,
            InvitationLimits::defaults(),
        )
        .await
        .expect("min(observed, live) = admin, and an admin may invite an admin");
    assert_eq!(ok_at_admin, InvitationOutcome::Created);

    // ── and over HTTP, an actor whose LIVE role is `admin` cannot ask for `owner` ──
    // (this arm kills deleting the ceiling check from `create_invitation` altogether)
    let after_demotion = post_invitation(
        &server,
        &demotee_token,
        &org_s,
        "e5_after@cyto.test",
        "owner",
        None,
    )
    .await;
    assert_eq!(
        after_demotion.status, 403,
        "an admin-ranked actor may not mint an OWNER invitation — and this must be the \
         ceiling refusing, not the floor, because an `admin` clears the floor: {}",
        after_demotion.text
    );
    assert_eq!(
        after_demotion.code().as_deref(),
        Some(ROLE_ABOVE_ACTOR),
        "…named ROLE_ABOVE_ACTOR: INSUFFICIENT_ACCOUNT_ROLE here would mean the FLOOR \
         refused and the ceiling was never exercised: {}",
        after_demotion.text
    );
    assert_eq!(
        invitation_rows(&pool, org, "e5_after@cyto.test").await,
        0,
        "no row from a refused request"
    );
    // …and the SAME actor, same instant, may still invite at their own rank.
    let still_admin = post_invitation(
        &server,
        &demotee_token,
        &org_s,
        "e5_still@cyto.test",
        "admin",
        None,
    )
    .await;
    assert_eq!(
        still_admin.status, 202,
        "the actor is still an admin and may still invite an admin — so the 403 above is \
         about the requested role, not about their session or membership: {}",
        still_admin.text
    );
}

// ===========================================================================
// TEST-8 [acceptance] [invariant: INV-16] [covers: ITEM-1, ITEM-3, ITEM-4, ITEM-17]
// ===========================================================================
/// **INV-16 — tokens are never stored in plaintext.**
///
/// > after create, no column of `account_invitations` contains the plaintext token […]
/// > A grep-style guard over the handler is acceptable as a companion, but the DB
/// > assertion is the real one.
///
/// The DB assertion is made over `to_jsonb(t)` — **every column at once** — rather than
/// over the columns this branch happens to know about. A future column that leaks the
/// token is then caught without anyone remembering to update this test.
///
/// The token is obtained from `resend`, which is the only route that ever surfaces one
/// (#145 DEC-2: because the row stores a hash, the server cannot reproduce a link it has
/// already handed out, so "give me the link" and "resend" are the same operation).
#[tokio::test]
async fn inv16_the_plaintext_token_is_nowhere_at_rest() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "e16_owner", "e16_owner@cyto.test").await;
    let owner_token = login(&server, "e16_owner").await;
    let org = make_org_account(&pool, "E16 Org", owner).await;
    let org_s = org.to_string();

    let email = "e16_invitee@cyto.test";
    let created = post_invitation(&server, &owner_token, &org_s, email, "member", None).await;
    assert_eq!(created.status, 202, "{}", created.text);

    // The create response carries NO token — that is the enumeration contract.
    assert!(
        !created.text.contains("token"),
        "the create response must carry no token material at all: {}",
        created.text
    );

    let id = live_invitation(&pool, org, email).await.expect("live row");

    // ── FIRST: the row as CREATE left it, before any resend ──
    //
    // A mutation battery caught this gap. The assertions below all run after a RESEND,
    // which overwrites `token_sha256` with a correctly-hashed value — so a mutation that
    // makes CREATE store something else (e.g. `token.as_bytes()[..32]`, the first 32
    // characters of the plaintext) was repaired by the resend before anything looked, and
    // the whole test stayed green.
    let created_hash: Vec<u8> =
        sqlx::query_scalar("SELECT token_sha256 FROM account_invitations WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("read the CREATE-time hash");
    assert_eq!(created_hash.len(), 32, "an untruncated digest at create time");
    // A real SHA-256 is essentially never valid UTF-8, and if it is, it is essentially
    // never printable. This is what distinguishes "a digest" from "some bytes of the
    // token": storing any ASCII slice of a base64url token yields valid, printable UTF-8.
    // This check is LIVE here and only here. Below, after the resend, `stored` is pinned by
    // an equality against an independently computed SHA-256 — which already kills any leak,
    // so the same assertion there would be dead code (a blind audit caught exactly that:
    // the first version of it sat after the equality and could never fire). At CREATE time
    // no independent digest exists — the create response deliberately carries no token — so
    // this is the only thing between a token-material column and a green suite.
    //
    // It is a shape assertion rather than a comparison for the same reason: there is no
    // plaintext to compare against. A SHA-256 is 32 random bytes; storing the token, or any
    // slice of it, yields printable ASCII, which is what this refuses.
    if let Ok(as_text) = String::from_utf8(created_hash.clone()) {
        assert!(
            !as_text.chars().all(|c| c.is_ascii_graphic()),
            "the create-time `token_sha256` decoded to printable ASCII ({as_text:?}) — that \
             is what storing the token, or a slice of it, looks like. A SHA-256 digest is \
             random bytes and passes this by ~2^-64"
        );
    }

    let resent = post_resend(&server, &owner_token, &org_s, &id.to_string()).await;
    assert_eq!(resent.status, 200, "{}", resent.text);
    let plaintext = resent.json()["invite_token"]
        .as_str()
        .expect("resend returns the plaintext token")
        .to_string();
    assert!(
        plaintext.len() >= 40,
        "a 256-bit base64url token is 43 chars; got {} ({plaintext})",
        plaintext.len()
    );

    // ── THE ASSERTION: the plaintext appears in NO column of the row. ──
    let row_json: String =
        sqlx::query_scalar("SELECT to_jsonb(t)::text FROM account_invitations t WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("serialize the whole row");
    assert!(
        !row_json.contains(&plaintext),
        "the plaintext token must appear in NO column of account_invitations. Row: {row_json}"
    );

    // …and what IS stored is the SHA-256 the test computes independently, so "absent" is
    // not passing because the row is empty or because the token was never persisted at all.
    let stored: Vec<u8> = sqlx::query_scalar("SELECT token_sha256 FROM account_invitations WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("read token_sha256");
    assert_eq!(
        stored,
        invitation_token::token_sha256(&plaintext).to_vec(),
        "the stored value must be exactly SHA-256(token) — computed here from the \
         published digest's own implementation, not read back from the writer"
    );
    assert_eq!(stored.len(), 32, "an untruncated digest");

    // …and the hash really does resolve, so the storage is functional rather than merely
    // opaque (an implementation that stored random bytes would satisfy the above).
    let repo = AccountRepository::new(pool.clone());
    let found = repo
        .find_pending_invitation_by_token_hash(&stored)
        .await
        .expect("lookup")
        .expect("the freshly resent token resolves");
    assert_eq!(found.id, id);
}

// ===========================================================================
// TEST-9 [covers: ITEM-2, ITEM-5, ITEM-12, ITEM-17]
// ===========================================================================
/// The list projection reveals **nothing user-shaped**, and is paged and clamped.
///
/// > The list response must never reveal whether a pending invitee is a registered user —
/// > return the email as typed, `role`, `created_at`, `expires_at`, `invited_by`, and
/// > nothing user-shaped.
///
/// The invitee used here **is** a registered user, so a projection that joined `users`
/// would have something to leak; the assertion scans the raw response for each forbidden
/// key rather than checking a struct's fields, so a widening of `InvitationSummary` is
/// caught by this test rather than by review.
#[tokio::test]
async fn invitation_list_is_paged_and_reveals_nothing_user_shaped() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "e9_owner", "e9_owner@cyto.test").await;
    // A REGISTERED user who is not a member — so a `users` join would have a row to find.
    let _registered = create_user(&server, &admin_token, "e9_known", "e9_known@cyto.test").await;
    let owner_token = login(&server, "e9_owner").await;
    let org = make_org_account(&pool, "E9 Org", owner).await;
    let org_s = org.to_string();

    for (i, email) in ["e9_known@cyto.test", "e9_a@cyto.test", "e9_b@cyto.test"]
        .iter()
        .enumerate()
    {
        let r = post_invitation(&server, &owner_token, &org_s, email, "member", None).await;
        assert_eq!(r.status, 202, "seed {i}: {}", r.text);
    }

    // One accepted, one revoked, one expired — none of the three may be listed.
    let revoked_id = {
        let r = post_invitation(
            &server,
            &owner_token,
            &org_s,
            "e9_revoked@cyto.test",
            "member",
            None,
        )
        .await;
        assert_eq!(r.status, 202, "{}", r.text);
        live_invitation(&pool, org, "e9_revoked@cyto.test")
            .await
            .expect("live")
    };
    assert_eq!(
        delete_invitation(&server, &owner_token, &org_s, &revoked_id.to_string())
            .await
            .status,
        204
    );
    {
        let r = post_invitation(
            &server,
            &owner_token,
            &org_s,
            "e9_expired@cyto.test",
            "member",
            None,
        )
        .await;
        assert_eq!(r.status, 202, "{}", r.text);
        let id = live_invitation(&pool, org, "e9_expired@cyto.test")
            .await
            .expect("live");
        sqlx::query("UPDATE account_invitations SET expires_at = now() - interval '1 day' WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .expect("expire it");
    }

    let listed = get_invitations(&server, &owner_token, &org_s, "", None).await;
    assert_eq!(listed.status, 200, "{}", listed.text);
    let v = listed.json();
    assert_eq!(
        v["total"].as_i64(),
        Some(3),
        "only the three PENDING invitations are listed — accepted, revoked and expired \
         rows are excluded by the predicate, not filtered in Rust: {}",
        listed.text
    );
    assert_eq!(v["page"].as_i64(), Some(1));
    assert_eq!(v["per_page"].as_i64(), Some(10), "the settings-list default");

    // ── nothing user-shaped, asserted on the RAW text ──
    for forbidden in [
        "user_id",
        "username",
        "display_name",
        "registered",
        "token",
        "token_sha256",
        "invite_token",
    ] {
        assert!(
            !listed.text.contains(forbidden),
            "the list response must not carry `{forbidden}` — one of its invitees IS a \
             registered user, so this is a live leak, not a hypothetical one: {}",
            listed.text
        );
    }

    // ── POSITIVE CONTROL: the fields that SHOULD be there are ──
    assert!(listed.text.contains("e9_known@cyto.test"), "{}", listed.text);
    let first = &v["invitations"][0];
    for present in ["id", "email", "role", "created_at", "expires_at", "invited_by"] {
        assert!(
            first.get(present).is_some(),
            "`{present}` must be present, or the list is useless: {}",
            listed.text
        );
    }
    assert_eq!(
        first["invited_by"].as_str().map(|s| s.to_string()),
        Some(owner.to_string()),
        "invited_by names the inviter"
    );

    // ── clamping (guideline §4: never unbounded) ──
    let clamped = get_invitations(&server, &owner_token, &org_s, "?per_page=1000", None).await;
    assert_eq!(clamped.status, 200, "{}", clamped.text);
    assert_eq!(
        clamped.json()["per_page"].as_i64(),
        Some(100),
        "per_page is capped at 100"
    );
    // The saturating offset (FIX_ROUND-1, F13). `(page - 1) * per_page` on an `i64` clamped
    // only from below overflows here — a panic under overflow-checks, or a negative
    // `OFFSET` Postgres rejects. Either way a 500 per request, and the fix shipped with no
    // test until a blind tests-quality audit said so.
    let absurd = get_invitations(
        &server,
        &owner_token,
        &org_s,
        "?page=9223372036854775807&per_page=100",
        None,
    )
    .await;
    assert_eq!(
        absurd.status, 200,
        "an absurd page number returns an empty page, not a 500: {}",
        absurd.text
    );
    assert_eq!(
        absurd.json()["invitations"].as_array().map(|a| a.len()),
        Some(0),
        "…and it really is empty"
    );

    let paged = get_invitations(&server, &owner_token, &org_s, "?page=2&per_page=2", None).await;
    assert_eq!(
        paged.json()["invitations"].as_array().map(|a| a.len()),
        Some(1),
        "page 2 of 3 at per_page=2 holds the remaining one: {}",
        paged.text
    );
}

// ===========================================================================
// TEST-10 [acceptance] [invariant: INV-1] [covers: ITEM-12, ITEM-13, ITEM-17]
// ===========================================================================
/// **INV-1 — cross-tenant access is refused, as a 404, on ALL FOUR invitation routes.**
///
/// > A caller who is Owner of account A and holds the manage capability gets **404** on
/// > any `AccountScope` route for account B, byte-identical to a nonexistent account id.
///
/// Run on **populated** state: B is a real organization with two members and a live
/// invitation of its own, and a DB re-query afterwards proves none of it moved. Without
/// that, a 404 could equally mean "there is nothing there", which proves nothing about
/// authorization.
///
/// Both arms are asserted 404 FIRST, so two identical 500s cannot satisfy the body
/// comparison — the guard #142 added after noticing the omission.
#[tokio::test]
async fn inv1_cross_tenant_invitation_routes_are_404_on_populated_state() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let a_owner = create_user(&server, &admin_token, "e1_a", "e1_a@cyto.test").await;
    let b_owner = create_user(&server, &admin_token, "e1_b", "e1_b@cyto.test").await;
    let b_member = create_user(&server, &admin_token, "e1_bm", "e1_bm@cyto.test").await;
    let a_token = login(&server, "e1_a").await;
    let b_token = login(&server, "e1_b").await;

    let a = make_org_account(&pool, "A Org", a_owner).await;
    let b = make_org_account(&pool, "B Org", b_owner).await;
    add_member(&pool, b, b_member, "member").await;

    // B has a live invitation of its own — the thing the intruder must not be able to
    // list, resend or revoke.
    let b_s = b.to_string();
    let a_s = a.to_string();
    assert_eq!(
        post_invitation(&server, &b_token, &b_s, "e1_binvitee@cyto.test", "member", None)
            .await
            .status,
        202
    );
    let b_invite = live_invitation(&pool, b, "e1_binvitee@cyto.test")
        .await
        .expect("B has a live invitation");
    let b_token_hash_before: Vec<u8> =
        sqlx::query_scalar("SELECT token_sha256 FROM account_invitations WHERE id = $1")
            .bind(b_invite)
            .fetch_one(&pool)
            .await
            .expect("read B's invitation hash");
    assert_eq!(member_count(&pool, b).await, 2, "B is populated");

    let nowhere = Uuid::new_v4().to_string();
    let b_invite_s = b_invite.to_string();

    // ── DENY, all four routes, A's owner acting on B ──
    let c_post = post_invitation(&server, &a_token, &b_s, "e1_x@cyto.test", "member", None).await;
    let c_get = get_invitations(&server, &a_token, &b_s, "", None).await;
    let c_resend = post_resend(&server, &a_token, &b_s, &b_invite_s).await;
    let c_del = delete_invitation(&server, &a_token, &b_s, &b_invite_s).await;

    let g_post = post_invitation(&server, &a_token, &nowhere, "e1_x@cyto.test", "member", None).await;
    let g_get = get_invitations(&server, &a_token, &nowhere, "", None).await;
    let g_resend = post_resend(&server, &a_token, &nowhere, &b_invite_s).await;
    let g_del = delete_invitation(&server, &a_token, &nowhere, &b_invite_s).await;

    assert_eq!(
        (
            c_post.status, c_get.status, c_resend.status, c_del.status,
            g_post.status, g_get.status, g_resend.status, g_del.status,
        ),
        (404, 404, 404, 404, 404, 404, 404, 404),
        "every cross-tenant and nonexistent-account call is 404, never 403 (a 403 would \
         confirm B exists). Bodies: {} | {} | {} | {}",
        c_post.text, c_get.text, c_resend.text, c_del.text
    );

    // ── and the two are INDISTINGUISHABLE, byte for byte ──
    assert_eq!(
        c_post.text, g_post.text,
        "POST: the foreign-account 404 body must be BYTE-IDENTICAL to the \
         nonexistent-account 404, or the difference is an existence oracle"
    );
    assert_eq!(c_get.text, g_get.text, "GET: same");
    assert_eq!(c_resend.text, g_resend.text, "resend: same");
    assert_eq!(c_del.text, g_del.text, "revoke: same");

    // ── B IS UNTOUCHED — the refusals were of a REAL, populated account ──
    assert_eq!(
        member_count(&pool, b).await,
        2,
        "B still has its members: the 404s were an authorization answer, not a \
         'there is nothing there' answer"
    );
    let b_after: (Vec<u8>, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
        "SELECT token_sha256, revoked_at FROM account_invitations WHERE id = $1",
    )
    .bind(b_invite)
    .fetch_one(&pool)
    .await
    .expect("B's invitation still exists");
    assert_eq!(
        b_after.0, b_token_hash_before,
        "the intruder's resend did not re-mint B's token"
    );
    assert!(
        b_after.1.is_none(),
        "the intruder's revoke did not revoke B's invitation"
    );
    assert_eq!(
        invitation_rows(&pool, b, "e1_x@cyto.test").await,
        0,
        "the intruder's create wrote nothing into B"
    );

    // ── POSITIVE CONTROL: the identical four calls on A succeed ──
    let p_post = post_invitation(&server, &a_token, &a_s, "e1_ok@cyto.test", "member", None).await;
    assert_eq!(p_post.status, 202, "{}", p_post.text);
    let a_invite = live_invitation(&pool, a, "e1_ok@cyto.test")
        .await
        .expect("A's own invitation");
    let p_get = get_invitations(&server, &a_token, &a_s, "", None).await;
    assert_eq!(p_get.status, 200, "{}", p_get.text);
    let p_resend = post_resend(&server, &a_token, &a_s, &a_invite.to_string()).await;
    assert_eq!(p_resend.status, 200, "{}", p_resend.text);
    let p_del = delete_invitation(&server, &a_token, &a_s, &a_invite.to_string()).await;
    assert_eq!(p_del.status, 204, "{}", p_del.text);
}

// ===========================================================================
// TEST-11 [acceptance] [invariant: INV-4] [covers: ITEM-12, ITEM-13, ITEM-17]
// ===========================================================================
/// **INV-4 — the role floor holds**, and the capability refusal is distinguishable.
///
/// > A bare `member` gets **403** on an `Admin`-floor route while
/// > `GET /accounts/{id}/members` still returns 200 (positive control).
///
/// The positive control is what makes the 403 mean "the floor refused me" rather than
/// "my session is broken" — the same token, the same account, a route the member IS
/// entitled to.
///
/// The second half separates the two factors of #139's two-factor model: revoking the
/// manage capability deployment-wide refuses an ACCOUNT ADMIN with a DIFFERENT code, from
/// a step that runs before any account lookup.
#[tokio::test]
async fn inv4_a_bare_member_is_403_on_every_invitation_route() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "e4_owner", "e4_owner@cyto.test").await;
    let plain = create_user(&server, &admin_token, "e4_member", "e4_member@cyto.test").await;
    let owner_token = login(&server, "e4_owner").await;
    let member_token = login(&server, "e4_member").await;

    let org = make_org_account(&pool, "E4 Org", owner).await;
    add_member(&pool, org, plain, "member").await;
    let org_s = org.to_string();

    // A live invitation to aim resend/revoke at, so those arms are not refused merely for
    // pointing at nothing.
    assert_eq!(
        post_invitation(&server, &owner_token, &org_s, "e4_inv@cyto.test", "member", None)
            .await
            .status,
        202
    );
    let inv = live_invitation(&pool, org, "e4_inv@cyto.test")
        .await
        .expect("live")
        .to_string();

    let post = post_invitation(&server, &member_token, &org_s, "e4_x@cyto.test", "member", None).await;
    let get = get_invitations(&server, &member_token, &org_s, "", None).await;
    let resend = post_resend(&server, &member_token, &org_s, &inv).await;
    let del = delete_invitation(&server, &member_token, &org_s, &inv).await;

    for (label, r) in [
        ("POST", &post),
        ("GET", &get),
        ("resend", &resend),
        ("revoke", &del),
    ] {
        assert_eq!(r.status, 403, "{label}: a bare member is 403, not 404 — they are a \
             PROVEN member, so nothing is leaked by naming the refusal: {}", r.text);
        assert_eq!(
            r.code().as_deref(),
            Some("INSUFFICIENT_ACCOUNT_ROLE"),
            "{label}: by CODE, not merely by status: {}",
            r.text
        );
    }
    assert_eq!(
        invitation_rows(&pool, org, "e4_x@cyto.test").await,
        0,
        "nothing written by the refused create"
    );

    // ── POSITIVE CONTROL: the same member, the same token, a route they may use ──
    let members = get_members(&server, &member_token, &org_s).await;
    assert_eq!(
        members.status, 200,
        "the SAME member reads the member list — so the four 403s above are the role \
         FLOOR refusing, not a broken session: {}",
        members.text
    );

    // ── the OTHER factor: revoke the capability deployment-wide and watch an ACCOUNT
    //    ADMIN be refused with a different code, from a step BEFORE any account lookup ──
    let admin_of_org = create_user_without_projects(
        &server,
        &admin_token,
        "e4_nocap",
        "e4_nocap@cyto.test",
    )
    .await;
    add_member(&pool, org, admin_of_org, "admin").await;
    let nocap_token = login(&server, "e4_nocap").await;
    // `create_user_without_projects` strips the Users group, which is where the
    // `account::members::manage` grant lives (#139's migration).
    let held: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM user_groups ug JOIN groups g ON g.id = ug.group_id \
         WHERE ug.user_id = $1 AND g.id = $2::uuid)",
    )
    .bind(admin_of_org)
    .bind(USERS_GROUP_ID)
    .fetch_one(&pool)
    .await
    .unwrap_or(false);
    assert!(
        !held,
        "precondition: this admin is NOT in the Users group, so they do not hold the \
         manage capability"
    );

    let nocap = post_invitation(&server, &nocap_token, &org_s, "e4_y@cyto.test", "member", None).await;
    assert_eq!(nocap.status, 403, "{}", nocap.text);
    assert_eq!(
        nocap.code().as_deref(),
        Some("ACCOUNT_MEMBERS_MANAGE_REQUIRED"),
        "a DIFFERENT code from the floor refusal — factor (a), the operator kill switch, \
         which is checked before any account lookup so it is not an existence oracle: {}",
        nocap.text
    );
    assert_eq!(
        role_of(&pool, org, admin_of_org).await.as_deref(),
        Some("admin"),
        "…and they really ARE an account admin, so the refusal is the capability and not \
         the floor"
    );
}

// ===========================================================================
// TEST-12 [acceptance] [invariant: INV-12] [covers: ITEM-4, ITEM-12, ITEM-17]
// ===========================================================================
/// **INV-12 — personal accounts refuse membership.**
///
/// > invite into a `personal` account ⇒ **422**.
///
/// Asserted by CODE (`PERSONAL_ACCOUNT_NOT_MANAGEABLE`), not by the 422 status, which
/// `LAST_OWNER` also uses.
///
/// The second arm drives the REPOSITORY directly, which is what proves the refusal exists
/// in BOTH places #139's DEC-5 requires: `AccountScope` step 6 (covering read-only routes
/// that never reach a mutating repository function) and `refuse_if_personal` (covering
/// every caller including the admin surface). Deleting either one still turns this test
/// red — which is the point of testing both rather than one.
#[tokio::test]
async fn inv12_a_personal_account_cannot_be_invited_into() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let user = create_user(&server, &admin_token, "e12_user", "e12_user@cyto.test").await;
    let token = login(&server, "e12_user").await;
    let personal = personal_account_id(&pool, user).await;

    let r = post_invitation(
        &server,
        &token,
        &personal.to_string(),
        "e12_x@cyto.test",
        "member",
        None,
    )
    .await;
    assert_eq!(r.status, 422, "a personal account refuses invitations: {}", r.text);
    assert_eq!(
        r.code().as_deref(),
        Some(PERSONAL_ACCOUNT_NOT_MANAGEABLE),
        "by NAME — `LAST_OWNER` is also a 422 from this module: {}",
        r.text
    );
    assert_eq!(
        invitation_rows(&pool, personal, "e12_x@cyto.test").await,
        0
    );

    // ── the REPOSITORY refuses too, independently of the extractor ──
    let repo = AccountRepository::new(pool.clone());
    let err = repo
        .create_invitation(
            personal,
            "e12_y@cyto.test",
            AccountRole::Member,
            super::staff_ceiling(),
            InvitationLimits::defaults(),
        )
        .await
        .expect_err("the repository refuses a personal account on its own");
    assert_eq!(err.status_code(), 422);
    assert!(
        format!("{err:?}").contains(PERSONAL_ACCOUNT_NOT_MANAGEABLE),
        "…by the same name: {err:?}"
    );

    // ── the READ route, which ONLY `AccountScope` step 6 can refuse ──
    //
    // This is what makes the DEC-5 double-enforcement claim testable rather than asserted.
    // A blind tests-quality audit pointed out that the two guards return the SAME status and
    // the SAME code, so on a MUTATING route (which reaches the repository anyway) deleting
    // step 6 leaves everything green. `GET …/invitations` never reaches a mutating
    // repository function at all — which is precisely the case step 6's own comment says it
    // exists to cover — so this arm is the only one that binds it.
    let read = get_invitations(&server, &token, &personal.to_string(), "", None).await;
    assert_eq!(
        read.status, 422,
        "a READ on a personal account is refused too, by the extractor: {}",
        read.text
    );
    assert_eq!(
        read.code().as_deref(),
        Some(PERSONAL_ACCOUNT_NOT_MANAGEABLE),
        "by NAME: {}",
        read.text
    );

    // ── POSITIVE CONTROL: the same user, the same body, against an ORGANIZATION ──
    let org = make_org_account(&pool, "E12 Org", user).await;
    let ok = post_invitation(
        &server,
        &token,
        &org.to_string(),
        "e12_x@cyto.test",
        "member",
        None,
    )
    .await;
    assert_eq!(
        ok.status, 202,
        "the identical call against an organization succeeds, so the 422 is about the \
         account KIND and not about the request: {}",
        ok.text
    );
}

// ===========================================================================
// TEST-13 [acceptance] [invariant: INV-R1] [covers: ITEM-9, ITEM-10, ITEM-17]
// ===========================================================================
/// **INV-R1 — an account Admin cannot create a principal holding account Owner, via ANY
/// surface** — proven at `AccountRepository::add_member`, the function that CREATES a
/// role from nothing.
///
/// **This arm was not expressible before this branch.** #142 shipped `ActorCeiling` on
/// `set_role` and `remove_member` only, and recorded in the source that `add_member`
/// *"compiles, runs, and mints tenant-wide delete/transfer/share authority (DEC-12) with
/// no ceiling check anywhere"*, safe only because its single caller was the platform-staff
/// surface. #145 threaded the ceiling and wrapped the function in the transaction its live
/// re-read requires, so the invariant is now true by signature rather than by call graph —
/// and #146's accept path cannot omit it, because there is no signature in which to omit
/// it.
///
/// The repository is driven DIRECTLY because the invariant quantifies over *any* surface;
/// testing the invitation route alone would prove only that one route is safe. This is the
/// same reason `member_mutations_test.rs` drives `set_role` directly for the locked
/// ceiling re-read — HTTP cannot express these preconditions deterministically.
#[tokio::test]
async fn invr1_add_member_refuses_to_mint_a_role_above_the_actors() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "er1_owner", "er1_owner@cyto.test").await;
    let actor = create_user(&server, &admin_token, "er1_admin", "er1_admin@cyto.test").await;
    let target = create_user(&server, &admin_token, "er1_target", "er1_target@cyto.test").await;
    let target2 = create_user(&server, &admin_token, "er1_t2", "er1_t2@cyto.test").await;
    let target3 = create_user(&server, &admin_token, "er1_t3", "er1_t3@cyto.test").await;

    let org = make_org_account(&pool, "ER1 Org", owner).await;
    add_member(&pool, org, actor, "admin").await;
    let repo = AccountRepository::new(pool.clone());

    let as_admin = ActorCeiling::SelfService {
        actor_user_id: actor,
        observed_role: AccountRole::Admin,
    };

    // ── DENY: an admin mints an owner ──
    let err = repo
        .add_member(org, target, AccountRole::Owner, as_admin)
        .await
        .expect_err("an admin must not be able to CREATE an owner");
    assert_eq!(err.status_code(), 403, "an AUTHORITY refusal: {err:?}");
    assert!(
        format!("{err:?}").contains(ROLE_ABOVE_ACTOR),
        "…named ROLE_ABOVE_ACTOR: {err:?}"
    );
    assert!(
        role_of(&pool, org, target).await.is_none(),
        "and NO membership row was created — the transaction rolled back"
    );

    // ── POSITIVE CONTROL (a): the same call at the actor's own rank succeeds ──
    let m = repo
        .add_member(org, target, AccountRole::Admin, as_admin)
        .await
        .expect("an admin may add an admin — the EQUAL case must stay open");
    assert_eq!(m.role, AccountRole::Admin);
    assert_eq!(role_of(&pool, org, target).await.as_deref(), Some("admin"));

    // ── POSITIVE CONTROL (b): PLATFORM STAFF are unchanged by this branch ──
    let staff = repo
        .add_member(org, target2, AccountRole::Owner, super::staff_ceiling())
        .await
        .expect("the admin surface still mints owners — its behaviour is unchanged");
    assert_eq!(staff.role, AccountRole::Owner);
    assert_eq!(role_of(&pool, org, target2).await.as_deref(), Some("owner"));

    // ── POSITIVE CONTROL (c): the ceiling is LIVE, and clamped with `min` ──
    // The actor's `observed_role` claims Owner (what a stale extractor read would have
    // said); their live row says Admin. `min(observed, live)` must pick Admin and refuse.
    let stale_high = ActorCeiling::SelfService {
        actor_user_id: actor,
        observed_role: AccountRole::Owner,
    };
    let err = repo
        .add_member(org, target3, AccountRole::Owner, stale_high)
        .await
        .expect_err("a stale-high observed role must not raise the ceiling");
    assert!(
        format!("{err:?}").contains(ROLE_ABOVE_ACTOR),
        "the LIVE role wins: {err:?}"
    );
    assert!(role_of(&pool, org, target3).await.is_none());

    // …and a VANISHED actor is `404 Account`, byte-identically to the extractor's own
    // non-member refusal, rather than a 500 or a silent success.
    sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(actor)
        .execute(&pool)
        .await
        .expect("evict the actor");
    let err = repo
        .add_member(org, target3, AccountRole::Member, as_admin)
        .await
        .expect_err("an actor whose membership vanished mid-flight is refused");
    assert_eq!(err.status_code(), 404, "…as a 404, not a 403: {err:?}");
    assert!(role_of(&pool, org, target3).await.is_none());
}

// ===========================================================================
// TEST-14 [acceptance] [invariant: INV-RL] [covers: ITEM-11, ITEM-12, ITEM-17]
// ===========================================================================
/// **INV-RL — create is rate limited per actor and per account.**
///
/// > Rate limit create per actor and per account. […] an unrated create endpoint is a spam
/// > relay sending from your domain, with the attacker controlling the recipient and,
/// > through the account name, part of the body.
///
/// The windows are driven by seeding backdated rows rather than by sleeping, so the test
/// is deterministic and fast. Three things are proven, and the third is the one that keeps
/// the limiter from becoming an oracle of its own:
///
/// 1. the ACTOR window refuses, and a DIFFERENT actor in the same account is refused by
///    the ACCOUNT window while an actor in a DIFFERENT account is not;
/// 2. the window really is a window — rows aged out of it stop counting;
/// 3. the limit is evaluated BEFORE the email-dependent branch, proven by a 429 for an
///    address that would otherwise be a silent no-op 202.
#[tokio::test]
async fn invrl_invitation_create_is_rate_limited_per_actor_and_per_account() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limits = InvitationLimits::defaults();

    let owner = create_user(&server, &admin_token, "erl_owner", "erl_owner@cyto.test").await;
    let admin2 = create_user(&server, &admin_token, "erl_admin", "erl_admin@cyto.test").await;
    let other_owner = create_user(&server, &admin_token, "erl_other", "erl_other@cyto.test").await;
    let owner_token = login(&server, "erl_owner").await;
    let admin2_token = login(&server, "erl_admin").await;
    let other_token = login(&server, "erl_other").await;

    let org = make_org_account(&pool, "ERL Org", owner).await;
    add_member(&pool, org, admin2, "admin").await;
    let other_org = make_org_account(&pool, "ERL Other", other_owner).await;
    let org_s = org.to_string();
    let other_s = other_org.to_string();

    // ── PHASE 1: the ACTOR window ALONE. ──
    //
    // Seeded to the ACTOR ceiling exactly, which is strictly below the ACCOUNT ceiling —
    // that ordering is asserted by `limits_are_internally_coherent`, and the precondition
    // below re-asserts it here, so this arm cannot silently stop isolating if the constants
    // move. (They have moved twice; the numbers are deliberately not written in this prose.)
    // A blind tests-quality audit found the first version seeding to the ACCOUNT ceiling,
    // which tripped BOTH windows at once: deleting the two actor rows from the limiter's
    // `over` array left the whole test green.
    seed_mints(&pool, org, owner, limits.per_actor_per_hour, "a").await;
    assert!(
        limits.per_actor_per_hour < limits.per_account_per_hour,
        "precondition for isolation: the actor ceiling must be strictly below the account's"
    );

    let over = post_invitation(&server, &owner_token, &org_s, "erl_a@cyto.test", "member", None).await;
    assert_eq!(over.status, 429, "over the ACTOR ceiling: {}", over.text);
    assert_eq!(
        over.code().as_deref(),
        Some(INVITATION_RATE_LIMITED),
        "by NAME — 429 is also emitted by unrelated concurrency caps in this tree: {}",
        over.text
    );
    assert!(
        over.text.contains("you may mint"),
        "the message must name WHICH window tripped — here the ACTOR's ('you'), not the \
         account's — or this arm cannot tell the two ceilings apart: {}",
        over.text
    );
    assert_eq!(
        invitation_rows(&pool, org, "erl_a@cyto.test").await,
        0,
        "a refused create writes nothing"
    );

    // …while a DIFFERENT admin of the SAME account is NOT refused: the account has taken
    // only `per_actor_per_hour` mints, which is under its own ceiling, so only the ACTOR
    // window was full. This is what proves the two windows are independent rather than one
    // window with two names.
    let peer_ok = post_invitation(&server, &admin2_token, &org_s, "erl_peer@cyto.test", "member", None).await;
    assert_eq!(
        peer_ok.status, 202,
        "a second admin is unaffected by the FIRST admin's exhausted actor window: {}",
        peer_ok.text
    );

    // ── PHASE 2: the ACCOUNT window. ──
    // Top the account up to its own ceiling, attributed to a FILLER principal who takes no
    // other part in this test, so the second admin's own actor window stays nearly empty
    // and only the ACCOUNT window can refuse. The filler must NOT be `other_owner`: they
    // drive the different-account control below, and charging them the top-up here would
    // refuse that control on their own ACTOR window — which is exactly the confound this
    // phase exists to avoid, in the other direction.
    let filler = create_user(&server, &admin_token, "erl_filler", "erl_filler@cyto.test").await;
    seed_mints(
        &pool,
        org,
        filler,
        limits.per_account_per_hour - limits.per_actor_per_hour,
        "c",
    )
    .await;
    let peer = post_invitation(&server, &admin2_token, &org_s, "erl_b@cyto.test", "member", None).await;
    assert_eq!(
        peer.status, 429,
        "a second admin of the same account is now refused by the ACCOUNT window even \
         though their own actor window is nearly empty — which is what stops a set of \
         colluding or compromised admins: {}",
        peer.text
    );
    assert!(
        peer.text.contains("this account may mint"),
        "…and the message names the ACCOUNT window this time: {}",
        peer.text
    );
    // …while an admin of a DIFFERENT account is not, so the ceiling is scoped and not
    // simply global. `other_owner` has minted nothing anywhere, so neither window can
    // refuse them — which is what makes this a control for SCOPE rather than for luck.
    let elsewhere = post_invitation(&server, &other_token, &other_s, "erl_c@cyto.test", "member", None).await;
    assert_eq!(
        elsewhere.status, 202,
        "another ACCOUNT is unaffected — the window is per-account, not global: {}",
        elsewhere.text
    );

    // ── the limit runs BEFORE the email-dependent branch ──
    // `erl_owner@cyto.test` is already a member of this account, so without the ordering
    // it would be a silent no-op 202 and the rate limit would be observable by which
    // addresses "get through". It must be 429, and byte-identically to the first refusal.
    let member_addr = post_invitation(
        &server,
        &owner_token,
        &org_s,
        "erl_owner@cyto.test",
        "member",
        None,
    )
    .await;
    assert_eq!(
        member_addr.status, 429,
        "an already-a-member address is ALSO rate-limited — the limiter runs before the \
         branch, so it cannot be used to tell the four cases apart: {}",
        member_addr.text
    );
    assert_eq!(
        member_addr.text, over.text,
        "…and the refusal is byte-identical whatever the address is"
    );

    // ── POSITIVE CONTROL: age the seeded rows out and the very next create succeeds ──
    age_out_mints(&pool, org).await;
    let after = post_invitation(&server, &owner_token, &org_s, "erl_d@cyto.test", "member", None).await;
    assert_eq!(
        after.status, 202,
        "rows aged OUT of the window stop counting — this is a sliding window, not a \
         lifetime total, and without this arm the 429s above would also pass against an \
         endpoint that always refused: {}",
        after.text
    );
    assert_eq!(invitation_rows(&pool, org, "erl_d@cyto.test").await, 1);

    // ── resend mints a token too, so it is limited by the same ceilings ──
    let inv = live_invitation(&pool, org, "erl_d@cyto.test")
        .await
        .expect("live")
        .to_string();
    seed_mints(&pool, org, filler, limits.per_account_per_hour, "b").await;
    let resend_over = post_resend(&server, &owner_token, &org_s, &inv).await;
    assert_eq!(
        resend_over.status, 429,
        "a resend re-mints a live token, so an unrated resend would defeat the create \
         ceiling entirely: {}",
        resend_over.text
    );
    assert_eq!(resend_over.code().as_deref(), Some(INVITATION_RATE_LIMITED));
}

// ===========================================================================
// TEST-15 [acceptance] [invariant: INV-D8] [covers: ITEM-1, ITEM-5, ITEM-6, ITEM-7, ITEM-17]
// ===========================================================================
/// **INV-D8 — an invitation is re-attributed to the ACCOUNT, not tied to its inviter.**
///
/// > do NOT require the inviter to still hold standing. Re-attribute the invitation to the
/// > account. Keep `invited_by` as an FK-less audit field.
///
/// `membership-rescope.md` §7.5 calls this "the single most consequential invitation
/// decision", and it deliberately DIVERGES from #171's answer for project transfers (which
/// DOES require the initiator to still hold authority). The justification is that a
/// transfer *removes* a resource from the tenant, so initiator authority is the point,
/// whereas an invitation *adds* a member the remaining admins still want — and requiring
/// live standing creates a new stranding class of exactly the kind #178/#201 document.
///
/// **This is not in tension with #146's accept-time re-check**, and the distinction is the
/// reason both can be true: D-8 is about the inviter's STANDING; the re-check is about the
/// invitation's FROZEN ROLE. §7.5's own "Role changes mid-invitation" paragraph states
/// both together. This test pins the standing half, which is #145's; #146 owns the role
/// half at redemption.
#[tokio::test]
async fn invd8_an_invitation_survives_its_inviter_leaving_and_being_deleted() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let inviter = create_user(&server, &admin_token, "ed8_inviter", "ed8_inviter@cyto.test").await;
    let survivor = create_user(&server, &admin_token, "ed8_survivor", "ed8_survivor@cyto.test").await;
    let inviter_token = login(&server, "ed8_inviter").await;
    let survivor_token = login(&server, "ed8_survivor").await;

    let org = make_org_account(&pool, "ED8 Org", inviter).await;
    // A SECOND owner, so the inviter can leave without tripping `LAST_OWNER`.
    add_member(&pool, org, survivor, "owner").await;
    let org_s = org.to_string();

    let email = "ed8_invitee@cyto.test";
    assert_eq!(
        post_invitation(&server, &inviter_token, &org_s, email, "member", None)
            .await
            .status,
        202
    );
    let inv = live_invitation(&pool, org, email).await.expect("live");
    // Capture a usable token BEFORE the inviter goes, so the redeemability arm below is
    // about the invitation surviving and not about the token being unobtainable.
    let resent = post_resend(&server, &inviter_token, &org_s, &inv.to_string()).await;
    assert_eq!(resent.status, 200, "{}", resent.text);
    let plaintext = resent.json()["invite_token"].as_str().unwrap().to_string();

    // ── the inviter LEAVES the account ──
    let left = server
        .client
        .post(server.api_url(&format!("/accounts/{org_s}/members/leave")))
        .bearer_auth(&inviter_token)
        .send()
        .await
        .expect("leave request");
    assert_eq!(left.status().as_u16(), 204, "the inviter leaves");
    assert!(
        role_of(&pool, org, inviter).await.is_none(),
        "precondition: the inviter really is gone"
    );

    // ── the invitation is untouched, and the remaining owner can still work with it ──
    let listed = get_invitations(&server, &survivor_token, &org_s, "", None).await;
    assert_eq!(listed.status, 200, "{}", listed.text);
    assert!(
        listed.text.contains(email),
        "the invitation is still listed after its author left: {}",
        listed.text
    );
    assert!(
        listed.text.contains(&inviter.to_string()),
        "`invited_by` still names the departed inviter — an FK-less AUDIT field: {}",
        listed.text
    );

    // …and it is genuinely still redeemable, which is the property that matters (a listed
    // but unredeemable invitation would satisfy the assertions above and strand the
    // invitee anyway).
    let repo = AccountRepository::new(pool.clone());
    let found = repo
        .find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&plaintext))
        .await
        .expect("lookup")
        .expect("the invitation is still pending and redeemable after its inviter left");
    assert_eq!(found.id, inv);
    assert_eq!(found.invited_by, Some(inviter));

    // ── and the inviter's USER ROW is deleted outright ──
    // `invited_by` carries no foreign key precisely so this cannot cascade the invitation
    // away (the `accounts.admin_suspended_by` precedent). A future `ON DELETE CASCADE`
    // added "for tidiness" turns this red.
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(inviter)
        .execute(&pool)
        .await
        .expect("delete the inviter's user row");
    assert_eq!(
        invitation_rows(&pool, org, email).await,
        1,
        "the invitation SURVIVES its author's user row being deleted"
    );
    let still = repo
        .find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&plaintext))
        .await
        .expect("lookup")
        .expect("…and is still redeemable");
    assert_eq!(still.invited_by, Some(inviter), "the audit id is preserved");

    // ── POSITIVE CONTROL: the surviving owner can still resend and revoke it ──
    let r = post_resend(&server, &survivor_token, &org_s, &inv.to_string()).await;
    assert_eq!(r.status, 200, "another admin can resend it: {}", r.text);
    let d = delete_invitation(&server, &survivor_token, &org_s, &inv.to_string()).await;
    assert_eq!(d.status, 204, "…and revoke it: {}", d.text);
}

// ===========================================================================
// TEST-16 [covers: ITEM-6, ITEM-7, ITEM-8, ITEM-13, ITEM-14, ITEM-15, ITEM-17]
// ===========================================================================
/// The resend / revoke lifecycle, the "one live token at a time" property, and the
/// expired-slot supersession (#145 DEC-4).
///
/// Each arm names the mutation it kills:
/// * resend that fails to re-mint ⇒ the old token still resolves;
/// * resend that fails to invalidate ⇒ TWO tokens resolve, so a revoked link keeps working;
/// * revoke implemented as a DELETE ⇒ the audit row is gone;
/// * revoke that does not free the unique slot ⇒ re-inviting the address fails forever;
/// * a missing expired-row supersede ⇒ likewise, but only after the first expiry, which is
///   the failure that would ship and then appear weeks later.
#[tokio::test]
async fn resend_and_revoke_lifecycle_and_the_expired_slot() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "e16b_owner", "e16b_owner@cyto.test").await;
    let owner_token = login(&server, "e16b_owner").await;
    let org = make_org_account(&pool, "E16b Org", owner).await;
    let org_s = org.to_string();
    let repo = AccountRepository::new(pool.clone());

    let email = "e16b_invitee@cyto.test";
    assert_eq!(
        post_invitation(&server, &owner_token, &org_s, email, "member", None)
            .await
            .status,
        202
    );
    let inv = live_invitation(&pool, org, email).await.expect("live");
    let inv_s = inv.to_string();

    let first = post_resend(&server, &owner_token, &org_s, &inv_s).await;
    assert_eq!(first.status, 200, "{}", first.text);
    let t1 = first.json()["invite_token"].as_str().unwrap().to_string();
    let exp1: chrono::DateTime<chrono::Utc> =
        serde_json::from_value(first.json()["expires_at"].clone()).expect("expires_at");

    let second = post_resend(&server, &owner_token, &org_s, &inv_s).await;
    assert_eq!(second.status, 200, "{}", second.text);
    let t2 = second.json()["invite_token"].as_str().unwrap().to_string();
    let exp2: chrono::DateTime<chrono::Utc> =
        serde_json::from_value(second.json()["expires_at"].clone()).expect("expires_at");

    assert_ne!(t1, t2, "each resend mints a NEW token");
    assert!(exp2 >= exp1, "…and the RESPONSE reports a fresh expiry");
    // …and the ROW carries it. The response's `expires_at` is computed in Rust and returned
    // whether or not the UPDATE persisted it, so asserting only on the response would let a
    // mutation dropping `expires_at = $4` from resend's UPDATE pass — the confound a blind
    // tests-quality audit found. Compared to the ORIGINAL expiry (7 days from the create),
    // not to the previous resend's, because `to_pg_timestamptz` has second precision and
    // two resends in the same second are legitimately equal.
    let (row_expiry, row_count): (chrono::DateTime<chrono::Utc>, i32) = sqlx::query_as(
        "SELECT expires_at, resend_count FROM account_invitations WHERE id = $1",
    )
    .bind(inv)
    .fetch_one(&pool)
    .await
    .expect("read the row's expiry");
    assert!(
        (row_expiry - exp2).num_seconds().abs() <= 1,
        "the ROW's expires_at must be the one the resend returned (row {row_expiry}, \
         response {exp2}) — otherwise the link the inviter is holding expires on the OLD \
         schedule while the API told them otherwise"
    );
    assert_eq!(
        row_count, 2,
        "resend_count is the invitation's AUDIT column and counts both resends"
    );
    assert_eq!(
        second.json()["invitation_id"].as_str(),
        Some(inv_s.as_str()),
        "the row is UPDATED in place — the invitation keeps its identity across a resend"
    );

    // ONE live token at a time: the old one must be dead, the new one alive.
    assert!(
        repo.find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&t1))
            .await
            .expect("lookup")
            .is_none(),
        "the SUPERSEDED token must no longer resolve, or a link the admin meant to \
         replace keeps working"
    );
    assert_eq!(
        repo.find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&t2))
            .await
            .expect("lookup")
            .expect("the fresh token resolves")
            .id,
        inv
    );

    // ── revoke: soft, and it frees the slot ──
    assert_eq!(
        delete_invitation(&server, &owner_token, &org_s, &inv_s).await.status,
        204
    );
    let after: (Option<chrono::DateTime<chrono::Utc>>, Option<Uuid>) =
        sqlx::query_as("SELECT revoked_at, revoked_by FROM account_invitations WHERE id = $1")
            .bind(inv)
            .fetch_one(&pool)
            .await
            .expect("THE ROW STILL EXISTS — revocation is a stamp, never a DELETE (audit)");
    assert!(after.0.is_some(), "revoked_at is stamped");
    assert_eq!(after.1, Some(owner), "…and revoked_by names who did it");

    assert!(
        repo.find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&t2))
            .await
            .expect("lookup")
            .is_none(),
        "a revoked invitation's token stops resolving"
    );
    assert_eq!(
        post_resend(&server, &owner_token, &org_s, &inv_s).await.status,
        404,
        "resending a revoked invitation is a 404 — it is no longer pending"
    );
    assert_eq!(
        delete_invitation(&server, &owner_token, &org_s, &inv_s).await.status,
        404,
        "a SECOND revoke is a 404, not a silent 204 — the row is already settled"
    );

    // …and the address may be invited afresh (the partial unique index freed the slot).
    let again = post_invitation(&server, &owner_token, &org_s, email, "member", None).await;
    assert_eq!(
        again.status, 202,
        "a revoked address can be re-invited: {}",
        again.text
    );
    assert_eq!(
        invitation_rows(&pool, org, email).await,
        2,
        "…as a NEW row; the revoked one is still there (audit)"
    );

    // ── DEC-4: an EXPIRED but unrevoked row must not block a re-invite forever ──
    // The partial unique index cannot mention expiry (`now()` is not IMMUTABLE), so
    // without the supersede step at mint time this next create fails on a unique
    // violation. This is the exact question `membership-rescope.md` §13.3 left unresolved.
    let live2 = live_invitation(&pool, org, email).await.expect("the new one");
    sqlx::query("UPDATE account_invitations SET expires_at = now() - interval '1 day' WHERE id = $1")
        .bind(live2)
        .execute(&pool)
        .await
        .expect("expire it");
    let third = post_invitation(&server, &owner_token, &org_s, email, "member", None).await;
    assert_eq!(
        third.status, 202,
        "re-inviting an address whose invitation EXPIRED must succeed: {}",
        third.text
    );
    let superseded: (Option<chrono::DateTime<chrono::Utc>>, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT revoked_at, expires_at FROM account_invitations WHERE id = $1")
            .bind(live2)
            .fetch_one(&pool)
            .await
            .expect("the expired row still exists — superseded, not deleted");
    let revoked_at = superseded.0.expect("the expired row was stamped revoked");
    assert!(
        superseded.1 <= revoked_at,
        "a SUPERSEDED row has expires_at <= revoked_at, which is how #148 will tell it \
         apart from a human revoke without a new column"
    );
    assert_eq!(invitation_rows(&pool, org, email).await, 3, "three rows, none deleted");

    // ── the CLAIM PREDICATE's other two clauses, exercised through the real lookup ──
    //
    // `invitation_is_claimable` is the PURE twin of the SQL in
    // `find_pending_invitation_by_token_hash`, and TEST-3 pins its truth table — but the
    // twin has no production caller, so a mutation dropping `expires_at > now()` or
    // `accepted_at IS NULL` from the SQL left TEST-3 green and nothing else red. A blind
    // tests-quality audit measured exactly that: of the three clauses, only
    // `revoked_at IS NULL` was covered behaviourally. These two arms cover the others.
    let fresh = post_invitation(&server, &owner_token, &org_s, "e16b_claim@cyto.test", "member", None).await;
    assert_eq!(fresh.status, 202, "{}", fresh.text);
    let claim_id = live_invitation(&pool, org, "e16b_claim@cyto.test").await.expect("live");
    let claim_tok = post_resend(&server, &owner_token, &org_s, &claim_id.to_string())
        .await
        .json()["invite_token"]
        .as_str()
        .expect("token")
        .to_string();
    assert!(
        repo.find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&claim_tok))
            .await
            .expect("lookup")
            .is_some(),
        "precondition: the fresh token resolves"
    );

    // (a) EXPIRED ⇒ the token must stop resolving.
    sqlx::query("UPDATE account_invitations SET expires_at = now() - interval '1 second' WHERE id = $1")
        .bind(claim_id)
        .execute(&pool)
        .await
        .expect("expire it");
    assert!(
        repo.find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&claim_tok))
            .await
            .expect("lookup")
            .is_none(),
        "an EXPIRED token must not resolve — expiry is enforced in the SQL predicate, not \
         by a sweeper, so a missing sweeper can never make a stale invitation acceptable"
    );

    // (b) ACCEPTED ⇒ likewise (single-use). Restore the expiry first so the ONLY thing
    //     refusing is the acceptance stamp.
    sqlx::query(
        "UPDATE account_invitations SET expires_at = now() + interval '7 days', \
         accepted_at = now(), accepted_by = $2 WHERE id = $1",
    )
    .bind(claim_id)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("un-expire and accept it");
    assert!(
        repo.find_pending_invitation_by_token_hash(&invitation_token::token_sha256(&claim_tok))
            .await
            .expect("lookup")
            .is_none(),
        "an ACCEPTED token must not resolve — this is the single-use half, and #146's \
         claim-as-UPDATE depends on this predicate being exactly these three clauses"
    );

    // ── the regen landed in BOTH generated client trees ──
    //
    // "Both" here is the DEFAULT client and the SAAS client (`just openapi-regen` runs two
    // cargo passes, the second with `--features saas`), **not** a desktop tree: this app
    // has no `src-app/desktop/ui`, and `MERGE_GENERATED` in `.claude/app.config` lists ten
    // files, all under `src-app/ui/`. A backend-only change that forgets the regen leaves
    // the frontend unable to call the routes at all, and no cargo test would otherwise
    // notice. Checking the SAAS client specifically matters because it is generated by a
    // separate pass that a partial regen can silently skip.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-app");
    for rel in [
        "ui/src/api-client/apiEndpoints.ts",
        "ui/src/api-client-saas/apiEndpoints.ts",
    ] {
        let p = root.join(rel);
        let body = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {p:?}: {e}"));
        for id in [
            "createInvitation",
            "listInvitations",
            "resendInvitation",
            "revokeInvitation",
        ] {
            assert!(
                body.contains(id),
                "{rel} is missing `{id}` — run `just openapi-regen` (it runs BOTH passes, \
                 default and --features saas; the merge-gate's C3 checks regen parity)"
            );
        }
    }
}

// ===========================================================================
// TEST-17 [acceptance] [invariant: INV-2] [covers: ITEM-12, ITEM-13, ITEM-17]
// ===========================================================================
/// **INV-2 — the ambient `X-Account-Id` header cannot override the path.**
///
/// #139's DEC-1 is stronger than "the path wins": on `/api/accounts/{account_id}/…` the
/// header is **not consulted at all** — not parsed, not compared, not 400'd. The reason is
/// that the frontend stamps it on *every* same-origin request from a global interceptor
/// driven by the account switcher, so it is ambient state rather than a declaration of
/// intent, and `member_scope.rs` deliberately does not import `parse_account_header` so
/// the property holds by construction.
///
/// Both directions are asserted, and both matter:
/// * a NON-MEMBER path with a member header must not be authorized (the confused-deputy
///   case) — and must be byte-identical to the same call with no header, which is what
///   proves the header was ignored rather than merely un-preferred;
/// * a MEMBER path with a foreign header must still succeed, and the row must land on the
///   PATH's account — which is what proves the header is not additive or subtractive.
#[tokio::test]
async fn inv2_the_account_header_is_ignored_in_both_directions() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let a_owner = create_user(&server, &admin_token, "e2_a", "e2_a@cyto.test").await;
    let b_owner = create_user(&server, &admin_token, "e2_b", "e2_b@cyto.test").await;
    let b_member = create_user(&server, &admin_token, "e2_bm", "e2_bm@cyto.test").await;
    let a_token = login(&server, "e2_a").await;
    let b_token = login(&server, "e2_b").await;

    let a = make_org_account(&pool, "E2 A", a_owner).await;
    let b = make_org_account(&pool, "E2 B", b_owner).await;
    add_member(&pool, b, b_member, "member").await;
    let a_s = a.to_string();
    let b_s = b.to_string();

    // B is POPULATED and holds a live invitation of its own.
    assert_eq!(
        post_invitation(&server, &b_token, &b_s, "e2_binv@cyto.test", "member", None)
            .await
            .status,
        202
    );
    assert_eq!(member_count(&pool, b).await, 2);

    // ── DENY: path = B (A's owner is not a member), header = A (where they ARE owner) ──
    let with_header =
        post_invitation(&server, &a_token, &b_s, "e2_x@cyto.test", "member", Some(&a_s)).await;
    let no_header = post_invitation(&server, &a_token, &b_s, "e2_x@cyto.test", "member", None).await;

    assert_eq!(
        (with_header.status, no_header.status),
        (404, 404),
        "the header neither authorizes (no 202) nor is validated (no 400 mismatch): {} | {}",
        with_header.text,
        no_header.text
    );
    assert_eq!(
        with_header.text, no_header.text,
        "byte-identical with and without the header — which is what 'the header is not \
         consulted at all' means, as opposed to 'the path is preferred'"
    );
    assert_eq!(
        invitation_rows(&pool, b, "e2_x@cyto.test").await,
        0,
        "nothing landed on B"
    );
    assert_eq!(
        invitation_rows(&pool, a, "e2_x@cyto.test").await,
        0,
        "…and nothing was redirected onto A either"
    );

    // ── POSITIVE CONTROL: path = A (theirs), header = B (foreign, ambient) ⇒ 202 on A ──
    let ok = post_invitation(&server, &a_token, &a_s, "e2_ok@cyto.test", "member", Some(&b_s)).await;
    assert_eq!(
        ok.status, 202,
        "a foreign ambient header must not BLOCK a request whose path is legitimate — \
         the frontend stamps that header on every request: {}",
        ok.text
    );
    assert_eq!(
        invitation_rows(&pool, a, "e2_ok@cyto.test").await,
        1,
        "the row landed on the PATH's account"
    );
    assert_eq!(
        invitation_rows(&pool, b, "e2_ok@cyto.test").await,
        0,
        "…and NOT on the header's — writing to the header's account while authorizing on \
         the path is the textbook confused deputy"
    );

    // ── B is untouched throughout ──
    assert_eq!(member_count(&pool, b).await, 2);
    assert!(
        live_invitation(&pool, b, "e2_binv@cyto.test").await.is_some(),
        "B's own invitation is still live"
    );
}

// ===========================================================================
// TEST-18 [acceptance] [invariant: INV-RL] [covers: ITEM-6, ITEM-11, ITEM-17]
// ===========================================================================
/// **A resend SPENDS mint budget, not just checks it** (FIX_ROUND-1, F1).
///
/// This is the arm the first implementation was missing, and its absence let a real hole
/// ship into the branch: the limiter counted rows by `created_at`, and `resend` UPDATEs an
/// existing row, so a resend was graded against a budget it never consumed. One invitation
/// could be resent without bound — unlimited fresh live 256-bit bearer tokens, and once
/// #143's mailer exists, unlimited outbound mail from this domain to an attacker-chosen
/// recipient. All three blind audit angles found it independently.
///
/// TEST-14's resend arm did NOT catch it, and the reason is worth stating because it is
/// the general shape: that arm seeds *create* rows to push the counter over and then
/// asserts the resend is refused. It proves resend is **checked against** the counter. It
/// says nothing about whether resend **contributes** to it, and a check against a budget
/// nothing spends is not a limit.
///
/// **The mutation this kills:** drop the `Self::record_invitation_mint(...)` call from
/// `resend_invitation`. TEST-14 stays green (it seeds the counter from creates and only
/// proves resend is CHECKED against it); this goes red on the loop that then never refuses.
///
/// Stated precisely, because the earlier version of this line named the wrong mutation.
/// It said "drop `resend_count = resend_count + 1, last_resent_at, last_resent_by`" — those
/// three columns WERE the budget under FIX_ROUND-1, but FIX_ROUND-2 moved the budget to
/// `account_invitation_mints` and left them as the invitation's audit columns. That
/// mutation now changes no rate-limiting at all; it fails only the two trailing audit
/// assertions below, so a later author trimming those would silently unbind the property
/// this test's name claims.
///
/// **Every resend is charged, including the first.** FIX_ROUND-3 briefly exempted the first
/// resend of each invitation, on the (correct) observation that DEC-2's create → resend →
/// copy flow makes one usable link cost two mints. That remedy was wrong and two blind
/// angles reproduced why: the exemption was a credit attached to the invitation ROW, not to
/// a window, so it could be earned in one window and spent in another — an auditor drove 30
/// fresh tokens through the real routes in one hour with the ledger recording ZERO in-window
/// mints. The unit problem was fixed where it belonged, in `InvitationLimits`: the ceilings
/// now say MINTS and the numbers were doubled to keep the same human-scale intent.
#[tokio::test]
async fn invrl_a_resend_consumes_mint_budget_not_merely_checks_it() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limits = InvitationLimits::defaults();

    let owner = create_user(&server, &admin_token, "ers_owner", "ers_owner@cyto.test").await;
    let owner_token = login(&server, "ers_owner").await;
    let org = make_org_account(&pool, "ERS Org", owner).await;
    let org_s = org.to_string();

    // A FRESH actor with an EMPTY window: exactly one create, then nothing but resends.
    let created = post_invitation(&server, &owner_token, &org_s, "ers_a@cyto.test", "member", None).await;
    assert_eq!(created.status, 202, "{}", created.text);
    let inv = live_invitation(&pool, org, "ers_a@cyto.test")
        .await
        .expect("live")
        .to_string();

    // ── POSITIVE CONTROL first: the very next resend succeeds. Without this, a refusal
    //    below could mean "resend is broken" rather than "the budget ran out". ──
    let first = post_resend(&server, &owner_token, &org_s, &inv).await;
    assert_eq!(
        first.status, 200,
        "a resend from an actor well inside their window succeeds: {}",
        first.text
    );

    // ── Now loop. Each resend must cost something, so the loop MUST terminate in a 429
    //    well inside the ceiling's own bound — never running away. ──
    let bound = limits.per_actor_per_hour + 5;
    let mut refused_at: Option<i64> = None;
    for i in 1..bound {
        let r = post_resend(&server, &owner_token, &org_s, &inv).await;
        if r.status == 429 {
            assert_eq!(
                r.code().as_deref(),
                Some(INVITATION_RATE_LIMITED),
                "the refusal is the mint budget, by NAME: {}",
                r.text
            );
            refused_at = Some(i);
            break;
        }
        assert_eq!(r.status, 200, "resend {i} unexpectedly failed: {}", r.text);
    }
    let refused_at = refused_at.unwrap_or_else(|| {
        panic!(
            "resending ONE invitation was never refused in {bound} attempts — the resend \
             path does not consume mint budget, so the ceiling it is checked against is a \
             budget nothing spends. That is the F1 hole."
        )
    });
    assert!(
        refused_at <= limits.per_actor_per_hour,
        "the refusal must arrive within the actor's own hourly ceiling ({}), not merely \
         eventually; it arrived at {refused_at}",
        limits.per_actor_per_hour
    );

    // ── the row records what it spent, which is what makes the accounting auditable ──
    let (count, last_by): (i32, Option<Uuid>) = sqlx::query_as(
        "SELECT resend_count, last_resent_by FROM account_invitations WHERE id = $1::uuid",
    )
    .bind(&inv)
    .fetch_one(&pool)
    .await
    .expect("read the resend accounting");
    assert_eq!(
        i64::from(count),
        refused_at,
        "resend_count equals the number of SUCCESSFUL resends — a refused one must not be \
         charged, or the audit column drifts away from what actually happened"
    );
    // And the MINT ledger — which is what the ceiling actually reads — records one row per
    // CHARGED mint: the create, plus every resend after the free first one.
    let mints: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM account_invitation_mints WHERE invitation_id = $1::uuid",
    )
    .bind(&inv)
    .fetch_one(&pool)
    .await
    .expect("count mint records");
    assert_eq!(
        mints,
        refused_at + 1,
        "one mint record for the CREATE plus one for EVERY successful resend, with no \
         exemption. An exemption for the first resend was tried and reverted: it was a \
         credit on the invitation ROW rather than on a window, so it could be banked \
         across windows and defeated the ceiling entirely"
    );
    assert_eq!(
        last_by,
        Some(owner),
        "the charge is attributed to whoever resent it, which may differ from invited_by"
    );

    // ── and the budget is SHARED with create, not a separate allowance: with the actor's
    //    window now full of resends, a plain create is refused too. ──
    let create_after = post_invitation(&server, &owner_token, &org_s, "ers_b@cyto.test", "member", None).await;
    assert_eq!(
        create_after.status, 429,
        "resends and creates draw on ONE budget — otherwise an attacker simply alternates \
         between them: {}",
        create_after.text
    );
    assert_eq!(invitation_rows(&pool, org, "ers_b@cyto.test").await, 0);
}

// ===========================================================================
// TEST-19 [covers: ITEM-6, ITEM-10, ITEM-17]
// ===========================================================================
/// **R-1 is re-graded on resend** — an admin cannot refresh an `owner` invitation issued
/// by someone who outranked them (FIX_ROUND-1, F10).
///
/// `resend_invitation_docs` promises exactly this in the shipped OpenAPI, and nothing
/// asserted it: deleting the `refuse_if_above_ceiling` call from `resend_invitation` left
/// the entire suite green. A resend is not a read — it re-mints a LIVE token and pushes the
/// expiry out — so an actor who may not confer a role must not be able to keep conferring
/// it by refreshing an old offer.
///
/// **A recorded consequence, because it interacts with INV-D8 and the interaction is not
/// obvious.** DEC-2 makes resend the only channel that ever surfaces a plaintext link. So
/// an `owner` invitation is link-mintable only by someone who currently ranks `owner`. That
/// is NOT the stranding class §7.5/D-8 forbids — an account always keeps at least one owner
/// (`LAST_OWNER` refuses the last one leaving or self-demoting), so an owner-ranked actor
/// always exists to mint it, and the invitation itself remains valid and redeemable
/// throughout (TEST-15 proves that). The residual case is an account whose sole owner's
/// USER ROW is hard-deleted, which is the same ownerless state `lock_account_row` exists to
/// keep from silently breaking guards, and which is out of this item's scope to create.
#[tokio::test]
async fn resend_re_grades_the_role_ceiling_against_the_live_role() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "erg_owner", "erg_owner@cyto.test").await;
    let junior = create_user(&server, &admin_token, "erg_admin", "erg_admin@cyto.test").await;
    let owner_token = login(&server, "erg_owner").await;
    let junior_token = login(&server, "erg_admin").await;

    let org = make_org_account(&pool, "ERG Org", owner).await;
    add_member(&pool, org, junior, "admin").await;
    let org_s = org.to_string();

    // The OWNER issues an `owner` invitation and an `admin` one.
    for (email, role) in [("erg_o@cyto.test", "owner"), ("erg_a@cyto.test", "admin")] {
        let r = post_invitation(&server, &owner_token, &org_s, email, role, None).await;
        assert_eq!(r.status, 202, "seed {email}: {}", r.text);
    }
    let owner_inv = live_invitation(&pool, org, "erg_o@cyto.test").await.expect("live").to_string();
    let admin_inv = live_invitation(&pool, org, "erg_a@cyto.test").await.expect("live").to_string();

    // Capture the owner-invitation's token hash so we can prove a refused resend changed
    // nothing — a guard that refuses AFTER writing is not a guard.
    let before: (Vec<u8>, i32) = sqlx::query_as(
        "SELECT token_sha256, resend_count FROM account_invitations WHERE id = $1::uuid",
    )
    .bind(&owner_inv)
    .fetch_one(&pool)
    .await
    .expect("read before");

    // ── DENY: the ADMIN tries to refresh the OWNER invitation ──
    let deny = post_resend(&server, &junior_token, &org_s, &owner_inv).await;
    assert_eq!(
        deny.status, 403,
        "an admin may not re-mint a live link for a grant they cannot confer: {}",
        deny.text
    );
    assert_eq!(
        deny.code().as_deref(),
        Some(ROLE_ABOVE_ACTOR),
        "by NAME — a 404 here would mean the invitation was not found, which is a \
         different (and wrong) answer: {}",
        deny.text
    );
    let after: (Vec<u8>, i32) = sqlx::query_as(
        "SELECT token_sha256, resend_count FROM account_invitations WHERE id = $1::uuid",
    )
    .bind(&owner_inv)
    .fetch_one(&pool)
    .await
    .expect("read after");
    assert_eq!(before.0, after.0, "the refused resend minted NOTHING");
    assert_eq!(
        before.1, after.1,
        "…and was not charged to the mint budget either"
    );

    // ── POSITIVE CONTROL (a): the same admin CAN refresh an `admin` invitation ──
    let ok = post_resend(&server, &junior_token, &org_s, &admin_inv).await;
    assert_eq!(
        ok.status, 200,
        "the refusal is about the invitation's ROLE, not about this actor being unable to \
         resend at all: {}",
        ok.text
    );

    // ── POSITIVE CONTROL (b): the OWNER can still refresh the owner invitation ──
    let owner_ok = post_resend(&server, &owner_token, &org_s, &owner_inv).await;
    assert_eq!(
        owner_ok.status, 200,
        "an owner-ranked actor mints the owner invitation's link — so the invitation is \
         not stranded, which is what INV-D8 requires: {}",
        owner_ok.text
    );

    // ── REVOKE is deliberately NOT ceiling-graded (DEC-9): the same admin who could not
    //    RESEND the owner invitation CAN revoke it. Revoking removes no role, so there is
    //    no standing to be above, and gating it would trap an owner invitation nobody
    //    junior could clean up. ──
    let revoked = delete_invitation(&server, &junior_token, &org_s, &owner_inv).await;
    assert_eq!(
        revoked.status, 204,
        "an admin may revoke an owner invitation even though they may not resend it: {}",
        revoked.text
    );
}

// ===========================================================================
// TEST-20 [acceptance] [invariant: INV-8] [covers: ITEM-3, ITEM-12, ITEM-17]
// ===========================================================================
/// **A malformed address is refused BEFORE it is stored** (FIX_ROUND-1, F4).
///
/// `normalize_email` trims outer whitespace; an INTERIOR CRLF survives `trim()`, and this
/// value is stored verbatim and is exactly what #143's mailer will place in an RFC 5322
/// `To:` header. A blind security audit pointed out that the first implementation
/// *documented the untouched interior as intentional*, which made
/// `a@b.com\r\nBcc: <ten thousand addresses>` a storable value — and that by the time a
/// mailer exists nobody re-audits what is already in the table.
///
/// The over-long case is a separate failure with the same fix. Stated precisely, because
/// the first version of this comment overclaimed it: the 306-byte address used here is well
/// under the ~2704-byte btree tuple limit, so what this arm actually pins is the **400
/// contract** (`MAX_EMAIL_BYTES`), not the 500. The 500 is what the bound EXISTS to prevent
/// — the live-invitation unique index is a btree on `(account_id, email)`, so a
/// multi-kilobyte address would make the INSERT fail with `index row size exceeds maximum`
/// — and the migration's `char_length(email) <= 254` CHECK is the backstop for it. Driving
/// a genuinely multi-kilobyte address here would exercise a path the CHECK now makes
/// unreachable, so the honest thing is to pin the contract and say what the bound is for.
#[tokio::test]
async fn a_malformed_or_injecting_address_is_400_and_stores_nothing() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "einj_owner", "einj_owner@cyto.test").await;
    let owner_token = login(&server, "einj_owner").await;
    let org = make_org_account(&pool, "EINJ Org", owner).await;
    let org_s = org.to_string();

    let before = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM account_invitations WHERE account_id = $1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .expect("count");

    let long_local = "a".repeat(300);
    // EVERY control-character payload here has exactly ONE `@`. That is load-bearing: a
    // payload like `einj@x.com\r\nBcc: victim@x.com` carries a SECOND `@` and is refused by
    // the SHAPE rule, so it would still 400 with the control-character guard deleted — the
    // confound a blind tests-quality audit found in the first version of this test. These
    // are refused by the injection guard and by nothing else.
    for bad in [
        "einj@x.com\r\nBcc-header-only",
        "einj@x.com\nX-Injected: yes",
        "einj@x.com\rSubject: spam",
        "",
        "   ",
        "nobody",
        "@x.com",
        format!("{long_local}@x.com").as_str(),
    ] {
        let r = post_invitation(&server, &owner_token, &org_s, bad, "member", None).await;
        assert_eq!(
            r.status, 400,
            "a malformed address is a 400, never a 500 and never a stored row: {bad:?} -> {}",
            r.text
        );
        assert_eq!(
            r.code().as_deref(),
            Some("INVALID_EMAIL"),
            "by NAME: {bad:?} -> {}",
            r.text
        );
    }

    let after = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM account_invitations WHERE account_id = $1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(
        before, after,
        "not one of the refused addresses reached the table — which is the point: a \
         control character stored today is a mail header injected the day #143 lands"
    );

    // ── POSITIVE CONTROL: an ordinary address with dots, a plus tag and mixed case is
    //    accepted and stored NORMALIZED (which is what the migration's CHECK enforces). ──
    let ok = post_invitation(
        &server,
        &owner_token,
        &org_s,
        "  First.Last+Tag@Sub.Example.CO.UK  ",
        "member",
        None,
    )
    .await;
    assert_eq!(ok.status, 202, "a real address is accepted: {}", ok.text);
    assert_eq!(
        invitation_rows(&pool, org, "first.last+tag@sub.example.co.uk").await,
        1,
        "…and is stored trimmed and lowercased, with its interior untouched"
    );
}

// ===========================================================================
// TEST-21 [acceptance] [invariant: INV-R1] [covers: ITEM-9, ITEM-17]
// ===========================================================================
/// **`add_member_in_tx` is a usable seam for #146's accept transaction** (FIX_ROUND-1, F8).
///
/// Shipping only the pool-owning `add_member` made #146's contract unsatisfiable in two
/// ways a blind design-conformance audit spelled out: its INV-17 requires the membership
/// INSERT and the `accepted_at` stamp to roll back together (impossible if `add_member`
/// commits on its own), and the instruction left for #146 — take the account lock, re-read
/// the inviter's role, then call `add_member` — **self-deadlocks**, because the pool-owning
/// call runs on a different connection and blocks on row locks the caller already holds,
/// with Postgres unable to see a cycle across two sessions.
///
/// This test drives the shape #146 will actually write: open a transaction, take the locks,
/// do other work, then call `add_member_in_tx` on that same connection, then commit. It
/// asserts three things — it does not hang, the ceiling still applies, and the whole thing
/// is atomic with the caller's own write.
///
/// The `#[tokio::test(flavor = "multi_thread")]` and the timeout are deliberate: a deadlock
/// here would otherwise be an infinite hang rather than a failure, and a test that hangs is
/// a test that gets killed and ignored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_member_in_tx_composes_with_a_caller_owned_transaction() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "eit_owner", "eit_owner@cyto.test").await;
    let actor = create_user(&server, &admin_token, "eit_admin", "eit_admin@cyto.test").await;
    let target = create_user(&server, &admin_token, "eit_t", "eit_t@cyto.test").await;
    let target2 = create_user(&server, &admin_token, "eit_t2", "eit_t2@cyto.test").await;

    let org = make_org_account(&pool, "EIT Org", owner).await;
    add_member(&pool, org, actor, "admin").await;

    let as_admin = ActorCeiling::SelfService {
        actor_user_id: actor,
        observed_role: AccountRole::Admin,
    };

    // ── the shape #146 will write, with a hard timeout so a deadlock FAILS rather than
    //    hanging forever ──
    let happy = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let mut tx = pool.begin().await.expect("begin");
        // The caller takes the locks itself, exactly as #146's accept must.
        // `FOR NO KEY UPDATE`, not `FOR UPDATE`. This test is the canonical "here is the
        // shape #146 will write", so the mode matters: `FOR UPDATE` on a parent row
        // conflicts with the implicit `FOR KEY SHARE` every FK-child INSERT takes, which
        // would block every concurrent project/dataset/invitation write for that account
        // for the life of the accept transaction — with `lock_timeout = 0`, unboundedly.
        // `lock_account_row`'s doc carries the full argument and the empirical verification.
        // An exemplar that demonstrates the hazard the module just removed is an exemplar
        // that reintroduces it.
        sqlx::query("SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE")
            .bind(org)
            .execute(&mut *tx)
            .await
            .expect("lock the account row");
        sqlx::query("SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'owner' FOR UPDATE")
            .bind(org)
            .execute(&mut *tx)
            .await
            .expect("lock the owner rows");

        // …then hands the SAME connection to the repository. A pool-owning `add_member`
        // would block here, forever, on locks this very transaction holds.
        let member = AccountRepository::add_member_in_tx(
            &mut tx,
            org,
            target,
            AccountRole::Member,
            as_admin,
            None,
        )
        .await
        .expect("add_member_in_tx on the caller's connection");

        // …and a second write in the SAME transaction, which is what makes #146's
        // "roll back together or not at all" expressible at all.
        sqlx::query("UPDATE accounts SET name = $2 WHERE id = $1")
            .bind(org)
            .bind("EIT Org (accepted)")
            .execute(&mut *tx)
            .await
            .expect("the caller's own write");

        tx.commit().await.expect("commit");
        member
    })
    .await
    .expect(
        "add_member_in_tx DEADLOCKED against the caller's own locks — this is exactly the \
         failure that made #146's accept transaction unbuildable, and Postgres cannot \
         detect it because the two sides would be separate sessions",
    );
    assert_eq!(happy.role, AccountRole::Member);
    assert_eq!(role_of(&pool, org, target).await.as_deref(), Some("member"));

    // ── the ceiling still applies through the seam ──
    let mut tx = pool.begin().await.expect("begin");
    let err = AccountRepository::add_member_in_tx(&mut tx, org, target2, AccountRole::Owner, as_admin, None)
        .await
        .expect_err("an admin may not mint an owner, through this seam either");
    assert_eq!(err.status_code(), 403);
    assert!(format!("{err:?}").contains(ROLE_ABOVE_ACTOR), "{err:?}");
    drop(tx);
    assert!(
        role_of(&pool, org, target2).await.is_none(),
        "nothing was written"
    );

    // ── H-2 STILL BINDS THROUGH THE SEAM ──
    //
    // `add_member_in_tx` calls `refuse_if_personal_on` itself. That line was added because a
    // blind audit found the seam had DROPPED the guard — H-2's own doc says it lives in the
    // repository "so it … cannot be forgotten by a third caller", and the seam was exactly
    // that third caller. A later audit then found the fix shipped with no coverage: deleting
    // the call left the whole suite green, because every other personal-account arm drives a
    // different function. This is the arm that binds it.
    //
    // Under DEC-12 the missed state is not cosmetic: a membership row on a personal account
    // is an implicit ≥Viewer grant over everything that user ever created.
    let victim = create_user(&server, &admin_token, "eit_victim", "eit_victim@cyto.test").await;
    let intruder = create_user(&server, &admin_token, "eit_intruder", "eit_intruder@cyto.test").await;
    let victim_personal = personal_account_id(&pool, victim).await;
    {
        let mut tx = pool.begin().await.expect("begin");
        let err = AccountRepository::add_member_in_tx(
            &mut tx,
            victim_personal,
            intruder,
            AccountRole::Member,
            super::staff_ceiling(),
            None,
        )
        .await
        .expect_err("the seam must refuse a PERSONAL account, exactly as the wrapper does");
        assert_eq!(err.status_code(), 422, "{err:?}");
        assert!(
            format!("{err:?}").contains(PERSONAL_ACCOUNT_NOT_MANAGEABLE),
            "by NAME — `LAST_OWNER` is also a 422 from this module: {err:?}"
        );
    }
    assert_eq!(
        member_count(&pool, victim_personal).await,
        1,
        "the victim's personal account still has exactly one member, its owner"
    );
    // …and `PlatformStaff` was used deliberately: it is the ceiling that DISABLES R-1, so
    // the refusal above can only be H-2. With a SelfService ceiling the call would have been
    // refused for a different reason and this arm would prove nothing.

    // ── ATOMICITY: a caller that rolls back takes the membership with it, which is the
    //    property #146's INV-17 needs and which the pool-owning wrapper cannot provide. ──
    let target3 = create_user(&server, &admin_token, "eit_t3", "eit_t3@cyto.test").await;
    {
        let mut tx = pool.begin().await.expect("begin");
        AccountRepository::add_member_in_tx(&mut tx, org, target3, AccountRole::Member, as_admin, None)
            .await
            .expect("insert inside the caller's transaction");
        // No commit — `tx` is dropped, which rolls back.
    }
    assert!(
        role_of(&pool, org, target3).await.is_none(),
        "the membership rolled back with the caller's transaction — without this, a \
         failure after the insert would leave a committed membership whose invitation \
         still looks pending (#146 INV-17)"
    );
}

// ===========================================================================
// TEST-22 [covers: ITEM-7, ITEM-17]
// ===========================================================================
/// **An EXPIRED but unsettled invitation can be revoked** (FIX_ROUND-1, F17).
///
/// Every other statement in the module uses the full pending predicate; `revoke` must not,
/// and the reason is a ledger reason rather than an access one. With `expires_at > now()`
/// in the predicate, an expired offer could never be closed out by a human — a 404 for a
/// row the admin can plainly see — and it would sit in a third state #148 cannot attribute:
/// neither human-revoked nor superseded, because the supersede stamp only fires if somebody
/// happens to re-invite that exact address.
///
/// It grants nothing: an expired invitation is already unredeemable, so this changes only
/// the row's recorded disposition. The two clauses that DO remain are what keep a second
/// revoke a 404 and an accepted invitation un-withdrawable.
#[tokio::test]
async fn an_expired_invitation_can_still_be_revoked_but_an_accepted_one_cannot() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "eexp_owner", "eexp_owner@cyto.test").await;
    let owner_token = login(&server, "eexp_owner").await;
    let org = make_org_account(&pool, "EEXP Org", owner).await;
    let org_s = org.to_string();

    // ── an EXPIRED, unsettled invitation ──
    assert_eq!(
        post_invitation(&server, &owner_token, &org_s, "eexp_a@cyto.test", "member", None)
            .await
            .status,
        202
    );
    let expired = live_invitation(&pool, org, "eexp_a@cyto.test").await.expect("live");
    sqlx::query("UPDATE account_invitations SET expires_at = now() - interval '1 day' WHERE id = $1")
        .bind(expired)
        .execute(&pool)
        .await
        .expect("expire it");

    let r = delete_invitation(&server, &owner_token, &org_s, &expired.to_string()).await;
    assert_eq!(
        r.status, 204,
        "an expired offer can be closed out — otherwise it is stuck in a state #148 \
         cannot attribute to anyone: {}",
        r.text
    );
    let (rev_at, rev_by): (Option<chrono::DateTime<chrono::Utc>>, Option<Uuid>) =
        sqlx::query_as("SELECT revoked_at, revoked_by FROM account_invitations WHERE id = $1")
            .bind(expired)
            .fetch_one(&pool)
            .await
            .expect("the row survives");
    assert!(rev_at.is_some(), "stamped");
    assert_eq!(rev_by, Some(owner), "…and attributed");

    // ── a SECOND revoke is still a 404 ──
    assert_eq!(
        delete_invitation(&server, &owner_token, &org_s, &expired.to_string())
            .await
            .status,
        404,
        "revoking twice is a 404, not a silent 204 — the row is already settled"
    );

    // ── an ACCEPTED invitation cannot be retroactively withdrawn ──
    // (#146 sets `accepted_at`/`accepted_by`; simulated here, since accept is its item.)
    assert_eq!(
        post_invitation(&server, &owner_token, &org_s, "eexp_b@cyto.test", "member", None)
            .await
            .status,
        202
    );
    let accepted = live_invitation(&pool, org, "eexp_b@cyto.test").await.expect("live");
    sqlx::query(
        "UPDATE account_invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1",
    )
    .bind(accepted)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("simulate an acceptance");
    assert_eq!(
        delete_invitation(&server, &owner_token, &org_s, &accepted.to_string())
            .await
            .status,
        404,
        "an accepted invitation is not revocable — revoking withdraws an OFFER, and this \
         one is no longer an offer. Remove the member instead"
    );
}

// ===========================================================================
// TEST-23 [acceptance] [invariant: INV-8] [covers: ITEM-4, ITEM-17]
// ===========================================================================
/// **`lock_account_row` serializes concurrent creates — including for an account with NO
/// owner rows** (FIX_ROUND-1 F2, corrected in FIX_ROUND-2; the arm a blind tests-quality
/// audit noted was missing entirely).
///
/// The module's serialization point used to be a `FOR UPDATE` over the account's OWNER
/// rows, and `resolve_ceiling`'s doc already recorded that this *"rests on an unstated
/// schema invariant… nothing in the schema enforces it"*. The empty state is reachable:
/// `account_members_user_id_fkey` is `ON DELETE CASCADE` to `users`, so hard-deleting the
/// sole owner's user row removes the membership without passing `LAST_OWNER`.
///
/// With nothing locked, two concurrent creates for the SAME address both pass the
/// live-invitation probe and both INSERT — and the second one hits
/// `uq_account_invitations_live` and becomes a **500**, breaking INV-8's uniform 202 in the
/// one case where it is easiest to trigger deliberately. With the account row locked, they
/// serialize: the loser sees the winner's live row and returns the ordinary no-op 202.
///
/// **Mutation this kills:** delete `lock_account_row(&mut tx, account_id).await?;` from
/// `create_invitation`. Nothing else in the suite notices, because a lock is invisible to a
/// serial test.
///
/// The contenders use their own wider pool, exactly as `member_mutations_test.rs` does for
/// its own concurrency arms: the shared `pool_for` helper is `max_connections(4)`, which is
/// too small to hold several contenders plus the assertions' own reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_creates_for_one_address_serialize_even_with_no_owner_rows() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "elk_owner", "elk_owner@cyto.test").await;
    let admin_a = create_user(&server, &admin_token, "elk_a", "elk_a@cyto.test").await;
    let admin_b = create_user(&server, &admin_token, "elk_b", "elk_b@cyto.test").await;
    let org = make_org_account(&pool, "ELK Org", owner).await;
    add_member(&pool, org, admin_a, "admin").await;
    add_member(&pool, org, admin_b, "admin").await;

    // THE PRECONDITION THAT MATTERS: strip the account's owner rows, so the OLD
    // serialization point locks nothing. This is the state the audit showed is reachable
    // through the platform-admin user-delete path.
    sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND role = 'owner'")
        .bind(org)
        .execute(&pool)
        .await
        .expect("strip the owner rows");
    let owners: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM account_members WHERE account_id = $1 AND role = 'owner'",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .expect("count owners");
    assert_eq!(
        owners, 0,
        "precondition: the owner-row FOR UPDATE now locks NOTHING"
    );

    let wide = sqlx::postgres::PgPoolOptions::new()
        .max_connections(12)
        .connect(server.database_url())
        .await
        .expect("wide contender pool");

    let email = "elk_target@cyto.test";
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(4));
    let mut handles = Vec::new();
    for actor in [admin_a, admin_b, admin_a, admin_b] {
        let repo = AccountRepository::new(wide.clone());
        let b = barrier.clone();
        handles.push(tokio::spawn(async move {
            b.wait().await;
            repo.create_invitation(
                org,
                email,
                AccountRole::Member,
                ActorCeiling::SelfService {
                    actor_user_id: actor,
                    observed_role: AccountRole::Admin,
                },
                InvitationLimits::defaults(),
            )
            .await
        }));
    }

    let mut created = 0;
    let mut already = 0;
    for h in handles {
        match h.await.expect("join") {
            Ok(InvitationOutcome::Created) => created += 1,
            Ok(InvitationOutcome::AlreadyInvited) => already += 1,
            Ok(other) => panic!("unexpected outcome {other:?}"),
            Err(e) => panic!(
                "a concurrent create FAILED instead of serializing: {e:?}. Without the \
                 account-row lock the losers race past the live-invitation probe and \
                 collide on uq_account_invitations_live, which surfaces as a 500 — the \
                 uniform-202 contract broken in the easiest case to trigger on purpose"
            ),
        }
    }

    assert_eq!(created, 1, "exactly ONE contender created the invitation");
    assert_eq!(
        already, 3,
        "the other three observed the winner's live row and returned the ordinary no-op"
    );
    assert_eq!(
        invitation_rows(&pool, org, email).await,
        1,
        "and exactly one row exists — the unique index was never even reached"
    );
}

// ===========================================================================
// TEST-24 [acceptance] [invariant: INV-RL] [covers: ITEM-11, ITEM-17]
// ===========================================================================
/// **The mint ledger's prune runs, is SCOPED to the acting account, and cannot remove a row
/// the ceiling would have counted** (FIX_ROUND-3).
///
/// Three separate properties, none of which had any coverage — the suite actively steered
/// around the prune (`age_out_mints` ages rows to 23 hours *so that* it will not delete
/// them), which a blind design-conformance audit pointed out means mutating the horizon, or
/// deleting the DELETE outright, left every rate-limit test green.
///
/// The scoping arm is the one that matters most. The first version of the prune had no
/// `account_id` predicate, and a blind security audit reproduced, against a real cluster,
/// (a) tenant A's mint blocking tenant B's on the aged rows, and (b) a genuine
/// `deadlock detected` between two tenants — because the same DELETE has several reachable
/// plans with different row-visit orders, chosen from platform-wide statistics rather than
/// from the requesting tenant.
///
/// **Mutations killed:** delete the DELETE (arm 1 goes red); shorten `MINT_RETENTION` below
/// the longest window (arm 2 goes red, and so does the unit `mint_retention_dominates…`);
/// drop `AND account_id = $1` (arm 3 goes red).
#[tokio::test]
async fn the_mint_ledger_prune_runs_scoped_and_never_eats_a_counted_row() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "epr_owner", "epr_owner@cyto.test").await;
    let other = create_user(&server, &admin_token, "epr_other", "epr_other@cyto.test").await;
    let owner_token = login(&server, "epr_owner").await;
    let org = make_org_account(&pool, "EPR Org", owner).await;
    let neighbour = make_org_account(&pool, "EPR Neighbour", other).await;
    let org_s = org.to_string();

    // Three seeded mint rows: one long stale in OUR account, one just inside the longest
    // window in OUR account, and one long stale in a DIFFERENT account.
    let mk = |account: Uuid, actor: Uuid, age: &'static str| {
        let pool = pool.clone();
        async move {
            let id: Uuid = sqlx::query_scalar(&format!(
                "INSERT INTO account_invitation_mints \
                     (account_id, actor_user_id, invitation_id, created_at) \
                 VALUES ($1, $2, gen_random_uuid(), now() - interval '{age}') RETURNING id"
            ))
            .bind(account)
            .bind(actor)
            .fetch_one(&pool)
            .await
            .expect("seed mint");
            id
        }
    };
    let stale_ours = mk(org, owner, "10 days").await;
    let recent_ours = mk(org, owner, "23 hours").await;
    let stale_theirs = mk(neighbour, other, "10 days").await;

    let exists = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM account_invitation_mints WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count")
        }
    };
    assert_eq!(exists(stale_ours).await, 1, "precondition");
    assert_eq!(exists(recent_ours).await, 1, "precondition");
    assert_eq!(exists(stale_theirs).await, 1, "precondition");

    // One create is enough — the prune runs at every mint.
    let r = post_invitation(&server, &owner_token, &org_s, "epr_a@cyto.test", "member", None).await;
    assert_eq!(r.status, 202, "{}", r.text);

    // ── ARM 1: the prune actually RAN ──
    assert_eq!(
        exists(stale_ours).await,
        0,
        "a mint record older than the retention horizon is deleted at the next mint — \
         without this the ledger grows without bound, because there is no sweeper and \
         deliberately so"
    );

    // ── ARM 2: it cannot eat a row the ceiling would still have counted ──
    assert_eq!(
        exists(recent_ours).await,
        1,
        "a 23-hour-old record is still inside the DAILY window, so the prune must not \
         touch it. If the horizon ever drops below the longest window, the per-day ceiling \
         silently becomes a shorter one — this is the arm that notices"
    );

    // ── ARM 3: it is SCOPED — one tenant's mint does not touch another's rows ──
    assert_eq!(
        exists(stale_theirs).await,
        1,
        "another account's stale record is UNTOUCHED. An unscoped prune was verified to \
         block one tenant's mint on another's and to deadlock two tenants outright; \
         scoping is what makes those unreachable by construction, and this is the arm that \
         binds the predicate"
    );

    // …and the neighbour prunes its OWN row when IT mints, so scoping does not mean rows
    // live forever — it means each tenant cleans up after itself.
    let other_token = login(&server, "epr_other").await;
    let r2 = post_invitation(
        &server,
        &other_token,
        &neighbour.to_string(),
        "epr_b@cyto.test",
        "member",
        None,
    )
    .await;
    assert_eq!(r2.status, 202, "{}", r2.text);
    assert_eq!(
        exists(stale_theirs).await,
        0,
        "the neighbour's own next mint prunes the neighbour's own stale row"
    );
}
