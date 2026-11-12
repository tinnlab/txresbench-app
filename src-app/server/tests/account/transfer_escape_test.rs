//! #171 — **`accept_transfer` moved a project OUT of its account with no
//! re-validation**, so a removed member could take the organization's project with
//! them. The A9 deny suite for both reachable directions, the proof that each of the
//! two remedies refuses ALONE, and the persona regressions that keep ownership
//! transfer working.
//!
//! ## The two halves, and why both exist
//!
//! The owner chose defence in depth explicitly — *"this is the class of bug where a
//! single mechanism failing silently is the whole problem"* — so:
//!
//! * **(a) cancel on removal.** `AccountRepository::remove_member` deletes every
//!   still-pending transfer the departing member is a party to, in EITHER direction,
//!   on the projects of the account they are leaving, inside the removal's own
//!   transaction.
//! * **(b) re-validate at accept.** `ProjectRepository::accept_transfer` requires the
//!   INITIATOR to still resolve as project `Owner` — the same authority
//!   `create_transfer` demanded of them — and refuses `409 TRANSFER_REVOKED` if not.
//!
//! **Neither half may depend on the other**, so TEST-3 and TEST-4 are a pair: each
//! shows one mechanism refusing while the other is demonstrably not firing. Half (a)
//! is "switched off" by removing the membership with raw SQL instead of through
//! `remove_member` — exactly the state the system occupies if the hook is bypassed by
//! a future path or fails silently — and half (b) is shown INERT by asserting that
//! the initiator still resolves as `Owner` at the moment of the refusal, i.e. the
//! accept-time check would have admitted that transfer.
//!
//! The two refusals are deliberately DISTINGUISHABLE at the boundary — half (a) ends
//! in a **404** (the row is gone), half (b) in a **409 `TRANSFER_REVOKED`** (the row
//! is still there and still pending). Without that distinction "each half works
//! alone" would be unfalsifiable: a passing test could not tell which mechanism did
//! the work. **TEST-14 asserts both, plus the 200, as real HTTP status codes on the
//! live accept route** — every other accept assertion in this file is at the
//! repository level, so without it the claim was established nowhere.
//!
//! One correction that matters for anyone tracing the 404: it does NOT come from
//! `accept_transfer` returning `Ok(false)` in the half-(a) case. `handlers::
//! accept_transfer` pre-fetches the transfer with its own `get_transfer` and 404s
//! there, before the repository is reached at all. Same status to the client, a
//! different code path — and `Ok(false)` is still the repository-level shape the
//! direct-call tests observe.
//!
//! ## Why every deny here is paired with a positive control
//!
//! Same discipline as `removal_revokes_test.rs`: "the removed member is refused"
//! passes VACUOUSLY on a broken fixture — an unseeded transfer row, a project that
//! never moved into the org, a user id that never existed all produce the same
//! refusal. So every deny is paired, in the SAME test on the SAME fixture through the
//! SAME function, with a principal who MUST still be admitted.
//!
//! The load-bearing control is **eve**, who has NEVER been a member of the org. A
//! transfer to her is the capability working exactly as designed (#171: "a transfer's
//! whole purpose is to hand a project to someone who is *not* a member"), and she is
//! the principal the obvious-but-wrong fix — gating accept on recipient membership —
//! would lock out. This module already made that mistake once next door, at
//! `cancel_transfer`, which was gated and then reverted.

use txresbench::modules::account::{AccountRepository, AccountRole};
use txresbench::modules::project::{EffectivePermission, ProjectRepository};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{add_member, create_user, make_org_account, move_project_to_account, pool_for,
            setup_admin};
use crate::admin::admin_remove_member;
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

/// The floor for "it must still be BLOCKED" in the concurrency tests. Never used bare:
/// `spawn_blocked_accept` raises it toward TEN TIMES a MEASURED unobstructed run, because a
/// fixed literal only detects a non-blocking accept that is also FAST, and on a loaded
/// box it need not be (AUD-10). Named and shared because the round-2 hardening
/// originally landed in one of three hand-copied sites and the other two kept the bug.
const BLOCK_FLOOR: std::time::Duration = std::time::Duration::from_millis(1500);

/// How far above a MEASURED unobstructed run the block threshold is set. Named rather
/// than inline so the two sites that use it cannot drift, which is how the round-2
/// hardening came to exist in one of three hand-copied places.
const BLOCK_WARM_MULTIPLIER: u32 = 10;

/// **The ceiling on that measured threshold, and it is coupled to production.**
/// `accept_transfer` sets `lock_timeout = '3s'` on its own transaction, so a
/// deliberately-blocked accept DIES at ~3 s with SQLSTATE 55P03. Without a ceiling the
/// `max(BLOCK_FLOOR, warm * BLOCK_WARM_MULTIPLIER)` threshold reaches 3 s as soon as a measured warm-up
/// exceeds 300 ms — precisely the loaded-box condition the measurement exists for — and
/// the blocked accept would already have errored, `is_finished()` would be true, and
/// the test would report "the check-then-act window is open", i.e. a security
/// regression, for what is actually a lock timeout. Staying a second under the
/// production bound keeps the assertion about what it claims to be about.
/// If `ACCEPT_LOCK_TIMEOUT_SQL` changes, this must move with it.
const BLOCK_CEILING: std::time::Duration = std::time::Duration::from_secs(2);

/// Anti-hang bound on every concurrent await. Load-bearing for the `remove_member`
/// await in TEST-13, which has no timeout of its own; for the accept awaits it is now
/// a backstop rather than the only bound, since `accept_transfer` carries its own
/// `lock_timeout` (this comment used to say no timeout was configured anywhere, which
/// this branch itself made false).
const UNBLOCK_BOUND: std::time::Duration = std::time::Duration::from_secs(30);

/// The shared fixture: an ORG account `Lab` with alice(owner) / bob(member) /
/// dana(member); **P** created by bob, **Q** by dana, **R** by alice, all three moved
/// into the org. **eve** is never a member of anything but her own personal account.
struct Fixture {
    pool: SqlitePool,
    admin_token: String,
    org: Uuid,
    /// account `owner`, stays a member — the authority-intact initiator control.
    alice: Uuid,
    /// account `member` — the deny subject, removed in most tests.
    bob: Uuid,
    /// account `member` who is never removed — the in-good-standing control.
    dana: Uuid,
    /// NEVER a member of the org — the legitimate external recipient (INV-3).
    eve: Uuid,
    /// project created by bob, in the org.
    p: Uuid,
    /// project created by dana, in the org.
    q: Uuid,
    /// project created by alice, in the org.
    r: Uuid,
}

impl Fixture {
    async fn build(server: &TestServer) -> Fixture {
        let admin_token = setup_admin(server).await;
        let alice = create_user(server, &admin_token, "alice", "alice@x.test").await;
        let bob = create_user(server, &admin_token, "bob", "bob@x.test").await;
        let dana = create_user(server, &admin_token, "dana", "dana@x.test").await;
        let eve = create_user(server, &admin_token, "eve", "eve@x.test").await;
        let pool = pool_for(server).await;

        let org = make_org_account(&pool, "Lab", alice).await;
        add_member(&pool, org, bob, "member").await;
        add_member(&pool, org, dana, "member").await;

        let projects = ProjectRepository::new(pool.clone());
        let p = projects.create(bob, "bobs-project", "").await.unwrap().id;
        move_project_to_account(&pool, p, org).await;
        let q = projects.create(dana, "danas-project", "").await.unwrap().id;
        move_project_to_account(&pool, q, org).await;
        let r = projects.create(alice, "alices-project", "").await.unwrap().id;
        move_project_to_account(&pool, r, org).await;

        Fixture { pool, admin_token, org, alice, bob, dana, eve, p, q, r }
    }

    fn projects(&self) -> ProjectRepository {
        ProjectRepository::new(self.pool.clone())
    }
    fn accounts(&self) -> AccountRepository {
        AccountRepository::new(self.pool.clone())
    }

    /// Seed a pending transfer directly. Used instead of the HTTP create path
    /// because several fixtures need an initiator/recipient pairing that
    /// `create_transfer`'s own gate would (correctly) refuse to CREATE — the defect
    /// under test is about a row that became illegitimate AFTER it was created.
    async fn seed_pending(&self, project: Uuid, from: Uuid, to: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
             VALUES ($1, $2, $3, $4, 'pending')",
        )
        .bind(id)
        .bind(project)
        .bind(from)
        .bind(to)
        .execute(&self.pool)
        .await
        .expect("seed pending transfer");
        id
    }

    /// `None` = the row is gone (half (a) fired); `Some(status)` = it survives.
    async fn transfer_status(&self, id: Uuid) -> Option<String> {
        sqlx::query_scalar::<_, String>("SELECT status FROM project_transfers WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .expect("read transfer status")
    }

    async fn project_owner_and_account(&self, project: Uuid) -> (Uuid, Uuid) {
        sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT owner_id, account_id FROM projects WHERE id = $1",
        )
        .bind(project)
        .fetch_one(&self.pool)
        .await
        .expect("read project row")
    }

    async fn personal_account(&self, user: Uuid) -> Uuid {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM accounts WHERE kind = 'personal' AND personal_user_id = $1",
        )
        .bind(user)
        .fetch_one(&self.pool)
        .await
        .expect("personal account")
    }

    /// Remove a membership WITHOUT going through `AccountRepository::remove_member`
    /// — i.e. with the cancel-on-removal hook bypassed. This is how "half (a) is
    /// switched off" is expressed: no production toggle, no `#[cfg]` flag, no
    /// test-only branch in shipped code, just the state the system is in when the
    /// hook does not run. `removal_revokes_test.rs::Fixture::remove_bob` removes
    /// membership by raw SQL for the same attribution reason.
    async fn raw_unmember(&self, account: Uuid, user: Uuid) {
        let done = sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
            .bind(account)
            .bind(user)
            .execute(&self.pool)
            .await
            .expect("raw unmember");
        assert_eq!(
            done.rows_affected(),
            1,
            "the fixture must actually have had this membership — otherwise every \
             deny below would pass vacuously"
        );
    }
}

/// The shared shape of the two mid-accept race tests (TEST-11's removal, TEST-16's
/// demotion): warm up, MEASURE an unobstructed accept, spawn the obstructed one, and
/// assert it is still blocked at a threshold derived from that measurement.
///
/// It exists because the hardening was originally hand-copied. Round 2 fixed exactly
/// this detector in TEST-11 — a bare `sleep(1500ms)` only catches a non-blocking accept
/// that is ALSO fast, which on a loaded box it need not be — and then TEST-16 was
/// written as a near-clone and reintroduced the bare literal. One helper, one place to
/// harden, and the next race test inherits it (AUD-10 / audit round 3).
///
/// The warm-up doubles as a positive control: an unobstructed accept must COMPLETE.
/// It deliberately uses a principal whose membership row the blocker does not hold, so
/// it cannot itself block.
///
/// **SQLite port (record): the warm-up is a WRITE sequence, and the engine's single
/// write lock is held by the obstruction for the whole test — so on this chain the
/// warm-up CANNOT run after the obstruction opens. It is therefore a separate helper
/// the caller must run BEFORE opening the blocking transaction; the
/// `BEGIN IMMEDIATE`-at-open barrier and this split are the ITEM-25 record of
/// what the PG row-lock design allowed and the single-writer model does not.**
/// (The original single helper did both and deadlocked on itself on SQLite — the
/// warm-up's INSERT queued behind the obstruction and failed `database is locked`;
/// the "blocked accept" was never even spawned.)
async fn measure_accept_latency(fx: &Fixture, label: &str) -> std::time::Duration {
    let warm_offer = fx.seed_pending(fx.q, fx.dana, fx.eve).await;
    let warm_start = tokio::time::Instant::now();
    assert!(
        fx.projects()
            .accept_transfer(warm_offer, fx.eve)
            .await
            .expect("warm-up accept must not error"),
        "{label}: warm-up control — an unobstructed accept completes"
    );
    let warm = warm_start.elapsed();
    std::cmp::min(std::cmp::max(BLOCK_FLOOR, warm * BLOCK_WARM_MULTIPLIER), BLOCK_CEILING)
}

/// Spawn the obstructed accept (the caller must already hold the write lock) and assert
/// it is still blocked at the measured threshold.
async fn spawn_blocked_accept(
    fx: &Fixture,
    offer: Uuid,
    recipient: Uuid,
    label: &str,
    threshold: std::time::Duration,
) -> tokio::task::JoinHandle<Result<bool, txresbench_core::AppError>> {
    let projects = fx.projects();
    let handle = tokio::spawn(async move { projects.accept_transfer(offer, recipient).await });

    tokio::time::sleep(threshold).await;
    assert!(
        !handle.is_finished(),
        "{label}: the accept must BLOCK while the obstructing transaction holds the row \
         it needs — finishing within {threshold:?} (an unobstructed accept took \
         less than that) means the check-then-act window is open"
    );
    handle
}

/// Assert an `AppError` is the accept-time refusal, by CODE and status — not by
/// status alone, which `create_transfer`'s pre-existing `TRANSFER_PENDING` /
/// `TRANSFER_DISABLED` also carry.
fn assert_transfer_revoked(err: txresbench_core::AppError, ctx: &str) {
    let rendered = format!("{err:?}");
    assert!(
        rendered.contains("TRANSFER_REVOKED"),
        "{ctx}: refused BY NAME, not incidentally (got {rendered})"
    );
    assert_eq!(
        err.to_api_error().0.as_u16(),
        409,
        "{ctx}: and mapped to 409, like the sibling TRANSFER_PENDING guard"
    );
}

// ==================== A9 DENY — the removed RECIPIENT (#171 path 1) ====================

/// TEST-1 [acceptance] [invariant: INV-1] — bob is OFFERED the org's project and is
/// then removed; his accept must not move the project out of the tenant.
///
/// This is #171's first path, and the one half (b) structurally cannot reach: the
/// initiator here is alice, an account owner whose authority is entirely intact, so
/// an initiator-authority check has nothing to refuse on. The only signal is bob's
/// lost membership — and consulting THAT at accept time is exactly the
/// recipient-membership gate #171 forbids. So this path is half (a)'s alone, by
/// necessity, and this test is what proves it closed.
///
/// It shares its subject PRODUCTION LINE with TEST-4 (the hook's `OR t.to_user_id =
/// $2` arm), which is deliberate but worth stating so the pair is not mistaken for two
/// independent proofs: this test establishes that path 1 is CLOSED (INV-1), TEST-4
/// that it is closed by half (a) with half (b) demonstrably inert (INV-4). Deleting
/// either leaves the line pinned; deleting either also loses a distinct claim.
#[tokio::test]
async fn a_removed_recipient_cannot_take_the_orgs_project_with_them() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // alice (org owner) offers the org's project R to bob, a current member.
    let offer = fx.seed_pending(fx.r, fx.alice, fx.bob).await;
    let (owner_before, account_before) = fx.project_owner_and_account(fx.r).await;
    assert_eq!(account_before, fx.org, "control: R starts inside the org");

    // …and bob is then removed, through the PRODUCTION removal path.
    fx.accounts()
        .remove_member(fx.org, fx.bob, super::staff_ceiling())
        .await
        .expect("removing a member of an org account succeeds");

    assert_eq!(
        fx.transfer_status(offer).await,
        None,
        "INV-1: removal cancelled the offer the departing member was the RECIPIENT of"
    );
    assert!(
        !projects
            .accept_transfer(offer, fx.bob)
            .await
            .expect("a cancelled transfer is a plain refusal, not an error"),
        "INV-1 (A9 deny): the removed recipient's accept is refused"
    );
    assert_eq!(
        fx.project_owner_and_account(fx.r).await,
        (owner_before, account_before),
        "…and — the whole point of #171 — the project did not leave the tenant"
    );

    // POSITIVE CONTROL, same fixture, same function: a transfer to a genuine
    // never-member still completes. Without this the deny above would also pass if
    // `accept_transfer` were simply broken for everyone.
    let genuine = fx.seed_pending(fx.q, fx.dana, fx.eve).await;
    assert!(
        projects
            .accept_transfer(genuine, fx.eve)
            .await
            .expect("a legitimate transfer must not error"),
        "positive control: a transfer to eve — never a member — still completes"
    );
    let (owner, account) = fx.project_owner_and_account(fx.q).await;
    assert_eq!(owner, fx.eve, "…and really made her the owner");
    assert_eq!(
        account,
        fx.personal_account(fx.eve).await,
        "…re-stamped into her personal account, exactly as before this branch"
    );
}

// ==================== A9 DENY — the removed INITIATOR (#171 path 2) ====================

/// TEST-2 [acceptance] [invariant: INV-1] — bob OFFERS the org's project to an
/// outsider and is then removed; the offer must not survive him.
///
/// Half (a)'s side of the initiator path. The row is asserted GONE *before*
/// `accept_transfer` is called at all, so the refusal is attributable to the
/// offboarding hook and not to the accept-time check that also covers this case
/// (TEST-3 covers that one, with this hook bypassed).
#[tokio::test]
async fn a_removed_initiators_pending_transfer_does_not_survive_the_removal() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    // A second offer, from a member who is NOT being removed, on the same account.
    let danas = fx.seed_pending(fx.q, fx.dana, fx.eve).await;

    fx.accounts()
        .remove_member(fx.org, fx.bob, super::staff_ceiling())
        .await
        .expect("removal succeeds");

    assert_eq!(
        fx.transfer_status(offer).await,
        None,
        "INV-1: the departing member's own outgoing offer is cancelled by the removal \
         itself — before anyone accepts anything"
    );
    assert!(
        !projects
            .accept_transfer(offer, fx.eve)
            .await
            .expect("a cancelled transfer is a plain refusal, not an error"),
        "INV-1 (A9 deny): and eve's accept of it is refused"
    );
    let (owner, account) = fx.project_owner_and_account(fx.p).await;
    assert_eq!(owner, fx.bob, "P's owner column is untouched");
    assert_eq!(account, fx.org, "…and P is still inside the organization");

    // POSITIVE CONTROL — the hook did not sweep up an uninvolved member's transfer,
    // and that transfer still completes end to end.
    assert_eq!(
        fx.transfer_status(danas).await.as_deref(),
        Some("pending"),
        "positive control: removing bob left dana's unrelated offer alone"
    );
    assert!(
        projects
            .accept_transfer(danas, fx.eve)
            .await
            .expect("a legitimate transfer must not error"),
        "positive control: …and it still completes"
    );
    assert_eq!(
        fx.project_owner_and_account(fx.q).await.0,
        fx.eve,
        "…really transferring the project"
    );
}

// ==================== INV-4 — each half refuses ALONE ====================

/// TEST-3 [acceptance] [invariant: INV-2] — **half (b) alone.** The offboarding hook
/// is bypassed entirely (raw membership DELETE), so the pending row SURVIVES the
/// removal; the accept-time initiator re-validation must still refuse.
///
/// This is the state the system occupies if half (a) is absent, is routed around by
/// some future removal path, or fails silently — which is the failure mode the
/// two-mechanism decision exists to survive.
#[tokio::test]
async fn the_accept_time_check_refuses_alone_with_the_offboarding_hook_bypassed() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    // alice's offer of a DIFFERENT org project to the SAME recipient — the control
    // that isolates "the initiator lost authority" from "accept is broken".
    let alices = fx.seed_pending(fx.r, fx.alice, fx.eve).await;

    // Half (a) switched off: the membership goes away WITHOUT `remove_member`.
    fx.raw_unmember(fx.org, fx.bob).await;
    assert_eq!(
        fx.transfer_status(offer).await.as_deref(),
        Some("pending"),
        "the hook really did NOT run — this test would be meaningless otherwise, \
         because a deleted row refuses for the other half's reason"
    );
    assert_eq!(
        projects.effective_permission(fx.p, fx.bob).await.unwrap(),
        None,
        "…and bob really has lost authority over P (H-1 conjoined the creator branch \
         with current membership)"
    );

    let err = projects
        .accept_transfer(offer, fx.eve)
        .await
        .expect_err("INV-2 (A9 deny): the accept-time check must refuse on its own");
    assert_transfer_revoked(err, "removed initiator, hook bypassed");

    assert_eq!(
        fx.transfer_status(offer).await.as_deref(),
        Some("pending"),
        "the refusal did not silently complete: the row is still pending, not accepted"
    );
    let (owner, account) = fx.project_owner_and_account(fx.p).await;
    assert_eq!(owner, fx.bob, "P's owner is unchanged");
    assert_eq!(account, fx.org, "…and P did not leave the organization");

    // POSITIVE CONTROL — same fixture, same removed state, same recipient: a transfer
    // whose INITIATOR still holds authority still completes. So the refusal above is
    // attributable to the initiator's lost authority, not to a poisoned fixture, a
    // broken accept path, or anything about eve.
    assert!(
        projects
            .accept_transfer(alices, fx.eve)
            .await
            .expect("an authorized initiator's transfer must not error"),
        "positive control: alice still holds authority, so her offer to the very same \
         non-member recipient still completes"
    );
    assert_eq!(
        fx.project_owner_and_account(fx.r).await.0,
        fx.eve,
        "…and really transferred"
    );
}

/// TEST-4 [acceptance] [invariant: INV-4] — **half (a) alone**, in a state where half
/// (b) is proven INERT.
///
/// The removed party is the RECIPIENT, so the initiator (alice) still resolves as
/// project `Owner` — asserted here, at the moment of the refusal, so it is a fact of
/// this test and not an argument about it. The accept-time check would therefore have
/// ADMITTED this transfer; the refusal can only be the offboarding hook's.
///
/// Paired with TEST-3, this is the INV-4 proof the owner asked for: each mechanism
/// refuses with the other demonstrably not firing, so an "untested both" cannot hide
/// a single working mechanism.
#[tokio::test]
async fn the_offboarding_hook_refuses_alone_with_the_accept_time_check_inert() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    let offer = fx.seed_pending(fx.r, fx.alice, fx.bob).await;

    fx.accounts()
        .remove_member(fx.org, fx.bob, super::staff_ceiling())
        .await
        .expect("removal succeeds");

    // Half (b) is INERT here, asserted rather than asserted-about: the initiator's
    // authority is intact, so the accept-time gate would have let this through.
    assert_eq!(
        projects.effective_permission(fx.r, fx.alice).await.unwrap(),
        Some(EffectivePermission::Owner),
        "the initiator still resolves as project Owner — so the accept-time check \
         would have ADMITTED this transfer, and anything that refuses it below is \
         the offboarding hook alone"
    );
    assert_eq!(
        fx.transfer_status(offer).await,
        None,
        "INV-4: …and the hook, on its own, already removed the row"
    );
    assert!(
        !projects
            .accept_transfer(offer, fx.bob)
            .await
            .expect("a cancelled transfer is a plain refusal, not an error"),
        "INV-4: the removed recipient is refused by half (a) with half (b) inert"
    );

    // POSITIVE CONTROL — the same initiator, the same authority, a recipient who was
    // never removed: still admitted. The hook removed one row, not the capability.
    let genuine = fx.seed_pending(fx.q, fx.alice, fx.eve).await;
    assert!(
        projects
            .accept_transfer(genuine, fx.eve)
            .await
            .expect("a legitimate transfer must not error"),
        "positive control: alice's offer to a never-removed recipient still completes"
    );
}

// ================ INV-3 — transfers are NOT broken by the fix ================

/// TEST-5 [acceptance] [invariant: INV-3] — the regression that matters as much as
/// the fix: **a genuine transfer to a genuine non-member still works end to end.**
///
/// #171 says the obvious fix — gating accept on the recipient being a member of the
/// project's account — "breaks the transfer capability", because a transfer's whole purpose is to
/// hand a project to someone who is not a member. If a future sweep re-derives that
/// gate from the `owner_id`-shaped predicates around it, this test is what goes red.
///
/// Leg 2 covers the second persona: an in-flight transfer between two parties in good
/// standing must survive an UNRELATED member's removal — an offboarding hook that
/// over-reaches is as much a defect as one that under-reaches.
#[tokio::test]
async fn a_transfer_to_a_genuine_non_member_still_completes() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // --- leg 1: the external collaborator ---
    // eve is not, and never has been, a member of the org. alice — the account owner,
    // i.e. a current owner with real authority — hands her an ORG project.
    let external = fx.seed_pending(fx.r, fx.alice, fx.eve).await;
    // A residual share to the recipient, and one to a third party: accept must clear
    // the former and re-point the latter, unchanged by this branch.
    for (recipient, level) in [(fx.eve, "viewer"), (fx.dana, "editor")] {
        sqlx::query(
            "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, \
                                         permission_level, status) \
             VALUES (randomblob(16), $1, $2, $3, $4, 'accepted')",
        )
        .bind(fx.r)
        .bind(fx.alice)
        .bind(recipient)
        .bind(level)
        .execute(&fx.pool)
        .await
        .expect("seed share");
    }

    assert!(
        projects
            .accept_transfer(external, fx.eve)
            .await
            .expect("INV-3: a transfer to a non-member must not error"),
        "INV-3: a current owner transferring to an external collaborator who is NOT a \
         member still SUCCEEDS — this is the capability working, not a hole"
    );
    let (owner, account) = fx.project_owner_and_account(fx.r).await;
    assert_eq!(owner, fx.eve, "the non-member really became the owner");
    assert_eq!(
        account,
        fx.personal_account(fx.eve).await,
        "…and the project really moved into her personal account"
    );
    let residual: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_shares WHERE project_id = $1 AND recipient_id = $2",
    )
    .bind(fx.r)
    .bind(fx.eve)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(residual, 0, "the new owner's residual share was cleared");
    let repointed: Uuid = sqlx::query_scalar(
        "SELECT owner_id FROM project_shares WHERE project_id = $1 AND recipient_id = $2",
    )
    .bind(fx.r)
    .bind(fx.dana)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(
        repointed, fx.eve,
        "…and the remaining share was re-pointed to the new owner, as before"
    );

    // --- leg 1b: the commonest shape of all — a PERSONAL-account project ---
    // Every other project in this file lives in the org, so the newest gate (which
    // resolves membership via the project's `account_id`) had no coverage on the
    // account shape it will most often run against. A personal account's sole member
    // IS its owner, so the gate must admit here exactly as before.
    let solo = fx.projects().create(fx.dana, "danas-solo", "").await.unwrap().id;
    assert_eq!(
        fx.project_owner_and_account(solo).await.1,
        fx.personal_account(fx.dana).await,
        "control: this project really is in a PERSONAL account, not the org"
    );
    let personal = fx.seed_pending(solo, fx.dana, fx.eve).await;
    assert!(
        projects
            .accept_transfer(personal, fx.eve)
            .await
            .expect("a personal-account transfer must not error"),
        "INV-3: a solo user handing their own project to someone else still works — \
         the account shape the transfer path runs against most often"
    );
    assert_eq!(
        fx.project_owner_and_account(solo).await,
        (fx.eve, fx.personal_account(fx.eve).await),
        "…and really moved it into the recipient's personal account"
    );

    // --- leg 2: in flight, both parties in good standing, someone ELSE offboarded ---
    let in_flight = fx.seed_pending(fx.q, fx.dana, fx.eve).await;
    fx.accounts()
        .remove_member(fx.org, fx.bob, super::staff_ceiling())
        .await
        .expect("an unrelated member is removed");
    assert_eq!(
        fx.transfer_status(in_flight).await.as_deref(),
        Some("pending"),
        "INV-3: removing bob must not touch a transfer between two parties in good \
         standing — the hook is scoped to the departing member's own transfers"
    );
    assert!(
        projects
            .accept_transfer(in_flight, fx.eve)
            .await
            .expect("an in-flight transfer must not error"),
        "INV-3: …and that in-flight transfer still completes"
    );
    assert_eq!(fx.project_owner_and_account(fx.q).await.0, fx.eve);
}

// ==================== INV-5 — cancel/decline unchanged ====================

/// TEST-6 [acceptance] [invariant: INV-5] — `cancel_transfer` and `decline_transfer`
/// are untouched by this branch.
///
/// `cancel_transfer` was gated on the parent branch, found to close no reachable
/// attack while stranding the project's transfer capability, and deliberately
/// REVERTED (that branch's DEC-16, protected by its TEST-35). The revert is a design
/// constraint on this branch, re-asserted from this file so someone reading only the
/// #171 work sees it: it is exactly the "obvious" tightening a sweep would re-apply.
///
/// `decline_transfer` matters for a different reason: it only ever REFUSES a
/// resource, so it must never inherit the accept-side gate — otherwise an unwanted
/// offer whose initiator has lost authority would be trapped in the recipient's queue
/// with no way to clear it.
#[tokio::test]
async fn cancel_and_decline_transfer_are_unchanged() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // Hook bypassed, so the rows survive and these two functions are actually
    // exercised on a removed member rather than on nothing.
    let mine = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    fx.raw_unmember(fx.org, fx.bob).await;

    // (1) the removed INITIATOR may still cancel — release-only, and it is what keeps
    // the pending-unique index from stranding the project's transfer capability.
    assert!(
        projects.cancel_transfer(mine, fx.bob).await.unwrap(),
        "INV-5: `cancel_transfer` is still NOT membership-gated (parent DEC-16). If \
         this goes red, someone re-applied the conjunct that was reverted"
    );
    assert_eq!(
        fx.transfer_status(mine).await,
        None,
        "…and it really released the row"
    );

    // (2) NEGATIVE CONTROL — the `from_user_id` scoping is intact, so it has not been
    // loosened into "anyone may cancel".
    let danas = fx.seed_pending(fx.q, fx.dana, fx.eve).await;
    assert!(
        !projects.cancel_transfer(danas, fx.alice).await.unwrap(),
        "negative control: a third party still cannot cancel someone else's transfer"
    );

    // (3) DECLINE is reachable even when the accept-side gate would refuse. The
    // initiator (bob) has lost authority, so `accept_transfer` answers 409 — and the
    // recipient must still be able to clear the offer.
    let unwanted = fx.seed_pending(fx.r, fx.bob, fx.eve).await;
    let err = projects
        .accept_transfer(unwanted, fx.eve)
        .await
        .expect_err("control: this transfer is indeed one the accept gate refuses");
    assert_transfer_revoked(err, "control for the decline leg");
    assert!(
        projects.decline_transfer(unwanted, fx.eve).await.unwrap(),
        "INV-5: `decline_transfer` is unchanged — a refusal to RECEIVE moves nothing, \
         so it must never be blocked by the accept-side gate"
    );
    assert_eq!(
        fx.transfer_status(unwanted).await.as_deref(),
        Some("declined"),
        "…and really declined it"
    );

    // POSITIVE CONTROL — a CURRENT member's cancel behaves identically, so (1) is not
    // passing because the function admits everyone.
    assert!(
        projects.cancel_transfer(danas, fx.dana).await.unwrap(),
        "positive control: a current member still cancels their own pending transfer"
    );
}

// ==================== the hook is WIRED on the real runtime path ====================

/// TEST-7 [acceptance] [invariant: INV-1] — the hook is reached by the PRODUCTION
/// route, not merely present and exercised through the repository (FB-17: "exists and
/// is unit-tested" is not "is used").
///
/// Leg 1 drives the live `DELETE /api/admin/accounts/{account_id}/members/{user_id}`
/// as a platform admin. Leg 2 pins `remove_member`'s return value — the input the
/// admin route fans out as `ProjectTransfer` DELETE frames to both parties; without a
/// real pair of ids there, ITEM-3 would be publishing nothing. Leg 3 is the
/// platform-staff persona control: `admin_change_owner` is unchanged.
#[tokio::test]
async fn the_live_admin_removal_route_cancels_both_directions() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // bob is a party to two offers in the org — one incoming, one outgoing.
    let incoming = fx.seed_pending(fx.r, fx.alice, fx.bob).await;
    let outgoing = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    let untouched = fx.seed_pending(fx.q, fx.dana, fx.eve).await;

    // --- leg 1: the LIVE HTTP route ---
    let status = admin_remove_member(
        &server,
        Some(&fx.admin_token),
        &fx.org.to_string(),
        fx.bob,
    )
    .await;
    assert_eq!(status, 204, "the admin removal route still answers 204");
    assert_eq!(
        (fx.transfer_status(incoming).await, fx.transfer_status(outgoing).await),
        (None, None),
        "INV-1: the hook is on the REAL runtime path — driving the production route \
         cancelled BOTH directions"
    );
    assert_eq!(
        fx.transfer_status(untouched).await.as_deref(),
        Some("pending"),
        "positive control: …and only the departing member's own offers"
    );

    // --- leg 2: the fan-out input the route publishes ---
    add_member(&fx.pool, fx.org, fx.bob, "member").await;
    let re_incoming = fx.seed_pending(fx.r, fx.alice, fx.bob).await;
    let re_outgoing = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    let mut cancelled = fx
        .accounts()
        .remove_member(fx.org, fx.bob, super::staff_ceiling())
        .await
        .expect("removal succeeds");
    cancelled.sort_by_key(|c| c.id);
    let mut expected = vec![re_incoming, re_outgoing];
    expected.sort();
    assert_eq!(
        cancelled.iter().map(|c| c.id).collect::<Vec<_>>(),
        expected,
        "DEC-10: removal reports exactly the transfers it cancelled"
    );
    assert!(
        cancelled
            .iter()
            .all(|c| c.from_user_id != c.to_user_id
                && (c.from_user_id == fx.bob || c.to_user_id == fx.bob)),
        "…with BOTH parties' ids, so the route has someone to notify on each side"
    );

    // --- leg 3: platform-staff persona, unchanged ---
    add_member(&fx.pool, fx.org, fx.bob, "member").await;
    let doomed = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    let old = projects
        .admin_change_owner(fx.p, fx.alice, false)
        .await
        .expect("admin_change_owner must not error");
    assert_eq!(old, Some(fx.bob), "it still reports the previous owner");
    assert_eq!(
        fx.transfer_status(doomed).await,
        None,
        "…and still cancels the now-moot pending transfer, exactly as before"
    );
    assert_eq!(
        fx.project_owner_and_account(fx.p).await,
        (fx.alice, fx.personal_account(fx.alice).await),
        "…and still re-stamps owner + account"
    );
}

// ==================== the hook's SCOPE ====================

/// TEST-8 [acceptance] [invariant: INV-1] — the hook cancels the departing member's
/// transfers on THIS account's projects, and nothing else.
///
/// A member leaving one organization keeps their personal account and any other org
/// they belong to. An over-deleting hook would silently destroy transfers that the
/// removal has no business touching — as much a defect as under-deleting, and one
/// that would never surface as a security failure, only as a user's work quietly
/// disappearing.
#[tokio::test]
async fn removal_cancels_only_this_accounts_transfers() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // A SECOND org bob also belongs to, with a project of his in it.
    let other_org = make_org_account(&fx.pool, "Lab2", fx.alice).await;
    add_member(&fx.pool, other_org, fx.bob, "member").await;
    let other_project = projects.create(fx.bob, "bobs-other", "").await.unwrap().id;
    move_project_to_account(&fx.pool, other_project, other_org).await;
    // …and a project in bob's OWN personal account, which removal never touches.
    let personal_project = projects.create(fx.bob, "bobs-personal", "").await.unwrap().id;

    // Seeded FIRST and settled immediately: `uq_project_transfers_pending` is
    // UNIQUE(project_id) WHERE status='pending', so R can hold at most one pending row
    // and the settled one has to stop being pending before the live one is created.
    let settled = fx.seed_pending(fx.r, fx.bob, fx.eve).await;
    sqlx::query("UPDATE project_transfers SET status = 'declined' WHERE id = $1")
        .bind(settled)
        .execute(&fx.pool)
        .await
        .expect("settle the row");

    let in_scope_out = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    let in_scope_in = fx.seed_pending(fx.r, fx.alice, fx.bob).await;
    let other_org_transfer = fx.seed_pending(other_project, fx.bob, fx.eve).await;
    let personal_transfer = fx.seed_pending(personal_project, fx.bob, fx.eve).await;
    let other_members_transfer = fx.seed_pending(fx.q, fx.dana, fx.eve).await;
    fx.accounts()
        .remove_member(fx.org, fx.bob, super::staff_ceiling())
        .await
        .expect("removal succeeds");

    // DENY half: everything bob is a party to, on THIS account's projects, is gone.
    assert_eq!(
        (
            fx.transfer_status(in_scope_out).await,
            fx.transfer_status(in_scope_in).await
        ),
        (None, None),
        "INV-1: both directions on the departed account's projects are cancelled"
    );

    // POSITIVE CONTROLS: three rows that MUST survive, each for a different reason.
    assert_eq!(
        fx.transfer_status(other_org_transfer).await.as_deref(),
        Some("pending"),
        "a different ORGANIZATION's project — bob is still a member there, and this \
         removal has no authority over it"
    );
    assert_eq!(
        fx.transfer_status(personal_transfer).await.as_deref(),
        Some("pending"),
        "bob's OWN personal project — leaving an org does not touch what he owns \
         outside it"
    );
    assert_eq!(
        fx.transfer_status(other_members_transfer).await.as_deref(),
        Some("pending"),
        "another member's transfer on this same account — bob is not a party to it"
    );
    assert_eq!(
        fx.transfer_status(settled).await.as_deref(),
        Some("declined"),
        "a SETTLED transfer bob was a party to, on this very account — offboarding \
         cancels PENDING offers, it does not erase resolved history"
    );
}

// ==================== the accept-time check reads CURRENT authority ====================

/// TEST-9 [acceptance] [invariant: INV-2] — the initiator gate consults CURRENT
/// authority through `effective_permission`, not the `projects.owner_id` column.
///
/// The subject is an initiator who is still a MEMBER but was demoted below
/// project-Owner after opening the transfer (DEC-4). Removal never happened, so half
/// (a) cannot fire and the row is still pending; and the initiator is not the
/// project's `owner_id`, so a check that merely compared `from_user_id` to
/// `projects.owner_id` would refuse for the wrong reason on every transfer. Only a
/// check that resolves current authority gets this pair right.
#[tokio::test]
async fn the_accept_gate_refuses_an_initiator_whose_authority_was_withdrawn() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();
    let accounts = fx.accounts();

    // A second account owner, so alice can be demoted without tripping LAST_OWNER.
    let carol = create_user(&server, &fx.admin_token, "carol", "carol@x.test").await;
    add_member(&fx.pool, fx.org, carol, "owner").await;

    // alice offers BOB'S project P (she reaches it as an account owner, not as its
    // `owner_id`), and carol offers DANA'S project Q the same way.
    let alices = fx.seed_pending(fx.p, fx.alice, fx.eve).await;
    let carols = fx.seed_pending(fx.q, carol, fx.eve).await;
    assert_eq!(
        projects.effective_permission(fx.p, fx.alice).await.unwrap(),
        Some(EffectivePermission::Owner),
        "control: at create time alice really did hold the authority the transfer needs"
    );

    // The sanction is withdrawn — no removal, just a demotion.
    accounts
        .set_role(fx.org, fx.alice, AccountRole::Member, super::staff_ceiling())
        .await
        .expect("demoting a non-sole owner succeeds");

    assert_eq!(
        fx.transfer_status(alices).await.as_deref(),
        Some("pending"),
        "half (a) cannot have fired — nobody was removed — so what follows is the \
         accept-time check alone"
    );
    let err = projects
        .accept_transfer(alices, fx.eve)
        .await
        .expect_err("INV-2/DEC-4: a withdrawn sanction must not still be honoured");
    assert_transfer_revoked(err, "demoted initiator");
    assert_eq!(
        fx.project_owner_and_account(fx.p).await.1,
        fx.org,
        "…and P stayed in the organization"
    );

    // POSITIVE CONTROL — the identical shape (an account owner transferring a project
    // owned by someone else, to the same non-member) with authority INTACT still
    // completes. So the refusal is the demotion, and the gate is not simply rejecting
    // every initiator who is not `projects.owner_id`.
    assert!(
        projects
            .accept_transfer(carols, fx.eve)
            .await
            .expect("an authorized initiator's transfer must not error"),
        "positive control: carol still holds authority, so her identically-shaped \
         transfer still completes"
    );
    assert_eq!(fx.project_owner_and_account(fx.q).await.0, fx.eve);
}

// ============ the OTHER offboarding door: deactivation (audit AUD-1) ============

/// TEST-10 [acceptance] [invariant: INV-2] — deactivating the initiator, rather than
/// removing their membership, must not leave the whole of #171 reachable.
///
/// Found by the blind audit, corroborated by both angles. This product offboards two
/// ways: deleting the `account_members` row, and flipping `users.is_active`. Only the
/// first runs the hook, and `effective_permission` — which the accept-time gate was
/// built on — reads `projects` + `account_members` and never joins `users`. So a
/// deactivated initiator resolved as `Owner`, half (a) never fired, and the escape
/// was open through the adjacent door.
///
/// Deactivation is not an edge case here: `create_transfer` already refuses an
/// `INACTIVE_RECIPIENT`, and the project-admin surface labels a project whose owner is
/// deactivated `is_orphaned`. The omission was asymmetric, not a considered exclusion.
#[tokio::test]
async fn a_deactivated_initiators_transfer_cannot_be_accepted_either() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    let control = fx.seed_pending(fx.q, fx.dana, fx.eve).await;

    // The OTHER offboarding lever: no membership row is touched.
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(fx.bob)
        .execute(&fx.pool)
        .await
        .expect("deactivate bob");

    // Both facts that make this test mean something, asserted rather than assumed:
    let still_member: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_members WHERE account_id=$1 AND user_id=$2")
            .bind(fx.org)
            .bind(fx.bob)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(
        still_member, 1,
        "bob is STILL a member — so half (a) cannot have fired and this is the \
         accept-time gate alone"
    );
    assert_eq!(
        fx.transfer_status(offer).await.as_deref(),
        Some("pending"),
        "…and his offer is still pending, for the same reason"
    );

    let err = projects
        .accept_transfer(offer, fx.eve)
        .await
        .expect_err("INV-2: a deactivated initiator no longer holds authority");
    assert_transfer_revoked(err, "deactivated initiator");
    assert_eq!(
        fx.project_owner_and_account(fx.p).await.1,
        fx.org,
        "…and P did not leave the organization through the deactivation door"
    );

    // POSITIVE CONTROL — an ACTIVE initiator, same fixture, same recipient, same
    // function. Without it the deny above would also hold if accept were simply
    // broken, or if `is_active` were being read inverted for everyone.
    assert!(
        projects
            .accept_transfer(control, fx.eve)
            .await
            .expect("an active initiator's transfer must not error"),
        "positive control: dana is active and still a member, so her transfer to the \
         same non-member recipient still completes"
    );
    assert_eq!(fx.project_owner_and_account(fx.q).await.0, fx.eve);
}

// ============ the check-then-act window (audit AUD-2) ============

/// TEST-11 [acceptance] [invariant: INV-2] — the accept-time gate and the offboarding
/// hook cannot interleave into "the removal succeeded AND the project left anyway".
///
/// The pre-transaction authority check is a check-then-act window: it runs on its own
/// pool connection, and two more connection acquisitions happen before the claim. If
/// accept's claim commits first, the hook's DELETE blocks on the claimed row, wakes to
/// find `status = 'accepted'`, and cancels nothing — the removal reports success while
/// the project has already gone. An earlier revision of `accept_transfer`'s doc
/// claimed the hook closed that window; it does not, it LOSES the race.
///
/// What closes it is the locked in-transaction re-assert. This test forces the exact
/// interleaving deterministically — no sleeps racing a scheduler — by holding the
/// removal in an UNCOMMITTED transaction, which is what makes the row lock observable:
///
/// 1. a transaction deletes bob's membership and does NOT commit (the row is now
///    locked by it, and every OTHER connection still sees bob as a member);
/// 2. `accept_transfer` is driven concurrently — its pre-transaction check therefore
///    PASSES, which is the window;
/// 3. it must then BLOCK, asserted: if it has finished at this point, the durable
///    re-assert is not taking the lock and the window is open;
/// 4. the removal commits;
/// 5. accept wakes, re-evaluates, finds no membership, and refuses.
///
/// The positive control runs the identical sequence but ROLLS BACK at step 4, and the
/// accept must then SUCCEED — which is what proves step 3 observed a lock rather than
/// a hang, and step 5 a refusal rather than a crash.
#[tokio::test]
async fn a_removal_committing_mid_accept_still_refuses_the_transfer() {
    use sqlx::sqlite::SqlitePoolOptions;

    for (commit, label) in [(true, "removal COMMITS"), (false, "removal ROLLS BACK")] {
        let server = TestServer::spawn().await;
        let fx = Fixture::build(&server).await;
        let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;

        // The measured unobstructed accept MUST run before the obstruction opens — the
        // warm-up is a write sequence, and on SQLite the write lock is global (see the
        // split-helper note above).
        let threshold = measure_accept_latency(&fx, label).await;

        // A separate pool, so holding the removal open cannot starve accept of a
        // connection and turn a lock-wait into a pool-wait.
        let blocking = SqlitePoolOptions::new()
            .max_connections(2)
            .connect(server.database_url())
            .await
            .expect("blocking pool");
        // SQLite port: `BEGIN IMMEDIATE` at the OPEN is the serialization point — the
        // PG `begin()` was deferred and took the write lock at the DELETE, which let the
        // measured warm-up insert-through it and fail `database is locked`; with the
        // immediate open, the accept is parked at its own transaction open like every
        // other single-writer barrier in this item's port.
        let mut removal = blocking
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect("begin removal tx");
        sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
            .bind(fx.org)
            .bind(fx.bob)
            .execute(&mut *removal)
            .await
            .expect("delete membership (uncommitted)");

        // Step 3 — it must be BLOCKED on the membership row lock. This is the
        // assertion the whole test exists for: with the in-transaction re-assert
        // removed, accept sails past (the uncommitted DELETE is invisible to it) and
        // finishes here, so this goes red. The warm-up, the measured threshold and the
        // block assertion all live in `measure_accept_latency` / `spawn_blocked_accept`.
        let handle = spawn_blocked_accept(&fx, offer, fx.eve, label, threshold).await;

        if commit {
            removal.commit().await.expect("commit removal");
            // Bounded so a lock regression FAILS rather than hanging. Belt and braces
            // now that `accept_transfer` carries its own `lock_timeout` — that bound is
            // 3 s, this one is the backstop for anything it does not cover.
            let err = tokio::time::timeout(UNBLOCK_BOUND, handle)
                .await
                .expect("accept must unblock once the removal commits, not hang")
                .expect("accept task")
                .expect_err("INV-2: the committed removal must win, not be raced past");
            assert_transfer_revoked(err, label);
            assert_eq!(
                fx.project_owner_and_account(fx.p).await.1,
                fx.org,
                "{label}: and the project stayed in the organization"
            );
        } else {
            // POSITIVE CONTROL — nothing actually changed, so the SAME blocked accept
            // must now complete. This is what makes step 3's block a lock rather than
            // a hang, and the refusal above attributable to the removal.
            removal.rollback().await.expect("rollback removal");
            assert!(
                tokio::time::timeout(UNBLOCK_BOUND, handle)
                    .await
                    .expect("accept must unblock once the removal is abandoned, not hang")
                    .expect("accept task")
                    .expect("a transfer whose initiator kept authority must not error"),
                "{label}: positive control — the removal was abandoned, so the very \
                 same accept completes"
            );
            assert_eq!(
                fx.project_owner_and_account(fx.p).await.0,
                fx.eve,
                "{label}: …and really transferred"
            );
        }
    }
}

// ============ the removal's sync fan-out, observed on the wire (audit AUD-5) ============

/// TEST-12 [acceptance] [invariant: INV-1] — the `ProjectTransfer`/`delete` frames the
/// admin removal route publishes actually reach BOTH parties, observed as SSE.
///
/// TEST-7 proves the ROWS are cancelled and that `remove_member` reports them; neither
/// touches the publish loop, so deleting that loop left the whole suite green while the
/// handler's doc asserted the fan-out as established behaviour. This is the FB-17
/// "wired-and-behaving" leg for ITEM-3: it drives the live route and reads the wire,
/// using the same `SyncProbe` harness `project::accept_origin_test` uses for this
/// entity.
///
/// Both parties matter and are asserted separately: the removal is performed by a
/// platform admin who is neither of them, so NEITHER has a local mutation to echo —
/// without a frame each device keeps rendering an offer that no longer exists.
#[tokio::test]
async fn the_admin_removal_route_tells_both_parties_the_offer_is_gone() {
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;

    // A user who is neither a party to the offer NOR a member of the account — so he
    // receives no `account_member` frames either, and any frame at all on his stream
    // means the fan-out is broadcasting rather than addressing.
    create_user(&server, &fx.admin_token, "frank", "frank@x.test").await;

    let bob_token = super::login(&server, "bob").await;
    let eve_token = super::login(&server, "eve").await;
    let frank_token = super::login(&server, "frank").await;
    let mut bob_probe = SyncProbe::open(&server, &bob_token).await;
    let mut eve_probe = SyncProbe::open(&server, &eve_token).await;
    let mut frank_probe = SyncProbe::open(&server, &frank_token).await;

    // SQLite port: the admin removal ROUTE has no object on this node (the
    // `/admin/accounts/*` surface is stripped — DRIFT-1.25). The fan-out this test
    // exists to observe lives in the HANDLER (`fan_cancelled_transfers` in
    // `handlers.rs`), not in the repository — so the SAME handler-side publish loop is
    // driven through the RETAINED account-scoped removal route, with the org OWNER as
    // the remover. The claims under test (both parties are told; a party-to-nothing
    // stream stays silent) are unchanged: alice was never a party to the offer and is
    // neither of the two parties whose devices must be told.
    let alice_token = super::login(&server, "alice").await;
    let resp = server
        .client
        .delete(server.api_url(&format!("/accounts/{}/members/{}", fx.org, fx.bob)))
        .bearer_auth(&alice_token)
        .send()
        .await
        .expect("remove member (retained route)");
    assert_eq!(resp.status().as_u16(), 204, "the removal route still answers 204");

    // The INITIATOR (the departing member) is told his outgoing offer is gone…
    let to_initiator = bob_probe
        .expect_event_for("project_transfer", "delete", &offer.to_string(), WAIT)
        .await;
    assert_eq!(to_initiator.id, offer.to_string());
    // …and so is the RECIPIENT, who is not a member of the account at all and would
    // otherwise never learn of it.
    let to_recipient = eve_probe
        .expect_event_for("project_transfer", "delete", &offer.to_string(), WAIT)
        .await;
    assert_eq!(to_recipient.id, offer.to_string());

    // NEGATIVE CONTROL — the subject here is PER-PARTY addressing
    // (`Audience::owner(from)` / `Audience::owner(to)`), and both assertions above
    // would still pass if the frames were broadcast to every subscriber. Frank is a
    // party to nothing and a member of nothing, so his stream must stay silent.
    frank_probe.expect_silence(Duration::from_secs(2)).await;
}

// ============ the reverse lock ordering, with the REAL hook (audit T2) ============

/// TEST-13 [acceptance] [invariant: INV-2] — the other ordering: the ACCEPT side holds
/// the membership lock and the real `remove_member` must queue behind it, then commit
/// correctly.
///
/// TEST-11 tests one direction (removal first, accept blocks) and does it with a raw
/// `DELETE`, so the hook's own `DELETE FROM project_transfers` never participates and
/// the lock-ORDER claim is exercised by nothing. This test is its mirror and uses the
/// PRODUCTION `remove_member`, so both of its locks are real: its `FOR UPDATE` on the
/// account's owner rows, its membership DELETE, and its transfer cancellation.
///
/// Scope, stated honestly: this establishes QUEUEING and correct completion in the
/// ordering TEST-11 does not cover. It does NOT and cannot exhibit a deadlock — the
/// holder transaction takes the membership lock and nothing else, so the cycle a
/// deadlock would need (one side holding `account_members` and waiting on
/// `project_transfers` while the other holds the reverse) is structurally unreachable
/// here. An earlier version of this comment claimed the deadlock coverage; it did not
/// have it. The lock-order argument itself is reasoned, not tested, and that is
/// recorded on `accept_transfer` rather than overstated here.
#[tokio::test]
async fn a_removal_queues_behind_an_in_flight_accepts_membership_lock() {
    use sqlx::sqlite::SqlitePoolOptions;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;

    // WARM-UP + TIMING CONTROL, for the same reason `spawn_blocked_accept` has one:
    // "it has not finished yet" only detects an operation that is NOT blocked if that
    // operation is also FAST, and this is the FIRST `remove_member` in a freshly
    // spawned server with a cold pool and cold plans. So measure an UNOBSTRUCTED
    // `remove_member` first — removing dana, who is a party to nothing and whose row
    // the holder does not hold — and derive the threshold from it. Without this the
    // test goes green on precisely the regression it exists to catch.
    // SQLite port (record): the warm-up is a write sequence, so it MUST run before the
    // holder opens its transaction — on the single-writer model a deferred holder does
    // not hold the lock, and an immediate one blocks the warm-up instead of the subject
    // (the same split as `measure_accept_latency`/`spawn_blocked_accept`).
    let warm_start = tokio::time::Instant::now();
    fx.accounts()
        .remove_member(fx.org, fx.dana, super::staff_ceiling())
        .await
        .expect("warm-up control: an unobstructed removal succeeds");
    let warm = warm_start.elapsed();

    // Stand in for an accept that has taken its `FOR SHARE` and not yet committed, by
    // taking the identical lock on the identical row from a separate pool.
    // SQLite port (record): `FOR SHARE` has no SQLite form — the accept's serialization
    // point on SQLite is the single write lock, taken at `BEGIN IMMEDIATE` (ITEM-18),
    // so the stand-in takes THAT: the production predicate below runs inside a
    // write-lock transaction, which is exactly the state `accept_transfer` occupies
    // between its first write and its commit.
    let holder_pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("holder pool");
    let mut holder = holder_pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .expect("begin holder tx");
    // Calls the PRODUCTION predicate, so the lock this test holds is BY CONSTRUCTION
    // the one `accept_transfer` takes. An earlier version re-typed the SQL here — the
    // very practice DEC-24 was written to eliminate — and the copy had already
    // diverged (it omitted the role conjunct), so the comment claiming an "identical
    // lock" was already inaccurate one round after it was written.
    let held = ProjectRepository::initiator_still_owner_locked(&mut holder, fx.p, fx.bob)
        .await
        .expect("take the share lock");
    assert!(
        held,
        "control: the lock really was taken on bob's membership row — otherwise the \
         queueing assertion below would be about nothing"
    );

    let accounts = fx.accounts();
    let org = fx.org;
    let bob = fx.bob;
    let removal = tokio::spawn(async move { accounts.remove_member(org, bob, super::staff_ceiling()).await });

    let threshold = std::cmp::min(std::cmp::max(BLOCK_FLOOR, warm * BLOCK_WARM_MULTIPLIER), BLOCK_CEILING);
    tokio::time::sleep(threshold).await;
    assert!(
        !removal.is_finished(),
        "the real `remove_member` must QUEUE behind the accept's share lock rather \
         than tearing the membership out from under an in-flight accept — finishing \
         within {threshold:?} (an unobstructed removal took {warm:?}) means it did not \
         queue at all"
    );

    // Release, and the removal must then complete NORMALLY — not deadlock, not error.
    // This is the leg that would catch a lock-mode incompatibility or a cycle between
    // the two transactions' orders.
    holder.commit().await.expect("release the share lock");
    let cancelled = tokio::time::timeout(UNBLOCK_BOUND, removal)
        .await
        .expect("the removal must proceed once the lock is released, not deadlock")
        .expect("removal task")
        .expect("removal must succeed, not error");

    assert_eq!(
        cancelled.iter().map(|c| c.id).collect::<Vec<_>>(),
        vec![offer],
        "…and having queued, it still does its whole job: the pending transfer is \
         reported cancelled"
    );
    assert_eq!(
        fx.transfer_status(offer).await,
        None,
        "…and really is cancelled"
    );
    assert_eq!(
        fx.project_owner_and_account(fx.p).await.1,
        fx.org,
        "…with the project still in the organization"
    );
}

// ============ the refusals AT THE HTTP BOUNDARY (audit T3) ============

/// TEST-14 [acceptance] [invariant: INV-4] — the two refusal shapes, observed as HTTP
/// status codes on the real `POST /api/project-transfers/{id}/accept` route.
///
/// Every other accept assertion in this suite calls `ProjectRepository::accept_transfer`
/// directly, so the module header's claim that the halves are "distinguishable at the
/// boundary" was established nowhere — and half (a) got two FB-17 "wired on the real
/// route" tests while half (b) got none. A change to `handlers::accept_transfer` that
/// bypassed or reordered the gate would have left the whole suite green.
///
/// It also pins the ACTUAL mechanism of the 404, which is not the one the header
/// originally described: for a cancelled row the handler's own `get_transfer` pre-fetch
/// 404s before `accept_transfer` is reached at all. Same status to the client, but a
/// different code path, and the header now says so.
#[tokio::test]
async fn the_two_refusals_are_distinguishable_at_the_http_boundary() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let eve_token = super::login(&server, "eve").await;

    let accept = |token: String, id: Uuid| {
        let client = server.client.clone();
        let url = server.api_url(&format!("/project-transfers/{id}/accept"));
        async move {
            client
                .post(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("accept request")
                .status()
                .as_u16()
        }
    };

    // (1) HALF (a) — the row was cancelled by an offboarding removal ⇒ 404.
    let cancelled = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    fx.accounts()
        .remove_member(fx.org, fx.bob, super::staff_ceiling())
        .await
        .expect("removal succeeds");
    assert_eq!(
        accept(eve_token.clone(), cancelled).await,
        404,
        "half (a) answers 404 at the boundary — the offer no longer exists"
    );

    // (2) HALF (b) — the row SURVIVES (hook bypassed) but the initiator lost
    // authority ⇒ 409. Different code, different path, same recipient.
    add_member(&fx.pool, fx.org, fx.bob, "member").await;
    let revoked = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    fx.raw_unmember(fx.org, fx.bob).await;
    assert_eq!(
        accept(eve_token.clone(), revoked).await,
        409,
        "half (b) answers 409 at the boundary — the offer exists but is no longer \
         valid. This is what makes the two halves attributable to a client, and it is \
         asserted here rather than claimed in a comment"
    );

    // POSITIVE CONTROL — the same route, the same recipient, a transfer in good
    // standing ⇒ 200. Without it, both denies above would also hold if the route were
    // simply broken for eve, or if the gate refused everything.
    let good = fx.seed_pending(fx.q, fx.dana, fx.eve).await;
    assert_eq!(
        accept(eve_token, good).await,
        200,
        "positive control: a legitimate transfer to a non-member still succeeds \
         through the real HTTP route"
    );
    assert_eq!(
        fx.project_owner_and_account(fx.q).await.0,
        fx.eve,
        "…and really transferred"
    );
}

// ============ the two spellings of "Owner" must agree (audit C1) ============

/// TEST-15 [acceptance] [invariant: INV-2] — the in-transaction re-assert and
/// `effective_permission` agree about who counts as project `Owner`.
///
/// The in-transaction check is a SECOND spelling of a condition `effective_permission`
/// also computes — `(p.owner_id = $2 OR am.role = 'owner')`, conjoined with membership
/// of the project's account. That is exactly the drift hazard #147 built
/// `require_dataset_read_matches_is_visible_to` for: two SQL literals that must agree
/// about one condition and silently stop agreeing. So it is pinned rather than
/// narrated.
///
/// The matrix deliberately includes the principal an existence-only check got WRONG (a
/// DEMOTED account owner, who still has a membership row) and the one a role-only check
/// would get wrong (a plain `member` who CREATED the project, and reaches Owner through
/// the creator branch, not through their role).
#[tokio::test]
async fn the_in_transaction_reassert_agrees_with_effective_permission() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // Calls the PRODUCTION predicate, not a copy of it. This is the whole point: an
    // earlier version of this test re-typed the SQL here, so the two "agreeing"
    // spellings were this test's copy and itself — reverting the production predicate
    // to its existence-only form left the entire suite green. The mutation battery
    // caught it; the fix was to give the predicate a name so a test can reach it.
    async fn reassert(pool: &SqlitePool, project: Uuid, user: Uuid) -> bool {
        let mut conn = pool.acquire().await.expect("connection");
        ProjectRepository::initiator_still_owner_locked(&mut conn, project, user)
            .await
            .expect("re-assert predicate")
    }

    // A demotable second owner, and an `admin`-role member — the two roles whose
    // floors differ (owner→Owner, admin→Editor) and which a role check must separate.
    let carol = create_user(&server, &fx.admin_token, "carol", "carol@x.test").await;
    add_member(&fx.pool, fx.org, carol, "owner").await;
    let mallory = create_user(&server, &fx.admin_token, "mallory", "mallory@x.test").await;
    add_member(&fx.pool, fx.org, mallory, "admin").await;

    let cases: Vec<(&str, Uuid, Uuid)> = vec![
        // bob CREATED P and is a plain `member` — Owner via the creator branch only.
        ("creator, plain member", fx.p, fx.bob),
        // alice is an account `owner` on a project she did NOT create — Owner via role.
        ("account owner, not creator", fx.p, fx.alice),
        // carol likewise, on dana's project.
        ("second account owner", fx.q, carol),
        // an `admin`-role member reaches Editor, never Owner.
        ("admin-role member", fx.p, mallory),
        // a plain member who did not create it reaches Viewer.
        ("plain member, not creator", fx.q, fx.bob),
        // a total outsider reaches nothing.
        ("non-member", fx.p, fx.eve),
        // alice on her OWN project — the creator AND owner-role case.
        ("creator and account owner", fx.r, fx.alice),
    ];

    for (label, project, user) in cases {
        let by_chokepoint =
            projects.effective_permission(project, user).await.unwrap() == Some(EffectivePermission::Owner);
        let by_reassert = reassert(&fx.pool, project, user).await;
        assert_eq!(
            by_chokepoint, by_reassert,
            "{label}: the two spellings of project-Owner must agree, or the durable \
             half of the accept gate has drifted from the chokepoint it narrows"
        );
    }
    // The matrix must actually contain BOTH answers, or the agreement above is
    // vacuous — two predicates that always say `false` also "agree".
    assert!(
        projects.effective_permission(fx.p, fx.bob).await.unwrap() == Some(EffectivePermission::Owner)
            && reassert(&fx.pool, fx.p, fx.bob).await,
        "control: the matrix contains a principal both predicates ADMIT"
    );
    assert!(
        projects.effective_permission(fx.p, fx.eve).await.unwrap() != Some(EffectivePermission::Owner)
            && !reassert(&fx.pool, fx.p, fx.eve).await,
        "control: …and one both predicates REFUSE"
    );

    // And the demotion case the existence-only version got wrong, end to end: carol
    // (an account owner, not the creator) is demoted, and both predicates must flip.
    fx.accounts()
        .set_role(fx.org, carol, AccountRole::Member, super::staff_ceiling())
        .await
        .expect("demote carol");
    assert!(
        !reassert(&fx.pool, fx.q, carol).await,
        "a DEMOTED account owner is no longer project-Owner by the re-assert — an \
         existence-only membership check said otherwise and left the demotion door open"
    );
    assert!(
        projects.effective_permission(fx.q, carol).await.unwrap() != Some(EffectivePermission::Owner),
        "…and the chokepoint agrees"
    );
}

// ============ the DEMOTION race the existence-only check missed (audit C1) ============

/// TEST-16 [acceptance] [invariant: INV-2] — a DEMOTION committing mid-accept is
/// refused, not raced past.
///
/// This is the reproduction the correctness audit ran against a live Postgres, turned
/// into a test. The first version of the durable re-assert checked only that a
/// membership row EXISTED, so when a demotion committed during the block, READ
/// COMMITTED re-evaluated against the updated tuple — whose `user_id` and `account_id`
/// still satisfied a user-only predicate — and the accept proceeded. The project left
/// the tenant with a demoted initiator: "the demotion succeeded AND the project left
/// anyway", the exact shape the re-assert exists to prevent.
///
/// The subject must be an account `owner` who is NOT the project's `owner_id` (alice on
/// bob's project P), because that is the only principal whose authority comes purely
/// from the role — the one an existence-only check cannot see change. The pre-transaction
/// check passes (the demotion is uncommitted and therefore invisible to it), so what
/// refuses here can only be the in-transaction re-assert reading `am.role`.
#[tokio::test]
async fn a_demotion_committing_mid_accept_still_refuses_the_transfer() {
    use sqlx::sqlite::SqlitePoolOptions;

    for (commit, label) in [(true, "demotion COMMITS"), (false, "demotion ROLLS BACK")] {
        let server = TestServer::spawn().await;
        let fx = Fixture::build(&server).await;
        // alice offers BOB'S project — she reaches it as an account owner, never as
        // its `owner_id`. That is what makes the role the only thing holding her up.
        let offer = fx.seed_pending(fx.p, fx.alice, fx.eve).await;
        assert_eq!(
            fx.project_owner_and_account(fx.p).await.0,
            fx.bob,
            "{label}: control — the initiator is deliberately NOT the project's owner_id"
        );

        // The measured unobstructed accept first — see the split-helper port note.
        let threshold = measure_accept_latency(&fx, label).await;

        let blocking = SqlitePoolOptions::new()
            .max_connections(2)
            .connect(server.database_url())
            .await
            .expect("blocking pool");
        let mut demotion = blocking
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect("begin demotion tx");
        sqlx::query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2")
            .bind(fx.org)
            .bind(fx.alice)
            .execute(&mut *demotion)
            .await
            .expect("demote (uncommitted)");

        // The pre-transaction check still sees `owner` — the demotion is uncommitted.
        assert_eq!(
            fx.projects().effective_permission(fx.p, fx.alice).await.unwrap(),
            Some(EffectivePermission::Owner),
            "{label}: the pre-transaction check PASSES here, so anything that refuses \
             below is the in-transaction re-assert alone"
        );

        let handle = spawn_blocked_accept(&fx, offer, fx.eve, label, threshold).await;

        if commit {
            demotion.commit().await.expect("commit demotion");
            let err = tokio::time::timeout(UNBLOCK_BOUND, handle)
                .await
                .expect("accept must unblock once the demotion commits, not hang")
                .expect("accept task")
                .expect_err("INV-2: a committed demotion must win, not be raced past");
            assert_transfer_revoked(err, label);
            assert_eq!(
                fx.project_owner_and_account(fx.p).await,
                (fx.bob, fx.org),
                "{label}: and the project stayed in the organization, owner unchanged"
            );
        } else {
            // POSITIVE CONTROL — the demotion was abandoned, so the same blocked
            // accept must complete. This is what proves the refusal above is the
            // demotion and not the block itself.
            demotion.rollback().await.expect("rollback demotion");
            assert!(
                tokio::time::timeout(UNBLOCK_BOUND, handle)
                    .await
                    .expect("accept must unblock once the demotion is abandoned, not hang")
                    .expect("accept task")
                    .expect("an initiator who kept their role must not error"),
                "{label}: positive control — the demotion was abandoned, so the very \
                 same accept completes"
            );
            assert_eq!(
                fx.project_owner_and_account(fx.p).await.0,
                fx.eve,
                "{label}: …and really transferred"
            );
        }
    }
}

// ====== the stale-`owner_id` read the `p` lock exists to prevent (audit AUD-18) ======

/// TEST-17 [acceptance] [invariant: INV-2] — a change of `projects.owner_id`
/// committing mid-accept is SEEN by the durable re-assert, not read stale.
///
/// `FOR SHARE OF am` alone locks only `account_members`. On unblocking, Postgres's
/// EvalPlanQual re-checks the qual using the NEW tuple for the LOCKED relation but the
/// PRE-BLOCK snapshot tuple for any unlocked one — so the `p.owner_id = $2` disjunct
/// passed on a stale `owner_id`, and the creator half of the gate was only as strong as
/// READ COMMITTED while its comment claimed it was as strong as the lock. The fix was
/// to lock `p` as well; this test is what makes that fix falsifiable.
///
/// The subject must be a PLAIN MEMBER who CREATED the project (bob on P): his authority
/// comes from `projects.owner_id` and from nothing else, so he is the only principal
/// whose gate outcome depends on reading that column freshly. For an account `owner`
/// the `am.role` disjunct would carry the check regardless and the staleness would be
/// invisible — which is exactly why it went unnoticed.
#[tokio::test]
async fn an_owner_id_change_committing_mid_accept_is_not_read_stale() {
    use sqlx::sqlite::SqlitePoolOptions;

    for (commit, label) in [(true, "owner_id change COMMITS"), (false, "it ROLLS BACK")] {
        let server = TestServer::spawn().await;
        let fx = Fixture::build(&server).await;
        let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
        assert_eq!(
            fx.project_owner_and_account(fx.p).await.0,
            fx.bob,
            "{label}: control — the initiator IS the project's owner_id, which is the \
             only thing giving him authority here"
        );

        // The measured unobstructed accept first — see the split-helper port note.
        let threshold = measure_accept_latency(&fx, label).await;

        let blocking = SqlitePoolOptions::new()
            .max_connections(2)
            .connect(server.database_url())
            .await
            .expect("blocking pool");
        let mut mover = blocking
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect("begin mover tx");
        // Touch the membership row so the accept BLOCKS (a no-op write still locks it),
        // and move the project's owner_id out from under him in the same transaction.
        sqlx::query("UPDATE account_members SET role = role WHERE account_id = $1 AND user_id = $2")
            .bind(fx.org)
            .bind(fx.bob)
            .execute(&mut *mover)
            .await
            .expect("lock the membership row");
        sqlx::query("UPDATE projects SET owner_id = $2 WHERE id = $1")
            .bind(fx.p)
            .bind(fx.alice)
            .execute(&mut *mover)
            .await
            .expect("re-point owner_id (uncommitted)");

        // Uncommitted, so the pre-transaction check still sees bob as the owner.
        assert_eq!(
            fx.projects().effective_permission(fx.p, fx.bob).await.unwrap(),
            Some(EffectivePermission::Owner),
            "{label}: the pre-transaction check PASSES, so anything that refuses below \
             is the in-transaction re-assert reading a FRESH projects tuple"
        );

        let handle = spawn_blocked_accept(&fx, offer, fx.eve, label, threshold).await;

        if commit {
            mover.commit().await.expect("commit the owner_id change");
            let err = tokio::time::timeout(UNBLOCK_BOUND, handle)
                .await
                .expect("accept must unblock once the change commits, not hang")
                .expect("accept task")
                .expect_err(
                    "INV-2: the initiator no longer owns the project, and the re-assert \
                     must SEE that — with `p` absent from the lock list it re-evaluates \
                     against the pre-block snapshot and lets the transfer through",
                );
            assert_transfer_revoked(err, label);
            assert_eq!(
                fx.project_owner_and_account(fx.p).await,
                (fx.alice, fx.org),
                "{label}: and the project stayed in the organization, under its new owner"
            );
        } else {
            // POSITIVE CONTROL — nothing actually changed, so the same blocked accept
            // must complete. This is what proves the refusal above is the fresh read
            // and not the block itself.
            mover.rollback().await.expect("rollback");
            assert!(
                tokio::time::timeout(UNBLOCK_BOUND, handle)
                    .await
                    .expect("accept must unblock once the change is abandoned, not hang")
                    .expect("accept task")
                    .expect("an initiator who kept ownership must not error"),
                "{label}: positive control — the change was abandoned, so the very same \
                 accept completes"
            );
            assert_eq!(
                fx.project_owner_and_account(fx.p).await.0,
                fx.eve,
                "{label}: …and really transferred"
            );
        }
    }
}

// ========== the fail-open between the two halves (audit AUD-30) ==========

/// TEST-18 [acceptance] [invariant: INV-1] — an accept that races an in-flight removal
/// must LOSE to it once the removal has claimed the transfer row.
///
/// This is the branch's most serious finding, reproduced against a real Postgres by the
/// round-6 error-handling angle. In #171's path 1 — the departing member is the
/// RECIPIENT — half (b) has nothing to refuse on, because the INITIATOR's authority is
/// intact. So half (a) is the only mechanism, and with the cancellation running LAST in
/// `remove_member`'s transaction it held membership locks and none on
/// `project_transfers` for its whole life. A concurrent accept slipped between the
/// membership DELETE and the cancellation, claimed the transfer, re-stamped the project
/// into the recipient's personal account and committed; the cancellation then woke,
/// found `status = 'accepted'`, deleted 0 rows — and the removal COMMITTED REPORTING
/// SUCCESS. The org's project left the tenant with the removed member and nothing
/// reported a problem: one mechanism failing silently, which is the exact thing the
/// owner chose two mechanisms to survive.
///
/// The fix is ordering — cancel the transfers BEFORE deleting the membership — and this
/// test pins the property that makes the ordering sufficient: once a transaction has
/// claimed the pending transfer row, a concurrent accept BLOCKS on it and, when that
/// transaction commits, refuses rather than completing on a row that is gone.
#[tokio::test]
async fn an_accept_racing_a_claimed_transfer_row_loses_to_it() {
    use sqlx::sqlite::SqlitePoolOptions;

    for (commit, label) in [(true, "the claim COMMITS"), (false, "the claim ROLLS BACK")] {
        let server = TestServer::spawn().await;
        let fx = Fixture::build(&server).await;
        // Path 1: alice (authority intact throughout) offers the org's project to bob,
        // who is the party being offboarded. Half (b) is inert here by construction.
        let offer = fx.seed_pending(fx.r, fx.alice, fx.bob).await;
        assert_eq!(
            fx.projects().effective_permission(fx.r, fx.alice).await.unwrap(),
            Some(EffectivePermission::Owner),
            "{label}: the INITIATOR's authority is intact — this is the direction the \
             accept-time check structurally cannot cover, so half (a) is alone"
        );

        // The measured unobstructed accept first — see the split-helper port note.
        let threshold = measure_accept_latency(&fx, label).await;

        let blocking = SqlitePoolOptions::new()
            .max_connections(2)
            .connect(server.database_url())
            .await
            .expect("blocking pool");
        let mut removal = blocking.begin_with("BEGIN IMMEDIATE").await.expect("begin removal tx");
        // Exactly what the offboarding hook now does FIRST, before touching membership.
        // `DELETE … USING` has no SQLite grammar — the EXISTS/subquery rewrite (the
        // ITEM-18 record; same rows, same predicate; the write lock is this
        // transaction's `BEGIN IMMEDIATE`).
        let claimed = sqlx::query(
            "DELETE FROM project_transfers \
              WHERE id IN (SELECT t.id FROM project_transfers t JOIN projects p \
                               ON t.project_id = p.id \
                           WHERE t.status = 'pending' AND p.account_id = $1 \
                             AND (t.from_user_id = $2 OR t.to_user_id = $2))",
        )
        .bind(fx.org)
        .bind(fx.bob)
        .execute(&mut *removal)
        .await
        .expect("claim the pending transfer row");
        assert_eq!(
            claimed.rows_affected(),
            1,
            "{label}: control — the removal really did claim bob's pending offer, or \
             the blocking assertion below would be about nothing"
        );

        let handle = spawn_blocked_accept(&fx, offer, fx.bob, label, threshold).await;

        if commit {
            removal.commit().await.expect("commit the removal");
            assert!(
                !tokio::time::timeout(UNBLOCK_BOUND, handle)
                    .await
                    .expect("accept must unblock once the removal commits, not hang")
                    .expect("accept task")
                    .expect("a cancelled transfer is a plain refusal, not an error"),
                "{label}: INV-1 — the accept must LOSE to the removal that claimed the \
                 row first. Before the ordering fix it won, the project left the \
                 tenant, and the removal still reported success"
            );
            assert_eq!(
                fx.project_owner_and_account(fx.r).await.1,
                fx.org,
                "{label}: and the project stayed in the organization"
            );
        } else {
            // POSITIVE CONTROL — the removal was abandoned, so the offer is live again
            // and the SAME blocked accept must complete. This is what proves the
            // refusal above is the claim and not the block.
            removal.rollback().await.expect("rollback the removal");
            assert!(
                tokio::time::timeout(UNBLOCK_BOUND, handle)
                    .await
                    .expect("accept must unblock once the removal is abandoned, not hang")
                    .expect("accept task")
                    .expect("a live transfer must not error"),
                "{label}: positive control — the removal was abandoned, so the very \
                 same accept completes"
            );
            assert_eq!(
                fx.project_owner_and_account(fx.r).await.0,
                fx.bob,
                "{label}: …and really transferred"
            );
        }
    }
}

// ===== the ORDER of remove_member's two statements (audit AUD-30, mutation M12) =====

/// TEST-19 [acceptance] [invariant: INV-1] — `remove_member` claims the pending
/// transfers BEFORE it deletes the membership, not after.
///
/// TEST-18 pins the property that makes the ordering sufficient (an accept blocks on a
/// claimed transfer row and then refuses). It does NOT pin the ordering itself: mutation
/// M12 puts the cancellation back after the membership DELETE — restoring the fail-open
/// — and TEST-18 stays green, because it simulates the hook with its own DELETE rather
/// than observing where in the transaction the real one runs. That is the third time on
/// this branch that a fix's test pinned everything except the fix (see AUD-17, AUD-29).
///
/// The ordering IS observable, from outside, while the removal is mid-transaction:
///
/// - hold the pending transfer row (`FOR UPDATE`) so the hook's DELETE must block;
/// - start the real `remove_member` and let it reach that block;
/// - from a THIRD connection, try to lock the departing member's `account_members` row
///   with `NOWAIT`.
///
/// Cancellation FIRST: the removal is blocked in the hook and has not touched
/// `account_members` yet, so the probe SUCCEEDS. Cancellation LAST: the removal has
/// already deleted that row and holds it exclusively, so the probe fails immediately
/// with `55P03`. The probe is the discriminator, and it is deterministic — `NOWAIT`
/// never waits, so there is no timing race in the assertion itself.
///
/// SQLite port note (ITEM-25): the PG `FOR UPDATE` hold + `NOWAIT` probe have no
/// SQLite form. The holder takes the single write lock at `BEGIN IMMEDIATE` (the
/// row-lock substitution); the removal queues behind it at its own transaction open;
/// and the probe becomes a snapshot read of the membership row (an uncommitted
/// removal is invisible, so the row still shows the departing member). The ordering
/// itself — cancel before delete — is internal to one transaction and unobservable
/// from outside on SQLite's single-writer model; its external consequence (a
/// concurrent accept seeing a half-state) is structurally unreachable.
///
/// (`remove_member`'s first statement locks the account's OWNER rows; the subject is a
/// plain `member`, so his row is untouched until the membership DELETE. That is what
/// makes the probe clean.)
#[tokio::test]
async fn removal_claims_the_transfers_before_deleting_the_membership() {
    use sqlx::sqlite::SqlitePoolOptions;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let offer = fx.seed_pending(fx.r, fx.alice, fx.bob).await;

    let holder_pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("holder pool");
    // SQLite's one isolation model: the holder takes the single WRITE lock at the
    // transaction's OPEN (`BEGIN IMMEDIATE`), which is what the PG `FOR UPDATE` on
    // the transfer row did — the offboarding hook's own write transaction queues
    // behind it instead of proceeding mid-hold.
    let mut holder = holder_pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .expect("begin holder tx");
    let held = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM project_transfers WHERE id = $1",
    )
    .bind(offer)
    .fetch_optional(&mut *holder)
    .await
    .expect("hold the pending transfer row");
    assert_eq!(
        held,
        Some(offer),
        "control: the transfer row really is held, or the removal below would not block \
         and the probe would prove nothing"
    );

    let accounts = fx.accounts();
    let org = fx.org;
    let bob = fx.bob;
    let removal = tokio::spawn(async move { accounts.remove_member(org, bob, super::staff_ceiling()).await });

    // Let it reach the hook and block there. BLOCK_CEILING, not the production
    // lock_timeout: `remove_member` sets none, so it waits indefinitely.
    tokio::time::sleep(BLOCK_CEILING).await;
    assert!(
        !removal.is_finished(),
        "the removal must be blocked in the hook — if it finished, it never contended \
         for the transfer row at all"
    );

    // THE DISCRIMINATOR — SQLite port (record): PG's `FOR UPDATE NOWAIT` probe has
    // no SQLite form, and on the one-isolation model the question "has the removal
    // touched the membership row yet" has no lock-level answer — the removal is
    // parked at the write lock either way, and an uncommitted state is invisible to
    // a reader. The probe becomes a snapshot READ of the row: while the removal is
    // blocked, the membership row still shows the departing member (the removal
    // cannot have committed its DELETE), which is the same fixture-state fact the
    // PG probe asserted. The internal ordering (cancel-then-delete) is enforced by
    // the transaction's statement order and is unobservable from outside on SQLite
    // — the window a concurrent accept exploited is structurally unreachable
    // (single writer). Recorded as the ITEM-25 port note.
    let probe_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(server.database_url())
        .await
        .expect("probe pool");
    let mut probe = probe_pool.begin().await.expect("begin probe tx");
    let probed = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(fx.org)
    .bind(fx.bob)
    .fetch_optional(&mut *probe)
    .await
    .expect("read the membership row");
    assert_eq!(
        probed,
        Some(fx.bob),
        "the membership row is still there, uncommitted-removal -> invisible, at \
         that moment"
    );
    probe.rollback().await.expect("release the probe");

    // Release, and the removal must complete normally and do its whole job.
    holder.commit().await.expect("release the transfer row");
    let cancelled = tokio::time::timeout(UNBLOCK_BOUND, removal)
        .await
        .expect("the removal must proceed once the row is released, not deadlock")
        .expect("removal task")
        .expect("removal must succeed");
    assert_eq!(
        cancelled.iter().map(|c| c.id).collect::<Vec<_>>(),
        vec![offer],
        "…cancelling the offer it had claimed"
    );
    assert_eq!(fx.transfer_status(offer).await, None, "…which really is gone");
    assert_eq!(
        fx.project_owner_and_account(fx.r).await.1,
        fx.org,
        "…with the project still in the organization"
    );
}

// ===== the anti-oracle conjunct: a NON-PARTY never reaches the 409 (audit AUD-39) =====

/// TEST-20 [acceptance] [invariant: INV-2] — the recipient/pending pre-check keeps a
/// stranger on the 404 path, so the 409's disclosure reaches the RECIPIENT and nobody
/// else.
///
/// `accept_transfer`'s doc claims exactly this ("the recipient/pending pre-check below
/// keeps a NON-PARTY on the 404 path so the distinction is never visible to a stranger")
/// and it is what DEC-19 leans on when it accepts the 409's disclosure as narrow. **Until
/// this test, nothing enforced it**: dropping `pending.to_user_id != to_user_id` left the
/// entire suite green.
///
/// The conjunct is load-bearing and not belt-and-braces, because the handler's own
/// `get_transfer` pre-fetch is NOT recipient-scoped — it 404s only when the row does not
/// exist at all. So this one comparison is the sole thing standing between any
/// authenticated holder of a transfer id and two things they should not get:
///
/// 1. the knowledge that some initiator's standing inside an organization they have no
///    relationship to has changed — the very disclosure DEC-19 argues is confined to the
///    recipient; and
/// 2. reach far enough into the transaction to take `FOR UPDATE` on an ARBITRARY project
///    row, i.e. a lock-contention primitive available to any authenticated user.
///
/// **Two-sided on one fixture, deliberately.** "The stranger gets 404" passes vacuously
/// if the whole path is broken — a 404 is also what a dead route, a missing row or a
/// refusing gate produces. So the SAME pending transfer, in the SAME lost-authority
/// state, is accepted by the real recipient and must answer 409. One row, two callers,
/// two different answers: that pair can only hold if the recipient comparison is doing
/// its job.
#[tokio::test]
async fn a_non_party_never_learns_why_the_transfer_is_refused() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // A stranger to this transfer: authenticated, holds projects::use, and has no
    // relationship to the org or to either party. The weakest possible claim on the row.
    let carl = create_user(&server, &fx.admin_token, "carl", "carl@x.test").await;

    // bob offers the org's project to eve, then loses authority with the hook bypassed,
    // so the row SURVIVES pending and the accept-time gate is what refuses it. That is
    // the only state in which the two answers differ — with the row gone, everyone gets
    // 404 and the conjunct is unobservable.
    let offer = fx.seed_pending(fx.p, fx.bob, fx.eve).await;
    fx.raw_unmember(fx.org, fx.bob).await;
    assert_eq!(
        fx.transfer_status(offer).await.as_deref(),
        Some("pending"),
        "control: the row must still be PENDING — if it were gone, both callers would \
         get 404 for the same reason and this test would prove nothing"
    );

    // --- SIDE 1: the stranger. Ok(false) => 404, and NOT the 409. ---
    let stranger = projects
        .accept_transfer(offer, carl)
        .await
        .expect("a non-party must get a plain refusal, never an error carrying WHY");
    assert!(
        !stranger,
        "a non-party's accept is refused"
    );

    // --- SIDE 2: the real recipient, same row, same instant. 409. ---
    let err = projects
        .accept_transfer(offer, fx.eve)
        .await
        .expect_err("the RECIPIENT is entitled to know the offer is dead");
    assert_transfer_revoked(err, "the real recipient");

    // --- the same pair AT THE HTTP BOUNDARY, which is where the disclosure lives ---
    let status_for = |token: String| {
        let client = server.client.clone();
        let url = server.api_url(&format!("/project-transfers/{offer}/accept"));
        async move {
            client
                .post(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("accept request")
                .status()
                .as_u16()
        }
    };
    let carl_token = super::login(&server, "carl").await;
    let eve_token = super::login(&server, "eve").await;
    let stranger_status = status_for(carl_token).await;
    let recipient_status = status_for(eve_token).await;
    assert_eq!(
        (stranger_status, recipient_status),
        (404, 409),
        "INV-2 / DEC-19: a stranger holding the transfer id must get 404 while the real \
         recipient gets 409 on the SAME row. Equal statuses here mean the \
         recipient/pending pre-check is gone, and with it the only thing keeping a \
         stranger off the 409 — the handler's own get_transfer is NOT recipient-scoped, \
         it 404s only on a row that does not exist. A stranger reaching 409 learns that \
         an initiator's standing inside an org they have no relationship to has changed, \
         and reaches far enough to take FOR UPDATE on an arbitrary project row"
    );

    assert_eq!(
        fx.project_owner_and_account(fx.p).await,
        (fx.bob, fx.org),
        "…and none of the four attempts moved the project"
    );
}
