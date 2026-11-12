//! TEST — a dataset's PRIMARY processing status (h5ad→SOMA convert) DERIVES from its
//! `processing_job_id` job on EVERY read (list + detail): running→running,
//! completed→completed, failed/stopped→failed carrying the error. The raw convert
//! error is surfaced to the OWNER but REDACTED for a non-owner sharee.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::dataset::repository::DatasetRepository;

use super::hardening_common::{admin_user_id, pool_for};
use super::{create_dataset, create_user, login, setup_admin};
use crate::common::TestServer;

/// A controlled processing job in a chosen status with an optional error. Only
/// terminal/running statuses are used (a `queued`/`blocked` job would be claimed +
/// run by the background scheduler, racing the assertion).
async fn insert_processing_job(
    pool: &SqlitePool,
    owner: Uuid,
    status: &str,
    error: Option<&str>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, error, params, priority_class, resource_class)
         VALUES ($1, $2, 'analysis', 'Convert proc-test', $3, $4, '{}', 'normal', 'cpu-sandbox')",
    )
    .bind(id)
    .bind(owner)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await
    .expect("insert controlled processing job");
    id
}

async fn detail(server: &TestServer, token: &str, ds: &str) -> Value {
    server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn find_item<'a>(page: &'a Value, ds: &str) -> &'a Value {
    page["items"]
        .as_array()
        .expect("items array")
        .iter()
        .find(|d| d["id"] == json!(ds))
        .expect("dataset present in list")
}

#[tokio::test]
async fn processing_status_derives_and_redacts_error_for_sharees() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = create_dataset(&server, &admin, "proc-status").await;
    let ds_uuid = Uuid::parse_str(&ds).unwrap();
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let repo = DatasetRepository::new(pool.clone());

    // A dataset with no linked job → no status (no badge).
    let d0 = detail(&server, &admin, &ds).await;
    assert!(
        d0["processing_status"].is_null(),
        "unlinked dataset has no processing status"
    );

    // running / completed derive on the detail read; non-failed carries no error.
    // (`running` is safe from the scheduler: it claims only `status='queued'`, and the
    // orphaned-`running` reconcile is boot-only — if a periodic stale-running reconcile
    // is ever added, revisit this + the `running` badge.)
    for (job_status, derived) in [("running", "running"), ("completed", "completed")] {
        let job = insert_processing_job(&pool, owner, job_status, None).await;
        repo.set_processing_job(ds_uuid, job)
            .await
            .expect("link job");
        let d = detail(&server, &admin, &ds).await;
        assert_eq!(
            d["processing_status"],
            json!(derived),
            "detail derives {job_status}→{derived}"
        );
        assert!(
            d["processing_error"].is_null(),
            "{job_status} carries no error"
        );
    }

    // FAILED → 'failed' carrying the error, on BOTH detail and list, for the owner.
    let failed = insert_processing_job(&pool, owner, "failed", Some("boom: /outputs/ws/x")).await;
    repo.set_processing_job(ds_uuid, failed)
        .await
        .expect("link failed job");

    let d = detail(&server, &admin, &ds).await;
    assert_eq!(
        d["processing_status"],
        json!("failed"),
        "detail derives failed"
    );
    assert_eq!(
        d["processing_error"],
        json!("boom: /outputs/ws/x"),
        "owner sees the raw error"
    );

    let list: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&admin)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let item = find_item(&list, &ds);
    assert_eq!(
        item["processing_status"],
        json!("failed"),
        "list derives failed"
    );
    assert_eq!(
        item["processing_error"],
        json!("boom: /outputs/ws/x"),
        "owner list sees the error"
    );

    // A view-sharee sees the FAILED status but NOT the raw error (redacted).
    let bob_id = create_user(&server, &admin, "proc_bob", "proc_bob@txresbench.test").await;
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&admin)
        .json(&json!({ "principal_type": "user", "principal_id": bob_id, "role": "view" }))
        .send()
        .await
        .unwrap();
    assert!(
        matches!(share.status().as_u16(), 200 | 201),
        "share view → 2xx"
    );

    let bob = login(&server, "proc_bob").await;
    let shared: Value = server
        .client
        .get(server.api_url("/datasets/shared"))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sitem = find_item(&shared, &ds);
    assert_eq!(
        sitem["processing_status"],
        json!("failed"),
        "sharee sees the failed status"
    );
    assert!(
        sitem["processing_error"].is_null(),
        "sharee's raw error text is REDACTED"
    );
    // The detail endpoint redacts for the sharee too.
    let sd = detail(&server, &bob, &ds).await;
    assert_eq!(sd["processing_status"], json!("failed"));
    assert!(
        sd["processing_error"].is_null(),
        "sharee detail error REDACTED"
    );
}

/// **The redaction protected the wrong direction.**
///
/// The raw convert error was withheld from every non-OWNER. But `799d0cf3` made an
/// `edit`-role sharee able to run the processing job, which makes them the job's owner
/// and hands them that identical string at `GET /jobs/{id}` — so the boundary withheld
/// it from exactly the people who could already read it, and the same dataset's error
/// was visible or not depending on who happened to press "run". The boundary is EDIT.
///
/// The `view` sharee is re-asserted here alongside, as the negative control: the fix
/// must widen to editors WITHOUT widening to readers, and a test that only checked the
/// editor could be satisfied by dropping the redaction entirely.
#[tokio::test]
async fn processing_error_is_shown_to_editors_and_still_redacted_for_viewers() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = create_dataset(&server, &admin, "redaction-boundary").await;
    let ds_uuid = Uuid::parse_str(&ds).unwrap();
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let repo = DatasetRepository::new(pool.clone());

    let failed = insert_processing_job(&pool, owner, "failed", Some("boom: /outputs/ws/x")).await;
    repo.set_processing_job(ds_uuid, failed).await.expect("link failed job");

    let ed_id = create_user(&server, &admin, "red_ed", "red_ed@txresbench.test").await;
    let viv_id = create_user(&server, &admin, "red_viv", "red_viv@txresbench.test").await;
    for (pid, role) in [(&ed_id, "edit"), (&viv_id, "view")] {
        let r = server
            .client
            .post(server.api_url(&format!("/datasets/{ds}/shares")))
            .bearer_auth(&admin)
            .json(&json!({ "principal_type": "user", "principal_id": pid, "role": role }))
            .send()
            .await
            .unwrap();
        assert!(matches!(r.status().as_u16(), 200 | 201), "share {role}");
    }

    let ed = login(&server, "red_ed").await;
    let viv = login(&server, "red_viv").await;

    for (who, token, expected) in [
        ("edit sharee", &ed, json!("boom: /outputs/ws/x")),
        ("view sharee", &viv, Value::Null),
    ] {
        let shared: Value = server
            .client
            .get(server.api_url("/datasets/shared"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            find_item(&shared, &ds)["processing_error"],
            expected,
            "{who}: LIST error text"
        );
        let d = detail(&server, token, &ds).await;
        assert_eq!(
            d["processing_error"],
            expected,
            "{who}: DETAIL error text — list and detail must answer the same principal \
             the same way"
        );
    }
}

/// `editable_subset` (batched, for the list path) and `access` (per row, for the
/// detail path) are two implementations of one predicate. `799d0cf3`'s second finding
/// was a hand-copied share predicate that had silently drifted from its original; this
/// asserts they agree per role instead of trusting a reader to notice.
#[tokio::test]
async fn editable_subset_matches_access() {
    use txresbench::modules::dataset::repository::DatasetAccess;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = create_dataset(&server, &admin, "subset-vs-access").await;
    let ds_uuid = Uuid::parse_str(&ds).unwrap();
    let pool = pool_for(&server).await;
    let repo = DatasetRepository::new(pool.clone());

    let mut ids = vec![];
    for (name, role) in [("sub_ed", Some("edit")), ("sub_viv", Some("view")), ("sub_out", None)] {
        let uid = create_user(&server, &admin, name, &format!("{name}@txresbench.test")).await;
        if let Some(role) = role {
            let r = server
                .client
                .post(server.api_url(&format!("/datasets/{ds}/shares")))
                .bearer_auth(&admin)
                .json(&json!({ "principal_type": "user", "principal_id": uid, "role": role }))
                .send()
                .await
                .unwrap();
            assert!(matches!(r.status().as_u16(), 200 | 201), "share {role}");
        }
        ids.push(Uuid::parse_str(&uid).unwrap());
    }
    ids.push(admin_user_id(&pool).await); // the owner

    let mut any_editable = false;
    let mut any_not = false;
    for uid in ids {
        let by_access = repo.access(ds_uuid, uid, &[]).await.unwrap() == DatasetAccess::CanEdit;
        let by_subset = repo
            .editable_subset(&[ds_uuid], uid, &[])
            .await
            .unwrap()
            .contains(&ds_uuid);
        assert_eq!(by_access, by_subset, "user {uid}: access says {by_access}, subset says {by_subset}");
        any_editable |= by_access;
        any_not |= !by_access;
    }
    // Negative controls: agreement is trivial if the predicate answers the same for all.
    assert!(any_editable, "some principal could edit");
    assert!(any_not, "some principal could not edit");

    // TEST-12 (H-1, #147) — extend the lock-step to the REMOVED-OWNER condition.
    //
    // `access`'s `can_edit` arm and `editable_subset` both carry the creator branch
    // conjoined with current account membership. They are two SQL literals, so this
    // is exactly the condition on which they could drift apart; #147 asks for the
    // existing lock-step to be extended here rather than bypassed.
    let rm = Uuid::parse_str(
        &create_user(&server, &admin, "sub_rm", "sub_rm@txresbench.test").await,
    )
    .unwrap();
    let org = crate::account::make_org_account(&pool, "SubsetLab", admin_user_id(&pool).await).await;
    crate::account::add_member(&pool, org, rm, "member").await;
    crate::account::move_dataset_to_account(&pool, ds_uuid, org).await;
    // Make `rm` the dataset's CREATOR — the branch this fix conjoins with membership.
    sqlx::query("UPDATE datasets SET owner_id = $1 WHERE id = $2")
        .bind(rm)
        .bind(ds_uuid)
        .execute(&pool)
        .await
        .unwrap();

    // Before the removal BOTH predicates must ADMIT the creator-member…
    let before_access = repo.access(ds_uuid, rm, &[]).await.unwrap() == DatasetAccess::CanEdit;
    let before_subset = repo
        .editable_subset(&[ds_uuid], rm, &[])
        .await
        .unwrap()
        .contains(&ds_uuid);
    assert_eq!(
        before_access, before_subset,
        "removed-owner lock-step (before): access says {before_access}, subset says {before_subset}"
    );
    assert!(
        before_access,
        "precondition: a CURRENT member who created the dataset can edit it — without \
         this, the after-half below would pass vacuously"
    );

    sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(rm)
        .execute(&pool)
        .await
        .unwrap();

    // …and after it, BOTH must refuse. Neither may keep the creator branch open on
    // its own — that divergence is precisely what this lock-step exists to catch.
    let after_access = repo.access(ds_uuid, rm, &[]).await.unwrap() == DatasetAccess::CanEdit;
    let after_subset = repo
        .editable_subset(&[ds_uuid], rm, &[])
        .await
        .unwrap()
        .contains(&ds_uuid);
    assert_eq!(
        after_access, after_subset,
        "removed-owner lock-step (after): access says {after_access}, subset says {after_subset}"
    );
    assert!(
        !after_access,
        "H-1: a removed member must not keep edit on the dataset they created"
    );
}
