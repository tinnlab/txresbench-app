//! TEST-56 [ITEM-25, ITEM-19] — fair-share across owners. Two owners each submit
//! jobs; the scheduler interleaves by owner running-count (WFQ) so neither
//! monopolizes — a second owner's job is NOT starved behind the first owner's
//! backlog. Claims are atomic (`FOR UPDATE SKIP LOCKED`): every job runs exactly
//! once (all reach a terminal state, none twice).

use std::time::Duration;

use super::hardening_common::*;
use super::{create_user, login, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn scheduler_interleaves_owners_and_claims_atomically() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "bob", "bob@cyto.test").await;
    let bob = login(&server, "bob").await;
    let pool = pool_for(&server).await;

    // BARRIER — the precondition this test asserts about, made a FACT rather
    // than a race.
    //
    // The four submits are four sequential POSTs while the scheduler ticks every
    // 500 ms. Started at cap=2, the scheduler could claim a2 before b1 had even
    // been created — and then `t_b1 < t_a2` fails for a reason that has nothing
    // to do with fair-share ordering. That is what made this test fail ~14% of
    // rounds. (The fair-share ORDER BY itself was verified correct against a
    // scratch table: with all four queued it picks b1; with b1 absent, a2.)
    //
    // So: hold the cap at 1 (MIN_MAX_CONCURRENT — 0 is rejected), let a1 take
    // the single slot, and let a2/a3/b1 pile up BEHIND it. Poll until all three
    // are observably `queued`; only then open the second slot. Now every
    // candidate exists before the claim under test happens.
    //
    // The wait is on STATE, never on elapsed time — a sleep would re-introduce
    // the same race with a longer fuse.
    //
    // Bonus: raising the cap mid-run is exactly the contract that
    // `dispatch_ready` broke by latching the cap once per tick, so this test now
    // also fails if that regresses.
    set_job_settings(&server, &admin, 1, 0).await;

    // Owner A (admin) floods 3 jobs FIRST; owner B (bob) submits 1 LAST.
    //
    // a1 gets a LONG body (~1s/step, `runner.rs::stub_steps`) so it demonstrably
    // still occupies the single slot while the other three are submitted. It is
    // the thing holding the gate shut; the barrier below asserts that as state
    // rather than assuming it.
    let a1 = submit_stub(
        &server,
        &admin,
        "a1",
        serde_json::json!({ "steps": 12 }),
        None,
    )
    .await;
    assert!(
        wait_started(&pool, a1, Duration::from_secs(30)).await,
        "a1 takes the single slot"
    );
    let a2 = submit_stub(
        &server,
        &admin,
        "a2",
        serde_json::json!({ "steps": 2 }),
        None,
    )
    .await;
    let a3 = submit_stub(
        &server,
        &admin,
        "a3",
        serde_json::json!({ "steps": 2 }),
        None,
    )
    .await;
    let b1 = submit_stub(&server, &bob, "b1", serde_json::json!({ "steps": 2 }), None).await;

    // THE BARRIER. Every candidate the fair-share claim chooses among must exist
    // and be claimable BEFORE that claim happens. Two state facts, polled — never
    // a sleep:
    //   * a2, a3, b1 are all observably `queued`, and
    //   * a1 is still `running`, i.e. the gate really is shut.
    // The second is what makes the first meaningful: if a1 had finished, the slot
    // would already be free and a2 could be claimed with b1 still absent — the
    // exact race being removed. Checking it here fails with a message that names
    // the cause, instead of surfacing later as a baffling ordering assertion.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let (s_a1, ..) = job_row(&pool, a1).await;
        let (s_a2, ..) = job_row(&pool, a2).await;
        let (s_a3, ..) = job_row(&pool, a3).await;
        let (s_b1, ..) = job_row(&pool, b1).await;
        assert_eq!(
            s_a1, "running",
            "a1 must still hold the single slot while a2/a3/b1 queue up \
             (a2={s_a2} a3={s_a3} b1={s_b1}) — barrier precondition"
        );
        if [&s_a2, &s_a3, &s_b1].iter().all(|s| *s == "queued") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for a2/a3/b1 to be queued behind a1 \
             (a2={s_a2} a3={s_a3} b1={s_b1})"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Gate open: a second slot. The claim that decides this test's assertion now
    // chooses among a2, a3 and b1 with ALL THREE present.
    set_job_settings(&server, &admin, 2, 0).await;

    // All four complete.
    for (label, id) in [("a1", a1), ("a2", a2), ("a3", a3), ("b1", b1)] {
        assert_eq!(
            wait_terminal(&pool, id, Duration::from_secs(90)).await,
            "completed",
            "{label} completes exactly once (atomic claim, no double-run)"
        );
    }

    // Fair-share: bob's ONE job (submitted last) started before admin's 2nd + 3rd
    // job — owner B is not head-of-line-blocked behind owner A's backlog. (A1 + B1
    // fill the two slots first because B's owner-running-count is lower.)
    let t_a2 = job_started_at(&pool, a2).await.unwrap();
    let t_a3 = job_started_at(&pool, a3).await.unwrap();
    let t_b1 = job_started_at(&pool, b1).await.unwrap();
    assert!(
        t_b1 < t_a2,
        "bob's job starts before admin's 2nd (fair interleave)"
    );
    assert!(
        t_b1 < t_a3,
        "bob's job starts before admin's 3rd (owner B not starved)"
    );

    // Atomic claim: exactly 4 completed rows for these ids, no extras.
    let completed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE status = 'completed' AND id = ANY($1)")
            .bind(vec![a1, a2, a3, b1])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(completed, 4, "all four claimed + completed exactly once");
}
